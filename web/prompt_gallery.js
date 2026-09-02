import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch, tileMenuItems } from "./prompt.js";
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
            // Read by the shared action menu, which puts them at the end of its Options flyout.
            this.onExtraOptions = () => tileMenuItems(this);
            attachTagDomWidget(this, "gallery");
            this.onUpdateTextWidget(this);
        };
    }
});
