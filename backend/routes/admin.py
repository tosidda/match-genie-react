from datetime import datetime, timedelta, timezone

import gspread
from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt_identity

from database import Announcement, SessionLocal, User
from config import get_admin_usernames, get_gsheets_creds
from aws_batch import list_unfinished_analyses as list_aws_analyses

admin_bp = Blueprint("admin", __name__)


def _is_admin(db, user_id):
    user = db.query(User).filter_by(id=int(user_id)).first()
    admin_usernames = [u.strip().lower() for u in get_admin_usernames()]
    return bool(user and user.username.strip().lower() in admin_usernames)


def _announcement_payload(item):
    return {
        "id": item.id,
        "title": item.title,
        "message": item.message,
        "created_at": item.created_at,
        "expires_at": item.expires_at,
    }


def _historical_video_analysis_count(user):
    """Count completed sheet analyses plus distinct standalone AWS jobs."""
    sheet_count = 0
    if user.google_sheet_url:
        gc = gspread.service_account_from_dict(get_gsheets_creds())
        key = user.google_sheet_url.split("/")[-2]
        records = gc.open_by_key(key).worksheet("Stats").get_all_records()
        sheet_count = sum(bool(row.get("Analyzed Video Link")) for row in records)
    aws_analyses = list_aws_analyses(user.username, limit=100)
    standalone_count = sum(bool(item.get("standalone")) for item in aws_analyses)
    return sheet_count + standalone_count


@admin_bp.route("/announcements", methods=["GET"])
@jwt_required()
def get_active_announcements():
    db = SessionLocal()
    try:
        now = datetime.now(timezone.utc).isoformat()
        items = (
            db.query(Announcement)
            .filter(Announcement.expires_at > now)
            .order_by(Announcement.created_at.desc())
            .all()
        )
        return jsonify({"announcements": [_announcement_payload(item) for item in items]})
    finally:
        db.close()


@admin_bp.route("/announcements/all", methods=["GET"])
@jwt_required()
def get_all_announcements():
    db = SessionLocal()
    try:
        if not _is_admin(db, get_jwt_identity()):
            return jsonify({"error": "Unauthorized"}), 403
        items = db.query(Announcement).order_by(Announcement.created_at.desc()).all()
        return jsonify({"announcements": [_announcement_payload(item) for item in items]})
    finally:
        db.close()


@admin_bp.route("/announcements", methods=["POST"])
@jwt_required()
def create_announcement():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        if not _is_admin(db, user_id):
            return jsonify({"error": "Unauthorized"}), 403
        data = request.get_json(silent=True) or {}
        title = str(data.get("title") or "").strip()
        message = str(data.get("message") or "").strip()
        try:
            duration_hours = float(data.get("duration_hours"))
        except (TypeError, ValueError):
            duration_hours = 0
        if not title or not message:
            return jsonify({"error": "Title and message are required"}), 400
        if len(title) > 120 or len(message) > 2000:
            return jsonify({"error": "Announcement is too long"}), 400
        if duration_hours <= 0 or duration_hours > 8760:
            return jsonify({"error": "Duration must be between 0 and 8,760 hours"}), 400

        now = datetime.now(timezone.utc)
        item = Announcement(
            title=title,
            message=message,
            created_at=now.isoformat(),
            expires_at=(now + timedelta(hours=duration_hours)).isoformat(),
            created_by=int(user_id),
        )
        db.add(item)
        db.commit()
        return jsonify({"announcement": _announcement_payload(item)}), 201
    except Exception as exc:
        db.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        db.close()


@admin_bp.route("/announcements/<int:announcement_id>", methods=["DELETE"])
@jwt_required()
def delete_announcement(announcement_id):
    db = SessionLocal()
    try:
        if not _is_admin(db, get_jwt_identity()):
            return jsonify({"error": "Unauthorized"}), 403
        item = db.query(Announcement).filter_by(id=announcement_id).first()
        if not item:
            return jsonify({"error": "Announcement not found"}), 404
        db.delete(item)
        db.commit()
        return jsonify({"deleted": True})
    except Exception as exc:
        db.rollback()
        return jsonify({"error": str(exc)}), 500
    finally:
        db.close()


@admin_bp.route("/users", methods=["GET"])
@jwt_required()
def get_all_users():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        requester = db.query(User).filter_by(id=int(user_id)).first()
        admin_usernames = [u.strip().lower() for u in get_admin_usernames()]
        if not requester or requester.username.strip().lower() not in admin_usernames:
            return jsonify({"error": "Unauthorized", "your_username": requester.username if requester else None, "admins": admin_usernames}), 403

        users = db.query(User).all()

        # Counters introduced after video analysis launched start at zero.
        # Reconcile each legacy user once from both historical stores: completed
        # match-sheet analyses and standalone AWS analyses.
        counts_changed = False
        for user in users:
            if user.video_analysis_history_synced:
                continue
            try:
                historical_count = _historical_video_analysis_count(user)
            except Exception:
                # Admin access must still work during a temporary cloud outage.
                continue
            user.video_analysis_count = max(
                user.video_analysis_count or 0,
                historical_count,
            )
            user.video_analysis_history_synced = 1
            counts_changed = True
        if counts_changed:
            db.commit()

        result = []
        for u in users:
            name = " ".join(filter(None, [u.first_name, u.last_name])) or u.username
            result.append({
                "id": u.id,
                "name": name,
                "username": u.username,
                "email": u.email or "",
                "location": u.location or "",
                "subscription_tier": u.subscription_tier or "free",
                "match_count": u.match_count or 0,
                "video_analysis_count": u.video_analysis_count or 0,
                "video_analysis_limit": 3 if u.video_analysis_limit is None else u.video_analysis_limit,
                "video_analysis_limit_used": u.video_analysis_limit_used or 0,
                "prompt_count": u.prompt_count or 0,
                "voice_count": u.voice_count or 0,
                "token_count": u.token_count or 0,
                "is_equity_player": bool(u.is_equity_player),
                "last_login": u.last_login or "",
                "is_archived": bool(u.is_archived),
            })

        return jsonify({"users": result})
    finally:
        db.close()


@admin_bp.route("/users/<int:target_id>/video-analysis-limit", methods=["PUT"])
@jwt_required()
def update_video_analysis_limit(target_id):
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        requester = db.query(User).filter_by(id=int(user_id)).first()
        admin_usernames = [u.strip().lower() for u in get_admin_usernames()]
        if not requester or requester.username.strip().lower() not in admin_usernames:
            return jsonify({"error": "Unauthorized"}), 403

        target = db.query(User).filter_by(id=target_id).first()
        if not target:
            return jsonify({"error": "User not found"}), 404

        data = request.get_json(silent=True) or {}
        value = data.get("video_analysis_limit")
        if isinstance(value, bool):
            return jsonify({"error": "Video analysis limit must be a non-negative integer"}), 400
        try:
            value = int(value)
        except (TypeError, ValueError):
            return jsonify({"error": "Video analysis limit must be a non-negative integer"}), 400
        if value < 0:
            return jsonify({"error": "Video analysis limit must be a non-negative integer"}), 400

        target.video_analysis_limit = value
        db.commit()
        return jsonify({"video_analysis_limit": target.video_analysis_limit})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@admin_bp.route("/users/<int:target_id>/archive", methods=["PUT"])
@jwt_required()
def toggle_archive(target_id):
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        requester = db.query(User).filter_by(id=int(user_id)).first()
        admin_usernames = [u.strip().lower() for u in get_admin_usernames()]
        if not requester or requester.username.strip().lower() not in admin_usernames:
            return jsonify({"error": "Unauthorized"}), 403

        target = db.query(User).filter_by(id=target_id).first()
        if not target:
            return jsonify({"error": "User not found"}), 404

        data = request.get_json()
        target.is_archived = 1 if data.get("is_archived") else 0
        db.commit()
        return jsonify({"is_archived": bool(target.is_archived)})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@admin_bp.route("/users/<int:target_id>/equity", methods=["PUT"])
@jwt_required()
def toggle_equity(target_id):
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        requester = db.query(User).filter_by(id=int(user_id)).first()
        admin_usernames = [u.strip().lower() for u in get_admin_usernames()]
        if not requester or requester.username.strip().lower() not in admin_usernames:
            return jsonify({"error": "Unauthorized"}), 403

        target = db.query(User).filter_by(id=target_id).first()
        if not target:
            return jsonify({"error": "User not found"}), 404

        data = request.get_json()
        target.is_equity_player = 1 if data.get("is_equity_player") else 0
        db.commit()
        return jsonify({"is_equity_player": bool(target.is_equity_player)})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
