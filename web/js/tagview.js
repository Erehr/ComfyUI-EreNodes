import { displayNameFor, strengthText } from "./parser.js";
import { loadStyle, apiUrl, requestJson } from "./util.js";

// Colours

/* Values live in tagview.css, one set per theme. */

/** Pill / tile background for an active tag, by type. */
export const TYPE_FILL = {
    lora: "var(--ere-fill-lora)",
    embedding: "var(--ere-fill-embedding)",
    group: "var(--ere-fill-group)",
    // Prose is not a category of thing, it is the thing itself: one step darker than the body it sits on.
    text: "var(--ere-fill-text)",
};
export const DEFAULT_FILL = "var(--ere-fill-tag)";

/** Toggle-row knob colour for an active tag, by type. */
export const TOGGLE_KNOB = {
    lora: "var(--ere-knob-lora)",
    embedding: "var(--ere-knob-embedding)",
    group: "var(--ere-knob-group)",
    text: "var(--ere-knob-text)",
};
export const TOGGLE_KNOB_DEFAULT = "var(--ere-knob-tag)";

/** Accent for drag affordances. TYPE_FILL is near-black so pill text stays readable, which makes it useless for a thin outline. */
export const TYPE_ACCENT = {
    tag: "#4a9eff",        // blue
    lora: "#5fbf6a",       // green
    embedding: "#d2687f",  // red
    group: "#e0a53f",      // amber
    text: "#9aa0a6",       // neutral grey
    mixed: "#a97ee0",      // violet
};
export const DEFAULT_ACCENT = TYPE_ACCENT.tag;

/** The shared type's accent, or `mixed` when the set spans several. */
export function accentForTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return DEFAULT_ACCENT;
    let seen = null;
    for (const tag of tags) {
        // Tags with no explicit type are plain csv tags.
        const type = tag?.type || "tag";
        if (seen === null) seen = type;
        else if (seen !== type) return TYPE_ACCENT.mixed;
    }
    return TYPE_ACCENT[seen] ?? DEFAULT_ACCENT;
}

// Tile Sizing
// Shared by the sidebar's grid toggles and the Gallery node's menu, so the two cannot drift.

/** Folder tiles stay small whatever the items do: a folder icon gains nothing from size. */
export const TILE_SIZE = 96;
/** Grid gap, in px, shared with sidebar.css. A large tile spans two small ones plus the gap. */
export const TILE_GAP = 8;

export const TILE_SIZES = [
    { id: "small", width: TILE_SIZE, icon: "icon-[lucide--minimize-2]", label: "Small previews" },
    { id: "large", width: TILE_SIZE * 2 + TILE_GAP, icon: "icon-[lucide--maximize-2]", label: "Large previews" },
];

// Portrait only - landscape tiles read badly in a narrow sidebar.
// ComfyUI compiles a subset of lucide without the rectangles, so all three stretch the square: at 16px the scaling reads as the shape.
export const TILE_RATIOS = [
    { id: "1-1",  ratio: 1,      label: "Aspect 1:1" },
    { id: "3-4",  ratio: 3 / 4,  label: "Aspect 3:4" },
    { id: "9-16", ratio: 9 / 16, label: "Aspect 9:16" },
];

/** The pixel box for a size id and a ratio id. */
export function tileBoxFor(sizeId, ratioId) {
    const size = TILE_SIZES.find(o => o.id === sizeId) ?? TILE_SIZES[0];
    const ratio = TILE_RATIOS.find(o => o.id === ratioId) ?? TILE_RATIOS[0];
    return { width: size.width, height: Math.round(size.width / ratio.ratio) };
}

// Surface

/** Marks a visual surface that should render tags like a node does. */
export const SURFACE_CLASS = "ere-surface";

/** Encode a tag/file name for the /erenodes/view/{type}/{path} route. */
// Preview bookkeeping.
// Thumbnails are DOM `<img>`, so the browser owns loading, decoding and caching.
// These maps hold the two things it cannot: that a cover does not exist (204 is not heuristically cacheable) and that one was replaced behind an unchanged URL.
const missingPreviews = new Set();
const previewVersions = new Map();
// Moved by a refresh: covers can change behind our back (another tool downloading them), and the browser keeps an old one for its max-age.
let previewEpoch = 0;

/** A cover's identity, independent of the tile size it happens to be drawn at. */
export function previewKey(type, name) {
    const encoded = String(name).replace(/\\/g, "/").split('/').map(encodeURIComponent).join('/');
    return `/erenodes/view/${type}/${encoded}`;
}

export function previewUrl(type, name) {
    const key = previewKey(type, name);
    // Only once a cover has been replaced, so ordinary URLs stay stable and stay cached.
    const version = previewVersions.get(key);
    const url = apiUrl(key);
    return version || previewEpoch ? `${url}?v=${previewEpoch}.${version || 0}` : url;
}

/** Re-ask for every cover, including the ones known to be missing. */
export function forgetPreviews() {
    missingPreviews.clear();
    videoPreviews.clear();
    previewEpoch++;
}

// Covers known to be clips (.mp4), so later renders build the <video> without failing as an <img> first.
const videoPreviews = new Set();

function coverVideo(url, className, onLoad, onMissing) {
    const video = document.createElement("video");
    video.className = className;
    video.muted = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.preload = "metadata";
    // Until a frame is in, it is an empty 300x150 box.
    video.style.visibility = "hidden";
    video.addEventListener("loadeddata", () => {
        video.style.visibility = "";
        onLoad?.(video);
    }, { once: true });
    video.addEventListener("error", () => onMissing?.(video), { once: true });
    // Paused at zero a video may draw nothing; a start just past it makes the first frame decode.
    video.src = `${url}#t=0.001`;
    return video;
}

/**
 * A cover: an <img>, or for a clip a muted <video> paused on its first frame (other tools save Civitai's animated previews as .mp4).
 * A failed <img> is either a 204 (no cover) or a clip, and only the response type tells them apart, so it asks once and swaps itself out in place.
 * `onLoad` and `onMissing` get the element that ended up on screen, which is not the returned one after a swap.
 */
export function coverElement(url, { className = "", lazy = false, onLoad = null, onMissing = null } = {}) {
    const key = url.split("?")[0];
    if (videoPreviews.has(key)) return coverVideo(url, className, onLoad, onMissing);
    const img = document.createElement("img");
    img.className = className;
    img.draggable = false;
    if (lazy) img.loading = "lazy";
    img.addEventListener("load", () => onLoad?.(img));
    img.addEventListener("error", async () => {
        let clip = false;
        try {
            clip = !!(await fetch(url, { method: "HEAD" })).headers.get("content-type")?.startsWith("video/");
        } catch { /* unreachable is missing */ }
        if (!clip) return onMissing?.(img);
        videoPreviews.add(key);
        const video = coverVideo(url, className, onLoad, onMissing);
        video.hidden = img.hidden;
        img.replaceWith(video);
    }, { once: true });
    img.src = url;
    return img;
}

/** Store a cover for a lora, embedding or tag group, and move its URL so the new bytes are fetched. */
export async function saveCover(type, name, file) {
    const form = new FormData();
    form.append("type", type);
    form.append("name", name);
    form.append("image_file", file, file.name);
    const result = await requestJson("/erenodes/save_file_image", { form });
    bumpPreview(type, name);
    return result;
}

/** A cover was written or deleted: forget it was missing, and move the URL so the browser fetches the new bytes. */
export function bumpPreview(type, name) {
    const key = previewKey(type, name);
    missingPreviews.delete(key);
    previewVersions.set(key, (previewVersions.get(key) || 0) + 1);
}

// Elements

/** A single-mode group names its pick after its own name. */
function labelFor(tag, stripFolders) {
    const name = displayNameFor(tag, stripFolders);
    if (tag.type !== "group" || tag.mode !== "single") return name;
    const pick = tag.content?.[0];
    return `${name}: ${pick ? displayNameFor(pick, true) : "none"}`;
}

/** A lora's trigger words are added to it; a multi-mode group's picks are a part of it. */
function countBadge(tag) {
    if (tag.type === "lora" && tag.triggers?.length > 0) return `[+${tag.triggers.length}]`;
    if (tag.type === "group" && tag.mode === "multi") return `[${tag.content?.length ?? 0}]`;
    return "";
}

/**
 * A single tag pill.
 * @param {object} [opts] stripFolders (basename only), showTriggers.
 */
export function renderTagPill(tag, opts = {}) {
    const pill = document.createElement("div");
    // A text pill is a paragraph, not a chip — see .ere-text in tagview.css.
    pill.className = "ere-pill" + (tag.active === false ? " inactive" : "")
        + (tag.type === "text" ? " ere-text" : "");

    // Fill only: the disabled look is a class, so it follows a palette change.
    if (tag.active !== false) pill.style.setProperty("--ere-fill", TYPE_FILL[tag.type] || DEFAULT_FILL);

    let name = labelFor(tag, !!opts.stripFolders);
    const badge = countBadge(tag);
    if (opts.showTriggers !== false && badge) name += ` ${badge}`;
    pill.textContent = name;

    const st = strengthText(tag);
    if (st) {
        const span = document.createElement("span");
        span.className = "ere-strength";
        span.textContent = st;
        pill.appendChild(span);
    }
    return pill;
}

/** The on/off knob: a Prompt Toggle row, and a Prompt Composer category header. */
export function renderSwitchEl(active, type, slide = false) {
    const sw = document.createElement("div");
    // A class, not inline left/right: those two cannot animate into each other.
    sw.className = "ere-switch" + (active ? " ere-on" : "") + (slide ? " ere-slide" : "");
    const knob = document.createElement("div");
    knob.className = "ere-knob";
    knob.style.background = active ? (TOGGLE_KNOB[type] || TOGGLE_KNOB_DEFAULT) : "var(--ere-knob-off)";
    sw.appendChild(knob);
    return sw;
}

/** A full-width toggle row (Prompt Toggle node). */
export function renderToggleRowEl(tag, opts = {}) {
    const row = document.createElement("div");
    row.className = "ere-toggle-row" + (tag.active ? "" : " inactive")
        + (tag.type === "text" ? " ere-text" : "");
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", String(!!tag.active));

    row.appendChild(renderSwitchEl(tag.active, tag.type, opts.slide));

    const label = document.createElement("span");
    label.className = "ere-label";
    label.textContent = labelFor(tag, false);
    row.appendChild(label);

    // Its own element rather than more label text: a row is name-left / numbers-right, and text
    // inside the ellipsised label cannot be pushed to the far edge.
    const badge = countBadge(tag);
    const st = strengthText(tag);
    if (badge || st) {
        const meta = document.createElement("span");
        meta.className = "ere-meta";
        if (badge) {
            const span = document.createElement("span");
            span.textContent = badge;
            meta.appendChild(span);
        }
        if (st) {
            const span = document.createElement("span");
            span.className = "ere-strength";
            span.textContent = st;
            meta.appendChild(span);
        }
        row.appendChild(meta);
    }
    return row;
}

/** A gallery tile (Prompt Gallery node, and the sidebar's grid view). */
export function renderTagTile(tag, opts = {}) {
    const tile = document.createElement("div");
    tile.className = "ere-tile" + (tag.active === false ? " inactive" : "");
    // Sized by the caller's layout when it does not say: the sidebar grid gives the cell a width and an aspect ratio.
    if (opts.width) tile.style.width = `${opts.width}px`;
    if (opts.height) tile.style.height = `${opts.height}px`;

    if (tag.type === 'lora' || tag.type === 'group' || tag.type === 'embedding') {
        const key = previewKey(tag.type, tag.name);
        // Nothing behind this URL last time: skip the element rather than fire a request whose answer the browser will not keep. It is absolutely positioned, so an absent one lays out like a hidden one.
        if (!missingPreviews.has(key)) {
            tile.appendChild(coverElement(previewUrl(tag.type, tag.name), {
                lazy: true,
                onMissing: (cover) => {
                    missingPreviews.add(key);
                    cover.style.display = "none";
                },
            }));
        }
    }

    const nameBar = document.createElement("div");
    nameBar.className = "ere-name";
    if (tag.active !== false) nameBar.style.setProperty("--ere-fill", TYPE_FILL[tag.type] || DEFAULT_FILL);
    nameBar.textContent = labelFor(tag, opts.stripFolders !== false);
    tile.appendChild(nameBar);

    let infoText = countBadge(tag);
    const st = strengthText(tag);
    if (st) infoText += (infoText ? " " : "") + st.trim();
    if (infoText) {
        const info = document.createElement("div");
        info.className = "ere-info";
        info.textContent = infoText;
        tile.appendChild(info);
    }
    return tile;
}

/**
 * A wrapped flow of pills on its own surface.
 * @param {object} [opts] renderTagPill options, plus `max` for a "+n more" cap.
 */
export function renderTagCloud(tags, opts = {}) {
    const wrap = document.createElement("div");
    wrap.className = `${SURFACE_CLASS} ere-cloud ere-flow`;
    const list = Array.isArray(tags) ? tags.filter(t => t && t.name) : [];
    const max = opts.max ?? Infinity;

    for (const tag of list.slice(0, max)) {
        wrap.appendChild(renderTagPill(tag, opts));
    }
    if (list.length > max) {
        const more = document.createElement("div");
        more.className = "ere-pill ere-more";
        more.textContent = `+${list.length - max} more`;
        wrap.appendChild(more);
    }
    return wrap;
}

// Stylesheet

/** Inject the tag stylesheet. Idempotent — safe to call from every surface. */
export function injectTagStyles() { loadStyle("tagview"); }
