# Default prefix separator in *escaped* form ("\n" as two characters).
# It is unescaped to real newlines in combine_prompt(). This matches the
# frontend's _prefixSeparator property format.
DEFAULT_PREFIX_SEPARATOR = ",\\n\\n"


def combine_prompt(text, prefix="", separator=None):
    """Join prefix and text with the (escaped) separator."""
    if separator is None or separator == "":
        separator = DEFAULT_PREFIX_SEPARATOR

    separator = str(separator).replace("\\n", "\n")

    if prefix and text:
        return f"{prefix}{separator}{text}"
    elif prefix:
        return prefix
    return text


class ErePrompt:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True})
            },
            "optional": {
                "prefix": ("STRING", {"forceInput": True}),
                # Transport only — hidden by the frontend. User edits live in
                # the _prefixSeparator node property; JS copies that into this
                # widget so Python can read it. (Node properties are frontend-
                # only; execute() never receives them as kwargs.)
                "separator": ("STRING", {"default": DEFAULT_PREFIX_SEPARATOR}),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, text, prefix="", separator=None):
        return (combine_prompt(text, prefix, separator),)


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

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
