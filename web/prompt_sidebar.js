import { app } from "../../scripts/app.js";
import { mountSidebar, unmountSidebar, refresh } from "./js/sidebar.js";

// Registers the EreNodes sidebar tab.
// `type: "custom"` hands us a bare HTMLElement, and `render(el)` runs again on every re-mount — so mountSidebar is idempotent and keeps its state in a module singleton.
app.registerExtension({
    name: "EreNodes.Sidebar",
    async setup() {
        /**
         * registerSidebarTab postdates some supported ComfyUI versions.
         * Skip quietly rather than throwing during extension load, which would take the rest of EreNodes down with it.
         */
        if (typeof app.extensionManager?.registerSidebarTab !== "function") {
            console.warn("[EreNodes] Sidebar tabs unsupported by this ComfyUI frontend; skipping.");
            return;
        }

        try {
            app.extensionManager.registerSidebarTab({
                id: "erenodes",
                title: "EreNodes",
                tooltip: "EreNodes",
                icon: "pi pi-tags",
                type: "custom",
                render: (el) => mountSidebar(el),
                destroy: () => unmountSidebar(),
            });
            // Lets other modules (saves, migrations) ask the sidebar to re-read from disk without importing it and creating a cycle.
            app.ereSidebar = { refresh };
        } catch (e) {
            console.error("[EreNodes] Failed to register sidebar tab.", e);
        }
    },
});
