import os
from flask import Flask
from flask_cors import CORS
from flask_jwt_extended import JWTManager
from database import Base, engine

def create_app():
    app = Flask(__name__)
    app.config["JWT_SECRET_KEY"] = os.environ.get("JWT_SECRET_KEY", "match-genie-jwt-secret-change-me")
    app.config["JWT_ACCESS_TOKEN_EXPIRES"] = 86400  # 24 hours

    CORS(app, origins=["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:3456"], supports_credentials=True)
    JWTManager(app)

    # Ensure DB tables exist
    Base.metadata.create_all(engine)

    # Register blueprints
    from routes.auth import auth_bp
    from routes.matches import matches_bp
    from routes.stats import stats_bp
    from routes.crush import crush_bp
    from routes.video import video_bp
    from routes.track import track_bp
    from routes.voice_log import voice_log_bp

    app.register_blueprint(auth_bp, url_prefix="/api/auth")
    app.register_blueprint(matches_bp, url_prefix="/api/matches")
    app.register_blueprint(stats_bp, url_prefix="/api/stats")
    app.register_blueprint(crush_bp, url_prefix="/api/crush")
    app.register_blueprint(video_bp, url_prefix="/api/video")
    app.register_blueprint(track_bp, url_prefix="/api/track")
    app.register_blueprint(voice_log_bp, url_prefix="/api/voice-log")

    @app.route("/api/health")
    def health():
        return {"status": "ok"}

    return app

if __name__ == "__main__":
    app = create_app()
    app.run(debug=True, port=5000)
