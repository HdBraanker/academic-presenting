#!/usr/bin/env node
// Local presenter profiles. The fenced settings block is the editable source of truth.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../../scripts/validate-spec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FORMAT = 'academic-presenting-profile-v1';
const MARKER = '<!-- academic-presenting-profile-settings -->';
const SETTINGS = /<!-- academic-presenting-profile-settings -->\s*```json\s*\n([\s\S]*?)\n```/;

function clean(value) { return String(value ?? '').trim(); }
function slug(value) { return clean(value).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

export function makeProfile(answers) {
  const name = clean(answers.name);
  if (!name) throw new Error('A profile name is required');
  const id = clean(answers.id) || slug(name);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Profile ID must be lowercase letters, digits, and hyphens');
  const tokens = {};
  for (const key of ['font_heading', 'font_body']) if (clean(answers[key])) tokens[key] = clean(answers[key]);
  if (answers.min_font_pt !== undefined && answers.min_font_pt !== null && answers.min_font_pt !== '') tokens.min_font_pt = Number(answers.min_font_pt);
  const colors = {};
  for (const key of ['accent', 'highlight']) if (clean(answers[key])) colors[key] = clean(answers[key]).replace(/^#/, '').toUpperCase();
  if (Object.keys(colors).length) tokens.colors = colors;
  const profile = {
    format: FORMAT,
    id,
    name,
    role: clean(answers.role),
    discipline: clean(answers.discipline),
    typical_audience: clean(answers.typical_audience),
    preferred_style: clean(answers.preferred_style),
    scientific_depth: clean(answers.scientific_depth),
    citation_preference: clean(answers.citation_preference),
    references_slide_default: answers.references_slide_default === undefined ? true : answers.references_slide_default,
    typical_duration_minutes: answers.typical_duration_minutes === undefined || answers.typical_duration_minutes === null || answers.typical_duration_minutes === '' ? null : Number(answers.typical_duration_minutes),
    output_preference: clean(answers.output_preference),
    animation_preference: clean(answers.animation_preference),
    style_references: Array.isArray(answers.style_references) ? answers.style_references.map(clean).filter(Boolean) : clean(answers.style_references).split(',').map(clean).filter(Boolean),
    design: { theme: clean(answers.theme), tokens },
  };
  validateProfile(profile);
  return profile;
}

export function validateProfile(profile) {
  if (profile?.format !== FORMAT) throw new Error(`Profile format must be ${FORMAT}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(profile.id ?? '')) throw new Error('Invalid profile ID');
  if (!clean(profile.name)) throw new Error('Profile name is required');
  for (const key of ['role', 'discipline', 'typical_audience', 'preferred_style', 'scientific_depth', 'citation_preference', 'output_preference', 'animation_preference']) {
    if (typeof profile[key] !== 'string') throw new Error(`${key} must be a string`);
  }
  if (profile.references_slide_default !== undefined && typeof profile.references_slide_default !== 'boolean') throw new Error('References slide default must be true or false');
  if (profile.typical_duration_minutes !== null && (!Number.isFinite(profile.typical_duration_minutes) || profile.typical_duration_minutes <= 0)) throw new Error('Typical duration must be a positive number');
  if (!Array.isArray(profile.style_references) || profile.style_references.some(item => typeof item !== 'string')) throw new Error('Style references must be a list of strings');
  if (!profile.design || !['', 'light', 'dark'].includes(profile.design.theme)) throw new Error('Theme must be light, dark, or unset');
  const tokens = profile.design.tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new Error('Design tokens must be an object');
  for (const key of Object.keys(tokens)) if (!['font_heading', 'font_body', 'min_font_pt', 'colors'].includes(key)) throw new Error(`Unsupported design token: ${key}`);
  for (const key of ['font_heading', 'font_body']) if (tokens[key] !== undefined && !clean(tokens[key])) throw new Error(`${key} cannot be empty`);
  if (tokens.min_font_pt !== undefined && (!Number.isFinite(tokens.min_font_pt) || tokens.min_font_pt < 8)) throw new Error('Minimum font size must be at least 8 pt');
  for (const [key, value] of Object.entries(tokens.colors ?? {})) {
    if (!['accent', 'highlight'].includes(key) || !/^[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`Invalid color ${key}: use six hexadecimal digits`);
  }
  return true;
}

export function renderProfile(profile, tail) {
  validateProfile(profile);
  const notes = tail ?? '## Observed style cues (not confirmed)\n\nNone recorded. A reference deck can be described here without turning observations into preferences.\n\n## Notes\n\nAdd context for future talks here.\n';
  return `# Presenter profile: ${profile.name.replace(/\s+/g, ' ')}\n\nLocal, editable profile. Answers in the settings block are user-confirmed; blank fields mean no preference has been recorded. The JSON block is the source of truth for automatic design choices.\n\n## Settings\n\n${MARKER}\n\`\`\`json\n${JSON.stringify(profile, null, 2)}\n\`\`\`\n\n${notes.trimStart().trimEnd()}\n`;
}

export function parseProfile(markdown) {
  const match = markdown.match(SETTINGS);
  if (!match) throw new Error('Profile settings block is missing');
  const profile = JSON.parse(match[1]);
  validateProfile(profile);
  return { profile, tail: markdown.slice(match.index + match[0].length).trimStart() };
}

export function applyProfile(spec, profile, profileRef = `profiles/${profile.id}.local.md`) {
  validateProfile(profile);
  const existing = spec.design ?? {};
  const current = existing.tokens ?? {};
  const preferred = profile.design.tokens;
  const colors = { ...(preferred.colors ?? {}), ...(current.colors ?? {}) };
  const tokens = { ...preferred, ...current };
  if (Object.keys(colors).length) tokens.colors = colors;
  else delete tokens.colors;
  const design = { ...existing, tokens };
  if (!existing.theme && profile.design.theme) design.theme = profile.design.theme;
  const result = { ...spec, profile_ref: profileRef, design };
  const validation = validateSpec(result);
  if (validation.errors.length) throw new Error(`Profiled spec is invalid: ${validation.errors.map(item => `${item.path}: ${item.message}`).join('; ')}`);
  return result;
}

function flags(args) {
  const options = {}; const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith('--')) {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${args[index]}`);
      options[args[index].slice(2)] = args[++index];
    } else positionals.push(args[index]);
  }
  return { options, positionals };
}

async function interview(existing = {}) {
  const ui = createInterface({ input: stdin, output: stdout });
  const ask = async (label, key) => {
    const current = existing[key] ?? '';
    const response = clean(await ui.question(`${label}${current ? ` [${current}]` : ''}: `));
    return response.toLowerCase() === 'skip' ? '' : response || current;
  };
  const group = async (label, defaultYes) => {
    const response = clean(await ui.question(`${label} [${defaultYes ? 'Y/n' : 'y/N'}]: `)).toLowerCase();
    return response ? response.startsWith('y') : defaultYes;
  };
  try {
    const answers = { ...existing };
    console.log('Core profile. Press Enter to keep a shown value; type skip to clear it.');
    for (const [label, key] of [['Profile name or alias', 'name'], ['Academic role', 'role'], ['Discipline', 'discipline'], ['Typical audience', 'typical_audience']]) answers[key] = await ask(label, key);
    if (await group('Add presentation preferences now?', true)) {
      for (const [label, key] of [
        ['Preferred presentation style', 'preferred_style'],
        ['Scientific depth and detail', 'scientific_depth'], ['Citation preference', 'citation_preference'],
        ['Typical duration in minutes', 'typical_duration_minutes'], ['Output preference (PowerPoint, HTML, both)', 'output_preference'],
        ['Animation preference', 'animation_preference'], ['Style reference paths or descriptions (comma separated)', 'style_references'],
      ]) answers[key] = await ask(label, key);
      answers.references_slide_default = await group('Include a full references slide by default?', answers.references_slide_default !== false);
    }
    if (await group('Add confirmed visual choices now?', false)) {
      for (const [label, key] of [
        ['Theme (light or dark)', 'theme'], ['Heading font (Calibri fallback)', 'font_heading'],
        ['Body font (Calibri fallback)', 'font_body'], ['Accent color (six-digit hex)', 'accent'],
        ['Highlight color (six-digit hex)', 'highlight'], ['Minimum font size in points', 'min_font_pt'],
      ]) answers[key] = await ask(label, key);
    }
    return answers;
  } finally { ui.close(); }
}

function toAnswers(profile) {
  return { ...profile, ...profile.design.tokens, ...(profile.design.tokens.colors ?? {}), theme: profile.design.theme };
}

function ensurePrivateProfilePath(path) {
  const withinRepo = relative(root, path);
  if (!withinRepo.startsWith('..') && !withinRepo.startsWith('/') && !/^profiles\/[^/]+\.local\.md$/.test(withinRepo)) {
    throw new Error('Personal profiles inside the repository must use profiles/*.local.md (git-ignored)');
  }
}

function usage() {
  return `Usage:\n  node modules/onboarding/profile.mjs create [--answers local-answers.json] [--out profiles/name.local.md]\n  node modules/onboarding/profile.mjs update <profile.md> [--answers local-answers.json]\n  node modules/onboarding/profile.mjs apply <profile.md> <spec.json> --out out/profiled-spec.json\n\nPersonal profiles belong in profiles/*.local.md (ignored by Git). The apply command fills missing design tokens; explicit spec choices win.`;
}

async function cli() {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') { console.log(usage()); return; }
  const { options, positionals } = flags(process.argv.slice(3));
  if (!['create', 'update', 'apply'].includes(command)) throw new Error(usage());
  if (command === 'apply') {
    if (positionals.length !== 2 || !options.out) throw new Error(usage());
    const profilePath = resolve(positionals[0]);
    const { profile } = parseProfile(readFileSync(profilePath, 'utf8'));
    const spec = JSON.parse(readFileSync(resolve(positionals[1]), 'utf8'));
    const profileRef = relative(root, profilePath) || profilePath;
    const result = applyProfile(spec, profile, profileRef);
    const out = resolve(options.out);
    if (existsSync(out)) throw new Error(`Output exists: ${out}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`Profiled spec: ${out}`);
    return;
  }
  if (command === 'update' && positionals.length !== 1) throw new Error(usage());
  const target = command === 'update' ? resolve(positionals[0]) : null;
  const original = target ? parseProfile(readFileSync(target, 'utf8')) : null;
  const supplied = options.answers ? JSON.parse(readFileSync(resolve(options.answers), 'utf8')) : null;
  const answers = supplied ? { ...(original ? toAnswers(original.profile) : {}), ...supplied } : await interview(original ? toAnswers(original.profile) : {});
  const profile = makeProfile(answers);
  const out = target || resolve(options.out || join(root, 'profiles', `${profile.id}.local.md`));
  ensurePrivateProfilePath(out);
  if (command === 'create' && existsSync(out)) throw new Error(`Profile exists: ${out}. Use update instead.`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderProfile(profile, original?.tail));
  console.log(`Local profile: ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
