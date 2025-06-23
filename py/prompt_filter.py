import os
import csv
import re
from .prompt_api import get_erenodes_settings
from .prompt_csv import get_tag_data

class ErePromptFilter:
    @classmethod
    def INPUT_TYPES(cls):
        base_dir = os.path.dirname(os.path.abspath(__file__))
        autocomplete_dir = os.path.join(base_dir, "..", "__autocomplete__")
        csv_files = [f for f in os.listdir(autocomplete_dir) if f.endswith(".csv")] if os.path.exists(autocomplete_dir) else []
        
        return {
            "required": {
                "prompt": ("STRING", {"forceInput": True}),
                "csv_file": (csv_files, {"default": csv_files[0] if csv_files else None}),
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
        prompt = prompt.lower().replace("_", " ")
        tokens = [t.strip() for t in re.split(r'[,\n]', prompt) if t.strip()]

        base_dir = os.path.dirname(os.path.abspath(__file__))
        autocomplete_dir = os.path.join(base_dir, "..", "__autocomplete__")
        selected_csv = os.path.join(autocomplete_dir, csv_file)

        alias_map = {}
        canonical_map = {}
        tag_set = set()

        if selected_csv and os.path.isfile(selected_csv):
            try:
                with open(selected_csv, newline='', encoding='utf-8') as csvfile:
                    reader = csv.reader(csvfile)
                    next(reader, None)  # Skip header
                    for row in reader:
                        if len(row) < 4:
                            continue
                        tag = row[0].strip().lower().replace('_', ' ')
                        tag_set.add(tag)
                        canonical_map[tag] = tag
                        aliases = row[3]
                        if aliases:
                            for alias in aliases.split(','):
                                alias = alias.strip().lower().replace('_', ' ')
                                alias_map[alias] = tag
            except Exception as e:
                return (prompt,)
        else:
            return (prompt,)

        result_tags = []
        for token in tokens:
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

            token = token.replace(r'\(', '(').replace(r'\)', ')').strip()

            base = alias_map.get(token, token)
            main = canonical_map.get(base)

            if alias_handling == "Use alias" and token in alias_map:
                result_tags.append(token)
            elif alias_handling == "Use main" and main:
                result_tags.append(main)
            elif alias_handling == "Use both" and token in alias_map and main:
                result_tags.extend([main, token])
            elif token in tag_set:
                result_tags.append(token)

        return (', '.join(dict.fromkeys(result_tags)),)


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