import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";

/** Prompt Randomizer. The seed is ComfyUI's own — declared in py/prompt.py with `control_after_generate`, so the frontend pairs it with the standard control widget and steps it per queued prompt. The arrangement follows from it (`arrangementForSeed`). */
app.registerExtension({
    name: "ErePromptRandomizer",

    setup() {
        applyContextMenuPatch();

        // Safety net for a frontend where afterQueued (below) never fires; it costs nothing when it does, since onSeedChanged is a no-op if the seed has not moved.
        api.addEventListener("execution_success", () => {
            setTimeout(() => {
                for (const node of app.graph?._nodes ?? []) {
                    if (node.type === "ErePromptRandomizer") node.onSeedChanged?.();
                }
            }, 10);
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptRandomizer") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);
            const node = this;

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);
            attachTagDomWidget(this, "randomizer");

            // Python widgets exist before onNodeCreated, so these would sit above the tag area. Serialized order is unaffected — the tag widget is `serialize: false`, so values still come out as text, separator, seed, control.
            const linked = this.widgets.filter(
                w => w.name === "seed" || w.name === "control_after_generate");
            if (linked.length) {
                this.widgets = this.widgets.filter(w => !linked.includes(w)).concat(linked);
            }

            const seedWidget = this.widgets?.find(w => w.name === "seed");
            // Whatever it starts with is what its tags already reflect; onConfigure sets this again for a loaded workflow, before any trigger can fire.
            node._seedApplied = Number(seedWidget?.value) || 0;

            // Typing a seed in re-lays the tags: how a remembered arrangement is played back.
            if (seedWidget) {
                const origCallback = seedWidget.callback;
                seedWidget.callback = function (...args) {
                    const result = origCallback?.apply(this, args);
                    node.onSeedChanged?.();
                    return result;
                };
            }

            // Chained original-first, so we read the value afterQueued just wrote instead of guessing the operation from the mode.
            const control = this.widgets?.find(w => w.name === "control_after_generate");
            if (control) {
                const origAfterQueued = control.afterQueued;
                control.afterQueued = function (...args) {
                    const result = origAfterQueued?.apply(this, args);
                    node.onSeedChanged?.();
                    return result;
                };
            }

            this.onUpdateTextWidget(this);
        };
    }
});
