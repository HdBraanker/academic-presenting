#!/usr/bin/env python3
"""Summarise a .pptx as JSON for edit comparison (T19).

Per slide: layout name, title, shapes (kind, inferred role, geometry in inches,
text, font sizes, table cell alignment) and speaker notes. Read-only; never
modifies the deck. Usage: python3 deck_dump.py deck.pptx > deck.json
"""
import json
import sys
from collections import Counter

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER

EMU = 914400


def inch(v):
    return None if v is None else round(v / EMU, 3)


def clean_text(t):
    return ' '.join(t.replace('\x0b', ' ').replace(' ', ' ').split())


def font_sizes(tf):
    sizes = []
    for p in tf.paragraphs:
        for r in p.runs:
            if r.font.size is not None and r.text.strip():
                sizes.append(round(r.font.size.pt, 1))
    return sizes


def kind_of(sh):
    if getattr(sh, 'has_chart', False) and sh.has_chart:
        return 'chart'
    if getattr(sh, 'has_table', False) and sh.has_table:
        return 'table'
    if sh.shape_type == MSO_SHAPE_TYPE.PICTURE:
        return 'picture'
    if sh.shape_type == MSO_SHAPE_TYPE.GROUP:
        return 'group'
    if sh.has_text_frame:
        return 'text'
    return 'shape'


def role_of(sh, kind, slide_h):
    if sh.is_placeholder:
        t = sh.placeholder_format.type
        if t in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE, PP_PLACEHOLDER.VERTICAL_TITLE):
            return 'title'
        if t == PP_PLACEHOLDER.SLIDE_NUMBER:
            return 'slide_number'
        if t in (PP_PLACEHOLDER.FOOTER, PP_PLACEHOLDER.DATE):
            return 'template_footer'
        if t == PP_PLACEHOLDER.SUBTITLE:
            return 'subtitle'
    if kind in ('chart', 'table', 'picture', 'group'):
        return kind
    if kind == 'text':
        top = sh.top or 0
        sizes = font_sizes(sh.text_frame)
        small = (max(sizes) if sizes else 99) <= 14
        if top / EMU > 0.8 * slide_h and small:
            return 'footer'
        if top / EMU < 0.75 and small:
            return 'kicker'
        if sh.is_placeholder:
            return 'placeholder_text'
        return 'body'
    return kind


def dump(path):
    prs = Presentation(path)
    W, H = prs.slide_width / EMU, prs.slide_height / EMU
    slides = []
    for idx, slide in enumerate(prs.slides, 1):
        shapes = []
        title = ''
        for sh in slide.shapes:
            kind = kind_of(sh)
            role = role_of(sh, kind, H)
            text = clean_text(sh.text_frame.text) if sh.has_text_frame else ''
            if kind == 'table':
                text = ' | '.join(clean_text(c.text) for r in sh.table.rows for c in r.cells)
            item = {
                'id': sh.shape_id, 'name': sh.name, 'kind': kind, 'role': role,
                'x': inch(sh.left), 'y': inch(sh.top), 'w': inch(sh.width), 'h': inch(sh.height),
                'text': text,
            }
            if sh.has_text_frame:
                sizes = font_sizes(sh.text_frame)
                item['font_pt'] = Counter(sizes).most_common(1)[0][0] if sizes else None
                aligns = [str(p.alignment).split('.')[-1].split(' ')[0] for p in sh.text_frame.paragraphs if p.alignment is not None]
                item['align'] = Counter(aligns).most_common(1)[0][0] if aligns else None
            if kind == 'table':
                aligns = []
                for r in sh.table.rows:
                    aligns.append([str(c.text_frame.paragraphs[0].alignment).split('.')[-1].split(' ')[0] for c in r.cells])
                item['cell_align'] = aligns
                sizes = [s for r in sh.table.rows for c in r.cells for s in font_sizes(c.text_frame)]
                item['font_pt'] = Counter(sizes).most_common(1)[0][0] if sizes else None
            if role == 'title' and not title:
                title = text
            shapes.append(item)
        if not title:
            # Decks without a title placeholder (default engine): the largest text near the top is the title.
            cands = [x for x in shapes if x['kind'] == 'text' and x.get('font_pt') and x['font_pt'] >= 24 and (x['y'] or 0) < 1.8 and x['text']]
            if cands:
                best = max(cands, key=lambda x: (x['font_pt'], -(x['y'] or 0)))
                best['role'] = 'title'
                title = best['text']
        notes = clean_text(slide.notes_slide.notes_text_frame.text) if slide.has_notes_slide else ''
        slides.append({'index': idx, 'layout': slide.slide_layout.name, 'title': title, 'shapes': shapes, 'notes': notes})
    return {'file': path, 'width': round(W, 3), 'height': round(H, 3), 'slides': slides}


if __name__ == '__main__':
    json.dump(dump(sys.argv[1]), sys.stdout, ensure_ascii=False)
