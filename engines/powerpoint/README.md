# Engine: PowerPoint (PptxGenJS)

Status: **working (v0.1)**.

```
npm run build:pptx -- examples/research-talk/spec.json -o out/ficta1.pptx
```
Writes the `.pptx` and a `.build-report.json` next to it. Refuses to render a spec with validation errors.

## What it does
- 16:9 (LAYOUT_WIDE). Layouts: `title`, `section`, `claim-figure`, `stat-card`, `comparison`, `question`, `take-home`, `references`, fallback `text`.
- Native, editable text, shapes, tables and line/bar/scatter charts. Figures are images (alt text set) and the report marks those slides `editable: partial`.
- Design tokens from `spec.design` (fonts, colors, `min_font_pt`, light/dark). No size below `min_font_pt`, except the 12 pt citation footer and slide number.
- Default visual language: editorial, one left edge, hairlines instead of panels, journal-style tables, direct chart labels (ADR-0008).
- Citation footer from the sources of the claims on the slide (`citation_display: none` to suppress). Slide numbers.
- Speaker notes = presenter notes + **evidence trail** per claim (status, source, locator, caveats) + reveal order + planned time. `needs-expert-review` claims are marked `!!` in the notes and as a warning in the report, never on the slide itself (ADR-0008).
- Wide figures (aspect > 1.9) get full width with text below; others sit left with a text column on the right.

## Limits (honest)
- No PowerPoint animations; reveal order goes to notes.
- Text fit is estimated, not measured. Use the render check (T5).
- One visual per claim-figure slide. Forest plots fall back to a table.
- The engine never rewrites claim text or numbers; layout problems are reported, not "fixed" by changing content or shrinking below the minimum size.
