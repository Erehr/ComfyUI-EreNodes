import os

class ErePrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True})
            },
            "optional": {
                "prefix": ("STRING", {"forceInput": True}),
            },
            "hidden": {"extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"}
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, text, prefix="", extra_pnginfo="", unique_id=""):

        prefix_separator = ",\n\n"
        if extra_pnginfo and "workflow" in extra_pnginfo and "nodes" in extra_pnginfo["workflow"]:
            for node in extra_pnginfo["workflow"]["nodes"]:
                if str(node.get("id")) == str(unique_id):
                    prefix_separator = node["properties"].get("_prefixSeparator", ",\n\n")
                    break
        
        separator = str(prefix_separator).replace("\\n", "\n")
        
        if prefix and text:
            return (f"{prefix}{separator}{text}",)
        elif prefix:
            return (prefix,)
        else:
            return (text,)


class ErePromptMultiSelect(ErePrompt): pass
class ErePromptToggle(ErePrompt): pass
class ErePromptCloud(ErePrompt): pass
class ErePromptMultiline(ErePrompt): pass
class ErePromptRandomizer(ErePrompt): pass
class ErePromptGallery(ErePrompt): pass

NODE_CLASS_MAPPINGS = {
    "ErePromptMultiSelect": ErePromptMultiSelect,
    "ErePromptToggle": ErePromptToggle,
    "ErePromptCloud": ErePromptCloud,
    "ErePromptMultiline": ErePromptMultiline,
    "ErePromptRandomizer": ErePromptRandomizer,
    "ErePromptGallery": ErePromptGallery,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptMultiSelect": "Prompt MultiSelect",
    "ErePromptToggle": "Prompt Toggle",
    "ErePromptCloud": "Prompt Cloud",
    "ErePromptMultiline": "Prompt Multiline",
    "ErePromptRandomizer": "Prompt Randomizer",
    "ErePromptGallery": "Prompt Gallery",
}

def scripts():
    return {
        "ErePromptMultiSelect": "prompt_multiselect.js",
        "ErePromptToggle": "prompt_toggle.js",
        "ErePromptCloud": "prompt_cloud.js",
        "ErePromptMultiline": "prompt_multiline.js",
        "ErePromptRandomizer": "prompt_randomizer.js",
        "ErePromptLoader": "prompt_loader.js",
    }

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
