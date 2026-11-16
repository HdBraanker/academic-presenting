# Local house-style import (experimental)

Use a local `.pptx` or `.potx` house-style file to extract theme fonts, colors, one solid background, fixed edge bars, and one small PNG/JPEG logo. The original template and generated manifests stay local; do not commit institutional or personal assets. The extracted colors and fonts override presentation choices before storyboard review (ADR-0011).

The importer reads the first slide master and, optionally, one numbered layout. Complete the presenter's intake record first (ADR-0010), then select a content layout and, if needed, a distinct title layout from the **same** template:

```sh
python3 modules/house-style/extract_template.py /path/to/template.pptx --layout 4 --out /tmp/content-style
python3 modules/house-style/extract_template.py /path/to/template.pptx --layout 2 --out /tmp/title-style
node modules/house-style/house-style.mjs prepare /tmp/content-style/manifest.json spec.json --title-manifest /tmp/title-style/manifest.json --out /tmp/styled-spec.json
node scripts/storyboard.mjs generate /tmp/styled-spec.json --origin outline --out /tmp/styled-storyboard.md
```

Review the styled spec, storyboard, and import warnings. The presenter must explicitly approve the exact storyboard before the normal `scripts/storyboard.mjs approve` step. Then render:

```sh
node modules/house-style/house-style.mjs render /tmp/content-style/manifest.json /tmp/styled-spec.json /tmp/styled-storyboard.md --title-manifest /tmp/title-style/manifest.json --out /tmp/styled-deck.pptx
npm run render:pptx -- /tmp/styled-deck.pptx --out /tmp/styled-render
```

The `prepare` command saves a receipt next to the styled spec and rebases existing local intake, profile, and figure paths when the styled spec is written elsewhere. The render command checks this receipt, both manifests, and the storyboard approval receipt. Changing any of them requires preparation and approval again. No template content is sent to an external service.

Import is intentionally limited. Vector logos, grouped shapes, gradients, photos, complex title artwork, and multiple layout variants are reported as unsupported or require manual review. A selected logo asset is copied into the local import directory. An imported deck is native editable for its text, shapes, tables, and charts; fixed logo imagery is not editable. Always inspect the rendered contact sheet and the `.build-report.json` limitations before use.
