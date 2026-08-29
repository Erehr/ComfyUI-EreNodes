# Default prefix separator in *escaped* form ("\n" as two characters).
# It is unescaped to real newlines in combine_prompt().
# This matches the frontend's _prefixSeparator property format.
DEFAULT_PREFIX_SEPARATOR = ",\\n\\n"


# Join prefix and text with the (escaped) separator.
def combine_prompt(text, prefix="", separator=None):
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
                # Transport only, hidden by the frontend: edits live in the _prefixSeparator property, which JS mirrors into this widget because execute() only receives widget values.
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
class ErePromptGallery(ErePrompt): pass


# Shuffles its tags. The seed decides the arrangement; the frontend does the
# shuffling, so `text` already carries the result by the time this runs.
#
# `control_after_generate: True` is what makes this a real ComfyUI seed: the
# frontend pairs it with the standard control widget (which collapses into the
# seed field in Nodes 2.0) and steps the value itself after every queued prompt.
# An INT widget of our own could never do that - it just sat there.
class ErePromptRandomizer(ErePrompt):
    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        # Declared last so that adding it does not shift the widgets that existing
        # saved workflows already store values for (see realignLoadedWidgets).
        spec["optional"]["seed"] = ("INT", {
            "default": 0,
            "min": 0,
            "max": 0xFFFFFFFFFFFFFFFF,
            "control_after_generate": True,
            "tooltip": "Decides the tag arrangement. The same seed always produces "
                       "the same order and the same active tags.",
        })
        return spec

    # Accepted and ignored: the arrangement it selected is already baked into `text`.
    def process(self, text, prefix="", separator=None, seed=0):
        return (combine_prompt(text, prefix, separator),)



# Recover a prompt from a generated image, as editable tag pills.
#
# `image` records where the tags came from; `text` is what executes.
class ErePromptExtractor(ErePrompt):

    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        spec["optional"]["image"] = ("STRING", {
            "default": "",
            "tooltip": "Image the prompt was recovered from (for reference; "
                       "drop a new one on the node to re-extract).",
        })
        return spec

    def process(self, text, prefix="", separator=None, image=""):
        return (combine_prompt(text, prefix, separator),)


NODE_CLASS_MAPPINGS = {
    "ErePromptMultiSelect": ErePromptMultiSelect,
    "ErePromptToggle": ErePromptToggle,
    "ErePromptCloud": ErePromptCloud,
    "ErePromptMultiline": ErePromptMultiline,
    "ErePromptRandomizer": ErePromptRandomizer,
    "ErePromptGallery": ErePromptGallery,
    "ErePromptExtractor": ErePromptExtractor,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptMultiSelect": "Prompt MultiSelect",
    "ErePromptToggle": "Prompt Toggle",
    "ErePromptCloud": "Prompt Cloud",
    "ErePromptMultiline": "Prompt Multiline",
    "ErePromptRandomizer": "Prompt Randomizer",
    "ErePromptGallery": "Prompt Gallery",
    "ErePromptExtractor": "Prompt Extractor",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
