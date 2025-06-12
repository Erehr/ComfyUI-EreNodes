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
        const index = text.toLowerCase().indexOf(query);
        if (query && index !== -1) {
            const pre = text.substring(0, index);
            const match = text.substring(index, index + query.length);
            const post = text.substring(index + query.length);
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

            if (option.tag && option.tag.count !== undefined) {
                const tag = option.tag;
                const highlightHTML = this.highlight(tag.name, query);
                const countFormatted = `(${tag.count.toLocaleString('en-US')})`;

                let aliasesHTML = '';
                if (tag.aliases && tag.aliases.length > 0) {
                    const highlightedAliases = tag.aliases.map(alias => this.highlight(alias, query)).join(', ');
                    aliasesHTML = `<div style="font-size: 0.8em; opacity: 0.7; white-space: normal;">${highlightedAliases}</div>`;
                }

                item.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div>${highlightHTML}</div>
                        <div style="font-size: 0.8em; opacity: 0.7; margin-left: 10px; white-space: nowrap;">${countFormatted}</div>
                    </div>
                    ${aliasesHTML}
                `;
            } else {
                item.innerHTML = this.highlight(option.content, query);
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

        this.show();
        this.setupEventListeners();
        this.updateSuggestions(""); 
    }

    onItemSelected(option) {
        super.onItemSelected(option);
        if (this.searchBox) {
            this.searchBox.value = "";
            this.updateSuggestions("").then(() => {
                this.searchBox.focus();
            });
        }
    }

    show() {
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        this.root.style.left = `${this.event.clientX}px`;
        this.root.style.top = `${this.event.clientY}px`;
        this.root.style.minWidth = "200px";

        this.searchBox = document.createElement("input");
        this.searchBox.className = "comfy-context-menu-filter";
        this.searchBox.placeholder = "Search tags...";
        
        this.itemsContainer = document.createElement("div");

        this.root.appendChild(this.searchBox);
        this.root.appendChild(this.itemsContainer);
        document.body.appendChild(this.root);

        this.searchBox.focus();
        setTimeout(() => this.searchBox.focus(), 50);
    }
    
    setupEventListeners() {
        this.searchBox.addEventListener("input", (e) => {
            this.updateSuggestions(e.target.value);
        });
        
        this.searchBox.addEventListener("keydown", (e) => {
            this.handleKeyboard(e);
        });

        this.closeHandler = (e) => {
            if (this.root && !this.root.contains(e.target)) {
                this.close();
            }
        };
        setTimeout(() => {
            document.addEventListener("mousedown", this.closeHandler);
        }, 100);
    }
    
    async updateSuggestions(raw_query) {
        this.currentWord = raw_query.trim();
        const query = this.currentWord.replace(/_/g, ' ');
        const isAutocompleteEnabled = app.ui.settings.getSettingValue('erenodes.autocomplete', false);
        
        let suggestions = [];
        if (query.length > 0 && isAutocompleteEnabled) {
            try {
                const response = await fetch(`/erenodes/search_tags?query=${encodeURIComponent(query)}&limit=10`);
                if (response.ok) {
                    let fetchedSuggestions = await response.json(); // Changed const to let
                    const currentQueryNormalized = query.toLowerCase(); // 'query' is this.currentWord.replace(/_/g, ' ')

                    let exactMatchSuggestion = null;
                    let exactMatchIndex = -1;
                    for (let i = 0; i < fetchedSuggestions.length; i++) {
                        if (fetchedSuggestions[i].name.toLowerCase() === currentQueryNormalized) {
                            exactMatchSuggestion = fetchedSuggestions[i];
                            exactMatchIndex = i;
                            break;
                        }
                    }

                    if (exactMatchSuggestion) {
                        fetchedSuggestions.splice(exactMatchIndex, 1);
                        fetchedSuggestions.unshift(exactMatchSuggestion);
                    }
                    
                    suggestions = fetchedSuggestions.filter(s => !this.existingTags.has(s.name.toLowerCase()));
                }
            } catch (error) { /* Ignore fetch errors */ }
        }
        
        this.options = [];
        const lowerQuery = query.toLowerCase();
        const exactMatch = suggestions.some(s => s.name.toLowerCase() === lowerQuery);

        if (query && !exactMatch) {
            this.options.push({
                content: `Add tag: "${query}"`,
                callback: () => this.onSelect(query),
            });
        }
        
        if (suggestions.length > 0) {
            if (this.options.length > 0) {
                this.options.push({ type: 'separator' });
            }
            suggestions.forEach(s => {
                this.options.push({
                    content: s.name,
                    tag: s,
                    callback: () => this.onSelect(s.name)
                });
            });
        }
        
        this.renderItems();
        if (this.options.length > 0) {
            let highlightIndex = 0;
            if (isAutocompleteEnabled) {
                const firstSuggestionIndex = this.options.findIndex(o => o.tag !== undefined);
                if (firstSuggestionIndex !== -1) {
                    highlightIndex = firstSuggestionIndex;
                }
            }
            this.setHighlight(highlightIndex);
        }
    }
}


// A utility to get the pixel coordinates of the cursor in a textarea
function getCursorCoords(textarea) {
    const div = document.createElement('div');
    const style = getComputedStyle(textarea);
    
    ['font', 'padding', 'border', 'width', 'height', 'lineHeight', 'whiteSpace', 'wordWrap', 'wordBreak'].forEach(prop => {
        div.style[prop] = style[prop];
    });
    
    div.style.position = 'absolute';
    div.style.visibility = 'hidden';
    div.style.overflow = 'auto';

    const text = textarea.value.substring(0, textarea.selectionStart);
    div.textContent = text;
    
    document.body.appendChild(div);

    const span = document.createElement('span');
    span.textContent = '.'; // A character to measure
    div.appendChild(span);

    const rect = textarea.getBoundingClientRect();
    const spanRect = span.getBoundingClientRect();

    document.body.removeChild(div);

    return {
        left: rect.left + spanRect.left - div.scrollLeft,
        top: rect.top + spanRect.top - div.scrollTop,
        height: spanRect.height
    };
}


// For global autocomplete, a passive renderer controlled by another class
export class TagContextMenuAutocomplete extends TagContextMenu {
    constructor(textarea, onSelectCallback) {
        super(null, onSelectCallback); 
        this.textarea = textarea;
        this.show();
    }

    update(suggestions, currentWord) {
        if (suggestions.length === 0) {
            this.close();
            return;
        }

        this.currentWord = currentWord;
        this.options = suggestions.map(s => ({
            tag: s,
            content: s.name,
            callback: () => this.onSelect(s.name, currentWord)
        }));
        
        this.renderItems();
        this.setHighlight(0);
    }

    show() {
        this.root = document.createElement("div");
        this.root.className = "litegraph litecontextmenu litemenubar-panel dark";
        
        const coords = getCursorCoords(this.textarea);
        this.root.style.left = `${coords.left}px`;
        this.root.style.top = `${coords.top + coords.height}px`;
        this.root.style.minWidth = "150px";

        this.itemsContainer = document.createElement("div");
        this.root.appendChild(this.itemsContainer);
        document.body.appendChild(this.root);
    }
}

class GlobalAutocomplete {
    constructor() {
        this.textarea = null;
        this.menu = null;

        document.addEventListener("focusin", (e) => {
            if (e.target.tagName === "TEXTAREA" && !e.target.closest('.litemenu-entry')) {
                this.attach(e.target);
            }
        });
    }

    attach(textarea) {
        if (this.textarea === textarea) return;
        this.detach();

        this.textarea = textarea;
        
        this.onInput = this.onInput.bind(this);
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onBlur = this.onBlur.bind(this);

        this.textarea.addEventListener("input", this.onInput);
        this.textarea.addEventListener("keydown", this.onKeyDown, true); // Use capture phase
        this.textarea.addEventListener("blur", this.onBlur);
    }

    detach() {
        if (this.textarea) {
            this.textarea.removeEventListener("input", this.onInput);
            this.textarea.removeEventListener("keydown", this.onKeyDown, true);
            this.textarea.removeEventListener("blur", this.onBlur);
            this.textarea = null;
        }
        if (this.menu) {
            this.menu.close();
            this.menu = null;
        }
    }

    onBlur() {
        // Delay detach to allow click on menu
        setTimeout(() => {
            if (!this.menu || !this.menu.root || !this.menu.root.matches(':hover')) {
                this.detach();
            }
        }, 200);
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
    
    async onInput() {
        const isAutocompleteEnabled = app.ui.settings.getSettingValue('erenodes.autocomplete', true);
        if (!isAutocompleteEnabled) {
            if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
            return;
        }

        const text = this.textarea.value;
        const cursorPos = this.textarea.selectionStart;

        const allTagsInText = new Set(text.split(/[,\n]/).map(tag => tag.trim().toLowerCase()).filter(Boolean));

        const textToCursor = text.substring(0, cursorPos);
        const lastComma = textToCursor.lastIndexOf(',');
        const lastNewline = textToCursor.lastIndexOf('\n');
        const wordStart = Math.max(lastComma, lastNewline) + 1;
        const currentWord = textToCursor.substring(wordStart).trim();

        if (currentWord.length < 1) {
            if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
            return;
        }

        try {
            const response = await fetch(`/erenodes/search_tags?query=${encodeURIComponent(currentWord)}&limit=10`);
            if (!response.ok) return;
            let suggestions = await response.json();

            // Prioritize exact match
            const lowerCurrentWord = currentWord.toLowerCase();
            let exactMatchSuggestion = null;
            let exactMatchIndex = -1;

            for (let i = 0; i < suggestions.length; i++) {
                if (suggestions[i].name.toLowerCase() === lowerCurrentWord) {
                    exactMatchSuggestion = suggestions[i];
                    exactMatchIndex = i;
                    break;
                }
            }

            if (exactMatchSuggestion) {
                suggestions.splice(exactMatchIndex, 1); // Remove from original position
                suggestions.unshift(exactMatchSuggestion); // Add to the beginning
            }

            // Existing filter
            suggestions = suggestions.filter(s => s.name.toLowerCase() === lowerCurrentWord || !allTagsInText.has(s.name.toLowerCase()));
            
            if (suggestions.length === 0) {
                if (this.menu) {
                    this.menu.close();
                    this.menu = null;
                }
                return;
            }

            if (!this.menu) {
                this.menu = new TagContextMenuAutocomplete(this.textarea, this.onSuggestionSelected.bind(this));
            }
            this.menu.update(suggestions, currentWord);

        } catch (error) {
            if (this.menu) {
                this.menu.close();
                this.menu = null;
            }
        }
    }

    onSuggestionSelected(suggestion, partialWord) {
        const text = this.textarea.value;
        const cursorPos = this.textarea.selectionStart;

        const textBefore = text.substring(0, cursorPos - partialWord.length);
        const textAfter = text.substring(cursorPos);

        const newText = textBefore + suggestion + ", " + textAfter;
        this.textarea.value = newText;

        const newCursorPos = (textBefore + suggestion + ", ").length;
        this.textarea.selectionStart = this.textarea.selectionEnd = newCursorPos;

        this.textarea.focus();
        if (this.menu) {
            this.menu.close();
            this.menu = null;
        }
    }
}

app.registerExtension({
    name: "EreNodes.Autocomplete",
    async setup() {
        new GlobalAutocomplete();

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
