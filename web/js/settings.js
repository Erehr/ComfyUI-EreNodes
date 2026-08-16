import { app } from "../../../../scripts/app.js";

// Fetch CSV options before registration so the combo can be populated.
// (Top-level await is fine here: extension files are loaded as ES modules.)
let csvOptions = [];
try {
    // Timeout so a stalled endpoint can't block extension loading forever.
    const response = await fetch("/erenodes/list_csv_files", { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
        const csvFiles = await response.json();
        csvOptions = csvFiles.map(file => ({ text: file, value: file }));
    }
} catch (e) {
    console.warn("[EreNodes] Could not fetch autocomplete CSV list.", e);
}

/**
 * Push the tag-group location to the server and, when the user moved it, offer
 * to bring existing groups along.
 *
 * The server is the source of truth for this one (the ComfyUI settings store is
 * frontend-only, and Python needs to know where to read and write), so the
 * combo only ever *requests* a location — the response says what actually
 * happened.
 */
async function applyTagGroupsLocation(location, previousValue) {
    if (!location) return;

    let result;
    try {
        const response = await fetch("/erenodes/set_tag_groups_location", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ location }),
        });
        result = await response.json();
        if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
    } catch (e) {
        console.error("[EreNodes] Could not set tag groups location.", e);
        app.extensionManager?.toast?.add({
            severity: "error",
            summary: "Tag Groups Folder",
            detail: `${e.message}. The previous location is still in use.`,
            life: 6000,
        });
        return;
    }

    // First call of the session just syncs server state — nothing to migrate.
    if (previousValue === undefined || result.previous === result.location) return;

    app.extensionManager?.toast?.add({
        severity: "success",
        summary: "Tag Groups Folder",
        detail: result.resolved,
        life: 4000,
    });

    if (!result.legacy_count) return;

    const message = `${result.legacy_count} tag group(s) are still in the previous folder. `
        + `Copy them to the new location? Nothing is deleted — the old folder stays as a backup.`;
    let confirmed;
    if (app.extensionManager?.dialog?.confirm) {
        confirmed = await app.extensionManager.dialog.confirm({ title: "Copy tag groups?", message });
    } else {
        confirmed = window.confirm(message);
    }
    if (!confirmed) return;

    try {
        const response = await fetch("/erenodes/migrate_tag_groups", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from: result.previous, to: result.location }),
        });
        const migrated = await response.json();
        if (!response.ok) throw new Error(migrated?.error || `HTTP ${response.status}`);
        app.extensionManager?.toast?.add({
            severity: "success",
            summary: "Tag groups copied",
            detail: `${migrated.copied} copied`
                + (migrated.skipped ? `, ${migrated.skipped} skipped (already present)` : ""),
            life: 5000,
        });
        // The sidebar is showing the old folder's contents.
        app.ereSidebar?.refresh?.();
    } catch (e) {
        console.error("[EreNodes] Migration failed.", e);
        app.extensionManager?.toast?.add({
            severity: "error",
            summary: "Copy failed",
            detail: e.message,
            life: 6000,
        });
    }
}

app.registerExtension({
    name: "EreNodes.Settings",
    // Declarative settings registration (current ComfyUI standard).
    // The ComfyUI settings store is the single source of truth for UI
    // preferences; only the active CSV is mirrored to the server, because
    // /erenodes/search_tags needs it.
    settings: [
        {
            id: "EreNodes.Autocomplete.Global",
            name: "Global Autocomplete",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "EreNodes.Autocomplete.Nodes",
            name: "Autocomplete in EreNodes prompts",
            tooltip: "Keep autocomplete inside EreNodes prompt nodes (including Prompt Multiline) even when Global Autocomplete is off.",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "EreNodes.Autocomplete.CSV",
            name: "Autocomplete CSV File",
            type: "combo",
            defaultValue: csvOptions.length > 0 ? csvOptions[0].value : "",
            options: csvOptions,
            onChange: (newVal) => {
                if (!newVal) return;
                // Also fires once on page load, which keeps the server's
                // settings.json in sync with the settings store.
                fetch("/erenodes/set_setting", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "autocomplete.csv", value: newVal }),
                }).catch(() => {});
            },
        },
        {
            id: "EreNodes.TagGroups.Location",
            name: "Tag Groups Folder",
            tooltip: "Where tag groups are stored. The node folder is wiped by a "
                   + "reinstall or a ComfyUI Manager update; the models folder survives both. "
                   + "To put them elsewhere, add 'tag_groups:' to extra_model_paths.yaml.",
            type: "combo",
            defaultValue: "node",
            options: [
                { text: "Node folder (__prompts__)", value: "node" },
                { text: "ComfyUI models/tag_groups", value: "models" },
            ],
            onChange: (newVal, oldVal) => {
                // Fires once on page load with oldVal undefined, which keeps the
                // server's settings.json in sync with the settings store.
                applyTagGroupsLocation(newVal, oldVal);
            },
        },
        {
            id: "EreNodes.Sidebar.DefaultNode",
            name: "Sidebar: node created on click",
            tooltip: "Which prompt node the EreNodes sidebar creates when you click a tag group.",
            type: "combo",
            defaultValue: "ErePromptCloud",
            options: [
                { text: "Prompt Cloud", value: "ErePromptCloud" },
                { text: "Prompt Toggle", value: "ErePromptToggle" },
                { text: "Prompt Multi Select", value: "ErePromptMultiSelect" },
                { text: "Prompt Randomizer", value: "ErePromptRandomizer" },
                { text: "Prompt Gallery", value: "ErePromptGallery" },
            ],
        },
        {
            id: "EreNodes.Nodes.PasteAction",
            name: "Paste Action",
            type: "combo",
            defaultValue: "Replace tags",
            options: ["Replace tags", "Append tags"].map(v => ({ text: v, value: v })),
        },
        {
            id: "EreNodes.Nodes.TagAreaScroll",
            name: "Scrollable Tag Area",
            tooltip: "When on, resizing a node smaller than its tags scrolls them. When off (default), the node always grows/shrinks to fit the tags — only width is free.",
            type: "boolean",
            defaultValue: false,
            onChange: () => {
                for (const node of app.graph?._nodes ?? []) node.onTagAreaPolicyChanged?.();
                app.graph?.setDirtyCanvas?.(true, true);
            },
        },
    ],
});
