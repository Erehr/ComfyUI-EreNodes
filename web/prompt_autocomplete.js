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
            // Separator rendering is handled by the class assignment below if option.type === 'separator'

            const item = document.createElement("div");
            item.dataset.optionIndex = i;

            if (option.type === 'separator') {
                item.className = "litemenu-entry submenu separator";
                // No text or event listeners for separators
            } else {
                item.className = "litemenu-entry submenu";
                if (option.disabled) {
                    item.classList.add("disabled");
                }

                let icon = '';
                switch(option.type) {
                    case 'lora': icon = ''; break; // Or specific LORA icon if desired
                    case 'embedding': icon = ''; break; // Or specific Embedding icon
                    case 'folder': icon = '📁 '; break;
                    case 'lora_folder_up': icon = '⬅️ '; break;
                    case 'embedding_folder_up': icon = '⬅️ '; break;
                    case 'tag': icon = ''; break; // No icon for regular tags by default
                    case 'add_custom_tag': icon = '➕ '; break;
                    default: icon = ''; // Default no icon
                }

                if (option.name !== undefined) {
                    const displayHTML = this.highlight(option.name, query);
                    let countHTML = '';
                    if (option.count !== undefined && option.type === 'tag') {
                        countHTML = `<div style="font-size: 0.8em; opacity: 0.7; margin-left: 10px; white-space: nowrap;">(${option.count.toLocaleString('en-US')})</div>`;
                    }
                    let aliasesHTML = '';
                    if (option.aliases && option.aliases.length > 0 && option.type === 'tag') {
                        const highlightedAliases = option.aliases.map(alias => this.highlight(alias, query)).join(', ');
                        aliasesHTML = `<div style="font-size: 0.8em; opacity: 0.7; white-space: normal;">${highlightedAliases}</div>`;
                    }
                    item.innerHTML = `
                        <div style="display: flex; justify-content: space-between; align-items: center;">
                            <div>${icon}${displayHTML}</div>
                            ${countHTML}
                        </div>
                        ${aliasesHTML}
                    `;
                } else if (option.content) { // For "Add tag:" or other simple content
                     item.innerHTML = `${icon}${this.highlight(option.content, query)}`;
                } else {
                    item.innerHTML = "Error: Invalid option";
                }
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

        // Attach the globalAutocompleteInstance, passing currentLORApath and currentEMBEDDINGpath
        this.globalAutocompleteInstance.attach(this.searchBox, (selectedItem, _originalWord) => {
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
                 textToInsert = selectedItem.name || ""; // Best guess
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
    constructor(textarea, onSelectCallback, positioningElement = null, globalAutocompleteInstance) {
        super(null, onSelectCallback); 
        this.textarea = textarea; 
        this.positioningElement = positioningElement || textarea;
        this.globalAutocompleteInstance = globalAutocompleteInstance; // Store reference
        this.show();
    }

    update(suggestions, currentWord) { 
        if (!suggestions || suggestions.length === 0) {
            this.close();
            return;
        }

        this.currentWord = currentWord;
        this.options = suggestions.map(s => ({
            ...s, // s contains name, type, path
            callback: () => {
                // The onSelect callback is now more complex due to folder navigation
                // It's handled by the callback passed to TagContextMenuAutocomplete's constructor,
                // which is defined within GlobalAutocomplete.onInput
                this.onSelect(s); // Pass the full suggestion object
            }
        }));
        
        this.renderItems();
        if (this.options.length > 0) {
            // Prioritize highlighting non-'up_folder' items if 'up_folder' is first
            // and there are other items. Otherwise, highlight the first available.
            let highlightIdx = 0;
            if (this.options[0].type === 'up_folder' && this.options.length > 1) {
                highlightIdx = 1;
            }
            // If it's a search box and the first item is 'add_custom_tag', prefer the next one if it exists.
            if (this.textarea && this.textarea.classList.contains('comfy-context-menu-filter') && 
                this.options[highlightIdx]?.type === 'add_custom_tag' && this.options.length > highlightIdx + 1) {
                this.setHighlight(highlightIdx + 1); 
            } else {
                this.setHighlight(highlightIdx);
            }
        } else {
            this.setHighlight(-1);
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
        // Ensure these are initialized for every instance
        this.currentPath = "";
        this.isLoraSearch = false; 
        this.isEmbeddingSearch = false; 
        this.currentPrefix = ""; 
        this.lastQueryForFetch = ""; // Stores the actual query string used in the last fetch

        // Bind methods in constructor to ensure 'this' context is correct
        // This was the source of the error, methods were bound in attach(), 
        // but if attach was called on a new instance without these methods defined yet, it would fail.
        // It's better practice to bind in the constructor or use arrow functions for class methods.
        // However, the specific error was due to onKeyDown and onBlur not being defined as methods.
    }

    // Modified attach to be more flexible
    attach(inputElement, onSelectCallback, existingTags = new Set(), positioningElement = null, initialPath = "") {
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
        // Reset paths on detach
        this.currentPath = "";
        this.isLoraSearch = false;
        this.isEmbeddingSearch = false;
        this.currentPrefix = "";
    }

    onKeyDown(e) {
        if (this.menu) {
            const handled = this.menu.handleKeyboard(e);
            if (handled) {
                // If Escape was handled, the menu is now closed by TagContextMenu.close()
                // We need to ensure GlobalAutocomplete knows its menu is gone so it can create a new one.
                if (e.key === 'Escape') {
                    this.menu = null; // Allow new menu creation on next input
                }

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
            if (this.menu) this.menu.close();
            return;
        }

        const text = this.textarea.value;
        const cursorPos = this.textarea.selectionStart;
        let currentInputWord = ""; // The full word including prefix like "lora:cat"
        let queryForFetch = "";    // The part after the prefix, e.g., "cat"
        
        // Determine current word based on context (textarea vs. input)
        // Use regex pattern similar to reference implementation to extract only the word being typed
        if (this.textarea.tagName === 'TEXTAREA') {
            const textToCursor = text.substring(0, cursorPos);
            // Extract the word being typed, excluding delimiters like parentheses, commas, etc.
            const match = textToCursor.match(/([^,;"|}{}()\n]+)$/);
            if (match) {
                currentInputWord = match[0].replace(/^\s+/, "").replace(/\s/g, "_");
            } else {
                currentInputWord = "";
            }
        } else { // For comfy-context-menu-filter or other inputs
            currentInputWord = text.trimStart();
        }
        this.currentWord = currentInputWord; // Store for menu highlighting

        // Determine queryForFetch, and set isLoraSearch, isEmbeddingSearch, currentPrefix based on currentInputWord
        queryForFetch = ""; // Ensure queryForFetch is declared and reset
        this.isLoraSearch = false;    // Reset search type flags
        this.isEmbeddingSearch = false;
        this.currentPrefix = "";      // Reset prefix

        const lowerCurrentInputWord = currentInputWord.toLowerCase();

        if (lowerCurrentInputWord.startsWith("lora:") || lowerCurrentInputWord.startsWith("l:")) {
            this.isLoraSearch = true;
            this.currentPrefix = lowerCurrentInputWord.startsWith("lora:") ? "lora:" : "l:";
            queryForFetch = currentInputWord.substring(this.currentPrefix.length);
        } else if (lowerCurrentInputWord.startsWith("embedding:") || lowerCurrentInputWord.startsWith("e:")) {
            this.isEmbeddingSearch = true;
            this.currentPrefix = lowerCurrentInputWord.startsWith("embedding:") ? "embedding:" : "e:";
            queryForFetch = currentInputWord.substring(this.currentPrefix.length);
        } else if (currentInputWord.startsWith('(')) {
            const firstCloseParen = currentInputWord.indexOf(')');
            // Case 1: (weight)tag_or_lora - e.g. (text:1.2)tag or (text:1.2)lora:name
            // Ensure there's content after the parenthesis and it's not just "()"
            if (firstCloseParen > 0 && firstCloseParen < currentInputWord.length - 1) {
                let potentialTag = currentInputWord.substring(firstCloseParen + 1).trimStart();
                const lowerPotentialTag = potentialTag.toLowerCase();
                if (lowerPotentialTag.startsWith("lora:") || lowerPotentialTag.startsWith("l:")) {
                    this.isLoraSearch = true;
                    this.currentPrefix = lowerPotentialTag.startsWith("lora:") ? "lora:" : "l:";
                    queryForFetch = potentialTag.substring(this.currentPrefix.length);
                } else if (lowerPotentialTag.startsWith("embedding:") || lowerPotentialTag.startsWith("e:")) {
                    this.isEmbeddingSearch = true;
                    this.currentPrefix = lowerPotentialTag.startsWith("embedding:") ? "embedding:" : "e:";
                    queryForFetch = potentialTag.substring(this.currentPrefix.length);
                } else {
                    queryForFetch = potentialTag;
                }
            } else { // Case 2: (tag_being_typed or (tag1, tag2_being_typed - e.g. (1girl or (1girl, solo
                let contentInsideParens = currentInputWord.substring(1); // Remove leading '('
                // If firstCloseParen exists and is the last char of currentInputWord (e.g. "(1girl)"), remove it from content
                if (firstCloseParen === currentInputWord.length - 1) {
                    contentInsideParens = contentInsideParens.substring(0, contentInsideParens.length - 1);
                }
                
                const lastCommaInParens = contentInsideParens.lastIndexOf(',');
                let activeSegment = "";
                if (lastCommaInParens !== -1) {
                    activeSegment = contentInsideParens.substring(lastCommaInParens + 1).trimStart();
                } else {
                    activeSegment = contentInsideParens.trimStart();
                }

                const lowerActiveSegment = activeSegment.toLowerCase();
                if (lowerActiveSegment.startsWith("lora:") || lowerActiveSegment.startsWith("l:")) {
                    this.isLoraSearch = true;
                    this.currentPrefix = lowerActiveSegment.startsWith("lora:") ? "lora:" : "l:";
                    queryForFetch = activeSegment.substring(this.currentPrefix.length);
                } else if (lowerActiveSegment.startsWith("embedding:") || lowerActiveSegment.startsWith("e:")) {
                    this.isEmbeddingSearch = true;
                    this.currentPrefix = lowerActiveSegment.startsWith("embedding:") ? "embedding:" : "e:";
                    queryForFetch = activeSegment.substring(this.currentPrefix.length);
                } else {
                    queryForFetch = activeSegment;
                }
            }
        } else { // Standard tag, not starting with LORA/Embedding/(
            queryForFetch = currentInputWord;
        }

        // Preserve the original currentInputWord for display/highlighting if it started with '('
        // but use the potentially modified queryForFetch for actual searching.
        // this.currentWord is already set to the original currentInputWord.

        // Hide menu if query is too short (unless it's a prefix-only LORA/Embedding search to list all)
        // Or if we are in parenthesis mode but the active segment (queryForFetch) is empty, but the user is still typing inside overall (e.g. "(tag, )")
        const inParenModeNoQuery = currentInputWord.startsWith('(') && queryForFetch.length < 1 && !this.isLoraSearch && !this.isEmbeddingSearch;

        if ((queryForFetch.length < 1 && !this.isLoraSearch && !this.isEmbeddingSearch && currentInputWord.length < 1) || inParenModeNoQuery) {
            if (this.menu) {
                this.menu.close();
                this.menu = null; // Ensure menu can be recreated
            }
            // If inParenModeNoQuery is true, we might still want to keep lastQueryForFetch if currentInputWord is not empty
            // This allows replacing an empty segment like "(tag, |)" with a new tag if user selects one.
            // However, for now, if queryForFetch is empty, we don't fetch, so lastQueryForFetch won't be updated.
            // If currentInputWord is also empty, then definitely return.
            if (currentInputWord.length < 1) return;
            if (inParenModeNoQuery && !currentInputWord.endsWith(',')) { // if it's like `(tag ` don't return, allow typing
                 // but if it's `(tag, ` then we should not fetch, but also not return if user might type more.
                 // The existing logic for `queryForFetch.length < 1` will handle not fetching.
            } else if (inParenModeNoQuery) {
                return; // e.g. (tag, ) - stop here, don't fetch
            }
            if (queryForFetch.length < 1 && !this.isLoraSearch && !this.isEmbeddingSearch) return; // General case for empty query
        }

        // Allow empty queryForFetch if it's LORA/Embedding search (e.g. "lora:") to list root/current folder items
        // This was queryForFetch.length < 0, which is impossible. Should be queryForFetch.length === 0 for prefix only search.
        if (queryForFetch.length === 0 && (this.isLoraSearch || this.isEmbeddingSearch)) {
             // Proceed to fetch for LORA/Embedding root/current folder listing
        } else if (queryForFetch.length < 1 && !this.isLoraSearch && !this.isEmbeddingSearch) {
            // This case should ideally be caught by the more comprehensive block above.
            // If it reaches here, it means queryForFetch is empty for a tag search.
            if (this.menu) {
                this.menu.close();
                this.menu = null; // Ensure menu can be recreated
            }
            return;
        }

        let fetchedItems = [];
        try {
            const existingTags = this.existingTagsProvider ? this.existingTagsProvider() : new Set();
            let apiPath = "";
            let currentPathForAPI = "";

            if (this.isLoraSearch) {
                apiPath = "/erenodes/search_loras";
                currentPathForAPI = this.currentPath;
            } else if (this.isEmbeddingSearch) {
                apiPath = "/erenodes/search_embeddings";
                currentPathForAPI = this.currentPath;
            } else { // Tag search
                apiPath = "/erenodes/search_tags";
            }

            if (apiPath) {
                let url = `${apiPath}?query=${encodeURIComponent(queryForFetch)}&limit=50`;
                if (this.isLoraSearch || this.isEmbeddingSearch) {
                    url += `&path=${encodeURIComponent(currentPathForAPI)}`;
                }
                const response = await fetch(url);
                if (!response.ok) {
                    console.error(`Error fetching from ${apiPath}: ${response.status}`);
                    if (this.menu) {
                        this.menu.close();
                        this.menu = null; // Ensure menu can be recreated
                    }
                    return;
                }
                const resultData = await response.json();

                if (this.isLoraSearch || this.isEmbeddingSearch) {
                    let itemsToMap = resultData.items; // Expecting object with 'items' and optional 'parentPath'
                    const parentPath = resultData.parentPath;

                    if (!Array.isArray(itemsToMap)) { // Check if itemsToMap is an array
                        console.warn("[LORA/EMBEDDING] Autocomplete suggestions received 'items' that is not an array or missing in resultData object:", resultData);
                        itemsToMap = []; // Default to empty array to prevent further errors
                    }

                    let suggestions = [];
                    let hasFolders = false;
                    let hasFiles = false;

                    // Add 'Up' option if in a subfolder for LORA/Embedding search
                    if ((this.isLoraSearch || this.isEmbeddingSearch) && currentPathForAPI && parentPath !== undefined) {
                        suggestions.push({
                            name: `Up to ${parentPath || (this.isLoraSearch ? 'LORA root' : 'Embedding root')}`,
                            type: this.isLoraSearch ? 'lora_folder_up' : 'embedding_folder_up',
                            path: parentPath
                        });
                        // Add a separator after the 'Up' option if there are other items
                        if (itemsToMap.length > 0) {
                            suggestions.push({ type: 'separator' });
                        }
                    }

                    const mappedItems = itemsToMap.map(item => {
                        if (item.type === 'folder') hasFolders = true;
                        else if (item.type === 'lora' || item.type === 'embedding') hasFiles = true;
                        return {
                            name: item.name,
                            type: item.type,
                            path: item.path,
                            extension: item.extension
                        };
                    });

                    // Sort folders first, then files
                    mappedItems.sort((a, b) => {
                        if (a.type === 'folder' && b.type !== 'folder') return -1;
                        if (a.type !== 'folder' && b.type === 'folder') return 1;
                        return a.name.localeCompare(b.name);
                    });

                    let folderItems = mappedItems.filter(item => item.type === 'folder');
                    let fileItems = mappedItems.filter(item => item.type === 'lora' || item.type === 'embedding');

                    suggestions.push(...folderItems);

                    // Add a separator between folders and files if both exist
                    if (folderItems.length > 0 && fileItems.length > 0) {
                        suggestions.push({ type: 'separator' });
                    }

                    suggestions.push(...fileItems);
                    fetchedItems = suggestions;
                } else { // Tag search results
                    fetchedItems = resultData.filter(tag => !existingTags.has(tag.name.toLowerCase().replace(/_/g, ' ')))
                        .map(tag => ({
                            name: tag.name,
                            type: 'tag',
                            aliases: tag.aliases,
                            count: tag.count
                        }));
                }
            }
            
            // Add "Add tag: ..." option for tag searches in the + button's context menu filter
            if (!this.isLoraSearch && !this.isEmbeddingSearch && this.textarea.classList.contains('comfy-context-menu-filter') && queryForFetch.trim().length > 0) {
                const alreadyExistsAsTag = fetchedItems.some(item => item.type === 'tag' && item.name.toLowerCase() === queryForFetch.toLowerCase());
                if (!alreadyExistsAsTag) {
                    fetchedItems.unshift({
                        name: `Add tag: "${queryForFetch}"`,
                        type: 'add_custom_tag', 
                    });
                }
            }

            this.lastQueryForFetch = queryForFetch; // Store the query used for this fetch

            if (fetchedItems.length > 0) {
                if (!this.menu) {
                    this.menu = new TagContextMenuAutocomplete(this.textarea, (selectedItem) => {
                        // selectedItem is the full object {name, type, path, originalName}
                        if (selectedItem.type === 'folder') {
                            this.currentPath = selectedItem.path;
                            this.textarea.value = this.currentPrefix; 
                            this.textarea.focus();
                            this.textarea.setSelectionRange(this.currentPrefix.length, this.currentPrefix.length);
                            this.onInput(); 
                            return; 
                        }
                        if (selectedItem.type === 'lora_folder_up' || selectedItem.type === 'embedding_folder_up') {
                            this.currentPath = selectedItem.path;
                            if (!this.currentPath) {
                                if (this.isLoraSearch) this.isLoraSearch = false;
                                if (this.isEmbeddingSearch) this.isEmbeddingSearch = false;
                            }
                            this.textarea.value = this.currentPrefix;
                            this.textarea.focus();
                            this.textarea.setSelectionRange(this.currentPrefix.length, this.currentPrefix.length);
                            this.onInput();
                            return;
                        }

                        if (this.onSelectExternalCallback) {
                            const originalFullSegment = this.currentWord; // What was typed e.g. "(1g"
                            const queryUsedForSearch = this.lastQueryForFetch; // The part that matched e.g. "1g"

                            let finalReplacementText;

                            if (selectedItem.type === 'lora' || selectedItem.type === 'embedding') {
                                if (selectedItem.type === 'lora') {
                                    finalReplacementText = `<lora:${selectedItem.path}${selectedItem.extension}>`;
                                } else { // embedding
                                    finalReplacementText = `embedding:${selectedItem.path}${selectedItem.extension}`;
                                }
                            } else { // 'tag' or 'add_custom_tag'
                                const completedTagPart = (selectedItem.type === 'add_custom_tag') 
                                    ? queryUsedForSearch // For 'add_custom_tag', the 'name' is descriptive, use the query itself
                                    : selectedItem.name; // For 'tag', use the selected item's name

                                // originalFullSegment is what the user typed, e.g., "(1g" or "lora:mylo"
                                // queryUsedForSearch is the part used for searching, e.g., "1g" or "mylo"
                                // completedTagPart is the selected suggestion, e.g., "1girl"

                                if (originalFullSegment && queryUsedForSearch && queryUsedForSearch !== "") {
                                    // Find the last occurrence of queryUsedForSearch within originalFullSegment
                                    // This helps correctly identify the prefix if queryUsedForSearch appears multiple times
                                    const indexOfQuery = originalFullSegment.toLowerCase().lastIndexOf(queryUsedForSearch.toLowerCase());

                                    if (indexOfQuery !== -1) {
                                        // Extract the prefix before the part that was searched
                                        const prefix = originalFullSegment.substring(0, indexOfQuery);
                                        finalReplacementText = prefix + completedTagPart;
                                    } else {
                                        // Fallback: If queryUsedForSearch is not found (should be rare if logic is correct),
                                        // construct based on currentPrefix if it exists (e.g. for lora: or embedding:)
                                        // or just prepend the completedTagPart to what might be a prefix in originalFullSegment
                                        // This part might need refinement if issues persist with complex prefixes.
                                        if (this.currentPrefix && originalFullSegment.toLowerCase().startsWith(this.currentPrefix.toLowerCase())) {
                                            finalReplacementText = this.currentPrefix + completedTagPart;
                                        } else if (originalFullSegment.startsWith('(') && !queryUsedForSearch.startsWith('(')) {
                                            // If original starts with '(' but query didn't, assume '(' is the prefix.
                                            finalReplacementText = '(' + completedTagPart;
                                        } else {
                                            // Default fallback: replace the whole original segment or just use completed part.
                                            // This might lead to issues if originalFullSegment has a complex prefix not handled above.
                                            finalReplacementText = completedTagPart; 
                                            console.warn("[Autocomplete] Fallback in finalReplacementText construction for tags. Original: ", originalFullSegment, "Query: ", queryUsedForSearch);
                                        }
                                    }
                                } else if (originalFullSegment) { // queryUsedForSearch is empty, but original segment exists (e.g. user typed "(" and selected a tag)
                                    // If originalFullSegment is just '(', prepend it.
                                    if (originalFullSegment === '(') {
                                        finalReplacementText = originalFullSegment + completedTagPart;
                                    } else {
                                        // Otherwise, append. This case might need more thought if it causes issues.
                                        finalReplacementText = originalFullSegment + completedTagPart; 
                                    }
                                } else { // No original segment, just insert the completed tag part
                                    finalReplacementText = completedTagPart;
                                }
                            }
                            // Pass `originalFullSegment` as the part to replace. This ensures that prompt.js
                            // understands the full context of what's being replaced, including prefixes like '(',
                            // aligning with finalReplacementText which also contains the prefix.
                            this.onSelectExternalCallback(finalReplacementText, originalFullSegment, selectedItem.type);
                        } else {
                            // Default behavior for textareas if no external callback (legacy, might need adjustment)
                            let textToInsert = selectedItem.name;
                            if (selectedItem.type === 'lora') {
                                textToInsert = `<lora:${selectedItem.path}${selectedItem.extension}>`;
                            } else if (selectedItem.type === 'embedding') {
                                textToInsert = `embedding:${selectedItem.path}${selectedItem.extension}`;
                            }

                            // Use the same logic as the reference implementation
                            // Replace the currentWord (what was typed) with the selected item
                            const currentText = this.textarea.value;
                            const currentCursorPos = this.textarea.selectionStart;
                            const originalWord = this.currentWord || '';
                            
                            // Calculate the start position of the word to replace
                            const wordStartPos = currentCursorPos - originalWord.length;
                            
                            // Get text before and after the word being replaced
                            const before = currentText.substring(0, wordStartPos);
                            const after = currentText.substring(currentCursorPos);
                            
                            // Check if we need to add a separator after the inserted text
                            // Always add separator unless there's already a comma or semicolon at the start of remaining text
                            const needsSeparator = !after.trim().startsWith(',') && !after.trim().startsWith(';');
                            const separator = needsSeparator ? ', ' : '';
                            
                            // Replace the text
                            this.textarea.value = before + textToInsert + separator + after;
                            const newCursorPos = (before + textToInsert + separator).length;
                            this.textarea.setSelectionRange(newCursorPos, newCursorPos);
                            this.textarea.focus();
                            // Don't dispatch input event as it would retrigger autocomplete
                            // this.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                        }
                        // Close menu after selection of a non-folder item
                        if (this.menu) {
                            this.menu.close();
                            this.menu = null;
                        }
                    }, this.positioningElement, this); // Pass 'this' (GlobalAutocomplete instance)
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
