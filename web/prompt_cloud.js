import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";

app.registerExtension({
    name: "ErePromptCloud",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptCloud") return;

        // Shared layout constants
        const pillX = 10, 
              pillY = 30,
              pillH = 20,
              radius = 5,
              spacing = 5, 
              padding = 5;

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

            const textWidget = node.widgets?.find(w => w.name === "text");
            textWidget.computeSize = () => [0, 0];
            textWidget.hidden = true;

            node.onMouseDown = (e, pos) => {

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

                    // Handle normal toggle click and quick edit shift click
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

        const origDraw = nodeType.prototype.onDrawForeground;
        nodeType.prototype.onDrawForeground = function (ctx) {
            if (origDraw) origDraw.call(this, ctx);

            const textWidget = this.widgets?.find(w => w.name === "text");
            if (!textWidget || this.flags?.collapsed) return;
            
            const tagData = parseTags(this.properties?._tagDataJSON || "[]");

            ctx.font = "12px monospace";

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
                if (currentX + pillH > pillX + pillMaxWidth - padding) {
                    currentX = pillX + padding;
                    currentY += pillH + spacing;
                }
                positions.push({ x: currentX, y: currentY, w: 20, h: 20, label, display, button: true });
                currentX += pillH + spacing;
            }

            // Creating pills
            for (const tag of tagData) {

                let label = tag.name;
                let displayName = tag.name;
                if (tag.type === 'lora') {
                    // displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1); // remove folders from name
                    const dotIndex = displayName.lastIndexOf('.');
                    if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
                    if (tag.triggers && tag.triggers.length > 0) {
                        displayName += ` [+${tag.triggers.length}]`;
                    }
                } else if (tag.type === 'embedding') {
                    displayName = displayName.replace(/^embedding:/, '');
                } else if (tag.type === 'group') {
                    // displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1); // remove folders from name
                    const dotIndex = displayName.lastIndexOf('.');
                    if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
                }

                let strengthText = "";
                if (tag.strength && tag.strength !== 1.0) {
                    tag.strength = tag.strength.toFixed(2);
                    strengthText = ` ${tag.strength}`;
                }

                let display = displayName;
                let strengthWidth = ctx.measureText(strengthText).width;
                let textWidth = ctx.measureText(display).width + strengthWidth;
            
                // Trim and append ellipsis if too wide
                let maxTextWidth = pillMaxWidth - padding * 2;
                if (textWidth > pillMaxWidth - padding * 2) {
                    let i = display.length;
                    const dots = "…";
                    const dotsWidth = ctx.measureText("…").width;
                    while (i > 0 && ctx.measureText(display.slice(0, i)).width + dotsWidth + strengthWidth > maxTextWidth ) i--;
                    display = display.slice(0, i) + dots;
                }

                // calculate pill width
                const pillW = Math.min(textWidth + padding * 2, pillMaxWidth);
            
                if (currentX + pillW > pillX + pillMaxWidth) {
                    currentX = pillX;
                    currentY += pillH + spacing;
                }
            
                positions.push({ x: currentX, y: currentY, w: pillW, h: pillH, label, display, active: !tag.active, type: tag.type, strength: tag.strength });
                currentX += pillW + spacing;
            }

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
                } else if (p.type === 'group') {
                    pillFill = "#504C41"; // Muted orange/brown
                }
                ctx.fillStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? LiteGraph.WIDGET_BGCOLOR : pillFill);
                ctx.roundRect(p.x, p.y, p.w, p.h, 6);
                ctx.fill();
            
                ctx.strokeStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? "#444" : pillFill);
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.textBaseline = "middle";
                const textX = p.x + (p.button ? p.w / 2 : padding);
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
            
            this._tagAreaBottom = currentY + pillH + padding;
            this._measuredHeight = currentY + pillH + pillX;

            // Height correction
            if (isFinite(this._measuredHeight) && this._measuredHeight && this.size[1] !== this._measuredHeight) {
                this.setSize([this.size[0], this._measuredHeight]);
				this.setDirtyCanvas(true, true);
            }

        };
        
        const origResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function () {
            if (!this._measuredHeight) return;
        
            if (this.size[1] !== this._measuredHeight) {
                this.setSize([this.size[0], this._measuredHeight]);
                return;
            }
        };

    }
});
