# The Booru sidebar tab's server side: searches Safebooru (safebooru.org), Gelbooru and e621, and relays the first two's thumbnails.
# On the server because neither Safebooru nor Gelbooru answers browsers with CORS headers, and Gelbooru serves images only to requests carrying its own Referer; e621 uses the same route so all three behave alike.
# Outbound requests go only to the hosts named in SOURCES and RELAY_HOSTS, over https; nothing is written to disk.

import asyncio
import html
import json
import os
from urllib.parse import urlsplit

import aiohttp
import server
from aiohttp import web

from .prompt_csv import meta_tag_names

PAGE = 60
def _version():
    try:
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pyproject.toml"), encoding="utf-8") as f:
            return next((line.split("=", 1)[1].strip().strip('"') for line in f if line.startswith("version")), "0")
    except OSError:
        return "0"


USER_AGENT = f"EreNodes/{_version()}"
TIMEOUT = aiohttp.ClientTimeout(total=20)
MAX_IMAGE_BYTES = 8 * 1024 * 1024
# Image hosts relayed for the browser, with the Referer each needs. e621's show in the browser directly and are relayed only when a cover is saved from one, since the browser cannot read their bytes.
RELAY_HOSTS = {"gelbooru.com": "https://gelbooru.com/", "safebooru.org": None, "e621.net": None}
# A grid page asks for 60 thumbnails at once; Gelbooru allows 10 requests a second per account.
_IMAGE_SLOTS = asyncio.Semaphore(6)

_session = None


def _client():
    global _session
    if _session is None or _session.closed:
        _session = aiohttp.ClientSession(timeout=TIMEOUT, headers={"User-Agent": USER_AGENT})
    return _session


def _names(text):
    return [name for name in (text or "").split(" ") if name]


def _tags(names, category):
    return [{"name": name.replace("_", " "), "category": category} for name in names]


# Ratings shown, per site, from the sidebar setting. Safebooru holds only safe posts; e621 has no sensitive level.
def _rating_terms(site, level):
    if level == "all" or site == "safebooru":
        return []
    if site == "e621":
        return ["-rating:e"] if level == "questionable" else ["rating:s"]
    return {"general": ["rating:general"], "questionable": ["-rating:explicit"]}.get(level, ["-rating:questionable", "-rating:explicit"])


# The blocked-tags setting as negated search terms, so posts carrying them never load. Same comma-separated, underscored form as the search box.
def _blocked_terms(blocked):
    return [f"-{tag}" for tag in (t.strip().replace(" ", "_") for t in str(blocked or "").split(",")) if tag and not tag.startswith("-")]


# Order of results, per site. Latest is each site's default.
def _sort_terms(site, sort):
    if site == "e621":
        return {"top": ["order:score"], "random": ["order:random"]}.get(sort, [])
    return {"top": ["sort:score:desc"], "random": ["sort:random"]}.get(sort, [])


def _size(width, height):
    try:
        return {"width": int(width), "height": int(height)}
    except (TypeError, ValueError):
        return {}


def _safebooru(data):
    rows = data if isinstance(data, list) else []
    posts = []
    for p in rows:
        if not p.get("id") or not p.get("preview_url"):
            continue
        posts.append({
            "id": p["id"],
            "thumb": p["preview_url"],
            "thumbLarge": p.get("sample_url") or p.get("file_url") or p["preview_url"],
            "relay": True,
            **_size(p.get("width"), p.get("height")),
            "page": f"https://safebooru.org/index.php?page=post&s=view&id={p['id']}",
            # Uncategorised, like Gelbooru's, and possibly HTML-escaped the same way.
            "tags": _tags(_names(html.unescape(p.get("tags") or "")), "general"),
        })
    return posts, len(rows) >= PAGE


def _gelbooru(data):
    data = data if isinstance(data, dict) else {}
    rows = data.get("post") or []
    attrs = data.get("@attributes") or {}
    posts = []
    for p in rows:
        if not p.get("id") or not p.get("preview_url"):
            continue
        posts.append({
            "id": p["id"],
            "thumb": p["preview_url"],
            "thumbLarge": p.get("sample_url") or p["preview_url"],
            "relay": True,
            **_size(p.get("width"), p.get("height")),
            "page": f"https://gelbooru.com/index.php?page=post&s=view&id={p['id']}",
            # Gelbooru sends tags HTML-escaped (`&#039;`) and without categories.
            "tags": _tags(_names(html.unescape(p.get("tags") or "")), "general"),
        })
    try:
        more = int(attrs.get("offset", 0)) + len(rows) < int(attrs.get("count", 0))
    except (TypeError, ValueError):
        more = len(rows) >= PAGE
    return posts, more


def _e621(data):
    rows = (data or {}).get("posts") or [] if isinstance(data, dict) else []
    posts = []
    for p in rows:
        preview = (p.get("preview") or {}).get("url")
        # Posts hidden from anonymous users come back with no preview URL.
        if not p.get("id") or not preview:
            continue
        tags = p.get("tags") or {}
        posts.append({
            "id": p["id"],
            "thumb": preview,
            "thumbLarge": (p.get("sample") or {}).get("url") or preview,
            **_size((p.get("file") or {}).get("width"), (p.get("file") or {}).get("height")),
            "page": f"https://e621.net/posts/{p['id']}",
            # Lore, meta and invalid tags are left out.
            "tags": _tags(tags.get("character"), "character") + _tags(tags.get("species"), "species")
            + _tags(tags.get("copyright"), "copyright") + _tags(tags.get("artist"), "artist")
            + _tags(tags.get("general"), "general"),
        })
    return posts, len(rows) >= PAGE


SOURCES = {
    "safebooru": {
        "label": "Safebooru",
        "request": lambda tags, page, body: ("https://safebooru.org/index.php", {"page": "dapi", "s": "post", "q": "index", "json": 1, "limit": PAGE, "pid": page - 1, "tags": tags}),
        "parse": _safebooru,
    },
    "gelbooru": {
        "label": "Gelbooru",
        "request": lambda tags, page, body: ("https://gelbooru.com/index.php", {
            "page": "dapi", "s": "post", "q": "index", "json": 1, "limit": PAGE, "pid": page - 1, "tags": tags,
            "user_id": str(body.get("userId") or "").strip(), "api_key": str(body.get("apiKey") or "").strip(),
        }),
        "parse": _gelbooru,
    },
    "e621": {
        "label": "e621",
        "request": lambda tags, page, body: ("https://e621.net/posts.json", {"tags": tags, "page": page, "limit": PAGE}),
        "parse": _e621,
    },
}


# The site's own explanation of a refusal, which e621 gives in `reason` or `message`.
def _refusal(site, status, data):
    if isinstance(data, dict):
        message = data.get("message") or data.get("reason")
        if message:
            return str(message)
    if site == "gelbooru" and status in (401, 403):
        return "Gelbooru rejected the user ID or API key. Check them in Settings → EreNodes → Sidebar."
    return f"{SOURCES[site]['label']} answered {status}."


@server.PromptServer.instance.routes.post("/erenodes/booru/search")
async def booru_search(request):
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        return web.json_response({"error": "Bad request."}, status=400)
    site = body.get("site")
    source = SOURCES.get(site)
    if source is None:
        return web.json_response({"error": f"Unknown source: {site}"}, status=400)
    if site == "gelbooru" and not (str(body.get("userId") or "").strip() and str(body.get("apiKey") or "").strip()):
        return web.json_response({"error": "Gelbooru needs an account's user ID and API key: Settings → EreNodes → Sidebar. Both are on gelbooru.com under My Account → Options."})
    try:
        page = max(1, int(body.get("page") or 1))
    except (TypeError, ValueError):
        page = 1

    tags = " ".join([str(body.get("tags") or "").strip(), *_rating_terms(site, body.get("rating")), *_sort_terms(site, body.get("sort")), *_blocked_terms(body.get("blocked"))]).strip()
    url, params = source["request"](tags, page, body)
    try:
        # Gelbooru hides part of its catalogue until a visitor opts in, which the site records as this cookie; the setting is the user's opt-in.
        cookies = {"fringeBenefits": "yup"} if site == "gelbooru" and body.get("allContent") else None
        async with _client().get(url, params=params, cookies=cookies) as response:
            status = response.status
            text = await response.text()
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        print(f"[EreNodes] Booru search on {site} failed: {e}")
        return web.json_response({"error": f"{source['label']} could not be reached."})

    try:
        data = json.loads(text) if text else None
    except ValueError:
        data = None
    if status != 200:
        return web.json_response({"error": _refusal(site, status, data)})
    posts, more = source["parse"](data)
    # Gelbooru and Safebooru send no tag categories, so meta tags are recognised through the autocomplete CSV, which has them. e621's are left out while parsing.
    if site != "e621":
        meta = await asyncio.to_thread(meta_tag_names)
        for post in posts:
            post["tags"] = [tag for tag in post["tags"] if tag["name"].lower() not in meta]
    return web.json_response({"posts": posts, "more": more})


# The relayed site a URL belongs to, or None when it is not one of them or not https.
def _relay_site(url):
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https":
        return None
    return next((site for site in RELAY_HOSTS if host == site or host.endswith("." + site)), None)


@server.PromptServer.instance.routes.get("/erenodes/booru/image")
async def booru_image(request):
    url = request.query.get("url", "")
    site = _relay_site(url)
    if site is None:
        return web.Response(status=400)
    # Without its own Referer, Gelbooru redirects an image request to the post's HTML page.
    referer = RELAY_HOSTS[site]
    try:
        async with _IMAGE_SLOTS:
            async with _client().get(url, headers={"Referer": referer} if referer else None, allow_redirects=False) as response:
                if response.status != 200 or not response.content_type.startswith("image/"):
                    return web.Response(status=502)
                # Read to the end in chunks: a single read returns only what has arrived so far, which cut images off partway.
                chunks, size = [], 0
                async for chunk in response.content.iter_chunked(256 * 1024):
                    size += len(chunk)
                    if size > MAX_IMAGE_BYTES:
                        return web.Response(status=502)
                    chunks.append(chunk)
                content_type = response.content_type
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return web.Response(status=502)
    return web.Response(body=b"".join(chunks), content_type=content_type, headers={"Cache-Control": "public, max-age=86400"})


if __name__ == "__main__":
    assert _rating_terms("e621", "sensitive") == ["rating:s"]
    assert _rating_terms("e621", "questionable") == ["-rating:e"]
    assert _rating_terms("gelbooru", "sensitive") == ["-rating:questionable", "-rating:explicit"]
    assert _rating_terms("gelbooru", "all") == [] and _rating_terms("safebooru", "general") == []
    assert _sort_terms("e621", "top") == ["order:score"] and _sort_terms("gelbooru", "random") == ["sort:random"] and _sort_terms("safebooru", "latest") == []
    assert _size("700", 990) == {"width": 700, "height": 990} and _size(None, 5) == {}
    assert _blocked_terms(" male focus, , text,-bad ") == ["-male_focus", "-text"] and _blocked_terms(None) == []
    posts, more = _safebooru([{"id": 2, "preview_url": "https://safebooru.org/t.jpg", "sample_url": "", "file_url": "https://safebooru.org/f.png", "tags": "blue_hair 1girl"}])
    assert posts[0]["thumbLarge"] == "https://safebooru.org/f.png" and [t["name"] for t in posts[0]["tags"]] == ["blue hair", "1girl"] and not more
    assert _relay_site("https://img4.gelbooru.com/thumbnails/a.jpg") == "gelbooru.com"
    assert _relay_site("https://safebooru.org/thumbnails/1/a.jpg") == "safebooru.org"
    assert _relay_site("https://static1.e621.net/data/sample/a.jpg") == "e621.net"
    assert _relay_site("http://img4.gelbooru.com/a.jpg") is None
    assert _relay_site("https://evilgelbooru.com/a.jpg") is None
    assert _relay_site("https://gelbooru.com.evil.net/a.jpg") is None
    posts, more = _gelbooru({"@attributes": {"offset": 0, "count": 61}, "post": [{"id": 1, "preview_url": "https://img4.gelbooru.com/t.jpg", "tags": "rem_(re:zero) l&#039;arc"}]})
    assert posts[0]["tags"] == [{"name": "rem (re:zero)", "category": "general"}, {"name": "l'arc", "category": "general"}] and more
    print("booru self-check ok")
