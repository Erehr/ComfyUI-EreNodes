# ComfyUI EreNodes

A collection of custom nodes for ComfyUI that enhance prompt management and organization. These nodes provide various ways to handle and manipulate prompts in your ComfyUI workflows and are designed to be used together. 

## Nodes
![Image](https://github.com/user-attachments/assets/0dee5980-c730-42ea-b649-61b1fb80099d)

### Prompt Cloud
A tag cloud visualization node that displays your prompts as interactive tags. Click on tags to toggle them on/off. Perfect for quickly managing prompts in a visual way.

### Prompt Toggle
A simple list of toggleable tags that can be easily enabled or disabled. Great for managing a smaller set of frequently used prompts.

### Prompt MultiSelect
A multi-select field implementation that allows you to select multiple tags from a list. Ideal for when you need to choose from a larger predefined set of prompts.

### Prompt Randomizer
A node that allows you to randomize your prompt tags. It includes a manual randomize button and an option to automatically randomize after each generation, giving you more control over creative exploration.

### Prompt Multiline
A complementary standard text edit node that includes all prompt managing features from other nodes. 

### Prompt Filter
A powerful node that filters your prompts through a CSV file.

> **Note:**  CSV files are located in __autocomplete__ folder in node directory. Adding additional CSV there will make them avaliable for both autocomplete setting and filter node.

## Installation

Install from ComfyUI Manager or:

1. Navigate to your ComfyUI custom nodes directory:
```bash
cd ComfyUI/custom_nodes/
```

2. Clone this repository:
```bash
git clone https://github.com/erehr/ComfyUI-EreNodes.git
```

3. Restart ComfyUI

## Features

### Autocomplete
Enhance your workflow with intelligent autocompletion. Suggestions are provided globally as you type, and can also be triggered via a dedicated button on each prompt node. 
**Note:**  Disabled by default. Enable in settings panel under erenodes. Support both lora (search  'lora:' or 'l:' for short) and embeddings ('embedding:' or 'e:').

### Advanced Tag Parsing
All prompt nodes are compatible with LoRAs, and embeddings. The parsers correctly handle complex prompts containing a mix of syntaxes.

- **Lora and Embedding Support**: Tags are intelligently parsed to recognize lora and embeddings. Tags are color-coded by type for easy identification: 
- **Clipboard Integration**: You can quickly add tags by pasting them directly from your clipboard. The nodes support replacing the existing set or appending to it.

### Tag Management & Editing
A robust set of features for managing, saving, and editing your tags.

- **Save and Load Tag Groups**: Manage your prompts by saving or loading entire tag groups. This includes options to easily create subfolders and convinient search filter. 
- **Import and Export Tag Group**: Tag groups can be also exported and imported directly as `.json`.
- **Quick Editing**: `Shift+Click` on any tag pill to open a quick-edit menu. This allows you to instantly change the tag's name and strength, or delete it entirely without entering the main editor.
- **Custom separator**: Option to set custom separator between tags and chained nodes under Properties.
- **Convertible**: All prompt nodes can be converted to another type under menu dropdown. 
> **Note:**  Converting to Prompt Multiline will result in permanent loss of inactive tags.

![Image](https://github.com/user-attachments/assets/b3da4aac-6e72-460f-84ae-bc1eae351b8a)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Thanks to the ComfyUI community for their support and feedback.
- [DraconicDragon](https://github.com/DraconicDragon) for the comprehensive tag lists in the [dbr-e621-lists-archive](https://github.com/DraconicDragon/dbr-e621-lists-archive/) repository.
- [kambara](https://github.com/kambara) for the initial inspiration and code concepts from the [ComfyUI-PromptPalette](https://github.com/kambara/ComfyUI-PromptPalette) repository.