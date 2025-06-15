import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions } from "./prompt.js";

app.registerExtension({
    name: "ErePromptCloud",

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptCloud") return;

        const parseTags = value => {
            try {
                const parsed = JSON.parse(value || "[]");
                if (Array.isArray(parsed)) return parsed;
            } catch {}
            return [];
        };

        const origCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            if (origCreated) origCreated.apply(this, arguments);

            const node = this;
            node._isInitialized = false;
            node.isEditMode = false;
            node.properties = node.properties || {};

            // Text widget
            const textWidget = node.widgets?.find(w => w.name === "text");
            if (!textWidget) return;
            textWidget.computeSize = () => [0, 0];
            textWidget.hidden = true;

            // Button widget (save)
            const saveButton = node.addWidget("button", "Save", "edit_text", () => {});
            saveButton.hidden = true;

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
                        if (e.shiftKey) {
                            node.onTagQuickEdit(e, pos, clickedPill);
                        } else {    
                            node.onTagPillClick(e, pos, clickedPill);
                        }
                    } 

                }

            };

            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget);

            // Defer the update based on _tagDataJSON, as it might not be immediately available
            // when onNodeCreated is called during graph load.
            setTimeout(() => {
                if (this.properties && this.properties._tagDataJSON) {
                    if (this.onUpdateTextWidget) {
                        // console.log('update text widget node side');
                        this.onUpdateTextWidget(this);
                    }
                }
                this._isInitialized = true; // Set flag to true after all initial setup
            }, 0);
        };

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
                { label: "button_add_tag", display: "+" } // this button tag need to show at end after all tag pills
            ];
    
            // Creating buttons
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
                    currentX = pillX;
                    currentY += 20 + 10 + 4;
                    continue;
                }
            
                let label = tag.name;
                let displayName = tag.name;
                if (tag.type === 'lora') {
                    // displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1);
                    const dotIndex = displayName.lastIndexOf('.');
                    if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
                } else if (tag.type === 'embedding') {
                    displayName = displayName.replace(/^embedding:/, '');
                }
                let nameForMeasuring = displayName;
                let strengthText = "";
                if (tag.strength && (tag.strength !== 1.0 || tag.strength !== "1.00" )) {
                    strengthText = ` ${tag.strength}`;
                }
                
                const pillMaxWidth = this.size[0] - pillX * 2;
                const strengthWidth = ctx.measureText(strengthText).width;
                const dots = "...";
                const dotsWidth = ctx.measureText(dots).width;

                if (ctx.measureText(nameForMeasuring).width + strengthWidth > pillMaxWidth - pillPadding * 2) {
                    let i = nameForMeasuring.length;
                    while (i > 0 && ctx.measureText(nameForMeasuring.slice(0, i)).width + dotsWidth + strengthWidth > pillMaxWidth - pillPadding * 2) {
                        i--;
                    }
                    nameForMeasuring = nameForMeasuring.slice(0, i) + dots;
                }
            
                const w = Math.min(ctx.measureText(nameForMeasuring).width + strengthWidth + 12, pillMaxWidth);
            
                if (currentX + w > pillX + pillMaxWidth) {
                    currentX = pillX;
                    currentY += 20 + spacing;
                }
            
                positions.push({ x: currentX, y: currentY, w, h: 20, label, display: nameForMeasuring, active: !tag.active, strength: tag.strength, type: tag.type });
                currentX += w + spacing;
            }

            const pillHeight = (currentY + 20 + pillPadding) - pillY;
            this._tagAreaBottom = pillY + pillHeight;

            // Store pill positions for click handling
            this._pillMap = [];

            for (const p of positions) {
                ctx.beginPath();
                ctx.globalAlpha = p.button ? 1 : (p.active ? 0.75 : 1);

                let pillFill = "#414650"; // Default
                if (p.type === 'lora') {
                    pillFill = "#415041"; // Muted green-cyan
                } else if (p.type === 'embedding') {
                    pillFill = "#504149 "; // Muted yellow
                }
                ctx.fillStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? LiteGraph.WIDGET_BGCOLOR : pillFill);
                ctx.roundRect(p.x, p.y, p.w, p.h, 6);
                ctx.fill();
            
                ctx.strokeStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? "#444" : pillFill);
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.textBaseline = "middle";
                const textX = p.x + (p.button ? p.w / 2 : 6);
                const textY = p.y + p.h / 2 + 1;
                
                if(p.button) {
                    ctx.textAlign = "center";
                    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
                    ctx.fillText(p.display, textX, textY);
                } else {
                    ctx.textAlign = "left";
                    ctx.fillStyle = (p.active ? LiteGraph.WIDGET_TEXT_COLOR : "#FFF");
                    ctx.fillText(p.display, textX, textY);

                    if (p.strength && p.strength !== 1.0) {
                        const nameWidth = ctx.measureText(p.display).width;
                        const strengthText = ` ${p.strength}`;
                        ctx.globalAlpha = 0.5;
                        ctx.fillText(strengthText, textX + nameWidth, textY);
                        ctx.globalAlpha = 1;
                    }
                }

                ctx.textBaseline = "alphabetic";
            
                this._pillMap.push({ x: p.x, y: p.y, w: p.w, h: p.h, label: p.label, button: p.button });
            }
            
            this._measuredHeight = pillY + pillHeight + 8;
            // height correction
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
                return;
            }
        
            if (origResize) origResize.call(this);
            app.graph.setDirtyCanvas(true);
        };

    }
});
