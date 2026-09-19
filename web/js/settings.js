import { app } from "../../../scripts/app.js";
import { requestJson, toast, confirmDialog } from "./util.js";
import { DEFAULT_SEPARATOR } from "./parser.js";

// Fetch CSV options before registration so the combo can be populated.
// (Top-level await is fine here: extension files are loaded as ES modules.)
// The server decides the tag-group location (fresh installs get the user folder, ones with groups already in the node folder stay there), so the combo seeds from it instead of asserting its own default.
let csvOptions = [];
let tagGroupsLocation = "user";
let tagGroupsLegacy = false;

// Timeout so a stalled endpoint cannot block extension loading forever, and both at once so they do not queue.
const [csvFiles, location] = await Promise.all([
    requestJson("/erenodes/list_csv_files", { signal: AbortSignal.timeout(5000) })
        .catch(e => { console.warn("[EreNodes] Could not fetch autocomplete CSV list.", e); return null; }),
    requestJson("/erenodes/tag_groups_location", { signal: AbortSignal.timeout(5000) })
        .catch(e => { console.warn("[EreNodes] Could not fetch tag groups location.", e); return null; }),
]);
if (Array.isArray(csvFiles)) csvOptions = csvFiles.map(file => ({ text: file, value: file }));
if (location?.location) tagGroupsLocation = location.location;
tagGroupsLegacy = !!location?.legacy;

/**
 * Push the tag-group location to the server and offer to migrate existing groups.
 * The server is the source of truth here, so the combo only *requests* a location — the response says what actually happened.
 */
async function applyTagGroupsLocation(location, previousValue) {
    if (!location) return;

    let result;
    try {
        result = await requestJson("/erenodes/set_tag_groups_location", { body: { location } });
    } catch (e) {
        console.error("[EreNodes] Could not set tag groups location.", e);
        toast("error", "Tag Groups Folder", `${e.message}. The previous location is still in use.`, 6000);
        return;
    }

    // First call of the session just syncs server state — nothing to migrate.
    if (previousValue === undefined || result.previous === result.location) return;

    toast("success", "Tag Groups Folder", result.resolved);

    if (!result.legacy_count) return;

    const message = `${result.legacy_count} tag group(s) are still in the previous folder. `
        + `Copy them to the new location? Nothing is deleted — the old folder stays as a backup.`;
    if (!await confirmDialog("Copy tag groups?", message)) return;

    try {
        const migrated = await requestJson("/erenodes/migrate_tag_groups", { body: { from: result.previous, to: result.location } });
        toast("success", "Tag groups copied",
            `${migrated.copied} copied` + (migrated.skipped ? `, ${migrated.skipped} skipped (already present)` : ""), 5000);
        // The sidebar is showing the old folder's contents.
        app.ereSidebar?.refresh?.();
    } catch (e) {
        console.error("[EreNodes] Migration failed.", e);
        toast("error", "Copy failed", e.message, 6000);
    }
}

app.registerExtension({
    name: "EreNodes.Settings",
    // Declarative settings registration (current ComfyUI standard).
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
            id: "EreNodes.Autocomplete.Limit",
            name: "Autocomplete suggestions shown",
            tooltip: "How many tag suggestions the autocomplete menu offers. The server clamps this to 1-100.",
            type: "number",
            defaultValue: 20,
            attrs: { min: 1, max: 100, step: 1 },
        },
        {
            id: "EreNodes.Autocomplete.Exclude",
            name: "Autocomplete: skip these textareas",
            tooltip: "Comma-separated CSS selectors. Any textarea matching one (or sitting inside one) is left alone by the global autocomplete. Use this when another custom node brings its own autocomplete and you get two menus at once. Default covers ComfyUI-Easy-Use's Anima prompt.",
            type: "text",
            defaultValue: ".easyuse-anima-highlight-input, .autocomplete-text-widget",
        },
        {
            id: "EreNodes.Autocomplete.CSV",
            name: "Autocomplete CSV File",
            type: "combo",
            defaultValue: csvOptions.length > 0 ? csvOptions[0].value : "",
            options: csvOptions,
            onChange: (newVal) => {
                if (!newVal) return;
                // Also fires once on page load, which keeps the server's settings.json in sync with the settings store.
                requestJson("/erenodes/set_setting", { body: { key: "autocomplete.csv", value: newVal } }).catch(() => {});
            },
        },
        {
            id: "EreNodes.TagGroups.Location",
            name: "Tag Groups Folder",
            tooltip: "Where tag groups are stored. The user folder survives updates and reinstalls. Use the models folder to share one set across installs — it is the one 'tag_groups:' in extra_model_paths.yaml can redirect.",
            type: "combo",
            defaultValue: tagGroupsLocation,
            options: [
                { text: "ComfyUI user folder (recommended)", value: "user" },
                { text: "ComfyUI models/tag_groups", value: "models" },
                // Offered only while it is the folder in use: a reinstall or Manager update wipes it, so it is not somewhere to move to.
                ...(tagGroupsLegacy ? [{ text: "Node folder (__prompts__, legacy)", value: "node" }] : []),
            ],
            onChange: (newVal, oldVal) => {
                // Fires once on page load with oldVal undefined, which keeps the server's settings.json in sync with the settings store.
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
            id: "EreNodes.Nodes.TagSeparator",
            name: "Default tag separator",
            tooltip: "What goes between tags in a newly created node. Written as stored, with \\n for a line break. Existing nodes keep the separator they were saved with — change theirs in the node's ≡ menu, under Options.",
            type: "text",
            defaultValue: ", ",
        },
        {
            id: "EreNodes.Nodes.PrefixSeparator",
            name: "Default node separator",
            tooltip: "What goes between a newly created node and the node feeding its prefix (and between a Composer's categories). Written as stored, with \\n for a line break. Existing nodes keep the separator they were saved with — change theirs in the node's ≡ menu, under Options.",
            type: "text",
            defaultValue: DEFAULT_SEPARATOR,
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
