#!/usr/bin/env python3
# Build EreNodes tag groups from the animadex.net character catalogue.
#
# Downloads characters.csv and the WebP thumbnails using an export token, then
# writes one tag group per character:
#
#     <out>/Characters/<Series>/<Character>.json     the tags
#     <out>/Characters/<Series>/<Character>.webp     the cover
#
# EreNodes serves a cover from `<group>.webp` sitting beside `<group>.json`, so
# no extra step is needed for thumbnails to show up in the sidebar.
#
# Standalone: nothing in the extension loads, imports or calls this. Run it by
# hand, with your own Python, when you want a large character library in one go.
# See scripts/README.md for the walkthrough; --help for the flags.
#
# Usage:
#     python animadex_to_tag_groups.py --token YOUR_TOKEN --out ... --dry-run --limit 20
#     python animadex_to_tag_groups.py --token YOUR_TOKEN --out "C:/.../models/tag_groups"
#
# The token can also come from ANIMADEX_IMPORT_TOKEN, which keeps it out of your
# shell history. Re-running is cheap: files already on disk are skipped, so an
# interrupted run resumes where it stopped and a later run adds whatever the
# catalogue has gained.
#
# By default it only ever adds, and that default matters: a tag group is an
# editable file the user owns - they remove tags, add their own, put a LoRA in -
# and it is also an *input to a saved workflow*. Rewriting one behind its existing
# name discards that editing with no undo, and makes a workflow that ran last week
# produce a different image today.
#
# --overwrite opts out, for when the catalogue's current tags are what you want.
# Optional, off unless asked for, and it reaches every group in the run - so
# --dry-run --overwrite first to see the count. Covers stay add-only either way.
#
# To rebuild a few characters instead, delete their .json (and .webp, for a fresh
# cover) and run again: that touches only what you picked.
#
# Covers are stored at AnimaDex's own 445px width. EreNodes only downscales a
# cover wider than PREVIEW_WIDTH (480), so these pass through untouched.

from __future__ import annotations

import argparse
import csv
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
USER_AGENT = "erenodes-tag-group-import/1"

# A full run is tens of thousands of requests, so a single blip must not turn into
# a permanently missing cover. These statuses mean "busy, or something transient" -
# anything else (401, 403, 404) is an answer, not a hiccup, and is not retried.
RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
MAX_ATTEMPTS = 4
MAX_BACKOFF = 30.0

# Windows forbids these characters outright and treats these stems as devices.
BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"CON", "PRN", "AUX", "NUL",
            *(f"COM{i}" for i in range(1, 10)),
            *(f"LPT{i}" for i in range(1, 10))}


# Seconds to wait before attempt `n`. Honours Retry-After when the server sends a
# plain number of seconds; otherwise exponential, with jitter so that eight worker
# threads throttled at the same moment do not all come back at the same moment.
#
# The jitter is taken out of the delay, not added on top of it: multiplying a
# capped delay by up to 1.5x would put the result past MAX_BACKOFF, which makes
# the cap a suggestion rather than a bound. Half fixed, half random keeps every
# wait inside [delay/2, delay] and still spreads the retries.
def backoff(attempt, retry_after=None):
    if retry_after:
        try:
            return min(float(retry_after), 60.0)
        except (TypeError, ValueError):
            pass  # Retry-After can also be an HTTP date; fall through to the delay below.
    delay = min(2.0 ** attempt, MAX_BACKOFF)
    return delay / 2 + random.random() * delay / 2


def http_get(url, headers=None, timeout=60, attempts=MAX_ATTEMPTS, retry_status=RETRY_STATUS):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in retry_status or attempt == attempts - 1:
                raise
            time.sleep(backoff(attempt, e.headers.get("Retry-After")))
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            # A dropped connection or a read timeout, which is exactly what a long
            # run over a domestic link produces every few thousand requests.
            if attempt == attempts - 1:
                raise
            time.sleep(backoff(attempt))


# AnimaDex's own rule, used to rebuild the filename a thumbnail has on their CDN.
def remote_name(text):
    return BAD_CHARS.sub("_", (text or "").strip()).rstrip(". ")


# Stricter, for names we write locally: also dodges the Windows device names.
def safe_name(text, fallback="unnamed"):
    name = remote_name(text)
    if name.upper() in RESERVED:
        name = "_" + name
    return name[:120] or fallback


# Title-case for display, leaving punctuation and inner capitals alone.
# "hatsune miku" -> "Hatsune Miku", "re:zero kara hajimeru" -> "Re:Zero Kara Hajimeru".
def pretty(text):
    def cap(match):
        word = match.group(0)
        return word if word[:1].isupper() else word[:1].upper() + word[1:]
    return re.sub(r"[A-Za-z0-9']+", cap, (text or "").replace("_", " ").strip())


# AnimaDex names its image files after the trigger, sanitised its way.
def thumb_filename(trigger, slug):
    return remote_name(trigger or slug) + ".webp"


# Split a comma-separated danbooru list into clean tag names.
def split_tags(text):
    return [t.strip() for t in (text or "").split(",") if t.strip()]


# One EreNodes tag pill. Plain tags only, all enabled, matching what the node writes.
def pill(name):
    return {"name": name, "type": "tag", "active": True}


# The tag list for one character: its trigger (name + series) then its core tags.
def build_tags(row):
    names = split_tags(row.get("trigger")) or [(row.get("character") or "").replace("_", " ")]
    tags, seen = [], set()
    for name in names + split_tags(row.get("core_tags")):
        key = name.lower()
        if key in seen:
            continue
        seen.add(key)
        tags.append(pill(name))
    return tags


def fetch_manifest(token):
    # No `?full=1`: the manifest hands over the same complete CSV either way, and
    # a full pull is rate-limited to once per 48h. This leaves that allowance alone.
    try:
        # 503 here means "the export has not been published yet", which is a state
        # of the world rather than a hiccup - retrying it just delays the message.
        return json.loads(http_get(SITE + "/api/export/manifest",
                                   {"X-Export-Token": token},
                                   retry_status=RETRY_STATUS - {503}).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 401:
            sys.exit(f"Token rejected. Generate a fresh one at {SITE}/account.")
        if e.code == 503:
            sys.exit("The site has not published the catalogue export yet. Try later.")
        raise


# Written to a .part file and renamed, so an interrupted run never leaves a
# truncated .webp that the next run would see as already downloaded.
def download(url, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    data = http_get(url, timeout=120)
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    return len(data)


# Decide the folder for every character, folding thin series into `Others`.
def plan_folders(rows, min_series, display):
    per_series = Counter(row.get("copyright") or "" for row in rows)
    folder_of = {}
    for series, count in per_series.items():
        folder_of[series] = display(series) if series and count >= min_series else "Others"
    return folder_of


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build EreNodes tag groups from animadex.net.")
    ap.add_argument("--token", default=os.environ.get("ANIMADEX_IMPORT_TOKEN"),
                    help="Export token, or set ANIMADEX_IMPORT_TOKEN.")
    ap.add_argument("--out", required=True,
                    help="Tag groups root, e.g. ComfyUI/models/tag_groups")
    ap.add_argument("--top", default="Characters",
                    help="Folder created under --out (default: Characters).")
    ap.add_argument("--min-series", type=int, default=3,
                    help="A series needs this many characters for its own folder (default: 3).")
    ap.add_argument("--no-covers", action="store_true", help="Write the JSON only.")
    ap.add_argument("--overwrite", action="store_true",
                    help="Rewrite tag groups that already exist, discarding any edits made to "
                         "them. Off by default and worth leaving off - see the notes at the top "
                         "of this file. Covers are unaffected: delete a .webp to refetch it.")
    ap.add_argument("--keep-case", action="store_true",
                    help="Keep danbooru's lowercase names for files and folders.")
    ap.add_argument("--limit", type=int, help="Only process the first N characters.")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--csv", help="Use a local characters.csv instead of downloading.")
    ap.add_argument("--dry-run", action="store_true", help="Report the plan, write nothing.")
    args = ap.parse_args(argv)

    display = (lambda s: (s or "").replace("_", " ").strip()) if args.keep_case else pretty

    if args.csv:
        rows = list(csv.DictReader(io.StringIO(Path(args.csv).read_text(encoding="utf-8"))))
        prefixes = r2 = None
        print(f"Read {len(rows):,} characters from {args.csv}")
        # The thumbnail URLs are only in the manifest, never in the CSV, so a local
        # CSV alone cannot produce covers. With a token it can: fetch the manifest
        # for the bucket prefixes and nothing else. Without one, say so plainly -
        # this used to write no images at all and never mention it.
        if not args.no_covers:
            if args.token:
                manifest = fetch_manifest(args.token)
                r2 = manifest["r2_base"].rstrip("/")
                prefixes = manifest["prefixes"]
                print(f"Cover URLs from catalogue version {manifest['version']}")
            else:
                print("  No token given, so covers will be skipped: their URLs live in the\n"
                      "  manifest, not in the CSV. Add --token to fetch them, or --no-covers\n"
                      "  to make skipping them explicit.")
    else:
        if not args.token:
            ap.error("a token is required (--token or ANIMADEX_IMPORT_TOKEN)")
        print(f"Contacting {SITE} ...")
        manifest = fetch_manifest(args.token)
        r2 = manifest["r2_base"].rstrip("/")
        prefixes = manifest["prefixes"]
        print(f"Catalogue version {manifest['version']}")
        body = http_get(manifest["csv"]["characters"]).decode("utf-8")
        rows = list(csv.DictReader(io.StringIO(body)))
        print(f"Downloaded {len(rows):,} characters")

    rows = [r for r in rows if (r.get("character") or "").strip()]
    if args.limit:
        rows = rows[:args.limit]

    if args.overwrite and not args.dry_run:
        print("  --overwrite: existing tag groups will be rewritten from the catalogue.\n"
              "  Edits you made to them (added tags, LoRAs) will be lost, and a saved\n"
              "  workflow using one may produce a different result than it did before.")

    folder_of = plan_folders(rows, args.min_series, display)
    root = Path(args.out) / args.top

    # Two characters can sanitise to the same filename, and two series can sanitise
    # to the same folder. The tally is kept against the *sanitised* names, because
    # those are what actually collide on disk - and case-insensitively, because on
    # Windows and macOS they do.
    used = defaultdict(set)
    jobs, written, updated, skipped = [], 0, 0, 0

    for row in rows:
        folder = safe_name(folder_of.get(row.get("copyright") or "", "Others"),
                           fallback="Others")
        triggers = split_tags(row.get("trigger"))
        base = safe_name(display(triggers[0] if triggers else row.get("character")),
                         fallback=safe_name(row.get("character")))
        stem = base
        # The danbooru name is unique, so it is the first thing to disambiguate
        # with; the counter after it covers the case where even that collides once
        # sanitised. Every candidate goes back through safe_name - the raw name can
        # carry characters no filesystem accepts, and appending it used to skip that.
        if stem.lower() in used[folder]:
            stem = safe_name(f"{base} ({display(row.get('character'))})", fallback=base)
        suffix = 2
        while stem.lower() in used[folder]:
            stem = safe_name(f"{base} ({suffix})", fallback=base)
            suffix += 1
        used[folder].add(stem.lower())

        target = root / folder / f"{stem}.json"
        exists = target.exists()
        if exists and not args.overwrite:
            skipped += 1
        else:
            if not args.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(build_tags(row), indent=2, ensure_ascii=False),
                                  encoding="utf-8")
            # Counted either way, so --dry-run can report what a run would do - which
            # is the whole reason to have it before an --overwrite.
            if exists:
                updated += 1
            else:
                written += 1

        if not args.no_covers and prefixes:
            cover = target.with_suffix(".webp")
            # Covers are add-only even under --overwrite: refetching tens of thousands
            # of images to replace them with the same bytes is hours of transfer for
            # nothing. Delete a .webp to have it fetched again.
            if not cover.exists():
                jobs.append((f"{r2}/{prefixes['char_thumb']}/"
                             f"{quote(thumb_filename(row.get('trigger'), row['character']), safe='()')}",
                             cover))

    series_count = len({f for f in folder_of.values() if f != "Others"})
    others = sum(1 for r in rows if folder_of.get(r.get("copyright") or "") == "Others")
    print(f"  {len(rows):,} characters across {series_count:,} series folders "
          f"(+{others:,} in Others)")
    print(f"  tag groups: {written:,} new, {updated:,} rewritten, {skipped:,} left alone")
    print(f"  covers to download: {len(jobs):,}")
    if updated and not args.dry_run:
        print(f"  --overwrite rewrote {updated:,} existing tag group(s); any edits to them are gone.")

    if args.dry_run:
        if jobs:
            print(f"  e.g. {jobs[0][0]}\n       -> {jobs[0][1]}")
        print("\nDry run - nothing written.")
        return

    if jobs:
        done = fail = 0
        with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
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
                except Exception as e:                        # noqa: BLE001
                    fail += 1
                    print(f"  ! {futures[fut]} -> {e}")
                if i % 500 == 0 or i == len(jobs):
                    print(f"  covers {done:,}/{len(jobs):,} ({fail} skipped)")

    print(f"\nDone. Point EreNodes at this folder with "
          f"Settings -> EreNodes -> Tag Groups Folder -> 'ComfyUI models/tag_groups'.")


if __name__ == "__main__":
    main()
