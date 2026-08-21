import os
import re

from .prompt_csv import CSV_FILES_PATH, get_filter_maps


def list_csv_files():
    if not os.path.isdir(CSV_FILES_PATH):
        return []
    return sorted(f for f in os.listdir(CSV_FILES_PATH) if f.endswith(".csv"))


# Strip lora/embedding syntax, weights and wrapping brackets from a token.
def _clean_token(token):
    token = re.sub(r'<lora:[^:>]+(:[^:>]+){1,2}>', '', token)
    token = re.sub(r'lora\([^)]+\)', '', token)
    token = re.sub(r'<[^>]+>', '', token)
    token = re.sub(r'([\w\- ]+):[\d.]+', r'\1', token)

    token = re.sub(r'^\(\(\((.*?)\)\)\)$', r'\1', token)
    token = re.sub(r'^\(\((.*?)\)\)$', r'\1', token)
    token = re.sub(r'^\(([^\(\)]+:[\d.]+)\)$', r'\1', token)
    token = re.sub(r'^\[([^\[\]]+:[\d.]+)\]$', r'\1', token)
    token = re.sub(r'^\{([^{}]+:[\d.]+)\}$', r'\1', token)
    token = re.sub(r'^[\(\[\{](.*?)[\)\]\}]$', r'\1', token)

    return token.replace(r'\(', '(').replace(r'\)', ')').strip()


# Keep only tokens known to the CSV (as tag or alias).
def filter_prompt(prompt, csv_file, alias_handling):
    prompt = prompt.lower().replace("_", " ")
    tokens = [t.strip() for t in re.split(r'[,\n]', prompt) if t.strip()]

    maps = get_filter_maps(csv_file)
    if maps is None:
        return prompt
    tag_set, alias_map = maps

    result_tags = []
    for token in tokens:
        token = _clean_token(token)

        base = alias_map.get(token, token)
        main = base if base in tag_set else None

        if alias_handling == "Use alias" and token in alias_map:
            result_tags.append(token)
        elif alias_handling == "Use main" and main:
            result_tags.append(main)
        elif alias_handling == "Use both" and token in alias_map and main:
            result_tags.extend([main, token])
        elif token in tag_set:
            result_tags.append(token)

    return ', '.join(dict.fromkeys(result_tags))


class ErePromptFilter:
    @classmethod
    def INPUT_TYPES(cls):
        csv_files = list_csv_files()
        return {
            "required": {
                "prompt": ("STRING", {"forceInput": True}),
                "csv_file": (csv_files or ["none found"], {"default": csv_files[0] if csv_files else "none found"}),
                "alias_handling": (
                    ["Use alias", "Use main", "Use both"],
                    {"default": "Use alias"},
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "EreNodes"

    def process(self, prompt: str, csv_file: str, alias_handling: str):
        return (filter_prompt(prompt, csv_file, alias_handling),)


NODE_CLASS_MAPPINGS = {
    "ErePromptFilter": ErePromptFilter,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ErePromptFilter": "Prompt Filter",
}

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
]
