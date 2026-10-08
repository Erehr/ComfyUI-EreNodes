# Autocomplete

[EreNodes](../README.md) › Autocomplete

![Autocomplete](images/autocomplete-light.webp#gh-light-mode-only)
![Autocomplete](images/autocomplete-dark.webp#gh-dark-mode-only)

Tag suggestions in every textarea, in the + search of prompt nodes, and in the sidebar search boxes.

## Tag lists

Built-in Danbooru and e621 lists, with post counts and aliases. Put your own CSV files in `ComfyUI/user/__erenodes/autocomplete` and pick one in Settings → EreNodes → Autocomplete → **Tag list (CSV)**.

## Searching

- Matches from the start of any word: `gym` finds `fitness gym`, `shirt` finds `t-shirt`, but `ness` does not find `fitness`. A tag (or alias) that is exactly what you typed comes first.
- Tags already in the prompt are left out, in textareas as well as in tag nodes. By default a used tag stays reachable through its remaining aliases.
- An alias is replaced by its canonical tag when picked.

## Category filters

A prefix narrows the search to one category:

| Prefix | Category |
|--------|----------|
| `artist:` `art:` | Artists |
| `character:` `char:` | Characters |
| `copyright:` `copy:` | Series |
| `general:` `gen:` | General tags |
| `meta:` | Meta tags |
| `species:` `lore:` | e621 species and lore |
| `@` | Artists, and the `@` stays on the inserted name, as Anima prompts an artist |

Post counts are coloured by category (artist, character, copyright, meta) with Danbooru's colours.

## Aliases

Settings → EreNodes → Autocomplete → **Alias handling**:

- **Listed under the tag** (default)
- **In a submenu**, opened by hovering or the right arrow
- **As separate suggestions**

## LoRAs, embeddings and tag groups inline

![File browser](images/autocomplete-files-light.webp#gh-light-mode-only)
![File browser](images/autocomplete-files-dark.webp#gh-dark-mode-only)

Type `<lora:` or `lora:`, `embedding:` or `group:` and the menu switches to a file browser with folders and preview images. The pick is written as `<lora:name:1.0>`, `embedding:name`, or, for a tag group, a pill in tag nodes and its tags in a textarea.

## Keys

- **Up/Down** to move, **Enter** or **Tab** to insert, **Esc** to close.
- **Right** opens an alias submenu or a folder; **Left** goes back.

## Where it runs

- **In every textarea**: all of ComfyUI's text widgets. Turn it off to keep it only in EreNodes nodes.
- **Skip these textareas**: CSS selectors for textareas that bring their own autocomplete, so two menus never open at once.

See [Settings](settings.md) for the full list.
