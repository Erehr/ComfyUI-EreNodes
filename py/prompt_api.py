import asyncio
import hashlib
import json
import os
import re
import shutil
import server
import folder_paths
from aiohttp import web
from safetensors import safe_open
from .prompt_csv import CSV_FILES_PATH, TAG_DATA_CACHE
from .settings import get_erenodes_settings, save_erenodes_settings
from . import paths
from . import images
from . import tag_index
from .paths import (
    IMAGE_EXTENSIONS,
    LOCATION_NODE,
    LOCATION_MODELS,
    VALID_LOCATIONS,
    get_prompts_dir,
    is_within,
)


# Tag Group API Endpoints
#
# No module-level `prompts_dir`: the root is a user setting, so handlers call get_prompts_dir() and the toggle takes effect without a restart.


# Strip characters that are unsafe in a filename.
# Spaces and underscores stay.
def sanitize_filename(filename):
    filename = re.sub(r'[\/:*?"<>|]', '_', filename)
    filename = filename.replace('..', '_')
    return filename.strip()


@server.PromptServer.instance.routes.post("/erenodes/set_setting")
async def set_setting_handler(request):
    data = await request.json()
    key = data.get("key")
    value = data.get("value")

    if key is None:
        return web.json_response({"status": "error", "message": "Setting 'key' not provided"}, status=400)

    settings = get_erenodes_settings()
    settings[key] = value
    save_erenodes_settings(settings)

    # Invalidate the tag cache so it lazy-reloads on the next search.
    if key == "autocomplete.csv":
        TAG_DATA_CACHE.pop(value, None)

    return web.json_response({"status": "ok"})

@server.PromptServer.instance.routes.get("/erenodes/list_csv_files")
async def list_csv_files_handler(request):
    if not os.path.isdir(CSV_FILES_PATH):
        return web.json_response([])
    
    files = [f for f in os.listdir(CSV_FILES_PATH) if f.endswith(".csv")]
    return web.json_response(files)

# Report which of the given tags point at a file on disk.
#
# Takes {"items": [{"name", "type", "extension"}]} and returns {"exists": {"<type>:<name>": bool}}, keyed as sent.
@server.PromptServer.instance.routes.post("/erenodes/check_files")
async def check_files_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    items = data.get("items")
    if not isinstance(items, list):
        return web.json_response({"error": "items must be a list"}, status=400)
    # A node holds tens of pills, not thousands.
    if len(items) > 500:
        return web.json_response({"error": "Too many items"}, status=400)

    exists = {}
    configs = {}      # get_type_config resolves roots per call; cache them here

    for item in items:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip()
        file_type = item.get("type")
        if not name or file_type not in ("lora", "embedding", "group"):
            continue

        key = f"{file_type}:{name}"
        if key in exists:
            continue

        if file_type not in configs:
            configs[file_type] = get_type_config(file_type)
        config = configs[file_type]
        if not config or not config["roots"]:
            # No folder configured, so we cannot tell — do not accuse it.
            exists[key] = True
            continue

        # An explicit extension wins.
        # Without one, try the bare name first: a lora recovered from prompt text carries its extension inside the name (`style.safetensors`), so appending another would probe `style.safetensors.safetensors`.
        extension = item.get("extension")
        candidates = (extension,) if extension else ("",) + tuple(config["extensions"])

        found = False
        for root in config["roots"]:
            abs_root = os.path.abspath(root)
            for ext in candidates:
                # `name` is client-supplied: check containment before probing.
                candidate = os.path.normpath(os.path.join(abs_root, name + (ext or "")))
                if not is_within(abs_root, candidate):
                    continue
                if os.path.isfile(candidate):
                    found = True
                    break
            if found:
                break
        exists[key] = found

    return web.json_response({"exists": exists})


@server.PromptServer.instance.routes.get("/erenodes/get_tag_group")
async def get_tag_group_handler(request):
    filename_param = request.query.get("filename")

    if not filename_param:
        return web.json_response({"message": "Filename not provided"}, status=400)

    safe_filename = filename_param.lstrip('/').lstrip('\\')
    safe_filename = safe_filename.replace("..", "_")

    if os.path.isabs(safe_filename):
        safe_filename = os.path.basename(safe_filename)

    prompts_dir = get_prompts_dir()
    file_path = os.path.abspath(os.path.join(prompts_dir, safe_filename))

    if not is_within(prompts_dir, file_path):
        return web.json_response({"error": "Forbidden path"}, status=403)

    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        return web.json_response({"error": "Tag group not found"}, status=404)

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return web.json_response(data)
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON format in tag group file"}, status=500)
    except Exception as e:
        return web.json_response({"error": f"Error reading file: {str(e)}"}, status=500)

@server.PromptServer.instance.routes.post("/erenodes/save_tag_group")
async def save_tag_group_handler(request):
    try:
        form_data = await request.post()

        filename = form_data.get("filename")
        tags_json_str = form_data.get("tags_json")
        path_param = form_data.get("path", "")
        image_file_field = form_data.get("image_file", None)

        if not filename or tags_json_str is None:
            return web.json_response({"message": "Filename or tags_json not provided"}, status=400)

        safe_path_param = path_param.lstrip('/').lstrip('\\').replace("..", "_")
        prompts_dir = get_prompts_dir()
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not is_within(prompts_dir, target_dir):
            return web.json_response({"error": "Forbidden save path"}, status=403)

        os.makedirs(target_dir, exist_ok=True)
        safe_filename = sanitize_filename(os.path.basename(filename))
        if not safe_filename.lower().endswith(".json"):
            safe_filename += ".json"

        file_path = os.path.join(target_dir, safe_filename)

        if os.path.isdir(file_path):
            return web.json_response({"message": "A directory with this name already exists at the target location."}, status=400)

        tags_data = json.loads(tags_json_str)
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(tags_data, f, indent=2)

        message = f"Tag group '{os.path.join(safe_path_param, safe_filename) if safe_path_param else safe_filename}' saved successfully."

        # Save associated cover if provided.
        # Stored as WebP at a fixed width - see py/images.py for why.
        if image_file_field and hasattr(image_file_field, 'file') and image_file_field.file:
            try:
                basename = os.path.splitext(safe_filename)[0]
                written = images.save_preview_image(image_file_field.file, target_dir, basename)
                # A legacy cover.png beside the new cover.webp would keep being served, since view_file_handler probes extensions in order.
                images.remove_other_previews(target_dir, basename, written)
                message += f" Cover '{written}' also saved."
            except Exception as e:
                # The tag group itself saved fine; report why the image did not instead of swallowing the reason.
                print(f"[EreNodes] Failed to save preview image for '{safe_filename}': {e}")
                message += f" Failed to save cover: {e}"
        elif image_file_field is not None:
            # A value was posted under "image_file" but it is not a file part (no .file attribute) - e.g. an empty string from an untouched form field.
            # Say so rather than hinting at a mystery failure.
            message += " (Ignored 'image_file': not an uploaded file.)"

        return web.json_response({"message": message})
    except json.JSONDecodeError:
        return web.json_response({"message": "Invalid JSON format for tags_json."}, status=400)
    except Exception as e:
        print(f"[EreNodes] save_tag_group failed: {e}")
        return web.json_response({"error": "Internal server error"}, status=500)


# Tag Group Location

# Current location plus both resolved paths, so the settings UI can show where things actually are without guessing at the install layout.
# Switch between the two allowed roots.
#
# Keywords only: no way to name an arbitrary directory over HTTP.
# A different disk goes in extra_model_paths.yaml.
@server.PromptServer.instance.routes.post("/erenodes/set_tag_groups_location")
async def set_tag_groups_location_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    location = data.get("location")
    if location not in VALID_LOCATIONS:
        return web.json_response(
            {"error": f"location must be one of {list(VALID_LOCATIONS)}"}, status=400
        )

    previous = paths.get_location()
    target = paths.dir_for_location(location)

    try:
        os.makedirs(target, exist_ok=True)
    except Exception as e:
        return web.json_response(
            {"error": f"Could not create '{target}': {e}"}, status=500
        )
    if not os.access(target, os.W_OK):
        return web.json_response({"error": f"'{target}' is not writable"}, status=500)

    settings = get_erenodes_settings()
    settings["tag_groups.location"] = location
    save_erenodes_settings(settings)

    other = paths.dir_for_location(previous)
    return web.json_response({
        "ok": True,
        "location": location,
        "previous": previous,
        "resolved": target,
        # How many groups are still sitting in the location we just left, so the client can offer to copy them across.
        "legacy_count": paths.count_tag_groups(other) if previous != location else 0,
    })


# Copy tag groups from one location to the other.
# Never overwrites, never deletes - the source folder is left intact as a backup.
@server.PromptServer.instance.routes.post("/erenodes/migrate_tag_groups")
async def migrate_tag_groups_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    src_key = data.get("from")
    dst_key = data.get("to", paths.get_location())
    if src_key not in VALID_LOCATIONS or dst_key not in VALID_LOCATIONS:
        return web.json_response(
            {"error": f"from/to must be one of {list(VALID_LOCATIONS)}"}, status=400
        )
    if src_key == dst_key:
        return web.json_response({"copied": 0, "skipped": 0})

    copied, skipped = paths.copy_tag_groups(
        paths.dir_for_location(src_key), paths.dir_for_location(dst_key)
    )
    return web.json_response({"copied": copied, "skipped": skipped})


# LORA API Endpoints

# Model folders for a type. folder_paths already merges extra_model_paths.yaml.
def get_model_paths(model_type):
    try:
        return [p for p in folder_paths.get_folder_paths(model_type) if os.path.isdir(p)]
    except Exception:
        return []

@server.PromptServer.instance.routes.get("/erenodes/get_lora_metadata")
async def get_lora_metadata_handler(request):
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"error": "Filename not provided"}, status=400)

    try:
        lora_path = folder_paths.get_full_path("loras", filename) or folder_paths.get_full_path("loras_old", filename)
        if not lora_path:
            return web.json_response({"error": "Lora not found in any known folder"}, status=404)

        # Same guard as save_file_image, for the same reason: `filename` is client-supplied. folder_paths.get_full_path sanitises in current ComfyUI, but it has not always, and this endpoint reads a file and returns part of its contents.
        roots = get_model_paths("loras") + get_model_paths("loras_old")
        if not any(is_within(os.path.abspath(root), lora_path) for root in roots):
            return web.json_response({"error": "Forbidden path"}, status=403)

        # File reads (especially safetensors header reads on large files) are blocking - run them in a thread so the server event loop stays free.
        tags = await asyncio.to_thread(_read_lora_tags, lora_path)
        return web.json_response(tags)
    except Exception as e:
        return web.json_response({"error": "Failed to read LoRA metadata: " + str(e)}, status=500)


def _read_lora_tags(lora_path):
    tags = []

    # From companion JSON (<file>.metadata.json) -> civitai.trainedWords
    try:
        md_path = os.path.splitext(lora_path)[0] + ".metadata.json"
        if os.path.isfile(md_path):
            with open(md_path, 'r', encoding='utf-8') as jf:
                data = json.loads(jf.read())
            tags += data['civitai']['trainedWords']
    except Exception:
        pass

    # From LoRA file metadata -> ss_tag_frequency (first 20)
    try:
        with safe_open(lora_path, framework="pt", device="cpu") as f:
            meta = f.metadata() or {}
        if 'ss_tag_frequency' in meta and isinstance(meta['ss_tag_frequency'], str):
            try:
                freq = json.loads(meta['ss_tag_frequency'])
                tags += (
                    [k for v in (freq.values() if isinstance(freq, dict) else []) if isinstance(v, dict) for k in v.keys()]
                    if isinstance(freq, dict) else freq
                )[:20]
            except Exception:
                pass
    except Exception:
        pass

    return tags

# Unified File Search API Endpoint

# Roots + extensions for a browsable file type, or None if unknown.
#
# Resolved per call, not cached: the tag-group root follows a live setting and model roots can change when extra_model_paths is reloaded.
def get_type_config(file_type):
    if file_type == 'lora':
        return {'roots': get_model_paths("loras"),
                'extensions': ('.safetensors', '.pt', '.ckpt', '.lora')}
    if file_type == 'embedding':
        return {'roots': get_model_paths("embeddings"),
                'extensions': ('.pt', '.bin', '.safetensors', '.embedding')}
    if file_type == 'group':
        return {'roots': [get_prompts_dir()], 'extensions': ('.json',)}
    return None


@server.PromptServer.instance.routes.get("/erenodes/search_files")
async def search_files_handler(request):
    raw_query = request.query.get("query", "")
    path_param = request.query.get("path", "")
    file_type = request.query.get("type")
    


    if not file_type:
        return web.json_response({"error": "File type not provided"}, status=400)

    config = get_type_config(file_type)
    if not config:
        return web.json_response({"error": f"Invalid file type: {file_type}"}, status=400)
    
    collection_paths = config['roots']
    extensions = config['extensions']

    potential_nav_folder = ""
    actual_search_query = raw_query.lower()

    if raw_query.endswith('/') or raw_query.endswith('\\'):
        potential_nav_folder = os.path.normpath(raw_query.strip('/\\'))
        actual_search_query = ""
        if path_param:
            path_param = os.path.join(path_param, potential_nav_folder)
        else:
            path_param = potential_nav_folder
    
    query = actual_search_query

    try:
        if not collection_paths:
            return web.json_response({"items": [], "parentPath": path_param if path_param else ""})

        items = []
        found_relative_paths = set()

        scan_target_abs = None
        current_collection_root_abs = None

        # (scan target, collection root) pairs: a given path resolves against whichever root contains it; no path scans every root, since loras can live in several via extra_model_paths.yaml.
        if path_param:
            normalized_path_param = os.path.normpath(path_param.lstrip('/').lstrip('\\'))
            for root in collection_paths:
                abs_root = os.path.abspath(root)
                potential_scan_path = os.path.abspath(os.path.join(abs_root, normalized_path_param))
                if os.path.isdir(potential_scan_path) and is_within(abs_root, potential_scan_path):
                    scan_target_abs = potential_scan_path
                    current_collection_root_abs = abs_root
                    break
            if not scan_target_abs:
                return web.json_response({"items": [], "parentPath": path_param})
            scan_targets = [(scan_target_abs, current_collection_root_abs)]
        else:
            scan_targets = [(os.path.abspath(r), os.path.abspath(r)) for r in collection_paths]

        for current_scan_target, current_collection_root_abs in scan_targets:
            if not os.path.exists(current_scan_target):
                continue

            for dirpath, dirnames_orig, filenames in os.walk(current_scan_target, topdown=True):
                 is_current_scan_level = (os.path.normpath(dirpath) == os.path.normpath(current_scan_target))

                 # Process files
                 for filename in filenames:
                     if filename.lower().endswith(extensions):
                         filename_no_ext, file_ext = os.path.splitext(filename)
                         full_file_path_abs = os.path.join(dirpath, filename)
                         relative_to_collection_root = os.path.relpath(full_file_path_abs, current_collection_root_abs)
                         prompt_path = os.path.splitext(relative_to_collection_root)[0]

                         item_data = {"name": filename_no_ext, "type": file_type, "path": prompt_path, "extension": file_ext}

                         if query:
                             if query in filename_no_ext.lower() or query in prompt_path.lower():
                                 if prompt_path not in found_relative_paths:
                                     items.append(item_data)
                                     found_relative_paths.add(prompt_path)
                         else:
                             if is_current_scan_level:
                                 if prompt_path not in found_relative_paths:
                                     items.append(item_data)
                                     found_relative_paths.add(prompt_path)
                 
                 # Process folders
                 current_level_dirnames_to_process = list(dirnames_orig)
                 dirnames_orig[:] = []

                 for dirname in current_level_dirnames_to_process:
                     if dirname.startswith('.') or dirname == "__pycache__":
                         continue

                     full_folder_path_abs = os.path.join(dirpath, dirname)
                     relative_to_collection_root = os.path.relpath(full_folder_path_abs, current_collection_root_abs)


                     if query:
                         if query in dirname.lower():
                             if relative_to_collection_root not in found_relative_paths:
                                 items.append({"name": dirname, "type": "folder", "path": relative_to_collection_root})
                                 found_relative_paths.add(relative_to_collection_root)
                         dirnames_orig.append(dirname)
                     else:
                         if is_current_scan_level:
                            if relative_to_collection_root not in found_relative_paths:
                                items.append({"name": dirname, "type": "folder", "path": relative_to_collection_root})
                                found_relative_paths.add(relative_to_collection_root)

        items.sort(key=lambda x: (x["type"] != "folder", x["name"].lower()))
        
        # Handle path information for response
        if path_param:
            current_relative_path_for_client = os.path.relpath(scan_target_abs, current_collection_root_abs)
            if current_relative_path_for_client == '.':
                current_relative_path_for_client = ""
            parent_path_for_client = ""
            if current_relative_path_for_client:
                parent_path_for_client = os.path.dirname(current_relative_path_for_client)
                if parent_path_for_client == '.':
                    parent_path_for_client = ""
        else:
            # When scanning all paths, we're at the root level
            current_relative_path_for_client = ""
            parent_path_for_client = ""
        
        response_data = {
            "items": items,
            "currentPath": current_relative_path_for_client,
            "parentPath": parent_path_for_client
        }
        
        return web.json_response(response_data)

    except Exception as e:
        return web.json_response({"items": [], "parentPath": path_param if path_param else "", "error": str(e)}, status=500)


@server.PromptServer.instance.routes.post("/erenodes/create_folder")
async def create_folder_handler(request):
    try:
        data = await request.json()
        path_param = data.get("path", "")
        folder_name = data.get("folderName")

        if not folder_name:
            return web.json_response({"message": "Folder name not provided"}, status=400)

        safe_path_param = path_param.lstrip('/').lstrip('\\').replace("..", "_")
        prompts_dir = get_prompts_dir()
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not is_within(prompts_dir, target_dir):
            return web.json_response({"error": "Forbidden path"}, status=403)

        safe_folder_name = sanitize_filename(folder_name)
        new_folder_path = os.path.join(target_dir, safe_folder_name)

        if os.path.exists(new_folder_path):
            return web.json_response({"message": "A folder or file with this name already exists."}, status=409)

        os.makedirs(new_folder_path)
        return web.json_response({"message": "Folder created successfully."})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.get("/erenodes/view/{type}/{path:.*}")
async def view_file_handler(request):
    type_name = request.match_info.get("type")
    path_param = request.match_info.get("path")

    if not type_name or not path_param:
        return web.Response(status=400, text="Missing type or path")

    # Accept optional sizing params for cache-key stability on the client.
    # We do not resize server-side (no extra deps), but presence of w/h/fit in the URL should not cause 404 when an image exists.
    _w = request.query.get("w")
    _h = request.query.get("h")
    _fit = request.query.get("fit")

    # Determine base directories
    if type_name == 'group':
        # get_prompts_dir() returns an absolute path.
        base_dirs = [get_prompts_dir()]
    else:
        # folder_paths uses plural for loras, embeddings, etc.
        base_dirs = get_model_paths(type_name + 's')

    if not base_dirs:
        return web.Response(status=404, text=f"No folder configured for type '{type_name}'")

    # This is a basic sanitization.
    # The check below is more robust.
    # It prevents using '..' to escape the intended directories.
    path_param = path_param.replace("..", "_")

    potential_extensions = IMAGE_EXTENSIONS

    for root_dir in base_dirs:
        abs_root_dir = os.path.abspath(root_dir)
        # The path_param is the path to the main file, *without* its extension.
        # It's what we use as the base for finding a preview image.
        prospective_path_base = os.path.join(abs_root_dir, path_param)

        # Security check: ensure the requested path is within the intended directory (see is_within — a sibling dir like ".../loras_x" must not pass a ".../loras" check).
        if is_within(abs_root_dir, prospective_path_base):
            # Check for both filename.extension and filename.preview.extension patterns
            for ext in potential_extensions:
                # First try: filename.extension (original pattern)
                image_path = prospective_path_base + ext
                if os.path.isfile(image_path):
                    # If sizing params provided, still return the original file.
                    # Client uses params for cache-key uniqueness; server does not resize.
                    return web.FileResponse(image_path)
                
                # Second try: filename.preview.extension (new pattern)
                preview_image_path = prospective_path_base + '.preview' + ext
                if os.path.isfile(preview_image_path):
                    return web.FileResponse(preview_image_path)
    
    # If we get here, no file was found in any of the directories Return 204 No Content to indicate "no preview available" without error noise.
    return web.Response(status=204)

@server.PromptServer.instance.routes.post("/erenodes/save_file_image")
async def save_file_image_handler(request):
    try:
        form_data = await request.post()
        file_type = form_data.get("type")
        file_name = form_data.get("name")
        image_file_field = form_data.get("image_file", None)

        if not file_type or not file_name or not image_file_field:
            return web.json_response({"error": "Type, name, or image file not provided"}, status=400)

        if not hasattr(image_file_field, 'file') or not image_file_field.file:
            return web.json_response({"error": "Invalid image file"}, status=400)

        # Determine the base directory based on file type
        type_configs = {
            'lora': {
                'roots': get_model_paths("loras"),
                'extensions': ('.safetensors', '.pt', '.ckpt', '.lora'),
            },
            'embedding': {
                'roots': get_model_paths("embeddings"),
                'extensions': ('.pt', '.bin', '.safetensors', '.embedding'),
            },
            'group': {
                'roots': [get_prompts_dir()],
                'extensions': ('.json',),
            }
        }

        config = type_configs.get(file_type)
        if not config:
            return web.json_response({"error": f"Invalid file type: {file_type}"}, status=400)

        # `name` is client-supplied, so check containment against the root it resolved under before probing — is_within, not startswith, so a sibling like ".../loras_backup" cannot pass a ".../loras" check.
        file_path = None
        for root_dir in config['roots']:
            abs_root = os.path.abspath(root_dir)
            for ext in config['extensions']:
                potential_path = os.path.normpath(os.path.join(abs_root, file_name + ext))
                if not is_within(abs_root, potential_path):
                    continue
                if os.path.exists(potential_path):
                    file_path = potential_path
                    break
            if file_path:
                break

        if not file_path:
            return web.json_response({"error": f"File not found: {file_name}"}, status=404)

        file_dir = os.path.dirname(file_path)
        file_basename = os.path.splitext(os.path.basename(file_path))[0]

        try:
            image_filename = images.save_preview_image(image_file_field.file, file_dir, file_basename)
        except images.PreviewError as e:
            return web.json_response({"error": str(e)}, status=400)
        images.remove_other_previews(file_dir, file_basename, image_filename)

        message = f"Cover '{image_filename}' saved for {file_type} '{file_name}'."
        return web.json_response({"message": message})

    except Exception:
        return web.json_response({"error": "Internal server error"}, status=500)


# Remove a tag group's cover image.
#
# Tag groups only: lora and embedding covers live in the model folders and are shared with every other tool that reads them.
@server.PromptServer.instance.routes.post("/erenodes/delete_file_image")
async def delete_file_image_handler(request):
    try:
        data = await request.json()
        name = (data.get("name") or "").strip()
        if data.get("type") != "group":
            return web.json_response({"error": "Only tag group covers can be removed"}, status=400)
        if not name:
            return web.json_response({"error": "Name not provided"}, status=400)

        root = get_prompts_dir()
        target = os.path.normpath(os.path.join(root, name))
        if not is_within(root, target):
            return web.json_response({"error": "Invalid path"}, status=400)
        if not os.path.isfile(target + ".json"):
            return web.json_response({"error": f"Tag group not found: {name}"}, status=404)

        # keep="" matches nothing, so every extension is swept.
        images.remove_other_previews(os.path.dirname(target), os.path.basename(target), "")
        return web.json_response({"message": f"Cover removed for '{name}'."})

    except Exception:
        return web.json_response({"error": "Internal server error"}, status=500)


# Sidebar API Endpoints
#
# Whole-tree data, one request instead of one per folder.
# The sidebar filters that tree itself: searching the tags inside each group meant reading every file on every keystroke, and matched so broadly that a character name was buried under every group mentioning it in passing.


def _tree_excluded(name):
    return name.startswith('.') or name == "__pycache__"


# Nested {folders, files} for one collection root.
#
# Paths in the result are relative to the root and always forward-slashed, so the client can use them directly in URLs regardless of host OS.
# scandir, not listdir: the directory entry already says whether it is a directory, so this avoids a stat per file.
# Over 36k tag groups that is the difference between a fraction of a second and a few seconds, and the gap is widest on Windows, where each stat is a full file open.
#
# depth 0 means the whole tree; depth 1 stops at this level, listing each folder with empty contents.
def _build_tree(root, extensions, rel="", depth=0):
    abs_dir = os.path.join(root, rel) if rel else root
    folders, files = [], []
    try:
        with os.scandir(abs_dir) as scan:
            entries = sorted(scan, key=lambda e: e.name.lower())
    except OSError:
        return {"folders": folders, "files": files}

    for entry in entries:
        name = entry.name
        child_rel = f"{rel}/{name}" if rel else name
        try:
            is_dir = entry.is_dir()
        except OSError:
            continue
        if is_dir:
            if _tree_excluded(name):
                continue
            sub = ({"folders": [], "files": []} if depth == 1
                   else _build_tree(root, extensions, child_rel, max(depth - 1, 0)))
            folders.append({
                "name": name, "path": child_rel.replace(os.sep, '/'),
                "type": "folder", **sub,
            })
        elif name.lower().endswith(extensions):
            stem, ext = os.path.splitext(name)
            files.append({
                "name": stem,
                "path": os.path.splitext(child_rel)[0].replace(os.sep, '/'),
                "extension": ext,
                "type": "file",
            })
    return {"folders": folders, "files": files}


# One built tree per file type, kept until something on disk actually changes.
_TREE_CACHE = {}


# A fingerprint of every directory under the roots.
#
# A directory's mtime changes whenever an entry inside it is added, removed or renamed, which is exactly what the tree reflects — file *contents* do not appear in it.
# So a few hundred directory stats stand in for tens of thousands of files, and reopening the sidebar costs that instead of a full walk.
def _tree_signature(roots):
    parts = []
    stack = [os.path.abspath(r) for r in roots if os.path.isdir(r)]
    while stack:
        path = stack.pop()
        try:
            parts.append(f"{path}:{os.stat(path).st_mtime_ns}")
            with os.scandir(path) as scan:
                for entry in scan:
                    if entry.is_dir() and not _tree_excluded(entry.name):
                        stack.append(entry.path)
        except OSError:
            continue
    parts.sort()
    return hashlib.sha1("\n".join(parts).encode("utf-8")).hexdigest()


# Query parameters:
#   depth=1  only the root level, for a first paint while the full walk runs
#   known=   the version the client already holds; answered with {"unchanged": true} when it is still current
#   force=1  rebuild regardless (the Refresh action)
@server.PromptServer.instance.routes.get("/erenodes/tree")
async def tree_handler(request):
    file_type = request.query.get("type")
    config = get_type_config(file_type)
    if not config:
        return web.json_response({"error": f"Invalid file type: {file_type}"}, status=400)

    depth = request.query.get("depth", "")
    depth = int(depth) if depth.isdigit() else 0
    known = request.query.get("known", "")
    force = request.query.get("force") == "1"

    # Walking several model roots can be slow on a network share - keep the event loop free.
    def build(levels):
        merged = {"folders": [], "files": []}
        for root in config['roots']:
            if not os.path.isdir(root):
                continue
            part = _build_tree(os.path.abspath(root), config['extensions'], depth=levels)
            merged["folders"].extend(part["folders"])
            merged["files"].extend(part["files"])
        return merged

    try:
        if depth:
            # No version: a partial tree must never be mistaken for the real one.
            return web.json_response({"partial": True, **await asyncio.to_thread(build, depth)})

        signature = await asyncio.to_thread(_tree_signature, config['roots'])
        if known and known == signature and not force:
            return web.json_response({"version": signature, "unchanged": True})

        cached = _TREE_CACHE.get(file_type)
        if cached and cached[0] == signature and not force:
            tree = cached[1]
        else:
            tree = await asyncio.to_thread(build, 0)
            _TREE_CACHE[file_type] = (signature, tree)
    except Exception as e:
        print(f"[EreNodes] tree({file_type}) failed: {e}")
        return web.json_response({"folders": [], "files": [], "error": str(e)}, status=500)
    return web.json_response({"version": signature, **tree})


# Tag Index API Endpoints
#
# The second half of the sidebar's dual-mode search. The default mode filters the
# tree the client already holds; this one answers "which groups contain this tag",
# which no amount of client-side work can do without the file contents.
#
# Three routes, deliberately split:
#   status  cheap enough to call on every mode switch - a directory walk, no reads
#   sync    starts a background build and returns immediately; a first pass over
#           36k files is far longer than any sensible HTTP timeout, so the client
#           polls status rather than holding a request open
#   search  the query itself, milliseconds once the index exists
#
# See py/tag_index.py for the schema and why the database sits beside the groups.


@server.PromptServer.instance.routes.get("/erenodes/tag_index/status")
async def tag_index_status_handler(request):
    try:
        data = await asyncio.to_thread(tag_index.status)
    except Exception as e:
        print(f"[EreNodes] tag index status failed: {e}")
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response(data)


@server.PromptServer.instance.routes.post("/erenodes/tag_index/sync")
async def tag_index_sync_handler(request):
    rebuild = False
    if request.can_read_body:
        try:
            rebuild = bool((await request.json()).get("rebuild"))
        except Exception:
            rebuild = False
    started = tag_index.start_sync(rebuild=rebuild)
    # `started: false` is not an error - it means a build was already under way,
    # which is exactly what the caller wanted to happen.
    return web.json_response({"started": started, **tag_index.progress()})


# Autocomplete for the sidebar's tag-search box. Deliberately not `search_tags`:
# that one completes from the CSV, which knows every danbooru tag whether or not
# a single group of yours contains it. In a *search* field a completion that
# returns nothing is worse than no completion at all, so this one completes from
# what is actually indexed, and carries the group count for each.
@server.PromptServer.instance.routes.get("/erenodes/tag_index/suggest")
async def tag_index_suggest_handler(request):
    query = request.query.get("query", "")
    # Terms already committed in the box, so completions can be narrowed to the
    # groups those still reach. Same comma syntax as the search field itself.
    context = request.query.get("context", "")
    limit = request.query.get("limit", "")
    limit = int(limit) if limit.isdigit() else tag_index.SUGGEST_LIMIT
    try:
        data = await asyncio.to_thread(tag_index.suggest, query, context, limit)
    except Exception as e:
        print(f"[EreNodes] tag index suggest failed: {e}")
        return web.json_response([])
    return web.json_response(data)


@server.PromptServer.instance.routes.get("/erenodes/tag_index/search")
async def tag_index_search_handler(request):
    query = request.query.get("query", "")
    limit = request.query.get("limit", "")
    limit = int(limit) if limit.isdigit() else tag_index.DEFAULT_LIMIT
    try:
        data = await asyncio.to_thread(tag_index.search, query, limit)
    except Exception as e:
        print(f"[EreNodes] tag index search failed: {e}")
        return web.json_response({"error": str(e)}, status=500)
    return web.json_response(data)


# Map a client-supplied relative path to an absolute one inside the root.
#
# Returns (abs_path, error_response).
# The containment check is what keeps rename/delete from reaching outside the tag-group folder.
def _resolve_group_path(rel_path, must_exist=True):
    if not rel_path:
        return None, web.json_response({"error": "path not provided"}, status=400)

    cleaned = str(rel_path).lstrip('/').lstrip('\\').replace("..", "_")
    root = get_prompts_dir()
    target = os.path.abspath(os.path.join(root, cleaned))

    if not is_within(root, target) or os.path.abspath(root) == target:
        return None, web.json_response({"error": "Forbidden path"}, status=403)
    if must_exist and not os.path.exists(target):
        return None, web.json_response({"error": "Not found"}, status=404)
    return target, None


# Rename a tag group or a folder.
# Preview images follow the .json.
@server.PromptServer.instance.routes.post("/erenodes/rename_path")
async def rename_path_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    source, err = _resolve_group_path(data.get("path"))
    if err:
        return err

    new_name = sanitize_filename(str(data.get("newName", "")))
    if not new_name:
        return web.json_response({"error": "newName not provided"}, status=400)

    is_dir = os.path.isdir(source)
    if not is_dir and not new_name.lower().endswith(".json"):
        new_name += ".json"

    target = os.path.join(os.path.dirname(source), new_name)
    if not is_within(get_prompts_dir(), target):
        return web.json_response({"error": "Forbidden path"}, status=403)
    if os.path.exists(target):
        return web.json_response({"error": "A file or folder with that name already exists."}, status=409)

    try:
        images = [] if is_dir else paths.sibling_images(source)
        os.rename(source, target)
        # Keep "<group>.png" next to "<group>.json" so previews survive.
        new_base = os.path.splitext(target)[0]
        for image in images:
            suffix = image[len(os.path.splitext(source)[0]):]
            os.rename(image, new_base + suffix)
    except Exception as e:
        print(f"[EreNodes] rename failed: {e}")
        return web.json_response({"error": f"Rename failed: {e}"}, status=500)

    return web.json_response({"ok": True, "path": os.path.relpath(target, get_prompts_dir()).replace(os.sep, '/')})


# Move a tag group or folder into another folder.
#
# Both ends resolve against the tag-group root, so neither can point outside it.
@server.PromptServer.instance.routes.post("/erenodes/move_path")
async def move_path_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    source, err = _resolve_group_path(data.get("path"))
    if err:
        return err

    prompts_dir = get_prompts_dir()
    # "" is the root, which _resolve_group_path deliberately rejects.
    raw_dest = str(data.get("toFolder") or "").lstrip('/').lstrip('\\').replace("..", "_")
    dest_dir = os.path.abspath(os.path.join(prompts_dir, raw_dest)) if raw_dest else os.path.abspath(prompts_dir)

    if not is_within(prompts_dir, dest_dir) or not os.path.isdir(dest_dir):
        return web.json_response({"error": "Invalid destination folder"}, status=400)
    if os.path.dirname(source) == dest_dir:
        return web.json_response({"ok": True, "unchanged": True})
    # Moving a folder into itself (or its own child) would destroy it.
    if os.path.isdir(source) and is_within(source, dest_dir):
        return web.json_response({"error": "Cannot move a folder into itself"}, status=400)

    target = os.path.join(dest_dir, os.path.basename(source))
    if os.path.exists(target):
        return web.json_response({"error": "A file or folder with that name already exists there."}, status=409)

    try:
        images = [] if os.path.isdir(source) else paths.sibling_images(source)
        shutil.move(source, target)
        for image in images:
            shutil.move(image, os.path.join(dest_dir, os.path.basename(image)))
    except Exception as e:
        print(f"[EreNodes] move failed: {e}")
        return web.json_response({"error": f"Move failed: {e}"}, status=500)

    return web.json_response({
        "ok": True,
        "path": os.path.relpath(target, prompts_dir).replace(os.sep, '/'),
    })


# Delete a tag group (plus its preview images) or an entire folder.
@server.PromptServer.instance.routes.post("/erenodes/delete_path")
async def delete_path_handler(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"error": "Invalid JSON body"}, status=400)

    target, err = _resolve_group_path(data.get("path"))
    if err:
        return err

    try:
        if os.path.isdir(target):
            shutil.rmtree(target)
        else:
            for image in paths.sibling_images(target):
                os.remove(image)
            os.remove(target)
    except Exception as e:
        print(f"[EreNodes] delete failed: {e}")
        return web.json_response({"error": f"Delete failed: {e}"}, status=500)

    return web.json_response({"ok": True})


# Prompt Extractor

# Pull the positive prompt out of an uploaded image.
#
# Saved into ComfyUI's input directory, like any LoadImage upload, so the node can re-read it and the workflow stays portable.
@server.PromptServer.instance.routes.post("/erenodes/extract_prompt")
async def extract_prompt_handler(request):
    from . import prompt_extractor

    try:
        form = await request.post()
    except Exception as e:
        return web.json_response({"error": f"Bad upload: {e}"}, status=400)

    field = form.get("image")
    if field is None or not hasattr(field, "file"):
        return web.json_response({"error": "No image uploaded"}, status=400)

    original = os.path.basename(field.filename or "image.png")
    if not original.lower().endswith(prompt_extractor.IMAGE_EXTENSIONS):
        return web.json_response(
            {"error": f"Unsupported image type: {original}"}, status=400)

    input_dir = folder_paths.get_input_directory()
    os.makedirs(input_dir, exist_ok=True)

    # Never clobber an existing input: suffix until the name is free.
    safe = sanitize_filename(original)
    stem, ext = os.path.splitext(safe)
    name, counter = safe, 1
    while os.path.exists(os.path.join(input_dir, name)):
        name = f"{stem}_{counter}{ext}"
        counter += 1

    target = os.path.join(input_dir, name)
    try:
        with open(target, "wb") as out:
            field.file.seek(0)
            shutil.copyfileobj(field.file, out)
    except Exception as e:
        return web.json_response({"error": f"Could not save image: {e}"}, status=500)

    try:
        # extract_from_image already prefers the editor graph when it contains our nodes (the only source that keeps strengths and inactive tags).
        result = await asyncio.to_thread(prompt_extractor.extract_from_image, target)
    except Exception as e:
        print(f"[EreNodes] extract_prompt failed: {e}")
        return web.json_response({"error": "Internal error while reading metadata"}, status=500)

    result["filename"] = name
    return web.json_response(result)


# Re-extract from an image already in the input directory.
@server.PromptServer.instance.routes.get("/erenodes/extract_prompt")
async def extract_prompt_existing_handler(request):
    from . import prompt_extractor

    filename = request.query.get("filename", "")
    if not filename:
        return web.json_response({"error": "filename not provided"}, status=400)

    input_dir = folder_paths.get_input_directory()
    path = os.path.abspath(os.path.join(input_dir, os.path.basename(filename)))
    if not is_within(input_dir, path) or not os.path.isfile(path):
        return web.json_response({"error": "Image not found"}, status=404)

    try:
        result = await asyncio.to_thread(prompt_extractor.extract_from_image, path)
    except Exception as e:
        print(f"[EreNodes] extract_prompt failed: {e}")
        return web.json_response({"error": "Internal error while reading metadata"}, status=500)

    result["filename"] = os.path.basename(path)
    return web.json_response(result)
