#!/usr/bin/env python3
"""Extract a small, explicit house-style subset from a PPTX/POTX OOXML package."""

import argparse
import hashlib
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"
EMU = 914400
FORMAT = "academic-presenting-house-style-v1"


def tag(ns, name):
    return f"{{{ns}}}{name}"


def xml(package, name):
    return ET.fromstring(package.read(name))


def inches(value):
    return round(int(value) / EMU, 4)


def color(element, scheme):
    if element is None:
        return None
    direct = element.find(tag(A, "srgbClr"))
    if direct is not None:
        return direct.get("val", "").upper() or None
    system = element.find(tag(A, "sysClr"))
    if system is not None:
        return system.get("lastClr", "").upper() or None
    reference = element.find(tag(A, "schemeClr"))
    if reference is not None:
        return scheme.get(reference.get("val"))
    return None


def relationships(package, part):
    rels_name = posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")
    if rels_name not in package.namelist():
        return {}
    result = {}
    for rel in xml(package, rels_name).findall(tag(PKG, "Relationship")):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target", "")
        resolved = posixpath.normpath(posixpath.join(posixpath.dirname(part), target))
        if resolved.startswith("../") or resolved.startswith("/"):
            continue
        result[rel.get("Id")] = {"target": resolved, "type": rel.get("Type", "")}
    return result


def geometry(element):
    transform = element.find(f".//{tag(A, 'xfrm')}")
    if transform is None:
        return None
    offset = transform.find(tag(A, "off"))
    extent = transform.find(tag(A, "ext"))
    if offset is None or extent is None:
        return None
    return {"x": inches(offset.get("x")), "y": inches(offset.get("y")),
            "w": inches(extent.get("cx")), "h": inches(extent.get("cy"))}


def extract(template, output, selected_logo=None, layout_number=None):
    if template.suffix.lower() not in {".pptx", ".potx"}:
        raise ValueError("Expected a .pptx or .potx template")
    if output.exists():
        raise ValueError(f"Output directory already exists: {output}")
    raw = template.read_bytes()
    with zipfile.ZipFile(template) as package:
        entries = package.infolist()
        if len(entries) > 5000 or sum(item.file_size for item in entries) > 200_000_000:
            raise ValueError("Template package exceeds the import size limit")
        names = set(package.namelist())
        if "ppt/presentation.xml" not in names:
            raise ValueError("Not a PowerPoint OOXML package")
        presentation = xml(package, "ppt/presentation.xml")
        slide_size = presentation.find(tag(P, "sldSz"))
        if slide_size is None:
            raise ValueError("Presentation slide size is missing")
        width, height = inches(slide_size.get("cx")), inches(slide_size.get("cy"))
        masters = sorted(name for name in names if re.fullmatch(r"ppt/slideMasters/slideMaster\d+\.xml", name))
        if not masters:
            raise ValueError("No slide master found")
        warnings = []
        if len(masters) > 1:
            warnings.append(f"Found {len(masters)} slide masters; only the first is imported")
        master_part = masters[0]
        rels = relationships(package, master_part)
        theme_part = next((item["target"] for item in rels.values() if item["type"].endswith("/theme") and item["target"] in names), None)
        if not theme_part:
            theme_part = next((name for name in sorted(names) if re.fullmatch(r"ppt/theme/theme\d+\.xml", name)), None)
            if theme_part:
                warnings.append("Master theme relationship missing; using the first theme")
        scheme = {}
        fonts = {}
        if theme_part:
            theme = xml(package, theme_part)
            scheme_element = theme.find(f".//{tag(A, 'clrScheme')}")
            if scheme_element is not None:
                for item in scheme_element:
                    value = color(item, {})
                    if value:
                        scheme[item.tag.rsplit("}", 1)[-1]] = value
            for key, node in [("heading", "majorFont"), ("body", "minorFont")]:
                latin = theme.find(f".//{tag(A, node)}/{tag(A, 'latin')}")
                if latin is not None and latin.get("typeface"):
                    fonts[key] = latin.get("typeface")
        else:
            warnings.append("No theme found; fonts and theme colors are unavailable")

        master = xml(package, master_part)
        background = color(master.find(f"./{tag(P, 'cSld')}/{tag(P, 'bg')}/{tag(P, 'bgPr')}/{tag(A, 'solidFill')}"), scheme)
        background = background or scheme.get("lt1")
        layout_part = f"ppt/slideLayouts/slideLayout{layout_number}.xml" if layout_number else None
        if layout_part and layout_part not in names:
            raise ValueError(f"Slide layout not found: {layout_number}")
        bars, image_candidates = [], []
        unsupported = 0
        for part in [master_part] + ([layout_part] if layout_part else []):
            part_xml = xml(package, part)
            part_background = color(part_xml.find(f"./{tag(P, 'cSld')}/{tag(P, 'bg')}/{tag(P, 'bgPr')}/{tag(A, 'solidFill')}"), scheme)
            if part_background:
                background = part_background
            shape_tree = part_xml.find(f"./{tag(P, 'cSld')}/{tag(P, 'spTree')}")
            rels = relationships(package, part)
            if shape_tree is None:
                continue
            for element in shape_tree:
                if element.tag == tag(P, "sp"):
                    if element.find(f"./{tag(P, 'nvSpPr')}/{tag(P, 'nvPr')}/{tag(P, 'ph')}") is not None:
                        continue
                    props = element.find(tag(P, "spPr"))
                    geom = geometry(props) if props is not None else None
                    preset = props.find(f"./{tag(A, 'prstGeom')}") if props is not None else None
                    fill = color(props.find(tag(A, "solidFill")), scheme) if props is not None else None
                    if geom and preset is not None and preset.get("prst") == "rect" and fill:
                        at_top = geom["y"] <= 0.6
                        at_bottom = geom["y"] + geom["h"] >= height - 0.6
                        if geom["w"] >= width * 0.6 and geom["h"] <= 1.0 and (at_top or at_bottom) and geom["y"] + geom["h"] > 0:
                            bars.append({**geom, "color": fill})
                        elif geom["w"] >= width * 0.95 and geom["h"] >= height * 0.95:
                            background = fill
                        else:
                            unsupported += 1
                    else:
                        unsupported += 1
                elif element.tag == tag(P, "pic"):
                    geom = geometry(element.find(tag(P, "spPr")))
                    blip = element.find(f".//{tag(A, 'blip')}")
                    rid = blip.get(tag(R, "embed")) if blip is not None else None
                    item = rels.get(rid)
                    if not geom or not item or item["target"] not in names:
                        unsupported += 1
                        continue
                    extension = posixpath.splitext(item["target"])[1].lower()
                    if extension not in {".png", ".jpg", ".jpeg"}:
                        warnings.append(f"Unsupported fixed image format in {part}: {extension or 'unknown'}")
                        continue
                    near_edge = geom["x"] < 1.0 or geom["x"] + geom["w"] > width - 1.0 or geom["y"] < 1.0 or geom["y"] + geom["h"] > height - 1.0
                    if geom["w"] * geom["h"] <= width * height * 0.1 and near_edge:
                        image_candidates.append({"id": f"{posixpath.basename(part).removesuffix('.xml')}:{rid}", "source": item["target"], **geom})
                    else:
                        unsupported += 1

        if unsupported:
            warnings.append(f"{unsupported} element(s) were outside the supported fixed-bar/logo subset")
        if selected_logo:
            selected = next((item for item in image_candidates if item["id"] == selected_logo), None)
            if not selected:
                raise ValueError(f"Logo candidate not found: {selected_logo}")
        elif len(image_candidates) == 1:
            selected = image_candidates[0]
        else:
            selected = None
            if len(image_candidates) > 1:
                warnings.append(f"Found {len(image_candidates)} logo candidates; choose one with --logo-id")
            else:
                warnings.append("No supported edge logo found in the selected master/layout")

        output.mkdir(parents=True)
        logo = None
        if selected:
            data = package.read(selected["source"])
            extension = posixpath.splitext(selected["source"])[1].lower()
            asset_name = f"logo-{hashlib.sha256(data).hexdigest()[:12]}{extension}"
            (output / asset_name).write_bytes(data)
            logo = {key: value for key, value in selected.items() if key != "source"}
            logo["file"] = asset_name

    tokens = {"colors": {}}
    if fonts.get("heading"):
        tokens["font_heading"] = fonts["heading"]
    if fonts.get("body"):
        tokens["font_body"] = fonts["body"]
    for target, source in [("background", "lt1"), ("ink", "dk1"), ("accent", "accent1"), ("highlight", "accent2")]:
        if scheme.get(source):
            tokens["colors"][target] = scheme[source]
    if background:
        tokens["colors"]["background"] = background
    manifest = {
        "format": FORMAT,
        "source_file": template.name,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "slide_size_inches": {"width": width, "height": height},
        "master_part": master_part,
        "layout_part": layout_part,
        "theme_part": theme_part,
        "scheme_colors": scheme,
        "design_tokens": tokens,
        "master": {"background": background, "bars": bars, "logo": logo},
        "logo_candidates": [{key: value for key, value in item.items() if key != "source"} for item in image_candidates],
        "warnings": warnings,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("template", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--logo-id")
    parser.add_argument("--layout", type=int, help="1-based slide layout number to include with the first master")
    args = parser.parse_args()
    try:
        manifest = extract(args.template, args.out, args.logo_id, args.layout)
    except (OSError, ValueError, zipfile.BadZipFile, ET.ParseError) as error:
        print(f"Template import failed: {error}", file=sys.stderr)
        return 1
    print(f"Manifest: {args.out / 'manifest.json'}")
    print(f"Master: {len(manifest['master']['bars'])} fixed bar(s), {'logo selected' if manifest['master']['logo'] else 'no logo selected'}")
    for warning in manifest["warnings"]:
        print(f"WARNING: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
