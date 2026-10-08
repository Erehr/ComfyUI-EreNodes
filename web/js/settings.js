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
            name: "In every textarea",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "EreNodes.Autocomplete.Nodes",
            name: "In EreNodes prompts",
            tooltip: "Keep autocomplete inside EreNodes prompt nodes (including Prompt Multiline) even when 'In every textarea' is off.",
            type: "boolean",
            defaultValue: true,
        },
        {
            id: "EreNodes.Autocomplete.Limit",
            name: "Suggestions shown",
            tooltip: "How many tag suggestions the autocomplete menu offers. The server clamps this to 1-100.",
            type: "number",
            defaultValue: 20,
            attrs: { min: 1, max: 100, step: 1 },
        },
        {
            id: "EreNodes.Autocomplete.Aliases",
            name: "Alias handling",
            tooltip: "How a tag's other spellings are shown: listed under the tag, in a submenu off it (hover or the right arrow), or as suggestions of their own.",
            type: "combo",
            defaultValue: "grouped",
            options: [
                { text: "Listed under the tag", value: "grouped" },
                { text: "In a submenu", value: "submenu" },
                { text: "As separate suggestions", value: "flat" },
            ],
        },
        {
            id: "EreNodes.Autocomplete.UsedTags",
            name: "Tags already in the prompt",
            tooltip: "A tag already in the prompt can drop out of the suggestions with all its aliases, or carry on as its first unused alias so the other spellings stay reachable.",
            type: "combo",
            defaultValue: "aliases",
            options: [
                { text: "Offer its remaining aliases", value: "aliases" },
                { text: "Hide it and its aliases", value: "hide" },
            ],
        },
        {
            id: "EreNodes.Autocomplete.Exclude",
            name: "Skip these textareas",
            tooltip: "Comma-separated CSS selectors. Any textarea matching one (or sitting inside one) is left alone by the global autocomplete. Use this when another custom node brings its own autocomplete and you get two menus at once. Default covers ComfyUI-Easy-Use's Anima prompt.",
            type: "text",
            defaultValue: ".easyuse-anima-highlight-input, .autocomplete-text-widget",
        },
        {
            id: "EreNodes.Autocomplete.CSV",
            name: "Tag list (CSV)",
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
            name: "Storage folder",
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
            name: "Node created on click",
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
            id: "EreNodes.Sidebar.BooruRating",
            name: "Booru ratings",
            tooltip: "Which posts the Booru tab shows on Gelbooru and e621. Safebooru only holds safe posts, so it is not affected. e621 has no sensitive level, so up to sensitive shows its safe posts.",
            type: "combo",
            defaultValue: "sensitive",
            options: [
                { text: "General only", value: "general" },
                { text: "Up to sensitive", value: "sensitive" },
                { text: "Up to questionable", value: "questionable" },
                { text: "All", value: "all" },
            ],
        },
        {
            id: "EreNodes.Sidebar.BooruBlockedTags",
            name: "Booru blocked tags",
            tooltip: "Comma-separated. Posts carrying any of these are left out of every Booru search, as if each were searched with a minus in front.",
            type: "text",
            defaultValue: "",
        },
        {
            id: "EreNodes.Sidebar.BooruHiddenTags",
            name: "Booru hidden tags",
            tooltip: "Comma-separated. Posts with these still show, but the tags are left out of their preview and of what a drag adds. Meta tags (highres, absurdres and the like) are always left out.",
            type: "text",
            defaultValue: "watermark, username, logo, signature",
        },
        {
            id: "EreNodes.Sidebar.GelbooruUserId",
            name: "Gelbooru user ID",
            tooltip: "Gelbooru only answers API requests from an account. The user ID and API key are on gelbooru.com under My Account → Options.",
            type: "text",
            defaultValue: "",
        },
        {
            id: "EreNodes.Sidebar.GelbooruApiKey",
            name: "Gelbooru API key",
            tooltip: "Stored in ComfyUI's settings file for your user, in plain text like every other setting, and sent by the ComfyUI server to gelbooru.com only.",
            type: "text",
            defaultValue: "",
        },
        {
            id: "EreNodes.Sidebar.GelbooruAllContent",
            name: "Gelbooru: show all content",
            tooltip: "Gelbooru hides part of its catalogue until a visitor opts in to seeing everything, as its own site does with a cookie. Without this some searches find only a few of the posts gelbooru.com shows when you are logged in. Independent of Booru ratings.",
            type: "boolean",
            defaultValue: false,
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
            id: "EreNodes.Nodes.RemoveDuplicates",
            name: "Remove duplicate tags from output",
            tooltip: "When on (default), a tag that appears more than once in a node's prompt — as a pill, inside a tag group, or as a LoRA trigger word — is written once, where it first appears. Turn off to get the prompt exactly as the tags list it.",
            type: "boolean",
            defaultValue: true,
            onChange: () => {
                for (const node of app.graph?._nodes ?? []) node.onUpdateTextWidget?.(node);
            },
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
        {
            id: "EreNodes.Nodes.TextPillsOneLine",
            name: "Text pills on one line",
            tooltip: "When on, a text pill (a whole sentence) on a node shows only what fits on one line, ending in …; quick edit still shows all of it. When off (default), it wraps to show the whole text.",
            type: "boolean",
            defaultValue: false,
            // A page class rather than a re-render: the cut is pure CSS (tagview.css). Nodes still re-render, since their height changes.
            onChange: (value) => {
                document.documentElement.classList.toggle("ere-text-oneline", !!value);
                for (const node of app.graph?._nodes ?? []) node._ereDom?.render?.();
            },
        },
    ],
});
