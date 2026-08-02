import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagPillWidget, openInactiveTagsMenu } from "./js/pills.js";

app.registerExtension({
    name: "ErePromptRandomizer",

    setup() {
        applyContextMenuPatch();

        api.addEventListener("status", ({ detail }) => {
            if (detail?.exec_info?.queue_remaining === 0) {
                setTimeout(() => {
                    const graph = app.graph;
                    if (!graph?._nodes) return;

                    for (const node of graph._nodes) {
                        if (node.type === "ErePromptRandomizer") {
                            const controlWidget = node.widgets?.find(w => w.name === "control after generate");
                            if (controlWidget) {
                                const mode = controlWidget.value;
                                if (mode === "randomize") {
                                    node.onRandomize?.();
                                } else if (mode === "increment") {
                                    node.onIncrement?.();
                                } else if (mode === "decrement") {
                                    node.onDecrement?.();
                                }
                            }
                        }
                    }
                }, 10);
            }
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptRandomizer") return;

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
            // Added before the control widget so that one sits below the pills.
            attachTagPillWidget(node, {
                variant: "chips",
                framed: true,
                showInactive: false,
                buttons: [
                    { label: "button_menu", display: "≡", title: "Menu" },
                    { label: "button_add_tag", display: "+", title: "Add tag" },
                    { label: "button_randomize", display: "🎲︎", title: "Randomize" }
                ],
                // Clicking the empty area offers the tags that are currently off
                onBackgroundClick: e => openInactiveTagsMenu(node, e)
            });

            // Randomize control
            node.addWidget("combo", "control after generate", "fixed", "control_after_generate", { values: ["fixed", "increment", "decrement", "randomize"] });

            // Update on load
            this.onUpdateTextWidget(this);
        };

    }
});
