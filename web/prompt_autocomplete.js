import { app } from "../../../scripts/app.js";

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

    onItemSelected(option) {
        if (option && !option.disabled && option.callback) {
            option.callback();
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
    }

    handleKeyboard(e) {
        const enabledOptions = this.options.map((o, i) => (!o.disabled && o.type !== 'separator') ? i : -1).filter(i => i !== -1);
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
                    this.onItemSelected(this.options[this.highlighted]);
                }
                handled = true;
                break;
            case "Escape":
                this.close();
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
                    this.onItemSelected(option);
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
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter' && e.key !== 'Escape') {
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
                    this.close();
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
        } 
    }

    setInitialHighlight() {
        // First, try to find a "real" suggestion that isn't an "add" action.
        let firstHighlight = this.options.findIndex(o => !o.disabled && o.type !== 'filter' && o.type !== 'separator' && o.type !== 'folder_up' && o.name && !o.name.startsWith('➕'));
        
        // If no "real" suggestion is found, fall back to highlighting the first available option (which could be "➕ Add tag...").
        if (firstHighlight === -1) {
            firstHighlight = this.options.findIndex(o => !o.disabled && o.type !== 'filter' && o.type !== 'separator');
        }

        // Set the highlight. If nothing is found, this will correctly be -1.
        this.setHighlight(firstHighlight);
    }
}

// A new context menu for folders and files
class FileContextMenu extends DynamicContextMenu {
    constructor(event, onSelectCallback, type) {
        super(event, onSelectCallback);
        this.type = type; // 'lora', 'embedding', or 'group'
        console.log(`[FileContextMenu] Created with type: ${this.type}`);
        this.currentPath = "";
        this.currentWord = "";
        this.previewImage = null;
        this.filterBox = null;
    }

    async searchFiles(path = "", query = "") {
        try {
            const url = `/erenodes/search_files?type=${this.type}&path=${encodeURIComponent(path)}&query=${encodeURIComponent(query)}`;
            console.log(`[FileContextMenu] Fetching from URL: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            console.log('[FileContextMenu] Received data from API:', data);
            return data;
        } catch (error) {
            console.error(`Error searching ${this.type} files:`, error);
            // On error, don't try to calculate a parent. Let the UI handle it gracefully.
            return { items: [], currentPath: path, parent_path: undefined };
        }
    }
    
    setHighlight(index) {
        super.setHighlight(index);
        
        if (index > -1) {
            const newItem = this.root.querySelector(`[data-option-index="${index}"]`);
            if (newItem && this.options[index] && !this.options[index].disabled) {
                this.showPreview(this.options[index], newItem);
            }
        } 
    }

    showPreview(option, itemElement) {
        this.hidePreview(); // Clear previous preview

        // We don't know for sure if a preview exists, but we can try to show one
        // for any item that isn't a folder. The backend will just 404 if it's not found.
        if (!itemElement || option.type === 'folder' || option.type === 'folder_up') {
            return;
        }
        
        const type = this.type + 's'; // e.g. 'loras'
        const path = option.path; // The path without extension, e.g. 'artist/748cm'
        const imageUrl = `/erenodes/view/${type}/${path}?mtime=${Date.now()}`;
        
        // Use fetch to check for the image first, to avoid console errors for 404s.
        fetch(imageUrl)
            .then(response => {
                if (!response.ok) {
                    return Promise.reject(); // Silently reject if not found
                }
                return response.blob();
            })
            .then(blob => {
                // If the menu was closed while fetching, don't show the preview
                if (!this.root || !this.root.isConnected) return;

                const objectURL = URL.createObjectURL(blob);
                
                this.previewImage = document.createElement('img');
                Object.assign(this.previewImage.style, {
                    position: 'fixed',
                    zIndex: 1001,
                    display: 'none',
                    maxWidth: '256px',
                    maxHeight: '256px',
                    border: '1px solid #ccc',
                });
                this.root.appendChild(this.previewImage);

                this.previewImage.src = objectURL;
                
                this.previewImage.onload = () => {
                    // Clean up the URL object to prevent memory leaks
                    URL.revokeObjectURL(objectURL);

                    this.previewImage.style.display = 'block';
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
                    if (previewRect.top < 0){
                        this.previewImage.style.top = `5px`;
                    }
                };

                this.previewImage.onerror = () => {
                    // This is a secondary fallback
                    this.hidePreview();
                };
            })
            .catch(() => {
                // This catch block handles the fetch rejection (e.g., 404) silently.
            });
    }

    hidePreview() {
        if (this.previewImage) {
            this.previewImage.remove();
            this.previewImage = null;
        }
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
        
        const parentPath = data.parent_path;
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
                type: 'folder_up',
                callback: () => {
                    this.updateOptions(parentPath || "", "");
                }
            });
            this.options.push({ type: 'separator' });
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
            this.options.push({
                name: file.name,
                type: this.type,
                path: file.path,
                extension: file.extension,
                callback: () => {
                    if (this.onSelect) {
                        this.onSelect({ name: file.path, type: this.type, extension: file.extension });
                    }
                    this.close();
                }
            });
        });
        
        this.renderItems();
    }
}

// A new context menu for csv tags
class TagContextMenu extends DynamicContextMenu {
    constructor(event, onSelectCallback, existingTags = []) {
        super(event, onSelectCallback);
        this.existingTags = new Set(existingTags.map(t => t.toLowerCase().replace(/_/g, ' ')));
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
            
            const existingTagsLower = new Set(Array.from(this.existingTags).map(t => t.toLowerCase()));
            suggestions = tags.filter(tag => !existingTagsLower.has(tag.name.toLowerCase()));
        } catch (error) {
            console.error("Error searching tags:", error);
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
                this.onItemSelected(option);
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
            const coords = getElementOrCursorCoords(this.positioning.element);
            Object.assign(this.root.style, { left: `${coords.x}px`, top: `${coords.bottom}px` });
        }
        
        document.body.appendChild(this.root);
        this.setupEventListeners();
    }
}

// For the + button, shows a menu to choose what to add.
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
                type: 'tag',
                callback: () => { this.onSelect({ name: query, type: 'tag' }); this.searchTags(""); }
            });
        }
        
        // Add the suggestions from the search
        tagSuggestions.forEach(s => tagOptions.push({
            ...s,
            type: 'tag',
            callback: () => { this.onSelect({ name: s.name, type: 'tag' }); this.searchTags(""); }
        }));
        
        // Create our special options that appear at the top of this specific menu
        const specialOptions = [];
        specialOptions.push({
            type: 'filter',
            placeholder: 'Filter tags...',
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
        const fileMenu = new FileContextMenu(this.positioning.event, (selectedFileObject) => {
            // selectedFileObject is already the correct {name, type} object passed from FileContextMenu
            this.onSelect(selectedFileObject);
            this.close(); // Close the parent TagContextMenuInsert as well
        }, type);
        fileMenu.show();
    }
}

export class TagEditContextMenu extends DynamicContextMenu {
    constructor(event, tagObject, saveCallback, deleteCallback, moveCallback, tagIndex = null, nodeScreenWidth = null) { // Added nodeScreenWidth
        super(event, saveCallback); // The primary callback on save.
        this.tag = JSON.parse(JSON.stringify(tagObject)); // Deep copy to edit safely
        this.nodeScreenWidth = nodeScreenWidth; // Store node screen width
        this.deleteCallback = deleteCallback;
        this.moveCallback = moveCallback;
        this.tagIndex = tagIndex; // Track by index instead of name
        this.isSpecialType = ['lora', 'embedding', 'group'].includes(this.tag.type);
        this.previewImage = null;

        // Ensure defaults
        if (this.tag.strength === undefined) this.tag.strength = 1.0;
        this.tag.triggers = this.tag.triggers || [];

        this.init();
    }

    async init() {
        this.options = [];

        // 1. Name Control (conditional)
        if (this.isSpecialType) {
            this.options.push({
                name: `🔁 ${this.tag.name}`,
                type: 'action',
                callback: () => this.switchToFileMenu(this.tag.type)
            });
        } else {
            this.options.push({ type: 'name_input' });
        }

        // 2. Strength Control (not for groups)
        if (this.tag.type !== 'group') {
             this.options.push({ type: 'strength_control' });
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

        // 4. Action Buttons
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
        this.renderMenu();
        this.setupEventListeners(); // Use the inherited setup
        this.showPreview();
    }
    
    renderMenu() {
        this.renderItems();
        // Set initial focus/highlight away from any text inputs
        const firstHighlight = this.options.findIndex(o => o.type !== 'name_input');
        this.setHighlight(firstHighlight !== -1 ? firstHighlight : 0);
    }
    
    renderItems() {
        this.root.innerHTML = '';
        this.renderedOptionElements = [];

        this.options.forEach((option, i) => {
            let element;
            if (option.type === 'name_input') {
                // Create the input element directly for proper styling
                // Using input as per previous requirement for autocomplete

                element = document.createElement("textarea");
                element.className = "comfy-context-menu-filter";
                element.value = this.tag.name;
                element.style.minWidth = "calc(100% - 10px)";
                element.style.width = "fit-content";
                element.style.fieldSizing = "content";
                element.placeholder = "Close to remove tag."; // remove when empty

                // Your existing dynamic width logic for the input will be respected
                // by the menu's maxWidth set in show().
                // For clarity, if you have a function like adjustInputWidth(el),
                // it would be called here and in the event listener.
                // Example (assuming you have such a function):
                // const adjustInputWidth = (el) => { /* your logic */ };
                // adjustInputWidth(element);


                element.addEventListener("input", () => {
                    this.tag.name = element.value;
                    // if (typeof adjustInputWidth === 'function') adjustInputWidth(element);
                    if (element.value.trim()) {
                        this.onSelect(this.updateTag());
                    }
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
                item.style.cssText = "max-width: 256px; display: flex; flex-wrap: wrap; gap: 4px; opacity: 1";
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
        }, type);

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
            if (this.tag.type === 'lora') {
                const response = await fetch(`/erenodes/get_lora_metadata?filename=${encodeURIComponent(this.tag.name + this.tag.extension)}`);
                if (response.ok) return this.processLoraMetadata(await response.json());
            } else if (this.tag.type === 'group') {
                const response = await fetch(`/erenodes/get_tag_group?filename=${encodeURIComponent(this.tag.name + this.tag.extension)}`);
                if (response.ok) return this.processGroupTags(await response.json());
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
        this.hidePreview();
        super.close();
    }

    updateTag() {
        // If strength is default (1.0), remove it from the object before saving to avoid cluttering the JSON.
        const tagCopy = JSON.parse(JSON.stringify(this.tag));
        if (tagCopy.strength === 1.0) {
            delete tagCopy.strength;
        }
        return tagCopy;
    }



    showPreview() {
        this.hidePreview();

        if (!this.isSpecialType) {
            return;
        }
        
        // The type needs to be plural for the view endpoint (e.g., 'loras')
        const type = this.tag.type + 's';
        // The name should not include the file extension. The backend handles finding the preview.
        const path = this.tag.name;
        const imageUrl = `/erenodes/view/${type}/${path}?mtime=${Date.now()}`;
        
        fetch(imageUrl)
            .then(response => {
                if (!response.ok) {
                    return Promise.reject(); // Silently reject
                }
                return response.blob();
            })
            .then(blob => {
                if (!this.root || !this.root.isConnected) return;

                const objectURL = URL.createObjectURL(blob);
                this.previewImage = document.createElement('img');
                Object.assign(this.previewImage.style, {
                    position: 'fixed',
                    zIndex: 1001,
                    display: 'none',
                    maxWidth: '256px',
                    maxHeight: '256px',
                    border: '1px solid #353535',
                });
                // Append to the menu itself so it's removed automatically when the menu closes
                this.root.appendChild(this.previewImage);

                this.previewImage.src = objectURL;
                
                this.previewImage.onload = () => {
                    URL.revokeObjectURL(objectURL);

                    this.previewImage.style.display = 'block';
                    // Position relative to the main context menu
                    const menuRect = this.root.getBoundingClientRect();
                    
                    this.previewImage.style.left = `${menuRect.right + 5}px`;
                    this.previewImage.style.top = `${menuRect.top}px`;
                    
                    const previewRect = this.previewImage.getBoundingClientRect();
                    if (previewRect.right > window.innerWidth) {
                         this.previewImage.style.left = `${menuRect.left - previewRect.width - 5}px`;
                    }
                     if (previewRect.bottom > window.innerHeight) {
                        this.previewImage.style.top = `${window.innerHeight - previewRect.height - 6}px`;
                    }
                    if (previewRect.top < 0){
                        this.previewImage.style.top = `5px`;
                    }
                };

                this.previewImage.onerror = () => {
                    this.hidePreview();
                };
            })
            .catch(() => {
                // Silently handle the fetch error
            });
    }

    hidePreview() {
        if (this.previewImage) {
            this.previewImage.remove();
            this.previewImage = null;
        }
    }
}

// Helper class for textarea caret operations
class TextAreaCaretHelper {
    constructor(el) {
        this.el = el;
    }

    getCursorOffset() {
        const cursorPosition = this.#getCursorPosition(); // Now contains screen-relative y, x, bottom, height (as lineHeight)
        const clientTop = this.el.getBoundingClientRect().top;

        return {
            top: cursorPosition.bottom, // Screen Y for the bottom of the line where cursor is
            left: cursorPosition.left,  // Screen X for the start of the cursor
            lineHeight: cursorPosition.height, // This is the lineHeight from getElementOrCursorCoords
            clientTop: clientTop
        };
    }

    #calculateElementOffset() {
        const rect = this.el.getBoundingClientRect();
        const owner = this.el.ownerDocument;
        const { defaultView, documentElement } = owner;
        const offset = {
            top: rect.top + defaultView.pageYOffset,
            left: rect.left + defaultView.pageXOffset
        };
        if (documentElement) {
            offset.top -= documentElement.clientTop;
            offset.left -= documentElement.clientLeft;
        }
        return offset;
    }

    #getElScroll() {
        return { top: this.el.scrollTop, left: this.el.scrollLeft };
    }

    #getCursorPosition() {
        // Returns screen-relative coordinates and line height
        const coords = getElementOrCursorCoords(this.el, this.el.selectionEnd);
        return {
            top: coords.y,    // Screen Y of the top of the line
            left: coords.x,   // Screen X of the cursor
            height: coords.lineHeight, // Calculated line height
            bottom: coords.bottom // Screen Y of the bottom of the line
        };
    }

    getBeforeCursor() {
        return this.el.selectionStart !== this.el.selectionEnd ? null : this.el.value.substring(0, this.el.selectionEnd);
    }

    getAfterCursor() {
        return this.el.value.substring(this.el.selectionEnd);
    }

    insertAtCursor(value, offset, finalOffset) {
        if (this.el.selectionStart != null) {
            const startPos = this.el.selectionStart;
            this.el.selectionStart = this.el.selectionStart + offset;
            
            let pasted = true;
            try {
                if (!document.execCommand("insertText", false, value)) {
                    pasted = false;
                }
            } catch (e) {
                pasted = false;
            }

            if (!pasted) {
                this.el.setRangeText(value, this.el.selectionStart, this.el.selectionEnd, 'end');
            }

            this.el.selectionEnd = this.el.selectionStart = startPos + value.length + offset + (finalOffset ?? 0);
        } else {
            let pasted = true;
            try {
                if (!document.execCommand("insertText", false, value)) {
                    pasted = false;
                }
            } catch (e) {
                pasted = false;
            }

            if (!pasted) {
                this.el.value += value;
            }
        }
    }
}

// Global autocomplte helper to get typing cursor coordinates
function getElementOrCursorCoords(element, position) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
        return { x: 0, y: 0, right: 0, bottom: 0 };
    }

    const rect = element.getBoundingClientRect();

    if (element.tagName !== 'TEXTAREA') {
        return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom };
    }

    // Calculate the scale factor of the element.
    const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;

    const style = getComputedStyle(element);

    // Helper to get line-height in px, handling "normal" and unitless values.
    const getLineHeightPx = () => {
        const lineHeight = style.lineHeight;
        if (lineHeight === 'normal') {
            const temp = document.createElement('div');
            temp.innerHTML = '&nbsp;';
            Object.assign(temp.style, {
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                position: 'absolute',
                visibility: 'hidden'
            });
            document.body.appendChild(temp);
            const height = temp.offsetHeight;
            document.body.removeChild(temp);
            return height;
        }
        const numericLineHeight = parseFloat(lineHeight);
        // If the parsed number is the same as the string, it's unitless.
        if (String(numericLineHeight) === lineHeight) {
            return numericLineHeight * parseFloat(style.fontSize);
        }
        return numericLineHeight;
    };
    const finalLineHeight = getLineHeightPx();

    const text = element.value;
    const selectionEnd = position ?? element.selectionEnd;
    const before = text.substring(0, selectionEnd);

    // Create a hidden "mirror" div to calculate the cursor's position.
    const dummy = document.createElement("div");

    // Copy all relevant styles from the textarea to the mirror div.
    [
        'font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
        'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'boxSizing', 'whiteSpace', 'wordWrap', 'wordBreak'
    ].forEach(prop => dummy.style[prop] = style[prop]);

    // Position the mirror div off-screen.
    dummy.style.position = "absolute";
    dummy.style.visibility = "hidden";
    dummy.style.left = "-9999px";
    dummy.style.top = "-9999px";
    dummy.style.width = `${element.clientWidth}px`;
    dummy.style.height = 'auto';
    
    // Use a unique ID for the marker span to avoid conflicts.
    const markerId = `cursor-marker-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    dummy.innerHTML = before.replace(/\n/g, '<br />') + `<span id="${markerId}"></span>`;

    document.body.appendChild(dummy);

    const cursorMarker = dummy.querySelector(`#${markerId}`);
    
    // Get the cursor's un-scaled position inside the mirror div.
    const internalX = cursorMarker.offsetLeft;
    const internalY = cursorMarker.offsetTop;
    // The marker's offsetHeight is the most reliable measure of the line's rendered height inside the mirror.
    const internalLineHeight = cursorMarker.offsetHeight || finalLineHeight;

    document.body.removeChild(dummy);

    // Calculate the final, scaled position of the cursor on the screen.
    const cursorX = rect.left + (internalX * scaleX) - (element.scrollLeft * scaleX);
    const cursorY = rect.top + (internalY * scaleY) - (element.scrollTop * scaleY);
    const cursorBottom = cursorY + (internalLineHeight * scaleY);

    return {
        x: cursorX,
        y: cursorY,
        right: cursorX, 
        bottom: cursorBottom,
        lineHeight: internalLineHeight * scaleY
    };
}

class GlobalAutocomplete {
    constructor() {
        this.menu = null;
        this.attachedElement = null;
        this.helper = null;
        this.debounce = null;
        this.currentWord = "";
        this.currentWordStart = 0;
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onBlur = this.onBlur.bind(this);
        this.onClick = this.onClick.bind(this);
    }
    
    attach(inputElement) {
        if (this.attachedElement === inputElement) return;
        this.detach();
        this.attachedElement = inputElement;
        this.helper = new TextAreaCaretHelper(inputElement);
        this.attachedElement.addEventListener("keydown", this.onKeyDown, true);
        this.attachedElement.addEventListener("blur", this.onBlur);
        this.attachedElement.addEventListener("click", this.onClick);
    }

    detach() {
        if (this.attachedElement) {
            this.attachedElement.removeEventListener("keydown", this.onKeyDown, true);
            this.attachedElement.removeEventListener("blur", this.onBlur);
            this.attachedElement.removeEventListener("click", this.onClick);
            this.attachedElement = null;
            this.helper = null;
        }
        this.closeMenu();
    }

    closeMenu() {
        if (this.menu) {
            this.menu.close();
            this.menu = null;
        }
    }

    onKeyDown(e) {
        if (this.menu && this.menu.root && this.menu.root.parentElement) {
            // Let DynamicContextMenu handle navigation keys
            if (['ArrowUp', 'ArrowDown', 'Escape'].includes(e.key)) {
                this.menu.handleKeyboard(e);
                return;
            }
            
            // Handle selection keys
            if (this.menu.highlighted !== -1) {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    this.insertSelectedItem();
                    return;
                }
                
                if (e.key === 'Enter' && !e.ctrlKey) {
                    e.preventDefault();
                    this.insertSelectedItem();
                    return;
                }
            }
        }
        
        // Ignore key events with modifier keys (e.g., paste, select all)
        if (e.ctrlKey || e.metaKey || e.altKey) {
            return;
        }
        
        // If deleting a selection, close the menu and don't reopen it.
        if (this.attachedElement.selectionStart !== this.attachedElement.selectionEnd) {
            if (e.key === 'Backspace' || e.key === 'Delete') {
                this.closeMenu();
                setTimeout(() => this.closeMenu(), 1); // Ensure it's closed after the event
                return;
            }
        }

        // Handle single character backspace.
        if (e.key === 'Backspace') {
            const before = this.helper.getBeforeCursor();
            // If the character being deleted is a separator, just close the menu.
            if (before && /[,;"|}()\n]/.test(before.slice(-1))) {
                this.closeMenu();
                return; // Don't schedule an update.
            }
            this.scheduleUpdate();
            return;
        }

        // Handle single character delete.
        if (e.key === 'Delete') {
            const after = this.helper.getAfterCursor();
            // If the character being deleted is a separator, just close the menu.
            if (after && /[,;"|}()\n]/.test(after.slice(0, 1))) {
                this.closeMenu();
                return; // Don't schedule an update.
            }
            this.scheduleUpdate();
            return;
        }
        
        // Handle regular character input.
        if (e.key.length === 1) {
            // If a separator is typed, close the menu.
            if (/[,;"|}()\n]/.test(e.key)) {
                this.closeMenu();
            } else {
                // Otherwise, it's a word character, so show suggestions.
                this.scheduleUpdate();
            }
        }
    }

    onClick() {
        this.closeMenu();
    }

    onBlur() {
        // Use a small timeout to allow a click on the menu to register
        setTimeout(() => {
            if (this.menu && this.menu.root && !this.menu.root.matches(':hover')) {
                this.closeMenu();
            }
        }, 150);
    }

    scheduleUpdate() {
        if (this.debounce) {
            clearTimeout(this.debounce);
        }
        this.debounce = setTimeout(() => {
            this.updateSuggestions();
        }, 150);
    }

    insertSelectedItem() {
        if (!this.menu || this.menu.highlighted === -1) return;
        const selectedOption = this.menu.options[this.menu.highlighted];
        if (selectedOption && selectedOption.callback) {
            selectedOption.callback();
        }
    }

    getCurrentWord() {
        if (!this.attachedElement || !this.helper) return null;
        
        let before = this.helper.getBeforeCursor();
        if (!before?.length) return null;
        
        // Use the same regex pattern as the reference implementation
        const match = before.match(/([^,;"|}()\n]+)$/);
        if (match) {
            const word = match[0].replace(/^\s+/, "").replace(/\s/g, "_") || null;
            if (word && word.length >= 2) {
                this.currentWordStart = before.length - match[0].length;
                return word;
            }
        }
        return null;
    }

    async updateSuggestions() {
        if (!this.attachedElement || !this.helper) return;

        const currentWord = this.getCurrentWord();
        if (!currentWord) {
            this.closeMenu();
            return;
        }

        
        const getBaseTagName = (rawTag) => {
            let tag = rawTag.trim();
            // Ignore anything that looks like a LORA/embedding tag for this purpose
            if (tag.startsWith('<') && tag.endsWith('>')) {
                return null;
            }

            // Remove wrapping parens/brackets
            while ((tag.startsWith('(') && tag.endsWith(')')) || (tag.startsWith('[') && tag.endsWith(']'))) {
                tag = tag.substring(1, tag.length - 1).trim();
            }
            
            // Remove weight, e.g. "tag:1.2"
            const colonIndex = tag.lastIndexOf(':');
            if (colonIndex > 0) {
                const potentialWeight = tag.substring(colonIndex + 1).trim();
                // Basic check for a number. This won't catch [from:to:when] because "when" can be a word.
                if (/^[\d\.]+$/.test(potentialWeight) && !isNaN(parseFloat(potentialWeight))) {
                    return tag.substring(0, colonIndex).trim();
                }
            }
            return tag;
        };

        const allText = this.attachedElement.value;
        const existingTags = allText.split(',').map(t => getBaseTagName(t)).filter(Boolean);

        this.currentWord = currentWord;
        
        // Create the menu if it doesn't exist
        if (!this.menu) {
            const onSelect = (selectedValue) => {
                this.insertTag(selectedValue);
            };

            this.menu = new TagContextMenu(this.attachedElement, onSelect, existingTags);
            
            // Override the menu's positioning and event handling
            this.menu.setupEventListeners = () => {
                if (this.menu.abortController) {
                    this.menu.abortController.abort();
                }
                this.menu.abortController = new AbortController();
                const { signal } = this.menu.abortController;

                // Minimal event handling - let GlobalAutocomplete handle most events
                const keyboardHandler = (e) => {
                    if (this.menu && this.menu.root && this.menu.root.parentElement) {
                        // Only handle specific keys that the menu needs to process internally
                        if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
                            this.menu.handleKeyboard(e);
                        }
                    }
                };
                document.addEventListener("keydown", keyboardHandler, { signal, capture: true });

                // Close on outside click
                const pointerDownHandler = (e) => {
                    if (!this.menu.root || !this.menu.root.isConnected) {
                        this.closeMenu();
                        return;
                    }
                    if (!this.menu.root.contains(e.target)) {
                        this.closeMenu();
                    }
                };
                document.addEventListener("pointerdown", pointerDownHandler, { signal });
                this.menu.root.addEventListener("pointerdown", (e) => e.stopPropagation(), { signal });
            };

            this.menu.show();
        }
        
        // Position the menu correctly
        this.positionMenu();
        
        // Search for tags
        this.menu.searchTags(currentWord);
    }

    positionMenu() {
        if (!this.menu || !this.menu.root || !this.attachedElement) return;

        const startCoords = getElementOrCursorCoords(this.attachedElement, this.currentWordStart);
        const endCoords = getElementOrCursorCoords(this.attachedElement); // No position = use current cursor

        let finalCoords = startCoords;

        // Check for line wrap by comparing Y positions of word start and cursor end.
        if (Math.abs(endCoords.y - startCoords.y) > startCoords.lineHeight / 2) {
            // The word has wrapped. We need to anchor the menu to the start of the *current* visual line.
            // To do this, we can take the X coordinate from the start of the entire textarea,
            // and the Y coordinate from the current cursor position.
            const leftEdgeCoords = getElementOrCursorCoords(this.attachedElement, 0);
            finalCoords = {
                x: leftEdgeCoords.x,
                y: endCoords.y,
                bottom: endCoords.bottom,
                lineHeight: endCoords.lineHeight
            };
        }

        this.menu.root.style.left = `${finalCoords.x}px`;
        this.menu.root.style.top = `${finalCoords.bottom}px`;
        this.menu.root.style.maxHeight = (window.innerHeight - finalCoords.bottom) + "px";
    }

    insertTag(selectedValue) {
        if (!this.attachedElement || !this.helper) return;
        
        const tagName = typeof selectedValue === 'string' ? selectedValue : selectedValue.name;
        if (!tagName) return;

        // Ensure the element is focused and cursor position is stable
        this.attachedElement.focus();
        
        // Use the stored currentWord if available, otherwise recalculate
        let wordLengthToReplace = 0;
        if (this.currentWord && this.currentWord.length > 0) {
            wordLengthToReplace = this.currentWord.length;
        } else {
            // Fallback: try to recalculate
            const currentWordInfo = this.getCurrentWord();
            wordLengthToReplace = currentWordInfo ? currentWordInfo.length : 0;
        }

        // Escape parentheses in the tag
        const escapedTag = tagName.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        
        // Check if we need to add a separator after
        const afterCursor = this.helper.getAfterCursor();
        const trimmedAfter = afterCursor.trim();
        let shouldAddSeparator = !trimmedAfter.startsWith(',') && !trimmedAfter.startsWith(')') && !trimmedAfter.startsWith(':');

        // Don't add a separator if we're in a single-tag input field
        if (this.attachedElement.tagName === 'INPUT') {
            shouldAddSeparator = false;
        }

        const separator = shouldAddSeparator ? ', ' : '';
        
        // Insert the tag using the helper
        this.helper.insertAtCursor(
            escapedTag + separator,
            -wordLengthToReplace,
            0
        );

        // Clear debounce to prevent re-triggering
        if (this.debounce) {
            clearTimeout(this.debounce);
        }

        this.attachedElement.focus();
        this.closeMenu();
    }
}

// Initialize GlobalAutocomplete for general textareas
// This needs to be done after the class definition.
if (typeof app !== "undefined") {
    app.globalAutocompleteInstance = new GlobalAutocomplete(); // Store on app for access
    document.addEventListener("focusin", (e) => {
        if (!app.ui.settings.getSettingValue('EreNodes.Autocomplete.Global', true)) {
            return; // If the setting is disabled, do nothing.
        }

        if (e.target.tagName === "TEXTAREA") {
            const parentContextMenu = e.target.closest('.litecontextmenu');
            const isSearchBoxParent = parentContextMenu ? parentContextMenu.querySelector('.comfy-context-menu-filter') : false;

            if (
                (!parentContextMenu || !isSearchBoxParent) && // Allow if not in a context menu OR if in one that ISN'T the TagContextMenuInsert's
                !e.target.classList.contains('comfy-context-menu-filter') && // Explicitly don't attach to the searchbox itself via this listener
                (!app.globalAutocompleteInstance.textarea || app.globalAutocompleteInstance.textarea !== e.target) // Only attach if not already attached or attached to a different element
            ) {
                const triggerImmediately = !e.target.classList.contains("erenodes-quick-edit-input");
                // Attach with default behavior for global textareas
                app.globalAutocompleteInstance.attach(e.target, null, new Set(), e.target, "", triggerImmediately);
            }
        }
    });
}
