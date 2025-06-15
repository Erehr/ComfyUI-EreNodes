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
                "prefix_separator": ("STRING", {"default": ",\n\n", "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, text, prefix="", prefix_separator=None):
        # Use the input values or fall back to defaults
        if prefix_separator is None:
            prefix_separator = ",\n\n"
        
        if prefix and text:
            # Replace literal \n with actual newlines in the separator
            separator = prefix_separator.replace("\\n", "\n")
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
