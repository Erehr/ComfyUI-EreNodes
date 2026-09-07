# Where tag groups live, per the `tag_groups.location` setting: "node" is <custom_nodes>/ComfyUI-EreNodes/__prompts__, "models" is <models_dir>/tag_groups.
# The models option goes through ComfyUI's folder_paths registry, so it honours --base-directory and can be redirected from extra_model_paths.yaml.

import os
import shutil

import folder_paths

FOLDER_NAME = "tag_groups"
LOCATION_NODE = "node"
LOCATION_MODELS = "models"
LOCATION_USER = "user"
VALID_LOCATIONS = (LOCATION_NODE, LOCATION_MODELS, LOCATION_USER)

# Preview images that travel with a tag group when it is copied or renamed.
# Re-exported from the module that owns image formats, since every caller of sibling_images() already imports from paths.
from .images import IMAGE_EXTENSIONS

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


# Register <models_dir>/tag_groups under the 'tag_groups' folder name.
# Two positional arguments only: `is_default` is a later addition and would break on older ComfyUI.
def _register_models_folder():
    try:
        folder_paths.add_model_folder_path(
            FOLDER_NAME, os.path.join(folder_paths.models_dir, FOLDER_NAME)
        )
    except Exception as e:  # pragma: no cover - defensive, very old frontends
        print(f"[EreNodes] Could not register '{FOLDER_NAME}' model folder: {e}")


_register_models_folder()


# The legacy location, inside the custom node folder.
def node_prompts_dir():
    return os.path.join(_PROJECT_ROOT, "__prompts__")


# First registered root for 'tag_groups'. One root, not merged like loras: tag groups are written too, and a multi-root write target is ambiguous.
def models_prompts_dir():
    try:
        roots = folder_paths.get_folder_paths(FOLDER_NAME)
        if roots:
            return roots[0]
    except Exception:
        pass
    # folder_paths unavailable or the name vanished - fall back to the default.
    return os.path.join(folder_paths.models_dir, FOLDER_NAME)


# Everything of the user's that must outlive an update lives under here: settings, custom
# autocomplete CSVs, and tag groups. Resolved once, since callers sit on the autocomplete path.
_USER_DATA_DIR = None


def user_data_dir():
    global _USER_DATA_DIR
    if _USER_DATA_DIR is None:
        try:
            user_path = folder_paths.get_user_directory()
        except AttributeError:  # Older ComfyUI versions have no user directory helper.
            user_path = os.path.join(getattr(folder_paths, "base_path", _PROJECT_ROOT), "user")
        _USER_DATA_DIR = os.path.join(user_path, "__erenodes")
    return _USER_DATA_DIR


# The update-safe user folder, alongside the autocomplete one.
def user_prompts_dir():
    return os.path.join(user_data_dir(), FOLDER_NAME)


def dir_for_location(location):
    if location == LOCATION_MODELS:
        return models_prompts_dir()
    if location == LOCATION_NODE:
        return node_prompts_dir()
    return user_prompts_dir()


# Active location setting, normalised.
# Unset means a fresh install, which gets the user folder; an install that already has groups in the
# node folder is pinned to it instead, so changing the default never strands someone's files.
def get_location():
    # Imported lazily: settings imports nothing from us, but keeping the import local avoids a cycle if that ever changes.
    from .settings import get_erenodes_settings, save_erenodes_settings
    settings = get_erenodes_settings()
    value = settings.get("tag_groups.location")
    if value in VALID_LOCATIONS:
        return value

    resolved = LOCATION_NODE if count_tag_groups(node_prompts_dir()) else LOCATION_USER
    settings["tag_groups.location"] = resolved
    save_erenodes_settings(settings)
    return resolved


# Active tag-group root, created on demand.
# Every handler calls this instead of a module-level constant, so the toggle takes effect without restarting ComfyUI.
def get_prompts_dir():
    path = dir_for_location(get_location())
    try:
        os.makedirs(path, exist_ok=True)
    except Exception as e:
        print(f"[EreNodes] Could not create tag group folder '{path}': {e}")
    return path


# True if `target` is `root` or lives inside it.
# commonpath, not startswith: a sibling like "__prompts__backup" would pass a prefix check, and mismatched Windows drives raise ValueError.
def is_within(root, target):
    # realpath, not abspath: a symlink inside the root would otherwise pass while pointing outside it.
    try:
        abs_root = os.path.realpath(root)
        return os.path.commonpath([abs_root, os.path.realpath(target)]) == abs_root
    except ValueError:
        return False


# Number of .json files anywhere under `path` (0 if it does not exist).
def count_tag_groups(path):
    if not os.path.isdir(path):
        return 0
    total = 0
    for _dirpath, _dirnames, filenames in os.walk(path):
        total += sum(1 for f in filenames if f.lower().endswith(".json"))
    return total


# Copy tag groups from `src` to `dst`, never overwriting, so the old folder stays a backup.
# Returns (copied, skipped).
def copy_tag_groups(src, dst):
    copied = skipped = 0
    if not os.path.isdir(src) or os.path.abspath(src) == os.path.abspath(dst):
        return copied, skipped

    wanted = (".json",) + IMAGE_EXTENSIONS
    for dirpath, _dirnames, filenames in os.walk(src):
        rel = os.path.relpath(dirpath, src)
        target_dir = os.path.join(dst, rel) if rel != "." else dst
        for filename in filenames:
            if not filename.lower().endswith(wanted):
                continue
            target = os.path.join(target_dir, filename)
            if os.path.exists(target):
                skipped += 1
                continue
            try:
                os.makedirs(target_dir, exist_ok=True)
                shutil.copy2(os.path.join(dirpath, filename), target)
                # Only .json files count as tag groups; images ride along.
                if filename.lower().endswith(".json"):
                    copied += 1
            except Exception as e:
                print(f"[EreNodes] Failed copying '{filename}': {e}")
                skipped += 1
    return copied, skipped


# Preview images belonging to a tag group file.
def sibling_images(json_path):
    base = os.path.splitext(json_path)[0]
    found = []
    for ext in IMAGE_EXTENSIONS:
        for candidate in (base + ext, base + ".preview" + ext):
            if os.path.isfile(candidate):
                found.append(candidate)
    return found
