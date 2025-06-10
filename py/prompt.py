import os

class ErePrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True})
            },
            "optional": {
                "prefix": ("STRING", {"forceInput": True})
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "utils"

    def process(self, text, prefix=""):
        clean_prefix = prefix.strip() if prefix else ""
        clean_text = text.strip() if text else ""
        
        if clean_prefix and clean_text:
            return (f"{clean_prefix}\n\n{clean_text}",)
        elif clean_prefix:
            return (clean_prefix,)
        else:
            return (clean_text,)


class ErePromptMultiSelect(ErePrompt): pass
class ErePromptToggle(ErePrompt): pass
class ErePromptCloud(ErePrompt): pass
class ErePromptMultiline(ErePrompt): pass

NODE_CLASS_MAPPINGS = {
    "ErePromptMultiSelect": ErePromptMultiSelect,
    "ErePromptToggle": ErePromptToggle,
    "ErePromptCloud": ErePromptCloud,
    "ErePromptMultiline": ErePromptMultiline,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptMultiSelect": "Prompt MultiSelect",
    "ErePromptToggle": "Prompt Toggle",
    "ErePromptCloud": "Prompt Cloud",
    "ErePromptMultiline": "Prompt Multiline",
}

def scripts():
    return {
        "ErePromptMultiSelect": "prompt_multiselect.js",
        "ErePromptToggle": "prompt_toggle.js",
        "ErePromptCloud": "prompt_cloud.js",
        "ErePromptMultiline": "prompt_multiline.js",
    }

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
