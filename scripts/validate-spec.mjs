#!/usr/bin/env node
// Validate an Academic Presenting spec: JSON Schema structure + scientific integrity rules.
// Usage: node scripts/validate-spec.mjs <spec.json> [--json]
// Exit code 1 when there are errors. Warnings never fail the run.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(here, '..', 'schemas', 'presentation.schema.json');

let compiled;
function getValidator() {
  if (!compiled) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    compiled = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf8')));
  }
  return compiled;
}

// Numbers that look like results: percentages, decimals, p-values, ratios. Years and plain counts are ignored.
const RESULT_NUMBER = /(\d+(?:[.,]\d+)?\s*%|\b\d+[.,]\d+\b|\bp\s*[<=>≤≥]\s*0?[.,]\d+)/i;
const NUMBER_TOKEN = /-?\d+(?:[.,]\d+)?/g;

function toNumbers(s) {
  return String(s ?? '').match(NUMBER_TOKEN)?.map((t) => Number(t.replace(',', '.'))) ?? [];
}

export function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });

  // 1. Structure
  const validate = getValidator();
  if (!validate(spec)) {
    for (const e of validate.errors) err(e.instancePath || '/', `${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`);
    return { errors, warnings }; // integrity rules assume valid structure
  }

  // 2. Unique ids
  const sources = new Map();
  const claims = new Map();
  const blockIds = new Set();
  const slideIds = new Set();
  spec.sources.forEach((s, i) => (sources.has(s.id) ? err(`/sources/${i}`, `duplicate source id "${s.id}"`) : sources.set(s.id, s)));
  spec.claims.forEach((c, i) => (claims.has(c.id) ? err(`/claims/${i}`, `duplicate claim id "${c.id}"`) : claims.set(c.id, c)));

  const usedClaims = new Set();
  const needClaim = (path, id) => {
    if (!id) return;
    if (!claims.has(id)) err(path, `unknown claim id "${id}"`);
    else usedClaims.add(id);
  };
  const needSource = (path, id) => {
    if (id && !sources.has(id)) err(path, `unknown source id "${id}"`);
  };

  // 3. Claims
  spec.claims.forEach((c, i) => {
    const p = `/claims/${i}`;
    const refs = c.source_refs ?? [];
    refs.forEach((r, j) => {
      needSource(`${p}/source_refs/${j}`, r.source_id);
      const src = sources.get(r.source_id);
      if (!src) return;
      if (src.verification.status === 'not-found')
        err(`${p}/source_refs/${j}`, `claim "${c.id}" cites source "${src.id}" that could not be found; remove it or mark the claim needs-expert-review without this source`);
      else if (src.verification.status === 'unverified')
        warn(`${p}/source_refs/${j}`, `source "${src.id}" is unverified; check it exists before presenting`);
      if (c.evidence_status === 'source-backed' && !r.locator)
        warn(`${p}/source_refs/${j}`, `no locator for "${src.id}" (e.g. "Table 2", "Fig. 3B"); traceability is weaker`);
    });
    if (c.evidence_status === 'source-backed' && refs.length === 0)
      err(p, `claim "${c.id}" is source-backed but has no source_refs`);
    if (c.evidence_status === 'mechanically-validated' && !(c.quantities?.length))
      warn(p, `claim "${c.id}" is mechanically-validated but has no quantities to validate`);
    if (c.evidence_status === 'needs-expert-review' && !c.review_reason && !c.review_note)
      warn(`${p}/review_reason`, `claim "${c.id}" needs expert review but the reason is not recorded`);
    if (c.relationship === 'causal') {
      const designs = refs.map((r) => sources.get(r.source_id)?.design).filter(Boolean);
      if (!designs.includes('rct')) {
        const why = designs.length ? `cited design(s): ${[...new Set(designs)].join(', ')}` : 'source design unknown';
        warn(p, `claim "${c.id}" states a causal relationship but no cited source is an RCT (${why}); check whether causal language is justified`);
      }
    }
    (c.quantities ?? []).forEach((q, k) => {
      const hasUncertainty = q.ci_low !== undefined || q.ci_high !== undefined || q.p_value !== undefined;
      if (c.kind === 'finding' && q.role !== 'arm-descriptive' && !hasUncertainty)
        warn(`${p}/quantities/${k}`, `"${q.label}" has no confidence interval or p-value; report uncertainty if the source does`);
      if (q.ci_low !== undefined && q.ci_high !== undefined && typeof q.value === 'number' && (q.value < q.ci_low || q.value > q.ci_high))
        err(`${p}/quantities/${k}`, `"${q.label}" value ${q.value} lies outside its CI [${q.ci_low}, ${q.ci_high}]`);
    });
  });

  // 4. Slides and blocks
  let totalSeconds = 0;
  let allTimed = true;
  spec.slides.forEach((s, i) => {
    const p = `/slides/${i}`;
    if (slideIds.has(s.id)) err(p, `duplicate slide id "${s.id}"`);
    slideIds.add(s.id);
    (s.claim_ids ?? []).forEach((id, j) => needClaim(`${p}/claim_ids/${j}`, id));
    if (s.timing_seconds === undefined) allTimed = false;
    else totalSeconds += s.timing_seconds;

    const slideBlockIds = new Set();
    const slideHasClaims = (s.claim_ids?.length ?? 0) > 0;

    (s.blocks ?? []).forEach((b, j) => {
      const bp = `${p}/blocks/${j}`;
      if (blockIds.has(b.id)) err(bp, `duplicate block id "${b.id}" (block ids are unique across the deck)`);
      blockIds.add(b.id);
      slideBlockIds.add(b.id);
      needClaim(bp, b.claim_id);
      needSource(bp, b.source_id);

      if (b.type === 'bullets') b.items.forEach((it, k) => needClaim(`${bp}/items/${k}`, it.claim_id));

      if (b.type === 'stat' && claims.has(b.claim_id)) {
        const c = claims.get(b.claim_id);
        const allowed = new Set();
        (c.quantities ?? []).forEach((q) => {
          [q.value, q.ci_low, q.ci_high, q.n, q.p_value].forEach((v) => toNumbers(v).forEach((n) => allowed.add(Math.abs(n))));
          if (q.ci_level !== undefined) allowed.add(Math.round(q.ci_level * 100));
        });
        // Hyphen ranges ("0.48-0.80") are read as unsigned numbers; signs are checked via absolute value.
        const shown = toNumbers(b.value).map(Math.abs);
        if (!c.quantities?.length) warn(bp, `stat "${b.value}" links to claim "${c.id}" which has no quantities; numbers cannot be checked`);
        else {
          const missing = shown.filter((n) => !allowed.has(n));
          if (missing.length) err(bp, `stat shows ${missing.join(', ')} which do not appear in claim "${c.id}" quantities`);
        }
      }

      if (b.type === 'figure') {
        if (!b.origin) warn(`${bp}/origin`, `figure "${b.id}" has no origin; set it so reuse can be checked`);
        if (b.origin === 'original-from-source') {
          const source = sources.get(b.source_id);
          if (!b.source_id) err(`${bp}/source_id`, `original figure "${b.id}" needs a source_id for reuse checking`);
          if (source) {
            const licence = source.licence?.trim();
            if (!licence || /^(?:unknown|all rights reserved)$/i.test(licence))
              err(`${bp}/source_id`, `original figure "${b.id}" has no recorded reuse permission in source "${source.id}" (licence: ${licence || 'missing'}); use a permitted figure or re-plot reported data`);
            else if (!/^CC BY(?: 4\.0)?$/i.test(licence) && !/^CC0(?: 1\.0)?$/i.test(licence) && !/^public domain$/i.test(licence))
              warn(`${bp}/source_id`, `original figure "${b.id}" uses source licence "${licence}"; confirm its conditions allow this presentation and the figure is covered`);
            else
              warn(`${bp}/source_id`, `confirm that original figure "${b.id}" is covered by source "${source.id}" licence and that credit is visible; third-party figure terms can differ`);
            if (!b.credit && !/^CC0(?: 1\.0)?$/i.test(licence ?? '') && !/^public domain$/i.test(licence ?? ''))
              err(`${bp}/credit`, `original figure "${b.id}" needs a recorded credit`);
          }
        }
        if (b.origin === 'redrawn')
          warn(bp, `figure "${b.id}" is redrawn; check that no data or scale changed versus the original`);
      }
      if (b.type === 'chart' && b.data_origin === 'digitized-from-figure')
        warn(bp, `chart "${b.id}" uses digitized values; label them as approximate on the slide`);

      // Unlinked result-like numbers in free text
      const texts = [];
      if (b.type === 'text' || b.type === 'question') texts.push(b.text);
      if (b.type === 'bullets') b.items.forEach((it) => !it.claim_id && texts.push(`${it.lead ?? ''} ${it.text}`));
      if (!b.claim_id && !slideHasClaims && texts.some((t) => RESULT_NUMBER.test(t)))
        warn(bp, `block "${b.id}" contains result-like numbers but no linked claim; link a claim so the number is traceable`);
    });

    if (!slideHasClaims && RESULT_NUMBER.test(s.title) && s.layout !== 'title')
      warn(`${p}/title`, `slide title contains a result-like number but the slide has no claim_ids`);

    (s.animation?.steps ?? []).forEach((id, j) => {
      if (!slideBlockIds.has(id)) err(`${p}/animation/steps/${j}`, `animation step "${id}" is not a block on this slide`);
    });
  });

  // 5. Deck-level checks
  spec.claims.forEach((c, i) => {
    if (!usedClaims.has(c.id)) warn(`/claims/${i}`, `claim "${c.id}" is not shown on any slide`);
  });
  if (allTimed && totalSeconds > spec.meta.duration_minutes * 60 * 1.1)
    warn('/slides', `planned timing ${Math.round(totalSeconds / 60)} min exceeds the ${spec.meta.duration_minutes}-min slot`);

  return { errors, warnings };
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  const asJson = process.argv.includes('--json');
  if (!file) {
    console.error('Usage: node scripts/validate-spec.mjs <spec.json> [--json]');
    process.exit(2);
  }
  let spec;
  try {
    spec = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  const { errors, warnings } = validateSpec(spec);
  if (asJson) console.log(JSON.stringify({ file, errors, warnings }, null, 2));
  else {
    for (const e of errors) console.log(`ERROR   ${e.path}  ${e.message}`);
    for (const w of warnings) console.log(`WARNING ${w.path}  ${w.message}`);
    console.log(`\n${file}: ${errors.length} error(s), ${warnings.length} warning(s)`);
  }
  process.exit(errors.length ? 1 : 0);
}
