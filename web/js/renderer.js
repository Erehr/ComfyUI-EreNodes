// Tag UI renderer — unified DOM widgets for both classic LiteGraph and Nodes 2.0.
//
// Classic mounts the element in the DomWidgets overlay; Vue mounts it inside
// the node. One implementation, no canvas onDrawForeground path.
// Tag-type colors stay custom; chrome (buttons / panels) prefers ComfyUI's
// --component-node-* theme variables when present.
//
// The previous canvas implementation was removed; see git history if needed.

import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

// Re-render tag UIs after undo/redo. The change tracker restores graph state
// and fires "graphChanged"; in the Vue renderer existing nodes keep their DOM
// widget instances, so without this the pills kept showing the pre-undo state
// (the data was restored correctly — a copy of the node pasted fine).
// Cheap: only nodes whose tag JSON actually differs re-render.
let graphChangedHooked = false;
function hookGraphChanged() {
    if (graphChangedHooked) return;
    graphChangedHooked = true;
    api.addEventListener("graphChanged", () => {
        for (const n of app.graph?._nodes ?? []) {
            n._ereDom?.renderIfChanged?.();
        }
    });
}

// Custom tag-type palette (no ComfyUI equivalent)
const TYPE_FILL = { lora: "#415041", embedding: "#504149", group: "#504C41" };
const DEFAULT_FILL = "#414650";
const TOGGLE_KNOB = { lora: "#89a189", embedding: "#9b8899", group: "#9b9188" };
const TOGGLE_KNOB_DEFAULT = "#8899bb";

export const MODE_BY_TYPE = {
    ErePromptCloud: "cloud",
    ErePromptToggle: "toggle",
    ErePromptMultiSelect: "multiselect",
    ErePromptRandomizer: "randomizer",
    ErePromptGallery: "gallery",
    ErePromptMultiline: "multiline",
};

// Hide transport widgets from both renderers.
// Classic: widget.hidden + computeSize=[0,0]
// Vue: options.hidden (and converted-widget type as a belt-and-suspenders)
function hideNativeWidget(w) {
    if (!w || w._ereHidden) return;
    w._ereHidden = true;
    w.hidden = true;
    if (w.options) w.options.hidden = true;
    else w.options = { hidden: true };
    w.computeSize = () => [0, 0];
    w.computeLayoutSize = () => ({ minHeight: 0, maxHeight: 0, minWidth: 0 });
    if (!String(w.type ?? "").startsWith("converted-widget")) {
        w._ereOrigType = w.type;
        w.type = "converted-widget";
    }
    if (w.element?.style) w.element.style.display = "none";
}

function nativeWidgetsToHide(node, mode) {
    const list = [];
    const sep = node.widgets?.find(w => w.name === "separator");
    if (sep) list.push(sep);
    if (mode !== "multiline") {
        const text = node.widgets?.find(w => w.name === "text");
        if (text) list.push(text);
    }
    return list;
}

function fallbackColors() {
    const LG = window.LiteGraph || {};
    return {
        widgetBg: LG.WIDGET_BGCOLOR || "#222",
        widgetText: LG.WIDGET_TEXT_COLOR || "#DDD",
        box: LG.NODE_DEFAULT_BOXCOLOR || "#666",
    };
}

const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

function displayNameFor(tag, stripFolders) {
    let displayName = tag.name || "";
    if (tag.type === 'lora' || tag.type === 'group') {
        if (stripFolders) {
            displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1);
        }
        const dotIndex = displayName.lastIndexOf('.');
        if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
    } else if (tag.type === 'embedding') {
        displayName = displayName.replace(/^embedding:/, '');
    }
    return displayName;
}

function strengthText(tag) {
    if (tag.strength && Number(tag.strength) !== 1.0) return ` ${Number(tag.strength).toFixed(2)}`;
    return "";
}

function injectStyles() {
    const css = `
.erenodes-dom {
    font: 12px monospace; box-sizing: border-box; width: 100%;
    min-height: 0; overflow: hidden;
    display: flex; flex-direction: column; gap: 5px;
    color: var(--component-node-foreground, #ddd);
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
.erenodes-dom * { box-sizing: border-box; }
.erenodes-dom .ere-flow { display: flex; flex-wrap: wrap; gap: 5px; align-items: flex-start; }
.erenodes-dom .ere-btn {
    width: 20px; height: 20px; flex: 0 0 auto; padding: 0;
    border-radius: 5px; border: 1px solid var(--component-node-border, #444);
    display: flex; align-items: center; justify-content: center;
    background: var(--component-node-widget-background, #353535);
    color: var(--component-node-foreground-secondary, #aaa);
    cursor: pointer; user-select: none; font: inherit; line-height: 18px;
}
.erenodes-dom .ere-btn:hover {
    background: var(--component-node-widget-background-hovered, #2a2a2a);
    color: var(--component-node-foreground, #ddd);
}
.erenodes-dom .ere-pill {
    height: 20px; line-height: 18px; max-width: 100%;
    border-radius: 6px; border: 1px solid transparent; padding: 0 5px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    cursor: pointer; user-select: none; color: #FFF;
}
.erenodes-dom .ere-pill.inactive { opacity: .75; }
.erenodes-dom .ere-strength { opacity: .5; }
.erenodes-dom .ere-panel {
    border: 1px solid var(--component-node-border, #444);
    border-radius: 5px; padding: 5px;
    background: var(--component-node-widget-background, #222);
}
.erenodes-dom .ere-toggle-row {
    display: flex; align-items: center; width: 100%;
    height: 20px; border-radius: 6px;
    border: 1px solid var(--component-node-border, #444);
    background: var(--component-node-widget-background, #222);
    cursor: pointer; user-select: none; overflow: hidden;
}
.erenodes-dom .ere-toggle-row.inactive { opacity: .75; }
.erenodes-dom .ere-toggle-row .ere-label {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #FFF;
}
.erenodes-dom .ere-toggle-row.inactive .ere-label { color: inherit; }
.erenodes-dom .ere-switch {
    position: relative; width: 18px; height: 10px; margin: 0 12px 0 5px;
    border-radius: 5px; background: #3b3b3b; flex: 0 0 auto;
}
.erenodes-dom .ere-switch .ere-knob {
    position: absolute; top: -2px; width: 14px; height: 14px; border-radius: 50%;
}
.erenodes-dom .ere-tile {
    position: relative; flex: 0 0 auto; overflow: hidden;
    border-radius: 5px; border: 1px solid var(--component-node-border, #444);
    background: var(--component-node-widget-background, #222);
    cursor: pointer; user-select: none;
}
.erenodes-dom .ere-tile img {
    position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
}
.erenodes-dom .ere-tile.inactive img { filter: grayscale(0.75); opacity: .25; }
.erenodes-dom .ere-tile .ere-name {
    position: absolute; left: 0; right: 0; bottom: 0; height: 20px; line-height: 20px;
    padding: 0 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #FFF; border-radius: 0 0 5px 5px;
}
.erenodes-dom .ere-tile.inactive .ere-name { opacity: .5; }
.erenodes-dom .ere-tile .ere-info {
    position: absolute; top: 2.5px; right: 2.5px; height: 15px; line-height: 15px;
    padding: 0 3px; font-size: 10px; text-align: center;
    background: #222; color: #FFF; border-radius: 5px; opacity: .75;
}
.erenodes-dom .ere-tile.inactive .ere-info { opacity: .5; }
`;
    let style = document.getElementById("erenodes-dom-style");
    if (!style) {
        style = document.createElement("style");
        style.id = "erenodes-dom-style";
        document.head.appendChild(style);
    }
    style.textContent = css;
}

// Root-element listeners are node-agnostic, so an element adopted from a
// previous node instance keeps its original listeners; the guard prevents
// double-binding (which would e.g. forward middle-clicks twice).
function bindRootListeners(el) {
    if (el._ereRootBound) return;
    el._ereRootBound = true;

    // Stop pill interactions from dragging/selecting the node — except the
    // middle button, which pans the canvas. Forward that to the canvas element
    // in the legacy renderer (the overlay otherwise swallows it); litegraph
    // takes pointer capture on pointerdown, so the rest of the drag follows.
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
        el.addEventListener(type, (e) => {
            const isMiddle = e.button === 1 || (e.buttons & 4) !== 0;
            if (isMiddle && !window.LiteGraph?.vueNodesMode) {
                e.preventDefault();
                e.stopPropagation();
                app.canvas?.canvas?.dispatchEvent(new PointerEvent(e.type, e));
                return;
            }
            e.stopPropagation();
        });
    }
    // Legacy renderer: DomWidgets overlay swallows wheel events. When the pill
    // area is scrollable, keep the wheel entirely (including at scroll edges) so
    // it never leaks into canvas zoom. Otherwise hand it to the canvas.
    // Vue nodes handle zoom themselves — only stopPropagation while scrolling.
    el.addEventListener("wheel", (e) => {
        const scrolls = app.ui?.settings?.getSettingValue?.("EreNodes.Nodes.TagAreaScroll", false) ?? false;
        if (scrolls) {
            const scroller = el.querySelector(".ere-scroll") || el;
            if (scroller.scrollHeight > scroller.clientHeight + 1) {
                e.stopPropagation();
                return;
            }
        }
        if (window.LiteGraph?.vueNodesMode) return;
        e.preventDefault();
        e.stopPropagation();
        app.canvas?.processMouseWheel?.(e);
    }, { passive: false });
}

function makeButton(node, label, display, title) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ere-btn";
    btn.textContent = display;
    if (title) btn.title = title;
    btn.addEventListener("click", (e) => {
        e.stopPropagation();
        node.onTagPillClick?.(e, [0, 0], { label, button: true });
    });
    return btn;
}

function attachPillEvents(node, el, tag, index) {
    el.addEventListener("click", (e) => {
        e.stopPropagation();
        node.onTagPillClick?.(e, [0, 0], { label: tag.name, index });
    });
    el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const width = el.closest(".erenodes-dom")?.getBoundingClientRect()?.width
            ?? el.getBoundingClientRect().width;
        // Anchor the quick edit menu to the pill's bottom-left (same as the
        // old canvas patch did) instead of the raw cursor position.
        const rect = el.getBoundingClientRect();
        const positionEvent = { clientX: rect.left, clientY: rect.bottom + 5 };
        node.onTagQuickEdit?.(positionEvent, node, { label: tag.name, index }, width);
    });
}

function openInactiveDropdown(node, e) {
    const tagData = parseTags(node.properties?._tagDataJSON || "[]");
    const inactive = tagData.filter(t => !t.active && t.name);
    const dropdownOptions = inactive.map(tag => ({
        content: tag.name,
        callback: () => {
            const entry = tagData.find(t => t.name === tag.name);
            if (entry) entry.active = true;
            node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
            node.onUpdateTextWidget?.(node);
        }
    }));
    if (dropdownOptions.length > 0 && window.LiteGraph?.ContextMenu) {
        new window.LiteGraph.ContextMenu(dropdownOptions, { event: e, className: "dark" }, window);
    }
}

function renderButtons(node, container, mode) {
    container.appendChild(makeButton(node, "button_menu", "≡", "Menu"));
    if (mode !== "multiline") {
        container.appendChild(makeButton(node, "button_add_tag", "+", "Add tag"));
    }
    if (mode === "randomizer") {
        container.appendChild(makeButton(node, "button_randomize", "🎲︎", "Randomize"));
    }
}

function renderCloudPill(node, tag, index, colors) {
    const pill = document.createElement("div");
    pill.className = "ere-pill" + (tag.active ? "" : " inactive");
    const fill = TYPE_FILL[tag.type] || DEFAULT_FILL;
    if (tag.active) {
        pill.style.background = fill;
        pill.style.borderColor = fill;
    } else {
        pill.style.background = colors.widgetBg;
        pill.style.borderColor = "#444";
        pill.style.color = colors.widgetText;
    }
    let name = displayNameFor(tag, false);
    if (tag.type === 'lora' && tag.triggers?.length > 0) name += ` [+${tag.triggers.length}]`;
    pill.textContent = name;
    const st = strengthText(tag);
    if (st) {
        const span = document.createElement("span");
        span.className = "ere-strength";
        span.textContent = st;
        pill.appendChild(span);
    }
    attachPillEvents(node, pill, tag, index);
    return pill;
}

function renderToggleRow(node, tag, index, colors) {
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

    attachPillEvents(node, row, tag, index);
    return row;
}

function renderGalleryTile(node, tag, index, colors, pillW, pillH) {
    const tile = document.createElement("div");
    tile.className = "ere-tile" + (tag.active ? "" : " inactive");
    tile.style.width = `${pillW}px`;
    tile.style.height = `${pillH}px`;

    if (tag.type === 'lora' || tag.type === 'group' || tag.type === 'embedding') {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.draggable = false;
        // Subfolder paths from the server use OS separators, so on Windows
        // names arrive as "sub\lora". The old canvas code sent them raw and the
        // browser normalized \ to / in the URL; once percent-encoded (%5C) that
        // normalization no longer happens and the server can't find the file.
        // Normalize to forward slashes first, then encode per path segment:
        // keeps subfolder slashes literal for the {path:.*} route while
        // encoding ?, #, +, & etc. inside filenames.
        const encodedName = tag.name.replace(/\\/g, "/").split('/').map(encodeURIComponent).join('/');
        img.src = `/erenodes/view/${tag.type}/${encodedName}?w=${pillW}&h=${pillH}&fit=cover`;
        img.addEventListener("error", () => { img.style.display = "none"; });
        tile.appendChild(img);
    }

    const nameBar = document.createElement("div");
    nameBar.className = "ere-name";
    const fill = TYPE_FILL[tag.type] || DEFAULT_FILL;
    if (tag.active) {
        nameBar.style.background = fill;
    } else {
        nameBar.style.background = colors.widgetBg;
        nameBar.style.color = colors.widgetText;
    }
    nameBar.textContent = displayNameFor(tag, true);
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

    attachPillEvents(node, tile, tag, index);
    return tile;
}

/**
 * Attach the DOM tag UI to a node. Call after initializeSharedPromptFunctions.
 *
 * @param {LGraphNode} node
 * @param {"cloud"|"toggle"|"multiselect"|"randomizer"|"gallery"|"multiline"} mode
 */
export function attachTagDomWidget(node, mode) {
    if (node._ereDom) return node._ereDom.widget;

    injectStyles();
    const colors = fallbackColors();

    for (const w of nativeWidgetsToHide(node, mode)) hideNativeWidget(w);

    // `let`: hosts can be swapped for a previously mounted element after undo/redo.
    // toolbar = sticky buttons; scroll/content = pills (only this scrolls).
    let el = document.createElement("div");
    el.className = "erenodes-dom";
    let toolbar = document.createElement("div");
    toolbar.className = "ere-toolbar ere-flow";
    let scroll = document.createElement("div");
    scroll.className = "ere-scroll";
    let content = document.createElement("div");
    content.className = "erenodes-dom-content";
    scroll.appendChild(content);
    el.appendChild(toolbar);
    el.appendChild(scroll);
    bindRootListeners(el);

    let lastRenderedState = null;
    const render = () => {
        lastRenderedState = node.properties?._tagDataJSON || "[]";
        toolbar.textContent = "";
        content.textContent = "";
        renderButtons(node, toolbar, mode);
        const tagData = parseTags(node.properties?._tagDataJSON || "[]");

        if (mode === "multiline") {
            return;
        }

        if (mode === "toggle") {
            const list = document.createElement("div");
            list.style.display = "flex";
            list.style.flexDirection = "column";
            list.style.gap = "5px";
            for (let i = 0; i < tagData.length; i++) {
                list.appendChild(renderToggleRow(node, tagData[i], i, colors));
            }
            content.appendChild(list);
            return;
        }

        if (mode === "gallery") {
            const pillW = node.properties?._tagImageWidth ?? 100;
            const pillH = node.properties?._tagImageHeight ?? 100;
            const grid = document.createElement("div");
            grid.className = "ere-flow";
            for (let i = 0; i < tagData.length; i++) {
                grid.appendChild(renderGalleryTile(node, tagData[i], i, colors, pillW, pillH));
            }
            content.appendChild(grid);
            return;
        }

        if (mode === "multiselect" || mode === "randomizer") {
            const panel = document.createElement("div");
            panel.className = "ere-panel ere-flow";
            panel.addEventListener("click", (e) => {
                if (e.target === panel) openInactiveDropdown(node, e);
            });
            for (let i = 0; i < tagData.length; i++) {
                if (!tagData[i].active) continue;
                panel.appendChild(renderCloudPill(node, tagData[i], i, colors));
            }
            content.appendChild(panel);
            return;
        }

        // Default: cloud — all pills, inactive dimmed
        const flow = document.createElement("div");
        flow.className = "ere-flow";
        for (let i = 0; i < tagData.length; i++) {
            flow.appendChild(renderCloudPill(node, tagData[i], i, colors));
        }
        content.appendChild(flow);
    };

    if (typeof node.addDOMWidget !== "function") {
        console.warn("[EreNodes] addDOMWidget unavailable; DOM tag UI not attached.");
        return null;
    }
    const widget = node.addDOMWidget(`erenodes_${mode}`, "erenodes_tags", el, {
        serialize: false,
        hideOnZoom: false,
    });
    if (!widget) {
        console.warn("[EreNodes] addDOMWidget returned no widget; DOM tag UI not attached.");
        return null;
    }
    if (widget.options) widget.options.serialize = false;

    // Multiline: ≡ button only, under the native textarea. Not subject to
    // fit/scroll tag-area policy — the textarea owns vertical resize.
    //
    // Nodes 2.0 grid: rows are `auto` when shouldExpand(type) OR hasLayoutSize.
    // hasLayoutSize is `typeof widget.computeLayoutSize === 'function'` — and
    // DOMWidgetImpl always has that method, so both textarea + ≡ became `auto`
    // and split free height 50/50. Shadow computeLayoutSize with a non-function
    // so the ≡ row is `min-content`; keep computeSize for classic DomWidget.
    if (mode === "multiline") {
        el.classList.add("ere-multiline");
        scroll.style.display = "none";
        el.style.gap = "0";
        const margin = widget.margin ?? 10;
        // Slot height must include DomWidget margins or the 20px button clips.
        const barH = () => (toolbar.offsetHeight || 20) + margin * 2;
        if (widget.options) {
            widget.options.getMinHeight = () => barH();
            widget.options.getMaxHeight = () => barH();
            widget.options.getHeight = () => barH();
        }
        widget.computeSize = () => [node.size?.[0] ?? 200, barH()];
        // Own-property undefined shadows the prototype method (do not delete —
        // delete would fall through to DOMWidgetImpl.computeLayoutSize again).
        widget.computeLayoutSize = undefined;

        const origUpdate = node.onUpdateTextWidget;
        node.onUpdateTextWidget = async function (...args) {
            const r = origUpdate?.apply(this, args);
            if (r instanceof Promise) await r;
            render();
            return r;
        };
        const origRemoved = node.onRemoved;
        node.onRemoved = function (...args) {
            node._ereDom = null;
            return origRemoved?.apply(this, args);
        };

        hookGraphChanged();
        node._ereDom = {
            widget, el, toolbar, scroll, content, render,
            renderIfChanged: () => {},
        };
        render();
        return widget;
    }

    // Height policy (mirrors the old canvas onDrawForeground + onResize clamp):
    // - Fit (default): height locked to content; only width is free.
    // - Scroll: user may shrink/grow; pills scroll under a sticky toolbar.
    // Measure toolbar+content (not the stretched host) so setSize doesn't feed
    // back into the measurement. Remeasure only when content height actually
    // changes (real pill reflow) — width-only noise kept the old fitHeight.
    const PILL_ROW_H = 20;
    const scrollEnabled = () =>
        app.ui?.settings?.getSettingValue?.("EreNodes.Nodes.TagAreaScroll", false) ?? false;

    // One visible row of tags/thumbs — scroll mode must not shrink below this.
    const oneRowHeight = () => {
        if (mode === "multiline") return 0;
        if (mode === "gallery") return node.properties?._tagImageHeight ?? 100;
        return PILL_ROW_H;
    };

    const scrollMinHeight = () => {
        const margin = widget.margin ?? 10;
        const toolH = toolbar.offsetHeight || PILL_ROW_H;
        const rowH = oneRowHeight();
        // Floor is toolbar + one row only. Including the flex gap (and host
        // padding) left enough room for the next row to peek at the bottom.
        return toolH + rowH + margin * 2;
    };

    const naturalHeight = () => {
        const margin = widget.margin ?? 10;
        const toolH = toolbar.offsetHeight || 0;
        const bodyH = content.offsetHeight || 0;
        // Match the 5px flex gap between toolbar and scroll body when both exist.
        const gap = toolH && bodyH ? 5 : 0;
        return Math.max(toolH + bodyH + gap, 20) + margin * 2;
    };

    const heightBelow = () => {
        const widgets = node.widgets ?? [];
        const index = widgets.indexOf(widget);
        if (index === -1) return 0;
        let total = 0;
        for (const w of widgets.slice(index + 1)) {
            if (w.hidden || w._ereHidden) continue;
            total += w.computedHeight ?? ((window.LiteGraph?.NODE_WIDGET_HEIGHT ?? 20) + 4);
        }
        return total;
    };

    const availableHeight = () => {
        const margin = widget.margin ?? 10;
        return node.size[1] - (widget.y ?? 30) - heightBelow() - margin * 2 - 4;
    };

    let fitHeight = 0;
    let lastContentH = 0;
    let applyingAutoHeight = false;
    let fitUntil = 0;

    const remeasureFitHeight = () => {
        if (!toolbar.offsetHeight && !content.offsetHeight) return fitHeight;
        fitHeight = Math.round((widget.y ?? 30) + naturalHeight() + heightBelow() + 4);
        lastContentH = content.offsetHeight;
        return fitHeight;
    };

    if (widget.options) {
        widget.options.getMinHeight = () => {
            if (scrollEnabled()) return scrollMinHeight();
            // Stable floor from last measure so layout doesn't thrash mid-resize.
            if (fitHeight > 0) {
                return Math.max(scrollMinHeight(), fitHeight - (widget.y ?? 30) - heightBelow() - 4);
            }
            return naturalHeight();
        };
        widget.options.getMaxHeight = () => {
            if (scrollEnabled()) return undefined;
            if (fitHeight > 0) {
                return Math.max(scrollMinHeight(), fitHeight - (widget.y ?? 30) - heightBelow() - 4);
            }
            return naturalHeight();
        };
    }
    widget.computeSize = undefined;

    const setScrollOverflow = (value) => {
        if (scroll.style.overflowY !== value) scroll.style.overflowY = value;
    };

    const clampToFitHeight = () => {
        if (!(fitHeight > 0) || Math.abs(node.size[1] - fitHeight) <= 0.5) return;
        applyingAutoHeight = true;
        try {
            node.setSize([node.size[0], fitHeight]);
        } finally {
            applyingAutoHeight = false;
        }
    };

    const applyHeightPolicy = () => {
        if (!el.isConnected || !node.graph) return;
        if (node.flags?.collapsed) return;
        if (!toolbar.offsetHeight && !content.offsetHeight) return;

        const scrolls = scrollEnabled();
        setScrollOverflow(scrolls ? "auto" : "hidden");

        // Nodes 2.0: don't fight Vue's ResizeObserver with setSize — cap the
        // scroll body with max-height so the toolbar stays visible.
        if (window.LiteGraph?.vueNodesMode) {
            const available = availableHeight();
            const toolH = toolbar.offsetHeight || 0;
            const bodyH = content.offsetHeight || 0;
            const bodyNatural = toolH + bodyH + (toolH && bodyH ? 5 : 0);
            const fitting = performance.now() < fitUntil;
            const minScroll = oneRowHeight() || PILL_ROW_H;
            const scrollBudget = Math.max(minScroll, available - toolH - (toolH && bodyH ? 5 : 0));
            const shrunk = scrolls && !fitting && available > scrollMinHeight() && available < bodyNatural - 2;
            const maxH = shrunk ? `${Math.round(scrollBudget)}px` : "";
            if (scroll.style.maxHeight !== maxH) scroll.style.maxHeight = maxH;
            node._tagAreaCapped = shrunk;
            return;
        }

        if (scroll.style.maxHeight) scroll.style.maxHeight = "";
        node._tagAreaCapped = scrolls && !!node.properties?._tagAreaManualHeight;

        if (scrolls && node.properties?._tagAreaManualHeight) return;

        remeasureFitHeight();
        if (!(fitHeight > 0) || Math.abs(node.size[1] - fitHeight) <= 1) return;

        applyingAutoHeight = true;
        try {
            node.setSize([node.size[0], fitHeight]);
        } finally {
            applyingAutoHeight = false;
        }
        node.graph?.setDirtyCanvas(true, true);
    };

    let syncScheduled = false;
    const syncSize = () => {
        if (syncScheduled) return;
        syncScheduled = true;
        requestAnimationFrame(() => {
            syncScheduled = false;
            applyHeightPolicy();
        });
    };

    node.onTagAreaPolicyChanged = () => {
        if (node.properties && !scrollEnabled()) delete node.properties._tagAreaManualHeight;
        applyHeightPolicy();
    };

    node.onFitTagArea = () => {
        if (node.properties) delete node.properties._tagAreaManualHeight;
        fitUntil = performance.now() + 300;
        scroll.style.maxHeight = "";
        node._tagAreaCapped = false;
        applyHeightPolicy();
    };

    // Fit mode: lock height immediately on every resize (old canvas onResize).
    // Scroll mode: first user drag takes ownership of height.
    const origResize = node.onResize;
    node.onResize = function (...args) {
        const draggedByUser = app.canvas?.resizing_node === node;
        if (!scrollEnabled() && !applyingAutoHeight && !window.LiteGraph?.vueNodesMode) {
            clampToFitHeight();
        } else if (draggedByUser && !applyingAutoHeight && scrollEnabled() && !window.LiteGraph?.vueNodesMode) {
            node.properties = node.properties || {};
            node.properties._tagAreaManualHeight = true;
        }
        if (window.LiteGraph?.vueNodesMode && !applyingAutoHeight) {
            applyHeightPolicy();
        }
        return origResize?.apply(this, args);
    };

    // Remeasure only when pill content height actually changes (row reflow).
    // Width-only ResizeObserver noise must not rewrite fitHeight — that was the flicker.
    const observer = new ResizeObserver(() => {
        const h = content.offsetHeight;
        if (!scrollEnabled() && Math.abs(h - lastContentH) < 2) {
            clampToFitHeight();
            return;
        }
        syncSize();
    });
    observer.observe(content);
    observer.observe(toolbar);

    const origUpdate = node.onUpdateTextWidget;
    node.onUpdateTextWidget = async function (...args) {
        const r = origUpdate?.apply(this, args);
        if (r instanceof Promise) await r;
        render();
        syncSize();
        return r;
    };
    const origRemoveTags = node.onRemoveTags;
    node.onRemoveTags = function (...args) {
        const r = origRemoveTags?.apply(this, args);
        render();
        syncSize();
        return r;
    };
    const origPropChanged = node.onPropertyChanged;
    node.onPropertyChanged = function (name, value) {
        origPropChanged?.apply(this, arguments);
        if (name === "_tagImageWidth" || name === "_tagImageHeight") {
            render();
            syncSize();
        }
    };
    // Undo/redo in Nodes 2.0 recreates the node objects but Vue keeps the
    // PREVIOUS node's element mounted (component keyed by node id), so a fresh
    // element would render into the void while the stale one stays on screen.
    // The node id is only final once the node is added to the graph, so adopt
    // the element that is actually mounted for this id there, and render into
    // that. In the legacy renderer old elements are unmounted on node removal,
    // so adoption simply never triggers.
    const origAdded = node.onAdded;
    node.onAdded = function (...args) {
        const r = origAdded?.apply(this, args);

        if (!el.isConnected) {
            const mounted = [...document.querySelectorAll(`.erenodes-dom[data-ere-node="${node.id}"]`)]
                .find(cand => cand !== el && cand.isConnected);
            if (mounted) {
                el = mounted;
                toolbar = el.querySelector(".ere-toolbar") || toolbar;
                scroll = el.querySelector(".ere-scroll") || scroll;
                content = el.querySelector(".erenodes-dom-content") || content;
                if (node._ereDom) {
                    node._ereDom.el = el;
                    node._ereDom.toolbar = toolbar;
                    node._ereDom.scroll = scroll;
                    node._ereDom.content = content;
                }
                // Keep the widget pointing at the live element in case Vue
                // (re)mounts it later — same element either way.
                widget.element = el;
                observer.disconnect();
                observer.observe(content);
                observer.observe(toolbar);
                render();
                syncSize();
            }
        }
        el.dataset.ereNode = String(node.id);
        return r;
    };

    const origRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        observer.disconnect();
        node._ereDom = null;
        return origRemoved?.apply(this, args);
    };

    const renderIfChanged = () => {
        const state = node.properties?._tagDataJSON || "[]";
        if (state === lastRenderedState) return;
        render();
        syncSize();
    };

    hookGraphChanged();
    node._ereDom = { widget, el, toolbar, scroll, content, render, renderIfChanged };
    render();
    syncSize();
    return widget;
}
