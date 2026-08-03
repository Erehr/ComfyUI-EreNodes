import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";

app.registerExtension({
    name: "ErePromptCloud",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptCloud") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);
            attachTagDomWidget(this, "cloud");
            this.onUpdateTextWidget(this);
        };
    }
});
