import gspread
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from openai import OpenAI

from database import SessionLocal, User
from config import get_gsheets_creds, get_openai_key

track_bp = Blueprint("track", __name__)

PLAYING_STYLES = [
    "Aggressive Baseline", "Counterpuncher", "Serve and Volley",
    "All-Court Player", "Defensive Player", "Lefty",
    "One-Handed Backhand", "Net Player", "Grinder", "Wall",
]


def _infer_playing_style(opp_stats, user_id=None):
    api_key = get_openai_key()
    if not api_key:
        return ""

    fs_total = opp_stats.get("first_serves_total", 0)
    fs_in = opp_stats.get("first_serves_in", 0)
    fs_pct = round(fs_in / fs_total * 100) if fs_total > 0 else None

    summary = (
        f"Opponent match stats:\n"
        f"- Aces: {opp_stats.get('aces', 0)}\n"
        f"- Double Faults: {opp_stats.get('double_faults', 0)}\n"
        f"- First Serve %: {fs_pct if fs_pct is not None else 'N/A'}\n"
        f"- Winners: {opp_stats.get('winners', 0)} "
        f"(FH: {opp_stats.get('forehand_winners', 0)}, BH: {opp_stats.get('backhand_winners', 0)}, Net: {opp_stats.get('net_winners', 0)})\n"
        f"- Forced Errors: {opp_stats.get('forced_errors', 0)} "
        f"(FH: {opp_stats.get('forehand_forced', 0)}, BH: {opp_stats.get('backhand_forced', 0)}, Net: {opp_stats.get('net_forced', 0)})\n"
        f"- Unforced Errors: {opp_stats.get('unforced_errors', 0)} "
        f"(FH: {opp_stats.get('forehand_unforced', 0)}, BH: {opp_stats.get('backhand_unforced', 0)}, Net: {opp_stats.get('net_unforced', 0)})\n"
        f"- Total Points Won: {opp_stats.get('points_won', 0)}\n"
    )

    styles_str = ", ".join(PLAYING_STYLES)
    prompt = (
        f"Based on the following tennis match statistics for an opponent, "
        f"classify their playing style. Choose one or more from this list ONLY: {styles_str}.\n\n"
        f"{summary}\n"
        f"Return ONLY the matching style name(s) from the list, comma-separated. No explanations."
    )

    try:
        client = OpenAI(api_key=api_key)
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            max_tokens=100,
        )
        total_tokens = response.usage.total_tokens if response.usage else 0
        if total_tokens > 0 and user_id is not None:
            token_db = SessionLocal()
            try:
                u = token_db.query(User).filter_by(id=int(user_id)).first()
                if u:
                    u.token_count = (u.token_count or 0) + total_tokens
                    token_db.commit()
            finally:
                token_db.close()

        raw = response.choices[0].message.content.strip()
        inferred = [s.strip() for s in raw.split(",")]
        valid = [s for s in inferred if s in PLAYING_STYLES]
        return ", ".join(valid)
    except Exception:
        return ""


@track_bp.route("/save", methods=["POST"])
@jwt_required()
def save_tracked_match():
    user_id = get_jwt_identity()
    data = request.get_json()

    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Google Sheet not found"}), 404

        stats1 = data.get("player1_stats", {})
        stats2 = data.get("player2_stats", {})
        match_info = data.get("match_info", {})

        # Calculate serve percentages for player 1
        first_serve_pct = round(stats1["first_serves_in"] / stats1["first_serves_total"] * 100) if stats1.get("first_serves_total", 0) > 0 else ""
        first_serve_won_pct = round(stats1.get("first_serve_points_won", 0) / stats1["first_serves_in"] * 100) if stats1.get("first_serves_in", 0) > 0 else ""
        second_serve_pct = round(stats1["second_serves_in"] / stats1["second_serves_total"] * 100) if stats1.get("second_serves_total", 0) > 0 else ""
        return_pct = round(stats1.get("returns_in", 0) / stats1.get("return_attempts", 0) * 100) if stats1.get("return_attempts", 0) > 0 else ""

        # Calculate for opponent
        opp_first_serve_pct = round(stats2["first_serves_in"] / stats2["first_serves_total"] * 100) if stats2.get("first_serves_total", 0) > 0 else ""
        opp_first_serve_won_pct = round(stats2.get("first_serve_points_won", 0) / stats2["first_serves_in"] * 100) if stats2.get("first_serves_in", 0) > 0 else ""
        opp_second_serve_pct = round(stats2["second_serves_in"] / stats2["second_serves_total"] * 100) if stats2.get("second_serves_total", 0) > 0 else ""
        opp_return_pct = round(stats2.get("returns_in", 0) / stats2.get("return_attempts", 0) * 100) if stats2.get("return_attempts", 0) > 0 else ""

        # Infer playing style
        opp_playing_style = _infer_playing_style(stats2, user_id=user_id)

        row_dict = {
            "First Serve %": first_serve_pct,
            "First Serve % Won": first_serve_won_pct,
            "Second Serve %": second_serve_pct,
            "Aces": stats1.get("aces", 0),
            "Serve Speed": "",
            "Serve Placement": "",
            "Double Faults": stats1.get("double_faults", 0),
            "Return %": return_pct,
            "Return Placement": "",
            "Winners": stats1.get("winners", 0),
            "Average Rally Length": "",
            "Unforced Errors": stats1.get("unforced_errors", 0),
            "Forced Errors": stats1.get("forced_errors", 0),
            "Net Points Won": stats1.get("net_winners", 0),
            "Break Points Won": stats1.get("break_points_converted", 0),
            "Break Points Saved": stats1.get("break_points_saved", 0),
            "Mental Game": match_info.get("mental_game", ""),
            "Match Date": match_info.get("match_date", ""),
            "Match Score": match_info.get("match_score", ""),
            "Surface Type": match_info.get("surface_type", ""),
            "Opp. Name": match_info.get("opponent_name", ""),
            "Opp. Ranking": "",
            "Opp. Playing Style": opp_playing_style,
            "Result": match_info.get("result", ""),
            "Match Description": match_info.get("match_description", ""),
            "Match Video": "",
            "UTR": "UR",
            "Analyzed Video Link": "",
            # Opponent stats
            "Opp. First Serve %": opp_first_serve_pct,
            "Opp. First Serve % Won": opp_first_serve_won_pct,
            "Opp. Second Serve %": opp_second_serve_pct,
            "Opp. Aces": stats2.get("aces", 0),
            "Opp. Double Faults": stats2.get("double_faults", 0),
            "Opp. Return %": opp_return_pct,
            "Opp. Winners": stats2.get("winners", 0),
            "Opp. Unforced Errors": stats2.get("unforced_errors", 0),
            "Opp. Forced Errors": stats2.get("forced_errors", 0),
            "Opp. Net Points Won": stats2.get("net_winners", 0),
            "Opp. Break Points Won": stats2.get("break_points_converted", 0),
            "Opp. Break Points Saved": stats2.get("break_points_saved", 0),
            "Opp. Points Won": stats2.get("points_won", 0),
            "Points Won": stats1.get("points_won", 0),
        }

        creds = get_gsheets_creds()
        gc = gspread.service_account_from_dict(creds)
        spreadsheet = gc.open_by_key(user.google_sheet_url.split("/")[-2])
        worksheet = spreadsheet.worksheet("Stats")
        headers = worksheet.row_values(1)

        # Add missing opponent headers
        opp_headers = [
            "Opp. First Serve %", "Opp. First Serve % Won", "Opp. Second Serve %",
            "Opp. Aces", "Opp. Double Faults", "Opp. Return %", "Opp. Return % Won",
            "Opp. Winners", "Opp. Unforced Errors", "Opp. Forced Errors",
            "Opp. Net Points Won", "Opp. Break Points Won", "Opp. Break Points Saved",
            "Opp. Points Won", "Points Won",
        ]
        new_headers = [h for h in opp_headers if h not in headers]
        if new_headers:
            total_cols = len(headers) + len(new_headers)
            if worksheet.col_count < total_cols:
                worksheet.resize(cols=total_cols)
            from gspread.utils import rowcol_to_a1
            start_col = len(headers) + 1
            cell_range = f"{rowcol_to_a1(1, start_col)}:{rowcol_to_a1(1, start_col + len(new_headers) - 1)}"
            worksheet.update(cell_range, [new_headers])
            headers.extend(new_headers)

        row_to_append = [row_dict.get(h, "") for h in headers]
        worksheet.append_row(row_to_append, value_input_option="USER_ENTERED")

        return jsonify({"message": "Match saved successfully"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
