import { app } from "../../scripts/app.js";
import { TagContextMenuInsert, TagEditContextMenu, TagGroupContextMenu, DynamicContextMenu } from "./js/contextmenu.js";
import { getCache, updateCache, clearCache, clearCachePrefix } from "./js/cache.js";
import { captureUndoState } from "./js/undo.js";


const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

/**
 * Write a tag group to disk.
 *
 * Extracted from onSaveTagGroup so the sidebar can save through exactly the
 * same path (overwrite confirmation, cache invalidation, toasts) instead of
 * growing a second, subtly different implementation.
 *
 * @param {object} opts
 * @param {string} [opts.path]      folder relative to the tag-group root
 * @param {string} opts.filename    ".json" is appended if missing
 * @param {Array<object>} opts.tags
 * @param {File} [opts.imageFile]   optional preview image
 * @param {boolean} [opts.overwriteSilently] skip the "already exists" prompt
 * @returns {Promise<{ok: boolean, cancelled?: boolean, message?: string, fullPath: string}>}
 */
export async function saveTagGroup({ path = "", filename, tags, imageFile, overwriteSilently = false }) {
    const name = filename.toLowerCase().endsWith(".json") ? filename : `${filename}.json`;
    const fullPath = path ? `${path}/${name}` : name;

    try {
        if (!overwriteSilently) {
            const checkResponse = await fetch(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);
            if (checkResponse.ok) {
                // app.ui.dialog.show() is not a confirm dialog (returns nothing);
                // use the extensionManager confirm dialog with a window.confirm fallback.
                const message = `Tag group '${name}' already exists. Do you want to overwrite it?`;
                const confirmed = app.extensionManager?.dialog?.confirm
                    ? await app.extensionManager.dialog.confirm({ title: "File Exists", message })
                    : window.confirm(message);
                if (!confirmed) return { ok: false, cancelled: true, fullPath };
            }
        }

        clearCache(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);
        // Also invalidate cached preview thumbnails for this group
        // (src entries carry query strings, so prefix-match).
        clearCachePrefix(`/erenodes/view/group/${fullPath.replace(/\.json$/i, "")}`);

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

/** Strip tag groups from a list — nesting a group inside a group is not allowed. */
export function stripNestedGroups(tags, { warn = true } = {}) {
    const groups = tags.filter(tag => tag.type === 'group');
    if (!groups.length) return tags;
    if (warn) {
        app.extensionManager?.toast?.add({
            severity: "warn",
            summary: "Nested tag groups not allowed.",
            detail: `${groups.length} tag group(s) skipped in saving.`,
            life: 6000,
        });
    }
    return tags.filter(tag => tag.type !== 'group');
}

function parseTag(tagString) {
    let originalString = (tagString || "").trim();
    if (!originalString) return null;

    const groupMatch = originalString.match(/^group:(.+)$/);
    if (groupMatch) {
        return { name: groupMatch[1], type: 'group', active: true };
    }

    const loraMatch = originalString.match(/^<lora:([^:]+)(?::([\d.-]+))?>$/);
    if (loraMatch) {
        const name = loraMatch[1];
        let strength = loraMatch[2] ? parseFloat(loraMatch[2]) : undefined;
        if (strength === 1.0 || isNaN(strength)) strength = undefined;
        
        return { name: name, type: 'lora', strength, active: true };
    }

    let name = originalString;
    let strength;

    const strengthMatch = name.match(/^\((.*):([\d.-]+)\)$/);
    if (strengthMatch) {
        name = strengthMatch[1].trim();
        strength = parseFloat(strengthMatch[2]);
        if (isNaN(strength) || strength === 1.0) {
            strength = undefined;
        }
    }

    let type = 'tag';
    if (name.startsWith('embedding:')) {
        type = 'embedding';
        name = name.substring('embedding:'.length);
    }

    return { name, type, strength, active: true };
}

function formatTag(tag) {

    if (tag.type === 'lora') {
        const strength = (tag.strength === undefined) ? 1.0 : tag.strength;
        const strengthStr = (strength % 1 === 0) ? strength.toFixed(1) : strength;
        const filename = tag.extension ? `${tag.name}${tag.extension}` : tag.name;
        return `<lora:${filename}:${strengthStr}>`;
    }

    if (tag.type === 'embedding') {
        return `embedding:${tag.name}`;
    }

    if (tag.type === 'group') {
        const filename = tag.extension ? `${tag.name}${tag.extension}` : tag.name;
        return `group:${filename}`;
    }

    if (tag.strength && tag.strength !== 1.0) {
        return `(${tag.name}:${tag.strength})`;
    }

    return tag.name;
}

function parseTextToTagData(text, oldTagData = []) {
    const oldTagsByName = new Map(oldTagData.map(t => [t.name, t]));
    const lines = (text || "").split('\n');
    const tagData = [];
    let lastLineWasEmpty = false;

    for (const line of lines) {
        const trimmedLine = line.trim();

        const tagStrings = (trimmedLine.split(/,(?![^()]*\))/g) || [])
            .map(s => s.trim())
            .filter(s => s);
        
        const newTags = tagStrings.map(parseTag).filter(Boolean);

        if (newTags.length > 0) {
            for (const tag of newTags) {
                const oldTag = oldTagsByName.get(tag.name);
                if (oldTag) {
                    tag.active = oldTag.active;
                } else {
                    tag.active = true; 
                }
            }
            tagData.push(...newTags);
            lastLineWasEmpty = false;
        }
    }
    
    const finalTagData = [];
    const seenNames = new Set();
    for (const tag of tagData) {
        if (tag.name && !seenNames.has(tag.name)) {
            finalTagData.push(tag);
            seenNames.add(tag.name);
        }
    }
    return finalTagData;
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

// Global keyboard shortcuts for tag nodes (Ctrl+V paste). The old
// processContextMenu hijack for pill right-clicks is gone: quick edit is
// handled by DOM contextmenu listeners on the pills (renderer.js).
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
                    // Block ComfyUI's paste handler NOW: it pastes its internal
                    // node clipboard regardless of what the system clipboard
                    // holds, so letting it run alongside us duplicated the last
                    // copied node on every tag paste. We then decide by system
                    // clipboard content: tag text → paste tags; JSON or empty
                    // (a copied node / nothing) → hand the paste back to
                    // ComfyUI manually.
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

    // --- separator widget bridge ---
    // User edits _prefixSeparator in the Properties panel (works in both
    // renderers). Python's process() only receives widget/input values, not
    // node.properties — so this hidden widget mirrors the property for the
    // backend. onConfigure also repairs old workflows where positional widget
    // values shifted when this input was first added.
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
    // Runs after a workflow's properties/widget values have been applied.
    const existingOnConfigure = node.onConfigure;
    node.onConfigure = function(info) {
        if (existingOnConfigure) {
            existingOnConfigure.apply(this, arguments);
        }

        const sep = this.widgets?.find(w => w.name === "separator");
        if (sep) {
            // Migration: workflows saved before the separator widget existed
            // have one fewer widget value, so positional loading can shift the
            // next widget's value (randomizer's control combo, multiline's
            // placeholder button) into the separator slot. Detect and repair.
            const ctrl = this.widgets?.find(w => w.name === "control after generate");
            const controlModes = ["fixed", "increment", "decrement", "randomize"];
            if (ctrl && (ctrl.value === undefined || ctrl.value === null) && controlModes.includes(sep.value)) {
                ctrl.value = sep.value;
                sep.value = null;
            } else if (sep.value === "fake_button") {
                sep.value = null;
            }

            // Property is the source of truth for the separator
            if (this.properties?._prefixSeparator != null) {
                sep.value = this.properties._prefixSeparator;
            } else if (sep.value == null || sep.value === "") {
                sep.value = ",\\n\\n";
            }
        }

        // Re-derive the text widget from tag data now that properties are
        // loaded (onNodeCreated runs before properties are applied, so the
        // update there ran against empty data).
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

            // This used to `throw` from a bare async callback — nothing caught
            // it, so a malformed file produced an unhandled rejection and no
            // user-visible feedback at all.
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
                    // Use the node's specified tagSeparator, defaulting to ", "
                    // And ensure \n in the separator string becomes an actual newline
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
     * @param {*} e             positioning event for the menu
     * @param {?{tags: Array, indices: number[]}} subset
     *        When given (pill multi-selection), only those tags are saved and
     *        "save and convert" replaces just them — the rest of the node is
     *        left alone.
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

                const originalTagData = [...tagDataToSave];
                tagDataToSave = stripNestedGroups(tagDataToSave);

                const saved = await saveTagGroup({
                    path: tagObject.path,
                    filename: tagObject.filename,
                    tags: tagDataToSave,
                    imageFile: tagObject.imageFile,
                });
                if (saved.cancelled || !saved.ok) return;
                {
                    // Replace saved tags with new group tag if requested
                    if (tagObject.shouldReplace) {
                        const groupName = tagObject.path ? `${tagObject.path}/${tagObject.filename.replace('.json', '')}` : tagObject.filename.replace('.json', '');
                        const newGroupTag = { name: groupName, type: 'group', active: true, extension: '.json' };

                        let finalTagData;
                        if (subset) {
                            // Swap just the selected tags for the group pill,
                            // in place. Indices are ascending, so the first one
                            // is also the insert position after the removal.
                            const all = parseTags(node.properties._tagDataJSON || "[]");
                            const drop = new Set(subset.indices);
                            const at = Math.min(...subset.indices);
                            finalTagData = all.filter((_, i) => !drop.has(i));
                            finalTagData.splice(at, 0, newGroupTag);
                        } else {
                            finalTagData = [...originalTagData.filter(tag => tag.type === 'group'), newGroupTag];
                        }

                        node.properties._tagDataJSON = JSON.stringify(finalTagData, null, 2);
                        if (node.onUpdateTextWidget) {
                            node.onUpdateTextWidget(node);
                        }
                        app.graph.setDirtyCanvas(true);
                    }
                }
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
                        const seenNames = new Set();
                        const uniqueValidTags = [];
                        for (const tag of importedData) {
                            if (typeof tag.name === 'string' && typeof tag.active === 'boolean') {
                                if (!seenNames.has(tag.name)) {
                                    uniqueValidTags.push(tag);
                                    seenNames.add(tag.name);
                                }
                            }
                        }

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

    node.onRandomize = (e, pos) => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        const activeCount = tagData.filter(t => t.active).length;

        tagData.forEach(t => t.active = false);

        for (let i = tagData.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tagData[i], tagData[j]] = [tagData[j], tagData[i]];
        }

        for (let i = 0; i < activeCount; i++) {
            if (tagData[i]) {
                tagData[i].active = true;
            }
        }
        
        node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
        node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
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

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        // Prefer the pill's tag index (set by nodes with index-aware pill maps,
        // e.g. the gallery) - name lookup collides when two tags share a name.
        const clickedTag = (clickedPill.index != null)
            ? tagData[clickedPill.index]
            : tagData.find(t => t.name === clickedPill.label);
        if (!clickedTag) return;

        clickedTag.active = !clickedTag.active;
        node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
        await node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };
    
    node.onTagQuickEdit = async function(event, nodeInstance, clickedPill, nodeScreenWidth) { // Added nodeScreenWidth
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
                    
                    // Remove duplicates that might have been introduced
                    const finalTagData = [];
                    const seenNames = new Set();
                    for (const tag of currentTagData) {
                        if (!seenNames.has(tag.name)) {
                            finalTagData.push(tag);
                            seenNames.add(tag.name);
                        }
                    }

                    nodeInstance.properties._tagDataJSON = JSON.stringify(finalTagData, null, 2);
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
                // Overwrite with all defined properties from editedTag
                // This includes name (if changed by file selection) and potentially strength (if not 1.0)
                for (const key in editedTag) {
                    if (editedTag.hasOwnProperty(key)) {
                        finalTag[key] = editedTag[key];
                    }
                }
                // If updateTag deleted strength from editedTag (because it was 1.0),
                // ensure it's also removed/undefined in finalTag.
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

        // Reordering lives in the drag & drop layer (web/js/dragdrop.js) now —
        // the quick edit menu no longer carries Move Up / Move Down.

        const imageCallback = () => {
            if (nodeInstance) {
                // Redraw the node to reflect the new image
                nodeInstance.setDirtyCanvas(true, true);
            }
        };

        // Calculate existing tags for file filtering
        const existingTags = tagData.map(tag => ({ name: tag.name, type: tag.type }));
        
        // The 'event' parameter (which is positionEvent from applyContextMenuPatch)
        // now has clientX and clientY correctly set.
        new TagEditContextMenu(event, clickedTag, saveCallback, deleteCallback, imageCallback, unpackCallback, tagIndex, nodeScreenWidth, existingTags);
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

                    // If there are already parts, and the last part is content (not a separator/newline),
                    // then we need to add a separator before adding this new line of content.
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

            // If there are already parts, and the last part is content (not a separator/newline),
            // then we need to add a separator before adding this new line of content.
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
            // Filter out any empty strings that might result from consecutive separators
            // or separators at the beginning/end without content.
            let currentText = parts.filter(part => part.trim() !== '' || part === tagSeparator).join('');
            // If the final result is just the separator itself (e.g. only a separator was active), make it empty.
            if (currentText === tagSeparator && activeTags.filter(t => t.type !== 'group').length === 0) {
                currentText = '';
            }

            // Python will now handle prefix logic, so we just set the current text
            textWidget.value = currentText;
        }
        // For multiline nodes, preserve the existing text content

        // Undo checkpoint — no-op when nothing actually changed (the tracker
        // diffs serialized state), so calls during workflow load are safe.
        captureUndoState();
    };

}

