"""Shared loader and fakes for the figma CLI tests."""
import hashlib
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "pi/agent/skills/figma/scripts/figma.py"


def load_figma():
    spec = importlib.util.spec_from_file_location("figma_cli_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


figma = load_figma()


class FakeResponse:
    def __init__(self, data=b""):
        self.data = data
        self.position = 0

    def read(self, size=-1):
        if size is None or size < 0:
            size = len(self.data) - self.position
        result = self.data[self.position:self.position + size]
        self.position += len(result)
        return result

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        return False


class FakeOpener:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if self.error:
            raise self.error
        return self.response


class RecordingClient:
    """Offline API double for exercising run() and its on-disk bundle."""

    def __init__(self, responses):
        self.responses = responses
        self.get_calls = []
        self.download_calls = []

    def get(self, path, **params):
        self.get_calls.append((path, params))
        response = self.responses[path]
        return response(params) if callable(response) else response

    def download(self, url, path):
        self.download_calls.append((url, path))
        data = {".png": b"\x89PNG\r\n\x1a\nfixture", ".jpg": b"\xff\xd8\xfffixture",
                ".pdf": b"%PDF-1.7 fixture", ".svg": b'<svg xmlns="http://www.w3.org/2000/svg"/>'}.get(path.suffix, b"offline asset")
        with figma.private_file(path, binary=True) as output:
            output.write(data)
        return {"path": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
