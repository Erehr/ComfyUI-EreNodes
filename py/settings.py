import json
import os
import shutil

import folder_paths

LEGACY_SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")
USER_DIRECTORY = folder_paths.get_user_directory()
SETTINGS_FILE = os.path.join(USER_DIRECTORY, "__erenodes", "settings.json")

# Only the shape used when settings.json is missing or unreadable; keys are written by /erenodes/set_setting and read by name elsewhere.
DEFAULT_SETTINGS = {'autocomplete.csv': None}


def _prepare_settings_file():
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    if not os.path.exists(SETTINGS_FILE) and os.path.isfile(LEGACY_SETTINGS_FILE):
        shutil.copyfile(LEGACY_SETTINGS_FILE, SETTINGS_FILE)


def get_erenodes_settings():
    try:
        _prepare_settings_file()
        with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_erenodes_settings(data):
    try:
        _prepare_settings_file()
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
    except Exception:
        pass
