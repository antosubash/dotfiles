#!/usr/bin/env python3
"""Offline safety and behavior tests for the Figma REST CLI."""

import contextlib
import hashlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request

from figma_test_support import FakeOpener, FakeResponse, RecordingClient, figma


class ParseTargetTests(unittest.TestCase):
    def test_file_frame_and_branch_links_are_normalized(self):
        self.assertEqual(figma.parse_target("AbC123"), ("AbC123", None))
        self.assertEqual(
            figma.parse_target("https://www.figma.com/design/AbC123/A-frame?node-id=12-34"),
            ("AbC123", "12:34"),
        )
        self.assertEqual(
            figma.parse_target("https://figma.com/file/AbC123/Frame?node-id=12%3A34"),
            ("AbC123", "12:34"),
        )
        self.assertEqual(
            figma.parse_target("https://www.figma.com/design/Main123/branch/Branch456/Name?node-id=1%3A2"),
            ("Branch456", "1:2"),
        )
        self.assertEqual(figma.parse_target("AbC123", "1-2;3-4"), ("AbC123", "1:2;3:4"))

    def test_untrusted_urls_and_malformed_node_ids_are_rejected(self):
        bad_urls = (
            "http://www.figma.com/design/AbC123",
            "https://evil.example/design/AbC123",
            "https://figma.com.evil.example/design/AbC123",
            "https://user@www.figma.com/design/AbC123",
            "https://www.figma.com:444/design/AbC123",
            "https://www.figma.com/make/AbC123",
            "https://www.figma.com/design/",
        )
        for value in bad_urls:
            with self.subTest(value=value), self.assertRaises(figma.FigmaError):
                figma.parse_target(value)
        for node in ("abc", "1", "1:", "1:two", "1:2;three:4", "1:2;;3:4"):
            with self.subTest(node=node), self.assertRaises(figma.FigmaError):
                figma.parse_target("AbC123", node)


class TokenTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        patch = mock.patch.object(figma, "ENV_PATH", Path(temporary.name) / ".env")
        patch.start()
        self.addCleanup(patch.stop)

    def test_env_token_takes_precedence_over_token_file(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("file-token\n", encoding="utf-8")
            token_file.chmod(0o600)
            with mock.patch.dict(os.environ, {"FIGMA_TOKEN": "env-token", "FIGMA_TOKEN_FILE": str(token_file)}, clear=True):
                self.assertEqual(figma.load_token(), "env-token")

    def test_private_token_file_is_loaded_and_insecure_file_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            token_file = Path(directory) / "token"
            token_file.write_text("file-token\n", encoding="utf-8")
            token_file.chmod(0o600)
            with mock.patch.dict(os.environ, {"FIGMA_TOKEN_FILE": str(token_file)}, clear=True):
                self.assertEqual(figma.load_token(), "file-token")
            if os.name == "posix":
                token_file.chmod(0o644)
                with mock.patch.dict(os.environ, {"FIGMA_TOKEN_FILE": str(token_file)}, clear=True):
                    with self.assertRaisesRegex(figma.FigmaError, "private"):
                        figma.load_token()

    def test_missing_or_malformed_tokens_are_refused(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(figma.FigmaError, "Set FIGMA_TOKEN"):
                figma.load_token()
        with mock.patch.dict(os.environ, {"FIGMA_TOKEN": "bad token"}, clear=True):
            with self.assertRaisesRegex(figma.FigmaError, "Invalid token format"):
                figma.load_token()


class DotenvTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.env = self.root / ".env"
        self.env.write_text('FIGMA_TOKEN="dotenv-token" # private\n', encoding="utf-8")
        self.env.chmod(0o600)
        for patch in (mock.patch.object(figma, "ENV_PATH", self.env), mock.patch.dict(os.environ, {}, clear=True)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_automatically_loads_private_dotenv(self):
        self.assertEqual(figma.load_token(), "dotenv-token")
        self.assertEqual(figma.ENV_PATH.parent, self.root)

    def test_process_credentials_override_dotenv_as_a_pair(self):
        with mock.patch.dict(os.environ, {"FIGMA_TOKEN": "exported-token"}):
            self.assertEqual(figma.load_token(), "exported-token")
        token = self.root / "token"
        token.write_text("file-token", encoding="utf-8")
        token.chmod(0o600)
        with mock.patch.dict(os.environ, {"FIGMA_TOKEN_FILE": str(token)}):
            self.assertEqual(figma.load_token(), "file-token")

    def test_token_file_in_dotenv_is_relative_to_pi_directory(self):
        token = self.root / "token"
        token.write_text("file-token", encoding="utf-8")
        token.chmod(0o600)
        self.env.write_text("FIGMA_TOKEN=\nFIGMA_TOKEN_FILE=token\n", encoding="utf-8")
        self.assertEqual(figma.load_token(), "file-token")

    def test_dotenv_does_not_execute_or_expand_shell_expressions(self):
        self.env.write_text("FIGMA_TOKEN='$(touch should-not-exist)'\nIGNORED=$(false)\n", encoding="utf-8")
        self.assertEqual(figma.dotenv_values(self.env)["FIGMA_TOKEN"], "$(touch should-not-exist)")
        self.assertFalse((self.root / "should-not-exist").exists())
        self.env.write_text('FIGMA_TOKEN="unterminated-secret\n', encoding="utf-8")
        with self.assertRaises(figma.FigmaError) as raised:
            figma.dotenv_values(self.env)
        self.assertNotIn("unterminated-secret", str(raised.exception))

    @unittest.skipUnless(os.name == "posix", "POSIX permission checks")
    def test_insecure_dotenv_is_refused(self):
        self.env.chmod(0o644)
        with self.assertRaisesRegex(figma.FigmaError, "chmod 600"):
            figma.load_token()


class RobustnessTests(unittest.TestCase):
    def test_malformed_response_shapes_raise_controlled_errors(self):
        for value in (None, [], "invalid"):
            with self.subTest(value=value):
                with self.assertRaises(figma.FigmaError):
                    figma.get_document({"nodes": value}, "1:2")
                with self.assertRaises(figma.FigmaError):
                    figma.render(RecordingClient({"/images/Key": {"images": value}}),
                                 "Key", "1:2", Path("unused.png"))
        for children in (None, {}, "invalid", [None]):
            with self.subTest(children=children), self.assertRaises(figma.FigmaError):
                figma.summarize({"id": "1:2", "children": children})
        for meta in (None, [], {"images": None}):
            with self.subTest(meta=meta), tempfile.TemporaryDirectory() as directory:
                client = RecordingClient({
                    "/files/Key/nodes": {"nodes": {"1:2": {"document": {"id": "1:2", "imageRef": "ref"}}}},
                    "/images/Key": {"images": {"1:2": "https://cdn.figma.com/ref.png"}},
                    "/files/Key/images": {"meta": meta},
                })
                out = Path(directory) / "bundle"
                args = figma.parser().parse_args(["fetch", "Key", "--node", "1:2", "--assets", "--out", str(out)])
                with self.assertRaises(figma.FigmaError):
                    figma.run(args, client)
                self.assertFalse((out / "manifest.json").exists())

    def test_bad_render_payloads_are_not_marked_complete(self):
        class BadClient(RecordingClient):
            def download(self, url, path):
                path.write_bytes(b"<html>CDN error</html>")
                return {"path": path.name}
        for fmt in ("png", "jpg", "svg", "pdf"):
            with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as directory:
                out = Path(directory) / "bundle"
                args = figma.parser().parse_args(["export", "Key", "--node", "1:2", "--out", str(out), "--format", fmt])
                with self.assertRaisesRegex(figma.FigmaError, "not the requested image format"):
                    figma.run(args, BadClient({"/images/Key": {"images": {"1:2": "https://cdn.figma.com/export"}}}))
                self.assertFalse((out / "manifest.json").exists())
                self.assertFalse((out / ("export." + fmt)).exists())

    def test_download_never_deletes_an_existing_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "existing.png"
            path.write_bytes(b"keep this")
            client = figma.Client("token")
            client.opener = FakeOpener(FakeResponse(b"new content"))
            with self.assertRaises(FileExistsError):
                client.download("https://cdn.figma.com/render.png", path)
            self.assertEqual(path.read_bytes(), b"keep this")
            client.opener = FakeOpener(error=HTTPError("https://cdn.figma.com/render.png", 403, "no", {}, None))
            with self.assertRaises(figma.FigmaError):
                client.download("https://cdn.figma.com/render.png", path)
            self.assertEqual(path.read_bytes(), b"keep this")

    def test_asset_hosts_and_redirects_are_checked(self):
        bad = ("http://cdn.figma.com/a", "https://localhost/a", "https://127.0.0.1/a",
               "https://figma.com.evil.example/a", "https://user@cdn.figma.com/a")
        for url in bad:
            with self.subTest(url=url), self.assertRaises(figma.FigmaError):
                figma.check_asset_url(url)
        handler = figma.SafeRedirects()
        request = Request("https://cdn.figma.com/a")
        with self.assertRaises(figma.FigmaError):
            handler.redirect_request(request, None, 302, "Found", {}, "https://evil.example/a")
        redirected = handler.redirect_request(request, None, 302, "Found", {}, "https://bucket.s3.amazonaws.com/a")
        self.assertIsNone(redirected.get_header("X-figma-token"))

    def test_extensionless_image_fills_get_detected_extensions(self):
        class ImageClient(RecordingClient):
            def download(self, url, path):
                result = super().download(url, path)
                if path.suffix == ".bin":
                    data = b"\x89PNG\r\n\x1a\nfixture"
                    path.write_bytes(data)
                    result.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                return result
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "bundle"
            args = figma.parser().parse_args(["fetch", "Key", "--node", "1:2", "--assets", "--out", str(out)])
            client = ImageClient({
                "/files/Key/nodes": {"nodes": {"1:2": {"document": {"id": "1:2", "imageRef": "ref"}}}},
                "/images/Key": {"images": {"1:2": "https://cdn.figma.com/reference"}},
                "/files/Key/images": {"images": {"ref": "https://bucket.s3.amazonaws.com/extensionless"}},
            })
            result = figma.run(args, client)
            asset = result["files"][1]
            self.assertTrue(asset["path"].endswith(".png"))
            self.assertTrue((out / asset["path"]).is_file())

    def test_asset_limit_leaves_no_completion_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "bundle"
            args = figma.parser().parse_args(["fetch", "Key", "--node", "1:2", "--assets", "--max-assets", "1", "--out", str(out)])
            client = RecordingClient({
                "/files/Key/nodes": {"nodes": {"1:2": {"document": {"id": "1:2", "fills": [{"imageRef": "a"}, {"imageRef": "b"}]}}}},
                "/images/Key": {"images": {"1:2": "https://cdn.figma.com/reference"}},
            })
            with self.assertRaisesRegex(figma.FigmaError, "exceeding --max-assets"):
                figma.run(args, client)
            self.assertTrue((out / "design.json").exists())
            self.assertFalse((out / "manifest.json").exists())
            self.assertEqual(len(client.get_calls), 2)

    def test_json_limit_and_parse_errors(self):
        for payload in (b"[]", b"invalid JSON", b'{"err": "secret detail"}'):
            client = figma.Client("token")
            client.opener = FakeOpener(FakeResponse(payload))
            with self.assertRaises(figma.FigmaError):
                client.get("/files/Key")
        client.opener = FakeOpener(FakeResponse(b'{"name":"too large"}'))
        with mock.patch.object(figma.figma_client, "MAX_JSON_BYTES", 4), self.assertRaisesRegex(figma.FigmaError, "exceeds"):
            client.get("/files/Key")

    def test_main_exit_codes_and_no_secrets_on_stderr(self):
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {"FIGMA_TOKEN": "private-token"}, clear=True), \
                mock.patch.object(figma.Client, "get", side_effect=figma.FigmaError("Rate limited", 3)), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(figma.main(["inspect", "Key"]), 3)
        self.assertNotIn("private-token", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
