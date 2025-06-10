import os
import csv
import re
import hashlib
import urllib.request

class ErePromptFilter:
    @classmethod

    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt": ("STRING", {"forceInput": True}),

                "csv_source": (
                    [
                        "e621",
                        "danbooru",
                        "danbooru_e621_merged",
                        "custom"
                    ],
                    {"default": "danbooru_e621_merged"}
                ),
                "csv_custom": ("STRING", {"default": "", "multiline": False}),

                "alias_handling": (
                    ["Use alias", "Use main", "Use both"],
                    {"default": "Use alias"},
                ),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "process"
    CATEGORY = "utils"

    def process(self, prompt: str, csv_source: str, csv_custom: str, alias_handling: str):
        prompt = prompt.lower().replace("_", " ")
        tokens = [t.strip() for t in re.split(r'[,\n]', prompt) if t.strip()]

        csv_urls = {
            "e621": "https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/refs/heads/main/tag-lists/e621/e621_2025-05-01_pt25-ia-ed.csv",
            "danbooru": "https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/refs/heads/main/tag-lists/danbooru/danbooru_2025-05-01_pt25-ia-dd.csv",
            "danbooru_e621_merged": "https://raw.githubusercontent.com/DraconicDragon/dbr-e621-lists-archive/refs/heads/main/tag-lists/danbooru_e621_merged/danbooru_e621_merged_2025-05-01_pt25-ia-dd-ed-spc.csv",
        }

        selected_csv = csv_custom if csv_source == "custom" else csv_urls.get(csv_source, "")
        is_url = selected_csv.lower().startswith(("http://", "https://"))
        cache_dir = os.path.join(os.path.dirname(__file__), "__csvcache__")
        os.makedirs(cache_dir, exist_ok=True)

        if is_url:
            filename = os.path.basename(selected_csv)
            cached_path = os.path.join(cache_dir, filename)
            if not os.path.isfile(cached_path):
                try:
                    urllib.request.urlretrieve(selected_csv, cached_path)
                except Exception:
                    cached_path = None
            selected_csv = cached_path

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
                print(f"[ErePromptFilter] Failed to read CSV: {e}")
        else:
            print(f"[ErePromptFilter] CSV not found or invalid: {selected_csv}")

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