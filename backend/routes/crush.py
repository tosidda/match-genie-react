import json

import gspread
import pandas as pd
import numpy as np
from flask import Blueprint, request, jsonify, Response, stream_with_context
from flask_jwt_extended import jwt_required, get_jwt_identity
from openai import OpenAI

from database import SessionLocal, User, SharedStats
from config import get_gsheets_creds, get_openai_key
from prompt import SYSTEM_PROMPT

crush_bp = Blueprint("crush", __name__)


def _read_sheet(sheet_url):
    creds = get_gsheets_creds()
    gc = gspread.service_account_from_dict(creds)
    key = sheet_url.split("/")[-2]
    sp = gc.open_by_key(key)
    ws = sp.worksheet("Stats")
    records = ws.get_all_records()
    df = pd.DataFrame(records)
    return df.replace("", pd.NA).dropna(how="all")


def _calc_team_metrics(current_data, shared_dataframes, sharer_usernames, username):
    if len(sharer_usernames) < 2:
        return None

    all_players = {username: current_data}
    all_players.update(shared_dataframes)

    player_stats = []
    for player, pdata in all_players.items():
        if pdata.empty:
            continue
        total = len(pdata)
        wins = len(pdata[pdata["Result"] == "W"]) if "Result" in pdata.columns else 0
        win_rate = round((wins / total) * 100, 1) if total > 0 else 0
        fs = pd.to_numeric(pdata["First Serve %"].astype(str).str.rstrip("%"), errors="coerce").mean() if "First Serve %" in pdata.columns else 0
        speed = pd.to_numeric(pdata.get("Serve Speed", pd.Series(dtype=float)), errors="coerce").mean()
        ue = pd.to_numeric(pdata.get("Unforced Errors", pd.Series(dtype=float)), errors="coerce").mean()
        ret = pd.to_numeric(pdata.get("Return %", pd.Series(dtype=str)).astype(str).str.rstrip("%"), errors="coerce").mean() if "Return %" in pdata.columns else 0
        w = pd.to_numeric(pdata.get("Winners", pd.Series(dtype=float)), errors="coerce").mean()
        df_val = pd.to_numeric(pdata.get("Double Faults", pd.Series(dtype=float)), errors="coerce").mean()
        aces = pd.to_numeric(pdata.get("Aces", pd.Series(dtype=float)), errors="coerce").mean()

        player_stats.append({
            "Player": player, "Matches": total, "Win Rate (%)": win_rate,
            "Avg First Serve (%)": round(fs, 1) if pd.notna(fs) else 0,
            "Avg Serve Speed": round(speed, 1) if pd.notna(speed) else 0,
            "Avg Return (%)": round(ret, 1) if pd.notna(ret) else 0,
            "Avg Winners": round(w, 1) if pd.notna(w) else 0,
            "Avg Unforced Errors": round(ue, 1) if pd.notna(ue) else 0,
            "Avg Double Faults": round(df_val, 1) if pd.notna(df_val) else 0,
            "Avg Aces": round(aces, 1) if pd.notna(aces) else 0,
        })

    if not player_stats:
        return None

    stats_df = pd.DataFrame(player_stats)

    balance_scores = []
    for _, row in stats_df.iterrows():
        norm_speed = (row["Avg Serve Speed"] / 150) * 100 if row["Avg Serve Speed"] > 0 else 0
        vals = [row["Win Rate (%)"], row["Avg First Serve (%)"], row["Avg Return (%)"], norm_speed]
        std = np.std(vals)
        avg = np.mean(vals)
        balance_scores.append({"Player": row["Player"], "std_dev": std, "avg_score": avg, "consistency_score": 100 - std})

    most_balanced = min(balance_scores, key=lambda x: x["std_dev"]) if balance_scores else None

    impact_scores = []
    for _, row in stats_df.iterrows():
        wr = row["Win Rate (%)"]
        nw = min((row["Avg Winners"] / 30) * 100, 100) if row["Avg Winners"] > 0 else 0
        es = max(100 - (row["Avg Unforced Errors"] / 40) * 100, 0) if row["Avg Unforced Errors"] >= 0 else 100
        ds = max(100 - (row["Avg Double Faults"] / 10) * 100, 0) if row["Avg Double Faults"] >= 0 else 100
        impact = (wr * 0.40) + (nw * 0.25) + (es * 0.20) + (ds * 0.15)
        impact_scores.append({"Player": row["Player"], "impact_score": round(impact, 1), "win_rate": wr, "winners": row["Avg Winners"], "errors": row["Avg Unforced Errors"]})

    most_impactful = max(impact_scores, key=lambda x: x["impact_score"]) if impact_scores else None

    player_strengths = []
    for _, row in stats_df.iterrows():
        strengths = []
        if row["Win Rate (%)"] >= stats_df["Win Rate (%)"].mean(): strengths.append("High Win Rate")
        if row["Avg First Serve (%)"] >= stats_df["Avg First Serve (%)"].mean(): strengths.append("Strong First Serve")
        if row["Avg Serve Speed"] >= stats_df["Avg Serve Speed"].mean(): strengths.append("Powerful Serve")
        if row["Avg Return (%)"] >= stats_df["Avg Return (%)"].mean(): strengths.append("Good Returner")
        if row["Avg Winners"] >= stats_df["Avg Winners"].mean(): strengths.append("Offensive Power")
        if row["Avg Unforced Errors"] <= stats_df["Avg Unforced Errors"].mean(): strengths.append("Consistent/Low Errors")
        player_strengths.append({"Player": row["Player"], "Strengths": strengths})

    return {
        "stats_df": stats_df, "balance_scores": balance_scores,
        "most_balanced": most_balanced, "impact_scores": impact_scores,
        "most_impactful": most_impactful, "player_strengths": player_strengths,
        "team_size": len(player_stats),
    }


@crush_bp.route("/chat", methods=["POST"])
@jwt_required()
def chat():
    user_id = get_jwt_identity()
    data = request.get_json()
    messages = data.get("messages", [])
    prompt = data.get("prompt", "")
    is_team_lineup = data.get("is_team_lineup", False)

    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Sheet not found"}), 404

        current_data = _read_sheet(user.google_sheet_url)
        data_string = current_data.to_string(index=False) if not current_data.empty else "No data yet."

        # Load shared data
        shares = db.query(SharedStats).filter_by(sharee_id=user.id).all()
        sharer_usernames = [s.sharer.username for s in shares]

        shared_data = []
        shared_dataframes = {}
        for uname in sharer_usernames:
            su = db.query(User).filter_by(username=uname).first()
            if su and su.google_sheet_url:
                try:
                    sdf = _read_sheet(su.google_sheet_url)
                    shared_data.append(f"This is {uname}'s data: {sdf.to_string(index=False)}")
                    shared_dataframes[uname] = sdf
                except Exception:
                    pass

        system_content = f"{SYSTEM_PROMPT}\n\n--- PLAYER DATA (current user) ---\n{data_string}\n\n--- SHARED DATA ---\n{shared_data}"

        # Team lineup mode
        if is_team_lineup:
            if len(sharer_usernames) < 2:
                system_content += f"\n\n--- SPECIAL INSTRUCTION ---\nThe user wants team lineup recommendations but they only have {len(sharer_usernames)} other player(s). They need at least 2."
            else:
                metrics = _calc_team_metrics(current_data, shared_dataframes, sharer_usernames, user.username)
                if metrics:
                    sdf = metrics["stats_df"]
                    mb = metrics["most_balanced"]
                    mi = metrics["most_impactful"]
                    team_txt = f"\n\n--- TEAM ANALYSIS ---\nTEAM SIZE: {metrics['team_size']}\n\nPLAYER STATISTICS:\n{sdf.to_string(index=False)}\n"
                    if mb:
                        team_txt += f"\nMOST BALANCED: {mb['Player']} (Avg {mb['avg_score']:.1f}%, Consistency {mb['consistency_score']:.1f}%)\n"
                    if mi:
                        team_txt += f"MOST IMPACTFUL: {mi['Player']} (Impact {mi['impact_score']}, WR {mi['win_rate']:.1f}%)\n"
                    for bs in sorted(metrics["balance_scores"], key=lambda x: x["consistency_score"], reverse=True):
                        team_txt += f"- {bs['Player']}: Avg {bs['avg_score']:.1f}%, Consistency {bs['consistency_score']:.1f}%\n"
                    for ps in metrics["player_strengths"]:
                        team_txt += f"- {ps['Player']}: {', '.join(ps['Strengths']) if ps['Strengths'] else 'No standout strengths'}\n"
                    system_content += team_txt

        is_training_plan = "training plan" in prompt.lower()

        # Inject progress goals for training plan prompts
        if is_training_plan:
            goals = {}
            if user.progress_goals:
                goals = json.loads(user.progress_goals)
            if goals:
                goals_txt = "\n\n--- PLAYER PROGRESS GOALS ---\n"
                for goal_name, target in goals.items():
                    goals_txt += f"- {goal_name}: target {target}\n"
                system_content += goals_txt
            else:
                system_content += "\n\n--- NOTE ---\nThe player has no progress goals set. Identify their 3-4 weakest stats from their data and create focus areas for those."

        # Increment prompt count
        user.prompt_count = (user.prompt_count or 0) + 1
        db.commit()

        client = OpenAI(api_key=get_openai_key())
        max_tokens = 2048 if (is_team_lineup or is_training_plan) else 1024

        api_messages = [{"role": "system", "content": system_content}] + messages

        def generate():
            total_tokens = 0
            response = client.chat.completions.create(
                model="gpt-4o",
                messages=api_messages,
                stream=True,
                max_tokens=max_tokens,
                stream_options={"include_usage": True},
            )
            for chunk in response:
                if chunk.usage is not None:
                    total_tokens = chunk.usage.total_tokens
                if chunk.choices and chunk.choices[0].delta.content is not None:
                    yield f"data: {json.dumps({'content': chunk.choices[0].delta.content})}\n\n"
            yield "data: [DONE]\n\n"

            if total_tokens > 0:
                token_db = SessionLocal()
                try:
                    u = token_db.query(User).filter_by(id=int(user_id)).first()
                    if u:
                        u.token_count = (u.token_count or 0) + total_tokens
                        token_db.commit()
                finally:
                    token_db.close()

        return Response(stream_with_context(generate()), mimetype="text/event-stream")
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()


@crush_bp.route("/team-metrics", methods=["GET"])
@jwt_required()
def team_metrics():
    user_id = get_jwt_identity()
    db = SessionLocal()
    try:
        user = db.query(User).filter_by(id=int(user_id)).first()
        if not user or not user.google_sheet_url:
            return jsonify({"error": "Sheet not found"}), 404

        current_data = _read_sheet(user.google_sheet_url)
        shares = db.query(SharedStats).filter_by(sharee_id=user.id).all()
        sharer_usernames = [s.sharer.username for s in shares]

        shared_dataframes = {}
        for uname in sharer_usernames:
            su = db.query(User).filter_by(username=uname).first()
            if su and su.google_sheet_url:
                try:
                    shared_dataframes[uname] = _read_sheet(su.google_sheet_url)
                except Exception:
                    pass

        metrics = _calc_team_metrics(current_data, shared_dataframes, sharer_usernames, user.username)
        if not metrics:
            return jsonify({"error": "Not enough data for team metrics"}), 404

        # Convert DataFrame to dict for JSON
        result = {
            "stats": metrics["stats_df"].to_dict("records"),
            "balance_scores": metrics["balance_scores"],
            "most_balanced": metrics["most_balanced"],
            "impact_scores": metrics["impact_scores"],
            "most_impactful": metrics["most_impactful"],
            "player_strengths": metrics["player_strengths"],
            "team_size": metrics["team_size"],
        }
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    finally:
        db.close()
