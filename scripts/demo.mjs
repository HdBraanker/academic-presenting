#!/usr/bin/env node
// Reproducible demo of the v0.1 PowerPoint slice on the synthetic FICTA-1 example.
// Usage: npm run demo [-- --out out/demo-name]
// The approval step is performed automatically and labelled as a SYNTHETIC demo approval.
// For a real talk, the presenter must read the storyboard and approve it explicitly.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const oi = process.argv.indexOf('--out');
const out = resolve(oi > 0 ? process.argv[oi + 1] : join(root, 'out', `demo-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`));
if (existsSync(out)) { console.error(`Output directory exists: ${out}`); process.exit(2); }
mkdirSync(join(out, 'figures'), { recursive: true });
const ex = join(root, 'examples', 'research-talk');
for (const f of ['spec.json', 'intake.md', 'source.md']) copyFileSync(join(ex, f), join(out, f));
copyFileSync(join(ex, 'figures', 'study-design.png'), join(out, 'figures', 'study-design.png'));

const spec = join(out, 'spec.json');
const sb = join(out, 'storyboard.md');
const deck = join(out, 'ficta1.pptx');
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
const step = (label, args) => {
  process.stdout.write(`• ${label} … `);
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) { console.log('FAILED'); console.error(r.stdout + r.stderr); process.exit(1); }
  console.log('ok');
  return r.stdout;
};

console.log(`Academic Presenting demo (synthetic data) → ${out}\n`);
step('validate spec', ['scripts/validate-spec.mjs', spec]);
step('storyboard (input-first gate)', ['scripts/storyboard.mjs', 'generate', spec, '--origin', 'outline', '--out', sb]);
step('approve storyboard (SYNTHETIC demo approval)', ['scripts/storyboard.mjs', 'approve', spec, sb, '--by', 'demo script (synthetic example, not a real review)']);
step('render PowerPoint', ['scripts/storyboard.mjs', 'render', spec, sb, '--out', deck]);
const renderOk = (process.env.SOFFICE_BIN || has('soffice')) && has('pdftoppm') && has('pdftotext');
const qArgs = ['modules/quality-review/quality-report.mjs', spec, '--build', deck.replace(/\.pptx$/, '.build-report.json'), '-o', join(out, 'quality-report.md')];
if (renderOk) {
  step('render check (LibreOffice + Poppler)', ['scripts/render-check.mjs', deck, '--out', join(out, 'render')]);
  qArgs.push('--render', join(out, 'render', 'render-report.json'));
} else console.log('• render check … skipped (install LibreOffice and Poppler to enable)');
spawnSync(process.execPath, qArgs, { cwd: root, encoding: 'utf8' });
const q = JSON.parse(readFileSync(join(out, 'quality-report.json'), 'utf8'));
console.log(`• quality report … ${q.status} (critical ${q.counts.critical}, major ${q.counts.major}, minor ${q.counts.minor})\n`);
console.log('Open:');
console.log(`  storyboard      ${sb}`);
console.log(`  deck            ${deck}`);
if (renderOk) console.log(`  contact sheet   ${join(out, 'render', 'contact-sheet.png')}`);
console.log(`  quality report  ${join(out, 'quality-report.md')}`);
