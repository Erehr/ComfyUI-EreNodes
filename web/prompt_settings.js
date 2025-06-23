import { app } from "../../../scripts/app.js";

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
    },
});
