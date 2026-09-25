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
        import comfy.sd
        import comfy.utils
        import folder_paths
        lora = comfy.utils.load_torch_file(folder_paths.get_full_path("loras", found), safe_load=True)
        model, clip = comfy.sd.load_lora_for_models(model, clip, match_anima_blocks(lora, model, row["name"]), strength_model, strength_clip)
    except Exception as e:
        print(f"[EreNodes] Failed to apply LoRA '{row['name']}': {e}")
        return model, clip, False

    return model, clip, True


# Each Anima generation inserts new transformer blocks between the previous generation's, so an older LoRA's block indices land on the wrong blocks of a newer model.
# Old block count -> (new block count, indices of the inserted blocks in the new model), from ComfyUI-Anima-Remap's expand manifests (MIT); 40 -> 52 is reconstructed there, not official.
ANIMA_EXPANSIONS = {
    28: (40, (2, 5, 8, 11, 14, 17, 21, 24, 27, 30, 33, 36)),
    40: (52, (3, 7, 11, 15, 19, 23, 27, 31, 35, 39, 43, 47)),
}

# The main block index in both LoRA key styles: `net.blocks.12.self_attn` and kohya's `lora_unet_blocks_12_self_attn`.
BLOCK_INDEX = re.compile(r"(?<=\.blocks\.)\d+(?=\.)|(?<=_blocks_)\d+(?=_)")


# llm_adapter has its own six blocks that no expansion has touched.
def _block_match(key):
    return None if "llm_adapter" in key else BLOCK_INDEX.search(key)


def lora_block_count(keys):
    indices = [int(m.group()) for m in map(_block_match, keys) if m]
    return max(indices) + 1 if indices else None


# Old block index -> new block index across every expansion between the two sizes, or None when no known chain connects them.
def anima_block_map(source, target):
    mapping = {i: i for i in range(source)}
    count = source
    while count < target and count in ANIMA_EXPANSIONS:
        count, inserted = ANIMA_EXPANSIONS[count]
        kept = [i for i in range(count) if i not in inserted]
        mapping = {old: kept[new] for old, new in mapping.items()}
    return mapping if count == target else None


def remap_lora_blocks(lora, mapping):
    out = {}
    for key, value in lora.items():
        m = _block_match(key)
        out[key if m is None else f"{key[:m.start()]}{mapping[int(m.group())]}{key[m.end():]}"] = value
    return out


# A LoRA that never touches the last blocks of its generation still belongs to the smallest generation that holds the blocks it does touch.
def lora_generation(block_count):
    sizes = sorted({*ANIMA_EXPANSIONS, *(new for new, _ in ANIMA_EXPANSIONS.values())})
    return next((size for size in sizes if size >= block_count), block_count)


# The LoRA as it has to be applied to this model: remapped when it was trained on an older, smaller Anima generation.
def match_anima_blocks(lora, model, name):
    import comfy.model_base
    anima = getattr(comfy.model_base, "Anima", None)
    if anima is None or not isinstance(getattr(model, "model", None), anima):
        return lora
    target = len(model.model.diffusion_model.blocks)
    source = lora_block_count(lora)
    if source is None:
        return lora
    # Never rounded past the model itself, whose size need not be a known generation.
    source = min(lora_generation(source), max(source, target))
    if source == target:
        return lora
    # ComfyUI would silently skip the blocks the model lacks and apply a broken remainder.
    if source > target:
        raise ValueError(f"trained on a {source}-block Anima model, this one has {target} blocks")
    mapping = anima_block_map(source, target)
    if mapping is None:
        return lora
    print(f"[EreNodes] Anima LoRA '{name}' remapped from {source} to {target} blocks")
    return remap_lora_blocks(lora, mapping)


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

    # Composed 28 -> 52 must equal ComfyUI-Anima-Remap's expand_manifest_28_52_composed.json.
    inserted_28_52 = {2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23, 27, 28, 31, 32, 35, 36, 39, 40, 43, 44, 47, 48}
    assert list(anima_block_map(28, 52).values()) == [i for i in range(52) if i not in inserted_28_52]
    assert anima_block_map(28, 40)[2] == 3 and anima_block_map(40, 40) == {i: i for i in range(40)}
    assert anima_block_map(27, 40) is None and anima_block_map(28, 30) is None

    lora = {"diffusion_model.blocks.27.mlp.layer1.lora_A.weight": 1, "lora_unet_blocks_2_self_attn_q_proj.lora_down.weight": 2,
            "diffusion_model.llm_adapter.blocks.5.cross_attn.lora_A.weight": 3, "diffusion_model.final_layer.lora_A.weight": 4}
    assert lora_block_count(lora) == 28
    assert [lora_generation(n) for n in (20, 28, 29, 40, 41, 60)] == [28, 28, 40, 40, 52, 60]
    assert remap_lora_blocks(lora, anima_block_map(28, 40)) == {"diffusion_model.blocks.39.mlp.layer1.lora_A.weight": 1, "lora_unet_blocks_3_self_attn_q_proj.lora_down.weight": 2,
                                                                  "diffusion_model.llm_adapter.blocks.5.cross_attn.lora_A.weight": 3, "diffusion_model.final_layer.lora_A.weight": 4}

    print("prompt_lora_loader self-check ok")
