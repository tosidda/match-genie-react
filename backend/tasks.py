import os
import uuid
import mimetypes
import tempfile
import csv
import glob
import json
import re
import shutil
import subprocess
import sys

import gspread
from celery import Celery
from google.oauth2 import service_account

# Lazy imports for heavy dependencies (cv2, ultralytics, numpy, gcs, tqdm)
# These are only needed when Celery tasks actually run, not at import time.
cv2 = None
np = None
gcs = None
tqdm = None
YOLO = None

def _load_heavy_deps():
    global cv2, np, gcs, tqdm, YOLO
    if cv2 is None:
        import cv2 as _cv2
        import numpy as _np
        from google.cloud import storage as _gcs
        from tqdm import tqdm as _tqdm
        from ultralytics import YOLO as _YOLO
        cv2 = _cv2
        np = _np
        gcs = _gcs
        tqdm = _tqdm
        YOLO = _YOLO
import toml

# Celery configuration
# Use Redis as the message broker and result backend.
_redis_url = os.environ.get("REDIS_URL", "redis://redis:6379/0")
celery_app = Celery('tasks', broker=_redis_url, backend=_redis_url)


@celery_app.task(name="train_reviewed_shot_classifier")
def train_reviewed_shot_classifier():
    """Retrain and publish after a safe batch of new reviewed pose examples."""
    from database import DB_PATH, SessionLocal, ShotCorrection

    minimum = max(20, int(os.environ.get("SHOT_FEEDBACK_MIN_SAMPLES", "30")))
    interval = max(5, int(os.environ.get("SHOT_FEEDBACK_RETRAIN_INTERVAL", "10")))
    db = SessionLocal()
    try:
        usable = db.query(ShotCorrection).filter(
            ShotCorrection.keypoints_json.isnot(None),
            ShotCorrection.keypoints_json != "",
        ).count()
    finally:
        db.close()
    if usable < minimum:
        return {"trained": False, "reason": "not_enough_samples", "samples": usable}

    data_dir = os.environ.get("DATA_DIR", "/app/data")
    model_dir = os.path.join(data_dir, "feedback_models")
    os.makedirs(model_dir, exist_ok=True)
    metadata_path = os.path.join(model_dir, "shot_classifier_feedback.json")
    if os.path.exists(metadata_path):
        try:
            with open(metadata_path, encoding="utf-8") as metadata_file:
                trained_samples = int(json.load(metadata_file).get("samples", 0))
        except (OSError, ValueError, TypeError):
            trained_samples = 0
        if usable - trained_samples < interval:
            return {"trained": False, "reason": "waiting_for_batch", "samples": usable}

    runtime = _analysis_runtime()
    output = os.path.join(model_dir, "shot_classifier_feedback.pt")
    command = [
        runtime["python"],
        os.path.join(runtime["scripts_dir"], "train_shot_classifier.py"),
        "--feedback-db", DB_PATH,
        "--output", output,
        "--backend", "torch",
        "--epochs", os.environ.get("SHOT_FEEDBACK_EPOCHS", "120"),
    ]
    _run_analysis_command(command, cwd=runtime["project_dir"])
    if not os.path.exists(output):
        raise RuntimeError("Reviewed classifier training produced no model")

    published_key = None
    try:
        from aws_batch import publish_feedback_model
        published_key = publish_feedback_model(output)
    except Exception as exc:
        # Keep the locally trained model available even during temporary cloud
        # authentication/control-plane outages; the next batch retries publish.
        print(f"Reviewed model trained locally but publish is pending: {exc}", flush=True)

    with open(metadata_path, "w", encoding="utf-8") as metadata_file:
        json.dump({"samples": usable, "published_key": published_key}, metadata_file)
    return {"trained": True, "samples": usable, "published_key": published_key}

# --- Helper function to load secrets for the Celery worker ---
def load_streamlit_secrets():
    """Loads secrets from the .streamlit/secrets.toml file."""
    secrets_path = os.path.join(os.path.dirname(__file__), '.streamlit', 'secrets.toml')
    try:
        return toml.load(secrets_path)
    except FileNotFoundError:
        print(f"Secrets file not found at {secrets_path}. Make sure it exists.")
        return {}
    except Exception as e:
        print(f"Error loading secrets file: {e}")
        return {}

# --- GCS Helper ---
def upload_local_file_to_gcs(local_file_path, gcs_bucket, username, original_filename):
    """Uploads a local file to GCS."""
    global gcs
    if gcs is None:
        from google.cloud import storage as _gcs
        gcs = _gcs
    secrets = load_streamlit_secrets()
    creds_dict = secrets.get("connections", {}).get("gsheets", {})
    storage_creds = service_account.Credentials.from_service_account_info(creds_dict)
    client = gcs.Client(credentials=storage_creds, project=creds_dict.get("project_id"))
    bucket = client.bucket(gcs_bucket)

    unique_id = uuid.uuid4()
    file_extension = os.path.splitext(original_filename)[1]
    key = f"{username}/{unique_id}_{os.path.basename(original_filename)}"

    blob = bucket.blob(key)
    content_type, _ = mimetypes.guess_type(local_file_path)
    if content_type is None:
        content_type = 'application/octet-stream'
    blob.upload_from_filename(local_file_path, content_type=content_type)
    return key

# --- Video Processing ---
def trim_video(input_video_path, output_video_path):
    """Trims a video to keep only segments with significant movement (rallies)."""
    _load_heavy_deps()
    roi = None
    movement_threshold = 5000
    min_rally_duration_secs = 2
    cooldown_secs = 2

    cap = cv2.VideoCapture(input_video_path)
    if not cap.isOpened():
        print(f"Error: Cannot open video file {input_video_path}")
        return None

    fps = cap.get(cv2.CAP_PROP_FPS)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    movement_scores = []
    prev_frame = None

    for _ in tqdm(range(frame_count), desc="Processing frames"):
        ret, frame = cap.read()
        if not ret:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (21, 21), 0)
        if prev_frame is None:
            prev_frame = gray
            movement_scores.append(0)
            continue
        frame_diff = cv2.absdiff(prev_frame, gray)
        score = cv2.countNonZero(frame_diff)
        movement_scores.append(score)
        prev_frame = gray
    cap.release()

    threshold = np.percentile(movement_scores, 40)
    min_rally_frames = int(min_rally_duration_secs * fps)
    cooldown_frames = int(cooldown_secs * fps)

    segments = []
    in_rally = False
    start_frame = 0
    last_rally_end_frame = -cooldown_frames

    for i, score in enumerate(movement_scores):
        is_moving = score > threshold
        if not in_rally and is_moving and (i - last_rally_end_frame) > cooldown_frames:
            in_rally = True
            start_frame = i
        elif in_rally and not is_moving:
            if (i - start_frame) >= min_rally_frames:
                segments.append((start_frame, i))
                last_rally_end_frame = i
            in_rally = False
    if in_rally and (len(movement_scores) - start_frame) >= min_rally_frames:
        segments.append((start_frame, len(movement_scores)))

    if not segments:
        print("No significant rallies were detected. The output video will be empty.")
        open(output_video_path, 'a').close()
        return output_video_path

    cap = cv2.VideoCapture(input_video_path)
    # Use 'avc1' codec for H.264, which is more compatible than 'mp4v'
    fourcc = cv2.VideoWriter_fourcc(*'avc1')
    out = cv2.VideoWriter(output_video_path, fourcc, fps, (width, height))

    print(f"Exporting {len(segments)} rally segments to new video...")

    # Create a set of all frame indices that should be included for fast lookup
    rally_frames = set()
    for start, end in segments:
        for i in range(start, end):
            rally_frames.add(i)

    print(f"Total frames to write: {len(rally_frames)}")

    for frame_idx in tqdm(range(frame_count), desc="Writing frames"):
        ret, frame = cap.read()
        if not ret:
            break
        if frame_idx in rally_frames:
            out.write(frame)

    cap.release()
    out.release()
    print("Finished exporting video.")
    return output_video_path


def _first_existing(*paths):
    for path in paths:
        if path and os.path.exists(os.path.expanduser(path)):
            return os.path.abspath(os.path.expanduser(path))
    return None


def _analysis_runtime():
    """Resolve the separate CV project and model paths used by the worker."""
    default_project = os.path.abspath(os.path.join(
        os.path.dirname(__file__), "..", "..", "video-analysis-work-for-match-genie"
    ))
    project_dir = os.path.abspath(os.path.expanduser(
        os.environ.get("VIDEO_ANALYSIS_PROJECT_DIR", default_project)
    ))
    scripts_dir = os.path.join(project_dir, "scripts")

    configured_python = os.environ.get("VIDEO_ANALYSIS_PYTHON")
    local_analysis_python = os.path.expanduser(
        "~/miniconda/envs/match-genie-env/bin/python"
    )
    python_bin = _first_existing(configured_python, local_analysis_python, sys.executable)

    det_weights = _first_existing(
        os.environ.get("VIDEO_ANALYSIS_DET_WEIGHTS"),
        "~/Downloads/best_det_v4.pt",
        os.path.join(project_dir, "runs", "detect", "runs", "tennis", "v2", "weights", "best.pt"),
    )
    seg_weights = _first_existing(
        os.environ.get("VIDEO_ANALYSIS_SEG_WEIGHTS"),
        "~/Downloads/best_seg_v1.pt",
        os.path.join(project_dir, "weights", "best_seg_v1.pt"),
    )
    pose_weights = _first_existing(
        os.environ.get("VIDEO_ANALYSIS_POSE_WEIGHTS"),
        os.path.join(project_dir, "yolov8m-pose.pt"),
    )

    required = {
        "analysis scripts": scripts_dir,
        "analysis Python": python_bin,
        "ball/player model": det_weights,
        "court segmentation model": seg_weights,
        "pose model": pose_weights,
    }
    missing = [name for name, path in required.items() if not path or not os.path.exists(path)]
    if missing:
        raise RuntimeError(
            "Video analysis is not configured: missing " + ", ".join(missing) +
            ". Set VIDEO_ANALYSIS_PROJECT_DIR, VIDEO_ANALYSIS_PYTHON, and the "
            "VIDEO_ANALYSIS_*_WEIGHTS environment variables."
        )
    if shutil.which("ffmpeg") is None:
        raise RuntimeError("ffmpeg is required for video trimming and browser playback")

    return {
        "project_dir": project_dir,
        "scripts_dir": scripts_dir,
        "python": python_bin,
        "det_weights": det_weights,
        "seg_weights": seg_weights,
        "pose_weights": pose_weights,
        "imgsz": int(os.environ.get("VIDEO_ANALYSIS_IMGSZ", "1280")),
        "conf": float(os.environ.get("VIDEO_ANALYSIS_CONF", "0.25")),
    }


def _run_analysis_command(command, cwd, line_callback=None):
    """Stream child output to Celery logs and raise with useful tail context."""
    print("Running:", " ".join(command), flush=True)
    process = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    tail = []
    for line in process.stdout or []:
        print(line, end="", flush=True)
        if line_callback:
            line_callback(line)
        tail.append(line.rstrip())
        if len(tail) > 80:
            tail.pop(0)
    return_code = process.wait()
    if return_code != 0:
        raise RuntimeError(
            f"Analysis command failed with exit code {return_code}:\n" + "\n".join(tail)
        )


def _transcode_for_browser(input_path, output_path, include_audio=False,
                           start_time=0.0, duration=0.0):
    command = ["ffmpeg", "-y"]
    if start_time and float(start_time) > 0:
        command.extend(["-ss", str(float(start_time))])
    command.extend(["-i", input_path])
    if duration and float(duration) > 0:
        command.extend(["-t", str(float(duration))])
    command.extend(["-map", "0:v:0"])
    if include_audio:
        command.extend(["-map", "0:a?"])
    command.extend([
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
    ])
    if include_audio:
        command.extend(["-c:a", "aac", "-b:a", "128k"])
    else:
        command.append("-an")
    command.append(output_path)
    _run_analysis_command(command, cwd=os.path.dirname(output_path))


@celery_app.task(bind=True)
def analyze_match_video(
        self, video_path, gcs_bucket, username, original_filename, sheet_url,
        row_index, opponent_name="Opponent", player_side="near",
        player_left_handed=False, player_one_handed_backhand=False,
        opp_left_handed=False, opp_one_handed_backhand=False,
        start_time_sec=0.0, end_time_sec=0.0):
    """Trim a match, extract rallies, pose-label each rally, and upload artifacts."""
    job_dir = None

    def progress(percent, stage, message, trimmed_blob=None,
                 rallies_complete=0, rally_count=None):
        meta = {
            "progress": int(percent),
            "stage": stage,
            "message": message,
            "rallies_complete": rallies_complete,
        }
        if rally_count is not None:
            meta["rally_count"] = rally_count
        if trimmed_blob:
            meta["trimmed_blob"] = trimmed_blob
        self.update_state(state="PROGRESS", meta=meta)

    try:
        runtime = _analysis_runtime()
        job_dir = tempfile.mkdtemp(prefix="matchgenie_analysis_")
        trim_dir = os.path.join(job_dir, "trim")
        rallies_dir = os.path.join(job_dir, "rallies")
        os.makedirs(trim_dir, exist_ok=True)
        os.makedirs(rallies_dir, exist_ok=True)

        start_time_sec = max(0.0, float(start_time_sec or 0.0))
        end_time_sec = max(0.0, float(end_time_sec or 0.0))
        if end_time_sec and end_time_sec <= start_time_sec:
            raise ValueError("End time must be later than start time")
        if end_time_sec:
            range_note = f" between {start_time_sec:.1f}s and {end_time_sec:.1f}s"
        else:
            range_note = f" from {start_time_sec:.1f}s" if start_time_sec else ""
        progress(
            2, "trimming",
            f"Finding active tennis{range_note} and removing dead time",
        )
        trim_command = [
            runtime["python"], os.path.join(runtime["scripts_dir"], "rally_trimmer.py"),
            "--source", video_path,
            "--det_weights", runtime["det_weights"],
            "--output", trim_dir,
            "--conf", str(runtime["conf"]),
            "--imgsz", str(runtime["imgsz"]),
            "--gap_sec", "4.0",
            "--min_sec", "1.0",
            "--pad_sec", "3.0",
            "--stride", "4",
            "--min_vel", "3.0",
            "--start_time", str(start_time_sec),
            "--end_time", str(end_time_sec),
            "--no_clips",
        ]
        trim_bounds = {"start": None, "end": None}

        def trim_progress(line):
            bounds_match = re.search(r"Scanning frames\s+(\d+)-(\d+)", line)
            if bounds_match:
                trim_bounds["start"] = int(bounds_match.group(1))
                trim_bounds["end"] = int(bounds_match.group(2))
                return
            match = re.search(r"^\s*(\d+)/(\d+)\s+\(", line)
            if not match:
                return
            current_frame = int(match.group(1))
            reported_end = int(match.group(2))
            start_frame = trim_bounds["start"]
            end_frame = trim_bounds["end"] or reported_end
            if start_frame is None:
                return
            span = max(1, end_frame - start_frame)
            fraction = max(0.0, min(1.0, (current_frame - start_frame) / span))
            percent = 2 + int(20 * fraction)
            progress(
                percent, "trimming",
                f"Scanning selected video: {fraction * 100:.0f}% complete",
            )

        _run_analysis_command(
            trim_command, cwd=runtime["project_dir"],
            line_callback=trim_progress,
        )

        edited_candidates = sorted(glob.glob(os.path.join(trim_dir, "*_edited.mp4")))
        trimmed_source = edited_candidates[0] if edited_candidates else video_path
        # If the detector could not build an edited match, retain the remainder
        # of the source as a fallback—but still honor the user's chosen start.
        fallback_start = 0.0 if edited_candidates else start_time_sec
        fallback_duration = 0.0
        if not edited_candidates and end_time_sec:
            fallback_duration = end_time_sec - start_time_sec
        trimmed_web = os.path.join(job_dir, "trimmed_match.mp4")
        _transcode_for_browser(
            trimmed_source, trimmed_web, include_audio=True,
            start_time=fallback_start, duration=fallback_duration,
        )
        trimmed_blob = upload_local_file_to_gcs(
            trimmed_web, gcs_bucket, username,
            f"trimmed_{os.path.splitext(os.path.basename(original_filename))[0]}.mp4",
        )
        progress(
            25, "segmenting",
            "Trimmed match is ready. Detecting serves and rally boundaries",
            trimmed_blob=trimmed_blob,
        )

        segment_command = [
            runtime["python"], os.path.join(runtime["scripts_dir"], "rally_segmenter.py"),
            "--source", trimmed_web,
            "--output_dir", rallies_dir,
            "--det_weights", runtime["det_weights"],
            "--seg_weights", runtime["seg_weights"],
            "--pose_weights", runtime["pose_weights"],
            "--imgsz", str(runtime["imgsz"]),
            "--conf", str(runtime["conf"]),
            "--p1_start_side", player_side,
        ]
        feedback_model = os.path.join(
            os.environ.get("DATA_DIR", "/app/data"),
            "feedback_models", "shot_classifier_feedback.pt",
        )
        if os.path.exists(feedback_model):
            segment_command += ["--mlp_weights", feedback_model]
        if player_left_handed:
            segment_command.append("--left_handed_p1")
        if player_one_handed_backhand:
            segment_command.append("--one_handed_backhand_p1")
        if opp_left_handed:
            segment_command.append("--left_handed_p2")
        if opp_one_handed_backhand:
            segment_command.append("--one_handed_backhand_p2")

        _run_analysis_command(segment_command, cwd=runtime["project_dir"])

        index_path = os.path.join(rallies_dir, "rally_index.csv")
        rally_rows = []
        if os.path.exists(index_path):
            with open(index_path, newline="") as index_file:
                rally_rows = list(csv.DictReader(index_file))
        if not rally_rows:
            raise RuntimeError(
                "Rally segmentation completed without producing any rallies. "
                "The trimmed match is available, but no unlabeled fallback clips "
                "will be presented as completed analysis."
            )

        scripts_dir = os.path.join(runtime["project_dir"], "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)
        from winner_clips import build_winner_clip

        rally_artifacts = []
        winner_artifacts = []
        rally_count = len(rally_rows)
        progress(
            80, "uploading_rallies",
            f"Pose labeling complete. Preparing {rally_count} rally videos",
            trimmed_blob=trimmed_blob,
            rally_count=rally_count,
        )
        for position, row in enumerate(rally_rows, start=1):
            rally_number = int(row.get("rally_num") or position)
            raw_clip = row.get("clip") or os.path.join(
                rallies_dir, f"rally_{rally_number:03d}.mp4"
            )
            pose_dir = os.path.splitext(raw_clip)[0] + "_pose"
            expected = os.path.join(
                pose_dir,
                f"{os.path.splitext(os.path.basename(raw_clip))[0]}_pose_shots.mp4",
            )
            if not os.path.exists(expected):
                alternatives = glob.glob(os.path.join(pose_dir, "*_pose_shots.mp4"))
                expected = alternatives[0] if alternatives else None
            if not expected:
                raise RuntimeError(f"Pose-labeled output missing for Rally {rally_number}")

            web_rally = os.path.join(job_dir, f"rally_{rally_number:03d}_labeled.mp4")
            _transcode_for_browser(expected, web_rally, include_audio=False)
            rally_blob = upload_local_file_to_gcs(
                web_rally, gcs_bucket, username,
                f"rally_{rally_number:03d}_labeled.mp4",
            )
            rally_artifacts.append({
                "number": rally_number,
                "blob_name": rally_blob,
                "start_sec": row.get("start_sec"),
                "end_sec": row.get("end_sec"),
                "duration_sec": row.get("duration_sec"),
            })

            shot_event_files = sorted(
                glob.glob(os.path.join(pose_dir, "*_shot_events.csv"))
            )
            if shot_event_files:
                try:
                    winner_path = os.path.join(
                        job_dir, "winners", f"rally_{rally_number:03d}_winner.mp4"
                    )
                    winner = build_winner_clip(
                        shot_event_files[0], web_rally, winner_path,
                        rally_number=rally_number,
                        rally_start_sec=float(row.get("start_sec") or 0.0),
                        rally_start_frame=int(float(row.get("start_frame") or 0)),
                    )
                    if winner is not None:
                        winner_blob = upload_local_file_to_gcs(
                            winner_path, gcs_bucket, username,
                            (f"winner_{winner['shot_type']}_rally_"
                             f"{rally_number:03d}_{winner['player_label'].lower()}.mp4"),
                        )
                        winner["blob_name"] = winner_blob
                        winner_artifacts.append(winner)
                except Exception as exc:
                    print(
                        f"Skipping winner clip for Rally {rally_number}: {exc}",
                        flush=True,
                    )
            progress(
                80 + int(15 * position / max(1, rally_count)),
                "uploading_rallies",
                f"Preparing Rally {position} of {rally_count}",
                trimmed_blob=trimmed_blob,
                rallies_complete=position,
                rally_count=rally_count,
            )

        stats_blob = None
        stats_path = os.path.join(rallies_dir, "shot_stats.csv")
        if os.path.exists(stats_path):
            stats_blob = upload_local_file_to_gcs(
                stats_path, gcs_bucket, username, "shot_stats.csv"
            )

        manifest = {
            "version": 2,
            "username": username,
            "opponent_name": opponent_name,
            "p1_start_side": player_side,
            "analysis_start_sec": start_time_sec,
            "analysis_end_sec": end_time_sec or None,
            "trimmed_blob": trimmed_blob,
            "rallies": rally_artifacts,
            "winner_clips": winner_artifacts,
            "stats_blob": stats_blob,
        }
        manifest_path = os.path.join(job_dir, "analysis_manifest.json")
        with open(manifest_path, "w") as manifest_file:
            json.dump(manifest, manifest_file, indent=2)
        manifest_blob = upload_local_file_to_gcs(
            manifest_path, gcs_bucket, username, "analysis_manifest.json"
        )
        manifest["manifest_blob"] = manifest_blob

        if row_index is not None:
            update_sheet_with_gcs_link(sheet_url, row_index, manifest_blob)
        progress(
            100, "complete", f"Analysis complete: {rally_count} rallies",
            trimmed_blob=trimmed_blob,
            rallies_complete=rally_count,
            rally_count=rally_count,
        )
        return manifest
    finally:
        if os.path.exists(video_path):
            os.remove(video_path)
        if job_dir:
            shutil.rmtree(job_dir, ignore_errors=True)

@celery_app.task(bind=True)
def analyze_video(self, video_path, gcs_bucket, username, original_filename, sheet_url, row_index):
   """Analyzes a video, uploads to GCS, updates Google Sheet, and returns the blob name."""
   _load_heavy_deps()
   model = YOLO("yolov8x.pt")
   cap = cv2.VideoCapture(video_path)
   if not cap.isOpened():
       print(f"Error: Could not open video.")
       return None

   width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
   height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
   fps = cap.get(cv2.CAP_PROP_FPS)
   total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
   frame_count = 0

   # Log the estimate
   estimated_seconds = (total_frames * 0.5) / 1 # Assuming ~0.5s per frame
   estimated_minutes = estimated_seconds / 60
   print(f"Starting analysis for video with {total_frames} frames.")
   print(f"Estimated completion time: {estimated_minutes:.2f} minutes.")

   with tempfile.NamedTemporaryFile(delete=False, suffix='.mp4') as tmpfile:
       output_path = tmpfile.name

   fourcc = cv2.VideoWriter_fourcc(*'avc1')
   out = cv2.VideoWriter(output_path, fourcc, fps, (width, height))

   while cap.isOpened():
       success, frame = cap.read()
       if not success:
           break

       # Update progress before the heavy processing
       frame_count += 1
       progress = (frame_count / total_frames) * 100
       self.update_state(state='PROGRESS', meta={'progress': round(progress, 2)})

       # Run tracking with verbose=False to prevent excessive logging
       results = model.track(frame, persist=True, conf=0.25, classes=[0, 32], verbose=False)
       annotated_frame = results[0].plot()
       out.write(annotated_frame)

   cap.release()
   out.release()

   try:
       analyzed_filename = f"analyzed_{uuid.uuid4()}_{os.path.basename(original_filename)}"
       processed_blob_name = upload_local_file_to_gcs(
           output_path,
           gcs_bucket,
           username,
           analyzed_filename
       )

       update_sheet_with_gcs_link(sheet_url, row_index, processed_blob_name)

   finally:
       os.remove(video_path)
       os.remove(output_path)

   return processed_blob_name


def update_sheet_with_gcs_link(sheet_url, row_index, blob_name):
   """Updates a specific cell in the Google Sheet with the new GCS blob name."""
   secrets = load_streamlit_secrets()
   gsheets_creds = secrets.get("connections", {}).get("gsheets", {})
   try:
       gc = gspread.service_account_from_dict(gsheets_creds)
       spreadsheet_key = sheet_url.split('/')[-2]
       spreadsheet = gc.open_by_key(spreadsheet_key)
       worksheet = spreadsheet.worksheet("Stats")
       
       headers = worksheet.row_values(1)
       try:
           col_index = headers.index("Analyzed Video Link") + 1
           worksheet.update_cell(row_index, col_index, blob_name)
       except ValueError:
           print("Error: 'Analyzed Video Link' column not found in the sheet.")

   except Exception as e:
       print(f"Error updating Google Sheet: {e}")


@celery_app.task
def process_video_task(temp_video_path, gcs_bucket, username, opponent_name, match_date_str, sheet_url, row_index):
   """Celery task to trim video, upload to GCS, and update Google Sheet."""
   _load_heavy_deps()
   try:
       print(f"Starting video processing for {temp_video_path}")
       output_video_path = os.path.splitext(temp_video_path)[0] + "_trimmed.mp4"
      
       # 1. Trim the video
       trim_video(temp_video_path, output_video_path)
       print(f"Video trimmed. Output at {output_video_path}")


       # 2. Upload to GCS
       gcs_uri = upload_local_file_to_gcs(
           output_video_path, gcs_bucket, username, os.path.basename(temp_video_path)
       )
       print(f"Uploaded to GCS: {gcs_uri}")


       # 3. Update Google Sheet
       secrets = load_streamlit_secrets()
       gsheets_creds = secrets.get("connections", {}).get("gsheets", {})
       gc = gspread.service_account_from_dict(gsheets_creds)
       spreadsheet = gc.open_by_key(sheet_url.split("/")[-2])
       worksheet = spreadsheet.worksheet("Stats")
       final_video_text = f"{opponent_name}, {match_date_str}: {gcs_uri}"
       worksheet.update_cell(row_index, 26, final_video_text)
       print(f"Google Sheet updated for row {row_index}")


   except Exception as e:
       print(f"An error occurred during video processing: {e}")
       # Optionally, update the sheet with an error message
       # ...


   finally:
       # 4. Cleanup temporary files
       if os.path.exists(temp_video_path):
           os.remove(temp_video_path)
       if os.path.exists(output_video_path):
           os.remove(output_video_path)
       print("Temporary files cleaned up.")
