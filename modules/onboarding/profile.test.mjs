import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeProfile, renderProfile, parseProfile, applyProfile } from './profile.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const spec = JSON.parse(readFileSync(join(repo, 'schemas/examples/minimal.valid.json'), 'utf8'));

test('profile round-trip keeps confirmed settings separate from observed cues', () => {
  const profile = makeProfile({ name: 'Example Researcher', role: 'Clinician-scientist', discipline: 'Immunology', font_heading: 'Source Sans 3', accent: '#123ABC', style_references: ['local style deck'] });
  const markdown = renderProfile(profile);
  const parsed = parseProfile(markdown);
  assert.deepEqual(parsed.profile, profile);
  assert.match(parsed.tail, /Observed style cues \(not confirmed\)/);
  assert.equal(profile.design.tokens.colors.accent, '123ABC');
  assert.equal(profile.id, 'example-researcher');
  assert.equal(profile.references_slide_default, true);
});

test('a presenter can prefer no references slide while old profiles retain the default', () => {
  const profile = makeProfile({ name: 'Example', references_slide_default: false });
  assert.equal(parseProfile(renderProfile(profile)).profile.references_slide_default, false);
  delete profile.references_slide_default;
  assert.equal(parseProfile(renderProfile(profile)).profile.references_slide_default, undefined);
  assert.throws(() => makeProfile({ name: 'Example', references_slide_default: 'no' }), /References slide default/);
});

test('profile fills missing design tokens while explicit deck choices win', () => {
  const profile = makeProfile({ name: 'Example Researcher', theme: 'dark', font_heading: 'Source Sans 3', font_body: 'Calibri', accent: '123ABC', highlight: 'ABC123' });
  const original = structuredClone(spec);
  original.design.tokens = { font_heading: 'Georgia', colors: { accent: '1F3A5F' } };
  const result = applyProfile(original, profile, 'profiles/example-researcher.local.md');
  assert.equal(result.design.theme, 'light');
  assert.equal(result.design.tokens.font_heading, 'Georgia');
  assert.equal(result.design.tokens.font_body, 'Calibri');
  assert.deepEqual(result.design.tokens.colors, { accent: '1F3A5F', highlight: 'ABC123' });
  assert.equal(result.profile_ref, 'profiles/example-researcher.local.md');
  assert.equal(original.design.tokens.font_body, undefined);
});

test('invalid design color is rejected before it reaches the spec', () => {
  assert.throws(() => makeProfile({ name: 'Example', accent: 'blue' }), /Invalid color/);
});

test('CLI creates multiple local profiles and applies one to a spec', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academic-presenting-profile-'));
  const script = join(here, 'profile.mjs');
  const outputs = [];
  for (const name of ['Example One', 'Example Two']) {
    const answers = join(directory, `${name.replace(' ', '-')}.json`);
    const out = join(directory, `${name.replace(' ', '-')}.local.md`);
    writeFileSync(answers, JSON.stringify({ name, font_heading: 'Calibri' }));
    const created = spawnSync(process.execPath, [script, 'create', '--answers', answers, '--out', out], { encoding: 'utf8' });
    assert.equal(created.status, 0, created.stderr);
    outputs.push(out);
  }
  assert.notEqual(parseProfile(readFileSync(outputs[0], 'utf8')).profile.id, parseProfile(readFileSync(outputs[1], 'utf8')).profile.id);
  const outSpec = join(directory, 'profiled-spec.json');
  const applied = spawnSync(process.execPath, [script, 'apply', outputs[0], join(repo, 'schemas/examples/minimal.valid.json'), '--out', outSpec], { encoding: 'utf8' });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(existsSync(outSpec), true);
  assert.equal(JSON.parse(readFileSync(outSpec, 'utf8')).design.tokens.font_heading, 'Calibri');
});

test('CLI refuses a personal profile in a tracked repository path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academic-presenting-profile-'));
  const answers = join(directory, 'answers.json');
  const unsafe = join(repo, 'profiles', 'unsafe.md');
  writeFileSync(answers, JSON.stringify({ name: 'Synthetic Tester' }));
  const result = spawnSync(process.execPath, [join(here, 'profile.mjs'), 'create', '--answers', answers, '--out', unsafe], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /profiles\/\*\.local\.md/);
  assert.equal(existsSync(unsafe), false);
});

test('CLI update keeps local notes and changes only confirmed settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'academic-presenting-profile-'));
  const profilePath = join(directory, 'researcher.local.md');
  const answersPath = join(directory, 'answers.json');
  const original = makeProfile({ name: 'Synthetic Researcher', font_heading: 'Calibri' });
  writeFileSync(profilePath, renderProfile(original, '## Observed style cues (not confirmed)\n\nDense figure labels in one supplied deck.\n'));
  writeFileSync(answersPath, JSON.stringify({ font_heading: 'Georgia' }));
  const result = spawnSync(process.execPath, [join(here, 'profile.mjs'), 'update', profilePath, '--answers', answersPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const updated = parseProfile(readFileSync(profilePath, 'utf8'));
  assert.equal(updated.profile.design.tokens.font_heading, 'Georgia');
  assert.match(updated.tail, /Dense figure labels in one supplied deck/);
});
