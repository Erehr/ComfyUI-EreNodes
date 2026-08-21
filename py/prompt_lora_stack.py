import re
import os

# <lora:name>, <lora:name:model_strength> or <lora:name:model_strength:clip_strength> Supports negative strengths; name may not contain ':' or '>'.
LORA_REGEX = re.compile(r"<lora:([^:>]+)(?::(-?[0-9.]+))?(?::(-?[0-9.]+))?>")


def _to_float(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


# Extract LoRA tags into ComfyUI LORA_STACK format.
def parse_lora_stack(prompt):
    lora_stack = []
    for name, model_s, clip_s in LORA_REGEX.findall(prompt or ""):
        filename = os.path.normpath(name)
        if not (filename.endswith('.safetensors') or filename.endswith('.pt')):
            filename += '.safetensors'
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
