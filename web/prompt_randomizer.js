import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { initializeSharedPromptFunctions } from "./prompt.js";

app.registerExtension({
    name: "ErePromptRandomizer",

    setup() {
        api.addEventListener("status", ({ detail }) => {
            if (detail?.exec_info?.queue_remaining === 0) {
                setTimeout(() => {
                    const graph = app.graph;
                    if (!graph?._nodes) return;
    
                    for (const node of graph._nodes) {
                        if (node.type === "ErePromptRandomizer") {
                            const controlWidget = node.widgets?.find(w => w.name === "control after generate");
                            if (controlWidget) {
                                const mode = controlWidget.value;
                                if (mode === "randomize") {
                                    node.onRandomize?.();
                                } else if (mode === "increment") {
                                    node.onIncrement?.();
                                } else if (mode === "decrement") {
                                    node.onDecrement?.();
                                }
                            }
                        }
                    }
                }, 10);
            }
        });
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptRandomizer") return;
        
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

            const textWidget = node.widgets?.find(w => w.name === "text");
            if (!textWidget) return;
            textWidget.computeSize = () => [0, 0];
            textWidget.hidden = true;

            // Randomize control
            const controlWidget = node.addWidget("combo", "control after generate", "fixed", "control_after_generate", { values: ["fixed", "increment", "decrement", "randomize"] });
            // Save button
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
                    // Open dropdown on background click tag selection
                    } else {

                        const tagData = parseTags(node.properties._tagDataJSON || textWidget.value);
                        const inactive = tagData.filter(t => !t.active && t.name);
        
                        const dropdownOptions = inactive.map(tag => ({
                            content: tag.name,
                            callback: () => {
                                const entry = tagData.find(t => t.name === tag.name);
                                if (entry) entry.active = true;
                                node.properties._tagDataJSON = JSON.stringify(tagData, null, 2);
                                const separator = (node.properties._tagSeparator !== "") ? node.properties._tagSeparator : ", ";
                                textWidget.value = tagData.filter(t => t.active).map(t => t.name).join(separator);
                                app.graph.setDirtyCanvas(true);
                            }
                        }));
        
                        if (dropdownOptions.length > 0) {
                            new LiteGraph.ContextMenu(dropdownOptions, { event: e, className: "dark" }, window);
                        }  

                    }

                }
                
            };
            
            // Initialize all other functions shared between prompt nodes
            initializeSharedPromptFunctions(this, textWidget, saveButton);

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
            const controlWidget = this.widgets?.find(w => w.name === "control after generate");
 
            
            if (!textWidget || this.isEditMode || this.flags?.collapsed) return;

            const tagData = parseTags(this.properties._tagDataJSON || textWidget.value);

            ctx.font = "12px monospace";
            const pillX = 10, pillY = 26, spacing = 5, pillPadding = 5;
            const pillMaxWidth = this.size[0] - pillX * 2;
            let currentX = pillX + pillPadding;
            let currentY = pillY + pillPadding;

            const positions = [];
            const specialTags = [
                { label: "button_menu", display: "≡" },
                { label: "button_add_tag", display: "+" },
                { label: "button_randomize", display: "🎲︎" },
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

            // Creating pills
            for (const tag of tagData) {
                if (tag.type === "separator") {
                    currentX = pillX + pillPadding;
                    currentY += 20 + 10 + 4;
                    continue; 
                }
                if (!tag.active) continue; // we don't render inactive tags

                let label = tag.name;
                let displayName = tag.name;
                if (tag.type === 'lora') {
                    // displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1);
                    const dotIndex = displayName.lastIndexOf('.');
                    if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
                } else if (tag.type === 'embedding') {
                    displayName = displayName.replace(/^embedding:/, '');
                }
                
                let strengthText = "";
                if (tag.strength && tag.strength !== 1.0) {
                    strengthText = ` ${tag.strength}`;
                }

                let display = displayName;
                let textWidth = ctx.measureText(display).width + ctx.measureText(strengthText).width;
            
                // Trim and append ellipsis if too wide
                if (textWidth > pillMaxWidth - pillPadding * 2) {
                    let i = display.length;
                    const dots = "...";
                    const dotsWidth = ctx.measureText("...").width;
                    while (i > 0 && ctx.measureText(display.slice(0, i)).width + dotsWidth + ctx.measureText(strengthText).width > pillMaxWidth - dotsWidth / 2 - pillPadding * 2 ) i--;
                    display = display.slice(0, i) + dots;
                }

                // calculate pill width
                const w = Math.min(ctx.measureText(display).width + ctx.measureText(strengthText).width + 12, pillMaxWidth - pillPadding * 2);
            
                if (currentX + w > pillX + pillMaxWidth - pillPadding) {
                    currentX = pillX + pillPadding;
                    currentY += 20 + spacing;
                }
            
                positions.push({ x: currentX, y: currentY, w, h: 20, label, display, active: !tag.active, type: tag.type, strength: tag.strength });
                currentX += w + spacing;
            }

            const pillHeight = (currentY + 20 + pillPadding) - pillY;
            this._tagAreaBottom = pillY + pillHeight;

            this._pillMap = [];

            // Draw background around pills
            ctx.beginPath();
            ctx.fillStyle = LiteGraph.WIDGET_BGCOLOR;
            ctx.strokeStyle = "#444";
            ctx.lineWidth = 1;
            ctx.roundRect(pillX, pillY, pillMaxWidth, pillHeight, 6);
            ctx.fill();
            ctx.stroke();

            // Drawing pills
            for (const p of positions) {
                ctx.beginPath();
                let pillFill = "#414650"; // Default
                if (p.type === 'lora') {
                    pillFill = "#415041"; // Muted green-cyan
                } else if (p.type === 'embedding') {
                    pillFill = "#504149 "; // Muted yellow
                }
                ctx.fillStyle = p.button ? LiteGraph.WIDGET_OUTLINE_COLOR  : pillFill;
                ctx.roundRect(p.x, p.y, p.w, p.h, 6);
                ctx.fill();

                ctx.strokeStyle = p.button ? LiteGraph.WIDGET_OUTLINE_COLOR  : pillFill;
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.textBaseline = "middle";
                ctx.textAlign = p.button ? "center" : "left";
                ctx.fillStyle = (p.active || p.button ? LiteGraph.WIDGET_TEXT_COLOR : "#FFF");

                const textX = p.x + (p.button ? p.w / 2 : 6);
                const textY = p.y + p.h / 2 + 1;
                ctx.fillText(p.display, textX, textY);

                if (p.strength && p.strength !== 1.0) {
                    const nameWidth = ctx.measureText(p.display).width;
                    const strengthText = ` ${p.strength}`;
                    ctx.globalAlpha = 0.5;
                    ctx.fillText(strengthText, textX + nameWidth, textY);
                    ctx.globalAlpha = 1;
                }

                ctx.textBaseline = "alphabetic";

                this._pillMap.push({ x: p.x, y: p.y, w: p.w, h: p.h, label: p.label, button: p.button });
            }
            
            this._measuredHeight = pillY + pillHeight + 8 + 25; // janky solution for locking resize height
            // height correction
            if (!this.isEditMode) {
                textWidget.computeSize = () => [0, pillHeight];
                this.setSize([this.size[0], this.size[1]]);
            } else {
                controlWidget.hidden = true;
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

            // todo:
            // calculate max height by each input height + each widget height

            if (origResize) origResize.call(this);
            app.graph.setDirtyCanvas(true);
        };

    }
});
