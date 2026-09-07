import datetime
import json
import math
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import gspread
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from google.oauth2.service_account import Credentials
from google.cloud import storage
from celery.result import AsyncResult

from database import SessionLocal, User, ShotCorrection
from config import get_gsheets_creds, get_gcs_bucket
from tasks import analyze_match_video, celery_app, train_reviewed_shot_classifier
from aws_batch import (
    AwsAuthenticationExpired,
    delete_analysis as delete_aws_analysis,
    get_request as get_aws_request,
    get_status as get_aws_status,
    is_aws_task,
    list_unfinished_analyses as list_unfinished_aws_analyses,
    load_s3_json,
    mark_finalized as mark_aws_finalized,
    owns_manifest_uri,
    presign_s3_uri,
    submit_analysis as submit_aws_analysis,
)

video_bp = Blueprint("video", __name__)

YOUTUBE_POT_SERVER_HOME = Path(
    os.environ.get("MATCHGENIE_YOUTUBE_POT_SERVER_HOME", "/opt/bgutil/server")
)


def _aws_auth_response(exc, *, analysis_continues=False):
    """Return a stable, machine-readable response for temporary AWS auth loss.

    Localhost uses an AWS IAM Identity Center (SSO) profile whose login expires.
    The Batch job itself is independent and keeps running, so clients must retry
    without treating this as an analysis failure or discarding known artifacts.
    """
    return jsonify({
        "error": str(exc),
        "code": exc.code,
        "retryable": exc.retryable,
        "analysis_continues": bool(analysis_continues),
    }), 503


def _get_gcs_client():
    creds_dict = get_gsheets_creds()
    return storage.Client(credentials=Credentials.from_service_account_info(creds_dict))


def _form_bool(name):
    return str(request.form.get(name, "false")).strip().lower() in {
        "1", "true", "yes", "on"
    }


def _canonical_youtube_url(value):
    """Validate one YouTube video URL and discard unrelated URL parameters."""
    text = str(value or "").strip()
    if not text or len(text) > 2048:
        raise ValueError("Enter a valid YouTube video link")
    parsed = urlparse(text)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        raise ValueError("Only normal HTTPS YouTube video links are supported")
    host = (parsed.hostname or "").lower().rstrip(".")
    video_id = ""
    if host in {"youtu.be", "www.youtu.be"}:
        video_id = parsed.path.strip("/").split("/", 1)[0]
    elif host in {
        "youtube.com", "www.youtube.com", "m.youtube.com",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
    }:
        parts = [part for part in parsed.path.split("/") if part]
        if parsed.path.rstrip("/") == "/watch":
            video_id = parse_qs(parsed.query).get("v", [""])[0]
        elif len(parts) >= 2 and parts[0] in {"shorts", "live", "embed"}:
            video_id = parts[1]
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
        raise ValueError("The link must point to one YouTube video")
    return f"https://www.youtube.com/watch?v={video_id}"


def _parse_video_time(value, field_name):
    """Parse seconds, MM:SS, or HH:MM:SS into a non-negative offset."""
    text = str(value or "").strip()
    if not text:
        return 0.0
    try:
        if ":" not in text:
            seconds = float(text)
        else:
            parts = text.split(":")
            if len(parts) not in {2, 3} or any(part.strip() == "" for part in parts):
                raise ValueError
            numbers = [float(part) for part in parts]
            if any(not math.isfinite(number) or number < 0 for number in numbers):
                raise ValueError
            if len(numbers) == 2:
                minutes, final_seconds = numbers
                if final_seconds >= 60:
                    raise ValueError
                seconds = minutes * 60 + final_seconds
            else:
                hours, minutes, final_seconds = numbers
                if minutes >= 60 or final_seconds >= 60:
                    raise ValueError
                seconds = hours * 3600 + minutes * 60 + final_seconds
        if not math.isfinite(seconds) or seconds < 0:
            raise ValueError
        return seconds
    except (TypeError, ValueError):
        raise ValueError(f"{field_name} must be seconds, MM:SS, or HH:MM:SS")


def _parse_start_time(value):
    return _parse_video_time(value, "Start time")


def _parse_end_time(value):
    return _parse_video_time(value, "End time")


def _download_youtube_locally(youtube_url, upload_dir):
    """Acquire an authorized YouTube source before handing it to AWS Batch.

    YouTube commonly rejects media extraction from AWS datacenter addresses,
    even when the extractor can generate a proof-of-origin token.  The
    localhost test backend has the user's normal network egress, so acquire the
    source here, without cookies, and then reuse the same private-S3 handoff as
    a direct upload.  yt-dlp merges the selected streams without re-encoding.
    """
    os.makedirs(upload_dir, exist_ok=True)
    stem = f"youtube-{uuid.uuid4().hex}"
    output_template = os.path.join(upload_dir, f"{stem}.%(ext)s")
    video_suffixes = {".mp4", ".mkv", ".webm", ".mov", ".m4v"}

    def cleanup_partial_download():
        for path in Path(upload_dir).glob(f"{stem}.*"):
            if path.is_file():
                path.unlink(missing_ok=True)

    common_command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--no-overwrites",
        "--restrict-filenames",
        "--force-ipv4",
        "--extractor-args",
        f"youtubepot-bgutilscript:server_home={YOUTUBE_POT_SERVER_HOME}",
        "--retries",
        "2",
        "--fragment-retries",
        "2",
        "--retry-sleep",
        "linear=1::2",
        "--format-sort-force",
        "--format-sort",
        # Preserve the detail that matters most to pose estimation: pixels,
        # then temporal resolution and bitrate.  Do not let container or
        # codec preferences silently outrank the highest YouTube rendition.
        "res,fps,vbr,abr",
        "--merge-output-format",
        "mp4",
        "--write-info-json",
        "--output",
        output_template,
    ]

    # ``--js-runtimes`` was added after the last yt-dlp release supporting
    # Python 3.9. Keep using Node when the installed downloader understands the
    # option, but do not make older compatible installations reject the entire
    # command before extraction begins.
    help_result = subprocess.run(
        [sys.executable, "-m", "yt_dlp", "--help"],
        capture_output=True,
        text=True,
        check=False,
    )
    if "--js-runtimes" in help_result.stdout:
        common_command[7:7] = ["--js-runtimes", "node:/usr/local/bin/node"]

    # Ask several current clients in one extraction first.  The old code
    # returned the first independently successful client (web_embedded), even
    # when that client's format list was capped below the normal web player's
    # 1080p/1440p rendition.  The combined format list lets yt-dlp choose the
    # true maximum.  Independent attempts remain only as delivery fallbacks.
    # Use bestvideo (not bestvideo*): the starred selector may accept a lower
    # pre-combined audio/video stream before considering the highest-resolution
    # video-only stream.  Merging streams does not re-encode or downscale them.
    highest_quality_format = "bestvideo+bestaudio/best"
    attempts = [
        ("combined-highest", "web_safari,mweb,web_embedded", highest_quality_format),
        ("web-safari", "web_safari", highest_quality_format),
        ("mweb-pot", "mweb", highest_quality_format),
        ("embedded", "web_embedded", highest_quality_format),
        ("tv", "tv", highest_quality_format),
        ("android-vr", "android_vr", highest_quality_format),
    ]
    timeout = int(os.environ.get("YOUTUBE_LOCAL_DOWNLOAD_TIMEOUT", "840"))
    failures = []
    for attempt_name, player_client, video_format in attempts:
        cleanup_partial_download()
        command = common_command + [
            "--extractor-args",
            f"youtube:player_client={player_client}",
            "--format",
            video_format,
            youtube_url,
        ]
        try:
            completed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired:
            failures.append(f"{attempt_name}: timed out")
            continue

        candidates = sorted(
            path for path in Path(upload_dir).glob(f"{stem}.*")
            if path.is_file() and path.suffix.lower() in video_suffixes
        )
        if completed.returncode == 0 and candidates:
            source = max(candidates, key=lambda path: path.stat().st_size)
            info_path = Path(upload_dir) / f"{stem}.info.json"
            if info_path.exists():
                try:
                    info = json.loads(info_path.read_text(encoding="utf-8"))
                    requested = info.get("requested_formats") or []
                    video_format = next(
                        (
                            item for item in requested
                            if item.get("vcodec") not in {None, "none"}
                        ),
                        info,
                    )
                    print(
                        "YouTube source selected: "
                        f"client={attempt_name} "
                        f"format={video_format.get('format_id', '?')} "
                        f"resolution={video_format.get('width', '?')}x"
                        f"{video_format.get('height', '?')} "
                        f"fps={video_format.get('fps', '?')} "
                        f"codec={video_format.get('vcodec', '?')}",
                        flush=True,
                    )
                except (OSError, ValueError, TypeError):
                    pass
            return str(source)

        details = (completed.stderr or completed.stdout or "").strip()
        final_line = next(
            (line.strip() for line in reversed(details.splitlines()) if line.strip()),
            "the downloader produced no video",
        )
        failures.append(f"{attempt_name}: {final_line[-500:]}")

    cleanup_partial_download()
    diagnostic = " | ".join(failures)
    if "Sign in to confirm" in diagnostic or "not a bot" in diagnostic:
        raise RuntimeError(
            "YouTube requires authentication for this video. Upload the original "
            "video file, or configure the private YouTube cookie secret."
        )
    if "HTTP Error 403" in diagnostic or "403: Forbidden" in diagnostic:
        raise RuntimeError(
            "YouTube rejected every available high-quality download path for "
            "this video. Retry once; if it remains blocked, upload the original "
            "video file."
        )
    raise RuntimeError(
        "Could not import this YouTube video after trying all supported player "
        "clients: " + diagnostic[-1200:]
    )


def _reserve_video_match_row(sheet_url, opponent_name):
    """Create a dedicated Stats row for an upload not attached to a match card."""
    creds = get_gsheets_creds()
    gc = gspread.service_account_from_dict(creds)
    key = sheet_url.split("/")[-2]
    worksheet = gc.open_by_key(key).worksheet("Stats")
    headers = worksheet.row_values(1)
    values = {
        "Match Date": datetime.date.today().isoformat(),
        "Opp. Name": opponent_name,
        "Match Description": "Uploaded from Match Videos",
    }
    worksheet.append_row(
        [values.get(header, "") for header in headers],
        value_input_option="USER_ENTERED",
    )
    return len(worksheet.get_all_values())


def _match_video_source(sheet_url, row_index, username):
    """Resolve a reusable source saved in the Stats sheet's Match Video cell."""
    creds = get_gsheets_creds()
    gc = gspread.service_account_from_dict(creds)
    key = sheet_url.split("/")[-2]
    worksheet = gc.open_by_key(key).worksheet("Stats")
    headers = worksheet.row_values(1)
    if "Match Video" not in headers:
        raise ValueError("The match does not have a saved video")
    values = worksheet.row_values(int(row_index))
    column = headers.index("Match Video")
    raw = values[column].strip() if column < len(values) else ""
    if not raw or raw.lower().endswith("trimming video..."):
        raise ValueError("The saved match video is not ready yet")

    youtube_match = re.search(r"https?://(?:www\.|m\.)?(?:youtube\.com|youtu\.be)/\S+", raw)
    if youtube_match:
        return {"youtube_url": _canonical_youtube_url(youtube_match.group(0))}

    source = raw.rsplit(": ", 1)[-1].strip()
    if source.startswith("gs://"):
        parsed = source[5:].split("/", 1)
        if len(parsed) != 2 or parsed[0] != get_gcs_bucket():
            raise ValueError("The saved match video is not in the configured storage bucket")
        source = parsed[1]
    if not source or source.startswith(("http://", "https://", "s3://")):
        raise ValueError("The saved match video cannot be reused; upload the original video again")
    if not source.startswith(f"{username}/"):
        raise ValueError("The saved match video does not belong to this account")
    return {"gcs_blob": source}


def _download_saved_match_video(blob_name, upload_dir):
    os.makedirs(upload_dir, exist_ok=True)
    suffix = os.path.splitext(blob_name)[1].lower() or ".mp4"
    local_path = os.path.join(upload_dir, f"{uuid.uuid4().hex}{suffix}")
    client = _get_gcs_client()
    blob = client.bucket(get_gcs_bucket()).blob(blob_name)
    if not blob.exists():
        raise ValueError("The saved match video is no longer available; upload it again")
    blob.download_to_filename(local_path)
    return local_path


def _save_analysis_manifest(sheet_url, row_index, manifest_blob):
    """Persist a finished AWS manifest and surface failures for safe retries."""
    creds = get_gsheets_creds()
    gc = gspread.service_account_from_dict(creds)
    key = sheet_url.split("/")[-2]
    worksheet = gc.open_by_key(key).worksheet("Stats")
    headers = worksheet.row_values(1)
    if "Analyzed Video Link" not in headers:
        raise RuntimeError("'Analyzed Video Link' column not found in the Stats sheet")
    worksheet.update_cell(
        int(row_index), headers.index("Analyzed Video Link") + 1, manifest_blob
    )


def _signed_artifact(blob_name):
    if not blob_name:
        return None
    if str(blob_name).startswith(("http://", "https://")):
        return {"blob_name": blob_name, "url": blob_name}
    if str(blob_name).startswith("s3://"):
        url, expires_epoch = presign_s3_uri(blob_name, expiration=6 * 60 * 60)
        expires_at = datetime.datetime.fromtimestamp(
            expires_epoch, tz=datetime.timezone.utc
        )
        return {
            "blob_name": blob_name,
            "url": url,
            "expires_at": expires_at.isoformat(),
        }
    client = _get_gcs_client()
    blob = client.bucket(get_gcs_bucket()).blob(blob_name)
    # Analysis can continue for hours after the trimmed match becomes available.
    # Expose the expiry so the frontend can retain a working URL without
    # needlessly replacing the video source on every status poll.
    expires_at = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=6)
    return {
        "blob_name": blob_name,
        "url": blob.generate_signed_url(expiration=expires_at),
        "expires_at": expires_at.isoformat(),
    }


def _materialize_analysis(payload):
    """Replace private GCS blob names with fresh, browser-playable signed URLs."""
    payload = dict(payload or {})
    payload["trimmed_video"] = _signed_artifact(payload.get("trimmed_blob"))
    rallies = []
    for rally in payload.get("rallies", []):
        item = dict(rally)
        artifact = _signed_artifact(item.get("blob_name"))
        if artifact:
            item.update(artifact)
        if item.get("shot_events_blob"):
            signed = _signed_artifact(item["shot_events_blob"])
            if signed:
                item["shot_events_url"] = signed["url"]
        rallies.append(item)
    payload["rallies"] = rallies
    rallies_by_number = {}
    for rally in rallies:
        try:
            rallies_by_number[int(rally.get("number"))] = rally
        except (TypeError, ValueError):
            continue
    winner_clips = []
    for winner in payload.get("winner_clips", []):
        item = dict(winner)
        artifact = _signed_artifact(item.get("blob_name"))
        if artifact:
            item.update(artifact)
        # Winner clips are derived from the pose-labeled rally. Keep that
        # source as a separately signed recovery stream so a stale URL or a
        # browser-specific decode failure cannot leave a permanent 0:00 card.
        # This is added while materializing the manifest, so it also repairs
        # analyses that completed before the fallback was introduced.
        try:
            source_rally = rallies_by_number.get(int(item.get("rally_number")))
        except (TypeError, ValueError):
            source_rally = None
        if source_rally and source_rally.get("url"):
            item["fallback_blob_name"] = source_rally.get("blob_name")
            item["fallback_url"] = source_rally.get("url")
            item["fallback_expires_at"] = source_rally.get("expires_at")
            try:
                contact_sec = max(0.0, float(item.get("contact_sec") or 0.0))
                clip_duration = max(0.0, float(item.get("duration_sec") or 0.0))
                fallback_start = max(0.0, contact_sec - 1.75)
                item["fallback_start_sec"] = round(fallback_start, 3)
                if clip_duration > 0:
                    item["fallback_end_sec"] = round(
                        fallback_start + clip_duration, 3
                    )
            except (TypeError, ValueError):
                pass
        winner_clips.append(item)
    payload["winner_clips"] = winner_clips
    if payload.get("stats_blob"):
        payload["stats"] = _signed_artifact(payload["stats_blob"])
    return payload


@video_bp.route("/analyze", methods=["POST"])
@jwt_required()
def start_analysis():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        analysis_count = user.video_analysis_count or 0
        analysis_limit_used = user.video_analysis_limit_used or 0
        analysis_limit = user.video_analysis_limit
        if analysis_limit is None:
            analysis_limit = 3
        if analysis_limit_used >= analysis_limit:
            return jsonify({
                "error": (
                    f"You have reached your video analysis limit of {analysis_limit}. "
                    "Contact an administrator to increase it."
                ),
                "code": "VIDEO_ANALYSIS_LIMIT_REACHED",
                "video_analysis_count": analysis_count,
                "video_analysis_limit": analysis_limit,
                "video_analysis_limit_used": analysis_limit_used,
            }), 403

        video_file = request.files.get("video")
        youtube_url = request.form.get("youtube_url", "").strip()
        row_index = request.form.get("row_index", type=int)
        use_existing_video = _form_bool("use_existing_video")
        if sum([bool(video_file), bool(youtube_url), use_existing_video]) != 1:
            return jsonify({"error": "Choose one video file, one YouTube link, or the saved match video"}), 400
        saved_gcs_blob = None
        if use_existing_video:
            if row_index is None:
                return jsonify({"error": "A match is required to reuse its saved video"}), 400
            try:
                saved_source = _match_video_source(user.google_sheet_url, row_index, user.username)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            youtube_url = saved_source.get("youtube_url", "")
            saved_gcs_blob = saved_source.get("gcs_blob")
        if youtube_url:
            try:
                youtube_url = _canonical_youtube_url(youtube_url)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            if not use_existing_video and not _form_bool("youtube_authorized"):
                return jsonify({
                    "error": "Confirm that you own this YouTube video or have permission to analyze it"
                }), 400

        player_side = request.form.get("player_side", "").strip().lower()
        if player_side not in {"near", "far"}:
            return jsonify({"error": "Choose whether P1 starts on the near or far side"}), 400
        try:
            start_time_sec = _parse_start_time(request.form.get("start_time"))
            end_time_sec = _parse_end_time(request.form.get("end_time"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        if end_time_sec and end_time_sec <= start_time_sec:
            return jsonify({"error": "End time must be later than start time"}), 400

        opponent_name = request.form.get("opponent_name", "Opponent").strip() or "Opponent"
        standalone_upload = row_index is None

        tmp_path = None
        imported_filename = None
        if video_file:
            # Backend and Celery are separate containers in production. The upload
            # must live on their shared DATA_DIR volume rather than container /tmp.
            upload_dir = os.path.join(
                os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data")),
                "video_uploads",
            )
            os.makedirs(upload_dir, exist_ok=True)
            suffix = os.path.splitext(video_file.filename)[1].lower() or ".mp4"
            tmp_path = os.path.join(upload_dir, f"{uuid.uuid4().hex}{suffix}")
            video_file.save(tmp_path)
        elif saved_gcs_blob:
            upload_dir = os.path.join(
                os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data")),
                "video_uploads",
            )
            try:
                tmp_path = _download_saved_match_video(saved_gcs_blob, upload_dir)
                imported_filename = os.path.basename(saved_gcs_blob)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400

        try:
            executor = os.environ.get("VIDEO_ANALYSIS_EXECUTOR", "local").strip().lower()
            if executor == "aws_batch" and youtube_url:
                upload_dir = os.path.join(
                    os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data")),
                    "video_uploads",
                )
                tmp_path = _download_youtube_locally(youtube_url, upload_dir)
                imported_filename = os.path.basename(tmp_path)

            task_args = {
                "video_path": tmp_path,
                "youtube_url": None if tmp_path else (youtube_url or None),
                "username": user.username,
                "original_filename": (
                    video_file.filename if video_file else
                    imported_filename or "youtube-video.mp4"
                ),
                "sheet_url": user.google_sheet_url,
                "row_index": row_index,
                "standalone": standalone_upload,
                "opponent_name": opponent_name,
                "player_side": player_side,
                "player_left_handed": _form_bool("player_left_handed"),
                "player_one_handed_backhand": _form_bool("player_one_handed_backhand"),
                "opp_left_handed": _form_bool("opp_left_handed"),
                "opp_one_handed_backhand": _form_bool("opp_one_handed_backhand"),
                "start_time_sec": start_time_sec,
                "end_time_sec": end_time_sec,
            }
            if executor == "aws_batch":
                task_payload = submit_aws_analysis(**task_args)
                # Batch now owns a private S3 copy, so the shared local upload
                # can be removed immediately.
                if tmp_path:
                    os.remove(tmp_path)
            elif executor == "local":
                if youtube_url:
                    raise RuntimeError(
                        "YouTube imports require the configured AWS analysis worker"
                    )
                task_args.pop("youtube_url", None)
                task_args.pop("standalone", None)
                task = analyze_match_video.delay(
                    gcs_bucket=get_gcs_bucket(), **task_args
                )
                task_payload = {
                    "task_id": task.id,
                    "executor": "local",
                    "state": "PENDING",
                    "progress": 0,
                    "stage": "queued",
                    "message": "Video uploaded. Analysis is queued.",
                }
            else:
                raise RuntimeError(
                    "VIDEO_ANALYSIS_EXECUTOR must be 'local' or 'aws_batch'"
                )
        except Exception:
            if tmp_path and os.path.exists(tmp_path):
                os.remove(tmp_path)
            raise

        # Count each analysis once, after its worker job has been accepted.
        # This is a lifetime usage metric, so deleting a result does not reduce it.
        user.video_analysis_count = (user.video_analysis_count or 0) + 1
        user.video_analysis_limit_used = (user.video_analysis_limit_used or 0) + 1
        db.commit()

        return jsonify({
            **task_payload,
            "row_index": row_index,
            "standalone": standalone_upload,
            "opponent_name": opponent_name,
            "start_time_sec": start_time_sec,
            "end_time_sec": end_time_sec,
        })
    except AwsAuthenticationExpired as exc:
        return _aws_auth_response(exc)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@video_bp.route("/status/<task_id>", methods=["GET"])
@jwt_required()
def get_status(task_id):
    if is_aws_task(task_id):
        user_id = get_jwt_identity()
        db = SessionLocal()
        try:
            user = db.query(User).filter_by(id=int(user_id)).first()
            if not user:
                return jsonify({"error": "User not found"}), 404
            response = get_aws_status(task_id, user.username)
            if response.get("trimmed_blob"):
                response["trimmed_video"] = _signed_artifact(response["trimmed_blob"])
            if response.get("state") == "SUCCESS":
                manifest = response.get("result") or {}
                # Updating the same sheet cell is idempotent. The marker avoids
                # repeated Google Sheets writes during subsequent status polls.
                aws_request = get_aws_request(task_id, user.username)
                if mark_aws_finalized(task_id, user.username, check_only=True):
                    row_index = aws_request.get("row_index")
                    if row_index is not None:
                        _save_analysis_manifest(
                            aws_request["sheet_url"],
                            int(row_index),
                            manifest["manifest_blob"],
                        )
                    mark_aws_finalized(task_id, user.username)
                response["standalone"] = bool(aws_request.get("standalone"))
                response["result"] = _materialize_analysis(manifest)
            return jsonify(response)
        except AwsAuthenticationExpired as exc:
            return _aws_auth_response(exc, analysis_continues=True)
        except PermissionError as exc:
            return jsonify({"error": str(exc)}), 403
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500
        finally:
            db.close()

    result = AsyncResult(task_id, app=celery_app)
    response = {
        "task_id": task_id,
        "state": result.state,
    }
    if result.state == "PROGRESS":
        meta = result.info if isinstance(result.info, dict) else {}
        response.update(meta)
        if meta.get("trimmed_blob"):
            response["trimmed_video"] = _signed_artifact(meta["trimmed_blob"])
    elif result.state == "SUCCESS":
        response["progress"] = 100
        response["stage"] = "complete"
        response["result"] = _materialize_analysis(result.result)
    elif result.state == "FAILURE":
        response["error"] = str(result.info)
    return jsonify(response)


@video_bp.route("/shot-events", methods=["GET"])
@jwt_required()
def get_shot_events():
    """Proxy a shot events CSV from S3 to avoid browser CORS restrictions."""
    import urllib.request
    from flask import Response as FlaskResponse
    blob_name = request.args.get("blob_name", "")
    if not blob_name.startswith("s3://"):
        return jsonify({"error": "Invalid blob"}), 400
    try:
        url, _ = presign_s3_uri(blob_name, expiration=300)
        with urllib.request.urlopen(url, timeout=30) as resp:
            csv_text = resp.read().decode("utf-8")
        return FlaskResponse(csv_text, mimetype="text/csv")
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@video_bp.route("/analysis", methods=["GET"])
@jwt_required()
def get_analysis_manifest():
    """Load a saved analysis manifest and refresh every private media URL."""
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        blob_name = request.args.get("blob_name", "").strip()
        if not blob_name:
            return jsonify({"error": "blob_name is required"}), 400
        if blob_name.startswith(("http://", "https://")):
            return jsonify({
                "version": 0,
                "trimmed_video": {"blob_name": blob_name, "url": blob_name},
                "rallies": [],
            })
        if blob_name.startswith("s3://"):
            if not owns_manifest_uri(blob_name, user.username):
                return jsonify({"error": "Analysis does not belong to this user"}), 403
            manifest = load_s3_json(blob_name)
            if manifest.get("username") != user.username:
                return jsonify({"error": "Analysis does not belong to this user"}), 403
            return jsonify(_materialize_analysis(manifest))
        if not blob_name.startswith(f"{user.username}/"):
            return jsonify({"error": "Analysis does not belong to this user"}), 403

        client = _get_gcs_client()
        blob = client.bucket(get_gcs_bucket()).blob(blob_name)
        try:
            manifest = json.loads(blob.download_as_text())
        except (json.JSONDecodeError, UnicodeDecodeError):
            # Backwards compatibility: older rows contain one analyzed-video
            # blob instead of a JSON manifest.
            manifest = {"version": 0, "trimmed_blob": blob_name, "rallies": []}
        return jsonify(_materialize_analysis(manifest))
    except AwsAuthenticationExpired as exc:
        return _aws_auth_response(exc, analysis_continues=True)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@video_bp.route("/active-analyses", methods=["GET"])
@jwt_required()
def get_active_analyses():
    """Restore cloud jobs that are absent from this browser's local cache."""
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        if os.environ.get("VIDEO_ANALYSIS_EXECUTOR", "local").strip().lower() != "aws_batch":
            return jsonify({"analyses": []})
        analyses = list_unfinished_aws_analyses(user.username, limit=100)
        historical_count = len(analyses)
        if historical_count > (user.video_analysis_count or 0):
            user.video_analysis_count = historical_count
            db.commit()
        for analysis in analyses:
            # Return completed history immediately. Signing every artifact for
            # every completed job here makes recovery take long enough for the
            # browser request to time out, leaving public tunnel origins stuck
            # with an older local cache. The frontend loads one completed
            # analysis on demand when its accordion row is opened.
            if analysis.get("batch_state") == "SUCCEEDED":
                analysis.update(
                    state="SUCCESS",
                    progress=100,
                    stage="complete",
                    message="Analysis complete. Open to load videos.",
                )
            if (analysis.get("trimmed_blob") and
                    analysis.get("batch_state") != "SUCCEEDED"):
                analysis["trimmed_video"] = _signed_artifact(
                    analysis["trimmed_blob"]
                )
        return jsonify({"analyses": analyses})
    except AwsAuthenticationExpired as exc:
        return _aws_auth_response(exc, analysis_continues=True)
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500
    finally:
        db.close()


@video_bp.route("/analysis/<task_id>", methods=["DELETE"])
@jwt_required()
def delete_analysis(task_id):
    """Permanently delete one terminal AWS analysis owned by this user."""
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        if not is_aws_task(task_id):
            return jsonify({"error": "Only cloud analyses can be deleted"}), 400

        analysis_request = get_aws_request(task_id, user.username)
        result = delete_aws_analysis(task_id, user.username)
        db.query(ShotCorrection).filter_by(task_id=task_id).delete(
            synchronize_session=False
        )
        db.commit()

        row_index = analysis_request.get("row_index")
        if row_index is not None and user.google_sheet_url:
            try:
                creds = get_gsheets_creds()
                gc = gspread.service_account_from_dict(creds)
                key = user.google_sheet_url.split("/")[-2]
                worksheet = gc.open_by_key(key).worksheet("Stats")
                headers = worksheet.row_values(1)
                if "Analyzed Video Link" in headers:
                    column = headers.index("Analyzed Video Link") + 1
                    current = worksheet.cell(int(row_index), column).value or ""
                    if task_id in current:
                        worksheet.update_cell(int(row_index), column, "")
            except Exception as exc:
                print(f"Could not clear deleted analysis from sheet: {exc}")
        return jsonify(result)
    except AwsAuthenticationExpired as exc:
        db.rollback()
        return _aws_auth_response(exc)
    except ValueError as exc:
        db.rollback()
        return jsonify({"error": str(exc)}), 409
    except Exception as exc:
        db.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        db.close()


@video_bp.route("/signed-url/<path:blob_name>", methods=["GET"])
@jwt_required()
def get_signed_url(blob_name):
    try:
        gcs_client = _get_gcs_client()
        bucket = gcs_client.bucket(get_gcs_bucket())
        blob = bucket.blob(blob_name)
        url = blob.generate_signed_url(expiration=datetime.timedelta(hours=1))
        return jsonify({"url": url})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@video_bp.route("/matches", methods=["GET"])
@jwt_required()
def get_video_matches():
    """Get matches that have videos from the user's sheet."""
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Sheet not found"}), 404

        creds = get_gsheets_creds()
        gc = gspread.service_account_from_dict(creds)
        key = user.google_sheet_url.split("/")[-2]
        sp = gc.open_by_key(key)
        ws = sp.worksheet("Stats")
        records = ws.get_all_records()

        matches_with_video = []
        for i, record in enumerate(records):
            video = record.get("Match Video", "")
            analyzed = record.get("Analyzed Video Link", "")
            if video or analyzed:
                matches_with_video.append({
                    "row_index": i + 2,
                    "opponent": record.get("Opp. Name", "Unknown"),
                    "date": record.get("Match Date", ""),
                    "result": record.get("Result", ""),
                    "score": record.get("Match Score", ""),
                    "video": video,
                    "analyzed_video": analyzed,
                })

        return jsonify({"matches": matches_with_video})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@video_bp.route("/correction", methods=["POST"])
@jwt_required()
def save_correction():
    """Save a user correction for a pose-detected shot."""
    user_id = get_jwt_identity()
    body = request.get_json(silent=True) or {}
    task_id      = body.get("task_id")
    rally_number = body.get("rally_number")
    frame        = body.get("frame")
    player       = body.get("player")
    detected     = body.get("detected")
    corrected    = body.get("corrected")   # None/null = marked correct
    keypoints_json = body.get("keypoints_json")

    if not all(v is not None for v in [task_id, rally_number, frame, player, detected]):
        return jsonify({"error": "Missing required fields"}), 400

    if keypoints_json is not None:
        try:
            keypoints = json.loads(keypoints_json)
            if (
                not isinstance(keypoints, list) or len(keypoints) != 17 or
                any(not isinstance(point, list) or len(point) != 3 for point in keypoints)
            ):
                raise ValueError
            keypoints_json = json.dumps(keypoints, separators=(",", ":"))
        except (TypeError, ValueError, json.JSONDecodeError):
            return jsonify({"error": "Invalid pose features"}), 400

    db = SessionLocal()
    try:
        existing = (
            db.query(ShotCorrection)
            .filter_by(user_id=int(user_id), task_id=task_id,
                       rally_number=int(rally_number), frame=int(frame),
                       player=int(player))
            .first()
        )
        if existing:
            existing.corrected = corrected
            if keypoints_json:
                existing.keypoints_json = keypoints_json
        else:
            db.add(ShotCorrection(
                user_id      = int(user_id),
                task_id      = task_id,
                rally_number = int(rally_number),
                frame        = int(frame),
                player       = int(player),
                detected     = detected,
                corrected    = corrected,
                keypoints_json = keypoints_json,
                created_at   = datetime.datetime.utcnow().isoformat(),
            ))
        db.commit()
        if keypoints_json:
            train_reviewed_shot_classifier.delay()
        return jsonify({"ok": True})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@video_bp.route("/corrections/<task_id>", methods=["GET"])
@jwt_required()
def get_corrections(task_id):
    """Return all corrections a user has made for a given analysis."""
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        rows = (
            db.query(ShotCorrection)
            .filter_by(user_id=int(user_id), task_id=task_id)
            .all()
        )
        return jsonify({
            "corrections": [
                {
                    "rally_number": r.rally_number,
                    "frame":        r.frame,
                    "player":       r.player,
                    "detected":     r.detected,
                    "corrected":    r.corrected,
                }
                for r in rows
            ]
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
