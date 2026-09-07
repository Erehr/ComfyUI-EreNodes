import asyncio
import os
import csv
import threading
from collections import OrderedDict
import server
import folder_paths
from aiohttp import web

from .settings import get_erenodes_settings

# Define constants for export
CSV_FILES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "__autocomplete__")

# Return the update-safe user autocomplete directory.
def get_user_csv_files_path():
    try:
        user_path = folder_paths.get_user_directory()
    except AttributeError:  # Older ComfyUI versions have no user directory helper.
        user_path = os.path.join(
            getattr(folder_paths, "base_path", os.path.dirname(CSV_FILES_PATH)),
            "user",
        )

    path = os.path.join(user_path, "__erenodes", "autocomplete")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as e:
        print(f"[EreNodes] Could not create autocomplete folder '{path}': {e}")
    return path


# Create the user folder during node startup, before the first CSV lookup.
get_user_csv_files_path()

# Resolve a selectable CSV, preferring the bundled file on name collision.
def get_csv_path(csv_file):
    if not isinstance(csv_file, str) or csv_file != os.path.basename(csv_file) or not csv_file.lower().endswith(".csv"):
        return None

    for directory in (CSV_FILES_PATH, get_user_csv_files_path()):
        path = os.path.join(directory, csv_file)
        if os.path.isfile(path):
            return path
    return None

# List bundled and user CSVs as one stable filename namespace.
def list_csv_files():
    files = []
    for directory in (CSV_FILES_PATH, get_user_csv_files_path()):
        if os.path.isdir(directory):
            files.extend(
                filename for filename in os.listdir(directory)
                if filename.lower().endswith(".csv")
            )
    return sorted(set(files), key=str.casefold)


# utf-8-sig: several community tag files carry a BOM, which would make the first row's tag read as "\ufeff1girl" — unmatchable, and always the highest-count one.
DEFAULT_ENCODING = 'utf-8-sig'
TAG_TYPES = {
    0: "General",
    1: "Character",
    3: "Copyright",
    4: "Artist",
    5: "Meta"
}

# csv_file -> tags, keyed by name so /erenodes/set_setting can drop one entry.
TAG_DATA_CACHE = {}

# Parsing 320k rows takes a couple of seconds, and without this two searches arriving together on a cold cache both pay for it.
_TAG_DATA_LOCK = threading.Lock()

# (csv_file -> (mtime, (tag_set, alias_map))) used by the Prompt Filter node
FILTER_MAP_CACHE = {}

# Short-lived cache for repeated autocomplete queries, such as typing a
# character and then deleting it again.
_SEARCH_CACHE_MAX = 32
_SEARCH_CACHE = OrderedDict()
_SEARCH_CACHE_LOCK = threading.Lock()


def _clear_search_cache(csv_file=None):
    with _SEARCH_CACHE_LOCK:
        if csv_file is None:
            _SEARCH_CACHE.clear()
            return

        for key in list(_SEARCH_CACHE):
            if key[0] == csv_file:
                _SEARCH_CACHE.pop(key, None)


# Yield data rows, skipping a header line if the file has one.
# Two shapes are in circulation, so it is detected rather than assumed: a data row has an integer post count in column 3.
def _open_rows(csvfile):
    reader = csv.reader(csvfile)
    first = next(reader, None)
    if first is None:
        return
    if not _is_header(first):
        yield first
    for row in reader:
        yield row


def _is_header(row):
    if len(row) < 3:
        return False
    try:
        int(row[2])
    except (TypeError, ValueError):
        return True
    return False


# Return (tag_set, alias_map) for a CSV file, cached by mtime.
def get_filter_maps(csv_file):
    if not csv_file:
        return None
    csv_path = get_csv_path(csv_file)
    if csv_path is None:
        return None
    try:
        mtime = os.path.getmtime(csv_path)
    except OSError:
        return None

    cached = FILTER_MAP_CACHE.get(csv_file)
    if cached and cached[0] == mtime:
        return cached[1]

    tag_set = set()
    alias_map = {}
    try:
        with open(csv_path, newline='', encoding=DEFAULT_ENCODING) as csvfile:
            for row in _open_rows(csvfile):
                if len(row) < 4:
                    continue
                tag = row[0].strip().lower().replace('_', ' ')
                if not tag:
                    continue
                tag_set.add(tag)
                if row[3]:
                    for alias in row[3].split(','):
                        alias = alias.strip().lower().replace('_', ' ')
                        if alias:
                            alias_map[alias] = tag
    except Exception:
        return None

    result = (tag_set, alias_map)
    FILTER_MAP_CACHE[csv_file] = (mtime, result)
    return result


# Drop cached data for one CSV so the next use reloads it.
def invalidate_csv_caches(csv_file):
    if not csv_file:
        return

    with _TAG_DATA_LOCK:
        TAG_DATA_CACHE.pop(csv_file, None)
    _clear_search_cache(csv_file)
    FILTER_MAP_CACHE.pop(csv_file, None)

def load_tags_from_csv(csv_path):
    tags = []
    if csv_path and os.path.isfile(csv_path):
        try:
            with open(csv_path, newline='', encoding=DEFAULT_ENCODING) as csvfile:
                for row in _open_rows(csvfile):
                    if len(row) < 3: continue
                    try:
                        name = row[0].strip().lower().replace('_', ' ')
                        if not name: continue
                        count = int(row[2])
                        
                        aliases = []
                        if len(row) >= 4 and row[3]:
                            aliases = [a.strip().lower().replace('_', ' ') for a in row[3].split(',') if a.strip()]

                        # Append as simple
                        tags.append((name, count, aliases))
                    except (ValueError, IndexError):
                        continue
        except Exception:
            pass

    return tags

# The active CSV, parsed and cached. Cache invalidation is driven by the
# autocomplete setting and process restart; Prompt Filter has its own mtime
# based cache because it accepts a CSV per node execution.
# Blocking: the merged danbooru+e621 file is ~320k rows and a couple of seconds, so call it from a thread, never on the event loop.
def get_tag_data(active_csv=None):
    if active_csv is None:
        settings = get_erenodes_settings()
        active_csv = settings.get('autocomplete.csv')

    if not active_csv:
        return []

    cached = TAG_DATA_CACHE.get(active_csv)
    if cached is not None:
        return cached

    csv_path = get_csv_path(active_csv)
    if csv_path is None:
        # Missing or unreadable: nothing to search, and nothing worth caching.
        return []

    with _TAG_DATA_LOCK:
        # Another thread may have loaded it while this one waited.
        cached = TAG_DATA_CACHE.get(active_csv)
        if cached is not None:
            return cached
        tags = load_tags_from_csv(csv_path)
        TAG_DATA_CACHE[active_csv] = tags
        _clear_search_cache(active_csv)
    return tags

# Substring match over tag names and their aliases, in file order, so that "eyes" finds `blue eyes`.
# The CSVs are sorted by post count descending, so breaking at `limit` stops early and hands back the highest-count matches; input that matches little or nothing walks the whole file for ~50ms.
def _search_tags(query, limit):
    active_csv = get_erenodes_settings().get('autocomplete.csv')
    if not active_csv:
        return []

    cache_key = (active_csv, query, limit)
    with _SEARCH_CACHE_LOCK:
        cached = _SEARCH_CACHE.get(cache_key)
        if cached is not None:
            _SEARCH_CACHE.move_to_end(cache_key)
            return list(cached)

    all_tags = get_tag_data(active_csv)

    results = []
    seen_tags = set()

    for tag_name, count, aliases in all_tags:
        if len(results) >= limit:
            break

        if not tag_name or tag_name in seen_tags:
            continue

        # Check for matches
        match_found = False
        if query in tag_name:
            match_found = True
        
        if not match_found:
            for alias in aliases:
                if query in alias:
                    match_found = True
                    break
        
        if match_found:
            # Convert only matched results as dict
            results.append({
                'name': tag_name,
                'count': count,
                'aliases': aliases,
            })
            seen_tags.add(tag_name)

    with _SEARCH_CACHE_LOCK:
        _SEARCH_CACHE[cache_key] = results
        _SEARCH_CACHE.move_to_end(cache_key)
        while len(_SEARCH_CACHE) > _SEARCH_CACHE_MAX:
            _SEARCH_CACHE.popitem(last=False)

    return results


@server.PromptServer.instance.routes.get("/erenodes/search_tags")
async def search_tags(request):
    query = request.query.get("query", "").lower().strip().replace('_', ' ')
    try:
        limit = max(1, min(int(request.query.get("limit", 10)), 100))
    except (TypeError, ValueError):
        limit = 10

    if not query:
        return web.json_response([])

    # In a thread: inline, the first search after a restart froze the whole server for the length of the CSV parse, which reads as a stutter somewhere else entirely.
    # Pure Python holds the GIL between switch intervals, so this turns one long freeze into a series of short ones rather than removing them.
    try:
        results = await asyncio.to_thread(_search_tags, query, limit)
    except Exception as e:
        print(f"[EreNodes] search_tags failed: {e}")
        return web.json_response([])
    return web.json_response(results)

