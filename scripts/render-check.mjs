#!/usr/bin/env node
/** Render a PPTX, make a contact sheet, and report technical review findings. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runFile = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return 'Usage: node scripts/render-check.mjs deck.pptx [--out directory] [--min-font 14] [--raster-width 960]';
}

function parseArgs(args) {
  if (args.includes('--help') || args.includes('-h')) return { help: true };
  if (!args.length || args[0].startsWith('-')) throw new Error(usage());
  const result = {
    input: path.resolve(args[0]),
    out: null,
    minFont: 14,
    rasterWidth: 960,
  };
  for (let i = 1; i < args.length; i += 2) {
    const value = args[i + 1];
    if (!value) throw new Error(`Missing value for ${args[i]}\n${usage()}`);
    if (args[i] === '--out') result.out = path.resolve(value);
    else if (args[i] === '--min-font') result.minFont = Number(value);
    else if (args[i] === '--raster-width') result.rasterWidth = Number(value);
    else throw new Error(`Unknown option: ${args[i]}\n${usage()}`);
  }
  if (!Number.isFinite(result.minFont) || result.minFont <= 0) throw new Error('--min-font must be positive');
  if (!Number.isInteger(result.rasterWidth) || result.rasterWidth < 320) throw new Error('--raster-width must be an integer >= 320');
  if (!result.input.toLowerCase().endsWith('.pptx') || !existsSync(result.input)) throw new Error(`PPTX not found: ${result.input}`);
  result.out ??= path.resolve('out', 'renders', path.basename(result.input, path.extname(result.input)));
  if (existsSync(result.out)) throw new Error(`Output directory already exists: ${result.out}`);
  return result;
}

async function run(tool, args, options = {}) {
  try {
    return await runFile(tool, args, { maxBuffer: 64 * 1024 * 1024, ...options });
  } catch (error) {
    const detail = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
    throw new Error(`${path.basename(tool)} failed: ${detail}`);
  }
}

async function convertWithLibreOffice(tool, input, format, outDirectory) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'academic-presenting-lo-'));
  try {
    await run(tool, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--convert-to', format, '--outdir', outDirectory, input]);
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}

function parsePages(info) {
  const match = info.match(/^Pages:\s*(\d+)\s*$/m);
  if (!match) throw new Error('pdfinfo did not report a page count');
  return Number(match[1]);
}

function normalizeWords(value) {
  return (value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

function missingSourceWords(source, rendered) {
  const expected = new Set(normalizeWords(source).filter(word => word.length >= 2 || /\d/.test(word)));
  const actual = new Set(normalizeWords(rendered));
  return [...expected].filter(word => !actual.has(word));
}

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity.toLowerCase()] || match;
  });
}

function pdfWords(bboxXml) {
  const words = [];
  for (const item of bboxXml.matchAll(/<word\b([^>]*)>([\s\S]*?)<\/word>/g)) {
    const attrs = Object.fromEntries([...item[1].matchAll(/(xMin|yMin|xMax|yMax)="([^"]+)"/g)].map(match => [match[1], Number(match[2])]));
    if (Object.keys(attrs).length !== 4 || Object.values(attrs).some(value => !Number.isFinite(value))) continue;
    const text = decodeEntities(item[2].replace(/<[^>]+>/g, ''));
    for (const token of normalizeWords(text)) words.push({ token, box: [attrs.xMin, attrs.yMin, attrs.xMax, attrs.yMax] });
  }
  return words;
}

function renderedBoundsForShape(shape, words) {
  const tokens = normalizeWords(shape.text);
  if (!tokens.length) return null;
  const [x, y, width, height] = shape.bounds_points;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  let best = null;
  for (let start = 0; start <= words.length - tokens.length; start += 1) {
    if (!tokens.every((token, offset) => words[start + offset].token === token)) continue;
    const selected = words.slice(start, start + tokens.length);
    const box = [
      Math.min(...selected.map(word => word.box[0])),
      Math.min(...selected.map(word => word.box[1])),
      Math.max(...selected.map(word => word.box[2])),
      Math.max(...selected.map(word => word.box[3])),
    ];
    const distance = Math.abs((box[0] + box[2]) / 2 - centerX) + Math.abs((box[1] + box[3]) / 2 - centerY);
    if (!best || distance < best.distance) best = { box, distance };
  }
  return best?.box || null;
}

function pngSize(bytes) {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid PNG from pdftoppm');
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function xmlEscape(text) {
  return String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

async function contactSheet(pngPaths, outputPath, title) {
  const columns = Math.min(3, pngPaths.length);
  const tileWidth = 480;
  const gap = 24;
  const labelHeight = 27;
  const images = await Promise.all(pngPaths.map(png => readFile(png)));
  const [sourceWidth, sourceHeight] = pngSize(images[0]);
  const tileHeight = Math.round(tileWidth * sourceHeight / sourceWidth);
  const rows = Math.ceil(images.length / columns);
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = 64 + rows * (tileHeight + labelHeight + gap) + gap;
  const elements = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#f3f4f6"/>',
    `<text x="${gap}" y="39" font-family="Arial, sans-serif" font-size="23" fill="#17212b">${xmlEscape(title)}</text>`];
  images.forEach((bytes, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = gap + column * (tileWidth + gap);
    const y = 64 + gap + row * (tileHeight + labelHeight + gap);
    elements.push(`<rect x="${x - 1}" y="${y - 1}" width="${tileWidth + 2}" height="${tileHeight + 2}" fill="#ffffff" stroke="#c5cbd2"/>`);
    elements.push(`<image x="${x}" y="${y}" width="${tileWidth}" height="${tileHeight}" href="data:image/png;base64,${bytes.toString('base64')}"/>`);
    elements.push(`<text x="${x}" y="${y + tileHeight + 20}" font-family="Arial, sans-serif" font-size="16" fill="#394957">Slide ${index + 1}</text>`);
  });
  elements.push('</svg>');
  await writeFile(outputPath, elements.join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const tools = {
    soffice: process.env.SOFFICE_BIN || 'soffice',
    pdftoppm: process.env.PDFTOPPM_BIN || 'pdftoppm',
    pdfinfo: process.env.PDFINFO_BIN || 'pdfinfo',
    pdftotext: process.env.PDFTOTEXT_BIN || 'pdftotext',
    python: process.env.PYTHON_BIN || 'python3',
  };
  await mkdir(options.out, { recursive: true });
  const pdfPath = path.join(options.out, `${path.basename(options.input, path.extname(options.input))}.pdf`);
  await convertWithLibreOffice(tools.soffice, options.input, 'pdf', options.out);
  if (!existsSync(pdfPath)) throw new Error(`LibreOffice did not create the expected PDF: ${pdfPath}`);

  const { stdout: info } = await run(tools.pdfinfo, [pdfPath]);
  const pageCount = parsePages(info);
  if (pageCount < 1) throw new Error('Rendered PDF has no pages');
  const prefix = path.join(options.out, 'slide');
  await run(tools.pdftoppm, ['-png', '-scale-to', String(options.rasterWidth), pdfPath, prefix]);
  const pngNames = (await readdir(options.out)).filter(name => /^slide-\d+\.png$/.test(name));
  pngNames.sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (pngNames.length !== pageCount) throw new Error(`Expected ${pageCount} PNG pages; found ${pngNames.length}`);
  const pngPaths = pngNames.map(name => path.join(options.out, name));
  await contactSheet(pngPaths, path.join(options.out, 'contact-sheet.svg'), path.basename(options.input));
  await convertWithLibreOffice(tools.soffice, path.join(options.out, 'contact-sheet.svg'), 'png', options.out);
  if (!existsSync(path.join(options.out, 'contact-sheet.png'))) throw new Error('LibreOffice did not create the contact-sheet PNG');

  const { stdout: inspectedJson } = await run(tools.python, [path.join(scriptDir, 'render-inspect.py'), options.input, '--min-font', String(options.minFont)]);
  const inspected = JSON.parse(inspectedJson);
  const findings = [...inspected.findings];
  if (inspected.slide_count !== pageCount) {
    findings.push({ code: 'page_count_mismatch', severity: 'error', message: `PPTX has ${inspected.slide_count} slides but PDF has ${pageCount} pages.` });
  }
  for (const slide of inspected.slides) {
    const { stdout: bboxXml } = await run(tools.pdftotext, ['-f', String(slide.index), '-l', String(slide.index), '-bbox', pdfPath, '-']);
    const words = pdfWords(bboxXml);
    const renderedText = words.map(word => word.token).join(' ');
    const missing = missingSourceWords(slide.source_text, renderedText);
    const expectedCount = new Set(normalizeWords(slide.source_text)).size;
    if (missing.length && (missing.some(word => /\d/.test(word)) || missing.length >= 2 || expectedCount <= 3)) {
      findings.push({
        code: 'possible_text_loss',
        severity: 'warning',
        slide: slide.index,
        message: 'Text in the PPTX slide XML was not found in extracted PDF text. Inspect for clipping, font substitution, animation state, or extraction differences.',
        missing_words: missing.slice(0, 20),
      });
    }
    slide.matched_text_shapes = 0;
    slide.unmatched_text_shapes = 0;
    for (const shape of slide.text_shapes) {
      const rendered = renderedBoundsForShape(shape, words);
      if (!rendered) {
        slide.unmatched_text_shapes += 1;
        continue;
      }
      slide.matched_text_shapes += 1;
      const [x, y, width, height] = shape.bounds_points;
      const tolerance = 4;
      const sides = [];
      if (rendered[0] < x - tolerance) sides.push('left');
      if (rendered[1] < y - tolerance) sides.push('top');
      if (rendered[2] > x + width + tolerance) sides.push('right');
      if (rendered[3] > y + height + tolerance) sides.push('bottom');
      if (sides.length) {
        findings.push({
          code: 'text_exceeds_box',
          severity: 'warning',
          slide: slide.index,
          element: shape.element,
          message: `Rendered text extends beyond its PowerPoint text box (${sides.join(', ')}). Inspect for overflow or overlap.`,
          sides,
          text_box_points: shape.bounds_points,
          rendered_text_bounds_points: rendered.map(value => Number(value.toFixed(2))),
        });
      }
    }
  }

  const report = {
    status: findings.some(item => item.severity === 'error') ? 'technical_error' : findings.length ? 'review_needed' : 'technical_checks_passed',
    input: options.input,
    output: options.out,
    slide_count: inspected.slide_count,
    pdf_pages: pageCount,
    canvas_inches: inspected.canvas_inches,
    min_font_review_target_pt: options.minFont,
    findings,
    approved_small_type: inspected.approved_small_type,
    coverage: inspected.slides.map(({ index, shape_count, unchecked_geometry, unchecked_font_runs, nested_groups, matched_text_shapes, unmatched_text_shapes }) => ({ index, shape_count, unchecked_geometry, unchecked_font_runs, nested_groups, matched_text_shapes, unmatched_text_shapes })),
    limitations: [...inspected.limitations, 'PDF text and text-box alignment are heuristics; unmatched text boxes and non-native text are not fully assessed.', 'A successful render does not verify scientific claims or visual quality. Review the contact sheet manually.'],
    artifacts: { pdf: path.basename(pdfPath), contact_sheet: 'contact-sheet.png', contact_sheet_svg: 'contact-sheet.svg', slide_pngs: pngNames },
  };
  await writeFile(path.join(options.out, 'render-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Rendered ${pageCount} slides to ${options.out}`);
  console.log(`${findings.length} technical finding(s), ${inspected.approved_small_type.length} approved small-type exception(s); inspect contact-sheet.png and render-report.json`);
  if (report.status === 'technical_error') process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
