import re

from .prompt import DEFAULT_PREFIX_SEPARATOR, combine_prompt
from .prompt_lora_stack import LORA_REGEX, parse_lora_stack, resolve_lora


# The node's own pills reach here in the same syntax as an upstream prompt, so both use this.
def rows_from_prompt(prompt):
    return [{"name": str(name), "strength": model_strength, "strengthClip": clip_strength}
            for name, model_strength, clip_strength in parse_lora_stack(prompt)]


# Drop the lora tags this node consumed, leaving the rest of the prompt untouched.
def strip_lora_tags(prompt):
    return _collapse_separators(LORA_REGEX.sub("", prompt or ""))


# A removed tag leaves ", ," or a dangling separator where it was.
# The leading whitespace is taken only from the start of a run: matching it anywhere is quadratic on a long run of spaces.
def _collapse_separators(text):
    text = re.sub(r"(?:(?<![ \t])[ \t]+)?,[ \t]*(?=,)", "", text)
    text = re.sub(r"(?m)^[ \t]*,[ \t]*", "", text)
    text = re.sub(r"(?:(?<![ \t])[ \t]+)?,[ \t]*$", "", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip().strip(",").strip()


class ErePromptLoraLoader:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True}),
            },
            "optional": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "prefix": ("STRING", {"forceInput": True}),
                "separator": ("STRING", {"default": DEFAULT_PREFIX_SEPARATOR}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "STRING")
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, text, model=None, clip=None, prefix="", separator=None):
        # Prefix first, so a lora named upstream behaves as if it loaded upstream.
        from_prefix = rows_from_prompt(prefix)
        loaded = 0
        # One application per lora: the same one named upstream and again here would otherwise be applied twice, at compounded strength.
        seen = set()
        for row in from_prefix + rows_from_prompt(text):
            if row["name"] in seen:
                continue
            seen.add(row["name"])
            model, clip, applied = apply_row(row, model, clip)
            if applied:
                loaded += 1

        # With nothing loaded, removing the tags would delete loras this node only passes through.
        if not loaded:
            return (model, clip, combine_prompt(text, prefix, separator))

        # Selected triggers follow their lora tag in both text and prefix, so stripping the tags leaves exactly those.
        return (model, clip, combine_prompt(strip_lora_tags(text), strip_lora_tags(prefix), separator))


# Apply one row, returning the models and whether it was applied.
def apply_row(row, model, clip):
    strength_model = row["strength"]
    strength_clip = 0.0 if clip is None else row["strengthClip"]
    if strength_model == 0 and strength_clip == 0:
        return model, clip, False

    found = resolve_lora(row["name"])
    if found is None:
        print(f"[EreNodes] LoRA not found, skipping: {row['name']}")
        return model, clip, False
    if model is None:
        return model, clip, False

    try:
        from nodes import LoraLoader
        model, clip = LoraLoader().load_lora(model, clip, found, strength_model, strength_clip)
    except Exception as e:
        print(f"[EreNodes] Failed to apply LoRA '{row['name']}': {e}")
        return model, clip, False

    return model, clip, True


NODE_CLASS_MAPPINGS = {
    "ErePromptLoraLoader": ErePromptLoraLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptLoraLoader": "Prompt Lora Loader",
}


if __name__ == "__main__":
    n = ErePromptLoraLoader()

    rows = rows_from_prompt("a, <lora:foo:0.7>, b, <lora:bar:0.5:0.2>")
    assert [r["name"] for r in rows] == ["foo.safetensors", "bar.safetensors"], rows
    assert rows_from_prompt("<lora:old.ckpt>")[0]["name"] == "old.ckpt"
    assert rows[0]["strength"] == 0.7 and rows[0]["strengthClip"] == 0.7
    assert rows[1]["strengthClip"] == 0.2
    assert rows_from_prompt("") == []

    assert strip_lora_tags("a, <lora:foo:0.7>, b") == "a, b"
    assert strip_lora_tags("<lora:foo>, a") == "a"
    assert strip_lora_tags("a, <lora:foo>") == "a"
    assert strip_lora_tags("<lora:foo>") == ""

    # A zeroed row loads nothing; clip=None zeroes the clip strength rather than raising.
    assert apply_row({"name": "x", "strength": 0, "strengthClip": 0}, "M", "C") == ("M", "C", False)
    assert apply_row({"name": "nope", "strength": 1, "strengthClip": 0.5}, "M", None) == ("M", None, False)

    # LoraLoader takes a registered name, never a path, so resolution has to hand one back.
    import sys, types
    fake = types.ModuleType("folder_paths")
    fake.get_filename_list = lambda kind: ["artist\\takawoyu.safetensors", "dmd2_sdxl_4step_lora_fp16.safetensors"]
    sys.modules["folder_paths"] = fake
    assert resolve_lora("dmd2_sdxl_4step_lora_fp16.safetensors") == "dmd2_sdxl_4step_lora_fp16.safetensors"
    assert resolve_lora("dmd2_sdxl_4step_lora_fp16") == "dmd2_sdxl_4step_lora_fp16.safetensors"
    assert resolve_lora("artist/takawoyu.safetensors") == "artist\\takawoyu.safetensors"
    assert resolve_lora("artist/takawoyu") == "artist\\takawoyu.safetensors"
    assert resolve_lora("takawoyu.safetensors") == "artist\\takawoyu.safetensors"
    assert resolve_lora("nope.safetensors") is None
    del sys.modules["folder_paths"]

    # No model connected: nothing was loaded, so the prompt keeps its tags even with consumption on.
    out = n.process("", prefix="a, <lora:foo:0.7>", separator=None)
    assert out[0] is None and out[1] is None
    assert "<lora:foo:0.7>" in out[2], out[2]

    # text is the node's own contribution and follows the prefix.
    assert n.process("body", prefix="pre", separator=None)[2] == "pre,\n\nbody"
    assert n.process("", prefix="pre", separator=None)[2] == "pre"
    assert n.process("body", separator=None)[2] == "body"

    # Own loras live in `text` like any other prompt node, and are left alone when none loaded.
    assert n.process("a, <lora:foo>, b", separator=None)[2] == "a, <lora:foo>, b"

    # Loaded loras keep only the triggers the upstream node selected, once each.
    real_apply = apply_row
    apply_row = lambda row, m, c: (m, c, True)
    out = n.process("<lora:own:0.5>, own trigger", model="M", prefix="a, <lora:foo:0.7>, picked trigger, b", separator=None)[2]
    assert out == "a, picked trigger, b,\n\nown trigger", repr(out)
    assert n.process("", model="M", prefix="<lora:foo>", separator=None)[2] == ""
    apply_row = real_apply

    print("prompt_lora_loader self-check ok")
