import os
import csv
import re
import server
from aiohttp import web

from .settings import get_erenodes_settings

# Define constants for export
CSV_FILES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "__autocomplete__")
DEFAULT_ENCODING = 'utf-8'
TAG_TYPES = {
    0: "General",
    1: "Character",
    3: "Copyright",
    4: "Artist",
    5: "Meta"
}

TAG_DATA_CACHE = {}

def load_tags_from_csv(csv_path):
    tags = []
    if csv_path and os.path.isfile(csv_path):
        try:
            with open(csv_path, newline='', encoding='utf-8') as csvfile:
                reader = csv.reader(csvfile)
                for row in reader:
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
        except Exception as e:
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
    limit = int(request.query.get("limit", 10))

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

