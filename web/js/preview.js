import { getCache, isNotFound, loadStyle, loadGroupTags, trackMarquee, trackPress } from "./util.js";
import { injectTagStyles, renderTagCloud, SURFACE_CLASS, previewUrl } from "./tagview.js";

const PANEL_ID = "erenodes-hover-preview";
const MAX_PILLS = 60;
/** Long enough that arrowing down a list doesn't fire a request per row, short enough to feel instant when the pointer settles. */
const HOVER_DELAY = 120;

let panel = null;
let hideTimer = 0;
let showTimer = 0;
let token = 0;

function injectPreviewStyles() { loadStyle("preview"); }

function ensurePanel() {
    if (panel?.isConnected) return panel;
    injectTagStyles();
    injectPreviewStyles();
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    // The panel renders tags, so it is a tag surface like any node.
    panel.className = SURFACE_CLASS;
    panel.hidden = true;
    // Moving from the row into the panel must not close it, or the pills are unreachable.
    panel.addEventListener("pointerenter", () => clearTimeout(hideTimer));
    panel.addEventListener("pointerleave", () => hidePreviewPanel());
    document.body.appendChild(panel);
    return panel;
}

/** Place the panel beside an anchor rect, flipping and clamping so it always stays on screen — same rules the old in-menu image preview used. */
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
        const value = await getCache(url, "json");
        return isNotFound(value) ? null : value;
    } catch {
        return null;
    }
}

/** Tags a preview should show for a given file type. */
async function loadTags(type, path, extension) {
    if (type === "group") return loadGroupTags(path, extension || ".json");
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
 * @param {DOMRect} opts.anchor  rect to position against
 * @param {boolean} [opts.image=true]  include the thumbnail
 * @param {boolean} [opts.interactive=false]  let the pointer enter and pick tags (sidebar only; menu previews stay click-through)
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
            cloud.classList.add("scrollbar-custom");
            el.appendChild(cloud);
            if (interactive) attachPillPicking(cloud, tags, el);
            hasTags = true;
        } else if (type === "group") {
            // An empty group is worth saying; a lora with no trained words is not.
            const empty = document.createElement("div");
            empty.className = "ere-preview-empty";
            empty.textContent = "Empty tag group";
            el.appendChild(empty);
            hasTags = true;
        }
        revealIfReady();
    }, HOVER_DELAY);
}

/** Selectable, draggable pills, with the same grammar as pills inside a node. */
function attachPillPicking(cloud, tags, panelEl) {
    const pills = [...cloud.querySelectorAll(".ere-pill:not(.ere-more)")];
    const picked = new Set();
    let anchorIndex = null;

    const sync = () => {
        pills.forEach((pill, i) => pill.classList.toggle("ere-selected", picked.has(i)));
        if (onPickChange) onPickChange(picked.size);
    };

    // The background rubber-bands, as empty space does in a node or in the sidebar.
    attachPanelMarquee(panelEl, pills, picked, sync);

    pills.forEach((pill, index) => {
        pill.addEventListener("pointerdown", (e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            trackPress(e, {
                onDrag: (session) => {
                    // Drag the picked set if this pill belongs to it, else just this one.
                    const indices = picked.has(index) ? [...picked].sort((a, b) => a - b) : [index];
                    const payload = indices.map(i => tags[i]).filter(Boolean);
                    const label = payload.length > 1 ? `${payload.length} tags` : (payload[0]?.name ?? "");
                    hidePreviewPanel(true);
                    startDrag?.({
                        tags: payload, label, x: session.x, y: session.y,
                        origin: { kind: "preview", onCanvasDrop: onCanvasDropFromPreview },
                    });
                },
                // A plain click does nothing: toggling here would imply it changes the group.
                onClick: (ev) => {
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
                },
            });
        });
    });
}

/** Rubber-band selection over preview pills. */
function attachPanelMarquee(panelEl, pills, picked, sync) {
    panelEl.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest?.(".ere-pill")) return;
        e.stopPropagation();

        const additive = e.ctrlKey || e.metaKey;
        const applyPicked = (keys) => {
            picked.clear();
            for (const key of keys) picked.add(key);
            sync();
        };
        trackMarquee(e, {
            items: () => pills.map((pill, i) => ({ key: i, el: pill })),
            base: additive ? picked : [],
            onChange: applyPicked,
            // A press on the background that never became a band clears.
            onClick: () => { if (!additive && picked.size) applyPicked([]); },
            // The panel sits above everything; its band has to as well.
            bandClass: "ere-marquee-above",
            markBody: false,
        });
    });
}

// Injected by the sidebar rather than imported: importing dragdrop.js here would close the cycle preview -> dragdrop -> contextmenu -> preview.
// Class exports are not hoisted, so such a cycle risks a temporal-dead-zone error at module init.
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
