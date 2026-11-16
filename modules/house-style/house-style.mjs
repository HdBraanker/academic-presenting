#!/usr/bin/env node
// Bind an extracted local house style to a presentation spec and an approved storyboard.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../../scripts/validate-spec.mjs';
import { checkApproval } from '../../scripts/storyboard.mjs';

const FORMAT = 'academic-presenting-house-style-v1';
const RECEIPT_FORMAT = 'academic-presenting-house-style-preparation-v1';
const hex = value => typeof value === 'string' && /^[0-9A-Fa-f]{6}$/.test(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function validateManifest(manifest, baseDir) {
  if (manifest?.format !== FORMAT) throw new Error(`House-style manifest format must be ${FORMAT}`);
  const size = manifest.slide_size_inches;
  if (!size || Math.abs(size.width - 13.3333) > 0.02 || Math.abs(size.height - 7.5) > 0.02) {
    throw new Error('House-style master requires a 16:9, 13.333 × 7.5 inch template');
  }
  const tokens = manifest.design_tokens;
  if (!tokens || typeof tokens !== 'object' || !tokens.colors || typeof tokens.colors !== 'object') throw new Error('Manifest design tokens are missing');
  for (const [key, value] of Object.entries(tokens.colors)) if (!hex(value)) throw new Error(`Invalid template color ${key}`);
  for (const key of ['font_heading', 'font_body']) if (tokens[key] !== undefined && (typeof tokens[key] !== 'string' || !tokens[key].trim())) throw new Error(`Invalid ${key}`);
  const master = manifest.master;
  if (!master || !Array.isArray(master.bars)) throw new Error('Manifest master is missing');
  if (master.background && !hex(master.background)) throw new Error('Invalid master background color');
  for (const bar of master.bars) {
    if (!hex(bar.color) || ![bar.x, bar.y, bar.w, bar.h].every(Number.isFinite) || bar.w <= 0 || bar.h <= 0) throw new Error('Invalid fixed bar');
    if (bar.x < -0.05 || bar.y < -0.05 || bar.x + bar.w > size.width + 0.05 || bar.y + bar.h > size.height + 0.05) throw new Error('Fixed bar extends outside the slide');
  }
  if (master.logo) {
    const logo = master.logo;
    if (!logo.file || basename(logo.file) !== logo.file || !/\.(png|jpe?g)$/i.test(logo.file)) throw new Error('Invalid logo asset path');
    if (![logo.x, logo.y, logo.w, logo.h].every(Number.isFinite) || logo.w <= 0 || logo.h <= 0) throw new Error('Invalid logo bounds');
    if (logo.x < -0.05 || logo.y < -0.05 || logo.x + logo.w > size.width + 0.05 || logo.y + logo.h > size.height + 0.05) throw new Error('Logo extends outside the slide');
    if (baseDir && !existsSync(resolve(baseDir, logo.file))) throw new Error(`Logo asset missing: ${logo.file}`);
  }
  return true;
}

export function applyHouseStyle(spec, manifest) {
  validateManifest(manifest);
  const current = spec.design ?? {};
  const own = current.tokens ?? {};
  const fromTemplate = manifest.design_tokens;
  const tokens = { ...own, ...fromTemplate, colors: { ...(own.colors ?? {}), ...(fromTemplate.colors ?? {}) } };
  const result = { ...spec, design: { ...current, tokens } };
  const { errors } = validateSpec(result);
  if (errors.length) throw new Error(`Styled spec is invalid: ${errors.map(item => `${item.path}: ${item.message}`).join('; ')}`);
  return result;
}

function rebaseLocalPaths(spec, sourceSpecPath, targetSpecPath) {
  const findLocal = value => {
    if (!value || isAbsolute(value)) return value;
    const sourceDir = dirname(sourceSpecPath);
    const found = [resolve(sourceDir, value), resolve(process.cwd(), value)].find(existsSync);
    return found ? relative(dirname(targetSpecPath), found) : value;
  };
  const result = structuredClone(spec);
  if (result.intake_ref) result.intake_ref = findLocal(result.intake_ref);
  if (result.profile_ref) result.profile_ref = findLocal(result.profile_ref);
  for (const slide of result.slides ?? []) {
    for (const block of slide.blocks ?? []) if (block.type === 'figure') block.path = findLocal(block.path);
  }
  return result;
}

export function preparationReceipt(specRaw, manifestRaw, titleManifestRaw = null) {
  return {
    format: RECEIPT_FORMAT,
    spec_sha256: sha256(specRaw),
    manifest_sha256: sha256(manifestRaw),
    title_manifest_sha256: titleManifestRaw ? sha256(titleManifestRaw) : null,
  };
}

export function checkPreparation(specRaw, manifestRaw, receipt, titleManifestRaw = null) {
  const expected = preparationReceipt(specRaw, manifestRaw, titleManifestRaw);
  if (receipt?.format !== expected.format || receipt.spec_sha256 !== expected.spec_sha256 || receipt.manifest_sha256 !== expected.manifest_sha256 || receipt.title_manifest_sha256 !== expected.title_manifest_sha256) {
    throw new Error('House-style manifest or prepared spec changed; prepare the spec and obtain storyboard approval again');
  }
  return true;
}

function parseArgs(args) {
  const flags = {}; const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      flags[args[i].slice(2)] = args[++i];
    } else positionals.push(args[i]);
  }
  return { flags, positionals };
}

function usage() {
  return `Usage:\n  node modules/house-style/house-style.mjs prepare <content-manifest.json> <spec.json> --out <styled-spec.json> [--title-manifest <title-manifest.json>]\n  node modules/house-style/house-style.mjs render <content-manifest.json> <styled-spec.json> <approved-storyboard.md> --out <deck.pptx> [--title-manifest <title-manifest.json>]\n\nImport the template with extract_template.py first. Prepare before storyboard generation; the render command requires both the preparation receipt and explicit storyboard approval.`;
}

async function cli() {
  const command = process.argv[2];
  if (!command || command === '--help' || command === '-h') { console.log(usage()); return; }
  if (!['prepare', 'render'].includes(command)) throw new Error(usage());
  const { flags, positionals } = parseArgs(process.argv.slice(3));
  if (!flags.out || positionals.length !== (command === 'prepare' ? 2 : 3)) throw new Error(usage());
  const manifestPath = resolve(positionals[0]);
  const specPath = resolve(positionals[1]);
  const manifestRaw = readFileSync(manifestPath);
  const manifest = JSON.parse(manifestRaw);
  validateManifest(manifest, dirname(manifestPath));
  const titlePath = flags['title-manifest'] ? resolve(flags['title-manifest']) : null;
  const titleRaw = titlePath ? readFileSync(titlePath) : null;
  const titleManifest = titleRaw ? JSON.parse(titleRaw) : null;
  if (titleManifest) {
    validateManifest(titleManifest, dirname(titlePath));
    if (!manifest.source_sha256 || titleManifest.source_sha256 !== manifest.source_sha256) {
      throw new Error('Title and content manifests must come from the same template');
    }
  }
  const specRaw = readFileSync(specPath);
  const spec = JSON.parse(specRaw);
  const target = resolve(flags.out);

  if (command === 'prepare') {
    if (existsSync(target) || existsSync(`${target}.house-style.json`)) throw new Error(`Output exists: ${target}`);
    const styled = rebaseLocalPaths(applyHouseStyle(spec, manifest), specPath, target);
    const styledRaw = Buffer.from(`${JSON.stringify(styled, null, 2)}\n`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, styledRaw);
    writeFileSync(`${target}.house-style.json`, `${JSON.stringify(preparationReceipt(styledRaw, manifestRaw, titleRaw), null, 2)}\n`);
    console.log(`Styled spec: ${target}`);
    console.log('Generate and review its storyboard before rendering.');
    return;
  }

  const prepPath = `${specPath}.house-style.json`;
  if (!existsSync(prepPath)) throw new Error('House-style preparation receipt is missing; run prepare first');
  checkPreparation(specRaw, manifestRaw, JSON.parse(readFileSync(prepPath, 'utf8')), titleRaw);
  const storyboardPath = resolve(positionals[2]);
  const markdown = readFileSync(storyboardPath, 'utf8');
  const approvalPath = `${storyboardPath}.approval.json`;
  if (!existsSync(approvalPath)) throw new Error('Storyboard approval receipt is missing; wait for explicit user approval');
  checkApproval(sha256(specRaw), markdown, JSON.parse(readFileSync(approvalPath, 'utf8')));
  if (existsSync(target)) throw new Error(`Output exists: ${target}`);
  const { buildDeck } = await import('../../engines/powerpoint/build.mjs');
  const { report } = await buildDeck(spec, { specDir: dirname(specPath), outFile: target, houseStyle: {
    manifest, baseDir: dirname(manifestPath), titleManifest, titleBaseDir: titlePath ? dirname(titlePath) : null,
  } });
  console.log(`House-style deck: ${target} (${report.summary.slides} slides)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
