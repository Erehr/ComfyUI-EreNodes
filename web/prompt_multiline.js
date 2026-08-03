import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";

app.registerExtension({
    name: "ErePromptMultiline",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptMultiline") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);
            // ≡ menu as a DOM widget (no fake placeholder button needed)
            attachTagDomWidget(this, "multiline");
            this.onUpdateTextWidget(this);
        };
    }
});
