import os
import json
import re
import server # ComfyUI's server instance
from aiohttp import web
from .prompt_csv import TAG_TYPES, DEFAULT_ENCODING, CSV_FILES_PATH, load_tags_from_csv
from .settings_utils import get_erenodes_settings, save_erenodes_settings

# --- Tag Group API Endpoints --- #

current_file_path = os.path.dirname(os.path.realpath(__file__))
prompts_dir = os.path.join(current_file_path, "prompts")

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
        print(f"[EreNodes API] Error refreshing autocomplete for {csv_file} after setting active: {e}")
    
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