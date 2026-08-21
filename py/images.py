import os

# Every image format this pack handles — covers it stores, and uploads it reads metadata from.
# Order matters: view_file_handler probes these in sequence.
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp')

# Matches what ComfyUI-Lora-Manager stores, and is comfortably above any size the UI displays (the sidebar's grid tiles are 96px; the hover preview caps at 320px wide).
PREVIEW_WIDTH = 480
PREVIEW_QUALITY = 85
PREVIEW_EXT = ".webp"


# Raised when an upload cannot be turned into a preview.
class PreviewError(Exception):
    pass


# Write `fileobj` as `<basename>.webp` in `dest_dir`, returning the name.
#
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
            # Some formats (animated WebP/GIF) are multi-frame; a cover is a still, so take the first frame and drop the rest.
            image.seek(0)

            # Palette and alpha modes must go through RGBA or the alpha channel is lost; everything else flattens to RGB.
            if image.mode in ("RGBA", "LA", "P", "PA"):
                converted = image.convert("RGBA")
            else:
                converted = image.convert("RGB")

            # Never upscale — a source narrower than the target keeps its own size rather than being blown up and re-encoded for nothing.
            if converted.width > PREVIEW_WIDTH:
                height = max(1, round(converted.height * PREVIEW_WIDTH / converted.width))
                converted = converted.resize((PREVIEW_WIDTH, height), Image.LANCZOS)

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
