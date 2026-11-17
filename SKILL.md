---
name: academic-presenting
description: Builds and reviews scientifically rigorous academic presentations (research talks, journal clubs, clinical cases, teaching) as editable PowerPoint, starting from the presenter's own notes or a short interview, with a storyboard the presenter approves, traceable claims and a quality report. Use when a researcher, clinician or educator wants to create, check or rehearse a scientific talk, or set up a presenter profile.
license: MIT
---

# Academic Presenting (orchestrator)

> Status: **v0.1 in development.** `working` workflows below are usable; `planned` ones are not. Never pretend a planned workflow ran.

## Core rules (always apply)
1. Never fabricate citations, data, figures or results. Flag what cannot be verified.
2. Never alter the meaning of a scientific claim for narrative or layout reasons.
3. Keep evidence states separate: `mechanically-validated` (numbers recomputed by code from supplied data), `source-backed` (checked at a stated locator), `needs-expert-review`. Passing a check is never scientific verification.
4. **Presenter input first** (ADR-0010): no storyboard without the presenter's own notes, outline or interview answers.
5. **Storyboard before slides** (ADR-0006): the presenter approves the storyboard explicitly before anything is rendered. Any later change to the spec needs a new approval.
6. No user content to external services without explicit permission. Real talks live in `local/` (git-ignored).

## Routing

| User intent | Workflow | Status |
|---|---|---|
| "Set up my profile" | onboarding: `modules/onboarding/README.md` | working |
| "Make a talk from this paper / these notes" | create (below) | working, agent-assisted |
| "Check my talk / is my evidence solid?" (spec exists) | quality review: `modules/quality-review/README.md` | working |
| "Make my existing PowerPoint better" | upgrade (below): `modules/storytelling/upgrade.md` | experimental (T26): diagnosis, scope and change plan are agent-assisted; the build goes through create; editing the presenter's file in place is planned |
| "Use my institution's template" | `engines/powerpoint-template/README.md` (fill the template file itself: `storyboard.mjs render ... --template`); `modules/house-style/README.md` (import colours and fonts only) | experimental (T15, T13) |
| "I edited the deck; learn from it" | `modules/onboarding/README.md` (learn-from-edits: report only, presenter confirms each lesson) | experimental (T19) |
| "Speaker notes / rehearse" | rehearsal | planned |
| "HTML version" | html (Slidev) | planned (v0.2) |

## Create workflow (working)
Work in `local/<talk-slug>/`. Load only what each step needs.

1. **Intake.** Follow `modules/storytelling/intake.md`. Copy the presenter's notes verbatim into `intake.md`, map them to the nine intake questions (including co-presenters, the exact title-slide occasion line, whether to show a full references slide, and material from others), ask only what is open (max four at a time, skippable). Set `status: complete`.
2. **Read the full source and answer the presenter's own questions** with exact locators. Check a result against the full text, tables, figure legends and supplements where relevant; an abstract alone cannot settle a claim that depends on methods, population or qualifiers. If full text is unavailable, keep the limitation visible with `needs-expert-review` and `review_reason`. Recompute derived numbers (percentages from counts, CI plausibility, NNT) and record internal inconsistencies without resolving them silently. Guidance: `references/evidence-integrity.md`.
3. **Write the spec** (`schemas/README.md`): claims with `source_refs` + locator, `quantities`, `caveats`, `evidence_status`, `origin` (`presenter` / `source` / `proposed`), and `review_reason` where needed. Include `meta.occasion` and all confirmed presenters. Include a `references` slide by default; omit it if the presenter chooses no for this talk. Before reusing an original figure, inspect source and figure-level licence terms, record `sources[].licence` and a figure credit, and confirm the intended use fits the terms. If reuse is not established, build a new chart from numbers reported in the source and trace every value; do not copy the original composition. Apply the presenter's profile if they have one (`modules/onboarding/README.md`). Run `npm run validate -- <spec>` until 0 errors.
4. **Pre-check.** `npm run quality -- <spec>` before rendering catches untraceable numbers in titles and notes. Fix the spec, not the check.
5. **Storyboard.** `node scripts/storyboard.mjs generate <spec> --origin outline|source --out <dir>/storyboard.md`. Show it. Say plainly which slides are `proposed` and which claims need expert review. Ask the presenter to check team names/roles and budget amounts, duration and funding context on those slides. Remove captions that only announce the next point; keep captions needed to interpret evidence or credit a source. Wait.
6. **Approval.** Only after the presenter explicitly approves: `node scripts/storyboard.mjs approve <spec> <storyboard> --by "<name>"`.
7. **Render.** `node scripts/storyboard.mjs render <spec> <storyboard> --out <dir>/out/<name>.pptx`.
8. **Check.** `npm run render:pptx -- <deck> --out <dir>/out/render-N`, then inspect the contact sheet yourself. Fix layout through the engine, not by changing claims.
9. **Report.** `npm run quality -- <spec> --build <deck>.build-report.json --render <render>/render-report.json -o <dir>/out/quality-report.md`. Hand over: deck, contact sheet, quality report, and the decisions the presenter still has to make.

## Upgrade workflow (experimental)
For a deck the presenter already has. Follow `modules/storytelling/upgrade.md`.

1. **Intake.** The deck is the presenter's outline. Ask what changes for this occasion, what they want more and less of, and for material from others.
2. **Read and render** the deck; judge the rendered slides.
3. **Diagnosis table** per slide: what works, the problem, the proposed change, and keep / change / cut to backup / new.
4. **Scope.** The presenter chooses trim, targeted or rebuild.
5. **Change plan** (`upgrade-plan.md`) with only what changes; the presenter approves it explicitly. It is the agreement on scope, not the storyboard gate.
6. **Build through the spec**, then create steps 3–9 with the normal storyboard approval. Say beforehand what a rebuild from the spec cannot keep (custom artwork, motion). Never edit the presenter's file in place.

## Intermediate representation
All content flows through `schemas/presentation.schema.json`. Engines render from the spec, never from free text.
