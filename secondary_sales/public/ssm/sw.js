// Service worker for /ssm. Served by secondary_sales.pwa with the build hash
// and asset list filled in, so every deploy installs a fresh cache.
// Business data is never cached here: it lives encrypted in IndexedDB.

const BUILD = "__BUILD__";
const SHELL_CACHE = `ssm-shell-${BUILD}`;
const IMG_CACHE = "ssm-img-v1";
const ASSETS = [
	/*__ASSETS__*/
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(SHELL_CACHE);
			await cache.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" })));
			try {
				const shell = await fetch("/ssm", { credentials: "same-origin", redirect: "manual", cache: "reload" });
				if (shell.ok && shell.type === "basic") await cache.put("/ssm", shell);
			} catch {
				/* the shell is cached on the next online navigation */
			}
		})()
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			for (const key of await caches.keys()) {
				if (key.startsWith("ssm-shell-") && key !== SHELL_CACHE) await caches.delete(key);
			}
			await self.clients.claim();
		})()
	);
});

self.addEventListener("message", (event) => {
	if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isShell(url) {
	return url.pathname === "/ssm" || url.pathname.startsWith("/ssm/");
}

async function networkFirstShell(request) {
	const cache = await caches.open(SHELL_CACHE);
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);
		const res = await fetch(request, { signal: controller.signal });
		clearTimeout(timer);
		// Only cache a real shell, never a login redirect or error page.
		if (res.ok && !res.redirected && res.type === "basic") cache.put("/ssm", res.clone());
		return res;
	} catch {
		const cached = await cache.match("/ssm");
		return cached || new Response("<h1>Offline</h1><p>Open the app once while online.</p>", { status: 503, headers: { "Content-Type": "text/html" } });
	}
}

async function cacheFirst(request, cacheName) {
	const cache = await caches.open(cacheName);
	const hit = await cache.match(request);
	if (hit) return hit;
	const res = await fetch(request);
	if (res.ok && res.type === "basic") cache.put(request, res.clone());
	return res;
}

self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/")) return; // never cache API responses

	if (req.mode === "navigate" && isShell(url)) {
		event.respondWith(networkFirstShell(req));
	} else if (url.pathname.startsWith("/ssm-assets/")) {
		event.respondWith(cacheFirst(req, SHELL_CACHE));
	} else if (url.pathname.startsWith("/files/") && req.destination === "image") {
		// Public item images only; /private/files is never cached.
		event.respondWith(cacheFirst(req, IMG_CACHE).catch(() => new Response("", { status: 504 })));
	}
});

self.addEventListener("sync", (event) => {
	if (event.tag === "ssm-outbox") {
		event.waitUntil(
			self.clients.matchAll({ type: "window" }).then((clients) => clients.forEach((c) => c.postMessage({ type: "sync" })))
		);
	}
});
