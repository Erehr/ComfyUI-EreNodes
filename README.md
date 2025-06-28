# 🎨 ComfyUI-EreNodes

> A powerful collection of custom nodes for ComfyUI that improve prompt management and organization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![ComfyUI](https://img.shields.io/badge/ComfyUI-Compatible-brightgreen)](https://github.com/comfyanonymous/ComfyUI)

ComfyUI-EreNodes provides an intuitive and feature-rich solution for handling prompts in your ComfyUI workflows. These nodes are designed to work seamlessly together, offering everything from intelligent autocomplete to visual tag management.

![Image](https://github.com/user-attachments/assets/7701cdb9-cef2-4dc4-8a3b-ed0dc5f164b6)

## 📚 Table of Contents

- [Available Nodes](#-available-nodes)
- [Key Features](#-key-features)
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

### ✏️ Advanced Tag Editing
- **Effortless Replacement**: Quick edit tags or replacement of LoRAs, embeddings and Tag Groups
- **Strength Control**: Precise tag strength adjustment via buttons or intuitive click-dragging
- **Rich Previews**: Set and view preview images for all content types
- **Dynamic Triggers**: Toggle LoRA trigger words with familiar tag pill interface

![Image](https://github.com/user-attachments/assets/ef65357f-88cd-4cfd-bf5d-0b9e0a7a0c78)

### 🔍 Smart Autocomplete
- **Comprehensive Dictionaries**: Built-in tag lists from Danbooru and e621, plus support for custom CSV files in the `__autocomplete__` folder
- **Intelligent Aliases**: Automatic tag alias detection and replacement with canonical terms
- **Flexible Search**: Partial matching support, including multi-word tag recognition
- **Visual Highlighting**: Clear highlighting of filtered terms for enhanced clarity

![Image](https://github.com/user-attachments/assets/42deb9e3-73fa-4891-9ec5-cfbd497f9d9e)

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
- Right-click any tag in EreNodes → "Save as Tag Group"
- Access saved groups through the Menu or + button
- Import/export tag groups for sharing with the community

**Lora Loading:**
- For loading Lora directly from prompt node like [Lora Tag Loader](https://github.com/badjeff/comfyui_lora_tag_loader/) is required

### 💡 Pro Tips

- **Search Efficiently**: Use partial matches or space for multi word phrases
- **Visual Organization**: Set preview images for your most-used ta groups
- **Quick Edits**: Right-click any tag for instant editing options
- **Experiment**: Use the Randomizer node to discover new prompt combinations
- **Convertible**: All tag nodes can be converted to another under ≡ menu
- **Customize output**: Separators between nodes and individual tags can be set customized in node Properties

## 📋 Changelog

### Version 2.1 - Latest
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

---

<div align="center">

**⭐ If you find this project helpful, please consider giving it a star! ⭐**

[Report Bug](https://github.com/erehr/ComfyUI-EreNodes/issues) • [Request Feature](https://github.com/erehr/ComfyUI-EreNodes/issues) • [Discussions](https://github.com/erehr/ComfyUI-EreNodes/discussions)

</div>