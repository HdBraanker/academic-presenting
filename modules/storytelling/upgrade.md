# Upgrade an existing deck (T26, ADR-0018)

Status: **experimental, agent-assisted.** Diagnosis, scope and change plan are guidance for the agent; there is no command for them. The build runs through the normal create pipeline and its storyboard gate. Editing the presenter's `.pptx` in place is **planned** (T33): do not do it inside this workflow and do not present it as available.

Use this when the presenter brings a finished or nearly finished deck and wants it better, not a new talk.

## 1. Intake for an upgrade
The existing deck is the presenter's own input: treat it as a supplied outline (ADR-0006: completed, not replaced). Work in `local/<talk-slug>/` and keep the original untouched as `source-deck.pptx`.

Run the normal intake (`intake.md`) and ask only what the deck does not answer. For an upgrade, three things are almost always open:
- What changes for this occasion: audience, time slot, language, what went well or badly last time.
- What the presenter wants more of and less of (their own data, background, clinic, mechanism).
- Material from others that could go in (intake question 9). Ask now; material that arrives mid-build changes the plan.

## 2. Read and render the deck
```sh
python3 modules/onboarding/deck_dump.py local/<slug>/source-deck.pptx > local/<slug>/source-deck.json
npm run render:pptx -- local/<slug>/source-deck.pptx --out local/<slug>/render-source
```
Open the contact sheet and the slide images yourself. Judge the rendered slides, not the text dump: a slide that reads well as text can be an unreadable picture. Render findings on a deck the skill did not build are information for the diagnosis, not errors to fix.

The render does not show transitions, animation or video. Say so in the diagnosis instead of guessing how they behave.

## 3. Diagnosis table
One row per slide, shown to the presenter before any proposal is worked out.

| # | Job in the talk | Works (keep) | Problem | Proposed change | Action |
|---|---|---|---|---|---|

- **Action** is one of `keep`, `change`, `cut to backup`, `new`.
- Start from what works and leave it alone. A recurring home figure, the presenter's metaphors and their own data are assets, not problems.
- Name a problem only when the audience would notice it: text where an image would carry the point, a figure too small or too dense to read, more than one idea, the same layout many times in a row, a claim without a visible source.
- A proposed change uses the presenter's own material first (their figures, their data, a figure from a paper they already cite). A new schematic is a proposal and, if generated, needs the presenter's check on every label.
- If the speaker notes carry timings, add the minutes per section under the table and say plainly when background material gets as much time as the presenter's own work. Until T29 this is counted by hand.

## 4. The presenter chooses the scope
Offer three, with what each costs in rehearsal time:
- **Trim:** text moves to the notes, figures get larger, nothing new. Little to re-rehearse.
- **Targeted:** the named slides are rebuilt, the structure and the notes stay. Some re-rehearsal.
- **Rebuild:** a new storyboard with the old deck as outline. A different talk to rehearse.

Do not choose for the presenter and do not start on the largest option because it looks best.

## 5. Change plan
Write `local/<slug>/upgrade-plan.md` with only what changes:

```markdown
---
status: proposed            # proposed | approved
scope: trim | targeted | rebuild
date: YYYY-MM-DD
---
## Changed slides (# | now | becomes | why | origin: presenter/source/proposed)
## New slides (position | job | content | source with locator | origin)
## Cut to backup (# | why)
## Section timing (section | before | after)
## Content to verify before building (claim | where it will be checked)
## Material from others (what | owner | published? | permission to show)
## Approval (the presenter's words, name, date)
```

Show it and wait. The presenter approves the plan explicitly, or revises it; record their words under Approval and set `status: approved`. New content that carries a claim follows create step 2 (full text, exact locator) before it enters the plan as anything other than `needs-expert-review`.

The change plan is the agreement on scope. It is **not** the storyboard gate: there is no approval receipt for it, and it does not allow rendering.

## 6. Build through the spec
Carry the deck into a presentation spec: kept slides and their claims as `origin: presenter`, changes the presenter asked for as `presenter`, the agent's own changes as `proposed`. Cut slides go after the closing slide as backup. Then follow the create workflow from step 3 (`SKILL.md`): validate, pre-check, storyboard, **explicit approval**, render, check, report.

Before step 5, tell the presenter what this route cannot keep: the engines draw seven layouts with one visual per slide and no animation. A deck whose strength is custom artwork, full-bleed imagery or motion loses that when rebuilt from a spec. In that case the honest result of this workflow is the diagnosis and the approved change plan, for the presenter to apply in their own file. Do not edit their file for them here.

## Rules
- Never render or deliver changed slides on the strength of the diagnosis or the change plan alone.
- Never change the meaning of a claim while shortening a slide; text moved to the notes keeps its qualifiers.
- The presenter's deck and every derived file stay in `local/`.
