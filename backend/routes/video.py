import datetime
import tempfile
import os

import gspread
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from google.oauth2.service_account import Credentials
from google.cloud import storage
from celery.result import AsyncResult

from database import SessionLocal, User
from config import get_gsheets_creds, get_gcs_bucket
from tasks import analyze_video, celery_app

video_bp = Blueprint("video", __name__)


def _get_gcs_client():
    creds_dict = get_gsheets_creds()
    return storage.Client(credentials=Credentials.from_service_account_info(creds_dict))


@video_bp.route("/analyze", methods=["POST"])
@jwt_required()
def start_analysis():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404

        video_file = request.files.get("video")
        row_index = request.form.get("row_index", type=int)

        if not video_file:
            return jsonify({"error": "No video file provided"}), 400

        suffix = os.path.splitext(video_file.filename)[1]
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
            tmp.write(video_file.read())
            tmp_path = tmp.name

        task = analyze_video.delay(
            video_path=tmp_path,
            gcs_bucket=get_gcs_bucket(),
            username=user.username,
            original_filename=video_file.filename,
            sheet_url=user.google_sheet_url,
            row_index=row_index or 2,
        )

        return jsonify({"task_id": task.id, "message": "Analysis started"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@video_bp.route("/status/<task_id>", methods=["GET"])
@jwt_required()
def get_status(task_id):
    result = AsyncResult(task_id, app=celery_app)
    response = {
        "task_id": task_id,
        "state": result.state,
    }
    if result.state == "PROGRESS":
        response["progress"] = result.info.get("progress", 0)
    elif result.state == "SUCCESS":
        response["result"] = result.result
    elif result.state == "FAILURE":
        response["error"] = str(result.info)
    return jsonify(response)


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
