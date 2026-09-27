<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/banner-dark.webp"><img src="docs/images/banner-light.webp" alt="EreNodes"></picture>

**Tag-based prompting for ComfyUI.** Build prompts from pills you can toggle, drag and reuse, with a built-in prompt library, tag autocomplete, a booru browser and a prompt-aware LoRA loader.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![ComfyUI](https://img.shields.io/badge/ComfyUI-Compatible-brightgreen)](https://github.com/comfyanonymous/ComfyUI) [![Ko-fi](https://img.shields.io/badge/Ko--fi-tip-F16061?style=flat-square&logo=ko-fi&logoColor=white)](https://ko-fi.com/erehr)

[Features](#features) • [Installation](#installation) • [Settings](docs/settings.md) • [Changelog](docs/changelog.md)

</div>

## Features

### [Prompt nodes](docs/prompt-nodes.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/prompt-nodes-dark.webp"><img src="docs/images/prompt-nodes-light.webp" alt="Prompt nodes" width="100%"></picture>

Cloud, Toggle, MultiSelect, Gallery, Randomizer and Multiline: one tag list, drawn the way you want it. Convert between them any time; chain them through `prefix`.

### [Prompt Composer](docs/prompt-composer.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/prompt-composer-dark.webp"><img src="docs/images/prompt-composer-light.webp" alt="Prompt Composer" width="100%"></picture>

*One Node to rule them all.* Character, outfit, background and quality as collapsible, bypassable categories in a single node, each with its own layout.

### [Tag pills](docs/tag-pills.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tag-pills-drag-dark.webp"><img src="docs/images/tag-pills-drag-light.webp" alt="Select, drag, drop" width="100%"></picture>

Select them, drag them, drop them. Reorder, move or copy between nodes, replace with Shift, multi-select with Ctrl. Tags, text, LoRAs, embeddings and tag groups all as the same pills.

### [Tag groups](docs/tag-groups.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/tag-groups-dark.webp"><img src="docs/images/tag-groups-light.webp" alt="Tag groups" width="100%"></picture>

Save them, reuse them. Characters, styles and presets as files with cover images, used as one pill or unpacked into tags.

### [Autocomplete](docs/autocomplete.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/autocomplete-dark.webp"><img src="docs/images/autocomplete-light.webp" alt="Autocomplete" width="100%"></picture>

Danbooru and e621 tags in every textarea, with aliases, category filters (`artist:`, `char:`, `@`) and colours, plus `lora:`, `embedding:` and `group:` with previews.

### [Sidebar](docs/sidebar.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/sidebar-dark.webp"><img src="docs/images/sidebar-light.webp" alt="Sidebar" width="100%"></picture>

Your tag groups, LoRAs and embeddings in a native sidebar tab. Hover for tags, drag onto nodes, search the tags inside every group, bookmark the ones you use daily.

### [Booru browser](docs/booru.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/booru-dark.webp"><img src="docs/images/booru-light.webp" alt="Booru browser" width="100%"></picture>

Search Safebooru, Gelbooru or e621 from the sidebar. Hover a post for its tags, click one to search it, drag them into your prompt or save them as a tag group.

### [LoRA loading](docs/lora-loading.md)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/lora-loader-dark.webp"><img src="docs/images/lora-loader-light.webp" alt="Prompt Lora Loader" width="100%"></picture>

The Prompt Lora Loader applies its own LoRAs and every `<lora:...>` in the incoming prompt, keeps the selected trigger words, and remaps older Anima LoRAs automatically.

### [Prompt Extractor](docs/prompt-nodes.md#prompt-extractor)
<picture><source media="(prefers-color-scheme: dark)" srcset="docs/images/prompt-extractor-dark.webp"><img src="docs/images/prompt-extractor-light.webp" alt="Prompt Extractor" width="100%"></picture>

Drop a generated image, get its positive prompt back as pills, including tags that were switched off.

## Nodes

| Node | |
|------|---|
| Prompt Cloud, Toggle, MultiSelect, Gallery | [Tag lists in four layouts](docs/prompt-nodes.md) |
| Prompt Randomizer | [Seeded choice of which tags are on](docs/prompt-nodes.md#prompt-randomizer) |
| Prompt Multiline | [Textarea with autocomplete and tag drop](docs/prompt-nodes.md#prompt-multiline) |
| Prompt Composer | [Categories in one node](docs/prompt-composer.md) |
| Prompt Extractor | [Prompt from an image](docs/prompt-nodes.md#prompt-extractor) |
| Prompt Lora Loader | [LoRAs from pills and prompt](docs/lora-loading.md#prompt-lora-loader) |
| Prompt to LoRA Stack | [`LORA_STACK` for other loaders](docs/lora-loading.md) |
| Prompt Filter | [Keep only known tags](docs/prompt-nodes.md#prompt-filter) |

All nodes work in the classic canvas and in Nodes 2.0, and inside subgraphs.

## Installation

**ComfyUI Manager:** search for "EreNodes", install, restart ComfyUI.

**Manual:**

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/erehr/ComfyUI-EreNodes.git
```

Then restart ComfyUI. The sidebar tab appears in the left bar, and all options are under Settings → EreNodes ([reference](docs/settings.md)).

## Contributing

Contributions are welcome. [Report a bug](https://github.com/erehr/ComfyUI-EreNodes/issues), [request a feature](https://github.com/erehr/ComfyUI-EreNodes/issues) or join the [discussions](https://github.com/erehr/ComfyUI-EreNodes/discussions).

## Acknowledgments

- **ComfyUI community**, for feedback and support
- **[ComfyUI-PromptPalette](https://github.com/kambara/ComfyUI-PromptPalette)**: initial inspiration and foundational code
- **[ComfyUI-EZ-AF-Nodes](https://github.com/ez-af/ComfyUI-EZ-AF-Nodes)**: Prompt Gallery inspiration
- **[DraconicDragon](https://github.com/DraconicDragon)**: tag lists and data
- **[ToxesFoxes](https://github.com/ToxesFoxes)**: scrollable tag area
- **[shin131002](https://github.com/shin131002/ComfyUI-Anima-Remap)**: Anima LoRA remapper

Licensed under the [MIT License](LICENSE).