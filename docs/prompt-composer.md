# Prompt Composer

[EreNodes](../README.md) › Prompt Composer

> *One Node to rule them all, One Node to tag them,*
> *One Node to bring them all, and in the prompt bind them.*

<picture><source media="(prefers-color-scheme: dark)" srcset="images/prompt-composer-dark.webp"><source media="(prefers-color-scheme: light)" srcset="images/prompt-composer-light.webp"><img src="images/prompt-composer-dark.webp" alt="Prompt Composer"></picture>

The Composer holds several categories in one node: character, outfit, background, quality, each with its own tags. It outputs the same prompt a chain of separate prompt nodes would.

## Categories

- **Add Category** from the node's ≡ menu, or **Add Category as** to pick its layout straight away. **Create Category from Clipboard** turns a copied prompt into a new category.
- **Rename** or remove a category by right-clicking its header. Each header has its own ≡ and + buttons.
- **Collapse** a category by clicking its header. The layout is saved with the workflow. ≡ → **Expand All** / **Collapse All** handles every category.
- **Bypass** a category with the switch on its header. Its tags stay exactly as they were and come back when it is switched on.
- **Reorder** categories by dragging the header, or drag a category into another Composer. Hold **Alt** over the other Composer to copy it instead.

## Layouts per category

Each category can be drawn as **Cloud**, **Toggle**, **MultiSelect**, **Gallery** or **Multiline** (category ≡ → Layout). A Multiline category is a free text area with autocomplete, next to tag categories in the same node.

## Selecting categories

Ctrl+click or Shift+click headers to select several. Right-click the selection for **Enable**, **Disable**, **Expand**, **Collapse** or **Remove Selected**.

## Output

Categories are joined in order with the node separator (≡ → Options). Empty and bypassed categories are left out. Tags drag between categories and in and out of every other prompt node, exactly as between nodes. See [Tag pills](tag-pills.md).
