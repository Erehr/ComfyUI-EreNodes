import { app } from "../../../scripts/app.js";
import { initializeSharedPromptFunctions } from "../prompt.js";
import { captureUndoState, beginUndoTransaction, endUndoTransaction, loadStyle, ensureChecked, tagsToText, insertTagsAsText } from "./util.js";
import { parseTags, parseTextToTagData, joinPrompt, looksLikeProse } from "./parser.js";
import { SURFACE_CLASS, renderSwitchEl } from "./tagview.js";
import { markTextDropZone, clearAllSelections, pruneSelection, buildCountBadges, isDragActive } from "./dragdrop.js";
import { renderTagBody, hideNativeWidget } from "./renderer.js";
import { ActionContextMenu, TagContextMenuInsert } from "./contextmenu.js";

loadStyle("composer");

// Prompt Composer rows. Each category is a pseudo node (as in tageditor.js), so the drag layer and the menus drive it without knowing what a category is.
// See documentation.txt for the data flow.

const TAGS_KEY = "_tagDataJSON";
const HOLD_MS = 200;        // press-and-hold a header to drag the row...
const MOVE_THRESHOLD = 5;   // ...or move this far, whichever comes first

// Row Model
// One property, two shapes: a Composer stores `[{title, active, open, tags}]`, every other prompt node stores a flat tag list. A flat list read here is one category, which is all "convert a Cloud into a Composer" has to do.

/** How a category draws itself. The same tag list, rendered as one of the prompt nodes would. */
export const ROW_LAYOUTS = [
    { id: "cloud", label: "Cloud" },
    { id: "toggle", label: "Toggle" },
    { id: "multiselect", label: "MultiSelect" },
    { id: "gallery", label: "Gallery" },
    { id: "multiline", label: "Multiline" },
];

function normalizeRow(row) {
    if (!row || typeof row !== "object") return null;
    return {
        title: typeof row.title === "string" ? row.title : "Category",
        // Off bypasses the row: it stops emitting, its tags keep their own states.
        active: row.active !== false,
        open: row.open !== false,
        layout: ROW_LAYOUTS.some(l => l.id === row.layout) ? row.layout : "cloud",
        tags: Array.isArray(row.tags) ? row.tags : [],
        // Multiline only: the row's prompt is this text verbatim, with no tags behind it.
        text: typeof row.text === "string" ? row.text : "",
        // Multiline only: a height the user dragged the field to. Null means "fit the text".
        height: Number.isFinite(row.height) && row.height > 0 ? row.height : null,
    };
}

export function getRows(node) {
    let parsed;
    try { parsed = JSON.parse(node.properties?.[TAGS_KEY] || "[]"); } catch { return []; }
    if (!Array.isArray(parsed) || !parsed.length) return [];
    if (Array.isArray(parsed[0]?.tags)) return parsed.map(normalizeRow).filter(Boolean);
    return [makeRow("Category 1", parsed)];
}

function setRows(node, rows) {
    node.properties[TAGS_KEY] = JSON.stringify(rows, null, 2);
}

const makeRow = (title, tags = [], layout = "cloud") =>
    ({ title, active: true, open: true, layout, tags, text: "", height: null });

/** Rows, normalized in place. A new node starts empty — a category nobody asked for is one to delete. */
export function ensureRows(node) {
    node.properties = node.properties || {};
    const rows = getRows(node);
    setRows(node, rows);
    return rows;
}

/** Flatten to a plain tag list, irreversibly. What Convert-to leaves behind. A multiline category has no tags, so its text is parsed back into some — the same trip switching its layout would make. */
export function flattenRows(node) {
    const tags = getRows(node).flatMap(row =>
        row.layout === "multiline" ? parseTextToTagData(row.text || "") : row.tags);
    node.properties[TAGS_KEY] = JSON.stringify(tags, null, 2);
}

// Pseudo Node

/** One host per category, cached on the node so a pill selection survives a re-render. Keyed by position: hosts are re-seeded from their row on every update, so a shifted one simply picks up its new row. */
function hostFor(node, index) {
    const cache = node._composerHosts || (node._composerHosts = new Map());
    const cached = cache.get(index);
    if (cached) return cached;

    const host = {
        id: `${node.id}:${index}`,
        // Not "ErePromptMultiline" — the one type prompt.js branches on.
        type: "ErePromptCloud",
        title: "Category",
        // A real text widget, so the shared update can render this row's prompt into it.
        widgets: [{ name: "text", value: "" }],
        properties: { _tagDataJSON: "[]" },
        setDirtyCanvas: () => {},
        composerNode: node,
        composerRow: index,
    };
    initializeSharedPromptFunctions(host, host.widgets[0]);

    // Two names: the node's own update calls computeText, everything else calls the wrapper that writes the row back. One function would recurse.
    host.computeText = host.onUpdateTextWidget;
    host.onUpdateTextWidget = async () => {
        const rows = getRows(node);
        if (!rows[index]) return;
        rows[index].tags = parseTags(host.properties._tagDataJSON || "[]");
        setRows(node, rows);
        await node.onUpdateTextWidget?.(node);
    };
    // prompt.js's version writes _tagDataJSON without re-rendering, which for a host means the row keeps its old pills.
    host.onRemoveTags = (mode = "all") => {
        const tags = parseTags(host.properties._tagDataJSON || "[]");
        host.properties._tagDataJSON = mode === "inactive"
            ? JSON.stringify(tags.filter(t => t.active), null, 2)
            : "[]";
        clearAllSelections();
        host.onUpdateTextWidget();
    };

    cache.set(index, host);
    return host;
}

/** Forget hosts and textareas past the last category, so a removed row cannot hold a selection. */
function dropStaleHosts(node, rows) {
    for (const cache of [node._composerHosts, node._composerAreas]) {
        if (!cache) continue;
        for (const index of [...cache.keys()]) {
            if (index >= rows.length) cache.delete(index);
        }
    }
}

// Keys typed in a category's field are the field's, not the app's: without this a bare "a" or "m"
// opens a ComfyUI sidebar tab mid-word and Ctrl+Z undoes the graph instead of the typing.
// Bound on window in the capture phase — the first hop — because stopping it at the element (as
// the sidebar's rename field does) is too late for a handler bound above us in the same phase.
// Only the keys the field itself consumes are stopped: arrows, Enter, Tab and Escape travel on,
// so the autocomplete's own handler still drives its menu. Typing still reaches it through the
// `input` event, which is what it listens to for composed (IME) text anyway.
const FIELD_KEYS = /^(Backspace|Delete|Home|End|PageUp|PageDown)$/;
window.addEventListener("keydown", (e) => {
    if (!e.target?.classList?.contains("ere-textarea")) return;
    const editing = !e.ctrlKey && !e.metaKey && !e.altKey
        && (e.key.length === 1 || FIELD_KEYS.test(e.key));
    const undo = (e.ctrlKey || e.metaKey) && "zyZY".includes(e.key);
    if (editing || undo) e.stopPropagation();
}, true);

/**
 * Height the field to its content. Skipped once the user has dragged it to a size of their own:
 * that is a deliberate choice, and the node can be made shorter than its content on purpose
 * (see the Scrollable tag area setting).
 */
function fitTextarea(area) {
    if (area._ereLocked || !area.isConnected) return;
    area.style.height = "auto";
    const target = `${area.scrollHeight}px`;
    area.style.height = target;
    // What the resize observer compares against to tell our height from a dragged one.
    area._ereAutoHeight = target;
}

/** Apply the row's stored height, or fit the text when it has none. */
function applyTextareaHeight(area, row) {
    area._ereLocked = !!row.height;
    if (row.height) {
        area.style.height = `${row.height}px`;
        area._ereAutoHeight = area.style.height;
        return;
    }
    fitTextarea(area);
}

/**
 * One textarea per multiline category, kept across renders rather than rebuilt — the same reason
 * the context menu carries its filter box over. A fresh element would lose focus, the caret and
 * the height, and this node re-renders on every edit anywhere in it.
 */
function textareaFor(node, index) {
    const cache = node._composerAreas || (node._composerAreas = new Map());
    let area = cache.get(index);
    if (!area) {
        area = document.createElement("textarea");
        area.className = "ere-textarea";
        area.spellcheck = false;
        area.placeholder = "Prompt text";
        area.addEventListener("input", () => {
            setRowText(node, index, area.value);
            fitTextarea(area);
        });
        // Belt and braces for anything bound below the window guard above.
        area.addEventListener("keydown", (e) => e.stopPropagation());
        markTextDropZone(area, node);
        // The resize grip writes `style.height` itself, which is how a dragged height is told from
        // one we set. Anything else that changes the box (the node's width, so the text re-wraps)
        // just re-fits, which is a no-op once the height already matches.
        new ResizeObserver(() => {
            const height = area.style.height;
            if (height && height !== area._ereAutoHeight) {
                area._ereLocked = true;
                area._ereAutoHeight = height;
                saveRowHeightSoon(node, index, parseFloat(height));
                return;
            }
            fitTextarea(area);
        }).observe(area);
        cache.set(index, area);
    }
    return area;
}

// Transport

/**
 * One hidden `row_<n>` widget per category — widget names are what the frontend sends as API input names (see _AnyRow in py/prompt.py).
 * Appended after the fixed widgets and recomputed on every update, so a changed row count cannot shift `text` or `separator` when LiteGraph restores values by position.
 */
function syncRowWidgets(node, texts) {
    node.widgets = node.widgets || [];
    const rowWidgets = node.widgets.filter(w => /^row_\d+$/.test(w.name || ""));

    while (rowWidgets.length < texts.length) {
        const widget = node.addWidget?.("text", `row_${rowWidgets.length}`, "", () => {});
        if (!widget) break;
        hideNativeWidget(widget);
        rowWidgets.push(widget);
    }
    while (rowWidgets.length > texts.length) {
        const widget = rowWidgets.pop();
        const at = node.widgets.indexOf(widget);
        if (at !== -1) node.widgets.splice(at, 1);
    }
    rowWidgets.forEach((widget, i) => { widget.value = texts[i] ?? ""; });
}

/** Rows join the way chained nodes do; Python repeats this on the same values. */
function joinRows(texts, separator) {
    return joinPrompt(texts.filter(t => t && t.trim()), separator || ",\\n\\n");
}

/** Recompute every category: its text, the flat mirror, the transport widgets and the node's combined text. */
export async function updateComposer(node) {
    const rows = ensureRows(node);
    const texts = [];

    // One undo step for the pass, not one per category.
    beginUndoTransaction();
    try {
        for (const [index, row] of rows.entries()) {
            // A multiline row emits its text as typed — that is the whole point of the layout.
            if (row.layout === "multiline") {
                texts.push(row.active ? (row.text || "") : "");
                continue;
            }
            const host = hostFor(node, index);
            host.title = row.title;
            host.properties._tagDataJSON = JSON.stringify(row.tags, null, 2);
            // One separator setting for the node, not one per row. Tile size travels the same way.
            host.properties._tagSeparator = node.properties._tagSeparator;
            host.properties._tagImageWidth = node.properties._tagImageWidth;
            host.properties._tagImageHeight = node.properties._tagImageHeight;
            host.widgets[0].value = "";
            await host.computeText(host);
            texts.push(row.active ? host.widgets[0].value : "");
        }
        syncRowWidgets(node, texts);
        const textWidget = node.widgets?.find(w => w.name === "text");
        if (textWidget) textWidget.value = joinRows(texts, node.properties._prefixSeparator);
        captureUndoState();
    } finally {
        endUndoTransaction();
    }
}

// Row Actions

async function commit(node) {
    await node.onUpdateTextWidget?.(node);
    app.graph?.setDirtyCanvas?.(true, true);
}

export function addRow(node, layout = "cloud") {
    const rows = getRows(node);
    rows.push(makeRow(`Category ${rows.length + 1}`, [], layout));
    dropRowSelection(node);
    setRows(node, rows);
    commit(node);
}

/** A new category from the clipboard, drawn as whatever its text turns out to be. */
export async function addRowFromClipboard(node) {
    let text = "";
    try { text = await navigator.clipboard.readText(); } catch { return; }
    text = (text || "").trim();
    if (!text) return;

    const rows = getRows(node);
    const title = `Category ${rows.length + 1}`;
    if (looksLikeProse(text)) {
        const row = makeRow(title, [], "multiline");
        row.text = text;
        rows.push(row);
    } else {
        const tags = parseTextToTagData(text);
        if (!tags.length) return;
        rows.push(makeRow(title, tags));
    }
    dropRowSelection(node);
    setRows(node, rows);
    commit(node);
}

/**
 * Switch how a category draws itself. The four pill layouts share one tag list and convert
 * nothing; multiline has no tags, so the trip in and out goes through text — lossy in exactly
 * the place converting a whole node to Prompt Multiline has always been lossy.
 */
async function setRowLayout(node, index, layout) {
    const rows = getRows(node);
    const row = rows[index];
    if (!row || row.layout === layout) return;

    if (layout === "multiline") {
        row.text = await tagsToText(row.tags, node.properties._tagSeparator);
        row.tags = [];
    } else if (row.layout === "multiline") {
        row.tags = parseTextToTagData(row.text || "");
        row.text = "";
    }
    row.layout = layout;
    // The host at this index now holds a different tag list, so anything selected in it is stale.
    clearAllSelections();
    setRows(node, rows);
    commit(node);
}

/** The "+" on a multiline category: the pick is written into the text at the caret, as a drop is. */
function addTextTag(node, index, e) {
    const area = node._composerAreas?.get(index);
    if (!area) return;
    const existing = parseTextToTagData(area.value).map(tag => ({ name: tag.name, type: tag.type }));
    new TagContextMenuInsert(e, async (tagObject) => {
        if (!tagObject?.name) return;
        await insertTagsAsText(area, [{ ...tagObject, active: true }], node.properties._tagSeparator);
    }, existing);
}

/** A dragged height, stored on the row so it survives a reload. Null means "fit the text" again. */
function setRowHeight(node, index, height) {
    const rows = getRows(node);
    if (!rows[index] || rows[index].height === height) return;
    rows[index].height = height;
    setRows(node, rows);
    // The field is already that tall; a repaint here would only cost it its focus.
    node._ereDom?.markRendered?.();
    captureUndoState();
}

// Dragging the grip fires the observer continuously; one write per gesture, not per pixel.
let heightTimer = 0;
function saveRowHeightSoon(node, index, height) {
    clearTimeout(heightTimer);
    heightTimer = setTimeout(() => setRowHeight(node, index, height), 200);
}

/** Back to fitting the text: the only way out of a height the user set by hand. */
function fitRowHeight(node, index) {
    setRowHeight(node, index, null);
    const area = node._composerAreas?.get(index);
    if (!area) return;
    area._ereLocked = false;
    fitTextarea(area);
}

/** A multiline row's text, saved without re-rendering — the textarea being typed into is in the DOM we would replace. */
function setRowText(node, index, text) {
    const rows = getRows(node);
    if (!rows[index] || rows[index].text === text) return;
    rows[index].text = text;
    setRows(node, rows);
    // Before the update: its undo checkpoint raises `graphChanged`, and the repaint that follows
    // would re-parent the textarea being typed into — which blurs it, so the next character goes
    // to <body> and ComfyUI's keybindings answer it instead.
    node._ereDom?.markRendered?.();
    updateComposer(node);
}

export function removeAllRows(node) {
    dropRowSelection(node);
    clearAllSelections();
    setRows(node, []);
    commit(node);
}

function removeRows(node, indices) {
    const drop = new Set(indices);
    const rows = getRows(node).filter((_, i) => !drop.has(i));
    dropRowSelection(node);
    clearAllSelections();
    setRows(node, rows);
    commit(node);
}

const removeRow = (node, index) => removeRows(node, [index]);

/** @param {"active"|"open"} field */
function toggleRow(node, index, field) {
    const rows = getRows(node);
    if (!rows[index]) return;
    rows[index][field] = !rows[index][field];
    setRows(node, rows);
    commit(node);
}

export function setAllRows(node, field, value) {
    const rows = getRows(node);
    for (const row of rows) row[field] = value;
    setRows(node, rows);
    commit(node);
}

/** Live rename. The title never reaches the prompt, so nothing is recomputed. */
function renameRow(node, index, title) {
    const rows = getRows(node);
    if (!rows[index] || rows[index].title === title) return;
    rows[index].title = title;
    setRows(node, rows);
    // The label below is the repaint; `graphChanged` must not order another one.
    node._ereDom?.markRendered?.();
    const label = node._ereDom?.content?.querySelector(
        `[data-ere-row="${index}"] .ere-composer-title`);
    if (label) {
        label.textContent = title;
        label.title = `${title}\nRight-click to rename or remove · drag to reorder`;
    }
    captureUndoState();
}

/** Move categories, within a node or between two Composers. `index` counts the rows still in place. `copy` leaves the originals where they are (Alt, across nodes only). */
async function moveRows(sourceNode, indices, targetNode, index, copy = false) {
    const source = getRows(sourceNode);
    const picked = indices.map(i => source[i]).filter(Boolean);
    if (!picked.length) return;
    dropRowSelection(sourceNode);
    clearAllSelections();

    if (copy) {
        const target = getRows(targetNode);
        target.splice(Math.min(index, target.length), 0, ...JSON.parse(JSON.stringify(picked)));
        setRows(targetNode, target);
        await commit(targetNode);
        return;
    }

    const drop = new Set(indices);
    const keep = source.filter((_, i) => !drop.has(i));

    if (sourceNode === targetNode) {
        keep.splice(Math.min(index, keep.length), 0, ...picked);
        setRows(sourceNode, keep);
        await commit(sourceNode);
        return;
    }

    beginUndoTransaction();
    try {
        setRows(sourceNode, keep);
        const target = getRows(targetNode);
        target.splice(Math.min(index, target.length), 0, ...picked);
        setRows(targetNode, target);
        await commit(sourceNode);
        await commit(targetNode);
    } finally {
        endUndoTransaction();
    }
}

// A pill drag that *rests* on a folded category opens it, rather than dropping into something the
// user cannot see. Its pills are already rendered inside the hidden body, so dropping the class is
// enough for the drag layer to find them — no re-render mid-drag.
// It waits, because a drag on its way to a row further down passes over every folded row between:
// opening each one in turn moves the target out from under the pointer.
const HOVER_OPEN_MS = 500;
const hoverOpen = { el: null, timer: 0 };

function cancelHoverOpen() {
    clearTimeout(hoverOpen.timer);
    hoverOpen.el = null;
    hoverOpen.timer = 0;
}

window.addEventListener("pointermove", (e) => {
    const el = isDragActive()
        ? document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".ere-composer-row.collapsed")
        : null;
    if (el === hoverOpen.el) return;
    cancelHoverOpen();
    if (!el) return;
    hoverOpen.el = el;
    hoverOpen.timer = setTimeout(() => {
        cancelHoverOpen();
        if (!isDragActive() || !el.isConnected) return;
        el.classList.remove("collapsed");
        const node = el.closest(".ere-composer")?._ereComposerNode;
        if (!node) return;
        const rows = getRows(node);
        const index = Number(el.dataset.ereRow);
        if (!rows[index]) return;
        rows[index].open = true;
        setRows(node, rows);
    }, HOVER_OPEN_MS);
}, true);

// Row Selection
// The pill semantics, on categories: ctrl toggles, ctrl+drag bands, shift ranges, a plain press clears. Kept here rather than in dragdrop.js because that module's selection is indices into a tag list; this one is indices into the row list, and only the visuals are shared (`.ere-selected`, `.ere-marquee`).

/** The one node holding a row selection, if any — same rule as pills: what you can see is what a drag carries. */
let selectionNode = null;
let selectionAnchor = -1;

const rowSelection = (node) => node._composerSel || (node._composerSel = new Set());

export function clearRowSelection(except = null) {
    if (!selectionNode || selectionNode === except) return;
    const node = selectionNode;
    selectionNode = null;
    selectionAnchor = -1;
    node._composerSel?.clear();
    syncRowSelectionClasses(node);
}

function syncRowSelectionClasses(node) {
    const selected = node._composerSel;
    for (const el of node._ereDom?.content?.querySelectorAll("[data-ere-row]") ?? []) {
        el.classList.toggle("ere-selected", !!selected?.has(Number(el.dataset.ereRow)));
    }
}

function setRowSelection(node, indices) {
    clearRowSelection(node);
    selectionNode = indices.length ? node : null;
    const selected = rowSelection(node);
    selected.clear();
    for (const i of indices) selected.add(i);
    syncRowSelectionClasses(node);
}

function selectedRowIndices(node) {
    return [...(node._composerSel ?? [])].sort((a, b) => a - b);
}

const isRowSelected = (node, index) => !!node._composerSel?.has(index);

/** Row order changed under the selection, so what it points at no longer holds. */
function dropRowSelection(node) {
    if (selectionNode === node) clearRowSelection();
}

/**
 * Ctrl/Shift press on a header: a rubber band, a toggle, or a range — never a drag.
 * Same thresholds as the pill marquee, and the same `.ere-marquee` band.
 */
function beginRowSelectPress(node, index, e) {
    e.preventDefault();
    e.stopPropagation();

    if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
        const from = selectionAnchor === -1 ? index : selectionAnchor;
        const [lo, hi] = from <= index ? [from, index] : [index, from];
        const anchor = from;
        setRowSelection(node, Array.from({ length: hi - lo + 1 }, (_, i) => lo + i));
        selectionAnchor = anchor;
        return;
    }

    const base = selectionNode === node ? selectedRowIndices(node) : [];
    const list = node._ereDom?.content?.querySelector(".ere-composer");
    const start = { x: e.clientX, y: e.clientY };
    let band = null;

    const update = (x, y) => {
        const left = Math.min(start.x, x), top = Math.min(start.y, y);
        const width = Math.abs(x - start.x), height = Math.abs(y - start.y);
        Object.assign(band.style, {
            left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`,
        });
        // XOR against what the band started from, like Explorer and like the pills.
        const next = new Set(base);
        for (const el of list?.children ?? []) {
            if (!el.classList?.contains("ere-composer-row")) continue;
            const r = el.getBoundingClientRect();
            if (r.left < left + width && r.right > left && r.top < top + height && r.bottom > top) {
                const i = Number(el.dataset.ereRow);
                if (next.has(i)) next.delete(i);
                else next.add(i);
            }
        }
        setRowSelection(node, [...next]);
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
        window.removeEventListener("pointerup", onUp, true);
        window.removeEventListener("pointercancel", finish, true);
        band?.remove();
        band = null;
        document.body.classList.remove("ere-marquee-active");
    };
    const onUp = () => {
        const banded = !!band;
        finish();
        // A ctrl press that never moved is a plain ctrl+click: toggle this one.
        if (banded) return;
        const next = new Set(base);
        if (next.has(index)) next.delete(index);
        else next.add(index);
        setRowSelection(node, [...next]);
        selectionAnchor = index;
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", finish, true);
}

/** Right-click inside a selection: what applies to all of them. */
function openSelectionMenu(node, indices, e) {
    const apply = (field, value) => {
        const rows = getRows(node);
        for (const i of indices) if (rows[i]) rows[i][field] = value;
        setRows(node, rows);
        commit(node);
    };
    new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY },
        `${indices.length} categories selected`, [
            { name: "Enable", callback: () => apply("active", true) },
            { name: "Disable", callback: () => apply("active", false) },
            null,
            { name: "Expand", callback: () => apply("open", true) },
            { name: "Collapse", callback: () => apply("open", false) },
            null,
            { name: "Remove Selected", callback: () => removeRows(node, indices) },
        ]);
}

// A press anywhere that is not a category header drops the selection, the way a press outside a tag area drops a pill selection.
window.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (e.target?.closest?.(".ere-composer-head, .litecontextmenu")) return;
    clearRowSelection();
}, true);

window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !selectionNode) return;
    const active = document.activeElement;
    if (active && (active.nodeName === "INPUT" || active.nodeName === "TEXTAREA")) return;
    clearRowSelection();
}, true);

// Row Drag
// Categories are dragged by their header and only ever land in a Composer, so this does not go through dragdrop.js (which moves tags between tag areas). Everything visible is shared with it though: the same ghost, placeholder and copy classes, and the same Alt.

const rowDrag = { pending: null, active: null };
let rowClickSuppressed = false;

/** True once, right after a row drag — so the drop does not also toggle the accordion. */
function consumeRowClick() {
    if (!rowClickSuppressed) return false;
    rowClickSuppressed = false;
    return true;
}

function endRowSession() {
    if (rowDrag.pending?.timer) clearTimeout(rowDrag.pending.timer);
    rowDrag.pending = null;
    window.removeEventListener("pointermove", onRowPointerMove, true);
    window.removeEventListener("pointerup", onRowPointerUp, true);
    window.removeEventListener("pointercancel", onRowPointerCancel, true);
    window.removeEventListener("keydown", onRowKey, true);
    window.removeEventListener("keyup", onRowKeyUp, true);
}

/** Alt over another Composer copies instead of moving: the source comes back dimmed and the ghost gains a "+". Appearance only. */
function setRowCopyMode(d, copying) {
    if (d.copying === copying) return;
    d.copying = copying;
    for (const el of d.rowEls) el.classList.toggle("ere-drag-copy", copying);
    d.ghost.classList.toggle("ere-copy", copying);
}

function setRowAlt(alt) {
    const d = rowDrag.active;
    if (!d || d.alt === alt) return;
    d.alt = alt;
    updateRowDrag(d.lastX, d.lastY);
}

function beginRowPress(node, rowIndex, rowEl, head, e) {
    if (e.button !== 0 || rowDrag.active) return;
    if (e.target?.closest?.("button, .ere-switch")) return;
    // Otherwise the press selects the header text instead of dragging the row.
    e.preventDefault();

    // Pressing a selected category carries the whole selection; pressing any other drops it.
    const indices = isRowSelected(node, rowIndex) ? selectedRowIndices(node) : [rowIndex];
    if (!isRowSelected(node, rowIndex)) clearRowSelection();

    endRowSession();
    rowDrag.pending = {
        node, rowIndex, indices, rowEl, head,
        startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
        alt: e.altKey,
        timer: setTimeout(() => { if (rowDrag.pending) startRowDrag(); }, HOLD_MS),
    };
    window.addEventListener("pointermove", onRowPointerMove, true);
    window.addEventListener("pointerup", onRowPointerUp, true);
    window.addEventListener("pointercancel", onRowPointerCancel, true);
    window.addEventListener("keydown", onRowKey, true);
    window.addEventListener("keyup", onRowKeyUp, true);
}

function startRowDrag() {
    const p = rowDrag.pending;
    rowDrag.pending = null;
    if (p?.timer) clearTimeout(p.timer);
    if (!p || !p.rowEl.isConnected) return;

    const list = p.rowEl.parentElement;
    const rowEls = p.indices
        .map(i => list?.querySelector(`[data-ere-row="${i}"]`))
        .filter(Boolean);
    if (!rowEls.includes(p.rowEl)) rowEls.push(p.rowEl);

    const rect = p.rowEl.getBoundingClientRect();
    // Scale by the canvas zoom, as the pill ghost does.
    const scale = p.rowEl.offsetWidth ? rect.width / p.rowEl.offsetWidth : 1;

    const ghost = document.createElement("div");
    ghost.className = `${SURFACE_CLASS} ere-drag-ghost`;
    // A row-shaped face, so the ghost's outline follows the same rounded box the row has.
    const face = document.createElement("div");
    face.className = "ere-composer-row collapsed";
    face.style.width = `${p.rowEl.offsetWidth}px`;
    face.appendChild(p.head.cloneNode(true));
    ghost.appendChild(face);
    if (rowEls.length > 1) {
        // The pill ghost's badge, with the one number a set of categories has.
        const counts = document.createElement("div");
        counts.className = "ere-drag-counts";
        const badge = document.createElement("div");
        badge.className = "ere-drag-count";
        badge.textContent = String(rowEls.length);
        counts.appendChild(badge);
        ghost.appendChild(counts);
    }
    ghost.style.transform = `scale(${scale})`;
    document.body.appendChild(ghost);

    const placeholder = document.createElement("div");
    placeholder.className = "ere-drop-placeholder ere-composer-placeholder";
    placeholder.style.height = `${p.rowEl.offsetHeight}px`;

    // The placeholder is the row's place now; leaving the originals in the flow would show them twice, exactly as it would for a pill.
    for (const el of rowEls) el.classList.add("ere-drag-source");
    document.body.classList.add("ere-dragging-active");

    rowDrag.active = {
        ...p, ghost, placeholder, rowEls,
        grabX: p.x - rect.left, grabY: p.y - rect.top,
        target: null, index: 0, copying: false,
    };
    updateRowDrag(p.x, p.y);
}

function updateRowDrag(x, y) {
    const d = rowDrag.active;
    if (!d) return;
    d.ghost.style.left = `${x - d.grabX}px`;
    d.ghost.style.top = `${y - d.grabY}px`;

    d.lastX = x;
    d.lastY = y;

    // Anywhere on a Composer counts, not just its list of categories: an empty one has a zero-height list, and there would be nothing to aim at.
    const under = document.elementFromPoint(x, y);
    const list = under?.closest?.(".ere-composer")
        ?? under?.closest?.(".erenodes-dom")?.querySelector?.(".ere-composer");
    if (!list?._ereComposerNode) {
        d.placeholder.remove();
        d.ghost.classList.add("ere-no-drop");
        d.target = null;
        setRowCopyMode(d, false);
        return;
    }
    d.ghost.classList.remove("ere-no-drop");
    // Alt copies, but only into another Composer: a copy in place would sit next to the category it came from with the same name and contents.
    setRowCopyMode(d, d.alt && list._ereComposerNode !== d.node);

    const items = [...list.children].filter(
        el => el.classList.contains("ere-composer-row") && !d.rowEls.includes(el));
    let index = items.length;
    for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (y < r.top + r.height / 2) { index = i; break; }
    }
    list.insertBefore(d.placeholder, items[index] ?? null);
    d.target = list._ereComposerNode;
    d.index = index;
}

function onRowPointerMove(e) {
    if (rowDrag.active) {
        e.stopPropagation();
        e.preventDefault();
        rowDrag.active.alt = e.altKey;
        updateRowDrag(e.clientX, e.clientY);
        return;
    }
    const p = rowDrag.pending;
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > MOVE_THRESHOLD) startRowDrag();
}

function teardownRowDrag() {
    const d = rowDrag.active;
    if (!d) return null;
    d.ghost.remove();
    d.placeholder.remove();
    for (const el of d.rowEls) el.classList.remove("ere-drag-source", "ere-drag-copy");
    document.body.classList.remove("ere-dragging-active");
    rowDrag.active = null;
    rowClickSuppressed = true;
    setTimeout(() => { rowClickSuppressed = false; }, 50);
    return d;
}

function onRowPointerUp(e) {
    const d = rowDrag.active;
    if (d) d.alt = e.altKey;
    teardownRowDrag();
    endRowSession();
    if (!d || !d.target) return;
    e.stopPropagation();
    moveRows(d.node, d.indices, d.target, d.index, d.alt && d.target !== d.node);
}

function onRowPointerCancel() {
    teardownRowDrag();
    endRowSession();
}

function onRowKey(e) {
    if (!rowDrag.active && !rowDrag.pending) return;
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        teardownRowDrag();
        endRowSession();
        return;
    }
    // Alt produces no pointer event, so the copy mode has to be read from the key itself.
    if (e.key === "Alt") e.preventDefault();
    setRowAlt(e.altKey || e.key === "Alt");
}

function onRowKeyUp(e) {
    setRowAlt(e.key === "Alt" ? false : e.altKey);
}

// Rendering

function rowButton(label, title, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ere-btn";
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
    return btn;
}

/** The layouts a category can be drawn as, current one marked. */
export function layoutMenuItem(node, index, current) {
    return {
        name: "Layout",
        submenu: ROW_LAYOUTS.map(layout => ({
            name: `${layout.id === current ? "✓ " : ""}${layout.label}`,
            callback: () => setRowLayout(node, index, layout.id),
        })),
    };
}

/**
 * The row's ≡, and its right-click: everything a category has.
 * The title leads as a live field (focused on open) and Remove closes the list, so there is no
 * second menu — two entries never justified one.
 */
function openRowMenu(node, index, host, e) {
    const row = getRows(node)[index];
    const anchor = { clientX: e.clientX, clientY: e.clientY };
    const head = [
        {
            type: "input",
            // Renaming does not re-render, so read the title back rather than trusting a closure.
            value: row?.title || "",
            placeholder: "Category",
            onInput: (value) => renameRow(node, index, value),
        },
        null,
        layoutMenuItem(node, index, row?.layout || "cloud"),
        null,
    ];
    const tail = [null, { name: "Remove Category", callback: () => removeRow(node, index) }];

    // A multiline row has no tags for any of the tag actions to act on.
    if (row?.layout === "multiline") {
        // Its text parses to tags like any other prompt text — one text pill per sentence — so
        // saving and exporting a category of prose is the same action it is everywhere else.
        const textTags = parseTextToTagData(row.text || "");
        new ActionContextMenu(anchor, null, [
            ...head,
            { name: "Clear Text", callback: () => setRowText(node, index, "") },
            // The one way back from a height dragged by hand.
            { name: "Fit Height to Text", disabled: !row.height,
              callback: () => fitRowHeight(node, index) },
            null,
            {
                name: "Save Tag Group",
                disabled: !textTags.length,
                callback: () => host.onSaveTagGroup?.(e, { tags: textTags, indices: [] }),
            },
            {
                name: "Export Tags (.json)",
                disabled: !textTags.length,
                callback: () => host.onExportTags?.(textTags),
            },
            ...tail,
        ]);
        return;
    }

    const tags = parseTags(host.properties._tagDataJSON || "[]");
    // The node menu's own order, minus what only a whole node can do (convert, fit height).
    new ActionContextMenu(anchor, null, [
        ...head,
        { name: "Replace Tags from Clipboard", callback: () => host.onClipboardReplace?.() },
        { name: "Add Tags from Clipboard", callback: () => host.onClipboardAppend?.() },
        null,
        { name: "Toggle All Tags", callback: () => host.onToggleTags?.() },
        { name: "Remove All Tags", callback: () => host.onRemoveTags?.("all") },
        { name: "Remove Inactive Tags", callback: () => host.onRemoveTags?.("inactive") },
        null,
        { name: "Load Tag Group", callback: () => host.onLoadTagGroup?.(e) },
        {
            name: "Save Tag Group",
            disabled: tags.filter(t => t.type !== "group").length < 2,
            callback: () => host.onSaveTagGroup?.(e),
        },
        null,
        { name: "Import Tags (.json)", callback: () => host.onImportTags?.() },
        { name: "Export Tags (.json)", callback: () => host.onExportTags?.() },
        ...tail,
    ]);
}

function renderRow(node, row, index, colors) {
    const multiline = row.layout === "multiline";
    const host = hostFor(node, index);
    // Undo/redo re-renders without an update pass, so re-seed here.
    host.properties._tagDataJSON = JSON.stringify(row.tags, null, 2);
    host.properties._tagImageWidth = node.properties._tagImageWidth;
    host.properties._tagImageHeight = node.properties._tagImageHeight;

    // The row is the drag root: that class, `_ereNode` and `_ereMode` are how the drag layer resolves a drop target, and putting them here rather than on the tag area means a folded category still takes a drop (on its header).
    const el = document.createElement("div");
    el.className = `erenodes-dom ${SURFACE_CLASS} ere-composer-row`
        + (row.active ? "" : " inactive")
        + (row.open ? "" : " collapsed")
        + (isRowSelected(node, index) ? " ere-selected" : "");
    el.dataset.ereRow = String(index);
    el._ereNode = host;
    // The drag layer treats the row as a node of that type — column drops for toggle, tile-sized
    // placeholders for gallery, and no pill drops at all for multiline.
    el._ereMode = row.layout;

    // `ere-toolbar` is what tells the drag layer this strip is not tag area: without it a press here would open a marquee and never reach the accordion or the row drag.
    const head = document.createElement("div");
    head.className = "ere-toolbar ere-composer-head";
    head.appendChild(rowButton("≡", "Category menu", (e) => openRowMenu(node, index, host, e)));
    head.appendChild(rowButton("+", "Add tag", (e) => (multiline
        ? addTextTag(node, index, e)
        : host.onAddTag?.(e, [0, 0]))));

    const title = document.createElement("span");
    title.className = "ere-composer-title";
    title.textContent = row.title || "Category";
    title.title = `${row.title || "Category"}\nRight-click to rename or remove · drag to reorder`;
    head.appendChild(title);

    // What is folded away, by type — the drag ghost's badges. Only while folded: with the pills on screen it would be counting what you are looking at.
    if (!row.open && !multiline) {
        const badges = buildCountBadges(row.tags.filter(t => t.active !== false));
        if (badges) head.appendChild(badges);
    }

    const sw = renderSwitchEl(row.active, "tag");
    sw.classList.add("ere-composer-switch");
    sw.title = row.active ? "Disable category (keeps its tags)" : "Enable category";
    sw.addEventListener("click", (e) => { e.stopPropagation(); toggleRow(node, index, "active"); });
    head.appendChild(sw);

    head.addEventListener("click", (e) => {
        if (e.target?.closest?.("button, .ere-switch")) return;
        // The press already answered a modified click — folding here would undo it.
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (consumeRowClick()) return;
        // A plain click drops the selection and folds just this one, as it does for a pill.
        clearRowSelection();
        toggleRow(node, index, "open");
    });
    // A selection of several categories keeps its right-click menu: it acts on the set, not on
    // this row, so it is not the ≡'s to open. A single category has no right-click menu at all —
    // the ≡ is the one way in, and a header opening the same entries is a second place to look.
    head.addEventListener("contextmenu", (e) => {
        const selected = selectedRowIndices(node);
        if (selected.length < 2 || !selected.includes(index)) return;
        e.preventDefault();
        e.stopPropagation();
        openSelectionMenu(node, selected, e);
    });
    head.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.("button, .ere-switch")) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return beginRowSelectPress(node, index, e);
        beginRowPress(node, index, el, head, e);
    });
    el.appendChild(head);

    const body = document.createElement("div");
    // The field is the whole body, so it carries the padding and the tint (see composer.css).
    body.className = "ere-composer-body" + (multiline ? " ere-composer-text" : "");
    el.appendChild(body);

    if (multiline) {
        const area = textareaFor(node, index);
        // While it has focus, what the user is typing is newer than what we were rendered with.
        const focused = document.activeElement === area;
        if (!focused && area.value !== (row.text || "")) {
            area.value = row.text || "";
        }
        // Re-parenting takes an element out of the document for an instant, which blurs it —
        // and a blurred field hands the next keystroke to ComfyUI's keybindings. Put it back.
        const [start, end] = [area.selectionStart, area.selectionEnd];
        body.appendChild(area);
        if (focused) {
            area.focus();
            area.setSelectionRange(start, end);
        }
        // After appending: a detached textarea has no scrollHeight to fit to.
        applyTextareaHeight(area, row);
        // No pills here, so nothing should be holding this row's previous tag area.
        host._ereDom = null;
        return el;
    }

    // Before rendering: the pills read the selection as they are built.
    pruneSelection(host, row.tags);
    const tagArea = renderTagBody(host, body, row.layout, colors, row.tags);
    tagArea.classList.add("ere-composer-tags");
    host._ereDom = { el, content: tagArea, render: () => node._ereDom?.render?.() };
    return el;
}

/**
 * Tags dropped on the toolbar's "+ Category" become one.
 * Wired through the drag layer's external-drop hook — the same one the sidebar folders use — so the ghost, the highlight and the drop all come for free.
 */
function markAddDropZone(button, node) {
    button.dataset.ereSidebarDrop = "1";
    button._ereDropCopy = false;   // the tags move here, they are not being saved somewhere
    button._ereSidebarDrop = (tags, path, source, origin, alt) =>
        dropAsCategory(node, tags, source, origin, alt);
}

async function dropAsCategory(node, tags, source, origin, alt) {
    const clean = (list) => (list || [])
        .filter(t => t?.name)
        .map(t => JSON.parse(JSON.stringify(t)));

    // Alt drops tag groups' *contents*, so the pills that carried their names are gone.
    // One category per group then, each keeping its own name — the flattened payload the ghost carries cannot say which tag came from which group, so the sidebar sends both.
    const incoming = alt && origin?.groups?.length
        ? origin.groups.map(g => ({
            title: String(g.name || "").split(/[\\/]/).pop().replace(/\.json$/i, ""),
            tags: clean(g.tags),
          }))
        : [{ title: "", tags: clean(tags) }];

    const added = incoming.filter(g => g.tags.length);
    if (!added.length) return;

    beginUndoTransaction();
    try {
        // A drag out of a tag area is a move; one in from the sidebar has no source to take from.
        if (source?.properties) {
            const names = new Set(added.flatMap(g => g.tags.map(t => t.name)));
            const left = parseTags(source.properties._tagDataJSON || "[]").filter(t => !names.has(t.name));
            source.properties._tagDataJSON = JSON.stringify(left, null, 2);
            await source.onUpdateTextWidget?.(source);
        }
        const rows = getRows(node);
        for (const group of added) {
            rows.push(makeRow(group.title || `Category ${rows.length + 1}`, group.tags));
        }
        setRows(node, rows);
        clearAllSelections();
        await commit(node);
    } finally {
        endUndoTransaction();
    }
}

/** Draw the categories. Called by renderer.js for mode "composer". */
export function renderComposer(node, content, colors) {
    const rows = ensureRows(node);
    dropStaleHosts(node, rows);
    // The toolbar is rebuilt on every render, so the button is wired on every render.
    const add = node._ereDom?.toolbar?.querySelector(".ere-composer-add");
    if (add) markAddDropZone(add, node);

    const list = document.createElement("div");
    list.className = "ere-composer";
    list.dataset.ereComposer = String(node.id);
    // How a row drag resolves the Composer it is over.
    list._ereComposerNode = node;
    rows.forEach((row, i) => list.appendChild(renderRow(node, row, i, colors)));
    content.appendChild(list);

    // Same fire-and-forget as the node renderer: draw from what is known, repaint once if a "this file is gone" verdict arrives late.
    ensureChecked(rows.flatMap(r => r.tags)).then((learned) => {
        if (learned) node._ereDom?.render?.();
    });
}
