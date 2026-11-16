#!/usr/bin/env python3
"""Academic Presenting — template-fill engine (experimental, T15).

Fills an institution's own PowerPoint template (.pptx/.potx) with python-pptx, so masters,
logos, fonts and placeholder styles are inherited exactly instead of being rebuilt.

  inspect <template> [--out map.json]   propose a role -> template-layout map (editable)
  fill <plan.json>                      render a plan written by build.mjs

The Node wrapper (build.mjs) validates the spec and prepares notes and citations; this script
never edits claim wording or numbers. It only places them.
"""
import argparse
import copy
import hashlib
import io
import json
import re
import sys
import zipfile

from lxml import etree
from pptx import Presentation
from pptx.chart.data import CategoryChartData, XyChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LEGEND_POSITION
from pptx.enum.shapes import MSO_CONNECTOR, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.parts.image import Image as PptxImage
from pptx.util import Inches, Pt

MAP_FORMAT = 'academic-presenting-template-map-v1'
ENGINE_VERSION = '0.1.0'
EMU = 914400
NS = {
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main',
    'p': 'http://schemas.openxmlformats.org/presentationml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}
A = '{%s}' % NS['a']
MUTED = '595959'
# Editorial type scale of the default engine (ADR-0008). A template map may override single sizes under style.sizes.
EDITORIAL_SIZES = {'title': 28, 'body': 22, 'small': 18, 'stat': 72, 'stat_sub': 24, 'question': 28, 'table': 20, 'take_home': 26, 'kicker': 13, 'footer': 14}
ROLES = ['title', 'section', 'text', 'title_only', 'text_visual', 'chart', 'table']


def xp(el, query):
    return etree.ElementBase.xpath(el, query, namespaces=NS)


def inch(v):
    return round(v / EMU, 3)


# ---------- template loading ----------
def load_template(path):
    data = open(path, 'rb').read()
    sha = hashlib.sha256(data).hexdigest()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        types = z.read('[Content_Types].xml').decode('utf8')
        table_styles = z.read('ppt/tableStyles.xml').decode('utf8') if 'ppt/tableStyles.xml' in z.namelist() else ''
        if 'presentationml.template.main+xml' in types:
            # .potx: same package, different main content type. python-pptx only opens presentations.
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as out:
                for item in z.infolist():
                    payload = z.read(item.filename)
                    if item.filename == '[Content_Types].xml':
                        payload = types.replace('presentationml.template.main+xml', 'presentationml.presentation.main+xml').encode('utf8')
                    out.writestr(item, payload)
            data = buf.getvalue()
    prs = Presentation(io.BytesIO(data))
    return prs, sha, table_styles


def theme_info(prs):
    root = None
    for rel in prs.slide_masters[0].part.rels.values():
        if rel.reltype.endswith('/theme'):
            root = etree.fromstring(rel.target_part.blob)
    colors, fonts = {}, {}
    if root is not None:
        for el in xp(root, './/a:clrScheme/*'):
            child = el[0] if len(el) else None
            if child is not None:
                is_rgb = etree.QName(child).localname == 'srgbClr'
                colors[etree.QName(el).localname] = (child.get('val') if is_rgb else child.get('lastClr') or '000000').upper()
        for key, tag in (('major', 'majorFont'), ('minor', 'minorFont')):
            hit = xp(root, './/a:fontScheme/a:%s/a:latin/@typeface' % tag)
            if hit:
                fonts[key] = hit[0]
    return colors, fonts


def resolve_font(face, fonts):
    if not face:
        return None
    if face.startswith('+mj'):
        return fonts.get('major')
    if face.startswith('+mn'):
        return fonts.get('minor')
    return face


def resolve_color(fill, colors):
    """solidFill element -> hex, following scheme colours (tx1/bg1 aliases included)."""
    if fill is None or not len(fill):
        return None
    c = fill[0]
    kind = etree.QName(c).localname
    if kind == 'srgbClr':
        return c.get('val').upper()
    if kind == 'schemeClr':
        alias = {'tx1': 'dk1', 'tx2': 'dk2', 'bg1': 'lt1', 'bg2': 'lt2'}
        return colors.get(alias.get(c.get('val'), c.get('val')))
    if kind == 'sysClr':
        return (c.get('lastClr') or '000000').upper()
    return None


def luminance(hex6):
    rgb = [int(hex6[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b='FFFFFF'):
    la, lb = luminance(a), luminance(b)
    return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)


# ---------- layout inventory ----------
KIND = {
    PP_PLACEHOLDER.TITLE: 'title', PP_PLACEHOLDER.CENTER_TITLE: 'title', PP_PLACEHOLDER.VERTICAL_TITLE: 'title',
    PP_PLACEHOLDER.SUBTITLE: 'subtitle', PP_PLACEHOLDER.BODY: 'body', PP_PLACEHOLDER.OBJECT: 'body',
    PP_PLACEHOLDER.VERTICAL_BODY: 'body', PP_PLACEHOLDER.VERTICAL_OBJECT: 'body',
    PP_PLACEHOLDER.PICTURE: 'picture', PP_PLACEHOLDER.SLIDE_NUMBER: 'sldnum',
    PP_PLACEHOLDER.DATE: 'date', PP_PLACEHOLDER.FOOTER: 'footer',
}


def master_ph(master, kind):
    for ph in master.placeholders:
        if KIND.get(ph.placeholder_format.type) == kind:
            return ph
    return None


def ph_box(ph, master, kind):
    src = ph if ph.left is not None and ph.width is not None else master_ph(master, kind)
    if src is None or src.left is None:
        return None
    return {'x': inch(src.left), 'y': inch(src.top), 'w': inch(src.width), 'h': inch(src.height)}


def layout_info(layout, index, master, W, H):
    phs = []
    for ph in layout.placeholders:
        fmt = ph.placeholder_format
        kind = KIND.get(fmt.type, 'other')
        box = ph_box(ph, master, kind)
        filled = bool(xp(ph._element, './p:spPr/a:solidFill|./p:spPr/a:gradFill|./p:spPr/a:blipFill'))
        phs.append({'idx': fmt.idx, 'kind': kind, 'center': fmt.type == PP_PLACEHOLDER.CENTER_TITLE, 'box': box, 'filled': filled})

    def usable(p):
        b = p['box']
        return p['kind'] == 'body' and b and b['h'] > 0.6 and b['w'] > 1.5 and b['w'] * b['h'] < 0.9 * W * H and not p['filled']

    def small(p):
        b = p['box']
        return p['kind'] in ('body', 'subtitle') and b and not usable(p) and b['w'] * b['h'] < 0.5 * W * H and not p['filled'] and b['w'] > 1.0

    return {
        'index': index, 'name': layout.name, 'type': layout._element.get('type'),
        'title': next((p for p in phs if p['kind'] == 'title'), None),
        'bodies': sorted([p for p in phs if usable(p)], key=lambda p: -(p['box']['w'] * p['box']['h'])),
        'small': [p for p in phs if small(p)],
        'pictures': [p for p in phs if p['kind'] == 'picture'],
        'others': [p for p in phs if p['kind'] == 'other'],
        'sldnum': next((p for p in phs if p['kind'] == 'sldnum'), None),
        'placeholders': phs,
    }


def fixed_shapes(layout, master, W, H):
    """Non-placeholder shapes that render on slides of this layout (layout + master unless hidden)."""
    out = []
    holders = [layout._element] + ([master._element] if layout._element.get('showMasterSp') != '0' else [])
    for holder in holders:
        for el in xp(holder, './p:cSld/p:spTree/*'):
            tag = etree.QName(el).localname
            if tag not in ('sp', 'pic', 'grpSp', 'cxnSp', 'graphicFrame'):
                continue
            if xp(el, './p:nvSpPr/p:nvPr/p:ph|./p:nvPicPr/p:nvPr/p:ph'):
                continue
            off = xp(el, './p:spPr/a:xfrm/a:off|./p:grpSpPr/a:xfrm/a:off')
            ext = xp(el, './p:spPr/a:xfrm/a:ext|./p:grpSpPr/a:xfrm/a:ext')
            if not off or not ext:
                continue
            box = {'x': inch(int(off[0].get('x'))), 'y': inch(int(off[0].get('y'))), 'w': inch(int(ext[0].get('cx'))), 'h': inch(int(ext[0].get('cy')))}
            if box['x'] >= W or box['y'] >= H or box['x'] + box['w'] <= 0 or box['y'] + box['h'] <= 0:
                continue  # parked off-slide (instruction notes)
            out.append({'box': box, 'filled': bool(xp(el, './p:spPr/a:solidFill')), 'tag': tag})
    return out


def lvl_props(layout, master, ph_idx, level, body=True):
    """Resolve (font size pt, has bullet, latin face, fill) for a list level: placeholder -> master placeholder -> txStyles."""
    chain = []
    for ph in layout.placeholders:
        if ph.placeholder_format.idx == ph_idx:
            chain += xp(ph._element, './p:txBody/a:lstStyle/a:lvl%dpPr' % level)
    mph = master_ph(master, 'body' if body else 'title')
    if mph is not None:
        chain += xp(mph._element, './p:txBody/a:lstStyle/a:lvl%dpPr' % level)
    chain += xp(master._element, './p:txStyles/p:%s/a:lvl%dpPr' % ('bodyStyle' if body else 'titleStyle', level))
    size = bullet = face = fill = None
    for el in chain:
        rpr = el.find(A + 'defRPr')
        if size is None and rpr is not None and rpr.get('sz'):
            size = int(rpr.get('sz')) / 100
        if bullet is None:
            if el.find(A + 'buNone') is not None:
                bullet = False
            elif el.find(A + 'buChar') is not None or el.find(A + 'buAutoNum') is not None:
                bullet = True
        if face is None and rpr is not None and rpr.find(A + 'latin') is not None:
            face = rpr.find(A + 'latin').get('typeface')
        if fill is None and rpr is not None and rpr.find(A + 'solidFill') is not None:
            fill = rpr.find(A + 'solidFill')
    return size, bullet, face, fill


def pick(cands, score, minimum=None):
    best, best_score = None, None
    for c in cands:
        s = score(c)
        if s is None:
            continue
        if best is None or s > best_score:
            best, best_score = c, s
    if minimum is not None and best is not None and best_score < minimum:
        return None
    return best


def name_is(info, pattern):
    return bool(re.search(pattern, info['name'], re.I))


def variant_penalty(info):
    return -1 if re.match(r'\d+_', info['name']) else 0


def kicker_only(info):
    """Small body above the title is a kicker, not a content column."""
    t = info['title']['box'] if info['title'] else None
    return bool(t and all(p['box'] and p['box']['h'] <= 0.42
                          and p['box']['y'] + p['box']['h'] <= t['y'] + 0.08
                          for p in info['small']))


def content_object(info, W, H):
    return any(p['box'] and p['box']['w'] >= 0.55 * W and p['box']['h'] >= 0.3 * H
               for p in info['others'])


def inspect(path):
    prs, sha, table_styles = load_template(path)
    W, H = inch(prs.slide_width), inch(prs.slide_height)
    colors, fonts = theme_info(prs)
    # Templates often keep title layouts and content layouts on separate masters: consider the layouts of all of them.
    layouts = [l for m in prs.slide_masters for l in m.slide_layouts]
    infos = [layout_info(l, i, l.slide_master, W, H) for i, l in enumerate(layouts)]
    notes = []
    # Layouts the template's own sample slides use are the ones its designers meant as defaults.
    sampled = {sl.slide_layout.name for sl in prs.slides}
    sample_bonus = lambda i: 1 if i['name'] in sampled else 0

    def s_title(i):
        if not i['title']:
            return None
        t = i['title']['box']
        if not t:
            return None
        s = 5 if t['y'] > 0.18 * H else 0
        s += 5 if i['type'] == 'title' else 0
        s += 3 if i['title']['center'] else 0
        s += 2 if i['small'] and not kicker_only(i) else 0
        s += 1 if i['pictures'] else 0
        s -= 5 if i['bodies'] or content_object(i, W, H) else 0
        return s + variant_penalty(i) + sample_bonus(i)

    def s_text(i):
        if not i['title'] or len(i['bodies']) != 1 or i['pictures'] or i['others']:
            return None
        b = i['bodies'][0]['box']
        if b['w'] < 0.6 * W:
            return None
        s = 3 if name_is(i, r'^(tekst|text|inhoud|content|bullets?|title and content|titel en (object|inhoud))$') else 0
        s += 3 if i['type'] in ('obj', 'tx') else 0
        s -= 2 if name_is(i, r'vertical|verticale') else 0
        return s + 4 * (b['w'] * b['h']) / (W * H) + variant_penalty(i) + sample_bonus(i)

    def title_only_ok(i):
        # A kicker above the title is fine; a centred title, subtitle or picture marks a title page.
        return bool(i['title'] and not i['bodies'] and not i['pictures'] and kicker_only(i) and not i['others']
                    and not i['title']['center'] and not any(p['kind'] == 'subtitle' for p in i['placeholders'])
                    and i['title']['box'] and i['title']['box']['y'] < 0.35 * H)

    def s_named(pattern, bonus_type=None):
        def score(i):
            if not title_only_ok(i):
                return None
            return 3 + (1 if name_is(i, pattern) else 0) + (2 if bonus_type and i['type'] == bonus_type else 0) + variant_penalty(i)
        return score

    def s_object(i, pattern):
        if not i['title'] or i['bodies'] or i['pictures'] or not kicker_only(i) or not content_object(i, W, H):
            return None
        return 3 + (1 if name_is(i, pattern) else 0) + variant_penalty(i)

    def s_text_visual(i):
        if not i['title'] or len(i['bodies']) != 1 or i['pictures'] or i['others']:
            return None
        b = i['bodies'][0]['box']
        if b['w'] > 0.5 * W or b['h'] < 0.3 * H:
            return None
        s = 2 if name_is(i, r'grafiek|chart|tabel|table|figuur|figure|object|content|inhoud') else 0
        s += 1 if name_is(i, r'grafiek|chart|figuur|figure') else 0
        return s + variant_penalty(i)

    def s_section(i):
        if not i['title'] or i['pictures'] or i['title']['center']:
            return None
        if not (name_is(i, r'hoofdstuk|section|sectie|chapter|divider|tussen') or i['type'] == 'secHead'):
            return None
        return 1 + variant_penalty(i)

    chosen = {
        'title': pick(infos, s_title, minimum=3),
        'text': pick(infos, s_text),
        'title_only': pick(infos, s_named(r'alleen titel|title only|titel alleen|only title', 'titleOnly')),
        'text_visual': pick(infos, s_text_visual),
        'section': pick(infos, s_section),
    }
    chosen['chart'] = pick(infos, lambda i: s_object(i, r'grafiek|chart|diagram')) or chosen['title_only']
    chosen['table'] = pick(infos, lambda i: s_object(i, r'tabel|table')) or chosen['title_only']

    text = chosen['text']
    if text is None:
        raise SystemExit('No usable text layout (a title plus one wide body placeholder) found in this template; write a map by hand.')
    if chosen['title'] is None:
        chosen['title'] = text
        notes.append('No title-slide layout recognised; the text layout "%s" is used for the title slide.' % text['name'])
    if chosen['title_only'] is None:
        notes.append('No title-only layout found; charts, tables, figures and stat cards use the text layout "%s" with its body placeholder removed.' % text['name'])
        for role in ('title_only', 'chart', 'table'):
            chosen[role] = chosen[role] or text
    if chosen['section'] is None:
        chosen['section'] = chosen['title_only']
        notes.append('No section layout with a title placeholder recognised; section slides use "%s".' % chosen['section']['name'])
    split = chosen['text_visual'] is None
    if split:
        chosen['text_visual'] = text
        notes.append('No narrow text-plus-visual layout found; text-with-visual slides use "%s" with its body resized to the left column.' % text['name'])

    tb, bb = text['title']['box'], text['bodies'][0]['box']
    left = min(tb['x'], bb['x'])
    frame = {'x': left, 'y': bb['y'], 'w': round(max(tb['x'] + tb['w'], bb['x'] + bb['w']) - left, 3), 'h': bb['h']}
    right, bottom = frame['x'] + frame['w'], frame['y'] + frame['h']

    def below_title(info):
        t = info['title']['box']
        return round(max(frame['y'], t['y'] + t['h'] + 0.3), 3)

    def footer_for(info, layout):
        num = info['sldnum']['box'] if info['sldnum'] and info['sldnum']['box'] else None
        x0, x1 = frame['x'], right
        y = num['y'] if num and num['y'] > bottom - 0.2 else round(min(bottom + 0.15, H - 0.45), 3)
        shapes = fixed_shapes(layout, layout.slide_master, W, H)
        logos = [sh['box'] for sh in shapes if sh['tag'] == 'pic' and sh['box']['y'] > 0.75 * H
                 and sh['box']['w'] < 0.25 * W and sh['box']['h'] < 0.16 * H]
        if logos:
            logo = min(logos, key=lambda b: b['x'])
            y = round(logo['y'] + max(0, (logo['h'] - 0.3) / 2), 3)
            x0 = max(x0, logo['x'] + logo['w'] + 0.2)
        for shape in shapes:
            b = shape['box']
            if b['y'] + b['h'] <= y or b['y'] >= y + 0.3 or b['h'] > 1.5 or b['w'] > 0.6 * W:
                continue
            if b['x'] + b['w'] / 2 < W / 2:
                x0 = max(x0, b['x'] + b['w'] + 0.25)
            else:
                x1 = min(x1, b['x'] - 0.25)
        if num and num['x'] + num['w'] / 2 > W / 2 and num['w'] < 0.4 * W:
            x1 = min(x1, num['x'] - 0.2)
        return {'x': round(x0, 3), 'y': round(y, 3), 'w': round(max(1.0, x1 - x0), 3), 'h': 0.3}

    def title_constraint(info, layout, pt):
        t = info['title']['box'] if info['title'] else None
        if not t or t['h'] > 1.4 * pt / 72:
            return None
        rules = [sh['box'] for sh in fixed_shapes(layout, layout.slide_master, W, H)
                 if sh['box']['h'] <= 0.18 and 0 <= sh['box']['y'] - (t['y'] + t['h']) <= 0.35
                 and sh['box']['x'] < t['x'] + t['w'] and sh['box']['x'] + sh['box']['w'] > t['x']]
        if not rules:
            return None
        return {'decoration_y': min(b['y'] for b in rules), 'min_pt': 20,
                'character_budget': max(1, int(0.85 * t['w'] * 72 / (pt * 0.62)))}

    # Lowest point content may reach on a clean content slide: stay clear of logos and other fixed artwork near the bottom edge.
    low = [sh['box']['y'] for sh in fixed_shapes(layouts[chosen['title_only']['index']], layouts[chosen['title_only']['index']].slide_master, W, H)
           if sh['box']['y'] > 0.7 * H and sh['box']['h'] < 1.5 and sh['box']['w'] < 0.6 * W]
    clear_bottom = round(min([bottom] + [y - 0.15 for y in low]), 3)
    col = round(frame['w'] * 0.36, 3)
    # Split variant of the text layout: body resized to a left column, visual on the right. Used when the template has no
    # narrow text-plus-visual layout, or when a long claim title does not fit that layout's narrow column.
    split_boxes = {'body_box': {'x': frame['x'], 'y': frame['y'], 'w': col, 'h': frame['h']},
                   'visual_area': {'x': round(frame['x'] + col + 0.4, 3), 'y': frame['y'], 'w': round(frame['w'] - col - 0.4, 3), 'h': frame['h']}}
    roles = {}
    for role in ROLES:
        info = chosen[role]
        layout = layouts[info['index']]
        entry = {'layout': info['name'], 'layout_index': info['index'], 'title': info['title']['idx'] if info['title'] else None}
        if info['title'] and info['title']['box']:
            entry['title_box'] = info['title']['box']
            entry['title_pt'] = lvl_props(layout, layout.slide_master, info['title']['idx'], 1, body=False)[0] or 28
            constraint = title_constraint(info, layout, EDITORIAL_SIZES['title'] if role not in ('title', 'section') else entry['title_pt'])
            if constraint:
                entry['title_constraint'] = constraint
        if role == 'title':
            sub = (info['small'] or info['bodies'] or [None])[0]
            entry['subtitle'] = sub['idx'] if sub else None
            if sub:
                sb = dict(sub['box'])
                obstacles = [sh['box']['y'] for sh in fixed_shapes(layout, layout.slide_master, W, H)
                             if sh['box']['y'] > sb['y'] and sh['box']['w'] < 0.6 * W
                             and sh['box']['x'] < sb['x'] + sb['w'] and sh['box']['x'] + sh['box']['w'] > sb['x']]
                limit = min(obstacles + [H - 0.15])
                sb['h'] = round(max(sb['h'], limit - sb['y'] - 0.08), 3)
                entry['subtitle_box'] = sb
                entry['subtitle_pt'] = lvl_props(layout, layout.slide_master, sub['idx'], 1)[0] or 18
            if sub is None:
                notes.append('Title layout "%s" has no subtitle placeholder; presenter and date are not shown on the title slide.' % info['name'])
        if role in ('text', 'text_visual') and info['bodies']:
            entry['body'] = info['bodies'][0]['idx']
            entry['body_default_box'] = info['bodies'][0]['box']
        if role in ('title_only', 'chart', 'table', 'section'):
            top = below_title(info)
            entry['content_area'] = {'x': frame['x'], 'y': top, 'w': frame['w'], 'h': round(bottom - top, 3)}
        if role == 'text':
            entry['content_area'] = dict(frame)
        if role == 'text_visual':
            b = info['bodies'][0]['box']
            if split:
                entry.update(split_boxes)
            else:
                cx, cy = b['x'] + b['w'] / 2, b['y'] + b['h'] / 2
                panel = next((s['box'] for s in fixed_shapes(layout, layout.slide_master, W, H) if s['filled'] and s['box']['w'] < 0.95 * W
                              and s['box']['x'] <= cx <= s['box']['x'] + s['box']['w'] and s['box']['y'] <= cy <= s['box']['y'] + s['box']['h']), None)
                t = info['title']['box']
                if cx < W / 2:
                    edge = max(b['x'] + b['w'], (panel['x'] + panel['w']) if panel else 0)
                    vx, vw = edge + 0.45, right - edge - 0.45
                    title_in_column = t['x'] + t['w'] <= edge + 0.1
                else:
                    edge = min(b['x'], panel['x'] if panel else W)
                    vx, vw = frame['x'], edge - 0.45 - frame['x']
                    title_in_column = t['x'] >= edge - 0.1
                vy = min(t['y'], frame['y']) if title_in_column else below_title(info)
                entry['visual_area'] = {'x': round(vx, 3), 'y': round(vy, 3), 'w': round(vw, 3), 'h': round(bottom - vy, 3)}
                entry['panel'] = bool(panel)
        entry['footer'] = footer_for(info, layout)
        if role == 'text_visual':
            va, f = entry['visual_area'], entry['footer']
            fx = max(f['x'], va['x']) if va['x'] > frame['x'] + 0.5 else f['x']
            fr = min(f['x'] + f['w'], va['x'] + va['w'])
            entry['footer'] = {**f, 'x': round(fx, 3), 'w': round(max(1.0, fr - fx), 3)}
        if entry.get('body') is not None:
            size, _, _, fill = lvl_props(layout, layout.slide_master, entry['body'], 1)
            entry['body_pt'] = size or 18
        roles[role] = entry

    text_layout = layouts[text['index']]
    body_idx = roles['text']['body']
    size1, bullet1, face_b, fill_b = lvl_props(text_layout, text_layout.slide_master, body_idx, 1)
    _, bullet2, _, _ = lvl_props(text_layout, text_layout.slide_master, body_idx, 2)
    tsize, _, face_t, fill_t = lvl_props(text_layout, text_layout.slide_master, text['title']['idx'], 1, body=False)
    title_color = resolve_color(fill_t, colors) or colors.get('dk1', '000000')
    body_color = resolve_color(fill_b, colors) or colors.get('dk1', '000000')
    accents = [colors[k] for k in ('accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6') if k in colors]
    # Contrast guard (Hannah's decision A, 2026-11-15): text drawn by the engine needs >= 4.5:1 on white.
    # A bright house accent stays in the template's own elements; a darker colour from the same theme is used for drawn text.
    accent_text = next((c for c in [title_color] + accents if contrast(c) >= 4.5), body_color)
    if accent_text != title_color:
        notes.append('Title colour %s is %.1f:1 on white; numbers drawn by the engine use %s (%.1f:1) from the same theme.'
                     % (title_color, contrast(title_color), accent_text, contrast(accent_text)))
    def warm(c):
        r, g, b = (int(c[i:i + 2], 16) for i in (0, 2, 4))
        return r > 150 and r > 1.6 * g and r > 1.6 * b
    # Key numbers: a warm theme colour with enough contrast if the template has one (ADR-0008 uses a red highlight), else the text accent.
    highlight = next((c for c in accents if warm(c) and contrast(c) >= 4.5 and c != accent_text), accent_text)
    bullet_level = 0 if bullet1 else (1 if bullet2 else None)
    if bullet_level is None:
        notes.append('The body placeholder defines no bullet character; bullets are written with an explicit bullet.')

    slides_xml = ''.join(etree.tostring(s._element, encoding='unicode') for s in prs.slides)
    used = re.findall(r'tableStyleId>(\{[0-9A-Fa-f-]+\})<', slides_xml)
    declared = re.findall(r'styleId="(\{[0-9A-Fa-f-]+\})"', table_styles)
    default = re.search(r'def="(\{[0-9A-Fa-f-]+\})"', table_styles)
    table_style = max(set(used), key=used.count) if used else (declared[0] if declared else (default.group(1) if default else None))

    return {
        'format': MAP_FORMAT,
        'template_sha256': sha,
        'slide_size_inches': {'width': W, 'height': H},
        'roles': roles,
        'frame': frame,
        'split': split_boxes,
        'clear_bottom': clear_bottom,
        'style': {
            'font_heading': resolve_font(face_t, fonts) or fonts.get('major') or 'Calibri',
            'font_body': resolve_font(face_b, fonts) or fonts.get('minor') or 'Calibri',
            'title_pt': tsize or 28, 'body_pt': size1 or 18,
            'typography': 'editorial', 'sizes': dict(EDITORIAL_SIZES),
            'title_color': title_color, 'body_color': body_color, 'accent_text': accent_text, 'highlight': highlight, 'muted': '646E78', 'rule': 'C8CDD2',
            'bullet_level': bullet_level, 'table_style_id': table_style,
        },
        'layouts_available': [{'index': i['index'], 'name': i['name'], 'placeholders': ['%s#%s' % (p['kind'], p['idx']) for p in i['placeholders']]} for i in infos],
        'notes': notes,
    }


# ---------- filling ----------
def est_height(text, pt, width_in, spacing=1.2):
    char_w = 0.52 * pt / 72  # Arial-like width; house fonts are rarely as narrow as Calibri
    per_line = max(1, int((width_in - 0.2) / char_w))
    lines = sum(max(1, -(-len(par) // per_line)) for par in str(text).split('\n'))
    return lines * pt * spacing / 72 + 0.15


def wrapped_lines(text, pt, width_in, glyph=0.52):
    per_line = max(4, int(width_in / (glyph * pt / 72)))
    lines = 0
    for para in str(text).split('\n'):
        used, count = 0, 1
        for word in para.split():
            need = len(word) + (1 if used else 0)
            if used and used + need > per_line:
                count, used = count + 1, len(word)
            else:
                used += need
        lines += count
    return lines


def numeric_column(block, col):
    values = [row[col] for row in block['rows'] if col < len(row) and row[col] is not None and str(row[col]).strip()]
    if not values:
        return False
    numeric = re.compile(r'^\s*[€$£]?\s*[−+\-]?\s*\d')
    return sum(bool(numeric.match(str(value))) for value in values) > len(values) / 2


class Filler:
    def __init__(self, plan):
        self.plan = plan
        self.map = plan['map']
        if self.map.get('format') != MAP_FORMAT:
            raise SystemExit('Template map format must be %s' % MAP_FORMAT)
        self.style = self.map['style']
        self.editorial_mode = self.style.get('typography', 'editorial') == 'editorial'
        self.sizes = {**EDITORIAL_SIZES, **(self.style.get('sizes') or {})}
        self.prs, self.sha, _ = load_template(plan['template'])
        if self.map.get('template_sha256') and self.map['template_sha256'] != self.sha:
            raise SystemExit('Template map was made for a different template file; run inspect again.')
        self.layouts = [l for m in self.prs.slide_masters for l in m.slide_layouts]
        self.report = {'spec_id': plan['spec_id'], 'engine': 'powerpoint-template', 'engine_version': ENGINE_VERSION,
                       'template': {'file': plan.get('template_name'), 'sha256': self.sha, 'map_sha256': plan.get('map_sha256')},
                       'slides': [], 'limitations': []}

    # --- package housekeeping ---
    def clear_slides(self):
        lst = self.prs.slides._sldIdLst
        removed = len(lst)
        for sld in list(lst):
            self.prs.part.drop_rel(sld.rId)
            lst.remove(sld)
        for ext in xp(self.prs.part._element, './p:extLst/p:ext'):
            if any('sectionLst' in etree.QName(c).localname for c in ext):
                ext.getparent().remove(ext)
        return removed

    def layout_for(self, entry):
        idx = entry.get('layout_index')
        if isinstance(idx, int) and 0 <= idx < len(self.layouts) and self.layouts[idx].name == entry.get('layout'):
            return self.layouts[idx]
        for layout in self.layouts:
            if layout.name == entry.get('layout'):
                return layout
        raise SystemExit('Template map refers to layout "%s", which this template does not have.' % entry.get('layout'))

    # --- text helpers ---
    @staticmethod
    def ph(slide, idx):
        if idx is None:
            return None
        for ph in slide.placeholders:
            if ph.placeholder_format.idx == idx:
                return ph
        return None

    def write_paragraphs(self, shape, paras, keep_style=False):
        tf = shape.text_frame
        level = self.style.get('bullet_level')
        for n, para in enumerate(paras):
            p = tf.paragraphs[0] if n == 0 else tf.add_paragraph()
            for text, bold in para['runs']:
                run = p.add_run()
                run.text = text
                if bold:
                    run.font.bold = True
                if para.get('pt'):
                    run.font.size = Pt(para['pt'])
            if keep_style:
                continue
            if para['kind'] == 'bullet':
                if level == 1:
                    p.level = 1
                elif level is None:
                    ppr = p._p.get_or_add_pPr()
                    ppr.set('marL', '285750')
                    ppr.set('indent', '-285750')
                    etree.SubElement(ppr, A + 'buChar').set('char', '•')
            elif level == 0:
                ppr = p._p.get_or_add_pPr()
                ppr.set('marL', '0')
                ppr.set('indent', '0')
                etree.SubElement(ppr, A + 'buNone')

    @staticmethod
    def paragraphs(blocks, base_pt):
        paras = []
        for b in blocks:
            if b['type'] == 'bullets':
                for it in b['items']:
                    runs = ([(it['lead'] + '  ', True)] if it.get('lead') else []) + [(it['text'], False)]
                    paras.append({'kind': 'bullet', 'runs': runs})
            elif b['type'] == 'question':
                paras.append({'kind': 'plain', 'runs': [(b['text'], True)], 'pt': min(28, round(base_pt * 1.4))})
            else:
                paras.append({'kind': 'plain', 'runs': [(b['text'], b.get('role') == 'callout')]})
        return paras

    @staticmethod
    def plain_text(blocks):
        out = []
        for b in blocks:
            if b['type'] == 'bullets':
                out += [((it.get('lead') or '') + '  ' + it['text']).strip() for it in b['items']]
            else:
                out.append(b['text'])
        return '\n'.join(out)

    def textbox(self, slide, box, text, pt, bold=False, color=None, font=None, align=None, anchor=MSO_ANCHOR.TOP):
        tb = slide.shapes.add_textbox(Inches(box['x']), Inches(box['y']), Inches(box['w']), Inches(box['h']))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = anchor
        for n, line in enumerate(str(text).split('\n')):
            p = tf.paragraphs[0] if n == 0 else tf.add_paragraph()
            if align:
                p.alignment = align
            if n:
                p.space_before = Pt(pt * 0.5)
            run = p.add_run()
            run.text = line
            run.font.size = Pt(pt)
            run.font.bold = bold
            run.font.name = font or self.style['font_body']
            run.font.color.rgb = RGBColor.from_string(color or self.style['body_color'])
        return tb

    # --- visuals ---
    def figure(self, slide, b, area, rep, caption_pt=14):
        path = b.get('resolved_path')
        box = dict(area)
        if b.get('caption'):
            box['h'] = max(1.0, box['h'] - 0.45)
        if not path:
            rep['warnings'].append('figure %s: file not found (%s); placeholder text drawn' % (b['id'], b['path']))
            self.textbox(slide, box, 'Missing figure: %s' % b['path'], 16, color='B03A2E', anchor=MSO_ANCHOR.MIDDLE, align=PP_ALIGN.CENTER)
            return box['h']
        pic = slide.shapes.add_picture(path, 0, 0)
        ratio = pic.width / pic.height
        w, h = (box['h'] * ratio, box['h']) if box['w'] / box['h'] > ratio else (box['w'], box['w'] / ratio)
        pic.left, pic.top = Inches(box['x'] + (box['w'] - w) / 2), Inches(box['y'] + (box['h'] - h) / 2)
        pic.width, pic.height = Inches(w), Inches(h)
        xp(pic._element, './p:nvPicPr/p:cNvPr')[0].set('descr', b['alt'])
        rep['raster_elements'].append({'block': b['id'], 'path': b['path'], 'origin': b.get('origin', 'unspecified')})
        rep['editable'] = 'partial'
        if b.get('caption'):
            self.textbox(slide, {'x': area['x'], 'y': box['y'] + box['h'] + 0.05, 'w': area['w'], 'h': 0.4}, b['caption'], caption_pt, color=self.style['muted'])
        return area['h']

    def table(self, slide, b, area, rep):
        rows, cols = len(b['rows']) + 1, len(b['columns'])
        pt = min(20, max(16, self.style['body_pt']))
        row_h = round(pt / 72 * 2.1, 3)
        height = row_h * rows
        frame = slide.shapes.add_table(rows, cols, Inches(area['x']), Inches(area['y']), Inches(area['w']), Inches(height))
        style_id = self.style.get('table_style_id')
        node = xp(frame._element, './/a:tblPr/a:tableStyleId')
        if style_id and node:
            node[0].text = style_id
        tbl = frame.table
        first = area['w'] * (0.34 if cols > 2 else 0.5)
        for j in range(cols):
            tbl.columns[j].width = Inches(first if j == 0 else (area['w'] - first) / max(1, cols - 1))
        for i in range(rows):
            for j in range(cols):
                value = b['columns'][j] if i == 0 else b['rows'][i - 1][j]
                cell = tbl.cell(i, j)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                tf = cell.text_frame
                tf.text = '' if value is None else str(value)
                par = tf.paragraphs[0]
                par.alignment = PP_ALIGN.RIGHT if numeric_column(b, j) else PP_ALIGN.LEFT
                for run in par.runs:
                    run.font.size = Pt(pt)
                    run.font.name = self.style['font_body']
        if height > area['h'] + 0.05:
            rep['warnings'].append('table %s: ~%.2f in tall, taller than the content area (%.2f in)' % (b['id'], height, area['h']))
        return height

    def chart(self, slide, b, area, rep):
        kinds = {'bar': XL_CHART_TYPE.COLUMN_CLUSTERED, 'line': XL_CHART_TYPE.LINE_MARKERS, 'scatter': XL_CHART_TYPE.XY_SCATTER}
        if b['chart_type'] not in kinds:
            rep['warnings'].append('chart %s: chart_type "%s" not supported by the template engine yet; drawn as table' % (b['id'], b['chart_type']))
            fallback = {'id': b['id'], 'columns': ['Series'] + list(b.get('categories') or []), 'rows': [[s['name']] + list(s['values']) for s in b['series']]}
            return self.table(slide, fallback, area, rep)
        cats = b.get('categories') or [str(i + 1) for i in range(len(b['series'][0]['values']))]
        if b['chart_type'] == 'scatter':
            data = XyChartData()
            for s in b['series']:
                series = data.add_series(s['name'])
                for i, v in enumerate(s['values']):
                    if v is None:
                        continue
                    try:
                        x = float(cats[i])
                    except (ValueError, IndexError):
                        x = i + 1
                    series.add_data_point(x, v)
        else:
            data = CategoryChartData()
            data.categories = cats
            for s in b['series']:
                data.add_series(s['name'], s['values'])
        frame = slide.shapes.add_chart(kinds[b['chart_type']], Inches(area['x']), Inches(area['y']), Inches(area['w']), Inches(area['h']), data)
        chart = frame.chart
        chart.font.size = Pt(14)
        chart.font.name = self.style['font_body']
        chart.has_title = False
        chart.has_legend = len(b['series']) > 1
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
        for axis, label in ((chart.category_axis, b.get('x_label')), (chart.value_axis, b.get('y_label'))):
            if label:
                axis.has_title = True
                axis.axis_title.text_frame.text = label
                for run in axis.axis_title.text_frame.paragraphs[0].runs:
                    run.font.size = Pt(14)
                    run.font.bold = False
        chart.value_axis.has_major_gridlines = True
        chart.value_axis.major_gridlines.format.line.color.rgb = RGBColor.from_string('E3E6E9')
        if b['chart_type'] != 'scatter':
            chart.value_axis.minimum_scale = 0
        if b['chart_type'] == 'line':
            for series in chart.plots[0].series:
                series.smooth = False
                series.format.line.width = Pt(2.5)
        if b.get('data_origin') == 'digitized-from-figure':
            rep['warnings'].append('chart %s: digitized values; label as approximate' % b['id'])
        return area['h']

    def visual(self, slide, b, area, rep):
        return {'figure': self.figure, 'chart': self.chart, 'table': self.table}[b['type']](slide, b, area, rep)

    def stats(self, slide, stats, area, stat_h, rep):
        n = max(1, len(stats))
        width = area['w'] if n > 1 else min(area['w'], 7.6)
        cw = width / n
        y = area['y'] + min(0.18, stat_h * 0.06)
        rule_y = area['y'] + stat_h - 0.62
        for i, b in enumerate(stats):
            x = area['x'] + i * cw
            cut = b['value'].find(' (')
            main, sub = (b['value'][:cut], b['value'][cut + 1:]) if cut > 0 else (b['value'], '')
            main_h = min(1.5, max(0.75, rule_y - y - (0.43 if sub else 0.1)))
            big = min(44 if b.get('emphasis') == 'secondary' else 66, int(main_h * 72 / 1.15))
            self.textbox(slide, {'x': x, 'y': y, 'w': cw - 0.4, 'h': main_h}, main, big, bold=True, color=self.style['accent_text'], font=self.style['font_heading'])
            if est_height(main, big, cw - 0.4) > main_h * 1.25:
                rep['warnings'].append('likely overflow in stat %s (confirm with render check)' % b['id'])
            if sub:
                self.textbox(slide, {'x': x, 'y': y + main_h + 0.04, 'w': cw - 0.4, 'h': 0.34}, sub, 20)
            self.rule(slide, x, rule_y, min(cw - 0.4, 5.5), self.style.get('rule', 'C8CDD2'))
            label_y = rule_y + 0.1
            self.textbox(slide, {'x': x, 'y': label_y, 'w': cw - 0.4, 'h': area['y'] + stat_h - label_y - 0.04}, b['label'], 18, color=self.style['muted'])
        return stat_h

    # --- editorial typography (ADR-0008 look on the template's own masters) ---
    def colors(self):
        st = self.style
        return {'ink': st['body_color'], 'muted': st.get('muted', MUTED), 'accent': st['accent_text'],
                'highlight': st.get('highlight') or st['accent_text'], 'rule': st.get('rule', 'C8CDD2'), 'brand': st['title_color']}

    def rich_box(self, slide, box, paras, pt, font=None, anchor=MSO_ANCHOR.TOP, space_after=0, line_spacing=None, align=None):
        """paras: list of paragraphs, each a list of (text, bold, hex colour) runs."""
        tb = slide.shapes.add_textbox(Inches(box['x']), Inches(box['y']), Inches(box['w']), Inches(max(0.2, box['h'])))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
        tf.vertical_anchor = anchor
        for n, runs in enumerate(paras):
            p = tf.paragraphs[0] if n == 0 else tf.add_paragraph()
            if space_after and n < len(paras) - 1:
                p.space_after = Pt(space_after)
            if line_spacing:
                p.line_spacing = line_spacing
            if align:
                p.alignment = align
            for text, bold, color in runs:
                run = p.add_run()
                run.text = text
                run.font.size = Pt(pt)
                run.font.bold = bool(bold)
                run.font.name = font or self.style['font_body']
                run.font.color.rgb = RGBColor.from_string(color)
        return tb

    def references(self, slide, s, box, rep):
        refs = [b['text'].strip() for b in s.get('blocks') or [] if b['type'] == 'text' and b.get('text', '').strip()]
        if not refs:
            refs = [text.strip() for text in s.get('reference_list') or [] if text.strip()]
        start = max(14, int(self.sizes['small']))
        def needed(pt):
            return sum(est_height(ref, pt, box['w'] - 0.2, spacing=1.25) for ref in refs) + max(0, len(refs) - 1) * pt * 0.55 / 72
        size = next((pt for pt in range(start, 13, -1) if needed(pt) <= box['h']), None)
        if size is None:
            raise SystemExit('References slide %s cannot fit at 14 pt; split it in the spec and obtain storyboard approval again.' % s['id'])
        paras = [[(ref, False, self.colors()['ink'])] for ref in refs]
        self.rich_box(slide, box, paras, size, space_after=size * 0.55)
        rep['references_font_pt'] = size

    def rule(self, slide, x, y, w, color, width=0.75):
        line = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(x), Inches(y), Inches(x + w), Inches(y))
        line.line.color.rgb = RGBColor.from_string(color)
        line.line.width = Pt(width)
        for node in xp(line._element, './p:style'):
            node.getparent().remove(node)  # no theme shadow or accent styling on hairlines
        return line

    def e_measure(self, blocks, w, bullet_pt=None, caption_pt=None, body_pt=None, gap=0.25, bullet_space=14):
        S = self.sizes
        total = 0.0
        for b in blocks:
            if b['type'] == 'bullets':
                plain = '\n'.join(((it.get('lead') or '') + '  ' + it['text']) for it in b['items'])
                total += est_height(plain, bullet_pt or S['body'], w, 1.25) + bullet_space / 72 * len(b['items']) + gap
            else:
                role = 'question' if b['type'] == 'question' else b.get('role', 'body')
                size = (caption_pt or S['small']) if role == 'caption' else 28 if role == 'question' else (body_pt or S['body'])
                total += est_height(b['text'], size, w) + (0.12 if role == 'callout' else 0) + gap
        return total - gap

    def e_stack(self, slide, blocks, x, y, w, max_h, rep, bullet_pt=None, caption_pt=None, body_pt=None, gap=0.25, bullet_space=14):
        S, C = self.sizes, self.colors()
        cy = y
        for b in blocks:
            if b['type'] == 'bullets':
                size = bullet_pt or S['body']
                plain = '\n'.join(((it.get('lead') or '') + '  ' + it['text']) for it in b['items'])
                h = min(est_height(plain, size, w, 1.25) + bullet_space / 72 * len(b['items']), max(0.3, max_h - (cy - y)))
                paras = [([(it['lead'] + '  ', True, C['accent'])] if it.get('lead') else []) + [(it['text'], False, C['ink'])] for it in b['items']]
                self.rich_box(slide, {'x': x, 'y': cy, 'w': w, 'h': h}, paras, size, space_after=bullet_space, line_spacing=1.1)
                need = est_height(plain, size, w, 1.25)
            else:
                role = 'question' if b['type'] == 'question' else b.get('role', 'body')
                size = (caption_pt or S['small']) if role == 'caption' else 28 if role == 'question' else (body_pt or S['body'])
                color = C['muted'] if role == 'caption' else C['accent'] if role == 'question' else C['ink']
                h = min(est_height(b['text'], size, w), max(0.3, max_h - (cy - y)))
                need = est_height(b['text'], size, w)
                top = cy
                if role == 'callout':
                    self.rule(slide, x, cy, min(w, 2.0), C['ink'])
                    top, h = cy + 0.12, h
                self.rich_box(slide, {'x': x, 'y': top, 'w': w, 'h': h}, [[(line, role == 'question', color)] for line in b['text'].split('\n')], size,
                              font=self.style['font_heading'] if role == 'question' else None)
                if role == 'callout':
                    h += 0.12
            if need > h * 1.25:
                rep['warnings'].append('likely overflow in block %s (confirm with render check)' % b.get('id', '?'))
            cy += h + gap
        if cy - y - gap > max_h * 1.25:
            rep['warnings'].append('text column taller than available space (%.2f > %.2f in)' % (cy - y - gap, max_h))
        return max(0.0, cy - y - gap)

    def e_table(self, slide, b, x, y, w, bottom, rep):
        S, C = self.sizes, self.colors()
        rows, cols = len(b['rows']) + 1, len(b['columns'])
        row_h = 0.72
        frame = slide.shapes.add_table(rows, cols, Inches(x), Inches(y), Inches(w), Inches(row_h * rows))
        tbl_pr = xp(frame._element, './/a:tblPr')[0]
        for attr in ('firstRow', 'bandRow', 'firstCol', 'lastRow', 'lastCol', 'bandCol'):
            tbl_pr.attrib.pop(attr, None)
        for node in xp(tbl_pr, './a:tableStyleId'):
            node.text = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}'  # "No Style, No Grid": journal rules are drawn per cell
        tbl = frame.table

        def border(tc_pr, tag, color, width):
            ln = etree.SubElement(tc_pr, A + tag, w=str(int(width * 12700)), cap='flat', cmpd='sng', algn='ctr')
            etree.SubElement(etree.SubElement(ln, A + 'solidFill'), A + 'srgbClr', val=color)
            etree.SubElement(ln, A + 'prstDash', val='solid')

        for i in range(rows):
            tbl.rows[i].height = Inches(row_h)
            for j in range(cols):
                value = b['columns'][j] if i == 0 else b['rows'][i - 1][j]
                cell = tbl.cell(i, j)
                cell.vertical_anchor = MSO_ANCHOR.MIDDLE
                cell.margin_left = cell.margin_right = Inches(0.12)
                cell.margin_top = cell.margin_bottom = Inches(0.06)
                tf = cell.text_frame
                tf.text = '' if value is None else str(value)
                par = tf.paragraphs[0]
                par.alignment = PP_ALIGN.RIGHT if numeric_column(b, j) else PP_ALIGN.LEFT
                for run in par.runs:
                    run.font.size = Pt(S['table'])
                    run.font.bold = i == 0
                    run.font.name = self.style['font_body']
                    run.font.color.rgb = RGBColor.from_string(C['ink'])
                tc_pr = cell._tc.get_or_add_tcPr()
                for tag in ('lnL', 'lnR'):
                    etree.SubElement(etree.SubElement(tc_pr, A + tag, w='0'), A + 'noFill')
                if i == 0:
                    border(tc_pr, 'lnT', C['ink'], 1.25)
                    border(tc_pr, 'lnB', C['ink'], 0.75)
                else:
                    etree.SubElement(etree.SubElement(tc_pr, A + 'lnT', w='0'), A + 'noFill')
                    last = i == rows - 1
                    border(tc_pr, 'lnB', C['ink'] if last else C['rule'], 1.25 if last else 0.5)
                etree.SubElement(tc_pr, A + 'noFill')
        height = row_h * rows
        if y + height > bottom + 0.05:
            rep['warnings'].append('table %s: ~%.2f in tall, may run into footer' % (b['id'], height))
        return height

    def e_chart(self, slide, b, x, y, w, h, bottom, rep):
        S, C = self.sizes, self.colors()
        kinds = {'bar': XL_CHART_TYPE.COLUMN_CLUSTERED, 'line': XL_CHART_TYPE.LINE_MARKERS, 'scatter': XL_CHART_TYPE.XY_SCATTER}
        if b['chart_type'] not in kinds:
            rep['warnings'].append('chart %s: chart_type "%s" not supported by the template engine yet; drawn as table' % (b['id'], b['chart_type']))
            fallback = {'id': b['id'], 'columns': ['Series'] + list(b.get('categories') or []), 'rows': [[s['name']] + list(s['values']) for s in b['series']]}
            return self.e_table(slide, fallback, x, y, w, bottom, rep)
        cats = b.get('categories') or [str(i + 1) for i in range(len(b['series'][0]['values']))]
        line = b['chart_type'] == 'line'
        direct = line and len(b['series']) <= 4
        label_w = 1.8 if direct else 0
        if b['chart_type'] == 'scatter':
            data = XyChartData()
            for s in b['series']:
                series = data.add_series(s['name'])
                for i, v in enumerate(s['values']):
                    if v is None:
                        continue
                    try:
                        px = float(cats[i])
                    except (ValueError, IndexError):
                        px = i + 1
                    series.add_data_point(px, v)
        else:
            data = CategoryChartData()
            data.categories = cats
            for s in b['series']:
                data.add_series(s['name'], s['values'])
        cw = w - label_w
        frame = slide.shapes.add_chart(kinds[b['chart_type']], Inches(x), Inches(y), Inches(cw), Inches(h), data)
        chart = frame.chart
        chart.font.size = Pt(16)
        chart.font.name = self.style['font_body']
        chart.font.color.rgb = RGBColor.from_string(C['muted'])
        chart.has_title = False
        chart.has_legend = not direct and len(b['series']) > 1
        if chart.has_legend:
            chart.legend.position = XL_LEGEND_POSITION.BOTTOM
            chart.legend.include_in_layout = False
            chart.legend.font.size = Pt(16)
            chart.legend.font.color.rgb = RGBColor.from_string(C['ink'])
        # Text sits next to lines, so line colours must be readable; fills may use the bright house colour.
        palette = [C['accent'], C['muted'], C['highlight'], C['ink']] if line else [C['brand'], C['accent'], C['highlight'], C['muted']]
        vmax = max([v for s in b['series'] for v in s['values'] if v is not None] or [1])
        step = 2 if vmax <= 10 else 10 if vmax <= 50 else 20 if vmax <= 100 else 10 ** int(len(str(int(vmax))) - 1)
        top = -(-(vmax * 1.05) // step) * step
        for i, series in enumerate(chart.plots[0].series):
            color = RGBColor.from_string(palette[i % len(palette)])
            if b['chart_type'] == 'bar':
                series.format.fill.solid()
                series.format.fill.fore_color.rgb = color
            else:
                series.smooth = False
                if line:
                    series.format.line.color.rgb = color
                    series.format.line.width = Pt(3)
                series.marker.format.fill.solid()
                series.marker.format.fill.fore_color.rgb = color
                series.marker.format.line.color.rgb = color
                series.marker.size = 7
        va, ca = chart.value_axis, chart.category_axis
        for axis, label in ((ca, b.get('x_label')), (va, b.get('y_label'))):
            axis.tick_labels.font.size = Pt(16)
            axis.tick_labels.font.color.rgb = RGBColor.from_string(C['muted'])
            if label:
                axis.has_title = True
                axis.axis_title.text_frame.text = label
                for run in axis.axis_title.text_frame.paragraphs[0].runs:
                    run.font.size = Pt(16)
                    run.font.bold = False
                    run.font.color.rgb = RGBColor.from_string(C['muted'])
        va.has_major_gridlines = True
        va.major_gridlines.format.line.color.rgb = RGBColor.from_string('E3E6E9')
        va.major_gridlines.format.line.width = Pt(0.5)
        va.format.line.fill.background()
        ca.format.line.color.rgb = RGBColor.from_string(C['ink'])
        ca.has_major_gridlines = False
        if b['chart_type'] != 'scatter':
            va.minimum_scale, va.maximum_scale, va.major_unit = 0, top, step
        plot = {'x': 0.1, 'y': 0.04, 'w': 0.86, 'h': 0.8}
        C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
        plot_area = chart._chartSpace.find('.//{%s}plotArea' % C_NS)
        for old in plot_area.findall('{%s}layout' % C_NS):
            plot_area.remove(old)
        layout = etree.Element('{%s}layout' % C_NS)
        manual = etree.SubElement(layout, '{%s}manualLayout' % C_NS)
        for tag, val in (('layoutTarget', 'inner'), ('xMode', 'edge'), ('yMode', 'edge'), ('x', plot['x']), ('y', plot['y']), ('w', plot['w']), ('h', plot['h'])):
            etree.SubElement(manual, '{%s}%s' % (C_NS, tag), val=str(val))
        plot_area.insert(0, layout)
        if direct:
            n = len(cats)
            labels = []
            for i, s in enumerate(b['series']):
                idx = max(k for k, v in enumerate(s['values']) if v is not None)
                labels.append({'i': i, 'name': s['name'], 'yy': y + h * (plot['y'] + plot['h'] * (1 - s['values'][idx] / top))})
            labels.sort(key=lambda item: item['yy'])
            for k in range(1, len(labels)):
                if labels[k]['yy'] - labels[k - 1]['yy'] < 0.38:
                    labels[k]['yy'] = labels[k - 1]['yy'] + 0.38
            lx = x + cw * (plot['x'] + plot['w'] * (1 - 0.5 / n)) + 0.15
            for item in labels:
                self.rich_box(slide, {'x': lx, 'y': item['yy'] - 0.2, 'w': label_w + 0.2, 'h': 0.4}, [[(item['name'], True, palette[item['i'] % len(palette)])]], 18, anchor=MSO_ANCHOR.MIDDLE)
            rep['warnings'].append('chart %s: direct labels are positioned geometrically; confirm alignment on the render' % b['id'])
        if b.get('data_origin') == 'digitized-from-figure':
            rep['warnings'].append('chart %s: digitized values; label as approximate' % b['id'])
        return h

    def e_visual(self, slide, b, x, y, w, h, bottom, rep):
        if b['type'] == 'figure':
            return self.figure(slide, b, {'x': x, 'y': y, 'w': w, 'h': h}, rep, caption_pt=self.sizes['small'])
        if b['type'] == 'chart':
            return self.e_chart(slide, b, x, y, w, h, bottom, rep)
        return self.e_table(slide, b, x, y, w, bottom, rep)

    def editorial(self, slide, s, rep, push, visuals, texts, stats):
        """ADR-0008 composition (same geometry as the default engine), drawn inside the template's content frame."""
        S, C = self.sizes, self.colors()
        f = self.map['frame']
        k = self.map['slide_size_inches']['width'] / 13.333
        M, CW = f['x'], f['w']
        top, bottom = f['y'] + push, min(f['y'] + f['h'], self.map.get('clear_bottom', 99))
        h = bottom - top
        layout = s['layout']
        head = self.style['font_heading']
        if layout == 'claim-figure':
            v0 = visuals[0] if visuals else None
            ratio = None
            if v0 and v0['type'] == 'figure' and v0.get('resolved_path'):
                px = PptxImage.from_file(v0['resolved_path']).size
                ratio = px[0] / px[1]
            if v0 and texts and ratio and ratio > 1.9:
                gap = 0.18
                minimum_image = h * 0.6
                figure_caption = 0.45 if v0.get('caption') else 0
                text_max = h - minimum_image - figure_caption - gap
                caption_pt = S['small']
                while caption_pt > 14 and self.e_measure(texts, CW, caption_pt=caption_pt, gap=0.1) > text_max:
                    caption_pt -= 1
                t_h = self.e_measure(texts, CW, caption_pt=caption_pt, gap=0.1)
                if t_h > text_max or CW / ratio < minimum_image:
                    raise SystemExit('Claim-figure slide %s cannot fit its captions while keeping the figure at least 60%% of the content height; split it in the spec and obtain storyboard approval again.' % s['id'])
                v_h = h - t_h - gap
                self.e_visual(slide, v0, M, top, CW, v_h, bottom, rep)
                self.e_stack(slide, texts, M, top + v_h + gap, CW, t_h, rep, caption_pt=caption_pt, gap=0.1)
                rep['figure_height_fraction'] = min(v_h - figure_caption, CW / ratio) / h
            elif v0 and texts:
                vw = min(8.4 * k, CW * 0.7)
                self.e_visual(slide, v0, M, top, vw, h, bottom, rep)
                self.e_stack(slide, texts, M + vw + 0.4, top + 0.2, CW - vw - 0.4, h - 0.2, rep)
            elif v0:
                self.e_visual(slide, v0, M, top, CW, h, bottom, rep)
            else:
                self.e_stack(slide, texts, M, top, CW, h, rep)
        elif layout == 'stat-card':
            if not stats:
                self.e_stack(slide, texts, M, top, CW, h, rep)
                return
            n = max(1, len(stats))
            panel_w = CW if n > 1 else min(CW, 7.6 * k)
            text_w = panel_w - 0.4
            gap = 0.15
            min_stat_h = 2.05 if any(' (' in b['value'] for b in stats) else 1.8
            bullet_pt = S['body']
            while texts and bullet_pt > 16 and self.e_measure(texts, text_w, bullet_pt=bullet_pt, gap=0.1, bullet_space=6) > h - min_stat_h - gap:
                bullet_pt -= 1
            text_h = self.e_measure(texts, text_w, bullet_pt=bullet_pt, gap=0.1, bullet_space=6) if texts else 0
            if text_h > h - min_stat_h - gap:
                raise SystemExit('Stat-card slide %s cannot fit the stat and text in the available height; split it in the spec and obtain storyboard approval again.' % s['id'])
            stat_h = min(3.5 * k, h - (text_h + gap if texts else 0))
            py = top + min(0.18, stat_h * 0.06)
            rule_y = top + stat_h - 0.62
            cw = panel_w / n
            for i, b in enumerate(stats):
                cx = M + i * cw
                cut = b['value'].find(' (')
                main, sub = (b['value'][:cut], b['value'][cut + 1:]) if cut > 0 else (b['value'], '')
                secondary = b.get('emphasis') == 'secondary'
                main_h = min(1.5, max(0.75, rule_y - py - (0.43 if sub else 0.1)))
                big = min(48 if secondary else S['stat'], int(main_h * 72 / 1.15))
                self.rich_box(slide, {'x': cx, 'y': py, 'w': cw - 0.4, 'h': main_h}, [[(main, True, C['accent'] if secondary else C['highlight'])]], big, font=head)
                if est_height(main, big, cw - 0.4) > main_h * 1.25:
                    rep['warnings'].append('likely overflow in stat %s (confirm with render check)' % b['id'])
                if sub:
                    self.rich_box(slide, {'x': cx, 'y': py + main_h + 0.04, 'w': cw - 0.4, 'h': 0.34}, [[(sub, False, C['ink'])]], min(S['stat_sub'], 20))
                self.rule(slide, cx, rule_y, min(cw - 0.4, 5.5), C['rule'])
                label_y = rule_y + 0.1
                label_h = top + stat_h - label_y - 0.04
                self.rich_box(slide, {'x': cx, 'y': label_y, 'w': cw - 0.4, 'h': label_h}, [[(b['label'], False, C['muted'])]], 20)
            if texts:
                self.e_stack(slide, texts, M, top + stat_h + gap, text_w, h - stat_h - gap, rep, bullet_pt=bullet_pt, gap=0.1, bullet_space=6)
            rep['stat_region_height'] = stat_h
        elif layout == 'comparison':
            if visuals:
                v0 = visuals[0]
                est = 0.75 * (len(v0['rows']) + 1) if v0['type'] == 'table' else h
                ty = top + max(0.2, (h - est - (self.e_measure(texts, CW) + 0.3 if texts else 0)) / 2)
                th = self.e_visual(slide, v0, M, ty, CW, h - (ty - top), bottom, rep) or 0
                if texts:
                    self.e_stack(slide, texts, M, ty + th + 0.3, CW, bottom - (ty + th + 0.3), rep)
            else:
                half = (CW - 0.5) / 2
                mid = -(-len(texts) // 2)
                self.e_stack(slide, texts[:mid], M, top, half, h, rep)
                self.e_stack(slide, texts[mid:], M + half + 0.5, top, half, h, rep)
        elif layout == 'question':
            q = [b for b in texts if b['type'] == 'question']
            rest = [b for b in texts if b['type'] != 'question']
            base = top + 0.65
            for i, b in enumerate(q):
                self.rich_box(slide, {'x': M, 'y': base + i * 1.6, 'w': CW - 2.0, 'h': 1.5}, [[(b['text'], False, C['accent'])]], S['question'], font=head, anchor=MSO_ANCHOR.MIDDLE)
                if est_height(b['text'], S['question'], CW - 2.0) > 1.5 * 1.25:
                    rep['warnings'].append('likely overflow in question %s (confirm with render check)' % b['id'])
            if rest:
                y = base + len(q) * 1.6 + 0.3
                self.e_stack(slide, rest, M, y, CW - 2.0, bottom - y, rep)
        elif layout == 'take-home':
            items = [it for b in texts for it in (b['items'] if b['type'] == 'bullets' else [{'text': b['text']}])]
            row_h = min(1.25, (h - 0.2) / max(1, len(items)))
            lead_w = 3.0 * k
            for i, it in enumerate(items):
                ry = top + 0.2 + i * row_h
                self.rule(slide, M, ry, CW, C['ink'] if i == 0 else C['rule'], 1 if i == 0 else 0.5)
                if it.get('lead'):
                    self.rich_box(slide, {'x': M, 'y': ry + 0.12, 'w': lead_w, 'h': row_h - 0.2}, [[(it['lead'], True, C['accent'])]], 20, font=head)
                off = lead_w + 0.2 if it.get('lead') else 0
                self.rich_box(slide, {'x': M + off, 'y': ry + 0.08, 'w': CW - off, 'h': row_h - 0.15}, [[(it['text'], False, C['ink'])]], S['take_home'])
                if est_height(it['text'], S['take_home'], CW - off) > (row_h - 0.15) * 1.25:
                    rep['warnings'].append('likely overflow in take-home item %d (confirm with render check)' % (i + 1))
        elif layout == 'section':
            pass
        elif layout == 'references':
            self.references(slide, s, {'x': M, 'y': top, 'w': CW, 'h': h}, rep)
        else:  # text, references and anything else
            if visuals:
                rep['warnings'].append('layout "%s" ignores visual blocks; use claim-figure' % layout)
            items = texts
            self.e_stack(slide, items, M, top, CW, h, rep)
        if len(visuals) > 1:
            rep['warnings'].append('%d visuals on one slide; only the first is placed (split the slide or use a multi-panel figure)' % len(visuals))

    # --- one slide ---
    @staticmethod
    def role_for(s, visuals, texts):
        layout = s['layout']
        if layout in ('title', 'section'):
            return layout
        if layout in ('claim-figure', 'comparison') and visuals:
            if layout == 'claim-figure' and texts:
                return 'text_visual'
            return {'chart': 'chart', 'table': 'table'}.get(visuals[0]['type'], 'title_only')
        if layout == 'stat-card':
            return 'title_only'
        return 'text'

    def add(self, s):
        blocks = s.get('blocks') or []
        visuals = [b for b in blocks if b['type'] in ('figure', 'chart', 'table')]
        texts = [b for b in blocks if b['type'] in ('text', 'bullets', 'question')]
        stats = [b for b in blocks if b['type'] == 'stat']
        role = self.role_for(s, visuals, texts)
        wide_figure_ratio = None
        if visuals and visuals[0]['type'] == 'figure' and visuals[0].get('resolved_path'):
            px = PptxImage.from_file(visuals[0]['resolved_path']).size
            wide_figure_ratio = px[0] / px[1]
        if not self.editorial_mode and role == 'text_visual' and wide_figure_ratio and wide_figure_ratio > 1.9:
            role = 'title_only'
        if self.editorial_mode and role not in ('title', 'section'):
            role = {'chart': 'chart', 'table': 'table'}.get(visuals[0]['type'] if visuals else None, 'title_only')
        entry = self.map['roles'][role]
        note = None
        editorial = self.editorial_mode and role != 'title'
        title_pt = self.sizes['title'] if editorial and role != 'section' else entry.get('title_pt', 28)
        constraint = entry.get('title_constraint')
        if constraint and role not in ('title', 'section'):
            floor = constraint.get('min_pt', 20)
            while title_pt > floor and len(s['title']) > int(0.85 * entry['title_box']['w'] * 72 / (title_pt * 0.62)):
                title_pt -= 1
        if role == 'text_visual' and not entry.get('body_box') and entry.get('title_box'):
            # Narrow text column: a long claim title or a long text does not fit. Keep the wording, change the layout.
            col = entry.get('body_default_box') or {'w': entry['title_box']['w'], 'h': self.map['frame']['h']}
            t_lines = wrapped_lines(s['title'], entry.get('title_pt', 28), entry['title_box']['w'])
            t_need = t_lines * entry.get('title_pt', 28) * 1.1 / 72
            b_pt = entry.get('body_pt') or self.style['body_pt']
            b_need = sum(est_height(line, b_pt, col['w']) + b_pt / 72 * 0.5 for line in self.plain_text(texts).split('\n'))
            if t_lines > 3 or t_need + b_need > col['h'] + entry['title_box']['h']:
                note = 'title or text too long for the narrow column of "%s"; used the wide text layout with the visual beside it' % entry['layout']
                entry = {**self.map['roles']['text'], **self.map['split']}
                role = 'text_visual_split'
        layout = self.layout_for(entry)
        slide = self.prs.slides.add_slide(layout)
        rep = {'id': s['id'], 'layout': s['layout'], 'template_layout': layout.name, 'role': role, 'editable': 'native', 'raster_elements': [], 'warnings': []}
        used = set()
        if note:
            rep['layout_note'] = note

        # Shrink a one-line title before wrapping; the template's fixed rule cannot move.
        push = 0.0
        tbox = entry.get('title_box')
        if constraint and role not in ('title', 'section'):
            budget = max(1, int(0.85 * tbox['w'] * 72 / (title_pt * 0.62)))
            if len(s['title']) > budget:
                rep['warnings'].append('title has %d characters; one-line template budget is ~%d at %d pt (floor reached; review the storyboard wording)' % (len(s['title']), budget, title_pt))
            elif title_pt < (self.sizes['title'] if editorial else entry.get('title_pt', 28)):
                rep['warnings'].append('one-line title reduced to %d pt to stay above fixed decoration' % title_pt)
        full_width_title = role not in ('title', 'section', 'text_visual')
        if tbox and full_width_title:
            lines = wrapped_lines(s['title'], title_pt, tbox['w'])
            top = self.map['frame']['y'] if editorial else (entry.get('body_box') or entry.get('content_area') or self.map['frame'])['y']
            push = round(max(0.0, tbox['y'] + lines * title_pt * 1.1 / 72 + 0.2 - top), 3)
            if lines > 3:
                rep['warnings'].append('title wraps to ~%d lines in this template; consider a shorter title' % lines)
        elif tbox and role == 'text_visual':
            lines = wrapped_lines(s['title'], entry.get('title_pt', 28), tbox['w'])
            top = (entry.get('body_default_box') or self.map['frame'])['y']
            push = round(max(0.0, tbox['y'] + lines * entry.get('title_pt', 28) * 1.1 / 72 + 0.2 - top), 3)

        def down(box, apply=True):
            return {**box, 'y': round(box['y'] + push, 3), 'h': round(max(0.5, box['h'] - push), 3)} if box and apply and push else box

        title = self.ph(slide, entry.get('title'))
        if title is not None:
            title.text_frame.text = s['title']
            used.add(entry['title'])
            if (editorial and role != 'section') or constraint:
                for run in title.text_frame.paragraphs[0].runs:
                    run.font.size = Pt(title_pt)
        else:
            rep['warnings'].append('template layout "%s" has no title placeholder; slide title not shown' % layout.name)
        if s.get('section') and role not in ('title', 'section'):
            if editorial and tbox and tbox['y'] >= 0.6:
                kicker = self.rich_box(slide, {'x': tbox['x'], 'y': round(tbox['y'] - 0.36, 3), 'w': tbox['w'], 'h': 0.3},
                                       [[(s['section'].upper(), True, self.style['accent_text'])]], self.sizes['kicker'])
                for rpr in xp(kicker._element, './/a:rPr'):
                    rpr.set('spc', '200')
            else:
                rep.setdefault('not_shown', []).append('section label')

        body_pt = entry.get('body_pt') or self.style['body_pt']
        area = down(entry.get('content_area'))

        def fill_body(items, box=None):
            body = self.ph(slide, entry.get('body'))
            if body is None:
                return False
            box = down(box or (entry.get('body_default_box') if push else None))
            if box:
                body.left, body.top, body.width, body.height = (Inches(box[k]) for k in ('x', 'y', 'w', 'h'))
            self.write_paragraphs(body, self.paragraphs(items, body_pt))
            used.add(entry['body'])
            size = box or self.ph_size(layout, entry['body']) or self.map['frame']
            need = sum(est_height(line, body_pt, size['w']) + body_pt / 72 * 0.5 for line in self.plain_text(items).split('\n'))
            if need > size['h'] * 1.25:
                rep['warnings'].append('likely overflow in body text: needs ~%.2f in, placeholder %.2f in (confirm with render check)' % (need, size['h']))
            return True

        def text_below(items, y):
            if not items:
                return
            box = {'x': area['x'], 'y': y, 'w': area['w'], 'h': max(0.4, area['y'] + area['h'] - y)}
            pt = max(16, body_pt)
            self.textbox(slide, box, self.plain_text(items), pt)
            if est_height(self.plain_text(items), pt, box['w']) > box['h'] * 1.25:
                rep['warnings'].append('text under the visual likely overflows (confirm with render check)')

        if editorial:
            self.editorial(slide, s, rep, push, visuals, texts, stats)
        elif role == 'title':
            occasion = s.get('occasion') or s.get('subtitle') or s.get('venue') or ''
            names = ', '.join(p.get('name') for p in s.get('presenters') or [] if p.get('name'))
            sub = self.ph(slide, entry.get('subtitle'))
            sbox, spt = entry.get('subtitle_box'), entry.get('subtitle_pt', 18)
            required = '  ·  '.join(x for x in (occasion, names) if x)
            options = [[x for x in (required, s.get('key_question')) if x], [required]]
            options = [o for o in options if o and all(o)]
            lines = []
            for pt in range(int(spt), 11, -1):
                max_lines = max(1, int(sbox['h'] / (pt * 1.2 / 72))) if sbox else 2
                lines = next((o for o in options if sbox is None or
                              (len(o) <= max_lines and sum(wrapped_lines(line, pt, sbox['w']) for line in o) <= max_lines)), [])
                if lines:
                    spt = pt
                    break
            if not lines and required:
                lines, spt = [required], 12
                rep['warnings'].append('occasion and presenter line may overflow the title subtitle; review in PowerPoint')
            if sub is not None and lines:
                if sbox:
                    sub.left, sub.top, sub.width, sub.height = (Inches(sbox[k]) for k in ('x', 'y', 'w', 'h'))
                self.write_paragraphs(sub, [{'kind': 'plain', 'runs': [(line, False)]} for line in lines], keep_style=True)
                for para in sub.text_frame.paragraphs:
                    for run in para.runs:
                        run.font.size = Pt(spt)
                used.add(entry['subtitle'])
                if s.get('key_question') and s['key_question'] not in lines:
                    rep.setdefault('not_shown', []).append('key question on the title slide (subtitle space is insufficient)')
                if required and required not in '\n'.join(lines):
                    rep.setdefault('not_shown', []).append('occasion or presenter line on the title slide (subtitle space is insufficient)')
            if texts:
                rep.setdefault('not_shown', []).append('title-slide kicker text (this layout has no placeholder for it)')
        elif role == 'section':
            pass
        elif s['layout'] == 'references':
            self.references(slide, s, area, rep)
        elif role in ('text_visual', 'text_visual_split'):
            if not fill_body(texts, entry.get('body_box')):
                rep['warnings'].append('no body placeholder on "%s"; text blocks not placed' % layout.name)
            self.visual(slide, visuals[0], down(entry['visual_area'], role == 'text_visual_split'), rep)
        elif role in ('title_only', 'chart', 'table'):
            if stats:
                panel_w = area['w'] if len(stats) > 1 else min(area['w'], 7.6)
                text_w = panel_w - 0.4
                gap = 0.15
                min_stat_h = 2.05 if any(' (' in b['value'] for b in stats) else 1.8
                bullet_pt = body_pt
                while texts and bullet_pt > 16 and self.e_measure(texts, text_w, bullet_pt=bullet_pt, body_pt=body_pt, gap=0.1, bullet_space=6) > area['h'] - min_stat_h - gap:
                    bullet_pt -= 1
                text_h = self.e_measure(texts, text_w, bullet_pt=bullet_pt, body_pt=body_pt, gap=0.1, bullet_space=6) if texts else 0
                if text_h > area['h'] - min_stat_h - gap:
                    raise SystemExit('Stat-card slide %s cannot fit the stat and text in the available height; split it in the spec and obtain storyboard approval again.' % s['id'])
                stat_h = min(3.5, area['h'] - (text_h + gap if texts else 0))
                self.stats(slide, stats, area, stat_h, rep)
                if texts:
                    self.e_stack(slide, texts, area['x'], area['y'] + stat_h + gap, text_w, area['h'] - stat_h - gap, rep,
                                 bullet_pt=bullet_pt, body_pt=body_pt, gap=0.1, bullet_space=6)
                rep['stat_region_height'] = stat_h
            elif visuals:
                v = visuals[0]
                box = dict(area)
                if texts and v['type'] == 'figure' and wide_figure_ratio and wide_figure_ratio > 1.9:
                    gap = 0.18
                    minimum_image = area['h'] * 0.6
                    figure_caption = 0.45 if v.get('caption') else 0
                    text_max = area['h'] - minimum_image - figure_caption - gap
                    caption_pt = self.sizes['small']
                    while caption_pt > 14 and self.e_measure(texts, area['w'], caption_pt=caption_pt, body_pt=body_pt, gap=0.1) > text_max:
                        caption_pt -= 1
                    text_h = self.e_measure(texts, area['w'], caption_pt=caption_pt, body_pt=body_pt, gap=0.1)
                    if text_h > text_max or area['w'] / wide_figure_ratio < minimum_image:
                        raise SystemExit('Claim-figure slide %s cannot fit its captions while keeping the figure at least 60%% of the content height; split it in the spec and obtain storyboard approval again.' % s['id'])
                    box['h'] = area['h'] - text_h - gap
                    self.visual(slide, v, box, rep)
                    self.e_stack(slide, texts, area['x'], box['y'] + box['h'] + gap, area['w'], text_h, rep,
                                 caption_pt=caption_pt, body_pt=body_pt, gap=0.1)
                    rep['figure_height_fraction'] = min(box['h'] - figure_caption, area['w'] / wide_figure_ratio) / area['h']
                else:
                    if texts and v['type'] != 'table':
                        reserve = min(area['h'] * 0.35, est_height(self.plain_text(texts), max(16, body_pt), area['w']) + 0.2)
                        box['h'] = area['h'] - reserve - 0.3
                    visual_h = self.visual(slide, v, box, rep)
                    text_below(texts, box['y'] + visual_h + 0.3)
            else:
                text_below(texts, area['y'])
        else:  # text
            if visuals:
                rep['warnings'].append('layout "%s" ignores visual blocks; use claim-figure' % s['layout'])
            items = texts
            if s['layout'] == 'references' and not texts:
                items = [{'type': 'text', 'text': c} for c in s.get('reference_list') or []]
            if items and not fill_body(items):
                rep['warnings'].append('no body placeholder on "%s"; text blocks not placed' % layout.name)
        if len(visuals) > 1 and not editorial:
            rep['warnings'].append('%d visuals on one slide; only the first is placed (split the slide or use a multi-panel figure)' % len(visuals))

        # Unfilled placeholders would show prompt text or an inherited fill: remove them from the slide.
        for ph in list(slide.placeholders):
            if ph.placeholder_format.idx not in used:
                ph._element.getparent().remove(ph._element)

        if role != 'title':
            self.copy_slide_number(slide, layout)
            cites = s.get('citations') or []
            if cites:
                f = dict(entry['footer'])
                text = '; '.join(cites)
                self.textbox(slide, f, text, self.sizes['footer'], color=self.style['muted'], anchor=MSO_ANCHOR.MIDDLE)
                if est_height(text, self.sizes['footer'], f['w']) > 0.6:
                    rep['warnings'].append('citation footer likely needs more than one line (confirm with render check)')
        elif s.get('citations'):
            rep.setdefault('not_shown', []).append('citations on the title slide (kept in speaker notes)')

        if s.get('notes'):
            slide.notes_slide.notes_text_frame.text = s['notes']
        if s.get('shows_review_claim'):
            rep['warnings'].append('shows a needs-expert-review claim (flagged in speaker notes)')
        self.report['slides'].append(rep)

    @staticmethod
    def ph_size(layout, idx):
        for ph in layout.placeholders:
            if ph.placeholder_format.idx == idx and ph.width is not None:
                return {'w': inch(ph.width), 'h': inch(ph.height)}
        return None

    @staticmethod
    def copy_slide_number(slide, layout):
        for ph in layout.placeholders:
            if ph.placeholder_format.type == PP_PLACEHOLDER.SLIDE_NUMBER:
                el = copy.deepcopy(ph._element)
                ids = [int(i) for i in xp(slide._element, './/p:cNvPr/@id')]
                xp(el, './p:nvSpPr/p:cNvPr')[0].set('id', str(max(ids + [1]) + 1))
                slide.shapes._spTree.append(el)
                return

    def run(self):
        removed = self.clear_slides()
        for s in self.plan['slides']:
            self.add(s)
        self.report['template']['sample_slides_removed'] = removed
        self.report['template']['notes'] = self.map.get('notes', [])
        not_shown = sorted({item for s in self.report['slides'] for item in s.get('not_shown', [])})
        self.report['limitations'] += [
            'Template-fill engine (experimental): typefaces, colours, logos and backgrounds come from the template file, not from the spec design tokens.',
            ('Typography: editorial type scale and composition of the default engine (ADR-0008) on the template\'s own layouts; content is drawn as native text boxes, not in body placeholders.'
             if self.editorial_mode else 'Typography: the template\'s own placeholder sizes and bullets.'),
            'Animation intent is written to speaker notes; this engine does not create PowerPoint animations.',
            'Text fit is estimated geometrically; confirm with the rendered check.',
            'Figures are placed as images and are not editable; their origin is listed per slide.',
        ] + (['Not shown in this template: %s.' % '; '.join(not_shown)] if not_shown else [])
        slides = self.report['slides']
        self.report['summary'] = {
            'slides': len(slides),
            'fully_native': sum(1 for x in slides if x['editable'] == 'native'),
            'with_raster': sum(1 for x in slides if x['editable'] == 'partial'),
            'warnings': sum(len(x['warnings']) for x in slides),
        }
        self.prs.core_properties.title = self.plan.get('title') or ''
        self.prs.core_properties.author = self.plan.get('author') or ''
        self.prs.core_properties.subject = self.plan.get('subject') or ''
        self.prs.save(self.plan['out'])
        return self.report


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p_inspect = sub.add_parser('inspect')
    p_inspect.add_argument('template')
    p_inspect.add_argument('--out')
    p_fill = sub.add_parser('fill')
    p_fill.add_argument('plan')
    args = parser.parse_args()
    if args.command == 'inspect':
        text = json.dumps(inspect(args.template), indent=2, ensure_ascii=False) + '\n'
        if args.out:
            open(args.out, 'w', encoding='utf8').write(text)
        else:
            sys.stdout.write(text)
        return
    plan = json.load(open(args.plan, encoding='utf8'))
    json.dump(Filler(plan).run(), sys.stdout, indent=2, ensure_ascii=False)


if __name__ == '__main__':
    main()
