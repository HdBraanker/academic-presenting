# Anti-slop review

Status: human-reviewable design checklist. It identifies problems and proposes edits; it must not silently rewrite scientific claims.

“Slop” here means a slide feature that looks polished but weakens meaning, evidence, or attention. Evaluate the actual slide in context. Do not flag a deliberate dense methods or results slide merely because it contains more information than a title slide.

## Review signals

| Signal | Why it matters | Actionable response |
|---|---|---|
| Generic title (“Results”, “Key insights”) | The audience cannot locate the slide's intellectual job | Write a precise question or source-supported conclusion |
| Stronger title than the evidence | Design turns uncertainty into certainty | Restore qualifiers and route the claim for scientific review |
| Repeated generic bullet layouts | Visual form does not help the audience understand evidence | Choose a chart, comparison, process diagram, or structured text that fits the job |
| Decorative icons, gradients, stock imagery, or visual metaphors | They draw attention without carrying information | Remove them or explain the specific information they encode |
| Illustration presented like a real scientific figure | Viewers may infer fabricated data or observed biology | Label it as schematic/hypothetical; cite the basis and remove invented detail |
| Figure too small to inspect | The central evidence becomes inaccessible | Crop to the relevant panel, split with shared context, or redraw from authorized data |
| Unexplained colors, axes, abbreviations, or denominators | Viewers cannot interpret the result correctly | Add direct labels, units, definitions, and necessary context |
| Decorative precision or false scale | The graphic suggests accuracy the source lacks | Match precision and scale to the source; label transformations |
| Long text competing with spoken explanation | Reading and listening compete | Keep only the text needed for the slide's job; put supporting detail in notes |
| Tiny citation or missing source locator | A claim is difficult to trace | Use a legible short citation and an exact source in notes or the claim ledger |
| Inconsistent type, spacing, or color roles | Reading order changes without a reason | Apply the deck's type and spacing system |
| Automatic “clean-up” removes caveats | The slide becomes easier to scan but scientifically wrong | Restore caveats; redesign around them |

## How to report a finding

For each affected slide, record:

1. Slide ID and the observed element.
2. The audience or scientific consequence.
3. A concrete edit, with any claim-level decision explicitly requiring review.
4. Severity: **critical** for a false or unsupported scientific impression, **major** for a likely comprehension or accessibility failure, **minor** for polish that does not affect meaning.
5. Whether the finding was observed in the source/storyboard, the rendered output, or both.

Example: “Slide 6, major, rendered output: the CI line is clipped at the right edge, so the uncertainty appears narrower. Expand the plot area and rerender; do not change the estimate.”

## Release gate

- Critical findings block an unqualified “ready” label.
- Major findings require a documented fix or an explicit limitation in the quality report.
- Minor findings may remain as suggestions.
- Re-run the visual inspection after layout edits. Recheck affected claims after content edits.

This rubric is an editorial tool, not a validated score. The [AWSM slide rubric study](https://pmc.ncbi.nlm.nih.gov/articles/PMC9005758/) supports attention to readability and visual busyness in medical education; it does not establish that this checklist predicts audience outcomes.
