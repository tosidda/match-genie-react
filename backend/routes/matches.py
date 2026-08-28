import os
import tempfile

import gspread
import pandas as pd
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity

from database import SessionLocal, User
from config import get_gsheets_creds, get_gcs_bucket
from tasks import process_video_task

matches_bp = Blueprint("matches", __name__)


def _get_user(db, user_id):
    return db.query(User).filter_by(id=int(user_id)).first()


def _get_worksheet(sheet_url):
    creds = get_gsheets_creds()
    gc = gspread.service_account_from_dict(creds)
    spreadsheet_key = sheet_url.split("/")[-2]
    spreadsheet = gc.open_by_key(spreadsheet_key)
    return spreadsheet.worksheet("Stats")


@matches_bp.route("", methods=["GET"])
@jwt_required()
def get_matches():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = _get_user(db, user_id)
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Google Sheet not found"}), 404

        worksheet = _get_worksheet(user.google_sheet_url)
        data = worksheet.get_all_records()
        for i, row in enumerate(data):
            row["_row_index"] = i + 2  # row 1 is the header
        return jsonify({"matches": data})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@matches_bp.route("/<int:row_index>", methods=["PUT"])
@jwt_required()
def update_match(row_index):
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = _get_user(db, user_id)
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Google Sheet not found"}), 404

        data = request.get_json()
        if not data:
            return jsonify({"error": "No data provided"}), 400

        worksheet = _get_worksheet(user.google_sheet_url)
        if row_index < 2 or row_index > len(worksheet.get_all_values()):
            return jsonify({"error": "Match not found"}), 404
        headers = worksheet.row_values(1)

        col_map = {h: i + 1 for i, h in enumerate(headers)}
        field_map = {
            "match_date": "Match Date",
            "opponent_name": "Opp. Name",
            "result": "Result",
            "match_score": "Match Score",
            "surface_type": "Surface Type",
            "match_description": "Match Description",
            "utr": "UTR",
            "first_serve_percentage": "First Serve %",
            "first_serve_percentage_won": "First Serve % Won",
            "second_serve_percentage": "Second Serve %",
            "aces": "Aces",
            "double_faults": "Double Faults",
            "serve_speed": "Serve Speed",
            "serve_placement": "Serve Placement",
            "return_percentage": "Return %",
            "return_placement": "Return Placement",
            "winners": "Winners",
            "unforced_errors": "Unforced Errors",
            "forced_errors": "Forced Errors",
            "net_points_won": "Net Points Won",
            "break_points_won": "Break Points Won",
            "break_points_saved": "Break Points Saved",
            "average_rally_length": "Average Rally Length",
            "mental_game": "Mental Game",
        }

        updates = []
        for key, header in field_map.items():
            if key in data and header in col_map:
                col = col_map[header]
                value = data[key]
                if key == "opponent_name" and isinstance(value, str):
                    value = value.title()
                updates.append({
                    "range": gspread.utils.rowcol_to_a1(row_index, col),
                    "values": [[value]],
                })

        if updates:
            worksheet.batch_update(updates, value_input_option="USER_ENTERED")

        return jsonify({"message": "Match updated successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@matches_bp.route("/<int:row_index>", methods=["DELETE"])
@jwt_required()
def delete_match(row_index):
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = _get_user(db, user_id)
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Google Sheet not found"}), 404

        worksheet = _get_worksheet(user.google_sheet_url)
        if row_index < 2 or row_index > len(worksheet.get_all_values()):
            return jsonify({"error": "Match not found"}), 404
        worksheet.delete_rows(row_index)

        user.match_count = max(0, (user.match_count or 1) - 1)
        db.commit()

        return jsonify({"message": "Match deleted successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@matches_bp.route("", methods=["POST"])
@jwt_required()
def log_match():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = _get_user(db, user_id)
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Google Sheet not found"}), 404

        data = request.form.to_dict() if request.form else request.get_json()
        uploaded_video = request.files.get("video")
        uploaded_stats_file = request.files.get("stats_file")

        # Extract stats from uploaded file if present
        first_serve_pct = data.get("first_serve_percentage", "")
        first_serve_pct_won = data.get("first_serve_percentage_won", "")
        second_serve_pct = data.get("second_serve_percentage", "")
        aces = data.get("aces", "")
        serve_speed = data.get("serve_speed", "")
        serve_placement = data.get("serve_placement", "")
        double_faults = data.get("double_faults", "")
        return_percentage = data.get("return_percentage", "")
        return_placement = data.get("return_placement", "")
        winners = data.get("winners", "")
        unforced_errors = data.get("unforced_errors", "")
        forced_errors = data.get("forced_errors", "")
        av_rally_length = data.get("average_rally_length", "")
        net_points_won = data.get("net_points_won", "")
        break_points_won = data.get("break_points_won", "")
        break_points_saved = data.get("break_points_saved", "")
        mental_game = data.get("mental_game", "")
        match_date = data.get("match_date", "")
        match_score = data.get("match_score", "")
        surface_type = data.get("surface_type", "")
        opponent_name = data.get("opponent_name", "")
        opp_ranking = data.get("opponent_ranking", "")
        opp_playing_style = data.get("opponent_playing_style", "")
        result = data.get("result", "")
        match_description = data.get("match_description", "")
        yt_url = data.get("youtube_url", "").strip()
        utr_rating = data.get("utr", "UR")

        # If SwingVision file uploaded, parse it
        if uploaded_stats_file:
            try:
                df = pd.read_excel(uploaded_stats_file, sheet_name="Shots")
                player_df = df[df["Player"] != "Opponent"]

                # Return %
                returns_df = player_df[player_df["Type"] == "return"]
                if not returns_df.empty:
                    total_returns = len(returns_df)
                    successful = returns_df[returns_df["Result"] == "In"].shape[0]
                    return_percentage = round((successful / total_returns) * 100) if total_returns > 0 else 0

                # Errors
                errors_df = player_df[(player_df["Stroke"] != "Serve") & (player_df["Result"].isin(["Net", "Out"]))]
                unforced_errors = len(errors_df)

                # Serve stats
                serves_df = player_df[player_df["Stroke"] == "Serve"].copy()
                first_in, first_total = 0, 0
                first_speeds = []
                dfs_count = 0
                second_in, second_total = 0, 0
                indices = serves_df.index.tolist()

                for i, idx in enumerate(indices):
                    s = serves_df.loc[idx]
                    is_second = i > 0 and indices[i - 1] == idx - 1
                    if not is_second:
                        first_total += 1
                        if "Speed (MPH)" in s:
                            first_speeds.append(s["Speed (MPH)"])
                        if s["Result"] == "In":
                            first_in += 1
                    else:
                        second_total += 1
                        if s["Result"] == "In":
                            second_in += 1
                        elif s["Result"] in ["Out", "Net"]:
                            dfs_count += 1

                first_serve_pct = round((first_in / first_total) * 100) if first_total > 0 else 0
                serve_speed = round(sum(first_speeds) / len(first_speeds)) if first_speeds else 0
                second_serve_pct = round((second_in / second_total) * 100) if second_total > 0 else 0
                double_faults = dfs_count

                if not serves_df.empty and "Direction" in serves_df:
                    placements = serves_df["Direction"].value_counts()
                    serve_placement = ", ".join(placements.index[:2].tolist())
            except Exception:
                pass  # Fall through to manual values

        # Build video text
        video_status = ""
        if uploaded_video:
            video_status = "Trimming video..."
        elif yt_url:
            video_status = yt_url

        video_text = f"{opponent_name.title()}, {match_date}: {video_status}" if video_status else ""

        worksheet = _get_worksheet(user.google_sheet_url)
        headers = worksheet.row_values(1)
        row_dict = {
            "First Serve %": first_serve_pct,
            "First Serve % Won": first_serve_pct_won,
            "Second Serve %": second_serve_pct,
            "Aces": aces,
            "Serve Speed": serve_speed,
            "Serve Placement": serve_placement,
            "Double Faults": double_faults,
            "Return %": return_percentage,
            "Return Placement": return_placement,
            "Winners": winners,
            "Average Rally Length": av_rally_length,
            "Unforced Errors": unforced_errors,
            "Forced Errors": forced_errors,
            "Net Points Won": net_points_won,
            "Break Points Won": break_points_won,
            "Break Points Saved": break_points_saved,
            "Mental Game": mental_game,
            "Match Date": match_date,
            "Match Score": match_score,
            "Surface Type": surface_type,
            "Opp. Name": opponent_name.title() if opponent_name else "",
            "Opp. Ranking": opp_ranking,
            "Opp. Playing Style": opp_playing_style,
            "Result": result,
            "Match Description": match_description,
            "Match Video": video_text,
            "UTR": utr_rating if utr_rating and str(utr_rating) != "0" else "UR",
            "Analyzed Video Link": "",
        }
        row_to_append = [row_dict.get(h, "") for h in headers]
        worksheet.append_row(row_to_append, value_input_option="USER_ENTERED")
        new_row_index = len(worksheet.get_all_values())

        user.match_count = (user.match_count or 0) + 1
        db.commit()

        # If video uploaded, trigger Celery task
        task_id = None
        if uploaded_video:
            suffix = os.path.splitext(uploaded_video.filename)[1]
            with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
                tmp.write(uploaded_video.read())
                tmp_path = tmp.name

            result_task = process_video_task.delay(
                temp_video_path=tmp_path,
                gcs_bucket=get_gcs_bucket(),
                username=user.username,
                sheet_url=user.google_sheet_url,
                row_index=new_row_index,
                opponent_name=opponent_name,
                match_date_str=match_date,
            )
            task_id = result_task.id

        return jsonify({
            "message": "Match logged successfully",
            "row_index": new_row_index,
            "task_id": task_id,
        }), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@matches_bp.route("/upload-stats", methods=["POST"])
@jwt_required()
def upload_stats():
    """Parse a SwingVision or other stats file and return extracted data."""
    file = request.files.get("file")
    source = request.form.get("source", "SwingVision")

    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    try:
        if source == "SwingVision":
            df = pd.read_excel(file, sheet_name="Shots")
            player_df = df[df["Player"] != "Opponent"]

            returns_df = player_df[player_df["Type"] == "return"]
            return_pct = 0
            if not returns_df.empty:
                total = len(returns_df)
                ok = returns_df[returns_df["Result"] == "In"].shape[0]
                return_pct = round((ok / total) * 100) if total > 0 else 0

            errors_df = player_df[(player_df["Stroke"] != "Serve") & (player_df["Result"].isin(["Net", "Out"]))]

            serves_df = player_df[player_df["Stroke"] == "Serve"].copy()
            first_in, first_total, dfs_count, second_in, second_total = 0, 0, 0, 0, 0
            first_speeds = []
            indices = serves_df.index.tolist()
            for i, idx in enumerate(indices):
                s = serves_df.loc[idx]
                is_second = i > 0 and indices[i - 1] == idx - 1
                if not is_second:
                    first_total += 1
                    if "Speed (MPH)" in s:
                        first_speeds.append(s["Speed (MPH)"])
                    if s["Result"] == "In":
                        first_in += 1
                else:
                    second_total += 1
                    if s["Result"] == "In":
                        second_in += 1
                    elif s["Result"] in ["Out", "Net"]:
                        dfs_count += 1

            return jsonify({
                "first_serve_percentage": round((first_in / first_total) * 100) if first_total > 0 else 0,
                "serve_speed": round(sum(first_speeds) / len(first_speeds)) if first_speeds else 0,
                "second_serve_percentage": round((second_in / second_total) * 100) if second_total > 0 else 0,
                "double_faults": dfs_count,
                "return_percentage": return_pct,
                "unforced_errors": len(errors_df),
            })
        else:
            return jsonify({"error": f"Unsupported source: {source}"}), 400
    except Exception as e:
        return jsonify({"error": str(e)}), 500
