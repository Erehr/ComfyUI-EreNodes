# 🎨 ComfyUI-EreNodes

> A powerful collection of custom nodes for ComfyUI that improve prompt management and organization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![ComfyUI](https://img.shields.io/badge/ComfyUI-Compatible-brightgreen)](https://github.com/comfyanonymous/ComfyUI)

ComfyUI-EreNodes provides an intuitive and feature-rich solution for handling prompts in your ComfyUI workflows. These nodes are designed to work seamlessly together, offering everything from intelligent autocomplete to visual tag management.

![Image](https://github.com/user-attachments/assets/7701cdb9-cef2-4dc4-8a3b-ed0dc5f164b6)

## 📚 Table of Contents

- [Available Nodes](#-available-nodes)
- [Key Features](#-key-features)
- [Compatibility](#-compatibility)
- [Installation](#-installation)
- [Getting Started](#-getting-started)
- [Changelog](#-changelog)
- [Contributing](#-contributing)
- [License](#-license)
- [Acknowledgments](#-acknowledgments)

## 🧩 Available Nodes

| Node | Description | Key Features |
|------|-------------|-------------|
| **Prompt Gallery** | Grid-based visual browser for LoRAs, Embeddings and Tag Groups | Image previews, intuitive selection |
| **Prompt Cloud** | Interactive tag cloud visualization | Dynamic sizing, click-to-select |
| **Prompt Toggle** | Simple toggleable tag list | Easy enable/disable, clean interface |
| **Prompt MultiSelect** | Multi-selection field for tags | Bulk selection, organized lists |
| **Prompt Randomizer** | Randomize your prompt tags | Manual randomization button, Control after generate |
| **Prompt Multiline** | Enhanced text input with EreNodes features | Full autocomplete, tag management |
| **Prompt Filter** | CSV-based prompt validation | Tag filtering, validation |
| **Prompt to Lora Stack** | Extracts and converts loras from prompt into  lora_stack

## ✨ Key Features

### 👁️ Visual Previews
- **Node Integration**: Direct image previews on Prompt Gallery node
- **Quick Edit Previews**: Preview support in editing interfaces
- **Selection Previews**: Visual feedback during file selection
- **Custom Previews**: Easy custom preview image assignment

### 📁 Tag Groups Management
- **Favorite Prompts**: Save and organize your most-used prompts with tags, LoRAs, and trigger words
- **Direct Node Integration**: Create tag groups directly from nodes with subfolder organization
- **Quick Application**: Easy loading of saved tag groups as convenient pills or their content
- **Import/Export**: Seamless sharing and backup of your tag collections
- **Choose Where They Live**: Keep tag groups in the node folder, or in `ComfyUI/models/tag_groups` so they survive reinstalls and Manager updates — switching offers to copy your existing groups across

### 🗂️ EreNodes Sidebar
- **Native Sidebar Tab**: Browse tag groups, LoRAs and embeddings in a proper ComfyUI sidebar tab
- **Search That Reads Inside**: Filter tag groups by filename *and* by the tags they actually contain
- **Hover Previews**: Hover any entry to see its thumbnail and its tags, drawn with the exact same pills the nodes use
- **Click to Add**: Click a tag group to drop a prefilled prompt node onto the canvas (node type is configurable)
- **Drag Both Ways**: Drag an entry onto an existing node to append its tags — or drag a node's tag pills onto a sidebar folder to save them as a new tag group
- **Multi-Select**: Ctrl+click, Shift+click or rubber-band drag over entries, exactly like tag pills in a node — then drag them all into a node at once, or right-click for bulk actions
- **Pick Tags Out of a Preview**: Hover a tag group, move into the preview, select tags you want and drag just those into a prompt node

### ✏️ Advanced Tag Editing
- **Effortless Replacement**: Quick edit tags or replacement of LoRAs, embeddings and Tag Groups
- **Strength Control**: Precise tag strength adjustment via buttons or intuitive click-dragging
- **Rich Previews**: Set and view preview images for all content types
- **Dynamic Triggers**: Toggle LoRA trigger words with familiar tag pill interface

![Image](https://github.com/user-attachments/assets/ef65357f-88cd-4cfd-bf5d-0b9e0a7a0c78)

### 🖐️ Drag & Drop Tag Pills
- **Reorder by Dragging**: Hold a pill for a moment (or just start moving it) to enter reorder mode — a live placeholder shows exactly where it will land
- **Move Between Nodes**: Drag pills from one prompt node into another; hold **Alt** while dropping to copy instead of move
- **Multi-Select**: **Ctrl+click** picks individual pills (they don't need to be next to each other), **Ctrl+drag** sweep a selected pill again to drop it, just like Explorer — and **Shift+click** selects a range
- **Bulk Actions**: Right-click any pill in a selection for Enable / Disable / Toggle / Remove, or save and export just those tags as a group
- **Works Everywhere**: Cloud, Toggle, MultiSelect, Randomizer and Gallery nodes all share the same behaviour

### 🔍 Smart Autocomplete
- **Comprehensive Dictionaries**: Built-in tag lists from Danbooru and e621, plus support for custom CSV files in the `__autocomplete__` folder
- **Intelligent Aliases**: Automatic tag alias detection and replacement with canonical terms
- **Flexible Search**: Partial matching support, including multi-word tag recognition
- **Visual Highlighting**: Clear highlighting of filtered terms for enhanced clarity

![Image](https://github.com/user-attachments/assets/42deb9e3-73fa-4891-9ec5-cfbd497f9d9e)

## 🧭 Compatibility

- **ComfyUI**: registered via standard `NODE_CLASS_MAPPINGS` (works on current and older installs). Node IDs are stable — workflows remain interchangeable.
- **Subgraphs**: supported. The prefix separator is passed as a real input instead of being read from workflow metadata.
- **Nodes 2.0 (Vue renderer)**: supported. Tag UI is DOM widgets in both the classic LiteGraph renderer and Nodes 2.0 (same implementation). The old canvas-drawn UI was removed; it remains available in git history.

## 📦 Installation

### Quick Install (Recommended)

**Via ComfyUI Manager:**
1. Open ComfyUI Manager in your ComfyUI interface
2. Search for "EreNodes" 
3. Click Install
4. Restart ComfyUI

### Manual Installation

```bash
# Navigate to your ComfyUI custom_nodes directory
cd /path/to/ComfyUI/custom_nodes

# Clone the repository
git clone https://github.com/erehr/ComfyUI-EreNodes.git

# Restart ComfyUI
```

> **Tip**: After installation, you'll find the new nodes under the "EreNodes" category in your ComfyUI node browser.

## 🚀 Getting Started

### Quick Setup

1. **Custom Autocomplete**: Place your custom CSV tag files in the `__autocomplete__` folder within the EreNodes directory or choose existing one from Settings
2. **Preview Images**: Add preview images to enhance your tag browsing experience
3. **Create Your First Tag Group**: Use any EreNodes prompt node to save your favorite tag combinations

### 🎮 Basic Usage

**Using Autocomplete:**
- Start typing in any EreNodes text or add tag field
- Use Tab or arrow keys to navigate suggestions
- Press Enter to select
- Enjoy intelligent tag completion with aliases

**Managing Tag Groups:**
- Click on any tag nodes ≡ menu button to "Save as Tag Group". Select (or create) folder, type filename and select optional image. 
- Access saved groups through the ≡ 'Load Tag Group' (loading content of tag group) or + button 'Add tag' (loading tag group as single combined pill)
- Import/export tag groups for sharing with the community

**LoRA Loading:**

EreNodes provides flexible LoRA loading options to fit different workflow preferences:

| Method | Description | Compatible Nodes | Use Case |
|--------|-------------|------------------|----------|
| **LoRA Stack** | Use "Prompt to LoRA Stack" node to extract `<lora:name:strength>` tags and connect to stack-compatible nodes | • [Efficiency Nodes](https://github.com/jags111/efficiency-nodes-comfyui)<br>• [ComfyRoll Custom Nodes](https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes)<br>• [LoRA Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) | Best for mixing multiple sources of LoRAs |
| **Direct Loading** | Use nodes that load LoRAs directly from prompt text in place of standard LoRA loaders. | • [LoRA Tag Loader](https://github.com/badjeff/comfyui_lora_tag_loader)<br>• [Impact Wildcard Encode](https://github.com/ltdrdata/ComfyUI-Impact-Pack)<br>• [PCLazyLoRALoader](https://github.com/asagi4/comfyui-prompt-control) | Best for simple workflows or when using wildcards |

### 💡 Pro Tips

- **Search Efficiently**: Use partial matches or space for multi word phrases
- **Visual Organization**: Set preview images for your most-used ta groups
- **Quick Edits**: Right-click any tag for instant editing options
- **Rearrange Fast**: Drag pills to reorder them, or straight into another prompt node — Ctrl+click first to move several at once
- **Experiment**: Use the Randomizer node to discover new prompt combinations
- **Convertible**: All tag nodes can be converted to another under ≡ menu
- **Customize output**: Separators between nodes and individual tags can be set customized in node Properties

## 📋 Changelog

### Version 3.2 - Latest
- **EreNodes sidebar**: alternative way to manage tag groups in native sidebar tab with three sub-tabs (tag groups / LoRAs / embeddings), an accordion folder tree, live search, hover previews, click-to-add, and bi-directional drag & drop to and from prompt nodes
- **Search inside tag groups**: the sidebar filter matches file names *and* the tags a group contains
- **Configurable tag group folder**: keep them in the node folder (default, unchanged) or in `ComfyUI/models/tag_groups`, which survives reinstalls and Manager updates. Switching offers to copy existing groups — nothing is ever deleted. Advanced users can redirect it further with `tag_groups:` in `extra_model_paths.yaml`
- **Type-coloured drag feedback**: the drop placeholder, drag ghost and target highlight now take the colour of what you're dragging — blue tags, green LoRAs, red embeddings, amber groups, violet for a mixed selection

### Version 3.1
- **Drag & drop reorder**: press-and-hold (or move) a tag pill to reorder it, with a live drop placeholder and drag preview
- **Drag between nodes**: move pills across any pill-based prompt nodes; **Alt** while dropping copies instead of moving, duplicate names are skipped
- **Multi-select**: **Ctrl+click** toggles individual pills, **Ctrl+drag** rubber-bands a box over them (Explorer-style — re-sweeping a selected pill deselects it), **Shift+click** selects a range, **Esc** or a click outside clears it — a drag started on a selected pill carries the whole set
- **Selection actions**: right-clicking a selected pill opens bulk Enable / Disable / Toggle / Remove, plus "Save Selected as Tag Group" and "Export Selected"
- **Quick edit cleanup**: Move Up / Move Down were dropped from the right-click menu now that pills can simply be dragged

### Version 3.0
- **Nodes 2.0 ready**: tag UI rendered as DOM widgets in both classic and Vue renderers
- **Subgraph support**: prefix separator is a real (hidden) input; property panel remains the edit surface
- **Gallery performance**: previews are plain `<img>` elements (browser cache, lazy loading) — no manual bitmap cache needed
- **Randomizer**: "control after generate" now triggers once per completed prompt (works correctly with queued batches)
- **Many bug fixes**: global autocomplete attachment, overwrite-confirm dialog, settings sync, stale text on workflow load, safer file-serving routes, gallery previews for filenames with special characters, button tooltips

### Version 2.1
- **New Node: Prompt Gallery**: Powerful and intuitive grid-based gallery for browsing and selecting tags
- **Tag Group Image on Save**: You can now set a preview image when saving a Tag Group
- **Change Image in Quick Edit**: Added the ability to change the preview image directly from the quick edit menu
- **Performance Boost**: Implemented caching for previews, trigger words, and Tag Group content for a smoother experience

### Version 2.0 - Major Overhaul
- **Major Refactor**: Major overhaul of the codebase with rebuilt Autocomplete and Quick Edit systems

### Version 1.4 - Enhanced Browsing
- **New Features**: Folder browser for LoRAs, Embeddings and Tag Groups

### Version 1.3 - Extended Support
- **New Features**: LoRA and Embedding support for Autocomplete

### Version 1.2 - Core Features
- **New Features**: Introduced Randomizer node and Autocomplete functionality

### Version 1.1 - Initial Release
- **Launch**: Published to ComfyUI Registry and Manager

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.


## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

Special thanks to the amazing open-source community:

- **ComfyUI Community** - For their continuous support and valuable feedback
- **[ComfyUI-PromptPalette](https://github.com/kambara/ComfyUI-PromptPalette)** - Initial inspiration and foundational code
- **[ComfyUI-EZ-AF-Nodes](https://github.com/ez-af/ComfyUI-EZ-AF-Nodes)** - Prompt Gallery node inspiration
- **[DraconicDragon](https://github.com/DraconicDragon)** - Comprehensive tag lists and data
- **[ToxesFoxes](https://github.com/ToxesFoxes)** - Scrollable tag area implementation

---

<div align="center">

**⭐ If you find this project helpful, please consider giving it a star! ⭐**

[Report Bug](https://github.com/erehr/ComfyUI-EreNodes/issues) • [Request Feature](https://github.com/erehr/ComfyUI-EreNodes/issues) • [Discussions](https://github.com/erehr/ComfyUI-EreNodes/discussions)

</div>
