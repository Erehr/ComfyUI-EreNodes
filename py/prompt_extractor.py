# Recover the positive prompt from a generated image.
#
# Three metadata dialects, tried in order: ComfyUI's `prompt` chunk (the executed graph), its `workflow` chunk (the editor graph — the only place our `_tagDataJSON` survives, so tags toggled *off* come back as inactive pills), then A1111 / Forge parameters in a PNG text chunk or EXIF UserComment.
#
# Deciding *which* text is the positive prompt is the hard part: the graph is traced back from a sampler's `positive` input, and anything reachable only from `negative` is excluded.
#
# Approach informed by RS Image-Prompt (ComfyUI_RaykoStudio, Apache-2.0).

import json
import os
import re

# The formats a dropped image may be in — the same list as the covers we store.
# See py/images.py, which owns it.
from .images import IMAGE_EXTENSIONS

# Node types known to hold prompt text.
# Anything else is still traced through, so unknown wrappers do not break the walk - this list only decides where a *search* (rather than a trace) is allowed to stop.
TEXT_NODE_TYPES = {
    "CLIPTextEncode",
    "CLIPTextEncodeSDXL",
    "CLIPTextEncodeSDXLRefiner",
    "CLIPTextEncodeFlux",
    "BNK_CLIPTextEncoder",
    "smZ CLIPTextEncode",
    "Text Multiline",
    "String Literal",
    "PrimitiveNode",
    "PrimitiveString",
    "PrimitiveStringMultiline",
    "ImpactWildcardProcessor",
    "ttN text",
    "easy positive",
    # Ours - these carry structured tag data as well as text.
    "ErePromptCloud",
    "ErePromptToggle",
    "ErePromptMultiSelect",
    "ErePromptRandomizer",
    "ErePromptGallery",
    "ErePromptMultiline",
    "ErePromptExtractor",
}

ERE_NODE_TYPES = {t for t in TEXT_NODE_TYPES if t.startswith("ErePrompt")}

# Inputs worth following when walking backwards towards the text.
TEXT_LINK_KEYS = (
    "text", "text_g", "text_l", "string", "prompt", "positive",
    "conditioning", "conditioning_1", "conditioning_2", "clip", "text_input",
    "populated_text", "wildcard_text",
)

# Widget/input names that hold prompt text, most specific first.
TEXT_VALUE_KEYS = ("text", "text_g", "string", "prompt", "populated_text", "value")

# PNG text chunks that A1111-style tools use.
# Deliberately excludes "prompt": that is ComfyUI's own graph chunk, handled in step 1, and treating it as free text meant a graph with no positive prompt returned its raw JSON.
A1111_KEYS = ("parameters", "Comment", "Description")


# A1111 / EXIF

def _looks_like_settings(line):
    keys = ("Steps:", "Sampler:", "CFG scale:", "Seed:", "Size:", "Model hash:",
            "Model:", "Denoising strength:", "Clip skip:", "VAE:", "Version:",
            "Schedule type:", "Hires upscale:", "TI hashes:", "Lora hashes:")
    return any(k in line for k in keys)


# Strip the negative prompt and trailing settings from an A1111 blob.
def clean_a1111_text(text):
    if not isinstance(text, str):
        return ""
    text = text.strip()
    if not text:
        return ""

    # Some tools stash a whole ComfyUI graph in `parameters`.
    # If it parses as a graph, its extraction result is final — falling through would return the raw JSON as if it were a prompt.
    if text.startswith("{"):
        try:
            return extract_from_prompt_graph(json.loads(text))
        except (json.JSONDecodeError, TypeError, ValueError):
            pass

    index = text.find("Negative prompt:")
    if index != -1:
        text = text[:index]

    lines = text.split("\n")
    while lines and _looks_like_settings(lines[-1]):
        lines.pop()
    return "\n".join(lines).strip()


# EXIF UserComment carries an 8-byte encoding prefix.
def decode_user_comment(data):
    if isinstance(data, str):
        return data
    if not isinstance(data, (bytes, bytearray)):
        return str(data)

    if data.startswith(b"ASCII\x00\x00\x00"):
        return data[8:].decode("latin-1", errors="replace")
    if data.startswith(b"UNICODE\x00"):
        return data[8:].decode("utf-16", errors="replace")
    if data.startswith(b"JIS\x00\x00\x00\x00\x00"):
        return data[8:].decode("shift_jis", errors="replace")

    for encoding in ("utf-8", "latin-1"):
        try:
            return data.decode(encoding)
        except (UnicodeDecodeError, UnicodeError):
            continue
    return data.decode("latin-1", errors="replace")


def _exif_user_comment(pil_image):
    try:
        exif = pil_image.getexif()
        if not exif:
            return ""
        exif_ifd = exif.get_ifd(0x8769)      # ExifOffset
        if not exif_ifd:
            return ""
        return decode_user_comment(exif_ifd.get(0x9286) or b"")   # UserComment
    except Exception as e:
        print(f"[EreNodes] EXIF read failed: {e}")
        return ""


# API Graph Walk

# A graph input reference looks like ["<node id>", <slot>].
def _is_link(value):
    return isinstance(value, list) and len(value) >= 1


# Gather every text segment feeding a node, in output order.
#
# EreNodes chain through `prefix`, each emitting `prefix + separator + text`, so the whole chain must be walked — not just the node the sampler points at.
def _collect_api_segments(graph, node_id, visited, out):
    node_id = str(node_id)
    if node_id in visited or node_id not in graph:
        return
    visited.add(node_id)

    node = graph[node_id]
    if not isinstance(node, dict):
        return
    inputs = node.get("inputs", {})

    # Upstream prefix first: it precedes this node's own text in the result.
    prefix = inputs.get("prefix")
    if _is_link(prefix):
        _collect_api_segments(graph, prefix[0], visited, out)

    # This node's own text, either literal or coming down a link.
    for key in TEXT_VALUE_KEYS:
        value = inputs.get(key)
        if isinstance(value, str) and value.strip():
            out.append({"text": value})
            return
        if _is_link(value) and key in ("text", "text_g", "string", "prompt"):
            _collect_api_segments(graph, value[0], visited, out)
            return

    # Nothing of its own - keep walking towards whatever feeds it.
    for key in TEXT_LINK_KEYS:
        ref = inputs.get(key)
        if _is_link(ref):
            before = len(out)
            _collect_api_segments(graph, ref[0], visited, out)
            if len(out) > before:
                return


# Every node reachable from some node's `negative` input.
#
# Transitive: the text node feeding a negative CLIPTextEncode is negative too.
def _negative_node_ids(graph):
    seeds = []
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ref = node.get("inputs", {}).get("negative")
        if _is_link(ref):
            seeds.append(str(ref[0]))

    negatives = set()
    stack = list(seeds)
    while stack:
        node_id = stack.pop()
        if node_id in negatives or node_id not in graph:
            continue
        negatives.add(node_id)
        node = graph[node_id]
        if not isinstance(node, dict):
            continue
        for value in node.get("inputs", {}).values():
            if _is_link(value):
                stack.append(str(value[0]))
    return negatives


# Nodes that some other node actually consumes.
#
# Rejects prompt nodes left unconnected in the workflow — they did not contribute to the image.
def _referenced_node_ids(graph):
    referenced = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        for value in node.get("inputs", {}).values():
            if _is_link(value):
                referenced.add(str(value[0]))
    return referenced


# Positive prompt segments from ComfyUI's executed (API) graph.
#
# Returns a list of `{"text": str}` segments in prompt order.
def extract_from_prompt_graph(graph):
    if not isinstance(graph, dict):
        return []

    # Preferred: trace back from a `positive` input.
    # That is the only reading that cannot confuse a negative or an unconnected leftover for the prompt.
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ref = node.get("inputs", {}).get("positive")
        if _is_link(ref):
            segments = []
            _collect_api_segments(graph, ref[0], set(), segments)
            if segments:
                return segments

    # Fallback for graphs with no `positive` input at all (some custom samplers name it differently).
    # A candidate must be *wired into* the graph and not part of the negative branch - an unconnected node sitting in the background is not what produced the image.
    negatives = _negative_node_ids(graph)
    connected = _referenced_node_ids(graph)
    for node_id, node in graph.items():
        node_id = str(node_id)
        if not isinstance(node, dict) or node_id in negatives or node_id not in connected:
            continue
        if node.get("class_type") in TEXT_NODE_TYPES:
            segments = []
            _collect_api_segments(graph, node_id, set(), segments)
            if segments:
                return segments
    return []


# Editor Graph Walk

def _widget_text(node):
    values = node.get("widgets_values")
    if isinstance(values, dict):
        for key in TEXT_VALUE_KEYS:
            value = values.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return ""
    if isinstance(values, list):
        for value in values:
            if isinstance(value, str) and value.strip() and not value.startswith("["):
                return value
    return ""


# Structured tags stored by our own nodes, inactive entries included.
#
# `_tagDataJSON` keeps type, strength and active state, so a tag switched off comes back as an inactive pill.
def _ere_tags(node):
    properties = node.get("properties")
    if not isinstance(properties, dict):
        return None
    raw = properties.get("_tagDataJSON")
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        tags = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(tags, list):
        return None
    return [t for t in tags if isinstance(t, dict) and t.get("name")]


# Positive prompt segments from the editor graph, in prompt order.
#
# Each is `{"tags": [...]}` (an EreNodes node, so strengths and inactive entries survive) or `{"text": str}`.
def extract_from_workflow_graph(workflow):
    if not isinstance(workflow, dict):
        return []

    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        return []

    by_id = {str(n["id"]): n for n in nodes if isinstance(n, dict) and "id" in n}

    # links: [id, origin_node, origin_slot, target_node, target_slot, type]
    source_of = {}
    for link in workflow.get("links", []) or []:
        if isinstance(link, list) and len(link) >= 5:
            source_of[(str(link[3]), link[4])] = str(link[1])

    def input_index(node, name):
        for index, spec in enumerate(node.get("inputs", []) or []):
            if isinstance(spec, dict) and spec.get("name") == name:
                return index
        return None

    def input_name(node, index):
        specs = node.get("inputs", []) or []
        spec = specs[index] if index < len(specs) else None
        return spec.get("name") if isinstance(spec, dict) else None

    # Input indices with the text-bearing ones first.
    # Slot order is not priority order: a CLIPTextEncode has `clip` at slot 0, and following that wire reaches whatever produced the CLIP - a LoRA scheduler fed by the same prompt chain - which then answers for the whole node and the real `text` wire is never tried.
    def ordered_inputs(node):
        specs = node.get("inputs", []) or []
        named = {}
        for index, spec in enumerate(specs):
            if isinstance(spec, dict) and spec.get("name"):
                named.setdefault(spec["name"], index)
        order = [named[k] for k in TEXT_LINK_KEYS if k in named]
        return order + [i for i in range(len(specs)) if i not in order]

    def collect(node_id, slot, visited, out):
        key = (node_id, slot)
        if key in visited:
            return
        visited.add(key)

        source_id = source_of.get(key)
        if not source_id:
            return
        node = by_id.get(source_id)
        if not node:
            return

        node_type = str(node.get("type", ""))
        order = ordered_inputs(node)

        # Upstream prefix first - it precedes this node's own contribution.
        prefix_index = input_index(node, "prefix")
        if prefix_index is not None:
            collect(source_id, prefix_index, visited, out)

        if node_type in ERE_NODE_TYPES:
            tags = _ere_tags(node)
            if tags:
                out.append({"tags": tags})
            return
        if node_type in TEXT_NODE_TYPES:
            # A text widget converted to an input keeps its old value in widgets_values, so a wired input always wins over the stored string.
            wired = next((i for i in order
                          if input_name(node, i) in ("text", "text_g", "string", "prompt")
                          and (source_id, i) in source_of), None)
            if wired is not None:
                collect(source_id, wired, visited, out)
                return
            text = _widget_text(node)
            if text:
                out.append({"text": text})
                return

        # Pass-through node: keep looking through its other inputs.
        for index in order:
            if index == prefix_index:
                continue
            before = len(out)
            collect(source_id, index, visited, out)
            if len(out) > before:
                return

    def from_positive(node_id, node):
        index = input_index(node, "positive")
        if index is None:
            return []
        segments = []
        collect(node_id, index, set(), segments)
        return segments

    # Samplers first, tracing their `positive` input.
    for node_id, node in by_id.items():
        node_type = str(node.get("type", ""))
        if "ampler" not in node_type and "Guider" not in node_type:
            continue
        segments = from_positive(node_id, node)
        if segments:
            return segments

    # Then anything at all with a `positive` input (ControlNet stacks, etc).
    for node_id, node in by_id.items():
        segments = from_positive(node_id, node)
        if segments:
            return segments

    return []


# Entry Point

# Shape a segment list into the API response.
#
# `segments` is the authoritative, ordered form.
# `text` and `tags` are conveniences for the simple single-source cases and for error reporting.
def _segments_result(segments, source):
    tag_segments = [s for s in segments if s.get("tags")]
    text_segments = [s for s in segments if s.get("text")]
    return {
        "segments": segments,
        # Only meaningful when nothing structured was found.
        "text": "" if tag_segments else "\n".join(s["text"] for s in text_segments),
        "tags": None,
        "source": source,
    }


# Read an image and return the prompt as ordered segments.
#
# `{"segments": [{"tags"} | {"text"}], "text": str, "source": str}`, upstream prefix first.
def extract_from_image(path):
    try:
        from PIL import Image
    except ImportError:
        return {"segments": [], "text": "", "tags": None, "source": "",
                "error": "Pillow is not installed"}

    try:
        with Image.open(path) as image:
            info = dict(image.info or {})
            exif_text = _exif_user_comment(image)
    except Exception as e:
        return {"segments": [], "text": "", "tags": None, "source": "",
                "error": f"Cannot read image: {e}"}

    # The editor graph is tried first when it contains our nodes, because it is the only source that keeps strengths and inactive tags.
    # It is also the only place a chain is visible as separate nodes rather than as one already-flattened string.
    workflow_segments = []
    raw_workflow = info.get("workflow")
    if isinstance(raw_workflow, str) and raw_workflow.strip():
        try:
            workflow_segments = extract_from_workflow_graph(json.loads(raw_workflow))
        except (json.JSONDecodeError, TypeError):
            workflow_segments = []
    if any(s.get("tags") for s in workflow_segments):
        return _segments_result(workflow_segments, "erenodes-workflow")

    # Executed graph: authoritative about what actually ran.
    raw_prompt = info.get("prompt")
    if isinstance(raw_prompt, str) and raw_prompt.strip():
        try:
            segments = extract_from_prompt_graph(json.loads(raw_prompt))
            if segments:
                return _segments_result(segments, "comfy-prompt")
        except (json.JSONDecodeError, TypeError):
            pass

    if workflow_segments:
        return _segments_result(workflow_segments, "comfy-workflow")

    # A1111 style.
    for key in A1111_KEYS:
        value = info.get(key)
        if isinstance(value, str) and value.strip():
            text = clean_a1111_text(value)
            if text:
                return _segments_result([{"text": text}], f"a1111:{key}")

    if exif_text:
        text = clean_a1111_text(exif_text)
        if text:
            return _segments_result([{"text": text}], "exif")

    return {"segments": [], "text": "", "tags": None, "source": "",
            "error": "No prompt metadata found in this image."}
