# scripts/

Standalone command-line tools. Nothing here is loaded by the extension, imported by a node, or reachable from the ComfyUI UI — these are run by hand, with your own Python, when you want them.

## animadex_import.py

Builds EreNodes tag groups in bulk from the [animadex.net](https://animadex.net) character and artist catalogues: one tag group per character or artist, with its thumbnail as the group's cover.

Standard library only — no `pip install` needed. Python 3.8+.

### Running it

```bash
python animadex_import.py
```

It asks, in order:

| Question | Default | Notes |
| --- | --- | --- |
| Import | Both | Characters, Artists, or both. |
| Tag groups folder | the one EreNodes is set to | The three EreNodes locations (user, `models/tag_groups`, node folder), or any other path. The list is only offered when the script sits inside `custom_nodes`. |
| Download cover images | yes | Thumbnails are saved as `<group>.webp` beside the `.json`. |
| Prefix artist tags with @ | no | Artists only. Writes `@wlop` instead of `wlop` in the tag — Anima and similar models expect artists in that form. The filename never gets the `@`. |
| Artists in a subfolder per first letter | yes | Artists only. Digits and symbols share `#`. |
| Skip artists with fewer posts than | 0 | Artists only. The catalogue has a long tail of artists with very few posts. |
| Overwrite existing tag groups | no | See below. |
| Token | — | Your export token from the AnimaDex account page. Input is hidden, asked on every run and never stored. |

It then downloads the catalogue, prints what it would do (new, rewritten, left alone, covers to download) and asks before writing anything — answering no is a dry run.

Re-running is cheap and safe: a tag group or cover already on disk is skipped, so an interrupted run resumes where it stopped, and a later run picks up whatever the catalogue has gained since.

### Overwrite

**By default an existing tag group is never rewritten.** A tag group is yours once it exists — you drop tags, add your own, put a LoRA in — and it is an input to every saved workflow that uses it, so rewriting it discards those edits with no undo and changes what an old workflow produces.

Answer yes to overwrite when you do want the catalogue's current tags back, for example to add or remove the `@` on an existing artist library. It applies to every group in the run; the summary before the final confirmation shows how many would be rewritten. Covers are add-only even then: delete a `.webp` to have it fetched again.

To rebuild a few groups only, delete their `.json` files and re-run.

### What you get

```
<folder>/Characters/<Series>/<Character>.json
<folder>/Characters/<Series>/<Character>.webp
<folder>/Artists/<A>/<Artist>.json
<folder>/Artists/<A>/<Artist>.webp
```

- A character group holds its trigger words (name, series) followed by its core tags, underscores turned into spaces. A series with fewer than 3 characters goes to `Others`.
- An artist group holds a single pill: the artist's trigger, or its slug with underscores turned into spaces, optionally prefixed with `@`.
- Covers arrive at AnimaDex's 445px width and are stored as-is; EreNodes only downscales covers wider than 480px.

### Notes

- **Expect a big collection.** The full catalogues are tens of thousands of entries. Turn on the sidebar's tag index (the tag icon in the search box) afterwards and let it build once.
- Downloads retry on timeouts and on 429/5xx, honouring `Retry-After`. Covers are written to a `.part` file and renamed, so a cancelled run never leaves a truncated image.
- A cover that 404s is skipped quietly — a very recent entry may not have a thumbnail yet.
- Filenames are sanitised for Windows, including reserved device names, and two entries that would land on the same filename are kept apart.
- The token is only sent to animadex.net, never along a redirect, and only `https://` URLs are fetched.
