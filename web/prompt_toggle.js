import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";

app.registerExtension({
    name: "ErePromptToggle",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptToggle") return;

        const parseTags = value => {
            try {
                const parsed = JSON.parse(value || "[]");
                if (Array.isArray(parsed)) return parsed;
            } catch {}
            return [];
        };

        // Enhance node on creation
        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const node = this;
            node.isEditMode = false;

            const textWidget = node.widgets?.find(w => w.name === "text");
            textWidget.computeSize = () => [0, 0];
            textWidget.hidden = true;

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

                    // Handle normal toggle click and qucik edit shift click
                    if (clickedPill) { 
                        node.onTagPillClick(e, pos, clickedPill);
                    } 

                }

            };

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // Update on load
            this.onUpdateTextWidget(this);


        };

        // Draw tag pills
        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (origDraw) origDraw.call(this, ctx);

            const textWidget = this.widgets?.find(w => w.name === "text");
            if (!textWidget || this.isEditMode || this.flags?.collapsed) return;

            const tagData = parseTags(this.properties?._tagDataJSON || "[]");

            ctx.font = "12px monospace";

            const pillX = 10, pillY = 26 + 5, spacing = 5, pillPadding = 5;
            const pillMaxWidth = this.size[0] - pillX * 2;
            let currentX = pillX;
            let currentY = pillY;

            const positions = [];
            const specialTags = [
                { label: "button_menu", display: "≡" },
                { label: "button_add_tag", display: "+" }
            ];
    
            for (const { display, label } of specialTags) {
                if (currentX + 20 > pillX + pillMaxWidth - pillPadding) {
                    currentX = pillX + pillPadding;
                    currentY += 20 + spacing;
                }
                positions.push({ x: currentX, y: currentY, w: 20, h: 20, label, display, button: true });
                currentX += 20 + spacing;
            }

            for (const tag of tagData) {
                if (tag.type === "separator") {
                    currentX = pillX + pillPadding;
                    currentY += 20 + 10 + 4;
                    continue; 
                }

                let baseName = tag.name;
                let loraTriggersSuffix = ""; // Will include leading space if needed
                let strengthStringToDraw = null; // Separate string for strength

                if (tag.type === 'lora') {
                    const dotIndex = baseName.lastIndexOf('.');
                    if (dotIndex !== -1) baseName = baseName.substring(0, dotIndex);
                    if (tag.triggers && tag.triggers.length > 0) {
                        loraTriggersSuffix = ` [+${tag.triggers.length}]`;
                    }
                } else if (tag.type === 'embedding') {
                    baseName = baseName.replace(/^embedding:/, '');
                } else if (tag.type === 'group') {
                    const dotIndex = baseName.lastIndexOf('.');
                    if (dotIndex !== -1) baseName = baseName.substring(0, dotIndex);
                }

                if (tag.strength && parseFloat(tag.strength) !== 1.0) {
                    strengthStringToDraw = ` ${parseFloat(tag.strength).toFixed(2)}`;
                }

                const leftTextCombined = baseName + loraTriggersSuffix;
                
                const w = pillMaxWidth;
                const leftMargin = 34; // For toggle switch
                const rightPadding = 5;
                const gapBetweenTextParts = 5; // Gap if both left text and strength are present
                const dots = "...";
                const dotsWidth = ctx.measureText(dots).width;

                const contentWidthForLayout = w - leftMargin - rightPadding;
                
                let strengthPartWidth = 0;
                if (strengthStringToDraw) {
                    strengthPartWidth = ctx.measureText(strengthStringToDraw).width;
                }

                let availableWidthForLeft = contentWidthForLayout;
                if (strengthPartWidth > 0) {
                    availableWidthForLeft -= (strengthPartWidth + gapBetweenTextParts);
                }
                availableWidthForLeft = Math.max(0, availableWidthForLeft); // Ensure non-negative

                let finalLeftDisplay = leftTextCombined;
                if (ctx.measureText(leftTextCombined).width > availableWidthForLeft) {
                    if (availableWidthForLeft <= dotsWidth) { // Not enough space even for "..."
                        finalLeftDisplay = "";
                    } else {
                        let i = leftTextCombined.length;
                        while (i > 0 && ctx.measureText(leftTextCombined.slice(0, i)).width + dotsWidth > availableWidthForLeft) {
                            i--;
                        }
                        finalLeftDisplay = leftTextCombined.slice(0, i) + dots;
                    }
                }
                            
                if (currentX + w > pillX + pillMaxWidth) {
                    currentX = pillX;
                    currentY += 20 + spacing;
                }
            
                positions.push({
                    x: currentX, y: currentY, w, h: 20,
                    label: tag.name,
                    display: finalLeftDisplay, // This is the name + Lora triggers part
                    strengthDisplay: strengthStringToDraw, // Separate strength part
                    active: tag.active,
                    type: tag.type,
                    strength: tag.strength // Original strength for data
                });
                currentX += w + spacing;
            }

            const pillHeight = (currentY + 20 + pillPadding) - pillY;
            this._tagAreaBottom = pillY + pillHeight;

            this._pillMap = [];

            for (const p of positions) {
                ctx.beginPath();
                ctx.globalAlpha = p.active ? 1 : 0.75;
                let pillFill = LiteGraph.WIDGET_BGCOLOR;
                ctx.fillStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? pillFill : LiteGraph.WIDGET_BGCOLOR);
                ctx.roundRect(p.x, p.y, p.w, p.h, p.h / 2);
                ctx.fill();

                if (!p.button) {
                    ctx.strokeStyle = "#444";
                    ctx.lineWidth = 1;
                    ctx.stroke();

                    ctx.beginPath();
                    ctx.fillStyle = "#3b3b3b";
                    ctx.roundRect(p.x + 6, p.y + 5, 18, p.h - 10, 6);
                    ctx.fill();

                    ctx.beginPath();
                    let pillFill = "#8899bb";
                    if (p.type === 'lora') {
                        pillFill = "#89a189";
                    } else if (p.type === 'embedding') {
                        pillFill = "#9b8899  ";
                    } else if (p.type === 'group') {
                        pillFill = "#9b9188";
                    }
                    ctx.fillStyle = p.active ? pillFill : "#888";
                    const r = 7;
                    const cx = p.x + (p.active ? 18 - r + 8 : r + 4);
                    const cy = p.y + p.h / 2;
                    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
                    ctx.fill();
                }

                ctx.textBaseline = "middle";
                ctx.textAlign = p.button ? "center" : "left";
                ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
                const textX = p.x + (p.button ? p.w / 2 : 34); // Left starting X for main display text
                const textY = p.y + p.h / 2 + 1;
                
                // Draw the main display text (name + Lora triggers, possibly truncated)
                if (p.display) { // Check if display string is not empty after truncation
                    ctx.fillText(p.display, textX, textY);
                }

                // Draw strength value separately if it exists, right-aligned with opacity
                if (p.strengthDisplay) {
                    const strengthTextWidth = ctx.measureText(p.strengthDisplay).width;
                    const strengthX = p.x + p.w - pillPadding * 2 - strengthTextWidth; // pill right edge - pillPadding - its own width
                    
                    // Ensure strength text doesn't overlap with left text if left text is very short
                    // This check is tricky if p.display is truncated.
                    // A simpler rule: if strengthX would be less than textX + p.display width + gap, it might need adjustment.
                    // However, the availableWidthForLeft calculation should prevent overlap if truncation works.

                    ctx.globalAlpha = 0.5;
                    ctx.fillText(p.strengthDisplay, strengthX, textY);
                    ctx.globalAlpha = 1;
                }
                
                // Lora trigger count is now part of p.display, so separate drawing is removed.
                ctx.textBaseline = "alphabetic";

                this._pillMap.push({ x: p.x, y: p.y, w: p.w, h: p.h, label: p.label, button: p.button });
            }
            
            this._measuredHeight = pillY + pillHeight + 8;
            if (!this.isEditMode) {
                textWidget.computeSize = () => [0, pillHeight];
                this.setSize([this.size[0], this.size[1]]);
            }

        };
        
        const origResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function () {
            if (!this._measuredHeight) return;

            const lockedHeight = this._measuredHeight;
        
            if (!this.isEditMode && this.size[1] !== lockedHeight) {
                this.setSize([this.size[0], lockedHeight]);
                return; // to stop infinite resize loop
            }

            if (origResize) origResize.call(this);
            app.graph.setDirtyCanvas(true);
        };

    }
});
