import { app } from "../../../../scripts/app.js";

// DOM rendering of the tag pill area.
//
// The canvas path (onDrawForeground + node.onMouseDown + the processContextMenu patch)
// only exists in the legacy renderer: with Vue nodes enabled LGraphCanvas.drawNode()
// returns before any node body drawing and pointer events go to Vue components instead.
// A DOM widget renders in both - the legacy renderer mounts it in the DomWidgets overlay
// positioned from the litegraph layout, Vue nodes mount the same element inside the node
// through WidgetDOM.vue - so this module is the single implementation for both modes.
//
// Variants:
//   toggle  - full width rows with a switch (Toggle)
//   chips   - inline wrapped chips (Cloud, MultiSelect, Randomizer)
//   gallery - image cards with a name bar (Gallery)
//   buttons - button row only, no tags (Multiline)

const STYLE_ID = "erenodes-pill-widget-styles";

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        /* The renderers stretch the mounted element (h-full / flex-1), so the content
           lives in an inner box whose height can be measured without feedback. */
        .erenodes-pills-root {
            display: block;
            box-sizing: border-box;
            width: 100%;
            min-height: 0;
            /* Shrinking the node past its tags scrolls them instead of clipping */
            overflow-x: hidden;
            overflow-y: auto;
            scrollbar-width: thin;
        }
        .erenodes-pills {
            display: flex;
            flex-wrap: wrap;
            align-content: flex-start;
            gap: 5px;
            box-sizing: border-box;
            width: 100%;
            height: fit-content;
            font: 12px monospace;
            color: var(--ere-text, #ddd);
        }
        .erenodes-pills[data-framed="true"] {
            padding: 5px;
            border: 1px solid #444;
            border-radius: 5px;
            background: var(--ere-widget-bg, #222);
        }
        /* Themed like the frontend's own node widgets: the litegraph constants are a
           flat grey box with near-white text, which stands out against the node. The
           --component-node-* variables are declared on :root / .dark-theme, so they
           reach the widget in both renderers; litegraph values stay as the fallback. */
        .erenodes-pill-button {
            flex: 0 0 auto;
            width: 20px;
            height: 20px;
            padding: 0;
            border: 1px solid var(--component-node-border, #444);
            border-radius: 5px;
            background: var(--component-node-widget-background, var(--ere-box, #353535));
            color: var(--component-node-foreground-secondary, var(--ere-text, #aaa));
            font: inherit;
            line-height: 18px;
            text-align: center;
            cursor: pointer;
        }
        .erenodes-pill-button:hover {
            background: var(--component-node-widget-background-hovered, var(--ere-widget-bg, #2a2a2a));
            color: var(--component-node-foreground, var(--ere-text, #ddd));
        }
        /* Cards are much taller than buttons, so they get a row of their own. */
        .erenodes-pills-buttons {
            flex: 1 0 100%;
            display: flex;
            flex-wrap: wrap;
            gap: 5px;
        }
        .erenodes-pill {
            display: flex;
            align-items: center;
            box-sizing: border-box;
            height: 20px;
            border-radius: 5px;
            cursor: pointer;
            user-select: none;
        }
        .erenodes-pill:hover { filter: brightness(1.2); }
        .erenodes-pill-name {
            flex: 1 1 auto;
            min-width: 0;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .erenodes-pill-strength {
            flex: 0 0 auto;
            margin-left: 4px;
            opacity: 0.5;
        }

        /* toggle variant */
        .erenodes-pills[data-variant="toggle"] .erenodes-pill {
            flex: 1 0 100%;
            gap: 7px;
            padding: 0 7px 0 5px;
            border: 1px solid #444;
            background: var(--ere-widget-bg, #222);
        }
        .erenodes-pills[data-variant="toggle"] .erenodes-pill[data-active="false"] { opacity: 0.75; }
        .erenodes-pill-switch {
            flex: 0 0 auto;
            position: relative;
            width: 18px;
            height: 14px;
            border-radius: 5px;
            background: #3b3b3b;
        }
        .erenodes-pill-knob {
            position: absolute;
            top: 50%;
            left: -3px;
            width: 14px;
            height: 14px;
            margin-top: -7px;
            border-radius: 50%;
            background: #888;
            transition: left 0.1s ease;
        }
        .erenodes-pill[data-active="true"] .erenodes-pill-knob {
            left: 7px;
            background: var(--ere-accent, #8899bb);
        }

        /* chips variant */
        .erenodes-pills[data-variant="chips"] .erenodes-pill {
            max-width: 100%;
            padding: 0 5px;
            border: 1px solid var(--ere-accent, #414650);
            background: var(--ere-accent, #414650);
            color: #fff;
        }
        .erenodes-pills[data-variant="chips"] .erenodes-pill[data-active="false"] {
            border-color: #444;
            background: var(--ere-widget-bg, #222);
            color: var(--ere-text, #ddd);
            opacity: 0.75;
        }

        /* gallery variant */
        .erenodes-pills[data-variant="gallery"] .erenodes-pill {
            position: relative;
            display: block;
            height: auto;
            padding: 0;
            overflow: hidden;
            border: 1px solid #444;
            background: #222;
        }
        .erenodes-card-image {
            display: block;
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .erenodes-pill[data-active="false"] .erenodes-card-image {
            filter: grayscale(0.75);
            opacity: 0.25;
        }
        .erenodes-card-name {
            position: absolute;
            right: 0;
            bottom: 0;
            left: 0;
            height: 20px;
            padding: 0 5px;
            box-sizing: border-box;
            line-height: 20px;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
            background: var(--ere-accent, #414650);
            color: #fff;
        }
        .erenodes-pill[data-active="false"] .erenodes-card-name {
            background: var(--ere-widget-bg, #222);
            color: var(--ere-text, #ddd);
            opacity: 0.5;
        }
        .erenodes-card-info {
            position: absolute;
            top: 2.5px;
            right: 2.5px;
            padding: 0 2.5px;
            border-radius: 5px;
            background: #222;
            color: #fff;
            font-size: 10px;
            line-height: 15px;
            opacity: 0.75;
        }
        .erenodes-pill[data-active="false"] .erenodes-card-info { opacity: 0.5; }
    `;
    document.head.appendChild(style);
}

// Pill accent per tag type, matching the canvas renderer.
const CHIP_COLORS = {
    lora: "#415041",
    embedding: "#504149",
    group: "#504C41"
};
const CHIP_DEFAULT = "#414650";

const KNOB_COLORS = {
    lora: "#89a189",
    embedding: "#9b8899",
    group: "#9b9188"
};
const KNOB_DEFAULT = "#8899bb";

const IMAGE_TYPES = ["lora", "embedding", "group"];

// One pill row - the smallest the tag area may be squeezed to before it just scrolls.
const MIN_AREA_HEIGHT = 20;

const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

// Same display rules the canvas renderer used: strip the extension from file-backed
// tags, drop the embedding: prefix, and append the trigger count for loras.
function getDisplayName(tag, { withTriggers = true } = {}) {
    let displayName = tag.name ?? "";

    if (tag.type === "lora") {
        const dotIndex = displayName.lastIndexOf(".");
        if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
        if (withTriggers && tag.triggers?.length > 0) displayName += ` [+${tag.triggers.length}]`;
    } else if (tag.type === "embedding") {
        displayName = displayName.replace(/^embedding:/, "");
    } else if (tag.type === "group") {
        const dotIndex = displayName.lastIndexOf(".");
        if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
    }

    return displayName;
}

/**
 * Dropdown of the node's inactive tags, opened by clicking the empty area of the
 * pill container (MultiSelect / Randomizer).
 */
export function openInactiveTagsMenu(node, event) {
    const tagData = parseTags(node.properties?._tagDataJSON || "[]");
    const options = tagData
        .filter(tag => !tag.active && tag.name)
        .map(tag => ({
            content: tag.name,
            callback: () => {
                const entry = tagData.find(t => t.name === tag.name);
                if (entry) entry.active = true;
                node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
                node.onUpdateTextWidget(node);
            }
        }));

    if (options.length > 0) {
        new LiteGraph.ContextMenu(options, { event, className: "dark" }, window);
    }
}

/**
 * Renders the node's tag pills as a DOM widget and wires clicks to the shared
 * node.onTagPillClick / node.onTagQuickEdit handlers.
 *
 * @param {object} node    the litegraph node
 * @param {object} config
 *   variant            "toggle" | "chips" | "gallery" | "buttons"
 *   buttons            [{ label, display, title }]
 *   showInactive       render inactive tags too (default true)
 *   framed             draw a container box around the area (default false)
 *   autoHeight         grow the node to fit the content, legacy renderer (default true)
 *   onBackgroundClick  handler for clicks on the empty area
 *   getCardSize        () => [w, h], gallery variant only
 * @returns the created DOM widget
 */
export function attachTagPillWidget(node, config = {}) {
    injectStyles();

    const {
        variant = "chips",
        buttons = [],
        showInactive = true,
        framed = false,
        autoHeight = true,
        onBackgroundClick,
        getCardSize
    } = config;

    const root = document.createElement("div");
    root.className = "erenodes-pills-root";

    const content = document.createElement("div");
    content.className = "erenodes-pills";
    content.dataset.variant = variant;
    if (framed) content.dataset.framed = "true";
    root.appendChild(content);

    // Pointer events on the pills are ours - don't let them reach the canvas
    // (node dragging in the legacy renderer, node selection in Vue nodes).
    for (const type of ["pointerdown", "pointermove", "pointerup"]) {
        root.addEventListener(type, e => e.stopPropagation());
    }

    if (onBackgroundClick) {
        content.addEventListener("click", e => {
            if (e.target !== content) return;
            e.preventDefault();
            onBackgroundClick(e);
        });
    }

    const widget = node.addDOMWidget("erenodes_pills", "erenodes_pills", root, {
        hideOnZoom: false,
        serialize: false,
        margin: 6,
        // The floor is what lets the node be dragged smaller than its tags: the layout
        // hands the widget whatever is left, and the area scrolls the rest.
        getMinHeight: () => Math.min(naturalHeight(), MIN_AREA_HEIGHT + widget.margin * 2),
        getMaxHeight: () => naturalHeight()
    });
    widget.serialize = false;

    // Height the widget box needs, margins included (the overlay insets the element
    // by `margin` on each side). Measured on the inner box - the outer one is stretched
    // to the allocated height, so measuring it would feed its own size back in.
    function naturalHeight() {
        return Math.max(content.offsetHeight, 20) + widget.margin * 2;
    }

    // Widgets placed after this one (e.g. the Randomizer's control) still need room.
    function heightBelow() {
        const widgets = node.widgets ?? [];
        const index = widgets.indexOf(widget);
        if (index === -1) return 0;

        let total = 0;
        for (const w of widgets.slice(index + 1)) {
            if (w.hidden) continue;
            total += w.computedHeight ?? (LiteGraph.NODE_WIDGET_HEIGHT + 4);
        }
        return total;
    }

    const scrollEnabled = () => app.ui?.settings?.getSettingValue?.("EreNodes.Nodes.TagAreaScroll", true) ?? true;

    // Height the node has left for the tag area, both renderers - arrange() keeps
    // widget.y and computedHeight up to date even when Vue draws the node.
    function availableHeight() {
        return node.size[1] - (widget.y ?? 30) - heightBelow() - widget.margin * 2 - 4;
    }

    // The legacy renderer sizes nodes from litegraph's layout, so the node has to be
    // grown to fit the pills. Vue nodes measure the DOM themselves - touching setSize
    // there fights their ResizeObserver, so there the area is capped with max-height
    // instead and the node stops growing on its own.
    let applyingAutoHeight = false;
    // Vue nodes shrink back to the DOM asynchronously, so a fit request suspends the cap
    // for a moment instead of re-applying it before the node has grown.
    let fitUntil = 0;

    function setStyle(prop, value) {
        if (root.style[prop] !== value) root.style[prop] = value;
    }

    function applyHeightPolicy() {
        if (!autoHeight) return;
        if (!root.isConnected || !node.graph) return;
        // Collapsed or not laid out yet - measuring now would resize the node to nothing.
        if (node.flags?.collapsed || !content.offsetHeight) return;

        const scrolls = scrollEnabled();
        // Only write when it actually changes: every style write resizes the element and
        // comes straight back through the ResizeObserver.
        setStyle("overflowY", scrolls ? "auto" : "hidden");

        if (LiteGraph.vueNodesMode) {
            const available = availableHeight();
            // Only cap once the node is actually smaller than its tags, otherwise a
            // freshly placed node would scroll instead of growing to fit. After a fit
            // request the cap is held off until the node has caught up with the content.
            const fitting = performance.now() < fitUntil;
            const shrunk = scrolls && !fitting && available > MIN_AREA_HEIGHT && available < content.offsetHeight - 2;

            setStyle("maxHeight", shrunk ? `${Math.round(available)}px` : "");
            node._tagAreaCapped = shrunk;
            return;
        }

        setStyle("maxHeight", "");
        node._tagAreaCapped = scrolls && !!node.properties?._tagAreaManualHeight;

        // The height is the user's now; the area scrolls instead of pushing the node.
        if (scrolls && node.properties?._tagAreaManualHeight) return;

        const target = Math.round((widget.y ?? 30) + naturalHeight() + heightBelow() + 4);

        if (Math.abs(node.size[1] - target) > 1) {
            applyingAutoHeight = true;
            try {
                node.setSize([node.size[0], target]);
            } finally {
                applyingAutoHeight = false;
            }
            node.setDirtyCanvas(true, true);
        }
    }

    // Kept as the name the rest of the module calls.


    node.onTagAreaPolicyChanged = () => applyHeightPolicy();

    // A manual resize hands the height over to the user for good - stored on the node so
    // it survives a reload. Gated on the canvas actually dragging this node's handle:
    // the layout grows nodes with setSize() too, and that must not count as manual.
    const origResize = node.onResize;
    node.onResize = function (...args) {
        const draggedByUser = app.canvas?.resizing_node === node;
        if (draggedByUser && !applyingAutoHeight && autoHeight && !LiteGraph.vueNodesMode) {
            node.properties = node.properties || {};
            node.properties._tagAreaManualHeight = true;
        }

        // Vue nodes: the cap is derived from the node's own height, so it has to follow
        // every resize.
        if (LiteGraph.vueNodesMode && !applyingAutoHeight) {
            applyHeightPolicy();
        }

        return origResize?.apply(this, args);
    };

    // Give the wheel back to the canvas when there is nothing to scroll, so zooming over
    // the node keeps working.
    root.addEventListener("wheel", e => {
        const scrollable = root.scrollHeight > root.clientHeight + 1;
        const atTop = root.scrollTop <= 0 && e.deltaY < 0;
        const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 1 && e.deltaY > 0;

        if (scrollable && !atTop && !atBottom) {
            e.stopPropagation();
            return;
        }

        e.preventDefault();
        app.canvas?.processMouseWheel?.(e);
    }, { passive: false });

    // Lets the node be snapped back to its content after a manual resize.
    node.onFitTagArea = () => {
        if (node.properties) delete node.properties._tagAreaManualHeight;
        fitUntil = performance.now() + 300;
        root.style.maxHeight = "";
        node._tagAreaCapped = false;
        applyHeightPolicy();
    };

    function pillTarget(label, button = false) {
        return { label, button };
    }

    function makeButton({ label, display, title }) {
        const el = document.createElement("button");
        el.type = "button";
        el.className = "erenodes-pill-button";
        el.textContent = display;
        if (title) el.title = title;

        // Not stopped on purpose: the click has to reach the widget root, where the
        // renderer's selectOn handler selects and raises the node.
        el.addEventListener("click", e => {
            e.preventDefault();
            node.onTagPillClick?.(e, [0, 0], pillTarget(label, true));
        });

        return el;
    }

    function bindPillEvents(el, tag) {
        el.addEventListener("click", e => {
            e.preventDefault();
            node.onTagPillClick?.(e, [0, 0], pillTarget(tag.name));
        });

        // Quick edit. TagEditContextMenu positions itself from clientX/clientY, so anchor
        // it to the pill the same way the canvas patch anchored it to the drawn pill.
        el.addEventListener("contextmenu", e => {
            e.preventDefault();
            e.stopPropagation();

            const rect = el.getBoundingClientRect();
            const positionEvent = { clientX: rect.left, clientY: rect.bottom + 5 };
            // The menu caps its width to the node's on-screen width; the widget spans it.
            const nodeScreenWidth = root.getBoundingClientRect().width;
            node.onTagQuickEdit?.(positionEvent, node, pillTarget(tag.name), nodeScreenWidth);
        });
    }

    function makeStrength(tag) {
        if (!tag.strength || Number(tag.strength) === 1.0) return null;
        const strength = document.createElement("span");
        strength.className = "erenodes-pill-strength";
        strength.textContent = Number(tag.strength).toFixed(2);
        return strength;
    }

    function makeBasePill(tag, accent) {
        const el = document.createElement("div");
        el.className = "erenodes-pill";
        el.dataset.active = String(!!tag.active);
        if (tag.type) el.dataset.type = tag.type;
        el.style.setProperty("--ere-accent", accent);
        bindPillEvents(el, tag);
        return el;
    }

    function makeTogglePill(tag) {
        const el = makeBasePill(tag, KNOB_COLORS[tag.type] ?? KNOB_DEFAULT);

        const track = document.createElement("span");
        track.className = "erenodes-pill-switch";
        const knob = document.createElement("span");
        knob.className = "erenodes-pill-knob";
        track.appendChild(knob);

        const name = document.createElement("span");
        name.className = "erenodes-pill-name";
        name.textContent = getDisplayName(tag);
        name.title = tag.name ?? "";

        el.append(track, name);

        const strength = makeStrength(tag);
        if (strength) el.appendChild(strength);

        return el;
    }

    function makeChipPill(tag) {
        const el = makeBasePill(tag, CHIP_COLORS[tag.type] ?? CHIP_DEFAULT);

        const name = document.createElement("span");
        name.className = "erenodes-pill-name";
        name.textContent = getDisplayName(tag);
        name.title = tag.name ?? "";
        el.appendChild(name);

        const strength = makeStrength(tag);
        if (strength) el.appendChild(strength);

        return el;
    }

    function makeGalleryPill(tag) {
        const [cardWidth, cardHeight] = getCardSize?.() ?? [100, 100];

        const el = makeBasePill(tag, CHIP_COLORS[tag.type] ?? CHIP_DEFAULT);
        el.style.width = `${cardWidth}px`;
        el.style.height = `${cardHeight}px`;

        if (IMAGE_TYPES.includes(tag.type)) {
            const image = document.createElement("img");
            image.className = "erenodes-card-image";
            image.loading = "lazy";
            image.draggable = false;
            image.src = `/erenodes/view/${tag.type}/${encodeURIComponent(tag.name)}?w=${cardWidth}&h=${cardHeight}&fit=cover`;
            // Tags without an image just keep the plain card background.
            image.addEventListener("error", () => image.remove());
            el.appendChild(image);
        }

        const info = [];
        if (tag.triggers?.length > 0) info.push(`[+${tag.triggers.length}]`);
        if (tag.strength && Number(tag.strength) !== 1.0) info.push(Number(tag.strength).toFixed(2));

        if (info.length) {
            const infoEl = document.createElement("span");
            infoEl.className = "erenodes-card-info";
            infoEl.textContent = info.join(" ");
            el.appendChild(infoEl);
        }

        const name = document.createElement("span");
        name.className = "erenodes-card-name";
        name.textContent = getDisplayName(tag, { withTriggers: false });
        name.title = tag.name ?? "";
        el.appendChild(name);

        return el;
    }

    const PILL_BUILDERS = {
        toggle: makeTogglePill,
        chips: makeChipPill,
        gallery: makeGalleryPill
    };

    function render() {
        content.style.setProperty("--ere-text", LiteGraph.WIDGET_TEXT_COLOR);
        content.style.setProperty("--ere-widget-bg", LiteGraph.WIDGET_BGCOLOR);
        content.style.setProperty("--ere-box", LiteGraph.NODE_DEFAULT_BOXCOLOR);

        const buttonElements = buttons.map(makeButton);
        const children = [];

        if (variant === "gallery" && buttonElements.length) {
            const row = document.createElement("div");
            row.className = "erenodes-pills-buttons";
            row.append(...buttonElements);
            children.push(row);
        } else {
            children.push(...buttonElements);
        }

        const buildPill = PILL_BUILDERS[variant];

        if (buildPill) {
            for (const tag of parseTags(node.properties?._tagDataJSON || "[]")) {
                if (!tag?.name) continue;
                if (!showInactive && !tag.active) continue;
                children.push(buildPill(tag));
            }
        }

        content.replaceChildren(...children);
        applyHeightPolicy();
    }

    // Every tag mutation funnels through onUpdateTextWidget, so chain the re-render onto it.
    const origUpdate = node.onUpdateTextWidget;
    node.onUpdateTextWidget = async function (...args) {
        const result = await origUpdate?.apply(this, args);
        render();
        return result;
    };

    // Content: width changes reflow the pills, which changes the height they need.
    // Root: Vue nodes apply a resize straight to the DOM, so this is what tells us the
    // node got smaller and the area has to be capped.
    const observer = new ResizeObserver(() => applyHeightPolicy());
    observer.observe(content);
    observer.observe(root);

    const origRemoved = node.onRemoved;
    node.onRemoved = function (...args) {
        observer.disconnect();
        return origRemoved?.apply(this, args);
    };

    node._erePillWidget = widget;
    node._erePillRender = render;
    render();

    return widget;
}

export { parseTags, getDisplayName };
