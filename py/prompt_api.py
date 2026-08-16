import asyncio
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
from .paths import (
    IMAGE_EXTENSIONS,
    LOCATION_NODE,
    LOCATION_MODELS,
    VALID_LOCATIONS,
    get_prompts_dir,
    is_within,
)


# --- Tag Group API Endpoints --- #
#
# There is deliberately no module-level `prompts_dir` constant any more: the
# root is a user setting now, so every handler calls get_prompts_dir() and the
# toggle takes effect without restarting ComfyUI.


def sanitize_filename(filename):
    # Remove potentially unsafe characters, keep it simple, allow spaces and underscores
    # Replace known problematic characters with underscore
    filename = re.sub(r'[\/:*?"<>|]', '_', filename)
    # Basic protection against directory traversal
    filename = filename.replace('..', '_')
    return filename.strip()

# --- API Endpoints ---

@server.PromptServer.instance.routes.post("/erenodes/set_setting")
async def set_setting_handler(request):
    data = await request.json()
    key = data.get("key")
    value = data.get("value")

    if key is None:
        return web.json_response({"status": "error", "message": "Setting 'key' not provided"}, status=400)

    settings = get_erenodes_settings()
    
    # Simple key update, can be expanded for nested keys if needed
    settings[key] = value
    
    save_erenodes_settings(settings)

    # If the active CSV changed, invalidate the tag cache so it lazy-reloads
    # on the next search. (Previously this branch checked a mismatched key and
    # called load_tags_from_csv with a wrong signature - it never ran.)
    if key == "autocomplete.csv":
        TAG_DATA_CACHE.pop(value, None)

    return web.json_response({"status": "ok"})

@server.PromptServer.instance.routes.get("/erenodes/list_csv_files")
async def list_csv_files_handler(request):
    # Ensure this uses the CSV_FILES_PATH from prompt_csv for consistency
    # or a shared constant if autocomplete_dir is different
    # For now, assuming CSV_FILES_PATH is the correct one for listing.
    if not os.path.isdir(CSV_FILES_PATH):
        return web.json_response([])
    
    files = [f for f in os.listdir(CSV_FILES_PATH) if f.endswith(".csv")]
    return web.json_response(files)

@server.PromptServer.instance.routes.get("/erenodes/list_tag_groups")
async def list_tag_groups_handler(request):
    path_param = request.query.get("path", "")


    safe_path_param = path_param.lstrip('/').lstrip('\\') # Remove leading slashes
    safe_path_param = safe_path_param.replace("..", "_") # Prevent directory traversal



    prompts_dir = get_prompts_dir()
    current_scan_path = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

    if not is_within(prompts_dir, current_scan_path):
        return web.json_response({"error": "Forbidden path"}, status=403)

    if not os.path.exists(current_scan_path):
        return web.json_response([])
    if not os.path.isdir(current_scan_path):
        return web.json_response([])

    items = []
    try:
        for entry in os.listdir(current_scan_path):
            entry_path = os.path.join(current_scan_path, entry)
            if os.path.isdir(entry_path):
                if not entry.startswith('.') and entry != "__pycache__":
                    items.append({"name": entry, "type": "folder"})
            elif os.path.isfile(entry_path) and entry.lower().endswith(".json"):
                items.append({"name": entry, "type": "file"})

        items.sort(key=lambda x: (x["type"] == "file", x["name"].lower()))
        return web.json_response(items)
    except Exception as e:
        return web.json_response({"error": f"Error listing files: {str(e)}"}, status=500)

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
        form_data = await request.post()  # Changed to handle FormData
        
        filename = form_data.get("filename")
        tags_json_str = form_data.get("tags_json") # Renamed to avoid conflict with json module
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
        safe_filename = sanitize_filename(os.path.basename(filename)) # This is the JSON filename
        if not safe_filename.lower().endswith(".json"):
            safe_filename += ".json"

        file_path = os.path.join(target_dir, safe_filename)

        if os.path.isdir(file_path):
            return web.json_response({"message": "A directory with this name already exists at the target location."}, status=400)

        tags_data = json.loads(tags_json_str)
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(tags_data, f, indent=2)

        message = f"Tag group '{os.path.join(safe_path_param, safe_filename) if safe_path_param else safe_filename}' saved successfully."

        # Save associated image if provided
        if image_file_field and hasattr(image_file_field, 'file') and image_file_field.file:
            try:
                image_original_filename = image_file_field.filename
                # Ensure there's an original filename to get an extension from
                if not image_original_filename:
                    raise ValueError("Image file has no original filename.")

                _, image_extension = os.path.splitext(image_original_filename)
                if image_extension and image_extension.lower() not in IMAGE_EXTENSIONS:
                    raise ValueError(f"Unsupported image type: {image_extension}")

                # Ensure there's an extension
                if not image_extension:
                    # Decide handling: skip, default, or error. Prompt implies using original.
                    # If truly no extension, it's safer to note it or skip.
                    message += f" Image '{image_original_filename}' was not saved as it has no extension."
                else:
                    json_basename_no_ext, _ = os.path.splitext(safe_filename)
                    image_save_filename = json_basename_no_ext + image_extension
                    image_save_path = os.path.join(target_dir, image_save_filename)

                    with open(image_save_path, 'wb') as f_img:
                        image_file_field.file.seek(0) # Ensure stream is at the beginning
                        shutil.copyfileobj(image_file_field.file, f_img)
                    
                    message += f" Image '{image_save_filename}' also saved."
            except Exception as e:
                # The tag group itself saved fine; report why the image did not
                # instead of swallowing the reason.
                print(f"[EreNodes] Failed to save preview image for '{safe_filename}': {e}")
                message += f" Failed to save associated image: {e}"
        elif image_file_field is not None:
            # A value was posted under "image_file" but it is not a file part
            # (no .file attribute) - e.g. an empty string from an untouched
            # form field. Say so rather than hinting at a mystery failure.
            message += " (Ignored 'image_file': not an uploaded file.)"

        return web.json_response({"message": message})
    except json.JSONDecodeError:
        return web.json_response({"message": "Invalid JSON format for tags_json."}, status=400)
    except Exception as e:
        print(f"[EreNodes] save_tag_group failed: {e}")
        return web.json_response({"error": "Internal server error"}, status=500)


# --- Tag Group Location --- #

@server.PromptServer.instance.routes.get("/erenodes/tag_groups_location")
async def get_tag_groups_location_handler(request):
    """Current location plus both resolved paths, so the settings UI can show
    where things actually are without guessing at the install layout."""
    location = paths.get_location()
    node_dir = paths.node_prompts_dir()
    models_dir = paths.models_prompts_dir()
    return web.json_response({
        "location": location,
        "resolved": paths.dir_for_location(location),
        "paths": {LOCATION_NODE: node_dir, LOCATION_MODELS: models_dir},
        "counts": {
            LOCATION_NODE: paths.count_tag_groups(node_dir),
            LOCATION_MODELS: paths.count_tag_groups(models_dir),
        },
    })


@server.PromptServer.instance.routes.post("/erenodes/set_tag_groups_location")
async def set_tag_groups_location_handler(request):
    """Switch between the two allowed roots.

    Only the two known keywords are accepted - there is deliberately no way to
    name an arbitrary directory over HTTP. Users who need a different disk add
    `tag_groups:` to extra_model_paths.yaml, which folder_paths picks up.
    """
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
        # How many groups are still sitting in the location we just left, so the
        # client can offer to copy them across.
        "legacy_count": paths.count_tag_groups(other) if previous != location else 0,
    })


@server.PromptServer.instance.routes.post("/erenodes/migrate_tag_groups")
async def migrate_tag_groups_handler(request):
    """Copy tag groups from one location to the other. Never overwrites, never
    deletes - the source folder is left intact as a backup."""
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


# --- LORA API Endpoints --- #

def get_model_paths(model_type):
    """Model folders for a type, via ComfyUI's folder_paths.

    folder_paths already merges extra_model_paths.yaml (including Stability
    Matrix and other manager setups), so the previous manual YAML parsing was
    redundant and has been removed.
    """
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

        # File reads (especially safetensors header reads on large files) are
        # blocking - run them in a thread so the server event loop stays free.
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

# --- Unified File Search API Endpoint --- #

def get_type_config(file_type):
    """Roots + extensions for a browsable file type, or None if unknown.

    Resolved per call, not cached: the tag-group root follows a live setting and
    model roots can change when extra_model_paths is reloaded.
    """
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

        # Two modes, expressed as a list of (scan target, collection root) pairs:
        #   - a path was given -> resolve it against whichever collection root
        #     actually contains it, and scan only that one;
        #   - no path -> scan every collection root (loras can live in several
        #     folders via extra_model_paths.yaml).
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
    # We do not resize server-side (no extra deps), but presence of w/h/fit
    # in the URL should not cause 404 when an image exists.
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

    # This is a basic sanitization. The check below is more robust.
    # It prevents using '..' to escape the intended directories.
    path_param = path_param.replace("..", "_")

    potential_extensions = IMAGE_EXTENSIONS

    for root_dir in base_dirs:
        abs_root_dir = os.path.abspath(root_dir)
        # The path_param is the path to the main file, *without* its extension.
        # It's what we use as the base for finding a preview image.
        prospective_path_base = os.path.join(abs_root_dir, path_param)

        # Security check: ensure the requested path is within the intended
        # directory (see is_within — a sibling dir like ".../loras_x" must not
        # pass a ".../loras" check).
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
    
    # If we get here, no file was found in any of the directories
    # Return 204 No Content to indicate "no preview available" without error noise.
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

        # Find the actual file path
        file_path = None
        for root_dir in config['roots']:
            for ext in config['extensions']:
                potential_path = os.path.join(root_dir, file_name + ext)
                if os.path.exists(potential_path):
                    file_path = potential_path
                    break
            if file_path:
                break

        if not file_path:
            return web.json_response({"error": f"File not found: {file_name}"}, status=404)

        # Get the directory and base name of the file
        file_dir = os.path.dirname(file_path)
        file_basename = os.path.splitext(os.path.basename(file_path))[0]

        # Get image extension from the uploaded file
        image_original_filename = image_file_field.filename
        if not image_original_filename:
            return web.json_response({"error": "Image file has no original filename"}, status=400)

        _, image_extension = os.path.splitext(image_original_filename)
        if not image_extension:
            return web.json_response({"error": "Image file has no extension"}, status=400)
        if image_extension.lower() not in IMAGE_EXTENSIONS:
            return web.json_response({"error": f"Unsupported image type: {image_extension}"}, status=400)

        # Create the image filename with the same base name as the file
        image_filename = file_basename + image_extension
        image_path = os.path.join(file_dir, image_filename)

        # Save the image
        with open(image_path, 'wb') as f_img:
            image_file_field.file.seek(0)
            shutil.copyfileobj(image_file_field.file, f_img)

        message = f"Image '{image_filename}' saved successfully for {file_type} '{file_name}'."
        return web.json_response({"message": message})

    except Exception:
        return web.json_response({"error": "Internal server error"}, status=500)


# --- Sidebar API Endpoints --- #
#
# The sidebar needs whole-tree data (an accordion expanding one level at a time
# would be one request per folder) and content-aware search (matching tags
# *inside* a group cannot be done client-side without downloading everything).

# path -> (mtime, [tag names]) so repeated searches only re-read changed files.
_TAG_INDEX = {}


def _tree_excluded(name):
    return name.startswith('.') or name == "__pycache__"


def _build_tree(root, extensions, rel=""):
    """Nested {folders, files} for one collection root.

    Paths in the result are relative to the root and always forward-slashed, so
    the client can use them directly in URLs regardless of host OS.
    """
    abs_dir = os.path.join(root, rel) if rel else root
    folders, files = [], []
    try:
        entries = sorted(os.listdir(abs_dir), key=str.lower)
    except OSError:
        return {"folders": folders, "files": files}

    for entry in entries:
        full = os.path.join(abs_dir, entry)
        child_rel = f"{rel}/{entry}" if rel else entry
        if os.path.isdir(full):
            if _tree_excluded(entry):
                continue
            sub = _build_tree(root, extensions, child_rel)
            folders.append({
                "name": entry, "path": child_rel.replace(os.sep, '/'),
                "type": "folder", **sub,
            })
        elif entry.lower().endswith(extensions):
            stem, ext = os.path.splitext(entry)
            files.append({
                "name": stem,
                "path": os.path.splitext(child_rel)[0].replace(os.sep, '/'),
                "extension": ext,
                "type": "file",
            })
    return {"folders": folders, "files": files}


@server.PromptServer.instance.routes.get("/erenodes/tree")
async def tree_handler(request):
    file_type = request.query.get("type")
    config = get_type_config(file_type)
    if not config:
        return web.json_response({"error": f"Invalid file type: {file_type}"}, status=400)

    # Walking several model roots can be slow on a network share - keep the
    # event loop free.
    def build():
        merged = {"folders": [], "files": []}
        for root in config['roots']:
            if not os.path.isdir(root):
                continue
            part = _build_tree(os.path.abspath(root), config['extensions'])
            merged["folders"].extend(part["folders"])
            merged["files"].extend(part["files"])
        return merged

    try:
        tree = await asyncio.to_thread(build)
    except Exception as e:
        print(f"[EreNodes] tree({file_type}) failed: {e}")
        return web.json_response({"folders": [], "files": [], "error": str(e)}, status=500)
    return web.json_response(tree)


def _tag_names_for(json_path):
    """Tag names inside a group file, cached on mtime."""
    try:
        mtime = os.path.getmtime(json_path)
    except OSError:
        _TAG_INDEX.pop(json_path, None)
        return []

    cached = _TAG_INDEX.get(json_path)
    if cached and cached[0] == mtime:
        return cached[1]

    names = []
    try:
        with open(json_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            names = [str(t.get("name", "")).lower() for t in data if isinstance(t, dict)]
    except Exception:
        names = []

    _TAG_INDEX[json_path] = (mtime, names)
    return names


@server.PromptServer.instance.routes.get("/erenodes/search_tag_groups")
async def search_tag_groups_handler(request):
    """Search tag groups by filename AND by the tags they contain."""
    query = request.query.get("query", "").strip().lower()
    if not query:
        return web.json_response({"items": []})

    root = os.path.abspath(get_prompts_dir())

    def search():
        items = []
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if not _tree_excluded(d)]
            for filename in filenames:
                if not filename.lower().endswith(".json"):
                    continue
                full = os.path.join(dirpath, filename)
                rel = os.path.relpath(full, root)
                stem = os.path.splitext(rel)[0].replace(os.sep, '/')

                name_hit = query in stem.lower()
                matched = [n for n in _tag_names_for(full) if query in n]
                if not name_hit and not matched:
                    continue
                items.append({
                    "name": os.path.splitext(filename)[0],
                    "path": stem,
                    "extension": os.path.splitext(filename)[1],
                    "type": "group",
                    "matchedName": name_hit,
                    # Enough to show "why" a result matched without shipping the
                    # whole group; the hover preview fetches the full list.
                    "matchedTags": matched[:8],
                })
        items.sort(key=lambda x: (not x["matchedName"], x["path"].lower()))
        return items

    try:
        items = await asyncio.to_thread(search)
    except Exception as e:
        print(f"[EreNodes] search_tag_groups failed: {e}")
        return web.json_response({"items": [], "error": str(e)}, status=500)
    return web.json_response({"items": items})


def _resolve_group_path(rel_path, must_exist=True):
    """Map a client-supplied relative path to an absolute one inside the root.

    Returns (abs_path, error_response). The containment check is what keeps
    rename/delete from reaching outside the tag-group folder.
    """
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


@server.PromptServer.instance.routes.post("/erenodes/rename_path")
async def rename_path_handler(request):
    """Rename a tag group or a folder. Preview images follow the .json."""
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


@server.PromptServer.instance.routes.post("/erenodes/move_path")
async def move_path_handler(request):
    """Move a tag group (or folder) into another folder.

    This is what dragging an entry onto a folder inside the sidebar does. Both
    ends are resolved against the tag-group root, so neither the source nor the
    destination can point outside it.
    """
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
        _TAG_INDEX.pop(source, None)
    except Exception as e:
        print(f"[EreNodes] move failed: {e}")
        return web.json_response({"error": f"Move failed: {e}"}, status=500)

    return web.json_response({
        "ok": True,
        "path": os.path.relpath(target, prompts_dir).replace(os.sep, '/'),
    })


@server.PromptServer.instance.routes.post("/erenodes/delete_path")
async def delete_path_handler(request):
    """Delete a tag group (plus its preview images) or an entire folder."""
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
            _TAG_INDEX.pop(target, None)
    except Exception as e:
        print(f"[EreNodes] delete failed: {e}")
        return web.json_response({"error": f"Delete failed: {e}"}, status=500)

    return web.json_response({"ok": True})
