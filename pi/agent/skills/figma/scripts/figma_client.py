"""Figma REST API client: HTTP transport, redirect/token safety, and error mapping."""

import hashlib
import json
import os
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

API = "https://api.figma.com/v1"
MAX_JSON_BYTES = 50 * 1024 * 1024
MAX_ASSET_BYTES = 50 * 1024 * 1024


class FigmaError(Exception):
    def __init__(self, message, code=1):
        super().__init__(message)
        self.code = code


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
