#!/usr/bin/env node
// Academic Presenting — quality report (T7)
// Combines spec integrity, narrative, visual (anti-slop), accessibility and technical checks into one actionable report.
// Usage: node modules/quality-review/quality-report.mjs <spec.json> [--build <build-report.json>] [--render <render-report.json>] [-o out/x.quality-report.md]
// The report is mechanical. It never verifies that a source supports a claim; it says what a human must check.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../../scripts/validate-spec.mjs';

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, info: 3 };
const DIMENSIONS = ['scientific', 'narrative', 'visual', 'accessibility', 'technical'];
const DIM_LABEL = { scientific: 'Scientific integrity', narrative: 'Narrative', visual: 'Visual (anti-slop)', accessibility: 'Accessibility', technical: 'Technical' };

const GENERIC_TITLES = /^(results?|background|introduction|methods?|discussion|conclusions?|summary|overview|agenda|outline|key (insights|takeaways|findings)|take[- ]home( messages?)?)$/i;
const AI_PHRASES = /\b(delve|delving|landscape|leverag\w*|unlock\w*|game[- ]chang\w*|cutting[- ]edge|revolutioni[sz]\w*|paradigm shift|holistic|seamless\w*|harness\w*|in today's|navigat\w* the complex\w*|tapestry|pivotal)\b/i;
const VAGUE_EVAL = /\b(robust|dramatic\w*|remarkabl\w*|groundbreaking|novel|striking\w*|impressive\w*|clearly)\b/i;
const CAUSAL_VERBS = /\b(causes?|caused|leads? to|led to|drives?|driven|induces?|prevents?|reduces?|reduced|improves?|improved|increases?|increased|lowers?|lowered|protects?)\b/i;
// Numbers not glued to letters (skips ACR20, PASI75, DAS28, IL-17A).
// Also skips identifiers with a hyphen (FICTA-1, COVID-19, IL-17A).
const NUM = /(?<![A-Za-z\d.])(?<![A-Za-z]-)[-−+]?\d+(?:[.,]\d+)?(?![A-Za-z\d])/g;

const nums = (text) => [...String(text ?? '').matchAll(NUM)].map((m) => Math.abs(Number(m[0].replace('−', '-').replace(',', '.'))));
const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

function contrast(hexA, hexB) {
  const lum = (h) => {
    const c = h.replace('#', '').match(/.{2}/g).map((x) => parseInt(x, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const [a, b] = [lum(hexA), lum(hexB)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

export function buildQualityReport(spec, { build = null, render = null } = {}) {
  const findings = [];
  const add = (f) => findings.push({ observed_in: 'spec', ...f });
  const claims = new Map(spec.claims.map((c) => [c.id, c]));
  const sources = new Map(spec.sources.map((s) => [s.id, s]));

  const slideClaimIds = (s) => [...new Set([
    ...(s.claim_ids ?? []),
    ...(s.blocks ?? []).map((b) => b.claim_id).filter(Boolean),
    ...(s.blocks ?? []).flatMap((b) => (b.items ?? []).map((it) => it.claim_id)).filter(Boolean),
  ])];

  // ---------- scientific integrity ----------
  const { errors, warnings } = validateSpec(spec);
  errors.forEach((e) => add({ dimension: 'scientific', severity: 'critical', element: e.path, message: e.message, action: 'Fix the spec; the deck must not be rendered while this error stands.' }));
  warnings.forEach((w) => add({ dimension: 'scientific', severity: /locator|not shown on any slide/.test(w.message) ? 'minor' : 'major', element: w.path, message: w.message, action: 'Resolve, or record why it is acceptable.' }));

  const shownOn = new Map();
  spec.slides.forEach((s, i) => slideClaimIds(s).forEach((cid) => shownOn.set(cid, [...(shownOn.get(cid) ?? []), i + 1])));

  // needs-expert-review claims that reach a slide
  for (const [cid, slidesNo] of shownOn) {
    const c = claims.get(cid);
    if (c?.evidence_status === 'needs-expert-review') {
      add({ dimension: 'scientific', severity: 'major', slide: slidesNo.join(', '), element: cid, message: `Claim on slide needs expert review: "${c.text}"${c.review_reason ? ` Reason: ${c.review_reason}` : ''}${c.review_note ? ` Reviewer note: ${c.review_note}` : ''}`, action: 'Have a domain expert confirm, rephrase as an explicit interpretation, or remove. Record the decision here.' });
    }
  }

  // numbers in titles, notes, text, bullets, tables must trace to claims
  const deckClaimNums = new Set(spec.claims.flatMap((c) => [...nums(c.text), ...(c.quantities ?? []).flatMap((q) => [q.value, q.ci_low, q.ci_high, q.n, q.p_value].flatMap(nums).concat(q.ci_level ? [Math.round(q.ci_level * 100)] : []))]));
  spec.slides.forEach((s, i) => {
    const no = i + 1;
    const local = slideClaimIds(s).map((cid) => claims.get(cid)).filter(Boolean);
    const allowed = new Set(local.flatMap((c) => [...nums(c.text), ...(c.quantities ?? []).flatMap((q) => [q.value, q.ci_low, q.ci_high, q.n, q.p_value].flatMap(nums).concat(q.ci_level ? [Math.round(q.ci_level * 100)] : []))]));
    const ppEffects = local.flatMap((c) => (c.quantities ?? []).filter((q) => /percentage point/i.test(q.unit ?? '') && typeof q.value === 'number'));
    const places = [['title', s.title], ['notes', s.notes]];
    (s.blocks ?? []).forEach((b) => {
      if (b.text) places.push([`block ${b.id}`, b.text]);
      if (b.items) b.items.forEach((it, k) => places.push([`block ${b.id} item ${k + 1}`, `${it.lead ?? ''} ${it.text}`]));
      if (b.rows) b.rows.forEach((r, k) => places.push([`block ${b.id} row ${k + 1}`, r.join(' ')]));
      if (b.type === 'stat') places.push([`block ${b.id}`, `${b.value} ${b.label}`]);
    });
    if (s.layout === 'references') return;
    for (const [where, text] of places) {
      if (!text) continue;
      let t = String(text);
      // derived numbers: NNT / NNH
      for (const m of t.matchAll(/\b(NNT|NNH|number needed to (?:treat|harm))\b\D{0,20}?(\d+(?:\.\d+)?)/gi)) {
        const stated = Number(m[2]);
        const derived = ppEffects.map((q) => 100 / Math.abs(q.value));
        const ok = derived.find((d) => Math.abs(d - stated) <= 0.6);
        if (ok !== undefined) add({ dimension: 'scientific', severity: 'info', slide: no, element: where, message: `Derived number "${m[0].trim()}" is consistent with the slide's effect (100 / ${(100 / ok).toFixed(0)} = ${ok.toFixed(1)}).`, action: 'None; derived values are not source-backed by themselves, say so if asked.' });
        else add({ dimension: 'scientific', severity: 'major', slide: no, element: where, message: `Derived number "${m[0].trim()}" cannot be reproduced from the percentage-point effects linked to this slide.`, action: 'Recompute from the source or remove.' });
        t = t.replace(m[0], ' ');
      }
      // Skip scale words, years and references to tables/figures/supplements ("Table 1-2", "Fig 3C", "Tabel S3").
      t = t.replace(/\bper 100\b/gi, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b(tables?|tabel(len)?|fig(ure|uur)?s?\.?|supplementary|suppl\.?|ref(s|erences?)?\.?)\s*S?\d+[A-Z]?(\s*[-–,]\s*S?\d+[A-Z]?)*/gi, ' ');
      const stray = nums(t).filter((n) => !allowed.has(n));
      if (!stray.length) continue;
      const elsewhere = stray.filter((n) => deckClaimNums.has(n));
      const nowhere = stray.filter((n) => !deckClaimNums.has(n));
      if (nowhere.length) add({ dimension: 'scientific', severity: 'major', slide: no, element: where, message: `Number(s) ${nowhere.join(', ')} not found in any claim (text or quantities).`, action: 'Link a claim that carries this number with its source, or remove it.' });
      if (elsewhere.length) add({ dimension: 'scientific', severity: 'minor', slide: no, element: where, message: `Number(s) ${elsewhere.join(', ')} come from claims not linked to this slide.`, action: 'Add the claim to this slide so its source appears in the footer and notes.' });
    }

    // hypothesis stated as fact in the title
    if (local.some((c) => c.kind === 'hypothesis') && !s.title.trim().endsWith('?') && !/\b(may|might|could|possibly|suggests?|hypothes)/i.test(s.title)) {
      add({ dimension: 'scientific', severity: 'major', slide: no, element: 'title', message: 'Slide shows a hypothesis but the title reads as an established finding.', action: 'Phrase as a question or add a qualifier ("may", "suggests").' });
    }
    // causal verb in title without causal support
    if (CAUSAL_VERBS.test(s.title) && local.length && !local.some((c) => c.relationship === 'causal')) {
      add({ dimension: 'scientific', severity: 'major', slide: no, element: 'title', message: `Title uses causal language ("${s.title.match(CAUSAL_VERBS)[0]}") but no linked claim is causal.`, action: 'Use association wording ("was associated with") or link the causal claim.' });
    }
  });

  // ---------- narrative ----------
  const timed = spec.slides.filter((s) => s.timing_seconds !== undefined);
  const total = timed.reduce((n, s) => n + s.timing_seconds, 0);
  const slot = spec.meta.duration_minutes * 60;
  if (timed.length < spec.slides.length) add({ dimension: 'narrative', severity: 'minor', message: `${spec.slides.length - timed.length} slide(s) have no planned time.`, action: 'Add timing so the storyboard can be checked against the slot.' });
  if (total > slot * 1.1) add({ dimension: 'narrative', severity: 'major', message: `Planned time ${(total / 60).toFixed(1)} min exceeds the ${spec.meta.duration_minutes}-min slot.`, action: 'Cut or merge slides; protect the main result and its uncertainty.' });
  else if (timed.length === spec.slides.length && total < slot * 0.7) add({ dimension: 'narrative', severity: 'minor', message: `Planned time ${(total / 60).toFixed(1)} min uses less than 70% of the ${spec.meta.duration_minutes}-min slot.`, action: 'Leave room for questions deliberately, or add depth where the audience needs it.' });
  spec.slides.forEach((s, i) => {
    const no = i + 1;
    if (!['title', 'section', 'references'].includes(s.layout) && GENERIC_TITLES.test(s.title.trim())) add({ dimension: 'narrative', severity: 'major', slide: no, element: 'title', message: `Generic title "${s.title}".`, action: 'Write the claim or question this slide answers.' });
    if (['claim-figure', 'stat-card', 'comparison', 'take-home', 'text'].includes(s.layout) && slideClaimIds(s).length === 0) add({ dimension: 'narrative', severity: 'minor', slide: no, message: 'Content slide without any linked claim.', action: 'Link the claim it supports, or ask whether the slide is needed.' });
  });
  if (!spec.slides.some((s) => s.layout === 'take-home')) add({ dimension: 'narrative', severity: 'minor', message: 'No take-home slide.', action: 'End with the messages the audience should keep, with their evidence level.' });

  // ---------- visual (spec-level anti-slop) ----------
  let run = 1;
  spec.slides.forEach((s, i) => {
    const no = i + 1;
    if (i > 0 && s.layout === spec.slides[i - 1].layout && !['title', 'references'].includes(s.layout)) run++; else run = 1;
    if (run === 3) add({ dimension: 'visual', severity: 'minor', slide: `${no - 2}-${no}`, message: `Three consecutive "${s.layout}" slides.`, action: 'Check whether each needs the same form; vary by intellectual job, not decoration.' });
    const blocks = s.blocks ?? [];
    blocks.filter((b) => b.type === 'bullets' && b.items.length > 5).forEach((b) => add({ dimension: 'visual', severity: 'minor', slide: no, element: b.id, message: `${b.items.length} bullet points.`, action: 'Keep the points the slide needs; move the rest to notes or a structured comparison.' }));
    const wc = blocks.reduce((n, b) => n + words(b.text) + (b.items ?? []).reduce((m, it) => m + words(it.text) + words(it.lead), 0), 0);
    if (wc > 50 && s.constraints?.density !== 'high') add({ dimension: 'visual', severity: 'minor', slide: no, message: `${wc} words of on-slide text.`, action: 'Reduce text competing with speech, or mark density high if scientifically justified.' });
    const texts = [['title', s.title], ...blocks.flatMap((b) => [[b.id, b.text], ...(b.items ?? []).map((it) => [b.id, `${it.lead ?? ''} ${it.text}`])])].filter(([, t]) => t);
    for (const [where, t] of texts) {
      const ai = t.match(AI_PHRASES);
      if (ai) add({ dimension: 'visual', severity: 'minor', slide: no, element: where, message: `Generic AI-style wording "${ai[0]}".`, action: 'Replace with the specific statement.' });
      const vague = t.match(VAGUE_EVAL);
      if (vague) add({ dimension: 'visual', severity: 'minor', slide: no, element: where, message: `Evaluative word "${vague[0]}" without a stated criterion.`, action: 'Replace with the estimate or criterion it rests on (e.g. the CI).' });
    }
    blocks.filter((b) => b.type === 'figure').forEach((b) => {
      if (b.origin === 'redrawn') add({ dimension: 'visual', severity: 'major', slide: no, element: b.id, message: 'Redrawn figure.', action: 'Compare against the original for data, scale and labels.' });
      if (b.origin === 'schematic') add({ dimension: 'visual', severity: 'info', slide: no, element: b.id, message: 'Schematic figure (not data).', action: 'Keep it visibly schematic; no invented detail.' });
    });
  });

  // ---------- accessibility ----------
  const col = { background: 'FFFFFF', ink: '1B1F23', muted: '646E78', accent: '1F3A5F', highlight: 'B03A2E', ...(spec.design?.tokens?.colors ?? {}) };
  if (spec.design?.theme === 'dark') col.background = '111418';
  for (const role of ['ink', 'muted', 'accent', 'highlight']) {
    if (!col[role]) continue;
    const r = contrast(col[role], col.background);
    if (r < 3) add({ dimension: 'accessibility', severity: 'major', element: `color ${role}`, message: `Contrast ${r.toFixed(1)}:1 against background (below 3:1).`, action: 'Darken or lighten this color.' });
    else if (r < 4.5) add({ dimension: 'accessibility', severity: 'minor', element: `color ${role}`, message: `Contrast ${r.toFixed(1)}:1 (enough for large text only).`, action: 'Use this color only for large text or graphics.' });
  }
  spec.slides.forEach((s, i) => (s.blocks ?? []).filter((b) => b.type === 'figure' && b.alt.length < 20).forEach((b) => add({ dimension: 'accessibility', severity: 'minor', slide: i + 1, element: b.id, message: 'Very short alt text.', action: 'Describe what the figure shows and why it matters.' })));

  // ---------- technical ----------
  const ran = { build: Boolean(build), render: Boolean(render) };
  if (build) {
    build.slides.forEach((s, i) => {
      if (s.editable === 'partial') add({ dimension: 'technical', severity: 'info', observed_in: 'build', slide: i + 1, message: `Contains image content (${s.raster_elements.map((r) => r.block).join(', ')}); not fully editable.`, action: 'None, unless editability matters for this element.' });
      s.warnings.filter((w) => !/needs-expert-review/.test(w)).forEach((w) => add({ dimension: 'technical', severity: /file not found|placeholder/.test(w) ? 'major' : 'minor', observed_in: 'build', slide: i + 1, message: w, action: /file not found|placeholder/.test(w) ? 'Supply the figure or remove the slide; a placeholder must not reach the audience.' : 'Confirm on the rendered slide.' }));
    });
  } else add({ dimension: 'technical', severity: 'major', message: 'Build report not provided; editability and engine warnings unchecked.', action: 'Build the deck and pass --build <deck>.build-report.json.' });
  if (render) {
    (render.findings ?? []).forEach((f) => add({ dimension: f.code === 'font_below_review_target' ? 'accessibility' : 'technical', severity: 'major', observed_in: 'render', slide: f.slide, element: f.element, message: `${f.code}: ${f.message}`, action: 'Fix the layout and re-render; do not change claims or shrink critical text.' }));
    const small = (render.approved_small_type ?? []).length;
    if (small) add({ dimension: 'technical', severity: 'info', observed_in: 'render', message: `${small} approved small-type element(s) (12 pt footers, 13 pt kickers; ADR-0008).`, action: 'None.' });
  } else add({ dimension: 'technical', severity: 'major', message: 'Render check not run; overflow and clipping unchecked.', action: 'Run npm run render:pptx and pass --render <dir>/render-report.json.' });

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension));
  const count = (sev) => findings.filter((f) => f.severity === sev).length;
  const status = count('critical') ? 'not-ready' : count('major') ? 'ready-with-documented-limitations' : 'no-blocking-issues-found';

  // evidence ledger, grouped by state
  const ledger = spec.claims.map((c) => ({
    id: c.id, state: c.evidence_status, kind: c.kind, relationship: c.relationship ?? '',
    text: c.text,
    sources: (c.source_refs ?? []).map((r) => `${sources.get(r.source_id)?.short_cite ?? r.source_id}${r.locator ? `, ${r.locator}` : ''} [${sources.get(r.source_id)?.verification.status ?? '?'}]`),
    slides: shownOn.get(c.id) ?? [],
    caveats: c.caveats ?? [], review_reason: c.review_reason ?? '', review_note: c.review_note ?? '',
  }));

  return { spec_id: spec.meta.id, generated: new Date().toISOString().slice(0, 10), status, counts: { critical: count('critical'), major: count('major'), minor: count('minor'), info: count('info') }, checks_run: ran, findings, ledger };
}

export function toMarkdown(rep, spec) {
  const L = [];
  const statusText = {
    'not-ready': 'NOT READY: critical findings must be fixed.',
    'ready-with-documented-limitations': 'NOT YET CLEARED: major findings need a fix or an explicit, recorded acceptance.',
    'no-blocking-issues-found': 'No blocking issues found by the automated checks.',
  }[rep.status];
  L.push(`# Quality report: ${spec.meta.title}`, '');
  L.push(`Generated ${rep.generated} for spec \`${rep.spec_id}\`.`, '');
  L.push(`**${statusText}**  `, `Critical ${rep.counts.critical} · Major ${rep.counts.major} · Minor ${rep.counts.minor} · Info ${rep.counts.info}`, '');
  L.push('> These checks are mechanical. They test consistency between claims, numbers, slides and the rendered deck. They do **not** establish that any source supports any claim. A deck is never scientifically verified by passing this report.', '');
  const blockers = rep.findings.filter((f) => f.severity === 'critical' || f.severity === 'major');
  if (blockers.length) {
    L.push('## Decide before presenting', '');
    blockers.forEach((f) => L.push(`- [ ] **${f.severity}** · ${DIM_LABEL[f.dimension]}${f.slide ? ` · slide ${f.slide}` : ''}${f.element ? ` · \`${f.element}\`` : ''}: ${f.message}  \n  → ${f.action}`));
    L.push('');
  }
  for (const d of DIMENSIONS) {
    const fs = rep.findings.filter((f) => f.dimension === d && !(f.severity === 'critical' || f.severity === 'major'));
    L.push(`## ${DIM_LABEL[d]}`, '');
    const nBlock = rep.findings.filter((f) => f.dimension === d && (f.severity === 'critical' || f.severity === 'major')).length;
    if (nBlock) L.push(`${nBlock} blocking finding(s), listed above.`, '');
    if (!fs.length && !nBlock) L.push('No findings from automated checks.', '');
    fs.forEach((f) => L.push(`- *${f.severity}*${f.slide ? ` · slide ${f.slide}` : ''}${f.element ? ` · \`${f.element}\`` : ''} (${f.observed_in}): ${f.message} → ${f.action}`));
    if (fs.length) L.push('');
  }
  L.push('## Evidence ledger', '', 'Three states, kept separate. A rendered deck does not change any state.', '');
  for (const state of ['needs-expert-review', 'source-backed', 'mechanically-validated']) {
    const rows = rep.ledger.filter((r) => r.state === state);
    L.push(`### ${state} (${rows.length})`, '');
    if (!rows.length) { L.push('None.', ''); continue; }
    L.push('| Claim | Kind | Source, locator [source status] | Slides | Caveats / review |', '|---|---|---|---|---|');
    rows.forEach((r) => L.push(`| ${r.text.replace(/\|/g, '/')} | ${r.kind}${r.relationship ? `, ${r.relationship}` : ''} | ${r.sources.join('; ') || 'none'} | ${r.slides.join(', ') || 'not shown'} | ${[...r.caveats, r.review_reason, r.review_note].filter(Boolean).join(' ').replace(/\|/g, '/') || ''} |`));
    L.push('');
  }
  L.push('## Manual review still required', '');
  L.push('- [ ] Each `source-backed` claim was read against its source at the stated locator.');
  L.push('- [ ] Figures are legible at presentation size and match their sources (see contact sheet).');
  L.push('- [ ] No decorative elements, icons or stock images were added that carry no information (references/anti-slop.md).');
  L.push('- [ ] Titles are not stronger than the evidence beneath them.');
  L.push('- [ ] Checks run: build report ' + (rep.checks_run.build ? 'yes' : '**no**') + ', render check ' + (rep.checks_run.render ? 'yes' : '**no**') + '.');
  L.push('');
  return L.join('\n');
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const specPath = args.find((a, i) => !a.startsWith('-') && !['--build', '--render', '-o'].includes(args[i - 1]));
  if (!specPath) { console.error('Usage: node modules/quality-review/quality-report.mjs <spec.json> [--build <build-report.json>] [--render <render-report.json>] [-o out/report.md]'); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const load = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null);
  const rep = buildQualityReport(spec, { build: load(get('--build')), render: load(get('--render')) });
  const out = resolve(get('-o') ?? `out/${spec.meta.id}.quality-report.md`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, toMarkdown(rep, spec));
  writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify(rep, null, 2));
  console.log(`Wrote ${out}`);
  console.log(`Status: ${rep.status} (critical ${rep.counts.critical}, major ${rep.counts.major}, minor ${rep.counts.minor}, info ${rep.counts.info})`);
  process.exit(rep.counts.critical ? 1 : 0);
}
