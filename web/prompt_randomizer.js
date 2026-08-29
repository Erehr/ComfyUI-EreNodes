import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";

/**
 * Prompt Randomizer.
 *
 * The seed is a real ComfyUI seed: declared in `py/prompt.py` with
 * `control_after_generate: True`, so the frontend builds it and pairs it with the
 * standard linked control widget (the one that collapses into the seed field in
 * Nodes 2.0) and steps the value itself after every queued prompt.
 *
 * Before 3.5 this node carried its own INT-ish widget plus a hand-rolled combo
 * named "control after generate". It looked the part and did none of the work:
 * nothing ever moved the number, so it sat at 0 through every generation. The
 * arrangement is now a pure function of whatever the real seed happens to be, and
 * all four control modes fall out of that — see `arrangementForSeed` in prompt.js.
 */
app.registerExtension({
    name: "ErePromptRandomizer",

    setup() {
        applyContextMenuPatch();

        // Safety net, not the mechanism. The seed is normally picked up the moment
        // control_after_generate moves it (below), which happens once per *queued
        // prompt* and so gives a batch of eight eight different arrangements — the
        // old execution_success-only path gave the whole batch one. This stays for
        // a frontend where that hook never fires, and costs nothing when it did:
        // onSeedChanged does nothing if the seed has not moved.
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

            // Widgets declared in Python exist before onNodeCreated runs, so the seed
            // and its control would sit *above* the tag area. Move them below it, where
            // this node's control has always been.
            //
            // Serialized order is unaffected: the tag widget is `serialize: false`, so
            // the values still come out as text, separator, seed, control — which is
            // what realignLoadedWidgets assumes.
            const linked = this.widgets.filter(
                w => w.name === "seed" || w.name === "control_after_generate");
            if (linked.length) {
                this.widgets = this.widgets.filter(w => !linked.includes(w)).concat(linked);
            }

            const seedWidget = this.widgets?.find(w => w.name === "seed");
            // Whatever the node starts with is what its tags already reflect. onConfigure
            // sets this again for a loaded workflow, before any trigger can fire.
            node._seedApplied = Number(seedWidget?.value) || 0;

            // Typing a seed in re-lays the tags immediately — that is how a remembered
            // arrangement is played back.
            if (seedWidget) {
                const origCallback = seedWidget.callback;
                seedWidget.callback = function (...args) {
                    const result = origCallback?.apply(this, args);
                    node.onSeedChanged?.();
                    return result;
                };
            }

            // control_after_generate is a second, linked widget whose afterQueued moves
            // the seed. Chaining it — original first — means we read the value it just
            // wrote, rather than guessing the operation from the mode. The mode only
            // says *what* it did; the number is on the seed widget.
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
