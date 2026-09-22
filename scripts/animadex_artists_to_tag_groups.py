#!/usr/bin/env python3
# Build EreNodes tag groups from the animadex.net artist catalogue.
#
# Downloads artists.csv and the WebP thumbnails using an export token, then writes one tag group per artist:
#
#     <out>/Artists/<A>/<Artist>.json     the tag
#     <out>/Artists/<A>/<Artist>.webp     the cover
#
# The companion to animadex_to_tag_groups.py, which does the same for characters. Same token, same manifest, same flags.
#
# Standalone: nothing in the extension loads, imports or calls this. Run it by hand, with your own Python.
# See scripts/README.md for the walkthrough; --help for the flags.
#
# Usage:
#     python animadex_artists_to_tag_groups.py --token YOUR_TOKEN --out ... --dry-run --limit 20
#     python animadex_artists_to_tag_groups.py --token YOUR_TOKEN --out "C:/.../models/tag_groups"
#
# The token can also come from ANIMADEX_IMPORT_TOKEN. Re-running is cheap: files already on disk are skipped.
#
# By default it only ever adds. A tag group is an editable file the user owns, and also an input to a saved workflow,
# so rewriting one behind its existing name discards edits with no undo and changes what an old workflow produces.
# --overwrite opts out, reaches every group in the run, and is worth a --dry-run --overwrite first. Covers stay add-only.

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
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

SITE = "https://animadex.net"
USER_AGENT = "erenodes-tag-group-import/1"

# Busy, or transient. Anything else (401, 403, 404) is an answer rather than a hiccup, and is not retried.
RETRY_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})
MAX_ATTEMPTS = 4
MAX_BACKOFF = 30.0

# Windows forbids these characters outright and treats these stems as devices.
BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}

# The manifest is the site's, not ours, so a renamed key is reported rather than guessed at.
CSV_KEYS = ("artists", "artist")
THUMB_KEYS = ("artist_thumb", "artists_thumb", "artist_thumbs")


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
            if attempt == attempts - 1:
                raise
            time.sleep(backoff(attempt))


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


# The artist as you would prompt it: `trigger` when the catalogue has one, else the slug.
def artist_name(row):
    return (row.get("trigger") or "").strip() or (row.get("artist") or "").replace("_", " ").strip()


# One tag group, one pill. An artist row carries no tag list of its own, unlike a character.
def build_tags(row):
    # artist_name itself must keep its underscores: the CDN cover filename is built from it.
    return [{"name": artist_name(row).replace("_", " "), "type": "tag", "active": True}]


# First letter, so the sidebar is not one folder of many thousands. Digits and symbols share `#`.
def bucket_of(row):
    first = artist_name(row)[:1].upper()
    return first if first.isalpha() else "#"


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


def pick(mapping, names, what):
    for name in names:
        if mapping.get(name):
            return mapping[name]
    sys.exit(f"The manifest has no {what}. It offers: {', '.join(sorted(mapping)) or '(nothing)'}")


# Written to a .part file and renamed, so an interrupted run never leaves a truncated .webp that the next run sees as done.
def download(url, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    data = http_get(url, timeout=120)
    tmp.write_bytes(data)
    os.replace(tmp, dest)
    return len(data)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build EreNodes tag groups from the animadex.net artist catalogue.")
    ap.add_argument("--token", default=os.environ.get("ANIMADEX_IMPORT_TOKEN"), help="Export token, or set ANIMADEX_IMPORT_TOKEN.")
    ap.add_argument("--out", required=True, help="Tag groups root, e.g. ComfyUI/models/tag_groups")
    ap.add_argument("--top", default="Artists", help="Folder created under --out (default: Artists).")
    ap.add_argument("--group-by", choices=("initial", "none"), default="initial", help="Subfolder per first letter (default), or all in one folder.")
    ap.add_argument("--min-count", type=int, default=0, help="Skip artists below this popularity count (default: 0, keep all).")
    ap.add_argument("--no-covers", action="store_true", help="Write the JSON only.")
    ap.add_argument("--overwrite", action="store_true", help="Rewrite tag groups that already exist, discarding any edits made to them. Covers are unaffected: delete a .webp to refetch it.")
    ap.add_argument("--keep-case", action="store_true", help="Keep danbooru's lowercase names for files and folders.")
    ap.add_argument("--limit", type=int, help="Only process the first N artists.")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--csv", help="Use a local artists.csv instead of downloading.")
    ap.add_argument("--dry-run", action="store_true", help="Report the plan, write nothing.")
    args = ap.parse_args(argv)

    display = (lambda s: (s or "").replace("_", " ").strip()) if args.keep_case else pretty

    if args.csv:
        rows = list(csv.DictReader(io.StringIO(Path(args.csv).read_text(encoding="utf-8"))))
        prefix = r2 = None
        print(f"Read {len(rows):,} artists from {args.csv}")
        # Thumbnail URLs live in the manifest, never in the CSV, so a local CSV alone cannot produce covers.
        if not args.no_covers:
            if args.token:
                manifest = fetch_manifest(args.token)
                r2 = manifest["r2_base"].rstrip("/")
                prefix = pick(manifest["prefixes"], THUMB_KEYS, "artist thumbnail prefix")
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
        prefix = pick(manifest["prefixes"], THUMB_KEYS, "artist thumbnail prefix")
        print(f"Catalogue version {manifest['version']}")
        body = http_get(pick(manifest["csv"], CSV_KEYS, "artists CSV")).decode("utf-8")
        rows = list(csv.DictReader(io.StringIO(body)))
        print(f"Downloaded {len(rows):,} artists")

    rows = [r for r in rows if artist_name(r)]
    if args.min_count:
        def count_of(row):
            try:
                return int(float(row.get("count") or 0))
            except (TypeError, ValueError):
                return 0
        before = len(rows)
        rows = [r for r in rows if count_of(r) >= args.min_count]
        print(f"  {before - len(rows):,} below --min-count {args.min_count:,} skipped")
    if args.limit:
        rows = rows[:args.limit]

    if args.overwrite and not args.dry_run:
        print("  --overwrite: existing tag groups will be rewritten from the catalogue.\n"
              "  Edits you made to them (added tags, LoRAs) will be lost, and a saved\n"
              "  workflow using one may produce a different result than it did before.")

    root = Path(args.out) / args.top

    # Two artists can sanitise to the same filename. Tallied against the sanitised name, case-insensitively, because that is what collides on disk.
    used = defaultdict(set)
    jobs, written, updated, skipped = [], 0, 0, 0

    for row in rows:
        folder = safe_name(bucket_of(row), fallback="#") if args.group_by == "initial" else ""
        base = safe_name(display(artist_name(row)), fallback=safe_name(row.get("artist")))
        stem = base
        # The slug is unique, so it disambiguates first; the counter covers a collision even after that.
        if stem.lower() in used[folder]:
            stem = safe_name(f"{base} ({display(row.get('artist'))})", fallback=base)
        suffix = 2
        while stem.lower() in used[folder]:
            stem = safe_name(f"{base} ({suffix})", fallback=base)
            suffix += 1
        used[folder].add(stem.lower())

        target = (root / folder / f"{stem}.json") if folder else (root / f"{stem}.json")
        exists = target.exists()
        if exists and not args.overwrite:
            skipped += 1
        else:
            if not args.dry_run:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(json.dumps(build_tags(row), indent=2, ensure_ascii=False), encoding="utf-8")
            # Counted either way, so --dry-run reports what a run would do.
            if exists:
                updated += 1
            else:
                written += 1

        if not args.no_covers and prefix:
            cover = target.with_suffix(".webp")
            # Add-only even under --overwrite: refetching thousands of images to replace them with the same bytes is hours for nothing.
            if not cover.exists():
                jobs.append((f"{r2}/{prefix}/{quote(remote_name(artist_name(row)) + '.webp', safe='()')}", cover))

    folders = len(used) if args.group_by == "initial" else 1
    print(f"  {len(rows):,} artists across {folders:,} folder(s)")
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

    print(f"\nDone. Point EreNodes at this folder with Settings -> EreNodes -> Tag Groups Folder.")


if __name__ == "__main__":
    main()
