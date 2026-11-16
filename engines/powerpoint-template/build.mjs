#!/usr/bin/env node
// Academic Presenting — template-fill engine (experimental, T15, ADR-0012)
// Fills the institution's own PowerPoint template instead of rebuilding its look.
// The spec stays the contract: this wrapper validates it, prepares notes and citations exactly as the default
// engine does, and hands a plan to fill_template.py (python-pptx), which only places content.
//
// Usage:
//   node engines/powerpoint-template/build.mjs inspect <template.pptx|.potx> [--out template-map.json]
//   node engines/powerpoint-template/build.mjs <spec.json> --template <template.pptx|.potx> [--map template-map.json] [-o out/deck.pptx]

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../../scripts/validate-spec.mjs';
import { indexSpec, footerCitations, speakerNotes } from '../shared/slide-meta.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FILLER = join(HERE, 'fill_template.py');
const MAP_FORMAT = 'academic-presenting-template-map-v1';
const ROLES = ['title', 'section', 'text', 'title_only', 'text_visual', 'chart', 'table'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function python(args) {
  try {
    return execFileSync(process.env.PYTHON || 'python3', [FILLER, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    if (/No module named '?pptx/.test(detail)) throw new Error('The template engine needs python-pptx: run `python3 -m pip install python-pptx`.');
    if (error.code === 'ENOENT') throw new Error('The template engine needs Python 3 (python3 not found).');
    throw new Error(detail.split('\n').slice(-1)[0] || 'Template engine failed');
  }
}

export function inspectTemplate(templatePath) {
  if (!existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);
  return JSON.parse(python(['inspect', templatePath]));
}

export function validateMap(map) {
  if (map?.format !== MAP_FORMAT) throw new Error(`Template map format must be ${MAP_FORMAT}`);
  for (const role of ROLES) {
    const entry = map.roles?.[role];
    if (!entry || typeof entry.layout !== 'string' || !entry.layout) throw new Error(`Template map has no layout for role "${role}"`);
    if (!entry.footer) throw new Error(`Template map role "${role}" has no footer area`);
  }
  for (const role of ['title_only', 'chart', 'table']) if (!map.roles[role].content_area) throw new Error(`Template map role "${role}" has no content_area`);
  if (!map.roles.text_visual.visual_area) throw new Error('Template map role "text_visual" has no visual_area');
  if (!map.style || !map.frame) throw new Error('Template map style or frame is missing');
  return true;
}

function resolveAsset(p, specDir) {
  for (const base of [process.cwd(), specDir, REPO_ROOT]) {
    const full = resolve(base, p);
    if (existsSync(full)) return full;
  }
  return null;
}

export function describeMap(map) {
  const lines = ROLES.map((role) => `  ${role.padEnd(12)} -> "${map.roles[role].layout}"`);
  return [`Template layouts chosen (${map.slide_size_inches.width} x ${map.slide_size_inches.height} in):`, ...lines, ...(map.notes ?? []).map((n) => `  note: ${n}`)].join('\n');
}

export async function buildTemplateDeck(spec, { specDir = process.cwd(), outFile, templatePath, mapPath = null } = {}) {
  const { errors } = validateSpec(spec);
  if (errors.length) {
    const msg = errors.map((e) => `  ${e.path} ${e.message}`).join('\n');
    throw new Error(`Spec has ${errors.length} validation error(s); fix them before rendering:\n${msg}`);
  }
  if (!templatePath || !existsSync(templatePath)) throw new Error(`Template not found: ${templatePath}`);
  if (!outFile) throw new Error('The template engine needs an output file');
  if (resolve(outFile) === resolve(templatePath)) throw new Error('Refusing to overwrite the template; choose another output file');

  let map; let mapRaw;
  if (mapPath) {
    mapRaw = readFileSync(mapPath);
    map = JSON.parse(mapRaw);
  } else {
    map = inspectTemplate(templatePath);
    mapRaw = Buffer.from(`${JSON.stringify(map, null, 2)}\n`);
  }
  validateMap(map);

  const index = indexSpec(spec);
  const meta = spec.meta;
  const slides = spec.slides.map((s) => {
    const notes = speakerNotes(s, index);
    return {
      id: s.id, layout: s.layout, title: s.title, section: s.section ?? null,
      blocks: (s.blocks ?? []).map((b) => (b.type === 'figure' ? { ...b, resolved_path: resolveAsset(b.path, specDir) } : b)),
      citations: footerCitations(s, index),
      notes: notes.text,
      shows_review_claim: notes.showsReviewClaim,
      ...(s.layout === 'title' ? { presenters: meta.presenters ?? [], subtitle: meta.subtitle ?? null, occasion: meta.occasion ?? null, venue: meta.venue ?? null, date: meta.date ?? null, key_question: spec.central_question } : {}),
      ...(s.layout === 'references' ? { reference_list: spec.sources.map((x) => x.citation) } : {}),
    };
  });

  mkdirSync(dirname(outFile), { recursive: true });
  const plan = {
    spec_id: meta.id, title: meta.title, author: (meta.presenters ?? []).map((p) => p.name).join(', '), subject: spec.central_question,
    template: resolve(templatePath), template_name: basename(templatePath), map, map_sha256: sha256(mapRaw), out: resolve(outFile), slides,
  };
  const planFile = join(mkdtempSync(join(tmpdir(), 'academic-presenting-template-')), 'plan.json');
  writeFileSync(planFile, JSON.stringify(plan));
  const report = JSON.parse(python(['fill', planFile]));
  writeFileSync(outFile.replace(/\.pptx$/i, '.build-report.json'), JSON.stringify(report, null, 2));
  if (!mapPath) writeFileSync(outFile.replace(/\.pptx$/i, '.template-map.json'), mapRaw);
  return { report, map };
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const valued = new Set(['--template', '--map', '-o', '--out']);
  const positionals = args.filter((a, i) => !a.startsWith('-') && !valued.has(args[i - 1]));
  const usage = 'Usage:\n  node engines/powerpoint-template/build.mjs inspect <template.pptx|.potx> [--out template-map.json]\n  node engines/powerpoint-template/build.mjs <spec.json> --template <template.pptx|.potx> [--map template-map.json] [-o out/deck.pptx]';
  try {
    if (positionals[0] === 'inspect') {
      if (!positionals[1]) throw new Error(usage);
      const map = inspectTemplate(resolve(positionals[1]));
      const out = flag('--out');
      if (out) { mkdirSync(dirname(resolve(out)), { recursive: true }); writeFileSync(resolve(out), `${JSON.stringify(map, null, 2)}\n`); console.log(`Template map: ${resolve(out)}`); }
      console.log(describeMap(map));
      console.log(`Available layouts: ${map.layouts_available.map((l) => `"${l.name}"`).join(', ')}`);
    } else {
      const specPath = positionals[0];
      const templatePath = flag('--template');
      if (!specPath || !templatePath) throw new Error(usage);
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      const outFile = resolve(flag('-o') ?? flag('--out') ?? join('out', `${spec.meta.id}.template.pptx`));
      const { report, map } = await buildTemplateDeck(spec, { specDir: dirname(resolve(specPath)), outFile, templatePath: resolve(templatePath), mapPath: flag('--map') ? resolve(flag('--map')) : null });
      console.log(`Wrote ${outFile}`);
      console.log(describeMap(map));
      console.log(`Slides: ${report.summary.slides} (fully native: ${report.summary.fully_native}, with image content: ${report.summary.with_raster})`);
      for (const s of report.slides) for (const w of s.warnings) console.log(`WARNING ${s.id}: ${w}`);
      console.log(`Report: ${basename(outFile).replace(/\.pptx$/i, '.build-report.json')}`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
