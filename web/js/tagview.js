import { displayNameFor, strengthText } from "./parser.js";
import { loadStyle } from "./util.js";

// Colours

/** Pill / tile background for an active tag, by type. */
export const TYPE_FILL = {
    lora: "#415041",       // dark green
    embedding: "#504149",  // dark purple
    group: "#504C41",      // dark amber
    // Prose is not a category of thing, it is the thing itself: near-black, and darker than the
    // #2b2c2f a Composer body is drawn on so it still reads as a pill there.
    text: "#262626",
};
export const DEFAULT_FILL = "#414650";

/** Toggle-row knob colour for an active tag, by type. */
export const TOGGLE_KNOB = {
    lora: "#89a189",
    embedding: "#9b8899",
    group: "#9b9188",
    text: "#9b9b9b",
};
export const TOGGLE_KNOB_DEFAULT = "#8899bb";

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

/** `#rrggbb` -> `r, g, b`, so one accent drives both a border and an rgba fill. */
export function hexToRgbTriplet(hex) {
    const m = /^#?([\da-f]{6})$/i.exec(String(hex).trim());
    if (!m) return "74, 158, 255";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
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

export function fallbackColors() {
    const LG = window.LiteGraph || {};
    return {
        widgetBg: LG.WIDGET_BGCOLOR || "#222",
        widgetText: LG.WIDGET_TEXT_COLOR || "#DDD",
        box: LG.NODE_DEFAULT_BOXCOLOR || "#666",
    };
}

/** Encode a tag/file name for the /erenodes/view/{type}/{path} route. */
// Preview bookkeeping.
// Thumbnails are DOM `<img>`, so the browser owns loading, decoding and caching.
// These maps hold the two things it cannot: that a cover does not exist (204 is not heuristically cacheable) and that one was replaced behind an unchanged URL.
const missingPreviews = new Set();
const previewVersions = new Map();

/** A cover's identity, independent of the tile size it happens to be drawn at. */
export function previewKey(type, name) {
    const encoded = String(name).replace(/\\/g, "/").split('/').map(encodeURIComponent).join('/');
    return `/erenodes/view/${type}/${encoded}`;
}

export function previewUrl(type, name, w, h) {
    const key = previewKey(type, name);
    const params = (w && h) ? [`w=${w}`, `h=${h}`, "fit=cover"] : [];
    // Only once a cover has been replaced, so ordinary URLs stay stable and stay cached.
    const version = previewVersions.get(key);
    if (version) params.push(`v=${version}`);
    return params.length ? `${key}?${params.join("&")}` : key;
}

/** A cover was written or deleted: forget it was missing, and move the URL so the browser fetches the new bytes. */
export function bumpPreview(type, name) {
    const key = previewKey(type, name);
    missingPreviews.delete(key);
    previewVersions.set(key, (previewVersions.get(key) || 0) + 1);
}

// Elements

/**
 * A single tag pill.
 * @param {object} [opts] colors, stripFolders (basename only), showTriggers.
 */
export function renderTagPill(tag, opts = {}) {
    const colors = opts.colors ?? fallbackColors();
    const pill = document.createElement("div");
    // A text pill is a paragraph, not a chip — see .ere-text in tagview.css.
    pill.className = "ere-pill" + (tag.active === false ? " inactive" : "")
        + (tag.type === "text" ? " ere-text" : "");

    const fill = TYPE_FILL[tag.type] || DEFAULT_FILL;
    if (tag.active === false) {
        pill.style.background = colors.widgetBg;
        pill.style.borderColor = "#444";
        pill.style.color = colors.widgetText;
    } else {
        pill.style.background = fill;
        pill.style.borderColor = fill;
    }

    let name = displayNameFor(tag, !!opts.stripFolders);
    if (opts.showTriggers !== false && tag.type === 'lora' && tag.triggers?.length > 0) {
        name += ` [+${tag.triggers.length}]`;
    }
    pill.textContent = name;

    const st = strengthText(tag);
    if (st) {
        const span = document.createElement("span");
        span.className = "ere-strength";
        span.textContent = st;
        pill.appendChild(span);
    }
    pill.title = name + st;
    return pill;
}

/** The on/off knob: a Prompt Toggle row, and a Prompt Composer category header. */
export function renderSwitchEl(active, type) {
    const sw = document.createElement("div");
    sw.className = "ere-switch";
    const knob = document.createElement("div");
    knob.className = "ere-knob";
    if (active) {
        knob.style.background = TOGGLE_KNOB[type] || TOGGLE_KNOB_DEFAULT;
        knob.style.right = "-2px";
    } else {
        knob.style.background = "#888";
        knob.style.left = "-2px";
    }
    sw.appendChild(knob);
    return sw;
}

/** A full-width toggle row (Prompt Toggle node). */
export function renderToggleRowEl(tag, opts = {}) {
    const colors = opts.colors ?? fallbackColors();
    const row = document.createElement("div");
    row.className = "ere-toggle-row" + (tag.active ? "" : " inactive")
        + (tag.type === "text" ? " ere-text" : "");
    if (!tag.active) row.style.color = colors.widgetText;

    row.appendChild(renderSwitchEl(tag.active, tag.type));

    const label = document.createElement("span");
    label.className = "ere-label";
    let name = displayNameFor(tag, false);
    if (tag.type === 'lora' && tag.triggers?.length > 0) name += ` [+${tag.triggers.length}]`;
    label.textContent = name;
    const st = strengthText(tag);
    if (st) {
        const span = document.createElement("span");
        span.className = "ere-strength";
        span.textContent = st;
        label.appendChild(span);
    }
    row.appendChild(label);
    return row;
}

/** A gallery tile (Prompt Gallery node, and the sidebar's grid view). */
export function renderTagTile(tag, opts = {}) {
    const colors = opts.colors ?? fallbackColors();
    const w = opts.width ?? 100;
    const h = opts.height ?? 100;

    const tile = document.createElement("div");
    tile.className = "ere-tile" + (tag.active === false ? " inactive" : "");
    tile.style.width = `${w}px`;
    tile.style.height = `${h}px`;

    if (tag.type === 'lora' || tag.type === 'group' || tag.type === 'embedding') {
        const key = previewKey(tag.type, tag.name);
        // Nothing behind this URL last time: skip the element rather than fire a request whose answer the browser will not keep. It is absolutely positioned, so an absent one lays out like a hidden one.
        if (!missingPreviews.has(key)) {
            const img = document.createElement("img");
            img.loading = "lazy";
            img.draggable = false;
            img.src = previewUrl(tag.type, tag.name, w, h);
            img.addEventListener("error", () => {
                missingPreviews.add(key);
                img.style.display = "none";
            });
            tile.appendChild(img);
        }
    }

    const nameBar = document.createElement("div");
    nameBar.className = "ere-name";
    const fill = TYPE_FILL[tag.type] || DEFAULT_FILL;
    if (tag.active === false) {
        nameBar.style.background = colors.widgetBg;
        nameBar.style.color = colors.widgetText;
    } else {
        nameBar.style.background = fill;
    }
    nameBar.textContent = displayNameFor(tag, opts.stripFolders !== false);
    tile.appendChild(nameBar);

    let infoText = "";
    if (tag.triggers?.length > 0) infoText += `[+${tag.triggers.length}]`;
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
    const colors = opts.colors ?? fallbackColors();
    const list = Array.isArray(tags) ? tags.filter(t => t && t.name) : [];
    const max = opts.max ?? Infinity;

    for (const tag of list.slice(0, max)) {
        wrap.appendChild(renderTagPill(tag, { ...opts, colors }));
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
