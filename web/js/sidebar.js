import { app } from "../../../scripts/app.js";
import { getCache, isNotFound, loadStyle, clearMissingCache, isAcceptedImage, extractFromImage, tagsFromResult, forgetVerdicts, installTooltips, getSetting, loadGroupTags, requestJson, toast, confirmDialog, promptDialog, pickFile, trackMarquee, trackPress, HOLD_MS, MOVE_THRESHOLD } from "./util.js";
import { SURFACE_CLASS, injectTagStyles, renderTagTile, previewUrl, saveCover,
         TILE_SIZE, TILE_GAP, TILE_SIZES, TILE_RATIOS, tileBoxFor } from "./tagview.js";
import { showPreviewFor, hidePreviewPanel, setPreviewHandlers } from "./preview.js";
import { startExternalDrag, isDragActive, injectDragStyles } from "./dragdrop.js";
import { ActionContextMenu, TagIndexContextMenu } from "./contextmenu.js";
import { GlobalAutocomplete } from "../prompt_autocomplete.js";
import { createTagEditor } from "./tageditor.js";
import { dedupeTags } from "./parser.js";

// Verbatim from the frontend's Button.vue output, so these match the buttons in the core sidebars: base, then one variant per line.
const BUTTON_BASE = "relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap appearance-none border-none rounded-md text-sm font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";
const BUTTON_CLASS = `${BUTTON_BASE} bg-transparent text-muted-foreground hover:bg-secondary-background-hover size-8`;
// The variant the Assets tab puts next to its search box, so the two buttons read as part of the input strip.
const BUTTON_SECONDARY = `${BUTTON_BASE} bg-secondary-background text-secondary-foreground hover:bg-secondary-background-hover size-8`;
// Popover.vue's content, and Button.vue's textonly/md as MediaAssetSettingsMenu uses it for a row.
// Rows stretch as flex children; the width itself is in sidebar.css, where an unlayered rule can outrank whatever widens it.
const MENU_CLASS = "ere-sb-menu fixed z-1700 flex flex-col rounded-lg border border-border-subtle bg-base-background p-2 shadow-sm";
const MENU_ITEM = `${BUTTON_BASE} bg-transparent text-base-foreground hover:bg-secondary-background-hover h-8 rounded-lg p-2 text-xs`;
const MENU_SEPARATOR = "my-1 border-b border-border-subtle";

// Text tab classes, copied from the Assets sidebar's tablist.
const TAB_CLASS = "flex h-8 shrink-0 items-center justify-center cursor-pointer rounded-lg border-none px-2.5 text-sm transition-all duration-200 focus-visible:ring-ring/20 outline-hidden focus-visible:ring-1";
const TAB_ACTIVE = "bg-interface-menu-component-surface-hovered text-text-primary";
const TAB_INACTIVE = "bg-transparent text-text-secondary hover:bg-button-hover-surface focus:bg-button-hover-surface";

// Tree row classes, copied verbatim from the Nodes sidebar.
// All static Tailwind — nothing lazily injected.
const ROW_CLASS = "group/tree-node flex w-full min-w-0 cursor-pointer select-none items-center gap-3 overflow-hidden py-2 outline-none hover:bg-comfy-input rounded";
const ROW_ICON = "size-4 shrink-0 text-muted-foreground";
const ROW_LABEL = "text-foreground min-w-0 flex-1 truncate text-sm";
const TREE_CLASS = "m-0 min-w-0 px-2 py-2 2xl:px-4";
// The Nodes tree has no counts, so this is built from its buttons' token vocabulary.
const COUNT_CLASS = "shrink-0 rounded bg-secondary-background px-1.5 py-0.5 text-xs text-muted-foreground";

const TABS = [
    { id: "group",     label: "Tag Groups", defaultView: "list" },
    { id: "lora",      label: "Loras",      defaultView: "grid" },
    { id: "embedding", label: "Embeddings", defaultView: "grid" },
];

// Only lucide icons the frontend already compiles can be used — an uncompiled `icon-[lucide--x]` renders as nothing.
// Folder view walks one level at a time like grid, but draws rows like list.
const VIEW_OPTIONS = [
    { id: "list",   icon: "icon-[lucide--list]",        label: "List view" },
    { id: "grid",   icon: "icon-[lucide--layout-grid]", label: "Grid view" },
    { id: "folder", icon: "icon-[lucide--folder]",      label: "Folder view" },
];

/** Views that show one level at a time, with a breadcrumb, rather than the whole tree. */
const walksLevels = view => view === "grid" || view === "folder";

const LS_VIEW = "EreNodes.Sidebar.view";
const LS_TILE = "EreNodes.Sidebar.tileSize";
const LS_RATIO = "EreNodes.Sidebar.tileRatio";
const LS_EXPANDED = "EreNodes.Sidebar.expanded";
const LS_TAB = "EreNodes.Sidebar.tab";
const LS_TAGSEARCH = "EreNodes.Sidebar.tagSearch";
const LS_BOOKMARKS_SEEN = "EreNodes.Sidebar.bookmarksSeen";

// Long enough that typing a word filters once at the end of it rather than once per letter.
const SEARCH_DEBOUNCE_MS = 250;
// Slow enough not to hammer the server, fast enough that a 36k first build visibly moves.
const INDEX_POLL_MS = 600;
// Tile sizes, ratios and the grid gap live in tagview.js: the Gallery node's menu offers the same set.
const RATIO_ICON = "icon-[lucide--square]";

const state = {
    host: null,
    tab: TABS[0].id,
    query: "",
    tagSearch: false,   // deep mode: match tags inside the groups, not their names
    tagResults: null,   // { query, paths: Set<string>, truncated } for the query on screen
    tagSeq: 0,          // discards answers to queries the user has already moved past
    indexStatus: null,  // last /tag_index/status payload
    indexBusy: false,   // a build is running and this tab is watching it
    trees: {},
    treeVersions: {},   // tab id -> the server's signature for the tree we hold
    loading: false,
    expanded: {},
    view: {},
    tileSize: {},       // tab id -> "small" | "large"
    tileRatio: {},      // tab id -> a TILE_RATIOS id
    crumb: {}, 
    selection: new Set(),
    anchor: null,
    cursor: -1,         // index into rows, for the keyboard
    rows: [],
    flows: [],
    press: null,
    editor: null,
    viewMenu: null,     // closes the view popover, while one is open
    bookmarks: [],      // tag group paths, in the order they were added
};

// Bookmarks
// Tag groups only, and stored with them rather than in a setting, so they follow
// `tag_groups.location` and travel with the library they name.

// `:` cannot occur in a path from disk, so this cannot collide with a real folder.
const BOOKMARK_PATH = "::bookmarks";
const BOOKMARK_TAB = "group";

const bookmarksApply = () => state.tab === BOOKMARK_TAB;

let bookmarkSet = new Set();
const isBookmarked = path => bookmarkSet.has(path);

// The file can only be written once it has been read: a toggle against a list that never loaded would save it over the real one.
let bookmarksLoaded = false;
let bookmarkWrite = Promise.resolve();

async function loadBookmarks() {
    try {
        const data = await requestJson("/erenodes/bookmarks");
        state.bookmarks = Array.isArray(data?.paths) ? data.paths : [];
        bookmarkSet = new Set(state.bookmarks);
        bookmarksLoaded = true;
    } catch {
        // The last known list stands; a failed read must not become an empty list.
    }
}

// Written back whole: the list is small and one request per change keeps the file the only truth.
// Writes are chained, since two quick toggles otherwise race and the older answer can land last.
function saveBookmarks(paths) {
    if (!bookmarksLoaded) {
        toast("warn", "Bookmarks", "Not loaded yet.", 4000);
        return bookmarkWrite;
    }
    state.bookmarks = paths;
    bookmarkSet = new Set(paths);
    render();
    bookmarkWrite = bookmarkWrite.then(async () => {
        const result = await postJson("/erenodes/bookmarks", { paths: state.bookmarks }, { quiet: true });
        if (Array.isArray(result?.paths)) return;
        toast("error", "Bookmarks", "Could not be saved.", 4000);
        // Re-read rather than restore what was on screen, which by now may be older than the file.
        await loadBookmarks();
        render();
    });
    return bookmarkWrite;
}

async function removeAllBookmarks() {
    const message = `Remove all ${state.bookmarks.length} bookmarks? The tag groups themselves are not touched.`;
    if (await confirmDialog("Remove Bookmarks", message)) saveBookmarks([]);
}

function toggleBookmark(path) {
    const next = isBookmarked(path)
        ? state.bookmarks.filter(p => p !== path)
        : [...state.bookmarks, path];
    return saveBookmarks(next);
}

// A renamed or moved group keeps its bookmark; a deleted one loses it.
function repathBookmarks(from, to) {
    return repathBookmarksAll([[from, to]]);
}

/** The same, for a batch: one write and one render however many entries moved. */
function repathBookmarksAll(moves) {
    if (!state.bookmarks.length || !moves.length) return Promise.resolve();
    let changed = false;
    const next = [];
    for (const path of state.bookmarks) {
        let updated = path;
        let dropped = false;
        for (const [from, to] of moves) {
            const prefix = `${from}/`;
            if (to === null) {
                if (updated === from || updated.startsWith(prefix)) { dropped = true; break; }
            } else if (updated === from) {
                updated = to;
            } else if (updated.startsWith(prefix)) {
                updated = to + updated.slice(from.length);
            }
        }
        if (dropped) { changed = true; continue; }
        if (updated !== path) changed = true;
        if (!next.includes(updated)) next.push(updated);
    }
    return changed ? saveBookmarks(next) : Promise.resolve();
}

// Storage

function loadJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
}

function saveJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function restorePrefs() {
    const views = loadJSON(LS_VIEW, {});
    for (const tab of TABS) state.view[tab.id] = views[tab.id] || tab.defaultView;
    const sizes = loadJSON(LS_TILE, {});
    const ratios = loadJSON(LS_RATIO, {});
    for (const tab of TABS) {
        state.tileSize[tab.id] = sizes[tab.id] || "small";
        state.tileRatio[tab.id] = ratios[tab.id] || "1-1";
    }
    const expanded = loadJSON(LS_EXPANDED, {});
    for (const tab of TABS) state.expanded[tab.id] = new Set(expanded[tab.id] || []);
    // Bookmarks start open, once. After that the stored set is the user's own answer.
    if (!loadJSON(LS_BOOKMARKS_SEEN, false)) {
        state.expanded[BOOKMARK_TAB].add(BOOKMARK_PATH);
        saveJSON(LS_BOOKMARKS_SEEN, true);
    }
    state.tab = loadJSON(LS_TAB, TABS[0].id);
    if (!TABS.some(t => t.id === state.tab)) state.tab = TABS[0].id;
    state.tagSearch = loadJSON(LS_TAGSEARCH, false) === true;
}

function persistExpanded() {
    saveJSON(LS_EXPANDED, Object.fromEntries(
        TABS.map(t => [t.id, [...(state.expanded[t.id] || [])]])
    ));
}

const activeTab = () => TABS.find(t => t.id === state.tab);

// Data

async function requestTree(tab, params) {
    const query = new URLSearchParams({ type: tab, ...params });
    return requestJson(`/erenodes/tree?${query}`);
}

/** The whole tree. The server answers `{unchanged: true}` when the copy we hold is current, which makes reopening the tab free. */
async function fetchTree(tab, { force = false } = {}) {
    const known = force ? "" : (state.treeVersions[tab] || "");
    try {
        const data = await requestTree(tab, force ? { force: "1" } : (known ? { known } : {}));
        if (data.unchanged && state.trees[tab]) return state.trees[tab];
        state.trees[tab] = { folders: data.folders || [], files: data.files || [] };
        state.treeVersions[tab] = data.version || "";
    } catch (e) {
        console.error("[EreNodes] Sidebar tree fetch failed.", e);
        state.trees[tab] = { folders: [], files: [] };
        state.treeVersions[tab] = "";
    }
    return state.trees[tab];
}

/** The root level only — one directory read, so it lands immediately. The full tree replaces it a moment later. */
async function fetchRootLevel(tab) {
    try {
        const data = await requestTree(tab, { depth: "1" });
        if (!data.partial) return;
        state.trees[tab] = { folders: data.folders || [], files: data.files || [] };
    } catch { /* the full fetch right behind it will report any real problem */ }
}

/** Every file at or below a tree node, depth first. */
function filesUnder(node, out = []) {
    for (const folder of node.folders || []) filesUnder(folder, out);
    for (const file of node.files || []) out.push(file);
    return out;
}

/**
 * Tags a row contributes when dropped on a node; a folder contributes its whole subtree.
 * @param {{unpack?: boolean}} opts  expand groups instead of passing the pill.
 */
async function tagsForRow(row, opts = {}) {
    if (row.type === "folder") {
        const node = nodeAtPath(state.trees[state.tab] || { folders: [], files: [] }, row.path);
        // Its own entries only. A library organised into subfolders would otherwise put every group under a top folder into one drop, which is tens of thousands of files and one request each.
        const files = node.files || [];
        const lists = await Promise.all(files.map(f => tagsForFile({
            ...f, tab: state.tab, type: "file",
        }, opts)));
        return dedupeTags(lists.flat());
    }
    return tagsForFile(row, opts);
}

/** A tag group contributes *itself*, as one group pill. */
async function tagsForFile(row, { unpack = false } = {}) {
    if (row.tab !== "group") {
        return [{ name: row.path, type: row.tab, active: true, extension: row.extension }];
    }
    if (unpack) return (await loadGroupTags(row.path, row.extension)) || [];
    return [{ name: row.path, type: "group", active: true, extension: row.extension || ".json" }];
}



// Filtering

/** One term per word, all of which must match. A contiguous substring only ever found "blue archive" typed in that order; terms let "archive aris" and "aris blue" reach the same file. */
function tokenize(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** The entry's lowercased path, cached on it. A 36k-file tree is re-filtered on every keystroke, and lowercasing the same strings again is the one part of that loop worth skipping. Safe to store: the server sends a fresh tree whenever anything on disk changes. */
function lowerPath(entry) {
    if (entry._lc === undefined) entry._lc = (entry.path || entry.name || "").toLowerCase();
    return entry._lc;
}

const matchesAll = (entry, terms) => {
    const text = lowerPath(entry);
    return terms.every(term => text.includes(term));
};

/**
 * Filter a tree to entries whose *path* matches every term. Paths are full and relative, so a folder name is part of every path below it and searching a series returns its characters; a folder that matches keeps its whole subtree, not a re-filtered one.
 * Tags inside the groups need the file contents, which the tree does not carry — that is the index mode below.
 */
function filterTree(node, terms) {
    const folders = [];
    for (const folder of node.folders || []) {
        if (matchesAll(folder, terms)) {
            folders.push(folder);
            continue;
        }
        const sub = filterTree(folder, terms);
        if (sub.folders.length || sub.files.length) folders.push({ ...folder, ...sub });
    }
    const files = (node.files || []).filter(f => matchesAll(f, terms));
    return { folders, files };
}

/** Filter a tree down to an exact set of file paths — the tag index's answer, drawn in the tree it belongs to. */
function filterTreeByPaths(node, paths) {
    const folders = [];
    for (const folder of node.folders || []) {
        const sub = filterTreeByPaths(folder, paths);
        if (sub.folders.length || sub.files.length) folders.push({ ...folder, ...sub });
    }
    const files = (node.files || []).filter(f => paths.has(f.path));
    return { folders, files };
}


// Tag Index (deep search)
// Name mode filters the tree the browser already holds. Tag mode answers "which groups contain this tag", which the tree cannot — the tags live in 36k separate files, behind a SQLite index (py/tag_index.py). The sidebar never blocks on it: a build runs in the background with a progress line, and the query goes out once the index is current.

async function fetchIndexStatus() {
    try {
        return await requestJson("/erenodes/tag_index/status");
    } catch (e) {
        console.error("[EreNodes] Tag index status failed.", e);
        return null;
    }
}

async function startIndexSync({ rebuild = false } = {}) {
    try {
        await requestJson("/erenodes/tag_index/sync", { body: { rebuild } });
        return true;
    } catch (e) {
        console.error("[EreNodes] Tag index sync could not be started.", e);
        return false;
    }
}

/** Bring the index up to date, drawing progress. Resolves to the final status, or null if the server was unreachable or the mode was left. */
async function ensureIndex({ rebuild = false } = {}) {
    // Two rounds, because the build we join may not be ours: if one was already running when we arrived, it can have started before the files we care about landed, and `stale` is not reported while a build is in flight. The second round is the one that can see whether anything is still missing.
    for (let round = 0; round < 2; round++) {
        state.indexStatus = await fetchIndexStatus();
        if (!state.indexStatus) { render(); return null; }
        if (!rebuild && !state.indexStatus.stale && !state.indexStatus.running) break;

        if (!state.indexStatus.running) await startIndexSync({ rebuild });
        rebuild = false;    // a rebuild is a one-off; any follow-up round is an ordinary sync
        state.indexBusy = true;
        render();

        // Polled, not streamed: a build runs for seconds to minutes.
        for (;;) {
            await new Promise(resolve => setTimeout(resolve, INDEX_POLL_MS));
            // Tab closed or mode off. The build carries on server-side with nobody to report to.
            if (!state.host || !state.tagSearch) { state.indexBusy = false; return null; }
            const status = await fetchIndexStatus();
            if (!status) { state.indexBusy = false; state.indexStatus = null; render(); return null; }
            state.indexStatus = status;
            if (!status.running) break;
            // In place: a full render every 600ms would rebuild thousands of rows and lose the scroll position, to move two numbers.
            refreshIndexProgress();
        }
        state.indexBusy = false;
        render();
    }
    return state.indexStatus;
}

/** Run the query on screen against the index. Sequenced: a slow answer to an abandoned query must not replace the one being read. */
async function runTagSearch() {
    const query = state.query.trim();
    const seq = ++state.tagSeq;
    state.tagResults = null;
    if (!query) { render(); return; }

    render();   // draws "Searching tags…" while the request is out

    let data = null;
    try {
        data = await requestJson(`/erenodes/tag_index/search?query=${encodeURIComponent(query)}`);
    } catch (e) {
        console.error("[EreNodes] Tag search failed.", e);
    }
    if (seq !== state.tagSeq || !state.host) return;
    state.tagResults = data && !data.error
        ? { query, paths: new Set(data.paths || []), truncated: !!data.truncated }
        : { query, paths: new Set(), failed: true };
    render();
}

async function setTagSearch(on) {
    if (state.tagSearch === on) return;
    state.tagSearch = on;
    saveJSON(LS_TAGSEARCH, on);
    state.tagResults = null;
    buildChrome(state.host);
    if (!on) { render(); return; }
    await ensureIndex();
    // ensureIndex can take a while; the user may have switched back out of the mode in the meantime.
    if (state.tagSearch) runTagSearch();
}

/** True when the query on screen should be answered by the index rather than by the tree. */
const deepSearchActive = () => state.tab === "group" && state.tagSearch;


// Autocomplete on the search box
// Only in tag mode, where the box takes comma-separated tags — the same job the node autocomplete does. In name mode there is nothing to complete against. Suggestions come from the index rather than the CSV, so the box never offers a tag you do not have.

/** Our own instance: the global one is bound to whichever node textarea has focus, and borrowing it would detach it mid-edit. */
let searchAutocomplete = null;

/** Our own input, so the EreNodes-specific setting governs it — not the global textarea hook someone may have turned off for other packs. */
function autocompleteEnabled() {
    const global = getSetting("EreNodes.Autocomplete.Global", true);
    const nodes = getSetting("EreNodes.Autocomplete.Nodes", true);
    return global || nodes;
}

/** Attached on focus, not up front: the mode and the setting can both change while the row stands. */
function attachSearchAutocomplete(input) {
    input.addEventListener("focus", () => {
        if (!deepSearchActive() || !autocompleteEnabled()) return;
        searchAutocomplete ??= new GlobalAutocomplete();
        searchAutocomplete.attach(input, {
            menuClass: TagIndexContextMenu,
            // A search term is matched literally, so `\(` would be looked up with the backslash in it.
            escapeParens: false,
        });
    });
}

/** The attached input is about to be discarded (chrome rebuild, tab switch, unmount). */
function detachSearchAutocomplete() {
    searchAutocomplete?.detach();
}

function nodeAtPath(tree, path) {
    if (!path) return tree;
    let node = tree;
    for (const part of path.split("/")) {
        const next = (node.folders || []).find(f => f.name === part);
        if (!next) return { folders: [], files: [] };
        node = next;
    }
    return node;
}

// Keyed by the node object, so a filtered copy counts its own files rather than the original's.
const leafCounts = new WeakMap();

function countLeaves(folder) {
    let count = leafCounts.get(folder);
    if (count === undefined) {
        count = filesUnder(folder).length;
        leafCounts.set(folder, count);
    }
    return count;
}

// Selection

const rowKey = row => `${row.bookmarkCopy ? "bm:" : ""}${row.type}:${row.path}`;

function clearSelection() {
    state.selection.clear();
    state.anchor = null;
    syncSelectionClasses();
}

function syncSelectionClasses() {
    if (!state.host) return;
    for (const el of state.host.querySelectorAll("[data-ere-key]")) {
        const selected = state.selection.has(el.dataset.ereKey);
        el.classList.toggle("ere-sb-selected", selected);
        if (el.getAttribute("role") === "treeitem") el.setAttribute("aria-selected", String(selected));
    }
}

function toggleRowKey(key) {
    if (state.selection.has(key)) state.selection.delete(key);
    else state.selection.add(key);
    state.anchor = key;
    syncSelectionClasses();
}

/** Shift ranges over rendered order; Ctrl is handled at pointerdown (see the body's guard), and a plain click just activates. */
function handleRowSelect(row, e) {
    const key = rowKey(row);
    if (e.shiftKey) {
        const keys = state.rows.map(rowKey);
        const from = keys.indexOf(state.anchor ?? key);
        const to = keys.indexOf(key);
        if (from !== -1 && to !== -1) {
            const [lo, hi] = from <= to ? [from, to] : [to, from];
            state.selection = new Set(keys.slice(lo, hi + 1));
            syncSelectionClasses();
        }
        return true;
    }
    return false;
}

// A selection lives until something says otherwise, and these are the somethings — the same set a pill or a category selection answers to. Bound once, on window, in the capture phase: presses on the sidebar's own chrome never reach the tree body, and presses outside it never reach the sidebar at all.
window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !state.selection.size) return;
    // Modified presses are selection gestures; rows and the tree body run their own guard; a menu acting on the selection must not have it cleared out from under it.
    if (e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (e.target?.closest?.(".ere-sb-body-inner, [data-ere-key], .litecontextmenu")) return;
    clearSelection();
}, true);

window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !state.selection.size) return;
    const active = document.activeElement;
    if (active && (active.nodeName === "INPUT" || active.nodeName === "TEXTAREA")) return;
    clearSelection();
}, true);

// Keyboard
// The list answers arrows, Enter, Escape, Backspace and type-ahead, as a file manager does.
// Bound to the body rather than the window: the keys belong to it only while it has focus.

const TYPEAHEAD_MS = 800;
let typed = "";
let typedAt = 0;

function bodyEl() {
    return state.host?.querySelector(".ere-sb-body-inner") ?? null;
}

function focusBody() {
    const body = bodyEl();
    if (body && document.activeElement !== body) body.focus({ preventScroll: true });
}

function moveCursor(delta) {
    if (!state.rows.length) return;
    const next = state.cursor < 0
        ? (delta > 0 ? 0 : state.rows.length - 1)
        : Math.min(Math.max(state.cursor + delta, 0), state.rows.length - 1);
    selectOnly(state.rows[next]);
    revealCursor();
}

function revealCursor() {
    const row = state.rows[state.cursor];
    if (!row) return;
    const key = rowKey(row);
    for (const flow of state.flows) {
        const index = flow.indexOf(r => rowKey(r) === key);
        if (index !== -1) { flow.scrollToIndex(index); break; }
    }
    state.host?.querySelector(`[data-ere-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
}

/** One level up, for the views that show one at a time. */
function goUp() {
    const view = state.view[state.tab];
    if (!walksLevels(view)) return false;
    const path = state.crumb[state.tab] || "";
    if (!path) return false;
    state.crumb[state.tab] = path === BOOKMARK_PATH ? "" : path.slice(0, Math.max(path.lastIndexOf("/"), 0));
    state.cursor = -1;
    render();
    return true;
}

/** Explorer's type-ahead: the letters typed so far, then the next row that starts with them. */
function typeAhead(key) {
    const now = Date.now();
    const repeat = typed.length === 1 && typed === key.toLowerCase();
    typed = now - typedAt > TYPEAHEAD_MS ? key.toLowerCase() : typed + key.toLowerCase();
    typedAt = now;

    const rows = state.rows;
    if (!rows.length) return;
    // Repeating one letter walks the entries starting with it, rather than sticking on the first.
    const from = (repeat || typed.length === 1) ? state.cursor + 1 : 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[(from + i) % rows.length];
        if ((row.name || "").toLowerCase().startsWith(typed)) {
            selectOnly(row);
            revealCursor();
            return;
        }
    }
}

function onBodyKeyDown(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target !== e.currentTarget && e.target?.closest?.("input, textarea")) return;

    switch (e.key) {
        case "ArrowDown": moveCursor(1); break;
        case "ArrowUp": moveCursor(-1); break;
        case "Home": if (state.rows.length) { selectOnly(state.rows[0]); revealCursor(); } break;
        case "End": if (state.rows.length) { selectOnly(state.rows[state.rows.length - 1]); revealCursor(); } break;
        case "Enter": {
            const row = state.rows[state.cursor];
            if (row) onRowActivate(row);
            break;
        }
        case "ArrowRight": {
            const row = state.rows[state.cursor];
            if (row?.type === "folder") onRowActivate(row);
            break;
        }
        case "ArrowLeft":
            if (!goUp()) {
                const row = state.rows[state.cursor];
                if (row?.type === "folder" && state.expanded[state.tab].has(row.path)) toggleFolder(row.path);
            }
            break;
        case "Backspace": if (!goUp()) return; break;
        case "Escape":
            clearSelection();
            state.cursor = -1;
            break;
        default:
            // A bare printable character is the start of a name, not a shortcut.
            if (e.key.length !== 1 || e.key === " ") return;
            typeAhead(e.key);
    }
    e.preventDefault();
    e.stopPropagation();
}

function selectedRows() {
    if (!state.selection.size) return [];
    const byKey = new Map(state.rows.map(r => [rowKey(r), r]));
    return [...state.selection].map(k => byKey.get(k)).filter(Boolean);
}

/**
 * Rubber-band selection over the rows, matching the pill marquee in nodes: drag on empty space to replace the selection, hold Ctrl/Cmd to XOR against what is already picked.
 * A press that never moves is not a band — it is the ctrl+click, or a click on nothing.
 * @param {?HTMLElement} rowEl  the row the press landed on, if any
 */
function beginMarquee(e, scroller, rowEl = null) {
    const additive = e.ctrlKey || e.metaKey;
    trackMarquee(e, {
        // Only what the window has drawn can be banded, which is also all that is on screen.
        items: () => [...scroller.querySelectorAll("[data-ere-key]")].map(el => ({ key: el.dataset.ereKey, el })),
        base: additive ? state.selection : [],
        onChange: (keys) => {
            state.selection = keys;
            syncSelectionClasses();
        },
        // A press that never opened a band stays a plain click: ctrl toggles that row, and a press on empty space clears.
        onClick: () => {
            if (rowEl) toggleRowKey(rowEl.dataset.ereKey);
            else if (!additive) clearSelection();
        },
    });
}

// Node Actions

function defaultNodeType() {
    return getSetting("EreNodes.Sidebar.DefaultNode", "ErePromptCloud")
        ?? "ErePromptCloud";
}

/**
 * Create a prompt node prefilled with `tags`.
 * @param {?{x, y}} at  drop point; centred in the viewport when omitted.
 */
function createNodeWithTags(tags, nodeType = defaultNodeType(), at = null) {
    const LG = window.LiteGraph;
    if (!LG?.createNode) return null;
    const node = LG.createNode(nodeType);
    if (!node) return null;

    const canvas = app.canvas;
    const graph = canvas?.graph ?? app.graph;
    graph.add(node);
    if (canvas?.ds) {
        const { scale, offset } = canvas.ds;
        const rect = canvas.canvas.getBoundingClientRect();
        if (at) {
            // Client -> graph coordinates, dropping the node's top-left roughly under the cursor.
            node.pos = [
                (at.x - rect.left) / scale - offset[0],
                (at.y - rect.top) / scale - offset[1],
            ];
        } else {
            // Nudged, so repeated adds do not stack exactly on top of each other.
            const jitter = ((graph.nodes ?? graph._nodes ?? []).length % 6) * 24;
            node.pos = [
                rect.width / 2 / scale - offset[0] - (node.size?.[0] ?? 200) / 2 + jitter,
                rect.height / 2 / scale - offset[1] - 40 + jitter,
            ];
        }
    }

    node.properties = node.properties || {};
    node.properties._tagDataJSON = JSON.stringify(tags);
    node.onUpdateTextWidget?.(node);
    graph.setDirtyCanvas(true, true);
    return node;
}

/** A sidebar payload dropped on bare canvas becomes a new node there. */
function onCanvasDrop(tags, x, y) {
    if (!tags?.length) return;
    createNodeWithTags(tags, defaultNodeType(), { x, y });
}

// Hovering

function anchorRect(el) {
    // Anchored to the sidebar's edge, so the panel never covers the list being scanned.
    const panel = state.host?.getBoundingClientRect();
    const row = el.getBoundingClientRect();
    return panel
        ? { top: row.top, bottom: row.bottom, left: panel.left, right: panel.right }
        : row;
}

function attachHover(el, row) {
    if (row.type === "folder") return;
    el.addEventListener("pointerenter", () => {
        if (isDragActive()) return;
        showPreviewFor({
            type: row.tab, path: row.path, extension: row.extension,
            anchor: anchorRect(el),
            // Grid view already shows the thumbnail on the tile itself.
            image: state.view[state.tab] !== "grid",
            // A lora's trained words are informational; a group's tags can be picked out.
            interactive: row.tab === "group" && row.type === "file",
        });
    });
    el.addEventListener("pointerleave", () => hidePreviewPanel());
}

// Press

/**
 * Press handling: a click activates, a hold or a small move becomes a drag.
 * Mirrors the pill gesture in dragdrop.js so both feel the same.
 */
function attachPress(el, row) {
    el.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();

        const begin = async (session) => {
            hidePreviewPanel(true);
            // A drag from a selected row carries the whole selection.
            const rows = state.selection.has(rowKey(row)) ? selectedRows() : [row];
            const lists = await Promise.all(rows.map(r => tagsForRow(r)));
            if (session.released) return;
            const tags = dedupeTags(lists.flat());
            const label = rows.length > 1 ? `${rows.length} items` : row.name;

            // Tag groups drop as themselves; holding Alt drops their contents instead.
            // Resolved up front so the Alt swap is instant; reading files mid-drag stalls the ghost. Only tag groups have a second reading — a lora is a lora.
            let altTags = null;
            let altLabel = "";
            let groups = null;
            if (state.tab === "group") {
                const unpacked = await Promise.all(rows.map(r => tagsForRow(r, { unpack: true })));
                if (session.released) return;
                altTags = dedupeTags(unpacked.flat());
                altLabel = `${altTags.length} tag${altTags.length === 1 ? "" : "s"}`;
                // Kept per row as well: a drop that makes categories wants one per group, with its name, which the flattened payload cannot say.
                groups = rows.map((r, i) => ({ name: r.name, tags: unpacked[i] }));
            }

            // The payload is resolved, so the highlight has done its job — carrying it into the drag and leaving it behind afterwards is how it got stuck there.
            clearSelection();

            startExternalDrag({
                tags, label, altTags, altLabel,
                x: session.x,
                y: session.y,
                // Lets a drop inside the sidebar move these entries instead of treating them as tags to save.
                origin: {
                    kind: "sidebar", tab: state.tab, rows, groups,
                    onMove: moveRowsInto,
                    onCanvasDrop,
                },
            });
        };

        trackPress(e, { onDrag: begin, onClick: (ev) => onRowClick(row, ev) });
    });

    el.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onRowActivate(row);
    });
}

/** A click picks, it does not act. Adding is the double click, the menu and the drag, as in a file manager. */
function onRowClick(row, e) {
    focusBody();
    if (handleRowSelect(row, e)) return;
    if (e.ctrlKey || e.metaKey) return;   // the body's guard already toggled it
    selectOnly(row);
}

function selectOnly(row) {
    const key = rowKey(row);
    state.selection = new Set([key]);
    state.anchor = key;
    state.cursor = state.rows.findIndex(r => rowKey(r) === key);
    syncSelectionClasses();
}

async function onRowActivate(row) {
    if (row.type === "folder") {
        // A level-walking view navigates into it; list view expands it where it is.
        if (walksLevels(state.view[state.tab])) {
            state.crumb[state.tab] = row.path;
            state.cursor = -1;
            render();
        } else {
            toggleFolder(row.path);
        }
        return;
    }
    const tags = await tagsForRow(row, { unpack: true });
    if (!tags.length) {
        toast("warn", "Empty tag group", `'${row.name}' has no tags.`, 4000);
        return;
    }
    createNodeWithTags(tags);
}

function toggleFolder(path) {
    const set = state.expanded[state.tab];
    if (set.has(path)) set.delete(path);
    else set.add(path);
    persistExpanded();
    render();
}

// Drops In Tree

/** Two gestures land here: entries dragged within the sidebar move into the folder, pills dragged out of a node open the editor. */
async function onSidebarDrop(tags, folderPath, sourceNode, origin) {
    if (origin?.kind === "sidebar") {
        await origin.onMove?.(origin.rows, folderPath, origin.tab);
        return;
    }
    if (state.tab !== "group") {
        toast("warn", "Switch to Tag Groups", "Tags can only be saved into the Tag Groups tab.", 4000);
        return;
    }

    // Straight into the editor rather than a name prompt: no reason to commit to a filename before seeing the group. The editor unpacks nested groups itself.
    openEditor({
        mode: "new",
        folder: folderPath,
        name: "",
        tags: tags.map(t => ({ ...t })),
    });
}

/** Move dragged sidebar entries into a folder (tag groups only). */
async function moveRowsInto(rows, folderPath, tab) {
    if (tab !== "group") return;   // model files are ComfyUI's to organise
    let moved = 0;
    const repaths = [];
    for (const row of rows) {
        if (!isRealMove(row, folderPath)) continue;
        const result = await postJson("/erenodes/move_path", {
            path: pathWithExtension(row),
            toFolder: folderPath,
        }, { quiet: true });
        if (result?.ok && !result.unchanged) {
            moved++;
            repaths.push([row.path, folderPath ? `${folderPath}/${row.name}` : row.name]);
        }
    }
    await repathBookmarksAll(repaths);
    // A drop that moved nothing leaves the tree as it was; re-reading it only flickers.
    if (!moved) return;
    toast("success", "Moved", `${moved} item(s) moved to ${folderPath || "the root folder"}.`, 3500);
    clearSelection();
    await refresh();
}

// Inline Naming
// In the row, Explorer style: a modal prompt interrupts a gesture that already said where.

/** Replace a label with an input until the user commits or cancels. */
function inlineEdit(labelEl, value, { onCommit, onCancel } = {}) {
    if (!labelEl?.parentElement) return null;

    const input = el("input", "ere-sb-inline");
    input.type = "text";
    input.value = value;
    input.spellcheck = false;
    labelEl.style.display = "none";
    labelEl.parentElement.insertBefore(input, labelEl.nextSibling);

    let settled = false;
    const finish = (commit) => {
        if (settled) return;
        settled = true;
        const next = input.value.trim();
        input.remove();
        labelEl.style.display = "";
        if (commit && next && next !== value) onCommit?.(next);
        else onCancel?.();
    };

    /** The row underneath listens for presses (drag, selection, marquee); a click inside the input is none of those. */
    for (const type of ["pointerdown", "click", "dblclick", "contextmenu"]) {
        input.addEventListener(type, e => e.stopPropagation());
    }
    input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(false));

    input.focus();
    // Select the stem, not the extension — the part anyone actually retypes.
    const stem = value.lastIndexOf(".");
    if (stem > 0) input.setSelectionRange(0, stem);
    else input.select();
    return input;
}

/** The rendered element for a row, in whichever view is showing. */
function rowElement(row) {
    const key = rowKey(row);
    return [...(state.host?.querySelectorAll("[data-ere-key]") || [])]
        .find(el => el.dataset.ereKey === key) || null;
}

/** Dropping a generated image on the tree: extract, then open the editor. One of exactly two places that extract — the editor's pane only sets a cover. */
function attachImageDrop(content) {
    let zone = null;
    const mark = (next) => {
        if (zone === next) return;
        zone?.classList.remove("ere-sb-drop-target");
        zone = next || null;
        zone?.classList.add("ere-sb-drop-target");
    };
    // `files` is empty until the drop lands; `types` is what dragover can see.
    const carriesFile = (dt) => !!dt && [...(dt.types || [])].includes("Files");
    const folderAt = (e) =>
        e.target?.closest?.("[data-ere-sidebar-drop]")?.dataset?.erePath ?? "";

    content.addEventListener("dragover", (e) => {
        if (state.tab !== "group" || !carriesFile(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        mark(e.target?.closest?.("[data-ere-sidebar-drop]") || content);
    });
    content.addEventListener("dragleave", (e) => {
        if (e.target === content || !content.contains(e.relatedTarget)) mark(null);
    });
    content.addEventListener("drop", async (e) => {
        if (state.tab !== "group" || !carriesFile(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        const folder = folderAt(e);
        mark(null);

        const file = e.dataTransfer.files?.[0];
        if (!file) return;
        if (!isAcceptedImage(file)) {
            toast("error", "Unsupported file", `${file.name} is not a PNG, JPEG or WebP.`, 5000);
            return;
        }

        let tags = [];
        try {
            tags = tagsFromResult(await extractFromImage(file));
        } catch (err) {
            console.error("[EreNodes] Sidebar extraction failed.", err);
            toast("error", "Extraction failed", err.message, 5000);
            return;
        }
        if (!tags.length) {
            // Open anyway.
            // The cover is still useful, and discarding it means doing the drop twice.
            toast("warn", "No prompt found", "The image had no readable prompt. Its cover was kept — drag tags in.", 6000);
        }
        forgetVerdicts(tags);
        openEditor({
            mode: "new",
            folder,
            // Not from the filename: ComfyUI output names are timestamps.
            name: "",
            tags,
            coverFile: file,
        });
    });
}

/**
 * Register an element as a drop destination for the drag layer.
 * @param {boolean} [moves] whether entries dragged within the sidebar may move here. False for the background, which takes tags from a node but must not swallow a move into root.
 */
function markDropFolder(el, path, { moves = true } = {}) {
    el.dataset.ereSidebarDrop = "1";
    el.dataset.erePath = path;
    el._ereSidebarDrop = onSidebarDrop;
    el._ereSidebarAccepts = (origin) =>
        origin?.kind !== "sidebar" || (moves && canMoveInto(origin.rows, path, origin.tab));
}

/** Folder an entry currently lives in. */
function parentFolderOf(path) {
    const cut = String(path || "").lastIndexOf("/");
    return cut === -1 ? "" : path.slice(0, cut);
}

/** True when at least one row would actually go somewhere. */
function canMoveInto(rows, folderPath, tab) {
    if (tab !== "group") return false;   // model files are ComfyUI's to organise
    return (rows || []).some(row => isRealMove(row, folderPath));
}

/** A move is real only if it changes where the entry lives; ordering is alphabetical, and a folder cannot move into its own subtree. */
function isRealMove(row, folderPath) {
    if (row.path === folderPath) return false;
    if (parentFolderOf(row.path) === folderPath) return false;
    if (row.type === "folder" && `${folderPath}/`.startsWith(`${row.path}/`)) return false;
    return true;
}

// Rendering
// Mirrors the Nodes sidebar: a flat <ul role="tree"> of Tailwind-styled rows.

// A 36k-entry library is one flow of identical lines, so only the lines in view need to exist: the rest is two spacers standing in for their height.

// Below this many items the window costs more than it saves, and a plain flow keeps small lists byte-identical to what they were.
const WINDOW_MIN = 150;

/**
 * Paint `items` into `container`, keeping only the visible lines in the DOM.
 * Items must all draw at the same height; `perLine` is 1 for a list, or a function giving the column count for a grid, since that follows the panel's width.
 * @param {HTMLElement} scroller  the element that scrolls
 * @param {Array<{row: object, make: function}>} items
 * @returns {{repaint: function, indexOf: function, scrollToIndex: function, destroy: function}}
 */
function windowFlow(scroller, container, items, { lineHeight, perLine = 1, spanColumns = false, onMeasure = null } = {}) {
    if (items.length < WINDOW_MIN || !lineHeight) {
        const frag = document.createDocumentFragment();
        for (const item of items) frag.appendChild(item.make(item.row));
        container.appendChild(frag);
        return plainHandle(container, items);
    }

    const anchor = document.createElement("li");
    const top = document.createElement("li");
    const bottom = document.createElement("li");
    for (const spacer of [anchor, top, bottom]) {
        spacer.setAttribute("aria-hidden", "true");
        spacer.style.flex = "0 0 auto";
        if (spanColumns) spacer.style.gridColumn = "1 / -1";
    }
    container.append(anchor, top, bottom);

    let height = lineHeight;
    let columns = 1;
    let painted = null;
    let queued = false;
    let alive = true;

    const lines = () => Math.ceil(items.length / columns);

    // Where the window's first line sits inside the scrolled content. The anchor never changes size, so this stays valid while the spacers do.
    const originTop = () =>
        anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

    function paint() {
        if (!alive) return;
        const next = typeof perLine === "function" ? Math.max(1, perLine()) : perLine;
        if (next !== columns) { columns = next; painted = null; }
        const above = Math.max(0, scroller.scrollTop - originTop());
        const firstLine = Math.max(0, Math.floor(above / height) - 4);
        const lineCount = Math.ceil(scroller.clientHeight / height) + 8;
        const from = firstLine * columns;
        const to = Math.min(items.length, (firstLine + lineCount) * columns);
        if (painted && painted[0] === from && painted[1] === to) return;
        painted = [from, to];

        while (top.nextSibling && top.nextSibling !== bottom) top.nextSibling.remove();
        const frag = document.createDocumentFragment();
        for (let i = from; i < to; i++) frag.appendChild(items[i].make(items[i].row));
        container.insertBefore(frag, bottom);

        top.style.height = `${firstLine * height}px`;
        bottom.style.height = `${Math.max(0, (lines() - Math.ceil(to / columns)) * height)}px`;

        // The first paint is also the measurement: row height comes from the theme, not from us.
        const first = top.nextSibling;
        if (first && first !== bottom) {
            const measured = first.getBoundingClientRect().height;
            if (measured && Math.abs(measured - height) > 0.5) {
                height = measured;
                onMeasure?.(measured);
                painted = null;
                paint();
            }
        }
    }

    const onScroll = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => { queued = false; paint(); });
    };

    scroller.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(onScroll);
    resize.observe(scroller);
    paint();

    return {
        repaint: () => { painted = null; paint(); },
        indexOf: (match) => items.findIndex(item => match(item.row)),
        scrollToIndex(index) {
            if (index < 0 || index >= items.length) return;
            const line = Math.floor(index / columns);
            const lineTop = originTop() + line * height;
            const viewTop = scroller.scrollTop;
            const viewBottom = viewTop + scroller.clientHeight;
            if (lineTop >= viewTop && lineTop + height <= viewBottom) return;
            scroller.scrollTop = lineTop < viewTop ? lineTop : lineTop - scroller.clientHeight + height;
            paint();
        },
        destroy() {
            alive = false;
            scroller.removeEventListener("scroll", onScroll);
            resize.disconnect();
        },
    };
}

function plainHandle(container, items) {
    return {
        repaint: () => {},
        indexOf: (match) => items.findIndex(item => match(item.row)),
        scrollToIndex(index) {
            const child = container.children[index];
            child?.scrollIntoView?.({ block: "nearest" });
        },
        destroy: () => {},
    };
}

/** Columns a grid of `tileWidth` tiles fits, matching `repeat(auto-fill, ...)` in the stylesheet. */
function gridColumns(container, tileWidth, gap) {
    const style = getComputedStyle(container);
    const inner = container.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
    return Math.max(1, Math.floor((inner + gap) / (tileWidth + gap)));
}


function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
}

/** One tree row, in the Nodes sidebar's markup. Flat list: hierarchy is padding-left, 8px at level 1 then +24px. */
function makeTreeRow(row, { open = false } = {}) {
    const isFolder = row.type === "folder";

    const item = el("li", `${ROW_CLASS}${row.divider ? " ere-sb-divider" : ""}`);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.level));
    item.setAttribute("aria-selected", String(state.selection.has(rowKey(row))));
    item.dataset.indent = String(row.level);
    item.dataset.ereKey = rowKey(row);
    if (state.selection.has(item.dataset.ereKey)) item.classList.add("ere-sb-selected");
    item.tabIndex = -1;
    item.style.paddingLeft = `${8 + (row.level - 1) * 24}px`;

    if (isFolder) {
        // No chevron where a folder is entered rather than unfolded.
        if (!walksLevels(state.view[state.tab])) {
            item.setAttribute("aria-expanded", String(open));
            if (open) item.dataset.expanded = "";
            const chevron = el("i",
                `icon-[lucide--chevron-right] ${ROW_ICON} transition-transform ${open ? "rotate-90" : ""}`, item);
            chevron.addEventListener("pointerdown", e => e.stopPropagation());
            chevron.addEventListener("click", (e) => {
                e.stopPropagation();
                toggleFolder(row.path);
            });
        }
        // The bookmark folder is a view, not a place: nothing can be moved into it.
        if (!row.bookmarkRoot) markDropFolder(item, row.path);
    }

    el("i", `${isFolder ? "icon-[lucide--folder]" : fileIcon(row)} ${ROW_ICON}`, item);

    const label = el("span", ROW_LABEL, item);
    label.dataset.ereLabel = "";     // inlineEdit swaps this for an input
    label.textContent = row.name;

    if (isFolder && row.count) {
        // Same gap from the edge as the bookmark button that takes this place on a file row.
        const badge = el("span", `${COUNT_CLASS} mr-1.5`, item);
        badge.textContent = String(row.count);
    }

    if (!isFolder && bookmarksApply()) item.appendChild(bookmarkButton(row.path));

    attachPress(item, row);
    attachHover(item, row);
    item.addEventListener("contextmenu", e => openRowMenu(row, e));
    return item;
}

function bookmarkButton(path) {
    const on = isBookmarked(path);
    const btn = el("button", `ere-sb-bookmark ${on ? "ere-sb-bookmark-on" : ""}`);
    btn.type = "button";
    btn.title = on ? "Remove bookmark" : "Bookmark";
    btn.setAttribute("aria-label", btn.title);
    btn.setAttribute("aria-pressed", String(on));
    el("i", `pi ${on ? "pi-bookmark-fill" : "pi-bookmark"}`, btn);
    btn.addEventListener("pointerdown", e => e.stopPropagation());
    // Without this, a second click inside the double-click window reaches the row and adds the group to the graph.
    btn.addEventListener("dblclick", (e) => { e.stopPropagation(); e.preventDefault(); });
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        toggleBookmark(path);
    });
    return btn;
}

/** Leaf icon per tab — only icons the frontend compiles may be used. */
function fileIcon(row) {
    return row.tab === "group" ? "icon-[lucide--tag]" : "icon-[lucide--box]";
}

function collectRows(node, items, searching, level = 1) {
    for (const folder of node.folders || []) {
        // While searching, every surviving branch is opened so hits are visible.
        const open = searching || state.expanded[state.tab].has(folder.path);
        addRow(items, {
            type: "folder", name: folder.name, path: folder.path,
            tab: state.tab, count: countLeaves(folder), level,
        }, r => makeTreeRow(r, { open }));
        if (open) collectRows(folder, items, searching, level + 1);
    }
    for (const file of node.files || []) addRow(items, fileRowFor(file, level), r => makeTreeRow(r));
}

/** The pixel box for an item tile, from the size and ratio toggles. */
function tileBox() {
    return tileBoxFor(state.tileSize[state.tab], state.tileRatio[state.tab]);
}

function makeTile(row) {
    const wrap = el("li", "ere-sb-tile");
    wrap.dataset.ereKey = rowKey(row);
    if (state.selection.has(wrap.dataset.ereKey)) wrap.classList.add("ere-sb-selected");

    if (row.type === "file" && bookmarksApply()) wrap.appendChild(bookmarkButton(row.path));

    if (row.type === "folder") {
        // Size comes from the grid, so folder and file tiles occupy identical cells.
        wrap.classList.add("ere-sb-folder-tile");
        el("i", "icon-[lucide--folder] size-8 text-muted-foreground", wrap);
        const name = el("div", "ere-sb-tile-name", wrap);
        name.dataset.ereLabel = "";
        name.textContent = row.name;
        if (row.count) {
            const badge = el("span", `${COUNT_CLASS} ere-sb-tile-badge`, wrap);
            badge.textContent = String(row.count);
        }
        // The bookmark folder is a view, not a place: nothing can be moved into it.
        if (!row.bookmarkRoot) markDropFolder(wrap, row.path);
    } else {
        // Same tile the Gallery node draws, so grid view matches the canvas. Unsized: the cell is what sets its box.
        wrap.appendChild(renderTagTile({ name: row.path, type: row.tab, active: true, extension: row.extension }, { stripFolders: true }));
    }

    attachPress(wrap, row);
    attachHover(wrap, row);
    wrap.addEventListener("contextmenu", e => openRowMenu(row, e));
    return wrap;
}

function renderBreadcrumb(container, path) {
    const bar = el("div", "ere-sb-crumbs", container);
    const crumbs = [{ name: activeTab().label, path: "" }];
    if (path === BOOKMARK_PATH) {
        crumbs.push({ name: "Bookmarks", path: BOOKMARK_PATH, virtual: true });
    } else {
        let acc = "";
        for (const part of (path ? path.split("/") : [])) {
            acc = acc ? `${acc}/${part}` : part;
            crumbs.push({ name: part, path: acc });
        }
    }
    crumbs.forEach((crumb, i) => {
        if (i) el("i", "icon-[lucide--chevron-right] size-3 shrink-0 opacity-50", bar);
        const button = el("button", "ere-sb-crumb", bar);
        button.type = "button";
        button.textContent = crumb.name;
        // Dropping onto a breadcrumb moves entries up a level.
        if (!crumb.virtual) markDropFolder(button, crumb.path);
        button.addEventListener("click", () => {
            state.crumb[state.tab] = crumb.path;
            render();
        });
        bar.appendChild(button);
    });
}

/** Record a row and how to draw it. The window decides which ones are built. */
function addRow(items, row, make) {
    state.rows.push(row);
    items.push({ row, make });
    return row;
}

/** Hand a section to the window, replacing whatever the previous render mounted. */
function mountFlow(body, container, items, opts) {
    state.flows.push(windowFlow(body, container, items, opts));
}

function render() {
    const host = state.host;
    const body = host?.querySelector(".ere-sb-body-inner");
    if (!body) return;

    for (const flow of state.flows) flow.destroy();
    state.flows = [];
    body.textContent = "";
    state.rows = [];


    const tree = state.trees[state.tab];
    if (state.loading || !tree) {
        const msg = el("div", "ere-sb-empty", body);
        msg.textContent = state.loading ? "Loading…" : "";
        return;
    }

    const query = state.query.trim().toLowerCase();
    const view = state.view[state.tab];
    const deep = !!query && deepSearchActive();

    // A build with a query waiting on it: the list cannot be drawn yet, and an empty one would read as "no matches", which is a different and wrong answer.
    if (deep && state.indexBusy) {
        body.appendChild(indexingMessage());
        return;
    }

    // A build with nothing waiting on it, the usual case: a strip above the tree rather than a takeover, since there is no reason to stop browsing while it runs.
    if (deepSearchActive() && state.indexBusy) body.appendChild(indexingBanner());

    // The answer on hand belongs to a query the user has already typed past.
    if (deep && state.tagResults?.query !== state.query.trim()) {
        body.appendChild(
            statusMessage("pi-search", "Searching tags…", `Looking for "${query}" in the tag index.`).wrap);
        return;
    }

    // A rebuild is the one action that fixes most of the reasons for this.
    if (deep && state.tagResults.failed) {
        const { wrap, inner } = statusMessage("pi-exclamation-triangle", "Tag search unavailable",
            "The tag index could not be queried. Check the ComfyUI console for the reason.");
        inner.appendChild(rebuildIndexButton());
        body.appendChild(wrap);
        return;
    }

    // "1girl" legitimately matches most of a character library, so the server caps what it sends rather than shipping the collection back to filter a tree the client holds.
    if (deep && state.tagResults.truncated) {
        const note = el("div", "px-3 pt-2 text-xs text-muted-foreground", body);
        note.textContent = `Showing the first ${state.tagResults.paths.size.toLocaleString()} matches — narrow the query with another term.`;
    }

    let filtered;
    if (!query) filtered = tree;
    else if (deep) filtered = filterTreeByPaths(tree, state.tagResults.paths);
    else filtered = filterTree(tree, tokenize(query));

    if (view === "grid") {
        // Search flattens: browsing by folder while filtering makes no sense.
        const path = query ? "" : (state.crumb[state.tab] || "");
        // At the root the bar is one dead crumb naming the tab already on screen.
        if (path) renderBreadcrumb(body, path);

        // The virtual folder is a level of its own: navigating into it shows every bookmark, wherever it lives.
        const inBookmarks = path === BOOKMARK_PATH;
        const level = inBookmarks ? { folders: [], files: bookmarkedFiles() }
            : query ? flatten(filtered) : nodeAtPath(filtered, path);
        const { width, height } = tileBox();

        // Two grids, so folders keep their own row rather than sitting beside items twice their size. `ere-surface` on each, since the tiles are the Gallery node's own.
        let tiles = 0;
        const folderRows = [...(level.folders || [])];
        const showBookmarkTile = !query && !path && bookmarkedFiles().length;
        if (folderRows.length || showBookmarkTile) {
            const folders = gridBox(body, TILE_SIZE, TILE_SIZE);
            const items = [];
            if (showBookmarkTile) addRow(items, bookmarkRow(), r => makeTile(r));
            for (const folder of folderRows) {
                addRow(items, {
                    type: "folder", name: folder.name, path: folder.path,
                    tab: state.tab, count: countLeaves(folder),
                }, r => makeTile(r));
            }
            tiles += items.length;
            mountFlow(body, folders, items, {
                lineHeight: TILE_SIZE + TILE_GAP,
                perLine: () => gridColumns(folders, TILE_SIZE, TILE_GAP),
                spanColumns: true,
            });

        }

        // Bookmarks lead the results while searching, as they do in list view.
        const marked = query && bookmarksApply() ? (level.files || []).filter(f => isBookmarked(f.path)) : [];
        const remaining = marked.length
            ? (level.files || []).filter(f => !isBookmarked(f.path))
            : (level.files || []);
        if (marked.length) {
            const grid = gridBox(body, width, height);
            const items = [];
            for (const file of marked) addRow(items, tileRowFor(file), r => makeTile(r));
            tiles += items.length;
            mountFlow(body, grid, items, {
                lineHeight: height + TILE_GAP,
                perLine: () => gridColumns(grid, width, TILE_GAP),
                spanColumns: true,
            });
            if (remaining.length) el("div", "ere-sb-rule", body);
        }

        if (remaining.length) {
            const files = gridBox(body, width, height);
            const items = [];
            for (const file of remaining) addRow(items, tileRowFor(file), r => makeTile(r));
            tiles += items.length;
            mountFlow(body, files, items, {
                lineHeight: height + TILE_GAP,
                perLine: () => gridColumns(files, width, TILE_GAP),
                spanColumns: true,
            });
        }
        if (!tiles) body.appendChild(emptyMessage(query, deep));
    } else if (view === "folder") {
        // One level at a time like grid, drawn as rows like list.
        const path = query ? "" : (state.crumb[state.tab] || "");
        if (path) renderBreadcrumb(body, path);

        const inBookmarks = path === BOOKMARK_PATH;
        const level = inBookmarks ? { folders: [], files: bookmarkedFiles() }
            : query ? flatten(filtered) : nodeAtPath(filtered, path);

        const list = el("ul", TREE_CLASS, body);
        list.setAttribute("role", "tree");
        list.setAttribute("aria-label", activeTab().label);

        const items = [];
        if (!query && !path && bookmarkedFiles().length) addRow(items, bookmarkRow(1), r => makeTreeRow(r));
        for (const folder of level.folders || []) {
            addRow(items, {
                type: "folder", name: folder.name, path: folder.path,
                tab: state.tab, count: countLeaves(folder), level: 1,
            }, r => makeTreeRow(r));
        }

        const files = level.files || [];
        const marked = query && bookmarksApply() ? files.filter(f => isBookmarked(f.path)) : [];
        const rest = marked.length ? files.filter(f => !isBookmarked(f.path)) : files;
        for (const file of marked) addRow(items, fileRowFor(file, 1, true), r => makeTreeRow(r));
        rest.forEach((file, i) => addRow(items, { ...fileRowFor(file, 1), divider: marked.length > 0 && i === 0 }, r => makeTreeRow(r)));
        mountFlow(body, list, items, { lineHeight: rowHeight(), onMeasure: setRowHeight });

        if (!state.rows.length) body.appendChild(emptyMessage(query, deep));
    } else {
        const list = el("ul", TREE_CLASS, body);
        list.setAttribute("role", "tree");
        list.setAttribute("aria-label", activeTab().label);
        const items = [];
        if (query) {
            // Matches only, no folder rows: the path to a hit is noise when you are searching for the hit.
            const files = flatten(filtered).files;
            const marked = bookmarksApply() ? files.filter(f => isBookmarked(f.path)) : [];
            const rest = marked.length ? files.filter(f => !isBookmarked(f.path)) : files;
            for (const file of marked) addRow(items, fileRowFor(file, 1, true), r => makeTreeRow(r));
            rest.forEach((file, i) => addRow(items, { ...fileRowFor(file, 1), divider: marked.length > 0 && i === 0 }, r => makeTreeRow(r)));
        } else {
            collectBookmarkFolder(items);
            collectRows(filtered, items, false);
        }
        mountFlow(body, list, items, { lineHeight: rowHeight(), onMeasure: setRowHeight });
        if (!state.rows.length) body.appendChild(emptyMessage(query, deep));
    }

    // Rows are rebuilt on every render, so the cursor is re-found rather than carried as an index.
    state.cursor = state.anchor ? state.rows.findIndex(r => rowKey(r) === state.anchor) : -1;
    syncSelectionClasses();
}

/** A file's row. `bookmarkCopy` marks the one drawn in the Bookmarks section, which needs a key of its own: the same path is also drawn in the tree, and two rows sharing a key make the cursor jump between them. */
function fileRowFor(file, level, bookmarkCopy = false) {
    return {
        type: "file", name: file.name, path: file.path,
        extension: file.extension, image: !!file.image, tab: state.tab, level, bookmarkCopy,
    };
}

function tileRowFor(file) {
    return {
        type: "file", name: file.name, path: file.path,
        extension: file.extension, image: !!file.image, tab: state.tab,
    };
}

/** A grid container, sized from the tile box. */
function gridBox(body, width, height) {
    const grid = el("ul", `ere-sb-grid ${SURFACE_CLASS}`, body);
    grid.setAttribute("role", "tree");
    grid.setAttribute("aria-label", activeTab().label);
    grid.style.setProperty("--ere-tile-gap", `${TILE_GAP}px`);
    grid.style.setProperty("--ere-tile-w", `${width}px`);
    grid.style.setProperty("--ere-tile-h", `${height}px`);
    return grid;
}

// Measured from a real row on the first windowed paint; this is only the starting guess.
let measuredRowHeight = 36;

function rowHeight() {
    return measuredRowHeight;
}

function setRowHeight(height) {
    measuredRowHeight = height;
}

/** Bookmarked groups resolved against the tree. Missing ones are skipped: a group deleted outside ComfyUI should not need pruning by hand. */
// Cached against the tree and the list it was built from, since a render asks for it once per section and resolving walks the whole tree.
let bookmarkedCache = null;

function bookmarkedFiles() {
    if (!bookmarksApply() || !state.bookmarks.length) return [];
    const tree = state.trees[state.tab];
    if (!tree) return [];
    if (bookmarkedCache?.tree === tree && bookmarkedCache.list === state.bookmarks) return bookmarkedCache.files;

    const byPath = new Map();
    (function walk(node) {
        for (const folder of node.folders || []) walk(folder);
        for (const file of node.files || []) byPath.set(file.path, file);
    })(tree);

    const files = state.bookmarks.map(p => byPath.get(p)).filter(Boolean);
    bookmarkedCache = { tree, list: state.bookmarks, files };
    return files;
}

function bookmarkRow(level) {
    return {
        type: "folder", name: "Bookmarks", path: BOOKMARK_PATH,
        tab: state.tab, count: bookmarkedFiles().length, level, bookmarkRoot: true,
    };
}

/** The virtual folder above the tree, in list view. */
function collectBookmarkFolder(items) {
    const found = bookmarkedFiles();
    if (!found.length) return;

    const open = state.expanded[state.tab].has(BOOKMARK_PATH);
    addRow(items, bookmarkRow(1), r => makeTreeRow(r, { open }));
    if (!open) return;
    for (const file of found) addRow(items, fileRowFor(file, 2, true), r => makeTreeRow(r));
}

/** Collapse a filtered tree to a single flat level (grid view while searching). */
function flatten(node, out = { folders: [], files: [] }) {
    for (const folder of node.folders || []) flatten(folder, out);
    for (const file of node.files || []) out.files.push(file);
    return out;
}

/** The frontend's own empty state, class for class (see the Workflows tab). Also the shell for the index's progress and error states. */
function statusMessage(iconName, heading, body) {
    const wrap = el("div", "no-results-placeholder h-full p-8");
    const inner = el("div", "flex flex-col items-center bg-(--surface-ground) text-center", wrap);

    el("i", `pi ${iconName} mb-4 text-5xl`, inner);
    el("h3", "mb-2 text-base-foreground", inner).textContent = heading;

    const text = el("p", "mb-4 text-center whitespace-pre-line", inner);
    text.textContent = body;
    return { wrap, inner };
}

function emptyMessage(query, deep = false) {
    const heading = query ? "No matches" : "Empty";
    let detail;
    if (!query) detail = `No ${activeTab().label.toLowerCase()} here yet.`;
    // In tag mode the question behind an empty result is what the index actually covers.
    else if (deep) {
        const indexed = state.indexStatus?.indexed ?? 0;
        detail = `No tag group contains "${query}".\n${indexed.toLocaleString()} groups indexed.`;
    } else detail = `Nothing matches "${query}".`;

    const { wrap, inner } = statusMessage(query ? "pi-search" : "pi-folder", heading, detail);
    if (deep) inner.appendChild(rebuildIndexButton());
    return wrap;
}

/**
 * Build progress, in two shapes. `total` counts the files that need re-reading, not the collection, so the fraction is how much work is left rather than how big the library is; before the scan has produced one the bar sweeps instead of sitting at 0%.
 * Both carry `data-ere-index-progress`, which is what lets the poll loop update them in place rather than re-rendering thousands of rows to move two numbers.
 */
function progressParts(parent) {
    const label = el("span", "min-w-0 flex-1 truncate", parent);
    label.dataset.ereIndexLabel = "";
    const track = el("div", "ere-sb-progress", parent);
    el("div", "ere-sb-progress-fill", track);
    return parent;
}

function fillIndexProgress(root, status) {
    const total = status.total || 0;
    const done = Math.min(status.done || 0, total);
    const scanning = !total || status.phase === "scanning";

    const label = root.querySelector("[data-ere-index-label]");
    if (label) {
        label.textContent = scanning
            ? "Building tag index — looking for what changed…"
            : `Building tag index — ${done.toLocaleString()} of ${total.toLocaleString()}`;
    }
    const fill = root.querySelector(".ere-sb-progress-fill");
    if (!fill) return;
    fill.classList.toggle("ere-sb-progress-idle", scanning);
    fill.style.width = scanning ? "" : `${Math.round((done / total) * 100)}%`;
}

/** The strip above the tree, for a build nothing is waiting on. */
function indexingBanner() {
    const wrap = el("div", "ere-sb-index-banner");
    wrap.dataset.ereIndexProgress = "";
    const line = el("div", "flex items-center gap-2 text-muted-foreground", wrap);
    el("i", "pi pi-spin pi-spinner", line).style.fontSize = ".75rem";
    progressParts(line);
    // The bar belongs under the whole line, not squeezed into it beside the text.
    wrap.appendChild(line.querySelector(".ere-sb-progress"));
    fillIndexProgress(wrap, state.indexStatus || {});
    return wrap;
}

/** The full-panel version, for a build a query is waiting on. */
function indexingMessage() {
    const { wrap, inner } = statusMessage("pi-spin pi-spinner", "Building tag index",
        "The first build reads every group once; later ones only re-read what changed.");
    const strip = el("div", "mt-4 flex w-full max-w-64 flex-col items-center gap-2 text-xs text-muted-foreground", inner);
    strip.dataset.ereIndexProgress = "";
    progressParts(strip);
    fillIndexProgress(strip, state.indexStatus || {});
    // The card is the thing that gets appended; the poller finds the strip inside it.
    wrap.dataset.ereIndexHost = "";
    return wrap;
}

/** Update whichever progress shape is on screen, in place. If neither is, the next full render draws whatever is true then. */
function refreshIndexProgress() {
    const host = state.host?.querySelector("[data-ere-index-progress]");
    if (host) fillIndexProgress(host, state.indexStatus || {});
}

/** Offered wherever the index might be the reason a search came back empty. */
function rebuildIndexButton() {
    const button = el("button",
        "mt-4 cursor-pointer rounded-md border-none bg-secondary-background px-3 py-2 "
        + "text-sm font-medium text-base-foreground hover:bg-secondary-background-hover");
    button.type = "button";
    button.textContent = "Rebuild index";
    button.title = "Re-read every tag group from disk";
    button.addEventListener("click", async () => {
        await ensureIndex({ rebuild: true });
        if (state.tagSearch) runTagSearch();
    });
    return button;
}

// Row Context Menu

/** Prompt node types offered by the row menu, in node-picker order. */
const NODE_TYPES = [
    ["Prompt Cloud", "ErePromptCloud"],
    ["Prompt Toggle", "ErePromptToggle"],
    ["Prompt Multi Select", "ErePromptMultiSelect"],
    ["Prompt Randomizer", "ErePromptRandomizer"],
    ["Prompt Gallery", "ErePromptGallery"],
    ["Prompt Composer", "ErePromptComposer"],
];

/** "Add as" plus one flyout entry per node type. `collect` resolves the tags on demand. */
function addAsMenuItem(label, collect) {
    return {
        name: label,
        submenu: NODE_TYPES.map(([title, type]) => ({
            name: title,
            callback: async () => {
                const tags = await collect();
                if (tags.length) createNodeWithTags(tags, type);
            },
        })),
    };
}

function openRowMenu(row, e) {
    e.preventDefault();
    e.stopPropagation();
    hidePreviewPanel(true);

    // Where the click happened: a menu at the row's corner feels detached from the gesture.
    const anchor = { clientX: e.clientX, clientY: e.clientY };

    // Inside a multi-selection acts on the whole set; outside one clears it.
    if (state.selection.size > 1) {
        if (state.selection.has(rowKey(row))) return openSelectionMenu(anchor);
        clearSelection();
    }

    // A view rather than a place: it can be emptied, but not renamed, deleted or added to.
    if (row.bookmarkRoot) {
        return new ActionContextMenu(anchor, "Bookmarks", [
            { name: "Remove All Bookmarks", callback: () => removeAllBookmarks() },
        ]);
    }

    // Expanded, like click-to-add — see onRowActivate.
    const actions = [addAsMenuItem("Add as", () => tagsForRow(row, { unpack: true }))];

    if (row.type === "file" && bookmarksApply()) {
        actions.push(null);
        actions.push({
            name: isBookmarked(row.path) ? "Remove Bookmark" : "Bookmark",
            callback: () => toggleBookmark(row.path),
        });
    }

    // A preview image is ours to write for every type — the node quick edit already sets them for
    // loras and embeddings. The name says which of the two things it will do.
    if (row.type === "file") {
        actions.push(null);
        actions.push({
            name: row.image ? "Replace Image" : "Set Image",
            callback: () => setFileImage(row),
        });
    }

    // Only tag groups are ours to rewrite; model files belong to ComfyUI.
    if (row.tab === "group") {
        actions.push(null);   // separator
        if (row.type === "file") {
            actions.push({ name: "Edit tag group", callback: () => editTagGroup(row) });
        }
        actions.push({ name: "New tag group here", callback: () => newTagGroup(folderOf(row)) });
        actions.push({ name: "New folder here", callback: () => createFolder(folderOf(row)) });
        actions.push({ name: "Rename", callback: () => renameRow(row) });
        actions.push({ name: "Delete", callback: () => deleteRow(row) });
    }

    // The constructor shows the menu itself.
    new ActionContextMenu(anchor, row.name || row.path, actions);
}

/** Bulk actions for a multi-row selection. */
function openSelectionMenu(anchor) {
    const rows = selectedRows();
    if (!rows.length) return;

    const collect = async () => {
        const lists = await Promise.all(rows.map(r => tagsForRow(r, { unpack: true })));
        return dedupeTags(lists.flat());
    };

    const actions = [addAsMenuItem("Add all as", collect)];

    if (rows.every(r => r.tab === "group")) {
        actions.push(null);
        actions.push({ name: "Delete selected", callback: () => deleteRows(rows) });
    }

    new ActionContextMenu(anchor, `${rows.length} items selected`, actions);
}

async function deleteRows(rows) {
    if (!await confirmDialog("Delete", `Delete ${rows.length} selected item(s)? This cannot be undone.`)) return;

    let removed = 0;
    const forgotten = [];
    for (const row of rows) {
        const result = await postJson("/erenodes/delete_path", { path: pathWithExtension(row) }, { quiet: true });
        if (!result?.ok) continue;
        removed++;
        forgotten.push([row.path, null]);
    }
    await repathBookmarksAll(forgotten);
    toast(removed === rows.length ? "success" : "warn", "Deleted", `${removed} of ${rows.length} item(s) deleted.`);
    clearSelection();
    await refresh();
}

/** Folder a row lives in (the row itself, when it is a folder). */
function folderOf(row) {
    if (row.type === "folder") return row.path;
    const cut = row.path.lastIndexOf("/");
    return cut === -1 ? "" : row.path.slice(0, cut);
}

/** Right-click on empty space: folder management for the current level. */
function openBackgroundMenu(e) {
    if (state.tab !== "group") return;   // model folders are ComfyUI's
    e.preventDefault();
    e.stopPropagation();
    hidePreviewPanel(true);

    let here = walksLevels(state.view[state.tab]) ? (state.crumb[state.tab] || "") : "";
    if (here === BOOKMARK_PATH) here = "";   // a view, with nowhere to create anything
    new ActionContextMenu(
        { clientX: e.clientX, clientY: e.clientY },
        here || "Tag Groups",
        [
            { name: "New tag group", callback: () => newTagGroup(here) },
            { name: "New folder", callback: () => createFolder(here) },
        ]
    );
}

/** Open an empty editor pointed at a folder. */
function newTagGroup(folder = "") {
    openEditor({ mode: "new", folder, name: "", tags: [] });
}

/** New folder: a placeholder row appears, already in edit mode. */
function createFolder(parentPath = "") {
    if (parentPath) {
        state.expanded[state.tab].add(parentPath);
        persistExpanded();
        render();
    }

    const grid = state.host?.querySelector(".ere-sb-grid");
    const list = state.host?.querySelector('[role="tree"]');
    const container = grid || list;
    if (!container) return;

    let placeholder;
    let label;
    if (grid) {
        placeholder = el("div", "ere-sb-tile ere-sb-folder-tile", container);
        el("i", "icon-[lucide--folder] size-8 text-muted-foreground", placeholder);
        label = el("div", "ere-sb-tile-name", placeholder);
    } else {
        placeholder = el("div", ROW_CLASS, container);
        // Same indent maths as makeTreeRow: 8px at level 1, +24px per level.
        const level = parentPath ? parentPath.split("/").length + 1 : 1;
        placeholder.style.paddingLeft = `${8 + (level - 1) * 24}px`;
        el("i", `icon-[lucide--folder] ${ROW_ICON}`, placeholder);
        label = el("span", ROW_LABEL, placeholder);
    }
    label.textContent = "New folder";

    inlineEdit(label, "", {
        onCommit: async (name) => {
            placeholder.remove();
            const result = await postJson("/erenodes/create_folder",
                { path: parentPath, folderName: name });
            if (!result) return;
            // Reveal what was just created.
            const created = parentPath ? `${parentPath}/${name}` : name;
            state.expanded[state.tab].add(created);
            if (parentPath) state.expanded[state.tab].add(parentPath);
            persistExpanded();
            await refresh();
        },
        onCancel: () => placeholder.remove(),
    });
}

function renameRow(row) {
    const element = rowElement(row);
    // `.ere-name` is the caption a file tile draws for itself in grid view.
    const label = element?.querySelector("[data-ere-label]")
        ?? element?.querySelector(".ere-name");
    if (!label) return;

    inlineEdit(label, row.name, {
        onCommit: async (next) => {
            const result = await postJson("/erenodes/rename_path",
                { path: pathWithExtension(row), newName: next });
            if (result?.ok) {
                const parent = row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/") + 1) : "";
                await repathBookmarks(row.path, parent + next.replace(/\.json$/i, ""));
            }
            await refresh();
        },
    });
}

async function deleteRow(row) {
    const what = row.type === "folder" ? `folder "${row.name}" and everything in it` : `"${row.name}"`;
    if (!await confirmDialog("Delete", `Delete ${what}? This cannot be undone.`)) return;
    const result = await postJson("/erenodes/delete_path", { path: pathWithExtension(row) });
    if (result?.ok) await repathBookmarks(row.path, null);
    await refresh();
}

async function setFileImage(row) {
    const file = await pickFile();
    if (!file) return;
    try {
        const result = await saveCover(row.tab, row.path, file);
        toast("success", "Image saved", result?.message);
        render();
    } catch (err) {
        toast("error", "Image failed", err.message, 5000);
    }
}

/** Server paths include the extension; row.path does not (it is the tag name). */
function pathWithExtension(row) {
    return row.type === "folder" ? row.path : row.path + (row.extension || ".json");
}

/** null on failure, so every caller can treat "no result" as "did not happen". */
async function postJson(url, body, { quiet = false } = {}) {
    try {
        return await requestJson(url, { body });
    } catch (e) {
        if (!quiet) toast("error", "Failed", e.message, 5000);
        return null;
    }
}

// Chrome

function buildChrome(host) {
    host.textContent = "";
    // While the editor is open it takes the body, the title and the tool button.
    // The tab strip stays: switching collections discards the editor exactly as Cancel does.
    const editing = !!state.editor;
    // Not `ere-surface`: its `font: 12px monospace` belongs to tag pills, and on the root it cascades over the whole tab.
    // Only the elements that actually render tags opt into it (see the grid below).
    host.className = "comfy-vue-side-bar-container group/sidebar-tab flex size-full flex-col ere-sidebar";

    // Every rebuild throws away the input the autocomplete is driving, and the popover's anchor with it. One place, so no path can leave either holding a detached element.
    detachSearchAutocomplete();
    closeViewMenu();

    const header = el("div", "comfy-vue-side-bar-header flex flex-col", host);

    // Toolbar: title, plus one icon button.
    const toolbar = el("div",
        "flex min-h-16 items-center justify-between border-b border-interface-stroke bg-transparent px-3 2xl:px-4", header);
    toolbar.setAttribute("role", "toolbar");

    const start = el("div", "flex min-w-0 flex-1 items-center overflow-hidden", toolbar);
    const title = el("span", "truncate font-bold", start);
    title.textContent = editing ? state.editor.title : "EreNodes";

    const end = el("div", "", toolbar);

    if (editing) {
        // Always visible: closing is the way out and must not hide behind a hover.
        const close = el("button", BUTTON_CLASS, end);
        close.type = "button";
        close.title = "Close without saving";
        close.setAttribute("aria-label", "Close without saving");
        el("i", "icon-[lucide--x] size-4", close);
        close.addEventListener("click", () => closeEditor());
    } else {
        // Matches Model Library's reveal-on-hover tool button area.
        const tools = el("div",
            "flex flex-row overflow-hidden transition-all duration-200 motion-safe:w-0 motion-safe:opacity-0 motion-safe:group-focus-within/sidebar-tab:w-auto motion-safe:group-focus-within/sidebar-tab:opacity-100 motion-safe:group-hover/sidebar-tab:w-auto motion-safe:group-hover/sidebar-tab:opacity-100 touch:w-auto touch:opacity-100", end);
        const refreshBtn = el("button", BUTTON_CLASS, tools);
        refreshBtn.type = "button";
        refreshBtn.title = "Refresh";
        refreshBtn.setAttribute("aria-label", "Refresh");
        el("i", "icon-[lucide--refresh-cw] size-4", refreshBtn);
        refreshBtn.addEventListener("click", () => refresh());
    }

    // First row: search, or the editor's name field — the same markup minus the magnifier, in the same slot, so the two line up when the panel opens.
    if (editing) header.appendChild(state.editor.nameRow);
    else buildSearchRow(header);

    // A plain bordered div, as the Nodes tab does it: PrimeVue's Divider is lazily injected.
    el("div", "border-t border-dashed border-comfy-input", header);

    // Second row: the tabs, or the editor's cover — both between the same two separators, so the cover reads as its own band. Tabs go while editing: a stray click must not discard it.
    if (editing) {
        header.appendChild(state.editor.coverRow);
        const body = el("div", "comfy-vue-side-bar-body flex h-0 grow flex-col", host);
        body.appendChild(state.editor.body);
        state.editor.focus?.();
        return;
    }

    // Text tabs, not icon buttons: three abstract glyphs were unreadable.
    const tabsRow = el("div", "border-b border-comfy-input p-2 2xl:px-4", header);
    const tablist = el("div", "flex w-full items-center gap-2", tabsRow);
    tablist.setAttribute("role", "tablist");
    for (const tab of TABS) {
        const active = tab.id === state.tab;
        const button = el("button", `${TAB_CLASS} ${active ? TAB_ACTIVE : TAB_INACTIVE}`, tablist);
        button.id = `ere-tab-${tab.id}`;
        button.type = "button";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", String(active));
        button.setAttribute("data-state", active ? "active" : "inactive");
        button.tabIndex = active ? 0 : -1;
        button.textContent = tab.label;
        button.addEventListener("click", () => selectTab(tab.id));
    }

    buildTreeBody(host);
}

function buildSearchRow(header) {
    const top = el("div", "flex items-center gap-2 p-2 2xl:px-4", header);
    const searchOuter = el("div", "min-w-0 flex-1", top);
    const searchBox = el("div",
        "relative flex w-full cursor-text items-center rounded-lg bg-secondary-background text-base-foreground h-8 px-2 py-1.5",
        searchOuter);
    el("i", "pointer-events-none absolute left-2.5 size-4 icon-[lucide--search]", searchBox);
    // pr-6 keeps the text clear of the reset button on the right.
    const search = el("input", "ere-sb-search size-full border-none bg-transparent outline-none pl-8 pr-6 text-xs", searchBox);
    search.type = "text";
    // The placeholder is a free mode indicator: tag mode takes comma-separated tags.
    search.placeholder = deepSearchActive() ? "Search tags (comma separated)..." : "Search...";
    search.value = state.query;
    searchBox.addEventListener("click", () => search.focus());
    if (deepSearchActive()) attachSearchAutocomplete(search);

    // Inline display rather than [hidden], which a display utility would win against.
    const clear = el("button",
        "absolute right-2 flex size-4 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-muted-foreground hover:text-base-foreground",
        searchBox);
    clear.type = "button";
    clear.title = "Clear search";
    clear.setAttribute("aria-label", "Clear search");
    el("i", "icon-[lucide--x] size-3.5", clear);
    const showClear = () => { clear.style.display = search.value ? "flex" : "none"; };
    showClear();

    const applyQuery = () => {
        state.query = search.value;
        // Tag mode renders twice: once pending, once with the answer.
        if (deepSearchActive()) runTagSearch();
        else render();
        // A different list: halfway down thousands of rows looks like nothing was found.
        const body = state.host?.querySelector(".ere-sb-body-inner");
        if (body) body.scrollTop = 0;
    };

    let debounce = 0;
    search.addEventListener("input", () => {
        showClear();
        clearTimeout(debounce);
        debounce = setTimeout(applyQuery, SEARCH_DEBOUNCE_MS);
    });
    clear.addEventListener("click", () => {
        clearTimeout(debounce);
        search.value = "";
        showClear();
        applyQuery();
        search.focus();
    });

    // Same slot and gap as SidebarTopArea's actions, so the buttons sit against the search box exactly as they do in the Assets tab.
    const actions = el("div", "flex shrink-0 items-center gap-2", top);

    // Deep search is a tag-group concept: there is nothing to look inside a .safetensors for.
    // A toggle rather than a prefix: the mode is sticky, and an invisible mode is forgotten.
    if (state.tab === "group") {
        const on = state.tagSearch;
        const tagBtn = el("button", `${BUTTON_SECONDARY} ${on ? "ere-sb-btn-on" : ""}`, actions);
        tagBtn.type = "button";
        tagBtn.title = on
            ? "Searching tags inside groups — click to search names again"
            : "Search tags inside groups (uses the tag index)";
        tagBtn.setAttribute("aria-label", tagBtn.title);
        tagBtn.setAttribute("aria-pressed", String(on));
        // `tag` is one of the lucide icons the frontend compiles; `hash`, the obvious alternative, is not.
        el("i", "icon-[lucide--tag] size-4", tagBtn);
        tagBtn.addEventListener("click", () => setTagSearch(!on));
    }

    // View and tile options, in the Assets tab's settings popover rather than one cycling button per option.
    const viewBtn = el("button", BUTTON_SECONDARY, actions);
    viewBtn.type = "button";
    viewBtn.title = "View settings";
    viewBtn.setAttribute("aria-label", "View settings");
    viewBtn.setAttribute("aria-haspopup", "menu");
    el("i", "icon-[lucide--settings-2] size-4", viewBtn);
    viewBtn.addEventListener("click", () => openViewMenu(viewBtn));
}

/** The Assets tab's view-settings popover: picking an option leaves it open, so the grid options can be reached without two round trips. */
function openViewMenu(anchor) {
    if (state.viewMenu) { closeViewMenu(); return; }

    const menu = el("div", MENU_CLASS, document.body);
    menu.setAttribute("role", "menu");
    const arrow = el("div", "ere-sb-menu-arrow bg-base-background border-l border-t border-border-subtle", menu);

    const place = () => {
        const box = anchor.getBoundingClientRect();
        const width = menu.offsetWidth;
        // Centred under the trigger, then held inside the viewport, as PopoverContent's collision padding does.
        const left = Math.min(Math.max(10, box.left + box.width / 2 - width / 2), window.innerWidth - width - 10);
        menu.style.left = `${left}px`;
        menu.style.top = `${box.bottom + 5}px`;
        arrow.style.left = `${Math.round(box.left + box.width / 2 - left - 4)}px`;
    };

    const fill = () => {
        for (const child of [...menu.children]) if (child !== arrow) child.remove();
        for (const option of VIEW_OPTIONS) {
            addMenuItem(menu, option, state.view[state.tab] === option.id, () => { setView(option.id); fill(); place(); });
        }
        if (state.view[state.tab] !== "grid") return;
        el("div", MENU_SEPARATOR, menu);
        for (const option of TILE_SIZES) {
            addMenuItem(menu, option, state.tileSize[state.tab] === option.id, () => {
                state.tileSize[state.tab] = option.id;
                saveJSON(LS_TILE, Object.fromEntries(TABS.map(t => [t.id, state.tileSize[t.id]])));
                render();
                fill();
            });
        }
        el("div", MENU_SEPARATOR, menu);
        for (const option of TILE_RATIOS) {
            addMenuItem(menu, option, state.tileRatio[state.tab] === option.id, () => {
                state.tileRatio[state.tab] = option.id;
                saveJSON(LS_RATIO, Object.fromEntries(TABS.map(t => [t.id, state.tileRatio[t.id]])));
                render();
                fill();
            });
        }
    };

    const onPointerDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeViewMenu(); };
    const onKeyDown = (e) => { if (e.key === "Escape") { closeViewMenu(); anchor.focus(); } };
    state.viewMenu = () => {
        menu.remove();
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("resize", place);
        state.viewMenu = null;
    };
    fill();
    place();
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", place);
}

function closeViewMenu() {
    state.viewMenu?.();
}

/** One popover row: icon, label, and the check MediaAssetSettingsMenu keeps in place at zero opacity so the rows do not shift. */
function addMenuItem(menu, option, checked, onPick) {
    const button = el("button", MENU_ITEM, menu);
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(checked));
    const label = el("span", "mr-4 flex items-center gap-2", button);
    const icon = el("i", `${option.icon ?? RATIO_ICON} size-4`, label);
    if (option.ratio !== undefined && option.ratio !== 1) icon.classList.add(`ere-ratio-${option.id}`);
    el("span", "", label).textContent = option.label;
    el("i", `ml-auto icon-[lucide--check] size-4 ${checked ? "" : "opacity-0"}`, button);
    button.addEventListener("click", onPick);
}

function buildTreeBody(host) {
    // Scrolls the way the Nodes tab does, so nothing waits on PrimeVue's ScrollPanel CSS.
    const scroll = el("div", "comfy-vue-side-bar-body flex h-0 grow flex-col", host);
    const container = el("div", "flex h-full flex-col", scroll);
    // No padding here: a sticky breadcrumb only travels to the top of its parent's content box, so it would leave a strip of tiles scrolling above it. The lists carry it instead.
    const content = el("div", "min-h-0 flex-1 scrollbar-custom overflow-x-hidden ere-sb-body-inner", container);
    // Focusable so the keys below reach it, but not in the tab order.
    content.tabIndex = -1;
    content.addEventListener("keydown", onBodyKeyDown);

    // Tags dragged out of a node land in the root folder when dropped on empty space.
    // Entries dragged within the sidebar do not: the background is everywhere, and would catch a drag released over the row it started on and move it to the root.
    markDropFolder(content, "", { moves: false });
    // Dropping an image file is a different gesture — see attachImageDrop.
    attachImageDrop(content);
    // Ctrl+press bands (or toggles) wherever it lands, a press on empty space bands, and a plain press on a row is left to attachPress. Capture, so rows never see the ones this takes — the same shape as onGlobalPointerDown in dragdrop.js, and the reason the gesture is identical in list view, in grid view and on pills.
    content.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const rowEl = e.target?.closest?.("[data-ere-key]");
        if (rowEl && !(e.ctrlKey || e.metaKey)) return;
        e.stopPropagation();
        beginMarquee(e, content, rowEl);
    }, true);
    // Right-click on background (not on a row) offers folder management.
    // Rows stop propagation in their own handler, so this only sees empty space.
    content.addEventListener("contextmenu", openBackgroundMenu);
    scroll.addEventListener("contextmenu", (e) => {
        if (e.target === scroll || e.target === container) openBackgroundMenu(e);
    });
}

// Editor Panel
// Takes over the sidebar while open (see buildChrome): name field in the search row's slot, cover where the tab strip would be, pills in the body.

/** Open the editor, replacing the tree. */
function openEditor(opts) {
    closeEditor({ rebuild: false });
    hidePreviewPanel(true);
    clearSelection();
    state.editor = createTagEditor({
        ...opts,
        onCancel: () => closeEditor(),
        onSaved: async () => {
            state.editor?.destroy?.();
            state.editor = null;
            buildChrome(state.host);
            await refresh();
        },
    });
    buildChrome(state.host);
}

/** Discard the editor. Unsaved changes are gone — that is what Cancel means. */
function closeEditor({ rebuild = true } = {}) {
    if (!state.editor) return false;
    state.editor.destroy?.();
    state.editor = null;
    if (rebuild && state.host) {
        buildChrome(state.host);
        render();
    }
    return true;
}

/** Open the editor on an existing tag group. */
async function editTagGroup(row) {
    const tags = await loadGroupTags(row.path, row.extension);
    if (!tags) {
        toast("error", "Could not open", `"${row.name}" could not be read.`, 5000);
        return;
    }
    openEditor({
        mode: "edit",
        folder: folderOf(row),
        name: row.name,
        tags: JSON.parse(JSON.stringify(tags)),
        // The group may have no cover at all; the <img> error handler hides it.
        coverUrl: previewUrl("group", row.path),
    });
}

async function selectTab(id) {
    if (state.tab === id) return;
    // Unreachable while the editor is open, but a panel pointing into a hidden tree is not.
    closeEditor({ rebuild: false });
    state.tab = id;
    state.query = "";
    state.tagResults = null;
    clearSelection();
    saveJSON(LS_TAB, id);
    buildChrome(state.host);
    await ensureTree();
}

// No chrome rebuild: the header is the same in every view, and rebuilding it would tear down the popover this is called from.
function setView(view) {
    if (state.view[state.tab] === view) return;
    state.view[state.tab] = view;
    saveJSON(LS_VIEW, Object.fromEntries(TABS.map(t => [t.id, state.view[t.id]])));
    render();
}

async function ensureTree({ force = false } = {}) {
    const tab = state.tab;
    // Anything that arrives after the user has moved on belongs to a list nobody is looking at.
    const current = () => state.host && state.tab === tab;
    const held = state.trees[tab];
    const before = state.treeVersions[tab];

    if (held && !force) {
        // Draw what we already hold before asking the server anything.
        // The answer is almost always "unchanged", and waiting for it is the whole delay on reopening the tab.
        state.loading = false;
        render();
    } else if (!held) {
        state.loading = true;
        render();
        await fetchRootLevel(tab);
        state.loading = false;
        if (current()) render();
    }

    await fetchTree(tab, { force });
    state.loading = false;
    // Nothing to redraw when the tree came back unchanged and it was already on screen.
    if (!current() || (held && !force && state.treeVersions[tab] === before)) return;
    render();
}

/** Re-read from disk after an external change (save, rename, delete, migration). */
export async function refresh() {
    // The held tree stays on screen while the new one is fetched: dropping it first renders
    // "Loading…" over a list that is about to come back nearly identical.
    // ensureTree({ force }) ignores the cached version anyway, and other tabs re-check on switch.
    await loadBookmarks();
    // A group may have just been created, renamed or deleted, and pills point at it.
    // Re-render them so the verdict is re-fetched now rather than whenever they next happen to redraw.
    clearMissingCache();
    for (const node of app.graph?._nodes ?? []) node._ereDom?.render?.();
    if (!state.host) return;
    await ensureTree({ force: true });
    // Re-reading from disk has to include the index, or tag search answers from the old contents after an import.
    if (deepSearchActive()) {
        await ensureIndex();
        if (state.tagSearch) runTagSearch();
    }
}

// Mount

export function mountSidebar(hostEl) {
    injectTagStyles();
    // The sidebar can open before any node has mounted and injected the drag layer's rules.
    injectDragStyles();
    injectSidebarStyles();
    if (!Object.keys(state.view).length) restorePrefs();

    // Lets a tag dragged out of a preview onto bare canvas still create a node.
    setPreviewHandlers({ startExternalDrag, onCanvasDrop });

    state.host = hostEl;
    buildChrome(hostEl);
    // Typing is the first thing most opens are for, as in the core sidebars — but only when a person just opened it, since a restored tab would otherwise take the keyboard from the canvas.
    if (navigator.userActivation?.isActive !== false) {
        hostEl.querySelector(".ere-sb-search")?.focus({ preventScroll: true });
    }
    // Not a forced refetch: state.trees survives unmount and the server compares signatures, so an unchanged answer costs a directory stat per folder and no transfer.
    ensureTree();
    loadBookmarks().then(() => { if (state.host) render(); });
}

export function unmountSidebar() {
    hidePreviewPanel(true);
    detachSearchAutocomplete();
    closeViewMenu();
    for (const flow of state.flows) flow.destroy();
    state.flows = [];
    // Reopening starts from the whole collection, as the core sidebars do.
    state.query = "";
    state.tagResults = null;
    clearSelection();
    state.cursor = -1;
    // Closing the tab discards the editor, as switching tabs does: its DOM is going away, and coming back with stale tags would be worse than losing them.
    closeEditor({ rebuild: false });
    state.host = null;
}

function injectSidebarStyles() { loadStyle("sidebar"); installTooltips(); }
