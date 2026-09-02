import { app } from "../../scripts/app.js";
import { TagContextMenu } from "./js/contextmenu.js";
import { getElementOrCursorCoords } from "./js/util.js";

// Helper class for textarea caret operations
class TextAreaCaretHelper {
    constructor(el) {
        this.el = el;
    }

    getCursorOffset() {
        const cursorPosition = this.#getCursorPosition();
        const clientTop = this.el.getBoundingClientRect().top;

        return {
            top: cursorPosition.bottom,
            left: cursorPosition.left,
            lineHeight: cursorPosition.height,
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
        const coords = getElementOrCursorCoords(this.el, this.el.selectionEnd);
        return {
            top: coords.y,
            left: coords.x,
            height: coords.lineHeight,
            bottom: coords.bottom
        };
    }

    getBeforeCursor() {
        return this.el.selectionStart !== this.el.selectionEnd ? null : this.el.value.substring(0, this.el.selectionEnd);
    }

    getAfterCursor() {
        return this.el.value.substring(this.el.selectionEnd);
    }

    insertAtCursor(value, offset, finalOffset) {
        /** document.execCommand is deprecated; use setRangeText and dispatch an 'input' event so widget change callbacks still fire. */
        if (this.el.selectionStart != null) {
            const startPos = this.el.selectionStart;
            this.el.setRangeText(value, startPos + offset, this.el.selectionEnd, 'end');
            this.el.selectionEnd = this.el.selectionStart = startPos + value.length + offset + (finalOffset ?? 0);
        } else {
            this.el.value += value;
        }
        this.el.dispatchEvent(new Event('input', { bubbles: true }));
    }
}

/** Autocomplete over a textarea or a single-line input. `attach` takes the menu *class* rather than the suggestions, so a caller (the sidebar's tag search) can supply a different source while this class keeps owning the typing. */
export class GlobalAutocomplete {
    constructor() {
        this.menu = null;
        this.attachedElement = null;
        this.helper = null;
        this.debounce = null;
        this.currentWord = "";
        this.currentWordStart = 0;
        this.onKeyDown = this.onKeyDown.bind(this);
        this.onInput = this.onInput.bind(this);
        this.onBlur = this.onBlur.bind(this);
        this.onClick = this.onClick.bind(this);
    }
    
    /**
     * @param {HTMLElement} inputElement       textarea or input to drive
     * @param {object}      [options]
     * @param {Function}    [options.menuClass]     TagContextMenu subclass; decides where suggestions come from
     * @param {boolean}     [options.escapeParens]  false in a search field, where `\(` would be matched literally
     */
    attach(inputElement, options = {}) {
        if (this.attachedElement === inputElement) {
            // Same field, possibly different terms — a re-attach must not silently keep the old ones.
            this.attachOptions = options;
            return;
        }
        this.detach();
        this.attachOptions = options;
        this.attachedElement = inputElement;
        this.helper = new TextAreaCaretHelper(inputElement);
        this.attachedElement.addEventListener("keydown", this.onKeyDown, true);
        // Composed text (IME) never reaches onKeyDown as a character — see onInput.
        this.attachedElement.addEventListener("input", this.onInput);
        this.attachedElement.addEventListener("blur", this.onBlur);
        this.attachedElement.addEventListener("click", this.onClick);
    }

    detach() {
        if (this.attachedElement) {
            this.attachedElement.removeEventListener("keydown", this.onKeyDown, true);
            this.attachedElement.removeEventListener("input", this.onInput);
            this.attachedElement.removeEventListener("blur", this.onBlur);
            this.attachedElement.removeEventListener("click", this.onClick);
            this.attachedElement = null;
            this.helper = null;
            this.attachOptions = null;
        }
        // A pending update would fire against the element we just let go of.
        if (this.debounce) {
            clearTimeout(this.debounce);
            this.debounce = null;
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
                setTimeout(() => this.closeMenu(), 1);
                return;
            }
        }

        if (e.key === 'Backspace') {
            const before = this.helper.getBeforeCursor();
            if (before && /[,;"|}()\n]/.test(before.slice(-1))) {
                this.closeMenu();
                return;
            }
            this.scheduleUpdate();
            return;
        }

        if (e.key === 'Delete') {
            const after = this.helper.getAfterCursor();
            if (after && /[,;"|}()\n]/.test(after.slice(0, 1))) {
                this.closeMenu();
                return;
            }
            this.scheduleUpdate();
            return;
        }
        
        if (e.key.length === 1) {
            // Mid-composition `e.key` is the key struck, not the character being formed (a jamo, for Hangul). onInput picks it up once the composition settles.
            if (e.isComposing) return;

            if (/[,;"|}()\n]/.test(e.key)) {
                this.closeMenu();
            } else {
                this.scheduleUpdate();
            }
        }
    }

    /**
     * Composed input (any IME): keydown reports the keystroke, not the character it produces.
     * Also fires for plain typing, where scheduleUpdate's debounce absorbs it.
     */
    onInput(e) {
        if (!e.data) return;   // deletions and composition starts carry no data

        const lastChar = e.data.slice(-1);
        if (/[,;"|}()\n]/.test(lastChar)) {
            this.closeMenu();
        } else {
            this.scheduleUpdate();
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
        
        const match = before.match(/([^,;"|}()\n]+)$/);
        if (match) {
            const word = match[0].replace(/^\s+/, "").replace(/\s/g, "_") || null;
            // Two characters before suggesting keeps English from firing on every stray letter.
            const minLength = word && /[^\x00-\x7F]/.test(word) ? 1 : 2;
            if (word && word.length >= minLength) {
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
            
            // Remove a trailing weight, e.g. "tag:1.2".
            const colonIndex = tag.lastIndexOf(':');
            if (colonIndex > 0) {
                const potentialWeight = tag.substring(colonIndex + 1).trim();
                // This won't catch [from:to:when] because "when" can be a word.
                if (/^[\d\.]+$/.test(potentialWeight) && !isNaN(parseFloat(potentialWeight))) {
                    return tag.substring(0, colonIndex).trim();
                }
            }
            return tag;
        };

        const allText = this.attachedElement.value;
        const existingTags = allText.split(',').map(t => getBaseTagName(t)).filter(Boolean);

        this.currentWord = currentWord;

        // Terms committed before the word being typed: the index menu narrows to what they still reach, the CSV menu ignores them. Per search, since the menu outlives inserts.
        const before = this.helper.getBeforeCursor() ?? "";
        const committed = before.split(",").slice(0, -1).map(t => t.trim()).filter(Boolean);

        if (!this.menu) {
            const MenuClass = this.attachOptions?.menuClass ?? TagContextMenu;
            const onSelect = (selectedValue) => {
                this.insertTag(selectedValue);
            };

            this.menu = new MenuClass(this.attachedElement, onSelect, existingTags);
            
            // Override the menu's positioning and event handling
            this.menu.setupEventListeners = () => {
                if (this.menu.abortController) {
                    this.menu.abortController.abort();
                }
                this.menu.abortController = new AbortController();
                const { signal } = this.menu.abortController;

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

        this.menu.existingTags = existingTags;
        this.menu.contextTerms = committed;

        this.positionMenu();
        
        this.menu.searchTags(currentWord);
    }

    positionMenu() {
        if (!this.menu || !this.menu.root || !this.attachedElement) return;

        const startCoords = getElementOrCursorCoords(this.attachedElement, this.currentWordStart);
        const endCoords = getElementOrCursorCoords(this.attachedElement); // No position = use current cursor

        let finalCoords = startCoords;

        // Check for line wrap by comparing Y positions of word start and cursor end.
        if (Math.abs(endCoords.y - startCoords.y) > startCoords.lineHeight / 2) {
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
        
        let wordLengthToReplace = 0;
        if (this.currentWord && this.currentWord.length > 0) {
            wordLengthToReplace = this.currentWord.length;
        } else {
            const currentWordInfo = this.getCurrentWord();
            wordLengthToReplace = currentWordInfo ? currentWordInfo.length : 0;
        }

        // Parentheses are weighting syntax in a prompt, but in a search field the term is matched literally and a backslash would be part of what is looked up.
        const escapedTag = this.attachOptions?.escapeParens === false
            ? tagName
            : tagName.replace(/\(/g, '\\(').replace(/\)/g, '\\)');
        
        const afterCursor = this.helper.getAfterCursor();
        const trimmedAfter = afterCursor.trim();
        let shouldAddSeparator = !trimmedAfter.startsWith(',') && !trimmedAfter.startsWith(')') && !trimmedAfter.startsWith(':');

        // Don't add a separator if we're in a single-tag input field / filters with autocomplete
        if (this.attachedElement.classList.contains('comfy-context-menu-filter')) {
            shouldAddSeparator = false;
        }

        const separator = shouldAddSeparator ? ', ' : '';
        
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

const ERE_NODE_TYPE_PREFIX = "ErePrompt";

/** Is this textarea the prompt input of one of our own nodes? */
function isEreNodeTextarea(target) {
    // Ours outright: a Composer multiline category builds its own field.
    if (target.classList?.contains("ere-textarea")) return true;

    // Legacy: multiline (and any other) text widget owns the textarea as element/inputEl.
    for (const node of app.graph?._nodes ?? []) {
        if (!node.type?.startsWith(ERE_NODE_TYPE_PREFIX)) continue;
        if (node.widgets?.some(w => w.element === target || w.inputEl === target)) return true;
    }

    // Vue: textarea lives under the node element, not on the widget object.
    const nodeElement = target.closest?.("[data-node-id]");
    if (nodeElement) {
        const node = app.graph?.getNodeById?.(nodeElement.dataset.nodeId);
        if (node?.type?.startsWith(ERE_NODE_TYPE_PREFIX)) return true;
    }

    return false;
}

/** Textareas to keep out of, so another pack's autocomplete does not open a second menu. A setting, since we cannot know every pack that does this. */
function isExcludedTextarea(target) {
    const raw = app.ui?.settings?.getSettingValue?.("EreNodes.Autocomplete.Exclude", "") ?? "";
    for (const selector of raw.split(",").map(s => s.trim()).filter(Boolean)) {
        try {
            if (target.matches?.(selector) || target.closest?.(selector)) return true;
        } catch {
            // A typo in the setting must not take autocomplete down with it.
            console.warn(`[EreNodes] Ignoring invalid autocomplete exclude selector: ${selector}`);
        }
    }
    return false;
}

if (typeof app !== "undefined") {
    app.globalAutocompleteInstance = new GlobalAutocomplete();
    document.addEventListener("focusin", (e) => {
        if (e.target.tagName !== "TEXTAREA") return;
        if (isExcludedTextarea(e.target)) return;

        const globalEnabled = app.ui.settings.getSettingValue('EreNodes.Autocomplete.Global', true);
        const nodesEnabled = app.ui.settings.getSettingValue('EreNodes.Autocomplete.Nodes', true);
        // Outside our own nodes the global setting still rules.
        if (!globalEnabled && !(nodesEnabled && isEreNodeTextarea(e.target))) {
            return;
        }

        const parentContextMenu = e.target.closest('.litecontextmenu');
        const isSearchBoxParent = parentContextMenu ? parentContextMenu.querySelector('.comfy-context-menu-filter') : false;

        if (
            (!parentContextMenu || !isSearchBoxParent) &&
            !e.target.classList.contains('comfy-context-menu-filter') &&
            app.globalAutocompleteInstance.attachedElement !== e.target
        ) {
            app.globalAutocompleteInstance.attach(e.target);
        }
    });
}
