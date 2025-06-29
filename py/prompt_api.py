import json
import os
import re
import shutil
import server 
import yaml
import folder_paths
from aiohttp import web
from safetensors import safe_open
from .prompt_csv import TAG_TYPES, DEFAULT_ENCODING, CSV_FILES_PATH, load_tags_from_csv
from .settings import get_erenodes_settings, save_erenodes_settings



# --- Tag Group API Endpoints --- #

current_file_path = os.path.dirname(os.path.realpath(__file__))
# Go up one level from 'py' to the project root, then into '__prompts__'
project_root = os.path.dirname(current_file_path)
prompts_dir = os.path.join(project_root, "__prompts__")

# Ensure the prompts directory exists
if not os.path.exists(prompts_dir):
    os.makedirs(prompts_dir)


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

    # If the active CSV is changed, we need to reload the tags
    if key == "autocomplete.csv_file":
        try:
            load_tags_from_csv(value, encoding=DEFAULT_ENCODING, csv_files_path=CSV_FILES_PATH)
        except Exception as e:
            # It's okay if this fails (e.g., file not found during a temporary state)
            # The setting is still saved.
            pass

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



    current_scan_path = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

    abs_prompts_dir = os.path.abspath(prompts_dir)
    if not current_scan_path.startswith(abs_prompts_dir):
        return web.json_response({"error": "Forbidden path"}, status=403)

    if not os.path.exists(current_scan_path):
        return web.json_response([])
    if not os.path.isdir(current_scan_path):
        return web.json_response([])

    items = []
    try:
        for entry_index, entry in enumerate(os.listdir(current_scan_path)):
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

    file_path = os.path.abspath(os.path.join(prompts_dir, safe_filename))

    if not file_path.startswith(os.path.abspath(prompts_dir)):
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
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not target_dir.startswith(os.path.abspath(prompts_dir)):
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
                message += " Failed to save associated image."
        else:
            # This block is hit if the image field isn't as expected or not present
            if image_file_field is not None: # Check if the field itself was found
                message += " (Image was provided but not saved due to an issue)."
        
        return web.json_response({"message": message})
    except json.JSONDecodeError:
        return web.json_response({"message": "Invalid JSON format for tags_json."}, status=400)
    except Exception as e:
        return web.json_response({"error": "Internal server error"}, status=500)


# --- LORA API Endpoints --- #

def get_robust_model_paths(model_type):
    # Get model paths from multiple sources to handle different ComfyUI installations.
    # 1. ComfyUI's folder_paths (default)
    # 2. extra_model_paths.yaml (used by Stability Matrix and other managers)

    paths = []
    
    # Method 1: Use ComfyUI's built-in folder_paths (works for standard installations)
    try:
        default_paths = folder_paths.get_folder_paths(model_type)
        if default_paths:
            paths.extend(default_paths)
    except Exception as e:
        pass
    
    # Method 2: Check extra_model_paths.yaml (used by Stability Matrix)
    try:
        # Look for extra_model_paths.yaml in multiple possible locations
        import os
        # Use the directory where folder_paths module is located (ComfyUI root)
        comfyui_root = os.path.dirname(folder_paths.__file__)
        
        # Single universal path that works for all installations
        yaml_path = os.path.join(comfyui_root, 'extra_model_paths.yaml')

        
        extra_paths_file = None
        if os.path.exists(yaml_path):
            extra_paths_file = yaml_path

        
        if extra_paths_file:

            with open(extra_paths_file, 'r', encoding='utf-8') as f:
                config = yaml.safe_load(f)
            
            # Check all configurations in the YAML file
            for config_name, config_data in config.items():
                
                if isinstance(config_data, dict) and model_type in config_data:
                    base_path = config_data.get('base_path', '')
                    model_paths = config_data[model_type]

                    
                    # Handle both string and list formats
                    if isinstance(model_paths, str):
                        # Check if string contains newlines (multiline format)
                        if '\n' in model_paths:
                            model_paths = [path.strip() for path in model_paths.strip().split('\n') if path.strip()]
                        else:
                            model_paths = [model_paths]
                    elif isinstance(model_paths, list):
                        pass  # Already a list
                    else:
                        # Handle YAML multiline format
                        model_paths = str(model_paths).strip().split('\n')
                    
                    # Convert relative paths to absolute paths
                    for model_path in model_paths:
                        model_path = model_path.strip()
                        if model_path:
                            if os.path.isabs(model_path):
                                full_path = model_path
                            else:
                                full_path = os.path.join(base_path, model_path)
                            
                            if os.path.exists(full_path) and full_path not in paths:
                                paths.append(full_path)


                                
    except Exception as e:
        pass
    
    # Remove duplicates while preserving order
    unique_paths = []
    for path in paths:
        if path not in unique_paths:
            unique_paths.append(path)
    
    if not unique_paths:
        # Fallback to common default locations
        fallback_paths = [
            os.path.join(os.path.expanduser('~'), 'ComfyUI', 'models', model_type),
            os.path.join('.', 'models', model_type)
        ]
        for fallback in fallback_paths:
            if os.path.exists(fallback):
                unique_paths.append(fallback)
                break
    

    return unique_paths

@server.PromptServer.instance.routes.get("/erenodes/get_lora_metadata")
async def get_lora_metadata_handler(request):
    filename = request.query.get("filename")
    if not filename:
        return web.json_response({"error": "Filename not provided"}, status=400)

    try:
        lora_path = folder_paths.get_full_path("loras", filename)
        if not lora_path:
            # Try to find it in the old loras folder as well
            lora_path = folder_paths.get_full_path("loras_old", filename)
            if not lora_path:
                return web.json_response({"error": "Lora not found in any known folder"}, status=404)

        metadata = {}
        with safe_open(lora_path, framework="pt", device="cpu") as f:
            metadata = f.metadata()
        
        if not metadata:
            return web.json_response({})

        # The 'ss_tag_frequency' is often a JSON string within the metadata, so we parse it.
        if 'ss_tag_frequency' in metadata and isinstance(metadata['ss_tag_frequency'], str):
            try:
                metadata['ss_tag_frequency'] = json.loads(metadata['ss_tag_frequency'])
            except json.JSONDecodeError:
                # Keep it as a string if it's not valid JSON
                pass

        return web.json_response(metadata)
    except Exception as e:
        # Consider logging the full error for debugging
        return web.json_response({"error": "Failed to read LoRA metadata: " + str(e)}, status=500)

# --- Unified File Search API Endpoint --- #

@server.PromptServer.instance.routes.get("/erenodes/search_files")
async def search_files_handler(request):
    raw_query = request.query.get("query", "")
    path_param = request.query.get("path", "")
    file_type = request.query.get("type")
    


    if not file_type:
        return web.json_response({"error": "File type not provided"}, status=400)

    type_configs = {
        'lora': {
            'roots': get_robust_model_paths("loras"),
            'extensions': ('.safetensors', '.pt', '.ckpt', '.lora'),
        },
        'embedding': {
            'roots': get_robust_model_paths("embeddings"),
            'extensions': ('.pt', '.bin', '.safetensors', '.embedding'),
        },
        'group': {
            'roots': [prompts_dir],
            'extensions': ('.json',),
        }
    }

    config = type_configs.get(file_type)
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

        if path_param:
            normalized_path_param = os.path.normpath(path_param.lstrip('/').lstrip('\\'))
            for root in collection_paths:
                abs_root = os.path.abspath(root)
                potential_scan_path = os.path.abspath(os.path.join(abs_root, normalized_path_param))
                if os.path.isdir(potential_scan_path) and os.path.commonpath([abs_root, potential_scan_path]) == abs_root:
                    scan_target_abs = potential_scan_path
                    current_collection_root_abs = abs_root
                    break
            if not scan_target_abs:
                return web.json_response({"items": [], "parentPath": path_param})
        else:
            if not collection_paths:
                return web.json_response({"items": [], "parentPath": ""})
                

            
        # Scan all collection paths, not just the first one
        for root_path in collection_paths if not path_param else [scan_target_abs]:
            if path_param:
                # Use the already determined scan_target_abs for specific path navigation
                current_scan_target = scan_target_abs
                current_collection_root_abs = current_collection_root_abs
            else:
                # Scan each collection path when no specific path is requested
                current_scan_target = os.path.abspath(root_path)
                current_collection_root_abs = current_scan_target
                
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
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not target_dir.startswith(os.path.abspath(prompts_dir)):
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

    # Determine base directories
    if type_name == 'group':
        # The 'prompts_dir' is already an absolute path.
        base_dirs = [prompts_dir]
    else:
        # folder_paths uses plural for loras, embeddings, etc.
        base_dirs = get_robust_model_paths(type_name + 's')

    if not base_dirs:
        return web.Response(status=404, text=f"No folder configured for type '{type_name}'")

    # This is a basic sanitization. The check below is more robust.
    # It prevents using '..' to escape the intended directories.
    path_param = path_param.replace("..", "_")

    potential_extensions = ['.jpg', '.jpeg', '.png', '.webp']

    for root_dir in base_dirs:
        abs_root_dir = os.path.abspath(root_dir)
        # The path_param is the path to the main file, *without* its extension.
        # It's what we use as the base for finding a preview image.
        prospective_path_base = os.path.join(abs_root_dir, path_param)

        # Security check: ensure the requested path is within the intended directory
        if os.path.abspath(prospective_path_base).startswith(abs_root_dir):
            # Check for both filename.extension and filename.preview.extension patterns
            for ext in potential_extensions:
                # First try: filename.extension (original pattern)
                image_path = prospective_path_base + ext
                if os.path.isfile(image_path):
                    return web.FileResponse(image_path)
                
                # Second try: filename.preview.extension (new pattern)
                preview_image_path = prospective_path_base + '.preview' + ext
                if os.path.isfile(preview_image_path):
                    return web.FileResponse(preview_image_path)
    
    # If we get here, no file was found in any of the directories
    return web.Response(status=404, text="Preview image not found")

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
                'roots': get_robust_model_paths("loras"),
                'extensions': ('.safetensors', '.pt', '.ckpt', '.lora'),
            },
            'embedding': {
                'roots': get_robust_model_paths("embeddings"),
                'extensions': ('.pt', '.bin', '.safetensors', '.embedding'),
            },
            'group': {
                'roots': [prompts_dir],
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

        # Create the image filename with the same base name as the file
        image_filename = file_basename + image_extension
        image_path = os.path.join(file_dir, image_filename)

        # Save the image
        with open(image_path, 'wb') as f_img:
            image_file_field.file.seek(0)
            import shutil
            shutil.copyfileobj(image_file_field.file, f_img)

        message = f"Image '{image_filename}' saved successfully for {file_type} '{file_name}'."
        return web.json_response({"message": message})

    except Exception as e:
        return web.json_response({"error": "Internal server error"}, status=500)