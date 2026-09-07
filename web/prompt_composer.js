import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch, convertMenuItem, optionsMenuItem, tileMenuItems } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";
import { ActionContextMenu } from "./js/contextmenu.js";
import { ensureRows, updateComposer, renderComposer, addRow, addRowFromClipboard, removeAllRows, setAllRows, flattenRows, getRows, ROW_LAYOUTS } from "./js/composer.js";

const NODE_TYPE = "ErePromptComposer";

/** The "+ Category" caret: add a category already set to a layout. */
function openAddRowMenu(node, e) {
    new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY }, "",
        ROW_LAYOUTS.map(layout => ({
            name: layout.label,
            callback: () => addRow(node, layout.id),
        })));
}

/** The node's ≡: what applies to the whole stack. Per-category actions live on the row. */
function openComposerMenu(node, e) {
    // Converting flattens for good: the target reads the same property as a plain tag list, and keeping the categories beside it would be dead weight in the workflow.
    const convert = (type) => { flattenRows(node); node.convertTo(type); };
    new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY }, node.title, [
        // No "Add Category" / "Add Category as" here: the split button sits next to this menu and
        // is both of them.
        { name: "Create Category from Clipboard", callback: () => addRowFromClipboard(node) },
        null,
        { name: "Expand All", callback: () => setAllRows(node, "open", true) },
        { name: "Collapse All", callback: () => setAllRows(node, "open", false) },
        null,
        { name: "Enable All Categories", callback: () => setAllRows(node, "active", true) },
        { name: "Disable All Categories", callback: () => setAllRows(node, "active", false) },
        { name: "Remove All Categories", callback: () => removeAllRows(node) },
        null,
        // Tile controls only once a category is drawn as a gallery, which is the only thing they affect.
        optionsMenuItem(node, getRows(node).some(r => r.layout === "gallery")
            ? tileMenuItems(node) : []),
        convertMenuItem(node, convert),
    ]);
}

app.registerExtension({
    name: NODE_TYPE,

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);
            const node = this;

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);

            // Replaced before attachTagDomWidget, so its render/resize wrappers sit outside:
            // the shared update knows only about one flat tag list.
            node.onUpdateTextWidget = (n) => updateComposer(n || node);
            node.onRenderComposer = (content, colors) => renderComposer(node, content, colors);
            node.onActionMenu = (e) => openComposerMenu(node, e);
            // Ctrl+V on the node: always a new category, never a replace — the node has no tag
            // list of its own to replace, and the categories it has are the point of it.
            node.onClipboardPaste = () => addRowFromClipboard(node);

            // The toolbar's "+ Category" (renderButtons) rides the shared button channel.
            const origPillClick = node.onTagPillClick;
            node.onTagPillClick = (e, pos, pill) => {
                if (pill?.label === "button_add_row") return addRow(node);
                if (pill?.label === "button_add_row_menu") return openAddRowMenu(node, e);
                return origPillClick?.(e, pos, pill);
            };

            // Rows are joined with the prefix separator, so editing it must re-join them.
            const origPropertyChanged = node.onPropertyChanged;
            node.onPropertyChanged = function (name, value) {
                origPropertyChanged?.apply(this, arguments);
                if (name === "_prefixSeparator") node.onUpdateTextWidget(node);
            };

            // convertTo() replaces `properties` after onNodeCreated and never triggers onConfigure, so a node converted into a Composer gets its categories here.
            const origAdded = node.onAdded;
            node.onAdded = function (...args) {
                const result = origAdded?.apply(this, args);
                ensureRows(node);
                node.onUpdateTextWidget(node);
                return result;
            };

            ensureRows(this);
            attachTagDomWidget(this, "composer");
            this.onUpdateTextWidget(this);
        };
    },
});
