import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";

app.registerExtension({
    name: "ErePromptRandomizer",

    setup() {
        applyContextMenuPatch();

        // Fire once per completed prompt (the old "status" queue_remaining===0
        // check only fired when the whole queue emptied, so queued batches
        // only randomized once at the end).
        api.addEventListener("execution_success", () => {
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
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptRandomizer") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);
            // Pills first, then the control combo so it sits under the tag area
            attachTagDomWidget(this, "randomizer");
            this.addWidget("combo", "control after generate", "fixed", "control_after_generate", {
                values: ["fixed", "increment", "decrement", "randomize"],
            });
            this.onUpdateTextWidget(this);
        };
    }
});
