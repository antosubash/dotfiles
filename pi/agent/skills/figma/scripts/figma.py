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
from urllib.parse import parse_qs, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import figma_client  # noqa: E402  (tests patch figma_client.MAX_* through this name)
from figma_client import API, Client, FigmaError, SafeRedirects, check_asset_url, private_file  # noqa: E402
from figma_bundle import (  # noqa: E402
    asset_extension, get_document, image_refs, mapping, render, save_json, sniff_extension, summarize,
)

ENV_PATH = Path(__file__).resolve().parents[4] / ".env"


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
