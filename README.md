# MatchGenie

MatchGenie is a full-stack tennis analytics platform that helps players review match footage, track performance, and collaborate with coaches.

The project has two connected parts: a web application for match logging, statistics, and coaching, and a computer vision pipeline that turns match footage into annotated clips and structured analysis.

## 1. Non-Computer Vision — Web Application and Coaching

The web application connects video analysis with the broader player experience: recording matches, reviewing progress, receiving coaching feedback, and managing an account.

### Main features

- **Match logging:** Record match information through forms or voice-assisted workflows.
- **Performance tracking:** Review match history and statistical summaries through interactive dashboards.
- **Video review:** Submit footage, follow analysis progress, watch annotated clips, and correct shot labels.
- **AI assistance:** Discuss match data and performance with a conversational assistant.
- **Coach collaboration:** Share statistics and matches, exchange feedback, and manage training plans and goals.
- **Account management:** Support authentication, player profiles, subscriptions, and administrative workflows.

### Application structure

The frontend uses React to manage navigation, forms, dashboards, and video interactions. A Flask backend exposes authenticated APIs, coordinates analysis requests, and integrates with storage and external services.

The paths below belong to the web application codebase; the computer vision paths in Part 2 belong to the analysis codebase.

| File or directory | Responsibility |
| --- | --- |
| `frontend/src/pages/Video.jsx` | Handles video submission, analysis progress, playback, and shot-label review. |
| `frontend/src/pages/Matches.jsx` | Presents match history and individual match records. |
| `frontend/src/pages/Stats.jsx` | Displays performance summaries and statistical visualizations. |
| `frontend/src/pages/Track.jsx` and `TrackVoice.jsx` | Provide match-tracking interfaces, including voice-assisted input. |
| `frontend/src/pages/Coach.jsx` | Provides the coach-facing interface. |
| `backend/app.py` | Initializes Flask, authentication, cross-origin settings, and API routes. |
| `backend/routes/auth.py` | Handles signup, login, and account-related requests. |
| `backend/routes/matches.py` | Provides match-record operations. |
| `backend/routes/video.py` | Connects the application to video-analysis submission and result workflows. |
| `backend/routes/stats.py` | Serves statistics, sharing, goals, training plans, and coaching feedback. |
| `backend/routes/voice_log.py` | Processes transcription, conversational input, and structured extraction for voice logging. |
| `backend/routes/crush.py` | Supports AI conversations using player and shared match data. |
| `backend/routes/billing.py` | Integrates Stripe checkout and subscription webhooks. |

### Data and infrastructure

The backend uses SQLAlchemy for application records and Google Sheets integrations for match-data workflows. JWT authentication protects API routes, while Stripe supports subscription management.

Docker separates application services, and the cloud analysis pipeline performs computationally intensive video processing without tying it to a browser session.

**Technologies:** React, Vite, Tailwind CSS, Plotly, Flask, SQLAlchemy, JWT, Google Sheets API, OpenAI API, Stripe, Docker.

## 2. Computer Vision — Video Analysis

The video analysis pipeline combines player pose estimation, ball detection, court geometry, and temporal logic to identify tennis strokes and organize footage into rally clips.

### How it works

1. **Filter inactive footage:** Identify periods of ball activity, remove inactive sections, and preserve the relationship between original and edited timestamps.
2. **Track players and the ball:** Use YOLO pose estimation and object detection to extract player keypoints and ball positions.
3. **Identify strokes:** Combine wrist and arm movement, handedness, ball proximity, and motion history to generate serve, forehand, and backhand events.
4. **Interpret court geometry:** Map image coordinates onto a tennis court to support bounce classification and rally-ending decisions.
5. **Segment rallies:** Combine serve timestamps, shot events, ball trajectories, and terminal-event evidence to determine rally boundaries.
6. **Generate results:** Produce annotated rally clips, event files, and player-level statistics.

An optional Astra integration interprets proposed strokes using surrounding video frames and pose information. It can confirm, relabel, or reject a candidate; it does not independently inspect every moment of the match.

### Key files

| File | Responsibility |
| --- | --- |
| `aws/worker.py` | Coordinates the AWS Batch pipeline, restores checkpoints, and publishes videos, progress, and results to S3. |
| `scripts/rally_trimmer.py` | Filters footage using ball activity and maintains an original-to-edited timeline mapping. |
| `scripts/pose_shot_classifier.py` | Tracks player identity, processes pose and ball signals, detects stroke events, and renders annotations. |
| `scripts/court_homography.py` | Converts image positions into court coordinates for spatial reasoning. |
| `scripts/ball_bounce.py` | Estimates bounce events from short ball trajectories. |
| `scripts/rally_segmenter.py` | Determines rally boundaries using serves, ball movement, and rally-ending evidence. |
| `scripts/astra_stroke.py` | Sends candidate-centered frames and supporting metadata to Astra for stroke interpretation. |
| `scripts/astra_handoff.py` | Reuses confirmed events across analysis passes and helps recover rally coverage. |
| `scripts/astra_decision_cache.py` | Persists exact-request decisions so repeated work can reuse results across passes and restarts. |
| `scripts/astra_budget.py` | Records token usage and estimated cost, with configurable per-video budget enforcement. |
| `scripts/diagnostic_retention.py` | Preserves available frame-level diagnostics and decision logs for debugging. |
| `scripts/shot_stats.py` | Aggregates shot events into player statistics while accounting for overlapping rally clips. |
| `scripts/winner_clips.py` | Extracts supported winning-shot clips using contact order and rally-ending evidence. |

### Cloud execution

Long-running analysis runs separately from the web application through AWS Batch. Amazon S3 stores inputs, intermediate artifacts, and results. Checkpoints preserve completed stages and rallies, while persistent decision caching avoids repeating identical model requests.

**Technologies:** Python, Ultralytics YOLO, OpenCV, FFmpeg, OpenAI API, AWS Batch, Amazon S3, Docker.
