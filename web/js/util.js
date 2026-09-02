import { app } from "../../../scripts/app.js";
import { parseTextToTagData, dedupeTags, formatTag, joinParts, separatorAfter } from "./parser.js";

// Fetch Cache

const cache = new Map();
const notFound = Symbol("notFound");   // 404 / 204 / empty body

/** True when getCache resolved to "there is no such content". */
export function isNotFound(value) {
    return value === notFound;
}

/** Fetch a URL once. Returns cached data directly, or a Promise while in flight. */
export function getCache(url, type = "json") {
    const cacheKey = `${type}:${url}`;
    const cached = cache.get(cacheKey);

    if (cached === notFound) return notFound;
    if (cached instanceof Promise) return cached;
    if (cached !== undefined) return cached;

    const promise = new Promise(async (resolve, reject) => {
        try {
            const response = await fetch(url);
            if (response.status === 204) {
                cache.set(cacheKey, notFound);
                resolve(notFound);
                return;
            }
            if (response.ok) {
                let data;
                if (type === "json") {
                    const text = await response.text();
                    data = text ? JSON.parse(text) : null;
                } else {
                    throw new Error(`Unsupported cache type: ${type}`);
                }
                cache.set(cacheKey, data);
                resolve(data);
            } else if (response.status === 404) {
                // Resolve to the sentinel rather than reject: a missing preview would spam the console on every render.
                cache.set(cacheKey, notFound);
                resolve(notFound);
            } else {
                cache.delete(cacheKey);
                reject(new Error(`Failed to fetch content: ${response.status} ${response.statusText}`));
            }
        } catch (error) {
            cache.delete(cacheKey);
            reject(error);
        }
    });

    cache.set(cacheKey, promise);
    return promise;
}

/** Forget one URL, in every content type. */
export function clearCache(url) {
    for (const key of [...cache.keys()]) {
        if (key.endsWith(`:${url}`)) cache.delete(key);
    }
}

// Undo tracker

let suppressed = false;
let pendingWhileSuppressed = false;
let depth = 0;

function getTracker() {
    return app.extensionManager?.workflow?.activeWorkflow?.changeTracker
        ?? app.workflowManager?.activeWorkflow?.changeTracker;
}

/** Record an undo checkpoint now (no-op while a transaction is open). */
export function captureUndoState() {
    if (suppressed) {
        pendingWhileSuppressed = true;
        return;
    }
    const tracker = getTracker();
    // captureCanvasState is current; checkState is the older name.
    (tracker?.captureCanvasState ?? tracker?.checkState)?.call(tracker);
}

/** Wrap a continuous gesture (dragging the strength control) so it lands as one undo step. Discrete actions should not. */
export function beginUndoTransaction() {
    // Counted: a drop opens one and the node update it triggers opens another, and the inner end must not flush the outer gesture halfway through.
    if (depth++ === 0) {
        suppressed = true;
        pendingWhileSuppressed = false;
    }
}

export function endUndoTransaction() {
    if (depth > 0) depth--;
    if (depth > 0) return;
    suppressed = false;
    if (pendingWhileSuppressed) {
        pendingWhileSuppressed = false;
        captureUndoState();
    }
}

// Styles

/** Load one of web/css/*.css, once. */
export function loadStyle(name) {
    const id = `erenodes-css-${name}`;
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = new URL(`../css/${name}.css`, import.meta.url).href;
    document.head.appendChild(link);
}

// Extraction
// Segments come in execution order, one per node in the chain: ours contribute `tags`, everything else `text`.

export const ACCEPTED_IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".webp"];

export const isAcceptedImage = (file) =>
    !!file && ACCEPTED_IMAGE_TYPES.some(ext => (file.name || "").toLowerCase().endsWith(ext));

/**
 * Turn an extraction response into a flat tag list, in prompt order and deduped.
 * @param {Array} existing so a re-extract keeps what the user toggled off.
 */
export function tagsFromResult(result, existing = []) {
    const segments = Array.isArray(result?.segments) ? result.segments : [];

    const collected = [];
    for (const segment of segments) {
        if (Array.isArray(segment.tags) && segment.tags.length) {
            // Normalised to the shape parseTextToTagData produces: stored tag data omits `type` for plain tags.
            collected.push(...segment.tags.map(t => ({ active: true, type: "tag", ...t })));
        } else if (segment.text) {
            collected.push(...parseTextToTagData(segment.text, existing));
        }
    }

    return dedupeTags(collected);
}

/** How many nodes the prompt was spread across (for user-facing messages). */
export const segmentCount = (result) =>
    Array.isArray(result?.segments) ? result.segments.length : 0;

/** Upload an image and read its prompt metadata. */
export async function extractFromImage(file) {
    const form = new FormData();
    form.append("image", file, file.name);
    const response = await fetch("/erenodes/extract_prompt", { method: "POST", body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
    return result;
}

/** Re-read an image already sitting in ComfyUI's input directory. */
export async function reExtractByFilename(filename) {
    const response = await fetch(
        `/erenodes/extract_prompt?filename=${encodeURIComponent(filename)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
    return result;
}


// Check for missing files

const CHECKABLE = new Set(["lora", "embedding", "group"]);

/** key -> true (on disk) | false (missing) */
const verdicts = new Map();
/** key -> {name, type, extension}, waiting to be sent */
const queue = new Map();
let flushTimer = 0;
let flushPromise = null;
// Bumped by clearMissingCache, so an in-flight request's answers are discarded.
let generation = 0;

export const isCheckable = (tag) => !!tag && CHECKABLE.has(tag.type) && !!tag.name;

const keyFor = (tag) => `${tag.type}:${tag.name}`;

/**
 * @returns {boolean} true only when the file is *known* missing: an unchecked pill must not flash red on its way to being fine.
 */
export function isKnownMissing(tag) {
    if (!isCheckable(tag)) return false;
    return verdicts.get(keyFor(tag)) === false;
}

/**
 * Make sure every checkable tag has a verdict.
 * @returns {Promise<boolean>} true when something new was learned (re-render).
 */
export async function ensureChecked(tags) {
    const wanted = [];
    for (const tag of tags || []) {
        if (!isCheckable(tag)) continue;
        const key = keyFor(tag);
        if (verdicts.has(key)) continue;
        wanted.push(key);
        if (!queue.has(key)) {
            queue.set(key, { name: tag.name, type: tag.type, extension: tag.extension || "" });
        }
    }
    if (!wanted.length) return false;

    await scheduleFlush();
    // Only ask for a re-render if an answer actually arrived and it is "missing".
    // A batch where everything exists changes nothing on screen.
    return wanted.some(key => verdicts.get(key) === false);
}

/** Coalesce every request made in the same tick into one round trip. */
function scheduleFlush() {
    if (flushPromise) return flushPromise;
    flushPromise = new Promise((resolve) => {
        flushTimer = setTimeout(async () => {
            flushTimer = 0;
            const items = [...queue.values()];
            const era = generation;
            queue.clear();
            flushPromise = null;
            if (items.length) await request(items, era);
            resolve();
        }, 0);
    });
    return flushPromise;
}

async function request(items, era) {
    const stale = () => era !== generation;
    try {
        const response = await fetch("/erenodes/check_files", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error || `HTTP ${response.status}`);
        if (stale()) return;
        for (const [key, exists] of Object.entries(result.exists || {})) {
            verdicts.set(key, !!exists);
        }
        /** Anything the server did not answer for (a type it rejected, say) is recorded as present: an unanswered pill must not be accused. */
        for (const item of items) {
            const key = `${item.type}:${item.name}`;
            if (!verdicts.has(key)) verdicts.set(key, true);
        }
    } catch (e) {
        console.warn("[EreNodes] Could not check for missing files.", e);
        // Treat the whole batch as fine rather than painting the graph red because one request failed.
        // It will be retried after a refresh.
        if (stale()) return;
        for (const item of items) verdicts.set(`${item.type}:${item.name}`, true);
    }
}

/** Forget these verdicts, so the next render re-checks. Used after an extraction, where a verdict cached for the same name may predate the file. */
export function forgetVerdicts(tags) {
    for (const tag of tags || []) {
        if (isCheckable(tag)) verdicts.delete(keyFor(tag));
    }
}

/** Forget every verdict. */
export function clearMissingCache() {
    // An in-flight request is left to run: cancelling strands every `await scheduleFlush()`.
    // The generation bump voids its answers.
    generation++;
    verdicts.clear();
    queue.clear();
}

// Caret Geometry

/**
 * The character index nearest a point in a textarea.
 * `document.caretRangeFromPoint` does not answer this for a textarea — it hands back the control
 * itself, or a node inside its shadow — so this binary-searches the caret positions the mirror
 * below already measures. Positions run in reading order, which is what makes the search valid.
 * It rounds up: any boundary left of the point counts as before it, so a pointer inside a
 * character lands after it rather than at the nearer side. Half a character, and callers snap
 * the result to a word gap anyway; testing the midpoint would double the measurements.
 * ponytail: ~8 mirror builds per call, so callers throttle it; cache the mirror if it ever drags.
 */
export function caretIndexFromPoint(element, x, y) {
    const value = element?.value ?? "";
    let lo = 0;
    let hi = value.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const caret = getElementOrCursorCoords(element, mid);
        // Before the point when its line ends above it, or it sits to the left on the same line.
        const before = y > caret.bottom || (y >= caret.y && x > caret.x);
        if (before) lo = mid + 1;
        else hi = mid;
    }
    // Past the end of a line, every position on it is "before", so the search stops at the first
    // position of the *next* line. Step back, or pointing to the right of a line would insert at
    // the start of the one below it.
    if (lo > 0 && y < getElementOrCursorCoords(element, lo).y) lo--;
    return lo;
}

// Screen coordinates of the caret, or of the element itself when it is not a textarea.
export function getElementOrCursorCoords(element, position) {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
        return { x: 0, y: 0, right: 0, bottom: 0 };
    }

    const rect = element.getBoundingClientRect();

    if (element.tagName !== 'TEXTAREA') {
        return { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom };
    }

    const scaleX = element.offsetWidth > 0 ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;

    const style = getComputedStyle(element);

    // Helper to get line-height in px, handling "normal" and unitless values.
    const getLineHeightPx = () => {
        const lineHeight = style.lineHeight;
        if (lineHeight === 'normal') {
            const temp = document.createElement('div');
            temp.innerHTML = '&nbsp;';
            Object.assign(temp.style, {
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                position: 'absolute',
                visibility: 'hidden'
            });
            document.body.appendChild(temp);
            const height = temp.offsetHeight;
            document.body.removeChild(temp);
            return height;
        }
        const numericLineHeight = parseFloat(lineHeight);
        // If the parsed number is the same as the string, it's unitless.
        if (String(numericLineHeight) === lineHeight) {
            return numericLineHeight * parseFloat(style.fontSize);
        }
        return numericLineHeight;
    };
    const finalLineHeight = getLineHeightPx();

    const text = element.value;
    const selectionEnd = position ?? element.selectionEnd;
    const before = text.substring(0, selectionEnd);

    // Create a hidden "mirror" div to calculate the cursor's position.
    const dummy = document.createElement("div");

    [
        'font', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
        'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform',
        'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
        'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
        'boxSizing', 'whiteSpace', 'wordWrap', 'wordBreak'
    ].forEach(prop => dummy.style[prop] = style[prop]);

    dummy.style.position = "absolute";
    dummy.style.visibility = "hidden";
    dummy.style.left = "-9999px";
    dummy.style.top = "-9999px";
    dummy.style.width = `${element.clientWidth}px`;
    dummy.style.height = 'auto';
    
    // Use a unique ID for the marker span to avoid conflicts.
    const markerId = `cursor-marker-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
    dummy.innerHTML = before.replace(/\n/g, '<br />') + `<span id="${markerId}"></span>`;

    document.body.appendChild(dummy);

    const cursorMarker = dummy.querySelector(`#${markerId}`);
    
    const internalX = cursorMarker.offsetLeft;
    const internalY = cursorMarker.offsetTop;
    // The marker's offsetHeight is the line's rendered height inside the mirror.
    const internalLineHeight = cursorMarker.offsetHeight || finalLineHeight;

    document.body.removeChild(dummy);

    const cursorX = rect.left + (internalX * scaleX) - (element.scrollLeft * scaleX);
    const cursorY = rect.top + (internalY * scaleY) - (element.scrollTop * scaleY);
    const cursorBottom = cursorY + (internalLineHeight * scaleY);

    return {
        x: cursorX,
        y: cursorY,
        right: cursorX, 
        bottom: cursorBottom,
        lineHeight: internalLineHeight * scaleY
    };
}

// Tag Text

/** A node's own prompt textarea: the native `text` widget's, which we never rebuild. */
export function textareaOf(node) {
    const widget = node?.widgets?.find(w => w.name === "text");
    const host = widget?.inputEl ?? widget?.element;
    if (!host) return null;
    return host.tagName === "TEXTAREA" ? host : (host.querySelector?.("textarea") ?? null);
}

/**
 * Put tags into a textarea as the prompt they emit, at `at` (default: the caret).
 * The one path for it, so a drop and the "+" menu insert identically.
 * A separator is added only on a side that has real content and does not already end in one.
 */
export async function insertTagsAsText(el, tags, tagSeparator, at = null) {
    if (!el || !tags?.length) return false;
    const text = await tagsToText(tags, tagSeparator);
    if (!text) return false;

    const separator = (tagSeparator || ", ").replace(/\\n/g, "\n");
    const index = Math.max(0, Math.min(at ?? el.selectionStart ?? el.value.length, el.value.length));
    const before = el.value.slice(0, index);
    const after = el.value.slice(index);
    // separatorAfter for the same reason the joins use it: after "a sentence." the separator's
    // own comma is not wanted.
    const lead = before.trim() && !/[\s,]$/.test(before) ? separatorAfter(separator, before) : "";
    const trail = after.trim() && !/^[\s,]/.test(after) ? separator : "";

    el.setRangeText(lead + text + trail, index, index, "end");
    // The widget (or the Composer row) stores its value off this event, exactly as typing does.
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
}

/**
 * The prompt a tag list emits: active tags only, groups expanded from disk, lora triggers
 * appended, strengths formatted, joined with the tag separator.
 * @param {string} [tagSeparator]  as stored ("\n" escaped), defaults to ", "
 */
export async function tagsToText(tagData, tagSeparator) {
    if (tagData.length === 0) return "";
    const activeTags = tagData.filter(t => (t.active && t.name));

    tagSeparator = (tagSeparator || ", ").replace(/\\n/g, "\n");

    // Content only: joinParts puts the separators between them, and leaves out the one a part
    // already ends with. Interleaving them by hand is what produced ".," after a sentence.
    // A `text` tag is a *block*: it goes on its own line, which is what lets parseTextToTagData
    // recognise it as prose when this text is read back (converting, pasting, extracting).
    const segments = [];
    let line = [];
    const flush = () => {
        if (line.length) segments.push({ text: joinParts(line, tagSeparator) });
        line = [];
    };

    for (const tag of activeTags) {
        if (tag.type === 'text') {
            flush();
            segments.push({ text: formatTag(tag), block: true });
            continue;
        }
        if (tag.type !== 'group') {
            line.push(formatTag(tag));
            if (tag.type === 'lora' && tag.triggers?.length > 0) line.push(...tag.triggers);
            continue;
        }
        // A group expands to its contents, in place.
        flush();
        try {
            const filename = tag.extension ? `${tag.name}${tag.extension}` : tag.name;
            const result = getCache(
                `/erenodes/get_tag_group?filename=${encodeURIComponent(filename)}`, 'json');
            const groupTagData = result instanceof Promise ? await result : result;
            if (!Array.isArray(groupTagData)) continue;

            const groupParts = [];
            for (const gTag of groupTagData.filter(t => t.active && t.name)) {
                groupParts.push(formatTag(gTag));
                if (gTag.type === 'lora' && gTag.triggers?.length > 0) groupParts.push(...gTag.triggers);
            }
            if (!groupParts.length) continue;

            let groupPart = joinParts(groupParts, tagSeparator);
            const strength = parseFloat(tag.strength);
            if (strength && !isNaN(strength) && strength !== 1.0) {
                groupPart = `(${groupPart}:${strength.toFixed(2)})`;
            }
            segments.push({ text: groupPart });
        } catch (error) {
            console.error(`[EreNodes] Failed to load and parse tag group: ${tag.name}`, error);
        }
    }
    flush();

    // Everything is joined with the tag separator, except a boundary touching a text block, which
    // ends the line instead: the separator's trailing space becomes the newline that keeps the
    // sentence recognisable on the way back.
    let out = "";
    let previousBlock = false;
    for (const segment of segments) {
        if (!segment.text) continue;
        if (out) {
            out += (segment.block || previousBlock)
                ? separatorAfter(tagSeparator.replace(/\s+$/, ""), out) + "\n"
                : separatorAfter(tagSeparator, out);
        }
        out += segment.text;
        previousBlock = !!segment.block;
    }
    return out;
}
