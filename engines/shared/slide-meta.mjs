// Slide text that every engine must render identically: the citation footer and the speaker notes
// (presenter notes + evidence trail + reveal order + timing). Engines place this text; they never rewrite it.

export function indexSpec(spec) {
  return {
    claims: new Map(spec.claims.map((c) => [c.id, c])),
    sources: new Map(spec.sources.map((s) => [s.id, s])),
  };
}

export function footerCitations(slide, { claims, sources }) {
  if ((slide.citation_display ?? 'footer') !== 'footer') return [];
  const blocks = slide.blocks ?? [];
  const ids = new Set();
  for (const cid of slide.claim_ids ?? []) for (const r of claims.get(cid)?.source_refs ?? []) ids.add(r.source_id);
  for (const b of blocks) {
    if (b.source_id) ids.add(b.source_id);
    if (b.claim_id) for (const r of claims.get(b.claim_id)?.source_refs ?? []) ids.add(r.source_id);
  }
  return [...ids].map((id) => sources.get(id)).filter(Boolean).map((x) => x.short_cite ?? x.citation);
}

export function speakerNotes(slide, { claims, sources }) {
  const blocks = slide.blocks ?? [];
  const parts = [];
  if (slide.notes) parts.push(slide.notes);
  const shown = [...new Set([...(slide.claim_ids ?? []), ...blocks.map((b) => b.claim_id).filter(Boolean), ...blocks.flatMap((b) => (b.items ?? []).map((it) => it.claim_id)).filter(Boolean)])];
  let showsReviewClaim = false;
  if (shown.length) {
    const lines = shown.map((cid) => {
      const c = claims.get(cid);
      const where = (c.source_refs ?? []).map((r) => `${sources.get(r.source_id)?.short_cite ?? r.source_id}${r.locator ? `, ${r.locator}` : ''}`).join('; ');
      let line = c.evidence_status === 'needs-expert-review'
        ? `!! NEEDS EXPERT REVIEW: ${c.text}${c.review_note ? ` | Review: ${c.review_note}` : ''}`
        : `[${c.evidence_status}] ${c.text}${where ? ` (${where})` : ''}`;
      if (c.caveats?.length) line += ` | Caveats: ${c.caveats.join(' ')}`;
      return `- ${line}`;
    });
    parts.push(`EVIDENCE ON THIS SLIDE\n${lines.join('\n')}`);
    showsReviewClaim = shown.some((cid) => claims.get(cid).evidence_status === 'needs-expert-review');
  }
  if (slide.animation?.intent && slide.animation.intent !== 'none') {
    parts.push(`REVEAL (${slide.animation.intent}, not animated in this PPTX): ${(slide.animation.steps ?? []).join(' -> ')}`);
  }
  if (slide.timing_seconds !== undefined) parts.push(`Planned time: ${slide.timing_seconds} s`);
  return { text: parts.join('\n\n'), showsReviewClaim };
}
