# ComfyUI EreNodes

A collection of custom nodes for ComfyUI that enhance prompt management and organization. These nodes provide various ways to handle and manipulate prompts in your ComfyUI workflows and are designed to be used together. 

## Nodes
![Image](https://github.com/user-attachments/assets/8e021dc6-c623-446a-990c-3bd72b08553f)

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
Node that filters your prompts through autocomplete CSV file and return only valid tags from your prompt. 

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

### Advanced Tag Parsing
All prompt nodes are compatible with LoRAs, and embeddings. The parsers correctly handle complex prompts containing a mix of syntaxes.

- **Lora and Embedding Support**: Tags are intelligently parsed to recognize lora and embeddings. Tags are color-coded by type for easy identification: 
- **Clipboard Integration**: You can quickly add tags by pasting them directly from your clipboard. The nodes support replacing the existing set or appending to it.

### Tag Management & Editing
A robust set of features for managing, saving, and editing your tags.

- **Save and Load Tag Groups**: Manage your prompts by saving or loading entire tag groups. This includes options to easily create subfolders and convinient search filter. 
- **Tag Group as its own tag** And your tag group back to prompt as a single clean tag. Preview of its content avaliable in Quick Edit menu. 
- **Quick Editing**: `Right Click` on any tag pill to open a quick-edit menu. This allows you to instantly change the tag (or switch lora etc.) strength (now with drag support), or delete it entirely without entering the main editor. 
- **Quick Editing Tag Group** Easily preview the content of your tag group. Add image to tag group file location to show it in preview (both in quick edit and file browser when adding tags)
- **Quick Editing Lora** Not only view potential Lora Trigger Words but also activate them! directly from quick edit just like on the main node.
- **Custom separator**: Option to set custom separator between tags and chained nodes under Properties.
- **Convertible**: All prompt nodes can be converted to another type under menu dropdown. 

> **Note:** Converting to Prompt Multiline will result in permanent loss of inactive tags.
> **Note** As in ComfyUI Lora is not recognized in prompt node like [lora tag loader/](https://github.com/badjeff/comfyui_lora_tag_loader/) is needed.

![Image](https://github.com/user-attachments/assets/b9c49015-b338-4d78-9e6c-e1ecf178292f)

## Changelog
- 2.0 Code refactored - Quick Edit, Tag Groups, Autocomplete
- 1.5 Code refactoring and cleanup
- 1.4 Added folder browser to aAutocomplete Lora and Embedding
- 1.3 Added Lora and Embedding support for Autocomplete 
- 1.2 Added Randomizer node
- 1.1 Added to Comfy Registry and Manager

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- Thanks to the ComfyUI community for their support and feedback.
- [DraconicDragon](https://github.com/DraconicDragon) for the comprehensive tag lists in the [dbr-e621-lists-archive](https://github.com/DraconicDragon/dbr-e621-lists-archive/) repository.
- [kambara](https://github.com/kambara) for the initial inspiration and code concepts from the [ComfyUI-PromptPalette](https://github.com/kambara/ComfyUI-PromptPalette) repository.