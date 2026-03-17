import os
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, inspect, text
from sqlalchemy.exc import OperationalError as SAOperationalError
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

# --- Database Setup ---
# Use DATA_DIR env var in production (Docker volume), fallback to local dev path
_data_dir = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "match-genie"))
os.makedirs(_data_dir, exist_ok=True)
_db_path = os.path.join(_data_dir, "users.db")
DATABASE_URL = f"sqlite:///{_db_path}"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
session = SessionLocal()
Base = declarative_base()

# --- Database Models ---
class User(Base):
    __tablename__ = 'users'
    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False)
    hashed_password = Column(String, nullable=True)  # Allow null for Google Sign-In
    google_sheet_url = Column(String, nullable=True)
    google_id = Column(String, unique=True, nullable=True)  # For Google OAuth
    progress_goals = Column(Text, nullable=True)
    training_plan = Column(Text, nullable=True)
    prompt_count = Column(Integer, default=0)
    voice_count = Column(Integer, default=0)
    first_name = Column(String, nullable=True)
    last_name = Column(String, nullable=True)
    location = Column(String, nullable=True)
    utr = Column(String, nullable=True)
    profile_pic = Column(String, nullable=True)
    token_count = Column(Integer, default=0)
    match_count = Column(Integer, default=0)
    is_equity_player = Column(Integer, default=0)
    email = Column(String, nullable=True)
    subscription_tier = Column(String, default='free')
    stripe_customer_id = Column(String, unique=True, nullable=True)
    stripe_subscription_id = Column(String, unique=True, nullable=True)
    last_login = Column(String, nullable=True)

    shares_given = relationship("SharedStats", foreign_keys="SharedStats.sharer_id", back_populates="sharer")
    shares_received = relationship("SharedStats", foreign_keys="SharedStats.sharee_id", back_populates="sharee")

class SharedStats(Base):
    __tablename__ = 'shared_stats'
    id = Column(Integer, primary_key=True)
    sharer_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    sharee_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    goal_comments = Column(Text, nullable=True)
    match_comments = Column(Text, nullable=True)
    general_comment = Column(Text, nullable=True)

    sharer = relationship("User", back_populates="shares_given", foreign_keys=[sharer_id])
    sharee = relationship("User", back_populates="shares_received", foreign_keys=[sharee_id])

class SharedMatchFeedback(Base):
    __tablename__ = 'shared_match_feedback'
    id = Column(Integer, primary_key=True)
    sharer_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    sharee_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    match_key = Column(String, nullable=False)
    match_data = Column(Text, nullable=True)
    feedback = Column(Text, nullable=True)
    feedback_date = Column(String, nullable=True)
    created_at = Column(String, nullable=True)

    sharer = relationship("User", foreign_keys=[sharer_id])
    sharee = relationship("User", foreign_keys=[sharee_id])

class TrackingCode(Base):
    __tablename__ = 'tracking_codes'
    id = Column(Integer, primary_key=True)
    code = Column(String, unique=True, nullable=False)
    player_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    expires_at = Column(String, nullable=False)
    player = relationship("User", foreign_keys=[player_id])

# Create tables
Base.metadata.create_all(engine)

def _add_column(sql):
    try:
        with engine.connect() as conn:
            conn.execute(text(sql))
            conn.commit()
    except SAOperationalError:
        pass  # Column already exists (race between workers or re-deploy)

# Add missing columns for existing DBs
inspector = inspect(engine)
columns = [c['name'] for c in inspector.get_columns('users')]

if 'progress_goals' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN progress_goals TEXT")
if 'training_plan' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN training_plan TEXT")
if 'prompt_count' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN prompt_count INTEGER DEFAULT 0")
if 'voice_count' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN voice_count INTEGER DEFAULT 0")
if 'token_count' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN token_count INTEGER DEFAULT 0")
if 'subscription_tier' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN subscription_tier TEXT DEFAULT 'free'")
if 'match_count' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN match_count INTEGER DEFAULT 0")
if 'is_equity_player' not in columns:
    _add_column("ALTER TABLE users ADD COLUMN is_equity_player INTEGER DEFAULT 0")
for col in ['stripe_customer_id', 'stripe_subscription_id']:
    if col not in columns:
        _add_column(f"ALTER TABLE users ADD COLUMN {col} TEXT")
for col in ['first_name', 'last_name', 'location', 'utr', 'profile_pic', 'email', 'last_login']:
    if col not in columns:
        _add_column(f"ALTER TABLE users ADD COLUMN {col} TEXT")

ss_columns = [c['name'] for c in inspector.get_columns('shared_stats')]
for col_name in ['goal_comments', 'match_comments', 'general_comment']:
    if col_name not in ss_columns:
        _add_column(f"ALTER TABLE shared_stats ADD COLUMN {col_name} TEXT")

# Ensure new tables exist
inspector = inspect(engine)
if 'shared_match_feedback' not in inspector.get_table_names():
    SharedMatchFeedback.__table__.create(engine)
if 'tracking_codes' not in inspector.get_table_names():
    TrackingCode.__table__.create(engine)
