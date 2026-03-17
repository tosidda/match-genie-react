from flask import Blueprint, jsonify, request
from flask_jwt_extended import jwt_required, get_jwt_identity

from database import SessionLocal, User
from config import get_admin_usernames

admin_bp = Blueprint("admin", __name__)


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
                "prompt_count": u.prompt_count or 0,
                "voice_count": u.voice_count or 0,
                "token_count": u.token_count or 0,
                "is_equity_player": bool(u.is_equity_player),
                "last_login": u.last_login or "",
            })

        return jsonify({"users": result})
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
