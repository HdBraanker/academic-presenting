#!/usr/bin/env python3
"""Inspect slide OOXML for geometry, explicit font sizes, and source text.

Python's standard-library XML and ZIP parsers are a better fit for reading PPTX
than regex-based XML inspection in the Node render orchestrator.
"""

from __future__ import annotations

import argparse
import json
import posixpath
import sys
import zipfile
from xml.etree import ElementTree as ET

EMU_PER_INCH = 914400
NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "rel": "http://schemas.openxmlformats.org/package/2006/relationships",
}


def slide_paths(archive: zipfile.ZipFile, presentation: ET.Element) -> list[str]:
    rels = ET.fromstring(archive.read("ppt/_rels/presentation.xml.rels"))
    targets = {
        item.get("Id"): item.get("Target")
        for item in rels.findall("rel:Relationship", NS)
    }
    result = []
    for item in presentation.findall("p:sldIdLst/p:sldId", NS):
        relation_id = item.get(f"{{{NS['r']}}}id")
        target = targets.get(relation_id)
        if not target:
            raise ValueError(f"Missing slide relationship: {relation_id}")
        if target.startswith("/"):
            path = target.lstrip("/")
        else:
            path = posixpath.normpath(posixpath.join("ppt", target))
        if not path.startswith("ppt/slides/"):
            raise ValueError(f"Unexpected slide path: {path}")
        result.append(path)
    return result


def shape_name(shape: ET.Element) -> str:
    c_nv_pr = shape.find(".//p:cNvPr", NS)
    return c_nv_pr.get("name", "unnamed") if c_nv_pr is not None else "unnamed"


def shape_transform(shape: ET.Element) -> tuple[int, int, int, int] | None:
    for path in ("p:spPr/a:xfrm", "p:xfrm", "p:grpSpPr/a:xfrm"):
        xfrm = shape.find(path, NS)
        if xfrm is None:
            continue
        off = xfrm.find("a:off", NS)
        ext = xfrm.find("a:ext", NS)
        if off is not None and ext is not None:
            return (
                int(off.get("x", "0")),
                int(off.get("y", "0")),
                int(ext.get("cx", "0")),
                int(ext.get("cy", "0")),
            )
    return None


def explicit_font_sizes(shape: ET.Element) -> tuple[list[float], int]:
    sizes = []
    unknown_runs = 0
    for paragraph in shape.findall(".//a:p", NS):
        default = paragraph.find("a:pPr/a:defRPr", NS)
        default_size = default.get("sz") if default is not None else None
        for run in list(paragraph):
            if run.tag not in (f"{{{NS['a']}}}r", f"{{{NS['a']}}}fld"):
                continue
            text = run.find("a:t", NS)
            if text is None or not (text.text or "").strip():
                continue
            properties = run.find("a:rPr", NS)
            value = properties.get("sz") if properties is not None else None
            value = value or default_size
            if value:
                sizes.append(int(value) / 100)
            else:
                unknown_runs += 1
    return sizes, unknown_runs


def inspect(pptx_path: str, min_font_pt: float) -> dict:
    findings = []
    approved_small_type = []
    slides = []
    with zipfile.ZipFile(pptx_path) as archive:
        presentation = ET.fromstring(archive.read("ppt/presentation.xml"))
        size = presentation.find("p:sldSz", NS)
        if size is None:
            raise ValueError("PowerPoint file has no slide size")
        slide_width = int(size.get("cx", "0"))
        slide_height = int(size.get("cy", "0"))
        if slide_width <= 0 or slide_height <= 0:
            raise ValueError("PowerPoint slide size is invalid")

        for index, path in enumerate(slide_paths(archive, presentation), start=1):
            root = ET.fromstring(archive.read(path))
            shape_count = 0
            unchecked_geometry = 0
            unchecked_font_runs = 0
            text_parts = []
            text_shapes = []
            shape_tree = root.find(".//p:spTree", NS)
            if shape_tree is None:
                raise ValueError(f"Slide has no shape tree: {path}")
            group_count = len(shape_tree.findall("p:grpSp", NS))
            checked_tags = {
                f"{{{NS['p']}}}sp",
                f"{{{NS['p']}}}pic",
                f"{{{NS['p']}}}graphicFrame",
                f"{{{NS['p']}}}cxnSp",
            }

            for shape in (item for item in shape_tree if item.tag in checked_tags):
                shape_count += 1
                name = shape_name(shape)
                shape_text = " ".join((item.text or "") for item in shape.findall(".//a:t", NS))
                text_parts.append(shape_text)
                transform = shape_transform(shape)
                if transform is None:
                    unchecked_geometry += 1
                else:
                    x, y, width, height = transform
                    tolerance = int(0.02 * EMU_PER_INCH)
                    if width < 0 or height < 0 or x < -tolerance or y < -tolerance or x + width > slide_width + tolerance or y + height > slide_height + tolerance:
                        findings.append({
                            "code": "out_of_bounds",
                            "severity": "warning",
                            "slide": index,
                            "element": name,
                            "message": "Shape extends outside the slide canvas; inspect for clipping or intentional bleed.",
                            "bounds_inches": [round(v / EMU_PER_INCH, 3) for v in transform],
                        })
                    if shape.tag == f"{{{NS['p']}}}sp" and shape_text.strip():
                        text_shapes.append({
                            "element": name,
                            "text": shape_text,
                            "bounds_points": [round(v * 72 / EMU_PER_INCH, 3) for v in transform],
                        })
                sizes, unknown = explicit_font_sizes(shape)
                unchecked_font_runs += unknown
                for size_pt in sorted(set(sizes)):
                    if size_pt < min_font_pt:
                        y_inches = transform[1] / EMU_PER_INCH if transform else None
                        is_footer = y_inches is not None and y_inches >= slide_height / EMU_PER_INCH - 0.65 and size_pt >= 12
                        is_kicker = y_inches is not None and y_inches <= 0.5 and shape_text.strip().isupper() and size_pt >= 13
                        if is_footer or is_kicker:
                            approved_small_type.append({
                                "slide": index,
                                "element": name,
                                "size_pt": size_pt,
                                "role_inferred_from_geometry": "footer" if is_footer else "section_kicker",
                                "basis": "ADR-0008",
                            })
                        else:
                            findings.append({
                                "code": "small_font",
                                "severity": "warning",
                                "slide": index,
                                "element": name,
                                "message": f"Explicit text size {size_pt:g} pt is below the {min_font_pt:g} pt review target.",
                                "size_pt": size_pt,
                            })

            # Chart text may live in related chart parts, rather than slide XML.
            slides.append({
                "index": index,
                "source_text": " ".join(text_parts),
                "text_shapes": text_shapes,
                "shape_count": shape_count,
                "unchecked_geometry": unchecked_geometry,
                "unchecked_font_runs": unchecked_font_runs,
                "nested_groups": group_count,
            })

    return {
        "slide_count": len(slides),
        "canvas_inches": [round(slide_width / EMU_PER_INCH, 3), round(slide_height / EMU_PER_INCH, 3)],
        "slides": slides,
        "findings": findings,
        "approved_small_type": approved_small_type,
        "limitations": [
            "OOXML geometry checks do not resolve nested group transforms or chart internals.",
            "Font checks cover explicit run or paragraph sizes; inherited theme sizes are unassessed.",
            "Text embedded in raster figures or chart parts is not covered by the font-size or PDF-text comparison checks.",
            "ADR-0008 footer and section-kicker exceptions are inferred from position and casing; inspect them visually.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pptx", help="PowerPoint file to inspect")
    parser.add_argument("--min-font", type=float, default=14.0)
    args = parser.parse_args()
    if args.min_font <= 0:
        parser.error("--min-font must be positive")
    try:
        json.dump(inspect(args.pptx, args.min_font), sys.stdout, ensure_ascii=False)
        print()
        return 0
    except (OSError, ValueError, KeyError, ET.ParseError, zipfile.BadZipFile) as exc:
        print(f"PPTX inspection failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
