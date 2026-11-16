# Presentation spec (schema v0.1.0)

The contract between storytelling and every renderer. Both the PowerPoint and the HTML engine render from this file, never from free text.

## Design in one paragraph
Claims are first-class objects at deck level (`claims[]`). Slides and blocks point to them by id (`claim_ids`, `claim_id`). That gives one place where a scientific statement, its sources, its numbers and its caveats live, so two renderers cannot drift apart, and the quality review can trace every number on a slide back to a location in a source.

## Main objects
| Object | Holds |
|---|---|
| `meta` | title, optional occasion and presenters, language, duration, narrative format |
| `audience`, `central_question`, `objectives` | storyboard anchors |
| `sources[]` | citation, short cite, DOI/PMID, **verification status** (verified, user-provided, unverified, not-found), optional recorded `licence` |
| `claims[]` | text, kind (finding, hypothesis, limitation…), relationship (association vs causal), **evidence_status**, source_refs with locator, quantities with CI/p/n, caveats, optional `review_reason` |
| `slides[]` | purpose (the one job), title-as-claim, layout, claim_ids, blocks, notes, timing, animation intent, constraints |
| `blocks` | text, bullets (bold lead), figure (alt required, origin), stat, chart, table, question |

## Two layers of validation
1. **Structure**: JSON Schema (draft 2020-12).
2. **Integrity**: `scripts/validate-spec.mjs`.

| Rule | Level |
|---|---|
| Unknown or duplicate ids, animation steps not on the slide | error |
| `source-backed` claim without source_refs | error |
| Claim cites a source marked `not-found` | error |
| Original source figure without a linked source, recorded reuse licence, or recorded credit | error |
| Original source figure whose linked source says `all rights reserved` or `unknown` | error |
| Stat block shows a number absent from the claim's quantities | error |
| Point estimate outside its own CI | error |
| Unverified source, missing locator, missing CI/p for a finding | warning |
| Causal claim, redrawn figure, digitized chart data | warning (needs human check) |
| Original figure with conditional or unfamiliar licence; possible third-party figure terms | warning (needs human check) |
| `needs-expert-review` claim without a recorded reason or reviewer note | warning |
| Result-like number in text without a linked claim | warning |
| Claim never shown, timing over the slot | warning |

A spec that passes has consistent references. It is **not** scientifically verified. That distinction is the point of `evidence_status`.

The reuse check is conservative triage, not a legal permission decision. `sources[].licence` records the source's stated terms; an individual figure may have different third-party terms. `CC BY` is recognised for reuse with a recorded credit, while `CC BY-NC` is flagged for a use-specific check. The validator cannot establish that the credit is visible in the rendered deck, so inspect the slide. See the [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.en) and [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/deed.en) summaries. `meta.occasion` is a separate title-slide line value and takes precedence over the older `subtitle`/`venue` fallback in the template engine. Existing specs without the new optional fields still validate unless they reuse an original figure without recorded rights.

## Run
```
npm install
npm run validate -- schemas/examples/minimal.valid.json
npm test
```
