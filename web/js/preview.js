// Floating hover preview for tag groups, loras and embeddings.
//
// One panel implementation, two call sites: the "Load Tag Group" / file context
// menus (contextmenu.js) and the sidebar (sidebar.js). It shows the thumbnail if
// there is one, plus the actual tags the file contains — rendered with the very
// same pill code the nodes use (tagview.js), so a preview is pixel-identical to
// what you get after loading the group.

import { getCache, isNotFound } from "./cache.js";
import { injectTagStyles, renderTagCloud, SURFACE_CLASS, previewUrl } from "./tagview.js";

const PANEL_ID = "erenodes-hover-preview";
const MAX_PILLS = 60;
// Long enough that arrowing down a list doesn't fire a request per row, short
// enough to feel instant when the pointer settles.
const HOVER_DELAY = 120;
// Same press grammar as pills inside a node.
const HOLD_MS = 200;
const MOVE_THRESHOLD = 5;

let panel = null;
let hideTimer = 0;
let showTimer = 0;
let token = 0;

function injectPreviewStyles() {
    if (document.getElementById("erenodes-preview-style")) return;
    const style = document.createElement("style");
    style.id = "erenodes-preview-style";
    style.textContent = `
#${PANEL_ID} {
    position: fixed; z-index: 10050; pointer-events: none;
    max-width: 320px; max-height: 70vh; overflow: hidden;
    display: flex; flex-direction: column; gap: 6px;
    padding: 12px; border-radius: 8px;
    border: 1px solid var(--component-node-border, #444);
    background: var(--comfy-menu-bg, #202020);
    box-shadow: 0 6px 20px rgba(0, 0, 0, .55);
}
/* Interactive mode: the pointer can move into the panel and work with the
   pills. Only enabled when the caller opts in, so menu previews (which sit
   under a moving cursor) stay click-through. */
#${PANEL_ID}.ere-preview-interactive { pointer-events: auto; }
#${PANEL_ID}.ere-preview-interactive .ere-pill { cursor: grab; }
#${PANEL_ID}[hidden] { display: none; }
#${PANEL_ID} img.ere-preview-img {
    display: block; max-width: 100%; max-height: 220px;
    object-fit: contain; border-radius: 5px; align-self: center;
}
/* Must beat the rule above, which would otherwise re-show a broken image icon
   for every file that has no preview (a plain [hidden] attribute loses to any
   explicit display declaration). */
#${PANEL_ID} img.ere-preview-img[hidden] { display: none; }
/* Extra breathing room inside the cloud gives the rubber band somewhere to
   start; without it every pixel is a pill and a drag always grabs one. */
#${PANEL_ID} .ere-cloud {
    overflow-y: auto; max-height: 260px; scrollbar-width: thin;
    padding: 4px; align-content: flex-start; min-height: 28px;
}
#${PANEL_ID} .ere-preview-empty { font-size: 11px; opacity: .55; }
/* The shared rubber band sits at z-index 10000 — below this panel (10050), so
   inside the preview it was drawn behind the panel. Lift it above, and state
   its appearance explicitly: over a small area the 1px dashed border dominates
   and the default fill read as almost solid blue. */
.ere-marquee.ere-marquee-above {
    z-index: 10060;
    border: 1px solid rgba(var(--ere-drag-accent-rgb, 74, 158, 255), .5);
    background: rgba(var(--ere-drag-accent-rgb, 74, 158, 255), .08);
}
`;
    document.head.appendChild(style);
}

function ensurePanel() {
    if (panel?.isConnected) return panel;
    injectTagStyles();
    injectPreviewStyles();
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    // The panel renders tags, so it is a tag surface like any node.
    panel.className = SURFACE_CLASS;
    panel.hidden = true;
    // Moving the pointer from the row into the panel must not close it — that
    // is what makes the pills reachable.
    panel.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    panel.addEventListener("pointerleave", () => hidePreviewPanel());
    document.body.appendChild(panel);
    return panel;
}

/**
 * Place the panel beside an anchor rect, flipping and clamping so it always
 * stays on screen — same rules the old in-menu image preview used.
 */
function position(el, anchorRect) {
    el.style.left = "0px";
    el.style.top = "0px";
    const rect = el.getBoundingClientRect();
    const gap = 6;

    let left = anchorRect.right + gap;
    if (left + rect.width > window.innerWidth) {
        left = anchorRect.left - rect.width - gap;      // flip to the other side
    }
    left = Math.max(gap, Math.min(left, window.innerWidth - rect.width - gap));

    let top = anchorRect.top;
    if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - gap;
    top = Math.max(gap, top);

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
}

async function fetchJson(url) {
    try {
        const value = getCache(url, "json");
        const resolved = value instanceof Promise ? await value : value;
        return isNotFound(resolved) ? null : resolved;
    } catch {
        return null;
    }
}

/** Tags a preview should show for a given file type. */
async function loadTags(type, path, extension) {
    if (type === "group") {
        const data = await fetchJson(
            `/erenodes/get_tag_group?filename=${encodeURIComponent(path + (extension || ".json"))}`
        );
        return Array.isArray(data) ? data : null;
    }
    if (type === "lora") {
        const words = await fetchJson(
            `/erenodes/get_lora_metadata?filename=${encodeURIComponent(path + (extension || ""))}`
        );
        if (!Array.isArray(words)) return null;
        // Trained words are bare strings; wrap them so they render as tag pills.
        return [...new Set(words.map(w => String(w).trim()).filter(Boolean))]
            .map(name => ({ name, type: "tag" }));
    }
    return null;
}

/**
 * Show the preview for a file.
 *
 * @param {object} opts
 * @param {"group"|"lora"|"embedding"} opts.type
 * @param {string} opts.path      path without extension (as the server reports it)
 * @param {string} [opts.extension]
 * @param {DOMRect} opts.anchor   rect to position against
 * @param {boolean} [opts.image=true] include the thumbnail (off where the
 *        caller already shows one, e.g. the sidebar's grid view)
 * @param {boolean} [opts.interactive=false] let the pointer enter the panel and
 *        pick/drag individual tags out of it (sidebar only — menu previews sit
 *        under a moving cursor and must stay click-through)
 */
export function showPreviewFor({ type, path, extension, anchor, image = true, interactive = false }) {
    if (!type || !path || !anchor) return hidePreviewPanel();

    clearTimeout(hideTimer);
    clearTimeout(showTimer);
    const mine = ++token;

    showTimer = setTimeout(async () => {
        // No title line: the pointer is already on the row that names it.
        const el = ensurePanel();
        el.textContent = "";
        el.classList.toggle("ere-preview-interactive", !!interactive);

        // The panel stays hidden until something has actually rendered into it.
        // An `img` that is still loading (or will 404) is not content, so a file
        // with no thumbnail and no tags never flashes an empty rounded box —
        // whichever of the two arrives first is what reveals the panel.
        const img = document.createElement("img");
        img.className = "ere-preview-img";
        img.hidden = true;

        let hasTags = false;
        const revealIfReady = () => {
            if (token !== mine) return;
            if (!hasTags && img.hidden) return;
            el.hidden = false;
            position(el, anchor);
        };
        img.addEventListener("load", () => {
            if (token !== mine) return;
            img.hidden = false;
            revealIfReady();
        });
        img.addEventListener("error", () => { img.hidden = true; });
        if (image) {
            img.src = previewUrl(type, path);
            el.appendChild(img);
        }

        const tags = await loadTags(type, path, extension);
        // A slower fetch for a row the pointer already left must not win.
        if (token !== mine) return;

        if (tags && tags.length) {
            const cloud = renderTagCloud(tags, { max: MAX_PILLS });
            el.appendChild(cloud);
            if (interactive) attachPillPicking(cloud, tags, el);
            hasTags = true;
        } else if (type === "group") {
            // A group that exists but holds nothing is worth saying out loud;
            // a lora with no trained words simply has nothing to add.
            const empty = document.createElement("div");
            empty.className = "ere-preview-empty";
            empty.textContent = "Empty tag group";
            el.appendChild(empty);
            hasTags = true;
        }
        revealIfReady();
    }, HOVER_DELAY);
}

/**
 * Make the pills in an interactive preview selectable and draggable.
 *
 * Click toggles one, Ctrl/Cmd adds, Shift extends a range — the same grammar as
 * pills inside a node. Dragging carries the picked set (or just the pill under
 * the cursor) into the graph through the shared drag machinery, so it lands in
 * a node or creates one on bare canvas exactly like a sidebar row does.
 */
function attachPillPicking(cloud, tags, panelEl) {
    const pills = [...cloud.querySelectorAll(".ere-pill:not(.ere-more)")];
    const picked = new Set();
    let anchorIndex = null;

    const sync = () => {
        pills.forEach((pill, i) => pill.classList.toggle("ere-selected", picked.has(i)));
        if (onPickChange) onPickChange(picked.size);
    };

    // Dragging on the panel background rubber-bands over the pills, the same
    // gesture as empty space inside a node or in the sidebar.
    attachPanelMarquee(panelEl, pills, picked, sync);

    pills.forEach((pill, index) => {
        pill.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            const start = { x: e.clientX, y: e.clientY };
            let dragging = false;

            const begin = () => {
                if (dragging) return;
                dragging = true;
                // Drag the picked set if this pill belongs to it, else just this one.
                const indices = picked.has(index) ? [...picked].sort((a, b) => a - b) : [index];
                const payload = indices.map(i => tags[i]).filter(Boolean);
                const label = payload.length > 1 ? `${payload.length} tags` : (payload[0]?.name ?? "");
                hidePreviewPanel(true);
                startDrag?.({
                    tags: payload, label, x: start.x, y: start.y,
                    origin: { kind: "preview", onCanvasDrop: onCanvasDropFromPreview },
                });
            };

            const timer = setTimeout(begin, HOLD_MS);
            const onMove = (ev) => {
                if (dragging) return;
                if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_THRESHOLD) {
                    clearTimeout(timer);
                    begin();
                }
            };
            const onUp = (ev) => {
                clearTimeout(timer);
                window.removeEventListener("pointermove", onMove, true);
                window.removeEventListener("pointerup", onUp, true);
                if (dragging) return;

                // A plain click does nothing: this is a preview, not an
                // editor, and toggling a tag here would imply it changes the
                // stored group. Only the explicit multi-select modifiers pick.
                if (ev.ctrlKey || ev.metaKey) {
                    if (picked.has(index)) picked.delete(index);
                    else picked.add(index);
                    anchorIndex = index;
                    sync();
                } else if (ev.shiftKey && anchorIndex != null) {
                    const [lo, hi] = anchorIndex <= index ? [anchorIndex, index] : [index, anchorIndex];
                    picked.clear();
                    for (let i = lo; i <= hi; i++) picked.add(i);
                    sync();
                }
            };
            window.addEventListener("pointermove", onMove, true);
            window.addEventListener("pointerup", onUp, true);
        });
    });
}

/**
 * Rubber-band selection over preview pills.
 *
 * Bound on the panel, not the cloud, so the padding around the pills is
 * draggable too. A press that lands on a pill is ignored here — that gesture
 * belongs to the pill itself (click = nothing, drag = carry it out).
 */
function attachPanelMarquee(panelEl, pills, picked, sync) {
    panelEl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest?.(".ere-pill")) return;
        e.stopPropagation();

        const additive = e.ctrlKey || e.metaKey;
        const base = new Set(additive ? picked : []);
        const start = { x: e.clientX, y: e.clientY };
        let band = null;

        const update = (x, y) => {
            const left = Math.min(start.x, x), top = Math.min(start.y, y);
            const width = Math.abs(x - start.x), height = Math.abs(y - start.y);
            Object.assign(band.style, {
                left: `${left}px`, top: `${top}px`,
                width: `${width}px`, height: `${height}px`,
            });
            picked.clear();
            for (const i of base) picked.add(i);
            pills.forEach((pill, i) => {
                const r = pill.getBoundingClientRect();
                if (r.left < left + width && r.right > left && r.top < top + height && r.bottom > top) {
                    // XOR, so sweeping back over a picked pill removes it.
                    if (picked.has(i)) picked.delete(i);
                    else picked.add(i);
                }
            });
            sync();
        };

        const onMove = (ev) => {
            if (!band && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > MOVE_THRESHOLD) {
                band = document.createElement("div");
                band.className = "ere-marquee ere-marquee-above";
                document.body.appendChild(band);
            }
            if (band) { ev.preventDefault(); update(ev.clientX, ev.clientY); }
        };
        const finish = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", finish, true);
            window.removeEventListener("pointercancel", finish, true);
            band?.remove();
            // A press on the background that never became a band clears.
            if (!band && !additive && picked.size) { picked.clear(); sync(); }
        };
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", finish, true);
        window.addEventListener("pointercancel", finish, true);
    });
}

// Injected by the sidebar rather than imported: a static
// `import ... from "./dragdrop.js"` here would close the cycle
// preview -> dragdrop -> contextmenu -> preview. Class exports are not hoisted,
// so such a cycle risks a temporal-dead-zone error at module init.
let startDrag = null;
let onCanvasDropFromPreview = null;
let onPickChange = null;

export function setPreviewHandlers({ startExternalDrag = null, onCanvasDrop = null, onPick = null } = {}) {
    startDrag = startExternalDrag;
    onCanvasDropFromPreview = onCanvasDrop;
    onPickChange = onPick;
}

export function hidePreviewPanel(immediate = false) {
    clearTimeout(showTimer);
    token++;
    const close = () => {
        if (panel) {
            panel.hidden = true;
            panel.textContent = "";
        }
    };
    clearTimeout(hideTimer);
    if (immediate) close();
    // Small grace period so moving between adjacent rows doesn't flicker.
    else hideTimer = setTimeout(close, 60);
}
