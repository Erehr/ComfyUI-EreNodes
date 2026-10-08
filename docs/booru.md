# Booru browser

[EreNodes](../README.md) › Booru browser

![Booru browser](images/booru-light.webp#gh-light-mode-only)
![Booru browser](images/booru-dark.webp#gh-dark-mode-only)

The sidebar's Booru tab searches image boards for posts and hands you their tags. It is a tag source, not a downloader: only thumbnails are loaded.

## Sources

Pick one from the tab's view settings button.

| Source | Needs |
|--------|-------|
| **Safebooru** (safebooru.org, default) | Nothing. Safe posts only. |
| **Gelbooru** | An account's user ID and API key, from gelbooru.com → My Account → Options, entered in [Settings](settings.md). |
| **e621** | Nothing. |

Requests go through the ComfyUI server, since these sites do not answer browser requests directly.

## Searching

- Type tags, comma separated, and press **Enter**. Spaces become underscores; `-tag` excludes a tag.
- The search box autocompletes from your tag list; picking a suggestion searches straight away. A term started with `-` completes too, and keeps the `-` on the picked tag.
- **Sort and page** button: **Latest**, **Top rated** or **Random**, and the page to start from. Remembered per source until ComfyUI restarts. Enter re-rolls a random sort.
- More posts load as you scroll.

## Taking tags

- **Hover** a post to see its tags as pills.
- **Click a tag** in the preview to search for just that tag, as on the site.
- **Select tags** in the preview (Ctrl+click, Shift+click, drag a box) and drag them onto a node.
- **Drag the post** onto a prompt node to add all its tags.
- **Right-click → Add as**: a new prompt node of the type you pick, with the post's tags.
- **Right-click → Copy tags**: the post's tags as comma-separated text, for any prompt field. With several posts selected, their tags combined.
- **Right-click → Save as tag group**: the post's tags become a [tag group](tag-groups.md), with its thumbnail as the cover. **Open on …** opens the post on its site.

Tags arrive in the prompt form (`blue hair`, not `blue_hair`). Meta tags such as `highres` and `absurdres` are always left out.

## Filtering

Settings → EreNodes → Sidebar:

- **Booru ratings**: general only, up to sensitive (default), up to questionable, or all. Safebooru holds safe posts only.
- **Booru blocked tags**: posts with any of these are not shown.
- **Booru hidden tags**: posts still show, but these tags are left out of the preview and of drags. Default: `watermark, username, logo, signature`.
- **Gelbooru: show all content**: Gelbooru hides part of its catalogue until a visitor opts in; this sends the same opt-in the site uses.
