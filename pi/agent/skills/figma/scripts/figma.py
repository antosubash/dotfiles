#!/usr/bin/env python3
"""Read-only Figma REST CLI. Python 3.10+, standard library only."""

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shlex
import stat
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import xml.etree.ElementTree as ET

API = "https://api.figma.com/v1"
MAX_JSON_BYTES = 50 * 1024 * 1024
MAX_ASSET_BYTES = 50 * 1024 * 1024
ENV_PATH = Path(__file__).resolve().parents[4] / ".env"
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


class FigmaError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


def parse_target(value, node=None):
    """Accept a file key or an HTTPS Figma link; never request the supplied URL."""
    key = value
    if "://" in value:
        url = urlsplit(value)
        if (url.scheme != "https" or url.hostname not in ("figma.com", "www.figma.com")
                or url.username or url.password or url.port not in (None, 443)):
            raise FigmaError("Use an https://www.figma.com/design/... or /file/... link.")
        parts = url.path.strip("/").split("/")
        if len(parts) < 2 or parts[0] not in ("design", "file", "proto", "board"):
            raise FigmaError("Unsupported Figma link. Copy a file or frame link, not a Make link.")
        key = parts[1]
        # Branch links address a different file key, not the main document.
        if len(parts) > 2 and parts[2] == "branch":
            if len(parts) < 4:
                raise FigmaError("The Figma branch link is incomplete.")
            key = parts[3]
        if node is None:
            node = parse_qs(url.query).get("node-id", [None])[0]
    if not re.fullmatch(r"[A-Za-z0-9]{1,128}", key):
        raise FigmaError("Invalid Figma file key. Use a file key or full Figma link.")
    if node:
        node = node.replace("-", ":")
        if not re.fullmatch(r"I?\d+:\d+(?:;\d+:\d+)*", node):
            raise FigmaError("Invalid node ID. Expected a frame ID such as 123:456 or 123-456.")
    return key, node


def dotenv_values(path):
    """Read only recognized settings; never source/evaluate shell code."""
    try:
        with path.open("r", encoding="utf-8") as source:
            info = os.fstat(source.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise FigmaError("pi/.env must be a regular file.")
            if os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
                raise FigmaError("pi/.env must be owned by you and private (chmod 600 pi/.env).")
            text = source.read(16385)
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError):
        raise FigmaError("Cannot read pi/.env. Check its path, encoding, and permissions.") from None
    if len(text) > 16384:
        raise FigmaError("pi/.env exceeds the 16 KiB configuration limit.")
    values = {}
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?(FIGMA_TOKEN|FIGMA_TOKEN_FILE)\s*=(.*)$", line)
        if not match:
            continue
        try:
            parts = shlex.split(match[2], comments=True)
        except ValueError:
            raise FigmaError("Invalid quoting in pi/.env. Use single-line KEY=value assignments.") from None
        if len(parts) > 1:
            raise FigmaError("Invalid value in pi/.env. Quote values containing spaces.")
        values[match[1]] = parts[0] if parts else ""
    if values.get("FIGMA_TOKEN_FILE"):
        token_path = Path(values["FIGMA_TOKEN_FILE"]).expanduser()
        if not token_path.is_absolute():
            values["FIGMA_TOKEN_FILE"] = str(path.parent / token_path)
    return values


def load_token():
    # Explicit process credentials override dotenv credentials as a pair, so an
    # exported token-file path cannot accidentally use a stale dotenv token.
    if os.environ.get("FIGMA_TOKEN") or os.environ.get("FIGMA_TOKEN_FILE"):
        config = os.environ
    else:
        config = dotenv_values(ENV_PATH)
    token = config.get("FIGMA_TOKEN", "").strip()
    if not token and config.get("FIGMA_TOKEN_FILE"):
        path = Path(config["FIGMA_TOKEN_FILE"]).expanduser()
        try:
            with path.open("r", encoding="utf-8") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise FigmaError("FIGMA_TOKEN_FILE must be a regular file.")
                if os.name == "posix" and (info.st_mode & 0o077 or info.st_uid != os.getuid()):
                    raise FigmaError("FIGMA_TOKEN_FILE must be owned by you and private (chmod 600).")
                token = source.read(4097).strip()
        except (OSError, UnicodeError):
            raise FigmaError("Cannot read FIGMA_TOKEN_FILE. Check its path and permissions.") from None
    if not token:
        raise FigmaError("Set FIGMA_TOKEN in the gitignored pi/.env, or use FIGMA_TOKEN/FIGMA_TOKEN_FILE in your environment. The token needs file_content:read.")
    if len(token) > 4096 or any(ord(c) < 33 or ord(c) > 126 for c in token):
        raise FigmaError("Invalid token format. Supply only the personal access token.")
    return token


def check_asset_url(value):
    if not isinstance(value, str):
        raise FigmaError("Figma did not return an asset URL.")
    url = urlsplit(value)
    host = url.hostname or ""
    if (url.scheme != "https" or url.username or url.password
            or url.port not in (None, 443)
            or not any(host == domain or host.endswith("." + domain)
                       for domain in ("figma.com", "amazonaws.com", "cloudfront.net"))):
        raise FigmaError("Refusing an asset URL outside Figma's HTTPS/CDN hosts.")
    return value


class SafeRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if req.has_header("X-figma-token"):
            raise FigmaError("Refusing an authenticated API redirect; the token was not forwarded.")
        check_asset_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def http_error(error):
    # Do not print response bodies, request headers, or signed download URLs.
    if error.code == 429:
        retry = error.headers.get("Retry-After", "") if error.headers else ""
        hint = f" Retry after {retry} seconds." if re.fullmatch(r"\d{1,10}", retry) else ""
        return FigmaError("Figma rate limit reached (HTTP 429)." + hint
                          + " Reuse saved bundles; check the file's plan and your seat. No automatic retry.", 3)
    messages = {
        401: "Authentication failed. Check whether the token expired.",
        403: "Access denied. Check token expiry, file_content:read scope, and file/plan permissions.",
        404: "File or asset not found. Check the file/branch key and your access.",
    }
    return FigmaError(f"HTTP {error.code}: " + messages.get(error.code, "Figma request failed. Try again later."))


class Client:
    def __init__(self, token, timeout=30):
        self.token = token
        self.timeout = timeout
        self.opener = build_opener(SafeRedirects())

    def open(self, request):
        try:
            return self.opener.open(request, timeout=self.timeout)
        except HTTPError as error:
            raise http_error(error) from None
        except (URLError, OSError):
            raise FigmaError("Network request failed. Check connectivity and try again; credentials were not logged.") from None

    def get(self, path, **params):
        query = urlencode({key: value for key, value in params.items() if value is not None})
        request = Request(API + path + ("?" + query if query else ""),
                          headers={"X-Figma-Token": self.token, "Accept": "application/json"})
        with self.open(request) as response:
            data = response.read(MAX_JSON_BYTES + 1)
        if len(data) > MAX_JSON_BYTES:
            raise FigmaError("Figma JSON exceeds 50 MiB. Select a smaller frame or inspect with --depth.")
        try:
            result = json.loads(data)
        except (ValueError, UnicodeError):
            raise FigmaError("Figma returned invalid JSON.") from None
        if not isinstance(result, dict) or result.get("err") or result.get("error"):
            raise FigmaError("Figma returned an API error. Check the file, node, and access permissions.")
        return result

    def download(self, url, path):
        request = Request(check_asset_url(url))  # Deliberately no API credentials.
        digest = hashlib.sha256()
        size = 0
        created = False
        try:
            with self.open(request) as response, private_file(path, binary=True) as output:
                created = True
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_ASSET_BYTES:
                        raise FigmaError("Asset exceeds 50 MiB. Export a smaller node or use a lower scale.")
                    digest.update(chunk)
                    output.write(chunk)
            if size == 0:
                raise FigmaError("Figma returned an empty asset.")
        except BaseException:
            # Never remove a pre-existing file if exclusive creation or HTTP failed.
            if created and path.exists():
                path.unlink()
            raise
        return {"path": path.name, "bytes": size, "sha256": digest.hexdigest()}


def private_file(path, binary=False):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    return os.fdopen(descriptor, "wb" if binary else "w", **({} if binary else {"encoding": "utf-8"}))


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


def run(args, client):
    key, node = parse_target(args.target, args.node)
    if args.command != "inspect" and not node:
        raise FigmaError("A frame/node is required. Paste its link or add --node 123:456; use inspect to find IDs.")
    if args.command == "inspect":
        data = client.get(f"/files/{key}" + ("/nodes" if node else ""),
                          ids=node, depth=args.depth)
        return {"fileKey": key, "nodeId": node, "name": data.get("name"),
                "version": data.get("version"), "requestedDepth": args.depth,
                **summarize(get_document(data, node))}

    out = Path(args.out).expanduser().absolute()
    try:
        out.mkdir(mode=0o700, parents=True, exist_ok=False)
    except FileExistsError:
        raise FigmaError("Output path already exists. Reuse its saved files or choose a new --out directory; nothing was overwritten.") from None
    manifest = {"fileKey": key, "nodeId": node, "files": [], "complete": True}
    if args.command == "export":
        manifest["files"].append(render(client, key, node, out / ("export." + args.format), args.format, args.scale))
    else:
        data = client.get(f"/files/{key}/nodes", ids=node, geometry="paths")
        root = get_document(data, node)
        save_json(out / "design.json", data)
        save_json(out / "summary.json", summarize(root))
        manifest.update(name=data.get("name"), version=data.get("version"),
                        design="design.json", summary="summary.json")
        manifest["files"].append(render(client, key, node, out / "reference.png",
                                        scale=args.scale, version=data.get("version")))
        refs = image_refs(root)
        manifest["imageRefs"] = refs
        manifest["imageFillsDownloaded"] = args.assets
        if args.assets and refs:
            if len(refs) > args.max_assets:
                raise FigmaError(f"Frame has {len(refs)} image fills, exceeding --max-assets {args.max_assets}. "
                                 "Select a smaller frame or explicitly raise the limit. Design/reference were saved; bundle is incomplete.")
            fills = client.get(f"/files/{key}/images")
            # The deployed API uses meta.images; also accept the documented top-level shape.
            container = mapping(fills["meta"], "meta") if "meta" in fills else fills
            urls = mapping(container.get("images"), "image fills")
            assets = out / "assets"
            assets.mkdir(mode=0o700)
            for ref in refs:
                url = urls.get(ref)
                if not url:
                    raise FigmaError("An image fill has no download URL. Bundle is incomplete; try again later.")
                check_asset_url(url)
                name = hashlib.sha256(ref.encode()).hexdigest() + asset_extension(url)
                entry = client.download(url, assets / name)
                if name.endswith(".bin"):
                    extension = sniff_extension(assets / name)
                    if extension != ".bin":
                        renamed = Path(name).with_suffix(extension).name
                        (assets / name).rename(assets / renamed)
                        name = renamed
                entry.update(path="assets/" + name, imageRef=ref)
                manifest["files"].append(entry)
            manifest["imageFillsVersion"] = "latest (Figma's image-fill endpoint cannot be version-pinned)"
    save_json(out / "manifest.json", manifest)  # A completion marker, written last.
    return {"output": str(out), **manifest}


def positive_int(value):
    number = int(value)
    if not 1 <= number <= 1000:
        raise argparse.ArgumentTypeError("must be between 1 and 1000")
    return number


def scale_value(value):
    number = float(value)
    if not math.isfinite(number) or not 0.01 <= number <= 4:
        raise argparse.ArgumentTypeError("must be between 0.01 and 4")
    return number


def parser():
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    for command in ("inspect", "fetch", "export"):
        sub = commands.add_parser(command, help={"inspect": "List pages/nodes and design properties",
                                                "fetch": "Save a frame's full design JSON and PNG reference",
                                                "export": "Render a node as PNG, JPG, SVG, or PDF"}[command])
        sub.add_argument("target", help="Figma file/frame URL or file key")
        sub.add_argument("--node", help="Override the link's node ID, e.g. 123:456")
        if command == "inspect":
            sub.add_argument("--depth", type=positive_int, default=2, help="API tree depth (default: 2)")
        else:
            sub.add_argument("--out", required=True, help="New output directory (never overwrites)")
            sub.add_argument("--scale", type=scale_value, default=1, help="Render scale 0.01–4 (default: 1)")
        if command == "fetch":
            sub.add_argument("--assets", action="store_true", help="Download image fills referenced by this frame")
            sub.add_argument("--max-assets", type=positive_int, default=20, help="Image-fill safety limit (default: 20)")
        if command == "export":
            sub.add_argument("--format", choices=("png", "jpg", "svg", "pdf"), default="svg")
    return result


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        # Validate user input before loading credentials or making requests.
        parse_target(args.target, args.node)
        result = run(args, Client(load_token()))
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except FigmaError as error:
        print(f"figma: {error}", file=sys.stderr)
        return error.code
    except (OSError, ValueError, RecursionError):
        print("figma: Could not process the input, response, or local files. Check paths, permissions, and frame size. "
              "Any output without manifest.json is incomplete.", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("figma: Cancelled. Any output without manifest.json is incomplete.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
