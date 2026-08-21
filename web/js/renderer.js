import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { attachPillDrag, markDropZone, injectDragStyles, installDragGlobals, pruneSelection,handlePillSelectClick,handlePillContextMenu,consumeDragClick } from "./dragdrop.js";
import { SURFACE_CLASS, injectTagStyles, fallbackColors, renderTagPill, renderToggleRowEl, renderTagTile } from "./tagview.js";
import { parseTags } from "./parser.js";
import { isKnownMissing, ensureChecked } from "./util.js";

// Re-render tag UIs after undo/redo: the change tracker restores graph state and fires "graphChanged", but Vue keeps the existing DOM widget instances.
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

export const MODE_BY_TYPE = {
    ErePromptExtractor: "extract",
    ErePromptCloud: "cloud",
    ErePromptToggle: "toggle",
    ErePromptMultiSelect: "multiselect",
    ErePromptRandomizer: "randomizer",
    ErePromptGallery: "gallery",
    ErePromptMultiline: "multiline",
};

/** Hide transport widgets from both renderers. */
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
    if (w.element?.style) {
        w.element.style.display = "none";
        // Belt and braces: if a renderer ever re-shows it (Vue manages the element itself), it must still never be a pointer target — a ctrl+drag landing on a stray textarea arms ComfyUI's box-select.
        w.element.style.pointerEvents = "none";
    }
}

function nativeWidgetsToHide(node, mode) {
    const list = [];
    const sep = node.widgets?.find(w => w.name === "separator");
    if (sep) list.push(sep);
    if (mode !== "multiline") {
        const text = node.widgets?.find(w => w.name === "text");
        if (text) list.push(text);
    }
    if (mode === "extract") {
        // Transport only: the filename is shown as the image preview itself.
        const image = node.widgets?.find(w => w.name === "image");
        if (image) list.push(image);
    }
    return list;
}

// Rendering lives in tagview.js; this module owns the node-specific parts — event wiring, layout modes and the height policy.

function injectStyles() {
    injectTagStyles();
    injectDragStyles();   // second, so its rules win ties
}

/**
 * Root listeners are node-agnostic, so an adopted element keeps the ones it had.
 * The guard stops them being bound twice.
 */
function bindRootListeners(el) {
    if (el._ereRootBound) return;
    el._ereRootBound = true;

    /**
     * Stop pill interactions from dragging/selecting the node — except the middle button, which pans the canvas.
     * Forward that to the canvas element in the legacy renderer (the overlay otherwise swallows it); litegraph takes pointer capture on
     */
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
    // Legacy renderer: DomWidgets overlay swallows wheel events.
    // When the pill area is scrollable, keep the wheel entirely (including at scroll edges) so it never leaks into canvas zoom.
    // Otherwise hand it to the canvas.
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

function attachPillEvents(node, el, tag, index, mode) {
    // Drag & drop / multi-selection.
    // Registers the pointerdown that may turn into a drag, tags the element with its data index and restores the selection outline after a re-render.
    attachPillDrag(node, el, index, mode);

    el.addEventListener("click", (e) => {
        e.stopPropagation();
        // A click that closes a drag must not toggle the tag.
        if (consumeDragClick()) return;
        // Ctrl/Shift click manage the selection instead of toggling; a plain click on a selected pill toggles the whole selection.
        if (handlePillSelectClick(node, index, e)) return;
        node.onTagPillClick?.(e, [0, 0], { label: tag.name, index });
    });
    el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Anchor the quick edit menu to the pill's bottom-left, not the raw cursor position.
        const rect = el.getBoundingClientRect();
        const positionEvent = { clientX: rect.left, clientY: rect.bottom + 5 };
        // A multi-selection gets bulk actions instead of single-tag editing.
        if (handlePillContextMenu(node, index, e, positionEvent)) return;
        node.onTagQuickEdit?.(positionEvent, node, { label: tag.name, index });
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

/**
 * The Prompt Extractor's image pane: a drop zone that becomes a preview.
 * The node owns the behaviour; this only draws it.
 */
function renderExtractImage(node) {
    const pane = document.createElement("div");
    pane.className = "ere-extract-pane";

    const filename = node.properties?._extractImage || "";
    if (filename) {
        const img = document.createElement("img");
        img.loading = "lazy";
        img.draggable = false;
        img.alt = filename;
        // ComfyUI's own input-image route, so it survives a workflow reload.
        img.src = `/view?filename=${encodeURIComponent(filename)}&type=input&subfolder=`;
        img.addEventListener("error", () => { img.style.display = "none"; });
        pane.appendChild(img);
    } else {
        pane.classList.add("empty");
        const empty = document.createElement("div");
        empty.className = "ere-extract-empty";
        empty.textContent = "Drop an image to recover its prompt.";
        pane.appendChild(empty);
    }

    if (node._extractBusy) {
        const busy = document.createElement("div");
        busy.className = "ere-extract-busy";
        busy.textContent = "Reading…";
        pane.appendChild(busy);
    }

    pane.addEventListener("click", (e) => {
        e.stopPropagation();
        node.onExtractPick?.();
    });
    // Native HTML5 drop, not the pill drag layer: the payload is a file from the OS or another browser tab.
    pane.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pane.classList.add("ere-extract-over");
    });
    pane.addEventListener("dragleave", () => pane.classList.remove("ere-extract-over"));
    pane.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pane.classList.remove("ere-extract-over");
        node.onExtractDrop?.(e);
    });
    return pane;
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

/**
 * Outline a pill whose file is gone — ComfyUI's red node border, at pill scale.
 * Marking only: the pill is still what the workflow says.
 */
function markIfMissing(el, tag) {
    if (!isKnownMissing(tag)) return el;
    el.classList.add("ere-missing");
    const what = tag.type === "group" ? "Tag group" : tag.type === "lora" ? "LoRA" : "Embedding";
    el.title = `${el.title || tag.name}\n${what} file not found`;
    return el;
}

function renderCloudPill(node, tag, index, colors, mode) {
    const pill = renderTagPill(tag, { colors });
    attachPillEvents(node, pill, tag, index, mode);
    return markIfMissing(pill, tag);
}

function renderToggleRow(node, tag, index, colors) {
    const row = renderToggleRowEl(tag, { colors });
    attachPillEvents(node, row, tag, index, "toggle");
    return markIfMissing(row, tag);
}

function renderGalleryTile(node, tag, index, colors, pillW, pillH) {
    const tile = renderTagTile(tag, { colors, width: pillW, height: pillH });
    attachPillEvents(node, tile, tag, index, "gallery");
    return markIfMissing(tile, tag);
}

/** Attach the DOM tag UI to a node. Call after initializeSharedPromptFunctions. */
export function attachTagDomWidget(node, mode) {
    if (node._ereDom) return node._ereDom.widget;

    injectStyles();
    const colors = fallbackColors();

    for (const w of nativeWidgetsToHide(node, mode)) hideNativeWidget(w);

    // `let`: hosts can be swapped for an already-mounted element after undo/redo. toolbar = sticky buttons; scroll/content = pills (only this scrolls).
    let el = document.createElement("div");
    // Two classes on purpose: `erenodes-dom` is the structural hook drag & drop and the Vue-remount adoption query on; `ere-surface` is the visual scope shared with the sidebar and the menu previews (see tagview.js).
    el.className = `erenodes-dom ${SURFACE_CLASS}`;
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
    // Cross-node drops resolve the node from the element under the pointer.
    el._ereNode = node;
    el._ereMode = mode;
    installDragGlobals();

    let lastRenderedState = null;
    /** Defined further down (after the height policy); only ever called from inside render() or the observer, so it is always initialised by then. */
    let applyExtractLayout = () => {};

    const render = () => {
        lastRenderedState = node.properties?._tagDataJSON || "[]";
        const rendered = parseTags(lastRenderedState);
        // Fire-and-forget: a late verdict triggers exactly one re-render, which reads from cache and schedules nothing.
        // Guarded on the tag data being unchanged, so an edit made in flight is not undone.
        ensureChecked(rendered).then((learned) => {
            if (learned && node._ereDom && node.properties?._tagDataJSON === lastRenderedState) {
                render();
            }
        });
        toolbar.textContent = "";
        content.textContent = "";
        // Extract mode renders its buttons inside the tag column instead, so they sit beside the image rather than spanning above both panes.
        if (mode === "extract") toolbar.style.display = "none";
        else renderButtons(node, toolbar, mode);
        const tagData = parseTags(node.properties?._tagDataJSON || "[]");
        // Selection is index-based; forget entries whose tag moved or vanished.
        pruneSelection(node, tagData);

        if (mode === "multiline") {
            return;
        }

        if (mode === "toggle") {
            const list = document.createElement("div");
            list.style.display = "flex";
            list.style.flexDirection = "column";
            list.style.gap = "5px";
            markDropZone(list, "column");
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
            markDropZone(grid, "flow");
            for (let i = 0; i < tagData.length; i++) {
                grid.appendChild(renderGalleryTile(node, tagData[i], i, colors, pillW, pillH));
            }
            content.appendChild(grid);
            return;
        }

        if (mode === "extract") {
            // Two panes: the image the prompt came from, and the pills it produced.
            const split = document.createElement("div");
            split.className = "ere-split";

            split.appendChild(renderExtractImage(node));

            // Buttons live with the tags, not above the whole node.
            const column = document.createElement("div");
            column.className = "ere-split-col";
            const bar = document.createElement("div");
            bar.className = "ere-toolbar ere-flow";
            renderButtons(node, bar, mode);
            column.appendChild(bar);

            const flow = document.createElement("div");
            flow.className = "ere-flow ere-split-tags";
            markDropZone(flow, "flow");
            for (let i = 0; i < tagData.length; i++) {
                flow.appendChild(renderCloudPill(node, tagData[i], i, colors, "extract"));
            }
            column.appendChild(flow);
            split.appendChild(column);

            content.appendChild(split);
            applyExtractLayout();
            return;
        }

        if (mode === "multiselect" || mode === "randomizer") {
            const panel = document.createElement("div");
            panel.className = "ere-panel ere-flow";
            panel.addEventListener("click", (e) => {
                // Not after a ctrl-drag selection, and not on a ctrl+click (that one belongs to the pill selection logic).
                if (e.ctrlKey || e.metaKey || consumeDragClick()) return;
                if (e.target === panel) openInactiveDropdown(node, e);
            });
            markDropZone(panel, "flow");
            for (let i = 0; i < tagData.length; i++) {
                if (!tagData[i].active) continue;
                panel.appendChild(renderCloudPill(node, tagData[i], i, colors, mode));
            }
            content.appendChild(panel);
            return;
        }

        // Default: cloud — all pills, inactive dimmed
        const flow = document.createElement("div");
        flow.className = "ere-flow";
        markDropZone(flow, "flow");
        for (let i = 0; i < tagData.length; i++) {
            flow.appendChild(renderCloudPill(node, tagData[i], i, colors, "cloud"));
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

    /**
     * Multiline: ≡ button only; the textarea owns vertical resize.
     * Shadowing computeLayoutSize with a non-function makes the ≡ row min-content — the Nodes 2.0 grid would otherwise split the height 50/50.
     */
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
        // Own-property undefined shadows the prototype method (do not delete — delete would fall through to DOMWidgetImpl.computeLayoutSize again).
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

    // Height policy: Fit (default) locks height to content and leaves width free; Scroll lets the user size it and scrolls the pills under a sticky toolbar.
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
        // Floor is toolbar + one row only.
        // Including the flex gap (and host padding) left enough room for the next row to peek at the bottom.
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

        /** Nodes 2.0: don't fight Vue's ResizeObserver with setSize — cap the scroll body with max-height so the toolbar stays visible. */
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

    // Remeasure only when content height changes — width-only observer noise rewriting fitHeight was the flicker.
    const EXTRACT_WIDE_ON = 340;
    const EXTRACT_WIDE_OFF = 320;
    applyExtractLayout = () => {
        if (mode !== "extract") return;
        const split = content.querySelector(".ere-split");
        if (!split) return;
        const width = content.offsetWidth || 0;
        if (!width) return;
        const wide = split.classList.contains("wide")
            ? width >= EXTRACT_WIDE_OFF
            : width >= EXTRACT_WIDE_ON;
        if (wide !== split.classList.contains("wide")) split.classList.toggle("wide", wide);
    };
    node.onExtractLayout = applyExtractLayout;

    const observer = new ResizeObserver(() => {
        applyExtractLayout();
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
    // Undo/redo in Nodes 2.0 recreates the node objects but Vue keeps the PREVIOUS node's element mounted (component keyed by node id), so a fresh element would render into the void while the stale one stays on screen.
    const origAdded = node.onAdded;
    node.onAdded = function (...args) {
        const r = origAdded?.apply(this, args);

        if (!el.isConnected) {
            const mounted = [...document.querySelectorAll(`.erenodes-dom[data-ere-node="${node.id}"]`)]
                .find(cand => cand !== el && cand.isConnected);
            if (mounted) {
                el = mounted;
                el._ereNode = node;
                el._ereMode = mode;
                toolbar = el.querySelector(".ere-toolbar") || toolbar;
                scroll = el.querySelector(".ere-scroll") || scroll;
                content = el.querySelector(".erenodes-dom-content") || content;
                if (node._ereDom) {
                    node._ereDom.el = el;
                    node._ereDom.toolbar = toolbar;
                    node._ereDom.scroll = scroll;
                    node._ereDom.content = content;
                }
                // Keep the widget pointing at the live element in case Vue (re)mounts it later — same element either way.
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
