import { app } from "../../../scripts/app.js";
import { getCache, clearCachePrefix, isNotFound, loadStyle, clearMissingCache, isAcceptedImage, extractFromImage, tagsFromResult, forgetVerdicts } from "./util.js";
import { SURFACE_CLASS, injectTagStyles, renderTagTile, previewUrl } from "./tagview.js";
import { showPreviewFor, hidePreviewPanel, setPreviewHandlers } from "./preview.js";
import { startExternalDrag, isDragActive, injectDragStyles } from "./dragdrop.js";
import { TagSelectionContextMenu } from "./contextmenu.js";
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
const TREE_CLASS = "m-0 min-w-0 p-0 px-2 pb-2";
// The Nodes tree has no counts; this is the same token vocabulary as its buttons, so it themes with everything else.
// (PrimeVue's p-badge is lazily injected and cannot be relied on.)
const COUNT_CLASS = "shrink-0 rounded bg-secondary-background px-1.5 py-0.5 text-xs text-muted-foreground";

const TABS = [
    { id: "group",     label: "Tag Groups", defaultView: "list" },
    { id: "lora",      label: "Loras",      defaultView: "grid" },
    { id: "embedding", label: "Embeddings", defaultView: "grid" },
];

// Only lucide icons the frontend already compiles can be used — an uncompiled `icon-[lucide--x]` renders as nothing.
const VIEWS = [
    ["list", "icon-[lucide--list]",        "List view"],
    ["grid", "icon-[lucide--layout-grid]", "Grid view"],
];

const LS_VIEW = "EreNodes.Sidebar.view";
const LS_EXPANDED = "EreNodes.Sidebar.expanded";
const LS_TAB = "EreNodes.Sidebar.tab";

const HOLD_MS = 200;
const MOVE_THRESHOLD = 5;
const TILE_SIZE = 96;

const state = {
    host: null,
    tab: TABS[0].id,
    query: "",
    trees: {},
    loading: false,
    expanded: {},
    view: {},
    crumb: {}, 
    selection: new Set(),
    anchor: null,
    rows: [],
    location: null,
    press: null,
    contentHits: null,
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
    const expanded = loadJSON(LS_EXPANDED, {});
    for (const tab of TABS) state.expanded[tab.id] = new Set(expanded[tab.id] || []);
    state.tab = loadJSON(LS_TAB, TABS[0].id);
    if (!TABS.some(t => t.id === state.tab)) state.tab = TABS[0].id;
}

function persistExpanded() {
    saveJSON(LS_EXPANDED, Object.fromEntries(
        TABS.map(t => [t.id, [...(state.expanded[t.id] || [])]])
    ));
}

const activeTab = () => TABS.find(t => t.id === state.tab);

// Data

async function fetchTree(tab, { force = false } = {}) {
    if (state.trees[tab] && !force) return state.trees[tab];
    try {
        const response = await fetch(`/erenodes/tree?type=${encodeURIComponent(tab)}`);
        const data = await response.json();
        state.trees[tab] = { folders: data.folders || [], files: data.files || [] };
    } catch (e) {
        console.error("[EreNodes] Sidebar tree fetch failed.", e);
        state.trees[tab] = { folders: [], files: [] };
    }
    return state.trees[tab];
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

const matches = (text, query) => text.toLowerCase().includes(query);

/** Filter a tree to entries matching the query. */
function filterTree(node, query, contentHits) {
    const folders = [];
    for (const folder of node.folders || []) {
        const sub = filterTree(folder, query, contentHits);
        if (matches(folder.name, query) || sub.folders.length || sub.files.length) {
            folders.push({ ...folder, ...sub });
        }
    }
    const files = (node.files || []).filter(
        f => matches(f.name, query) || matches(f.path, query) || contentHits?.has(f.path)
    );
    return { folders, files };
}

/** Group files whose *contents* match — tag groups only. */
async function contentMatches(query) {
    if (state.tab !== "group" || query.length < 2) return null;
    try {
        const response = await fetch(`/erenodes/search_tag_groups?query=${encodeURIComponent(query)}`);
        const data = await response.json();
        return new Set((data.items || []).map(i => i.path));
    } catch { return null; }
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
        if (row.path === folderPath) continue;
        const result = await postJson("/erenodes/move_path", {
            path: pathWithExtension(row),
            toFolder: folderPath,
        }, { quiet: true });
        if (result?.ok && !result.unchanged) moved++;
    }
    if (moved) {
        app.extensionManager?.toast?.add({
            severity: "success", summary: "Moved",
            detail: `${moved} item(s) moved to ${folderPath || "the root folder"}.`, life: 3500,
        });
    }
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

/** Register an element as a drop destination for the drag layer. */
function markDropFolder(el, path) {
    el.dataset.ereSidebarDrop = "1";
    el.dataset.erePath = path;
    el._ereSidebarDrop = onSidebarDrop;
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

function makeTile(row) {
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
        wrap.appendChild(renderTagTile(
            { name: row.path, type: row.tab, active: true, extension: row.extension },
            { width: TILE_SIZE, height: TILE_SIZE, stripFolders: true }
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
    const filtered = query ? filterTree(tree, query, state.contentHits) : tree;

    if (view === "grid") {
        // Search flattens: browsing by folder while filtering makes no sense.
        const path = query ? "" : (state.crumb[state.tab] || "");
        if (!query) renderBreadcrumb(body, path);

        const level = query ? flatten(filtered) : nodeAtPath(filtered, path);
        // `ere-surface` here (not on the root): the tiles are drawn by the same code the Gallery node uses and need its styling.
        const grid = el("div", `ere-sb-grid ${SURFACE_CLASS}`, body);
        grid.style.setProperty("--ere-tile-size", `${TILE_SIZE}px`);
        for (const folder of level.folders || []) {
            const row = {
                type: "folder", name: folder.name, path: folder.path,
                tab: state.tab, count: countLeaves(folder),
            };
            state.rows.push(row);
            grid.appendChild(makeTile(row));
        }
        for (const file of level.files || []) {
            const row = {
                type: "file", name: file.name, path: file.path,
                extension: file.extension, tab: state.tab,
            };
            state.rows.push(row);
            grid.appendChild(makeTile(row));
        }
        if (!grid.children.length) body.appendChild(emptyMessage(query));
    } else {
        const list = el("ul", TREE_CLASS, body);
        list.setAttribute("role", "tree");
        list.setAttribute("aria-label", activeTab().label);
        collectRows(filtered, state.rows, list, !!query);
        if (!state.rows.length) body.appendChild(emptyMessage(query));
    }

    syncSelectionClasses();
}

/** Collapse a filtered tree to a single flat level (grid view while searching). */
function flatten(node, out = { folders: [], files: [] }) {
    for (const folder of node.folders || []) flatten(folder, out);
    out.files.push(...(node.files || []));
    return out;
}

function emptyMessage(query) {
    const msg = el("div", "ere-sb-empty");
    msg.textContent = query ? `No matches for "${query}"` : "Nothing here yet";
    /** "Nothing here" is confusing when the folder is configurable, so say which one is actually being read. */
    if (!query && state.tab === "group" && state.location?.resolved) {
        const where = el("div", "ere-sb-where", msg);
        where.textContent = state.location.resolved;
        where.title = "Change this in Settings → EreNodes → Tag Groups Folder";
    }
    return msg;
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
    const search = el("input", "size-full border-none bg-transparent outline-none pl-8 text-xs", searchBox);
    search.type = "text";
    search.placeholder = state.tab === "group" ? "Search names and tags..." : "Search...";
    search.value = state.query;
    searchBox.addEventListener("click", () => search.focus());
    let debounce = 0;
    search.addEventListener("input", () => {
        clearTimeout(debounce);
        debounce = setTimeout(async () => {
            state.query = search.value;
            state.contentHits = await contentMatches(state.query.trim().toLowerCase());
            render();
        }, 150);
    });

    // `h-8` matches the search box height so the row reads as one control strip.
    const actions = el("div", "flex shrink-0 items-center gap-1", top);
    for (const [view, icon, label] of VIEWS) {
        const button = el("button", `${BUTTON_CLASS}${state.view[state.tab] === view ? " " + BUTTON_ACTIVE : ""}`, actions);
        button.type = "button";
        button.title = label;
        button.setAttribute("aria-label", label);
        button.setAttribute("aria-pressed", String(state.view[state.tab] === view));
        el("i", `${icon} size-4`, button);
        button.addEventListener("click", () => setView(view));
    }
}

function buildTreeBody(host) {
    // `min-h-0 flex-1 overflow-y-auto` does the scrolling, as in the Nodes tab, so nothing here waits on PrimeVue's ScrollPanel CSS.
    const scroll = el("div", "comfy-vue-side-bar-body flex h-0 grow flex-col", host);
    const container = el("div", "flex h-full flex-col", scroll);
    const content = el("div", "min-h-0 flex-1 overflow-y-auto py-2 ere-sb-body-inner", container);


    // Dropping on empty space targets the root of the current folder view.
    markDropFolder(content, "");
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
    state.contentHits = null;
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
    state.loading = true;
    render();
    await Promise.all([
        fetchTree(state.tab, { force }),
        state.location && !force ? Promise.resolve() : loadLocation(),
    ]);
    state.loading = false;
    render();
}

/** Which folder the tag groups tab is reading (for the empty state). */
async function loadLocation() {
    try {
        const response = await fetch("/erenodes/tag_groups_location");
        if (response.ok) state.location = await response.json();
    } catch { /* purely informational */ }
}

/** Re-read from disk after an external change (save, rename, delete, migration). */
export async function refresh() {
    state.trees = {};
    // A group may have just been created, renamed or deleted, and nodes on the canvas are showing pills that point at it.
    // Re-render them so the verdict is re-fetched now rather than whenever they next happen to redraw.
    clearMissingCache();
    for (const node of app.graph?._nodes ?? []) node._ereDom?.render?.();
    if (!state.host) return;
    await ensureTree({ force: true });
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
    // Always refetch on mount. state.trees is a module singleton that survives unmount, so a cached tree can only ever be stale by the time the tab is reopened — that is what hid folders created from a node's menu.
    ensureTree({ force: true });
}

export function unmountSidebar() {
    hidePreviewPanel(true);
    // Closing the tab discards the editor, exactly as switching tabs does: its DOM is about to be thrown away, and a panel that silently came back with stale tags on reopen would be worse than losing them.
    closeEditor({ rebuild: false });
    state.host = null;
}

function injectSidebarStyles() { loadStyle("sidebar"); }
