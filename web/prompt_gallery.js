import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";

app.registerExtension({
    name: "ErePromptGallery",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptGallery") return;

        const defaultPillW = 100;
        const defaultPillH = 100;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            if (this.properties._tagImageWidth == null) {
                this.properties._tagImageWidth = defaultPillW;
            }
            if (this.properties._tagImageHeight == null) {
                this.properties._tagImageHeight = defaultPillH;
            }

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);
            // Gallery previews are plain <img> tags (browser cache / lazy load) — no canvas ImageBitmap cache needed.
            attachTagDomWidget(this, "gallery");
            this.onUpdateTextWidget(this);
        };
    }
});
