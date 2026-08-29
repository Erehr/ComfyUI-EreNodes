import asyncio
import os
import csv
import threading
import server
from aiohttp import web

from .settings import get_erenodes_settings

# Define constants for export
CSV_FILES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "__autocomplete__")
# utf-8-sig, not utf-8: several community tag files (the Korean danbooru sets in particular) are saved with a BOM, and without this the first row's tag comes back as "\ufeff1girl" — silently unmatchable, and it is always the highest-count tag in a count-sorted file.
DEFAULT_ENCODING = 'utf-8-sig'
TAG_TYPES = {
    0: "General",
    1: "Character",
    3: "Copyright",
    4: "Artist",
    5: "Meta"
}

# csv_file -> (mtime, tags). Keyed by name so /erenodes/set_setting can still drop
# one entry; stamped with mtime so an edited or replaced CSV is noticed, which is
# what get_filter_maps below has always done and this cache never did.
TAG_DATA_CACHE = {}

# Parsing 320k rows takes a couple of seconds. Without this, two searches arriving
# together while the cache is cold both pay for it.
_TAG_DATA_LOCK = threading.Lock()

# (csv_file -> (mtime, (tag_set, alias_map))) used by the Prompt Filter node
FILTER_MAP_CACHE = {}


# Yield data rows, skipping a header line if the file has one.
#
# Two shapes are in circulation, so it is detected rather than assumed: a real data row has an integer post count in column 3.
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
    csv_path = os.path.join(CSV_FILES_PATH, csv_file)
    if not os.path.isfile(csv_path):
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

                        tags.append({
                            'name': name,
                            'count': count,
                            'aliases': aliases
                        })
                    except (ValueError, IndexError):
                        continue
        except Exception:
            pass

    return tags

# The active CSV, parsed and cached.
#
# Blocking: parsing the merged danbooru+e621 file is ~320k rows and a couple of
# seconds. Call it from a thread (search_tags does), never on the event loop.
def get_tag_data():
    settings = get_erenodes_settings()
    active_csv = settings.get('autocomplete.csv')

    if not active_csv:
        return []

    csv_path = os.path.join(CSV_FILES_PATH, active_csv)
    try:
        mtime = os.path.getmtime(csv_path)
    except OSError:
        # Missing or unreadable: nothing to search, and nothing worth caching.
        return []

    cached = TAG_DATA_CACHE.get(active_csv)
    if cached and cached[0] == mtime:
        return cached[1]

    with _TAG_DATA_LOCK:
        # Another thread may have loaded it while this one waited.
        cached = TAG_DATA_CACHE.get(active_csv)
        if cached and cached[0] == mtime:
            return cached[1]
        tags = load_tags_from_csv(csv_path)
        TAG_DATA_CACHE[active_csv] = (mtime, tags)
    return tags

# Substring match over tag names and their aliases, in file order.
#
# The scan looks linear but is not, in practice: the CSVs are sorted by post count
# descending, so breaking at `limit` both stops early and hands back the highest-
# count matches. Typical input is answered in well under a millisecond. The cost
# is paid by input that matches little or nothing - a rare tag, a multi-word
# fragment, a typo - which walks the whole file for ~50ms on the merged CSV.
#
# Substring, not prefix, on purpose: "eyes" has to find `blue eyes`, and "genshin"
# has to find `genshin impact`. A prefix trie or a bisect over sorted names would
# make the walk cheap, but only by answering a narrower question - and it would
# lose the aliases, which are substring-matched here too. It would also have to
# gather *every* prefix match and re-rank it by count, since name order is not
# count order, which for a one-letter query is slower than what this does now.
#
# So the scan stays. What matters is that it does not run on the event loop.
def _search_tags(query, limit):
    all_tags = get_tag_data()

    results = []
    seen_tags = set()

    for tag in all_tags:
        if len(results) >= limit:
            break

        tag_name = tag.get('name')
        if not tag_name or tag_name in seen_tags:
            continue

        # Check for matches
        match_found = False
        if query in tag_name:
            match_found = True
        
        if not match_found:
            for alias in tag.get('aliases', []):
                if query in alias:
                    match_found = True
                    break
        
        if match_found:
            results.append(tag)
            seen_tags.add(tag_name)

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

    # In a thread, like every other route in this pack that touches the disk or
    # walks a large structure. Inline, the first search after a restart froze the
    # whole ComfyUI server for the length of the CSV parse - websockets, progress
    # and queue included - and each miss added ~50ms more. That reads as a stutter
    # somewhere else entirely, never as "autocomplete is slow".
    #
    # Measured on the merged danbooru+e621 file (322k tags), worst loop stall:
    #   cold parse   351ms inline -> 114ms threaded
    #   scan, 0 hits  36ms inline ->  11ms threaded
    #   typical query   under a millisecond either way
    #
    # Threaded is not free, and it is worth knowing why: this is pure Python, so
    # the worker holds the GIL and only yields it every `sys.getswitchinterval()`
    # (5ms by default), and the loop has to wait its turn each time. A thread
    # turns one long freeze into a series of short ones - it does not remove
    # them. Making the cold parse disappear entirely would mean warming the cache
    # at startup instead of on the first keystroke.
    try:
        results = await asyncio.to_thread(_search_tags, query, limit)
    except Exception as e:
        print(f"[EreNodes] search_tags failed: {e}")
        return web.json_response([])
    return web.json_response(results)

