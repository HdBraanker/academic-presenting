# Module: onboarding

Status: **working** for a progressive local interview, an editable Markdown profile, multiple profiles, and applying confirmed design settings to a validated presentation spec. Automatic analysis of style reference decks is **planned**.

## Conversation workflow

Start with a profile name or alias, academic role and discipline, and usual audience. Let the user skip any question except the profile name. Then ask at most two relevant follow-ups at a time about preferred style, scientific detail, citations, typical duration, output, animation, or a local presentation they like. A new user can stop after the first round and use engine defaults. Talk-specific messages, claims, and goals belong to the presentation intake, not the persistent presenter profile.

Separate **confirmed preferences** from **observed cues** in a reference deck. Observing a font or dense slide does not mean the presenter wants it repeated. Record observations in the Markdown notes section and only put a preference in the settings block after the user confirms it. Never infer a preference from an unanswered question. Do not upload a deck, profile, or private content to an external service without authorization.

Before saving, show the proposed profile to the user and invite corrections. Use a local filename under `profiles/*.local.md`. These files are git-ignored; the committed `profiles/example-presenter.md` is synthetic. Multiple presenters or contexts use separate filenames. The settings block is JSON inside Markdown so it remains editable and can be read without an extra dependency. It is the source of truth for automatic settings; the prose below it holds notes and unconfirmed observations.

## Local commands

```sh
node modules/onboarding/profile.mjs create --out profiles/my-talks.local.md
node modules/onboarding/profile.mjs update profiles/my-talks.local.md
node modules/onboarding/profile.mjs apply profiles/my-talks.local.md examples/research-talk/spec.json --out out/my-profiled-spec.json
```

`create` asks core questions first, then offers optional presentation and visual groups. Enter keeps an existing value during `update`; `skip` clears it. For an agent-assisted interview, pass a local JSON file with the answers: `create --answers local-answers.json --out profiles/name.local.md` or `update profiles/name.local.md --answers local-answers.json`. Do not commit an answers file with personal details.

Run `apply` **before** generating the storyboard. It writes a new spec and never edits the original. Explicit `design.theme` and `design.tokens` in that spec win; profile settings fill missing fields, including individual colors. The PowerPoint engine uses these existing schema fields. A profile can set a theme, heading/body fonts, accent/highlight colors, and minimum font size. Unanswered design questions leave engine defaults in place, including Calibri as the font fallback. No new schema or dependency is required. The CLI refuses to overwrite an existing output spec; choose a new filename.

The profile also records role, discipline, audience, style, depth, citations, duration, output, animation, and local style references as context for the agent. `references_slide_default` is an optional confirmed boolean (true when absent); the talk's intake answer overrides it before the storyboard is made. Those narrative answers do not silently rewrite scientific claims, timing, or layouts. HTML output remains planned under ADR-0002. Font availability and the final appearance must be checked in the rendered deck.

## Learn from the presenter's edits (experimental, T19, ADR-0013)

After a talk, compare the generated deck with the copy the presenter actually used:

```sh
node modules/onboarding/learn-from-edits.mjs out/talk.pptx path/to/edited.pptx --spec spec.json -o out/edit-lessons.md [--json out/edit-lessons.json]
```

Requires python-pptx. The report lists proposals in five groups: scientific integrity (numbers changed in slide text), citations, style cues (moved, resized, re-sized type, table alignment; a change on two or more slides is a *pattern*), structure (slides removed or added) and content edits (word-level, with the slide's claim ids). It writes nothing else. Walk through it with the presenter: confirmed style preferences go into the profile with `profile.mjs update`; unconfirmed ones can be noted under "Observed style cues"; content corrections go into the spec and need a new storyboard approval; engine-wide lessons become tasks.

## Example

`profiles/example-presenter.md` demonstrates the format with a fictional presenter. It is not Hannah's profile. To inspect the mapping without rendering a deck:

```sh
node modules/onboarding/profile.mjs apply profiles/example-presenter.md schemas/examples/minimal.valid.json --out out/profiled-minimal.json
```
