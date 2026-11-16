# Template-fill engine (experimental)

Fills **your institution's own PowerPoint template** (`.pptx` or `.potx`) with an approved presentation spec. Slides are created on the template's own layouts, so masters, logos, fonts and colours are inherited exactly. Without a template, use the default engine (`engines/powerpoint/`); nothing changes there. Decision record: ADR-0012.

Requires Python 3 with python-pptx: `python3 -m pip install -r engines/powerpoint-template/requirements.txt`.

## Use

```sh
# 1. Look at what the engine would do with your template (optional, writes an editable map)
npm run build:template -- inspect /path/to/template.pptx --out /path/to/template-map.json

# 2. Generate the storyboard against that template, then obtain explicit approval
node scripts/storyboard.mjs generate spec.json --origin outline --template /path/to/template.pptx --out storyboard.md [--template-map /path/to/template-map.json]

# 3. Render the approved storyboard into the template (same approval gate as always)
node scripts/storyboard.mjs render spec.json storyboard.md --out out/deck.pptx --template /path/to/template.pptx [--template-map /path/to/template-map.json]

# 4. Check the result as usual
npm run render:pptx -- out/deck.pptx --out out/renders/deck
npm run quality -- spec.json --build out/deck.build-report.json --render out/renders/deck/render-report.json -o out/deck.quality-report.md
```

`npm run build:template -- spec.json --template template.pptx -o out/deck.pptx` is the developer path without the gate, like `npm run build:pptx`.

Keep institutional templates and decks made from them out of Git (`local/` and `out/` are ignored).

## How layouts are chosen

`inspect` reads every layout's placeholders (type and position) on all slide masters and assigns seven roles. Layouts that the template's own sample slides use get a small preference:

| Role | Used for | Looks for |
|---|---|---|
| `title` | title slide | title positioned as a cover, with a subtitle placeholder; a picture placeholder is allowed |
| `section` | section divider | section-type layout with a title placeholder (falls back to `title_only`) |
| `text` | text, question, take-home, references | title plus one wide body placeholder |
| `title_only` | stat cards, figures without text | title placeholder; a small kicker above it is allowed |
| `chart`, `table` | chart or table slides | title plus a large object placeholder; the name breaks ties (fall back to `title_only`) |
| `text_visual` | claim with text and a visual | title plus one narrow body placeholder (falls back to the text layout with its body resized) |

The map also records the content frame, a footer area beside a bottom logo when one is present, one-line title constraints, the template's type sizes, and the table style its sample slides use. **Edit the map to override any choice** (set `layout` to another layout name from `layouts_available`), then pass it with `--template-map`. The map is bound to the template file by hash. Generate the storyboard with that same template/map to see per-slide title-length warnings before approval.

## Typography: brand from the template, type from the default engine

By default (`style.typography: "editorial"` in the map) the template supplies what makes it the house style: masters, logo, backgrounds, typefaces and colours. Type sizes and composition are those of the default engine (ADR-0008): 28 pt titles, 22 pt body, large key number, journal-style tables, direct labels on line charts, hairline take-home rows, small uppercase section kicker. Content is drawn inside the template's content frame and kept clear of its logo. Single sizes can be changed under `style.sizes` in the map.

Set `style.typography` to `"template"` to use the template's own body placeholders, sizes, bullets and table style instead.

## What the engine does and does not do

- The slide title always goes into the template's title placeholder (its typeface and colour). In editorial mode body content is native, editable text boxes in the template's body typeface; in template mode it goes into the body placeholder.
- Charts and tables are native and editable, in theme colours. Figures are images, fitted without cropping.
- Stat cards, captions and the citation footer are drawn as text boxes in the template's body font. Numbers use a theme colour with at least 4.5:1 contrast on white.
- Sample slides in the template are removed. Unused placeholders are removed from each slide. Slide numbers are copied from the layout.
- Speaker notes (presenter notes, evidence trail, reveal order, timing) are identical to the default engine.
- Wording is never changed or shortened. A title that wraps pushes the content down. A claim title too long for a narrow text column moves the slide to the wide text layout with the visual beside it; the build report records this per slide (`layout_note`).
- On a one-line title layout with a fixed rule below the title, the engine shrinks the title to a 20 pt floor before allowing wrap. The storyboard shows the approximate character budget. A title that exceeds the floor is flagged for review.
- The title subtitle uses `meta.subtitle` (or `meta.venue`) and every presenter in `meta.presenters`; the central question is added if the available space permits. The default citation footer is 14 pt in the bottom band beside the logo; discussion questions default to 28 pt. Table alignment follows column contents: text left, predominantly numeric columns right.
- A `references` slide draws its full citations as native text, starting at the map's `small` type size and shrinking no lower than 14 pt. If they cannot fit, the build stops and asks for the spec to split the list into approved slides.

Limits (v0.1): one visual per slide; forest plots render as a table; picture placeholders of the template are not used (scientific figures must not be cropped); title-slide kicker text and title-slide citations are not shown when the template has no place for them (listed in the build report). Content areas are assumed to have a light background. The quality report's colour-contrast checks read the spec's design tokens and do not describe a template-filled deck. Always inspect the contact sheet, and open the deck in PowerPoint to check fonts that LibreOffice does not have.
