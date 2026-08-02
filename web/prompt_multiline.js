import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, addLayoutSpacer, getSpacerTop } from "./prompt.js";

// Height of the strip kept free below the textarea for the erenodes button row
const BUTTON_ROW_HEIGHT = 30;

app.registerExtension({
    name: "ErePromptMultiline",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptMultiline") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const node = this;

            const textWidget = node.widgets?.find(w => w.name === "text");
            
            node.onMouseDown = (e, pos) => {

                const [x, y] = pos;

                // The textarea covers the rest of the node body, so the only clickable
                // area here is the button row - test the buttons directly.
                let clickedPill = null;
                for (const pill of node._pillMap || []) {
                    if (x >= pill.x && x <= pill.x + pill.w && y >= pill.y && y <= pill.y + pill.h) {
                        clickedPill = pill;
                        break;
                    }
                }

                // Handle normal toggle click
                // no need to check shift click because we only show menu button
                if (clickedPill) {
                    node.onTagPillClick(e, pos, clickedPill);
                }

            };

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // Update on load
            this.onUpdateTextWidget(this);

            // Keep a strip below the textarea free for the action button
            node._buttonRowSpacer = addLayoutSpacer(node, "erenodes_button_row", BUTTON_ROW_HEIGHT);
        };
        
        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (origDraw) origDraw.call(this, ctx);
            const textWidget = this.widgets?.find(w => w.name === "text");
            if (!textWidget || this.flags?.collapsed) return;
        
            ctx.font = "12px monospace";

            // The buttons live in the strip reserved by the spacer widget, below the textarea.
            const pillX = 10, spacing = 5, pillPadding = 5;
            const pillY = getSpacerTop(this._buttonRowSpacer, this.size[1] - BUTTON_ROW_HEIGHT) + pillPadding;
            let currentX = pillX;
            let currentY = pillY;

            const positions = [];
            const specialTags = [
                { label: "button_menu", display: "≡" }
            ];

            for (const { display, label } of specialTags) {
                const pillMaxWidth = this.size[0] - pillX * 2;
                if (currentX + 20 > pillX + pillMaxWidth) {
                    currentX = pillX;
                    currentY += 20 + spacing;
                }
                positions.push({ x: currentX, y: currentY, w: 20, h: 20, label, display, button: true });
                currentX += 20 + spacing;
            }


            const pillHeight = (currentY + 20 + pillPadding) - pillY;
            this._tagAreaBottom = pillY + pillHeight;

            // Store pill positions for click handling
            this._pillMap = [];

            for (const p of positions) {
                ctx.beginPath();

                let pillFill = "#414650"; // Default
                ctx.fillStyle = LiteGraph.NODE_DEFAULT_BOXCOLOR;
                ctx.roundRect(p.x, p.y, p.w, p.h, 6);
                ctx.fill();

                ctx.textBaseline = "middle";
                const textX = p.x + (p.button ? p.w / 2 : 6);
                const textY = p.y + p.h / 2 + 1;
                
                ctx.textAlign = "center";
                ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
                ctx.fillText(p.display, textX, textY);

                ctx.textBaseline = "alphabetic";
                ctx.globalCompositeOperation='source-atop';
                this._pillMap.push({ x: p.x, y: p.y, w: p.w, h: p.h, label: p.label, button: p.button });
                ctx.globalCompositeOperation='source-over';
            }
            
        };

    }
});
