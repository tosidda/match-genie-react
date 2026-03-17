import os
import toml

_secrets = None

def get_secrets():
    global _secrets
    if _secrets is None:
        secrets_path = os.path.join(os.path.dirname(__file__), '.streamlit', 'secrets.toml')
        _secrets = toml.load(secrets_path)
    return _secrets

def get_gsheets_creds():
    return get_secrets().get("connections", {}).get("gsheets", {})

def get_openai_key():
    return get_secrets().get("OPENAI_API_KEY", "")

def get_google_oauth_config():
    s = get_secrets()
    return {
        "client_id": s.get("GOOGLE_CLIENT_ID", ""),
        "client_secret": s.get("GOOGLE_CLIENT_SECRET", ""),
        "redirect_uri": s.get("REDIRECT_URI", ""),
    }

def get_gcs_bucket():
    return get_gsheets_creds().get("gcs_bucket", "matchgenie-uploads-prod")

def get_admin_usernames():
    return get_secrets().get("ADMIN_USERNAMES", [])
