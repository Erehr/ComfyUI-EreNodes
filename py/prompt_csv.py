import asyncio
import os
import csv
import threading
from array import array
from bisect import bisect_right
from collections import OrderedDict
import server
from aiohttp import web

from .paths import user_data_dir
from .settings import get_erenodes_settings

# Define constants for export
CSV_FILES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "__autocomplete__")

# Resolved once: this sits on the autocomplete path, which runs per keystroke.
_USER_CSV_PATH = None


# Return the update-safe user autocomplete directory.
def get_user_csv_files_path():
    global _USER_CSV_PATH
    if _USER_CSV_PATH is not None:
        return _USER_CSV_PATH

    path = os.path.join(user_data_dir(), "autocomplete")
    try:
        os.makedirs(path, exist_ok=True)
    except OSError as e:
        print(f"[EreNodes] Could not create autocomplete folder '{path}': {e}")
    _USER_CSV_PATH = path
    return path


# Create the user folder during node startup, before the first CSV lookup.
get_user_csv_files_path()

# Names already reported as overriding a bundled file, so the notice prints once each.
_SHADOWED_WARNED = set()


# The user folder wins: a file put there deliberately is meant to replace the bundled one.
def get_csv_path(csv_file):
    if not isinstance(csv_file, str) or csv_file != os.path.basename(csv_file) or not csv_file.lower().endswith(".csv"):
        return None

    user_path = os.path.join(get_user_csv_files_path(), csv_file)
    bundled_path = os.path.join(CSV_FILES_PATH, csv_file)

    if os.path.isfile(user_path):
        if os.path.isfile(bundled_path) and csv_file not in _SHADOWED_WARNED:
            _SHADOWED_WARNED.add(csv_file)
            print(f"[EreNodes] '{csv_file}' in the user autocomplete folder overrides the bundled file of the same name.")
        return user_path
    return bundled_path if os.path.isfile(bundled_path) else None

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
# csv_file -> (mtime, TagData), keyed by name so /erenodes/set_setting can drop one entry and stamped with mtime so an edited CSV is noticed.
TAG_DATA_CACHE = {}

# Parsing 320k rows takes a couple of seconds, and without this two searches arriving together on a cold cache both pay for it.
_TAG_DATA_LOCK = threading.Lock()

# csv_file -> (mtime, (tag_set, alias_map)) for the Prompt Filter node, derived from the autocomplete data rather than a second parse of the file.
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


# Return (tag_set, alias_map) for a CSV file, or None when it cannot be loaded.
def get_filter_maps(csv_file):
    loaded = _load(csv_file)
    if loaded is None:
        return None
    mtime, data = loaded

    cached = FILTER_MAP_CACHE.get(csv_file)
    if cached and cached[0] == mtime:
        return cached[1]

    tag_set = set()
    alias_map = {}
    for line in data.hay.split("\n"):
        if line:
            name, *aliases = line.split("\t")
            tag_set.add(name)
            for alias in aliases:
                alias_map[alias] = name

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

# One CSV as a single string, a line per row of `name\talias\talias...`, plus each line's start offset and post count.
# Searching is then str.find in C over one buffer instead of a Python loop over 320k tuples, and one string costs far less memory than a tuple and list per row.
class TagData:
    __slots__ = ("hay", "starts", "counts")

    def __init__(self, hay, starts, counts):
        self.hay = hay
        self.starts = starts
        self.counts = counts


def _normalize_field(value):
    value = value.strip().lower().replace('_', ' ')
    # Tabs and newlines delimit the haystack, so they cannot survive inside a field.
    return value if value.isprintable() else value.replace('\t', ' ').replace('\n', ' ')


def load_tags_from_csv(csv_path):
    lines, starts, counts = [], array('q'), array('q')
    offset = 0
    if csv_path and os.path.isfile(csv_path):
        try:
            with open(csv_path, newline='', encoding=DEFAULT_ENCODING) as csvfile:
                for row in _open_rows(csvfile):
                    if len(row) < 3:
                        continue
                    name = _normalize_field(row[0])
                    if not name:
                        continue
                    try:
                        count = int(row[2])
                    except ValueError:
                        continue
                    fields = [name]
                    if len(row) >= 4 and row[3]:
                        fields.extend(alias for alias in map(_normalize_field, row[3].split(',')) if alias)
                    line = "\t".join(fields) + "\n"
                    lines.append(line)
                    starts.append(offset)
                    counts.append(count)
                    offset += len(line)
        except Exception:
            pass
    return TagData("".join(lines), starts, counts)


# (mtime, TagData) for a CSV, loaded on first use; None when the file is missing or unreadable.
# Blocking: the merged danbooru+e621 file is ~320k rows, so call it from a thread, never on the event loop.
def _load(csv_file):
    if not csv_file:
        return None
    csv_path = get_csv_path(csv_file)
    if csv_path is None:
        return None
    try:
        mtime = os.path.getmtime(csv_path)
    except OSError:
        return None

    cached = TAG_DATA_CACHE.get(csv_file)
    if cached and cached[0] == mtime:
        return cached

    with _TAG_DATA_LOCK:
        # Another thread may have loaded it while this one waited.
        cached = TAG_DATA_CACHE.get(csv_file)
        if cached and cached[0] == mtime:
            return cached
        cached = TAG_DATA_CACHE[csv_file] = (mtime, load_tags_from_csv(csv_path))
        _clear_search_cache(csv_file)
    return cached


def get_tag_data(active_csv=None):
    if active_csv is None:
        active_csv = get_erenodes_settings().get('autocomplete.csv')
    loaded = _load(active_csv)
    return loaded[1] if loaded else None


# Substring match over tag names and their aliases, in file order, so that "eyes" finds `blue eyes`.
# The CSVs are sorted by post count descending, so stopping at `limit` hands back the highest-count matches.
def _search_tags(query, limit):
    # Either would match across field or row boundaries in the haystack.
    if "\t" in query or "\n" in query:
        return []
    active_csv = get_erenodes_settings().get('autocomplete.csv')
    if not active_csv:
        return []

    # Loaded first: a reload drops the search cache, which would otherwise still answer.
    data = get_tag_data(active_csv)
    if data is None:
        return []

    cache_key = (active_csv, query, limit)
    with _SEARCH_CACHE_LOCK:
        cached = _SEARCH_CACHE.get(cache_key)
        if cached is not None:
            _SEARCH_CACHE.move_to_end(cache_key)
            return list(cached)

    hay, starts, counts = data.hay, data.starts, data.counts
    results = []
    seen_tags = set()
    position = 0
    while len(results) < limit:
        hit = hay.find(query, position)
        if hit < 0:
            break
        row = bisect_right(starts, hit) - 1
        end = hay.index("\n", hit)
        tag_name, *aliases = hay[starts[row]:end].split("\t")
        if tag_name not in seen_tags:
            seen_tags.add(tag_name)
            results.append({
                'name': tag_name,
                'count': counts[row],
                'aliases': aliases,
            })
        position = end + 1

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

