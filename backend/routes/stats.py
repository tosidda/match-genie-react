import json

import gspread
import pandas as pd
import numpy as np
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from database import SessionLocal, User, SharedStats, SharedMatchFeedback
from config import get_gsheets_creds

stats_bp = Blueprint("stats", __name__)


def _get_worksheet(sheet_url):
    creds = get_gsheets_creds()
    gc = gspread.service_account_from_dict(creds)
    key = sheet_url.split("/")[-2]
    sp = gc.open_by_key(key)
    return sp.worksheet("Stats")


def _read_sheet_data(sheet_url):
    ws = _get_worksheet(sheet_url)
    records = ws.get_all_records()
    df = pd.DataFrame(records)
    df = df.replace("", pd.NA).dropna(how="all")
    return df


@stats_bp.route("", methods=["GET"])
@jwt_required()
def get_stats():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Sheet not found"}), 404

        df = _read_sheet_data(user.google_sheet_url)
        if df.empty:
            return jsonify({"stats": [], "summary": {}})

        df["Match Date"] = pd.to_datetime(df["Match Date"], errors="coerce")
        df = df.dropna(subset=["Match Date"]).sort_values("Match Date")

        total = len(df)
        wins = len(df[df["Result"] == "W"])
        win_rate = round((wins / total) * 100, 1) if total > 0 else 0

        avg_fs = pd.to_numeric(df["First Serve %"].astype(str).str.rstrip("%"), errors="coerce").mean()
        avg_speed = pd.to_numeric(df.get("Serve Speed", pd.Series(dtype=float)), errors="coerce").mean()
        avg_ue = pd.to_numeric(df.get("Unforced Errors", pd.Series(dtype=float)), errors="coerce").mean()
        avg_ret = pd.to_numeric(df.get("Return %", pd.Series(dtype=str)).astype(str).str.rstrip("%"), errors="coerce").mean()

        # Surface wins
        surface_wins = df[df["Result"] == "W"].groupby("Surface Type").size().to_dict()

        # W/L by opponent
        record = {}
        for _, row in df.iterrows():
            opp = str(row.get("Opp. Name", "")).strip().title()
            if not opp:
                continue
            if opp not in record:
                record[opp] = {"wins": 0, "losses": 0}
            if row["Result"] == "W":
                record[opp]["wins"] += 1
            else:
                record[opp]["losses"] += 1

        # Goals
        goals = {}
        if user.progress_goals:
            goals = json.loads(user.progress_goals)

        # Goal trend data
        goal_trends = {}
        goal_config = {
            "First Serve %": {"col": "First Serve %", "strip_pct": True},
            "Return %": {"col": "Return %", "strip_pct": True},
            "Unforced Errors": {"col": "Unforced Errors", "strip_pct": False},
            "Serve Speed": {"col": "Serve Speed", "strip_pct": False},
            "Net Points Won": {"col": "Net Points Won", "strip_pct": False},
            "First Serve % Won": {"col": "First Serve % Won", "strip_pct": False},
            "Second Serve %": {"col": "Second Serve %", "strip_pct": False},
            "Double Faults": {"col": "Double Faults", "strip_pct": False},
        }
        for goal_name in goals:
            cfg = goal_config.get(goal_name)
            if not cfg or cfg["col"] not in df.columns:
                continue
            if cfg["strip_pct"]:
                series = pd.to_numeric(df[cfg["col"]].astype(str).str.rstrip("%"), errors="coerce")
            else:
                series = pd.to_numeric(df[cfg["col"]], errors="coerce")
            goal_trends[goal_name] = {
                "dates": df["Match Date"].dt.strftime("%Y-%m-%d").tolist(),
                "values": [None if pd.isna(v) else v for v in series.tolist()],
                "goal": goals[goal_name],
            }

        # Head-to-head data
        h2h_columns = ["Opp. Aces", "Opp. Winners", "Opp. Unforced Errors", "Opp. Forced Errors",
                        "Opp. Double Faults", "Opp. Net Points Won", "Opp. Points Won", "Points Won"]
        has_h2h = all(col in df.columns for col in h2h_columns)
        h2h_matches = []
        if has_h2h:
            h2h_df = df.dropna(subset=["Opp. Points Won"])
            h2h_df = h2h_df[pd.to_numeric(h2h_df["Opp. Points Won"], errors="coerce").notna()]
            for _, row in h2h_df.iterrows():
                h2h_matches.append(row.to_dict())

        # Convert NaN to None for JSON
        matches_list = df.to_dict("records")
        for m in matches_list:
            m["Match Date"] = str(m.get("Match Date", ""))
            for k, v in m.items():
                if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                    m[k] = None

        return jsonify({
            "stats": matches_list,
            "summary": {
                "total_matches": total,
                "wins": wins,
                "win_rate": win_rate,
                "avg_first_serve": round(avg_fs, 1) if pd.notna(avg_fs) else 0,
                "avg_serve_speed": round(avg_speed, 1) if pd.notna(avg_speed) else 0,
                "avg_unforced_errors": round(avg_ue, 1) if pd.notna(avg_ue) else 0,
                "avg_return_pct": round(avg_ret, 1) if pd.notna(avg_ret) else 0,
            },
            "surface_wins": surface_wins,
            "record": record,
            "goals": goals,
            "goal_trends": goal_trends,
            "h2h_matches": h2h_matches,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/shared", methods=["GET"])
@jwt_required()
def get_shared_stats():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        shares = db.query(SharedStats).filter_by(sharee_id=user.id).all()
        sharer_usernames = [s.sharer.username for s in shares]

        # Individual shared user data
        target = request.args.get("user")
        if target and target != "Team Stats":
            target_user = db.query(User).filter_by(username=target).first()
            if not target_user or not target_user.google_sheet_url:
                return jsonify({"error": "User not found"}), 404

            df = _read_sheet_data(target_user.google_sheet_url)
            share_row = db.query(SharedStats).filter_by(
                sharer_id=target_user.id, sharee_id=user.id
            ).first()

            goals = {}
            if target_user.progress_goals:
                goals = json.loads(target_user.progress_goals)

            goal_comments = {}
            match_comments = {}
            if share_row:
                if share_row.goal_comments:
                    goal_comments = json.loads(share_row.goal_comments)
                if share_row.match_comments:
                    match_comments = json.loads(share_row.match_comments)

            records = df.to_dict("records") if not df.empty else []

            # Compute summary, surface_wins, record, goal_trends
            summary = {}
            surface_wins = {}
            record = {}
            goal_trends = {}
            if not df.empty:
                df["Match Date"] = pd.to_datetime(df["Match Date"], errors="coerce")
                df = df.dropna(subset=["Match Date"]).sort_values("Match Date")

                total = len(df)
                wins_count = len(df[df["Result"] == "W"])
                win_rate = round((wins_count / total) * 100, 1) if total > 0 else 0
                avg_fs = pd.to_numeric(df["First Serve %"].astype(str).str.rstrip("%"), errors="coerce").mean()
                avg_speed = pd.to_numeric(df.get("Serve Speed", pd.Series(dtype=float)), errors="coerce").mean()
                avg_ue = pd.to_numeric(df.get("Unforced Errors", pd.Series(dtype=float)), errors="coerce").mean()
                avg_ret = pd.to_numeric(df.get("Return %", pd.Series(dtype=str)).astype(str).str.rstrip("%"), errors="coerce").mean()

                summary = {
                    "total_matches": total,
                    "wins": wins_count,
                    "win_rate": win_rate,
                    "avg_first_serve": round(avg_fs, 1) if pd.notna(avg_fs) else 0,
                    "avg_serve_speed": round(avg_speed, 1) if pd.notna(avg_speed) else 0,
                    "avg_unforced_errors": round(avg_ue, 1) if pd.notna(avg_ue) else 0,
                    "avg_return_pct": round(avg_ret, 1) if pd.notna(avg_ret) else 0,
                }

                surface_wins = df[df["Result"] == "W"].groupby("Surface Type").size().to_dict()

                for _, row in df.iterrows():
                    opp = str(row.get("Opp. Name", "")).strip().title()
                    if not opp:
                        continue
                    if opp not in record:
                        record[opp] = {"wins": 0, "losses": 0}
                    if row["Result"] == "W":
                        record[opp]["wins"] += 1
                    else:
                        record[opp]["losses"] += 1

                goal_config = {
                    "First Serve %": {"col": "First Serve %", "strip_pct": True},
                    "Return %": {"col": "Return %", "strip_pct": True},
                    "Unforced Errors": {"col": "Unforced Errors", "strip_pct": False},
                    "Serve Speed": {"col": "Serve Speed", "strip_pct": False},
                    "Net Points Won": {"col": "Net Points Won", "strip_pct": False},
                    "First Serve % Won": {"col": "First Serve % Won", "strip_pct": False},
                    "Second Serve %": {"col": "Second Serve %", "strip_pct": False},
                    "Double Faults": {"col": "Double Faults", "strip_pct": False},
                }
                for goal_name in goals:
                    cfg = goal_config.get(goal_name)
                    if not cfg or cfg["col"] not in df.columns:
                        continue
                    if cfg["strip_pct"]:
                        series = pd.to_numeric(df[cfg["col"]].astype(str).str.rstrip("%"), errors="coerce")
                    else:
                        series = pd.to_numeric(df[cfg["col"]], errors="coerce")
                    goal_trends[goal_name] = {
                        "dates": df["Match Date"].dt.strftime("%Y-%m-%d").tolist(),
                        "values": [None if pd.isna(v) else v for v in series.tolist()],
                        "goal": goals[goal_name],
                    }

                # Convert NaN for JSON
                for m in records:
                    m["Match Date"] = str(m.get("Match Date", ""))
                    for k, v in m.items():
                        if isinstance(v, float) and (np.isnan(v) or np.isinf(v)):
                            m[k] = None

            return jsonify({
                "sharer_usernames": sharer_usernames,
                "stats": records,
                "summary": summary,
                "surface_wins": surface_wins,
                "record": record,
                "goals": goals,
                "goal_trends": goal_trends,
                "goal_comments": goal_comments,
                "match_comments": match_comments,
                "share_id": share_row.id if share_row else None,
                "training_plan": target_user.training_plan,
            })

        # Team stats
        if target == "Team Stats":
            all_data = []
            for uname in sharer_usernames:
                u = db.query(User).filter_by(username=uname).first()
                if u and u.google_sheet_url:
                    try:
                        df = _read_sheet_data(u.google_sheet_url)
                        if not df.empty:
                            df["Player"] = uname
                            all_data.append(df)
                    except Exception:
                        pass

            if not all_data:
                return jsonify({"sharer_usernames": sharer_usernames, "team_stats": []})

            combined = pd.concat(all_data, ignore_index=True)
            player_stats = []
            for player in sharer_usernames:
                pdata = combined[combined["Player"] == player]
                if pdata.empty:
                    continue
                total = len(pdata)
                wins = len(pdata[pdata["Result"] == "W"])
                win_rate = round((wins / total) * 100, 1) if total > 0 else 0
                fs = pd.to_numeric(pdata["First Serve %"].astype(str).str.rstrip("%"), errors="coerce").mean()
                speed = pd.to_numeric(pdata.get("Serve Speed", pd.Series(dtype=float)), errors="coerce").mean()
                ue = pd.to_numeric(pdata.get("Unforced Errors", pd.Series(dtype=float)), errors="coerce").mean()
                ret = pd.to_numeric(pdata.get("Return %", pd.Series(dtype=str)).astype(str).str.rstrip("%"), errors="coerce").mean()
                w = pd.to_numeric(pdata.get("Winners", pd.Series(dtype=float)), errors="coerce").mean()
                df_val = pd.to_numeric(pdata.get("Double Faults", pd.Series(dtype=float)), errors="coerce").mean()

                player_stats.append({
                    "Player": player,
                    "Matches": total,
                    "Win Rate (%)": win_rate,
                    "Avg First Serve (%)": round(fs, 1) if pd.notna(fs) else 0,
                    "Avg Serve Speed": round(speed, 1) if pd.notna(speed) else 0,
                    "Avg Return (%)": round(ret, 1) if pd.notna(ret) else 0,
                    "Avg Winners": round(w, 1) if pd.notna(w) else 0,
                    "Avg Unforced Errors": round(ue, 1) if pd.notna(ue) else 0,
                    "Avg Double Faults": round(df_val, 1) if pd.notna(df_val) else 0,
                })

            return jsonify({
                "sharer_usernames": sharer_usernames,
                "team_stats": player_stats,
            })

        # Default: return list of sharers
        return jsonify({"sharer_usernames": sharer_usernames})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/my-coaches", methods=["GET"])
@jwt_required()
def get_my_coaches():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404

        shares = db.query(SharedStats).filter_by(sharer_id=user.id).all()
        coaches = []
        for share in shares:
            goal_comments = {}
            if share.goal_comments:
                goal_comments = json.loads(share.goal_comments)
            general_comment = {}
            if share.general_comment:
                general_comment = json.loads(share.general_comment)
            coaches.append({
                "coach_username": share.sharee.username,
                "goal_comments": goal_comments,
                "general_comment": general_comment,
                "share_id": share.id,
            })
        return jsonify({"coaches": coaches})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/training-plan", methods=["GET"])
@jwt_required()
def get_training_plan():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        return jsonify({"training_plan": user.training_plan if user else None})
    finally:
        db.close()


@stats_bp.route("/training-plan", methods=["PUT"])
@jwt_required()
def update_training_plan():
    user_id = get_jwt_identity()
    data = request.get_json()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        user.training_plan = data.get("training_plan")
        db.commit()
        return jsonify({"message": "Training plan updated"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/usage", methods=["GET"])
@jwt_required()
def get_usage():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        return jsonify({
            "prompt_count": user.prompt_count or 0,
            "voice_count": user.voice_count or 0,
        })
    finally:
        db.close()


@stats_bp.route("/voice-count", methods=["PUT"])
@jwt_required()
def increment_voice_count():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        user.voice_count = (user.voice_count or 0) + 1
        db.commit()
        return jsonify({"voice_count": user.voice_count})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/goals", methods=["GET"])
@jwt_required()
def get_goals():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        goals = {}
        if user and user.progress_goals:
            goals = json.loads(user.progress_goals)
        return jsonify({"goals": goals})
    finally:
        db.close()


@stats_bp.route("/goals", methods=["PUT"])
@jwt_required()
def update_goals():
    user_id = get_jwt_identity()
    data = request.get_json()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user:
            return jsonify({"error": "User not found"}), 404
        user.progress_goals = json.dumps(data.get("goals", {}))
        db.commit()
        return jsonify({"message": "Goals updated"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/share", methods=["POST"])
@jwt_required()
def share_stats():
    user_id = get_jwt_identity()
    data = request.get_json()
    sharee_username = data.get("username", "").strip()

    if not sharee_username:
        return jsonify({"error": "Username is required"}), 400

    db = SessionLocal()
    try:
        sharer = db.query(User).filter_by(id=int(user_id)).first()
        sharee = db.query(User).filter_by(username=sharee_username).first()

        if not sharee:
            return jsonify({"error": f"User '{sharee_username}' not found"}), 404
        if sharer.id == sharee.id:
            return jsonify({"error": "You cannot share stats with yourself"}), 400

        existing = db.query(SharedStats).filter_by(sharer_id=sharer.id, sharee_id=sharee.id).first()
        if existing:
            return jsonify({"error": f"Already shared with {sharee_username}"}), 409

        share = SharedStats(sharer_id=sharer.id, sharee_id=sharee.id)
        db.add(share)
        db.commit()
        return jsonify({"message": f"Shared with {sharee_username}"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/comments", methods=["PUT"])
@jwt_required()
def update_comments():
    from datetime import date as _date
    user_id = get_jwt_identity()
    data = request.get_json()
    share_id = data.get("share_id")
    goal_comments = data.get("goal_comments")
    match_comments = data.get("match_comments")

    db = SessionLocal()
    try:
        share = db.query(SharedStats).filter_by(id=share_id).first()
        if not share:
            return jsonify({"error": "Share not found"}), 404
        if share.sharee_id != int(user_id):
            return jsonify({"error": "Unauthorized"}), 403

        if goal_comments is not None:
            # Wrap plain strings with timestamp
            today = _date.today().isoformat()
            timestamped = {}
            for k, v in goal_comments.items():
                if isinstance(v, str) and v.strip():
                    timestamped[k] = {"text": v, "date": today}
                elif isinstance(v, dict):
                    timestamped[k] = v
            share.goal_comments = json.dumps(timestamped) if timestamped else None
        if match_comments is not None:
            share.match_comments = json.dumps(match_comments) if match_comments else None
        db.commit()
        return jsonify({"message": "Comments updated"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/dismiss-feedback", methods=["PUT"])
@jwt_required()
def dismiss_feedback():
    user_id = get_jwt_identity()
    data = request.get_json()
    share_id = data.get("share_id")
    goal_name = data.get("goal_name")

    db = SessionLocal()
    try:
        share = db.query(SharedStats).filter_by(id=share_id).first()
        if not share:
            return jsonify({"error": "Share not found"}), 404
        if share.sharer_id != int(user_id):
            return jsonify({"error": "Unauthorized"}), 403

        if share.goal_comments:
            comments = json.loads(share.goal_comments)
            comments.pop(goal_name, None)
            share.goal_comments = json.dumps(comments) if comments else None
            db.commit()
        return jsonify({"message": "Feedback dismissed"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/training-plan-feedback", methods=["PUT"])
@jwt_required()
def training_plan_feedback():
    from datetime import date as _date
    user_id = get_jwt_identity()
    data = request.get_json()
    share_id = data.get("share_id")
    feedback = data.get("feedback", "").strip()

    db = SessionLocal()
    try:
        share = db.query(SharedStats).filter_by(id=share_id).first()
        if not share:
            return jsonify({"error": "Share not found"}), 404
        if share.sharee_id != int(user_id):
            return jsonify({"error": "Unauthorized"}), 403

        if feedback:
            today = _date.today().isoformat()
            share.general_comment = json.dumps({"text": feedback, "date": today})
        else:
            share.general_comment = None
        db.commit()
        return jsonify({"message": "Training plan feedback saved"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/dismiss-training-feedback", methods=["PUT"])
@jwt_required()
def dismiss_training_feedback():
    user_id = get_jwt_identity()
    data = request.get_json()
    share_id = data.get("share_id")

    db = SessionLocal()
    try:
        share = db.query(SharedStats).filter_by(id=share_id).first()
        if not share:
            return jsonify({"error": "Share not found"}), 404
        if share.sharer_id != int(user_id):
            return jsonify({"error": "Unauthorized"}), 403

        share.general_comment = None
        db.commit()
        return jsonify({"message": "Training feedback dismissed"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/share-match", methods=["POST"])
@jwt_required()
def share_match():
    from datetime import date as _date
    user_id = get_jwt_identity()
    data = request.get_json()
    username = data.get("username", "").strip()
    match_key = data.get("match_key", "").strip()
    match_data = data.get("match_data")

    if not username or not match_key:
        return jsonify({"error": "Username and match_key are required"}), 400

    db = SessionLocal()
    try:
        sharer = db.query(User).filter_by(id=int(user_id)).first()
        sharee = db.query(User).filter_by(username=username).first()
        if not sharee:
            return jsonify({"error": f"User '{username}' not found"}), 404
        if sharer.id == sharee.id:
            return jsonify({"error": "Cannot share with yourself"}), 400

        existing = db.query(SharedMatchFeedback).filter_by(
            sharer_id=sharer.id, sharee_id=sharee.id, match_key=match_key
        ).first()
        if existing:
            return jsonify({"error": "This match is already shared with this user"}), 409

        entry = SharedMatchFeedback(
            sharer_id=sharer.id,
            sharee_id=sharee.id,
            match_key=match_key,
            match_data=json.dumps(match_data) if match_data else None,
            created_at=_date.today().isoformat(),
        )
        db.add(entry)

        # Ensure SharedStats relationship exists too
        ss = db.query(SharedStats).filter_by(sharer_id=sharer.id, sharee_id=sharee.id).first()
        if not ss:
            db.add(SharedStats(sharer_id=sharer.id, sharee_id=sharee.id))

        db.commit()
        return jsonify({"message": f"Match shared with {username}"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/shared-matches", methods=["GET"])
@jwt_required()
def get_shared_matches():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        uid = int(user_id)
        as_coach = db.query(SharedMatchFeedback).filter_by(sharee_id=uid).all()
        as_player = db.query(SharedMatchFeedback).filter_by(sharer_id=uid).filter(
            SharedMatchFeedback.feedback.isnot(None)
        ).all()

        def serialize(row):
            return {
                "id": row.id,
                "sharer": row.sharer.username,
                "sharee": row.sharee.username,
                "match_key": row.match_key,
                "match_data": json.loads(row.match_data) if row.match_data else {},
                "feedback": row.feedback,
                "feedback_date": row.feedback_date,
                "created_at": row.created_at,
            }

        return jsonify({
            "as_coach": [serialize(r) for r in as_coach],
            "as_player": [serialize(r) for r in as_player],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/match-feedback", methods=["PUT"])
@jwt_required()
def update_match_feedback():
    from datetime import date as _date
    user_id = get_jwt_identity()
    data = request.get_json()
    shared_match_id = data.get("shared_match_id")
    feedback = data.get("feedback", "").strip()

    db = SessionLocal()
    try:
        row = db.query(SharedMatchFeedback).filter_by(id=shared_match_id).first()
        if not row:
            return jsonify({"error": "Shared match not found"}), 404
        if row.sharee_id != int(user_id):
            return jsonify({"error": "Unauthorized"}), 403

        row.feedback = feedback if feedback else None
        row.feedback_date = _date.today().isoformat() if feedback else None
        db.commit()
        return jsonify({"message": "Feedback saved"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/dismiss-match-feedback", methods=["PUT"])
@jwt_required()
def dismiss_match_feedback():
    user_id = get_jwt_identity()
    data = request.get_json()
    shared_match_id = data.get("shared_match_id")

    db = SessionLocal()
    try:
        row = db.query(SharedMatchFeedback).filter_by(id=shared_match_id).first()
        if not row:
            return jsonify({"error": "Shared match not found"}), 404
        if row.sharer_id != int(user_id):
            return jsonify({"error": "Unauthorized"}), 403

        row.feedback = None
        row.feedback_date = None
        db.commit()
        return jsonify({"message": "Feedback dismissed"})
    except Exception as e:
        db.rollback()
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@stats_bp.route("/share-recipients", methods=["GET"])
@jwt_required()
def get_share_recipients():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        uid = int(user_id)
        usernames = set()

        # From SharedStats
        shares = db.query(SharedStats).filter_by(sharer_id=uid).all()
        for s in shares:
            usernames.add(s.sharee.username)

        # From SharedMatchFeedback
        match_shares = db.query(SharedMatchFeedback).filter_by(sharer_id=uid).all()
        for ms in match_shares:
            usernames.add(ms.sharee.username)

        return jsonify({"recipients": sorted(usernames)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
