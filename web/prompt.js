import { app } from "../../scripts/app.js";
// import { TagContextMenuInsert, TagContextMenuQuickEdit } from "./prompt_autocomplete.js";
// Make sure DynamicContextMenu is exported from prompt_autocomplete.js
// e.g., export class DynamicContextMenu { ... }
// Then import it here:
import { TagContextMenuInsert, TagEditContextMenu, DynamicContextMenu } from "./prompt_autocomplete.js";


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
    if (tag.type === 'separator') {
        return "";
    }
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
        if (trimmedLine === "") {
            if (!lastLineWasEmpty) {
                tagData.push({ name: "", type: 'separator', active: false });
                lastLineWasEmpty = true;
            }
        } else {
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
    }
    
    const finalTagData = [];
    const seenNames = new Set();
    for (const tag of tagData) {
        if (tag.type === 'separator') {
            finalTagData.push(tag);
            continue;
        }
        if (tag.name && !seenNames.has(tag.name)) {
            finalTagData.push(tag);
            seenNames.add(tag.name);
        }
    }
    
    if (finalTagData.length > 0 && finalTagData[finalTagData.length - 1].type === 'separator') {
        finalTagData.pop();
    }
    return finalTagData;
}

// flattenTagData function removed as per request

const getTextInput = async (title, promptMessage, defaultValue = "") => {
    const value = prompt(promptMessage, defaultValue);
    if (value === null) return false; 
    return value;
};


// Custom hijack of the context menu to allow for quick edit of tags on right click
let contextMenuPatched = false;
const ERE_TAG_NODE_TYPES = ["ErePromptCloud", "ErePromptToggle", "ErePromptMultiSelect", "ErePromptRandomizer"];

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
        // Handle _tagSeparator property changes
        if (name === "_tagSeparator") {
            // Trigger text widget update when tag separator changes
            if (this.onUpdateTextWidget) {
                this.onUpdateTextWidget(this);
            }
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
            // if (newNode.properties) delete newNode.properties._prefixSeparator;
            // if (newNode.properties) delete newNode.properties._tagSeparator;
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

    node.onActionMenu = (actionEvent, node) => { 
        let options = [
            { content: "Replace Tags from Clipboard", callback: () => node.onClipboardReplace?.() },
            { content: "Add Tags from Clipboard", callback: () => node.onClipboardAppend?.() },
            null, 
            { content: "Edit Tags", callback: () => node.onEdit?.() },
            { content: "Toggle All Tags", callback: () => node.onToggleTags?.() },
            { content: "Remove All Tags", callback: () => node.onRemoveTags?.() },
            null, 
            { content: "Load Tag Group", callback: () => node.onLoadTagGroup?.(actionEvent, "")  },
            { content: "Save Tag Group", callback: () => node.onSaveTagGroup?.(actionEvent, "")  },
            null, 
            { content: "Export Tags (.json)", callback: () => node.onExportTags?.() },
            { content: "Import Tags (.json)", callback: () => node.onImportTags?.() },
            null, 
            { content: "Convert to Prompt Cloud", callback: () => node.convertTo("ErePromptCloud") },
            { content: "Convert to Prompt MultiSelect", callback: () => node.convertTo("ErePromptMultiSelect") },
            { content: "Convert to Prompt Toggle", callback: () => node.convertTo("ErePromptToggle") },
            { content: "Convert to Prompt Multiline", callback: () => node.convertTo("ErePromptMultiline") },
            { content: "Convert to Prompt Randomizer", callback: () => node.convertTo("ErePromptRandomizer") },
        ];

        if (node.type === "ErePromptMultiline") {
            options = options.filter(option => !option || option.content !== "Edit Tags");
            options = options.filter(option => !option || option.content !== "Toggle All Tags");
        }
        options = options.filter(option => !option || option.content !== "Convert to " + node.title);

                new LiteGraph.ContextMenu(options, { event: actionEvent, className: "dark", node }, window);
    };

    node.onEdit = () => {
        node.isEditMode = true;
        textWidget.hidden = false;
        textWidget.computeSize = null;
        
        // Add save button widget
        let saveButton = node.addWidget("button", "Save", "edit_text", () => {
            
            // Save to JSON
            const finalTagData = parseTextToTagData(textWidget.value, parseTags(node.properties._tagDataJSON || "[]"));
            node.properties._tagDataJSON = JSON.stringify(finalTagData, null, 2);

            // Disable edit mode and remove button
            node.isEditMode = false;
            textWidget.hidden = true;

            const widgetIndex = node.widgets.indexOf(saveButton);
            if (widgetIndex > -1) {
                node.widgets.splice(widgetIndex, 1); // Use splice instead of removeWidget
            } 

            // Update output
            node.onUpdateTextWidget(node);
        });

        // Set editor size
        const minEditorHeight = 256;
        if (node.size[1] < minEditorHeight) {
            node.setSize([node.size[0], minEditorHeight]);
        }

        // Parse tags into editor value
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        
        let lines = [];
        let currentLine = [];

        // Insert tags and separators
        for (const tag of tagData) {
            if (tag.type === 'separator') {
                if (currentLine.length > 0) {
                    const separator = (node.properties._tagSeparator !== undefined && node.properties._tagSeparator !== "") ? node.properties._tagSeparator : ", ";
                    lines.push(currentLine.join(separator));
                }
                lines.push(""); 
                currentLine = [];
            } else if (tag.name) {
                currentLine.push(formatTag(tag));
            }
        }
        
        // Join with tag separator
        if (currentLine.length > 0) {
            const separator = (node.properties._tagSeparator !== undefined && node.properties._tagSeparator !== "") ? node.properties._tagSeparator : ", ";
            lines.push(currentLine.join(separator));
        }

        textWidget.value = lines.join("\n");
        app.graph.setDirtyCanvas(true);
    };

    node.onUpdateTextWidget = async (node) => {
        const textWidget = node.widgets.find(w => w.name === "text");
        if (!textWidget) return;

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        const activeTagsAndSeparators = tagData.filter(t => (t.active && t.name) || t.type === 'separator');

        let tagSeparator = (node.properties._tagSeparator || ", ").replace(/\\n/g, "\n");

        const parts = [];
        let currentLineTags = [];

        for (const tag of activeTagsAndSeparators) {
            if (tag.type === 'separator') {
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
            } else if (tag.type === 'group') {
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
                    const response = await fetch(`/erenodes/get_tag_group?filename=${encodeURIComponent(filename)}`);
                    if (response.ok) {
                        const groupTagData = await response.json();
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
            let currentText = parts.filter(part => part.trim() !== '' || part === tagSeparator)
                                   .join('');
            // If the final result is just the separator itself (e.g. only a separator was active), make it empty.
            if (currentText === tagSeparator && activeTagsAndSeparators.filter(t => t.type !== 'separator' && t.type !== 'group').length === 0) {
                currentText = '';
            }

            // Python will now handle prefix logic, so we just set the current text
            textWidget.value = currentText;
        }
        // For multiline nodes, preserve the existing text content
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
    
    node.onRemoveTags = () => {
        if(node.properties._tagDataJSON !== undefined) {
            node.properties._tagDataJSON = "[]"; 
        }
        if (textWidget) {
            textWidget.value = ""; 
        }
        node.setDirtyCanvas(true);
        app.graph.setDirtyCanvas(true);
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

    node.onLoadTagGroupFile = async (fileName, filePath = "") => {
        const fullPath = filePath ? `${filePath}/${fileName}` : fileName;
        try {
            const response = await fetch(`/erenodes/get_tag_group?filename=${encodeURIComponent(fullPath)}`);
            if (!response.ok) {
                const errorResult = await response.json().catch(() => ({ error: 'Failed to fetch tag group details.' }));
                throw new Error(errorResult.error || `HTTP error! status: ${response.status}`);
            }
            const newTagData = await response.json();
            if (!Array.isArray(newTagData)) {
                throw new Error('Loaded tag group is not a valid array.');
            }

            if (node.type !== "ErePromptMultiline") {
                const existingTagData = parseTags(node.properties._tagDataJSON || "[]");
                const existingTagNames = new Set(existingTagData.map(t => t.name));
                const uniqueNewTagObjects = newTagData.filter(tagObj => tagObj.name && !existingTagNames.has(tagObj.name));

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
                    const newTagsString = newTagData.map(formatTag).join(separator);
                    
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
        } catch (error) {
            console.error('[EreNodes] Error loading tag group file:', error);
        }
    };

    node.onLoadTagGroup = async (actionEvent, currentPath = "") => {
        const loadSubMenu = [];
        try {
            const response = await fetch(`/erenodes/list_tag_groups?path=${encodeURIComponent(currentPath)}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const groups = await response.json();

            if (currentPath !== "") {
                const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
                loadSubMenu.push({
                    content: "⬅️ .. (Up)",
                    callback: () => node.onLoadTagGroup(actionEvent, parentPath)
                });
            }
            if (Array.isArray(groups) && groups.length > 0) {
                groups.forEach(item => {
                    const fullItemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
                    if (item.type === "folder") {
                        loadSubMenu.push({
                            content: "📂 " + item.name,
                            callback: () => node.onLoadTagGroup(actionEvent, fullItemPath)
                        });
                    } else if (item.type === "file") {
                        loadSubMenu.push({
                            content: "📄 " + item.name,
                            callback: () => node.onLoadTagGroupFile(item.name, currentPath)
                        });
                    }
                });
            } else if (groups.length === 0 && currentPath === "") {
                loadSubMenu.push({ content: "(No tag groups found)", disabled: true });
            } else if (groups.length === 0) {
                 loadSubMenu.push({ content: "(Empty folder)", disabled: true });
            }
        } catch (error) {
            console.error("Error fetching tag groups:", error);
            loadSubMenu.push({ content: "(Error fetching tag groups)", disabled: true });
        }

        new LiteGraph.ContextMenu(loadSubMenu, {
            event: actionEvent,
            className: "dark",
            node: node, 
        }, window);
    };

    node.onOverwriteTagGroup = async (fullItemPath) => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");

        // Check for nested groups before overwriting
        if (tagData.some(tag => tag.type === 'group')) {
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Overwrite Aborted",
                detail: "Nested tag groups are not allowed. Please remove groups from this set before overwriting.",
                life: 6000
            });
            return; // Abort overwrite
        }
        const tagsToSave = JSON.stringify(tagData, null, 2);

        let directoryPath = "";
        let fileName = fullItemPath;
        const lastSlashIndex = fullItemPath.lastIndexOf('/');
        if (lastSlashIndex !== -1) {
            directoryPath = fullItemPath.substring(0, lastSlashIndex);
            fileName = fullItemPath.substring(lastSlashIndex + 1);
        }

        if (!fileName.endsWith(".json")) {
            console.error("[EreNodes] Error: Attempting to overwrite a non-JSON file.");
            return;
        }

        try {
            const formData = new FormData();
            formData.append('path', directoryPath);
            formData.append('filename', fileName);
            formData.append('tags_json', tagsToSave);
            // No image_file for overwrite, but backend handles its absence

            const response = await fetch('/erenodes/save_tag_group', {
                method: 'POST',
                body: formData, // Use FormData, browser sets Content-Type
            });
            const result = await response.json();
            if (!response.ok) {
                const errorMessage = result.error || result.message || "Unknown error overwriting tag group.";
                console.error('[EreNodes] Error overwriting tag group:', errorMessage);
                app.extensionManager.toast.add({
                    severity: "error",
                    summary: "Overwrite Error",
                    detail: errorMessage,
                    life: 5000
                });
            } else {
                // Shorthand for creating an alert toast
                app.extensionManager.toast.addAlert("This is an important message");
                const successMessage = result.message || `Tag group '${fileName}' overwritten successfully.`;
                app.extensionManager.toast.add({
                    severity: "success",
                    summary: "Overwritten",
                    detail: successMessage,
                    life: 4000
                });
            }
        } catch (error) {
            console.error('[EreNodes] Error overwriting tag group:', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Overwrite Operation Error",
                detail: error.message,
                life: 5000
            });
        }
    };

    node.onSaveTagGroup = async (actionEvent, currentPath = "") => {
        const saveSubMenu = [];

        saveSubMenu.push({
            content: "💾 Save Here...",
            callback: () => node.promptForFilenameAndSave(actionEvent, currentPath)
        });

        saveSubMenu.push({
            content: "📂 Create New Folder...",
            callback: () => node.promptForNewFolder(actionEvent, currentPath)
        });

        saveSubMenu.push(null); 

        if (currentPath !== "") {
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
            saveSubMenu.push({
                content: "⬅️ .. (Up)",
                callback: () => node.onSaveTagGroup(actionEvent, parentPath)
            });
        }

        try {
            const response = await fetch(`/erenodes/list_tag_groups?path=${encodeURIComponent(currentPath)}`);
            if (response.ok) {
                const items = await response.json();
                if (Array.isArray(items)) {
                    items.forEach(item => {
                        const fullItemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
                        if (item.type === "folder") {
                            saveSubMenu.push({
                                content: "📁 " + item.name,
                                callback: () => node.onSaveTagGroup(actionEvent, fullItemPath)
                            });
                        } else if (item.type === "file" && item.name.endsWith(".json")) {
                            saveSubMenu.push({
                                content: "📄 " + item.name + " (Overwrite)",
                                callback: () => node.onOverwriteTagGroup(fullItemPath)
                            });
                        }
                    });
                }
            } else {
                console.error("Failed to fetch folder list for saving, status:", response.status);
                saveSubMenu.push({ content: "(Error fetching folders)", disabled: true });
            }
        } catch (error) {
            console.error("Error fetching folder list for saving:", error);
            saveSubMenu.push({ content: "(Error fetching folders)", disabled: true });
        }

        new LiteGraph.ContextMenu(saveSubMenu, {
            event: actionEvent,
            className: "dark",
            node: node, 
        }, window);
    };
    
    node.promptForNewFolder = async (actionEvent, currentPath) => {
        const folderName = await getTextInput("Create New Folder", "Enter new folder name:", "New Folder");
        if (!folderName || folderName.trim() === "") return;

        try {
            const response = await fetch('/erenodes/create_folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: currentPath,
                    folderName: folderName.trim(),
                }),
            });
            if (response.ok) {
                node.onSaveTagGroup(actionEvent, currentPath);
            } else {
                const error = await response.json();
                console.error("Error creating folder:", error.error);
            }
        } catch (error) {
            console.error("Error creating folder:", error);
        }
    };
    
class TagGroupSaveContextMenu extends DynamicContextMenu {
    constructor(event, savePath, nodeInstance, onSaveActualCallback) {
        super(event, null); // Base class onSelect is not used directly for this dialog's primary action
        this.savePath = savePath;
        this.nodeInstance = nodeInstance; // Store the node instance
        this.onSaveActual = onSaveActualCallback;
        this.currentImageFile = null;
        this.currentFileName = ""; // Store filename from input for convenience

        // Override onItemSelected to prevent default close behavior for some items
        this.onItemSelected = (option) => {
            if (option && !option.disabled && option.callback) {
                option.callback();
            }
        };
        this.show();
    }

    show() {
        this.close(); // Close any existing menu
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        this.root.close = this.close.bind(this);
        
        const { clientX: x, clientY: y } = this.event;
        Object.assign(this.root.style, {
            left: `${x}px`,
            top: `${y}px`,
        });
        if (this.nodeScreenWidth && this.nodeScreenWidth > 0) {
            this.root.style.maxWidth = this.nodeScreenWidth - 28 + 'px';
        }

        document.body.appendChild(this.root);

        this.updateOptionsAndRender();
        this.setupEventListeners();
        
        if (this.filterBox) {
            this.filterBox.focus();
            this.filterBox.value = this.currentFileName; // Restore previous filename if any
        }

        if (LiteGraph.currentMenu && LiteGraph.currentMenu !== this && typeof LiteGraph.currentMenu.close === 'function') {
            LiteGraph.currentMenu.close();
        }
        LiteGraph.currentMenu = this;
    }
    
    updateOptionsAndRender() {
        this.options = [
            {
                type: 'filter',
                placeholder: 'Filename',
                onInput: (value) => {
                    this.currentFileName = value;
                }
            },
            { type: 'separator' },
            {
                name: `🖼️ ${this.currentImageFile ? `Image: ${this.currentImageFile.name}` : "Select Image..."}`,
                callback: async () => {
                    const imageFile = await this._selectImageFile();
                    this.currentImageFile = imageFile;
                    // Re-render by re-calling show, which will call updateOptionsAndRender
                    this.show();
                }
            },
            { type: 'separator' },
            {
                name: "💾 Save",
                callback: () => {
                    const filenameFromInput = this.filterBox ? this.filterBox.value.trim() : this.currentFileName.trim();
                    if (!filenameFromInput) {
                        alert("Filename cannot be empty.");
                        if (this.filterBox) this.filterBox.focus();
                        return;
                    }
                    let finalFileName = filenameFromInput;
                    if (!finalFileName.toLowerCase().endsWith('.json')) {
                        finalFileName += '.json';
                    }
                    this.onSaveActual(finalFileName, this.currentImageFile, this.savePath, this.nodeInstance);
                    this.close();
                }
            },
            {
                name: "❌ Cancel",
                callback: () => {
                    this.close();
                }
            }
        ];
        this.renderItems();
        
        if (this.filterBox) {
            this.filterBox.value = this.currentFileName; // Ensure value is set after render
            setTimeout(() => this.filterBox.focus(), 0); // Ensure focus after render
        }
    }

    async _selectImageFile() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.display = 'none';
            let resolved = false;
            const cleanupAndResolve = (file) => {
                if (resolved) return;
                resolved = true;
                window.removeEventListener('focus', handleFocus);
                if (document.body.contains(input)) document.body.removeChild(input);
                resolve(file);
            };
            const handleChange = (event) => cleanupAndResolve(event.target.files && event.target.files.length > 0 ? event.target.files[0] : null);
            const handleFocus = () => setTimeout(() => { if (!resolved && (!input.files || input.files.length === 0)) cleanupAndResolve(null); }, 100);
            input.addEventListener('change', handleChange);
            window.addEventListener('focus', handleFocus, { once: true });
            document.body.appendChild(input);
            try { input.click(); } catch (err) { console.error("[EreNodes] Error triggering file input click:", err); cleanupAndResolve(null); }
        });
    }

    handleKeyboard(e) {
        // Allow DynamicContextMenu to handle Enter key based on highlighted item.
        // Do not trigger save directly from filterBox on Enter.
        if (this.filterBox && e.target === this.filterBox && e.key === 'Enter') {
             // If enter is pressed in the filter box, we want the default behavior of DynamicContextMenu,
             // which is to activate the currently highlighted item.
             // So, we let the event propagate to the parent's handler.
             // However, we still want to prevent default browser action for Enter in an input if not handled by menu.
            e.preventDefault();
        }
        return super.handleKeyboard(e);
    }
}


node.promptForFilenameAndSave = async (actionEvent, savePath) => {
    const onSaveActualCallback = async (fileName, imageFile, path, graphNode) => {
        try {
            let jsonString;
            let tagDataToSave;
            if (graphNode.properties._tagDataJSON !== undefined) {
                tagDataToSave = parseTags(graphNode.properties._tagDataJSON || "[]");
            } else {
                const textWidget = graphNode.widgets.find(w => w.name === "text");
                tagDataToSave = parseTextToTagData(textWidget ? textWidget.value : "");
            }

            // Check for nested groups before saving
            if (tagDataToSave.some(tag => tag.type === 'group')) {
                app.extensionManager.toast.add({
                    severity: "error",
                    summary: "Save Aborted",
                    detail: "Nested tag groups are not allowed. Please remove groups from this set before saving.",
                    life: 6000
                });
                return; // Abort save
            }
            jsonString = JSON.stringify(tagDataToSave, null, 2);

            const formData = new FormData();
            formData.append('path', path);
            formData.append('filename', fileName);
            formData.append('tags_json', jsonString);

            if (imageFile) {
                formData.append('image_file', imageFile, imageFile.name);
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
                const successMessage = result.message || `Tag group '${fileName}' saved successfully.`;
                // console.log('[EreNodes] Tag group saved:', successMessage);
                app.extensionManager.toast.add({
                    severity: "success",
                    summary: "Saved",
                    detail: successMessage,
                    life: 4000
                });
            }
        } catch (error) {
            console.error('Error saving tag group:', error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Save Operation Error",
                detail: error.message,
                life: 5000
            });
        }
    };
    new TagGroupSaveContextMenu(actionEvent, savePath, node, onSaveActualCallback);
};

    node.onRandomize = (e, pos) => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (!tagData.length) return;

        const allTags = tagData.filter(t => t.type !== 'separator' && t.name);
        if (!allTags.length) return;

        const activeCount = allTags.filter(t => t.active).length;

        allTags.forEach(t => t.active = false);

        for (let i = allTags.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [allTags[i], allTags[j]] = [allTags[j], allTags[i]];
        }

        for (let i = 0; i < activeCount; i++) {
            if (allTags[i]) {
                allTags[i].active = true;
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
        
        let existingTagNames = [];
        const textWidget = node.widgets.find(w => w.name === "text");
        if (textWidget && textWidget.value) {
            existingTagNames = textWidget.value.split(/[,\n]/).map(tag => tag.trim()).filter(Boolean);
        }
        
        new TagContextMenuInsert(e, addTagObject, existingTagNames);
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
                // For special types, the name/type are not editable from the input,
                // but the name can change if a different file is selected.
                finalTag = { ...clickedTag, ...editedTag };
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

        // The 'event' parameter (which is positionEvent from applyContextMenuPatch)
        // now has clientX and clientY correctly set.
        new TagEditContextMenu(event, clickedTag, saveCallback, deleteCallback, moveCallback, tagIndex, nodeScreenWidth); // Pass nodeScreenWidth
    };
    
}
