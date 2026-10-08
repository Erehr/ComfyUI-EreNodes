# Tag pills

[EreNodes](../README.md) › Tag pills

![Select them, drag them, drop them](images/tag-pills-drag-light.webp#gh-light-mode-only)
![Select them, drag them, drop them](images/tag-pills-drag-dark.webp#gh-dark-mode-only)

Every prompt node, the sidebar previews and the Booru browser draw tags as the same pills, and they all follow the same rules.

## Pill types

| Type | Written to the prompt as |
|------|--------------------------|
| Tag | `blue hair`, or `(blue hair:1.2)` with a strength |
| Text | A whole sentence, for mixing natural language with tags |
| LoRA | `<lora:name:1.0>` |
| Embedding | `embedding:name` |
| Tag group | The group's current tags, read from its file. The pill stays one pill until unpacked. |

LoRA, embedding and tag group pills get a red border when the file they name is not on disk.

## Click, strength, quick edit

- **Click** a pill to toggle it. Disabled pills stay in the node but are not written to the prompt.
- **Right-click** for quick edit: rename the tag or pick another file, set the strength (with the − / + buttons, by dragging across the value, or with Left/Right; middle-click resets it to 1), see a LoRA's trigger words or a group's contents, set a preview image, **Unpack** a group into its tags, or **Remove** it.
- **Toggle rows** (Prompt Toggle, Prompt Lora Loader, Composer Toggle categories) carry the strength control on the row itself: click the arrows (− / + in Nodes 2.0) to step it, Shift+click for 0.1, drag across the value, middle-click to reset it to 1.

![Quick edit](images/tag-pills-quick-edit-light.webp#gh-light-mode-only)
![Quick edit](images/tag-pills-quick-edit-dark.webp#gh-dark-mode-only)

LoRA trigger words are listed in the LoRA's quick edit; the selected ones are written after the LoRA. The eye button on a node shows or hides its disabled tags.

## Drag and drop

- **Reorder**: hold a pill for a moment, or just start moving it. A placeholder shows where it lands.
- **Move between nodes**: drag pills into any other prompt node or Composer category.
- **Alt** while dropping: copy instead of move.
- **Shift** while dropping: replace the target's tags with the dropped ones. The target is highlighted red.
- Tags already present in the target are skipped.

![Shift replaces, Alt copies](images/tag-pills-modifiers-light.webp#gh-light-mode-only)
![Shift replaces, Alt copies](images/tag-pills-modifiers-dark.webp#gh-dark-mode-only)

- Pills can also be dropped into a Prompt Multiline textarea, or onto a sidebar folder to save them as a new tag group.
- The other way round works too: select text in a Prompt Multiline or Composer Multiline category and drag the selection out. It becomes tags on any prompt node, or text in another of those fields, and leaves its own field; hold **Alt** to copy it instead.

## Multi-select

- **Ctrl+click** picks individual pills.
- **Ctrl+drag** draws a selection box; sweeping over a selected pill again deselects it, as in Explorer.
- **Shift+click** selects a range.
- **Esc** or a click outside clears the selection.

A drag started on a selected pill carries the whole selection. Right-click a selected pill for **Strength**, which shifts every selected tag by the same amount and resets them all to 1 on a middle-click (tag groups have none), then **Enable**, **Disable**, **Toggle**, **Remove Selected**, **Save Selected as Tag Group** and **Export Selected (.json)**.

## Touch screens

Phones and tablets have no right button or Ctrl, so how long you hold stands in for them. The mouse works as described above.

| Gesture | What it does |
|---|---|
| Tap | Toggle the tag on or off |
| Hold (about half a second) | Select the pill and start selection mode |
| Keep holding (about a second) | Quick edit, or the bulk menu for a pill in a selection |
| Touch and move at once | Drag the pill |
| Hold, then move | Drag the pill; a pill that was already selected drags the whole selection |

In selection mode a tap adds or removes a pill, and a quick swipe draws a selection band, as Ctrl+drag does. Tap empty space in the tag area to leave selection mode. A second finger (ComfyUI's pinch and pan) cancels whatever the first one started.

Composer category headers and sidebar entries work the same way, without the menu: a hold selects, a move drags, and in selection mode a tap picks. In the sidebar a quick swipe scrolls the list instead of dragging.
