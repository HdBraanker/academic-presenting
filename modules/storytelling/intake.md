# Intake: the presenter's input comes first (ADR-0010)

The agent never proposes a storyboard from source material alone.

## 1. Collect what the presenter already has
Ask for notes, an outline, highlights in the paper, a previous deck, or a voice memo transcript. Messy is fine. Copy the presenter's words **verbatim** into the intake record; do not tidy their meaning.

## 2. Map the input against the intake questions
For each question below, mark: answered by the notes (quote the line), partly answered, or open.

| # | Question | Why it matters |
|---|---|---|
| 1 | Occasion, audience, time slot; who presents with you; exact title-slide occasion line | Depth, pace, number of slides; `meta.occasion` and all `meta.presenters` |
| 2 | Language of the slides | |
| 3 | The one message the audience must remember | Becomes the take-home and the title logic |
| 4 | Why this topic or paper, for this audience, now | The opening |
| 5 | What do you find convincing, and what do you doubt? | The discussion; prevents a summary-only talk |
| 6 | Which discussion do you want to provoke? | Question slides |
| 7 | Own figures, images, data or a case to include | What only the presenter can bring |
| 8 | Include a full references slide at the end? | Default yes; a presenter's local profile may set `references_slide_default: false`. A choice for this talk overrides that default. |
| 9 | Material from others you may want to show (a collaborator's slides, figures, unpublished data): what is it, whose is it, may you show it here? | Arrives mid-build otherwise and changes the plan; unpublished or borrowed material needs a label on the slide and the owner's permission |

## 3. Interview only the open questions
At most four at a time, each skippable, with the profile's defaults offered. Never ask what the notes already answer.

## 4. Write the intake record and set `status: complete`
```markdown
---
status: complete            # or in-progress
presenter_input: notes      # notes | outline | interview | notes+interview
date: YYYY-MM-DD
---
## Presenter's own input (verbatim)
## Interview (question | answer | source: notes/interview/default)
## Questions the presenter raised (to answer from the source or flag)
## Title slide (exact occasion line, presenter/co-presenter names and affiliations | source: notes/interview/default)
## References slide (yes/no | source: notes/interview/profile/default)
## Team and budget facts to confirm (names, roles, amounts, period, funding source | source: notes/interview/document)
## Material from others (what | owner | published? | permission to show: yes/no/ask | source: notes/interview)
## Gaps the agent will fill (these become origin: proposed)
```

## 5. Build the spec with `origin`
- `presenter`: slide or claim that exists because the presenter said so.
- `source`: taken from the source document (with locator).
- `proposed`: the agent's suggestion; the presenter must agree in the storyboard review.

Then: `node scripts/storyboard.mjs generate <spec.json> --origin outline` (notes present) or `--origin source` (interview only).

Add a `references` slide to the spec by default, using full citations from `sources`. If the presenter chooses no in the intake, omit it for this talk; keep the short citations and evidence trail on relevant slides and in speaker notes. An explicit talk choice wins over the profile default. Decide this before generating the storyboard so adding or removing the slide triggers the normal approval gate.

Transfer the confirmed occasion line to `meta.occasion` and every presenter/co-presenter to `meta.presenters`. Keep any team or budget details the agent supplies as `proposed` until the presenter checks the names, roles, amounts, time period and funding context in the storyboard. Do not infer a missing team member or budget figure from a partial source.
