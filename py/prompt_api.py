import os
import json
import re
import server # ComfyUI's server instance
from aiohttp import web
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

@server.PromptServer.instance.routes.post("/erenodes/set_active_csv")
async def set_active_csv_handler(request):
    data = await request.json()
    csv_file = data.get("csv_file")
    if csv_file is None:
        return web.json_response({"status": "error", "message": "csv_file not provided"}, status=400)
    
    settings = get_erenodes_settings()
    settings['active_csv'] = csv_file
    save_erenodes_settings(settings)
    try:
        # Refresh autocomplete for the newly activated CSV
        load_tags_from_csv(csv_file, encoding=DEFAULT_ENCODING, csv_files_path=CSV_FILES_PATH)
    except Exception as e:
        # Log this error on the server, but don't fail the entire operation
        # as setting active_csv was successful.
        # Consider a more robust logging mechanism if this becomes a common issue.
        pass
    
    return web.json_response({"status": "ok"})
    
    settings = get_erenodes_settings()
    settings['active_csv'] = csv_file
    save_erenodes_settings(settings)
    
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
        data = await request.json()
        filename = data.get("filename")
        tags_json = data.get("tags_json")
        path_param = data.get("path", "")

        if not filename or tags_json is None:
            return web.json_response({"message": "Filename or tags_json not provided"}, status=400)

        safe_path_param = path_param.lstrip('/').lstrip('\\').replace("..", "_")
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not target_dir.startswith(os.path.abspath(prompts_dir)):
            return web.json_response({"error": "Forbidden save path"}, status=403)

        os.makedirs(target_dir, exist_ok=True)
        safe_filename = sanitize_filename(os.path.basename(filename))
        if not safe_filename.lower().endswith(".json"):
            safe_filename += ".json"

        file_path = os.path.join(target_dir, safe_filename)

        if os.path.isdir(file_path):
            return web.json_response({"message": "A directory with this name already exists at the target location."}, status=400)

        tags_data = json.loads(tags_json)
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(tags_data, f, indent=2)

        display_path = os.path.join(safe_path_param, safe_filename) if safe_path_param else safe_filename
        return web.json_response({"message": f"Tag group '{display_path}' saved successfully."})
    except json.JSONDecodeError:
        return web.json_response({"message": "Invalid JSON format for tags_json."}, status=400)
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


# --- LORA API Endpoints --- #

import folder_paths # Import ComfyUI's folder_paths

# --- LORA API Endpoints --- #

@server.PromptServer.instance.routes.get("/erenodes/search_loras")
async def search_loras_handler(request):
    raw_query = request.query.get("query", "")
    path_param = request.query.get("path", "") # This is the current subfolder relative to a LORA root
    LORA_EXTENSIONS = ('.safetensors', '.pt', '.ckpt', '.lora')

    # Handle query-based navigation
    # If query is like "folder/" or "folder\", treat it as navigation
    potential_nav_folder = ""
    actual_search_query = raw_query.lower()

    if raw_query.endswith('/') or raw_query.endswith('\\'):
        potential_nav_folder = os.path.normpath(raw_query.strip('/\\'))
        actual_search_query = "" # Clear search query if it was a navigation command
        # The new path_param will be the old path_param + potential_nav_folder
        if path_param:
            path_param = os.path.join(path_param, potential_nav_folder).replace('\\', '/')
        else:
            path_param = potential_nav_folder.replace('\\', '/')
    
    query = actual_search_query

    try:
        lora_collection_paths = folder_paths.get_folder_paths("loras")
        if not lora_collection_paths:
            return web.json_response({"items": [], "parentPath": path_param if path_param else ""})

        items = []
        found_relative_paths = set()

        # Determine the actual absolute path to scan and the root of this LORA collection for relative path calculation
        scan_target_abs = None
        current_lora_collection_root_abs = None

        if path_param:
            normalized_path_param = os.path.normpath(path_param.lstrip('/').lstrip('\\'))
            for lora_root in lora_collection_paths:
                abs_lora_root = os.path.abspath(lora_root)
                potential_scan_path = os.path.abspath(os.path.join(abs_lora_root, normalized_path_param))
                if os.path.isdir(potential_scan_path) and os.path.commonpath([abs_lora_root, potential_scan_path]) == abs_lora_root:
                    scan_target_abs = potential_scan_path
                    current_lora_collection_root_abs = abs_lora_root
                    break
            if not scan_target_abs:
                return web.json_response({"items": [], "parentPath": path_param})
        else:
            # No path_param, search starts from the root of the primary LORA collection path
            # For simplicity, we'll use the first LORA path as the primary scan target for root searches.
            # A more complex setup might iterate all roots or provide a way to switch between them.
            if lora_collection_paths:
                scan_target_abs = os.path.abspath(lora_collection_paths[0])
                current_lora_collection_root_abs = scan_target_abs # Root is its own collection root
            else:
                 return web.json_response({"items": [], "parentPath": ""}) # Should be caught by earlier check


        for dirpath, dirnames_orig, filenames in os.walk(scan_target_abs, topdown=True):
            is_current_scan_level = (os.path.normpath(dirpath) == os.path.normpath(scan_target_abs))

            # Process files
            for filename in filenames:
                if filename.lower().endswith(LORA_EXTENSIONS):
                    filename_no_ext = os.path.splitext(filename)[0]
                    full_file_path_abs = os.path.join(dirpath, filename)
                    relative_to_collection_root = os.path.relpath(full_file_path_abs, current_lora_collection_root_abs).replace('\\', '/')
                    # The 'path' for a LORA should be its filename without extension, relative to the LORA collection root.
                    # This 'path' is what gets inserted into the prompt, e.g., "style/my_lora"
                    lora_prompt_path = os.path.splitext(relative_to_collection_root)[0]

                    if query: # Query present, search recursively
                        if query in filename_no_ext.lower() or query in lora_prompt_path.lower():
                            if lora_prompt_path not in found_relative_paths:
                                # For display, we might still want just the filename, but the 'path' for prompt needs to be full
                                items.append({"name": filename_no_ext, "type": "lora", "path": lora_prompt_path, "extension": os.path.splitext(filename)[1]})
                                found_relative_paths.add(lora_prompt_path)
                    else: # No query, only list if current level is the scan_target_abs
                        if is_current_scan_level:
                            if lora_prompt_path not in found_relative_paths:
                                items.append({"name": filename_no_ext, "type": "lora", "path": lora_prompt_path, "extension": os.path.splitext(filename)[1]})
                                found_relative_paths.add(lora_prompt_path)
            
            # Process folders
            # dirnames_orig is the list of subdirectories in dirpath from os.walk.
            # We will modify the actual dirnames list that os.walk uses for recursion.
            current_level_dirnames_to_process = list(dirnames_orig) # Make a copy to iterate
            dirnames_orig[:] = [] # Clear dirnames_orig to control recursion. We'll add back if needed.

            for dirname in current_level_dirnames_to_process:
                if dirname.startswith('.') or dirname == "__pycache__":
                    continue

                full_folder_path_abs = os.path.join(dirpath, dirname)
                relative_to_collection_root = os.path.relpath(full_folder_path_abs, current_lora_collection_root_abs).replace('\\', '/')

                if query: # Query present, search recursively for matching folder names
                    if query in dirname.lower():
                        if relative_to_collection_root not in found_relative_paths:
                            items.append({"name": dirname, "type": "folder", "path": relative_to_collection_root})
                            found_relative_paths.add(relative_to_collection_root)
                    # Always allow recursion if query is present, as subfolders might contain matching files/folders
                    dirnames_orig.append(dirname)
                else: # No query, only list if current level is scan_target_abs
                    if is_current_scan_level:
                        if relative_to_collection_root not in found_relative_paths:
                            items.append({"name": dirname, "type": "folder", "path": relative_to_collection_root})
                            found_relative_paths.add(relative_to_collection_root)
                    # If no query, we do not want to recurse into subdirectories for listing.
                    # By not adding 'dirname' back to dirnames_orig, os.walk will not visit it.

        items.sort(key=lambda x: (x["type"] == "lora", x["name"].lower()))
        
        current_relative_path_for_client = os.path.relpath(scan_target_abs, current_lora_collection_root_abs).replace('\\', '/')
        if current_relative_path_for_client == '.':
            current_relative_path_for_client = ""

        parent_path_for_client = ""
        if current_relative_path_for_client:
            parent_path_for_client = os.path.dirname(current_relative_path_for_client).replace('\\', '/')
            if parent_path_for_client == '.': # Should not happen if current_relative_path_for_client is not empty
                parent_path_for_client = ""
        
        response_data = {
            "items": items,
            "currentPath": current_relative_path_for_client,
            "parentPath": parent_path_for_client
        }
        
        return web.json_response(response_data)

    except Exception as e:
        # It's good practice to return a consistent structure even on error, if possible
        return web.json_response({"items": [], "parentPath": path_param if path_param else "", "error": str(e)}, status=500)
    

# --- Embedding API Endpoints --- #

@server.PromptServer.instance.routes.get("/erenodes/search_embeddings")
async def search_embeddings_handler(request):
    raw_query = request.query.get("query", "")
    path_param = request.query.get("path", "") # Current subfolder relative to an embedding root
    EMBEDDING_EXTENSIONS = ('.pt', '.bin', '.safetensors', '.embedding')

    # Handle query-based navigation
    potential_nav_folder = ""
    actual_search_query = raw_query.lower()

    if raw_query.endswith('/') or raw_query.endswith('\\'):
        potential_nav_folder = os.path.normpath(raw_query.strip('/\\'))
        actual_search_query = "" # Clear search query if it was a navigation command
        if path_param:
            path_param = os.path.join(path_param, potential_nav_folder).replace('\\', '/')
        else:
            path_param = potential_nav_folder.replace('\\', '/')

    query = actual_search_query

    try:
        embedding_collection_paths = folder_paths.get_folder_paths("embeddings")
        if not embedding_collection_paths:
            return web.json_response({"items": [], "parentPath": path_param if path_param else ""})

        items = []
        found_relative_paths = set()

        scan_target_abs = None
        current_embedding_collection_root_abs = None

        if path_param:
            normalized_path_param = os.path.normpath(path_param.lstrip('/').lstrip('\\'))
            for emb_root in embedding_collection_paths:
                abs_emb_root = os.path.abspath(emb_root)
                potential_scan_path = os.path.abspath(os.path.join(abs_emb_root, normalized_path_param))
                if os.path.isdir(potential_scan_path) and os.path.commonpath([abs_emb_root, potential_scan_path]) == abs_emb_root:
                    scan_target_abs = potential_scan_path
                    current_embedding_collection_root_abs = abs_emb_root
                    break
            if not scan_target_abs:
                return web.json_response({"items": [], "parentPath": path_param})
        else:
            if embedding_collection_paths:
                scan_target_abs = os.path.abspath(embedding_collection_paths[0])
                current_embedding_collection_root_abs = scan_target_abs
            else:
                return web.json_response({"items": [], "parentPath": ""})


        for dirpath, dirnames_orig, filenames in os.walk(scan_target_abs, topdown=True):
            is_current_scan_level = (os.path.normpath(dirpath) == os.path.normpath(scan_target_abs))

            # Process files
            for filename in filenames:
                if filename.lower().endswith(EMBEDDING_EXTENSIONS):
                    filename_no_ext = os.path.splitext(filename)[0]
                    full_file_path_abs = os.path.join(dirpath, filename)
                    relative_to_collection_root = os.path.relpath(full_file_path_abs, current_embedding_collection_root_abs).replace('\\', '/')
                    # The 'path' for an embedding should be its filename without extension, relative to the embedding collection root.
                    embedding_prompt_path = os.path.splitext(relative_to_collection_root)[0]

                    if query: # Query present, search recursively
                        if query in filename_no_ext.lower() or query in embedding_prompt_path.lower():
                            if embedding_prompt_path not in found_relative_paths:
                                items.append({"name": filename_no_ext, "type": "embedding", "path": embedding_prompt_path, "extension": os.path.splitext(filename)[1]})
                                found_relative_paths.add(embedding_prompt_path)
                    else: # No query, only list if current level is the scan_target_abs
                        if is_current_scan_level:
                            if embedding_prompt_path not in found_relative_paths:
                                items.append({"name": filename_no_ext, "type": "embedding", "path": embedding_prompt_path, "extension": os.path.splitext(filename)[1]})
                                found_relative_paths.add(embedding_prompt_path)
            
            # Process folders
            current_level_dirnames_to_process = list(dirnames_orig) # Make a copy to iterate
            dirnames_orig[:] = [] # Clear dirnames_orig to control recursion.

            for dirname in current_level_dirnames_to_process:
                if dirname.startswith('.') or dirname == "__pycache__":
                    continue

                full_folder_path_abs = os.path.join(dirpath, dirname)
                relative_to_collection_root = os.path.relpath(full_folder_path_abs, current_embedding_collection_root_abs).replace('\\', '/')

                if query: # Query present, search recursively for matching folder names
                    if query in dirname.lower():
                        if relative_to_collection_root not in found_relative_paths:
                            items.append({"name": dirname, "type": "folder", "path": relative_to_collection_root})
                            found_relative_paths.add(relative_to_collection_root)
                    dirnames_orig.append(dirname) # Allow recursion if query is present
                else: # No query, only list if current level is scan_target_abs
                    if is_current_scan_level:
                        if relative_to_collection_root not in found_relative_paths:
                            items.append({"name": dirname, "type": "folder", "path": relative_to_collection_root})
                            found_relative_paths.add(relative_to_collection_root)
                    # If no query, do not recurse by not adding back to dirnames_orig

        items.sort(key=lambda x: (x["type"] == "embedding", x["name"].lower()))

        current_relative_path_for_client = os.path.relpath(scan_target_abs, current_embedding_collection_root_abs).replace('\\', '/')
        if current_relative_path_for_client == '.':
            current_relative_path_for_client = ""

        parent_path_for_client = ""
        if current_relative_path_for_client:
            parent_path_for_client = os.path.dirname(current_relative_path_for_client).replace('\\', '/')
            if parent_path_for_client == '.':
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