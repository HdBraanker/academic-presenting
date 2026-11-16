# Example: research talk (journal club, synthetic)

**Everything here is invented** (drug, trial, authors, journal, numbers). It exists to test Academic Presenting without proprietary or patient data.

| File | What |
|---|---|
| `source.md` | Fictional trial paper (FICTA-1, examplimab in PsA). Internally consistent numbers; CIs checked by hand. |
| `spec.json` | 8-slide, 10-minute journal-club spec built from `source.md`. Covers layouts: title, claim-figure (figure and chart), stat-card, comparison, question, take-home, references. |
| `figures/study-design.png` | Schematic, regenerate with `python3 figures/make_study_design.py` (matplotlib). |

## Deliberate test content
- `c-unmet-need`: background claim that is a secondary citation (caveat says: check primary sources).
- `c-crp`: post hoc subgroup, kind `hypothesis`.
- `c-safety`: descriptive numbers, explicitly not tested.
- `c-tnf-ir`: presenter's extrapolation beyond the trial population, `needs-expert-review`. It appears on the take-home slide on purpose; the quality review (T7) must surface it.

## Validate
```
npm run validate -- examples/research-talk/spec.json
```
