import json
import os
import shutil

from .paths import user_data_dir

# Where settings lived before the move. Read once to carry an existing install across, and never
# shipped: a file here is overwritten by every update, so it cannot hold anyone's settings, and one
# containing `tag_groups.location` would pre-empt the fresh-install default in paths.get_location().
LEGACY_SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")
SETTINGS_FILE = os.path.join(user_data_dir(), "settings.json")

# The defaults are the code, not a bundled file. Only keys with a meaningful absent value belong
# here: `tag_groups.location` is deliberately missing, because get_location() resolves it.
DEFAULT_SETTINGS = {'autocomplete.csv': None}

# The seed from the pre-move location is a one-time step, but reads happen per autocomplete keystroke.
_PREPARED = False


def _prepare_settings_file():
    global _PREPARED
    if _PREPARED:
        return
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    # The old file is left in place as a backup; the node folder it sits in is wiped by an update anyway.
    if not os.path.exists(SETTINGS_FILE) and os.path.isfile(LEGACY_SETTINGS_FILE):
        shutil.copyfile(LEGACY_SETTINGS_FILE, SETTINGS_FILE)
    _PREPARED = True


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
