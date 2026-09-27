# Changelog

[EreNodes](../README.md) › Changelog

### Version 3.8
- **Booru browser**: a sidebar tab searching Safebooru, Gelbooru and e621. Hover a post for its tags, click a tag to search for it, drag tags onto a node, or save them as a tag group. See [Booru browser](booru.md).

### Version 3.7
- **New Node: Prompt Lora Loader**: applies LoRAs to MODEL/CLIP with the familiar pill interface, from its own list and from the incoming prompt. No other pack needed.
- **Anima block remap**: LoRAs trained on older Anima generations are remapped for newer models automatically.
- **Autocomplete**: category filters (`artist:`, `char:`, `@` and more), category colours, `lora:` / `embedding:` / `group:` inline, alias display options, used-tag handling in every textarea.
- **Shift-drop replaces** the target's tags instead of adding to them.

### Version 3.6
- **Per-category layouts in the Composer**: each category draws as Cloud, Toggle, MultiSelect, Gallery or Multiline, from its ≡ menu → Layout
- **Drop tags into a prompt textarea**: pills and tag groups can be dragged into the Prompt Multiline node and Composer multiline category
- **New `text` tag type**: a pill holding a whole sentence, so tags and natural language prompts can mix in one node
- **Separators on the node**: tag and node separators are now editable from node ≡ → Options

### Version 3.5
- **New Node: Prompt Composer**: several tag clouds in one node as reorderable, collapsible categories

### Version 3.4
- **Sidebar tag search**: an alternative search mode, backed by a tag index built in the background
- **Autocomplete on the sidebar search box** (tag mode only): only from tags actually in your tag groups
- **Prompt Randomizer**: added seed control

### Version 3.3
- **Tag group editor** in the sidebar
- **Drop an image on the sidebar**: extracts its prompt and keeps the image as the group's cover
- **Prompt Extractor node**: image drop area prompt extraction
- **Missing file warnings**: red border on LoRA / embedding / tag group pills whose file isn't on disk

### Version 3.2
- **EreNodes sidebar**: native sidebar for managing tag groups, LoRAs and embeddings
- **Search inside tag groups**: sidebar filter matching file names and the tags a group contains
- **Configurable tag group folder**: node folder or `ComfyUI/models/tag_groups`
- **Type-coloured drag feedback**: ghost and target highlight during tag drag

### Version 3.1
- **Drag and drop reorder**: press-and-hold (or move) a tag pill to reorder it, with a live drop placeholder and drag preview
- **Drag between nodes**: move pills across any pill-based prompt nodes; **Alt** while dropping copies instead of moving, duplicate names are skipped
- **Multi-select**: **Ctrl+click** toggles individual pills, **Ctrl+drag** draws a selection box, **Shift+click** selects a range, **Esc** or a click outside clears it. A drag started on a selected pill carries the whole set
- **Selection actions**: right-clicking a selected pill opens bulk Enable / Disable / Toggle / Remove, plus Save Selected as Tag Group and Export Selected

### Version 3.0
- **Nodes 2.0 ready**: tag UI rendered as DOM widgets in both classic and Vue renderers
- **Subgraph support**: prefix separator is a real (hidden) input
- **Gallery performance**: previews are plain `<img>` elements with browser caching and lazy loading
- **Randomizer**: "control after generate" triggers once per completed prompt, including queued batches
- **Many bug fixes**: global autocomplete attachment, overwrite-confirm dialog, settings sync, stale text on workflow load, safer file-serving routes, gallery previews for filenames with special characters, button tooltips

### Version 2.1
- **New Node: Prompt Gallery**: grid-based gallery for browsing and selecting tags
- **Tag group image on save**: set a preview image when saving a tag group
- **Change image in quick edit**
- **Performance**: caching for previews, trigger words and tag group content

### Version 2.0
- **Major refactor**: rebuilt autocomplete and quick edit

### Version 1.4
- Folder browser for LoRAs, embeddings and tag groups

### Version 1.3
- LoRA and embedding support in autocomplete

### Version 1.2
- Randomizer node and autocomplete

### Version 1.1
- Published to the ComfyUI Registry and Manager
