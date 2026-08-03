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
