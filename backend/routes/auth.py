import os
import bcrypt
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, send_from_directory
from flask_jwt_extended import create_access_token, jwt_required, get_jwt_identity
from google.oauth2 import service_account, id_token
from google.auth.transport import requests as google_requests
from googleapiclient.discovery import build
from werkzeug.utils import secure_filename

from database import SessionLocal, User
from config import get_gsheets_creds, get_google_oauth_config, get_admin_usernames

UPLOAD_FOLDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

auth_bp = Blueprint("auth", __name__)


def user_dict(user):
    admin_usernames = [u.strip().lower() for u in get_admin_usernames()]
    return {
        "id": user.id,
        "username": user.username,
        "email": user.email or "",
        "google_sheet_url": user.google_sheet_url,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "location": user.location,
        "utr": user.utr,
        "profile_pic": user.profile_pic,
        "subscription_tier": user.subscription_tier or "free",
        "is_admin": user.username.strip().lower() in admin_usernames,
        "is_google_user": bool(user.google_id),
    }

SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive']

SHEET_HEADERS = [
    "First Serve %", "First Serve % Won", "Second Serve %", "Aces",
    "Serve Speed", "Serve Placement", "Double Faults", "Return %",
    "Return Placement", "Winners", "Average Rally Length", "Unforced Errors",
    "Forced Errors", "Net Points Won", "Break Points Won", "Break Points Saved",
    "Mental Game", "Match Date", "Match Score", "Surface Type", "Opp. Name",
    "Opp. Ranking", "Opp. Playing Style", "Result", "Match Description",
    "Match Video", "UTR", "Analyzed Video Link"
]


def hash_password(password):
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt())


def check_password(password, hashed):
    return bcrypt.checkpw(password.encode("utf-8"), hashed)


def create_google_sheet(username):
    creds_dict = get_gsheets_creds()
    creds = service_account.Credentials.from_service_account_info(creds_dict, scopes=SCOPES)
    drive_service = build("drive", "v3", credentials=creds)
    sheets_service = build("sheets", "v4", credentials=creds)

    spreadsheet_body = {"properties": {"title": f"{username}'s Match Log"}}
    spreadsheet = sheets_service.spreadsheets().create(
        body=spreadsheet_body, fields="spreadsheetId,spreadsheetUrl,sheets.properties"
    ).execute()
    spreadsheet_id = spreadsheet.get("spreadsheetId")
    sheet_url = spreadsheet.get("spreadsheetUrl")
    original_sheet_id = spreadsheet["sheets"][0]["properties"]["sheetId"]

    rename_request = {
        "updateSheetProperties": {
            "properties": {"sheetId": original_sheet_id, "title": "Stats"},
            "fields": "title",
        }
    }
    sheets_service.spreadsheets().batchUpdate(
        spreadsheetId=spreadsheet_id, body={"requests": [rename_request]}
    ).execute()

    value_range_body = {"values": [SHEET_HEADERS]}
    sheets_service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id, range="Stats!A1",
        valueInputOption="RAW", body=value_range_body
    ).execute()

    return sheet_url


@auth_bp.route("/signup", methods=["POST"])
def signup():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    if not username or not password:
        return jsonify({"error": "Username and password are required"}), 400

    db = SessionLocal()
    try:
        if db.query(User).filter_by(username=username).first():
            return jsonify({"error": "Username already exists"}), 409

        hashed = hash_password(password)
        sheet_url = create_google_sheet(username)

        new_user = User(username=username, hashed_password=hashed, google_sheet_url=sheet_url)
        db.add(new_user)
        db.commit()
        db.refresh(new_user)

        token = create_access_token(identity=str(new_user.id))
        return jsonify({
            "token": token,
            "user": user_dict(new_user)
        }), 201
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@auth_bp.route("/login", methods=["POST"])
def login():
    data = request.get_json()
    username = data.get("username", "").strip()
    password = data.get("password", "").strip()

    db = SessionLocal()
    try:
        user = db.query(User).filter_by(username=username).first()
        if not user or not user.hashed_password:
            return jsonify({"error": "Invalid username or password"}), 401

        if not check_password(password, user.hashed_password):
            return jsonify({"error": "Invalid username or password"}), 401

        if user.is_archived:
            return jsonify({"error": "This account has been disabled."}), 403

        user.last_login = datetime.now(timezone.utc).isoformat()
        db.commit()

        token = create_access_token(identity=str(user.id))
        return jsonify({
            "token": token,
            "user": user_dict(user)
        })
    finally:
        db.close()


@auth_bp.route("/google", methods=["POST"])
def google_login():
    data = request.get_json()
    credential = data.get("credential", "")

    if not credential:
        return jsonify({"error": "Google credential is required"}), 400

    try:
        oauth_config = get_google_oauth_config()
        idinfo = id_token.verify_oauth2_token(
            credential, google_requests.Request(), oauth_config["client_id"]
        )
        google_id = idinfo["sub"]
        email = idinfo.get("email", "")

        db = SessionLocal()
        try:
            user = db.query(User).filter_by(google_id=google_id).first()

            if not user:
                # Check if email already exists as username
                existing = db.query(User).filter_by(username=email).first()
                if existing:
                    return jsonify({"error": "A user with this email already exists. Please log in with your password."}), 409

                sheet_url = create_google_sheet(email)
                user = User(username=email, google_id=google_id, google_sheet_url=sheet_url, email=email)
                db.add(user)
                db.commit()
                db.refresh(user)
            else:
                # Backfill email for existing Google users that may be missing it
                if not user.email and email:
                    user.email = email

            if user.is_archived:
                return jsonify({"error": "This account has been disabled."}), 403

            user.last_login = datetime.now(timezone.utc).isoformat()
            db.commit()
            db.refresh(user)

            token = create_access_token(identity=str(user.id))
            return jsonify({
                "token": token,
                "user": user_dict(user)
            })
        finally:
            db.close()
    except ValueError:
        return jsonify({"error": "Invalid Google token"}), 401


@auth_bp.route("/me", methods=["GET"])
@jwt_required()
def me():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        return jsonify(user_dict(user))
    finally:
        db.close()


@auth_bp.route("/profile", methods=["PUT"])
@jwt_required()
def update_profile():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404

        for field in ['first_name', 'last_name', 'location', 'utr', 'email']:
            val = request.form.get(field)
            if val is not None:
                setattr(user, field, val)

        pic = request.files.get('profile_pic')
        if pic and pic.filename:
            filename = f"{user_id}_{secure_filename(pic.filename)}"
            pic.save(os.path.join(UPLOAD_FOLDER, filename))
            user.profile_pic = filename

        db.commit()
        db.refresh(user)
        return jsonify(user_dict(user))
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@auth_bp.route("/profile-pic/<filename>", methods=["GET"])
def profile_pic(filename):
    return send_from_directory(UPLOAD_FOLDER, filename)


@auth_bp.route("/logout", methods=["POST"])
@jwt_required()
def logout():
    return jsonify({"message": "Logged out successfully"})
