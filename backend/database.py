import os
from sqlalchemy import create_engine, Column, Integer, String, Text, ForeignKey, inspect, text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, relationship

# --- Database Setup ---
# Get the absolute path to the directory where this file is located
_current_dir = os.path.dirname(os.path.abspath(__file__))
# Share the same database as the Streamlit match-genie version
_db_path = os.path.join(_current_dir, "..", "..", "match-genie", "users.db")
# Create the SQLAlchemy database URL
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

# Create tables
Base.metadata.create_all(engine)

# Add progress_goals column if it doesn't exist (for existing DBs)
inspector = inspect(engine)
columns = [c['name'] for c in inspector.get_columns('users')]
if 'progress_goals' not in columns:
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN progress_goals TEXT"))
        conn.commit()

if 'training_plan' not in columns:
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN training_plan TEXT"))
        conn.commit()

if 'prompt_count' not in columns:
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN prompt_count INTEGER DEFAULT 0"))
        conn.commit()

if 'voice_count' not in columns:
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN voice_count INTEGER DEFAULT 0"))
        conn.commit()

if 'token_count' not in columns:
    with engine.connect() as conn:
        conn.execute(text("ALTER TABLE users ADD COLUMN token_count INTEGER DEFAULT 0"))
        conn.commit()

for col in ['first_name', 'last_name', 'location', 'utr', 'profile_pic']:
    if col not in columns:
        with engine.connect() as conn:
            conn.execute(text(f"ALTER TABLE users ADD COLUMN {col} TEXT"))
            conn.commit()

ss_columns = [c['name'] for c in inspector.get_columns('shared_stats')]
for col_name in ['goal_comments', 'match_comments', 'general_comment']:
    if col_name not in ss_columns:
        with engine.connect() as conn:
            conn.execute(text(f"ALTER TABLE shared_stats ADD COLUMN {col_name} TEXT"))
            conn.commit()

# Ensure shared_match_feedback table exists (handled by create_all above, but refresh inspector)
inspector = inspect(engine)
if 'shared_match_feedback' not in inspector.get_table_names():
    SharedMatchFeedback.__table__.create(engine)
