import { app } from "../../scripts/app.js";
import { TagContextMenuInsert, TagEditContextMenu, TagGroupContextMenu, DynamicContextMenu } from "./js/contextmenu.js";
import { getCache, updateCache, clearCache } from "./js/cache.js";


const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

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
    const value = prompt(promptMessage, defaultValue);
    if (value === null) return false; 
    return value;
};


// Custom hijack of the context menu to allow for quick edit of tags on right click
let contextMenuPatched = false;
const ERE_TAG_NODE_TYPES = ["ErePromptCloud", "ErePromptToggle", "ErePromptMultiSelect", "ErePromptRandomizer", "ErePromptGallery"];

let stylesInjected = false;
function injectSpinnerHidingStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
        .erenodes-quick-edit-input::-webkit-outer-spin-button,
        .erenodes-quick-edit-input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        .erenodes-quick-edit-input {
            -moz-appearance: textfield;
        }
    `;
    document.head.appendChild(style);
}

export function applyContextMenuPatch() {
    if (contextMenuPatched) {
        return;
    }
    contextMenuPatched = true;

    injectSpinnerHidingStyles();

    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
            const activeElement = document.activeElement;
            if (activeElement && (activeElement.nodeName === 'INPUT' || activeElement.nodeName === 'TEXTAREA' || activeElement.hasAttribute('contenteditable'))) {
                return;
            }

            const selectedNodes = Object.values(app.canvas.selected_nodes || {});
            if (selectedNodes.length === 1) {
                const node = selectedNodes[0];
                if (node && ERE_TAG_NODE_TYPES.includes(node.constructor.type)) {
                    e.preventDefault();
                    e.stopPropagation();
                    const pasteBehaviour = app.ui.settings.getSettingValue('EreNodes.Nodes.PasteAction', 'Replace tags');
                    if (pasteBehaviour === 'Append tags') {
                        node.onClipboardAppend();
                    } else {
                        node.onClipboardReplace();
                    }
                }
            }
        }
    });

    const canvasPrototype = app.canvas.constructor.prototype;
    const orig_processContextMenu = canvasPrototype.processContextMenu;

    canvasPrototype.processContextMenu = function(node, e) {
        // Check if it's one of our target nodes
        if (node && ERE_TAG_NODE_TYPES.includes(node.constructor.type)) {
            const canvas_pos = this.convertEventToCanvasOffset(e);
            const node_pos = [canvas_pos[0] - node.pos[0], canvas_pos[1] - node.pos[1]];

            if (node._pillMap) {
                for (const pill of node._pillMap) {
                    if (node_pos[0] >= pill.x && node_pos[0] <= pill.x + pill.w &&
                        node_pos[1] >= pill.y && node_pos[1] <= pill.y + pill.h) {
                        
                        const scale = app.canvas.ds.scale;

                        // node_pos is the click relative to the node's top-left, in canvas units.
                        // pill.x, pill.y, pill.h are relative to the node's top-left, in canvas units.

                        // Pill's bottom-left corner, relative to the node's top-left (canvas units)
                        const pillNodeRelativeBottomLeftX = pill.x;
                        const pillNodeRelativeBottomLeftY = pill.y + pill.h;

                        // Delta from the click point (within the node) to the pill's bottom-left (within the node), in canvas units
                        const deltaCanvasX = pillNodeRelativeBottomLeftX - node_pos[0];
                        const deltaCanvasY = pillNodeRelativeBottomLeftY - node_pos[1];

                        // Convert this delta to screen pixels
                        const deltaScreenX = deltaCanvasX * scale;
                        const deltaScreenY = deltaCanvasY * scale;

                        // New menu position: original click viewport coordinates + screen delta
                        const finalClientX = e.clientX + deltaScreenX;
                        const finalClientY = e.clientY + deltaScreenY + 5; // 5px gap

                        const nodeScreenWidth = node.size[0] * scale; // Calculate node's current screen width

                        const positionEvent = {
                            ...e, // Spread original event properties
                            clientX: finalClientX,
                            clientY: finalClientY
                        };
                        
                        // Use setTimeout to avoid menu/event conflicts
                        setTimeout(() => {
                            node.onTagQuickEdit(positionEvent, node, pill, nodeScreenWidth);
                        }, 0);
                        
                        return; // Stop processing, preventing the original menu
                    }
                }
            }
        }

        // If it wasn't our node or wasn't a pill click on our node, call the original function
        return orig_processContextMenu.apply(this, arguments);
    };
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

        if (name === "_tagImageWidth" || name === "_tagImageHeight") {
            this.setDirtyCanvas(true, true);
        }

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
                return;
            }

            if (!Array.isArray(resolvedGroupTags)) {
                throw new Error('Loaded tag group is not a valid array.');
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

    node.onSaveTagGroup = (e) => {

        const saveTagObject = async (tagObject) => {
            try {
                let tagDataToSave;
                if (node.properties._tagDataJSON !== undefined) {
                    tagDataToSave = parseTags(node.properties._tagDataJSON || "[]");
                } else {
                    const textWidget = node.widgets.find(w => w.name === "text");
                    tagDataToSave = parseTextToTagData(textWidget ? textWidget.value : "");
                }

                const originalTagData = [...tagDataToSave];
                // Only filter out group tags if we're actually saving a tag group (not individual tags)
                const groupTags = tagDataToSave.filter(tag => tag.type === 'group');
                if (groupTags.length > 0) {
                    tagDataToSave = tagDataToSave.filter(tag => tag.type !== 'group');
                    app.extensionManager.toast.add({
                        severity: "warn",
                        summary: "Nested tag groups not allowed.",
                        detail: `${groupTags.length} tag group(s) skipped in saving.`,
                        life: 6000
                    });
                }

                const jsonString = JSON.stringify(tagDataToSave, null, 2);
                const fullPath = tagObject.path ? `${tagObject.path}/${tagObject.filename}` : tagObject.filename;
                
                // Check if file already exists and confirm overwrite
                const checkResponse = await fetch(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);
                if (checkResponse.ok) {
                    const confirmed = await app.ui.dialog.show({
                        type: "confirm",
                        title: "File Exists",
                        message: `Tag group '${tagObject.filename}' already exists. Do you want to overwrite it?`
                    });
                    if (!confirmed) return;
                }

                clearCache(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);

                const formData = new FormData();
                formData.append('path', tagObject.path || '');
                formData.append('filename', tagObject.filename);
                formData.append('tags_json', jsonString);

                if (tagObject.imageFile) {
                    formData.append('image_file', tagObject.imageFile, tagObject.imageFile.name);
                }

                const response = await fetch('/erenodes/save_tag_group', {
                    method: 'POST',
                    body: formData,
                });
                
                const result = await response.json();
                if (!response.ok) {
                    const errorMessage = result.error || result.message || "Unknown error saving tag group.";
                    console.error('[EreNodes] Error saving tag group:', errorMessage);
                    app.extensionManager.toast.add({
                        severity: "error",
                        summary: "Save Error",
                        detail: errorMessage,
                        life: 5000
                    });
                } else {
                    const successMessage = result.message || `Tag group '${tagObject.filename}' saved successfully.`;
                    app.extensionManager.toast.add({
                        severity: "success",
                        summary: "Saved",
                        detail: successMessage,
                        life: 4000
                    });

                    // Replace saved tags with new group tag if requested
                    if (tagObject.shouldReplace) {
                        const remainingTags = originalTagData.filter(tag => tag.type === 'group');
                        const groupName = tagObject.path ? `${tagObject.path}/${tagObject.filename.replace('.json', '')}` : tagObject.filename.replace('.json', '');
                        const newGroupTag = { name: groupName, type: 'group', active: true, extension: '.json' };
                        const finalTagData = [...remainingTags, newGroupTag];

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


        /// ** Or is this maybe alternative way to show it and set callback too I think.
        // const SaveGroupMenu = new TagGroupContextMenu(e, async (selectedFile) => {
        //     // Update the tag object with the new file info
        //     this.tag.name = selectedFile.name;
        //     this.tag.extension = selectedFile.extension;

        //     if (this.onSelect) {
        //     }
        // }, 'group', 'save);
        

    };

    node.onClipboardReplace = () => {
        navigator.clipboard.readText().then(async text => {
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
    };

    node.onExportTags = async () => {
        let fileName = await getTextInput("Export Tags", "Enter filename for export (e.g., my_tags.json):", "");
        if (fileName === false || fileName === null) return; 

        fileName = String(fileName).trim();
        if (!fileName.toLowerCase().endsWith('.json')) fileName += '.json';

        let jsonString;
        if (node.properties._tagDataJSON !== undefined) {
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
        const clickedTag = tagData.find(t => t.name === clickedPill.label);
        if (!clickedTag) return;

        clickedTag.active = !clickedTag.active;
        node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
        await node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };
    
    node.onTagQuickEdit = async function(event, nodeInstance, clickedPill, nodeScreenWidth) { // Added nodeScreenWidth
        if (!clickedPill) return;

        const tagData = parseTags(nodeInstance.properties._tagDataJSON || "[]");
        let tagIndex = tagData.findIndex(t => t.name === clickedPill.label);
        if (tagIndex === -1) return;
        
        let clickedTag = tagData[tagIndex];

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

        const moveCallback = async (direction) => {
            const currentTagData = parseTags(nodeInstance.properties._tagDataJSON || "[]");
            if (tagIndex < 0 || tagIndex >= currentTagData.length) return;
            const newIndex = tagIndex + direction;
            if (newIndex < 0 || newIndex >= currentTagData.length) return;
            
            const [item] = currentTagData.splice(tagIndex, 1);
            currentTagData.splice(newIndex, 0, item);
            
            // Update the index to track the moved item
            tagIndex = newIndex;
            
            nodeInstance.properties._tagDataJSON = JSON.stringify(currentTagData, null, 2);
            await nodeInstance.onUpdateTextWidget(nodeInstance);
            app.graph.setDirtyCanvas(true);
        };

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
        new TagEditContextMenu(event, clickedTag, saveCallback, deleteCallback, moveCallback, imageCallback, tagIndex, nodeScreenWidth, existingTags);
    };
    
    node.onUpdateTextWidget = async (node) => {
        const textWidget = node.widgets.find(w => w.name === "text");
        if (!textWidget) return;

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (tagData.length === 0) return;
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
            if (currentText === tagSeparator && activeTags.filter(t.type !== 'group').length === 0) {
                currentText = '';
            }

            // Python will now handle prefix logic, so we just set the current text
            textWidget.value = currentText;
        }
        // For multiline nodes, preserve the existing text content
    };

}

