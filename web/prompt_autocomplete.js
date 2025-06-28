import { app } from "../../../scripts/app.js";
import { TagContextMenu } from "./js/contextmenu.js";

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

        // Don't add a separator if we're in a single-tag input field / filters with autocomplete
        if (this.attachedElement.classList.contains('comfy-context-menu-filter')) {
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
