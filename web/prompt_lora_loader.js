import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, optionsMenuItem, tileMenuItems } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";
import { ActionContextMenu, FileContextMenu } from "./js/contextmenu.js";
import { getTags } from "./js/util.js";

const NODE_TYPE = "ErePromptLoraLoader";

/** No multiline: there is no prose in a lora list. */
const LAYOUTS = [
    { id: "toggle", label: "Toggle" },
    { id: "cloud", label: "Cloud" },
    { id: "multiselect", label: "MultiSelect" },
    { id: "gallery", label: "Gallery" },
];

const layoutOf = (node) => {
    const id = node.properties?._loraLayout;
    return LAYOUTS.some(l => l.id === id) ? id : "toggle";
};

const loraTagsOf = (node) =>
    getTags(node).filter(t => t.type === "lora");

/** Windows hands subfolders back with backslashes, the file picker with forward ones. */
const samePath = (name) => String(name || "").replace(/\\/g, "/");

function setLayout(node, id) {
    node.properties._loraLayout = LAYOUTS.some(l => l.id === id) ? id : "toggle";
    node._ereDom?.render?.();
}

function layoutMenuItem(node) {
    const current = layoutOf(node);
    return {
        name: "Layout",
        submenu: LAYOUTS.map(layout => ({
            name: `${layout.id === current ? "✓ " : ""}${layout.label}`,
            callback: () => setLayout(node, layout.id),
        })),
    };
}

/** Only loras have anything to apply, so a drop or paste of anything else is dropped. */
function keepOnlyLoras(node) {
    const stored = getTags(node);
    const loras = stored.filter(t => t.type === "lora");
    if (stored.length === loras.length) return false;
    node.properties._tagDataJSON = JSON.stringify(loras);
    return true;
}

/** Straight to the file picker, skipping the tag search this node has no use for. */
function openLoraPicker(node, e) {
    const menu = new FileContextMenu(e, (selected) => {
        const items = Array.isArray(selected) ? selected : [selected];
        const tags = loraTagsOf(node);
        for (const item of items) {
            const name = samePath(item?.name);
            if (!name || tags.some(t => samePath(t.name) === name)) continue;
            tags.push({ name, type: "lora", active: true });
        }
        node.properties._tagDataJSON = JSON.stringify(tags);
        node.onUpdateTextWidget?.(node);
        node._ereDom?.render?.();
    }, "lora", loraTagsOf(node));
    menu.show();
}

function openLoraMenu(node, e) {
    new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY }, node.title, [
        layoutMenuItem(node),
        null,
        { name: "Toggle All Loras", callback: () => node.onToggleTags?.() },
        { name: "Remove All Loras", callback: () => node.onRemoveTags?.() },
        { name: "Remove Inactive Loras", callback: () => node.onRemoveTags?.('inactive') },
        null,
        { name: "Load Tag Group", callback: () => node.onLoadTagGroup?.(e) },
        { name: "Save Tag Group", callback: () => node.onSaveTagGroup?.(e), disabled: loraTagsOf(node).length < 2 },
        null,
        // No "Convert to": convertTo reconnects by index, and only this node starts with MODEL.
        optionsMenuItem(node, node.onExtraOptions?.() ?? []),
    ]);
}

app.registerExtension({
    name: NODE_TYPE,

    async setup() {
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);
            const node = this;

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);

            node.onActionMenu = (e) => openLoraMenu(node, e);

            // Refusing the whole payload keeps a cross-node drag from emptying the source node.
            node.onAcceptTags = (tags) => tags.length > 0 && tags.every(t => t?.type === "lora");

            // keepOnlyLoras backstops paste, which never reaches the drag layer.
            const origUpdate = node.onUpdateTextWidget;
            node.onUpdateTextWidget = async function (...args) {
                if (keepOnlyLoras(node)) node._ereDom?.render?.();
                return origUpdate?.apply(this, args);
            };

            // Tile controls only affect the gallery layout.
            node.onExtraOptions = () => (layoutOf(node) === "gallery" ? tileMenuItems(node) : []);

            const origPillClick = node.onTagPillClick;
            node.onTagPillClick = (e, pos, pill) => {
                if (pill?.label === "button_add_lora") return openLoraPicker(node, e);
                return origPillClick?.(e, pos, pill);
            };

            // convertTo() replaces `properties` after onNodeCreated without firing onConfigure.
            const origAdded = node.onAdded;
            node.onAdded = function (...args) {
                const result = origAdded?.apply(this, args);
                node.onUpdateTextWidget(node);
                return result;
            };

            attachTagDomWidget(this, "loraloader", () => layoutOf(node));
            this.onUpdateTextWidget(this);
        };
    },
});
