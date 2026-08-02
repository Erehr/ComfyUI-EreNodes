import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions } from "./prompt.js";
import { attachTagPillWidget } from "./js/pills.js";

app.registerExtension({
    name: "ErePromptMultiline",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptMultiline") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const node = this;

            const textWidget = node.widgets?.find(w => w.name === "text");

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // This node keeps its textarea, so the widget only carries the action button.
            // As a DOM widget it takes part in the layout of both renderers, which is what
            // keeps it from ending up underneath the textarea.
            attachTagPillWidget(node, {
                variant: "buttons",
                autoHeight: false,
                buttons: [
                    { label: "button_menu", display: "≡", title: "Menu" }
                ]
            });

            // Update on load
            this.onUpdateTextWidget(this);
        };

    }
});
