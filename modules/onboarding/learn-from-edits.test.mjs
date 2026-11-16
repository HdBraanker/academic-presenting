import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildDeck } from '../../engines/powerpoint/build.mjs';
import { compareDecks, dumpDeck, renderReport, wordDiff, numbersIn, alignSlides } from './learn-from-edits.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const specPath = join(root, 'examples/research-talk/spec.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const hasPptx = spawnSync('python3', ['-c', 'import pptx']).status === 0;
const skip = hasPptx ? false : 'python-pptx is not installed';

// Simulated presenter edits on the synthetic FICTA-1 deck (no real content).
const EDIT = `
import sys
from pptx import Presentation
from pptx.util import Inches, Pt
p = Presentation(sys.argv[1])
EMU = 914400
for idx in (1, 2):                      # slides 2 and 3: move the citation footer next to the logo area
    s = p.slides[idx]
    foot = [sh for sh in s.shapes if sh.has_text_frame and sh.top / EMU > 6.0 and sh.text_frame.text.strip() and not sh.text_frame.text.strip().isdigit() and all(r.font.size is not None and r.font.size.pt <= 14 for para in sh.text_frame.paragraphs for r in para.runs if r.text.strip())]
    foot[0].left = Inches(2.0); foot[0].top = Inches(7.0)
s = p.slides[2]                         # slide 3: presenter changes a number in a caption
for sh in s.shapes:
    if sh.has_text_frame and '58%' in sh.text_frame.text:
        r = sh.text_frame.paragraphs[0].runs[0]; r.text = r.text.replace('58%', '57%')
s = p.slides[5]                         # slide 6: question text smaller
for sh in s.shapes:
    if sh.has_text_frame:
        for para in sh.text_frame.paragraphs:
            for r in para.runs:
                if r.font.size and r.font.size.pt == 32: r.font.size = Pt(28)
sldIdLst = p.slides._sldIdLst           # drop the last slide (references)
sldIdLst.remove(sldIdLst[-1])
p.save(sys.argv[2])
`;

async function decks() {
  const dir = mkdtempSync(join(tmpdir(), 'ap-t19-'));
  const gen = join(dir, 'generated.pptx'), ed = join(dir, 'edited.pptx');
  const { pptx } = await buildDeck(spec, { specDir: join(root, 'examples/research-talk') });
  await pptx.writeFile({ fileName: gen });
  execFileSync('python3', ['-c', EDIT, gen, ed]);
  return { gen, ed };
}

test('helpers: word diff, numbers, slide alignment', () => {
  assert.deepEqual(wordDiff('EUR 50,000 per project, one year', 'EUR 50,000, one year'), { removed: ['50,000', 'per', 'project,'], added: ['50,000,'] });
  assert.deepEqual(numbersIn('HR 0.62 (0,48-0.80), n = 1,240'), ['0.62', '0.48', '0.80', '1240']);
  const s = (t) => ({ title: t, shapes: [] });
  assert.deepEqual(alignSlides([s('Intro'), s('Results'), s('References')], [s('Intro'), s('Results')]), [[0, 0], [1, 1]]);
});

test('finds the simulated edits and turns them into proposals, never into preferences', { skip }, async () => {
  const { gen, ed } = await decks();
  const result = compareDecks(dumpDeck(gen), dumpDeck(ed), { spec });
  const kinds = result.lessons.map((l) => l.kind);

  const footer = result.lessons.find((l) => l.kind === 'style' && /footer/.test(l.text));
  assert.ok(footer, 'footer move found');
  assert.equal(footer.scope, 'pattern');
  assert.deepEqual(footer.slides, [2, 3]);

  const integrity = result.lessons.find((l) => l.kind === 'integrity');
  assert.ok(integrity, 'changed number flagged');
  assert.match(integrity.proposal, /58 -> 57/);
  assert.match(integrity.proposal, /re-check it against its source/);

  assert.ok(result.lessons.some((l) => l.kind === 'style' && /32 pt -> 28 pt/.test(l.text)), 'question size change found');
  const refs = result.lessons.find((l) => l.kind === 'structure');
  assert.ok(refs && /References slide optional/.test(refs.proposal));
  assert.equal(kinds[0], 'integrity', 'integrity first');

  const md = renderReport(result, { generated: gen, edited: ed, spec: specPath });
  assert.match(md, /Proposals only/);
  assert.match(md, /## Scientific integrity/);
});

test('identical decks give no lessons', { skip }, async () => {
  const { gen } = await decks();
  const d = dumpDeck(gen);
  const result = compareDecks(d, d, { spec });
  assert.equal(result.lessons.length, 0);
});

test('CLI writes a report and touches nothing else', { skip }, async () => {
  const { gen, ed } = await decks();
  const out = join(dirname(gen), 'lessons.md');
  const before = readFileSync(ed);
  execFileSync('node', [join(here, 'learn-from-edits.mjs'), gen, ed, '--spec', specPath, '-o', out], { stdio: 'pipe' });
  assert.ok(existsSync(out));
  assert.deepEqual(readFileSync(ed), before, 'edited deck unchanged');
});
