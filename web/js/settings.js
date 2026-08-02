import { app } from "../../../../scripts/app.js";

app.registerExtension({
    name: "EreNodes.Autocomplete",
    async setup() {

        // Fetch CSV files for settings
        const response = await fetch("/erenodes/list_csv_files");
        const csvFiles = await response.json();
        const csvOptions = csvFiles.map(file => ({ text: file, value: file }));

        // Register settings
        app.ui.settings.addSetting({
            id: "EreNodes.Autocomplete.Global",
            name: "Global Autocomplete",
            type: "boolean",
            defaultValue: true,
            onChange: (newVal) => {
                fetch("/erenodes/set_setting", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "autocomplete.global", value: newVal }),
                });
            },
        });

        app.ui.settings.addSetting({
            id: "EreNodes.Autocomplete.Nodes",
            name: "Autocomplete in EreNodes prompts",
            tooltip: "Keep autocomplete inside EreNodes prompt nodes even when Global Autocomplete is off.",
            type: "boolean",
            defaultValue: true,
            onChange: (newVal) => {
                fetch("/erenodes/set_setting", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "autocomplete.nodes", value: newVal }),
                });
            },
        });

        app.ui.settings.addSetting({
            id: "EreNodes.Autocomplete.CSV",
            name: "Autocomplete CSV File",
            type: "combo",
            defaultValue: csvOptions.length > 0 ? csvOptions[0].value : "",
            options: csvOptions,
            onChange: (newVal) => {
                fetch("/erenodes/set_setting", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "autocomplete.csv", value: newVal }),
                });
            },
        });

        app.ui.settings.addSetting({
            id: "EreNodes.Nodes.TagAreaScroll",
            name: "Scrollable Tag Area",
            tooltip: "Resizing a node smaller than its tags scrolls them. Turn off to always grow the node to fit.",
            type: "boolean",
            defaultValue: true,
            onChange: (newVal) => {
                fetch("/erenodes/set_setting", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "node.tag_area_scroll", value: newVal }),
                });

                for (const node of app.graph?._nodes ?? []) node.onTagAreaPolicyChanged?.();
                app.graph?.setDirtyCanvas(true, true);
            },
        });

        app.ui.settings.addSetting({
            id: "EreNodes.Nodes.PasteAction",
            name: "Paste Action",
            type: "combo",
            defaultValue: "Replace tags",
            options: ["Replace tags", "Append tags"].map(v => ({ text: v, value: v })),
            onChange: (newVal) => {
                fetch("/erenodes/set_setting", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "node.paste", value: newVal }),
                });
            },
        });
    },
});
