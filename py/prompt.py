import os
import time

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

    @classmethod
    def IS_CHANGED(cls, text, prefix="", extra_pnginfo="", unique_id=""):
        # Include separator in the hash to force re-execution
        for node in extra_pnginfo["workflow"]["nodes"]:
            if node["id"] == int(unique_id):
                prefix_separator = node["properties"].get("_prefixSeparator", ",\n\n")
                return hash((text, prefix, prefix_separator))
        return hash((text, prefix))
        
    def process(self, text, prefix="", extra_pnginfo="", unique_id=""):

        node_found = False
        for node in extra_pnginfo["workflow"]["nodes"]:
            if node["id"] == int(unique_id):
                prefix_separator = node["properties"].get("_prefixSeparator")
                tag_separator = node["properties"].get("_tagSeparator")
                node_found = True
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

NODE_CLASS_MAPPINGS = {
    "ErePromptMultiSelect": ErePromptMultiSelect,
    "ErePromptToggle": ErePromptToggle,
    "ErePromptCloud": ErePromptCloud,
    "ErePromptMultiline": ErePromptMultiline,
    "ErePromptRandomizer": ErePromptRandomizer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptMultiSelect": "Prompt MultiSelect",
    "ErePromptToggle": "Prompt Toggle",
    "ErePromptCloud": "Prompt Cloud",
    "ErePromptMultiline": "Prompt Multiline",
    "ErePromptRandomizer": "Prompt Randomizer",
}

def scripts():
    return {
        "ErePromptMultiSelect": "prompt_multiselect.js",
        "ErePromptToggle": "prompt_toggle.js",
        "ErePromptCloud": "prompt_cloud.js",
        "ErePromptMultiline": "prompt_multiline.js",
        "ErePromptRandomizer": "prompt_randomizer.js",
    }

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
