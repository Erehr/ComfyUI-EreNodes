// Pill drag & drop + multi-selection.
//
// Three features, one state machine, because they overlap:
//   1. Reorder pills inside a node by dragging them.
//   2. Drag pills from one pill-based Ere node into another (all modes except
//      multiline, which has no pills).
//   3. Ctrl/Shift click multi-selection; a drag that starts on a selected pill
//      carries the whole selection.
//
// Pills stay clickable (click = toggle active), so a drag only starts after a
// short hold OR a few pixels of movement — whichever comes first. The click
// that follows a drag is swallowed (see consumeDragClick).
//
// Everything here is DOM-only; the renderer owns rendering and simply calls
// attachPillDrag() / markDropZone() while it builds pills.

import { app } from "../../../scripts/app.js";
import { beginUndoTransaction, endUndoTransaction } from "./undo.js";
import { TagSelectionContextMenu } from "./contextmenu.js";
import { accentForTags, hexToRgbTriplet, TYPE_ACCENT, DEFAULT_ACCENT } from "./tagcolors.js";
import { injectTagStyles } from "./tagview.js";

const PILL_SELECTOR = ".ere-pill, .ere-toggle-row, .ere-tile";
const HOLD_MS = 200;          // press-and-hold to enter reorder mode
const MOVE_THRESHOLD = 5;     // ...or just move this far in px
const SCROLL_EDGE = 24;       // auto-scroll band inside a scrollable tag area
const SCROLL_SPEED = 12;

// Modes that take part in drag & drop (multiline has no pill system).
const DND_MODES = new Set(["cloud", "toggle", "multiselect", "randomizer", "gallery"]);
// One pill row / one toggle row, in layout px (matches .ere-pill in renderer.js).
const PILL_ROW_H = 20;

const state = {
    pending: null,   // press in progress, may still become a plain click
    drag: null,      // active drag
    marquee: null,   // ctrl-drag rubber-band selection
};

let clickSuppressed = false;

// ---------------------------------------------------------------- tag access

const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

const getTags = node => parseTags(node?.properties?._tagDataJSON || "[]");

async function setTags(node, tags) {
    node.properties._tagDataJSON = JSON.stringify(tags, null, 2);
    // The renderer wraps onUpdateTextWidget to re-render + resize, and it also
    // records the undo checkpoint.
    if (node.onUpdateTextWidget) await node.onUpdateTextWidget(node);
    else node._ereDom?.render?.();
    app.graph?.setDirtyCanvas?.(true, true);
}

function toast(severity, summary, detail) {
    try {
        app.extensionManager?.toast?.add({ severity, summary, detail, life: 3000 });
    } catch {}
}

// ------------------------------------------------------------------ selection
//
// Selection lives on the node object (not in properties — it must not be
// serialized into the workflow) as index → name pairs. Storing the name lets
// pruneSelection() drop entries after the tag data shifted underneath us.

// Nodes that currently hold a selection. Tracked explicitly rather than
// swept from app.graph._nodes so that clearing still reaches a node the user
// has navigated away from (subgraphs). Entries drain on the next clear-all.
const selectedNodes = new Set();

function selOf(node, create = false) {
    if (!node._ereSel && create) {
        node._ereSel = { indices: new Set(), names: new Map(), anchor: null };
    }
    return node._ereSel;
}

function trackSelection(node) {
    if (node?._ereSel?.indices.size) selectedNodes.add(node);
    else selectedNodes.delete(node);
}

export function isPillSelected(node, index) {
    return node?._ereSel?.indices.has(index) ?? false;
}

export function getSelectedIndices(node) {
    const s = node?._ereSel;
    return s ? [...s.indices].sort((a, b) => a - b) : [];
}

/** Drop selection entries that no longer point at the tag they were made on. */
export function pruneSelection(node, tagData) {
    const s = node?._ereSel;
    if (!s || !s.indices.size) return;
    for (const i of [...s.indices]) {
        if (tagData[i]?.name !== s.names.get(i)) {
            s.indices.delete(i);
            s.names.delete(i);
        }
    }
    if (!s.indices.size) s.anchor = null;
    trackSelection(node);
}

function selectIndices(node, indices, tags = getTags(node)) {
    // Only one node holds a selection at a time: the highlight you can see is
    // always exactly the set a drag will carry.
    clearAllSelections(node);

    const s = selOf(node, true);
    s.indices.clear();
    s.names.clear();
    for (const i of indices) {
        if (!tags[i]) continue;
        s.indices.add(i);
        s.names.set(i, tags[i].name);
    }
    trackSelection(node);
    applySelectionClasses(node);
}

function clearSelectionState(node) {
    const s = node?._ereSel;
    selectedNodes.delete(node);
    if (!s || (!s.indices.size && s.anchor == null)) return false;
    s.indices.clear();
    s.names.clear();
    s.anchor = null;
    applySelectionClasses(node);
    return true;
}

/** @param {?object} except node to leave alone (the one taking over). */
export function clearAllSelections(except = null) {
    for (const n of [...selectedNodes]) {
        if (n !== except) clearSelectionState(n);
    }
}

/** Sync `.ere-selected` classes without a full re-render. */
function applySelectionClasses(node) {
    const content = node?._ereDom?.content;
    if (!content) return;
    for (const el of content.querySelectorAll("[data-ere-index]")) {
        el.classList.toggle("ere-selected", isPillSelected(node, Number(el.dataset.ereIndex)));
    }
}

/** Data indices in the order they are currently rendered (skips hidden tags). */
function renderedIndices(node) {
    const content = node?._ereDom?.content;
    if (!content) return [];
    return [...content.querySelectorAll("[data-ere-index]")].map(el => Number(el.dataset.ereIndex));
}

/**
 * Selection-aware click handling, called by the renderer before it forwards a
 * click to onTagPillClick.
 *
 * @returns {boolean} true when the click was consumed here.
 */
export function handlePillSelectClick(node, index, e) {
    const s = selOf(node, true);

    if (e.ctrlKey || e.metaKey) {
        clearAllSelections(node);   // selection stays scoped to one node
        const tags = getTags(node);
        if (s.indices.has(index)) {
            s.indices.delete(index);
            s.names.delete(index);
        } else if (tags[index]) {
            s.indices.add(index);
            s.names.set(index, tags[index].name);
        }
        s.anchor = index;
        trackSelection(node);
        applySelectionClasses(node);
        return true;
    }

    if (e.shiftKey) {
        const order = renderedIndices(node);
        const anchor = s.anchor != null && order.includes(s.anchor) ? s.anchor : index;
        const from = order.indexOf(anchor);
        const to = order.indexOf(index);
        if (from !== -1 && to !== -1) {
            const [lo, hi] = from <= to ? [from, to] : [to, from];
            selectIndices(node, order.slice(lo, hi + 1));
            s.anchor = anchor;
        }
        return true;
    }

    // Any plain click drops the selection and then toggles just that one tag.
    // (Toggling the whole selection was tried and removed: it forced every
    // selected tag to the clicked tag's new state instead of flipping each,
    // and it made a normal click on a selected pill behave surprisingly.)
    clearSelectionState(node);
    return false;
}

// ------------------------------------------------------------------- helpers

function rootOf(el) {
    const root = el?.closest?.(".erenodes-dom");
    if (!root || root.classList.contains("ere-multiline")) return null;
    return root;
}

function pillElement(node, index) {
    return node?._ereDom?.content?.querySelector(`[data-ere-index="${index}"]`) ?? null;
}

/** Visible drop candidates (the dragged pills are hidden, so they drop out). */
function dropItems(container) {
    return [...container.children].filter(
        el => el.dataset?.ereIndex !== undefined && !el.classList.contains("ere-drag-source")
    );
}

/**
 * Position (0..items.length) where the pointer would insert, in terms of the
 * container's visible children.
 */
function computeDropPosition(container, x, y) {
    const items = dropItems(container);
    if (!items.length) return { pos: 0, items };
    const rects = items.map(el => el.getBoundingClientRect());

    if (container.dataset.ereLayout === "column") {
        for (let i = 0; i < rects.length; i++) {
            if (y < rects[i].top + rects[i].height / 2) return { pos: i, items };
        }
        return { pos: items.length, items };
    }

    // Wrapping flow: pick the row the pointer is on (or the closest one),
    // then compare against the horizontal centres inside that row.
    let row = [];
    for (let i = 0; i < rects.length; i++) {
        if (y >= rects[i].top && y <= rects[i].bottom) row.push(i);
    }
    if (!row.length) {
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < rects.length; i++) {
            const d = y < rects[i].top ? rects[i].top - y : y - rects[i].bottom;
            if (d < bestDist - 0.5) { bestDist = d; best = i; }
        }
        const top = rects[best].top;
        for (let i = 0; i < rects.length; i++) {
            if (Math.abs(rects[i].top - top) < 1) row.push(i);
        }
    }
    for (const i of row) {
        if (x < rects[i].left + rects[i].width / 2) return { pos: i, items };
    }
    return { pos: row[row.length - 1] + 1, items };
}

/** Translate a visible-children position into an index in the tag array. */
function toDataIndex(pos, items) {
    if (!items.length) return 0;
    if (pos < items.length) return Number(items[pos].dataset.ereIndex);
    return Number(items[items.length - 1].dataset.ereIndex) + 1;
}

/**
 * Move `movingIndices` (indices into `tags`) so they land in front of whatever
 * currently sits at `targetIndex`, keeping their relative order.
 */
function moveWithin(tags, movingIndices, targetIndex) {
    const moving = new Set(movingIndices);
    const picked = movingIndices.map(i => tags[i]);
    const kept = tags.filter((_, i) => !moving.has(i));
    let insertAt = 0;
    for (let i = 0; i < tags.length && i < targetIndex; i++) {
        if (!moving.has(i)) insertAt++;
    }
    kept.splice(insertAt, 0, ...picked);
    return { tags: kept, insertAt };
}

// ---------------------------------------------------------------- drag ghost

/**
 * Count badges for the drag ghost, one per tag type.
 *
 * A mixed selection used to collapse to a single violet "11", which hid what
 * was actually being carried. Now it reads "10" in tag-blue next to "1" in
 * lora-green — the accent palette already encodes the types, so the badges just
 * reuse it. A single-type drag keeps exactly one badge, as before.
 */
function buildCountBadges(tags) {
    const counts = new Map();
    for (const tag of tags) {
        const type = tag?.type || "tag";
        counts.set(type, (counts.get(type) || 0) + 1);
    }
    if (!counts.size) return null;

    const wrap = document.createElement("div");
    wrap.className = "ere-drag-counts";
    // Stable, meaningful order rather than insertion order.
    const order = ["tag", "lora", "embedding", "group"];
    for (const type of [...counts.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
        const badge = document.createElement("div");
        badge.className = "ere-drag-count";
        badge.style.background = TYPE_ACCENT[type] || DEFAULT_ACCENT;
        badge.textContent = String(counts.get(type));
        badge.title = `${counts.get(type)} ${type}`;
        wrap.appendChild(badge);
    }
    return wrap;
}

function buildGhost(elements, primary, scale, tags = []) {
    const ghost = document.createElement("div");
    // `ere-surface` so the cloned pills keep their styling once re-parented to
    // <body>. Deliberately NOT `erenodes-dom`: that class is what rootOf()
    // matches, and the ghost must never register as a drop target.
    ghost.className = "ere-surface ere-drag-ghost";

    for (const [i, src] of elements.slice(1, 3).entries()) {
        const clone = src.cloneNode(true);
        clone.classList.remove("ere-selected", "ere-drag-source");
        clone.style.position = "absolute";
        clone.style.left = `${(i + 1) * 4}px`;
        clone.style.top = `${(i + 1) * 4}px`;
        clone.style.width = `${src.offsetWidth}px`;
        clone.style.height = `${src.offsetHeight}px`;
        clone.style.opacity = String(0.7 - i * 0.2);
        ghost.appendChild(clone);
    }

    const main = primary.cloneNode(true);
    main.classList.remove("ere-selected", "ere-drag-source");
    main.style.position = "relative";
    main.style.width = `${primary.offsetWidth}px`;
    main.style.height = `${primary.offsetHeight}px`;
    ghost.appendChild(main);

    const total = tags.length || elements.length;
    if (total > 1) {
        const badges = buildCountBadges(
            tags.length ? tags : Array.from({ length: elements.length }, () => ({}))
        );
        if (badges) ghost.appendChild(badges);
    }

    ghost.style.transform = `scale(${scale})`;
    return ghost;
}

// ------------------------------------------------------------- drag lifecycle

function endPointerSession() {
    if (state.pending?.timer) clearTimeout(state.pending.timer);
    state.pending = null;
    if (state.marquee) {
        state.marquee.el?.remove();
        document.body.classList.remove("ere-marquee-active");
        state.marquee = null;
    }
    window.removeEventListener("pointermove", onWindowPointerMove, true);
    window.removeEventListener("pointerup", onWindowPointerUp, true);
    window.removeEventListener("pointercancel", onWindowPointerCancel, true);
}

function startPointerSession() {
    endPointerSession();
    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("pointercancel", onWindowPointerCancel, true);
}

// ------------------------------------------------------------------- marquee
//
// Ctrl/Cmd + drag inside a node rubber-band selects pills. ComfyUI binds its
// own Ctrl+drag box-select on the canvas, so this only works because the
// window-capture guard swallows the gesture before it gets there.

/**
 * Belt-and-braces: if ComfyUI managed to arm a canvas gesture from the same
 * press (its Ctrl+drag box-select may be bound in the capture phase *above*
 * us, where stopPropagation can no longer help), disarm it. Every field is
 * probed defensively — this must never throw on a frontend that renamed them.
 */
function abortCanvasGesture() {
    const canvas = app.canvas;
    if (!canvas) return;
    try { canvas.pointer?.reset?.(); } catch {}
    if (canvas.dragging_rectangle) canvas.dragging_rectangle = null;
    if (canvas.dragging_canvas) canvas.dragging_canvas = false;
}

function beginMarqueePress(node, root, e) {
    startPointerSession();
    const additive = e.ctrlKey || e.metaKey;
    state.marquee = {
        node, root,
        startX: e.clientX, startY: e.clientY,
        // Ctrl adds to / XORs against the existing selection; a plain band on
        // empty space replaces it outright, like Explorer.
        base: additive ? getSelectedIndices(node) : [],
        additive,
        // A plain press on empty space that never becomes a band still clears
        // the selection on release.
        onPill: !!e.target?.closest?.(PILL_SELECTOR),
        el: null,
        active: false,
    };
}

function activateMarquee(m) {
    m.active = true;
    abortCanvasGesture();
    m.el = document.createElement("div");
    m.el.className = "ere-marquee";
    document.body.appendChild(m.el);
    document.body.classList.add("ere-marquee-active");
}

function updateMarquee(m, x, y) {
    abortCanvasGesture();
    const left = Math.min(m.startX, x);
    const top = Math.min(m.startY, y);
    const width = Math.abs(x - m.startX);
    const height = Math.abs(y - m.startY);
    Object.assign(m.el.style, {
        left: `${left}px`, top: `${top}px`,
        width: `${width}px`, height: `${height}px`,
    });

    // XOR against the selection the band started from, like Explorer: sweeping
    // over an already-selected pill removes it again.
    const next = new Set(m.base);
    for (const el of m.root.querySelectorAll("[data-ere-index]")) {
        const r = el.getBoundingClientRect();
        if (r.left < left + width && r.right > left && r.top < top + height && r.bottom > top) {
            const i = Number(el.dataset.ereIndex);
            if (next.has(i)) next.delete(i);
            else next.add(i);
        }
    }
    selectIndices(m.node, [...next]);
}

/** Called from the window-capture pointerdown guard. */
function onPillPointerDown(node, el, index, mode, e) {
    if (e.button !== 0 || state.drag) return;
    startPointerSession();

    state.pending = {
        node, el, index, mode,
        startX: e.clientX, startY: e.clientY,
        x: e.clientX, y: e.clientY,
        timer: setTimeout(() => { if (state.pending) beginDrag(); }, HOLD_MS),
    };
}

// All pointer handling runs in the capture phase on `window`, i.e. the very
// first stop on the event's journey. Bubble-phase stopping (what the widget
// root does for canvas panning) is too late for ComfyUI features bound in the
// capture phase further down — notably Ctrl+drag box-select, which otherwise
// swallowed multi-pill drags.
function onWindowPointerMove(e) {
    if (!state.drag && !state.pending && !state.marquee) return;
    // Once a press has started inside a node, nothing else sees the gesture.
    e.stopPropagation();

    const m = state.marquee;
    if (m) {
        e.preventDefault();
        if (!m.active && Math.hypot(e.clientX - m.startX, e.clientY - m.startY) > MOVE_THRESHOLD) {
            activateMarquee(m);
        }
        if (m.active) updateMarquee(m, e.clientX, e.clientY);
        return;
    }

    if (state.drag) {
        state.drag.lastX = e.clientX;
        state.drag.lastY = e.clientY;
        state.drag.alt = e.altKey;
        updateDrag(e.clientX, e.clientY);
        e.preventDefault();
        return;
    }
    const p = state.pending;
    if (!p) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > MOVE_THRESHOLD) beginDrag();
}

function onWindowPointerUp(e) {
    // A marquee that never moved stays a plain ctrl+click, which the pill's
    // click handler turns into a selection toggle — so only swallow the click
    // when the rubber band actually opened.
    const m = state.marquee;
    if (m?.active) {
        e.stopPropagation();
        clickSuppressed = true;
        setTimeout(() => { clickSuppressed = false; }, 50);
    } else if (m && !m.onPill && !m.additive) {
        // Plain press on empty tag area that never became a band: deselect.
        clearSelectionState(m.node);
    }
    if (state.drag) {
        e.stopPropagation();
        state.drag.alt = e.altKey;
        finishDrag();
    }
    endPointerSession();
}

function onWindowPointerCancel() {
    if (state.drag) cancelDrag();
    endPointerSession();
}

function onDragKey(e) {
    if (!state.drag) return;
    if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelDrag();
        endPointerSession();
        return;
    }
    // Alt toggles copy mode mid-drag, and the key alone produces no
    // pointermove — refresh from the key event instead. preventDefault keeps
    // Alt from moving focus to the browser menu bar.
    if (e.key === "Alt") e.preventDefault();
    setAlt(e.altKey || e.key === "Alt");
}

function onDragKeyUp(e) {
    if (!state.drag) return;
    setAlt(e.key === "Alt" ? false : e.altKey);
}

function setAlt(alt) {
    // Key repeat fires continuously while Alt is held — only react to changes.
    if (!state.drag || state.drag.alt === alt) return;
    state.drag.alt = alt;
    updateDrag(state.drag.lastX, state.drag.lastY);
}

// Right-clicking mid-drag would otherwise open the pill quick-edit menu on top
// of a drag that never ends.
function onDragContextMenu(e) {
    if (!state.drag) return;
    e.preventDefault();
    e.stopPropagation();
    cancelDrag();
    endPointerSession();
}

function beginDrag() {
    const p = state.pending;
    if (!p) return;
    clearTimeout(p.timer);

    const { node, el, index, mode } = p;
    if (!el.isConnected) { endPointerSession(); return; }

    const tags = getTags(node);
    // Dragging a pill that is part of the selection carries the whole
    // selection; dragging anything else drops the selection first.
    let indices = isPillSelected(node, index) ? getSelectedIndices(node) : null;
    if (!indices) {
        clearSelectionState(node);
        clearAllSelections();
        indices = [index];
    }
    indices = indices.filter(i => tags[i]);
    if (!indices.length) { endPointerSession(); return; }

    // Primary first so the ghost stacks the grabbed pill on top.
    const elements = [el, ...indices.map(i => pillElement(node, i)).filter(x => x && x !== el)];

    const rect = el.getBoundingClientRect();
    const scale = el.offsetWidth ? rect.width / el.offsetWidth : 1;

    // Initial size = the source pill; updateDrag re-sizes it for whichever
    // node it is hovering (pill vs full-width row vs gallery tile).
    const placeholder = document.createElement("div");
    placeholder.className = "ere-drop-placeholder";
    placeholder.style.width = `${el.offsetWidth}px`;
    placeholder.style.height = `${el.offsetHeight}px`;

    // Colour every drag affordance after what is being dragged: blue for plain
    // tags, green loras, red embeddings, amber groups, violet for a mixed set.
    setDragAccent(indices.map(i => tags[i]));

    const ghost = buildGhost(elements, el, scale, indices.map(i => tags[i]).filter(Boolean));
    document.body.appendChild(ghost);
    for (const pill of elements) pill.classList.add("ere-drag-source");

    state.drag = {
        sourceNode: node,
        sourceMode: mode,
        indices,
        elements,
        ghost,
        placeholder,
        label: pillLabel(el),
        sizedFor: null,
        grabX: p.x - rect.left,
        grabY: p.y - rect.top,
        scale,
        target: null,
        targetMode: null,
        dropIndex: null,
        lastX: p.x,
        lastY: p.y,
        lastKey: null,
        alt: false,
        copying: false,
        origin: null,
        sidebarZone: null,
        sidebarDrop: null,
        raf: 0,
    };
    state.pending = null;

    document.body.classList.add("ere-dragging-active");
    abortCanvasGesture();
    window.addEventListener("keydown", onDragKey, true);
    window.addEventListener("keyup", onDragKeyUp, true);
    window.addEventListener("contextmenu", onDragContextMenu, true);
    updateDrag(p.x, p.y);
    state.drag.raf = requestAnimationFrame(stepAutoScroll);
}

function updateDrag(x, y) {
    const d = state.drag;
    if (!d) return;

    d.ghost.style.left = `${x - d.grabX}px`;
    d.ghost.style.top = `${y - d.grabY}px`;

    const under = document.elementFromPoint(x, y);

    // The sidebar is a second kind of drop target. What a drop means there
    // depends on where the drag started (see onSidebarDrop): pills from a node
    // are saved as a new tag group, entries already in the sidebar are moved.
    // Checked before the node lookup because the sidebar is not a node and
    // would otherwise read as "no valid target".
    const zone = under?.closest?.("[data-ere-sidebar-drop]");
    if (zone) {
        if (d.placeholder.parentNode) d.placeholder.remove();
        d.ghost.classList.remove("ere-no-drop");
        highlightTarget(null);
        setSidebarTarget(d, zone);
        d.target = null;
        d.dropIndex = null;
        d.lastKey = null;
        // Saving pills as a tag group does not remove them from their node, so
        // show the originals dimmed-and-dashed exactly like an Alt copy — the
        // gesture is not a move and should not look like one.
        setCopyMode(d, !!d.sourceNode);
        return;
    }
    setSidebarTarget(d, null);

    const root = rootOf(under);
    const targetNode = root?._ereNode ?? null;
    const container = root?.querySelector(".ere-drop-zone");
    const mode = root?._ereMode;

    if (!targetNode || !container || !DND_MODES.has(mode)) {
        if (d.placeholder.parentNode) d.placeholder.remove();
        // Bare canvas is a valid destination for an external payload — it makes
        // a new node — so don't show the "no drop" cue there.
        const canvasDrop = !d.sourceNode && d.externalTags?.length
            && !!d.origin?.onCanvasDrop && overCanvas(x, y);
        d.ghost.classList.toggle("ere-no-drop", !canvasDrop);
        highlightTarget(null);
        d.target = null;
        d.dropIndex = null;
        d.lastKey = null;
        setCopyMode(d, false);
        return;
    }

    d.ghost.classList.remove("ere-no-drop");
    highlightTarget(targetNode === d.sourceNode ? null : root);
    if (d.sizedFor !== container) {
        d.sizedFor = container;
        sizePlaceholder(d, targetNode, container, mode);
    }
    // Alt only means "copy" across nodes: a copy in place would collide with
    // the tag it was copied from, so an in-node drop is always a move.
    setCopyMode(d, d.alt && targetNode !== d.sourceNode);

    const { pos, items } = computeDropPosition(container, x, y);
    const key = `${targetNode.id}:${pos}`;
    if (key !== d.lastKey || !d.placeholder.parentNode) {
        d.lastKey = key;
        container.insertBefore(d.placeholder, items[pos] ?? null);
    }

    d.target = targetNode;
    d.targetMode = mode;
    d.dropIndex = toDataIndex(pos, items);
}

/**
 * Track (and highlight) a sidebar folder row as the drop target.
 *
 * The sidebar registers a handler on the element via `_ereSidebarDrop`; we only
 * record it plus the folder path, so dragdrop.js stays ignorant of what saving
 * a tag group actually involves.
 */
function setSidebarTarget(d, zone) {
    if (d.sidebarZone === zone) return;
    d.sidebarZone?.classList.remove("ere-sb-drop-target");
    d.sidebarZone = zone || null;
    if (!zone) {
        d.sidebarDrop = null;
        return;
    }
    zone.classList.add("ere-sb-drop-target");
    d.sidebarDrop = {
        path: zone.dataset.erePath || "",
        onDrop: zone._ereSidebarDrop || null,
    };
}

/**
 * Start a drag whose payload comes from outside the graph (the sidebar).
 *
 * Reuses the whole existing machine — ghost, placeholder sizing, auto-scroll,
 * duplicate rejection, undo wrapping — by leaving `sourceNode` null and putting
 * the tags in `externalTags`. Callers own their own press/threshold handling and
 * call this once the gesture is confirmed to be a drag.
 *
 * @param {object} opts
 * @param {Array<object>} opts.tags   tags to insert on drop
 * @param {string} opts.label         ghost caption
 * @param {number} opts.x @param {number} opts.y   current pointer position
 */
export function startExternalDrag({ tags, label, x, y, origin = null }) {
    if (state.drag) cancelDrag();
    if (!Array.isArray(tags) || !tags.length) return false;

    installDragGlobals();
    // The renderer normally injects these, but a sidebar drag can happen before
    // any node has mounted a widget. Both are idempotent.
    injectTagStyles();
    injectDragStyles();
    setDragAccent(tags);

    // A stand-in "pill" so the ghost looks like what will be inserted.
    const proxy = document.createElement("div");
    proxy.className = "ere-surface";
    proxy.style.cssText = "position:fixed;left:-9999px;top:-9999px;";
    const face = document.createElement("div");
    face.className = "ere-pill";
    face.textContent = label || `${tags.length} tags`;
    proxy.appendChild(face);
    document.body.appendChild(proxy);

    const ghost = buildGhost([face], face, 1, tags);
    document.body.appendChild(ghost);
    proxy.remove();

    const placeholder = document.createElement("div");
    placeholder.className = "ere-drop-placeholder";
    placeholder.style.width = "60px";
    placeholder.style.height = `${PILL_ROW_H}px`;

    state.drag = {
        sourceNode: null,
        sourceMode: null,
        externalTags: tags.map(t => ({ ...t })),
        // Where the drag came from. A sidebar-origin drop inside the sidebar is
        // a move, not a "save these tags" — see onSidebarDrop.
        origin,
        indices: [],
        elements: [],
        ghost,
        placeholder,
        label: label || "",
        sizedFor: null,
        grabX: 10,
        grabY: 10,
        scale: 1,
        target: null,
        targetMode: null,
        dropIndex: null,
        lastX: x,
        lastY: y,
        lastKey: null,
        alt: false,
        copying: false,
        sidebarZone: null,
        sidebarDrop: null,
        raf: 0,
    };

    document.body.classList.add("ere-dragging-active");
    abortCanvasGesture();
    window.addEventListener("keydown", onDragKey, true);
    window.addEventListener("keyup", onDragKeyUp, true);
    window.addEventListener("contextmenu", onDragContextMenu, true);
    // The sidebar owns the pointer, so it must drive move/up itself.
    window.addEventListener("pointermove", onWindowPointerMove, true);
    window.addEventListener("pointerup", onWindowPointerUp, true);
    window.addEventListener("pointercancel", onWindowPointerCancel, true);
    updateDrag(x, y);
    state.drag.raf = requestAnimationFrame(stepAutoScroll);
    return true;
}

/** True when the point is over the graph canvas itself. */
function overCanvas(x, y) {
    const canvas = app.canvas?.canvas;
    if (!canvas) return false;
    const r = canvas.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Visible text of a pill, whatever shape it has. */
function pillLabel(el) {
    const label = el.querySelector(".ere-label, .ere-name");
    return ((label ?? el).textContent || "").trim();
}

/**
 * Size the placeholder the way the *target* node would draw the tag, not the
 * way the source node draws it: a pill dropped into a Toggle node becomes a
 * full-width row, and a Toggle row dropped into a Cloud node becomes a pill
 * only as wide as its text. Measured with a hidden probe inside the target
 * container so it picks up that node's real CSS instead of guessing.
 */
function sizePlaceholder(d, targetNode, container, mode) {
    const ph = d.placeholder;

    if (container.dataset.ereLayout === "column") {
        ph.style.width = "";                 // flex column stretches it full width
        ph.style.height = `${PILL_ROW_H}px`;
        return;
    }

    if (mode === "gallery") {
        ph.style.width = `${targetNode.properties?._tagImageWidth ?? 100}px`;
        ph.style.height = `${targetNode.properties?._tagImageHeight ?? 100}px`;
        return;
    }

    const probe = document.createElement("div");
    probe.className = "ere-pill";
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.textContent = d.label;
    container.appendChild(probe);
    ph.style.width = `${probe.offsetWidth || PILL_ROW_H}px`;
    ph.style.height = `${probe.offsetHeight || PILL_ROW_H}px`;
    probe.remove();
}

/**
 * Copy mode brings the source pills back into view (dimmed, dashed) so the
 * original node shows the tag staying put, and marks the ghost with a "+".
 * `.ere-drag-copy` only changes appearance — the pills keep `.ere-drag-source`
 * and so remain excluded from the drop-position maths.
 */
function setCopyMode(d, copying) {
    if (d.copying === copying) return;
    d.copying = copying;
    for (const el of d.elements) el.classList.toggle("ere-drag-copy", copying);
    d.ghost.classList.toggle("ere-copy", copying);
}

function highlightTarget(root) {
    for (const el of document.querySelectorAll(".ere-drop-target")) {
        if (el !== root) el.classList.remove("ere-drop-target");
    }
    root?.classList.add("ere-drop-target");
}

function stepAutoScroll() {
    const d = state.drag;
    if (!d) return;
    const root = rootOf(document.elementFromPoint(d.lastX, d.lastY));
    const scroller = root?.querySelector(".ere-scroll");
    if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
        const r = scroller.getBoundingClientRect();
        const before = scroller.scrollTop;
        if (d.lastY < r.top + SCROLL_EDGE) scroller.scrollTop -= SCROLL_SPEED;
        else if (d.lastY > r.bottom - SCROLL_EDGE) scroller.scrollTop += SCROLL_SPEED;
        if (scroller.scrollTop !== before) updateDrag(d.lastX, d.lastY);
    }
    d.raf = requestAnimationFrame(stepAutoScroll);
}

/**
 * Publish the drag accent as CSS variables on <html>.
 *
 * The three affordances that need it — drop placeholder, ghost outline and the
 * hovered node's ring — live in unrelated parts of the DOM (inside the target
 * node, on <body>, on the node root), so a document-level variable is simpler
 * than threading a colour through each. Only one drag runs at a time.
 */
function setDragAccent(tags) {
    const accent = accentForTags(tags);
    const style = document.documentElement.style;
    style.setProperty("--ere-drag-accent", accent);
    style.setProperty("--ere-drag-accent-rgb", hexToRgbTriplet(accent));
}

function clearDragAccent() {
    const style = document.documentElement.style;
    style.removeProperty("--ere-drag-accent");
    style.removeProperty("--ere-drag-accent-rgb");
}

function teardownDrag() {
    const d = state.drag;
    if (!d) return null;
    if (d.raf) cancelAnimationFrame(d.raf);
    d.ghost.remove();
    d.placeholder.remove();
    d.sidebarZone?.classList.remove("ere-sb-drop-target");
    clearDragAccent();
    document.body.classList.remove("ere-dragging-active");
    for (const el of document.querySelectorAll(".ere-drag-source")) el.classList.remove("ere-drag-source");
    highlightTarget(null);
    for (const el of document.querySelectorAll(".ere-drag-copy")) el.classList.remove("ere-drag-copy");
    window.removeEventListener("keydown", onDragKey, true);
    window.removeEventListener("keyup", onDragKeyUp, true);
    window.removeEventListener("contextmenu", onDragContextMenu, true);
    state.drag = null;
    // Swallow the click that follows this pointerup.
    clickSuppressed = true;
    setTimeout(() => { clickSuppressed = false; }, 50);
    return d;
}

function cancelDrag() {
    teardownDrag();
}

/** True once, right after a drag — the renderer uses it to skip the toggle. */
export function consumeDragClick() {
    if (!clickSuppressed) return false;
    clickSuppressed = false;
    return true;
}

export function isDragActive() {
    return !!state.drag;
}

async function finishDrag() {
    const d = teardownDrag();
    if (!d) return;

    // Dropped on the sidebar rather than a node — hand the payload over and
    // let it decide (it prompts for a filename and saves a tag group).
    if (d.sidebarDrop) {
        const tags = d.sourceNode
            ? d.indices.map(i => getTags(d.sourceNode)[i]).filter(Boolean)
            : d.externalTags;
        await d.sidebarDrop.onDrop?.(tags, d.sidebarDrop.path, d.sourceNode, d.origin);
        return;
    }

    // Dropped on bare canvas rather than on a node: an external payload becomes
    // a brand-new node there. (Pill drags between nodes stay a no-op — there is
    // nothing sensible to do with a tag dropped into empty space.)
    if (!d.target && !d.sourceNode && d.externalTags?.length && overCanvas(d.lastX, d.lastY)) {
        await d.origin?.onCanvasDrop?.(d.externalTags, d.lastX, d.lastY);
        return;
    }

    if (!d.target || d.dropIndex == null) return;

    // sourceNode === null means the drag came from outside the graph (the
    // sidebar): there is nothing to remove from, so it is always an insert.
    if (!d.sourceNode) await dropExternal(d);
    else if (d.target === d.sourceNode) await dropWithinNode(d);
    else await dropAcrossNodes(d);
}

/**
 * Insert tags carried in from outside the graph.
 *
 * Deliberately shares dropAcrossNodes' duplicate handling and undo wrapping,
 * but has no source side: no removal, and Alt is a no-op (there is nothing to
 * leave behind).
 */
async function dropExternal(d) {
    const targetTags = getTags(d.target);
    const existing = new Set(targetTags.map(t => t.name));

    const accepted = [];
    const rejected = [];
    for (const tag of d.externalTags || []) {
        if (!tag?.name || existing.has(tag.name)) {
            if (tag?.name) rejected.push(tag.name);
            continue;
        }
        existing.add(tag.name);
        accepted.push(JSON.parse(JSON.stringify(tag)));
    }

    if (accepted.length) {
        beginUndoTransaction();
        try {
            const insertAt = Math.max(0, Math.min(d.dropIndex, targetTags.length));
            targetTags.splice(insertAt, 0, ...accepted);
            await setTags(d.target, targetTags);
            if (accepted.length > 1) {
                selectIndices(d.target, accepted.map((_, i) => insertAt + i), targetTags);
            }
        } finally {
            endUndoTransaction();
        }
    }

    if (rejected.length) {
        toast(
            "warn",
            accepted.length ? "Some tags skipped" : "Tags already present",
            `${rejected.length} tag(s) already in the node: ${rejected.slice(0, 3).join(", ")}${rejected.length > 3 ? "…" : ""}`
        );
    }
}

async function dropWithinNode(d) {
    const tags = getTags(d.sourceNode);
    const moving = d.indices.filter(i => tags[i]);
    if (!moving.length) return;

    const { tags: reordered, insertAt } = moveWithin(tags, moving, d.dropIndex);
    if (JSON.stringify(reordered) === JSON.stringify(tags)) return;

    await setTags(d.sourceNode, reordered);
    if (moving.length > 1) {
        selectIndices(d.sourceNode, moving.map((_, i) => insertAt + i), reordered);
    }
}

async function dropAcrossNodes(d) {
    const sourceTags = getTags(d.sourceNode);
    const targetTags = getTags(d.target);
    const existing = new Set(targetTags.map(t => t.name));

    const accepted = [];
    const rejected = [];
    const takenFrom = [];
    for (const i of d.indices) {
        const tag = sourceTags[i];
        if (!tag) continue;
        if (existing.has(tag.name)) { rejected.push(tag.name); continue; }
        existing.add(tag.name);
        // Active state travels with the tag. In multiselect / randomizer an
        // inactive tag is simply not rendered — it lives in the "inactive"
        // dropdown, which is where the user expects to find it.
        accepted.push(JSON.parse(JSON.stringify(tag)));
        takenFrom.push(i);
    }

    if (accepted.length) {
        // One undo step for the whole transfer instead of one per node.
        beginUndoTransaction();
        try {
            const insertAt = Math.max(0, Math.min(d.dropIndex, targetTags.length));
            targetTags.splice(insertAt, 0, ...accepted);
            await setTags(d.target, targetTags);

            if (!d.alt) {
                const removed = new Set(takenFrom);
                await setTags(d.sourceNode, sourceTags.filter((_, i) => !removed.has(i)));
            }
            clearSelectionState(d.sourceNode);
            if (accepted.length > 1) {
                selectIndices(d.target, accepted.map((_, i) => insertAt + i), targetTags);
            }
        } finally {
            // Flushes the checkpoint the suppressed setTags calls asked for.
            endUndoTransaction();
        }
    }

    if (rejected.length) {
        toast(
            "warn",
            accepted.length ? "Some tags skipped" : "Tag already present",
            `${rejected.length} tag(s) already in the target node: ${rejected.slice(0, 3).join(", ")}${rejected.length > 3 ? "…" : ""}`
        );
    }
}

// ------------------------------------------------------ selection actions menu

async function applyToSelection(node, mutate) {
    const tags = getTags(node);
    for (const i of getSelectedIndices(node)) {
        if (tags[i]) mutate(tags[i]);
    }
    await setTags(node, tags);
}

async function removeSelection(node) {
    const tags = getTags(node);
    const drop = new Set(getSelectedIndices(node));
    if (!drop.size) return;
    clearSelectionState(node);
    await setTags(node, tags.filter((_, i) => !drop.has(i)));
}

/** The selected tags plus their indices, for save / export. */
function selectionSubset(node) {
    const tags = getTags(node);
    const indices = getSelectedIndices(node).filter(i => tags[i]);
    return { tags: indices.map(i => tags[i]), indices };
}

/**
 * Right-clicking a pill that belongs to a multi-selection opens bulk actions
 * instead of the single-tag quick edit.
 *
 * @returns {boolean} true when the selection menu was opened.
 */
export function handlePillContextMenu(node, index, e, anchorEvent) {
    const selected = getSelectedIndices(node);

    if (!selected.includes(index)) {
        // Right-clicking outside the selection drops it, then edits normally.
        clearSelectionState(node);
        return false;
    }
    if (selected.length < 2) return false;   // one tag: quick edit is more useful

    const subset = selectionSubset(node);
    const saveable = subset.tags.filter(t => t.type !== 'group').length;
    const anchor = anchorEvent ?? e;

    new TagSelectionContextMenu(anchor, `${selected.length} tags selected`, [
        { name: "Enable", callback: () => applyToSelection(node, t => { t.active = true; }) },
        { name: "Disable", callback: () => applyToSelection(node, t => { t.active = false; }) },
        { name: "Toggle", callback: () => applyToSelection(node, t => { t.active = !t.active; }) },
        null,
        { name: "Remove Selected", callback: () => removeSelection(node) },
        null,
        {
            name: "Save Selected as Tag Group",
            disabled: saveable < 2,
            callback: () => node.onSaveTagGroup?.(anchor, subset),
        },
        { name: "Export Selected (.json)", callback: () => node.onExportTags?.(subset.tags) },
    ]);
    return true;
}

// ------------------------------------------------------------- renderer hooks

/**
 * Make a rendered pill draggable and selectable. There is no per-pill
 * pointerdown listener: presses are picked up by the window-capture guard in
 * installDragGlobals(), which has to run before ComfyUI's own handlers anyway.
 */
export function attachPillDrag(node, el, index, mode) {
    if (!DND_MODES.has(mode)) return;
    el.dataset.ereIndex = String(index);
    if (isPillSelected(node, index)) el.classList.add("ere-selected");
}

/**
 * Mark the element that holds the pills as the node's drop area.
 * @param {"flow"|"column"} layout
 */
export function markDropZone(container, layout = "flow") {
    container.classList.add("ere-drop-zone");
    container.dataset.ereLayout = layout;
}

/**
 * Single entry point for presses on a pill.
 *
 * Bound on `window` in the capture phase so it runs before anything else in
 * the page. The widget root also stops pointer events, but only while they
 * bubble — too late for ComfyUI handlers that listen in the capture phase.
 * Ctrl+drag was the visible symptom: the canvas box-select armed itself from
 * the same gesture and fought the pill drag.
 */
function onGlobalPointerDown(e) {
    // Context menus live outside the widget, so they would look like "a press
    // somewhere else" and clear the selection — right out from under the bulk
    // action the user is clicking.
    if (e.target?.closest?.(".litecontextmenu")) return;

    const root = rootOf(e.target);
    const node = root?._ereNode;
    const mode = root?._ereMode;

    if (!root || !node || !DND_MODES.has(mode)) {
        // A press anywhere else drops the selection.
        if (!state.drag) clearAllSelections();
        return;
    }
    // Middle click still belongs to the canvas (pan), so let it through to the
    // widget root's forwarding handler.
    if (e.button !== 0) return;

    // Dismiss an open quick-edit / selection menu. Its own outside-click
    // handler sits on `document` and never fires for presses inside a node,
    // because we stop the event long before it gets there.
    try { window.LiteGraph?.currentMenu?.close?.(); } catch {}

    const inToolbar = !!e.target?.closest?.(".ere-toolbar");
    const pill = e.target?.closest?.(PILL_SELECTOR);
    const onPill = !!pill && pill.dataset.ereIndex !== undefined;

    // Rubber-band selection, Windows Explorer style:
    //   - empty space in the tag area  -> band, no modifier needed;
    //   - on top of a pill             -> band only with Ctrl/Cmd, because a
    //     plain press there means "click or drag this pill".
    // Either way a press that never moves stays a plain click.
    if (!inToolbar && (!onPill || e.ctrlKey || e.metaKey)) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        beginMarqueePress(node, root, e);
        return;
    }

    if (!onPill) {
        // Toolbar buttons and anything else that is not a pill.
        if (!state.drag) clearAllSelections();
        return;
    }

    e.stopPropagation();
    e.stopImmediatePropagation();
    onPillPointerDown(node, pill, Number(pill.dataset.ereIndex), mode, e);
}

let globalsInstalled = false;
export function installDragGlobals() {
    if (globalsInstalled) return;
    globalsInstalled = true;

    window.addEventListener("pointerdown", onGlobalPointerDown, true);
    // Gallery tiles hold an <img>; a modifier-drag can still trip the native
    // HTML5 drag in some browsers.
    window.addEventListener("dragstart", e => {
        if (state.drag || e.target?.closest?.(PILL_SELECTOR)) e.preventDefault();
    }, true);

    document.addEventListener("keydown", e => {
        if (e.key !== "Escape" || state.drag) return;
        const active = document.activeElement;
        if (active && (active.nodeName === "INPUT" || active.nodeName === "TEXTAREA")) return;
        // Escape mid-marquee reverts to the selection it started from.
        if (state.marquee?.active) {
            const m = state.marquee;
            selectIndices(m.node, m.base);
            endPointerSession();
            return;
        }
        clearAllSelections();
    }, true);
}

// --------------------------------------------------------------------- styles

export function injectDragStyles() {
    const css = `
/* --ere-drag-accent / --ere-drag-accent-rgb are set on <html> for the duration
   of a drag (see setDragAccent) and describe what is being dragged: blue for
   plain tags, green loras, red embeddings, amber groups, violet for a mixed
   selection. The fallbacks keep the pre-drag blue for the selection outline,
   which is drawn outside any drag. */
/* Inset outline: the tag area clips overflow, so an outer ring would be cut
   off on edge pills. */
.ere-surface .ere-selected {
    outline: 2px solid var(--ere-drag-accent, var(--p-primary-color, #4a9eff));
    outline-offset: -2px;
    box-shadow: inset 0 0 8px rgba(var(--ere-drag-accent-rgb, 74, 158, 255), .45);
}
/* Dragged pills leave the flow — unless Alt is held over another node, where
   they stay put (dimmed) to show the original is being kept. They keep
   .ere-drag-source either way, so they never count as drop candidates. */
.ere-surface .ere-drag-source:not(.ere-drag-copy) { display: none !important; }
.ere-surface .ere-drag-copy {
    opacity: .4;
    outline: 1px dashed var(--ere-drag-accent, var(--p-primary-color, #4a9eff));
    outline-offset: -2px;
}
.ere-surface .ere-drop-placeholder {
    flex: 0 0 auto; pointer-events: none;
    border: 1px dashed var(--ere-drag-accent, var(--p-primary-color, #4a9eff));
    border-radius: 6px;
    background: rgba(var(--ere-drag-accent-rgb, 74, 158, 255), .14);
    animation: ere-drop-pulse .9s ease-in-out infinite alternate;
}
@keyframes ere-drop-pulse {
    from { opacity: .45; }
    to   { opacity: 1; }
}
.ere-surface.ere-drop-target {
    outline: 1px dashed var(--ere-drag-accent, var(--p-primary-color, #4a9eff));
    outline-offset: 2px;
}
.ere-surface.ere-drag-ghost {
    position: fixed; left: 0; top: 0; z-index: 10000;
    display: block; width: auto; min-height: 0; overflow: visible;
    pointer-events: none; transform-origin: top left;
    opacity: .92; filter: drop-shadow(0 3px 6px rgba(0, 0, 0, .6));
}
.ere-surface.ere-drag-ghost > * {
    outline: 2px solid var(--ere-drag-accent, var(--p-primary-color, #4a9eff));
    outline-offset: 1px;
}
.ere-surface.ere-drag-ghost.ere-no-drop { opacity: .5; }
.ere-surface.ere-drag-ghost.ere-no-drop > * { outline-color: #b05050; }
.ere-surface.ere-drag-ghost .ere-drag-counts {
    position: absolute; top: -7px; right: -9px; z-index: 1;
    display: flex; flex-direction: row; gap: 2px;
}
.ere-surface.ere-drag-ghost .ere-drag-count {
    min-width: 16px; height: 16px; padding: 0 3px;
    border-radius: 8px; outline: none;
    background: var(--ere-drag-accent, var(--p-primary-color, #4a9eff)); color: #fff;
    font: 10px/16px monospace; text-align: center;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
}
/* Copy mode (Alt over another node) */
.ere-surface.ere-drag-ghost.ere-copy::after {
    content: "+";
    position: absolute; top: -7px; left: -9px; z-index: 1;
    width: 16px; height: 16px; border-radius: 8px;
    background: #4a9a5a; color: #fff;
    font: bold 11px/16px monospace; text-align: center;
}
body.ere-dragging-active, body.ere-dragging-active * { cursor: grabbing !important; }
/* Ctrl+drag rubber band */
.ere-marquee {
    position: fixed; z-index: 10000; pointer-events: none;
    border: 1px dashed var(--p-primary-color, #4a9eff);
    background: rgba(74, 158, 255, .12);
    border-radius: 2px;
}
body.ere-marquee-active, body.ere-marquee-active * { cursor: crosshair !important; }
`;
    let style = document.getElementById("erenodes-drag-style");
    if (!style) {
        style = document.createElement("style");
        style.id = "erenodes-drag-style";
        document.head.appendChild(style);
    }
    style.textContent = css;
}
