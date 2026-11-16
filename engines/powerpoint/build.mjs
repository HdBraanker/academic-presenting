#!/usr/bin/env node
// Academic Presenting — PowerPoint engine (v0.1)
// Renders a validated presentation spec to an editable 16:9 .pptx with PptxGenJS.
// Usage: node engines/powerpoint/build.mjs <spec.json> [-o out/deck.pptx]
//
// Principles (see references/): native text, shapes, tables and charts; figures stay images and are reported as such;
// the engine never edits claim wording or numbers; animation intent goes to speaker notes (PPTX animation is not supported).

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import PptxGenJS from 'pptxgenjs';
import { validateSpec } from '../../scripts/validate-spec.mjs';
import { validateManifest } from '../../modules/house-style/house-style.mjs';
import { indexSpec, footerCitations, speakerNotes } from '../shared/slide-meta.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------- geometry (inches, LAYOUT_WIDE 13.333 x 7.5) ----------
const W = 13.333;
const H = 7.5;
const M = 0.6;
const CONTENT_TOP = 1.75;
const FOOTER_Y = 6.95;
const CONTENT_BOTTOM = 6.7;
const CW = W - 2 * M;

const SIZES = { title: 28, titleSlide: 38, body: 22, small: 18, stat: 72, statSub: 24, question: 32, table: 18, kicker: 13, footer: 12 };

const DEFAULT_COLORS = {
  light: { background: 'FFFFFF', ink: '1B1F23', muted: '646E78', accent: '1F3A5F', highlight: 'B03A2E', surface: 'F3F4F6', rule: 'C8CDD2' },
  dark: { background: '111418', ink: 'F2F2F2', muted: 'A9B3BA', accent: '6CA8E8', highlight: 'F08A7E', surface: '1F2A33', rule: '3A4650' },
};

// ---------- helpers ----------
const hex = (c) => String(c).replace('#', '').toUpperCase();

function contrastText(background) {
  const rgb = [0, 2, 4].map(i => parseInt(background.slice(i, i + 2), 16) / 255);
  const luminance = rgb.reduce((sum, channel, i) => sum + [0.2126, 0.7152, 0.0722][i] * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4), 0);
  return luminance > 0.179 ? '000000' : 'FFFFFF';
}

function tokensFrom(spec) {
  const theme = spec.design?.theme ?? 'light';
  const t = spec.design?.tokens ?? {};
  const colors = { ...DEFAULT_COLORS[theme], ...Object.fromEntries(Object.entries(t.colors ?? {}).map(([k, v]) => [k, hex(v)])) };
  if (theme === 'dark') { colors.background = DEFAULT_COLORS.dark.background; }
  return {
    theme,
    colors,
    fontHeading: t.font_heading ?? 'Calibri',
    fontBody: t.font_body ?? 'Calibri',
    minPt: t.min_font_pt ?? 14,
  };
}

// Rough text-fit estimate (Calibri-like average glyph width ~0.5 em). Real check happens on the render (T5).
function estimateHeight(text, pt, widthIn, lineSpacing = 1.2) {
  const charW = (0.47 * pt) / 72;
  const perLine = Math.max(1, Math.floor((widthIn - 0.2) / charW));
  const lines = String(text).split('\n').reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
  return (lines * pt * lineSpacing) / 72 + 0.15;
}

function imageSize(path) {
  const b = readFileSync(path);
  if (b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return null;
}

function resolveAsset(p, specDir) {
  for (const base of [process.cwd(), specDir, REPO_ROOT]) {
    const full = resolve(base, p);
    if (existsSync(full)) return full;
  }
  return null;
}

// ---------- engine ----------
export async function buildDeck(spec, { specDir = process.cwd(), outFile, houseStyle = null } = {}) {
  const { errors } = validateSpec(spec);
  if (errors.length) {
    const msg = errors.map((e) => `  ${e.path} ${e.message}`).join('\n');
    throw new Error(`Spec has ${errors.length} validation error(s); fix them before rendering:\n${msg}`);
  }

  const tk = tokensFrom(spec);
  const C = tk.colors;
  const index = indexSpec(spec);
  const report = { spec_id: spec.meta.id, engine: 'powerpoint', engine_version: '0.1.0', slides: [], limitations: [] };

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = spec.meta.title;
  pptx.author = (spec.meta.presenters ?? []).map((p) => p.name).join(', ');
  pptx.subject = spec.central_question;

  const house = houseStyle?.manifest;
  const titleHouse = houseStyle?.titleManifest ?? house;
  const defineHouseMaster = (manifest, baseDir, name) => {
    validateManifest(manifest, baseDir);
    const objects = manifest.master.bars.map(bar => ({ rect: {
      x: bar.x, y: bar.y, w: bar.w, h: bar.h,
      fill: { color: bar.color }, line: { color: bar.color, transparency: 100 },
    } }));
    if (manifest.master.logo) {
      const logo = manifest.master.logo;
      objects.push({ image: { path: resolve(baseDir, logo.file), x: logo.x, y: logo.y, w: logo.w, h: logo.h } });
    }
    pptx.defineSlideMaster({ title: name, background: { color: manifest.master.background || C.background }, objects });
    return {
      layout_part: manifest.layout_part,
      fixed_bars: manifest.master.bars.length,
      logo: Boolean(manifest.master.logo),
      import_warnings: manifest.warnings ?? [],
    };
  };
  if (house) {
    if (titleHouse !== house && (!house.source_sha256 || titleHouse.source_sha256 !== house.source_sha256)) {
      throw new Error('Title and content manifests must come from the same template');
    }
    const content = defineHouseMaster(house, houseStyle.baseDir, 'AP_HOUSE_CONTENT');
    const title = titleHouse === house ? content : defineHouseMaster(titleHouse, houseStyle.titleBaseDir, 'AP_HOUSE_TITLE');
    report.house_style = { source_sha256: house.source_sha256, content, title };
    for (const warning of new Set([...(content.import_warnings ?? []), ...(title.import_warnings ?? [])])) {
      report.limitations.push(`House-style import: ${warning}`);
    }
  }

  const total = spec.slides.length;

  spec.slides.forEach((s, idx) => {
    const masterName = s.layout === 'title' && titleHouse !== house ? 'AP_HOUSE_TITLE' : 'AP_HOUSE_CONTENT';
    const slide = house ? pptx.addSlide({ masterName }) : pptx.addSlide();
    if (!house) slide.background = { color: C.background };
    const titleInk = house && s.layout === 'title' ? contrastText(titleHouse.master.background || C.background) : C.ink;
    const rep = { id: s.id, layout: s.layout, editable: 'native', raster_elements: [], warnings: [] };
    // Advisory only: the render check (scripts/render-check.mjs) is authoritative. Report only large estimated overruns.
    const warnFit = (what, text, pt, w, h) => {
      const need = estimateHeight(text, pt, w);
      if (need > h * 1.25) rep.warnings.push(`likely overflow in ${what}: needs ~${need.toFixed(2)} in, box ${h.toFixed(2)} in (confirm with render check)`);
    };
    const pt = (n) => Math.max(n, tk.minPt);

    // --- title ---
    const addTitle = () => {
      const size = pt(SIZES.title);
      if (s.section) slide.addText(s.section.toUpperCase(), { x: M, y: 0.32, w: CW, h: 0.3, fontFace: tk.fontBody, fontSize: SIZES.kicker, bold: true, color: C.accent, charSpacing: 2, valign: 'top', margin: 0 });
      slide.addText(s.title, { x: M, y: 0.62, w: CW - 1.0, h: 1.0, fontFace: tk.fontHeading, fontSize: size, bold: true, color: C.ink, valign: 'top', margin: 0, fit: 'none' });
      warnFit('title', s.title, size, CW - 1.0, 1.0);
    };

    // --- text-like blocks stacked in a column ---
    const stackText = (blocks, x, y, w, maxH, opt = {}) => {
      let cy = y;
      const align = opt.align ?? 'left';
      const gap = opt.gap ?? 0.25;
      const bulletSpace = opt.bulletSpacePt ?? 14;
      for (const b of blocks) {
        let runs; let size; let h;
        if (b.type === 'bullets') {
          size = pt(opt.bulletPt ?? SIZES.body);
          runs = b.items.flatMap((it, i) => [
            ...(it.lead ? [{ text: `${it.lead}  `, options: { bold: true, color: C.accent } }] : []),
            { text: it.text, options: { color: C.ink, breakLine: i < b.items.length - 1 } },
          ]);
          const plain = b.items.map((it) => `${it.lead ?? ''}  ${it.text}`).join('\n');
          h = Math.min(estimateHeight(plain, size, w, 1.25) + (bulletSpace / 72) * b.items.length, maxH - (cy - y));
          slide.addText(runs, { x, y: cy, w, h, fontFace: tk.fontBody, fontSize: size, align, valign: 'top', margin: 0.05, paraSpaceAfter: bulletSpace, lineSpacingMultiple: 1.1 });
          warnFit(`block ${b.id}`, plain, size, w, h);
        } else {
          const role = b.type === 'question' ? 'question' : b.role ?? 'body';
          size = pt(role === 'caption' ? (opt.captionPt ?? SIZES.small) : role === 'question' ? 28 : SIZES.body);
          const color = role === 'caption' ? C.muted : role === 'question' ? C.accent : C.ink;
          h = Math.min(estimateHeight(b.text, size, w), maxH - (cy - y));
          if (role === 'callout') {
            slide.addShape(pptx.ShapeType.line, { x, y: cy, w: Math.min(w, 2.0), h: 0, line: { color: C.ink, width: 0.75 } });
            slide.addText(b.text, { x, y: cy + 0.12, w, h, fontFace: tk.fontBody, fontSize: size, color: C.ink, align, valign: 'top', margin: 0 });
            warnFit(`block ${b.id}`, b.text, size, w, h);
            h += 0.12;
          } else {
            slide.addText(b.text, { x, y: cy, w, h, fontFace: tk.fontBody, fontSize: size, color, bold: role === 'question', align, valign: 'top', margin: 0.05 });
            warnFit(`block ${b.id}`, b.text, size, w, h);
          }
        }
        cy += h + gap;
      }
      if (cy - y - gap > maxH * 1.25) rep.warnings.push(`text column taller than available space (${(cy - y - gap).toFixed(2)} > ${maxH.toFixed(2)} in)`);
      return Math.max(0, cy - y - gap);
    };
    const measureText = (blocks, w, opt = {}) => blocks.reduce((sum, b) => {
      const gap = opt.gap ?? 0.25;
      if (b.type === 'bullets') return sum + estimateHeight(b.items.map((it) => `${it.lead ?? ''}  ${it.text}`).join('\n'), pt(opt.bulletPt ?? SIZES.body), w, 1.25) + ((opt.bulletSpacePt ?? 14) / 72) * b.items.length + gap;
      const role = b.type === 'question' ? 'question' : b.role ?? 'body';
      const size = pt(role === 'caption' ? (opt.captionPt ?? SIZES.small) : role === 'question' ? 28 : SIZES.body);
      return sum + estimateHeight(b.text, size, w) + (role === 'callout' ? 0.12 : 0) + gap;
    }, 0) - (opt.gap ?? 0.25);

    // --- visuals ---
    const addFigure = (b, x, y, w, h) => {
      const file = resolveAsset(b.path, specDir);
      if (!file) {
        rep.warnings.push(`figure ${b.id}: file not found (${b.path}); placeholder drawn`);
        slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: C.surface }, line: { color: C.highlight, width: 1, dashType: 'dash' } });
        slide.addText(`Missing figure: ${b.path}`, { x, y, w, h, align: 'center', valign: 'middle', fontSize: pt(16), color: C.highlight, fontFace: tk.fontBody });
        return;
      }
      const dim = imageSize(file);
      const captionH = b.caption ? 0.45 : 0;
      const imageH = h - captionH;
      let fw = w; let fh = imageH;
      if (dim) { const r = dim.w / dim.h; if (w / imageH > r) { fw = imageH * r; } else { fh = w / r; } }
      slide.addImage({ path: file, x: x + (w - fw) / 2, y: y + (imageH - fh) / 2, w: fw, h: fh, altText: b.alt });
      rep.raster_elements.push({ block: b.id, path: b.path, origin: b.origin ?? 'unspecified' });
      rep.editable = 'partial';
      if (b.caption) slide.addText(b.caption, { x, y: y + imageH + 0.05, w, h: 0.4, fontSize: pt(SIZES.small), color: C.muted, fontFace: tk.fontBody });
      return { height: h, imageHeight: fh };
    };

    const addChart = (b, x, y, w, h) => {
      const type = { bar: pptx.ChartType.bar, line: pptx.ChartType.line, scatter: pptx.ChartType.scatter }[b.chart_type];
      if (!type) {
        rep.warnings.push(`chart ${b.id}: chart_type "${b.chart_type}" not supported by the PowerPoint engine yet; drawn as table`);
        return addTable({ id: b.id, columns: ['Series', ...(b.categories ?? [])], rows: b.series.map((s2) => [s2.name, ...s2.values]) }, x, y, w);
      }
      const data = b.series.map((s2) => ({ name: s2.name, labels: b.categories ?? s2.values.map((_, i) => String(i + 1)), values: s2.values }));
      const axisPt = pt(16);
      const colors = [C.accent, C.muted, C.highlight, C.ink];
      const vmax = Math.max(...b.series.flatMap((s2) => s2.values.filter((v) => v !== null)));
      const step = vmax <= 10 ? 2 : vmax <= 50 ? 10 : vmax <= 100 ? 20 : 10 ** Math.floor(Math.log10(vmax));
      const top = Math.ceil((vmax * 1.05) / step) * step;
      const direct = type === pptx.ChartType.line && b.series.length <= 4;
      const labelW = direct ? 1.8 : 0;
      const plot = { x: 0.1, y: 0.04, w: 0.86, h: 0.8 };
      slide.addChart(type, data, {
        x, y, w: w - labelW, h,
        chartColors: colors,
        lineSize: 3, lineDataSymbol: 'circle', lineDataSymbolSize: 7,
        showLegend: !direct, legendPos: 'b', legendFontSize: axisPt, legendColor: C.ink, legendFontFace: tk.fontBody,
        layout: plot,
        catAxisTitle: b.x_label, showCatAxisTitle: Boolean(b.x_label), valAxisTitle: b.y_label, showValAxisTitle: Boolean(b.y_label),
        catAxisTitleFontSize: axisPt, valAxisTitleFontSize: axisPt, catAxisLabelFontSize: axisPt, valAxisLabelFontSize: axisPt,
        catAxisLabelColor: C.muted, valAxisLabelColor: C.muted, catAxisTitleColor: C.muted, valAxisTitleColor: C.muted,
        catAxisLabelFontFace: tk.fontBody, valAxisLabelFontFace: tk.fontBody,
        catAxisLineColor: C.ink, valAxisLineShow: false,
        valAxisMinVal: 0, valAxisMaxVal: top, valAxisMajorUnit: step,
        valGridLine: { color: 'E3E6E9', size: 0.5 }, catGridLine: { style: 'none' },
        showTitle: false,
      });
      if (direct) {
        // Direct labels at the last data point (references/slide-design-principles.md). Positions assume the fixed plot layout above.
        const ch = w - labelW;
        const n = (b.categories ?? b.series[0].values).length;
        const labels = b.series.map((s2, i) => {
          const lastIdx = s2.values.map((v) => v !== null).lastIndexOf(true);
          const v = s2.values[lastIdx];
          const yy = y + h * (plot.y + plot.h * (1 - v / top));
          return { i, name: s2.name, v, yy };
        }).sort((a, b2) => a.yy - b2.yy);
        for (let k = 1; k < labels.length; k++) if (labels[k].yy - labels[k - 1].yy < 0.38) labels[k].yy = labels[k - 1].yy + 0.38;
        const lx = x + ch * (plot.x + plot.w * (1 - 0.5 / n)) + 0.15;
        for (const L of labels) {
          slide.addText(L.name, { x: lx, y: L.yy - 0.2, w: labelW + 0.2, h: 0.4, fontFace: tk.fontBody, fontSize: pt(18), bold: true, color: colors[L.i % colors.length], valign: 'middle', margin: 0 });
        }
        rep.warnings.push(`chart ${b.id}: direct labels are positioned geometrically; confirm alignment on the render`);
      }
      if (b.data_origin === 'digitized-from-figure') rep.warnings.push(`chart ${b.id}: digitized values; label as approximate`);
    };

    const addTable = (b, x, y, w) => {
      const size = pt(20);
      const none = { type: 'none' };
      const hair = (c, ptw) => ({ type: 'solid', pt: ptw, color: c });
      const last = b.rows.length - 1;
      const header = b.columns.map((c, j) => ({ text: String(c), options: { bold: true, color: C.ink, align: j === 0 ? 'left' : 'right', border: [hair(C.ink, 1.25), none, hair(C.ink, 0.75), none] } }));
      const body = b.rows.map((r, i) => r.map((cell, j) => ({ text: cell === null ? '' : String(cell), options: { color: C.ink, align: j === 0 ? 'left' : 'right', border: [none, none, i === last ? hair(C.ink, 1.25) : hair(C.rule, 0.5), none] } })));
      const rowH = 0.72;
      slide.addTable([header, ...body], { x, y, w, fontFace: tk.fontBody, fontSize: size, rowH, valign: 'middle', margin: [0.06, 0.12, 0.06, 0.12] });
      const tableH = rowH * (b.rows.length + 1);
      if (y + tableH > CONTENT_BOTTOM) rep.warnings.push(`table ${b.id}: ~${tableH.toFixed(2)} in tall, may run into footer`);
      return tableH;
    };

    const addVisual = (b, x, y, w, h) => {
      if (b.type === 'figure') return addFigure(b, x, y, w, h);
      if (b.type === 'chart') return addChart(b, x, y, w, h);
      if (b.type === 'table') return addTable(b, x, y, w);
    };

    const blocks = s.blocks ?? [];
    const visuals = blocks.filter((b) => ['figure', 'chart', 'table'].includes(b.type));
    const texts = blocks.filter((b) => ['text', 'bullets', 'question'].includes(b.type));
    const stats = blocks.filter((b) => b.type === 'stat');

    // --- layouts ---
    switch (s.layout) {
      case 'title': {
        const size = pt(SIZES.titleSlide);
        slide.addText(s.title, { x: M, y: 1.7, w: 10.6, h: 2.3, fontFace: tk.fontHeading, fontSize: size, bold: true, color: titleInk, valign: 'bottom', margin: 0 });
        warnFit('title', s.title, size, 10.6, 2.3);
        slide.addShape(pptx.ShapeType.line, { x: M, y: 4.25, w: CW, h: 0, line: { color: titleInk, width: 0.75 } });
        const kicker = texts.map((b) => b.text ?? '').filter(Boolean).join('\n');
        if (kicker) slide.addText(kicker, { x: M, y: 4.45, w: 10.6, h: 0.8, fontFace: tk.fontBody, fontSize: pt(22), color: house ? titleInk : C.muted, valign: 'top', margin: 0 });
        const who = (spec.meta.presenters ?? []).map((p) => [p.name, p.affiliation].filter(Boolean).join(', ')).join('\n');
        const where = [spec.meta.occasion, spec.meta.venue, spec.meta.date].filter(Boolean).join('  ·  ');
        const foot = [who, where].filter(Boolean).join('\n');
        if (foot) slide.addText(foot, { x: M, y: 5.5, w: 11.2, h: 1.0, fontFace: tk.fontBody, fontSize: pt(18), color: titleInk, valign: 'top', margin: 0 });
        break;
      }
      case 'section': {
        slide.addText(s.title, { x: M, y: 2.8, w: CW, h: 1.6, fontFace: tk.fontHeading, fontSize: pt(40), bold: true, color: C.accent, valign: 'middle', margin: 0 });
        break;
      }
      case 'claim-figure': {
        addTitle();
        const h = CONTENT_BOTTOM - CONTENT_TOP;
        const v0 = visuals[0];
        const vFile = v0?.type === 'figure' ? resolveAsset(v0.path, specDir) : null;
        const vDim = vFile ? imageSize(vFile) : null;
        const wide = vDim && vDim.w / vDim.h > 1.9;
        if (visuals.length && texts.length && wide) {
          const gap = 0.18;
          const minImageH = h * 0.6;
          const figureCaptionH = v0.caption ? 0.45 : 0;
          const textMax = h - minImageH - figureCaptionH - gap;
          let captionPt = SIZES.small;
          const textOptions = () => ({ captionPt, gap: 0.1 });
          while (captionPt > 14 && measureText(texts, CW, textOptions()) > textMax) captionPt -= 1;
          const tH = measureText(texts, CW, textOptions());
          if (tH > textMax || CW / (vDim.w / vDim.h) < minImageH) {
            throw new Error(`Claim-figure slide ${s.id} cannot fit its captions while keeping the figure at least 60% of the content height; split it in the spec and obtain storyboard approval again`);
          }
          const vH = h - tH - gap;
          const placed = addVisual(v0, M, CONTENT_TOP, CW, vH);
          stackText(texts, M, CONTENT_TOP + vH + gap, CW, tH, textOptions());
          rep.figure_height_fraction = placed.imageHeight / h;
        } else if (visuals.length && texts.length) {
          const vw = 8.4;
          addVisual(visuals[0], M, CONTENT_TOP, vw, h);
          stackText(texts, M + vw + 0.4, CONTENT_TOP + 0.2, CW - vw - 0.4, h - 0.2);
        } else if (visuals.length) {
          addVisual(visuals[0], M, CONTENT_TOP, CW, h);
        } else {
          stackText(texts, M, CONTENT_TOP, CW, h);
        }
        if (visuals.length > 1) rep.warnings.push(`${visuals.length} visuals on a claim-figure slide; only the first is placed (split the slide or use a multi-panel figure)`);
        break;
      }
      case 'stat-card': {
        addTitle();
        if (!stats.length) {
          stackText(texts, M, CONTENT_TOP, CW, CONTENT_BOTTOM - CONTENT_TOP);
          break;
        }
        const h = CONTENT_BOTTOM - CONTENT_TOP;
        const panelW = stats.length > 1 ? CW : 7.6;
        const textW = panelW - 0.4;
        const gap = 0.15;
        const minStatH = stats.some((b) => b.value.includes(' (')) ? 2.05 : 1.8;
        let bulletPt = SIZES.body;
        const textOptions = () => ({ bulletPt, bulletSpacePt: 6, gap: 0.1 });
        while (texts.length && bulletPt > 16 && measureText(texts, textW, textOptions()) > h - minStatH - gap) bulletPt -= 1;
        const textH = texts.length ? measureText(texts, textW, textOptions()) : 0;
        if (textH > h - minStatH - gap) throw new Error(`Stat-card slide ${s.id} cannot fit the stat and text in the available height; split it in the spec and obtain storyboard approval again`);
        const statH = Math.min(3.5, h - (texts.length ? textH + gap : 0));
        const py = CONTENT_TOP + Math.min(0.18, statH * 0.06);
        const ruleY = CONTENT_TOP + statH - 0.62;
        const n = Math.max(1, stats.length);
        stats.forEach((b, i) => {
          const cw = panelW / n;
          const cx = M + i * cw;
          const cut = b.value.indexOf(' (');
          const main = cut > 0 ? b.value.slice(0, cut) : b.value;
          const sub = cut > 0 ? b.value.slice(cut + 1) : '';
          const mainH = Math.min(1.5, Math.max(0.75, ruleY - py - (sub ? 0.43 : 0.1)));
          const big = pt(Math.min(b.emphasis === 'secondary' ? 48 : SIZES.stat, Math.floor(mainH * 72 / 1.15)));
          slide.addText(main, { x: cx, y: py, w: cw - 0.4, h: mainH, fontFace: tk.fontHeading, fontSize: big, bold: true, color: b.emphasis === 'secondary' ? C.accent : C.highlight, align: 'left', valign: 'top', margin: 0 });
          warnFit(`stat ${b.id}`, main, big, cw - 0.4, mainH);
          if (sub) slide.addText(sub, { x: cx, y: py + mainH + 0.04, w: cw - 0.4, h: 0.34, fontFace: tk.fontBody, fontSize: pt(Math.min(SIZES.statSub, 20)), color: C.ink, align: 'left', valign: 'top', margin: 0 });
          slide.addShape(pptx.ShapeType.line, { x: cx, y: ruleY, w: Math.min(cw - 0.4, 5.5), h: 0, line: { color: C.rule, width: 0.75 } });
          const labelY = ruleY + 0.1;
          const labelH = CONTENT_TOP + statH - labelY - 0.04;
          slide.addText(b.label, { x: cx, y: labelY, w: cw - 0.4, h: labelH, fontFace: tk.fontBody, fontSize: pt(20), color: C.muted, align: 'left', valign: 'top', margin: 0 });
          warnFit(`stat label ${b.id}`, b.label, pt(20), cw - 0.4, labelH);
        });
        if (texts.length) stackText(texts, M, CONTENT_TOP + statH + gap, textW, h - statH - gap, textOptions());
        rep.stat_region_height = statH;
        break;
      }
      case 'comparison': {
        addTitle();
        if (visuals.length) {
          const avail = CONTENT_BOTTOM - CONTENT_TOP;
          const est = visuals[0].type === 'table' ? 0.75 * (visuals[0].rows.length + 1) : avail;
          const ty = CONTENT_TOP + Math.max(0.2, (avail - est - (texts.length ? measureText(texts, CW) + 0.3 : 0)) / 2);
          const th = addVisual(visuals[0], M, ty, CW, avail - (ty - CONTENT_TOP)) ?? 0;
          if (texts.length) stackText(texts, M, ty + th + 0.3, CW, CONTENT_BOTTOM - (ty + th + 0.3));
        } else {
          const half = (CW - 0.5) / 2;
          const mid = Math.ceil(texts.length / 2);
          stackText(texts.slice(0, mid), M, CONTENT_TOP, half, CONTENT_BOTTOM - CONTENT_TOP);
          stackText(texts.slice(mid), M + half + 0.5, CONTENT_TOP, half, CONTENT_BOTTOM - CONTENT_TOP);
        }
        break;
      }
      case 'question': {
        addTitle();
        const q = texts.filter((b) => b.type === 'question');
        const rest = texts.filter((b) => b.type !== 'question');
        q.forEach((b, i) => {
          const size = pt(SIZES.question);
          slide.addText(b.text, { x: M, y: 2.4 + i * 1.6, w: CW - 2.0, h: 1.5, fontFace: tk.fontHeading, fontSize: size, bold: false, color: C.accent, align: 'left', valign: 'middle', margin: 0 });
          warnFit(`question ${b.id}`, b.text, size, CW - 2.0, 1.5);
        });
        if (rest.length) stackText(rest, M, 2.4 + q.length * 1.6 + 0.3, CW - 2.0, CONTENT_BOTTOM - (2.4 + q.length * 1.6 + 0.3));
        break;
      }
      case 'take-home': {
        addTitle();
        const items = texts.flatMap((b) => (b.type === 'bullets' ? b.items : [{ text: b.text }]));
        const rowH = Math.min(1.25, (CONTENT_BOTTOM - CONTENT_TOP - 0.2) / Math.max(1, items.length));
        const size = pt(26);
        items.forEach((it, i) => {
          const ry = CONTENT_TOP + 0.2 + i * rowH;
          slide.addShape(pptx.ShapeType.line, { x: M, y: ry, w: CW, h: 0, line: { color: i === 0 ? C.ink : C.rule, width: i === 0 ? 1 : 0.5 } });
          if (it.lead) slide.addText(it.lead, { x: M, y: ry + 0.12, w: 3.0, h: rowH - 0.2, fontFace: tk.fontHeading, fontSize: pt(20), bold: true, color: C.accent, valign: 'top', margin: 0 });
          slide.addText(it.text, { x: M + (it.lead ? 3.2 : 0), y: ry + 0.08, w: CW - (it.lead ? 3.2 : 0), h: rowH - 0.15, fontFace: tk.fontBody, fontSize: size, color: C.ink, valign: 'top', margin: 0 });
          warnFit(`take-home item ${i + 1}`, it.text, size, CW - (it.lead ? 3.2 : 0), rowH - 0.15);
        });
        break;
      }
      case 'references': {
        addTitle();
        const refs = texts.length ? texts.map((b) => b.text?.trim()).filter(Boolean) : spec.sources.map((x) => x.citation.trim());
        const content = refs.join('\n\n');
        const height = CONTENT_BOTTOM - CONTENT_TOP;
        const fits = (size) => {
          const charWidth = 0.55 * size / 72;
          const charsPerLine = Math.max(1, Math.floor((CW - 0.3) / charWidth));
          const lines = refs.reduce((n, ref) => n + ref.split('\n').reduce((m, para) => m + Math.max(1, Math.ceil(para.length / charsPerLine)), 0), 0);
          return (lines * size * 1.25 + Math.max(0, refs.length - 1) * size * 0.55) / 72 + 0.2 <= height;
        };
        let size = SIZES.small;
        while (size > 14 && !fits(size)) size -= 1;
        if (!fits(size)) throw new Error(`References slide ${s.id} cannot fit at 14 pt; split it in the spec and obtain storyboard approval again`);
        slide.addText(content, { x: M, y: CONTENT_TOP, w: CW, h: height, fontFace: tk.fontBody, fontSize: size, color: C.ink, valign: 'top', margin: 0.03, breakLine: false, fit: 'shrink' });
        rep.references_font_pt = size;
        break;
      }
      default: { // text and anything else
        addTitle();
        if (visuals.length) rep.warnings.push(`layout "${s.layout}" ignores visual blocks; use claim-figure`);
        stackText(texts, M, CONTENT_TOP, CW, CONTENT_BOTTOM - CONTENT_TOP);
      }
    }

    // --- footer: citations + slide number ---
    const cites = footerCitations(s, index);
    if (cites.length) {
      const ftxt = cites.join('; ');
      slide.addText(ftxt, { x: M, y: FOOTER_Y, w: CW - 1.0, h: 0.4, fontFace: tk.fontBody, fontSize: SIZES.footer, color: house && s.layout === 'title' ? titleInk : C.muted, valign: 'middle', margin: 0 });
      warnFit('citation footer', ftxt, SIZES.footer, CW - 1.0, 0.4);
    }
    if (s.layout !== 'title') {
      slide.addText(`${idx + 1}`, { x: W - M - 0.9, y: FOOTER_Y, w: 0.9, h: 0.4, fontFace: tk.fontBody, fontSize: SIZES.footer, color: C.muted, align: 'right', valign: 'middle', margin: 0 });
    }

    // --- speaker notes: presenter notes + evidence trail + reveal order (shared with the template engine) ---
    const notes = speakerNotes(s, index);
    if (notes.showsReviewClaim) rep.warnings.push('shows a needs-expert-review claim (flagged in speaker notes)');
    if (notes.text) slide.addNotes(notes.text);

    report.slides.push(rep);
  });

  report.limitations.push(
    'Animation intent is written to speaker notes; this engine does not create PowerPoint animations.',
    'Text fit is estimated geometrically; confirm with the rendered check (T5).',
    'Figures are placed as images and are not editable; their origin is listed per slide.',
  );
  report.summary = {
    slides: total,
    fully_native: report.slides.filter((x) => x.editable === 'native').length,
    with_raster: report.slides.filter((x) => x.editable === 'partial').length,
    warnings: report.slides.reduce((n, x) => n + x.warnings.length, 0),
  };

  if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    await pptx.writeFile({ fileName: outFile });
    writeFileSync(outFile.replace(/\.pptx$/i, '.build-report.json'), JSON.stringify(report, null, 2));
  }
  return { pptx, report };
}

// ---------- CLI ----------
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const specPath = args.find((a) => !a.startsWith('-'));
  const oi = args.indexOf('-o');
  if (!specPath) { console.error('Usage: node engines/powerpoint/build.mjs <spec.json> [-o out/deck.pptx]'); process.exit(2); }
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const outFile = resolve(oi >= 0 ? args[oi + 1] : join('out', `${spec.meta.id}.pptx`));
  try {
    const { report } = await buildDeck(spec, { specDir: dirname(resolve(specPath)), outFile });
    console.log(`Wrote ${outFile}`);
    console.log(`Slides: ${report.summary.slides} (fully native: ${report.summary.fully_native}, with image content: ${report.summary.with_raster})`);
    for (const s of report.slides) for (const w of s.warnings) console.log(`WARNING ${s.id}: ${w}`);
    console.log(`Report: ${basename(outFile).replace(/\.pptx$/i, '.build-report.json')}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
