#!/usr/bin/env node
// Build a human-readable storyboard and enforce approval in the user-facing render path.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from './validate-spec.mjs';

const MARKER = 'academic-presenting-storyboard';
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function inline(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().replace(/[\\`*_\[\]<>|]/g, character => `\\${character}`);
}

function quote(value) {
  return String(value ?? '').split(/\r?\n/).map(line => `> ${inline(line)}`).join('\n');
}

function clock(seconds) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

function linkedClaims(slide) {
  const ids = [
    ...(slide.claim_ids ?? []),
    ...(slide.blocks ?? []).map(block => block.claim_id).filter(Boolean),
    ...(slide.blocks ?? []).flatMap(block => (block.items ?? []).map(item => item.claim_id)).filter(Boolean),
  ];
  return [...new Set(ids)];
}

function contentSummary(block) {
  if (block.type === 'figure') return `figure: ${inline(block.alt || block.caption || block.path || block.id)}`;
  if (block.type === 'chart') return `chart: ${inline(block.title || block.id)}`;
  if (block.type === 'table') return `table: ${inline(block.title || block.id)}`;
  if (block.type === 'stat') return `stat: ${inline(block.value || block.label || block.id)}`;
  if (block.type === 'question') return `question: ${inline(block.text)}`;
  if (block.type === 'bullets') return `structured points: ${(block.items ?? []).length}`;
  if (block.type === 'text') return `text: ${inline(block.text).slice(0, 130)}`;
  return inline(block.type || 'content');
}

function validateForStoryboard(spec) {
  const result = validateSpec(spec);
  if (result.errors.length) {
    throw new Error(`Spec validation failed:\n${result.errors.map(item => `- ${item.path}: ${item.message}`).join('\n')}`);
  }
  return result;
}

const ORIGIN_LABEL = { presenter: 'from your input', source: 'from the source', proposed: 'PROPOSED by the agent (needs your agreement)' };

// Reads the intake record's front matter (status, presenter_input). Returns null when absent.
export function readIntake(specPath, spec) {
  if (!spec.intake_ref) return null;
  const file = resolve(dirname(specPath), spec.intake_ref);
  if (!existsSync(file)) return { path: spec.intake_ref, status: 'missing-file' };
  const text = readFileSync(file, 'utf8');
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const get = (k) => fm?.[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))?.[1].trim();
  return { path: spec.intake_ref, status: get('status') ?? 'unknown', presenter_input: get('presenter_input') ?? 'unknown' };
}

export function renderStoryboard(spec, { origin = 'source', specHash, intake, templateMap = null } = {}) {
  if (!['source', 'outline'].includes(origin)) throw new Error('Origin must be source or outline');
  const validation = validateForStoryboard(spec);
  const claims = new Map(spec.claims.map(claim => [claim.id, claim]));
  const sources = new Map(spec.sources.map(source => [source.id, source]));
  const allocated = spec.slides.reduce((sum, slide) => sum + (slide.timing_seconds ?? 0), 0);
  const missingTimes = spec.slides.filter(slide => slide.timing_seconds === undefined).length;
  const slot = spec.meta.duration_minutes * 60;
  const difference = slot - allocated;
  const lines = [
    `<!-- ${MARKER} spec_sha256=${specHash || 'unspecified'} origin=${origin} -->`,
    `# Storyboard: ${inline(spec.meta.title)}`,
    '',
    `**Review state:** ${origin === 'outline' ? 'completed from supplied outline' : 'proposed from source material'}. Explicit user approval is required before rendering.`,
    `**Spec ID:** \`${inline(spec.meta.id)}\` · **Format:** ${inline(spec.meta.format)} · **Language:** ${inline(spec.meta.language)}`,
    `**Audience:** ${inline(spec.audience.description)} (${inline(spec.audience.expertise)})`,
    `**Central question:** ${inline(spec.central_question)}`,
    `**Presenter input:** ${intake === undefined ? 'not checked' : intake === null ? '**MISSING** (developer mode: no intake record)' : intake.status === 'complete' ? `intake complete (${inline(intake.presenter_input)}; \`${inline(intake.path)}\`)` : `**intake ${inline(intake.status)}** (\`${inline(intake.path)}\`)`}`,
    `**Slide origin:** ${['presenter', 'source', 'proposed'].map((o) => `${spec.slides.filter((sl) => sl.origin === o).length} ${ORIGIN_LABEL[o].split(' (')[0]}`).join(' · ')}${spec.slides.some((sl) => !sl.origin) ? ` · ${spec.slides.filter((sl) => !sl.origin).length} unmarked` : ''}`,
    `**Time:** ${clock(allocated)} allocated across ${spec.slides.length} slides versus ${clock(slot)} speaking slot${missingTimes ? `; ${missingTimes} slide(s) have no timing` : ''}${difference > 0 ? `; ${clock(difference)} unallocated` : difference < 0 ? `; ${clock(-difference)} over the slot` : ''}.`,
    '',
    '## Objectives',
    '',
    ...spec.objectives.map(objective => `- ${inline(objective)}`),
    '',
    '## Slide sequence',
  ];

  spec.slides.forEach((slide, index) => {
    lines.push('', `### ${index + 1}. ${inline(slide.title)}`, '');
    lines.push(`- **Slide ID / layout:** \`${inline(slide.id)}\` / \`${inline(slide.layout)}\`${slide.section ? ` · **Section:** ${inline(slide.section)}` : ''}`);
    lines.push(`- **Origin:** ${slide.origin ? ORIGIN_LABEL[slide.origin] : 'unmarked'}`);
    lines.push(`- **Intellectual job:** ${inline(slide.purpose)}`);
    lines.push(`- **Planned time:** ${slide.timing_seconds === undefined ? 'unassigned' : clock(slide.timing_seconds)}`);
    if (templateMap && slide.layout !== 'title' && slide.layout !== 'section') {
      const visual = (slide.blocks ?? []).find(b => ['figure', 'chart', 'table'].includes(b.type));
      const role = visual?.type === 'chart' ? 'chart' : visual?.type === 'table' ? 'table' : 'title_only';
      const entry = templateMap.roles[role];
      if (entry?.title_constraint && entry.title_box) {
        const pt = templateMap.style?.typography === 'template' ? entry.title_pt : (templateMap.style?.sizes?.title ?? 28);
        const budget = Math.max(1, Math.floor(0.85 * entry.title_box.w * 72 / (pt * 0.62)));
        if (slide.title.length > budget) {
          const floor = entry.title_constraint.min_pt ?? 20;
          const floorBudget = Math.max(1, Math.floor(0.85 * entry.title_box.w * 72 / (floor * 0.62)));
          lines.push(`- **Template title fit:** ${slide.title.length} characters; about ${budget} fit on one line at ${pt} pt. ${slide.title.length > floorBudget ? `Even ${floor} pt fits only about ${floorBudget}; revise the title before approving.` : `The renderer will shrink it toward ${floor} pt before wrapping.`}`);
        }
      }
    }
    if (slide.blocks?.length) lines.push(`- **Content plan:** ${slide.blocks.map(contentSummary).join('; ')}`);
    const ids = linkedClaims(slide);
    if (!ids.length) lines.push('- **Claims:** none linked (check whether this is intentional).');
    for (const id of ids) {
      const claim = claims.get(id);
      if (!claim) continue; // Validator reports unknown IDs before rendering.
      lines.push(`- **Claim \`${inline(id)}\` — \`${inline(claim.evidence_status)}\`${claim.origin ? ` · ${claim.origin === 'proposed' ? '**proposed**' : claim.origin}` : ''}:** ${inline(claim.text)}`);
      if (claim.source_refs?.length) {
        lines.push(`  - Sources: ${claim.source_refs.map(ref => {
          const source = sources.get(ref.source_id);
          return `${inline(source?.short_cite || ref.source_id)}${ref.locator ? ` (${inline(ref.locator)})` : ''} [${inline(source?.verification?.status || 'unknown verification')}]`;
        }).join('; ')}`);
      } else {
        lines.push('  - Sources: none linked.');
      }
      if (claim.caveats?.length) lines.push(`  - Caveats: ${claim.caveats.map(inline).join('; ')}`);
      if (claim.evidence_status === 'needs-expert-review') lines.push(`  - **Expert review needed:** ${inline(claim.review_reason || claim.review_note || 'Reason not recorded in spec.')}`);
    }
    if (slide.animation?.intent && slide.animation.intent !== 'none') lines.push(`- **Reveal intent:** ${inline(slide.animation.intent)}${slide.animation.steps?.length ? ` (${slide.animation.steps.map(inline).join(' → ')})` : ''}`);
    if (slide.notes) lines.push('- **Speaker note:**', quote(slide.notes));
  });

  lines.push('', '## Source register', '');
  for (const source of spec.sources) {
    lines.push(`- \`${inline(source.id)}\` — ${inline(source.citation)} · verification: \`${inline(source.verification.status)}\`.`);
  }
  if (validation.warnings.length) {
    lines.push('', '## Mechanical validation warnings', '', 'These warnings require review; they do not establish scientific validity.', '');
    for (const warning of validation.warnings) lines.push(`- \`${inline(warning.path)}\`: ${inline(warning.message)}`);
  }
  lines.push('', '## Approval step', '',
    'Review the sequence, claim wording, caveats, source trace, and time allocation. The create workflow waits for explicit user approval before rendering. After any spec or storyboard edit, generate and approve this version again.',
    '',
    'The evidence labels above come from the supplied spec. Generating this document does not independently verify a scientific claim.',
    '');
  return lines.join('\n');
}

function options(args) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--no-intake') { flags['no-intake'] = true; continue; }
    if (args[i].startsWith('--')) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
      flags[args[i].slice(2)] = args[++i];
    } else positionals.push(args[i]);
  }
  return { flags, positionals };
}

function loadSpec(specPath) {
  const raw = readFileSync(specPath);
  const spec = JSON.parse(raw);
  validateForStoryboard(spec);
  return { spec, raw, hash: sha256(raw) };
}

function markerHash(markdown) {
  const match = markdown.match(new RegExp(`^<!-- ${MARKER} spec_sha256=([a-f0-9]{64}) origin=(source|outline) -->`));
  return match?.[1] || null;
}

export function approvalReceipt(specHash, markdown, approvedBy) {
  if (!approvedBy?.trim()) throw new Error('Approver is required');
  if (markerHash(markdown) !== specHash) throw new Error('Storyboard was generated from a different spec; regenerate it before approval');
  return {
    format: 'academic-presenting-storyboard-approval-v1',
    spec_sha256: specHash,
    storyboard_sha256: sha256(markdown),
    approved_by: approvedBy.trim(),
    approved_at: new Date().toISOString(),
  };
}

export function checkApproval(specHash, markdown, receipt) {
  if (markerHash(markdown) !== specHash) throw new Error('Storyboard and spec differ; regenerate and obtain approval again');
  if (receipt?.format !== 'academic-presenting-storyboard-approval-v1' || receipt.spec_sha256 !== specHash || receipt.storyboard_sha256 !== sha256(markdown)) {
    throw new Error('No matching approval for this exact spec and storyboard; ask the user to review them before rendering');
  }
  return true;
}

function usage() {
  return `Usage:
  node scripts/storyboard.mjs generate <spec.json> [--origin source|outline] [--out out/storyboard.md] [--template house-style.pptx|.potx [--template-map map.json]] [--no-intake (developer only)]
  node scripts/storyboard.mjs approve <spec.json> <storyboard.md> --by <approver>
  node scripts/storyboard.mjs render <spec.json> <storyboard.md> --out out/deck.pptx [--template house-style.pptx|.potx [--template-map map.json]]

With --template the approved slides are filled into that template file (experimental template engine, needs python-pptx);
without it the default engine renders as before.

Only run approve after the user explicitly approves the displayed storyboard in conversation.`;
}

async function cli() {
  const command = process.argv[2];
  if (command === '--help' || command === '-h' || !command) { console.log(usage()); return; }
  if (!['generate', 'approve', 'render'].includes(command)) throw new Error(usage());
  const { flags, positionals } = options(process.argv.slice(3));
  if (!positionals[0]) throw new Error(usage());
  const specPath = resolve(positionals[0]);
  const { spec, hash } = loadSpec(specPath);

  if (command === 'generate') {
    const origin = flags.origin || 'source';
    const target = resolve(flags.out || join(projectRoot, 'out', `${spec.meta.id}.storyboard.md`));
    // Input-first gate (ADR-0010): no storyboard without the presenter's own input.
    const intake = readIntake(specPath, spec);
    if (!flags['no-intake'] && (!intake || intake.status !== 'complete')) {
      throw new Error(`Presenter input missing or incomplete (${intake ? `${intake.path}: ${intake.status}` : 'no intake_ref in spec'}). Collect the presenter's own notes or run the intake interview first (modules/storytelling/intake.md).`);
    }
    if (flags['template-map'] && !flags.template) throw new Error('--template-map needs --template');
    let templateMap = null;
    if (flags.template) {
      const { inspectTemplate, validateMap } = await import('../engines/powerpoint-template/build.mjs');
      templateMap = flags['template-map'] ? JSON.parse(readFileSync(resolve(flags['template-map']), 'utf8')) : inspectTemplate(resolve(flags.template));
      validateMap(templateMap);
    }
    const markdown = renderStoryboard(spec, { origin, specHash: hash, intake: flags['no-intake'] ? null : intake, templateMap });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown);
    console.log(`Storyboard: ${target}`);
    console.log(`Review state: ${origin === 'outline' ? 'completed from supplied outline' : 'proposed from source material'}; approval required before rendering.`);
    return;
  }

  if (!positionals[1]) throw new Error(usage());
  const storyboardPath = resolve(positionals[1]);
  const markdown = readFileSync(storyboardPath, 'utf8');
  const receiptPath = `${storyboardPath}.approval.json`;
  if (command === 'approve') {
    if (!flags.by) throw new Error('The approve command requires --by <approver>');
    const receipt = approvalReceipt(hash, markdown, flags.by);
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    console.log(`Approval receipt: ${receiptPath}`);
    return;
  }

  if (!existsSync(receiptPath)) throw new Error('Approval receipt is missing; show the storyboard to the user and wait for explicit approval');
  checkApproval(hash, markdown, JSON.parse(readFileSync(receiptPath, 'utf8')));
  const outFile = resolve(flags.out || join(projectRoot, 'out', `${spec.meta.id}.pptx`));
  if (flags['template-map'] && !flags.template) throw new Error('--template-map needs --template');
  if (flags.template) {
    // Template-fill engine (ADR-0012): the approved spec is unchanged, only the look comes from the template file.
    const { buildTemplateDeck, describeMap } = await import('../engines/powerpoint-template/build.mjs');
    const { report, map } = await buildTemplateDeck(spec, { specDir: dirname(specPath), outFile, templatePath: resolve(flags.template), mapPath: flags['template-map'] ? resolve(flags['template-map']) : null });
    console.log(`Approved storyboard filled into template ${basename(flags.template)}: ${outFile} (${report.summary.slides} slides)`);
    console.log(describeMap(map));
    return;
  }
  const { buildDeck } = await import('../engines/powerpoint/build.mjs');
  const { report } = await buildDeck(spec, { specDir: dirname(specPath), outFile });
  console.log(`Approved storyboard rendered to ${outFile} (${report.summary.slides} slides)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  cli().catch(error => { console.error(error.message); process.exitCode = 1; });
}
