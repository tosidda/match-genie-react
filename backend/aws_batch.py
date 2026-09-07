"""AWS Batch submission and status helpers for MatchGenie video analysis.

This module is dormant unless VIDEO_ANALYSIS_EXECUTOR=aws_batch. Local Celery
remains the default, which lets the cloud integration be tested from localhost
before any production configuration changes.
"""

from __future__ import annotations

import json
import errno
import math
import mimetypes
import os
import re
import time
import uuid
import urllib.error
import urllib.request
import httpx
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache
from pathlib import Path

AWS_TASK_PREFIX = "aws-"
# S3 accepts multipart pieces as small as 5 MiB (except the final piece).  The
# old 64 MiB x four-worker setting could put 256 MiB in flight at once and was
# large enough for some home-network/NAT connections to repeatedly reset a
# single PUT.  Smaller pieces cost a few more signed URLs but make a failed
# transfer cheap to repeat and keep memory/network pressure bounded.
BROKER_PART_SIZE = max(
    5 * 1024 * 1024,
    int(os.environ.get("MATCHGENIE_BROKER_PART_SIZE", 16 * 1024 * 1024)),
)
BROKER_UPLOAD_WORKERS = max(
    1,
    min(4, int(os.environ.get("MATCHGENIE_BROKER_UPLOAD_WORKERS", "2"))),
)
BROKER_UPLOAD_RETRY_DELAYS = (0.0, 1.0, 2.0, 4.0, 8.0, 15.0, 30.0)


class AwsAuthenticationExpired(RuntimeError):
    """Raised when a temporary localhost AWS login needs reauthentication."""

    code = "AWS_AUTH_EXPIRED"
    retryable = True


_AUTH_ERROR_MARKERS = (
    "token has expired",
    "refresh failed",
    "unauthorizedssotoken",
    "the sso session associated with this profile has expired",
    "error loading sso token",
)


def is_aws_task(task_id):
    return str(task_id or "").startswith(AWS_TASK_PREFIX)


def _broker_enabled():
    return bool(
        os.environ.get("MATCHGENIE_AWS_CONTROL_BROKER_URL") and
        os.environ.get("MATCHGENIE_AWS_CONTROL_BROKER_SECRET")
    )


def _broker_call(action, data=None, *, timeout=120):
    """Call the IAM-role AWS control plane without developer AWS credentials."""
    url = os.environ.get("MATCHGENIE_AWS_CONTROL_BROKER_URL", "").strip()
    secret = os.environ.get("MATCHGENIE_AWS_CONTROL_BROKER_SECRET", "").strip()
    if not url or not secret:
        raise RuntimeError("The AWS control broker is not configured")
    encoded = json.dumps({"action": action, "data": data or {}}).encode("utf-8")
    payload = None
    last_error = None
    # Lambda URL networking and cold starts can occasionally fail for a few
    # seconds. Absorb those transient failures here so an active analysis does
    # not flash a false pause in the UI. Authorization and validation failures
    # are intentionally not retried.
    for attempt, delay in enumerate((0.0, 0.5, 1.5, 3.0)):
        if delay:
            time.sleep(delay)
        request = urllib.request.Request(
            url,
            data=encoded,
            headers={
                "content-type": "application/json",
                "x-matchgenie-broker-key": secret,
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:
            try:
                error_payload = json.loads(exc.read().decode("utf-8"))
                detail = error_payload.get("error")
            except Exception:
                detail = None
            if exc.code < 500 or attempt == 3:
                raise RuntimeError(
                    detail or f"AWS control service returned HTTP {exc.code}"
                ) from exc
            last_error = exc
        except urllib.error.URLError as exc:
            last_error = exc
            if attempt == 3:
                raise RuntimeError("AWS control service is temporarily unreachable") from exc
    if payload is None:
        raise RuntimeError("AWS control service is temporarily unreachable") from last_error
    if "result" not in payload:
        raise RuntimeError(payload.get("error") or "AWS control service returned an invalid response")
    return payload["result"]


def _is_retryable_upload_error(exc):
    """Return whether repeating an idempotent S3 part PUT is safe/useful."""
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in {
            408, 409, 425, 429, 500, 502, 503, 504
        }
    if isinstance(exc, httpx.TransportError):
        return True
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in {408, 409, 425, 429, 500, 502, 503, 504}
    if isinstance(exc, (urllib.error.URLError, TimeoutError, ConnectionError)):
        return True
    if isinstance(exc, OSError):
        return exc.errno in {
            errno.EPIPE,
            errno.ECONNABORTED,
            errno.ECONNRESET,
            errno.ENETRESET,
            errno.ETIMEDOUT,
            errno.EHOSTUNREACH,
        }
    return False


def _upload_part(path, part_number, offset, length, url):
    with open(path, "rb") as source:
        source.seek(offset)
        body = source.read(length)

    last_error = None
    for attempt, delay in enumerate(BROKER_UPLOAD_RETRY_DELAYS, start=1):
        if delay:
            time.sleep(delay)
        try:
            # urllib repeatedly raised EPIPE while writing presigned S3 PUTs,
            # including after reopening the connection. httpx uses a more
            # robust streaming HTTP implementation and is already a backend
            # dependency. The top-level call creates a fresh client/connection
            # for every idempotent part retry.
            response = httpx.put(
                url,
                content=body,
                headers={"Content-Length": str(len(body))},
                timeout=httpx.Timeout(7200.0, connect=60.0),
                follow_redirects=False,
            )
            response.raise_for_status()
            etag = response.headers.get("ETag")
            if not etag:
                raise RuntimeError(
                    f"AWS did not acknowledge upload part {part_number}"
                )
            return {"part_number": part_number, "etag": etag}
        except Exception as exc:
            last_error = exc
            if (
                not _is_retryable_upload_error(exc)
                or attempt == len(BROKER_UPLOAD_RETRY_DELAYS)
            ):
                break

    raise RuntimeError(
        "The cloud upload connection was interrupted repeatedly while sending "
        f"video part {part_number}. Please retry the upload."
    ) from last_error


def _broker_upload_file(path, *, username, task_id, filename, content_type):
    """Multipart-upload a source video through role-signed S3 URLs."""
    initialized = _broker_call("init_upload", {
        "username": username,
        "task_id": task_id,
        "filename": filename,
        "content_type": content_type,
    })
    key = initialized["key"]
    upload_id = initialized["upload_id"]
    size = os.path.getsize(path)
    part_count = max(1, int(math.ceil(size / BROKER_PART_SIZE)))
    numbers = list(range(1, part_count + 1))
    try:
        urls = _broker_call("upload_part_urls", {
            "username": username,
            "task_id": task_id,
            "key": key,
            "upload_id": upload_id,
            "part_numbers": numbers,
        })["urls"]
        completed = []
        # Keep at most two pieces in flight by default. Large concurrent PUTs
        # were the source of reproducible EPIPE failures on local uploads.
        with ThreadPoolExecutor(
            max_workers=min(BROKER_UPLOAD_WORKERS, part_count)
        ) as pool:
            futures = {}
            for number in numbers:
                offset = (number - 1) * BROKER_PART_SIZE
                length = min(BROKER_PART_SIZE, max(0, size - offset))
                futures[pool.submit(
                    _upload_part, path, number, offset, length, urls[str(number)]
                )] = number
            for future in as_completed(futures):
                completed.append(future.result())
        _broker_call("complete_upload", {
            "username": username,
            "task_id": task_id,
            "key": key,
            "upload_id": upload_id,
            "parts": completed,
        })
        return key
    except Exception:
        try:
            _broker_call("abort_upload", {
                "username": username,
                "task_id": task_id,
                "key": key,
                "upload_id": upload_id,
            })
        except Exception:
            pass
        raise


def publish_feedback_model(path):
    """Publish the reviewed classifier to the fixed private model key."""
    if not _broker_enabled():
        raise RuntimeError("The AWS control broker is not configured")
    target = _broker_call("feedback_model_upload_url")
    with open(path, "rb") as model_file:
        response = httpx.put(
            target["url"],
            content=model_file.read(),
            headers={
                "Content-Type": "application/octet-stream",
                "x-amz-server-side-encryption": "AES256",
            },
            timeout=httpx.Timeout(300.0, connect=30.0),
        )
    response.raise_for_status()
    return target["key"]


def _settings():
    required = {
        "bucket": os.environ.get("MATCHGENIE_AWS_JOB_BUCKET"),
        "queue": os.environ.get("MATCHGENIE_AWS_JOB_QUEUE"),
        "definition": os.environ.get("MATCHGENIE_AWS_JOB_DEFINITION"),
    }
    missing = [key for key, value in required.items() if not value]
    if missing:
        raise RuntimeError(
            "AWS Batch analysis is not configured: missing " +
            ", ".join(f"MATCHGENIE_AWS_{name.upper()}" for name in missing)
        )
    required["region"] = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    return required


@lru_cache(maxsize=1)
def _session():
    # AWS_PROFILE is useful for localhost SSO testing. In a deployed backend,
    # omit it so boto3 uses the service's IAM role rather than static keys.
    # Import lazily so the existing local-Celery mode still starts before the
    # optional AWS dependency has been installed.
    import boto3

    profile = os.environ.get("AWS_PROFILE")
    return boto3.Session(profile_name=profile, region_name=_settings()["region"])


@lru_cache(maxsize=1)
def _s3():
    return _session().client("s3")


@lru_cache(maxsize=1)
def _batch():
    return _session().client("batch")


def _is_authentication_expired(exc):
    name = type(exc).__name__.lower()
    text = str(exc or "").lower()
    return (
        "sso" in name and ("token" in name or "unauthorized" in name)
    ) or any(marker in text for marker in _AUTH_ERROR_MARKERS)


def _reset_cached_clients():
    """Discard credential-bearing clients so a renewed SSO cache is re-read."""
    _batch.cache_clear()
    _s3.cache_clear()
    _session.cache_clear()


def _aws_call(client_factory, operation, *args, **kwargs):
    """Run one AWS call, rebuilding cached clients once after auth expiry.

    The localhost AWS profile uses short-lived IAM Identity Center credentials.
    Boto clients cache their credential provider, so a successful `aws sso login`
    was previously invisible until the Flask container restarted. Rebuilding the
    session makes the next poll recover automatically while IAM-role production
    credentials continue to use the normal boto refresh path.
    """
    last_error = None
    for attempt in range(2):
        try:
            client = client_factory()
            return getattr(client, operation)(*args, **kwargs)
        except Exception as exc:
            if not _is_authentication_expired(exc):
                raise
            last_error = exc
            _reset_cached_clients()
            if attempt == 0:
                continue

    if os.environ.get("AWS_PROFILE"):
        message = (
            "Local AWS access needs to be reconnected. The cloud analysis "
            "continues safely; run `aws sso login --profile "
            f"{os.environ['AWS_PROFILE']}`. This page will reconnect automatically."
        )
    else:
        message = "AWS credentials are temporarily unavailable; retry shortly."
    raise AwsAuthenticationExpired(message) from last_error


def _safe_component(value):
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "-", str(value or "user")).strip("-.")
    return cleaned[:80] or "user"


def _task_prefix(username, task_id):
    return f"jobs/{_safe_component(username)}/{task_id}"


def _put_json(bucket, key, value):
    _aws_call(
        _s3,
        "put_object",
        Bucket=bucket,
        Key=key,
        Body=json.dumps(value, indent=2).encode("utf-8"),
        ContentType="application/json",
        ServerSideEncryption="AES256",
    )


def _get_json(bucket, key, *, optional=False):
    try:
        response = _aws_call(_s3, "get_object", Bucket=bucket, Key=key)
    except Exception as exc:
        error_code = getattr(exc, "response", {}).get("Error", {}).get("Code")
        if optional and error_code in {"NoSuchKey", "404"}:
            return None
        raise
    return json.loads(response["Body"].read().decode("utf-8"))


def submit_analysis(
    *, video_path=None, youtube_url=None, username, original_filename, sheet_url, row_index,
    standalone=False,
    opponent_name, player_side, player_left_handed,
    player_one_handed_backhand, opp_left_handed,
    opp_one_handed_backhand, start_time_sec, end_time_sec,
):
    settings = _settings()
    task_id = AWS_TASK_PREFIX + uuid.uuid4().hex
    prefix = _task_prefix(username, task_id)
    if bool(video_path) == bool(youtube_url):
        raise ValueError("Provide exactly one video file or YouTube URL")
    # Inputs have a separate top-level prefix so lifecycle cleanup can expire
    # large source uploads without deleting the retained rally results.
    input_prefix = f"inputs/{_safe_component(username)}/{task_id}"
    if video_path:
        suffix = Path(original_filename or video_path).suffix.lower() or ".mp4"
        input_key = f"{input_prefix}/source{suffix}"
        content_type = mimetypes.guess_type(original_filename or video_path)[0] or "video/mp4"
        if _broker_enabled():
            input_key = _broker_upload_file(
                video_path,
                username=username,
                task_id=task_id,
                filename=original_filename or os.path.basename(video_path),
                content_type=content_type,
            )
        else:
            _aws_call(
                _s3,
                "upload_file",
                video_path,
                settings["bucket"],
                input_key,
                ExtraArgs={"ContentType": content_type, "ServerSideEncryption": "AES256"},
            )
        input_payload = {"key": input_key, "filename": original_filename}
    else:
        # The URL is downloaded inside the isolated AWS worker. This keeps a
        # multi-gigabyte import out of the Flask request and local machine.
        input_payload = {
            "youtube_url": str(youtube_url),
            "filename": "youtube-video.mp4",
        }
    request_payload = {
        "version": 1,
        "task_id": task_id,
        "owner_username": username,
        "username": username,
        "opponent_name": opponent_name,
        "sheet_url": sheet_url,
        "row_index": int(row_index) if row_index is not None else None,
        "standalone": bool(standalone),
        "input": input_payload,
        "models": {
            "det_key": os.environ.get("MATCHGENIE_AWS_DET_MODEL_KEY", "models/best_det_v4.pt"),
            "seg_key": os.environ.get("MATCHGENIE_AWS_SEG_MODEL_KEY", "models/best_seg_v1.pt"),
            "pose_key": os.environ.get("MATCHGENIE_AWS_POSE_MODEL_KEY", "models/yolov8m-pose.pt"),
            "mlp_key": os.environ.get(
                "MATCHGENIE_AWS_MLP_MODEL_KEY",
                "models/shot_classifier_feedback.pt",
            ),
        },
        "options": {
            "player_side": player_side,
            "player_left_handed": bool(player_left_handed),
            "player_one_handed_backhand": bool(player_one_handed_backhand),
            "opp_left_handed": bool(opp_left_handed),
            "opp_one_handed_backhand": bool(opp_one_handed_backhand),
            "start_time_sec": float(start_time_sec or 0.0),
            "end_time_sec": float(end_time_sec or 0.0),
            "imgsz": int(os.environ.get("VIDEO_ANALYSIS_IMGSZ", "1280")),
            "conf": float(os.environ.get("VIDEO_ANALYSIS_CONF", "0.25")),
        },
        "submitted_at": int(time.time()),
    }
    request_key = f"{prefix}/request.json"
    if _broker_enabled():
        _broker_call("submit", {"request": request_payload})
        return {
            "task_id": task_id,
            "executor": "aws_batch",
            "state": "PENDING",
            "progress": 0,
            "stage": "queued",
            "message": (
                "YouTube video queued for secure import on an AWS GPU worker."
                if youtube_url else
                "Video uploaded securely. Waiting for an AWS GPU worker."
            ),
        }
    _put_json(settings["bucket"], request_key, request_payload)

    try:
        submitted = _aws_call(
            _batch,
            "submit_job",
            jobName=f"matchgenie-{task_id[-12:]}",
            jobQueue=settings["queue"],
            jobDefinition=settings["definition"],
            containerOverrides={
                "environment": [
                    {"name": "MATCHGENIE_JOB_BUCKET", "value": settings["bucket"]},
                    {"name": "MATCHGENIE_JOB_PREFIX", "value": prefix},
                ]
            },
            tags={"Application": "MatchGenie", "MatchGenieTaskId": task_id},
        )
    except Exception as submit_error:
        # Keep no orphaned source video if Batch rejects the submission.
        try:
            objects = _aws_call(
                _s3, "list_objects_v2",
                Bucket=settings["bucket"], Prefix=f"{prefix}/",
            ).get("Contents", [])
            objects += _aws_call(
                _s3, "list_objects_v2",
                Bucket=settings["bucket"], Prefix=f"{input_prefix}/",
            ).get("Contents", [])
            if objects:
                _aws_call(
                    _s3,
                    "delete_objects",
                    Bucket=settings["bucket"],
                    Delete={"Objects": [{"Key": item["Key"]} for item in objects]},
                )
        except Exception:
            # Cleanup is best effort. Never mask the submission failure (most
            # importantly, a retryable SSO-authentication failure) with a
            # secondary list/delete error.
            pass
        raise submit_error

    control = {
        "version": 1,
        "task_id": task_id,
        "batch_job_id": submitted["jobId"],
        "owner_username": username,
        "request_key": request_key,
        "submitted_at": int(time.time()),
    }
    _put_json(settings["bucket"], f"{prefix}/control.json", control)
    return {
        "task_id": task_id,
        "executor": "aws_batch",
        "state": "PENDING",
        "progress": 0,
        "stage": "queued",
        "message": (
            "YouTube video queued for secure import on an AWS GPU worker."
            if youtube_url else
            "Video uploaded securely. Waiting for an AWS GPU worker."
        ),
    }


def _load_control(task_id, username):
    settings = _settings()
    prefix = _task_prefix(username, task_id)
    control = _get_json(settings["bucket"], f"{prefix}/control.json")
    if control.get("owner_username") != username or control.get("task_id") != task_id:
        raise PermissionError("This analysis does not belong to the signed-in user")
    return settings, prefix, control


def get_request(task_id, username):
    if _broker_enabled():
        return _broker_call("get_request", {"task_id": task_id, "username": username})
    settings, _, control = _load_control(task_id, username)
    payload = _get_json(settings["bucket"], control["request_key"])
    if payload.get("owner_username") != username:
        raise PermissionError("This analysis request belongs to a different user")
    return payload


def list_unfinished_analyses(username, limit=100):
    """Discover this user's recent recoverable AWS analyses.

    Browser local storage is only a convenience cache. S3 control files are
    the durable task index, so refreshing the page, clearing browser storage,
    or opening another device cannot make a running cloud analysis disappear.
    """
    if _broker_enabled():
        return _broker_call(
            "list_unfinished", {"username": username, "limit": limit}
        ).get("analyses", [])
    settings = _settings()
    user_prefix = f"jobs/{_safe_component(username)}/"
    listed = _aws_call(
        _s3,
        "list_objects_v2",
        Bucket=settings["bucket"],
        Prefix=user_prefix,
        Delimiter="/",
        MaxKeys=1000,
    )

    controls = []
    for item in listed.get("CommonPrefixes", []):
        prefix = str(item.get("Prefix") or "").rstrip("/")
        task_id = prefix.rsplit("/", 1)[-1]
        if not is_aws_task(task_id):
            continue
        control = _get_json(
            settings["bucket"], f"{prefix}/control.json", optional=True
        )
        if not control or control.get("owner_username") != username:
            continue
        if control.get("task_id") != task_id or not control.get("batch_job_id"):
            continue
        controls.append((int(control.get("submitted_at", 0)), prefix, control))

    controls.sort(key=lambda value: value[0], reverse=True)
    controls = controls[:max(1, int(limit))]
    if not controls:
        return []

    batch_jobs = {}
    job_ids = [control[2]["batch_job_id"] for control in controls]
    for offset in range(0, len(job_ids), 100):
        described = _aws_call(
            _batch, "describe_jobs", jobs=job_ids[offset:offset + 100]
        )
        for job in described.get("jobs", []):
            batch_jobs[job.get("jobId")] = job

    recoverable = []
    active_states = {"SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"}
    for _, prefix, control in controls:
        job = batch_jobs.get(control["batch_job_id"])
        if not job:
            continue
        batch_state = job.get("status", "SUBMITTED")
        # Successful standalone analyses must remain discoverable after they
        # are finalized. Browser storage is scoped by origin, so localhost and
        # a temporary public hostname cannot otherwise show the same history.
        if batch_state not in active_states and batch_state != "SUCCEEDED":
            continue

        request_payload = _get_json(
            settings["bucket"], control["request_key"], optional=True
        ) or {}
        progress = _get_json(
            settings["bucket"], f"{prefix}/progress.json", optional=True
        ) or {}
        response = {
            "task_id": control["task_id"],
            "executor": "aws_batch",
            "batch_state": batch_state,
            # Even a just-finished job must be polled once so the status route
            # can save its manifest and materialize signed artifact URLs.
            "state": "PROGRESS" if batch_state == "RUNNING" else "PENDING",
            "progress": int(progress.get("progress", 0)),
            "stage": progress.get("stage", "queued"),
            "message": progress.get("message") or (
                "Retrieving the completed analysis."
                if batch_state == "SUCCEEDED"
                else "Restoring the active AWS analysis."
            ),
            "opponent_name": request_payload.get("opponent_name", "Opponent"),
            "standalone": bool(request_payload.get("standalone")),
            "submitted_at": int(
                request_payload.get("submitted_at") or control.get("submitted_at", 0)
            ),
        }
        for field in ("trimmed_blob", "rally_count", "rallies_complete"):
            if field in progress:
                response[field] = progress[field]
        recoverable.append(response)
    return recoverable


def get_status(task_id, username):
    if _broker_enabled():
        return _broker_call("status", {"task_id": task_id, "username": username})
    settings, prefix, control = _load_control(task_id, username)
    jobs = _aws_call(
        _batch, "describe_jobs", jobs=[control["batch_job_id"]]
    ).get("jobs", [])
    if not jobs:
        raise RuntimeError("AWS Batch no longer has a record of this analysis job")
    job = jobs[0]
    batch_state = job.get("status", "SUBMITTED")
    progress = _get_json(settings["bucket"], f"{prefix}/progress.json", optional=True) or {}
    response = {
        "task_id": task_id,
        "executor": "aws_batch",
        "batch_state": batch_state,
        "state": "PROGRESS",
        "progress": int(progress.get("progress", 0)),
        "stage": progress.get("stage", "queued"),
        "message": progress.get("message") or {
            "SUBMITTED": "Analysis submitted to AWS Batch.",
            "PENDING": "AWS is preparing the analysis job.",
            "RUNNABLE": "Waiting for an available GPU worker.",
            "STARTING": "Starting the GPU analysis container.",
            "RUNNING": "GPU analysis is running.",
        }.get(batch_state, "Waiting for the AWS worker."),
    }
    for field in ("trimmed_blob", "rally_count", "rallies_complete"):
        if field in progress:
            response[field] = progress[field]

    if batch_state == "SUCCEEDED":
        manifest = _get_json(settings["bucket"], f"{prefix}/manifest.json")
        if manifest.get("username") != username:
            raise PermissionError("AWS returned a manifest for a different user")
        response.update(state="SUCCESS", progress=100, stage="complete", result=manifest)
    elif batch_state == "FAILED":
        reason = (
            progress.get("message") or job.get("statusReason") or
            (job.get("container") or {}).get("reason") or "AWS Batch analysis failed"
        )
        response.update(state="FAILURE", stage="failed", error=reason, message=reason)
    return response


def mark_finalized(task_id, username, *, check_only=False):
    if _broker_enabled():
        return bool(_broker_call("mark_finalized", {
            "task_id": task_id,
            "username": username,
            "check_only": bool(check_only),
        }).get("created"))
    settings, prefix, _ = _load_control(task_id, username)
    key = f"{prefix}/finalized.json"
    existing = _get_json(settings["bucket"], key, optional=True)
    if existing:
        return False
    if check_only:
        return True
    _put_json(settings["bucket"], key, {"finalized_at": int(time.time())})
    return True


def delete_analysis(task_id, username):
    """Permanently delete one terminal analysis owned by this user."""
    if _broker_enabled():
        return _broker_call("delete_analysis", {
            "task_id": task_id,
            "username": username,
        })
    settings, prefix, control = _load_control(task_id, username)
    jobs = _aws_call(
        _batch, "describe_jobs", jobs=[control["batch_job_id"]]
    ).get("jobs", [])
    if jobs and jobs[0].get("status") in {
        "SUBMITTED", "PENDING", "RUNNABLE", "STARTING", "RUNNING"
    }:
        raise ValueError("An analysis must finish or stop before it can be deleted")

    request_payload = _get_json(
        settings["bucket"], control["request_key"], optional=True
    ) or {}
    keys = []
    for object_prefix in (
        f"{prefix}/",
        f"inputs/{_safe_component(username)}/{task_id}/",
    ):
        continuation = None
        while True:
            params = {
                "Bucket": settings["bucket"],
                "Prefix": object_prefix,
            }
            if continuation:
                params["ContinuationToken"] = continuation
            page = _aws_call(_s3, "list_objects_v2", **params)
            keys.extend(item["Key"] for item in page.get("Contents", []))
            continuation = page.get("NextContinuationToken")
            if not continuation:
                break
    for offset in range(0, len(keys), 1000):
        _aws_call(
            _s3,
            "delete_objects",
            Bucket=settings["bucket"],
            Delete={
                "Objects": [{"Key": key} for key in keys[offset:offset + 1000]],
                "Quiet": True,
            },
        )
    return {
        "deleted": True,
        "objects_deleted": len(keys),
        "task_id": task_id,
        "request": request_payload,
    }


def presign_s3_uri(uri, expiration=21600):
    if not str(uri or "").startswith("s3://"):
        raise ValueError("Expected a private s3:// artifact URI")
    if _broker_enabled():
        result = _broker_call("presign_get", {
            "uri": str(uri), "expiration": int(expiration)
        })
        return result["url"], int(result["expires_epoch"])
    bucket_and_key = str(uri)[5:]
    bucket, key = bucket_and_key.split("/", 1)
    url = _aws_call(
        _s3,
        "generate_presigned_url",
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=int(expiration),
    )
    return url, int(time.time()) + int(expiration)


def load_s3_json(uri):
    if not str(uri or "").startswith("s3://"):
        raise ValueError("Expected an s3:// JSON URI")
    if _broker_enabled():
        return _broker_call("load_manifest", {"uri": str(uri)})
    bucket_and_key = str(uri)[5:]
    bucket, key = bucket_and_key.split("/", 1)
    return _get_json(bucket, key)


def owns_manifest_uri(uri, username):
    """Return true only for this user's manifest in the configured job bucket."""
    if not str(uri or "").startswith("s3://"):
        return False
    bucket_and_key = str(uri)[5:]
    if "/" not in bucket_and_key:
        return False
    bucket, key = bucket_and_key.split("/", 1)
    expected_prefix = f"jobs/{_safe_component(username)}/{AWS_TASK_PREFIX}"
    return (
        bucket == _settings()["bucket"] and
        key.startswith(expected_prefix) and
        key.endswith("/manifest.json")
    )
