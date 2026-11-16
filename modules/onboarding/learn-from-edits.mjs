#!/usr/bin/env node
// T19: compare a generated deck with the presenter's edited copy and propose lessons.
// Report only: it never edits a profile, spec or deck. The presenter confirms each lesson first.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MOVE_IN = 0.15;   // inches; smaller shifts are noise
const IGNORE_ROLES = new Set(['slide_number', 'template_footer']);

export function dumpDeck(path) {
  const out = execFileSync('python3', [join(here, 'deck_dump.py'), path], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out);
}

const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
function bigrams(t) { const s = norm(t); const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
export function similarity(a, b) {
  if (norm(a) === norm(b)) return 1;
  const A = bigrams(a), B = bigrams(b); let inter = 0, n = 0;
  for (const [g, c] of A) { inter += Math.min(c, B.get(g) || 0); n += c; }
  for (const c of B.values()) n += c;
  return n ? (2 * inter) / n : 0;
}
export const numbersIn = (t) => (String(t ?? '').replace(/(\d),(\d{3})\b/g, '$1$2').match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.'));

function slideKey(s) { return s.title || s.shapes.filter((x) => x.text).map((x) => x.text).join(' ').slice(0, 120); }

// Monotonic alignment of slides (generated -> edited) by title similarity.
export function alignSlides(gen, ed, threshold = 0.6) {
  const n = gen.length, m = ed.length;
  const sim = gen.map((g) => ed.map((e) => similarity(slideKey(g), slideKey(e))));
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    const take = sim[i][j] >= threshold ? sim[i][j] + dp[i + 1][j + 1] : -Infinity;
    dp[i][j] = Math.max(take, dp[i + 1][j], dp[i][j + 1]);
  }
  const pairs = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (sim[i][j] >= threshold && dp[i][j] === sim[i][j] + dp[i + 1][j + 1]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i][j] === dp[i + 1][j]) i++; else j++;
  }
  // Positional fallback: one unmatched slide between the same two anchors on both sides is the same slide, edited heavily.
  const anchors = [[-1, -1], ...pairs, [n, m]];
  const extra = [];
  for (let k = 0; k < anchors.length - 1; k++) {
    const [gi, ej] = anchors[k], [gn, en] = anchors[k + 1];
    if (gn - gi === 2 && en - ej === 2 && (gen[gi + 1].layout === ed[ej + 1].layout)) extra.push([gi + 1, ej + 1]);
  }
  return [...pairs, ...extra].sort((a, b) => a[0] - b[0]);
}

export function wordDiff(a, b) {
  const tok = (t) => String(t ?? '').split(/\s+/).filter(Boolean);
  const A = tok(a), B = tok(b), cb = new Map(), ca = new Map();
  for (const w of B) cb.set(w.toLowerCase(), (cb.get(w.toLowerCase()) || 0) + 1);
  for (const w of A) ca.set(w.toLowerCase(), (ca.get(w.toLowerCase()) || 0) + 1);
  const removed = [], added = [];
  for (const w of A) { const k = w.toLowerCase(); if (cb.get(k)) cb.set(k, cb.get(k) - 1); else removed.push(w); }
  for (const w of B) { const k = w.toLowerCase(); if (ca.get(k)) ca.set(k, ca.get(k) - 1); else added.push(w); }
  return { removed, added };
}

function matchShapes(gs, es) {
  const pairs = []; const usedE = new Set();
  const cand = [];
  gs.forEach((g, i) => es.forEach((e, j) => {
    if (g.kind !== e.kind) return;
    let score = g.role === e.role ? 0.2 : 0;
    if (g.text || e.text) score += similarity(g.text, e.text); else score += 0.5;
    if (g.name === e.name) score += 0.3;
    const dist = Math.hypot((g.x ?? 0) - (e.x ?? 0), (g.y ?? 0) - (e.y ?? 0));
    score += Math.max(0, 0.3 - dist / 10);
    cand.push([score, i, j]);
  }));
  cand.sort((a, b) => b[0] - a[0]);
  const usedG = new Set();
  for (const [score, i, j] of cand) {
    if (score < 0.55 || usedG.has(i) || usedE.has(j)) continue;
    usedG.add(i); usedE.add(j); pairs.push([i, j]);
  }
  return { pairs, removed: gs.map((_, i) => i).filter((i) => !usedG.has(i)), added: es.map((_, j) => j).filter((j) => !usedE.has(j)) };
}

function roleLabel(shape, slideRole) {
  if (shape.role === 'body' && slideRole === 'question') return 'question';
  if (shape.role === 'title' && slideRole === 'title') return 'title-slide title';
  if (shape.role === 'placeholder_text' && slideRole === 'title') return 'title-slide subtitle';
  return shape.role;
}

export function compareDecks(genDeck, edDeck, { spec } = {}) {
  const specSlides = spec?.slides ?? [];
  const slideInfo = (i) => {
    const title = genDeck.slides[i].title;
    let layout = specSlides[i]?.layout ?? null;
    if (/^(references|bronnen|literatuur|referenties)$/i.test(title.trim())) layout = 'references';
    return { index: i + 1, id: specSlides[i]?.id ?? null, layout, title, claim_ids: specSlides[i]?.claim_ids ?? [] };
  };
  const changes = [];
  const pairs = alignSlides(genDeck.slides, edDeck.slides);
  const matchedG = new Set(pairs.map((p) => p[0])), matchedE = new Set(pairs.map((p) => p[1]));
  genDeck.slides.forEach((s, i) => { if (!matchedG.has(i)) changes.push({ type: 'slide_removed', slide: slideInfo(i) }); });
  edDeck.slides.forEach((s, j) => { if (!matchedE.has(j)) changes.push({ type: 'slide_added', edited_index: j + 1, title: s.title }); });

  for (const [i, j] of pairs) {
    const g = genDeck.slides[i], e = edDeck.slides[j], where = slideInfo(i);
    const slideRole = where.layout;
    const gs = g.shapes.filter((x) => !IGNORE_ROLES.has(x.role)), es = e.shapes.filter((x) => !IGNORE_ROLES.has(x.role));
    const m = matchShapes(gs, es);
    for (const [a, b] of m.pairs) {
      const A = gs[a], B = es[b], role = roleLabel(A, slideRole);
      if (norm(A.text) !== norm(B.text) && role === 'footer') {
        changes.push({ type: 'citation_changed', slide: where, role, from: A.text, to: B.text, diff: wordDiff(A.text, B.text) });
      } else if (norm(A.text) !== norm(B.text)) {
        const na = numbersIn(A.text), nb = numbersIn(B.text);
        const numChanged = na.join('|') !== nb.join('|');
        changes.push({ type: role === 'title' || role === 'title-slide title' ? 'title_changed' : 'text_changed', slide: where, role, from: A.text, to: B.text, diff: wordDiff(A.text, B.text),
          numbers_changed: numChanged ? (() => { const d = wordDiff(na.join(' '), nb.join(' ')); return { from: d.removed, to: d.added }; })() : null });
      }
      if ((A.font_pt || B.font_pt) && A.font_pt !== B.font_pt && !(A.font_pt && !B.font_pt)) changes.push({ type: 'font_size', slide: where, role, from: A.font_pt ?? 'template default', to: B.font_pt });
      const dx = (B.x ?? 0) - (A.x ?? 0), dy = (B.y ?? 0) - (A.y ?? 0);
      if (Math.abs(dx) > MOVE_IN || Math.abs(dy) > MOVE_IN) changes.push({ type: 'moved', slide: where, role, from: { x: A.x, y: A.y }, to: { x: B.x, y: B.y } });
      const dw = (B.w ?? 0) - (A.w ?? 0);
      if (Math.abs(dw) > MOVE_IN && !(role === 'question' || role === 'body')) changes.push({ type: 'resized', slide: where, role, from: { w: A.w, h: A.h }, to: { w: B.w, h: B.h } });
      if (A.cell_align && B.cell_align && JSON.stringify(A.cell_align) !== JSON.stringify(B.cell_align)) changes.push({ type: 'table_alignment', slide: where, role, from: A.cell_align[1] ?? A.cell_align[0], to: B.cell_align[1] ?? B.cell_align[0] });
    }
    for (const a of m.removed) changes.push({ type: 'shape_removed', slide: where, role: roleLabel(gs[a], slideRole), text: gs[a].text });
    for (const b of m.added) changes.push({ type: 'shape_added', slide: where, role: roleLabel(es[b], slideRole), text: es[b].text });
    // Reordered blocks with the same role (e.g. discussion questions)
    const order = (shapes) => shapes.filter((x) => x.role === 'body' && x.text).sort((p, q) => (p.y - q.y) || (p.x - q.x)).map((x) => norm(x.text));
    const og = order(gs), oe = order(es);
    if (og.length > 1 && og.length === oe.length && og.join('|') !== oe.join('|') && [...og].sort().join('|') === [...oe].sort().join('|'))
      changes.push({ type: 'reordered', slide: where, role: roleLabel({ role: 'body' }, slideRole), from: og, to: oe });
    if (changes.length && changes[changes.length - 1].type === 'reordered' && changes[changes.length - 1].slide === where) {
      const rrole = changes[changes.length - 1].role;
      for (let k = changes.length - 2; k >= 0 && changes[k].slide === where; k--) if (changes[k].type === 'moved' && changes[k].role === rrole) changes.splice(k, 1);
    }
    if (norm(g.notes) !== norm(e.notes)) changes.push({ type: 'notes_changed', slide: where });
  }
  return { changes, lessons: deriveLessons(changes, genDeck.slides.length) };
}

const r1 = (v) => Math.round(v * 10) / 10;

// Group changes into lessons. A pattern on >= 2 slides is a candidate style cue; content edits stay per slide.
export function deriveLessons(changes) {
  const lessons = [];
  const group = (key, items, make) => { const by = new Map(); for (const c of items) { const k = key(c); if (!by.has(k)) by.set(k, []); by.get(k).push(c); } for (const [k, cs] of by) lessons.push(make(cs, k)); };
  const slidesOf = (cs) => [...new Set(cs.map((c) => c.slide?.index).filter(Boolean))].sort((a, b) => a - b);
  const scopeOf = (cs) => (slidesOf(cs).length > 1 ? 'pattern' : 'one-off');

  // Moves cluster when the target is within 0.3 in of the cluster's first target.
  const clusters = [];
  for (const c of changes.filter((c) => c.type === 'moved')) {
    const hit = clusters.find((k) => k[0].role === c.role && Math.abs(k[0].to.x - c.to.x) <= 0.3 && Math.abs(k[0].to.y - c.to.y) <= 0.3);
    if (hit) hit.push(c); else clusters.push([c]);
  }
  for (const cs of clusters) lessons.push(((cs) => ({
    kind: 'style', scope: scopeOf(cs), slides: slidesOf(cs),
    text: `Moved ${cs[0].role} to x ${r1(cs[0].to.x)} in, y ${r1(cs[0].to.y)} in (was x ${r1(cs[0].from.x)}, y ${r1(cs[0].from.y)}).`,
    proposal: cs[0].role === 'footer' ? 'Place the citation footer at this position (template map or engine default).' : `Position of ${cs[0].role} blocks.`,
  }))(cs));
  group((c) => c.slide.index, changes.filter((c) => c.type === 'citation_changed'), (cs) => ({
    kind: 'citation', scope: 'one-off', slides: slidesOf(cs),
    text: `Footer citation edited: ${cs.map((c) => [c.diff.removed.length ? `removed "${c.diff.removed.join(' ')}"` : '', c.diff.added.length ? `added "${c.diff.added.join(' ')}"` : ''].filter(Boolean).join(', ')).join('; ')}.`,
    proposal: 'Check which sources the slide really shows; the footer should cite only those (claim_ids on this slide).',
  }));
  group((c) => `${c.role}|${c.from}|${c.to}`, changes.filter((c) => c.type === 'font_size'), (cs) => ({
    kind: 'style', scope: scopeOf(cs), slides: slidesOf(cs),
    text: `${cs[0].role} type size ${cs[0].from}${typeof cs[0].from === 'number' ? ' pt' : ''} -> ${cs[0].to} pt.`, proposal: `Default size for ${cs[0].role}: ${cs[0].to} pt.`,
  }));
  group((c) => c.role, changes.filter((c) => c.type === 'table_alignment'), (cs) => ({
    kind: 'style', scope: scopeOf(cs), slides: slidesOf(cs),
    text: `Table cell alignment changed (${(cs[0].from || []).join('/')} -> ${(cs[0].to || []).join('/')}).`, proposal: 'Table alignment rule.',
  }));
  group((c) => c.role, changes.filter((c) => c.type === 'shape_removed'), (cs, role) => ({
    kind: role === 'footer' ? 'citation' : 'content', scope: scopeOf(cs), slides: slidesOf(cs),
    text: `Removed ${role}: ${cs.map((c) => `"${c.text.slice(0, 60)}"`).join('; ')}.`,
    proposal: role === 'caption' || role === 'body' ? 'Check whether this kind of text should not be generated.' : `Do not generate ${role} in this situation.`,
  }));
  for (const c of changes.filter((c) => c.type === 'shape_added')) lessons.push({ kind: 'content', scope: 'one-off', slides: [c.slide.index], text: `Added ${c.role}: "${c.text.slice(0, 80)}".`, proposal: 'Content the presenter supplies; ask whether the generator should ask for it.' });
  group((c) => c.slide.layout ?? 'unknown', changes.filter((c) => c.type === 'slide_removed'), (cs, layout) => ({
    kind: 'structure', scope: scopeOf(cs), slides: slidesOf(cs),
    text: `Removed slide(s): ${cs.map((c) => `${c.slide.index} "${c.slide.title}"`).join('; ')} (layout ${layout}).`,
    proposal: layout === 'references' ? 'References slide optional for this occasion (profile references_slide_default or intake answer).' : 'Ask whether this slide type is wanted for this occasion.',
  }));
  for (const c of changes.filter((c) => c.type === 'slide_added')) lessons.push({ kind: 'structure', scope: 'one-off', slides: [], text: `Added slide "${c.title}" (position ${c.edited_index}).`, proposal: 'Content the presenter supplies; add to the spec if it should be traced.' });
  for (const c of changes.filter((c) => c.type === 'reordered')) lessons.push({ kind: 'content', scope: 'one-off', slides: [c.slide.index], text: `Reordered ${c.role} blocks.`, proposal: 'Order preference; ask before generalising.' });
  for (const c of changes.filter((c) => c.type === 'title_changed' || c.type === 'text_changed')) {
    lessons.push({
      kind: c.numbers_changed ? 'integrity' : 'content', scope: 'one-off', slides: [c.slide.index],
      text: `${c.role} text${c.diff.removed.length ? ` · removed "${c.diff.removed.join(' ')}"` : ''}${c.diff.added.length ? ` · added "${c.diff.added.join(' ')}"` : ''}${c.slide.claim_ids?.length ? ` (claims: ${c.slide.claim_ids.join(', ')})` : ''}.`,
      proposal: c.numbers_changed
        ? `Numbers changed (${c.numbers_changed.from.join(', ') || 'none'} -> ${c.numbers_changed.to.join(', ') || 'none'}): update the claim in the spec and re-check it against its source before reuse.`
        : c.role === 'title-slide subtitle' ? 'Ask at intake for the title-slide line (occasion, all presenters); add co-presenters to meta.presenters.'
        : c.role === 'title-slide title' ? 'Ask at intake for the full title as it should appear on the title slide.'
        : 'Update the spec wording if this talk is rebuilt; generalise only if the presenter confirms.',
    });
  }
  const notes = changes.filter((c) => c.type === 'notes_changed');
  if (notes.length) lessons.push({ kind: 'content', scope: notes.length > 1 ? 'pattern' : 'one-off', slides: notes.map((c) => c.slide.index), text: 'Speaker notes edited.', proposal: 'Review the notes diff manually.' });
  const order = { integrity: 0, citation: 1, style: 2, structure: 3, content: 4 };
  return lessons.sort((a, b) => (order[a.kind] - order[b.kind]) || ((b.scope === 'pattern') - (a.scope === 'pattern')) || ((a.slides[0] ?? 0) - (b.slides[0] ?? 0)));
}

export function renderReport({ lessons, changes }, { generated, edited, spec }) {
  const L = [];
  L.push('# Lessons from presenter edits', '');
  L.push(`Generated: \`${generated}\`  `, `Edited: \`${edited}\`  `, spec ? `Spec: \`${spec}\`` : 'Spec: not given (slides labelled by position only)', '');
  L.push('> Proposals only. Nothing here is a preference until the presenter confirms it. Confirmed style preferences go into the local profile (`profile.mjs update`); content corrections go into the spec and need a new storyboard approval.', '');
  const section = (title, kind) => {
    const ls = lessons.filter((l) => l.kind === kind); if (!ls.length) return;
    L.push(`## ${title}`, '');
    for (const l of ls) L.push(`- [ ] **${l.scope}**${l.slides.length ? ` · slide${l.slides.length > 1 ? 's' : ''} ${l.slides.join(', ')}` : ''} · ${l.text}  `, `  → ${l.proposal}`);
    L.push('');
  };
  section('Scientific integrity (check first)', 'integrity');
  section('Citations', 'citation');
  section('Style cues (candidate profile observations)', 'style');
  section('Structure', 'structure');
  section('Content edits', 'content');
  if (!lessons.length) L.push('No differences found.', '');
  L.push(`_${changes.length} raw change(s); run with --json for the full list._`, '');
  return L.join('\n');
}

function args(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--') || k === '-o') { const key = k === '-o' ? 'out' : k.slice(2); a[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; } else a._.push(k); }
  return a;
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const a = args(process.argv.slice(2));
  const [generated, edited] = a._;
  if (!generated || !edited) { console.error('Usage: node modules/onboarding/learn-from-edits.mjs <generated.pptx> <edited.pptx> [--spec spec.json] [-o|--out report.md] [--json changes.json]'); process.exit(2); }
  for (const f of [generated, edited, a.spec].filter(Boolean)) if (!existsSync(f)) { console.error(`Not found: ${f}`); process.exit(2); }
  const spec = a.spec ? JSON.parse(readFileSync(a.spec, 'utf8')) : null;
  const result = compareDecks(dumpDeck(generated), dumpDeck(edited), { spec });
  const md = renderReport(result, { generated, edited, spec: a.spec });
  const out = a.out || a.o;
  if (out) { writeFileSync(out, md); console.log(`Wrote ${out}`); } else console.log(md);
  if (a.json) writeFileSync(a.json, JSON.stringify(result, null, 2));
  const counts = result.lessons.reduce((m, l) => (m[l.kind] = (m[l.kind] || 0) + 1, m), {});
  console.error(`Lessons: ${result.lessons.length} (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
}
