# Deep tag search index: a SQLite cache of the tags inside every group, built once, kept current incrementally and queried in milliseconds.
# It lives at `<tag groups root>/.erenodes_tag_index.db`, so it follows the `tag_groups.location` setting and the leading dot keeps it out of every listing route.
# `groups(id, path, mtime, size)` is the freshness stamp; tag strings are interned once in `names(id, tag)`, and `tags(tid, gid)` is WITHOUT ROWID with PRIMARY KEY(tid, gid), so a prefix range over `names` resolves to index-only scans of integers.

from array import array
import json
import os
import re
import sqlite3
import threading
import time

from .paths import excluded, get_prompts_dir, tree_signature, dir_key

DB_NAME = ".erenodes_tag_index.db"

MAX_GROUP_BYTES = 16 * 1024 * 1024

# Bumped when the schema changes; a mismatch rebuilds rather than migrates a cache that can always be regenerated from disk.
SCHEMA_VERSION = 2

# Rows are flushed this often during an incremental sync, so a long run holds a bounded amount in memory.
COMMIT_EVERY = 400

# The staleness figures are reused while the folder structure is unchanged, but only this long, since a group rewritten in place by another program leaves no trace in directory mtimes.
STATUS_TTL = 10.0

# Hard cap on returned paths: a term like "1girl" legitimately matches most of a character library, and the client is told when it was truncated.
DEFAULT_LIMIT = 5000
MAX_LIMIT = 50000

# How many completions to offer, and how far the "only suggest what is still reachable" rule may reach.
# Narrowing to the groups the typed terms match is what stops the box offering a tag that produces nothing, but above this many groups it is only a cost, and counts come from the whole index instead.
SUGGEST_LIMIT = 20
MAX_SUGGEST_LIMIT = 100
CONTEXT_MAX_GROUPS = 2000


# Sync runs in a worker thread so a first build cannot block the event loop or time out a request; the client polls status instead.
_LOCK = threading.Lock()
_STATUS_CACHE = None  # (signature, (added, changed, removed), monotonic time)
_STATE = {
    "running": False,
    "phase": "idle",     # idle | scanning | reading | done | error
    "done": 0,
    "total": 0,
    "error": None,
    "finished": 0.0,
}


def _set(**kwargs):
    with _LOCK:
        _STATE.update(kwargs)


def progress():
    with _LOCK:
        return dict(_STATE)


# Text normalisation. Danbooru-style tags are written both ways ("blue_eyes" / "blue eyes"), and one collection usually holds both.
# Folding underscores at index and query time means either spelling finds either file, and the lowercase form makes a plain BINARY prefix scan case-insensitive.

_WS = re.compile(r"\s+")


def normalize(text):
    text = str(text or "").replace("_", " ").strip().lower()
    # Any whitespace other than a plain space is non-printable, so the regex only runs on the rare tag that needs it.
    if "  " in text or not text.isprintable():
        text = _WS.sub(" ", text)
    return text


# Split a query into terms. Commas only: a space is part of a tag.
def parse_terms(query):
    terms = []
    for part in str(query or "").split(","):
        term = normalize(part)
        if term and term not in terms:
            terms.append(term)
    return terms


# Upper bound for a prefix scan under SQLite's BINARY collation.
# UTF-8 preserves code point order, so incrementing the last code point sorts after every continuation of the prefix; anything unencodable falls back to a LIKE scan.
def _prefix_bounds(term):
    try:
        high = term[:-1] + chr(ord(term[-1]) + 1)
        high.encode("utf-8")
        return term, high
    except (ValueError, UnicodeEncodeError, OverflowError):
        return None


# Database

def db_path():
    return os.path.join(get_prompts_dir(), DB_NAME)


def _connect():
    connection = sqlite3.Connection(db_path(), timeout=30)
    # Lowercase is enforced on the way in, and with case folding off SQLite can use the index for a 'prefix%' pattern.
    connection.execute("PRAGMA case_sensitive_like=ON")
    try:
        # Lets a search read while a build is still writing; ignored on filesystems that cannot do it, where the fallback journal is slower but not wrong.
        connection.execute("PRAGMA journal_mode=WAL")
    except sqlite3.Error:
        pass
    connection.execute("PRAGMA synchronous=NORMAL")
    return connection


_TABLES = (
    """CREATE TABLE IF NOT EXISTS groups (
        id    INTEGER PRIMARY KEY,
        path  TEXT NOT NULL UNIQUE,
        mtime REAL NOT NULL,
        size  INTEGER NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS names (
        id  INTEGER PRIMARY KEY,
        tag TEXT NOT NULL UNIQUE
    )""",
    """CREATE TABLE IF NOT EXISTS tags (
        tid INTEGER NOT NULL,
        gid INTEGER NOT NULL,
        PRIMARY KEY (tid, gid)
    ) WITHOUT ROWID""",
    "CREATE INDEX IF NOT EXISTS tags_by_gid ON tags(gid)",
)


def _drop_tables(connection):
    for table in ("tags", "names", "groups"):
        connection.execute(f"DROP TABLE IF EXISTS {table}")


def _create_tables(connection):
    for sql in _TABLES:
        connection.execute(sql)


def _ensure_schema(connection):
    connection.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)")
    row = connection.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
    if not row or row[0] != str(SCHEMA_VERSION):
        # A cache that can be rebuilt from disk is not worth a migration path.
        _drop_tables(connection)
        connection.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema', ?)", (str(SCHEMA_VERSION),))
    _create_tables(connection)
    connection.commit()


# Disk

# {relative path without extension: (mtime, size)} for every tag group under the root.
# scandir, not walk + stat: the directory entry already carries both numbers.
def _scan(root):
    found = {}
    stack = [("", root)]
    seen = set()
    while stack:
        rel, abs_dir = stack.pop()
        key = dir_key(abs_dir)
        if key is None or key in seen:
            continue
        seen.add(key)
        try:
            with os.scandir(abs_dir) as scan:
                entries = list(scan)
        except OSError:
            continue
        for entry in entries:
            name = entry.name
            if excluded(name):
                continue
            child_rel = f"{rel}/{name}" if rel else name
            try:
                if entry.is_dir():
                    stack.append((child_rel, entry.path))
                    continue
                if not name.lower().endswith(".json"):
                    continue
                stat = entry.stat()
            except OSError:
                continue
            key = os.path.splitext(child_rel)[0].replace(os.sep, '/')
            found[key] = (stat.st_mtime, stat.st_size)
    return found


# Distinct, normalised tag names in one tag group file.
# Only `tag` entries: lora, embedding and nested group pills are already findable by name in the default path search.
def _read_tags(abs_path):
    try:
        # No real tag group comes near this; the cap bounds what one hostile file can cost.
        if os.path.getsize(abs_path) > MAX_GROUP_BYTES:
            return None
        with open(abs_path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    # RecursionError is not a ValueError: json.load raises it on a deeply nested file, and it would abort the whole sync.
    except (OSError, ValueError, RecursionError):
        return None
    if not isinstance(data, list):
        return []
    names = set()
    for entry in data:
        if not isinstance(entry, dict):
            continue
        if entry.get("type", "tag") != "tag":
            continue
        name = normalize(entry.get("name"))
        if name:
            names.add(name)
    return sorted(names)


# Sync

# Compare disk against the stored stamps without touching file contents.
# Returns (on_disk, stored, added, changed, removed), where `stored` maps a path to (id, mtime, size) so the caller can reuse ids.
def _diff(connection, root):
    on_disk = _scan(root)
    stored = {path: (gid, mtime, size) for gid, path, mtime, size
              in connection.execute("SELECT id, path, mtime, size FROM groups")}

    added, changed = [], []
    for path, (mtime, size) in on_disk.items():
        previous = stored.get(path)
        if previous is None:
            added.append(path)
        # Float equality is right here: both sides are the same os.stat value round-tripped through SQLite's REAL, not a computation.
        elif previous[1] != mtime or previous[2] != size:
            changed.append(path)
    removed = [path for path in stored if path not in on_disk]
    return on_disk, stored, added, changed, removed


def _group_file(root, path):
    return os.path.join(root, path.replace('/', os.sep) + ".json")


# Full build into empty tables: tag strings are interned in memory and the pairs are inserted sorted, so every B-tree is filled in key order.
# Returns the paths left out because they could not be read.
def _bulk_build(connection, root, on_disk):
    paths = sorted(on_disk)
    _set(phase="reading", done=0, total=len(paths))
    tids, groups, failed = {}, [], []
    # The group ids carrying each tag, indexed by tid - 1. Groups are numbered in reading order, so each array is already sorted and the pairs come out in key order without a sort.
    buckets = []
    for index, path in enumerate(paths, 1):
        tags = _read_tags(_group_file(root, path))
        if tags is None:
            failed.append(path)
        else:
            gid = len(groups) + 1
            groups.append((gid, path) + on_disk[path])
            for tag in tags:
                tid = tids.get(tag)
                if tid is None:
                    tid = tids[tag] = len(tids) + 1
                    buckets.append(array('i'))
                buckets[tid - 1].append(gid)
        if index % 50 == 0 or index == len(paths):
            _set(done=index)

    # The disk cache can always be rebuilt, so a crash mid-build costing durability is fine.
    connection.execute("PRAGMA synchronous=OFF")
    # One transaction: searches keep reading the previous index until the new one is complete.
    connection.execute("BEGIN IMMEDIATE")
    _drop_tables(connection)
    _create_tables(connection)
    connection.execute("DROP INDEX tags_by_gid")
    connection.executemany("INSERT INTO groups(id, path, mtime, size) VALUES(?, ?, ?, ?)", groups)
    connection.executemany("INSERT INTO names(id, tag) VALUES(?, ?)", ((tid, tag) for tag, tid in sorted(tids.items())))
    connection.executemany("INSERT INTO tags(tid, gid) VALUES(?, ?)", ((tid, gid) for tid, gids in enumerate(buckets, 1) for gid in gids))
    connection.execute("CREATE INDEX tags_by_gid ON tags(gid)")
    connection.commit()
    connection.execute("PRAGMA synchronous=NORMAL")
    # Dropped tables leave their pages on the free list; give them back after a rebuild over an existing index.
    free, total = (connection.execute(f"PRAGMA {name}").fetchone()[0] for name in ("freelist_count", "page_count"))
    if free * 4 > total:
        connection.execute("VACUUM")
    return failed


# Applies the diff file by file, for the usual case of a few groups added, changed or removed since the last sync.
def _incremental_sync(connection, root, on_disk, stored, stale, removed):
    if removed:
        gone = [(stored[path][0],) for path in removed]
        connection.executemany("DELETE FROM tags WHERE gid=?", gone)
        connection.executemany("DELETE FROM groups WHERE id=?", gone)
        connection.commit()

    _set(phase="reading", done=0, total=len(stale))
    # Names no longer used by any group stay behind; the join in every query ignores them and a rebuild drops them.
    tids = {}

    def intern(tag):
        tid = tids.get(tag)
        if tid is None:
            row = connection.execute("SELECT id FROM names WHERE tag=?", (tag,)).fetchone()
            tid = tids[tag] = row[0] if row else connection.execute("INSERT INTO names(tag) VALUES(?)", (tag,)).lastrowid
        return tid

    failed, pending = [], 0
    for index, path in enumerate(stale, 1):
        tags = _read_tags(_group_file(root, path))
        if tags is None:
            # Unreadable or malformed: left out of `groups` too, so the next sync retries instead of caching the failure.
            failed.append(path)
            continue
        mtime, size = on_disk[path]
        previous = stored.get(path)
        if previous is None:
            # INSERT rather than INSERT OR REPLACE, so an id is never recycled out from under rows that still point at it.
            gid = connection.execute("INSERT INTO groups(path, mtime, size) VALUES(?, ?, ?)", (path, mtime, size)).lastrowid
        else:
            gid = previous[0]
            connection.execute("UPDATE groups SET mtime=?, size=? WHERE id=?", (mtime, size, gid))
            connection.execute("DELETE FROM tags WHERE gid=?", (gid,))
        if tags:
            connection.executemany("INSERT OR IGNORE INTO tags(tid, gid) VALUES(?, ?)", [(intern(tag), gid) for tag in tags])
        pending += 1
        if pending >= COMMIT_EVERY:
            connection.commit()
            pending = 0
        if index % 50 == 0 or index == len(stale):
            _set(done=index)
    connection.commit()
    return failed


def _sync(rebuild=False):
    global _STATUS_CACHE
    root = get_prompts_dir()
    connection = _connect()
    try:
        _ensure_schema(connection)
        _set(phase="scanning", done=0, total=0, error=None)
        signature = tree_signature([root])
        on_disk, stored, added, changed, removed = _diff(connection, root)

        if rebuild or not stored:
            failed = _bulk_build(connection, root, on_disk)
            counts = (len(failed), 0, 0)
        else:
            failed = set(_incremental_sync(connection, root, on_disk, stored, added + changed, removed))
            counts = (sum(p in failed for p in added), sum(p in failed for p in changed), 0)

        connection.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('synced', ?)", (str(time.time()),))
        connection.commit()
        # The diff this sync just applied is the next status answer, as long as nothing moves in the meantime.
        with _LOCK:
            _STATUS_CACHE = (signature, counts, time.monotonic())
        _set(phase="done", done=progress()["total"], finished=time.time())
    finally:
        connection.close()


def start_sync(rebuild=False):
    """Kick off a sync in the background. False if one is already running."""
    with _LOCK:
        if _STATE["running"]:
            return False
        _STATE.update(running=True, phase="scanning", done=0, total=0, error=None)

    def run():
        try:
            _sync(rebuild=rebuild)
        except Exception as e:            # noqa: BLE001 - reported to the client
            print(f"[EreNodes] tag index sync failed: {e}")
            _set(phase="error", error=str(e))
        finally:
            _set(running=False, finished=time.time())

    threading.Thread(target=run, name="erenodes-tag-index", daemon=True).start()
    return True


def invalidate_status():
    global _STATUS_CACHE
    with _LOCK:
        _STATUS_CACHE = None


# Staleness counts, reused from the last scan or sync while the folder structure is unchanged, so the repeated polls around a sync do not rescan the library each time.
def _stale_counts(connection, root):
    global _STATUS_CACHE
    signature = tree_signature([root])
    with _LOCK:
        cached = _STATUS_CACHE
    if cached and cached[0] == signature and time.monotonic() - cached[2] < STATUS_TTL:
        return cached[1]
    _, _stored, added, changed, removed = _diff(connection, root)
    counts = (len(added), len(changed), len(removed))
    with _LOCK:
        _STATUS_CACHE = (signature, counts, time.monotonic())
    return counts


# What the sidebar needs to decide whether the index is usable: how much it holds, and how much of the collection it is missing.
# While a build runs this is polled every ~600ms, and each call would walk the tree the build is already walking, so the diff is skipped and `scanned: false` says the staleness figures are not an answer yet.
def status():
    running = progress()["running"]
    connection = _connect()
    try:
        _ensure_schema(connection)
        counts = (0, 0, 0)
        if not running:
            counts = _stale_counts(connection, get_prompts_dir())
        indexed = connection.execute("SELECT COUNT(*) FROM groups").fetchone()[0]
        tags = connection.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
        row = connection.execute("SELECT value FROM meta WHERE key='synced'").fetchone()
    finally:
        connection.close()
    return {
        "indexed": indexed,
        "tags": tags,
        "scanned": not running,
        "added": counts[0],
        "changed": counts[1],
        "removed": counts[2],
        "stale": sum(counts),
        "synced": float(row[0]) if row else 0.0,
        "root": get_prompts_dir(),
        **progress(),
    }


# Search

def _name_where(term, column="tag"):
    bounds = _prefix_bounds(term)
    if bounds:
        return f"{column} >= ? AND {column} < ?", list(bounds)
    return f"{column} LIKE ?", [term + "%"]


# One SELECT per term, intersected by SQLite: each is an index-only prefix scan, so the intersection happens on integers and only the survivors become paths.
def _term_clause(term):
    where, params = _name_where(term)
    return f"SELECT gid FROM tags WHERE tid IN (SELECT id FROM names WHERE {where})", params


# Prefix completions for the word being typed: which tags this collection contains, and how many groups carry each.
# `context` is the terms already committed, and when the groups they match are few enough to intersect, completions and counts come from those groups alone.
def suggest(prefix, context="", limit=SUGGEST_LIMIT):
    term = normalize(prefix)
    if not term:
        return []
    limit = max(1, min(int(limit or SUGGEST_LIMIT), MAX_SUGGEST_LIMIT))

    where, params = _name_where(term, "n.tag")

    # A term identical to the word being completed is the user retyping it, not context for itself.
    context_terms = [t for t in parse_terms(context) if t != term]

    connection = _connect()
    try:
        _ensure_schema(connection)
        scope_sql, scope_params = "", []
        if context_terms:
            clauses, ctx_params = [], []
            for other in context_terms:
                sql, args = _term_clause(other)
                clauses.append(sql)
                ctx_params.extend(args)
            intersect = " INTERSECT ".join(clauses)
            # Bounded probe: stop counting at the cutoff rather than measure how far past it we are.
            reachable = connection.execute(
                f"SELECT COUNT(*) FROM (SELECT gid FROM ({intersect}) LIMIT {CONTEXT_MAX_GROUPS + 1})",
                ctx_params).fetchone()[0]
            if reachable == 0:
                # Nothing matches what is already typed, so no completion of the current word can match either.
                return []
            if reachable <= CONTEXT_MAX_GROUPS:
                scope_sql = f" AND t.gid IN ({intersect})"
                scope_params = ctx_params

        # Over-fetch by the number of terms filtered out below, so excluding them cannot shorten the menu.
        rows = connection.execute(
            f"SELECT n.tag, COUNT(*) AS c FROM names n JOIN tags t ON t.tid = n.id WHERE {where}{scope_sql}"
            f" GROUP BY n.id ORDER BY c DESC, n.tag LIMIT {limit + len(context_terms)}",
            params + scope_params).fetchall()
    except sqlite3.Error as e:
        print(f"[EreNodes] tag index suggest failed: {e}")
        return []
    finally:
        connection.close()

    # A term already in the box is not a completion, and under context scoping it would sit at the top of the menu.
    already = set(context_terms)
    # `name` and `count` are what the autocomplete menu already renders for a CSV tag.
    return [{"name": tag, "count": count}
            for tag, count in rows if tag not in already][:limit]


def search(query, limit=DEFAULT_LIMIT):
    terms = parse_terms(query)
    if not terms:
        return {"terms": [], "paths": [], "total": 0, "truncated": False}

    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    clauses, params = [], []
    for term in terms:
        sql, args = _term_clause(term)
        clauses.append(sql)
        params.extend(args)

    connection = _connect()
    try:
        _ensure_schema(connection)
        # One extra row says whether there were more without counting them all.
        # Ordered by path, so the sidebar's results are stable between identical queries.
        rows = connection.execute(
            f"SELECT path FROM groups WHERE id IN ({' INTERSECT '.join(clauses)})"
            f" ORDER BY path LIMIT {limit + 1}", params).fetchall()
    except sqlite3.Error as e:
        print(f"[EreNodes] tag index search failed: {e}")
        return {"terms": terms, "paths": [], "total": 0, "truncated": False, "error": str(e)}
    finally:
        connection.close()

    truncated = len(rows) > limit
    paths = [row[0] for row in rows[:limit]]
    return {"terms": terms, "paths": paths, "total": len(paths), "truncated": truncated}
