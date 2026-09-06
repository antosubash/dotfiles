"""Figma design-tree summarizing, manifest saving, and render validation."""

import json
from pathlib import Path
from urllib.parse import urlsplit
import xml.etree.ElementTree as ET

from figma_client import FigmaError, private_file

SUMMARY_FIELDS = (
    "id", "name", "type", "visible", "absoluteBoundingBox", "relativeTransform",
    "constraints", "layoutMode", "layoutWrap", "layoutSizingHorizontal",
    "layoutSizingVertical", "primaryAxisSizingMode", "counterAxisSizingMode",
    "primaryAxisAlignItems", "counterAxisAlignItems", "itemSpacing",
    "counterAxisSpacing", "paddingLeft", "paddingRight", "paddingTop",
    "paddingBottom", "layoutGrow", "layoutAlign", "layoutPositioning",
    "fills", "strokes", "strokeWeight", "strokeAlign", "effects", "opacity",
    "blendMode", "cornerRadius", "rectangleCornerRadii", "clipsContent",
    "characters", "style", "styles", "boundVariables", "componentId",
    "componentProperties", "exportSettings", "annotations",
)


def save_json(path, data):
    with private_file(path) as output:
        json.dump(data, output, indent=2, ensure_ascii=False)
        output.write("\n")


def mapping(value, label):
    if not isinstance(value, dict):
        raise FigmaError(f"Malformed Figma response: expected an object for {label}.")
    return value


def walk(root):
    stack = [(root, None)]
    while stack:
        node, parent = stack.pop()
        mapping(node, "node")
        children = node.get("children", [])
        if not isinstance(children, list) or not isinstance(node.get("characters", ""), str):
            raise FigmaError("Malformed Figma response: invalid node children or text.")
        yield node, parent
        stack.extend((child, node.get("id")) for child in reversed(children))


def image_refs(root):
    refs = set()
    stack = [root]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            if isinstance(value.get("imageRef"), str):
                refs.add(value["imageRef"])
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
    return sorted(refs)


def summarize(root, limit=200):
    nodes = []
    total = 0
    for node, parent in walk(root):
        total += 1
        if len(nodes) >= limit:
            continue
        entry = {key: node[key] for key in SUMMARY_FIELDS if key in node}
        entry["parentId"] = parent
        if len(entry.get("characters", "")) > 2000:
            entry["characters"] = entry["characters"][:2000]
            entry["textTruncated"] = True
        nodes.append(entry)
    return {"nodeCount": total, "nodesTruncated": total > limit, "nodes": nodes,
            "imageRefs": image_refs(root)}


def get_document(data, node):
    if node:
        item = mapping(data.get("nodes"), "nodes").get(node)
        if not isinstance(item, dict) or not isinstance(item.get("document"), dict):
            raise FigmaError("Node not found in this file. Copy its frame link or use inspect to find IDs.")
        return item["document"]
    if not isinstance(data.get("document"), dict):
        raise FigmaError("Figma response has no document.")
    return data["document"]


def render(client, key, node, output, fmt="png", scale=1, version=None):
    data = client.get(f"/images/{key}", ids=node, format=fmt, scale=scale,
                      version=version, use_absolute_bounds="true")
    url = mapping(data.get("images"), "images").get(node)
    if not url:
        raise FigmaError("Node could not be rendered. Check that it exists and is visible.")
    result = client.download(url, output)
    validate_render(output, fmt)
    return result


def validate_render(path, fmt):
    with path.open("rb") as source:
        header = source.read(16)
        valid = {"png": header.startswith(b"\x89PNG\r\n\x1a\n"),
                 "jpg": header.startswith(b"\xff\xd8\xff"),
                 "pdf": header.startswith(b"%PDF-")}.get(fmt, False)
        if fmt == "svg":
            source.seek(0)
            try:
                _, root = next(ET.iterparse(source, events=("start",)))
                valid = root.tag in ("svg", "{http://www.w3.org/2000/svg}svg")
            except (ET.ParseError, StopIteration):
                valid = False
    if not valid:
        path.unlink()
        raise FigmaError("Render download is not the requested image format. Bundle is incomplete; no manifest was written.")


def asset_extension(url):
    ext = Path(urlsplit(url).path).suffix.lower()
    return ext if ext in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg") else ".bin"


def sniff_extension(path):
    # Figma's signed S3 image-fill URLs often have no filename extension.
    with path.open("rb") as source:
        header = source.read(16)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if header.startswith((b"GIF87a", b"GIF89a")):
        return ".gif"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    return ".bin"
