import re
import os

class ErePromptLoraStack:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"forceInput": True})
            }
        }

    RETURN_TYPES = ("LORA_STACK", "STRING")
    RETURN_NAMES = ("lora_stack", "filtered_prompt")
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, prompt):
        lora_stack = []
        # Regex to find <lora:filename:strength>
        lora_regex = r"<lora:([^:]+):([0-9.]+)>"
        matches = re.findall(lora_regex, prompt)
        for match in matches:
            filename = os.path.normpath(match[0])
            strength = float(match[1])
            if not (filename.endswith('.safetensors') or filename.endswith('.pt')):
                filename += '.safetensors'
            # ComfyUI's LoRA stack format: (lora_name, model_strength, clip_strength)
            lora_stack.append((filename, strength, strength))
        # Remove lora tags from the text
        cleaned_text = re.sub(lora_regex, '', prompt)
        # Normalize commas: ensure ', ' as separator, collapse multiple commas, strip
        cleaned_text = re.sub(r'\s*,\s*', ', ', cleaned_text)  # normalize to ', '
        cleaned_text = re.sub(r'(,\s*)+', ', ', cleaned_text)   # collapse multiple commas
        cleaned_text = cleaned_text.strip(', ').strip()
        return (lora_stack, cleaned_text)

NODE_CLASS_MAPPINGS = {
    "ErePromptLoraStack": ErePromptLoraStack
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptLoraStack": "Prompt to LoRA Stack"
}
