import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch, convertMenuItem } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";
import { ActionContextMenu } from "./js/contextmenu.js";
import { ensureRows, updateComposer, renderComposer, addRow, removeAllRows, setAllRows, flattenRows } from "./js/composer.js";

const NODE_TYPE = "ErePromptComposer";

/** The node's ≡: what applies to the whole stack. Per-category actions live on the row. */
function openComposerMenu(node, e) {
    // Converting flattens for good: the target reads the same property as a plain tag list, and keeping the categories beside it would be dead weight in the workflow.
    const convert = (type) => { flattenRows(node); node.convertTo(type); };
    new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY }, node.title, [
        { name: "Add Category", callback: () => addRow(node) },
        null,
        { name: "Expand All", callback: () => setAllRows(node, "open", true) },
        { name: "Collapse All", callback: () => setAllRows(node, "open", false) },
        null,
        { name: "Enable All Categories", callback: () => setAllRows(node, "active", true) },
        { name: "Disable All Categories", callback: () => setAllRows(node, "active", false) },
        { name: "Remove All Categories", callback: () => removeAllRows(node) },
        null,
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

            // The toolbar's "+ Category" (renderButtons) rides the shared button channel.
            const origPillClick = node.onTagPillClick;
            node.onTagPillClick = (e, pos, pill) => {
                if (pill?.label === "button_add_row") return addRow(node);
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
