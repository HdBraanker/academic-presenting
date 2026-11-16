# Module: quality review

Status: **working (v0.1)**, mechanical checks only.

```
npm run quality -- examples/research-talk/spec.json \
  --build out/ficta1.build-report.json \
  --render out/renders/<name>/render-report.json \
  -o out/ficta1.quality-report.md
```
Writes `<name>.quality-report.md` (for people) and `.json` (for agents). Exit code 1 when there are critical findings.

## What it checks
| Dimension | Checks |
|---|---|
| Scientific integrity | validator errors (critical) and warnings; every `needs-expert-review` claim that reaches a slide (major); numbers in titles, notes, text, bullets, tables and stats traced to claims; derived NNT/NNH recomputed from percentage-point effects; hypothesis titled as fact; causal verbs without a causal claim |
| Narrative | timing vs slot, missing timings, generic titles, content slides without a claim, missing take-home |
| Visual (anti-slop) | 3 identical layouts in a row, >5 bullets, >50 words (unless density high), AI-style phrasing, evaluative words without criterion, redrawn figures |
| Accessibility | WCAG-style contrast of token colors against the background, very short alt text, font findings from the render check |
| Technical | build report (editability, engine warnings), render report findings, approved small type; missing reports are reported as **not run** |

Severity follows `references/anti-slop.md`: critical blocks a "ready" label, major needs a fix or recorded acceptance, minor is a suggestion.

Full bibliographic entries on a slide with `layout: "references"` are exempt from result-number tracing; their years, volumes, pages and DOIs are source metadata. This exemption does not apply to ordinary `text` slides. Keep reference content on the references layout rather than using a text-slide workaround.

## Status line
- `not-ready`: critical findings.
- `ready-with-documented-limitations`: no critical, but major findings that need a decision.
- `no-blocking-issues-found`: automated checks found nothing blocking. Still not scientific verification.

## Limits
- No check reads the source documents. `source-backed` is taken from the spec, not re-verified.
- Number tracing compares values, not meaning: a correct number in a wrong context passes.
- Word lists for AI phrasing and evaluative words are short and English-only.
