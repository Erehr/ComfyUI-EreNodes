import os
import json

SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")

# Only the shape used when settings.json is missing or unreadable; keys are written by /erenodes/set_setting and read by name elsewhere.
DEFAULT_SETTINGS = {'autocomplete.csv': None}


def get_erenodes_settings():
    if not os.path.exists(SETTINGS_FILE):
        return dict(DEFAULT_SETTINGS)
    try:
        with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_erenodes_settings(data):
    try:
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
    except Exception:
        pass
