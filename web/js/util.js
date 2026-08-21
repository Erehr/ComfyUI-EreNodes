import { app } from "../../../scripts/app.js";
import { parseTextToTagData, dedupeTags } from "./parser.js";

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
                } else if (type === "src") {
                    const blob = await response.blob();
                    if (!blob?.size) {
                        cache.set(cacheKey, notFound);
                        resolve(notFound);
                        return;
                    }
                    data = URL.createObjectURL(blob);
                } else {
                    throw new Error(`Unsupported cache type: ${type}`);
                }
                cache.set(cacheKey, data);
                resolve(data);
            } else if (response.status === 404) {
                // Resolve to the sentinel rather than rejecting, or a missing preview spams the console on every render.
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

export function updateCache(url, data, type = "json") {
    cache.set(`${type}:${url}`, data);
}

function drop(key) {
    const value = cache.get(key);
    cache.delete(key);
    if (typeof value === "string" && value.startsWith("blob:")) {
        try { URL.revokeObjectURL(value); } catch {}
    }
}

/** Forget one URL, in every content type. */
export function clearCache(url) {
    for (const key of [...cache.keys()]) {
        if (key.endsWith(`:${url}`)) drop(key);
    }
}

/** Forget every URL starting with a prefix — query strings included. */
export function clearCachePrefix(urlPrefix) {
    for (const key of [...cache.keys()]) {
        if (key.slice(key.indexOf(":") + 1).startsWith(urlPrefix)) drop(key);
    }
}

// Undo tracker

let suppressed = false;
let pendingWhileSuppressed = false;

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

/**
 * Wrap a continuous gesture (dragging the strength control) so it lands as one undo step instead of one per tick.
 * Discrete actions should not use this.
 */
export function beginUndoTransaction() {
    suppressed = true;
    pendingWhileSuppressed = false;
}

export function endUndoTransaction() {
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
//
// The server answers with segments in execution order, one per node in the prompt chain: EreNodes nodes contribute `tags`, everything else `text`.

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
 * @returns {boolean} true only when the file is *known* missing — an unchecked pill must not flash red on its way to being fine.
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

/**
 * Forget the verdicts for just these tags, so the next render re-checks them.
 * Used after an extraction: the pills are new to this session, and a verdict cached for the same name may predate the file being installed or removed.
 */
export function forgetVerdicts(tags) {
    for (const tag of tags || []) {
        if (isCheckable(tag)) verdicts.delete(keyFor(tag));
    }
}

/** Forget every verdict. */
export function clearMissingCache() {
    // An in-flight request is left to run — cancelling its timer would strand every `await scheduleFlush()`.
    // The generation bump voids its answers.
    generation++;
    verdicts.clear();
    queue.clear();
}
