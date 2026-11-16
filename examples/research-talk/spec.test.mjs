import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSpec } from '../../scripts/validate-spec.mjs';

const spec = JSON.parse(readFileSync(new URL('./spec.json', import.meta.url), 'utf8'));

test('research-talk example validates without errors', () => {
  assert.deepEqual(validateSpec(spec).errors, []);
});

test('research-talk example covers every v0.1 PowerPoint layout', () => {
  const layouts = new Set(spec.slides.map((s) => s.layout));
  for (const l of ['title', 'claim-figure', 'stat-card', 'comparison', 'question', 'take-home', 'references']) {
    assert.ok(layouts.has(l), `missing layout ${l}`);
  }
});

test('research-talk example contains a needs-expert-review claim on a slide', () => {
  const flagged = spec.claims.filter((c) => c.evidence_status === 'needs-expert-review').map((c) => c.id);
  const shown = new Set(spec.slides.flatMap((s) => s.claim_ids ?? []));
  assert.ok(flagged.some((id) => shown.has(id)));
});
