import os
import json

SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")

def get_erenodes_settings():
    if not os.path.exists(SETTINGS_FILE):
        # Return a default structure if the file doesn't exist
        return {'active_csv': None, 'other_settings': {}}
    try:
        with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except json.JSONDecodeError:
        # Return default structure if JSON is invalid
        print(f"[EreNodes Settings] Error decoding {SETTINGS_FILE}. Returning default settings.")
        return {'active_csv': None, 'other_settings': {}}
    except Exception as e:
        print(f"[EreNodes Settings] Error reading {SETTINGS_FILE}: {e}. Returning default settings.")
        return {'active_csv': None, 'other_settings': {}}

def save_erenodes_settings(data):
    try:
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
    except Exception as e:
        print(f"[EreNodes Settings] Error writing to {SETTINGS_FILE}: {e}")