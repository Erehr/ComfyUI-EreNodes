import os

# Every image format this pack handles: covers it stores, and uploads it reads metadata from.
# Order matters — view_file_handler probes these in sequence.
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp')

PREVIEW_WIDTH = 480
PREVIEW_QUALITY = 85
PREVIEW_EXT = ".webp"

# Pillow only refuses above 2 x MAX_IMAGE_PIXELS and merely warns below it, so a 150 KB PNG could cost ~800 MB to decode.
MAX_SOURCE_PIXELS = 40_000_000


# Raised when an upload cannot be turned into a preview.
class PreviewError(Exception):
    pass


# Write `fileobj` as `<basename>.webp` in `dest_dir`, returning the name.
# Raises PreviewError rather than falling back to storing the original.
def save_preview_image(fileobj, dest_dir, basename):
    try:
        from PIL import Image
    except ImportError as e:
        raise PreviewError("Pillow is not installed") from e

    try:
        fileobj.seek(0)
    except Exception:
        pass

    try:
        with Image.open(fileobj) as image:
            # open() reads only the header, so nothing is decoded before this.
            if image.width * image.height > MAX_SOURCE_PIXELS:
                raise PreviewError(f"Image too large ({image.width}x{image.height}); the limit is {MAX_SOURCE_PIXELS // 1_000_000}M pixels")

            # Some formats (animated WebP/GIF) are multi-frame; a cover is a still, so take the first frame and drop the rest.
            image.seek(0)

            # thumbnail() fits the width and never upscales.
            box = (PREVIEW_WIDTH, MAX_SOURCE_PIXELS)
            # Palette and alpha modes must go through RGBA: the alpha is lost otherwise, and a palette image resizes nearest-neighbour.
            if image.mode in ("RGBA", "LA", "P", "PA"):
                converted = image.convert("RGBA")
                converted.thumbnail(box, Image.LANCZOS)
            else:
                # Before convert(): thumbnail() lets a JPEG decode at reduced scale.
                image.thumbnail(box, Image.LANCZOS)
                converted = image.convert("RGB")

            os.makedirs(dest_dir, exist_ok=True)
            filename = f"{basename}{PREVIEW_EXT}"
            converted.save(
                os.path.join(dest_dir, filename),
                format="WEBP",
                quality=PREVIEW_QUALITY,
                method=4,
            )
            return filename
    except PreviewError:
        raise
    except Exception as e:
        raise PreviewError(f"Could not convert image: {e}") from e


# True when Pillow recognises `fileobj` as an intact image, from the header and checksums alone.
def is_image(fileobj):
    try:
        from PIL import Image
        fileobj.seek(0)
        with Image.open(fileobj) as image:
            image.verify()
        return True
    except Exception:
        return False


# Delete same-named covers in other formats, so a replaced one stops being served — view_file_handler probes extensions in a fixed order.
def remove_other_previews(dest_dir, basename, keep):
    for ext in IMAGE_EXTENSIONS + (PREVIEW_EXT,):
        for candidate in (f"{basename}{ext}", f"{basename}.preview{ext}"):
            if candidate == keep:
                continue
            path = os.path.join(dest_dir, candidate)
            if os.path.isfile(path):
                try:
                    os.remove(path)
                except Exception as e:
                    print(f"[EreNodes] Could not remove old preview '{candidate}': {e}")
