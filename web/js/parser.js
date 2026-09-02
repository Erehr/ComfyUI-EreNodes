import { app } from "../../../scripts/app.js";

/** Tag data is stored as a JSON string on the node; anything else reads as empty. */
export const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

/**
 * Prose rather than a tag list: capitalised and ending in a terminator. Splitting a sentence on
 * its commas produces tags nobody wrote, so it becomes `text` tags instead.
 */
export const looksLikeProse = (text) => /^\p{Lu}/u.test(text) && /[.!?]$/.test(text);

/**
 * One sentence per entry. The boundary is a terminator followed by whitespace and a capital, so
 * `0.8 strength` and `e.g. this` are left alone — neither is followed by one.
 */
export const splitSentences = (text) =>
    text.split(/(?<=[.!?])\s+(?=\p{Lu})/u).map(s => s.trim()).filter(Boolean);

/** One prompt fragment -> a tag object, or null if it is empty. */
export function parseTag(tagString) {
    const original = (tagString || "").trim();
    if (!original) return null;

    const groupMatch = original.match(/^group:(.+)$/);
    if (groupMatch) return { name: groupMatch[1], type: "group", active: true };

    const loraMatch = original.match(/^<lora:([^:]+)(?::([\d.-]+))?>$/);
    if (loraMatch) {
        let strength = loraMatch[2] ? parseFloat(loraMatch[2]) : undefined;
        if (strength === 1.0 || isNaN(strength)) strength = undefined;
        return { name: loraMatch[1], type: "lora", strength, active: true };
    }

    let name = original;
    let strength;
    const strengthMatch = name.match(/^\((.*):([\d.-]+)\)$/);
    if (strengthMatch) {
        name = strengthMatch[1].trim();
        strength = parseFloat(strengthMatch[2]);
        if (isNaN(strength) || strength === 1.0) strength = undefined;
    }

    // A capitalised fragment ending in a terminator is a sentence, not a tag. The line-level split
    // catches prose written on its own line; this catches what a comma left behind
    // ("1girl, A quiet street at dusk.") and a weighted one, `(A quiet street.:1.20)`.
    if (looksLikeProse(name)) return { name, type: "text", strength, active: true };

    let type = "tag";
    if (name.startsWith("embedding:")) {
        type = "embedding";
        name = name.substring("embedding:".length);
    }
    return { name, type, strength, active: true };
}

/** A tag object -> the prompt fragment parseTag would read back. */
export function formatTag(tag) {
    if (tag.type === "lora") {
        const strength = tag.strength === undefined ? 1.0 : tag.strength;
        const strengthStr = strength % 1 === 0 ? strength.toFixed(1) : strength;
        return `<lora:${withExtension(tag)}:${strengthStr}>`;
    }
    if (tag.type === "embedding") return `embedding:${tag.name}`;
    if (tag.type === "group") return `group:${withExtension(tag)}`;
    if (tag.strength && tag.strength !== 1.0) return `(${tag.name}:${tag.strength})`;
    return tag.name;
}

const withExtension = tag => (tag.extension ? `${tag.name}${tag.extension}` : tag.name);

// A tag with no explicit `active` renders as active, so it counts as one here too.
const isActive = tag => tag.active !== false;

/** Dedupe by name, keeping the first position but letting an active entry win: a node further down the chain can switch a tag back on, and that is the state that ran. */
export function dedupeTags(tags) {
    const at = new Map();
    const out = [];
    for (const tag of tags || []) {
        if (!tag?.name) continue;
        const seen = at.get(tag.name);
        if (seen === undefined) {
            at.set(tag.name, out.length);
            out.push(tag);
        } else if (isActive(tag) && !isActive(out[seen])) {
            out[seen] = tag;
        }
    }
    return out;
}

/**
 * Split prompt text into tag objects, carrying over active states by name.
 * Lines first, and a line that reads as prose becomes `text` tags rather than being cut up on its
 * commas — which is what makes a sentence survive the trip out to prompt text and back.
 */
export function parseTextToTagData(text, oldTagData = []) {
    const oldTagsByName = new Map(oldTagData.map(t => [t.name, t]));
    const tagData = [];

    for (const line of (text || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const newTags = looksLikeProse(trimmed)
            ? splitSentences(trimmed).map(name => ({ name, type: "text", active: true }))
            : trimmed
                .split(/,(?![^()]*\))/g)
                .map(s => s.trim())
                .filter(Boolean)
                .map(parseTag)
                .filter(Boolean);

        for (const tag of newTags) {
            tag.active = oldTagsByName.get(tag.name)?.active ?? true;
        }
        tagData.push(...newTags);
    }

    // Nameless entries go too: a bare "embedding:" parses to an empty name.
    return dedupeTags(tagData);
}

// Punctuation a part can already end with, which the separator must then not repeat.
// Closing brackets are deliberately not in it: `(masterpiece:1.2)` does want a comma after it.
const TERMINATORS = ",.;:!?";

/**
 * The separator to put after `previous`, with its own leading punctuation dropped when that part
 * already ends in some: `",\n\n"` after a sentence would otherwise read `".,"`.
 * Mirrors `separator_after` in py/prompt.py.
 */
export function separatorAfter(separator, previous) {
    const last = previous.replace(/\s+$/, "").slice(-1);
    return last && TERMINATORS.includes(last)
        ? separator.replace(/^[,.;:!?]+/, "")
        : separator;
}

/** Join non-empty parts, never repeating punctuation the part before already ended with. */
export function joinParts(parts, separator) {
    let out = "";
    for (const part of parts) {
        if (!part) continue;
        if (out) out += separatorAfter(separator, out);
        out += part;
    }
    return out;
}

/**
 * The same, for a separator as stored (with "\n" escaped).
 * Mirrors `join_parts` in py/prompt.py, which is what actually runs at execution time; this keeps
 * the text shown on the node honest about it.
 */
export const joinPrompt = (parts, separator) =>
    joinParts(parts, String(separator ?? ",\\n\\n").replace(/\\n/g, "\n"));

/** Groups cannot nest, so drop any that made it into a list being saved. */
export function stripNestedGroups(tags, { warn = true } = {}) {
    const groups = tags.filter(tag => tag.type === "group");
    if (!groups.length) return tags;
    if (warn) {
        app.extensionManager?.toast?.add({
            severity: "warn",
            summary: "Nested tag groups not allowed.",
            detail: `${groups.length} tag group(s) skipped in saving.`,
            life: 6000,
        });
    }
    return tags.filter(tag => tag.type !== "group");
}

// Display

// A known list, not the last ".": a lora called "v1.5_style" showed as "v1".
const KNOWN_EXTENSIONS = /\.(json|safetensors|ckpt|lora|pt|bin|embedding)$/i;

/** Order two tags by name. Case-insensitive first, then case-sensitive, then type: a total order, so two tags differing only in case never swap places between renders. */
export function byTagName(a, b) {
    const x = (a?.name || ""), y = (b?.name || "");
    const lx = x.toLowerCase(), ly = y.toLowerCase();
    if (lx !== ly) return lx < ly ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
    return (a?.type || "").localeCompare(b?.type || "");
}

export function displayNameFor(tag, stripFolders) {
    let name = tag.name || "";
    if (tag.type === "lora" || tag.type === "group") {
        if (stripFolders) {
            name = name.substring(Math.max(name.lastIndexOf("\\"), name.lastIndexOf("/")) + 1);
        }
        name = name.replace(KNOWN_EXTENSIONS, "");
    } else if (tag.type === "embedding") {
        name = name.replace(/^embedding:/, "");
    }
    return name;
}

export function strengthText(tag) {
    if (tag.strength && Number(tag.strength) !== 1.0) return ` ${Number(tag.strength).toFixed(2)}`;
    return "";
}
