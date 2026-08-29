import { app } from "../../scripts/app.js";
import { TagContextMenuInsert, TagEditContextMenu, TagGroupContextMenu } from "./js/contextmenu.js";
import { getCache, clearCache, captureUndoState } from "./js/util.js";
import { bumpPreview } from "./js/tagview.js";
import { parseTags, parseTag, formatTag, parseTextToTagData, stripNestedGroups, dedupeTags } from "./js/parser.js";

// The dice button's range. ComfyUI's seed input goes to 2^64, but a JS number cannot hold that exactly and nothing here needs it to — 32 bits is already far more arrangements than any tag list has.
const DICE_SEED_MAX = 0xFFFFFFFF;

/** Any widget value as a usable seed. */
const normalizeSeed = (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * 32 bits of shuffle key out of a seed declared over a 64-bit range.
 * Both halves are folded in, so two seeds that differ only in their high bits still shuffle differently.
 */
function seedKey32(value) {
    const n = normalizeSeed(value);
    return ((n >>> 0) ^ Math.imul(Math.floor(n / 4294967296) >>> 0, 0x9E3779B1)) >>> 0;
}

const CONTROL_MODES = ["fixed", "increment", "decrement", "randomize"];

/**
 * Undo the positional shift a workflow suffers when it was saved by a version with fewer widgets than the node has now.
 *
 * LiteGraph restores widget values by position, so adding a widget in the middle silently slides every later value one slot along — a Randomizer saved before the seed existed loads its `control after generate` value *into* the seed, and loses the control. This has now happened twice (the separator did it first), so it is worth having as one function rather than a growing chain of branches inside onConfigure.
 *
 * Detection is by type, never by counting: a seed is a number and a control mode is a known string, so a value in the wrong slot identifies itself. `hasControl` / `hasSeed` say which widgets the node actually has — only the Randomizer has either, and a separator that happens to read "fixed" on a node with no control widget must be left alone.
 *
 * @returns the corrected `{separator, control, seed}`.
 */
export function realignLoadedWidgets({ separator, control, seed, hasControl = false, hasSeed = false }) {
    const out = { separator, control, seed };

    // Saved before the separator widget: the control's value landed in the separator.
    if (hasControl && (control === undefined || control === null) && CONTROL_MODES.includes(separator)) {
        out.control = separator;
        out.separator = null;
    } else if (separator === "fake_button") {
        out.separator = null;
    }

    if (hasSeed) {
        // Saved before the seed widget: the control's value landed in the seed.
        if (CONTROL_MODES.includes(out.seed)) {
            if (out.control === undefined || out.control === null) out.control = out.seed;
            out.seed = 0;
        }
        // Anything else non-numeric here (including the two-slot shift above, which
        // leaves nothing in this slot at all) is not a seed.
        if (typeof out.seed !== "number" || !Number.isFinite(out.seed)) out.seed = 0;
    }
    return out;
}

/**
 * mulberry32 — a small seeded PRNG.
 *
 * Math.random cannot be seeded, so a reproducible shuffle needs its own generator. This one is 32-bit, has no dependencies and passes gjrand; more than enough to permute a tag list, and identical in every browser, which is the property that actually matters here.
 */
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The arrangement a seed produces: which tags are on.
 *
 * **The stored order is never touched.** Randomizing a set of tags is a question of
 * which ones are enabled, not of where they sit in the list — the order in
 * `_tagDataJSON` is the user's, changed only by actually dragging a pill. That also
 * keeps a Randomizer honest under conversion: turn it into a Cloud and back and the
 * pills are where they were left.
 *
 * (Before 3.5 `onRandomize` swapped array elements and wrote the shuffled list back.
 * It was invisible, because these nodes draw only their active tags, so the reorder
 * showed up nowhere until you converted the node to one that draws all of them.)
 *
 * **Two** things come out of the one number, which is what lets ComfyUI's single
 * native seed replace this node's old bespoke combo without losing either behaviour:
 *   - which positions are on, from `seed / count`
 *   - how far that selection is rotated, from `seed % count`
 *
 * So `increment` slides every enabled tag one place along, wrapping — the same sweep
 * the old `shiftActiveTags` gave, where a batch walks the whole list instead of
 * resampling it — while `randomize` lands on a different selection entirely. The
 * difference is that both are now a pure function of (seed, tag list), so both are
 * reproducible, which the old combo could not offer at all.
 *
 * How many tags are enabled is preserved; the seed only decides which.
 */
function arrangementForSeed(tags, seed) {
    const count = tags.length;
    const activeCount = tags.filter(t => t.active).length;
    // Nothing to choose between: no tags, none enabled, or all of them. Each would
    // otherwise burn a re-render per generation to produce what is already on screen.
    if (count < 2 || activeCount === 0 || activeCount === count) return tags;

    const value = normalizeSeed(seed);

    // Partial Fisher-Yates over the positions: the first `activeCount` entries are a
    // uniform sample without replacement, and it costs `activeCount` steps rather than
    // shuffling the whole list to throw most of it away.
    const positions = [...Array(count).keys()];
    const random = mulberry32(seedKey32(Math.floor(value / count)));
    for (let i = 0; i < activeCount; i++) {
        const j = i + Math.floor(random() * (count - i));
        [positions[i], positions[j]] = [positions[j], positions[i]];
    }

    const offset = value % count;
    const enabled = new Set(positions.slice(0, activeCount).map(i => (i + offset) % count));
    return tags.map((tag, i) => ({ ...tag, active: enabled.has(i) }));
}

/**
 * Write a tag group to disk — the one path for it, so the node menu and the sidebar share the overwrite confirmation, cache invalidation and toasts.
 *
 * @param {string} [opts.path]  folder relative to the tag-group root
 * @param {string} opts.filename  ".json" is appended if missing
 * @param {boolean} [opts.overwriteSilently]  skip the "already exists" prompt
 */
export async function saveTagGroup({ path = "", filename, tags, imageFile, overwriteSilently = false }) {
    const name = filename.toLowerCase().endsWith(".json") ? filename : `${filename}.json`;
    const fullPath = path ? `${path}/${name}` : name;

    try {
        if (!overwriteSilently) {
            const checkResponse = await fetch(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);
            if (checkResponse.ok) {
                // app.ui.dialog.show() is not a confirm dialog (returns nothing); use the extensionManager confirm dialog with a window.confirm fallback.
                const message = `Tag group '${name}' already exists. Do you want to overwrite it?`;
                const confirmed = app.extensionManager?.dialog?.confirm
                    ? await app.extensionManager.dialog.confirm({ title: "File Exists", message })
                    : window.confirm(message);
                if (!confirmed) return { ok: false, cancelled: true, fullPath };
            }
        }

        clearCache(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);
        // Move the cover's URL so a replaced thumbnail is actually fetched. This used to call clearCachePrefix, which cleared a map `<img>` never wrote to — the browser went on showing the old image.
        bumpPreview("group", fullPath.replace(/\.json$/i, ""));

        const formData = new FormData();
        formData.append('path', path || '');
        formData.append('filename', name);
        formData.append('tags_json', JSON.stringify(tags, null, 2));
        if (imageFile) formData.append('image_file', imageFile, imageFile.name);

        const response = await fetch('/erenodes/save_tag_group', { method: 'POST', body: formData });
        const result = await response.json();

        if (!response.ok) {
            const errorMessage = result.error || result.message || "Unknown error saving tag group.";
            console.error('[EreNodes] Error saving tag group:', errorMessage);
            app.extensionManager?.toast?.add({
                severity: "error", summary: "Save Error", detail: errorMessage, life: 5000,
            });
            return { ok: false, message: errorMessage, fullPath };
        }

        const successMessage = result.message || `Tag group '${name}' saved successfully.`;
        app.extensionManager?.toast?.add({
            severity: "success", summary: "Saved", detail: successMessage, life: 4000,
        });
        app.ereSidebar?.refresh?.();
        return { ok: true, message: successMessage, fullPath };
    } catch (error) {
        console.error('[EreNodes] Error saving tag group:', error);
        app.extensionManager?.toast?.add({
            severity: "error", summary: "Save Operation Error", detail: error.message, life: 5000,
        });
        return { ok: false, message: error.message, fullPath };
    }
}

const getTextInput = async (title, promptMessage, defaultValue = "") => {
    // Prefer the ComfyUI dialog API (window.prompt is blocked in some desktop/embedded contexts)
    if (app.extensionManager?.dialog?.prompt) {
        try {
            const value = await app.extensionManager.dialog.prompt({
                title,
                message: promptMessage,
                defaultValue,
            });
            return (value === null || value === undefined) ? false : value;
        } catch (e) {
            // fall through to window.prompt
        }
    }
    const value = window.prompt(promptMessage, defaultValue);
    if (value === null) return false;
    return value;
};

// Global keyboard shortcuts for tag nodes (Ctrl+V paste).
// The old processContextMenu hijack for pill right-clicks is gone: quick edit is handled by DOM contextmenu listeners on the pills (renderer.js).
let contextMenuPatched = false;
const ERE_TAG_NODE_TYPES = ["ErePromptCloud", "ErePromptToggle", "ErePromptMultiSelect", "ErePromptRandomizer", "ErePromptGallery"];

export function applyContextMenuPatch() {
    if (contextMenuPatched) {
        return;
    }
    contextMenuPatched = true;

    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.nodeName === 'INPUT' || activeElement.nodeName === 'TEXTAREA' || activeElement.hasAttribute('contenteditable'))) {
                return;
            }

            const selectedNodes = Object.values(app.canvas.selected_nodes || {});
            if (selectedNodes.length === 1) {
                const node = selectedNodes[0];
                if (node && ERE_TAG_NODE_TYPES.includes(node.type)) {
                    // Block ComfyUI's handler first — it pastes its node clipboard whatever the system clipboard holds — then decide: tag text pastes tags, JSON hands it back.
                    e.preventDefault();
                    e.stopPropagation();
                    const comfyPaste = () => app.canvas?.pasteFromClipboard?.();
                    navigator.clipboard.readText().then(text => {
                        const trimmed = (text || "").trim();
                        let isTagText = !!trimmed;
                        if (isTagText) {
                            try {
                                if (typeof JSON.parse(trimmed) === "object") isTagText = false; // copied node / workflow
                            } catch {} // not JSON → tag text
                        }
                        if (!isTagText) return comfyPaste();
                        const pasteBehaviour = app.ui.settings.getSettingValue('EreNodes.Nodes.PasteAction', 'Replace tags');
                        if (pasteBehaviour === 'Append tags') {
                            node.onClipboardAppend();
                        } else {
                            node.onClipboardReplace();
                        }
                    }).catch(() => comfyPaste());
                }
            }
        }
    });
}

export function initializeSharedPromptFunctions(node, textWidget) {

    node.properties = node.properties || {};

    // Initialize _prefixSeparator if it's null or undefined
    if (node.properties._prefixSeparator === null || node.properties._prefixSeparator === undefined) {
        node.properties._prefixSeparator = ",\\n\\n"; // Default value
    }

    // Initialize _tagSeparator if it's null or undefined
    if (node.properties._tagSeparator === null || node.properties._tagSeparator === undefined) {
        node.properties._tagSeparator = ", "; // Default value
    }

    // Separator bridge: _prefixSeparator is edited in the Properties panel, but process() only sees widget values — so this hidden widget mirrors it.
    const sepWidget = node.widgets?.find(w => w.name === "separator");
    if (sepWidget) {
        sepWidget.computeSize = () => [0, 0];
        sepWidget.hidden = true;
        sepWidget.value = node.properties._prefixSeparator ?? sepWidget.value ?? ",\\n\\n";
    }

    // Capture existing onPropertyChanged to allow chaining
    const existingOnPropertyChanged = node.onPropertyChanged;
    node.onPropertyChanged = function(name, value) {
        if (existingOnPropertyChanged) {
            existingOnPropertyChanged.apply(this, arguments);
        }

        // Handle _tagSeparator property changes
        if (name === "_tagSeparator") {
            // Trigger text widget update when tag separator changes
            if (this.onUpdateTextWidget) {
                this.onUpdateTextWidget(this);
            }
        }

        // Keep the hidden separator widget in sync with the property
        if (name === "_prefixSeparator") {
            const sep = this.widgets?.find(w => w.name === "separator");
            if (sep) sep.value = value;
        }

        if (name === "_tagImageWidth" || name === "_tagImageHeight") {
            this.setDirtyCanvas(true, true);
        }

    };

    // Capture existing onConfigure to allow chaining.
    const existingOnConfigure = node.onConfigure;
    node.onConfigure = function(info) {
        if (existingOnConfigure) {
            existingOnConfigure.apply(this, arguments);
        }

        const sep = this.widgets?.find(w => w.name === "separator");
        if (sep) {
            // Workflows saved before the separator widget existed have one fewer widget value, so positional loading shifts the next widget's value into it.
            // Detect that and hand it back.
            const ctrl = this.widgets?.find(w => w.name === "control_after_generate");
            const seedWidget = this.widgets?.find(w => w.name === "seed");
            const fixed = realignLoadedWidgets({
                separator: sep.value, control: ctrl?.value, seed: seedWidget?.value,
                hasControl: !!ctrl, hasSeed: !!seedWidget,
            });
            sep.value = fixed.separator;
            if (ctrl) ctrl.value = fixed.control;
            if (seedWidget) {
                seedWidget.value = fixed.seed;
                // Loading must never reshuffle. The saved tags are the arrangement this
                // workflow was saved with; re-deriving them here would change someone's
                // prompt just by opening the file.
                this._seedApplied = fixed.seed;
            }

            // Property is the source of truth for the separator
            if (this.properties?._prefixSeparator != null) {
                sep.value = this.properties._prefixSeparator;
            } else if (sep.value == null || sep.value === "") {
                sep.value = ",\\n\\n";
            }
        }

        // Re-derive the text widget from tag data now that properties are loaded (onNodeCreated runs before properties are applied, so the update there ran against empty data).
        this.onUpdateTextWidget?.(this);
    };

    node.convertTo = function(targetNodeType) {
        if (node.type === "ErePromptMultiline") {
            const textWidget = this.widgets.find(w => w.name === "text");
            if (textWidget) {
                const tagData = parseTextToTagData(textWidget.value);
                this.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
            }
        }

        const newNode = LiteGraph.createNode(targetNodeType);
        if (!newNode) {
            console.error(`[EreNodes] Unknown node type: ${targetNodeType}`);
            return;
        }
    
        if(this.properties) {
            newNode.properties = JSON.parse(JSON.stringify(this.properties));
        }
    
        app.graph.add(newNode);
    
        const sourceTextWidget = this.widgets.find(w => w.name === "text");
        const targetTextWidget = newNode.widgets.find(w => w.name === "text");
        if (sourceTextWidget && targetTextWidget) {
            targetTextWidget.value = sourceTextWidget.value;
        }
    
        if (targetNodeType === "ErePromptMultiline") {
            if (newNode.properties) delete newNode.properties._tagDataJSON;
        }
        
        newNode.pos = [this.pos[0], this.pos[1]]; 
        newNode.size = [this.size[0], this.size[1]]; 
        newNode.color = this.color;
        newNode.bgcolor = this.bgcolor;

        if (this.inputs) {
            for (let i = 0; i < this.inputs.length; i++) {
                if (this.inputs[i] && this.inputs[i].link !== null) {
                    const link = app.graph.links[this.inputs[i].link];
                    if (link) {
                        const originNode = app.graph.getNodeById(link.origin_id);
                        if (originNode) originNode.connect(link.origin_slot, newNode, i);
                    }
                }
            }
        }
    
        if (this.outputs) {
            for (let i = 0; i < this.outputs.length; i++) {
                const output = this.outputs[i];
                if (output.links && output.links.length) {
                    const linksToReconnect = [...output.links];
                    for (const linkId of linksToReconnect) {
                        const link = app.graph.links[linkId];
                        if (link) {
                            const targetNode = app.graph.getNodeById(link.target_id);
                            if (targetNode) newNode.connect(i, targetNode, link.target_slot);
                        }
                    }
                }
            }
        }
    
        app.graph.remove(this);
        app.graph.setDirtyCanvas(true, true);
    };

    node.onActionMenu = (e, node) => { 
        const tagData = parseTags(node.properties._tagDataJSON || "[]");

        let options = [
            { content: "Replace Tags from Clipboard", callback: () => node.onClipboardReplace?.() },
            { content: "Add Tags from Clipboard", callback: () => node.onClipboardAppend?.() },
            null,
            // Only while the tag area is capped / manually sized in scroll mode
            ...(node._tagAreaCapped
                ? [{ content: "Fit Height to Tags", callback: () => node.onFitTagArea?.() }]
                : []),
            { content: "Toggle All Tags", callback: () => node.onToggleTags?.() },
            { content: "Remove All Tags", callback: () => node.onRemoveTags?.() },
            { content: "Remove Inactive Tags", callback: () => node.onRemoveTags?.('inactive') },
            null, 
            { content: "Load Tag Group", callback: () => node.onLoadTagGroup?.(e) },
            { content: "Save Tag Group", callback: () => node.onSaveTagGroup?.(e), disabled: tagData.filter(t => t.type !== 'group').length < 2 },
            null, 
            { content: "Export Tags (.json)", callback: () => node.onExportTags?.() },
            { content: "Import Tags (.json)", callback: () => node.onImportTags?.() },
            null, 
            { content: "Convert to Prompt Cloud", callback: () => node.convertTo("ErePromptCloud") },
            { content: "Convert to Prompt MultiSelect", callback: () => node.convertTo("ErePromptMultiSelect") },
            { content: "Convert to Prompt Toggle", callback: () => node.convertTo("ErePromptToggle") },
            { content: "Convert to Prompt Multiline", callback: () => node.convertTo("ErePromptMultiline") },
            { content: "Convert to Prompt Randomizer", callback: () => node.convertTo("ErePromptRandomizer") },
            { content: "Convert to Prompt Gallery", callback: () => node.convertTo("ErePromptGallery") },
        ];

        if (node.type === "ErePromptMultiline") {
            options = options.filter(option => !option || option.content !== "Toggle All Tags");
        }

        options = options.filter(option => !option || option.content !== "Convert to " + node.title);

        new LiteGraph.ContextMenu(options, { event: e, className: "dark", node }, window);

    };

    node.onLoadTagGroup = (e) => {
        
        const addTagObject = async (tagObject) => {
            if (!tagObject || !tagObject.name) return;

            let resolvedGroupTags;
            try {
                let url;
                url = `/erenodes/get_tag_group?filename=${encodeURIComponent(tagObject.name + tagObject.extension)}`;
                const groupTags = getCache(url, 'json');
                resolvedGroupTags = groupTags instanceof Promise ? await groupTags : groupTags;
            } catch (error) {
                console.error("[EreNodes] Error loading tag group.", error);
                app.extensionManager?.toast?.add({
                    severity: "error",
                    summary: "Load Error",
                    detail: `Could not read tag group '${tagObject.name}'.`,
                    life: 5000
                });
                return;
            }

            if (!Array.isArray(resolvedGroupTags)) {
                console.error("[EreNodes] Tag group is not an array:", tagObject.name, resolvedGroupTags);
                app.extensionManager?.toast?.add({
                    severity: "error",
                    summary: "Invalid Tag Group",
                    detail: `'${tagObject.name}' does not contain a list of tags.`,
                    life: 5000
                });
                return;
            }

            if (node.type !== "ErePromptMultiline") {
                const existingTagData = parseTags(node.properties._tagDataJSON || "[]");
                const existingTagNames = new Set(existingTagData.map(t => t.name));

                // Check if tag group already exists by name and type
                const existingTagSet = new Set(existingTagData.map(t => `${t.name}_${t.type || 'tag'}`));
                const uniqueNewTagObjects = resolvedGroupTags.filter(tagObj => 
                    tagObj.name && !existingTagSet.has(`${tagObj.name}_${tagObj.type || 'tag'}`)
                );

                if (!uniqueNewTagObjects.length) return;

                const combinedTagData = existingTagData.concat(uniqueNewTagObjects);
                node.properties._tagDataJSON = JSON.stringify(combinedTagData, null, 2);
                node.onUpdateTextWidget(node);
            } else { // Handles ErePromptMultiline
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) {
                    const separator = (node.properties._tagSeparator || ", ").replace(/\\n/g, "\n");
                    const newTagsString = resolvedGroupTags.map(formatTag).join(separator);
                    
                    if (textWidget.value) {
                        let cleanedExistingText = textWidget.value.replace(/[, \t\n]+$/, "");
                        if (cleanedExistingText) { // If anything remains after cleaning
                            textWidget.value = cleanedExistingText + separator + newTagsString;
                        } else { // Existing text was only separators/whitespace
                            textWidget.value = newTagsString;
                        }
                    } else {
                        // If the text widget is empty, just set it to the new tags.
                        textWidget.value = newTagsString;
                    }
                }
            }

            app.graph.setDirtyCanvas(true);
        };

        const LoadGroupMenu = new TagGroupContextMenu(e, addTagObject, 'group', 'load'); // open in load mode
        LoadGroupMenu.show();

    };

    /**
     * @param {?{tags, indices}} subset  a pill multi-selection: only these are saved, and "save and convert" replaces only them.
     */
    node.onSaveTagGroup = (e, subset = null) => {

        const saveTagObject = async (tagObject) => {
            try {
                let tagDataToSave;
                if (subset) {
                    tagDataToSave = subset.tags.map(t => ({ ...t }));
                } else if (node.properties._tagDataJSON !== undefined) {
                    tagDataToSave = parseTags(node.properties._tagDataJSON || "[]");
                } else {
                    const textWidget = node.widgets.find(w => w.name === "text");
                    tagDataToSave = parseTextToTagData(textWidget ? textWidget.value : "");
                }

                tagDataToSave = stripNestedGroups(tagDataToSave);

                await saveTagGroup({
                    path: tagObject.path,
                    filename: tagObject.filename,
                    tags: tagDataToSave,
                    imageFile: tagObject.imageFile,
                });
            } catch (error) {
                console.error('[EreNodes] Error saving tag group:', error);
                app.extensionManager.toast.add({
                    severity: "error",
                    summary: "Save Operation Error",
                    detail: error.message,
                    life: 5000
                });
            }
        }

        const SaveGroupMenu = new TagGroupContextMenu(e, saveTagObject, 'group', 'save'); // open in load mode
        SaveGroupMenu.show();
    };

    node.onClipboardReplace = () => {
        navigator.clipboard.readText().then(async text => {
            // Empty clipboard must not wipe the node's tags
            if (!text || !text.trim()) return;
            if (node.type !== "ErePromptMultiline") {
                const tagStrings = (text.replace(/\n/g, ',').split(/,(?![^()]*\))/g) || [])
                    .map(s => s.trim())
                    .filter(s => s);

                const tagData = tagStrings.map(parseTag).filter(Boolean);
                const json = JSON.stringify(tagData, null, 2);
                node.properties._tagDataJSON = json;
                await node.onUpdateTextWidget(node);
                app.graph.setDirtyCanvas(true);
            } else {
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) {
                    textWidget.value = text;
                }
            }
        });
    };

    node.onClipboardAppend = () => {
        navigator.clipboard.readText().then(async text => {
            if (node.type !== "ErePromptMultiline") {
                const newTagStrings = (text.replace(/\n/g, ',').split(/,(?![^()]*\))/g) || [])
                    .map(s => s.trim())
                    .filter(s => s);
                if (!newTagStrings.length) return;
                const existingTagData = parseTags(node.properties._tagDataJSON || "[]");
                const existingTagNames = new Set(existingTagData.map(t => t.name));

                const uniqueNewTags = newTagStrings
                    .map(parseTag)
                    .filter(Boolean)
                    .filter(tagObj => tagObj.name && !existingTagNames.has(tagObj.name));

                if (!uniqueNewTags.length) return;
                
                const combinedTagData = existingTagData.concat(uniqueNewTags);
                node.properties._tagDataJSON = JSON.stringify(combinedTagData, null, 2);
                await node.onUpdateTextWidget(node);
                app.graph.setDirtyCanvas(true);
            } else {
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) {
                    textWidget.value += (textWidget.value ? "\n" : "") + text;
                }
            }
        });
    };

    node.onToggleTags = async () => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (!tagData.length) return;

        const anyActive = tagData.some(tag => tag.active && tag.name);
        const allTargetState = !anyActive;

        const updatedTagData = tagData.map(tag => ({ ...tag, active: tag.name ? allTargetState : tag.active }));

        node.properties._tagDataJSON = JSON.stringify(updatedTagData, null, 2);
        await node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };
    
    node.onRemoveTags = (mode = 'all') => {
        if(node.properties._tagDataJSON !== undefined) {
            if (mode === 'all') {
                node.properties._tagDataJSON = "[]"; 
            } else if (mode === 'inactive') {
                const tagData = parseTags(node.properties._tagDataJSON || "[]");
                const activeTags = tagData.filter(t => t.active);
                node.properties._tagDataJSON = JSON.stringify(activeTags);
            }
        }
        if (textWidget && mode === 'all') {
            textWidget.value = "";
        }
        node.setDirtyCanvas(true);
        app.graph.setDirtyCanvas(true);
        // Undo step for tag removal (doesn't go through onUpdateTextWidget)
        captureUndoState();
    };

    /** @param {?Array} subsetTags export only these (pill multi-selection). */
    node.onExportTags = async (subsetTags = null) => {
        let fileName = await getTextInput("Export Tags", "Enter filename for export (e.g., my_tags.json):", "");
        if (fileName === false || fileName === null) return;

        fileName = String(fileName).trim();
        if (!fileName.toLowerCase().endsWith('.json')) fileName += '.json';

        let jsonString;
        if (subsetTags) {
            jsonString = JSON.stringify(subsetTags, null, 2);
        } else if (node.properties._tagDataJSON !== undefined) {
            jsonString = node.properties._tagDataJSON || "[]";
        } else {
            const tagData = parseTextToTagData(textWidget.value);
            jsonString = JSON.stringify(tagData, null, 2);
        }
 
        const blob = new Blob([jsonString], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    node.onImportTags = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.onchange = e => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = readerEvent => {
                try {
                    const content = readerEvent.target.result;
                    const importedData = JSON.parse(content);
                    if (Array.isArray(importedData)) {
                        const uniqueValidTags = dedupeTags(importedData.filter(
                            tag => typeof tag.name === 'string' && typeof tag.active === 'boolean'));

                        if (uniqueValidTags.length === 0 && importedData.length > 0) return;

                        if (node.type !== "ErePromptMultiline") {
                            node.properties._tagDataJSON = JSON.stringify(uniqueValidTags, null, 2);
                            node.onUpdateTextWidget(node);
                        } else {
                            const textWidget = node.widgets.find(w => w.name === "text");
                            if(textWidget) {
                                const lines = uniqueValidTags.map(formatTag).join("\n");
                                textWidget.value = lines;
                            }
                        }
                        app.graph.setDirtyCanvas(true);
                    }
                } catch (err) {
                     console.error('[EreNodes] Error importing tags:', err);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    };

    /**
     * Lay the tags out for a seed: same seed, same tags, same result — which is the point of having one.
     * How many tags are on is preserved; *which* ones and in what order is what the seed decides.
     */
    node.onApplySeed = async (seed) => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (tagData.length < 2) return;
        node._seedApplied = normalizeSeed(seed);
        node.properties._tagDataJSON = JSON.stringify(arrangementForSeed(tagData, seed), null, 2);
        await node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };

    /**
     * Re-lay the tags if the seed has moved since they were laid out.
     *
     * Idempotent by design, and that is what lets several triggers share it: the seed widget's callback (typed in), `control_after_generate`'s `afterQueued` (stepped per queued prompt), and the `execution_success` safety net all call this, and only the first one to see a new value does any work.
     */
    node.onSeedChanged = async () => {
        const widget = node.widgets?.find(w => w.name === "seed");
        if (!widget) return;
        const seed = normalizeSeed(widget.value);
        if (seed === node._seedApplied) return;
        await node.onApplySeed(seed);
    };

    /**
     * Roll a new seed and lay the tags out for it — the dice button.
     *
     * The seed is written to the widget before it is used, so the number on screen is always the one that produced what you are looking at. This is the manual form of `control_after_generate: randomize`.
     */
    node.onRandomize = async (e, pos) => {
        const seed = Math.floor(Math.random() * (DICE_SEED_MAX + 1));
        const widget = node.widgets?.find(w => w.name === "seed");
        // Assigning .value does not fire a widget callback, so this cannot recurse.
        if (widget) widget.value = seed;
        await node.onApplySeed(seed);
    };

    node.onAddTag = (e, pos) => {
        const addTagObject = async (tagObject) => {
            if (!tagObject || !tagObject.name) return;

            const existingTagData = parseTags(node.properties._tagDataJSON || "[]");
            const existingTagNames = new Set(existingTagData.map(t => t.name));

            if (existingTagNames.has(tagObject.name)) {
                return; // Tag already exists, do nothing
            }

            const newTag = { ...tagObject, active: true };
            
            const combinedTagData = existingTagData.concat(newTag);
            node.properties._tagDataJSON = JSON.stringify(combinedTagData, null, 2);
            await node.onUpdateTextWidget(node);
            app.graph.setDirtyCanvas(true);
        };
        
        const existingTags = parseTags(node.properties._tagDataJSON || "[]")
            .map(tag => ({ name: tag.name, type: tag.type }));
        
        new TagContextMenuInsert(e, addTagObject, existingTags);
    };

    node.onTagPillClick = async (e, pos, clickedPill) => {
        if (!clickedPill) return;
        
        if (clickedPill.label === "button_menu") {
            return node.onActionMenu?.(e, node);
        }        
        
        if (clickedPill.label === "button_add_tag") {
            return node.onAddTag?.(e, pos);
        }
        
        if (clickedPill.label === "button_randomize") {
            return node.onRandomize?.(e, clickedPill);
        }

        if (clickedPill.label === "button_show_inactive") {
            // Deliberately on the node instance, not in properties: it is a way of looking at the node, not part of what the node *is*, so it stays out of saved workflows and resets on reload.
            node._showInactive = !node._showInactive;
            node._ereDom?.render?.();
            app.graph.setDirtyCanvas(true);
            return;
        }

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        // Index first: a name lookup collides when two tags share a name.
        const clickedTag = (clickedPill.index != null)
            ? tagData[clickedPill.index]
            : tagData.find(t => t.name === clickedPill.label);
        if (!clickedTag) return;

        clickedTag.active = !clickedTag.active;
        node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
        await node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };
    
    node.onTagQuickEdit = async function(event, nodeInstance, clickedPill) {
        if (!clickedPill) return;

        const tagData = parseTags(nodeInstance.properties._tagDataJSON || "[]");
        let tagIndex = (clickedPill.index != null)
            ? clickedPill.index
            : tagData.findIndex(t => t.name === clickedPill.label);
        if (tagIndex < 0 || tagIndex >= tagData.length) return;
        
        let clickedTag = tagData[tagIndex];

        const unpackCallback = async () => {
            const currentTagData = parseTags(nodeInstance.properties._tagDataJSON || "[]");
            const groupTag = currentTagData[tagIndex];
            if (!groupTag || groupTag.type !== 'group') return;

            try {
                const filename = groupTag.extension ? `${groupTag.name}${groupTag.extension}` : groupTag.name;
                const groupContentResult = getCache(`/erenodes/get_tag_group?filename=${encodeURIComponent(filename)}`, 'json');
                const originalGroupTags = await (groupContentResult instanceof Promise ? groupContentResult : Promise.resolve(groupContentResult));

                if (originalGroupTags && Array.isArray(originalGroupTags)) {
                    const unpackedTags = JSON.parse(JSON.stringify(originalGroupTags));
                    if (groupTag.modified) {
                        unpackedTags.forEach(t => {
                            if (groupTag.modified.hasOwnProperty(t.name)) {
                                t.active = groupTag.modified[t.name];
                            }
                        });
                    }
                    
                    // Replace the group tag with its unpacked contents
                    currentTagData.splice(tagIndex, 1, ...unpackedTags);
                    
                    nodeInstance.properties._tagDataJSON =
                        JSON.stringify(dedupeTags(currentTagData), null, 2);
                    await nodeInstance.onUpdateTextWidget(nodeInstance);
                    app.graph.setDirtyCanvas(true);
                }
            } catch (error) {
                console.error(`[EreNodes] Failed to unpack tag group: ${groupTag.name}`, error);
            }
        };

        const saveCallback = async (editedTag) => {
            const currentTagData = parseTags(nodeInstance.properties._tagDataJSON || "[]");
            
            // Use the stored index instead of searching by name
            if (tagIndex < 0 || tagIndex >= currentTagData.length) {
                console.error("[EreNodes] Quick-edit save failed: invalid tag index.", tagIndex);
                return;
            }

            let finalTag;
            const isSpecialType = ['lora', 'embedding', 'group'].includes(clickedTag.type);

            if (isSpecialType) {
                // Start with clickedTag to preserve properties like 'active', 'extension', etc.
                finalTag = { ...clickedTag };
                // Overwrite with all defined properties from editedTag This includes name (if changed by file selection) and potentially strength (if not 1.0)
                for (const key in editedTag) {
                    if (editedTag.hasOwnProperty(key)) {
                        finalTag[key] = editedTag[key];
                    }
                }
                /** If updateTag deleted strength from editedTag (because it was 1.0), ensure it's also removed/undefined in finalTag. */
                if (editedTag.strength === undefined) {
                    delete finalTag.strength;
                }
                // Ensure triggers from editedTag are used, or default to empty if not present in either
                if (editedTag.hasOwnProperty('triggers')) {
                    finalTag.triggers = editedTag.triggers;
                } else if (!finalTag.hasOwnProperty('triggers')) {
                    finalTag.triggers = [];
                }
            } else {
                // For normal tags, parse the full input value as it might have changed.
                const parsed = parseTag(editedTag.name.trim());
                if (!parsed) {
                    deleteCallback(); // If parsing fails (e.g., empty input), delete the tag.
                    return;
                }
                // Combine the original tag's properties (like 'active' state) with the newly parsed data and edited properties.
                finalTag = { ...clickedTag, ...parsed, strength: editedTag.strength, triggers: editedTag.triggers, active: clickedTag.active };
            }

            currentTagData[tagIndex] = finalTag;
            nodeInstance.properties._tagDataJSON = JSON.stringify(currentTagData, null, 2);
            await nodeInstance.onUpdateTextWidget(nodeInstance);
            app.graph.setDirtyCanvas(true);

            // After a successful save, update the reference for the next save operation from the same menu.
            clickedTag = JSON.parse(JSON.stringify(finalTag));
        };

        const deleteCallback = async () => {
            const currentTagData = parseTags(nodeInstance.properties._tagDataJSON || "[]");
            if (tagIndex >= 0 && tagIndex < currentTagData.length) {
                currentTagData.splice(tagIndex, 1);
                nodeInstance.properties._tagDataJSON = JSON.stringify(currentTagData, null, 2);
                await nodeInstance.onUpdateTextWidget(nodeInstance);
                app.graph.setDirtyCanvas(true);
            }
        };

        const imageCallback = () => {
            if (nodeInstance) {
                // Redraw the node to reflect the new image
                nodeInstance.setDirtyCanvas(true, true);
            }
        };

        // Calculate existing tags for file filtering
        const existingTags = tagData.map(tag => ({ name: tag.name, type: tag.type }));
        
        // The 'event' parameter (which is positionEvent from applyContextMenuPatch) now has clientX and clientY correctly set.
        new TagEditContextMenu(event, clickedTag, saveCallback, deleteCallback, imageCallback, unpackCallback, tagIndex, existingTags);
    };
    
    node.onUpdateTextWidget = async (node) => {
        const textWidget = node.widgets.find(w => w.name === "text");
        if (!textWidget) return;

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (tagData.length === 0) {
            textWidget.value = "";
            return;
        }
        const activeTags = tagData.filter(t => (t.active && t.name) );

        let tagSeparator = (node.properties._tagSeparator || ", ").replace(/\\n/g, "\n");

        const parts = [];
        let currentLineTags = [];

        for (const tag of activeTags) {
            if (tag.type === 'group') {
                // If we have pending tags, join and add them before processing the group.
                if (currentLineTags.length > 0) {
                    const line = currentLineTags.join(tagSeparator);

                    // If there are already parts, and the last part is content (not a separator/newline), then we need to add a separator before adding this new line of content.
                    if (parts.length > 0 && parts[parts.length - 1] !== tagSeparator && parts[parts.length - 1].trim() !== '') {
                        parts.push(tagSeparator);
                    }
                    parts.push(line);
                    currentLineTags = [];
                }
                try {
                    const filename = tag.extension ? `${tag.name}${tag.extension}` : tag.name;
                    const groupTagDataResult = getCache(`/erenodes/get_tag_group?filename=${encodeURIComponent(filename)}`, 'json');
                    const groupTagData = groupTagDataResult instanceof Promise ? await groupTagDataResult : groupTagDataResult;
                    if (groupTagData) {
                        if (Array.isArray(groupTagData)) {
                            const activeGroupTags = groupTagData.filter(t => t.active && t.name);
                            if (activeGroupTags.length > 0) {
                                if (parts.length > 0 && parts[parts.length - 1].trim() !== '') {
                                    parts.push(tagSeparator);
                                }
                                
                                const groupParts = [];
                                activeGroupTags.forEach(gTag => {
                                    groupParts.push(formatTag(gTag));
                                    if (gTag.type === 'lora' && gTag.triggers && gTag.triggers.length > 0) {
                                        groupParts.push(...gTag.triggers);
                                    }
                                });
                                let groupPart = groupParts.join(tagSeparator);

                                if (tag.strength && tag.strength !== 1.0) {
                                    const strengthValue = parseFloat(tag.strength);
                                    if (!isNaN(strengthValue) && strengthValue !== 1.0) {
                                        groupPart = `(${groupPart}:${strengthValue.toFixed(2)})`;
                                    }
                                }
                                parts.push(groupPart);
                            }
                        }
                    }
                } catch (error) {
                    console.error(`[EreNodes] Failed to load and parse tag group: ${tag.name}`, error);
                }
            } else {
                currentLineTags.push(formatTag(tag));
                if (tag.type === 'lora' && tag.triggers && tag.triggers.length > 0) {
                    currentLineTags.push(...tag.triggers);
                }
            }
        }

        if (currentLineTags.length > 0) {
            const line = currentLineTags.join(tagSeparator);

            // If there are already parts, and the last part is content (not a separator/newline), then we need to add a separator before adding this new line of content.
            if (parts.length > 0 && parts[parts.length - 1] !== tagSeparator && parts[parts.length - 1].trim() !== '') {
                parts.push(tagSeparator);
            }
            parts.push(line);
        }

        // Remove trailing separator if 'parts' ends with it and has more than one element.
        if (parts.length > 1 && parts[parts.length - 1] === tagSeparator) {
            parts.pop();
        }

        // For multiline nodes, don't modify the text widget content when updating separators
        if (node.type !== "ErePromptMultiline") {
            // Filter out any empty strings that might result from consecutive separators or separators at the beginning/end without content.
            let currentText = parts.filter(part => part.trim() !== '' || part === tagSeparator).join('');
            // If the final result is just the separator itself (e.g. only a separator was active), make it empty.
            if (currentText === tagSeparator && activeTags.filter(t => t.type !== 'group').length === 0) {
                currentText = '';
            }

            // Python will now handle prefix logic, so we just set the current text
            textWidget.value = currentText;
        }
        // For multiline nodes, preserve the existing text content

        // Undo checkpoint — no-op when nothing actually changed (the tracker diffs serialized state), so calls during workflow load are safe.
        captureUndoState();
    };

}

