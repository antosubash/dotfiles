#!/usr/bin/env python3
"""Offline safety and behavior tests for the Figma client and bundle helpers."""

import hashlib
import io
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request

from figma_test_support import FakeOpener, FakeResponse, RecordingClient, figma


class SummaryTests(unittest.TestCase):
    def test_summary_limits_nodes_truncates_text_and_collects_unique_image_refs(self):
        root = {
            "id": "0:0",
            "name": "root",
            "type": "DOCUMENT",
            "children": [
                {"id": "1:1", "name": "text", "type": "TEXT", "characters": "x" * 2001,
                 "fills": [{"imageRef": "fill-b"}], "children": [{"id": "1:2", "name": "nested", "type": "RECTANGLE", "imageRef": "fill-a"}]},
                {"id": "2:1", "name": "other", "type": "RECTANGLE", "imageRef": "fill-a"},
            ],
        }
        summary = figma.summarize(root, limit=2)
        self.assertEqual(summary["nodeCount"], 4)
        self.assertTrue(summary["nodesTruncated"])
        self.assertEqual([node["id"] for node in summary["nodes"]], ["0:0", "1:1"])
        self.assertIsNone(summary["nodes"][0]["parentId"])
        self.assertEqual(summary["nodes"][1]["parentId"], "0:0")
        self.assertEqual(len(summary["nodes"][1]["characters"]), 2000)
        self.assertTrue(summary["nodes"][1]["textTruncated"])
        self.assertEqual(summary["imageRefs"], ["fill-a", "fill-b"])


class HttpSafetyTests(unittest.TestCase):
    def test_api_token_is_sent_only_to_api_and_authenticated_redirects_are_rejected(self):
        client = figma.Client("super-secret-token")
        opener = FakeOpener(FakeResponse(b'{"name": "ok"}'))
        client.opener = opener
        self.assertEqual(client.get("/files/AbC123"), {"name": "ok"})
        request = opener.requests[0][0]
        self.assertTrue(request.full_url.startswith(figma.API + "/files/AbC123"))
        self.assertEqual(request.get_header("X-figma-token"), "super-secret-token")

        redirect_request = Request(figma.API + "/files/AbC123", headers={"X-Figma-Token": "super-secret-token"})
        with self.assertRaisesRegex(figma.FigmaError, "authenticated API redirect"):
            figma.SafeRedirects().redirect_request(
                redirect_request, None, 302, "Found", {}, "https://evil.example/collect"
            )

    def test_http_errors_have_actionable_hints_without_secrets(self):
        token = "do-not-log-this-token"
        expectations = {
            401: "Authentication failed",
            403: "Access denied",
            404: "File or asset not found",
        }
        for code, expected in expectations.items():
            with self.subTest(code=code):
                client = figma.Client(token)
                client.opener = FakeOpener(error=HTTPError("https://api.figma.com/private?sig=secret", code, "no", {}, io.BytesIO(b"secret body")))
                with self.assertRaises(figma.FigmaError) as raised:
                    client.get("/files/AbC123")
                self.assertIn(expected, str(raised.exception))
                self.assertNotIn(token, str(raised.exception))
                self.assertNotIn("sig=secret", str(raised.exception))
                self.assertNotIn("secret body", str(raised.exception))

        client = figma.Client(token)
        client.opener = FakeOpener(error=HTTPError("https://api.figma.com/private", 429, "slow", {"Retry-After": "17"}, None))
        with self.assertRaises(figma.FigmaError) as raised:
            client.get("/files/AbC123")
        self.assertEqual(raised.exception.code, 3)
        self.assertIn("Retry after 17 seconds", str(raised.exception))
        self.assertNotIn(token, str(raised.exception))

    def test_download_is_uncredentialed_bounded_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "asset.png"
            client = figma.Client("super-secret-token")
            opener = FakeOpener(FakeResponse(b"abcdef"))
            client.opener = opener
            result = client.download("https://cdn.figma.com/assets/a.png", output)
            self.assertEqual(result["bytes"], 6)
            self.assertEqual(result["sha256"], hashlib.sha256(b"abcdef").hexdigest())
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            request = opener.requests[0][0]
            self.assertIsNone(request.get_header("X-figma-token"))
            self.assertIsNone(request.get_header("Authorization"))

            too_large = Path(directory) / "too-large.png"
            bounded = figma.Client("super-secret-token")
            bounded.opener = FakeOpener(FakeResponse(b"01234567890"))
            with mock.patch.object(figma.figma_client, "MAX_ASSET_BYTES", 10):
                with self.assertRaisesRegex(figma.FigmaError, "exceeds"):
                    bounded.download("https://cdn.figma.com/assets/b.png", too_large)
            self.assertFalse(too_large.exists())


class RunTests(unittest.TestCase):
    def test_inspect_passes_requested_depth_and_returns_node_summary(self):
        document = {"id": "1:2", "name": "Frame", "type": "FRAME", "children": []}
        client = RecordingClient({"/files/AbC123/nodes": {"name": "File", "version": "v1", "nodes": {"1:2": {"document": document}}}})
        args = figma.parser().parse_args(["inspect", "AbC123", "--node", "1:2", "--depth", "7"])
        result = figma.run(args, client)
        self.assertEqual(client.get_calls, [("/files/AbC123/nodes", {"ids": "1:2", "depth": 7})])
        self.assertEqual(result["requestedDepth"], 7)
        self.assertEqual(result["nodeCount"], 1)
        self.assertEqual(result["nodeId"], "1:2")

    def test_fetch_saves_full_bundle_metadata_pinned_reference_and_selected_deduped_assets(self):
        document = {
            "id": "1:2", "name": "Selected", "type": "FRAME",
            "children": [
                {"id": "1:3", "name": "A", "type": "RECTANGLE", "imageRef": "fill-a"},
                {"id": "1:4", "name": "Again", "type": "RECTANGLE", "fills": [{"imageRef": "fill-a"}]},
                {"id": "1:5", "name": "B", "type": "RECTANGLE", "imageRef": "fill-b"},
            ],
        }
        full_data = {"name": "File name", "version": "version-42", "nodes": {"1:2": {"document": document}}}
        reference_url = "https://cdn.figma.com/reference.png"
        fill_urls = {
            "fill-a": "https://cdn.figma.com/fill-a.png",
            "fill-b": "https://cdn.figma.com/fill-b.jpg",
            "unselected-fill": "https://cdn.figma.com/should-not-download.png",
        }
        client = RecordingClient({
            "/files/AbC123/nodes": full_data,
            "/images/AbC123": {"images": {"1:2": reference_url}},
            "/files/AbC123/images": {"meta": {"images": fill_urls}},
        })
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "bundle"
            args = figma.parser().parse_args([
                "fetch", "AbC123", "--node", "1:2", "--out", str(output), "--scale", "2", "--assets",
            ])
            result = figma.run(args, client)
            self.assertEqual(json.loads((output / "design.json").read_text(encoding="utf-8")), full_data)
            self.assertEqual(json.loads((output / "summary.json").read_text(encoding="utf-8"))["imageRefs"], ["fill-a", "fill-b"])
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["complete"])
            self.assertEqual((manifest["name"], manifest["version"]), ("File name", "version-42"))
            self.assertEqual(manifest["imageRefs"], ["fill-a", "fill-b"])
            self.assertEqual(result["output"], str(output.absolute()))

        self.assertIn(("/files/AbC123/nodes", {"ids": "1:2", "geometry": "paths"}), client.get_calls)
        self.assertIn(("/images/AbC123", {"ids": "1:2", "format": "png", "scale": 2.0, "version": "version-42", "use_absolute_bounds": "true"}), client.get_calls)
        self.assertIn(("/files/AbC123/images", {}), client.get_calls)
        self.assertEqual([url for url, _ in client.download_calls], [reference_url, fill_urls["fill-a"], fill_urls["fill-b"]])
        self.assertNotIn(fill_urls["unselected-fill"], [url for url, _ in client.download_calls])

    def test_export_supports_all_formats(self):
        for fmt in ("png", "jpg", "svg", "pdf"):
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "export"
                asset_url = "https://cdn.figma.com/export." + fmt
                client = RecordingClient({"/images/AbC123": {"images": {"1:2": asset_url}}})
                args = figma.parser().parse_args(["export", "AbC123", "--node", "1:2", "--out", str(output), "--format", fmt])
                result = figma.run(args, client)
                self.assertEqual(client.get_calls, [("/images/AbC123", {"ids": "1:2", "format": fmt, "scale": 1, "version": None, "use_absolute_bounds": "true"})])
                self.assertEqual(client.download_calls[0][1].name, "export." + fmt)
                self.assertEqual(result["files"][0]["path"], "export." + fmt)

    def test_missing_nodes_or_renders_and_existing_output_are_refused(self):
        with self.assertRaisesRegex(figma.FigmaError, "Node not found"):
            figma.get_document({"nodes": {}}, "1:2")
        client = RecordingClient({"/images/AbC123": {"images": {}}})
        with self.assertRaisesRegex(figma.FigmaError, "could not be rendered"):
            figma.render(client, "AbC123", "1:2", Path("ignored.png"))

        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "already-exists"
            output.mkdir()
            client = RecordingClient({})
            args = figma.parser().parse_args(["export", "AbC123", "--node", "1:2", "--out", str(output)])
            with self.assertRaisesRegex(figma.FigmaError, "already exists"):
                figma.run(args, client)
            self.assertEqual(client.get_calls, [])


if __name__ == "__main__":
    unittest.main()
