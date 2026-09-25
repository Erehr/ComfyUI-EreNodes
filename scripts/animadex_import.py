#!/usr/bin/env python3
# Build EreNodes tag groups from the animadex.net character and artist catalogues.
# Interactive: run it and answer the prompts. Standalone, standard library only; nothing in the extension imports it.
# See scripts/README.md for what it writes and why existing groups are left alone by default.

from __future__ import annotations

import csv
import getpass
import io
import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

SITE = "https://animadex.net"
USER_AGENT = "erenodes-tag-group-import/2"

# Busy, or transient. Anything else (401, 403, 404) is an answer rather than a hiccup, and is not retried.
RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
MAX_ATTEMPTS = 4
MAX_BACKOFF = 30.0
CONCURRENCY = 8
# A series needs this many characters for its own folder; thinner ones go to `Others`.
MIN_SERIES = 3

# Windows forbids these characters outright and treats these stems as devices.
BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

# <ComfyUI>/custom_nodes/ComfyUI-EreNodes/scripts/this.py, assuming the default ComfyUI layout.
# absolute(), not resolve(): a checkout symlinked into custom_nodes must keep the link's path.
NODE_DIR = Path(__file__).absolute().parents[1]
COMFY_DIR = NODE_DIR.parents[1]
LOCATIONS = {
    "user": COMFY_DIR / "user" / "__erenodes" / "tag_groups",
    "models": COMFY_DIR / "models" / "tag_groups",
    "node": NODE_DIR / "__prompts__",
}

def ask(prompt, default=""):
    value = input(f"{prompt} [{default}]: " if default else f"{prompt}: ").strip()
    return value or default

def confirm(prompt, default):
    while True:
        value = input(f"{prompt} [{'Y/n' if default else 'y/N'}]: ").strip().lower()
        if not value:
            return default
        if value in ("y", "yes", "n", "no"):
            return value.startswith("y")

def choose(prompt, options, default=1):
    print(prompt)
    for i, label in enumerate(options, 1):
        print(f"  {i}) {label}")
    while True:
        value = ask("Choice", str(default))
        if value.isdigit() and 1 <= int(value) <= len(options):
            return int(value) - 1

def ask_int(prompt, default):
    while True:
        value = ask(prompt, str(default))
        if value.isdigit():
            return int(value)

# The location EreNodes is set to, read from its settings file; "user" is what a fresh install resolves to.
def active_location():
    try:
        value = json.loads((COMFY_DIR / "user" / "__erenodes" / "settings.json").read_text(encoding="utf-8")).get("tag_groups.location")
        return value if value in LOCATIONS else "user"
    except (OSError, ValueError):
        return "user"

def ask_out_dir():
    keys = list(LOCATIONS) if NODE_DIR.parent.name == "custom_nodes" else []
    active = active_location()
    labels = [f"{LOCATIONS[k]}{'   (active in EreNodes)' if k == active else ''}" for k in keys] + ["Other folder..."]
    picked = choose("Tag groups folder:", labels, keys.index(active) + 1) if keys else 0
    if picked < len(keys):
        return LOCATIONS[keys[picked]]
    while True:
        path = ask("Tag groups folder path").strip('"')
        if path:
            return Path(path).expanduser()

def ask_token():
    while True:
        token = getpass.getpass(f"AnimaDex export token (from {SITE}/account, input hidden): ").strip()
        if token:
            return token

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

# The token request refuses redirects: urllib would forward X-Export-Token to whatever host the redirect names.
TOKEN_OPENER = urllib.request.build_opener(NoRedirect)

# Honours Retry-After when it is a plain number of seconds, otherwise exponential with jitter.
# The jitter comes out of the delay rather than on top, so MAX_BACKOFF stays a bound.
def backoff(attempt, retry_after=None):
    if retry_after:
        try:
            return min(float(retry_after), 60.0)
        except (TypeError, ValueError):
            pass  # Retry-After can also be an HTTP date.
    delay = min(2.0 ** attempt, MAX_BACKOFF)
    return delay / 2 + random.random() * delay / 2

# https only: the manifest supplies URLs, and urlopen would also accept file://.
def http_get(url, headers=None, timeout=60, retry_status=RETRY_STATUS):
    if not url.startswith("https://"):
        raise ValueError(f"refusing non-https URL {url!r}")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    opener = TOKEN_OPENER.open if headers else urllib.request.urlopen
    for attempt in range(MAX_ATTEMPTS):
        try:
            with opener(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in retry_status or attempt == MAX_ATTEMPTS - 1:
                raise
            time.sleep(backoff(attempt, e.headers.get("Retry-After")))
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            if attempt == MAX_ATTEMPTS - 1:
                raise
            time.sleep(backoff(attempt))

def fetch_manifest(token):
    # No `?full=1`: the manifest hands over the same complete CSV either way, and a full pull is rate-limited to once per 48h.
    try:
        # 503 here means the export has not been published yet, which is a state of the world rather than a hiccup.
        return json.loads(http_get(SITE + "/api/export/manifest", {"X-Export-Token": token}, retry_status=RETRY_STATUS - {503}).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit(f"Token rejected. Generate a fresh one at {SITE}/account.")
        if e.code == 503:
            sys.exit("The site has not published the catalogue export yet. Try later.")
        raise

# The manifest is the site's, not ours, so a renamed key is reported rather than guessed at.
def pick(mapping, names, what):
    for name in names:
        if mapping.get(name):
            return mapping[name]
    sys.exit(f"The manifest has no {what}. It offers: {', '.join(sorted(mapping)) or '(nothing)'}")

def fetch_rows(manifest, keys, what):
    body = http_get(pick(manifest["csv"], keys, f"{what} CSV")).decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(body)))
    print(f"Downloaded {len(rows):,} {what}")
    return rows

# Written to a .part file and renamed, so an interrupted run never leaves a truncated .webp that the next run sees as done.
def download(url, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    tmp.write_bytes(http_get(url, timeout=120))
    os.replace(tmp, dest)

# AnimaDex's own rule, used to rebuild the filename a thumbnail has on their CDN.
def remote_name(text):
    return BAD_CHARS.sub("_", (text or "").strip()).rstrip(". ")

# Stricter, for names we write locally: also dodges the Windows device names.
# A space, not remote_name's underscore: that rule builds AnimaDex's CDN filename, not ours.
def safe_name(text, fallback="unnamed"):
    name = re.sub(r"\s+", " ", BAD_CHARS.sub(" ", (text or "").replace("_", " "))).strip().rstrip(". ")
    if name.upper() in RESERVED:
        name = "_" + name
    return name[:120].rstrip(". ") or fallback

# Title-case for display, leaving punctuation and inner capitals alone.
def pretty(text):
    def cap(match):
        word = match.group(0)
        return word if word[:1].isupper() else word[:1].upper() + word[1:]
    return re.sub(r"[A-Za-z0-9']+", cap, (text or "").replace("_", " ").strip())

def split_tags(text):
    return [t.strip() for t in (text or "").split(",") if t.strip()]

def pill(name):
    return {"name": name, "type": "tag", "active": True}

# Trigger (name + series) then core tags, spaced: the catalogue stores booru form, anime checkpoints are trained on the spaced form.
def character_tags(row):
    names = split_tags(row.get("trigger")) or [row.get("character") or ""]
    tags, seen = [], set()
    for name in names + split_tags(row.get("core_tags")):
        name = name.replace("_", " ")
        if name.lower() not in seen:
            seen.add(name.lower())
            tags.append(pill(name))
    return tags

# The artist as you would prompt it: `trigger` when the catalogue has one, else the slug.
# Keeps its underscores, because the CDN cover filename is built from it.
def artist_name(row):
    return (row.get("trigger") or "").strip() or (row.get("artist") or "").replace("_", " ").strip()

def post_count(row):
    try:
        return int(float(row.get("count") or 0))
    except (TypeError, ValueError):
        return 0

# One (target, tags) write per row that needs one, and one (url, dest) download per missing cover.
# Stems are deduplicated case-insensitively against the sanitised name, because that is what collides on disk.
def plan(rows, root, folder_of, stem_of, slug_of, tags_of, cover_of, overwrite):
    used = defaultdict(set)
    writes, covers, counts = [], [], Counter()
    for row in rows:
        folder = folder_of(row)
        base = stem_of(row)
        stem = base
        # The slug is unique, so it disambiguates first; the counter covers a collision even after that.
        if stem.lower() in used[folder]:
            stem = safe_name(f"{base[:100]} ({pretty(slug_of(row))})", fallback=base)
        suffix = 2
        while stem.lower() in used[folder]:
            stem = f"{base[:100]} ({suffix})"
            suffix += 1
        used[folder].add(stem.lower())

        target = root / folder / f"{stem}.json"
        exists = target.exists()
        if exists and not overwrite:
            counts["kept"] += 1
        else:
            writes.append((target, tags_of(row)))
            counts["rewritten" if exists else "new"] += 1
        # Covers are add-only even under overwrite: delete a .webp to have it fetched again.
        cover = target.with_suffix(".webp")
        if cover_of and not cover.exists():
            covers.append((cover_of(row), cover))
    return writes, covers, counts

def plan_characters(manifest, out, opts):
    rows = [r for r in fetch_rows(manifest, ("characters",), "characters") if (r.get("character") or "").strip()]
    per_series = Counter(r.get("copyright") or "" for r in rows)
    folders = {s: safe_name(pretty(s), fallback="Others") if s and n >= MIN_SERIES else "Others" for s, n in per_series.items()}
    cover_of = None
    if opts["covers"]:
        base = f"{manifest['r2_base'].rstrip('/')}/{pick(manifest['prefixes'], ('char_thumb',), 'character thumbnail prefix')}"
        cover_of = lambda r: f"{base}/{quote(remote_name(r.get('trigger') or r['character']) + '.webp', safe='()')}"

    def stem_of(r):
        triggers = split_tags(r.get("trigger"))
        return safe_name(pretty(triggers[0] if triggers else r["character"]), fallback=safe_name(r["character"]))

    return plan(rows, out / "Characters", lambda r: folders[r.get("copyright") or ""], stem_of, lambda r: r["character"], character_tags, cover_of, opts["overwrite"])

def plan_artists(manifest, out, opts):
    rows = [r for r in fetch_rows(manifest, ("artists", "artist"), "artists") if artist_name(r)]
    if opts["min_count"]:
        before = len(rows)
        rows = [r for r in rows if post_count(r) >= opts["min_count"]]
        print(f"  {before - len(rows):,} artists below {opts['min_count']:,} posts skipped")
    cover_of = None
    if opts["covers"]:
        base = f"{manifest['r2_base'].rstrip('/')}/{pick(manifest['prefixes'], ('artist_thumb', 'artists_thumb', 'artist_thumbs'), 'artist thumbnail prefix')}"
        cover_of = lambda r: f"{base}/{quote(remote_name(artist_name(r)) + '.webp', safe='()')}"

    # Digits and symbols share `#`, so the sidebar is not one folder of many thousands.
    def folder_of(r):
        if not opts["by_initial"]:
            return ""
        first = artist_name(r)[:1].upper()
        return first if first.isalpha() else "#"

    # The @ goes on the tag only, never the filename; models like Anima expect artists as `@name`.
    def tags_of(r):
        name = artist_name(r).replace("_", " ")
        return [pill(f"@{name}" if opts["at_prefix"] and not name.startswith("@") else name)]

    stem_of = lambda r: safe_name(pretty(artist_name(r)), fallback=safe_name(r.get("artist")))
    return plan(rows, out / "Artists", folder_of, stem_of, lambda r: r.get("artist") or "", tags_of, cover_of, opts["overwrite"])

def download_covers(jobs):
    done = fail = 0
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as pool:
        futures = {pool.submit(download, url, dest): url for url, dest in jobs}
        for i, fut in enumerate(as_completed(futures), 1):
            try:
                fut.result()
                done += 1
            except urllib.error.HTTPError as e:
                fail += 1
                # A brand-new row may not have a thumbnail yet.
                if e.code != 404:
                    print(f"  ! {futures[fut]} -> HTTP {e.code}")
            except Exception as e:  # noqa: BLE001
                fail += 1
                print(f"  ! {futures[fut]} -> {e}")
            if i % 500 == 0 or i == len(jobs):
                print(f"  covers {done:,}/{len(jobs):,} ({fail} skipped)")

def main():
    print("EreNodes - AnimaDex tag group import\n")
    kinds = [("characters",), ("artists",), ("characters", "artists")][choose("Import:", ["Characters", "Artists", "Both"], 3)]
    out = ask_out_dir()
    opts = {"covers": confirm("Download cover images?", True), "at_prefix": False, "by_initial": True, "min_count": 0}
    if "artists" in kinds:
        opts["at_prefix"] = confirm("Prefix artist tags with @ (needed by Anima and similar models)?", False)
        opts["by_initial"] = confirm("Artists in a subfolder per first letter?", True)
        opts["min_count"] = ask_int("Skip artists with fewer posts than (0 keeps all)", 0)
    opts["overwrite"] = confirm("Overwrite tag groups that already exist? Edits made to them are lost", False)
    token = ask_token()

    print(f"\nContacting {SITE} ...")
    manifest = fetch_manifest(token)
    print(f"Catalogue version {manifest['version']}")

    planners = {"characters": plan_characters, "artists": plan_artists}
    writes, covers = [], []
    for kind in kinds:
        w, c, counts = planners[kind](manifest, out, opts)
        writes += w
        covers += c
        print(f"  {kind}: {counts['new']:,} new, {counts['rewritten']:,} rewritten, {counts['kept']:,} left alone, {len(c):,} covers to download")

    if not writes and not covers:
        print("\nNothing to do.")
        return
    print(f"\nTarget: {out}")
    if not confirm(f"Write {len(writes):,} tag group(s) and download {len(covers):,} cover(s)?", True):
        print("Nothing written.")
        return

    for target, tags in writes:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(tags, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(writes):,} tag group(s).")
    if covers:
        download_covers(covers)
    print("\nDone. Make sure Settings -> EreNodes -> Tag Groups Folder points at the folder above.")

if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.")
