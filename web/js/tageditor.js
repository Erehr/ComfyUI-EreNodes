import { app } from "../../../scripts/app.js";
import { initializeSharedPromptFunctions, saveTagGroup } from "../prompt.js";
import { getCache, isNotFound, loadStyle, isAcceptedImage, ACCEPTED_IMAGE_TYPES, isKnownMissing, ensureChecked } from "./util.js";
import { SURFACE_CLASS, injectTagStyles, renderTagPill, previewUrl } from "./tagview.js";
import { parseTags, dedupeTags } from "./parser.js";
import { injectDragStyles, markDropZone, attachPillDrag, pruneSelection, handlePillSelectClick, handlePillContextMenu, consumeDragClick, clearAllSelections } from "./dragdrop.js";
import { TagSelectionContextMenu } from "./contextmenu.js";

const toast = (severity, summary, detail, life = 4000) => {
    try { app.extensionManager?.toast?.add({ severity, summary, detail, life }); } catch {}
};

function el(tag, className, parent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
}

// Tag Data

async function loadGroupTags(name, extension = ".json") {
    const filename = extension ? `${name}${extension}` : name;
    try {
        const value = getCache(
            `/erenodes/get_tag_group?filename=${encodeURIComponent(filename)}`, "json");
        const resolved = value instanceof Promise ? await value : value;
        return isNotFound(resolved) || !Array.isArray(resolved) ? null : resolved;
    } catch { return null; }
}

/**
 * Replace every tag group pill with its contents, in place.
 *
 * @returns {boolean} whether anything changed.
 */
async function unpackGroups(host) {
    const tags = parseTags(host.properties._tagDataJSON || "[]");
    if (!tags.some(t => t.type === "group")) return false;

    const expanded = [];
    for (const tag of tags) {
        if (tag.type !== "group") { expanded.push(tag); continue; }
        const contents = await loadGroupTags(tag.name, tag.extension);
        if (!contents) {
            // A group pill pointing at a file that no longer exists.
            // Dropping it is the only option — it cannot be kept and cannot be expanded.
            toast("warn", "Tag group missing",
                `"${tag.name}" could not be read, so it was not added.`, 5000);
            continue;
        }
        const copy = JSON.parse(JSON.stringify(contents));
        /** A group pill can carry per-tag toggles made after it was loaded; the unpacked pills should reflect what the pill showed, not the file. */
        if (tag.modified) {
            for (const t of copy) {
                if (Object.prototype.hasOwnProperty.call(tag.modified, t.name)) {
                    t.active = tag.modified[t.name];
                }
            }
        }
        expanded.push(...copy);
    }

    host.properties._tagDataJSON = JSON.stringify(dedupeTags(expanded), null, 2);
    return true;
}

// The Pseudo Node
//
// The drag layer and the menus only need "a node": `properties._tagDataJSON` plus some callbacks.
// None touch the graph, so a plain object suffices.

function makeHost(onChange) {
    const host = {
        id: "ere-tag-editor",     // drag layer uses this only as a cache key
        // Not "ErePromptMultiline", which is the one type prompt.js branches on.
        type: "ErePromptCloud",
        title: "Tag Group",
        widgets: [],
        properties: { _tagDataJSON: "[]" },
        setDirtyCanvas: () => {},
    };
    initializeSharedPromptFunctions(host, null);

    // Everything that mutates tags funnels through here, so unpacking a dropped group and re-rendering both need to happen in exactly one place.
    const inner = host.onUpdateTextWidget;
    host.onUpdateTextWidget = async (node) => {
        await inner?.(node || host);
        if (await unpackGroups(host)) { /* tag data rewritten in place */ }
        onChange();
    };

    /** Replaces prompt.js's version rather than wrapping it: that one writes an undo checkpoint for the *graph*, and clearing pills in a panel that has not been saved yet has nothing to do with the graph's history. */
    host.onRemoveTags = (mode = "all") => {
        const tags = parseTags(host.properties._tagDataJSON || "[]");
        host.properties._tagDataJSON = mode === "inactive"
            ? JSON.stringify(tags.filter(t => t.active), null, 2)
            : "[]";
        clearAllSelections();
        onChange();
    };

    return host;
}

// The Panel

/**
 * Build an editor panel in three pieces: the name and cover rows go in the sidebar header (the search row and tab strip slots), the pills in the body.
 *
 * @param {string} opts.folder  destination folder ("" is the root)
 * @param {string} opts.coverUrl  existing cover to show (edit mode)
 * @param {File} opts.coverFile  a cover to upload on save
 */
export function createTagEditor(opts) {
    injectTagStyles();
    injectDragStyles();
    injectEditorStyles();

    const {
        mode = "new", folder = "", name = "", tags = [],
        coverUrl = "", coverFile = null, onCancel, onSaved,
    } = opts;

    let pendingCover = coverFile;             // File, uploaded on save
    let objectUrl = null;                     // revoked on destroy
    let dropCover = false;                    // edit mode: remove the stored one
    // A cover handed in as a File (dropping an image on the tree) has no URL yet — it is not on the server until Save.
    // Show it from memory meanwhile, or the pane would read as empty right after the drop that filled it.
    if (coverFile) objectUrl = URL.createObjectURL(coverFile);
    let coverSrc = objectUrl || coverUrl;

    // Name row: SidebarTopArea + SearchInput markup, class for class, minus the magnifier and its `pl-8` offset.
    const nameRow = el("div", "flex items-center gap-2 p-2 2xl:px-4");
    const nameOuter = el("div", "min-w-0 flex-1", nameRow);
    const nameBox = el("div",
        "relative flex w-full cursor-text items-center rounded-lg bg-secondary-background text-base-foreground h-8 px-2 py-1.5", nameOuter);
    const nameInput = el("input", "size-full border-none bg-transparent outline-none text-xs", nameBox);
    nameInput.type = "text";
    nameInput.placeholder = "Tag group name";
    nameInput.value = name;
    nameInput.spellcheck = false;
    nameBox.addEventListener("click", () => nameInput.focus());

    // Cover row: where the tab strip would be, between the same two separators.
    const coverRow = el("div", `border-b border-comfy-input p-2 2xl:px-4 ${SURFACE_CLASS} ere-editor-cover`);
    const pane = el("div", "ere-extract-pane", coverRow);

    const body = el("div", `ere-editor ${SURFACE_CLASS}`);

    // `erenodes-dom` is what the drag layer looks for (rootOf); `_ereNode` and `_ereMode` are how it resolves the drop target.
    const dom = el("div", `erenodes-dom ${SURFACE_CLASS} ere-editor-dom`, body);
    const host = makeHost(() => renderTags());
    host.properties._tagDataJSON = JSON.stringify(tags || [], null, 2);
    dom._ereNode = host;
    dom._ereMode = "cloud";

    const toolbar = el("div", "ere-toolbar ere-flow", dom);
    const scroll = el("div", "ere-scroll", dom);
    const content = el("div", "erenodes-dom-content", scroll);
    const flow = el("div", "ere-flow", content);
    markDropZone(flow, "flow");

    host._ereDom = { el: dom, toolbar, scroll, content, render: () => renderTags() };

    // Actions ComfyUI's own button classes, not ours: these are chrome, and the monospace `ere-surface` font belongs to tag pills alone.
    const BTN_BASE = "relative inline-flex items-center justify-center gap-2 cursor-pointer touch-manipulation whitespace-nowrap appearance-none border-none font-medium font-inter transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 h-8 rounded-lg p-2 text-xs";
    const BTN_SECONDARY =
        `${BTN_BASE} bg-secondary-background text-base-foreground hover:bg-secondary-background-hover`;
    const BTN_PRIMARY =
        `${BTN_BASE} bg-primary-background text-base-foreground hover:bg-primary-background-hover`;

    const actions = el("div", "ere-editor-actions", body);
    // Cancel is the way out, not the thing to aim at — it gets the narrow width.
    const cancelBtn = el("button", `${BTN_SECONDARY} w-20`, actions);
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    const saveBtn = el("button", `${BTN_PRIMARY} w-36`, actions);
    saveBtn.type = "button";
    saveBtn.textContent = "Save";
    // `w-36` on both, so the row does not resize as tags come and go.
    const setSaveEnabled = (enabled) => {
        saveBtn.disabled = !enabled;
        saveBtn.className = `${enabled ? BTN_PRIMARY : BTN_SECONDARY} w-36`;
    };

    // Cover

    function setCoverFile(file) {
        if (!isAcceptedImage(file)) {
            toast("error", "Unsupported file", `${file?.name || "That file"} is not a PNG, JPEG or WebP.`);
            return;
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(file);
        pendingCover = file;
        coverSrc = objectUrl;
        dropCover = false;
        renderCover();
    }

    function pickCover() {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ACCEPTED_IMAGE_TYPES.join(",");
        input.style.display = "none";
        document.body.appendChild(input);
        let settled = false;
        const cleanup = () => { if (input.isConnected) input.remove(); };
        input.addEventListener("change", () => {
            if (settled) return;
            settled = true;
            const file = input.files?.[0];
            cleanup();
            if (file) setCoverFile(file);
        });
        input.addEventListener("cancel", () => { settled = true; cleanup(); });
        input.click();
    }

    function renderCover() {
        pane.textContent = "";
        pane.classList.toggle("empty", !coverSrc);
        if (coverSrc) {
            const img = el("img", null, pane);
            img.src = coverSrc;
            img.alt = "Cover image";
            img.draggable = false;
            // A group with no cover still has a URL — the route just 404s.
            // Fall all the way back to the empty state rather than hiding the image and leaving a blank box: the pane would collapse and read as missing, when it is in fact the drop target.
            img.addEventListener("error", () => {
                coverSrc = "";
                renderCover();
            });
            const clear = el("button", "ere-editor-clear", pane);
            clear.type = "button";
            clear.title = "Remove cover image";
            clear.textContent = "✕";
            clear.addEventListener("click", (e) => {
                e.stopPropagation();
                if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
                pendingCover = null;
                coverSrc = "";
                dropCover = true;
                renderCover();
            });
        } else {
            const empty = el("div", "ere-extract-empty", pane);
            // Cover only.
            // Extraction happens in exactly two places: the Prompt Extractor node, and a drop on the sidebar tree.
            empty.textContent = "Drop an image to use as the cover.";
        }
    }

    pane.addEventListener("click", (e) => { e.stopPropagation(); pickCover(); });
    pane.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pane.classList.add("ere-extract-over");
    });
    pane.addEventListener("dragleave", () => pane.classList.remove("ere-extract-over"));
    pane.addEventListener("drop", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pane.classList.remove("ere-extract-over");
        const file = e.dataTransfer?.files?.[0];
        if (file) setCoverFile(file);
    });

    // Pills

    function makeButton(label, display, title, onClick) {
        const btn = el("button", "ere-btn", toolbar);
        btn.type = "button";
        btn.textContent = display;
        btn.title = title;
        btn.addEventListener("click", (e) => { e.stopPropagation(); onClick(e); });
        return btn;
    }

    /** Reduced: a file is being edited, not a node, so only the actions that change what gets written are useful here. */
    function openMenu(e) {
        new TagSelectionContextMenu(
            { clientX: e.clientX, clientY: e.clientY },
            "Tag Group",
            [
                { name: "🔀 Toggle All Tags", callback: () => host.onToggleTags?.() },
                { name: "🧹 Remove Inactive Tags", callback: () => host.onRemoveTags?.("inactive") },
                { name: "🗑️ Remove All Tags", callback: () => host.onRemoveTags?.("all") },
                null,
                { name: "🖼️ Choose Cover Image…", callback: () => pickCover() },
            ]
        );
    }

    function renderTags() {
        const tagData = parseTags(host.properties._tagDataJSON || "[]");
        pruneSelection(host, tagData);

        toolbar.textContent = "";
        makeButton("button_menu", "≡", "Menu", openMenu);
        makeButton("button_add_tag", "+", "Add tag", (e) => host.onAddTag?.(e, [0, 0]));

        flow.textContent = "";
        for (let i = 0; i < tagData.length; i++) {
            flow.appendChild(makePill(tagData[i], i));
        }
        // Same fire-and-forget as the node renderer: draw from what is known, re-render once if a "missing" verdict arrives late.
        // Saving a group whose LoRA has vanished is exactly when you want to be told.
        ensureChecked(tagData).then((learned) => { if (learned) renderTags(); });
        if (!tagData.length) {
            const empty = el("div", "ere-editor-empty", flow);
            empty.textContent = "Drag tags here from any prompt node, or use +.";
        }
        setSaveEnabled(tagData.length > 0);
    }

    /** The same wiring renderer.js does for a node's pills, minus the node — click toggles, ctrl/shift manage the selection, right-click quick-edits. */
    function makePill(tag, index) {
        const pill = renderTagPill(tag);
        if (isKnownMissing(tag)) {
            pill.classList.add("ere-missing");
            pill.title = `${pill.title || tag.name}\nFile not found`;
        }
        attachPillDrag(host, pill, index, "cloud");
        pill.addEventListener("click", (e) => {
            e.stopPropagation();
            if (consumeDragClick()) return;
            if (handlePillSelectClick(host, index, e)) return;
            host.onTagPillClick?.(e, [0, 0], { label: tag.name, index });
        });
        pill.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const rect = pill.getBoundingClientRect();
            const anchor = { clientX: rect.left, clientY: rect.bottom + 5 };
            if (handlePillContextMenu(host, index, e, anchor)) return;
            host.onTagQuickEdit?.(anchor, host, { label: tag.name, index });
        });
        return pill;
    }

    // Save

    let saving = false;

    async function save() {
        if (saving) return;
        const filename = nameInput.value.trim();
        if (!filename) {
            toast("warn", "Name required", "Give the tag group a name before saving.");
            nameInput.focus();
            return;
        }
        const tagData = parseTags(host.properties._tagDataJSON || "[]");
        if (!tagData.length) {
            toast("warn", "No tags", "A tag group needs at least one tag.");
            return;
        }

        saving = true;
        setSaveEnabled(false);
        try {
            /**
             * Editing and renaming are the same gesture: change the name, press Save.
             * The rename goes first and through the normal route, which also carries the cover image across; writing the new file and leaving the old one
             */
            if (mode === "edit" && filename !== name) {
                const renamed = await renameGroup(folder, name, filename);
                if (!renamed) return;               // renameGroup already reported
            }

            const result = await saveTagGroup({
                path: folder,
                filename,
                tags: tagData,
                imageFile: pendingCover || undefined,
                // Edit mode is *about* rewriting an existing file; asking "this already exists, overwrite?" about the file the user opened is noise.
                // A new group still asks — including after a rename, where the destination is a name the user has not seen.
                overwriteSilently: mode === "edit" && filename === name,
            });
            if (!result?.ok) return;                 // saveTagGroup already reported
            if (dropCover && !pendingCover) await removeCover(folder, filename);
            onSaved?.(result.fullPath);
        } finally {
            saving = false;
            setSaveEnabled(parseTags(host.properties._tagDataJSON || "[]").length > 0);
        }
    }

    saveBtn.addEventListener("click", save);
    cancelBtn.addEventListener("click", () => onCancel?.());

    nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); save(); }
    });
    /** Esc closes, but only from inside the panel: a global handler would fight the context menus the editor itself opens. */
    for (const part of [nameRow, coverRow, body]) {
        part.addEventListener("keydown", (e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            onCancel?.();
        });
    }

    renderCover();
    renderTags();

    return {
        title: mode === "edit" ? "Edit Tag Group" : "Save Tag Group",
        nameRow,
        coverRow,
        body,
        focus: () => nameInput.focus(),
        destroy: () => {
            if (objectUrl) URL.revokeObjectURL(objectUrl);
            clearAllSelections();
        },
    };
}

/** Rename a group before rewriting it, so the cover follows the .json. */
async function renameGroup(folder, from, to) {
    const path = folder ? `${folder}/${from}.json` : `${from}.json`;
    try {
        const response = await fetch("/erenodes/rename_path", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path, newName: to }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
        return true;
    } catch (e) {
        toast("error", "Rename failed", e.message, 5000);
        return false;
    }
}

/** Delete a group's cover after the user cleared it in the editor. */
async function removeCover(folder, filename) {
    const base = filename.replace(/\.json$/i, "");
    const path = folder ? `${folder}/${base}` : base;
    try {
        await fetch("/erenodes/delete_file_image", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "group", name: path }),
        });
    } catch (e) {
        console.warn("[EreNodes] Could not remove cover image.", e);
    }
}

/** The cover URL for an existing group, or "" — used to open the editor on one. */
export function coverUrlFor(path) {
    return previewUrl("group", path);
}

export { loadGroupTags };

function injectEditorStyles() { loadStyle("editor"); }
