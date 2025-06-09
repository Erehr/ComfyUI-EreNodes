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
        # Treat input as a simple comma-separated list
        tags = [t.strip() for t in text.split(",") if t.strip()]
        result = ", ".join(filter(None, [prefix] + tags))
        return (result,)


class ErePromptMultiSelect(ErePrompt): pass
class ErePromptToggle(ErePrompt): pass
class ErePromptCloud(ErePrompt): pass
class ErePromptPassthrough(ErePrompt): pass

NODE_CLASS_MAPPINGS = {
    "ErePromptMultiSelect": ErePromptMultiSelect,
    "ErePromptToggle": ErePromptToggle,
    "ErePromptCloud": ErePromptCloud,
    "ErePromptPassthrough": ErePromptPassthrough,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptMultiSelect": "Prompt MultiSelect",
    "ErePromptToggle": "Prompt Toggle",
    "ErePromptCloud": "Prompt Cloud",
    "ErePromptPassthrough": "Prompt Passthrough",
}

def scripts():
    return {
        "ErePromptMultiSelect": "prompt_multiselect.js",
        "ErePromptToggle": "prompt_toggle.js",
        "ErePromptCloud": "prompt_cloud.js",
    }

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
