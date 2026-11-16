# Evidence integrity

Status: scientific review procedure. It is distinct from syntax validation and visual QA.

## Non-negotiable boundary

Never invent a source, result, data point, figure, effect size, uncertainty interval, or study conclusion. Do not change the meaning of a claim to improve its title, narrative, or layout. When a source is unavailable, the claim remains unverified and the limitation must be visible in the review record.

## Claim-level evidence states

Assign one current state to each substantive scientific claim. These are workflow states, not a quality score:

| State | What it establishes | What it does not establish |
|---|---|---|
| `mechanically-validated` | The claim's numbers (estimates, intervals, counts) were recomputed or matched by code against data supplied with the presentation | That the source text reports the same, that the analysis is appropriate, or that the interpretation holds |
| `source-backed` | A reviewer inspected an identifiable source and confirmed that its stated result or passage supports the claim with the relevant qualifiers | The underlying study is flawless or the claim is clinically/general scientifically settled |
| `needs-expert-review` | A source is missing, inaccessible, ambiguous, conflicting, or the interpretation needs domain judgment | Permission to omit the concern from the deck or quality report |

Passing the schema and integrity validator (fields, IDs, links) is a property of the spec, not an evidence state; it does not make any claim `mechanically-validated`. (Definition aligned with ADR-0005 by Hannah, 2026-11-15.)

Do not promote `mechanically-validated` to `source-backed` because a citation string, DOI, or URL resolves. A source may be attached to a `needs-expert-review` claim; the concern may be interpretation rather than missing literature. A rendered deck does not change evidence state.

## Minimum claim ledger

Keep enough information for another reviewer to repeat the check:

- Exact slide claim, including direction, population, outcome, comparison, time frame, and qualifiers.
- Source identifier and exact locator (page, table, figure, section, or quoted passage where practical).
- Source type and version: original study, review, guideline, preprint, unpublished material, or presenter-supplied document.
- Extracted result: estimate, unit, denominator/sample size, uncertainty, and analysis population when applicable.
- Evidence state, reviewer's action, unresolved question, and date of inspection.
- Permission/provenance for reused figures or images where relevant.

## Review procedure

1. **Identify claims.** Include titles, chart annotations, take-home messages, causal arrows, and spoken-note conclusions. A figure can imply a claim even without a sentence.
2. **Locate the original support.** Prefer the primary study or source data for a result. Read the full text, relevant tables, figure legends and supplements before treating a substantive claim as source-backed. An abstract can identify a source but may omit the population, methods or qualifier that changes the claim; the second real talk exposed an incorrect "mouse only" interpretation from an abstract. If only an abstract is available, record that limit in `review_reason` and leave the claim `needs-expert-review`. Verify bibliographic details against the source or a reliable index. A review may support a synthesis, but do not cite it as if it directly reported the underlying experiment. [ICMJE's reference guidance](https://www.icmje.org/recommendations/browse/manuscript-preparation/preparing-for-submission.html) recommends original research where possible and checking references against bibliographic or original sources.
3. **Compare the exact claim to the result.** Check population, intervention/exposure, comparator, outcome, time point, direction, effect size, units, confidence interval or other uncertainty, analysis set, and important limitations. Confirm whether a subgroup or secondary endpoint is being presented as a primary finding.
4. **Keep inference visible.** Distinguish observation from interpretation, association from causation, and hypothesis from established result. Avoid “no effect” when a study only found insufficient evidence for an effect.
5. **Check visual fidelity.** Inspect chart scales, omitted categories, denominators, error bars, figure labels, and transformations. A plot that is technically valid can still misrepresent a result.
6. **Assign the evidence state.** Record why a claim is `source-backed` or what expert judgment is still needed. Never fill a gap with plausible-looking details.
7. **Review after editing.** If a title, number, plot, or summary changes, recompare that part with its source. Preserve the earlier wording or record the substantive change for human review.

## Figure reuse and re-plotting

Before placing an original figure, inspect the publication's licence statement and the figure legend or credit line for third-party exclusions. Record the source terms in `sources[].licence`, the figure's `source_id`, `origin: original-from-source`, and `credit`. The T20 validator catches missing or clearly restricted source-level terms; it cannot prove the figure is covered, that a non-commercial condition fits this use, or that credit is visible in the deck. Check those conditions and the rendered slide manually. See [Creative Commons' CC BY](https://creativecommons.org/licenses/by/4.0/deed.en) and [CC BY-NC](https://creativecommons.org/licenses/by-nc/4.0/deed.en) descriptions for their respective terms.

When reuse of the image is not established, make a new editable chart from numbers explicitly reported in the source. Record each number's exact table, text or supplement locator and the comparison, time point, denominator and uncertainty. Credit the source. Do not trace the image into an equivalent drawing, infer missing points from pixels, recreate unlabeled error bars, or preserve a misleading scale. If the required values are not reported, omit the chart or seek permission instead of inventing them.

## Presenter-owned administrative facts

Show team and budget slides to the presenter as specific facts to confirm before storyboard approval: names, roles, affiliations, amounts, currency, duration and funding context. Do not fill missing details by guesswork. Preserve confirmed wording; mark agent-supplied details as proposed. A title-slide occasion and co-presenters also need the presenter's exact wording and names.

Remove a caption whose only job is to announce what the title or next sentence already says. Preserve captions that carry the comparison, sample, time point, caveat, source credit or other information needed to interpret a visual.

## Unavailable or conflicting sources

- Flag the exact claim and missing source or contradictory passages.
- Keep the claim out of an unqualified conclusion until reviewed. If the presentation must show it, label the uncertainty on the slide or in the speaker notes and quality report according to its importance.
- Do not use an AI summary, citation string, or a visually similar paper as a replacement for the source.
- For synthetic fixtures, mark all content as fictional and do not turn it into real-world evidence.

## Outputs for downstream work

The storyboard and both future engines must preserve the same claim wording, source mapping, and qualifiers. A quality report should list claims that remain `needs-expert-review` with their exact reason. Technical checks may verify IDs and renderability; scientific review is recorded separately.

These rules apply across disciplines. When a study design needs domain-specific interpretation, use the relevant reporting guidance and an expert reviewer rather than a generic automated pass. [ICMJE lists reporting guidance by study type](https://www.icmje.org/recommendations/browse/manuscript-preparation/preparing-for-submission.html); those guidelines help assess what information a source reports, but do not themselves verify a slide's claim.
