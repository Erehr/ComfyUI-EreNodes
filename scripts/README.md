# scripts/

Standalone command-line tools. Nothing here is loaded by the extension, imported
by a node, or reachable from the ComfyUI UI — these are run by hand, with your
own Python, when you want them.

## animadex_to_tag_groups.py

Builds EreNodes tag groups in bulk from the [animadex.net](https://animadex.net)
character catalogue: one tag group per character, filed under its series, with
the character's thumbnail as the group's cover.

Standard library only — no `pip install` needed. Python 3.8+.

### Getting a token

The catalogue export needs an export token from your AnimaDex account page. Pass
it with `--token`, or put it in `ANIMADEX_IMPORT_TOKEN` to keep it out of your
shell history.

### Running it

Look before you leap — this writes tens of thousands of files:

```bash
python animadex_to_tag_groups.py --token YOUR_TOKEN \
    --out "C:/ComfyUI/models/tag_groups" --dry-run --limit 20
```

`--dry-run` reports the plan and writes nothing. Drop both flags for the real run:

```bash
python animadex_to_tag_groups.py --token YOUR_TOKEN \
    --out "C:/ComfyUI/models/tag_groups"
```

Point `--out` at the root you have EreNodes configured to use — the folder itself,
not a subfolder. **Settings → EreNodes → Tag Groups Folder** decides which that is;
`ComfyUI models/tag_groups` is the one that survives reinstalls and Manager updates.

Re-running is cheap and safe: a tag group or cover already on disk is skipped, so
an interrupted run resumes where it stopped, and a later run picks up characters
the catalogue has gained since.

**By default an existing tag group is never rewritten**, and that default is
worth keeping. Two reasons:

- A tag group is yours once it exists. You edit them — drop a tag you don't want,
  add one you do, put a LoRA in. A re-import that "updated" your groups would
  throw that away wholesale, with nothing to undo it.
- A workflow is supposed to be reproducible. A tag group referenced by a saved
  workflow is an input to it, so changing the tags behind an existing name means
  the same workflow produces a different image than it did last week.

`--overwrite` opts out of that, for when you do want the catalogue's current tags
back. It is entirely optional, off unless you type it, and it applies to every
group in the run — so do a `--dry-run --overwrite` first to see how many would be
rewritten. Covers are add-only even then: refetching tens of thousands of images
to replace them with the same bytes is hours of transfer for nothing, so delete a
`.webp` if you want it fetched again.

To rebuild just a few characters, deleting their `.json` files and re-running
stays the safer move — it touches only what you chose.

### Flags

| Flag | Default | What it does |
| --- | --- | --- |
| `--out PATH` | *required* | Tag groups root to write into. |
| `--token TOKEN` | `$ANIMADEX_IMPORT_TOKEN` | Export token. |
| `--top NAME` | `Characters` | Folder created under `--out`. |
| `--min-series N` | `3` | A series with fewer characters than this goes to `Others` instead of getting its own folder. |
| `--no-covers` | off | Write the JSON only, no thumbnails. |
| `--overwrite` | off | Rewrite tag groups that already exist, discarding edits made to them. Covers are unaffected. |
| `--keep-case` | off | Keep danbooru's `lowercase_underscored` names instead of title-casing them. |
| `--limit N` | all | Only process the first N characters. |
| `--concurrency N` | `8` | Parallel cover downloads. |
| `--csv PATH` | — | Use a local `characters.csv` instead of downloading one. |
| `--dry-run` | off | Report the plan, write nothing. |

`--csv` with no `--token` skips covers and says so: the thumbnail URLs come from
the manifest, not from the CSV. Pass both to use a local CSV *and* fetch covers.

### What you get

```
<out>/Characters/<Series>/<Character>.json     the tags
<out>/Characters/<Series>/<Character>.webp     the cover
```

EreNodes serves a cover from the `.webp` sitting beside the `.json`, so the
thumbnails appear in the sidebar with no further step. The images arrive at
AnimaDex's own 445px width and are stored as-is: EreNodes only downscales a cover
wider than 480px (`PREVIEW_WIDTH` in `py/images.py`), so these would pass through
untouched anyway — resizing them here would only cost quality.

Tags are the character's trigger words followed by their core tags, each as a
plain enabled pill — exactly the shape the nodes write, so a group can be edited
in the sidebar like any other.

### Notes

- **Expect a big collection.** The full catalogue is tens of thousands of
  characters. Turn on the sidebar's tag index (the tag icon in the search box)
  afterwards, and let it build once.
- Downloads retry on timeouts and on 429/5xx, honouring `Retry-After`. Covers are
  written to a `.part` file and renamed, so a cancelled run never leaves a
  truncated image that the next run would mistake for a finished one.
- A cover that 404s is skipped quietly — a character added to the catalogue very
  recently may not have a thumbnail yet.
- Filenames are sanitised for Windows, including its reserved device names, and
  two characters that would land on the same filename are kept apart.

## animadex_artists_to_tag_groups.py

The same thing for the artist catalogue: one tag group per artist, with the
artist's thumbnail as the cover.

```bash
python animadex_artists_to_tag_groups.py --token YOUR_TOKEN \
    --out "C:/ComfyUI/models/tag_groups" --dry-run --limit 20
```

Same token, same manifest, and the same flags as the character script, so
everything above about `--dry-run`, `--overwrite` and re-running applies here
too. Two differences:

| Flag | Default | What it does |
| --- | --- | --- |
| `--top NAME` | `Artists` | Folder created under `--out`. |
| `--group-by initial\|none` | `initial` | A subfolder per first letter, or everything in one folder. Digits and symbols share `#`. |
| `--min-count N` | `0` | Skip artists below this popularity count. |

### What you get

```
<out>/Artists/<A>/<Artist>.json     the tag
<out>/Artists/<A>/<Artist>.webp     the cover
```

An artist row in the catalogue carries no tag list of its own — unlike a
character, which has `core_tags` — so each group holds a single pill: the
artist's `trigger`, or its slug with underscores turned into spaces. That is the
tag you prompt with; the value of the import is having every artist named,
filed and thumbnailed in the sidebar.

`--group-by initial` is the default because a flat folder of several thousand
tag groups is unpleasant to browse. `--min-count` is the other way to keep it
small: the catalogue has a long tail of artists with very few posts.
