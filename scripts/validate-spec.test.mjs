import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSpec } from './validate-spec.mjs';

const base = JSON.parse(readFileSync(new URL('../schemas/examples/minimal.valid.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(base);
const has = (list, re) => list.some((x) => re.test(x.message));

test('valid example has no errors', () => {
  assert.deepEqual(validateSpec(clone()).errors, []);
});

test('schema: figure without alt text is rejected', () => {
  const s = clone();
  s.slides[1].blocks.push({ id: 'b-fig', type: 'figure', path: 'fig.png' });
  assert.ok(validateSpec(s).errors.length > 0);
});

test('source-backed claim without sources is an error', () => {
  const s = clone();
  delete s.claims[1].source_refs;
  assert.ok(has(validateSpec(s).errors, /source-backed but has no source_refs/));
});

test('stat showing a number absent from the claim is an error (altered result)', () => {
  const s = clone();
  s.slides[1].blocks[0].value = '-1.9 (95% CI -1.3 to -0.5)';
  assert.ok(has(validateSpec(s).errors, /do not appear in claim/));
});

test('hyphen ranges in stat values are accepted', () => {
  const s = clone();
  s.slides[1].blocks[0].value = '-0.9 (-1.3-0.5)';
  assert.deepEqual(validateSpec(s).errors, []);
});

test('unknown claim id on a slide is an error', () => {
  const s = clone();
  s.slides[2].claim_ids.push('c-ghost');
  assert.ok(has(validateSpec(s).errors, /unknown claim id "c-ghost"/));
});

test('citing a source marked not-found is an error', () => {
  const s = clone();
  s.sources[0].verification.status = 'not-found';
  assert.ok(has(validateSpec(s).errors, /could not be found/));
});

test('point estimate outside its CI is an error', () => {
  const s = clone();
  s.claims[0].quantities[0].value = -2.0;
  s.slides[1].blocks[0].value = '-2 (95% CI -1.3 to -0.5)';
  assert.ok(has(validateSpec(s).errors, /outside its CI/));
});

test('animation step must be a block on the same slide', () => {
  const s = clone();
  s.slides[1].animation.steps.push('b-q');
  assert.ok(has(validateSpec(s).errors, /not a block on this slide/));
});

test('duplicate block ids are an error', () => {
  const s = clone();
  s.slides[2].blocks.push({ id: 'b-stat', type: 'text', text: 'dup' });
  assert.ok(has(validateSpec(s).errors, /duplicate block id/));
});

test('result-like number without linked claim is a warning', () => {
  const s = clone();
  s.slides[0].blocks = [{ id: 'b-loose', type: 'text', text: 'Response rate was 64% in the treated arm' }];
  assert.ok(has(validateSpec(s).warnings, /no linked claim/));
});

test('unused claim is a warning', () => {
  const s = clone();
  s.slides[2].claim_ids = [];
  assert.ok(has(validateSpec(s).warnings, /not shown on any slide/));
});

test('causal claim citing an RCT does not warn', () => {
  const s = clone();
  s.sources[0].design = 'rct';
  assert.ok(!has(validateSpec(s).warnings, /causal relationship/));
});

test('causal claim citing only a cohort study still warns', () => {
  const s = clone();
  s.sources[0].design = 'cohort';
  assert.ok(has(validateSpec(s).warnings, /no cited source is an RCT \(cited design\(s\): cohort\)/));
});

test('causal claim with unknown source design warns', () => {
  assert.ok(has(validateSpec(clone()).warnings, /source design unknown/));
});

test('arm-descriptive quantity without CI does not warn; effect quantity does', () => {
  const s = clone();
  s.claims[0].quantities.push({ label: 'response, arm A', role: 'arm-descriptive', value: 58 });
  s.claims[0].quantities.push({ label: 'difference without CI', value: 27 });
  const w = validateSpec(s).warnings;
  assert.ok(!has(w, /"response, arm A" has no confidence interval/));
  assert.ok(has(w, /"difference without CI" has no confidence interval/));
});

test('original figure requires a linked source, licence and credit', () => {
  const s = clone();
  const figure = { id: 'b-original', type: 'figure', path: 'figure.png', alt: 'Synthetic figure', origin: 'original-from-source' };
  s.slides[1].blocks.push(figure);
  assert.ok(has(validateSpec(s).errors, /needs a source_id/));
  figure.source_id = s.sources[0].id;
  assert.ok(has(validateSpec(s).errors, /no recorded reuse permission/));
  s.sources[0].licence = 'all rights reserved';
  assert.ok(has(validateSpec(s).errors, /no recorded reuse permission/));
  s.sources[0].licence = 'CC BY 4.0';
  assert.ok(has(validateSpec(s).errors, /needs a recorded credit/));
  figure.credit = 'Doe et al., CC BY 4.0';
  assert.equal(validateSpec(s).errors.length, 0);
  assert.ok(has(validateSpec(s).warnings, /third-party figure terms can differ/));
});

test('conditional licence is flagged for manual check, and review reason is recorded', () => {
  const s = clone();
  s.sources[0].licence = 'CC BY-NC 4.0';
  s.slides[1].blocks.push({ id: 'b-original', type: 'figure', path: 'figure.png', alt: 'Synthetic figure', origin: 'original-from-source', source_id: s.sources[0].id, credit: 'Doe et al., CC BY-NC 4.0' });
  assert.equal(validateSpec(s).errors.length, 0);
  assert.ok(has(validateSpec(s).warnings, /confirm its conditions allow this presentation/));
  s.claims[0].evidence_status = 'needs-expert-review';
  delete s.claims[0].review_note;
  assert.ok(has(validateSpec(s).warnings, /reason is not recorded/));
  s.claims[0].review_reason = 'Full text was unavailable.';
  assert.ok(!has(validateSpec(s).warnings, /reason is not recorded/));
});
