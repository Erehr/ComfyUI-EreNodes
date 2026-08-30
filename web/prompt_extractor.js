import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch, convertMenuItem } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";
import { parseTags } from "./js/parser.js";
import { ActionContextMenu } from "./js/contextmenu.js";
import { ACCEPTED_IMAGE_TYPES, isAcceptedImage, tagsFromResult, segmentCount, extractFromImage, reExtractByFilename, forgetVerdicts } from "./js/util.js";

const NODE_TYPE = "ErePromptExtractor";


const toast = (severity, summary, detail, life = 5000) => {
    try {
        app.extensionManager?.toast?.add({ severity, summary, detail, life });
    } catch {}
};

/** Mirror a value into a hidden transport widget so Python can read it. */
function setWidget(node, name, value) {
    const widget = node.widgets?.find(w => w.name === name);
    if (widget) widget.value = value;
}

/** Apply an extraction result to the node (merging lives in js/util.js). */
function applyResult(node, result) {
    const existing = parseTags(node.properties?._tagDataJSON || "[]");
    const tags = tagsFromResult(result, existing);

    if (!tags.length) {
        // The node now shows this image; keeping the old pills would claim they came from it.
        const hadTags = existing.length > 0;
        node.properties._tagDataJSON = "[]";
        node._extractSnapshot = "[]";
        node.onUpdateTextWidget?.(node);
        toast("warn", "Nothing to extract",
            (result.error || "No prompt metadata was found in that image.")
            + (hadTags ? " Previous tags cleared." : ""), 6000);
        return false;
    }

    node.properties._tagDataJSON = JSON.stringify(tags, null, 2);
    // New pills, so re-check against disk rather than trust a verdict cached for the name.
    forgetVerdicts(tags);
    // Set before the update, so the change watcher does not fire on this one.
    node._extractSnapshot = node.properties._tagDataJSON;
    node.onUpdateTextWidget?.(node);

    const inactive = tags.filter(t => t.active === false).length;
    const nodes = segmentCount(result);
    toast("success", "Prompt extracted",
        `${tags.length} tag(s)${inactive ? `, ${inactive} inactive` : ""}`
        + `${nodes > 1 ? `, ${nodes} nodes` : ""}`
        + `${result.source ? ` · ${result.source}` : ""}`, 4000);
    return true;
}

async function extractFromFile(node, file) {
    if (!file) return;
    if (!isAcceptedImage(file)) {
        toast("error", "Unsupported file", `${file.name} is not a PNG, JPEG or WebP.`);
        return;
    }

    node._extractBusy = true;
    node._ereDom?.render?.();

    try {
        const result = await extractFromImage(file);

        /** Record the image even when extraction found nothing: the preview is useful feedback that the right file arrived. */
        if (result.filename) {
            node.properties._extractImage = result.filename;
            setWidget(node, "image", result.filename);
        }
        applyResult(node, result);
    } catch (e) {
        console.error("[EreNodes] Prompt extraction failed.", e);
        toast("error", "Extraction failed", e.message);
    } finally {
        node._extractBusy = false;
        node._ereDom?.render?.();
        node.onExtractLayout?.();
        app.graph?.setDirtyCanvas?.(true, true);
    }
}

/** Re-read the image already recorded on the node. */
async function reExtract(node) {
    const filename = node.properties?._extractImage;
    if (!filename) {
        toast("warn", "No image", "Drop an image on the node first.");
        return;
    }
    node._extractBusy = true;
    node._ereDom?.render?.();
    try {
        applyResult(node, await reExtractByFilename(filename));
    } catch (e) {
        console.error("[EreNodes] Re-extraction failed.", e);
        toast("error", "Extraction failed", e.message);
    } finally {
        node._extractBusy = false;
        node._ereDom?.render?.();
        app.graph?.setDirtyCanvas?.(true, true);
    }
}

/** Drop the recorded image once the tags stop matching it: the pills stay editable, and an edited set no longer came from that image. */
function checkExtractDirty(node) {
    if (!node.properties?._extractImage) return;
    if (node._extractSnapshot === undefined) return;
    if (node.properties._tagDataJSON === node._extractSnapshot) return;

    delete node.properties._extractImage;
    node._extractSnapshot = undefined;
    setWidget(node, "image", "");
    node._ereDom?.render?.();
    node.onExtractLayout?.();
}

function attachExtractorBehaviour(node) {
    // A restored node saved its image and tags together, so they match: re-baseline here or the first edit after a reload would not clear the preview.
    const origConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        const result = origConfigure?.apply(this, arguments);
        const recorded = this.properties?._extractImage;
        if (recorded) {
            setWidget(this, "image", recorded);
            this._extractSnapshot = this.properties._tagDataJSON;
        }
        return result;
    };

    // Wrapped before attachTagDomWidget wraps them, so the renderer repaints after the image is cleared.
    const origUpdate = node.onUpdateTextWidget;
    node.onUpdateTextWidget = async function (...args) {
        const result = origUpdate?.apply(this, args);
        if (result instanceof Promise) await result;
        checkExtractDirty(node);
        return result;
    };
    // onRemoveTags mutates tags without going through onUpdateTextWidget.
    const origRemove = node.onRemoveTags;
    node.onRemoveTags = function (...args) {
        const result = origRemove?.apply(this, args);
        checkExtractDirty(node);
        return result;
    };

    node.onExtractPick = () => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ACCEPTED_IMAGE_TYPES.join(",");
        input.style.display = "none";
        document.body.appendChild(input);

        let settled = false;
        const cleanup = () => { if (input.isConnected) input.remove(); };
        input.addEventListener("change", () => {
            if (settled) return;
            settled = true;
            const file = input.files?.[0];
            cleanup();
            if (file) extractFromFile(node, file);
        });
        input.addEventListener("cancel", () => { settled = true; cleanup(); });
        input.click();
    };

    node.onExtractDrop = (e) => {
        const file = e.dataTransfer?.files?.[0];
        if (file) {
            extractFromFile(node, file);
            return;
        }
        // Dragged from another browser tab rather than the filesystem.
        const url = e.dataTransfer?.getData("text/uri-list")
            || e.dataTransfer?.getData("text/plain");
        if (url) {
            toast("warn", "Drop the file itself",
                "Images dragged from a web page carry no metadata. Save it first, then drop the saved file.", 6000);
        }
    };

    /** A reduced action menu: no clipboard/import/convert-from-text entries, because */
    node.onActionMenu = (e) => {
        const tagData = parseTags(node.properties?._tagDataJSON || "[]");
        new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY }, node.title, [
            // Cleared once the tags are edited: the image no longer describes them.
            { name: "Extract Again", callback: () => reExtract(node),
              disabled: !node.properties?._extractImage },
            { name: "Choose Image…", callback: () => node.onExtractPick?.() },
            null,
            { name: "Toggle All Tags", callback: () => node.onToggleTags?.() },
            { name: "Remove All Tags", callback: () => node.onRemoveTags?.() },
            { name: "Remove Inactive Tags", callback: () => node.onRemoveTags?.('inactive') },
            null,
            { name: "Save Tag Group", callback: () => node.onSaveTagGroup?.(e),
              disabled: tagData.filter(t => t.type !== 'group').length < 2 },
            { name: "Export Tags (.json)", callback: () => node.onExportTags?.() },
            null,
            convertMenuItem(node),
        ]);
    };
}

app.registerExtension({
    name: NODE_TYPE,

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== NODE_TYPE) return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const textWidget = this.widgets?.find(w => w.name === "text");
            initializeSharedPromptFunctions(this, textWidget);
            attachExtractorBehaviour(this);
            attachTagDomWidget(this, "extract");

            // A loaded node re-syncs its image in onConfigure, once properties are restored.
            this.onUpdateTextWidget(this);
        };
    },
});
