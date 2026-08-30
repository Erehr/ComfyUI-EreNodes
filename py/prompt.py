import re

# Default prefix separator, escaped ("\n" as two characters) to match the frontend's _prefixSeparator property; join_parts() unescapes it.
DEFAULT_PREFIX_SEPARATOR = ",\\n\\n"


# Join the non-empty parts with the (escaped) separator.
def join_parts(parts, separator=None):
    if separator is None or separator == "":
        separator = DEFAULT_PREFIX_SEPARATOR
    return str(separator).replace("\\n", "\n").join(p for p in parts if p)


# Join prefix and text with the (escaped) separator.
def combine_prompt(text, prefix="", separator=None):
    return join_parts([prefix, text], separator)


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


# Shuffles its tags. The frontend does the shuffling, so `text` already carries the result.
# `control_after_generate` is what makes this a real ComfyUI seed: the frontend pairs it with the standard control widget and steps the value after every queued prompt.
class ErePromptRandomizer(ErePrompt):
    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        # Declared last, so it does not shift the widget values saved workflows already store (see realignLoadedWidgets).
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


# Prompt Composer: one hidden `row_<n>` input per category, joined the way a chain of prompt nodes joins.
# The frontend creates those widgets on the fly and widget names are the input names, so they cannot be declared up front.
ROW_SPEC = ("STRING", {"default": "", "multiline": True})
ROW_NAME = re.compile(r"^row_(\d+)$")


class _AnyRow(dict):
    """`optional` that accepts any name. `__missing__` too: the server asks whether a
    name is in it, then reads its spec."""

    def __contains__(self, key):
        return True

    def __missing__(self, key):
        return ROW_SPEC


class ErePromptComposer(ErePrompt):
    @classmethod
    def INPUT_TYPES(cls):
        spec = super().INPUT_TYPES()
        spec["optional"] = _AnyRow(spec["optional"])
        return spec

    def process(self, text, prefix="", separator=None, **kwargs):
        rows = []
        for key, value in kwargs.items():
            match = ROW_NAME.match(key)
            if match and isinstance(value, str):
                rows.append((int(match.group(1)), value))
        rows.sort()

        # `text` mirrors the same join on the frontend, and stands in only when no row inputs arrived at all.
        body = join_parts([value for _, value in rows], separator) if rows else text
        return (combine_prompt(body, prefix, separator),)


NODE_CLASS_MAPPINGS = {
    "ErePromptMultiSelect": ErePromptMultiSelect,
    "ErePromptToggle": ErePromptToggle,
    "ErePromptCloud": ErePromptCloud,
    "ErePromptMultiline": ErePromptMultiline,
    "ErePromptRandomizer": ErePromptRandomizer,
    "ErePromptGallery": ErePromptGallery,
    "ErePromptExtractor": ErePromptExtractor,
    "ErePromptComposer": ErePromptComposer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptMultiSelect": "Prompt MultiSelect",
    "ErePromptToggle": "Prompt Toggle",
    "ErePromptCloud": "Prompt Cloud",
    "ErePromptMultiline": "Prompt Multiline",
    "ErePromptRandomizer": "Prompt Randomizer",
    "ErePromptGallery": "Prompt Gallery",
    "ErePromptExtractor": "Prompt Extractor",
    "ErePromptComposer": "Prompt Composer",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]


if __name__ == "__main__":
    # Self-check for the Composer's row join: numeric order, blanks dropped, text fallback.
    c = ErePromptComposer()
    assert c.process("mirror", "", None, row_1="b", row_0="a") == ("a,\n\nb",)
    assert c.process("", "PRE", None, row_0="", row_1="x") == ("PRE,\n\nx",)
    assert c.process("flat", "PRE", None) == ("PRE,\n\nflat",)
    assert c.process("", "", " | ", row_0="a", row_1="b") == ("a | b",)
    assert c.process("", "", ", ", **{f"row_{i}": str(i) for i in range(12)})[0].endswith("9, 10, 11")
    optional = c.INPUT_TYPES()["optional"]
    assert "row_7" in optional and optional["row_7"][0] == "STRING"
    assert ErePrompt().process("t", "p", None) == ("p,\n\nt",)
    print("ok")
