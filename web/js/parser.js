import { app } from "../../../scripts/app.js";

/** Tag data is stored as a JSON string on the node; anything else reads as empty. */
export const parseTags = value => {
    try {
        const parsed = JSON.parse(value || "[]");
        if (Array.isArray(parsed)) return parsed;
    } catch {}
    return [];
};

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

/**
 * Dedupe by name, keeping the first position but letting an active entry win.
 * A node further down the chain can switch a tag back on, and that is the state that ran, so the later active copy replaces the earlier inactive one rather than being discarded.
 */
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

/** Split prompt text into tag objects, carrying over active states by name. */
export function parseTextToTagData(text, oldTagData = []) {
    const oldTagsByName = new Map(oldTagData.map(t => [t.name, t]));
    const tagData = [];

    for (const line of (text || "").split("\n")) {
        const newTags = line.trim()
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

// Only these are stripped from a display name.
// Cutting at the last "." truncated any name that merely contained one, so a lora called "v1.5_style" showed "v1".
const KNOWN_EXTENSIONS = /\.(json|safetensors|ckpt|lora|pt|bin|embedding)$/i;

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
