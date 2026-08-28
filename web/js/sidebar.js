import { app } from "../../../scripts/app.js";
import { getCache, clearCachePrefix, isNotFound, loadStyle, clearMissingCache, isAcceptedImage, extractFromImage, tagsFromResult, forgetVerdicts } from "./util.js";
import { SURFACE_CLASS, injectTagStyles, renderTagTile, previewUrl } from "./tagview.js";
import { showPreviewFor, hidePreviewPanel, setPreviewHandlers } from "./preview.js";
import { startExternalDrag, isDragActive, injectDragStyles } from "./dragdrop.js";
import { TagSelectionContextMenu, TagIndexContextMenu } from "./contextmenu.js";
import { GlobalAutocomplete } from "../prompt_autocomplete.js";
import { createTagEditor } from "./tageditor.js";
import { dedupeTags } from "./parser.js";

// Icon-button class string lifted verbatim from the frontend's Button.vue output (variant "muted-textonly", size "icon"); see reference/sidebar.html.
// Reusing it means these buttons are the same size, radius, hover and focus treatment as the Refresh / Load-All buttons in the core sidebars.
const BUTTON_CLASS = "relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap appearance-none border-none rounded-md text-sm font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 bg-transparent text-muted-foreground hover:bg-secondary-background-hover size-8";
// Only a background + full-strength text; nothing invented, both utilities are already used by the frontend.
const BUTTON_ACTIVE = "bg-secondary-background text-base-foreground";

// Text tab classes, copied from the Assets sidebar's tablist.
const TAB_CLASS = "flex shrink-0 items-center justify-center cursor-pointer rounded-lg border-none px-2.5 py-2 text-sm transition-all duration-200 focus-visible:ring-ring/20 outline-hidden focus-visible:ring-1";
const TAB_ACTIVE = "bg-interface-menu-component-surface-hovered text-text-primary";
const TAB_INACTIVE = "bg-transparent text-text-secondary hover:bg-button-hover-surface focus:bg-button-hover-surface";

// Tree row classes, copied verbatim from the Nodes sidebar (see reference/sidebar-nodes.html).
// All static Tailwind — nothing lazily injected.
const ROW_CLASS = "group/tree-node flex w-full min-w-0 cursor-pointer select-none items-center gap-3 overflow-hidden py-2 outline-none hover:bg-comfy-input rounded";
const ROW_ICON = "size-4 shrink-0 text-muted-foreground";
const ROW_LABEL = "text-foreground min-w-0 flex-1 truncate text-sm";
const TREE_CLASS = "m-0 min-w-0 p-2";
// The Nodes tree has no counts; this is the same token vocabulary as its buttons, so it themes with everything else.
// (PrimeVue's p-badge is lazily injected and cannot be relied on.)
const COUNT_CLASS = "shrink-0 rounded bg-secondary-background px-1.5 py-0.5 text-xs text-muted-foreground";

const TABS = [
    { id: "group",     label: "Tag Groups", defaultView: "list" },
    { id: "lora",      label: "Loras",      defaultView: "grid" },
    { id: "embedding", label: "Embeddings", defaultView: "grid" },
];

// Only lucide icons the frontend already compiles can be used — an uncompiled `icon-[lucide--x]` renders as nothing.
// Shows the view it switches to, not the one you are in.
const VIEW_TOGGLE = {
    list: { next: "grid", icon: "icon-[lucide--layout-grid]", label: "Switch to grid view" },
    grid: { next: "list", icon: "icon-[lucide--list]",        label: "Switch to list view" },
};

const LS_VIEW = "EreNodes.Sidebar.view";
const LS_TILE = "EreNodes.Sidebar.tileSize";
const LS_RATIO = "EreNodes.Sidebar.tileRatio";
const LS_EXPANDED = "EreNodes.Sidebar.expanded";
const LS_TAB = "EreNodes.Sidebar.tab";
const LS_TAGSEARCH = "EreNodes.Sidebar.tagSearch";

const HOLD_MS = 200;
const MOVE_THRESHOLD = 5;
// Long enough that typing a word filters once at the end of it rather than once per letter.
const SEARCH_DEBOUNCE_MS = 250;
// While the tag index builds, the sidebar polls for progress. Slow enough not to hammer the server, fast enough that a 36k first build visibly moves.
const INDEX_POLL_MS = 600;
// Folder tiles stay at the small size whatever the groups do - a folder icon gains nothing from being bigger.
const TILE_SIZE = 96;

// Grid gap, in px, shared with the stylesheet so the two cannot drift.
// A large tile spans two small ones *plus the gap between them*, which is what lines the two grids up: 4 x 96 + 3 gaps == 2 x 200 + 1 gap.
const TILE_GAP = 8;

const TILE_SIZES = [
    { id: "small", width: TILE_SIZE, icon: "icon-[lucide--minimize-2]", label: "Small previews" },
    { id: "large", width: TILE_SIZE * 2 + TILE_GAP, icon: "icon-[lucide--maximize-2]", label: "Large previews" },
];

// Portrait only - landscape tiles read badly in a narrow sidebar.
// ComfyUI compiles a subset of lucide, and the rectangle icons are not in it, so all three reuse the square and stretch it: at 16px the scaling reads as the shape.
const TILE_RATIOS = [
    { id: "1-1",  ratio: 1,      label: "Aspect 1:1" },
    { id: "3-4",  ratio: 3 / 4,  label: "Aspect 3:4" },
    { id: "9-16", ratio: 9 / 16, label: "Aspect 9:16" },
];
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
    rows: [],
    press: null,
    editor: null,
};

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
    const response = await fetch(`/erenodes/tree?${query}`);
    return response.json();
}

/**
 * The whole tree.
 * The server answers `{unchanged: true}` when the copy we already hold is still current, which is what makes reopening the tab free.
 */
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

/**
 * The root level only — one directory read, so it lands immediately.
 * Folders arrive empty, which shows as no count badge; the full tree replaces it a moment later.
 */
async function fetchRootLevel(tab) {
    try {
        const data = await requestTree(tab, { depth: "1" });
        if (!data.partial) return;
        state.trees[tab] = { folders: data.folders || [], files: data.files || [] };
    } catch { /* the full fetch right behind it will report any real problem */ }
}

async function loadGroupTags(path, extension = ".json") {
    try {
        const value = getCache(
            `/erenodes/get_tag_group?filename=${encodeURIComponent(path + extension)}`, "json");
        const resolved = value instanceof Promise ? await value : value;
        return isNotFound(resolved) || !Array.isArray(resolved) ? null : resolved;
    } catch { return null; }
}

/** Every file at or below a tree node, depth first. */
function filesUnder(node, out = []) {
    for (const folder of node.folders || []) filesUnder(folder, out);
    out.push(...(node.files || []));
    return out;
}

/**
 * Tags a row contributes when dropped on a node; a folder contributes its whole subtree.
 * @param {{unpack?: boolean}} opts  expand groups instead of passing the pill.
 */
async function tagsForRow(row, opts = {}) {
    if (row.type === "folder") {
        const node = nodeAtPath(state.trees[state.tab] || { folders: [], files: [] }, row.path);
        const files = filesUnder(node);
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

/**
 * A query becomes one term per whitespace-separated word, and every term has to match.
 * A single contiguous substring only ever found "blue archive" typed in that order; terms mean "archive aris" and "aris blue" reach the same file, which is how people actually type once a folder name is three words long.
 */
function tokenize(query) {
    return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The entry's lowercased path, cached on the entry.
 * A 36k-file tree is re-filtered on every (debounced) keystroke, and lowercasing the same strings again on each pass is the one part of that loop worth not repeating. Safe to store: the tree objects belong to the client and the server sends a fresh copy whenever anything on disk changes.
 */
function lowerPath(entry) {
    if (entry._lc === undefined) entry._lc = (entry.path || entry.name || "").toLowerCase();
    return entry._lc;
}

const matchesAll = (entry, terms) => {
    const text = lowerPath(entry);
    return terms.every(term => text.includes(term));
};

/**
 * Filter a tree to entries whose *path* matches every term.
 *
 * Paths are full and relative ("Characters/Blue Archive/Aris"), so a folder name is part of every path below it and searching a series returns its characters.
 * A folder that matches on its own keeps its **whole** subtree rather than a filtered one: once the folder is named, everything inside it is a result, including entries whose own names share none of the terms.
 *
 * Tags *inside* the groups are not searched here. That needs the file contents, which the tree does not carry — it is the index mode below.
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
//
// Mode one filters the tree the browser already holds. Mode two answers "which groups contain this tag", which cannot be done from the tree at all — the tags live in 36k separate files. A SQLite index (py/tag_index.py) is built once and synced incrementally, and the sidebar never blocks on it: switching the mode on reports what the index holds, a build runs in the background with a progress line where the list would be, and the query goes out once it is current.

async function fetchIndexStatus() {
    try {
        const response = await fetch("/erenodes/tag_index/status");
        return await response.json();
    } catch (e) {
        console.error("[EreNodes] Tag index status failed.", e);
        return null;
    }
}

async function startIndexSync({ rebuild = false } = {}) {
    try {
        await fetch("/erenodes/tag_index/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rebuild }),
        });
        return true;
    } catch (e) {
        console.error("[EreNodes] Tag index sync could not be started.", e);
        return false;
    }
}

/**
 * Bring the index up to date, drawing progress while it runs.
 * Resolves to the final status, or null if the server could not be reached or the user left the mode while it was building.
 */
async function ensureIndex({ rebuild = false } = {}) {
    // Two rounds, because the build we join may not be ours: if one was already
    // running when we arrived, it can have started before the files we care about
    // landed, and `stale` is not reported while a build is in flight. The second
    // round is the one that can see whether anything is still missing.
    for (let round = 0; round < 2; round++) {
        state.indexStatus = await fetchIndexStatus();
        if (!state.indexStatus) { render(); return null; }
        if (!rebuild && !state.indexStatus.stale && !state.indexStatus.running) break;

        if (!state.indexStatus.running) await startIndexSync({ rebuild });
        rebuild = false;    // a rebuild is a one-off; any follow-up round is an ordinary sync
        state.indexBusy = true;
        render();

        // Polled, not streamed: a build runs for seconds to minutes, and one small request every INDEX_POLL_MS costs less than holding a connection open for it.
        for (;;) {
            await new Promise(resolve => setTimeout(resolve, INDEX_POLL_MS));
            // Tab closed or mode switched off. The build carries on server-side, which is what we want — it just has nobody left to report to.
            if (!state.host || !state.tagSearch) { state.indexBusy = false; return null; }
            const status = await fetchIndexStatus();
            if (!status) { state.indexBusy = false; state.indexStatus = null; render(); return null; }
            state.indexStatus = status;
            if (!status.running) break;
            // In place: re-rendering the whole tree every 600ms to move two numbers would rebuild thousands of rows and lose the scroll position.
            refreshIndexProgress();
        }
        state.indexBusy = false;
        render();
    }
    return state.indexStatus;
}

/**
 * Run the query on screen against the index.
 * Sequenced, because a slow answer to an abandoned query must never replace the results of the one the user is actually reading.
 */
async function runTagSearch() {
    const query = state.query.trim();
    const seq = ++state.tagSeq;
    state.tagResults = null;
    if (!query) { render(); return; }

    render();   // draws "Searching tags…" while the request is out

    let data = null;
    try {
        const response = await fetch(
            `/erenodes/tag_index/search?query=${encodeURIComponent(query)}`);
        data = await response.json();
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
//
// Only in tag mode, where the box takes comma-separated tags and completing them is the same job the node autocomplete already does — menu under the caret, Tab or Enter to accept, `, ` inserted after a pick so the next term can be typed straight away. In name mode the box takes free text and there is nothing to complete against.
//
// Suggestions come from the index rather than the CSV (see TagIndexContextMenu), so the box never offers a tag your collection does not contain.

/**
 * Our own instance, not `app.globalAutocompleteInstance`.
 * That one is a singleton bound to whichever node textarea has focus, and borrowing it would detach it from the user's prompt mid-edit — and it completes from the CSV, which is the wrong source here.
 */
let searchAutocomplete = null;

/**
 * The sidebar search box is one of our own inputs, so the EreNodes-specific autocomplete setting keeps it working even for someone who turned the global textarea hook off to stay out of other packs' way.
 */
function autocompleteEnabled() {
    const settings = app.ui?.settings;
    const global = settings?.getSettingValue?.("EreNodes.Autocomplete.Global", true) ?? true;
    const nodes = settings?.getSettingValue?.("EreNodes.Autocomplete.Nodes", true) ?? true;
    return global || nodes;
}

/**
 * Attached on focus rather than up front: the menu positions itself against the field it is driving, and there is no reason to hold listeners on a box nobody is typing in.
 * Re-checked at focus time too, because both the mode and the setting can change while the row stands.
 */
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

function countLeaves(folder) {
    return filesUnder(folder).length;
}

// Selection

const rowKey = row => `${row.type}:${row.path}`;

function clearSelection() {
    state.selection.clear();
    state.anchor = null;
    syncSelectionClasses();
}

function syncSelectionClasses() {
    if (!state.host) return;
    for (const el of state.host.querySelectorAll("[data-ere-key]")) {
        el.classList.toggle("ere-sb-selected", state.selection.has(el.dataset.ereKey));
    }
}

/** Ctrl toggles, Shift ranges over rendered order, plain click just activates. */
function handleRowSelect(row, e) {
    const key = rowKey(row);
    if (e.ctrlKey || e.metaKey) {
        if (state.selection.has(key)) state.selection.delete(key);
        else state.selection.add(key);
        state.anchor = key;
        syncSelectionClasses();
        return true;
    }
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

function selectedRows() {
    if (!state.selection.size) return [];
    const byKey = new Map(state.rows.map(r => [rowKey(r), r]));
    return [...state.selection].map(k => byKey.get(k)).filter(Boolean);
}

/**
 * Rubber-band selection over the rows, matching the pill marquee in nodes: drag on empty space to replace the selection, hold Ctrl/Cmd to XOR against what is already picked.
 * A press that never moves is not a band.
 */
function beginMarquee(e, scroller) {
    const additive = e.ctrlKey || e.metaKey;
    const base = additive ? new Set(state.selection) : new Set();
    const start = { x: e.clientX, y: e.clientY };
    let band = null;

    const update = (x, y) => {
        const left = Math.min(start.x, x), top = Math.min(start.y, y);
        const width = Math.abs(x - start.x), height = Math.abs(y - start.y);
        Object.assign(band.style, {
            left: `${left}px`, top: `${top}px`,
            width: `${width}px`, height: `${height}px`,
        });

        const next = new Set(base);
        for (const el of scroller.querySelectorAll("[data-ere-key]")) {
            // Tree rows nest (li holds the content div), so only count the element the user actually sees as a row.
            if (el.querySelector("[data-ere-key]")) continue;
            const r = el.getBoundingClientRect();
            if (r.left < left + width && r.right > left && r.top < top + height && r.bottom > top) {
                const key = el.dataset.ereKey;
                if (next.has(key)) next.delete(key);
                else next.add(key);
            }
        }
        state.selection = next;
        syncSelectionClasses();
    };

    const onMove = (ev) => {
        if (!band && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_THRESHOLD) {
            band = document.createElement("div");
            band.className = "ere-marquee";
            document.body.appendChild(band);
            document.body.classList.add("ere-marquee-active");
        }
        if (band) { ev.preventDefault(); update(ev.clientX, ev.clientY); }
    };
    const finish = () => {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", finish, true);
        band?.remove();
        document.body.classList.remove("ere-marquee-active");
        // A press that never opened a band is just a click on empty space.
        if (!band && !additive) clearSelection();
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", finish, true);
}

// Node Actions

function defaultNodeType() {
    return app.ui?.settings?.getSettingValue?.("EreNodes.Sidebar.DefaultNode", "ErePromptCloud")
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

    app.graph.add(node);
    const canvas = app.canvas;
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
            const jitter = (app.graph._nodes.length % 6) * 24;
            node.pos = [
                rect.width / 2 / scale - offset[0] - (node.size?.[0] ?? 200) / 2 + jitter,
                rect.height / 2 / scale - offset[1] - 40 + jitter,
            ];
        }
    }

    node.properties = node.properties || {};
    node.properties._tagDataJSON = JSON.stringify(tags, null, 2);
    node.onUpdateTextWidget?.(node);
    app.graph.setDirtyCanvas(true, true);
    return node;
}

/** A sidebar payload dropped on bare canvas becomes a new node there. */
function onCanvasDrop(tags, x, y) {
    if (!tags?.length) return;
    createNodeWithTags(tags, defaultNodeType(), { x, y });
}

// Hovering

function anchorRect(el) {
    // Anchor previews to the sidebar's edge, not the row, so the panel never covers the list the pointer is moving through.
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
            // Only tag groups have individually useful tags to pick out; a lora's trained words are informational.
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

        const start = { x: e.clientX, y: e.clientY };
        let started = false;

        const begin = async () => {
            if (started) return;
            started = true;
            hidePreviewPanel(true);
            // A drag from a selected row carries the whole selection.
            const rows = state.selection.has(rowKey(row)) ? selectedRows() : [row];
            const lists = await Promise.all(rows.map(r => tagsForRow(r)));
            const tags = dedupeTags(lists.flat());
            const label = rows.length > 1 ? `${rows.length} items` : row.name;

            // Tag groups drop as themselves; holding Alt drops their contents instead.
            // Both payloads are resolved up front so the swap is instant — reading files mid-drag would stall the ghost.
            // Only the Tag Groups tab has a second reading: a lora is a lora.
            let altTags = null;
            let altLabel = "";
            if (state.tab === "group") {
                const unpacked = await Promise.all(rows.map(r => tagsForRow(r, { unpack: true })));
                altTags = dedupeTags(unpacked.flat());
                altLabel = `${altTags.length} tag${altTags.length === 1 ? "" : "s"}`;
            }

            startExternalDrag({
                tags, label, altTags, altLabel,
                x: state.press?.x ?? start.x,
                y: state.press?.y ?? start.y,
                // Lets a drop inside the sidebar move these entries instead of treating them as tags to save.
                origin: {
                    kind: "sidebar", tab: state.tab, rows,
                    onMove: moveRowsInto,
                    onCanvasDrop,
                },
            });
        };

        const timer = setTimeout(begin, HOLD_MS);
        state.press = { ...start };

        const onMove = (ev) => {
            state.press = { x: ev.clientX, y: ev.clientY };
            if (started) return;
            if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_THRESHOLD) {
                clearTimeout(timer);
                begin();
            }
        };
        const onUp = (ev) => {
            clearTimeout(timer);
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            state.press = null;
            if (started) return;   // the drag machinery owns the rest
            onRowActivate(row, ev);
        };
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
    });
}

async function onRowActivate(row, e) {
    if (handleRowSelect(row, e)) return;
    clearSelection();

    if (row.type === "folder") {
        /** List view expands in place; grid view navigates into the folder, because a nested accordion of grids is unreadable. */
        if (state.view[state.tab] === "grid") {
            state.crumb[state.tab] = row.path;
            render();
        } else {
            toggleFolder(row.path);
        }
        return;
    }
    // Click-to-add and the ➕ menu still expand a group into its tags.
    const tags = await tagsForRow(row, { unpack: true });
    if (!tags.length) {
        app.extensionManager?.toast?.add({
            severity: "warn", summary: "Empty tag group",
            detail: `'${row.name}' has no tags.`, life: 4000,
        });
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

/**
 * Drop inside the sidebar.
 * Two gestures land here: entries dragged *within* the sidebar move into the folder, tag pills dragged *out of a node* open the editor.
 */
async function onSidebarDrop(tags, folderPath, sourceNode, origin) {
    if (origin?.kind === "sidebar") {
        await origin.onMove?.(origin.rows, folderPath, origin.tab);
        return;
    }
    if (state.tab !== "group") {
        app.extensionManager?.toast?.add({
            severity: "warn", summary: "Switch to Tag Groups",
            detail: "Tags can only be saved into the Tag Groups tab.", life: 4000,
        });
        return;
    }

    // Straight into the editor rather than a name prompt: the tags are already in hand, so there is no reason to make the user commit to a filename before seeing what is in the group.
    // Nested groups are unpacked by the editor itself, so they arrive intact rather than being stripped.
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
    for (const row of rows) {
        if (!isRealMove(row, folderPath)) continue;
        const result = await postJson("/erenodes/move_path", {
            path: pathWithExtension(row),
            toFolder: folderPath,
        }, { quiet: true });
        if (result?.ok && !result.unchanged) moved++;
    }
    // A drop that moved nothing leaves the tree exactly as it was, and re-reading it would only make the list flicker.
    if (!moved) return;
    app.extensionManager?.toast?.add({
        severity: "success", summary: "Moved",
        detail: `${moved} item(s) moved to ${folderPath || "the root folder"}.`, life: 3500,
    });
    clearSelection();
    await refresh();
}

// Inline Naming
//
// In the row itself, Explorer style, rather than a modal prompt that interrupts a gesture which has already said where the thing goes.

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

/**
 * Dropping a generated image on the tree: extract, then open the editor.
 * One of exactly two places that extract a prompt — the editor's own pane only sets a cover.
 */
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
            app.extensionManager?.toast?.add({
                severity: "error", summary: "Unsupported file",
                detail: `${file.name} is not a PNG, JPEG or WebP.`, life: 5000,
            });
            return;
        }

        let tags = [];
        try {
            tags = tagsFromResult(await extractFromImage(file));
        } catch (err) {
            console.error("[EreNodes] Sidebar extraction failed.", err);
            app.extensionManager?.toast?.add({
                severity: "error", summary: "Extraction failed", detail: err.message, life: 5000,
            });
            return;
        }
        if (!tags.length) {
            // Open anyway.
            // The gesture was explicit and the cover is still useful; discarding it would just mean doing the drop twice.
            app.extensionManager?.toast?.add({
                severity: "warn", summary: "No prompt found",
                detail: "The image had no readable prompt. Its cover was kept — drag tags in.",
                life: 6000,
            });
        }
        forgetVerdicts(tags);
        openEditor({
            mode: "new",
            folder,
            // Not prefilled from the filename: ComfyUI output names are timestamps, so it would only ever need clearing.
            name: "",
            tags,
            coverFile: file,
        });
    });
}

/**
 * Register an element as a drop destination for the drag layer.
 * @param {boolean} [moves] whether entries dragged within the sidebar may be moved here.
 *   False for the background, which is a destination for tags dragged out of a node but must not silently swallow a move into the root folder.
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

/**
 * A move is real only if it changes where the entry lives.
 * Ordering is always alphabetical, so a drop inside the folder the entry already sits in has nothing to do — and a folder cannot be moved into itself or its own subtree.
 */
function isRealMove(row, folderPath) {
    if (row.path === folderPath) return false;
    if (parentFolderOf(row.path) === folderPath) return false;
    if (row.type === "folder" && `${folderPath}/`.startsWith(`${row.path}/`)) return false;
    return true;
}

// Rendering
//
// Mirrors the Nodes sidebar: a flat <ul role="tree"> of Tailwind-styled rows.

function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
}

/**
 * One tree row, in the Nodes sidebar's markup (see the module header for why that one).
 * Flat list: hierarchy is padding-left, 8px at level 1 then +24px.
 */
function makeTreeRow(row, { open = false } = {}) {
    const isFolder = row.type === "folder";

    const item = el("div", ROW_CLASS);
    item.setAttribute("role", "treeitem");
    item.setAttribute("aria-level", String(row.level));
    item.setAttribute("aria-selected", "false");
    item.dataset.indent = String(row.level);
    item.dataset.ereKey = rowKey(row);
    item.tabIndex = -1;
    item.title = row.path;
    item.style.paddingLeft = `${8 + (row.level - 1) * 24}px`;

    if (isFolder) {
        item.setAttribute("aria-expanded", String(open));
        if (open) item.dataset.expanded = "";
        const chevron = el("i",
            `icon-[lucide--chevron-${open ? "down" : "right"}] ${ROW_ICON} transition-transform`, item);
        chevron.addEventListener("pointerdown", e => e.stopPropagation());
        chevron.addEventListener("click", (e) => {
            e.stopPropagation();
            toggleFolder(row.path);
        });
        markDropFolder(item, row.path);
    }

    el("i", `${isFolder ? "icon-[lucide--folder]" : fileIcon(row)} ${ROW_ICON}`, item);

    const label = el("span", ROW_LABEL, item);
    label.dataset.ereLabel = "";     // inlineEdit swaps this for an input
    label.textContent = row.name;

    if (isFolder && row.count) {
        const badge = el("span", COUNT_CLASS, item);
        badge.textContent = String(row.count);
    }

    attachPress(item, row);
    attachHover(item, row);
    item.addEventListener("contextmenu", e => openRowMenu(row, e));
    return item;
}

/** Leaf icon per tab — only icons the frontend compiles may be used. */
function fileIcon(row) {
    return row.tab === "group" ? "icon-[lucide--tag]" : "icon-[lucide--box]";
}

function collectRows(node, out, container, searching, level = 1) {
    for (const folder of node.folders || []) {
        const row = {
            type: "folder", name: folder.name, path: folder.path,
            tab: state.tab, count: countLeaves(folder), level,
        };
        out.push(row);
        // While searching, every surviving branch is opened so hits are visible without the user having to expand anything.
        const open = searching || state.expanded[state.tab].has(folder.path);
        container.appendChild(makeTreeRow(row, { open }));
        if (open) collectRows(folder, out, container, searching, level + 1);
    }
    for (const file of node.files || []) {
        const row = {
            type: "file", name: file.name, path: file.path,
            extension: file.extension, tab: state.tab, level,
        };
        out.push(row);
        container.appendChild(makeTreeRow(row));
    }
}

/** The pixel box for an item tile, from the size and ratio toggles. */
function tileBox() {
    const size = TILE_SIZES.find(o => o.id === state.tileSize[state.tab]) ?? TILE_SIZES[0];
    const ratio = TILE_RATIOS.find(o => o.id === state.tileRatio[state.tab]) ?? TILE_RATIOS[0];
    return { width: size.width, height: Math.round(size.width / ratio.ratio) };
}

function makeTile(row, box = null) {
    const wrap = el("div", "ere-sb-tile");
    wrap.dataset.ereKey = rowKey(row);
    wrap.title = row.path;

    if (row.type === "folder") {
        // Size comes from the grid's --ere-tile-size, so folder tiles and file tiles are guaranteed to occupy identical cells.
        wrap.classList.add("ere-sb-folder-tile");
        el("i", "icon-[lucide--folder] size-8 text-muted-foreground", wrap);
        const name = el("div", "ere-sb-tile-name", wrap);
        name.dataset.ereLabel = "";
        name.textContent = row.name;
        if (row.count) {
            const badge = el("span", `${COUNT_CLASS} ere-sb-tile-badge`, wrap);
            badge.textContent = String(row.count);
        }
        markDropFolder(wrap, row.path);
    } else {
        // Same tile the Gallery node draws, so grid view matches the canvas.
        const { width, height } = box ?? tileBox();
        wrap.appendChild(renderTagTile(
            { name: row.path, type: row.tab, active: true, extension: row.extension },
            { width, height, stripFolders: true }
        ));
    }

    attachPress(wrap, row);
    attachHover(wrap, row);
    wrap.addEventListener("contextmenu", e => openRowMenu(row, e));
    return wrap;
}

function renderBreadcrumb(container, path) {
    const bar = el("div", "ere-sb-crumbs", container);
    const crumbs = [{ name: activeTab().label, path: "" }];
    let acc = "";
    for (const part of (path ? path.split("/") : [])) {
        acc = acc ? `${acc}/${part}` : part;
        crumbs.push({ name: part, path: acc });
    }
    crumbs.forEach((crumb, i) => {
        if (i) el("i", "icon-[lucide--chevron-right] size-3 shrink-0 opacity-50", bar);
        const button = el("button", "ere-sb-crumb", bar);
        button.type = "button";
        button.textContent = crumb.name;
        // Dropping onto a breadcrumb moves entries up a level.
        markDropFolder(button, crumb.path);
        button.addEventListener("click", () => {
            state.crumb[state.tab] = crumb.path;
            render();
        });
        bar.appendChild(button);
    });
}

function render() {
    const host = state.host;
    const body = host?.querySelector(".ere-sb-body-inner");
    if (!body) return;

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

    // A build with a query waiting on it. The list cannot be drawn at all yet, so the whole panel becomes the progress report — an empty list here would read as "no matches", which is a different and wrong answer.
    if (deep && state.indexBusy) {
        body.appendChild(indexingMessage());
        return;
    }

    // A build with nothing waiting on it, which is the usual case: the mode is normally switched on with an empty search box, and that is precisely when a first build starts. A strip above the tree rather than a takeover — there is no reason to stop browsing while it runs, and a minute of silence looks like nothing happened.
    if (deepSearchActive() && state.indexBusy) body.appendChild(indexingBanner());

    // The answer on hand belongs to a query the user has already typed past.
    if (deep && state.tagResults?.query !== state.query.trim()) {
        body.appendChild(
            statusMessage("pi-search", "Searching tags…", `Looking for "${query}" in the tag index.`).wrap);
        return;
    }

    // The index answered with an error (or could not be reached). Offering a rebuild here is the one action that fixes most of the reasons for it.
    if (deep && state.tagResults.failed) {
        const { wrap, inner } = statusMessage("pi-exclamation-triangle", "Tag search unavailable",
            "The tag index could not be queried. Check the ComfyUI console for the reason.");
        inner.appendChild(rebuildIndexButton());
        body.appendChild(wrap);
        return;
    }

    // A term like "1girl" legitimately matches most of a character library; the server caps what it sends rather than shipping the whole collection back to filter a tree the client already holds.
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
        // Only below the root: at the root the bar is one dead crumb naming the tab you are already looking at.
        if (path) renderBreadcrumb(body, path);

        const level = query ? flatten(filtered) : nodeAtPath(filtered, path);
        const { width, height } = tileBox();

        // Two grids, so folders keep their own row instead of being packed in beside items twice their size.
        // `ere-surface` on each (not on the root): the tiles are drawn by the same code the Gallery node uses and need its styling.
        let tiles = 0;
        if (level.folders?.length) {
            const folders = el("div", `ere-sb-grid ${SURFACE_CLASS}`, body);
            folders.style.setProperty("--ere-tile-gap", `${TILE_GAP}px`);
            folders.style.setProperty("--ere-tile-w", `${TILE_SIZE}px`);
            folders.style.setProperty("--ere-tile-h", `${TILE_SIZE}px`);
            for (const folder of level.folders) {
                const row = {
                    type: "folder", name: folder.name, path: folder.path,
                    tab: state.tab, count: countLeaves(folder),
                };
                state.rows.push(row);
                folders.appendChild(makeTile(row));
                tiles++;
            }
        }
        if (level.files?.length) {
            const files = el("div", `ere-sb-grid ${SURFACE_CLASS}`, body);
            files.style.setProperty("--ere-tile-gap", `${TILE_GAP}px`);
            files.style.setProperty("--ere-tile-w", `${width}px`);
            files.style.setProperty("--ere-tile-h", `${height}px`);
            for (const file of level.files) {
                const row = {
                    type: "file", name: file.name, path: file.path,
                    extension: file.extension, tab: state.tab,
                };
                state.rows.push(row);
                files.appendChild(makeTile(row, { width, height }));
                tiles++;
            }
        }
        if (!tiles) body.appendChild(emptyMessage(query, deep));
    } else {
        const list = el("ul", TREE_CLASS, body);
        list.setAttribute("role", "tree");
        list.setAttribute("aria-label", activeTab().label);
        if (query) {
            // Matches only, no folder rows: the path to a hit is noise when you are searching for the hit.
            for (const file of flatten(filtered).files) {
                const row = {
                    type: "file", name: file.name, path: file.path,
                    extension: file.extension, tab: state.tab, level: 1,
                };
                state.rows.push(row);
                list.appendChild(makeTreeRow(row));
            }
        } else {
            collectRows(filtered, state.rows, list, false);
        }
        if (!state.rows.length) body.appendChild(emptyMessage(query, deep));
    }

    syncSelectionClasses();
}

/** Collapse a filtered tree to a single flat level (grid view while searching). */
function flatten(node, out = { folders: [], files: [] }) {
    for (const folder of node.folders || []) flatten(folder, out);
    out.files.push(...(node.files || []));
    return out;
}

/**
 * The frontend's own empty state, class for class (see the Workflows tab), so an empty folder here reads like an empty anything else.
 * Also the shell for the index's own progress and error states, which occupy the same slot and should look like they belong to the same tab.
 */
function statusMessage(iconName, heading, body) {
    const wrap = el("div", "no-results-placeholder h-full p-8");
    const card = el("div", "p-card p-component", wrap);
    const content = el("div", "p-card-content", el("div", "p-card-body", card));
    const inner = el("div", "flex flex-col items-center", content);

    const icon = el("i", `pi ${iconName}`, inner);
    icon.style.fontSize = "3rem";
    icon.style.marginBottom = "1rem";

    el("h3", "", inner).textContent = heading;

    const text = el("p", "text-center whitespace-pre-line", inner);
    text.textContent = body;
    return { wrap, inner };
}

function emptyMessage(query, deep = false) {
    const heading = query ? "No matches" : "Empty";
    let detail;
    if (!query) detail = `No ${activeTab().label.toLowerCase()} here yet.`;
    // In tag mode the interesting question is usually "is the index actually covering my collection", so the answer says how much it holds.
    else if (deep) {
        const indexed = state.indexStatus?.indexed ?? 0;
        detail = `No tag group contains "${query}".\n${indexed.toLocaleString()} groups indexed.`;
    } else detail = `Nothing matches "${query}".`;

    const { wrap, inner } = statusMessage(query ? "pi-search" : "pi-folder", heading, detail);
    if (deep) inner.appendChild(rebuildIndexButton());
    return wrap;
}

/**
 * Build progress, in two shapes.
 *
 * `total` is the number of files that actually need re-reading, not the size of the collection, so the fraction means "how much of the work is left" rather than "how big is my library". Before the scan has produced one there is nothing to divide, and the bar sweeps instead of sitting at 0%.
 *
 * Both shapes carry `data-ere-index-progress`, which is what lets the poll loop update them in place. A full render every 600ms would rebuild thousands of rows and throw away the scroll position for the sake of two numbers.
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

/**
 * Update whichever progress shape is on screen, in place.
 * If neither is (another tab, or the mode was switched off) there is nothing to do — the next full render draws whatever is true then.
 */
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
];

function openRowMenu(row, e) {
    e.preventDefault();
    e.stopPropagation();
    hidePreviewPanel(true);

    // Open where the click happened, not under the row — a menu that always appears at the item's bottom-left feels detached from the gesture.
    const anchor = { clientX: e.clientX, clientY: e.clientY };

    /**
     * Right-clicking inside a multi-selection acts on the whole set, exactly like right-clicking a selected pill in a node.
     * Right-clicking outside one clears it and falls through to the single-row menu below.
     */
    if (state.selection.size > 1) {
        if (state.selection.has(rowKey(row))) return openSelectionMenu(anchor);
        clearSelection();
    }

    const actions = [];

    /**
     * One entry per node type, each naming the node it creates.
     * There is no generic "Add as node" any more: it duplicated whichever type came first.
     */
    for (const [label, type] of NODE_TYPES) {
        actions.push({
            name: `➕ Add as ${label}`,
            callback: async () => {
                // Expanded, like click-to-add — see onRowActivate.
                const tags = await tagsForRow(row, { unpack: true });
                if (tags.length) createNodeWithTags(tags, type);
            },
        });
    }

    // Only tag groups are ours to rewrite; model files belong to ComfyUI.
    if (row.tab === "group") {
        actions.push(null);   // separator
        if (row.type === "file") {
            actions.push({ name: "✎ Edit tag group", callback: () => editTagGroup(row) });
        }
        actions.push({ name: "🏷️ New tag group here", callback: () => newTagGroup(folderOf(row)) });
        actions.push({ name: "📁 New folder here", callback: () => createFolder(folderOf(row)) });
        actions.push({ name: "✏️ Rename", callback: () => renameRow(row) });
        if (row.type === "file") {
            actions.push({ name: "🖼️ Set thumbnail", callback: () => setThumbnail(row) });
        }
        actions.push({ name: "🗑️ Delete", callback: () => deleteRow(row) });
    }

    // The constructor shows the menu itself.
    new TagSelectionContextMenu(anchor, row.name || row.path, actions);
}

/** Bulk actions for a multi-row selection. */
function openSelectionMenu(anchor) {
    const rows = selectedRows();
    if (!rows.length) return;

    const collect = async () => {
        const lists = await Promise.all(rows.map(r => tagsForRow(r, { unpack: true })));
        return dedupeTags(lists.flat());
    };

    const actions = [];
    for (const [label, type] of NODE_TYPES) {
        actions.push({
            name: `➕ Add all as ${label}`,
            callback: async () => {
                const tags = await collect();
                if (tags.length) createNodeWithTags(tags, type);
            },
        });
    }

    if (rows.every(r => r.tab === "group")) {
        actions.push(null);
        actions.push({ name: "🗑️ Delete selected", callback: () => deleteRows(rows) });
    }

    new TagSelectionContextMenu(anchor, `${rows.length} items selected`, actions);
}

async function deleteRows(rows) {
    const message = `Delete ${rows.length} selected item(s)? This cannot be undone.`;
    const confirmed = app.extensionManager?.dialog?.confirm
        ? await app.extensionManager.dialog.confirm({ title: "Delete", message })
        : window.confirm(message);
    if (!confirmed) return;

    let removed = 0;
    for (const row of rows) {
        const result = await postJson("/erenodes/delete_path", { path: pathWithExtension(row) }, { quiet: true });
        if (result?.ok) removed++;
    }
    app.extensionManager?.toast?.add({
        severity: removed === rows.length ? "success" : "warn",
        summary: "Deleted",
        detail: `${removed} of ${rows.length} item(s) deleted.`,
        life: 4000,
    });
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

    const here = state.view[state.tab] === "grid" ? (state.crumb[state.tab] || "") : "";
    new TagSelectionContextMenu(
        { clientX: e.clientX, clientY: e.clientY },
        here || "Tag Groups",
        [
            { name: "🏷️ New tag group", callback: () => newTagGroup(here) },
            { name: "📁 New folder", callback: () => createFolder(here) },
            { name: "🔄 Refresh", callback: () => refresh() },
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
            await postJson("/erenodes/rename_path",
                { path: pathWithExtension(row), newName: next });
            await refresh();
        },
    });
}

async function deleteRow(row) {
    const what = row.type === "folder" ? `folder "${row.name}" and everything in it` : `"${row.name}"`;
    const message = `Delete ${what}? This cannot be undone.`;
    const confirmed = app.extensionManager?.dialog?.confirm
        ? await app.extensionManager.dialog.confirm({ title: "Delete", message })
        : window.confirm(message);
    if (!confirmed) return;
    await postJson("/erenodes/delete_path", { path: pathWithExtension(row) });
    await refresh();
}

function setThumbnail(row) {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.style.display = "none";
    document.body.appendChild(input);

    let settled = false;
    const cleanup = () => { if (input.isConnected) input.remove(); };

    input.addEventListener("change", async () => {
        if (settled) return;
        settled = true;
        const file = input.files?.[0];
        cleanup();
        if (!file) return;

        const form = new FormData();
        form.append("type", row.tab);
        form.append("name", row.path);
        form.append("image_file", file, file.name);
        try {
            const response = await fetch("/erenodes/save_file_image", { method: "POST", body: form });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || result.message);
            app.extensionManager?.toast?.add({
                severity: "success", summary: "Thumbnail set", detail: result.message, life: 4000,
            });
            clearCachePrefix(previewUrl(row.tab, row.path).split("?")[0]);
            render();
        } catch (err) {
            app.extensionManager?.toast?.add({
                severity: "error", summary: "Thumbnail failed", detail: err.message, life: 5000,
            });
        }
    });
    input.addEventListener("cancel", () => { settled = true; cleanup(); });
    input.click();
}

/** Server paths include the extension; row.path does not (it is the tag name). */
function pathWithExtension(row) {
    return row.type === "folder" ? row.path : row.path + (row.extension || ".json");
}

async function postJson(url, body, { quiet = false } = {}) {
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return result;
    } catch (e) {
        if (!quiet) {
            app.extensionManager?.toast?.add({
                severity: "error", summary: "Failed", detail: e.message, life: 5000,
            });
        }
        return null;
    }
}

// Chrome

function buildChrome(host) {
    host.textContent = "";
    // While the editor is open it takes the body, the title and the tool button.
    // The tab strip stays: switching collections is a legitimate way out, and it discards the editor exactly as Cancel does.
    const editing = !!state.editor;
    // Deliberately NOT `ere-surface`: that class carries `font: 12px monospace` for tag pills, and on the root it cascaded over the whole tab — wrong family, wrong size, nothing like the native sidebars.
    // Only the elements that actually render tags opt into it (see the grid below).
    host.className = "comfy-vue-side-bar-container group/sidebar-tab flex size-full flex-col ere-sidebar";

    // Every rebuild throws away the search input, and with it the element the autocomplete is driving. One place, so no path can leave it holding a detached field.
    detachSearchAutocomplete();

    const header = el("div", "comfy-vue-side-bar-header flex flex-col", host);

    // Toolbar: title, plus one icon button.
    const toolbar = el("div",
        "p-toolbar p-component flex items-center justify-between min-h-16 rounded-none border-x-0 border-t-0 bg-transparent px-3 2xl:px-4", header);
    toolbar.setAttribute("role", "toolbar");

    const start = el("div", "p-toolbar-start min-w-0 flex-1 overflow-hidden", toolbar);
    const title = el("span", "truncate font-bold", start);
    title.textContent = editing ? state.editor.title : "EreNodes";
    title.title = title.textContent;

    el("div", "p-toolbar-center", toolbar);
    const end = el("div", "p-toolbar-end", toolbar);

    if (editing) {
        // Always visible, unlike the refresh button below: closing is the way out of the panel and must not be hidden behind a hover.
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

    // First row: search, or the editor's name field The editor's name input is the search box's markup minus the magnifier, and it goes in the same slot, so the two line up when the panel opens.
    if (editing) header.appendChild(state.editor.nameRow);
    else buildSearchRow(header);

    // Dashed rule under the search row — a plain bordered div, exactly as the Nodes tab does it (PrimeVue's Divider is lazily injected).
    el("div", "border-t border-dashed border-comfy-input", header);

    /**
     * Second row: the collection tabs, or the editor's cover.
     * Both sit between the same two separators, so the cover reads as its own band.
     * Tabs are hidden while editing — a stray click must not discard the panel.
     */
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
    const search = el("input", "size-full border-none bg-transparent outline-none pl-8 pr-6 text-xs", searchBox);
    search.type = "text";
    // The placeholder is the mode indicator that costs nothing: in tag mode the box takes comma-separated tags, not a name.
    search.placeholder = deepSearchActive() ? "Search tags (comma separated)..." : "Search...";
    search.value = state.query;
    searchBox.addEventListener("click", () => search.focus());
    if (deepSearchActive()) attachSearchAutocomplete(search);

    // Mirrors the search icon on the left. Inline display rather than [hidden], which a display utility on the same element would win against.
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
        // Tag mode answers from the server, so it renders twice: once for the pending state, once for the result.
        if (deepSearchActive()) runTagSearch();
        else render();
        // The results are a different list, so the old scroll offset means nothing — and halfway down a list of thousands it looks like nothing was found.
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

    // `h-8` matches the search box height so the row reads as one control strip.
    const actions = el("div", "flex shrink-0 items-center gap-1", top);
    const view = state.view[state.tab];

    // Deep search is a tag-group concept: there is nothing to look inside a .safetensors for.
    // A toggle rather than a prefix syntax, because the mode is sticky and a mode you cannot see is a mode you forget you are in.
    if (state.tab === "group") {
        const on = state.tagSearch;
        const tagBtn = el("button", `${BUTTON_CLASS} ${on ? BUTTON_ACTIVE : ""}`, actions);
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

    // Grid-only controls, to the left of the view toggle.
    if (view === "grid") {
        addToggle(actions, TILE_SIZES, state.tileSize[state.tab], size => {
            state.tileSize[state.tab] = size;
            saveJSON(LS_TILE, Object.fromEntries(TABS.map(t => [t.id, state.tileSize[t.id]])));
            buildChrome(state.host);
            render();
        });
        addToggle(actions, TILE_RATIOS, state.tileRatio[state.tab], ratio => {
            state.tileRatio[state.tab] = ratio;
            saveJSON(LS_RATIO, Object.fromEntries(TABS.map(t => [t.id, state.tileRatio[t.id]])));
            buildChrome(state.host);
            render();
        }, { showCurrent: true });
    }

    const toggle = VIEW_TOGGLE[view] ?? VIEW_TOGGLE.list;
    const button = el("button", BUTTON_CLASS, actions);
    button.type = "button";
    button.title = toggle.label;
    button.setAttribute("aria-label", toggle.label);
    el("i", `${toggle.icon} size-4`, button);
    button.addEventListener("click", () => setView(toggle.next));
}

/**
 * One button that steps through a list of options.
 * The icon shows the option it will pick, which reads as "press for this"; `showCurrent` flips it for the aspect toggle, where the shape you are looking at is the useful thing to see.
 * The tooltip always names the next option.
 */
function addToggle(parent, options, current, onPick, { showCurrent = false } = {}) {
    const index = Math.max(0, options.findIndex(o => o.id === current));
    const here = options[index];
    const next = options[(index + 1) % options.length];
    const shown = showCurrent ? here : next;
    const button = el("button", BUTTON_CLASS, parent);
    button.type = "button";
    button.title = next.label;
    button.setAttribute("aria-label", next.label);
    const icon = el("i", `${shown.icon ?? RATIO_ICON} size-4`, button);
    if (shown.ratio !== undefined && shown.ratio !== 1) icon.classList.add(`ere-ratio-${shown.id}`);
    button.addEventListener("click", () => onPick(next.id));
    return button;
}

function buildTreeBody(host) {
    // `min-h-0 flex-1 overflow-y-auto` does the scrolling, as in the Nodes tab, so nothing here waits on PrimeVue's ScrollPanel CSS.
    const scroll = el("div", "comfy-vue-side-bar-body flex h-0 grow flex-col", host);
    const container = el("div", "flex h-full flex-col", scroll);
    // No padding on the scroller itself: a sticky breadcrumb can only travel to the top of its parent's content box, so padding here would leave a strip of tiles scrolling above it.
    // The lists inside carry the spacing instead.
    const content = el("div", "min-h-0 flex-1 overflow-y-auto ere-sb-body-inner", container);

    // Tags dragged out of a node land in the root folder when dropped on empty space.
    // Entries dragged within the sidebar do not: the background is everywhere, so it used to catch drags released over a search result or over the row they started on and quietly move them to the root.
    markDropFolder(content, "", { moves: false });
    // Dropping an *image file* anywhere in the tree is a different gesture entirely — see attachImageDrop.
    attachImageDrop(content);
    // Press on background starts a rubber band (rows stop propagation, so this only ever sees empty space) — same gesture as inside a node.
    content.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target !== content && e.target !== container && e.target !== scroll) return;
        beginMarquee(e, content);
    });
    // Right-click on background (not on a row) offers folder management.
    // Rows stop propagation in their own handler, so this only sees empty space.
    content.addEventListener("contextmenu", openBackgroundMenu);
    scroll.addEventListener("contextmenu", (e) => {
        if (e.target === scroll || e.target === container) openBackgroundMenu(e);
    });
}

// Editor Panel
//
// Takes over the sidebar while open (see buildChrome): its name field in the search row's slot, its cover where the tab strip would be, pills in the body.

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
        app.extensionManager?.toast?.add({
            severity: "error", summary: "Could not open",
            detail: `"${row.name}" could not be read.`, life: 5000,
        });
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
    // Unreachable while the editor is open (the tab strip is hidden), but a stale panel pointing into a hidden tree is worth guarding against.
    closeEditor({ rebuild: false });
    state.tab = id;
    state.query = "";
    state.tagResults = null;
    clearSelection();
    saveJSON(LS_TAB, id);
    buildChrome(state.host);
    await ensureTree();
}

function setView(view) {
    if (state.view[state.tab] === view) return;
    state.view[state.tab] = view;
    saveJSON(LS_VIEW, Object.fromEntries(TABS.map(t => [t.id, state.view[t.id]])));
    buildChrome(state.host);
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
        // The answer is almost always "unchanged", and waiting for it is the entire delay on reopening the tab — a round trip the user has no reason to sit through to see a list that has not moved.
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
    state.trees = {};
    state.treeVersions = {};
    // A group may have just been created, renamed or deleted, and nodes on the canvas are showing pills that point at it.
    // Re-render them so the verdict is re-fetched now rather than whenever they next happen to redraw.
    clearMissingCache();
    for (const node of app.graph?._nodes ?? []) node._ereDom?.render?.();
    if (!state.host) return;
    await ensureTree({ force: true });
    // "Re-read from disk" has to include what the index believes about those files, or refreshing after an import leaves tag search answering from the old contents.
    if (deepSearchActive()) {
        await ensureIndex();
        if (state.tagSearch) runTagSearch();
    }
}

// Mount

export function mountSidebar(hostEl) {
    injectTagStyles();
    // The marquee and drop-target rules live with the drag layer; the sidebar can be opened before any node has mounted and injected them.
    injectDragStyles();
    injectSidebarStyles();
    if (!Object.keys(state.view).length) restorePrefs();

    // Lets a tag dragged out of a preview onto bare canvas still create a node.
    setPreviewHandlers({ startExternalDrag, onCanvasDrop });

    state.host = hostEl;
    buildChrome(hostEl);
    // Not a forced refetch: state.trees survives unmount, and the server now decides whether that copy is still good by comparing signatures.
    // A stale tree used to hide folders created from a node's menu; an unchanged answer costs one directory stat per folder and no transfer at all.
    ensureTree();
}

export function unmountSidebar() {
    hidePreviewPanel(true);
    detachSearchAutocomplete();
    // Closing the tab discards the editor, exactly as switching tabs does: its DOM is about to be thrown away, and a panel that silently came back with stale tags on reopen would be worse than losing them.
    closeEditor({ rebuild: false });
    state.host = null;
}

function injectSidebarStyles() { loadStyle("sidebar"); }
