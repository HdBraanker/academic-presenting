# Slide design principles

Status: design guidance for storyboard review, rendering, and human inspection. These are defaults to test, not universal numeric pass/fail rules.

## Structure and hierarchy

- Use a 16:9 canvas for the initial PowerPoint engine, as required by this project. Keep title, evidence, and source treatment in predictable regions.
- Give each slide a purpose and a clear reading order. Use a claim title only when the evidence supports the exact wording; otherwise use a question or descriptive title.
- Put the figure or explanation next to the label that interprets it. Remove empty boxes, repeated captions, and visual elements that do no work.
- Prefer direct labels over a distant legend when space permits. Use one restrained emphasis color consistently; do not use color alone to distinguish groups, states, or importance.
- Preserve a meaningful visual relationship. A comparison is harder to judge if the compared values are split across distant slides or use different axes.

## Text and legibility

- Use a small, consistent type system: a clear display size for titles, one or two body sizes, and a legible citation/annotation size. Sentence case is a useful default, not a scientific requirement.
- As initial PowerPoint targets, try approximately 28–36 pt titles, 20–28 pt body text, and at least 14–18 pt for information that must be read on the slide. Inspect the render in the target room or viewing mode; these point sizes are project heuristics, not accessibility certification.
- Keep essential qualifiers, units, sample sizes, and uncertainty readable. If they do not fit, restructure the slide, add an explanatory slide, or move nonessential details to notes. Never shrink critical scientific text solely to clear an overflow check.
- Avoid long blocks that the presenter would have to read aloud. Use structured text when a definition, quote, or decision is itself the evidence; bullet limits are not universal.

## Figures, charts, and tables

- Show axes, units, group labels, sample sizes or denominators where relevant, time points, and the comparison being made. Include uncertainty measures and statistical caveats when needed to interpret the claim.
- Match chart type to the question: comparison, distribution, change, relationship, composition, or process. A stylized chart that hides exact values or uncertainty is a design defect.
- Avoid truncated axes when they would exaggerate a difference; if a nonzero baseline is analytically justified, label it clearly. Explain transformations, normalization, and omitted categories.
- Keep numerical precision consistent with the source. Do not create data points, error bars, effect sizes, or mechanistic arrows to make a graphic look complete.
- Use native editable text, shapes, and charts where feasible. If a scientific figure must be an image, retain its provenance and say that the figure is not editable.
- Preserve a static, understandable state when adding progressive reveal. Speaker notes can carry the reveal sequence; the exported PDF must not depend on animation to convey the scientific conclusion.

## Color and accessibility

- Aim for at least **4.5:1** contrast for ordinary text, **3:1** for large text, and **3:1** for meaningful graphical elements against adjacent colors, using the [WCAG 2.2 contrast criteria](https://www.w3.org/TR/WCAG22/#contrast-minimum) and [non-text contrast criterion](https://www.w3.org/TR/WCAG22/#non-text-contrast) as practical targets. WCAG is a web standard; borrowing these thresholds does not certify a PowerPoint deck as WCAG conformant.
- Encode distinctions with labels, line styles, patterns, or shapes as well as color, following the [WCAG use-of-color principle](https://www.w3.org/TR/WCAG22/#use-of-color).
- Check contrast on the actual background, including photographs, chart panels, and projected dark themes. Thin lines may remain hard to see even when their nominal color ratio passes.
- Provide meaningful alternative text or nearby textual explanation for essential visuals where the output format supports it. Do not use rasterized text as the primary way to communicate a slide's message.

## Review at three scales

1. **Storyboard:** Does the slide have a necessary job, and is its evidence sufficient?
2. **Rendered slide:** Are all elements present, in bounds, correctly layered, and readable? Inspect figures and citations, not just text boxes.
3. **Deck sequence:** Is the hierarchy consistent? Are transitions and repeated structures helpful? Can the audience follow the argument without relying on decorative continuity?

A successful render is a technical result, not evidence that the claims or the visual interpretation are correct. Send scientific concerns to [evidence-integrity.md](evidence-integrity.md) and visual quality findings to [anti-slop.md](anti-slop.md).
