import { app } from "../../../../scripts/app.js";
import { getCache, clearCache } from "./cache.js";

// Base class for dynamic context menus
export class DynamicContextMenu { // Added export
    constructor(event, onSelectCallback) {
        this.event = event;
        this.onSelect = onSelectCallback;
        this.root = null;
        this.options = [];
        this.highlighted = -1;
        this.renderedOptionElements = [];
        this.abortController = null;
    }

    onItemSelected(option, event = null, index = -1) {
        if (option && !option.disabled && option.callback) {
            // Pass the index to the callback
            option.callback(event, index);
        }
    }

    close() {
        
        if (this.root) {
            this.root.remove();
            this.root = null;
        }
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        if (LiteGraph.currentMenu === this) {
            LiteGraph.currentMenu = null;
        }
        
        // Hide preview when closing if hidePreview method exists
        this.hidePreview();
    }

    handleKeyboard(e) {
        const enabledOptions = this.options.map((o, i) => (!o.disabled && o.type !== 'separator' && o.type !== 'title' && o.type !== 'filter') ? i : -1).filter(i => i !== -1);
        if (enabledOptions.length === 0 && e.key !== 'Escape') return false;

        let currentHighlightIndex = enabledOptions.indexOf(this.highlighted);
        let handled = false;

        switch (e.key) {
            case "ArrowUp":
                currentHighlightIndex = (currentHighlightIndex > 0) ? currentHighlightIndex - 1 : enabledOptions.length - 1;
                while(this.options[enabledOptions[currentHighlightIndex]].disabled) {
                    currentHighlightIndex = (currentHighlightIndex > 0) ? currentHighlightIndex - 1 : enabledOptions.length - 1;
                }
                this.setHighlight(enabledOptions[currentHighlightIndex]);
                handled = true;
                break;
            case "ArrowDown":
                currentHighlightIndex = (currentHighlightIndex < enabledOptions.length - 1) ? currentHighlightIndex + 1 : 0;
                while(this.options[enabledOptions[currentHighlightIndex]].disabled) {
                     currentHighlightIndex = (currentHighlightIndex < enabledOptions.length - 1) ? currentHighlightIndex + 1 : 0;
                }
                this.setHighlight(enabledOptions[currentHighlightIndex]);
                handled = true;
                break;
            case "Enter":
                if (this.highlighted !== -1) {
                    this.onItemSelected(this.options[this.highlighted], e, this.highlighted);
                }
                handled = true;
                break;
            case "Escape":
                this.close();
                handled = true;
                break;
            case "Tab":
                // Navigate to next option like ArrowDown, but preserve input focus
                currentHighlightIndex = (currentHighlightIndex < enabledOptions.length - 1) ? currentHighlightIndex + 1 : 0;
                while(this.options[enabledOptions[currentHighlightIndex]].disabled) {
                     currentHighlightIndex = (currentHighlightIndex < enabledOptions.length - 1) ? currentHighlightIndex + 1 : 0;
                }
                this.setHighlight(enabledOptions[currentHighlightIndex]);
                handled = true;
                break;
        }

        if (handled) {
            e.preventDefault();
            e.stopPropagation();
        }
        return handled;
    }

    highlight(text, query) {
        if (!query || !text) return text;
        const index = text.toLowerCase().indexOf(query.toLowerCase());
        if (index !== -1) {
            const pre = text.substring(0, index);
            const match = text.substring(index, index + query.length);
            const post = text.substring(index + query.length);
            return `${pre}<mark style="background-color: #414650; color: white;">${match}</mark>${post}`;
        }
        return text;
    }

    renderItems() {
        this.root.innerHTML = '';
        this.renderedOptionElements = [];

        this.options.forEach((option, i) => {
            let element;
            if (option.type === 'filter') {
                // Create the input element directly, not inside a div
                element = document.createElement("input");
                element.className = "comfy-context-menu-filter";
                element.placeholder = option.placeholder || "";
                element.value = this.currentWord || "";
                if (option.onInput) {
                    element.addEventListener("input", () => option.onInput(element.value));
                }
                this.filterBox = element;
            } else {
                // For all other types, create the standard div wrapper
                element = document.createElement("div");
                this.renderSingleItem(element, option, i);
            }
            
            element.dataset.optionIndex = i;
            this.root.appendChild(element);
            this.renderedOptionElements.push(element);
        });

        setTimeout(() => this.filterBox?.focus(), 0);
        this.setInitialHighlight();
    }

    renderSingleItem(item, option, index) {
        // This function now only handles non-filter items, which are always wrapped in a div
        switch (option.type) {
            case 'separator':
                item.className = "litemenu-entry submenu separator";
                break;
            case 'title':
                item.className = "litemenu-title";
                item.innerHTML = `<div>${option.name}</div>`;
                break;
            default:
                item.className = "litemenu-entry submenu";
                if (option.disabled) {
                    item.classList.add("disabled");
                }

                if (option.name !== undefined) {
                    const query = this.filterBox ? this.filterBox.value : (this.currentWord || "");
                    const displayHTML = this.highlight(option.name, query);
                    item.innerHTML = `<div>${displayHTML}</div>`;
                } else {
                    item.innerHTML = "Error: Invalid option";
                }

                item.addEventListener("click", (e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    this.onItemSelected(option, e, index);
                });

                item.addEventListener("mouseenter", () => {
                    if (!option.disabled) this.setHighlight(index);
                });
                break;
        }
    }

    setupEventListeners() {
        // Abort any existing listeners from a previous instance
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        const keyboardHandler = (e) => {
            if (this.filterBox && e.target === this.filterBox) {
                const isNavKey = ['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab'].includes(e.key);
                const isOverridden = this.filterBoxOverrides && this.filterBoxOverrides.includes(e.key);

                if (!isNavKey && !isOverridden) {
                    return;
                }
            }
            const handledByMenu = this.handleKeyboard(e);
            if (handledByMenu) {
                e.preventDefault();
                e.stopPropagation();
            } else if (e.key === 'Enter' && this.filterBox) {
                const query = this.filterBox.value.trim();
                if (this.highlighted === -1 && query && this.onSelect) {
                    this.onSelect(query);
                }
            }
        };
        document.addEventListener("keydown", keyboardHandler, { signal, capture: true });

        // Use pointerdown for closing, same as LiteGraph
        const pointerDownHandler = (e) => {
            if (!this.root || !this.root.isConnected) {
                this.close();
                return;
            }
            if (!this.root.contains(e.target)) {
                this.close();
            }
        };
        document.addEventListener("pointerdown", pointerDownHandler, { signal });

        this.root.addEventListener("pointerdown", (e) => e.stopPropagation(), { signal });

        if (LiteGraph.currentMenu) {
            LiteGraph.currentMenu.close();
        }
        LiteGraph.currentMenu = this;
    }

    setHighlight(index) {
        if (!this.root) return;

        if (this.highlighted > -1) {
            const oldItem = this.root.querySelector(`[data-option-index="${this.highlighted}"]`);
            if (oldItem) {
                oldItem.style.backgroundColor = "";
                oldItem.style.color = "";
            }
        }

        this.highlighted = index;
        
        if (index > -1) {
            const newItem = this.root.querySelector(`[data-option-index="${index}"]`);
            if (newItem && this.options[index] && !this.options[index].disabled) {
                newItem.style.setProperty('background-color', 'rgb(204, 204, 204)', 'important');
                newItem.style.setProperty('color', 'rgb(0, 0, 0)', 'important');
                newItem.scrollIntoView({ block: 'nearest' });
            }
            
            // Show preview for previewable types if showPreview method exists
            const option = this.options[index];
            if (option && !option.disabled && this.showPreview &&
                ['file', 'lora', 'embedding', 'group'].includes(option.type)) {
                this.showPreview(`/erenodes/view/${option.type}/${option.path}`);
            }
        } else {
            // Hide preview when no item is highlighted if hidePreview method exists
            if (this.hidePreview) {
                this.hidePreview();
            }
        } 
    }

    setInitialHighlight() {
        // First, try to find a "real" suggestion that isn't an action.
        let firstHighlight = this.options.findIndex(o => !o.disabled && o.type !== 'filter' && o.type !== 'separator' && o.type !== 'title' && o.type !== 'action');

        // If no "real" suggestion is found, check for an actionable item (like "Add tag: ...")
        if (firstHighlight === -1) {
            firstHighlight = this.options.findIndex(o => !o.disabled && o.type === 'action');
        }

        // Set the highlight. If nothing is found, this will correctly be -1.
        this.setHighlight(firstHighlight);
    }

    showPreview(url) {
        this.hidePreview(); // Clear previous preview

        if (!url) {
            return;
        }
        
        const imageUrl = url;
        const processImage = (url) => {
            if (!this.root || !this.root.isConnected) return;

            this.previewImage = document.createElement('img');

            Object.assign(this.previewImage.style, {
                position: 'fixed',
                zIndex: 1001,
                border: '1px solid #444',
                display: 'block',
                maxWidth: '256px',
                maxHeight: '256px',
            });

            this.previewImage.onload = () => {
                if (!this.root || !this.root.isConnected) return;
                this.root.appendChild(this.previewImage);

                const menuRect = this.root.getBoundingClientRect();

                this.previewImage.style.left = `${menuRect.right + 5}px`;
                this.previewImage.style.top = `${menuRect.top}px`;

                const previewRect = this.previewImage.getBoundingClientRect();
                if (previewRect.right > window.innerWidth) {
                    this.previewImage.style.left = `${menuRect.left - previewRect.width - 5}px`;
                }
                if (previewRect.bottom > window.innerHeight) {
                    this.previewImage.style.top = `${window.innerHeight - previewRect.height - 5}px`;
                }
                if (previewRect.top < 0) {
                    this.previewImage.style.top = `5px`;
                }
            };

            this.previewImage.onerror = () => {
                this.hidePreview();
            };

            this.previewImage.src = url;
        };

        // Handle data URLs directly
        if (imageUrl.startsWith('data:')) {
            processImage(imageUrl);
        } else {
            // Use cache for server URLs
            Promise.resolve(getCache(imageUrl, 'src')).then(url => {
                processImage(url);
            })
            .catch((error) => {
                // This will now catch the 'Image not found' rejection from the cache
                // and prevent further requests for the same URL.
                this.hidePreview();
            });
        }
    }

    hidePreview() {
        // Remove all preview images from this instance's root to prevent accumulation or orphaned images
        if (this.root) {
            const existingPreviews = this.root.querySelectorAll('img');
            existingPreviews.forEach(img => img.remove());
        }
        
        // Clear current instance's preview reference
        if (this.previewImage) {
            // Only call remove() if it's a DOM element, not a File object
            if (this.previewImage.remove && typeof this.previewImage.remove === 'function') {
                this.previewImage.remove();
            }
            this.previewImage = null;
        }
    }

    async setPreview() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';
        document.body.appendChild(input);

        return new Promise((resolve) => {
            input.addEventListener('change', async (event) => {
                const file = event.target.files[0];
                if (file) {
                    const formData = new FormData();
                    // Check if this context has tag (TagEditContextMenu) or use generic approach
                    if (this.tag) {
                        formData.append('type', this.tag.type);
                        formData.append('name', this.tag.name);
                        formData.append('image_file', file, file.name);
                    } else {
                         // For TagGroupContextMenu - store the image for later use and show preview
                         this.previewImage = file;
                         
                         // Create a data URL to show the preview immediately
                         const reader = new FileReader();
                         reader.onload = (e) => {
                             this.showPreview(e.target.result);
                         };
                         reader.readAsDataURL(file);
                         
                         resolve(file);
                         document.body.removeChild(input);
                         return;
                     }

                    try {
                        const response = await fetch('/erenodes/save_file_image', {
                            method: 'POST',
                            body: formData
                        });

                        if (response.ok) {
                            const result = await response.json();
                            const successMessage = result.message || 'Image saved successfully.';
                            app.extensionManager.toast.add({
                                severity: 'success',
                                summary: 'Saved',
                                detail: successMessage,
                                life: 4000
                            });
                            
                            // Clear image cache and update preview (only for TagEditContextMenu)
                            if (this.tag) {
                                clearCache(`/erenodes/view/${this.tag.type}/${this.tag.name}`);
                                this.showPreview(`/erenodes/view/${this.tag.type}/${this.tag.name}`);
                            }
                            
                            // Call imageCallback if it exists
                            if (this.imageCallback && typeof this.imageCallback === 'function') {
                                this.imageCallback();
                            }
                        } else {
                            const result = await response.json();
                            const errorMessage = result.error || result.message || 'Unknown error saving image.';
                            console.error('[EreNodes] Error saving image:', errorMessage);
                            app.extensionManager.toast.add({
                                severity: 'error',
                                summary: 'Save Error',
                                detail: errorMessage,
                                life: 5000
                            });
                        }
                    } catch (error) {
                        console.error('[EreNodes] Error saving image:', error);
                        app.extensionManager.toast.add({
                            severity: 'error',
                            summary: 'Save Operation Error',
                            detail: error.message,
                            life: 5000
                        });
                    }
                }
                document.body.removeChild(input);
                resolve(file);
            });

            input.addEventListener('focus', () => {
                document.body.removeChild(input);
                resolve(null);
            });

            input.click();
        });
    }

}

// A new context menu for folders and files
export class FileContextMenu extends DynamicContextMenu {
    constructor(event, onSelectCallback, type, existingTags = []) {
        super(event, onSelectCallback);
        this.type = type; // 'lora', 'embedding', or 'group'
        this.existingTags = existingTags;
        this.currentPath = "";
        this.currentWord = "";
        this.previewImage = null;
        this.filterBox = null;
    }

    async searchFiles(path = "", query = "") {
        try {
            const url = `/erenodes/search_files?type=${this.type}&path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            return data;
        } catch (error) {
            console.error(`[EreNodes] Error searching ${this.type} files:`, error);
            // On error, don't try to calculate a parent. Let the UI handle it gracefully.
            return { items: [], currentPath: path, parentPath: undefined };
        }
    }
    
    setHighlight(index) {
        super.setHighlight(index);
    }

    async show(initialPath = "") {
        this.close();

        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        this.root.close = this.close.bind(this);
        
        const { clientX: x, clientY: y } = this.event;
        Object.assign(this.root.style, {
            left: `${x}px`,
            top: `${y}px`,
        });

        document.body.appendChild(this.root);
        
        this.setupEventListeners();
        this.updateOptions(initialPath, "");
    }
    
    async updateOptions(path, query = "") {
        this.currentPath = path;
        this.currentWord = query;
        const data = await this.searchFiles(path, query);
        
        const parentPath = data.parentPath;
        const items = data?.items || [];
        
        const folders = items.filter(item => item.type === 'folder');
        const files = items.filter(item => item.type !== 'folder');

        this.options = [
            { 
                type: 'filter', 
                placeholder: `Filter ${this.type}s...`,
                onInput: (query) => this.updateOptions(this.currentPath, query)
            }
        ];

        if (this.currentPath) {
            this.options.push({
                name: "⬆️ Up",
                type: 'action',
                callback: () => {
                    this.updateOptions(parentPath !== undefined ? parentPath : "", "");
                }
            });
            this.options.push({ type: 'separator' });
        }
        
        // Add "Load all from folder" option if applicable
        const addableFiles = files.filter(f => !this.existingTags.some(tag => tag.name === f.path && tag.type === this.type));
        if (addableFiles.length > 0) {
            this.options.push({
                name: "➕ Load all from folder",
                type: 'action',
                callback: () => {
                    if (this.onSelect) {
                        const filesToLoad = addableFiles.map(file => ({
                            name: file.path,
                            type: this.type,
                            extension: file.extension
                        }));
                        this.onSelect(filesToLoad); // Pass array of addable files
                        this.close();
                    }
                }
            });
            this.options.push({ type: 'separator' });
        }

        if (this.currentPath) {
        }
        
        folders.forEach(folder => {
            this.options.push({
                name: "📁 " + folder.name,
                type: 'folder',
                path: folder.path,
                callback: () => this.updateOptions(folder.path, "")
            });
        });

        files.forEach(file => {
            // Filter out files that already exist, checking by both name and type
            const fileExists = this.existingTags.some(tag => tag.name === file.path && tag.type === this.type);
            if (!fileExists) {
                this.options.push({
                    name: file.name,
                    type: this.type,
                    path: file.path,
                    extension: file.extension,
                    callback: (e, index) => {
                        if (this.onSelect) {
                            this.onSelect({ name: file.path, type: this.type, extension: file.extension });
                        }
                        if (e?.shiftKey) {
                            this.existingTags.push({ name: file.path, type: this.type });
                            // After updating the options, we want to control the highlight
                            this.updateOptions(this.currentPath, this.currentWord).then(() => {
                                let newHighlight = index;
                                // If the removed item was the last one, the index will be out of bounds.
                                // In that case, we want to highlight the new last item.
                                if (newHighlight >= this.options.length) {
                                    newHighlight = this.options.length - 1;
                                }
                                this.setHighlight(newHighlight);
                            });
                        } else {
                            this.close();
                        }
                    }
                });
            }
        });
        
        this.renderItems();
    }
}

// A new context menu for csv tags
export class TagContextMenu extends DynamicContextMenu {
    constructor(event, onSelectCallback, existingTags = []) {
        super(event, onSelectCallback);
        // Handle both string arrays (from autocomplete) and object arrays (from other contexts)
        this.existingTags = existingTags;
        this.currentWord = ""; 
        this.filterBox = null;
        
        // Determine how to position the menu
        if (event instanceof MouseEvent) {
            this.positioning = { event };
        } else if (event?.tagName === 'TEXTAREA' || event?.tagName === 'INPUT') {
            this.positioning = { element: event };
        }
    }

    async searchTags(query) {
        this.currentWord = query;
        let suggestions = [];
        try {
            const response = await fetch(`/erenodes/search_tags?query=${encodeURIComponent(query)}&limit=20`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const tags = await response.json();
            suggestions = tags.filter(tag => !this.existingTags.some(existingTag => existingTag.name === tag.name && existingTag.type === 'tag'));
        } catch (error) {
            console.error("[EreNodes] Error searching tags:", error);
        }
        this.updateOptions(suggestions);
    }
    
    updateOptions(tagSuggestions = []) {
        const query = this.currentWord;
        this.options = [];

        const tagOptions = tagSuggestions.map(s => ({
            ...s,
            type: 'tag',
            callback: () => { this.onSelect(s.name); this.close(); }
        }));

        this.options.push(...tagOptions);
        this.renderItems();
    }

    renderSingleItem(item, option, index) {
        const query = this.currentWord.toLowerCase().replace(/_/g, ' ');

        if (option.type === 'tag' && (option.count || option.aliases?.length > 0)) {
            // This is a "rich" tag from the database
            item.className = "litemenu-entry submenu";
            if (option.disabled) item.classList.add("disabled");

            const displayHTML = this.highlight(option.name, query);
            let countHTML = option.count ? `<div style="font-size: 0.8em; opacity: 0.7; margin-left: 10px;">(${option.count.toLocaleString()})</div>` : '';
            let aliasesHTML = (option.aliases && option.aliases.length) ? `<div style="font-size: 0.8em; opacity: 0.7;">${option.aliases.map(a => this.highlight(a, query)).join(', ')}</div>` : '';
            item.innerHTML = `<div style="display: flex; justify-content: space-between; align-items: center;"><div>${displayHTML}</div>${countHTML}</div>${aliasesHTML}`;

            item.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.onItemSelected(option, e, index);
            });

            item.addEventListener("mouseenter", () => {
                if (!option.disabled) this.setHighlight(index);
            });
        } else {
            // This handles "simple" tags (like add actions) and any other default cases
            super.renderSingleItem(item, option, index);
        }
    }

    show() {
        this.close();
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        this.root.close = this.close.bind(this);

        if (this.positioning?.event) {
            const { clientX: x, clientY: y } = this.positioning.event;
            Object.assign(this.root.style, { left: `${x}px`, top: `${y}px` });
        } else if (this.positioning?.element) {
            // Use the helper function to get precise cursor coordinates
            const rect = this.positioning?.element.getBoundingClientRect();
            const coords ={ x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom };
            Object.assign(this.root.style, { left: `${coords.x}px`, top: `${coords.bottom}px` });
        }
        
        document.body.appendChild(this.root);
        this.setupEventListeners();
    }
}

// For the + button to switch between csv and file tags
export class TagContextMenuInsert extends TagContextMenu {
    constructor(event, onSelectCallback, existingTags = []) {
        super(event, onSelectCallback, existingTags);
        this.show();
    }

    
    show() {
        super.show(); 
        this.searchTags(""); // This will call this class's updateOptions
    }

    // Override parent's updateOptions to add special items
    updateOptions(tagSuggestions = []) {
        const query = this.currentWord;
        
        // Build the list of standard tag options first
        const tagOptions = [];
        const exactMatch = tagSuggestions.some(s => s.name.toLowerCase() === query.toLowerCase());
        
        // Add the "Add tag: ..." option only if there's a query that isn't an exact match
        // OR if there are multiple suggestions (even with an exact match)
        if (query && (!exactMatch || tagSuggestions.length > 1)) {
            tagOptions.push({
                name: `➕ Add tag: "${query}"`,
                type: 'action',
                callback: () => {
                    const newTag = { name: query, type: 'tag' };
                    this.onSelect(newTag);
                    this.existingTags.push(newTag);
                    this.searchTags("");
                }
            });
        }
        
        // Add the suggestions from the search
        tagSuggestions.forEach(s => tagOptions.push({
            ...s,
            type: 'tag',
            callback: () => {
                const newTag = { name: s.name, type: 'tag' };
                this.onSelect(newTag);
                this.existingTags.push(newTag);
                this.searchTags("");
            }
        }));
        
        // Create our special options that appear at the top of this specific menu
        const specialOptions = [];
        specialOptions.push({
            type: 'filter',
            placeholder: 'Type to add tag...',
            onInput: (query) => this.searchTags(query)
        });
        
        // Show file-type options only when the search is empty
        if (!query) {
            specialOptions.push({ name: 'Add Lora', type: 'tag', callback: () => this.switchToFileMenu('lora') });
            specialOptions.push({ name: 'Add Embedding', type: 'tag', callback: () => this.switchToFileMenu('embedding') });
            specialOptions.push({ name: 'Add Tag Group', type: 'tag', callback: () => this.switchToFileMenu('group') });
        }
        
        // Combine special options with the dynamic tag options
        this.options = [...specialOptions, ...tagOptions];

        this.renderItems();
    }

    switchToFileMenu(type) {
        this.close();
        const fileMenu = new FileContextMenu(this.positioning.event, (selected) => {
            // The callback can now receive a single object or an array of objects
            const itemsToAdd = Array.isArray(selected) ? selected : [selected];
            itemsToAdd.forEach(item => {
                // Ensure we don't add duplicates if the user re-opens the menu
                const alreadyExists = this.existingTags.some(tag => tag.name === item.name && tag.type === item.type);
                if (!alreadyExists) {
                    this.onSelect(item);
                }
            });
            this.close(); // Close the parent TagContextMenuInsert
        }, type, this.existingTags);
        fileMenu.show();
    }
}

// For tag quick edit
export class TagEditContextMenu extends DynamicContextMenu {
    constructor(event, tagObject, saveCallback, deleteCallback, moveCallback, imageCallback, tagIndex = null, nodeScreenWidth = null, existingTags = []) { // Added nodeScreenWidth and existingTags
        super(event, saveCallback); // The primary callback on save.
        this.tag = JSON.parse(JSON.stringify(tagObject)); // Deep copy to edit safely
        this.nodeScreenWidth = nodeScreenWidth; // Store node screen width
        this.deleteCallback = deleteCallback;
        this.moveCallback = moveCallback;
        this.imageCallback = imageCallback;
        this.tagIndex = tagIndex; // Track by index instead of name
        this.existingTags = existingTags; // Store existing tags for file filtering
        this.isSpecialType = ['lora', 'embedding', 'group'].includes(this.tag.type);
        this.previewImage = null;
        this.filterBoxOverrides = ['ArrowLeft', 'ArrowRight'];

        // Ensure defaults
        if (this.tag.strength === undefined) this.tag.strength = 1.0;
        this.tag.triggers = this.tag.triggers || [];

        this.init();
    }

    async init() {
        this.options = [];

        // Add dynamic title based on tag type
        this.options.push({ name: 'Edit ' + this.tag.type, type: 'title' });

        // 1. Name Control (conditional)
        if (this.isSpecialType) {
            this.options.push({
                name: `🔁 ${this.tag.name}`,
                callback: () => this.switchToFileMenu(this.tag.type)
            });
        } else {
            this.options.push({ type: 'filter' });
        }

        // 2. Strength Control (not for groups)
        if (this.tag.type !== 'group') {
             this.options.push({ name: 'strength', type: 'strength_control' });
        }
        
        // 3. Info Panel (for lora triggers, group contents)
        if (this.isSpecialType) {
            const infoPanelContent = await this.fetchInfoPanelContent();
            if (infoPanelContent && infoPanelContent.length > 0) {
                this.options.push({ type: 'separator' });
                this.options.push({ type: 'info_panel', content: infoPanelContent, disabled: true });
            }
        }
        
        this.options.push({ type: 'separator' });

        if (this.isSpecialType) {
            this.options.push({
                name: "🖼️ Set Image",
                callback: () => this.setPreview()
            });
        }
        // 5. Action Buttons
        const createCallback = (cb) => () => { cb(); this.close(); };
        this.options.push(
            { name: "⬆️ Move Up", callback: createCallback(() => this.moveCallback(-1)) },
            { name: "⬇️ Move Down", callback: createCallback(() => this.moveCallback(1)) },
            { name: "🗑️ Remove", callback: createCallback(() => this.deleteCallback()) }
        );
        
        this.show();
    }

    show() {
        // This method creates the root element and sets up basic properties and listeners
        this.close(); // Close any existing menu
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        this.root.close = this.close.bind(this);
        
        const { clientX: x, clientY: y } = this.event;
        Object.assign(this.root.style, {
            left: `${x}px`,
            top: `${y}px`,
            width: 'auto', // Allow menu to grow based on content
            minWidth: '150px' // A sensible default minimum width
        });
        if (this.nodeScreenWidth && this.nodeScreenWidth > 0) {
            this.root.style.maxWidth = this.nodeScreenWidth - 28 + 'px';
        }

        document.body.appendChild(this.root);
        this.renderItems();
        this.setupEventListeners(); // Use the inherited setup

        // show preview
        if (this.isSpecialType) {
            this.showPreview(`/erenodes/view/${this.tag.type}/${this.tag.name}`);
        }

    }
    
    renderItems() {
        this.root.innerHTML = '';
        this.renderedOptionElements = [];

        this.options.forEach((option, i) => {
            let element;
            if (option.type === 'filter') {
                // Create the input element directly for proper styling
                // Using input as per previous requirement for autocomplete

                element = document.createElement("textarea");
                element.className = "comfy-context-menu-filter";
                element.value = this.tag.name;
                element.style.background = "#222";
                element.style.minWidth = "100%";
                element.style.margin = "0";
                element.style.width = "fit-content";
                element.style.fieldSizing = "content";
                element.placeholder = "Close to remove tag."; // remove when empty


                element.addEventListener("input", () => {
                    this.tag.name = element.value;
                    if (element.value.trim()) {
                        this.onSelect(this.updateTag());
                    }
                });

                element.addEventListener("click", () => {
                    this.setHighlight(-1);
                });
                
                this.filterBox = element;

                // Attach global autocomplete to this input
                setTimeout(() => {
                    app.globalAutocompleteInstance.attach(element);
                    element.focus();
                }, 0);
            } else {
                // For all other types, create the standard div wrapper
                element = document.createElement("div");
                this.renderSingleItem(element, option, i);
            }
            
            element.dataset.optionIndex = i;
            this.root.appendChild(element);
            this.renderedOptionElements.push(element);
        });

        this.setInitialHighlight();
    }

    renderSingleItem(item, option, index) {
        switch(option.type) {
            case 'strength_control':
                item.className = "litemenu-entry submenu";
                item.style.display = "flex";
                item.style.justifyContent = "space-between";
                item.style.alignItems = "center";
                
                const textSpan = document.createElement("span");
                const strengthDisplay = () => `Strength: ${this.tag.strength.toFixed(2)}`;
                textSpan.textContent = strengthDisplay();
                
                const createButton = (text, onClick) => {
                    const btn = document.createElement("button");
                    btn.textContent = text;
                    btn.style.cssText = "background:none; border:none; line-height:1; font-size:12px; cursor:pointer; color:white; padding: 2px 5px;";
                    btn.onclick = (e) => { e.stopPropagation(); onClick(e); };
                    return btn;
                };

                const updateDisplay = () => { 
                    textSpan.textContent = strengthDisplay(); 
                    this.onSelect(this.updateTag());
                };
                const decBtn = createButton("◀", (e) => { this.tag.strength = parseFloat((this.tag.strength - (e.shiftKey ? 0.1 : 0.05)).toFixed(2)); updateDisplay(); });
                const incBtn = createButton("▶", (e) => { this.tag.strength = parseFloat((this.tag.strength + (e.shiftKey ? 0.1 : 0.05)).toFixed(2)); updateDisplay(); });
                item.append(decBtn, textSpan, incBtn);

                item.addEventListener("mouseenter", () => {
                    if (!option.disabled) this.setHighlight(index);
                });

                // Add drag functionality
                item.addEventListener('mousedown', (e) => {
                    if (e.button !== 0 || e.target.nodeName === "BUTTON") return;
                    e.preventDefault(); e.stopPropagation();
                    let startX = e.clientX, startValue = this.tag.strength;
                    const onMouseMove = (moveEvent) => {
                        this.tag.strength = parseFloat((startValue + Math.round((moveEvent.clientX - startX) / 5) * 0.05).toFixed(2));
                        updateDisplay();
                    };
                    const onMouseUp = () => window.removeEventListener('mousemove', onMouseMove, true);
                    window.addEventListener('mousemove', onMouseMove, true);
                    window.addEventListener('mouseup', onMouseUp, true);
                });
                break;
            
            case 'info_panel':
                item.className = "litemenu-entry submenu disabled";
                item.style.cssText = "max-width: 256px; display: flex; flex-wrap: wrap; gap: 2.5px; opacity: 1";
                if (Array.isArray(option.content)) {
                    option.content.forEach(pill => item.appendChild(pill));
                }
                break;

            default:
                super.renderSingleItem(item, option, index);
                break;
        }
    }

    handleKeyboard(e) {
        // If the autocomplete dropdown is visible, let it handle keyboard events first.
        const autocompleteMenu = app.globalAutocompleteInstance.menu;
        if (autocompleteMenu && autocompleteMenu.root) {
            if (autocompleteMenu.handleKeyboard(e)) {
                return true; // Autocomplete handled it, so we're done.
            }
        }

        // Handle "Save on Enter" for the name input ONLY if autocomplete did not handle it.
        if (e.key === 'Enter' && this.filterBox && document.activeElement === this.filterBox) {
            // If the input is empty, delete the tag
            if (!this.filterBox.value.trim()) {
                this.deleteCallback();
            } else {
                this.onSelect(this.updateTag());
            }
            this.close();
            e.preventDefault();
            e.stopPropagation();
            return true;
        }

        if (this.highlighted !== -1) {
            const highlightedOption = this.options[this.highlighted];
            if (highlightedOption.type === 'strength_control') {
                const step = e.shiftKey ? 0.1 : 0.05;
                let handled = false;
                if (e.key === 'ArrowLeft') { this.tag.strength = parseFloat((this.tag.strength - step).toFixed(2)); handled = true; }
                if (e.key === 'ArrowRight') { this.tag.strength = parseFloat((this.tag.strength + step).toFixed(2)); handled = true; }
                if (handled) {
                    // Find the rendered element and update its display
                    const strengthControlElement = this.root.querySelector('.litemenu-entry[style*="justify-content"] span');
                    if (strengthControlElement) strengthControlElement.textContent = `Strength: ${this.tag.strength.toFixed(2)}`;
                    this.onSelect(this.updateTag());
                    e.preventDefault(); e.stopPropagation();
                    return true;
                }
            }
        }
        // Fallback to parent for default navigation (Up/Down from input, etc.)
        return super.handleKeyboard(e);
    }
    
    switchToFileMenu(type) {
        this.root.style.display = 'none'; // Hide instead of closing
        const fileMenu = new FileContextMenu(this.event, async (selectedFile) => {
            // Update the tag object with the new file info
            this.tag.name = selectedFile.name;
            this.tag.extension = selectedFile.extension;
            // When switching to a new file, clear any triggers from the old one.
            this.tag.triggers = [];

            // First, save the change. The saveCallback from prompt.js will update the node data.
            if (this.onSelect) {
                this.onSelect(this.updateTag());
            }

            // Then, re-initialize this menu to reflect the new tag's data (e.g., fetch new triggers).
            // This also re-opens the quick edit menu.
            await this.init();
        }, type, this.existingTags);

        const originalFileMenuClose = fileMenu.close.bind(fileMenu);
        fileMenu.close = () => {
            originalFileMenuClose();
            if (this.root) {
                this.root.style.display = 'block'; // Show it again if no selection was made
            }
        };
        
        fileMenu.show();
    }

    async fetchInfoPanelContent() {
        try {
            let url;
            if (this.tag.type === 'lora') {
                url = `/erenodes/get_lora_metadata?filename=${encodeURIComponent(this.tag.name + this.tag.extension)}`;
                const metadata = getCache(url, 'json');
                const resolvedMetadata = metadata instanceof Promise ? await metadata : metadata;
                return this.processLoraMetadata(resolvedMetadata);
            } else if (this.tag.type === 'group') {
                url = `/erenodes/get_tag_group?filename=${encodeURIComponent(this.tag.name + this.tag.extension)}`;
                const groupTags = getCache(url, 'json');
                const resolvedGroupTags = groupTags instanceof Promise ? await groupTags : groupTags;
                return this.processGroupTags(resolvedGroupTags);
            }
        } catch (error) {
            console.error("[EreNodes] Error loading side panel content:", error);
        }
        return null;
    }

    processLoraMetadata(metadata) {
        const pills = [];
        let freq_tags = metadata.ss_tag_frequency;
        if (freq_tags && typeof freq_tags === 'string') {
            try { freq_tags = JSON.parse(freq_tags); } catch(e) { freq_tags = null; }
        }
        if (freq_tags) {
            let allTags = {};
            for (const dir in freq_tags) for (const tag in freq_tags[dir]) allTags[tag] = (allTags[tag] || 0) + freq_tags[dir][tag];
            const sortedTags = Object.entries(allTags).sort(([,a],[,b]) => b-a).slice(0, 20);
            if (sortedTags.length > 0) sortedTags.forEach(([tag]) => pills.push(this.createPill(tag, true)));
        }
        return pills;
    }

    processGroupTags(groupTags) {
        const pills = [];
        if (groupTags && Array.isArray(groupTags) && groupTags.length > 0) {
            const activeTags = groupTags.filter(t => t.active && t.name);
            if (activeTags.length > 0) activeTags.forEach(tag => pills.push(this.createPill(tag, false)));
        }
        return pills;
    }

    createPill(tagOrTrigger, isTrigger) {
        const pillEl = document.createElement('span');
        let displayName, pillFill;
        pillEl.style.cssText = `padding: 2.5px 7.5px; border-radius: 5px; font-size: 11px; color: white; display: inline-block; max-width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; vertical-align: middle; line-height: 1.5;`;
        
        if (isTrigger) {
            displayName = tagOrTrigger;
            const isTriggerActive = this.tag.triggers.includes(tagOrTrigger);
            pillFill = isTriggerActive ? "#414650" : "#262626"; // Active/Inactive colors
            pillEl.style.cursor = "pointer";
            pillEl.style.boxShadow = isTriggerActive ? "" : "0px 0px 0px 1px #444 inset";
            pillEl.onclick = () => {
                const triggerIndex = this.tag.triggers.indexOf(tagOrTrigger);
                if (triggerIndex > -1) {
                    this.tag.triggers.splice(triggerIndex, 1);
                    pillEl.style.background = "#262626"; // Inactive
                    pillEl.style.boxShadow = "0px 0px 0px 1px #444 inset";
                } else {
                    this.tag.triggers.push(tagOrTrigger);
                    pillEl.style.background = "#414650"; // Active
                    pillEl.style.boxShadow = "";
                }
                this.onSelect(this.updateTag());
            };
        } else {
            const tag = tagOrTrigger;
            displayName = tag.name;
            pillFill = "#414650"; 
            pillEl.style.cursor = "default";
            if (tag.type === 'lora') pillFill = "#415041"; // Dark green-ish
            else if (tag.type === 'embedding') pillFill = "#504149"; // Dark purple-ish
            else if (tag.type === 'group') pillFill = "#504c41"; // Dark orange-ish
            if (tag.strength && tag.strength !== 1.0) displayName += `:${parseFloat(tag.strength).toFixed(2)}`;
        }
        pillEl.style.background = pillFill;
        pillEl.textContent = displayName;
        pillEl.title = displayName;
        return pillEl;
    }

    close() {
        // Check if we need to delete the tag due to empty name when closing
        const nameInput = this.root?.querySelector('.comfy-context-menu-filter');
        if (nameInput && !nameInput.value.trim() && !this.isSpecialType) {
            // Only delete if it's a regular tag (not special type) and name is empty
            this.deleteCallback();
        }
        
        // Detach autocomplete if it's attached to our input
        if (nameInput && app.globalAutocompleteInstance.attachedElement === nameInput) {
             app.globalAutocompleteInstance.detach();
        }
        super.close();
    }

    updateTag() {
        const tagCopy = JSON.parse(JSON.stringify(this.tag));
        // If strength is effectively 1.0 (or very close due to float precision),
        // delete it from the copy to ensure it's not saved in the JSON.
        // This applies to all tag types.
        if (tagCopy.strength !== undefined && Math.abs(tagCopy.strength - 1.0) < 0.0001) {
            delete tagCopy.strength;
        }
        return tagCopy;
    }

}

// For save and load tag group
export class TagGroupContextMenu extends FileContextMenu {
    constructor(event, onSelectCallback, type, mode) {
        super(event, onSelectCallback, type);
        this.mode = mode;
        this.saveMode = "browse"; // "browse" or "options"
        this.saveFileName = "";
    }

    async updateOptions(path, query = "") {
        if (this.mode === "save") {
            this.currentPath = path;
            this.currentWord = query;
            
            if (this.saveMode === "options") {
                 // Show save options after clicking "Save Here"
                 this.options = [
                     { 
                         type: 'filter', 
                         placeholder: 'Enter filename...',
                         onInput: (value) => {
                             this.saveFileName = value;
                         }
                     },
                     {
                        name: "🖼️ Set Image",
                        callback: async () => {
                            await super.setPreview();
                        }
                    },
                     {
                         name: "💾 Save",
                         type: 'save',
                         callback: () => this.executeSave(false)
                     },
                     {
                         name: "💾 Save and Replace",
                         type: 'save_replace',
                         callback: () => this.executeSave(true)
                     },
                     {
                         name: "⬅️ Back",
                         type: 'back',
                         callback: () => {
                             this.saveMode = "browse";
                             this.updateOptions(this.currentPath, "");
                         }
                     }
                 ];
                 this.renderItems();
                 
                 // Show preview of selected image if available
                 if (this.saveImageFile) {
                     const reader = new FileReader();
                     reader.onload = (e) => {
                         this.showPreview(e.target.result);
                     };
                     reader.readAsDataURL(this.saveImageFile);
                 }
                 return;
             }
            
            // Default browse mode - reuse parent logic but override file callbacks
            await super.updateOptions(path, query);
            
            // Find the filter option and inject save options after it
            const filterIndex = this.options.findIndex(option => option.type === 'filter');
            const saveOptions = [
                {
                    name: "💾 Save Here",
                    callback: () => {
                        this.saveMode = "options";
                        this.updateOptions(this.currentPath, "");
                    }
                },
                {
                    name: "📁 Create New Folder",
                    type: 'create_folder',
                    callback: () => this.createNewFolder()
                },
                { type: 'separator' }
            ];
            
            // Override file callbacks to show confirmation dialog
            this.options = this.options.map(option => {
                if (option.type === 'file') {
                    return {
                        ...option,
                        callback: async () => {
                            const confirmed = await app.extensionManager.dialog.confirm({
                                title: "Overwrite File",
                                message: `Do you want to overwrite '${option.name.replace('📄 ', '')}'?`,
                                type: "overwrite"
                            });
                            if (!confirmed) return;
                            
                            if (this.onSelect) {
                                this.onSelect({
                                    filename: option.name.replace('📄 ', ''),
                                    path: this.currentPath,
                                    extension: option.extension,
                                    shouldReplace: false,
                                    imageFile: null
                                });
                            }
                            this.close();
                        }
                    };
                }
                return option;
            });
            
            // Insert save options after the filter
            if (filterIndex !== -1) {
                this.options.splice(filterIndex + 1, 0, ...saveOptions);
            } else {
                // Fallback: add at beginning if no filter found
                this.options = [...saveOptions, ...this.options];
            }
            this.renderItems();
        } else {
            // Load mode - use parent implementation
            await super.updateOptions(path, query);
        }
    }

    executeSave(shouldReplace) {
        const filename = this.filterBox ? this.filterBox.value.trim() : this.saveFileName.trim();
        if (!filename) {
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Invalid Filename",
                detail: "Please enter a filename.",
                life: 3000
            });
            return;
        }

        let finalFileName = filename;
        if (!finalFileName.toLowerCase().endsWith('.json')) {
            finalFileName += '.json';
        }

        if (this.onSelect) {
            this.onSelect({
                filename: finalFileName,
                path: this.currentPath,
                extension: '.json',
                shouldReplace: shouldReplace,
                imageFile: this.previewImage
            });
        }
        this.close();
    }

    async createNewFolder() {
        const folderName = prompt("Enter new folder name:", "New Folder");
        if (!folderName || folderName.trim() === "") return;

        try {
            const response = await fetch('/erenodes/create_folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    path: this.currentPath,
                    folderName: folderName.trim(),
                }),
            });
            if (response.ok) {
                this.updateOptions(this.currentPath, "");
            } else {
                const error = await response.json();
                console.error("[EreNodes] Error creating folder:", error.error);
                app.extensionManager.toast.add({
                    severity: "error",
                    summary: "Folder Creation Error",
                    detail: error.error || "Failed to create folder",
                    life: 5000
                });
            }
        } catch (error) {
            console.error("[EreNodes] Error creating folder:", error);
            app.extensionManager.toast.add({
                severity: "error",
                summary: "Folder Creation Error",
                detail: error.message,
                life: 5000
            });
        }
    }



    close() {
        super.close();
    }

}
