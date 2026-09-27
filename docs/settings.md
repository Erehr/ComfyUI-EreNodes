# Settings

[EreNodes](../README.md) › Settings

Everything under ComfyUI **Settings → EreNodes**.

## Autocomplete

| Setting | Default | |
|---------|---------|---|
| In every textarea | On | Autocomplete in all of ComfyUI's text widgets. |
| In EreNodes prompts | On | Keep it in EreNodes nodes when "In every textarea" is off. |
| Suggestions shown | 20 | 1 to 100. |
| Alias handling | Listed under the tag | Or in a submenu, or as separate suggestions. |
| Tags already in the prompt | Offer its remaining aliases | Or hide the tag and all its aliases. |
| Skip these textareas | Easy-Use Anima prompt | CSS selectors for textareas with their own autocomplete. |
| Tag list (CSV) | First available | The list autocomplete and Prompt Filter use. |

## Tag Groups

| Setting | Default | |
|---------|---------|---|
| Storage folder | ComfyUI user folder | Or `models/tag_groups`, shared across installs. See [Tag groups](tag-groups.md#storage-folder). |

## Sidebar

| Setting | Default | |
|---------|---------|---|
| Node created on click | Prompt Cloud | The node a clicked tag group creates. |
| Booru ratings | Up to sensitive | General only, up to sensitive, up to questionable, all. |
| Booru blocked tags | (none) | Posts with these are not shown. |
| Booru hidden tags | watermark, username, logo, signature | Left out of previews and drags. |
| Gelbooru user ID | (none) | From gelbooru.com → My Account → Options. |
| Gelbooru API key | (none) | Stored in ComfyUI's settings file and sent only to gelbooru.com. |
| Gelbooru: show all content | Off | Gelbooru's opt-in to its full catalogue. |

## Nodes

| Setting | Default | |
|---------|---------|---|
| Default tag separator | `, ` | For new nodes. `\n` is a line break. |
| Default node separator | `,\n\n` | Between a node and its prefix, and between Composer categories. |
| Scrollable Tag Area | Off | On: a node smaller than its tags scrolls. Off: the node grows to fit. |

Existing nodes keep their own separators; change them in the node's ≡ → Options.
