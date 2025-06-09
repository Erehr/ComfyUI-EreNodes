import { app } from "../../scripts/app.js";

// --- Helper Functions ---
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

    // LORA parsing
    const loraMatch = originalString.match(/^<lora:([^:]+)(?::([\d.-]+))?>$/);
    if (loraMatch) {
        const name = loraMatch[1];
        let strength = loraMatch[2] ? parseFloat(loraMatch[2]) : undefined;
        if (strength === 1.0 || isNaN(strength)) strength = undefined;
        
        return { name: name, type: 'lora', strength, active: true };
    }

    // General tag parsing (handles normal tags, tags with strength, and embeddings)
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

    // Now determine type
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

    // For 'tag' and 'embedding'
    if (tag.strength && tag.strength !== 1.0) {
        return `(${tag.name}:${tag.strength})`;
    }
    return tag.name;
}

const getTextInput = async (title, promptMessage, defaultValue = "") => {
    const value = prompt(promptMessage, defaultValue);
    if (value === null) return false; // User cancelled
    return value;
};

export function initializeSharedPromptFunctions(node, textWidget, saveButton) {
    node.onActionMenu = function(actionEvent) { 
        const options = [
            { content: "Replace Tags from Clipboard", callback: () => node.onClipboardReplace?.() },
            { content: "Add Tags from Clipboard", callback: () => node.onClipboardAppend?.() },
            null, // separator
            { content: "Edit Tags", callback: () => node.onEdit?.() },
            { content: "Toggle All Tags", callback: () => node.onToggleTags?.() },
            { content: "Remove all tags", callback: () => node.onRemoveTags?.() },
            null, // separator
            { content: "Load Tag Group...", callback: () => node.onLoadTagGroup?.(actionEvent, "")  },
            { content: "Save Tag Group...", callback: () => node.onSaveTagGroup?.(actionEvent, "")  },
            null, // separator
            { content: "Export Tags (.json)...", callback: () => node.onExportTags?.() },
            { content: "Import Tags (.json)...", callback: () => node.onImportTags?.() },
        ];
        
        new LiteGraph.ContextMenu(options, { event: actionEvent, className: "dark", node }, window);
    };

    node.onEdit = () => {
        node.isEditMode = true;
        saveButton.hidden = false;
        textWidget.hidden = false;

        // Reset height (set to 0, 0 onNodeCreated)
        textWidget.computeSize = null;
        
        const minEditorHeight = 256;
        if (node.size[1] < minEditorHeight) {
            node.setSize([node.size[0], minEditorHeight]);
        }

        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        const lines = tagData.map(formatTag);
        textWidget.value = lines.join("\n");

        app.graph.setDirtyCanvas(true);
    };

    node.onUpdateTextWidget = (node) => {
        const textWidget = node.widgets.find(w => w.name === "text");
        if (!textWidget) return;
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        const activeTags = tagData.filter(t => t.active && t.name);
        textWidget.value = activeTags.map(formatTag).join(", ");
    };

    node.onClipboardReplace = () => {
        navigator.clipboard.readText().then(text => {
            const tagStrings = (text.match(/<lora:[^>]+>|\([^)]+\)|[^,\n]+/g) || [])
                .map(s => s.trim())
                .filter(s => s);

            const tagData = tagStrings.map(parseTag).filter(Boolean);
            const json = JSON.stringify(tagData, null, 2);
            node.properties._tagDataJSON = json;

            const activeTags = tagData.filter(t => t.active).map(formatTag).join(", ");
            textWidget.value = activeTags;

            app.graph.setDirtyCanvas(true);
        });
    };

    node.onClipboardAppend = () => {
        navigator.clipboard.readText().then(text => {
            const newTagStrings = (text.match(/<lora:[^>]+>|\([^)]+\)|[^,\n]+/g) || [])
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
            
            if (!node.isEditMode) {
                 const activeTags = combinedTagData.filter(t => t.active && t.name);
                 textWidget.value = activeTags.map(formatTag).join(", ");
            } else {
                 textWidget.value = combinedTagData.map(formatTag).join("\n");
            }
            app.graph.setDirtyCanvas(true);
        });
    };

    node.onToggleTags = () => {
        const tagData = parseTags(node.properties._tagDataJSON || "[]");
        if (!tagData.length) return;

        const anyActive = tagData.some(tag => tag.active && tag.name);
        const allTargetState = !anyActive; 

        const updatedTagData = tagData.map(tag => ({ ...tag, active: tag.name ? allTargetState : tag.active }));

        node.properties._tagDataJSON = JSON.stringify(updatedTagData, null, 2);
            const activeTags = updatedTagData.filter(t => t.active && t.name);
            textWidget.value = activeTags.map(t => t.name).join(", ");
        app.graph.setDirtyCanvas(true);
    };

    node.onExportTags = async () => {
        let fileName = await getTextInput("Export Tags", "Enter filename for export (e.g., my_tags.json):", "");
        if (fileName === false || fileName === null) return; // User cancelled or closed prompt

        fileName = String(fileName).trim();
        if (!fileName.toLowerCase().endsWith('.json')) fileName += '.json';

        const jsonString = node.properties._tagDataJSON || "[]";
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

            const existingTagData = parseTags(node.properties._tagDataJSON || "[]");
            const existingTagNames = new Set(existingTagData.map(t => t.name));
            const uniqueNewTagObjects = newTagData.filter(tagObj => tagObj.name && !existingTagNames.has(tagObj.name));

            if (!uniqueNewTagObjects.length) return;

            const combinedTagData = existingTagData.concat(uniqueNewTagObjects);
            node.properties._tagDataJSON = JSON.stringify(combinedTagData, null, 2);
                const activeTags = combinedTagData.filter(t => t.active && t.name);
            if (textWidget) {
                textWidget.value = activeTags.map(t => t.name).join(", ");
            }
            if (node.renderTagDisplay) {
                node.renderTagDisplay();
            }
            node.setDirtyCanvas(true);
            app.graph.setDirtyCanvas(true);
        } catch (error) {
            // Silent error handling
        }
    };
    
    node.onRemoveTags = () => {
        node.properties._tagDataJSON = "[]"; 
        if (textWidget) {
            textWidget.value = ""; 
        }
        if (node.renderTagDisplay) {
            node.renderTagDisplay(); 
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

                        node.properties._tagDataJSON = JSON.stringify(uniqueValidTags, null, 2);
                            const activeTags = uniqueValidTags.filter(t => t.active && t.name);
                        if (textWidget) {
                            textWidget.value = activeTags.map(t => t.name).join(", ");
                        }
                        if (node.renderTagDisplay) {
                           node.renderTagDisplay();
                        }
                        app.graph.setDirtyCanvas(true);
                        node.setDirtyCanvas(true);
                    }
                } catch (err) {
                    // Silent error handling
                }
            };
            reader.readAsText(file);
        };
        input.click();
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
                    content: "⬆️ .. (Up)",
                    callback: () => node.onLoadTagGroup(actionEvent, parentPath)
                });
            }
            if (Array.isArray(groups) && groups.length > 0) {
                groups.forEach(item => {
                    const fullItemPath = currentPath ? `${currentPath}/${item.name}` : item.name;
                    if (item.type === "folder") {
                        loadSubMenu.push({
                            content: "📁 " + item.name,
                            callback: () => node.onLoadTagGroup(actionEvent, fullItemPath)
                        });
                    } else if (item.type === "file") {
                        loadSubMenu.push({
                            content: "📄 " + item.name,
                            callback: () => node.onLoadTagGroupFile(item.name, currentPath) // Pass currentPath as filePath
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
            left: actionEvent.clientX - 10, 
            top: actionEvent.clientY - 10,    
            className: "dark",
            node: node, // Use the passed 'node' object
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
            content: "➕ Create New Folder...",
            callback: () => node.promptForNewFolder(actionEvent, currentPath)
        });

        saveSubMenu.push(null); 

        if (currentPath !== "") {
            const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/'));
            saveSubMenu.push({
                content: "⬆️ .. (Up)",
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
            left: actionEvent.clientX - 10,
            top: actionEvent.clientY - 10,
            className: "dark",
            node: node, // Use the passed 'node' object
        }, window);
    };
    
    node.promptForNewFolder = async (actionEvent, currentPath) => {
        const folderName = await getTextInput("Create New Folder", "Enter new folder name:", "New Folder");
        if (!folderName || folderName.trim() === "") return;

        // This endpoint doesn't exist yet, we'll need to create it.
        // For now, let's just log it.
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
                // Refresh the save menu to show the new folder
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
            if (fileName === false || fileName === null) return; // User cancelled or closed prompt
            fileName = String(fileName).trim();
            if (!fileName) fileName = ""; // Default if empty
            if (!fileName.toLowerCase().endsWith('.json')) fileName += '.json';

            const jsonString = node.properties._tagDataJSON || "[]";

            const response = await fetch('/erenodes/save_tag_group', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: savePath, // Use the passed savePath
                    filename: fileName,
                    tags_json: jsonString,
                }),
            });
            const result = await response.json();
        } catch (error) {
            console.error('Error saving tag group:', error);
        }
    };

    node.onTagPillClick = (e, pos, clickedPill) => {

        if (!clickedPill) return;
        console.log('click');
        
        if (clickedPill.label === "button_menu") {
            return node.onActionMenu?.(e, clickedPill);
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
        // we are not limiting it to shift click here, to maybe reuse later or fix right click

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

            const newTagName = input.value;
            const newStrength = strengthInput.value;
            let strength = 1.0;
            if (newStrength && newStrength.trim() !== "" && !isNaN(newStrength)) {
                strength = parseFloat(newStrength);
            }
            
            if (newTagName && newTagName.trim()) {
                const trimmedNewName = newTagName.trim();
                if (trimmedNewName !== clickedTag.name && tagData.some(t => t.name === trimmedNewName)) {
                    return;
                }
                clickedTag.name = trimmedNewName;
                
                if (strength === 1.0) {
                    delete clickedTag.strength;
                } else {
                    clickedTag.strength = strength;
                }
        
                node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
                
                node.onUpdateTextWidget(node);
                app.graph.setDirtyCanvas(true);
            }

            menu.close();
        };

        const menu = new LiteGraph.ContextMenu([], { event: e, className: "dark" });
        const container = document.createElement("div");
        container.className = "litegraph-menu-item";
        container.style.display = "flex";
        container.style.margin = "0";

        const input = document.createElement("textarea");
        input.value = clickedTag.name;
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
        // TODO: Force strength to be 2 decimal places, ensure it's saved in json and parsed correctly
        // strengthInput.addEventListener("input", () => { strengthInput.value = parseFloat(strengthInput.value).toFixed(2) });
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
        setTimeout(() => input.focus(), 50);

        return;
    };

    if (saveButton) {
        saveButton.callback = () => {
            const text = textWidget.value || "";
            const lines = text.split('\n');
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
                    const tagStrings = (trimmedLine.match(/<lora:[^>]+>|\([^)]+\)|[^,\n]+/g) || [])
                        .map(s => s.trim())
                        .filter(s => s);
                    
                    const newTags = tagStrings.map(parseTag).filter(Boolean);

                    if (newTags.length > 0) {
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
            
            node.properties._tagDataJSON = JSON.stringify(finalTagData, null, 2);

            node.isEditMode = false;
            saveButton.hidden = true;
            textWidget.hidden = true;
            
            textWidget.computeSize = function() {
                return [0, -4]; 
            }

            if (node.type === "ErePromptCloud") {
                if (node.renderTagDisplay) node.renderTagDisplay();
            } else {
                node.onUpdateTextWidget(node);
            }
            app.graph.setDirtyCanvas(true);
        }
    }
}