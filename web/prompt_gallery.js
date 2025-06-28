import { app } from "../../scripts/app.js";
import { initializeSharedPromptFunctions, applyContextMenuPatch } from "./prompt.js";
import { getCache } from "./js/cache.js";

app.registerExtension({
    name: "ErePromptGallery",

    async setup() {
        applyContextMenuPatch();
    },

    beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ErePromptGallery") return;

        // Shared layout constants
        let pillX = 10, 
              pillY = 30,
              pillW = 100, 
              pillH = 100,
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

            // create properties defaults
            if (node.properties._tagImageWidth === null || node.properties._tagImageWidth === undefined) {
                node.properties._tagImageWidth = pillW; // Default value
            }
            if (node.properties._tagImageHeight === null || node.properties._tagImageHeight === undefined) {
                node.properties._tagImageHeight = pillH; // Default value
            }



            node.onMouseDown = (e, pos) => {

                const [x, y] = pos;

                // Get background area
                const bgX = pillX, bgY = pillY;
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
            
            if (!this._pillImageCache) this._pillImageCache = new Map();
            const tagData = parseTags(this.properties?._tagDataJSON || "[]");

            // Custom size
            const newPillW = this.properties?._tagImageWidth ?? pillW;
            const newPillH = this.properties?._tagImageHeight ?? pillH;
            if (this._cachedPillW !== newPillW || this._cachedPillH !== newPillH) {
                this._pillImageCache.clear();
                this._cachedPillW = newPillW;
                this._cachedPillH = newPillH;
            }
            pillW = newPillW;
            pillH = newPillH;

            ctx.font = "12px monospace";

            const pillMaxWidth = this.size[0] - pillX * 2;
            let currentX = pillX;
            let currentY = pillY;

            const positions = [];
            const specialTags = [
                { label: "button_menu", display: "≡" },
                { label: "button_add_tag", display: "+" } // this button tag need to show at end after all tag pills
            ];
    
            // Creating buttons (fixed 20x20)
            for (const { display, label } of specialTags) {
                positions.push({ x: currentX, y: currentY, w: 20, h: 20, label, display, button: true });
                currentX += 20 + spacing;
            }

            currentX = pillX;
            currentY += 20 + padding;

            for (const tag of tagData) {

                let label = tag.name;
                let displayName = tag.name;
                if (tag.type === 'lora') {
                    displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1); // remove folders from name
                    const dotIndex = displayName.lastIndexOf('.');
                    if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
                } else if (tag.type === 'embedding') {
                    displayName = displayName.replace(/^embedding:/, '');
                } else if (tag.type === 'group') {
                    displayName = displayName.substring(Math.max(displayName.lastIndexOf('\\'), displayName.lastIndexOf('/')) + 1); // remove folders from name
                    const dotIndex = displayName.lastIndexOf('.');
                    if (dotIndex !== -1) displayName = displayName.substring(0, dotIndex);
                }

                let display = displayName;
                let textWidth = ctx.measureText(display).width;
            
                // Trim and append ellipsis if too wide
                let maxTextWidth = pillW - padding * 2;
                if (textWidth > maxTextWidth) {
                    let i = display.length;
                    const dots = "…";
                    const dotsWidth = ctx.measureText("…").width;
                    while (i > 0 && ctx.measureText(display.slice(0, i)).width + dotsWidth > maxTextWidth ) i--;
                    display = display.slice(0, i) + dots;
                }

                // Prepare info pill data
                let infoPillText = "";
                if (tag.triggers && tag.triggers.length > 0) {
                    infoPillText += `[+${tag.triggers.length}]`;
                }
                if (tag.strength && tag.strength !== 1.0) {
                    if (infoPillText) infoPillText += " ";
                    infoPillText += tag.strength.toFixed(2);
                }

                // calculate pill width
                if (currentX + pillW > pillX + pillMaxWidth) {
                    currentX = pillX;
                    currentY += pillH + spacing;
                }
                positions.push({ x: currentX, y: currentY, w: pillW, h: pillH, label, display, active: !tag.active, type: tag.type, strength: tag.strength, infoPillText, triggers: tag.triggers });
                currentX += pillW + spacing;
            }


 
            // Store pill positions for click handling
            this._pillMap = [];

            // Check if all images are cached (either exist or not)
            const imagesToLoad = [];
            for (const p of positions) {
                if (p.type === 'lora' || p.type === 'group' || p.type === 'embedding') {
                    const imageUrl = `/erenodes/view/${p.type}/${p.label}`;
                    p.imageUrl = imageUrl; // Store for later drawing

                    // Only load if not cached yet (undefined), skip if cached (including notFound)
                    const cached = getCache(imageUrl, 'bitmap');
                    if (cached === undefined) { 
                        imagesToLoad.push(imageUrl);
                    }
                }
            }

            // Force node reload after new images are cached
            if (imagesToLoad.length > 0) {
                // Use a flag to prevent multiple concurrent loads
                if (!this._imagesLoading) {
                    this._imagesLoading = true;
                    // Since getCache now returns synchronous values, we can directly proceed
                    const cachedUrls = imagesToLoad.map(imageUrl => getCache(imageUrl, 'bitmap')).filter(url => url);
                    if (cachedUrls.length > 0) {
                        this.setDirtyCanvas(true, true);
                    }
                    this._imagesLoading = false;
                }
            }
 
            for (const p of positions) {
 
                // pill background and image (cached)
                ctx.beginPath();
                ctx.fillStyle = "#222";
                ctx.roundRect(p.x, p.y, p.w, p.h, radius);
                ctx.fill();

                // inactive filter
                ctx.filter = p.button ? "" : (p.active ? "grayscale(0.75)" : "grayscale(0)");
                ctx.globalAlpha = p.button ? 1 : (p.active ? 0.25 : 1);

                // cache offscreen canvas
                let cachedCanvas = p.imageUrl ? this._pillImageCache.get(p.label) : null;
                if (p.imageUrl && !cachedCanvas) {
                    const TagImage = getCache(p.imageUrl, 'bitmap');
                    if (TagImage && TagImage instanceof ImageBitmap) {
                        const scale = window.devicePixelRatio || 2;
                        cachedCanvas = document.createElement('canvas');
                        cachedCanvas.width = p.w * scale;
                        cachedCanvas.height = p.h * scale;
                        const pillCtx = cachedCanvas.getContext('2d');
                        pillCtx.scale(scale, scale);

                        pillCtx.fillStyle = "#222";
                        pillCtx.beginPath();
                        pillCtx.roundRect(0, 0, p.w, p.h, radius);
                        pillCtx.fill();

                        pillCtx.save();
                        pillCtx.beginPath();
                        pillCtx.roundRect(0, 0, p.w, p.h, radius);
                        pillCtx.clip();

                        const imgAspectRatio = TagImage.width / TagImage.height;
                        const areaAspectRatio = p.w / p.h;
                        let sx = 0, sy = 0, sWidth = TagImage.width, sHeight = TagImage.height;
                        if (imgAspectRatio > areaAspectRatio) {
                            sWidth = TagImage.height * areaAspectRatio;
                            sx = (TagImage.width - sWidth) / 2;
                        } else {
                            sHeight = TagImage.width / areaAspectRatio;
                            sy = (TagImage.height - sHeight) / 2;
                        }
                        pillCtx.drawImage(TagImage, sx, sy, sWidth, sHeight, 0, 0, p.w, p.h);
                        pillCtx.restore();

                        this._pillImageCache.set(p.label, cachedCanvas);
                    }
                }

                // draw cached canvas
                if (cachedCanvas) {
                    ctx.drawImage(cachedCanvas, p.x, p.y, p.w, p.h);
                }

                // reset filter
                ctx.globalAlpha = 1.0;
                ctx.filter = "none";
 
                // pill border
                ctx.beginPath();
                ctx.roundRect(p.x, p.y, p.w, p.h, radius);
                ctx.strokeStyle = "#444";
                ctx.lineWidth = 1;
                ctx.stroke();

                // ** and added border around both background and image

                // ** and now actuall name pill, lowered by pillH - 20 and with height 20
                // ** this part other than position and size remains direct copy from cloud
                ctx.beginPath();
                ctx.globalAlpha = p.button ? 1 : (p.active ? 0.5 : 1);
                let pillFill = "#414650"; // Default
                if (p.type === 'lora') {
                    pillFill = "#415041"; // Muted green-cyan
                } else if (p.type === 'embedding') {
                    pillFill = "#504149 "; // Muted yellow
                } else if (p.type === 'group') {
                    pillFill = "#504C41"; // Muted orange/brown
                }
                ctx.fillStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? LiteGraph.WIDGET_BGCOLOR : pillFill);
                // ctx.roundRect(p.x, p.y, p.w, p.h, 6); 
                ctx.roundRect(p.x, (p.y + p.h - 20), p.w, 20, (p.button ? radius : [0, 0, radius, radius]));
                ctx.fill();
            
                ctx.strokeStyle = p.button ? LiteGraph.NODE_DEFAULT_BOXCOLOR : (p.active ? "#444" : pillFill);
                ctx.lineWidth = 1;
                ctx.stroke();

                ctx.textBaseline = "middle";
                const textX = p.x + (p.button ? p.w / 2 : padding);
                const textY = p.y + p.h - 20 + (20 / 2 + 1);
                
                if(p.button) {
                    ctx.textAlign = "center";
                    ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
                    ctx.fillText(p.display, textX, textY);
                } else {
                    ctx.textAlign = "left";
                    ctx.fillStyle = (p.active ? LiteGraph.WIDGET_TEXT_COLOR : "#FFF");
                    ctx.fillText(p.display, textX, textY);
                }

                // Draw info pill in upper right corner if there's info to show
                if (!p.button && p.infoPillText) {
                    ctx.font = "10px monospace";
                    const infoPillWidth = ctx.measureText(p.infoPillText).width + 5;
                    const infoPillX = p.x + p.w - infoPillWidth - 2.5;
                    const infoPillY = p.y + 2.5;
                    
                    ctx.globalAlpha = p.button ? 1 : (p.active ? 0.5 : 0.75);
                    // Draw info pill background
                    ctx.fillStyle = "#222";
                    ctx.beginPath();
                    ctx.roundRect(infoPillX, infoPillY, infoPillWidth, 15, radius);
                    ctx.fill();
                    
                    // Draw info pill text
                    ctx.fillStyle = "#FFF";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText(p.infoPillText, infoPillX + infoPillWidth / 2, infoPillY + 15 / 2 + 1);
                }

                ctx.globalAlpha = 1;
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
            if (this._pillImageCache) this._pillImageCache.clear();

            // Allow horizontal resizing only, snap to valid widths for 1 to N pills per row (N = total pills/tags, not including special buttons)
            let tagData = JSON.parse(this.properties?._tagDataJSON || "[]");
            // Custom size
            pillW = this.properties?._tagImageWidth ?? pillW;
            pillH = this.properties?._tagImageHeight ?? pillH;

            let totalPills = tagData?.length || 0;
            if (totalPills === 0) totalPills = 1;
            // Allow resizing up to a reasonable max columns (e.g., 12)
            const maxColumns = 12;
            let snapPoints = [];
            // for (let n = 1; n <= totalPills; n++) {
            for (let n = 1; n <= Math.max(totalPills, maxColumns); n++) {
                snapPoints.push(pillX * 2 + n * pillW + (n - 1) * spacing);
            }

            // Clamp width to max allowed (all pills/tags in one row)
            // let width = this.size[0];
            // const maxAllowedWidth = snapPoints[snapPoints.length - 1];
            // if (width > maxAllowedWidth) width = maxAllowedWidth;
        
            // Find the closest snap point

            let snappedWidth = snapPoints[0];
            for (let i = 0; i < snapPoints.length; i++) {
                if (this.size[0] < snapPoints[i]) {
                    // Snap to previous if closer, else to this one
                    if (i > 0 && Math.abs(this.size[0] - snapPoints[i-1]) < Math.abs(this.size[0] - snapPoints[i])) {
                        snappedWidth = snapPoints[i-1];
                    } else {
                        snappedWidth = snapPoints[i];
                    }
                    break;
                }
                snappedWidth = snapPoints[i];
            }
            // Always set height to measured height (no vertical resizing)
            const measuredHeight = this._measuredHeight || this.size[1];
            // Prevent infinite resize loop: round values before comparing
            const newWidth = Math.round(snappedWidth);
            const newHeight = Math.round(measuredHeight);
            if (this.size[0] !== newWidth || this.size[1] !== newHeight) {
                this.setSize([newWidth, newHeight]);
                return;
            }
            if (origResize) origResize.call(this);
            app.graph.setDirtyCanvas(true);
        };
        
        const origRemove = nodeType.prototype.onRemove;
        nodeType.prototype.onRemove = function () {
            if (this._pillImageCache) this._pillImageCache.clear();
        };

    }
});
