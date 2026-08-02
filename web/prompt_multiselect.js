import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagPillWidget, openInactiveTagsMenu } from "./js/pills.js";

app.registerExtension({
    name: "ErePromptMultiSelect",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptMultiSelect") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const node = this;

            const textWidget = node.widgets?.find(w => w.name === "text");
            textWidget.computeSize = () => [0, 0];
            // `hidden` hides it in the legacy renderer, `options.hidden` in Vue nodes -
            // they read different flags, and without the second one the raw tag JSON
            // shows up as a textarea.
            textWidget.hidden = true;
            textWidget.options = textWidget.options || {};
            textWidget.options.hidden = true;

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // Tag pills are a DOM widget so they render in both the legacy and the
            // Vue node renderer; clicks are wired to the shared handlers inside.
            attachTagPillWidget(node, {
                variant: "chips",
                framed: true,
                showInactive: false,
                buttons: [
                    { label: "button_menu", display: "≡", title: "Menu" },
                    { label: "button_add_tag", display: "+", title: "Add tag" }
                ],
                // Clicking the empty area offers the tags that are currently off
                onBackgroundClick: e => openInactiveTagsMenu(node, e)
            });

            // Update on load
            this.onUpdateTextWidget(this);
        };

    }
});
