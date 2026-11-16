import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildDeck } from './build.mjs';

const load = () => JSON.parse(readFileSync(new URL('../../examples/research-talk/spec.json', import.meta.url), 'utf8'));

test('builds the research-talk example into a valid pptx (zip) with all slides', async () => {
  const { pptx, report } = await buildDeck(load());
  const buf = await pptx.write({ outputType: 'nodebuffer' });
  assert.equal(buf.subarray(0, 2).toString(), 'PK');
  assert.equal(report.summary.slides, 8);
});

test('reports raster figures honestly as partial editability', async () => {
  const { report } = await buildDeck(load());
  const s2 = report.slides.find((s) => s.id === 's02-design');
  assert.equal(s2.editable, 'partial');
  assert.equal(s2.raster_elements[0].origin, 'schematic');
});

test('flags slides that show needs-expert-review claims', async () => {
  const { report } = await buildDeck(load());
  const s7 = report.slides.find((s) => s.id === 's07-takehome');
  assert.ok(s7.warnings.some((w) => /needs-expert-review/.test(w)));
});

test('refuses to render a spec with validation errors', async () => {
  const spec = load();
  spec.slides[2].blocks[0].value = '+37 pp (95% CI 15 to 39)'; // altered number
  await assert.rejects(() => buildDeck(spec), /validation error/);
});

test('reference list auto-fits to small type and refuses content that cannot fit at 14 pt', async () => {
  const spec = load();
  const refs = spec.slides.find(s => s.layout === 'references');
  refs.blocks[0].text = Array.from({ length: 6 }, (_, i) => `${i + 1}. Example Author. A deliberately long citation about a synthetic study in rheumatology and its methods. Journal of Examples. 2026;12:100-110.`).join('\n\n');
  const { report } = await buildDeck(spec);
  const size = report.slides.find(s => s.id === refs.id).references_font_pt;
  assert.ok(size >= 14 && size < 18);
  refs.blocks[0].text = refs.blocks[0].text.repeat(8);
  await assert.rejects(() => buildDeck(spec), /cannot fit at 14 pt; split it in the spec/);
});

test('wide figure with three captions keeps most content height and stat leaves room for three bullets', async () => {
  const spec = load();
  const figure = spec.slides[1];
  figure.blocks = [figure.blocks[0], ...['Participants: active PsA', 'Treatments: blinded comparison', 'Outcome: clinical response'].map((text, i) => ({ id: `b02-cap${i}`, type: 'text', text, role: 'caption', claim_id: 'c-design' }))];
  const stat = spec.slides[2];
  stat.blocks = [stat.blocks[0], { id: 'b03-bullets', type: 'bullets', claim_id: 'c-primary', items: ['The treatment group improved.', 'The comparison group improved less.', 'Uncertainty remains in the estimate.'].map(text => ({ text })) }];
  stat.animation.steps = ['b03-stat', 'b03-bullets'];
  const { report } = await buildDeck(spec);
  assert.ok(report.slides[1].figure_height_fraction >= 0.6);
  assert.ok(report.slides[2].stat_region_height < 3.5);
  assert.ok(!report.slides.slice(1, 3).some(s => s.warnings.some(w => /overflow|taller than/.test(w))));
});

test('title line includes the confirmed occasion and every presenter', async () => {
  const spec = load();
  spec.meta.occasion = 'Project proposal meeting';
  spec.meta.presenters.push({ name: 'B. Example', affiliation: 'Example Institute' });
  const { pptx } = await buildDeck(spec);
  const titleText = pptx._slides[0]._slideObjects.flatMap((o) => o.text ?? []).map((r) => r.text).join('\n');
  assert.match(titleText, /Project proposal meeting/);
  assert.match(titleText, /B\. Example/);
});
