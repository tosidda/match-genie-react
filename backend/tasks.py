import os
import uuid
import mimetypes
import tempfile

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
celery_app = Celery('tasks', broker='redis://localhost:6379/0', backend='redis://localhost:6379/0')

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
