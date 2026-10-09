# MatchGenie

MatchGenie is a full-stack tennis analytics platform that helps players review match footage, track performance, and collaborate with coaches.

The project combines a web application for match logging, statistics, and coaching with a computer vision pipeline that transforms tennis footage into annotated rally clips and structured analysis.

## 1. Non-Computer Vision — Web Application and Coaching

### Features

- **Match logging:** Record matches through forms and voice-assisted input.
- **Performance tracking:** Explore match history and interactive statistical dashboards.
- **Video review:** Upload footage, follow analysis progress, review clips, and correct shot labels.
- **AI assistance:** Discuss performance using player and match data.
- **Coach collaboration:** Share matches, exchange feedback, and manage goals and training plans.
- **Account management:** Manage authentication, profiles, and subscriptions.

### Frontend files

Paths are relative to the web application codebase. Axios requests use the shared `frontend/src/api/client.js` client.

| File | Purpose | Libraries and tools |
| --- | --- | --- |
| `frontend/src/pages/Video.jsx` | Manages video submission, progress updates, playback, and shot-label corrections. | React hooks for state and lifecycle management; Axios through the shared API client; HTML video elements for playback. |
| `frontend/src/pages/Matches.jsx` | Displays match history and individual match records. | React; React Router for navigation; Axios through the shared API client. |
| `frontend/src/pages/Stats.jsx` | Renders performance summaries and interactive charts. | React; Plotly through `react-plotly.js` for charts; React Router; Axios through the shared API client. |
| `frontend/src/pages/Track.jsx` | Provides the match-tracking interface. | React hooks; React Router; Axios through the shared API client. |
| `frontend/src/pages/TrackVoice.jsx` | Supports voice-assisted match tracking. | React hooks; browser Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`); Axios through the shared API client. |
| `frontend/src/pages/Coach.jsx` | Provides coach-facing navigation and data views. | React; React Router; Axios through the shared API client. |

### Backend files

| File | Purpose | Libraries and tools |
| --- | --- | --- |
| `backend/app.py` | Initializes the API server, database tables, authentication, and route registration. | Flask; Flask-CORS; Flask-JWT-Extended; SQLAlchemy through the database module. |
| `backend/routes/auth.py` | Handles signup, login, and account-related requests. | Flask; Flask-JWT-Extended; bcrypt for password hashing; Google Auth and Google API Python Client for Google integrations; SQLAlchemy-backed models. |
| `backend/routes/matches.py` | Reads and manages match records. | Flask; Flask-JWT-Extended; gspread for Google Sheets; pandas for tabular data; SQLAlchemy-backed models. |
| `backend/routes/video.py` | Coordinates video submission, job status, results, and shot corrections. | Flask; Flask-JWT-Extended; Celery result APIs; Google Cloud Storage client; gspread; internal AWS Batch integration. |
| `backend/routes/stats.py` | Calculates statistics and manages sharing, goals, training plans, and feedback. | Flask; Flask-JWT-Extended; pandas and NumPy for data processing; gspread for Google Sheets; SQLAlchemy-backed models. |
| `backend/routes/voice_log.py` | Processes voice transcription, conversational logging, and structured extraction. | Flask and streaming responses; Flask-JWT-Extended; OpenAI Python SDK; Python JSON utilities. |
| `backend/routes/crush.py` | Generates AI responses informed by player and shared match data. | OpenAI Python SDK; Flask streaming responses; pandas; NumPy; gspread; Flask-JWT-Extended. |
| `backend/routes/billing.py` | Creates checkout sessions and processes subscription webhooks. | Stripe Python SDK; Flask; Flask-JWT-Extended; SQLAlchemy-backed models. |

### Application infrastructure

React and Vite power the frontend, with Tailwind CSS for styling. Flask provides authenticated backend APIs. SQLAlchemy manages application records, while Google Sheets integrations support match-data workflows.

Docker packages application services. Computationally intensive video analysis runs separately from the web server.

## 2. Computer Vision — Video Analysis

### How it works

1. **Filter footage:** Detect ball activity and remove inactive sections while preserving timestamp mappings.
2. **Track movement:** Extract player keypoints and ball positions using YOLO models.
3. **Identify strokes:** Combine pose, handedness, ball proximity, and motion history to generate shot candidates.
4. **Interpret court geometry:** Map image coordinates to court coordinates for bounce and boundary reasoning.
5. **Segment rallies:** Combine serves, shot events, and ball trajectories to determine rally boundaries.
6. **Produce results:** Export annotated clips, shot events, and player statistics.

An optional Astra integration evaluates proposed strokes using surrounding frames and pose evidence. It can confirm, relabel, or reject candidates; it does not independently inspect every moment of the video.

### Pipeline files

Paths are relative to the video-analysis codebase.

| File | Purpose | Libraries and tools |
| --- | --- | --- |
| `aws/worker.py` | Coordinates analysis stages, restores checkpoints, and publishes results. | Boto3 for AWS access; Amazon S3; AWS Batch as the execution environment; Python `subprocess`; FFmpeg/FFprobe for video processing. |
| `scripts/rally_trimmer.py` | Filters footage using ball activity and preserves original-to-edited timestamp mappings. | Ultralytics YOLO for detection; OpenCV for video access; NumPy for numerical processing; FFmpeg for cutting and joining footage. |
| `scripts/pose_shot_classifier.py` | Tracks players, detects stroke events, and renders pose and shot annotations. | Ultralytics YOLO for pose and object detection; OpenCV; NumPy; FFmpeg; Python CSV/JSON utilities. |
| `scripts/court_homography.py` | Maps image positions to tennis-court coordinates. | Ultralytics YOLO for court segmentation; OpenCV for perspective transformations; NumPy for coordinate calculations. |
| `scripts/ball_bounce.py` | Estimates bounce contacts and checks player strike-zone overlap. | NumPy for trajectory and geometric calculations. |
| `scripts/rally_segmenter.py` | Determines rally starts and endings from serves, ball movement, and terminal-event evidence. | Ultralytics YOLO; OpenCV; NumPy; FFmpeg; internal court, bounce, pose, and statistics modules. |
| `scripts/astra_stroke.py` | Builds frame-based requests for Astra stroke interpretation and handles responses. | OpenCV and NumPy for frame preparation; Python `base64` and `json`; `urllib.request` for OpenAI Responses API calls; internal cache and budget modules. |
| `scripts/astra_handoff.py` | Carries confirmed events between passes and reconciles rally coverage. | Python `csv` and custom event-grouping and interval-processing logic. |
| `scripts/astra_decision_cache.py` | Reuses identical model requests across passes and restarts. | Python `hashlib` for SHA-256 fingerprints; `json` and `pathlib` for local records; Boto3 and S3 for cloud persistence. |
| `scripts/astra_budget.py` | Tracks token usage, estimated costs, and optional per-video spending limits. | Python `json`, `math`, `uuid`, and `pathlib`; Boto3 and S3 conditional writes for shared ledger updates. |
| `scripts/diagnostic_retention.py` | Preserves diagnostic files before temporary working files are removed. | Python `pathlib`; an upload callback supplied by the worker for S3 persistence. |
| `scripts/shot_stats.py` | Aggregates discrete shot events into player statistics. | Python `csv`, `glob`, and `collections.defaultdict`; custom event aggregation and rally-ownership rules. |
| `scripts/winner_clips.py` | Selects supported winning shots and extracts their video clips. | Python CSV/JSON utilities; `pathlib`; `subprocess`; FFmpeg for clip extraction. |

### Cloud execution and persistence

AWS Batch runs long-running analysis jobs, while Amazon S3 stores source videos, intermediate artifacts, diagnostics, and final results.

Stage checkpoints preserve completed work. Exact-request decision caching reduces duplicate model calls across passes and restarts, while usage tracking records token consumption and estimated cost.
