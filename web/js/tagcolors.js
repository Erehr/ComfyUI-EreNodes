// Single source of truth for tag type colours.
//
// Previously TYPE_FILL lived in renderer.js and TagEditContextMenu.createPill
// carried its own hardcoded copies, which had already drifted apart in case
// (#504C41 vs #504c41). Everything that paints a tag now imports from here.
//
// This module deliberately has no imports of its own: renderer.js imports
// dragdrop.js which imports contextmenu.js, and all three need these values.
// A leaf module keeps that graph acyclic.

/** Pill / tile background for an active tag, by type. */
export const TYPE_FILL = {
    lora: "#415041",       // dark green
    embedding: "#504149",  // dark purple
    group: "#504C41",      // dark amber
};
export const DEFAULT_FILL = "#414650";

/** Toggle-row knob colour for an active tag, by type. */
export const TOGGLE_KNOB = {
    lora: "#89a189",
    embedding: "#9b8899",
    group: "#9b9188",
};
export const TOGGLE_KNOB_DEFAULT = "#8899bb";

/**
 * Accent used for drag affordances (drop placeholder, ghost outline, drop
 * target ring, selection outline).
 *
 * These are *not* TYPE_FILL — those fills are near-black by design so pill text
 * stays readable, which makes them useless for a 1px dashed outline. This is a
 * brighter companion palette in the same hues.
 */
export const TYPE_ACCENT = {
    tag: "#4a9eff",        // blue   (plain csv tags — the original accent)
    lora: "#5fbf6a",       // green
    embedding: "#d2687f",  // red
    group: "#e0a53f",      // amber
    mixed: "#a97ee0",      // violet (selection spanning more than one type)
};
export const DEFAULT_ACCENT = TYPE_ACCENT.tag;

/**
 * Accent for a set of tags: the shared type's colour, or `mixed` when the set
 * spans several types. Empty/unknown sets fall back to the plain-tag accent.
 *
 * @param {Array<{type?: string}>} tags
 * @returns {string} hex colour
 */
export function accentForTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return DEFAULT_ACCENT;
    let seen = null;
    for (const tag of tags) {
        // Tags with no explicit type are plain csv tags.
        const type = tag?.type || "tag";
        if (seen === null) seen = type;
        else if (seen !== type) return TYPE_ACCENT.mixed;
    }
    return TYPE_ACCENT[seen] ?? DEFAULT_ACCENT;
}

/**
 * `#rrggbb` -> `r, g, b` so a single accent can drive both a solid border and a
 * translucent fill via `rgba(var(--ere-drag-accent-rgb), .14)`.
 *
 * @param {string} hex
 * @returns {string}
 */
export function hexToRgbTriplet(hex) {
    const m = /^#?([\da-f]{6})$/i.exec(String(hex).trim());
    if (!m) return "74, 158, 255";
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}
