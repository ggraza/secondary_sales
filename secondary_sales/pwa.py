"""Serves the PWA shell, its versioned static files and the service worker.

Routes
  /ssm                       app shell (login required when online)
  /ssm-sw.js                 service worker, scope /ssm
  /ssm-assets/<hash>/<path>  app files, content-hashed so updates are atomic

Files are served from ``secondary_sales/public/ssm`` with a strict allow-list
of extensions and a path traversal guard.
"""

from __future__ import annotations

import hashlib
import mimetypes
import os
from functools import lru_cache

import frappe
from frappe.website.page_renderers.base_renderer import BaseRenderer
from werkzeug.wrappers import Response

from secondary_sales import __version__
from secondary_sales.core.assets import resolve_asset

PUBLIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public", "ssm")
SHELL_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "templates", "ssm_shell.html")
SW_PATH = "ssm-sw.js"
ASSET_PREFIX = "ssm-assets/"
ALLOWED_EXT = {
	".js": "text/javascript",
	".css": "text/css",
	".json": "application/manifest+json",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
}

CSP = "; ".join(
	[
		"default-src 'self'",
		"script-src 'self'",
		"style-src 'self'",
		"img-src 'self' data: blob:",
		"font-src 'self'",
		"connect-src 'self'",
		"manifest-src 'self'",
		"worker-src 'self'",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	]
)

SECURITY_HEADERS = {
	"Content-Security-Policy": CSP,
	"X-Content-Type-Options": "nosniff",
	"X-Frame-Options": "DENY",
	"Referrer-Policy": "same-origin",
	"Permissions-Policy": "geolocation=(self), camera=(), microphone=(), payment=()",
	"Cross-Origin-Opener-Policy": "same-origin",
}


@lru_cache(maxsize=1)
def asset_manifest() -> tuple[str, tuple[str, ...]]:
	"""(build hash, relative file list). Cached per process; a deploy restarts workers."""
	digest = hashlib.sha256(__version__.encode())
	files = []
	for root, _dirs, names in os.walk(PUBLIC_DIR):
		for name in sorted(names):
			full = os.path.join(root, name)
			rel = os.path.relpath(full, PUBLIC_DIR).replace(os.sep, "/")
			if rel == "sw.js" or os.path.splitext(name)[1] not in ALLOWED_EXT:
				continue
			if name.endswith(".json") and rel != "manifest.json":
				continue
			files.append(rel)
	for rel in sorted(files):
		digest.update(rel.encode())
		with open(os.path.join(PUBLIC_DIR, rel), "rb") as fh:
			digest.update(fh.read())
	return digest.hexdigest()[:12], tuple(sorted(files))


def safe_asset_path(rel: str) -> str | None:
	if rel.endswith(".json") and rel != "manifest.json":
		return None
	return resolve_asset(PUBLIC_DIR, rel, ALLOWED_EXT)


def _response(body, mimetype, status=200, extra=None):
	resp = Response(body, status=status, mimetype=mimetype)
	for k, v in SECURITY_HEADERS.items():
		resp.headers[k] = v
	for k, v in (extra or {}).items():
		resp.headers[k] = v
	return resp


class SSMRenderer(BaseRenderer):
	def can_render(self):
		p = self.path
		return p == "ssm" or p.startswith("ssm/") or p == SW_PATH or p.startswith(ASSET_PREFIX)

	def render(self):
		if self.path == SW_PATH:
			return self.render_sw()
		if self.path.startswith(ASSET_PREFIX):
			return self.render_asset()
		return self.render_shell()

	def render_shell(self):
		if frappe.session.user == "Guest":
			frappe.flags.redirect_location = "/login?redirect-to=/ssm"
			raise frappe.Redirect
		build, _files = asset_manifest()
		with open(SHELL_FILE, encoding="utf-8") as fh:
			html = fh.read().replace("__BUILD__", build).replace("__VERSION__", __version__)
		return _response(html, "text/html", extra={"Cache-Control": "no-cache, private"})

	def render_sw(self):
		build, files = asset_manifest()
		with open(os.path.join(PUBLIC_DIR, "sw.js"), encoding="utf-8") as fh:
			body = fh.read()
		asset_urls = ",\n\t".join(f'"/{ASSET_PREFIX}{build}/{f}"' for f in files)
		body = body.replace("__BUILD__", build).replace("/*__ASSETS__*/", asset_urls)
		return _response(
			body,
			"text/javascript",
			extra={"Service-Worker-Allowed": "/ssm", "Cache-Control": "no-cache, no-store"},
		)

	def render_asset(self):
		rest = self.path[len(ASSET_PREFIX) :]
		build_req, _sep, rel = rest.partition("/")
		full = safe_asset_path(rel)
		if not full:
			return _response("Not found", "text/plain", status=404)
		build, _files = asset_manifest()
		ext = os.path.splitext(full)[1].lower()
		with open(full, "rb") as fh:
			body = fh.read()
		cache = "public, max-age=31536000, immutable" if build_req == build else "no-cache"
		return _response(body, ALLOWED_EXT.get(ext) or mimetypes.guess_type(full)[0], extra={"Cache-Control": cache})
