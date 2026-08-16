// Shared tag rendering — pills, toggle rows, gallery tiles.
//
// One implementation for every surface that draws a tag: the node widgets
// (renderer.js), the context-menu hover previews (contextmenu.js) and the
// sidebar (sidebar.js). Before this module the menus re-implemented pills with
// their own hardcoded colours, which had already drifted from the node's.
//
// Styling is scoped to `.ere-surface`, NOT to `.erenodes-dom`. Node widget roots
// carry both classes: `.erenodes-dom` stays the structural hook that drag & drop
// and the Vue-remount adoption query on (`rootOf`, `[data-ere-node]`), while
// `.ere-surface` is the purely visual scope anything can opt into. That is what
// lets a preview panel or a sidebar row look identical to a pill in a node
// without duplicating a single rule.
//
// Elements returned here carry no event listeners — callers attach their own.

import { TYPE_FILL, DEFAULT_FILL, TOGGLE_KNOB, TOGGLE_KNOB_DEFAULT } from "./tagcolors.js";

/** Marks a visual surface that should render tags like a node does. */
export const SURFACE_CLASS = "ere-surface";

export const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

export function fallbackColors() {
    const LG = window.LiteGraph || {};
    return {
        widgetBg: LG.WIDGET_BGCOLOR || "#222",
        widgetText: LG.WIDGET_TEXT_COLOR || "#DDD",
        box: LG.NODE_DEFAULT_BOXCOLOR || "#666",
    };
}

// File extensions a name may legitimately end with. Only these are stripped —
// cutting at the last "." truncated any name that merely contained one, so a
// lora called "v1.5_style" rendered as "v1".
const KNOWN_EXTENSIONS = /\.(json|safetensors|ckpt|lora|pt|bin|embedding)$/i;

export function displayNameFor(tag, stripFolders) {
    let displayName = tag.name || "";
    if (tag.type === 'lora' || tag.type === 'group') {
        if (stripFolders) {
            displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1);
        }
        // Names arrive extension-less (the server splitext's them and keeps the
        // extension in tag.extension); this only cleans up legacy/hand-edited
        // entries that still carry one.
        displayName = displayName.replace(KNOWN_EXTENSIONS, "");
    } else if (tag.type === 'embedding') {
        displayName = displayName.replace(/^embedding:/, '');
    }
    return displayName;
}

export function strengthText(tag) {
    if (tag.strength && Number(tag.strength) !== 1.0) return ` ${Number(tag.strength).toFixed(2)}`;
    return "";
}

/** Encode a tag/file name for the /erenodes/view/{type}/{path} route.
 *
 * Subfolder paths from the server use OS separators, so on Windows names arrive
 * as "sub\lora". Normalise to forward slashes first, then encode per segment:
 * keeps subfolder slashes literal for the {path:.*} route while escaping ?, #,
 * + and & inside filenames.
 */
export function previewUrl(type, name, w, h) {
    const encoded = String(name).replace(/\\/g, "/").split('/').map(encodeURIComponent).join('/');
    const size = (w && h) ? `?w=${w}&h=${h}&fit=cover` : "";
    return `/erenodes/view/${type}/${encoded}${size}`;
}

// ------------------------------------------------------------------- elements

/**
 * A single tag pill, styled exactly as a Prompt Cloud node draws it.
 *
 * @param {object} tag
 * @param {object} [opts]
 * @param {object} [opts.colors]        fallbackColors() result (built if absent)
 * @param {boolean} [opts.stripFolders] show only the basename
 * @param {boolean} [opts.showTriggers] append " [+n]" for lora trigger counts
 */
export function renderTagPill(tag, opts = {}) {
    const colors = opts.colors ?? fallbackColors();
    const pill = document.createElement("div");
    pill.className = "ere-pill" + (tag.active === false ? " inactive" : "");

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

/** A full-width toggle row (Prompt Toggle node). */
export function renderToggleRowEl(tag, opts = {}) {
    const colors = opts.colors ?? fallbackColors();
    const row = document.createElement("div");
    row.className = "ere-toggle-row" + (tag.active ? "" : " inactive");
    if (!tag.active) row.style.color = colors.widgetText;

    const sw = document.createElement("div");
    sw.className = "ere-switch";
    const knob = document.createElement("div");
    knob.className = "ere-knob";
    if (tag.active) {
        knob.style.background = TOGGLE_KNOB[tag.type] || TOGGLE_KNOB_DEFAULT;
        knob.style.right = "-2px";
    } else {
        knob.style.background = "#888";
        knob.style.left = "-2px";
    }
    sw.appendChild(knob);
    row.appendChild(sw);

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
        const img = document.createElement("img");
        img.loading = "lazy";
        img.draggable = false;
        img.src = previewUrl(tag.type, tag.name, w, h);
        img.addEventListener("error", () => { img.style.display = "none"; });
        tile.appendChild(img);
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
 * A wrapped flow of pills on its own surface — the building block for hover
 * previews and anywhere else a tag list needs to look like a node's cloud.
 *
 * @param {Array<object>} tags
 * @param {object} [opts] passed through to renderTagPill, plus:
 * @param {number} [opts.max] cap the pill count and append a "+n more" marker
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

// --------------------------------------------------------------------- styles

/**
 * Inject the tag stylesheet. Idempotent — safe to call from every surface.
 *
 * Every rule is scoped to `.ere-surface` so the node, the preview panel and the
 * sidebar are guaranteed to render a pill identically: there is only one rule.
 */
export function injectTagStyles() {
    const css = `
.${SURFACE_CLASS} {
    font: 12px monospace; box-sizing: border-box;
    color: var(--component-node-foreground, #ddd);
}
.${SURFACE_CLASS} * { box-sizing: border-box; }
.erenodes-dom {
    width: 100%; min-height: 0; overflow: hidden;
    display: flex; flex-direction: column; gap: 5px;
}
.erenodes-dom.ere-multiline {
    height: auto; flex: 0 0 auto; gap: 0; overflow: visible;
}
.erenodes-dom .ere-toolbar { flex: 0 0 auto; }
.erenodes-dom .ere-scroll {
    flex: 1 1 auto; min-height: 0;
    overflow-x: hidden; overflow-y: hidden;
    scrollbar-width: thin;
}
.erenodes-dom-content { box-sizing: border-box; width: 100%; }
.${SURFACE_CLASS} .ere-flow { display: flex; flex-wrap: wrap; gap: 5px; align-items: flex-start; }
.${SURFACE_CLASS} .ere-btn {
    width: 20px; height: 20px; flex: 0 0 auto; padding: 0;
    border-radius: 5px; border: 1px solid var(--component-node-border, #444);
    display: flex; align-items: center; justify-content: center;
    background: var(--component-node-widget-background, #353535);
    color: var(--component-node-foreground-secondary, #aaa);
    cursor: pointer; user-select: none; font: inherit; line-height: 18px;
}
.${SURFACE_CLASS} .ere-btn:hover {
    background: var(--component-node-widget-background-hovered, #2a2a2a);
    color: var(--component-node-foreground, #ddd);
}
.${SURFACE_CLASS} .ere-pill {
    height: 20px; line-height: 18px; max-width: 100%;
    border-radius: 6px; border: 1px solid transparent; padding: 0 5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: pointer; user-select: none; color: #FFF;
}
.${SURFACE_CLASS} .ere-pill.inactive { opacity: .75; }
.${SURFACE_CLASS} .ere-pill.ere-more {
    background: transparent; border-color: var(--component-node-border, #444);
    color: var(--component-node-foreground-secondary, #aaa); cursor: default;
}
.${SURFACE_CLASS} .ere-strength { opacity: .5; }
.${SURFACE_CLASS} .ere-panel {
    border: 1px solid var(--component-node-border, #444);
    border-radius: 5px; padding: 5px;
    background: var(--component-node-widget-background, #222);
}
.${SURFACE_CLASS} .ere-toggle-row {
    display: flex; align-items: center; width: 100%;
    height: 20px; border-radius: 6px;
    border: 1px solid var(--component-node-border, #444);
    background: var(--component-node-widget-background, #222);
    cursor: pointer; user-select: none; overflow: hidden;
}
.${SURFACE_CLASS} .ere-toggle-row.inactive { opacity: .75; }
.${SURFACE_CLASS} .ere-toggle-row .ere-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #FFF;
}
.${SURFACE_CLASS} .ere-toggle-row.inactive .ere-label { color: inherit; }
.${SURFACE_CLASS} .ere-switch {
    position: relative; width: 18px; height: 10px; margin: 0 12px 0 5px;
    border-radius: 5px; background: #3b3b3b; flex: 0 0 auto;
}
.${SURFACE_CLASS} .ere-switch .ere-knob {
    position: absolute; top: -2px; width: 14px; height: 14px; border-radius: 50%;
}
.${SURFACE_CLASS} .ere-tile {
    position: relative; flex: 0 0 auto; overflow: hidden;
    border-radius: 5px; border: 1px solid var(--component-node-border, #444);
    background: var(--component-node-widget-background, #222);
    cursor: pointer; user-select: none;
}
.${SURFACE_CLASS} .ere-tile img {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
}
.${SURFACE_CLASS} .ere-tile.inactive img { filter: grayscale(0.75); opacity: .25; }
.${SURFACE_CLASS} .ere-tile .ere-name {
    position: absolute; left: 0; right: 0; bottom: 0; height: 20px; line-height: 20px;
    padding: 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #FFF; border-radius: 0 0 5px 5px;
}
.${SURFACE_CLASS} .ere-tile.inactive .ere-name { opacity: .5; }
.${SURFACE_CLASS} .ere-tile .ere-info {
    position: absolute; top: 2.5px; right: 2.5px; height: 15px; line-height: 15px;
    padding: 0 3px; font-size: 10px; text-align: center;
    background: #222; color: #FFF; border-radius: 5px; opacity: .75;
}
.${SURFACE_CLASS} .ere-tile.inactive .ere-info { opacity: .5; }
`;
    let style = document.getElementById("erenodes-dom-style");
    if (!style) {
        style = document.createElement("style");
        style.id = "erenodes-dom-style";
        document.head.appendChild(style);
    }
    style.textContent = css;
}
