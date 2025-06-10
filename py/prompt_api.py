import os
import json
import re
import server # ComfyUI's server instance
from aiohttp import web

# --- Tag Group API Endpoints --- #

# Get the directory of the current script (tag_api.py)
current_script_dir = os.path.dirname(os.path.abspath(__file__))
# Path to the comfyui_erenodes directory (assuming py folder is directly inside it)
base_erenodes_dir = os.path.abspath(os.path.join(current_script_dir, ".."))
# Define the prompts directory path within the erenodes extension
prompts_dir = os.path.join(base_erenodes_dir, "__prompts__") # This is your TAG_GROUPS_DIR

# Ensure the __prompts__ directory exists
if not os.path.exists(prompts_dir):
    os.makedirs(prompts_dir)
    print(f"[EreNodes] Created directory: {prompts_dir}")

def sanitize_filename(filename):
    # Remove potentially unsafe characters, keep it simple, allow spaces and underscores
    # Replace known problematic characters with underscore
    filename = re.sub(r'[\/:*?"<>|]', '_', filename)
    # Basic protection against directory traversal
    filename = filename.replace('..', '_')
    return filename.strip()

# --- API Endpoints ---

@server.PromptServer.instance.routes.get("/erenodes/list_tag_groups")
async def list_tag_groups_handler(request):
    path_param = request.query.get("path", "")
    print(f"[EreNodes DEBUG] list_tag_groups_handler called. path_param: '{path_param}'") # DEBUG

    safe_path_param = path_param.lstrip('/').lstrip('\\') # Remove leading slashes
    safe_path_param = safe_path_param.replace("..", "_") # Prevent directory traversal
    print(f"[EreNodes DEBUG] safe_path_param: '{safe_path_param}'") # DEBUG

    print(f"[EreNodes DEBUG] prompts_dir: '{prompts_dir}' (abs: '{os.path.abspath(prompts_dir)}')") # DEBUG

    current_scan_path = os.path.abspath(os.path.join(prompts_dir, safe_path_param))
    print(f"[EreNodes DEBUG] current_scan_path: '{current_scan_path}'") # DEBUG

    abs_prompts_dir = os.path.abspath(prompts_dir)
    if not current_scan_path.startswith(abs_prompts_dir):
        print(f"[EreNodes WARNING] Forbidden path access attempt: query_path='{path_param}', resolved_to='{current_scan_path}', base_dir='{abs_prompts_dir}'")
        return web.json_response({"error": "Forbidden path"}, status=403)

    if not os.path.exists(current_scan_path):
        print(f"[EreNodes DEBUG] Path does not exist: {current_scan_path}") # DEBUG
        return web.json_response([])
    if not os.path.isdir(current_scan_path):
        print(f"[EreNodes DEBUG] Path is not a directory: {current_scan_path}") # DEBUG
        return web.json_response([])

    items = []
    print(f"[EreNodes DEBUG] Scanning directory: {current_scan_path}") # DEBUG
    try:
        for entry_index, entry in enumerate(os.listdir(current_scan_path)):
            print(f"[EreNodes DEBUG]   Entry {entry_index}: '{entry}'") # DEBUG
            entry_path = os.path.join(current_scan_path, entry)
            print(f"[EreNodes DEBUG]     Full entry_path: '{entry_path}'") # DEBUG

            if os.path.isdir(entry_path):
                print(f"[EreNodes DEBUG]     '{entry}' IS a directory.") # DEBUG
                if not entry.startswith('.') and entry != "__pycache__":
                    items.append({"name": entry, "type": "folder"})
                    print(f"[EreNodes DEBUG]       Added as folder: {entry}") # DEBUG
                else:
                    print(f"[EreNodes DEBUG]       Skipped (dotfile/pycache): {entry}") # DEBUG
            elif os.path.isfile(entry_path) and entry.lower().endswith(".json"):
                print(f"[EreNodes DEBUG]     '{entry}' IS a .json file.") # DEBUG
                items.append({"name": entry, "type": "file"})
                print(f"[EreNodes DEBUG]       Added as file: {entry}") # DEBUG
            else:
                print(f"[EreNodes DEBUG]     '{entry}' is neither a recognized folder nor a .json file. Skipping.") # DEBUG

        items.sort(key=lambda x: (x["type"] == "file", x["name"].lower()))
        print(f"[EreNodes DEBUG] Final items to be sent: {items}") # DEBUG
        return web.json_response(items)
    except Exception as e:
        print(f"[EreNodes ERROR] Error during os.listdir or processing for path '{current_scan_path}': {e}")
        return web.json_response({"error": f"Error listing files: {str(e)}"}, status=500)

@server.PromptServer.instance.routes.get("/erenodes/get_tag_group")
async def get_tag_group_handler(request):
    filename_param = request.query.get("filename")

    if not filename_param:
        return web.json_response({"error": "Filename not provided"}, status=400)

    safe_filename = filename_param.lstrip('/').lstrip('\\')
    safe_filename = safe_filename.replace("..", "_")

    if os.path.isabs(safe_filename):
        safe_filename = os.path.basename(safe_filename)

    file_path = os.path.abspath(os.path.join(prompts_dir, safe_filename))

    if not file_path.startswith(os.path.abspath(prompts_dir)):
        print(f"[EreNodes] Forbidden path access attempt for get_tag_group: {filename_param} resolved to {file_path}")
        return web.json_response({"error": "Forbidden path"}, status=403)

    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        print(f"[EreNodes] Tag group file not found: {file_path}")
        return web.json_response({"error": "Tag group not found"}, status=404)

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return web.json_response(data)
    except json.JSONDecodeError:
        print(f"[EreNodes] Invalid JSON in tag group file: {file_path}")
        return web.json_response({"error": "Invalid JSON format in tag group file"}, status=500)
    except Exception as e:
        print(f"[EreNodes] Error reading tag group file '{filename_param}': {e}")
        return web.json_response({"error": f"Error reading file: {str(e)}"}, status=500)

@server.PromptServer.instance.routes.post("/erenodes/save_tag_group")
async def save_tag_group_handler(request):
    try:
        data = await request.json()
        filename = data.get("filename")
        tags_json = data.get("tags_json")
        path_param = data.get("path", "")

        if not filename or tags_json is None:
            return web.json_response({"error": "Filename or tags_json not provided"}, status=400)

        safe_path_param = path_param.lstrip('/').lstrip('\\').replace("..", "_")
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not target_dir.startswith(os.path.abspath(prompts_dir)):
            print(f"[EreNodes WARNING] Forbidden save path attempt: path_param='{path_param}', resolved_target_dir='{target_dir}'")
            return web.json_response({"error": "Forbidden save path"}, status=403)

        os.makedirs(target_dir, exist_ok=True)
        safe_filename = sanitize_filename(os.path.basename(filename))
        if not safe_filename.lower().endswith(".json"):
            safe_filename += ".json"

        file_path = os.path.join(target_dir, safe_filename)

        if os.path.isdir(file_path):
            return web.json_response({"error": "A directory with this name already exists at the target location."}, status=400)

        tags_data = json.loads(tags_json)
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(tags_data, f, indent=2)

        display_path = os.path.join(safe_path_param, safe_filename) if safe_path_param else safe_filename
        print(f"[EreNodes INFO] Tag group '{display_path}' saved successfully to '{file_path}'")
        return web.json_response({"message": f"Tag group '{display_path}' saved successfully."})
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON format for tags_json."}, status=400)
    except Exception as e:
        print(f"[EreNodes ERROR] Error saving tag group: {e}")
        return web.json_response({"error": str(e)}, status=500)

@server.PromptServer.instance.routes.post("/erenodes/create_folder")
async def create_folder_handler(request):
    try:
        data = await request.json()
        path_param = data.get("path", "")
        folder_name = data.get("folderName")

        if not folder_name:
            return web.json_response({"error": "Folder name not provided"}, status=400)

        safe_path_param = path_param.lstrip('/').lstrip('\\').replace("..", "_")
        target_dir = os.path.abspath(os.path.join(prompts_dir, safe_path_param))

        if not target_dir.startswith(os.path.abspath(prompts_dir)):
            print(f"[EreNodes WARNING] Forbidden folder creation path attempt: {path_param}")
            return web.json_response({"error": "Forbidden path"}, status=403)

        safe_folder_name = sanitize_filename(folder_name)
        new_folder_path = os.path.join(target_dir, safe_folder_name)

        if os.path.exists(new_folder_path):
            return web.json_response({"error": "A folder or file with this name already exists."}, status=409)

        os.makedirs(new_folder_path)
        print(f"[EreNodes INFO] Created folder: {new_folder_path}")
        return web.json_response({"message": "Folder created successfully."})
    except Exception as e:
        print(f"[EreNodes ERROR] Error creating folder: {e}")
        return web.json_response({"error": str(e)}, status=500)