import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { renderStoryboard, approvalReceipt, checkApproval } from './storyboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(here, '../examples/research-talk/spec.json');
const raw = readFileSync(specPath);
const spec = JSON.parse(raw);
const hash = createHash('sha256').update(raw).digest('hex');

test('renders an evidence-aware storyboard with timing and expert-review flags', () => {
  const markdown = renderStoryboard(spec, { origin: 'source', specHash: hash });
  assert.match(markdown, /proposed from source material/);
  assert.match(markdown, /8:30 allocated across 8 slides versus 10:00 speaking slot; 1:30 unallocated/);
  assert.match(markdown, /## Slide sequence/);
  assert.equal((markdown.match(/^### \d+\./gm) || []).length, 8);
  assert.match(markdown, /Claim `c-tnf-ir` — `needs-expert-review`/);
  assert.match(markdown, /\*\*Expert review needed:\*\* Presenter's extrapolation/);
  assert.match(markdown, /Table 2/);
  assert.match(markdown, /verification: `user-provided`/);
});

test('storyboard shows the explicit expert-review reason', () => {
  const withReason = structuredClone(spec);
  const claim = withReason.claims.find((c) => c.evidence_status === 'needs-expert-review');
  claim.review_reason = 'Only the abstract was available.';
  assert.match(renderStoryboard(withReason, { origin: 'source', specHash: hash }), /\*\*Expert review needed:\*\* Only the abstract was available\./);
});

test('outline origin remains unapproved and preserves slide order', () => {
  const markdown = renderStoryboard(spec, { origin: 'outline', specHash: hash });
  assert.match(markdown, /completed from supplied outline/);
  assert.match(markdown, /Explicit user approval is required before rendering/);
  assert.ok(markdown.indexOf('### 1.') < markdown.indexOf('### 8.'));
});

test('approval receipt is bound to exact spec and storyboard bytes', () => {
  const markdown = renderStoryboard(spec, { origin: 'source', specHash: hash });
  const receipt = approvalReceipt(hash, markdown, 'Synthetic test reviewer');
  assert.equal(checkApproval(hash, markdown, receipt), true);
  assert.throws(() => checkApproval(hash, `${markdown}\nchanged`, receipt), /No matching approval/);
  assert.throws(() => checkApproval('0'.repeat(64), markdown, receipt), /differ/);
});

test('render command refuses a storyboard without approval', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'academic-presenting-storyboard-test-'));
  const storyboardPath = path.join(directory, 'storyboard.md');
  const deckPath = path.join(directory, 'deck.pptx');
  writeFileSync(storyboardPath, renderStoryboard(spec, { origin: 'source', specHash: hash }));
  const result = spawnSync(process.execPath, [path.join(here, 'storyboard.mjs'), 'render', specPath, storyboardPath, '--out', deckPath], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Approval receipt is missing/);
  assert.equal(existsSync(deckPath), false);
});

test('render command accepts a matching synthetic approval receipt', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'academic-presenting-storyboard-test-'));
  const storyboardPath = path.join(directory, 'storyboard.md');
  const deckPath = path.join(directory, 'deck.pptx');
  const markdown = renderStoryboard(spec, { origin: 'source', specHash: hash });
  writeFileSync(storyboardPath, markdown);
  writeFileSync(`${storyboardPath}.approval.json`, JSON.stringify(approvalReceipt(hash, markdown, 'Synthetic test reviewer')));
  const result = spawnSync(process.execPath, [path.join(here, 'storyboard.mjs'), 'render', specPath, storyboardPath, '--out', deckPath], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(deckPath), true);
  assert.match(result.stdout, /8 slides/);
});

test('storyboard shows presenter input status and per-slide origin', async () => {
  const { readIntake } = await import('./storyboard.mjs');
  const intake = readIntake(specPath, spec);
  assert.equal(intake.status, 'complete');
  const markdown = renderStoryboard(spec, { origin: 'outline', specHash: hash, intake });
  assert.match(markdown, /\*\*Presenter input:\*\* intake complete \(notes/);
  assert.match(markdown, /4 from your input · 3 from the source · 1 PROPOSED by the agent/);
  assert.match(markdown, /\*\*Origin:\*\* PROPOSED by the agent \(needs your agreement\)/);
});

test('generate refuses without presenter input unless explicitly in developer mode', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'academic-presenting-intake-test-'));
  const noIntake = { ...spec };
  delete noIntake.intake_ref;
  const p = path.join(directory, 'spec.json');
  writeFileSync(p, JSON.stringify(noIntake));
  const out = path.join(directory, 'sb.md');
  const refused = spawnSync(process.execPath, [path.join(here, 'storyboard.mjs'), 'generate', p, '--out', out], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Presenter input missing/);
  const dev = spawnSync(process.execPath, [path.join(here, 'storyboard.mjs'), 'generate', p, '--out', out, '--no-intake'], { encoding: 'utf8' });
  assert.equal(dev.status, 0);
  assert.match(readFileSync(out, 'utf8'), /\*\*MISSING\*\* \(developer mode/);
});
