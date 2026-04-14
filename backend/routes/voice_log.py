import json
from datetime import date

from flask import Blueprint, request, jsonify, Response, stream_with_context
from flask_jwt_extended import jwt_required, get_jwt_identity
from openai import OpenAI

from database import SessionLocal, User
from config import get_openai_key

voice_log_bp = Blueprint("voice_log", __name__)

VOICE_SYSTEM_PROMPT = """You are MatchGenie, a friendly tennis coach helping a player log their match data through conversation. Your ONLY job is to collect the exact stats that go into their match log — nothing more, nothing less. Do NOT ask any questions beyond these fields.

You must collect ALL of the following fields, in this order. Ask one group at a time.

FIELDS TO COLLECT (in this order, one group at a time):

1. Match Date (a specific date)
2. Surface Type (Hard, Clay, or Grass)
3. Result (W or L)
4. Match Score (set-by-set, e.g. 6-4, 6-3)
5. Opponent Name
6. UTR Rating (1-17)
7. Opponent Ranking bracket (1-100, 100-300, 300-500, or Below 500)
8. Opponent Playing Style (one or more from ONLY: Aggressive Baseline, Counterpuncher, Serve and Volley, All-Court Player, Defensive Player, Lefty, One-Handed Backhand, Net Player, Grinder, Wall)
9. First Serve %
10. First Serve % Won
11. Second Serve %
12. Aces
13. Double Faults
14. Serve Speed (MPH)
15. Serve Placement (Wide, Down the T, Body, Random/Varied)
16. Return %
17. Return Placement (Crosscourt, Down the Line, Middle, Random/Varied)
18. Winners
19. Unforced Errors
20. Forced Errors
21. Average Rally Length
22. Net Points Won
23. Break Points Won
24. Break Points Saved
25. Mental Game (how they felt mentally during the match)
26. Match Description (key moments, turning points, what worked/didn't)

THESE FIELDS ARE REQUIRED AND MUST HAVE AN ANSWER (re-ask if the user skips or is vague):
- Match Date, Surface Type, Result, Match Score, Opponent Name, Opponent Playing Style, Mental Game, Match Description

STRICT RULES:
- ONLY ask about the fields listed above. Do NOT ask anything else — no advice, no analysis, no commentary.
- NEVER tell the user a field is "optional" or say they can "skip" it. Just ask every question naturally.
- If the user doesn't answer or is vague about a REQUIRED field, politely re-ask until you get a clear answer. For example: "I just need a name for your opponent — who did you play?"
- If the user doesn't know a non-required field, just accept their answer and move on without drawing attention to it.
- Ask ONE group at a time (e.g. match basics, then opponent info, then serve stats, etc.)
- Keep responses concise (1-3 sentences max per turn).
- When ALL fields have been asked, say exactly: "I've got everything! Click the Review & Submit button when you're ready."
- Do NOT give coaching advice, analysis, or commentary — just collect the data.
- IMPORTANT: If the user volunteers extra details at ANY point during the conversation — stories about key moments, how they felt, what went well or poorly, turning points, frustrations, confidence, nerves, etc. — mentally note all of it. When you reach the Mental Game and Match Description questions, incorporate everything they already shared so they don't have to repeat themselves. Just confirm what you gathered and ask if there's anything else to add."""

EXTRACT_PROMPT = """Extract all tennis match data from this conversation into a JSON object. Use these exact field names and types:

{
  "matchDate": "YYYY-MM-DD",
  "surfaceType": "Hard" | "Clay" | "Grass",
  "result": "W" | "L",
  "playerSet1": number, "playerSet2": number, "playerSet3": number,
  "oppSet1": number, "oppSet2": number, "oppSet3": number,
  "opponentName": string,
  "utrRating": number,
  "oppRanking": "1-100" | "100-300" | "300-500" | "Below 500",
  "oppPlayingStyle": [array of strings from: "Aggressive Baseline", "Counterpuncher", "Serve and Volley", "All-Court Player", "Defensive Player", "Lefty", "One-Handed Backhand", "Net Player", "Grinder", "Wall"],
  "firstServePct": number (0-100),
  "firstServePctWon": number (0-100),
  "secondServePct": number (0-100),
  "aces": number,
  "doubleFaults": number,
  "serveSpeed": number,
  "servePlacement": [array of strings from: "Wide", "Down the T", "Body", "Random/Varied"],
  "returnPct": number (0-100),
  "returnPlacement": [array of strings from: "Crosscourt", "Down the Line", "Middle", "Random/Varied"],
  "winners": number,
  "unforcedErrors": number,
  "forcedErrors": number,
  "avgRallyLength": number,
  "netPointsWon": number,
  "breakPointsWon": number,
  "breakPointsSaved": number,
  "mentalGame": string,
  "matchDescription": string
}

Defaults for missing data: numbers → 0, strings → "", arrays → [], date → "TODAY_DATE".
IMPORTANT: For "mentalGame" and "matchDescription", don't just use what the user said when directly asked those questions. Scan the ENTIRE conversation for any extra details the user shared — stories about key moments, turning points, emotions, frustrations, confidence, what worked or didn't — and incorporate all of it into these two fields as a rich summary.
Only return the JSON object, nothing else."""


@voice_log_bp.route("/chat", methods=["POST"])
@jwt_required()
def voice_chat():
    user_id = get_jwt_identity()
    data = request.get_json()
    messages = data.get("messages", [])

    client = OpenAI(api_key=get_openai_key())
    api_messages = [{"role": "system", "content": VOICE_SYSTEM_PROMPT}] + messages

    def generate():
        total_tokens = 0
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=api_messages,
            stream=True,
            max_tokens=512,
            stream_options={"include_usage": True},
        )
        for chunk in response:
            if chunk.usage is not None:
                total_tokens = chunk.usage.total_tokens
            if chunk.choices and chunk.choices[0].delta.content is not None:
                yield f"data: {json.dumps({'content': chunk.choices[0].delta.content})}\n\n"
        yield "data: [DONE]\n\n"

        if total_tokens > 0:
            db = SessionLocal()
            try:
                user = db.query(User).filter_by(id=int(user_id)).first()
                if user:
                    user.token_count = (user.token_count or 0) + total_tokens
                    db.commit()
            finally:
                db.close()

    return Response(stream_with_context(generate()), mimetype="text/event-stream")


@voice_log_bp.route("/tts", methods=["POST"])
@jwt_required()
def voice_tts():
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "No text provided"}), 400

    try:
        client = OpenAI(api_key=get_openai_key())
        response = client.audio.speech.create(
            model="tts-1",
            voice="echo",
            input=text,
        )
        audio_bytes = response.content
        return Response(audio_bytes, mimetype="audio/mpeg",
                        headers={"Content-Type": "audio/mpeg"})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@voice_log_bp.route("/transcribe", methods=["POST"])
@jwt_required()
def voice_transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file"}), 400

    audio_file = request.files["audio"]
    audio_bytes = audio_file.read()

    if not audio_bytes:
        return jsonify({"error": "Empty audio"}), 400

    filename = audio_file.filename or "recording.mp4"
    content_type = audio_file.content_type or "audio/mp4"

    try:
        client = OpenAI(api_key=get_openai_key())
        # Pass as explicit tuple so Whisper gets the filename (for format detection)
        # and content type — passing FileStorage directly doesn't work reliably
        transcript = client.audio.transcriptions.create(
            model="whisper-1",
            file=(filename, audio_bytes, content_type),
        )
        return jsonify({"transcript": transcript.text})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@voice_log_bp.route("/extract", methods=["POST"])
@jwt_required()
def voice_extract():
    user_id = get_jwt_identity()
    data = request.get_json()
    messages = data.get("messages", [])

    today = date.today().isoformat()
    prompt = EXTRACT_PROMPT.replace("TODAY_DATE", today)

    client = OpenAI(api_key=get_openai_key())

    extraction_messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": "Here is the conversation:\n\n" + "\n".join(
            f"{m['role'].upper()}: {m['content']}" for m in messages
        )},
    ]

    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=extraction_messages,
            response_format={"type": "json_object"},
            max_tokens=1024,
        )

        total_tokens = response.usage.total_tokens if response.usage else 0
        if total_tokens > 0:
            db = SessionLocal()
            try:
                user = db.query(User).filter_by(id=int(user_id)).first()
                if user:
                    user.token_count = (user.token_count or 0) + total_tokens
                    db.commit()
            finally:
                db.close()

        extracted = json.loads(response.choices[0].message.content)
        return jsonify(extracted)
    except Exception as e:
        return jsonify({"error": str(e)}), 500
