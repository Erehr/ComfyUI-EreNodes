import { app } from "../../../scripts/app.js";

// A custom context menu designed for dynamic, searchable content without flickering.
class TagContextMenu {
    constructor(event, onSelectCallback, existingTags = []) {
        this.event = event;
        this.onSelect = onSelectCallback;
        this.existingTags = new Set(existingTags.map(t => t.toLowerCase().replace(/_/g, ' ')));
        this.root = null;
        this.itemsContainer = null;
        this.options = [];
        this.highlighted = -1;
        this.currentWord = ""; 
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
            if (this.closeHandler) {
                document.removeEventListener("mousedown", this.closeHandler);
            }
        }
    }

    highlight(text, query) {
        // query is the full input, e.g., "lora:someLORA" or "someTag"
        // text is the suggestion item, e.g., "someLORA" or "someTag"
        let actualQuery = query;
        const loraPrefix = "lora:";
        const loraShortPrefix = "l:";
        const embeddingPrefix = "embedding:";
        const embeddingShortPrefix = "e:";

        if (query.toLowerCase().startsWith(loraPrefix)) {
            actualQuery = query.substring(loraPrefix.length);
        } else if (query.toLowerCase().startsWith(loraShortPrefix)) {
            actualQuery = query.substring(loraShortPrefix.length);
        } else if (query.toLowerCase().startsWith(embeddingPrefix)) {
            actualQuery = query.substring(embeddingPrefix.length);
        } else if (query.toLowerCase().startsWith(embeddingShortPrefix)) {
            actualQuery = query.substring(embeddingShortPrefix.length);
        }

        const index = text.toLowerCase().indexOf(actualQuery.toLowerCase());
        if (actualQuery && index !== -1) {
            const pre = text.substring(0, index);
            const match = text.substring(index, index + actualQuery.length);
            const post = text.substring(index + actualQuery.length);
            return `${pre}<strong style="background-color: #414650; color: white; font-weight: normal">${match}</strong>${post}`;
        }
        return text;
    }

    renderItems() {
        if (!this.itemsContainer) return;
        this.itemsContainer.innerHTML = '';
        this.highlighted = -1;
        const query = this.currentWord.toLowerCase().replace(/_/g, ' ');

        this.options.forEach((option, i) => {
            if (option.type === 'separator') {
                const separator = document.createElement("div");
                separator.className = "litemenu-separator";
                this.itemsContainer.appendChild(separator);
                return;
            }

            const item = document.createElement("div");
            item.className = "litemenu-entry submenu";
            item.dataset.optionIndex = i;

            if (option.disabled) {
                item.classList.add("disabled");
            }

            if (option.name !== undefined) { 
                // Unified highlighting for both tags and LORAs using option.name
                const displayHTML = this.highlight(option.name, query);
                
                let countHTML = '';
                if (option.count !== undefined && option.type === 'tag') { // Count only for tags
                    countHTML = `<div style="font-size: 0.8em; opacity: 0.7; margin-left: 10px; white-space: nowrap;">(${option.count.toLocaleString('en-US')})</div>`;
                }

                let aliasesHTML = '';
                if (option.aliases && option.aliases.length > 0 && option.type === 'tag') { // Aliases only for tags
                    const highlightedAliases = option.aliases.map(alias => this.highlight(alias, query)).join(', ');
                    aliasesHTML = `<div style="font-size: 0.8em; opacity: 0.7; white-space: normal;">${highlightedAliases}</div>`;
                }

                item.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>${displayHTML}</div>
                        ${countHTML}
                    </div>
                    ${aliasesHTML}
                `;
            } else if (option.content) { // For "Add tag:" or other simple content
                item.innerHTML = this.highlight(option.content, query);
            } else {
                item.innerHTML = "Error: Invalid option"; 
            }

            item.addEventListener("click", (e) => {
                e.stopPropagation();
                e.preventDefault();
                this.onItemSelected(option);
            });

            item.addEventListener("mouseenter", () => {
                if (!option.disabled) {
                    this.setHighlight(i);
                }
            });

            this.itemsContainer.appendChild(item);
        });
    }

    handleKeyboard(e) {
        const enabledOptions = this.options.map((o, i) => (!o.disabled && o.type !== 'separator') ? i : -1).filter(i => i !== -1);
        if (enabledOptions.length === 0 && e.key !== 'Escape') return false;

        let currentHighlightIndex = enabledOptions.indexOf(this.highlighted);
        let handled = false;

        switch (e.key) {
            case "ArrowUp":
                currentHighlightIndex = (currentHighlightIndex - 1 + enabledOptions.length) % enabledOptions.length;
                this.setHighlight(enabledOptions[currentHighlightIndex]);
                handled = true;
                break;
            case "ArrowDown":
                currentHighlightIndex = (currentHighlightIndex + 1) % enabledOptions.length;
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

    setHighlight(index) {
        if (!this.itemsContainer) return;

        if (this.highlighted > -1) {
            const oldItem = this.itemsContainer.querySelector(`[data-option-index="${this.highlighted}"]`);
            if (oldItem) {
                oldItem.style.backgroundColor = "";
                oldItem.style.color = "";
            }
        }

        this.highlighted = index;
        if (index === -1) return;

        const newItem = this.itemsContainer.querySelector(`[data-option-index="${index}"]`);
        if (newItem && this.options[index] && !this.options[index].disabled) {
            newItem.style.setProperty('background-color', 'rgb(204, 204, 204)', 'important');
            newItem.style.setProperty('color', 'rgb(0, 0, 0)', 'important');
            newItem.scrollIntoView({ block: 'nearest' });
        }
    }
}


// For the + button, self-contained with its own search input
export class TagContextMenuInsert extends TagContextMenu {
    constructor(event, onSelectCallback, existingTags = []) {
        super(event, onSelectCallback, existingTags);
        this.searchBox = null;
        // Use the global instance
        this.globalAutocompleteInstance = app.globalAutocompleteInstance; 

        this.show();
        this.setupEventListeners();
    }

    onItemSelected(option) {
        // The callback in the option itself handles the selection logic.
        // We just need to call it if it exists.
        if (option && option.callback) {
            option.callback(); // This will call the onSelect with the correct parameters.
        }
        // Clear search box and refocus after selection for quick multi-add
        if (this.searchBox) {
            this.searchBox.value = ""; 
            this.searchBox.focus();
        }
        // No need to call super.onItemSelected if it just calls option.callback
        // and we are already doing it here. If super has other logic, reconsider.
    }

    show() {
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        this.root.style.left = `${this.event.clientX}px`;
        this.root.style.top = `${this.event.clientY}px`;
        this.root.style.minWidth = "200px";

        this.searchBox = document.createElement("input");
        this.searchBox.className = "comfy-context-menu-filter";
        this.searchBox.placeholder = "Search (tags, lora:name, embedding:name)";
        
        this.itemsContainer = document.createElement("div"); 

        this.root.appendChild(this.searchBox);
        this.root.appendChild(this.itemsContainer); 
        document.body.appendChild(this.root);

        this.searchBox.focus();
        setTimeout(() => this.searchBox.focus(), 50);

        // Ensure GlobalAutocomplete is reset and ready for the new input context
        if (this.globalAutocompleteInstance) {
            this.globalAutocompleteInstance.detach(); // Detach from any previous element
        }

        // Attach the globalAutocompleteInstance
        this.globalAutocompleteInstance.attach(this.searchBox, (selectedItem, _originalWord) => { // existingTags will be passed here
            // selectedItem can be a string (for tags) or an object {name, type} for lora/embedding
            let textToInsert = selectedItem;
            if (typeof selectedItem === 'object' && selectedItem.name) {
                if (selectedItem.type === 'lora') {
                    textToInsert = `<lora:${selectedItem.name}>`;
                } else if (selectedItem.type === 'embedding') {
                    textToInsert = `embedding:${selectedItem.name}`;
                } else { // Should ideally be just name for tags or add_custom_tag
                    textToInsert = selectedItem.name;
                }
            } else if (typeof selectedItem !== 'string') {
                 // Fallback if selectedItem is an object but not structured as expected, or not a string
                 console.warn("Autocomplete: Unexpected selectedItem format", selectedItem);
                 textToInsert = selectedItem.originalName || selectedItem.name || ""; // Best guess
            }

            this.onSelect(textToInsert); // Pass the formatted string (or plain name) to the node's onSelect
            this.searchBox.value = "";
            // Update existingTags for the globalAutocompleteInstance
            if (typeof textToInsert === 'string') {
                const normalizedInserted = textToInsert.toLowerCase().replace(/_/g, ' ');
                if (this.globalAutocompleteInstance && this.globalAutocompleteInstance.existingTagsProvider) {
                    const currentTags = this.globalAutocompleteInstance.existingTagsProvider();
                    currentTags.add(normalizedInserted); // Add to the set
                    // No need to re-assign existingTagsProvider, modifying the set is enough if it's a reference
                }
                 // Also update the local existingTags for TagContextMenuInsert if it's used directly
                this.existingTags.add(normalizedInserted);
            }
            this.searchBox.focus();
            // Trigger re-evaluation of suggestions
            if (this.globalAutocompleteInstance) {
                this.globalAutocompleteInstance.onInput();
            }
            // GlobalAutocomplete's menu should close itself upon selection or be closed by detach
        }, this.existingTags, this.searchBox); 
    }
    
    setupEventListeners() {
        this.searchBox.addEventListener("keydown", (e) => {
            if (this.globalAutocompleteInstance && this.globalAutocompleteInstance.menu) {
                // Let GlobalAutocomplete handle Enter if its menu is open and an item is highlighted
                if (e.key === 'Enter' && this.globalAutocompleteInstance.menu.highlighted !== -1) {
                    const handledByGlobal = this.globalAutocompleteInstance.menu.handleKeyboard(e);
                    if (handledByGlobal) {
                        e.preventDefault();
                        e.stopPropagation();
                        return; 
                    }
                } else if (e.key === 'Enter') {
                    // If Enter is pressed and no item is highlighted in autocomplete menu, 
                    // or menu is not open, treat as adding custom tag from searchBox value.
                    const customTag = this.searchBox.value.trim();
                    if (customTag) {
                        this.onSelect(customTag); // Call the original onSelectCallback
                        this.searchBox.value = "";
                        // Autocomplete menu should have closed or will close on blur/detach
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                } else if (e.key === 'Escape') {
                    // If GlobalAutocomplete's menu is open, let it handle Escape first
                    const handledByGlobal = this.globalAutocompleteInstance.menu.handleKeyboard(e);
                    if (handledByGlobal) {
                        // GlobalAutocomplete's menu.handleKeyboard for Escape will call its own close()
                        // which in turn detaches the global instance from the searchBox if it was the active element.
                        // We might not need to explicitly call this.close() here if global's escape handling is sufficient.
                        // However, to ensure TagContextMenuInsert itself closes:
                        this.close(); 
                        e.preventDefault();
                        e.stopPropagation();
                        return;
                    }
                    // If GlobalAutocomplete's menu wasn't open or didn't handle Escape, close TagContextMenuInsert
                    this.close();
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                } else {
                    // For other keys (arrows, etc.), let GlobalAutocomplete handle them
                    const handledByGlobal = this.globalAutocompleteInstance.menu.handleKeyboard(e);
                    if (handledByGlobal) {
                        e.preventDefault();
                        e.stopPropagation();
                        return; 
                    }
                }
            } else if (e.key === 'Enter') {
                 // Case where global autocomplete might not have a menu (e.g. no results)
                 const customTag = this.searchBox.value.trim();
                 if (customTag) {
                     this.onSelect(customTag);
                     this.searchBox.value = "";
                 }
                 e.preventDefault();
                 e.stopPropagation();
            } else if (e.key === 'Escape') {
                this.close();
                e.preventDefault();
                e.stopPropagation();
            }
        });

        this.closeHandler = (e) => {
            if (this.root && !this.root.contains(e.target) && 
                (!this.globalAutocompleteInstance || !this.globalAutocompleteInstance.menu || !this.globalAutocompleteInstance.menu.root || !this.globalAutocompleteInstance.menu.root.contains(e.target))) {
                this.close();
            }
        };
        setTimeout(() => {
            document.addEventListener("mousedown", this.closeHandler);
        }, 100);
    }

    close() {
        if (this.globalAutocompleteInstance && this.globalAutocompleteInstance.textarea === this.searchBox) {
            // Detach the global instance ONLY if it's currently attached to our searchBox.
            // This prevents detaching it from a global textarea if TagContextMenuInsert closes while
            // a global textarea was the last one to have focus for the autocomplete.
            this.globalAutocompleteInstance.detach();
        }
        // Call TagContextMenu's close (which removes event listeners and root element)
        super.close();
    }
}


// A utility to get the pixel coordinates of the cursor in a textarea
// OR the bottom-left of an input element if it's not a textarea
function getElementOrCursorCoords(element) {
    if (element.tagName === 'TEXTAREA') {
        const div = document.createElement('div');
        const style = getComputedStyle(element);
        
        ['font', 'padding', 'border', 'width', 'height', 'lineHeight', 'whiteSpace', 'wordWrap', 'wordBreak'].forEach(prop => {
            div.style[prop] = style[prop];
        });
        
        div.style.position = 'absolute';
        div.style.visibility = 'hidden';
        div.style.overflow = 'auto';

        const text = element.value.substring(0, element.selectionStart);
        div.textContent = text;
        
        document.body.appendChild(div);

        const span = document.createElement('span');
        span.textContent = '.'; // A character to measure
        div.appendChild(span);

        const rect = element.getBoundingClientRect();
        const spanRect = span.getBoundingClientRect();

        document.body.removeChild(div);

        return {
            left: rect.left + spanRect.left - div.scrollLeft,
            top: rect.top + spanRect.top - div.scrollTop,
            height: spanRect.height
        };
    } else { // For input elements or others, position below the element
        const rect = element.getBoundingClientRect();
        return {
            left: rect.left,
            top: rect.bottom, // Position below the input element
            height: 0 // Height isn't as relevant for this positioning mode
        };
    }
}


// For global autocomplete, a passive renderer controlled by another class
export class TagContextMenuAutocomplete extends TagContextMenu {
    constructor(textarea, onSelectCallback, positioningElement = null) {
        super(null, onSelectCallback); 
        this.textarea = textarea; 
        this.positioningElement = positioningElement || textarea;
        this.show();
    }

    update(suggestions, currentWord) { 
        if (!suggestions || suggestions.length === 0) {
            this.close();
            return;
        }

        this.currentWord = currentWord; // currentWord is the text being typed, e.g. "lora:myL"
        this.options = suggestions.map(s => ({
            ...s, // s already contains name, type, and originalName if applicable
            callback: () => {
                // The onSelectExternalCallback (passed to GlobalAutocomplete.attach)
                // expects the selected item. It will then format it if necessary.
                // So, we pass the suggestion object 's' itself for lora/embedding,
                // or just its name/originalName for tags.
                if (s.type === 'lora' || s.type === 'embedding') {
                    this.onSelect(s); // Pass the object {name, type} for lora/embedding
                } else if (s.type === 'add_custom_tag') {
                    this.onSelect(s.originalName); // Pass the string for the new tag
                } else { // 'tag'
                    this.onSelect(s.name); // Pass the tag name string
                }
            }
        }));
        
        this.renderItems();
        // Highlight logic: if the input is a filter (like in TagContextMenuInsert)
        // and the first suggestion is to add a custom tag, highlight the next actual suggestion if available.
        if (this.textarea && this.textarea.classList.contains('comfy-context-menu-filter') && 
            this.options.length > 0 && this.options[0].type === 'add_custom_tag') {
            if (this.options.length > 1) {
                 this.setHighlight(1); 
            } else {
                 this.setHighlight(0); 
            }
        } else if (this.options.length > 0) {
            this.setHighlight(0); 
        }
    }

    show() {
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        
        const coords = getElementOrCursorCoords(this.positioningElement);
        this.root.style.left = `${coords.left}px`;
        this.root.style.top = `${coords.top + (this.positioningElement.tagName === 'TEXTAREA' ? coords.height : 5)}px`; // Add small offset for inputs
        this.root.style.minWidth = "150px";
        if (this.positioningElement && this.positioningElement.offsetWidth) {
            this.root.style.width = `${this.positioningElement.offsetWidth}px`; // Match width
        }

        this.itemsContainer = document.createElement("div");
        this.root.appendChild(this.itemsContainer);
        document.body.appendChild(this.root);
    }
}

class GlobalAutocomplete {
    constructor() {
        this.textarea = null; // This will be the input element (e.g., searchBox or a general textarea)
        this.menu = null;
        this.onSelectExternalCallback = null;
        this.existingTagsProvider = null; // Can be a Set or a function returning a Set
        this.positioningElement = null;

        // Bind methods in constructor to ensure 'this' context is correct
        // This was the source of the error, methods were bound in attach(), 
        // but if attach was called on a new instance without these methods defined yet, it would fail.
        // It's better practice to bind in the constructor or use arrow functions for class methods.
        // However, the specific error was due to onKeyDown and onBlur not being defined as methods.
    }

    // Modified attach to be more flexible
    attach(inputElement, onSelectCallback, existingTags = new Set(), positioningElement = null) {
        if (this.textarea === inputElement) return;
        this.detach();

        this.textarea = inputElement;
        this.onSelectExternalCallback = onSelectCallback;
        this.existingTagsProvider = typeof existingTags === 'function' ? existingTags : () => existingTags;
        this.positioningElement = positioningElement || inputElement;
        
        // Ensure methods are bound to the current instance
        // This was moved from constructor as per original structure, but the root cause was missing methods
        this.boundOnInput = this.onInput.bind(this);
        this.boundOnKeyDown = this.onKeyDown.bind(this);
        this.boundOnBlur = this.onBlur.bind(this);

        this.textarea.addEventListener("input", this.boundOnInput);
        this.textarea.addEventListener("keydown", this.boundOnKeyDown, true); 
        this.textarea.addEventListener("blur", this.boundOnBlur);

        // Trigger initial input processing in case there's already text (e.g. if re-attaching)
        this.boundOnInput(); 
    }

    detach() {
        if (this.textarea) {
            this.textarea.removeEventListener("input", this.boundOnInput);
            this.textarea.removeEventListener("keydown", this.boundOnKeyDown, true);
            this.textarea.removeEventListener("blur", this.boundOnBlur);
            this.textarea = null;
        }
        if (this.menu) {
            this.menu.close();
            this.menu = null;
        }
        this.onSelectExternalCallback = null;
        this.existingTagsProvider = null;
        this.positioningElement = null;
    }

    onKeyDown(e) {
        if (this.menu) {
            const handled = this.menu.handleKeyboard(e);
            if (handled) {
                e.preventDefault();
                e.stopPropagation();
            }
        }
    }

    onBlur() {
        // Delay detach to allow click on menu
        setTimeout(() => {
            // If the menu exists and the mouse is not over it, 
            // AND (the textarea is null OR the textarea does not have focus AND is not the active element)
            // then detach.
            // This ensures that if the focus shifts to an element outside the textarea and menu, the menu closes.
            if (this.menu && this.menu.root && !this.menu.root.matches(':hover')) {
                if (!this.textarea || (this.textarea !== document.activeElement && !this.textarea.contains(document.activeElement))) {
                    this.detach();
                }
            }
        }, 200); // Keep a slight delay to allow menu item clicks
    }

    async onInput() {
        const isAutocompleteEnabled = app.ui.settings.getSettingValue('erenodes.autocomplete', true);
        if (!isAutocompleteEnabled || !this.textarea) {
            if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
            return;
        }

        const text = this.textarea.value;
        const cursorPos = this.textarea.selectionStart;
        let currentWord = "";
        let queryForFetch = "";
        this.currentWord = ""; // Initialize currentWord

        if (this.textarea.tagName === 'TEXTAREA') {
            const textToCursor = text.substring(0, cursorPos);
            const lastComma = textToCursor.lastIndexOf(',');
            const lastNewline = textToCursor.lastIndexOf('\n');
            const wordStart = Math.max(lastComma, lastNewline) + 1;
            currentWord = textToCursor.substring(wordStart).trimStart();
            queryForFetch = currentWord;
        } else if (this.textarea.classList.contains('comfy-context-menu-filter')) {
            currentWord = text.trimStart();
            queryForFetch = currentWord;
        } else {
            currentWord = text.trimStart();
            queryForFetch = currentWord;
        }
        this.currentWord = currentWord; 

        const lowerQueryForFetch = queryForFetch.toLowerCase(); // Moved up for early check

        if (queryForFetch.length < 1 && !lowerQueryForFetch.startsWith("lora:") && !lowerQueryForFetch.startsWith("l:") && !lowerQueryForFetch.startsWith("embedding:") && !lowerQueryForFetch.startsWith("e:")) {
            if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
            return;
        }

        let fetchedItems = [];
        let isLoraSearch = false;
        let isEmbeddingSearch = false;
        let specificSearchQuery = ""; // Renamed from loraSearchQuery for generality

        if (lowerQueryForFetch.startsWith("lora:")) {
            isLoraSearch = true;
            specificSearchQuery = queryForFetch.substring(5);
        } else if (lowerQueryForFetch.startsWith("l:")) {
            isLoraSearch = true;
            specificSearchQuery = queryForFetch.substring(2);
        } else if (lowerQueryForFetch.startsWith("embedding:")) {
            isEmbeddingSearch = true;
            specificSearchQuery = queryForFetch.substring(10);
        } else if (lowerQueryForFetch.startsWith("e:")) { // Added e: for embeddings
            isEmbeddingSearch = true;
            specificSearchQuery = queryForFetch.substring(2);
        }

        const effectiveQuery = (isLoraSearch || isEmbeddingSearch) ? specificSearchQuery : queryForFetch;

        // If it's a tag search (neither Lora nor Embedding) and the query is empty, return.
        // For Lora/Embedding, an empty specificSearchQuery (e.g., "lora:") is allowed to proceed to fetch all.
        if (effectiveQuery.length < 1 && !isLoraSearch && !isEmbeddingSearch) {
             if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
            return;
        }

        try {
            const existingTags = this.existingTagsProvider ? this.existingTagsProvider() : new Set();
            if (isLoraSearch) {
                const response = await fetch(`/erenodes/search_loras?query=${encodeURIComponent(specificSearchQuery)}&limit=10`);
                if (!response.ok) {
                    if (this.menu) this.menu.close();
                    return;
                }
                const loraFiles = await response.json();
                fetchedItems = loraFiles
                    .filter(loraFile => !existingTags.has(`lora:${loraFile.toLowerCase()}`))
                    .map(loraFile => ({
                        name: loraFile,
                        type: 'lora'
                    }));
            } else if (isEmbeddingSearch) {
                const response = await fetch(`/erenodes/search_embeddings?query=${encodeURIComponent(specificSearchQuery)}&limit=10`);
                if (!response.ok) {
                    if (this.menu) this.menu.close();
                    return;
                }
                const embeddingFiles = await response.json();
                fetchedItems = embeddingFiles
                    .filter(embeddingFile => !existingTags.has(`embedding:${embeddingFile.toLowerCase()}`))
                    .map(embeddingFile => ({
                        name: embeddingFile,
                        type: 'embedding'
                    }));
            } else { // Tag search
                const response = await fetch(`/erenodes/search_tags?query=${encodeURIComponent(effectiveQuery)}&limit=10`);
                if (!response.ok) {
                    if (this.menu) this.menu.close();
                    return;
                }
                const tags = await response.json();
                fetchedItems = tags.filter(tag => !existingTags.has(tag.name)).map(tag => ({
                    name: tag.name,
                    type: 'tag',
                    aliases: tag.aliases,
                    count: tag.count,
                    originalName: tag.name
                }));

                // Add "Add tag: ..." option if in comfy-context-menu-filter and query is not empty
                if (this.textarea.classList.contains('comfy-context-menu-filter') && effectiveQuery.trim().length > 0) {
                    const alreadyExists = fetchedItems.some(item => item.name.toLowerCase() === effectiveQuery.toLowerCase());
                    if (!alreadyExists) {
                        fetchedItems.unshift({
                            name: `Add tag: "${effectiveQuery}"`,
                            type: 'add_custom_tag',
                            originalName: effectiveQuery
                        });
                    }
                }
            }

            if (fetchedItems.length > 0) {
                if (!this.menu) {
                    this.menu = new TagContextMenuAutocomplete(this.textarea, (selectedName, originalWord) => {
                        if (this.onSelectExternalCallback) {
                            this.onSelectExternalCallback(selectedName, originalWord || this.currentWord);
                        } else {
                            // Default behavior for textareas if no external callback
                            let textToInsert;
                            if (typeof selectedName === 'object' && selectedName.name) {
                                if (selectedName.type === 'lora') {
                                    textToInsert = `lora:${selectedName.name}`;
                                } else if (selectedName.type === 'embedding') {
                                    textToInsert = `embedding:${selectedName.name}`;
                                } else {
                                    textToInsert = selectedName.name;
                                }
                            } else {
                                textToInsert = selectedName;
                            }

                            const text = this.textarea.value;
                            const cursorPos = this.textarea.selectionStart;
                            const textToCursor = text.substring(0, cursorPos);
                            
                            let wordStart = 0;
                            const lastComma = textToCursor.lastIndexOf(',');
                            const lastNewline = textToCursor.lastIndexOf('\n');
                            wordStart = Math.max(lastComma, lastNewline) + 1;

                            // Adjust wordStart to preserve space after comma if present
                            if (lastComma !== -1 && textToCursor.substring(lastComma + 1, wordStart).trim() === '') {
                                // If the character after the last comma is a space (and then the cursor),
                                // ensure wordStart includes that space for the 'before' string.
                                if (text[lastComma + 1] === ' ') {
                                    // wordStart is already correct in this case if currentWord was empty or just spaces
                                } 
                                // If currentWord was being typed right after comma (no space), wordStart is also fine.
                            }
                            
                            let before = text.substring(0, wordStart);
                            const after = text.substring(cursorPos);

                            // Ensure 'before' ends with a comma and a space if it's not the start of the text
                            // and the previous character was a comma without a space.
                            if (wordStart > 0 && before.endsWith(',') && !before.endsWith(', ')) {
                                before += ' ';
                            } else if (wordStart > 0 && !before.endsWith(', ') && !before.endsWith('\n') && before.trim() !== '') {
                                // If 'before' is not empty, not ending with newline, and not ending with ", ", add it.
                                // This handles cases where the previous content didn't end with a comma.
                                if (!before.endsWith(',')) before += ',';
                                if (!before.endsWith(' ')) before += ' ';
                            } else if (before.trim() === '') {
                                // If 'before' is empty or just whitespace, don't add a leading comma.
                                before = ''; 
                            }

                            this.textarea.value = before + textToInsert + ", " + after;
                            
                            const newTextValue = before + textToInsert + ", " + after;
                            this.textarea.value = newTextValue;
                            
                            const newCursorPos = (before + textToInsert + ", ").length;
                            this.textarea.setSelectionRange(newCursorPos, newCursorPos);
                            this.textarea.focus();
                            this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        if (this.menu) {
                            this.menu.close();
                            this.menu = null;
                        }
                    }, this.positioningElement);
                }
                this.menu.update(fetchedItems, this.currentWord);
            } else {
                if (this.menu) {
                    this.menu.close();
                    this.menu = null;
                }
            }
        } catch (error) {
            console.error("Error fetching autocomplete suggestions:", error);
            if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
        }
    }
}

// Initialize GlobalAutocomplete for general textareas
// This needs to be done after the class definition.
if (typeof app !== "undefined") {
    app.globalAutocompleteInstance = new GlobalAutocomplete(); // Store on app for access
    document.addEventListener("focusin", (e) => {
        if (e.target.tagName === "TEXTAREA") {
            const parentContextMenu = e.target.closest('.litecontextmenu');
            const isSearchBoxParent = parentContextMenu ? parentContextMenu.querySelector('.comfy-context-menu-filter') : false;

            if (
                (!parentContextMenu || !isSearchBoxParent) && // Allow if not in a context menu OR if in one that ISN'T the TagContextMenuInsert's
                !e.target.classList.contains('comfy-context-menu-filter') && // Explicitly don't attach to the searchbox itself via this listener
                (!app.globalAutocompleteInstance.textarea || app.globalAutocompleteInstance.textarea !== e.target) // Only attach if not already attached or attached to a different element
            ) {
                // Attach with default behavior for global textareas (including onTagQuickEdit's textarea)
                app.globalAutocompleteInstance.attach(e.target, null, new Set(), e.target);
            }
        }
    });
}

app.registerExtension({
    name: "EreNodes.Autocomplete",
    async setup() {
        // const globalInstance = new GlobalAutocomplete(); // Instance is now created and managed by the focusin listener above

        // Fetch CSV files for settings
        const response = await fetch("/erenodes/list_csv_files");
        const csvFiles = await response.json();
        const csvOptions = csvFiles.map(file => ({ text: file, value: file }));

        // Register settings
        app.ui.settings.addSetting({
            id: "erenodes.autocomplete",
            name: "EreNodes Autocomplete",
            type: "boolean",
            defaultValue: true,
        });

        app.ui.settings.addSetting({
            id: "erenodes.csv",
            name: "EreNodes Autocomplete CSV",
            type: "combo",
            defaultValue: csvOptions.length > 0 ? csvOptions[0].value : "",
            options: csvOptions,
            onChange: (newVal, oldVal) => {
                fetch("/erenodes/set_active_csv", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({ csv_file: newVal }),
                });
            },
        });
    },
});
