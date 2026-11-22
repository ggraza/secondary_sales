// Entry point: boot (online or offline), routing, layout and shared state.

import { Api, AuthError, NetworkError, ServerError } from "./api.js";
import { importKey } from "./crypto.js";
import { deleteDB, Meta, openDB, Store } from "./store.js";
import { SyncEngine } from "./sync.js";
import { icon, toast } from "./ui.js";
import { clear, h, relTime, sha256Hex, todayISO } from "./util.js";
import * as routeView from "./views/route.js";
import * as orderView from "./views/order.js";
import * as ordersView from "./views/orders.js";
import * as outstandingView from "./views/outstanding.js";
import * as moreView from "./views/more.js";

const root = document.getElementById("app");

export const app = {
	api: new Api(),
	meta: null,
	store: null,
	sync: null,
	boot: null,
	userHash: null,
	masters: { customers: [], items: [], no_order_reasons: [], visits_today: [] },
	customersById: new Map(),
	itemsByCode: new Map(),
	online: navigator.onLine,
	pending: 0,
	authLost: false,
	syncing: false,
	lastMasters: null,
	installPrompt: null,
	prefs: {},
	get profile() {
		return this.boot?.profile;
	},
	get settings() {
		return this.boot?.settings || {};
	},
	can(screen) {
		return !!this.profile?.screens?.[screen];
	},
	visible(field) {
		return this.profile?.fields?.[field]?.visible !== false;
	},
	editable(field) {
		return !!this.profile?.fields?.[field]?.editable;
	},
	go(hash) {
		if (location.hash === hash) render();
		else location.hash = hash;
	},
	refresh: () => render(),
};

const NAV = [
	{ hash: "#/route", label: "Customers", icon: "route", screen: "route" },
	{ hash: "#/order", label: "New order", icon: "cart", screen: "order" },
	{ hash: "#/orders", label: "Orders", icon: "orders", screen: "orders" },
	{ hash: "#/outstanding", label: "Outstanding", icon: "money", screen: "outstanding" },
	{ hash: "#/more", label: "More", icon: "more", screen: null },
];

const VIEWS = {
	route: routeView,
	order: orderView,
	orders: ordersView,
	outstanding: outstandingView,
	more: moreView,
};

// ---------- boot ----------

function fullScreenMessage(iconName, title, text, actions = []) {
	clear(root).className = "boot";
	root.appendChild(
		h("div", { class: "splash" }, h("div", { class: "splash-icon" }, icon(iconName, 40)), h("h1", null, title), h("p", { class: "muted" }, text), h("div", { class: "row center gap" }, actions))
	);
}

function goLogin() {
	location.href = "/login?redirect-to=" + encodeURIComponent("/ssm" + (location.hash || ""));
}

async function wipeUser(hash) {
	await deleteDB(`ssm-${hash}`);
	await app.meta.del(`key:${hash}`);
}

export async function signOutAndWipe() {
	try {
		await fetch("/api/method/logout", { method: "POST", credentials: "same-origin", headers: { "X-Frappe-CSRF-Token": app.api.csrf || "" } }).catch(() => {});
	} finally {
		app.store?.close();
		if (app.userHash) await wipeUser(app.userHash);
		await app.meta.del("last_user");
		if ("caches" in window) for (const k of await caches.keys()) if (k.startsWith("ssm-")) await caches.delete(k);
		location.href = "/login?redirect-to=/ssm";
	}
}

export async function touchContact() {
	const last = await app.meta.get("last_user");
	if (last) await app.meta.set("last_user", { ...last, last_contact: Date.now() });
}

async function onlineBoot() {
	const boot = await app.api.call("boot.bootstrap");
	app.api.csrf = boot.csrf_token;
	const hash = (await sha256Hex(boot.user.name)).slice(0, 16);
	const last = await app.meta.get("last_user");
	if (last && last.hash !== hash) await wipeUser(last.hash); // another user used this device

	const encrypt = !!boot.settings.encrypt_local_data;
	const keyRec = await app.meta.get(`key:${hash}`);
	let key = null;
	if (!keyRec || keyRec.key_id !== boot.device.key_id || keyRec.encrypted !== encrypt) {
		// New device, rotated key (admin revoke / password reset) or mode change: start clean.
		await deleteDB(`ssm-${hash}`);
		key = encrypt ? await importKey(boot.device.key) : null;
		await app.meta.set(`key:${hash}`, { key_id: boot.device.key_id, encrypted: encrypt, key });
	} else {
		key = keyRec.key;
	}

	await app.meta.set("last_user", {
		hash,
		name: boot.user.name,
		last_contact: Date.now(),
		max_offline_hours: boot.settings.max_offline_hours,
		offline_allowed: !!boot.settings.enable_offline,
	});

	const safeBoot = { ...boot, device: { key_id: boot.device.key_id }, csrf_token: null };
	app.userHash = hash;
	app.store = new Store(await openDB(`ssm-${hash}`), key);
	await app.store.put("kv", "boot", safeBoot);
	return safeBoot;
}

async function offlineBoot() {
	const last = await app.meta.get("last_user");
	if (!last) {
		fullScreenMessage("offline", "You're offline", "Connect to the internet to sign in the first time.", [
			h("button", { class: "btn primary", onclick: () => location.reload() }, "Try again"),
		]);
		return null;
	}
	if (!last.offline_allowed) {
		fullScreenMessage("offline", "Offline use is turned off", "Your administrator requires a connection for this app.", [
			h("button", { class: "btn primary", onclick: () => location.reload() }, "Try again"),
		]);
		return null;
	}
	const hours = Number(last.max_offline_hours) || 0;
	if (hours && Date.now() - last.last_contact > hours * 3600 * 1000) {
		fullScreenMessage("lock", "Connect to continue", `This device has been offline for more than ${hours} hours. Connect to the internet to unlock. Your unsent orders are kept safely.`, [
			h("button", { class: "btn primary", onclick: () => location.reload() }, "Try again"),
		]);
		return null;
	}
	const keyRec = await app.meta.get(`key:${last.hash}`);
	app.userHash = last.hash;
	app.store = new Store(await openDB(`ssm-${last.hash}`), keyRec?.key || null);
	const boot = await app.store.get("kv", "boot");
	if (!boot) {
		fullScreenMessage("offline", "You're offline", "Connect once so the app can download your customers and items.");
		return null;
	}
	return boot;
}

async function start() {
	registerSW();
	try {
		app.meta = await Meta.open();
	} catch {
		fullScreenMessage("alert", "Storage unavailable", "This browser blocks local storage (private mode?). Open the app in a normal window.");
		return;
	}

	let boot = null;
	if (navigator.onLine) {
		try {
			boot = await onlineBoot();
		} catch (e) {
			if (e instanceof AuthError) return goLogin();
			if (e instanceof ServerError) {
				fullScreenMessage("lock", "No access", e.message, [h("a", { class: "btn", href: "/app" }, "Back to desk"), h("button", { class: "btn", onclick: signOutAndWipe }, "Sign out")]);
				return;
			}
			// NetworkError: fall through to offline boot
		}
	}
	if (!boot) boot = await offlineBoot();
	if (!boot) return;
	app.boot = boot;
	app.api.onCsrfExpired = async () => (await app.api.call("boot.bootstrap")).csrf_token;
	document.documentElement.style.setProperty("--brand", boot.settings.theme_color || "#0f6cbd");
	document.title = boot.settings.app_title || "Secondary Sales";

	app.prefs = (await app.store.get("kv", "prefs")) || {};
	app.sync = new SyncEngine({
		store: app.store,
		api: app.api,
		onChange: () => updateStatus(),
		onAuthError: () => {
			app.authLost = true;
			updateStatus();
		},
	});
	await loadMasters();
	layout();
	window.addEventListener("hashchange", render);
	if (!location.hash || location.hash === "#") location.hash = app.can("route") ? "#/route" : "#/order";
	else render();

	window.addEventListener("online", () => {
		app.online = true;
		updateStatus();
		backgroundSync();
	});
	window.addEventListener("offline", () => {
		app.online = false;
		updateStatus();
	});
	navigator.serviceWorker?.addEventListener("message", (e) => {
		if (e.data?.type === "sync") backgroundSync();
		if (e.data?.type === "update-ready") showUpdateBanner(e.data.worker);
	});
	document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && backgroundSync());
	setInterval(backgroundSync, 60 * 1000);
	backgroundSync(true);
}

// ---------- data ----------

async function loadMasters() {
	const m = await app.store.get("kv", "masters");
	if (m) setMasters(m);
	app.lastMasters = (await app.store.get("kv", "masters_at")) || null;
}

function setMasters(m) {
	app.masters = m;
	app.customersById = new Map((m.customers || []).map((c) => [c.name, c]));
	app.itemsByCode = new Map((m.items || []).map((i) => [i.item_code, i]));
}

export async function refreshMasters() {
	const res = await app.api.call("data.master_data", { params: { known_hash: app.masters?.hash || "" } });
	const now = new Date().toISOString();
	if (!res.unchanged) {
		await app.store.put("kv", "masters", res);
		setMasters(res);
	}
	app.lastMasters = now;
	await app.store.put("kv", "masters_at", now);
	await touchContact();
	return !res.unchanged;
}

let bgRunning = false;
export async function backgroundSync(includeMasters = false) {
	if (bgRunning || !navigator.onLine || app.authLost) return;
	bgRunning = true;
	app.syncing = true;
	updateStatus();
	try {
		const r = await app.sync.run();
		if (r?.sent) {
			toast(`${r.sent} ${r.sent === 1 ? "order" : "orders"} sent`, "success");
			await touchContact();
		}
		const stale = !app.lastMasters || Date.now() - new Date(app.lastMasters).getTime() > 15 * 60 * 1000;
		if (includeMasters || stale) {
			const changed = await refreshMasters();
			if (changed) render();
		}
	} catch (e) {
		if (e instanceof AuthError) app.authLost = true;
		else if (!(e instanceof NetworkError)) console.warn("sync", e);
	} finally {
		bgRunning = false;
		app.syncing = false;
		updateStatus();
	}
}

/** Visit status per customer today: server visits + local outbox/synced. */
export async function visitStatus() {
	const status = new Map();
	for (const v of app.masters.visits_today || []) status.set(v.customer, v.outcome === "Order" ? "order" : "no_order");
	const today = todayISO();
	for (const o of await app.store.all("synced")) {
		if ((o.payload.created_at || "").slice(0, 10) === today) status.set(o.payload.customer, o.payload.outcome);
	}
	for (const o of await app.store.all("outbox")) {
		if ((o.payload.created_at || "").slice(0, 10) === today) status.set(o.payload.customer, o.state === "rejected" ? "error" : "pending");
	}
	return status;
}

export async function savePrefs(patch) {
	app.prefs = { ...app.prefs, ...patch };
	await app.store.put("kv", "prefs", app.prefs);
}

// ---------- layout & routing ----------

let mainEl, statusEl, navEl, titleEl, backEl;

function layout() {
	clear(root).className = "shell";
	titleEl = h("h1", { class: "title" }, app.settings.app_title || "Secondary Sales");
	backEl = h("button", { class: "icon-btn back hidden", "aria-label": "Back", onclick: () => history.back() }, icon("back"));
	statusEl = h("button", { class: "status-chip", onclick: () => app.go("#/orders") });
	const header = h("header", { class: "topbar" }, backEl, titleEl, statusEl);
	navEl = h("nav", { class: "nav", "aria-label": "Main" });
	for (const n of NAV) {
		if (n.screen && !app.can(n.screen)) continue;
		navEl.appendChild(h("a", { href: n.hash, class: "nav-item", dataset: { hash: n.hash } }, icon(n.icon), h("span", null, n.label), n.hash === "#/orders" ? h("b", { class: "nav-badge hidden" }) : null));
	}
	mainEl = h("main", { class: "main", id: "main", tabindex: "-1" });
	root.append(header, navEl, mainEl);
	updateStatus();
}

async function updateStatus() {
	if (!statusEl) return;
	app.pending = app.sync ? await app.sync.pendingCount() : 0;
	const rejected = app.sync ? (await app.sync.outbox()).filter((o) => o.state === "rejected").length : 0;
	clear(statusEl);
	let cls = "ok";
	let label = "Online";
	let ic = "check";
	if (app.authLost) {
		cls = "warn";
		label = "Sign in to sync";
		ic = "lock";
	} else if (!navigator.onLine) {
		cls = "off";
		label = "Offline";
		ic = "offline";
	} else if (app.syncing) {
		cls = "busy";
		label = "Syncing";
		ic = "sync";
	}
	if (rejected) cls = "warn";
	statusEl.className = `status-chip ${cls}`;
	statusEl.title = `Data updated ${relTime(app.lastMasters)}`;
	statusEl.append(icon(ic, 16), h("span", null, label));
	if (app.pending) statusEl.append(h("b", { class: "count" }, String(app.pending)));
	const badge = navEl?.querySelector(".nav-badge");
	if (badge) {
		badge.textContent = String(app.pending + rejected);
		badge.classList.toggle("hidden", !(app.pending + rejected));
	}
	document.body.classList.toggle("is-offline", !navigator.onLine);
	if (app.authLost && !document.querySelector(".auth-banner")) {
		mainEl?.before(
			h("div", { class: "banner warn auth-banner" }, icon("lock", 18), h("span", null, "Your session ended. Unsent orders are safe on this device."), h("button", { class: "btn small", onclick: goLogin }, "Sign in"))
		);
	}
}

function parseHash() {
	const parts = (location.hash || "#/route").replace(/^#\/?/, "").split("/");
	return { name: parts[0] || "route", args: parts.slice(1).map((p) => decodeURIComponent(p)) };
}

let renderToken = 0;
async function render() {
	if (!mainEl) return;
	const { name, args } = parseHash();
	const screenFor = { route: "route", order: "order", orders: "orders", outstanding: "outstanding" };
	const view = VIEWS[name];
	const token = ++renderToken;
	for (const a of navEl.querySelectorAll(".nav-item")) a.classList.toggle("active", a.dataset.hash === `#/${name}`);
	if (!view || (screenFor[name] && !app.can(screenFor[name]))) {
		clear(mainEl).appendChild(h("div", { class: "empty" }, h("h3", null, "Not available"), h("p", { class: "muted" }, "This screen is turned off for your profile.")));
		return;
	}
	try {
		const out = await view.render(app, args);
		if (token !== renderToken) return; // a newer navigation won
		clear(mainEl).appendChild(out.el || out);
		titleEl.textContent = out.title || app.settings.app_title || "Secondary Sales";
		backEl.classList.toggle("hidden", !out.back);
		document.body.dataset.view = name;
		mainEl.scrollTop = 0;
	} catch (e) {
		console.error(e);
		clear(mainEl).appendChild(h("div", { class: "empty" }, h("h3", null, "Something went wrong"), h("p", { class: "muted" }, e.message || String(e))));
	}
}

// ---------- service worker ----------

function registerSW() {
	if (!("serviceWorker" in navigator)) return;
	navigator.serviceWorker
		.register("/ssm-sw.js", { scope: "/ssm" })
		.then((reg) => {
			reg.addEventListener("updatefound", () => {
				const w = reg.installing;
				w?.addEventListener("statechange", () => {
					if (w.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(w);
				});
			});
		})
		.catch((e) => console.warn("Service worker registration failed", e));
	let reloading = false;
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		if (reloading) return;
		reloading = true;
		location.reload();
	});
}

function showUpdateBanner(worker) {
	if (document.querySelector(".update-banner")) return;
	document.body.appendChild(
		h("div", { class: "banner info update-banner" }, h("span", null, "A new version is ready."), h("button", { class: "btn small primary", onclick: () => worker?.postMessage({ type: "SKIP_WAITING" }) }, "Update"))
	);
}

window.addEventListener("beforeinstallprompt", (e) => {
	e.preventDefault();
	app.installPrompt = e;
});

start();
