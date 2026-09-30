import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, convertMenuItem, optionsMenuItem } from "./prompt.js";
import { attachTagDomWidget } from "./js/renderer.js";
import { parseTags } from "./js/parser.js";
import { ActionContextMenu } from "./js/contextmenu.js";
import { ACCEPTED_IMAGE_TYPES, isAcceptedImage, tagsFromResult, segmentCount, extractFromImage, reExtractByFilename, forgetVerdicts, ensureChecked, isKnownMissing, getTags, setTags, toast, pickFile } from "./js/util.js";

const NODE_TYPE = "ErePromptExtractor";



/** Mirror a value into a hidden transport widget so Python can read it. */
function setWidget(node, name, value) {
    const widget = node.widgets?.find(w => w.name === name);
    if (widget) widget.value = value;
}

/** Without inactive pills, and without loras, embeddings and groups whose file is missing (the red ones). */
async function withoutUnused(tags) {
    await ensureChecked(tags);
    return tags.filter(t => t.active !== false && !isKnownMissing(t));
}

async function removeUnused(node) {
    const tags = getTags(node);
    const kept = await withoutUnused(tags);
    if (kept.length !== tags.length) await setTags(node, kept);
}

function setRemoveByDefault(node, on) {
    if (on) node.properties._extractRemoveInactive = true;
    else delete node.properties._extractRemoveInactive;
    if (on) removeUnused(node);
}

/** Apply an extraction result to the node (merging lives in js/util.js). */
async function applyResult(node, result) {
    const existing = getTags(node);
    let tags = tagsFromResult(result, existing);

    if (!tags.length) {
        // The node now shows this image; keeping the old pills would claim they came from it.
        const hadTags = existing.length > 0;
        node.properties._tagDataJSON = "[]";
        node._extractSnapshot = "[]";
        delete node.properties._extractStale;
        node.onUpdateTextWidget?.(node);
        toast("warn", "Nothing to extract",
            (result.error || "No prompt metadata was found in that image.")
            + (hadTags ? " Previous tags cleared." : ""), 6000);
        return false;
    }

    // New pills, so re-check against disk rather than trust a verdict cached for the name.
    forgetVerdicts(tags);
    const extracted = tags.length;
    if (node.properties._extractRemoveInactive) tags = await withoutUnused(tags);
    const removed = extracted - tags.length;

    node.properties._tagDataJSON = JSON.stringify(tags);
    // Set before the update, so the change watcher does not fire on this one.
    node._extractSnapshot = node.properties._tagDataJSON;
    delete node.properties._extractStale;
    node.onUpdateTextWidget?.(node);

    const inactive = tags.filter(t => t.active === false).length;
    const nodes = segmentCount(result);
    toast("success", "Prompt extracted",
        `${tags.length} tag(s)${inactive ? `, ${inactive} inactive` : ""}${removed ? `, ${removed} removed` : ""}`
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
        await applyResult(node, result);
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
        await applyResult(node, await reExtractByFilename(filename));
    } catch (e) {
        console.error("[EreNodes] Re-extraction failed.", e);
        toast("error", "Extraction failed", e.message);
    } finally {
        node._extractBusy = false;
        node._ereDom?.render?.();
        app.graph?.setDirtyCanvas?.(true, true);
    }
}

/** Grey the recorded image out while the tags differ from what it gave: the pills stay editable, and an edited set no longer came from that image. */
function checkExtractDirty(node) {
    if (!node.properties?._extractImage) return;
    if (node._extractSnapshot === undefined) return;
    const stale = node.properties._tagDataJSON !== node._extractSnapshot;
    if (stale === !!node.properties._extractStale) return;

    if (stale) node.properties._extractStale = true;
    else delete node.properties._extractStale;
    node._ereDom?.render?.();
}

function clearExtractImage(node) {
    delete node.properties._extractImage;
    delete node.properties._extractStale;
    node._extractSnapshot = undefined;
    setWidget(node, "image", "");
    node._ereDom?.render?.();
    node.onExtractLayout?.();
}

function attachExtractorBehaviour(node) {
    // A restored node saved its image and tags together, so they match: re-baseline here or the first edit after a reload would not grey the preview.
    // A greyed image is not restored at all: it only lasts for the session it went stale in.
    const origConfigure = node.onConfigure;
    node.onConfigure = function (info) {
        const result = origConfigure?.apply(this, arguments);
        if (this.properties?._extractStale) clearExtractImage(this);
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
        const result = await origUpdate?.apply(this, args);
        checkExtractDirty(node);
        return result;
    };
    // Removing inactive tags here also removes missing files, and goes through setTags, which the change watcher sees.
    // Removing all of them clears the image outright: there is nothing left for it to describe.
    const origRemove = node.onRemoveTags;
    node.onRemoveTags = function (mode = 'all', ...rest) {
        if (mode === 'inactive') return removeUnused(node);
        const result = origRemove?.call(this, mode, ...rest);
        if (node.properties?._extractImage) clearExtractImage(node);
        return result;
    };

    node.onExtractPick = async () => {
        const file = await pickFile(ACCEPTED_IMAGE_TYPES.join(","));
        if (file) extractFromFile(node, file);
    };

    node.onExtractDrop = (file, e) => {
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
        const tagData = getTags(node);
        const removeByDefault = !!node.properties?._extractRemoveInactive;
        new ActionContextMenu({ clientX: e.clientX, clientY: e.clientY }, node.title, [
            { name: "Extract Again", callback: () => reExtract(node),
              disabled: !node.properties?._extractImage },
            { name: "Choose Image…", callback: () => node.onExtractPick?.() },
            null,
            { name: "Toggle All Tags", callback: () => node.onToggleTags?.() },
            { name: "Remove All Tags", callback: () => node.onRemoveTags?.() },
            // With the option on there is never anything left for it to remove.
            { name: "Remove Inactive Tags", callback: () => node.onRemoveTags?.('inactive'), disabled: removeByDefault },
            null,
            { name: "Save Tag Group", callback: () => node.onSaveTagGroup?.(e),
              disabled: tagData.filter(t => t.type !== 'group').length < 2 },
            { name: "Export Tags (.json)", callback: () => node.onExportTags?.() },
            null,
            optionsMenuItem(node, [
                null,
                { name: "Remove inactive by default", checked: removeByDefault, callback: () => setRemoveByDefault(node, !removeByDefault) },
            ]),
            convertMenuItem(node),
        ]);
    };
}

app.registerExtension({
    name: NODE_TYPE,

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
