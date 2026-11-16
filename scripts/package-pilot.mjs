#!/usr/bin/env node
// Create a small distribution ZIP from tracked, committed files only.
// Internal plans, session logs, Git history and local materials are excluded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--out');
if (index < 0 || !process.argv[index + 1]) {
  console.error('Usage: node scripts/package-pilot.mjs --out out/academic-presenting-pilot.zip');
  process.exit(2);
}
const out = resolve(process.argv[index + 1]);
if (existsSync(out)) {
  console.error(`Refusing to overwrite ${out}`);
  process.exit(2);
}
mkdirSync(dirname(out), { recursive: true });

const included = [
  '.gitignore', 'LICENSE', 'PILOT-START.md', 'SKILL.md',
  'package.json', 'package-lock.json',
  'engines', 'examples', 'modules', 'profiles', 'references', 'schemas', 'scripts',
];
execFileSync('git', ['archive', '--format=zip', '--prefix=academic-presenting/', '-o', out, 'HEAD', '--', ...included], {
  cwd: root,
  stdio: 'inherit',
});
console.log(out);
