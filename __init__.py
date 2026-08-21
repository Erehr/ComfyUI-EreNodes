# Importing these registers the /erenodes/* API routes as a side effect.
from .py import prompt_api  # noqa: F401
from .py import prompt_csv  # noqa: F401

# No routes of its own (prompt_api owns those), but importing it here surfaces
# any problem at startup rather than on the first image drop.
from .py import prompt_extractor  # noqa: F401

from .py import prompt
from .py import prompt_filter
from .py import prompt_lora_stack

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_CLASS_MAPPINGS.update(prompt.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(prompt_filter.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(prompt_lora_stack.NODE_CLASS_MAPPINGS)

NODE_DISPLAY_NAME_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS.update(prompt.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(prompt_filter.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(prompt_lora_stack.NODE_DISPLAY_NAME_MAPPINGS)


__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
