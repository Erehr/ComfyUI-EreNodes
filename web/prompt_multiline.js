import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions } from "./prompt.js";

app.registerExtension({
    name: "ErePromptMultiline",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptMultiline") return;

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const node = this;
            node.isEditMode = false;

            const textWidget = node.widgets?.find(w => w.name === "text");
            
            node.onMouseDown = (e, pos) => {
                if (node.isEditMode) return;

                const [x, y] = pos;

                // Get background area
                const bgX = 10, bgY = 35;
                const bgW = node.size[0] - bgX * 2;
                const bgH = node._tagAreaBottom - bgY;
                if (x >= bgX && x <= bgX + bgW && y >= bgY && y <= bgY + bgH) {

                    // Find if we are clicking pill
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

                }

            };

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // Update on load
            this.onUpdateTextWidget(this);
            
            // Dummy button to make space for action button
            let fakeButton = node.addWidget("button", "Placeholder", "fake_button", () => {});
            fakeButton.hidden = true;
        };
        
        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (origDraw) origDraw.call(this, ctx);
            const textWidget = this.widgets?.find(w => w.name === "text");
            if (!textWidget || this.flags?.collapsed) return;
        
            ctx.font = "12px monospace";

            // if we can't reorder widgets, we need to move pill to the bottom of the node where butotn makes space. For now leave it like that. 
            const pillX = 10, pillY = this.size[1] - 30, spacing = 5, pillPadding = 5;
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
