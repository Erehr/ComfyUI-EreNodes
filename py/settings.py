import json
import os
import shutil

from .paths import user_data_dir

# Read once to carry an existing install across, and never shipped.
# A file here is overwritten by every update, and one holding `tag_groups.location` would pre-empt
# the fresh-install default in paths.get_location().
LEGACY_SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")
SETTINGS_FILE = os.path.join(user_data_dir(), "settings.json")

# Only keys with a meaningful absent value belong here.
# `tag_groups.location` is deliberately missing, because get_location() resolves it.
DEFAULT_SETTINGS = {'autocomplete.csv': None}

# Seeding is one-time, but reads happen per autocomplete keystroke.
_PREPARED = False

# ((mtime_ns, size), settings) of the last read, so a keystroke costs a stat rather than a parse.
_CACHE = (None, None)


def _prepare_settings_file():
    global _PREPARED
    if _PREPARED:
        return
    os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
    if not os.path.exists(SETTINGS_FILE) and os.path.isfile(LEGACY_SETTINGS_FILE):
        shutil.copyfile(LEGACY_SETTINGS_FILE, SETTINGS_FILE)
    _PREPARED = True


def get_erenodes_settings():
    global _CACHE
    try:
        _prepare_settings_file()
        stat = os.stat(SETTINGS_FILE)
        stamp = (stat.st_mtime_ns, stat.st_size)
        if _CACHE[0] != stamp:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as f:
                _CACHE = (stamp, json.load(f))
        # A copy: callers modify the dict before passing it to save_erenodes_settings.
        return dict(_CACHE[1])
    except Exception:
        return dict(DEFAULT_SETTINGS)


def save_erenodes_settings(data):
    global _CACHE
    _CACHE = (None, None)
    try:
        _prepare_settings_file()
        with open(SETTINGS_FILE, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=4)
    except Exception:
        pass
