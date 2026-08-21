import os
import csv
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

TAG_DATA_CACHE = {}

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

def get_tag_data():
    settings = get_erenodes_settings()
    active_csv = settings.get('autocomplete.csv')

    if not active_csv:
        return []

    if active_csv in TAG_DATA_CACHE:
        return TAG_DATA_CACHE[active_csv]

    base_dir = os.path.dirname(os.path.abspath(__file__))
    autocomplete_dir = os.path.join(base_dir, "..", "__autocomplete__")
    csv_path = os.path.join(autocomplete_dir, active_csv)

    tags = load_tags_from_csv(csv_path)
    TAG_DATA_CACHE[active_csv] = tags
    return tags

@server.PromptServer.instance.routes.get("/erenodes/search_tags")
async def search_tags(request):
    query = request.query.get("query", "").lower().strip().replace('_', ' ')
    try:
        limit = max(1, min(int(request.query.get("limit", 10)), 100))
    except (TypeError, ValueError):
        limit = 10

    if not query or len(query) < 1:
        return web.json_response([])

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
            
    return web.json_response(results)

