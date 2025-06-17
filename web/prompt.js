import { app } from "../../scripts/app.js";
import { TagContextMenuInsert } from "./prompt_autocomplete.js";

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
    }

    return { name, type, strength, active: true };
}

function formatTag(tag) {
    if (tag.type === 'separator') {
        return "";
    }
    if (tag.type === 'lora') {
        if (tag.strength && tag.strength !== 1.0) {
            return `<lora:${tag.name}:${tag.strength}>`;
        }
        return `<lora:${tag.name}>`;
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

const getTextInput = async (title, promptMessage, defaultValue = "") => {
    const value = prompt(promptMessage, defaultValue);
    if (value === null) return false; 
    return value;
};

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
            { content: "Remove all tags", callback: () => node.onRemoveTags?.() },
            null, 
            { content: "Load Tag Group...", callback: () => node.onLoadTagGroup?.(actionEvent, "")  },
            { content: "Save Tag Group...", callback: () => node.onSaveTagGroup?.(actionEvent, "")  },
            null, 
            { content: "Export Tags (.json)...", callback: () => node.onExportTags?.() },
            { content: "Import Tags (.json)...", callback: () => node.onImportTags?.() },
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

    node.onUpdateTextWidget = (node) => {
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
                    parts.push(currentLineTags.join(tagSeparator));
                    currentLineTags = [];
                }
                // Only add a separator if there was something before it and parts is not empty
                // and the last part wasn't already a separator (or effectively one due to empty line).
                if (parts.length > 0 && parts[parts.length -1] !== tagSeparator) {
                     // Check if the last part added actual content or if it was an empty line join
                    if (parts[parts.length-1].trim() !== "") { 
                        parts.push(tagSeparator);
                    }
                }
            } else {
                currentLineTags.push(formatTag(tag));
            }
        }

        if (currentLineTags.length > 0) {
            parts.push(currentLineTags.join(tagSeparator));
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
            if (currentText === tagSeparator && activeTagsAndSeparators.filter(t => t.type !== 'separator').length === 0) {
                currentText = '';
            }

            // Python will now handle prefix logic, so we just set the current text
            textWidget.value = currentText;
        }
        // For multiline nodes, preserve the existing text content
    };

    node.onClipboardReplace = () => {
        navigator.clipboard.readText().then(text => {
            if (node.type !== "ErePromptMultiline") {
                const tagStrings = (text.replace(/\n/g, ',').split(/,(?![^()]*\))/g) || [])
                    .map(s => s.trim())
                    .filter(s => s);

                const tagData = tagStrings.map(parseTag).filter(Boolean);
                const json = JSON.stringify(tagData, null, 2);
                node.properties._tagDataJSON = json;
                node.onUpdateTextWidget(node);
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
        navigator.clipboard.readText().then(text => {
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
                node.onUpdateTextWidget(node);
                app.graph.setDirtyCanvas(true);
            } else {
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) {
                    textWidget.value += (textWidget.value ? "\n" : "") + text;
                }
            }
        });
    };

    node.onToggleTags = () => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (!tagData.length) return;

        const anyActive = tagData.some(tag => tag.active && tag.name);
        const allTargetState = !anyActive; 

        const updatedTagData = tagData.map(tag => ({ ...tag, active: tag.name ? allTargetState : tag.active }));

        node.properties._tagDataJSON = JSON.stringify(updatedTagData, null, 2);
        node.onUpdateTextWidget(node);
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
            } else {
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) {
                    const newText = newTagData.map(formatTag).join("\n");
                    if (textWidget.value) {
                        textWidget.value += `${newText}`;
                    } else {
                        textWidget.value = newText;
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
        const tagsToSave = node.properties._tagDataJSON || "[]";

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
            const response = await fetch('/erenodes/save_tag_group', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: directoryPath,
                    filename: fileName,
                    tags_json: tagsToSave,
                })
            });
            const result = await response.json();
        } catch (error) {
            console.error('[EreNodes] Error saving/overwriting tag group:', error);
        }
    };

    node.onSaveTagGroup = async (actionEvent, currentPath = "") => {
        const saveSubMenu = [];

        saveSubMenu.push({
            content: "💾 Save Here...",
            callback: () => node.promptForFilenameAndSave(currentPath)
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
    
    node.promptForFilenameAndSave = async (savePath) => {
        let fileName;
        try {
            fileName = await getTextInput("Save Tag Group", "Enter filename (e.g., my_tags.json):", "");
            if (fileName === false || fileName === null) return; 
            fileName = String(fileName).trim();
            if (!fileName) fileName = ""; 
            if (!fileName.toLowerCase().endsWith('.json')) fileName += '.json';

            let jsonString;
            if (node.properties._tagDataJSON !== undefined) {
                jsonString = node.properties._tagDataJSON || "[]";
            } else {
                const tagData = parseTextToTagData(textWidget.value);
                jsonString = JSON.stringify(tagData, null, 2);
            }

            const response = await fetch('/erenodes/save_tag_group', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: savePath, 
                    filename: fileName,
                    tags_json: jsonString,
                }),
            });
            const result = await response.json();
        } catch (error) {
            console.error('Error saving tag group:', error);
        }
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

    const shiftActiveTags = (node, shift) => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (!tagData.length) return;

        const usableTags = tagData.filter(t => t.type !== 'separator' && t.name);
        if (!usableTags.length) return;
        
        const activeIndices = [];
        usableTags.forEach((tag, index) => {
            if (tag.active) {
                activeIndices.push(index);
            }
        });

        if (activeIndices.length === 0) return;

        usableTags.forEach(t => t.active = false);

        const newActiveIndices = activeIndices.map(index => (index + shift + usableTags.length) % usableTags.length);
        
        newActiveIndices.forEach(newIndex => {
            if (usableTags[newIndex]) {
                usableTags[newIndex].active = true;
            }
        });

        node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
        node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };

    node.onIncrement = () => {
        shiftActiveTags(node, 1);
    };

    node.onDecrement = () => {
        shiftActiveTags(node, -1);
    };

    node.onAddTag = (e, pos) => {
        const addTags = (textToAdd) => {
            if (!textToAdd || !textToAdd.trim()) return;

            if (node.type !== "ErePromptMultiline") {
                const newTagStrings = (textToAdd.replace(/\n/g, ',').split(/,(?![^()]*\))/g) || [])
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
                node.onUpdateTextWidget(node);
            } else {
                const textWidget = node.widgets.find(w => w.name === "text");
                if (textWidget) {
                    textWidget.value += (textWidget.value ? "\n" : "") + textToAdd;
                }
            }
            app.graph.setDirtyCanvas(true);
        };
        
        let existingTagNames = [];
        if (node.type !== "ErePromptMultiline") {
            const existingTagData = parseTags(node.properties._tagDataJSON || "[]");
            existingTagNames = existingTagData.map(t => t.name).filter(Boolean);
        } else {
            const textWidget = node.widgets.find(w => w.name === "text");
            if (textWidget && textWidget.value) {
                existingTagNames = textWidget.value.split(/[,\n]/).map(tag => tag.trim()).filter(Boolean);
            }
        }
        
        new TagContextMenuInsert(e, addTags, existingTagNames);
    };

    node.onTagPillClick = (e, pos, clickedPill) => {
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
        node.onUpdateTextWidget(node);
        app.graph.setDirtyCanvas(true);
    };
    
    node.onTagQuickEdit = (e, pos, clickedPill) => {
        if (!clickedPill) return;

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        const clickedTag = tagData.find(t => t.name === clickedPill.label);

        if (!clickedTag) return;

        const deleteTag = () => {
            const newTagData = tagData.filter(t => t.name !== clickedTag.name);
            node.properties._tagDataJSON = JSON.stringify(newTagData, null, 2);
            node.onUpdateTextWidget(node);
            app.graph.setDirtyCanvas(true);
        };

        const updateTag = () => {
            const currentTagData = parseTags(node.properties._tagDataJSON || "[]");
            const tagIndex = currentTagData.findIndex(t => t.name === clickedTag.name && t.type === clickedTag.type && t.strength === clickedTag.strength);

            const inputText = input.value.trim();
            const newStrengthValue = strengthInput.value.trim();

            // Parse the input text which might contain multiple new tags
            // We pass an empty array as oldTagData to parseTextToTagData because we are replacing, not merging with existing list context here.
            const newTags = parseTextToTagData(inputText, []); 

            if (tagIndex !== -1) {
                if (newTags.length > 0) {
                    // If the input resulted in one or more tags
                    // Apply the strength from the strength input to the first new tag if it's not a LORA with its own strength
                    // or if the new tag is a LORA and the strength input is not empty.
                    if (newTags[0].type !== 'lora' || (newTags[0].type === 'lora' && newStrengthValue !== "")) {
                         const strength = parseFloat(newStrengthValue);
                         if (!isNaN(strength) && strength !== 1.0) {
                            newTags[0].strength = strength;
                         } else if (newTags[0].type === 'lora' && newTags[0].strength === undefined && newStrengthValue === "") {
                            // If it's a LORA parsed without strength and strength input is empty, keep it undefined
                            newTags[0].strength = undefined;
                         } else if (newTags[0].type !== 'lora'){
                            newTags[0].strength = undefined; // Default for non-lora or strength 1
                         }
                    }
                    // Replace the old tag with the new one(s)
                    currentTagData.splice(tagIndex, 1, ...newTags);
                } else {
                    // If input is empty, effectively delete the tag
                    currentTagData.splice(tagIndex, 1);
                }
            } else if (newTags.length > 0) {
                // If original tag not found (shouldn't happen ideally, but as a fallback), append new tags
                // Apply strength to the first new tag as above
                if (newTags[0].type !== 'lora' || (newTags[0].type === 'lora' && newStrengthValue !== "")) {
                    const strength = parseFloat(newStrengthValue);
                    if (!isNaN(strength) && strength !== 1.0) {
                        newTags[0].strength = strength;
                    }
                     else if (newTags[0].type === 'lora' && newTags[0].strength === undefined && newStrengthValue === "") {
                        newTags[0].strength = undefined;
                     } else if (newTags[0].type !== 'lora'){
                        newTags[0].strength = undefined; 
                     }
                }
                currentTagData.push(...newTags);
            }

            node.properties._tagDataJSON = JSON.stringify(currentTagData, null, 2);
            node.onUpdateTextWidget(node);
            app.graph.setDirtyCanvas(true);
            menu.close();
        };

        const menu = new LiteGraph.ContextMenu([], { event: e, className: "dark" });
        const container = document.createElement("div");
        container.className = "litegraph-menu-item";
        container.style.display = "flex";
        container.style.margin = "0";

        const input = document.createElement("textarea");
        input.value = formatTag(clickedTag);
        input.style.border = "none";
        input.style.background = LiteGraph.WIDGET_BGCOLOR;
        input.style.fieldSizing = "content";
        input.style.padding = "5px 10px";
        input.style.marginBottom = "-3px";
        input.style.minWidth = "128px";
        input.style.maxWidth = "384px";
        input.style.lineHeight = "1.5";
        input.style.margin = "0";
        input.addEventListener('focus', () => {
            input.style.outline = "1px solid #666";
            // Autocomplete will be handled by the global focusin listener
        });

        const strengthInput = document.createElement("input");
        strengthInput.type = "number";
        strengthInput.style.setProperty('background', 'none', 'important');
        strengthInput.style.cursor = "pointer";
        strengthInput.placeholder = "💪";
        strengthInput.value = clickedTag.strength || "";
        strengthInput.step = 0.05;
        strengthInput.style.fieldSizing = "content";
        strengthInput.style.padding = "5px";
        strengthInput.style.border = "none";
        strengthInput.addEventListener('focus', () => {
            strengthInput.style.outline = "1px solid #666";
            strengthInput.style.background = LiteGraph.WIDGET_BGCOLOR;
            if(strengthInput.value === "") strengthInput.value = "1";
        });
        strengthInput.addEventListener('blur', () => {
            strengthInput.style.setProperty('background', 'none', 'important');
            if(strengthInput.value === "1") strengthInput.value = "";
        });

        const saveButton = document.createElement("button");
        saveButton.textContent = "✅";
        saveButton.style.background = "none";
        saveButton.style.border = "none";
        saveButton.style.cursor = "pointer";
        saveButton.style.fontSize = "16px";
        saveButton.addEventListener('focus', () => {
            saveButton.style.outline = "1px solid #666";
            saveButton.style.background = LiteGraph.WIDGET_BGCOLOR;
        });
        saveButton.addEventListener('blur', () => {
            saveButton.style.background = "none"
        });
        
        const deleteButton = document.createElement("button");
        deleteButton.textContent = "🗑️";
        deleteButton.style.background = "none";
        deleteButton.style.border = "none";
        deleteButton.style.cursor = "pointer";
        deleteButton.style.fontSize = "16px";
        deleteButton.addEventListener('focus', () => {
            deleteButton.style.outline = "1px solid #666";
            deleteButton.style.background = LiteGraph.WIDGET_BGCOLOR;
        });
        deleteButton.addEventListener('blur', () => {
            deleteButton.style.background = "none"
        });

        saveButton.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); updateTag(); });
        deleteButton.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); deleteTag(); menu.close(); });
        input.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
        strengthInput.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); });
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") updateTag(); e.stopPropagation(); });
        strengthInput.addEventListener("keydown", (e) => { if (e.key === "Enter") updateTag(); e.stopPropagation(); });

        container.appendChild(input);
        container.appendChild(strengthInput);
        container.appendChild(saveButton);
        container.appendChild(deleteButton);
        menu.root.prepend(container);
        menu.onClose = () => { // Ensure detachment when the context menu itself is closed
            if (quickEditAutocompleteInstance) {
                quickEditAutocompleteInstance.detach();
                quickEditAutocompleteInstance = null;
            }
        };
        setTimeout(() => input.focus(), 50);

        return;
    };
    
}
