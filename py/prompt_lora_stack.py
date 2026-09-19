import re
import os

# What a lora file may be called; a name with none of these gets the default appended.
LORA_EXTENSIONS = (".safetensors", ".pt", ".ckpt", ".lora")

# <lora:name>, <lora:name:model_strength> or <lora:name:model_strength:clip_strength> Supports negative strengths; name may not contain ':' or '>'.
LORA_REGEX = re.compile(r"<lora:([^:>]+)(?::(-?[0-9.]+))?(?::(-?[0-9.]+))?>")


def _to_float(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _with_default_extension(name):
    filename = os.path.normpath(name)
    return filename if filename.lower().endswith(LORA_EXTENSIONS) else filename + ".safetensors"


# The name as folder_paths knows it, which is what every loader downstream expects, or None when no such lora is registered.
# Matching against the registered list is also what keeps a name inside the lora roots.
def resolve_lora(name):
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


# Extract LoRA tags into ComfyUI LORA_STACK format.
def parse_lora_stack(prompt):
    lora_stack = []
    for name, model_s, clip_s in LORA_REGEX.findall(prompt or ""):
        filename = resolve_lora(name) or _with_default_extension(name)
        model_strength = _to_float(model_s, 1.0) if model_s else 1.0
        clip_strength = _to_float(clip_s, model_strength) if clip_s else model_strength
        # LoRA stack format: (lora_name, model_strength, clip_strength)
        lora_stack.append((filename, model_strength, clip_strength))
    return lora_stack


class ErePromptLoraStack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"forceInput": True})
            }
        }

    RETURN_TYPES = ("LORA_STACK",)
    RETURN_NAMES = ("lora_stack",)
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, prompt):
        return (parse_lora_stack(prompt),)


NODE_CLASS_MAPPINGS = {
    "ErePromptLoraStack": ErePromptLoraStack
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptLoraStack": "Prompt to LoRA Stack"
}
