from .py import prompt_api
from .py import prompt_csv
from .py import prompt
from .py import prompt_filter

NODE_CLASS_MAPPINGS = {}
NODE_CLASS_MAPPINGS.update(prompt.NODE_CLASS_MAPPINGS)
NODE_CLASS_MAPPINGS.update(prompt_filter.NODE_CLASS_MAPPINGS)

NODE_DISPLAY_NAME_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS.update(prompt.NODE_DISPLAY_NAME_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(prompt_filter.NODE_DISPLAY_NAME_MAPPINGS)

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]