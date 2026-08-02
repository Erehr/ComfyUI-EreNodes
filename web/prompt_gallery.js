import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagPillWidget } from "./js/pills.js";

const DEFAULT_CARD_SIZE = 100;

app.registerExtension({
    name: "ErePromptGallery",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptGallery") return;

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

            // create properties defaults
            if (node.properties._tagImageWidth === null || node.properties._tagImageWidth === undefined) {
                node.properties._tagImageWidth = DEFAULT_CARD_SIZE;
            }
            if (node.properties._tagImageHeight === null || node.properties._tagImageHeight === undefined) {
                node.properties._tagImageHeight = DEFAULT_CARD_SIZE;
            }

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // Tag cards are a DOM widget so they render in both the legacy and the
            // Vue node renderer; clicks are wired to the shared handlers inside.
            // Images are plain <img> elements - the browser cache takes over the job
            // the bitmap cache did for the canvas renderer.
            attachTagPillWidget(node, {
                variant: "gallery",
                buttons: [
                    { label: "button_menu", display: "≡", title: "Menu" },
                    { label: "button_add_tag", display: "+", title: "Add tag" }
                ],
                getCardSize: () => [
                    node.properties?._tagImageWidth ?? DEFAULT_CARD_SIZE,
                    node.properties?._tagImageHeight ?? DEFAULT_CARD_SIZE
                ]
            });

            // Update on load
            this.onUpdateTextWidget(this);
        };

        // Width stays freely resizable (the cards reflow on their own), height follows
        // the content. Legacy renderer only - Vue nodes size themselves from the DOM.
        nodeType.prototype.onResize = function () {
            if (LiteGraph.vueNodesMode || !this._erePillsHeight) return;

            if (Math.abs(this.size[1] - this._erePillsHeight) > 1) {
                this.setSize([this.size[0], this._erePillsHeight]);
            }
        };

    }
});
