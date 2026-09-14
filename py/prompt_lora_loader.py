import os
import re

from .prompt import DEFAULT_PREFIX_SEPARATOR, combine_prompt, join_parts
from .prompt_lora_stack import LORA_REGEX, parse_lora_stack


def _to_float(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


# The node's own pills reach here in the same syntax as an upstream prompt, so both use this.
def rows_from_prompt(prompt):
    rows = []
    for name, model_strength, clip_strength in parse_lora_stack(prompt):
        strength = _to_float(model_strength, 1.0)
        rows.append({
            "name": str(name),
            "strength": strength,
            "strengthClip": _to_float(clip_strength, strength),
        })
    return rows


# Drop the lora tags this node consumed, leaving the rest of the prompt untouched.
def strip_lora_tags(prompt):
    return _collapse_separators(LORA_REGEX.sub("", prompt or ""))


# A removed tag leaves ", ," or a dangling separator where it was.
def _collapse_separators(text):
    text = re.sub(r"[ \t]*,[ \t]*(?=,)", "", text)
    text = re.sub(r"(?m)^[ \t]*,[ \t]*", "", text)
    text = re.sub(r"[ \t]*,[ \t]*$", "", text)
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
                # On when a loader further down the chain would otherwise load them again.
                "remove_lora_tags": ("BOOLEAN", {"default": False}),
            },
        }

    RETURN_TYPES = ("MODEL", "CLIP", "STRING")
    RETURN_NAMES = ("MODEL", "CLIP", "STRING")
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, text, model=None, clip=None, prefix="", separator=None, remove_lora_tags=False):
        # Prefix first, so a lora named upstream behaves as if it loaded upstream.
        from_prefix = rows_from_prompt(prefix)
        loaded = 0
        removed_prefix = []
        for is_prefix, rows in ((True, from_prefix), (False, rows_from_prompt(text))):
            for row in rows:
                model, clip, applied = apply_row(row, model, clip)
                if not applied:
                    continue
                loaded += 1
                if is_prefix:
                    removed_prefix.append(row)

        # With nothing loaded, removing the tags would delete loras this node only passes through.
        if not remove_lora_tags or not loaded:
            return (model, clip, combine_prompt(text, prefix, separator))

        # Own loras carry their chosen triggers in `text` already; prefix ones have none picked.
        triggers = ", ".join(_triggers_for(removed_prefix))
        out_prefix = join_parts([strip_lora_tags(prefix), triggers], separator)
        return (model, clip, combine_prompt(strip_lora_tags(text), out_prefix, separator))


# Apply one row, returning the models and whether it was applied.
def apply_row(row, model, clip):
    strength_model = row["strength"]
    strength_clip = 0.0 if clip is None else row["strengthClip"]
    if strength_model == 0 and strength_clip == 0:
        return model, clip, False

    found = _resolve_lora(row["name"])
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


# Lazy import: prompt_api pulls in the ComfyUI server, and this module stays runnable alone.
def _triggers_for(rows):
    try:
        from .prompt_api import _read_lora_tags
    except Exception:
        return []

    out = []
    seen = set()
    for row in rows:
        found = _resolve_lora(row["name"])
        path = _lora_path(found) if found else None
        if not path:
            continue
        try:
            triggers = _read_lora_tags(path)
        except Exception:
            continue
        for trigger in triggers or []:
            name = trigger.get("name") if isinstance(trigger, dict) else trigger
            key = str(name or "").strip().lower()
            if key and key not in seen:
                seen.add(key)
                out.append(str(name).strip())
    return out


# LoraLoader takes the name as folder_paths knows it, not a path.
# Matching against the registered list is also what keeps a name inside the lora roots.
def _resolve_lora(name):
    try:
        import folder_paths
        available = folder_paths.get_filename_list("loras")
    except Exception:
        return None

    # A prompt may name the lora with or without its extension, and with either separator.
    wanted = {name.replace("\\", "/").lower()}
    wanted.add(os.path.splitext(name)[0].replace("\\", "/").lower())

    for entry in available:
        flat = entry.replace("\\", "/").lower()
        if flat in wanted or os.path.splitext(flat)[0] in wanted:
            return entry
    # Written by hand without its folder.
    for entry in available:
        base = os.path.basename(entry.replace("\\", "/")).lower()
        if base in wanted or os.path.splitext(base)[0] in wanted:
            return entry
    return None


def _lora_path(name):
    try:
        import folder_paths
        return folder_paths.get_full_path("loras", name)
    except Exception:
        return None


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
    assert _resolve_lora("dmd2_sdxl_4step_lora_fp16.safetensors") == "dmd2_sdxl_4step_lora_fp16.safetensors"
    assert _resolve_lora("dmd2_sdxl_4step_lora_fp16") == "dmd2_sdxl_4step_lora_fp16.safetensors"
    assert _resolve_lora("artist/takawoyu.safetensors") == "artist\\takawoyu.safetensors"
    assert _resolve_lora("artist/takawoyu") == "artist\\takawoyu.safetensors"
    assert _resolve_lora("takawoyu.safetensors") == "artist\\takawoyu.safetensors"
    assert _resolve_lora("nope.safetensors") is None
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

    print("prompt_lora_loader self-check ok")
