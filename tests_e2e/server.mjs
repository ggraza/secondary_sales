// Mock Frappe server for browser tests and local UI work. It serves the PWA
// exactly like secondary_sales/pwa.py (shell, hashed assets, service worker,
// security headers) and fakes the app's API with in-memory data.
//   node tests_e2e/server.mjs   ->  http://localhost:8765/ssm

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "secondary_sales");
const PUBLIC = join(ROOT, "public", "ssm");
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".json": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function walk(dir) {
	return readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
}
function manifest() {
	const files = walk(PUBLIC)
		.map((f) => relative(PUBLIC, f))
		.filter((r) => r !== "sw.js" && TYPES[extname(r)] && (!r.endsWith(".json") || r === "manifest.json"))
		.sort();
	const h = createHash("sha256").update("dev");
	for (const f of files) h.update(f).update(readFileSync(join(PUBLIC, f)));
	return { build: h.digest("hex").slice(0, 12), files };
}

export const db = {
	orders: [],
	user: "rep@example.com",
	failNext: 0,
	customers: [
		{ name: "CUST-0001", customer_name: "Bismillah Store", mobile_no: "0308 4562740", address: "Main Bazar, Bhobatiyan", price_list: "Retail", lat: 31.4, lng: 74.2, route_days: ["Everyday"], sequence: 1, outstanding: 15400, credit_limit: 20000, last_order_date: "2026-11-18" },
		{ name: "CUST-0002", customer_name: "Hafiz Provision", mobile_no: "0302 0782741", address: "Main Bazar", price_list: "Retail", route_days: ["Everyday"], sequence: 2, outstanding: 0, credit_limit: 0 },
		{ name: "CUST-0003", customer_name: "Zulfiqar General Store", mobile_no: "0331 4241146", address: "Bhobatiyan Chowk", price_list: "Special", route_days: ["Everyday"], sequence: 3, outstanding: 3200, credit_limit: 5000 },
		{ name: "CUST-0004", customer_name: "<img src=x onerror=alert(1)>Mashallah Mart", mobile_no: "0324 4311245", address: "<b>Canal Road</b>", price_list: "Retail", route_days: ["Monday"], sequence: 4, outstanding: 0 },
	],
	items: [
		{ item_code: "COLA-1500", item_name: "Cola 1500 ml", item_group: "Carbonated", brand: "Fizz", stock_uom: "Nos", pack_factor: 6, prices: { Retail: 139.17, Special: 125 }, stock: 340 },
		{ item_code: "COLA-1000", item_name: "Cola 1000 ml", item_group: "Carbonated", brand: "Fizz", stock_uom: "Nos", pack_factor: 12, prices: { Retail: 51.5, Special: 48 }, stock: 1200 },
		{ item_code: "LEMON-500", item_name: "Lemon Soda 500 ml", item_group: "Carbonated", brand: "Fizz", stock_uom: "Nos", pack_factor: 24, prices: { Retail: 40 }, stock: 0 },
		{ item_code: "WATER-1500", item_name: "Mineral Water 1.5 L", item_group: "Water", brand: "Pure", stock_uom: "Nos", pack_factor: 6, prices: { Retail: 60 }, stock: 800 },
		{ item_code: "JUICE-250", item_name: "Mango Juice 250 ml", item_group: "Juice", brand: "Sunny", stock_uom: "Nos", pack_factor: 27, prices: { Retail: 45 }, stock: 270 },
		{ item_code: "CHIPS-50", item_name: "Salted Chips 50 g", item_group: "Snacks", brand: "Crunch", stock_uom: "Nos", pack_factor: 0, prices: { Retail: 50 }, stock: 90 },
	],
};

function profile() {
	const fields = {};
	for (const k of ["customer.mobile_no", "customer.address", "customer.territory", "customer.customer_group", "customer.outstanding", "customer.credit_limit", "item.price", "item.stock", "item.image", "item.brand", "item.item_group", "order.rate", "order.discount", "order.delivery_date", "order.remarks"])
		fields[k] = { visible: true, editable: ["order.delivery_date", "order.remarks", "order.discount"].includes(k) };
	return {
		name: "Field Sales Rep",
		screens: { route: true, order: true, orders: true, outstanding: true },
		cart_views: ["list", "grid", "table", "compact", "catalogue"],
		default_view: "list",
		fields,
		customer_scope: "Route Plan Only",
		order_action: "Save as Draft",
		max_discount_percent: 5,
		allow_update_location: true,
		view_all_orders: false,
		allow_offline: true,
	};
}

const api = {
	"boot.bootstrap": () => ({
		user: { name: db.user, full_name: "Ali Raza" },
		profile: profile(),
		settings: { app_title: "Secondary Sales", theme_color: "#0f6cbd", company: "Demo Beverages", currency: "PKR", pack_uom: "Ctn", default_delivery_days: 1, enable_offline: true, encrypt_local_data: true, max_offline_hours: 72, max_order_age_days: 7, nearby_radius_m: 500, require_location: false, ageing_ranges: [30, 60, 90, 120] },
		device: { key: Buffer.from(createHash("sha256").update(db.user).digest()).toString("base64"), key_id: "dev-key-1" },
		csrf_token: "csrf-dev",
		server_time: new Date().toISOString(),
		app_version: "1.0.0",
	}),
	"data.master_data": (q) => {
		const payload = { customers: db.customers, items: db.items, no_order_reasons: ["Shop Closed", "Stock Available", "Not Interested"], visits_today: [], default_price_list: "Retail" };
		const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
		if (q.get("known_hash") === hash) return { unchanged: true, hash };
		return { ...payload, hash, generated_at: new Date().toISOString() };
	},
	"orders.submit_orders": (_q, body) => {
		if (db.failNext > 0) {
			db.failNext--;
			throw Object.assign(new Error("down"), { status: 502 });
		}
		return {
			results: body.orders.map((o) => {
				const dup = db.orders.find((x) => x.client_uuid === o.client_uuid);
				if (dup) return { client_uuid: o.client_uuid, status: "duplicate", doctype: "Sales Order", name: dup.name };
				const name = o.outcome === "no_order" ? `SSM-VIS-${db.orders.length + 1}` : `SAL-ORD-2026-${String(db.orders.length + 1).padStart(5, "0")}`;
				db.orders.push({ ...o, name });
				return { client_uuid: o.client_uuid, status: "ok", doctype: o.outcome === "no_order" ? "SSM Visit" : "Sales Order", name, docstatus: 0, grand_total: o.estimated_total };
			}),
		};
	},
	"orders.order_history": () => db.orders.filter((o) => o.outcome === "order").map((o) => ({ name: o.name, customer: o.customer, customer_name: o.customer, transaction_date: "2026-11-22", grand_total: o.estimated_total, status: "Draft", total_qty: o.items.reduce((s, i) => s + i.qty, 0), currency: "PKR" })),
	"outstanding.get_outstanding": (q) => {
		const rows = db.customers
			.filter((c) => c.outstanding)
			.map((c) => ({ customer: c.name, customer_name: c.customer_name, total: c.outstanding, invoiced: c.outstanding, unallocated: 0, invoice_count: 2, oldest_days: 45, buckets: [{ label: "Not Due", amount: c.outstanding * 0.4 }, { label: "1-30", amount: c.outstanding * 0.3 }, { label: "31-60", amount: c.outstanding * 0.3 }, { label: "61-90", amount: 0 }, { label: "91-120", amount: 0 }, { label: "121+", amount: 0 }] }));
		const one = q.get("customer");
		if (one) return { ...rows.find((r) => r.customer === one), invoices: [{ name: "ACC-SINV-2026-00012", posting_date: "2026-10-01", due_date: "2026-10-08", grand_total: 9000, outstanding_amount: 4620 }] };
		return { as_of: "2026-11-22", rows };
	},
};

export function start(port = 8765) {
	const { build, files } = manifest();
	const server = createServer((req, res) => {
		const url = new URL(req.url, `http://${req.headers.host}`);
		const sec = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" };
		const send = (status, type, body, extra = {}) => {
			res.writeHead(status, { "Content-Type": type, ...sec, ...extra });
			res.end(body);
		};
		const p = url.pathname;
		if (p === "/ssm" || p.startsWith("/ssm/")) {
			const html = readFileSync(join(ROOT, "templates", "ssm_shell.html"), "utf8").replaceAll("__BUILD__", build);
			return send(200, "text/html", html, { "Cache-Control": "no-cache", "Set-Cookie": `user_id=${encodeURIComponent(db.user)}; Path=/` });
		}
		if (p === "/ssm-sw.js") {
			const sw = readFileSync(join(PUBLIC, "sw.js"), "utf8").replace("__BUILD__", build).replace("/*__ASSETS__*/", files.map((f) => `"/ssm-assets/${build}/${f}"`).join(",\n\t"));
			return send(200, "text/javascript", sw, { "Service-Worker-Allowed": "/ssm", "Cache-Control": "no-cache" });
		}
		if (p.startsWith("/ssm-assets/")) {
			const rel = p.split("/").slice(3).join("/");
			if (!files.includes(rel)) return send(404, "text/plain", "Not found");
			return send(200, TYPES[extname(rel)], readFileSync(join(PUBLIC, rel)));
		}
		if (p.startsWith("/api/method/secondary_sales.api.")) {
			const method = p.slice("/api/method/secondary_sales.api.".length);
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				try {
					if (req.method === "POST" && req.headers["x-frappe-csrf-token"] !== "csrf-dev") return send(400, "application/json", JSON.stringify({ exc_type: "CSRFTokenError" }));
					const fn = api[method];
					if (!fn) return send(404, "application/json", "{}");
					const out = fn(url.searchParams, body ? JSON.parse(body) : {});
					send(200, "application/json", JSON.stringify({ message: out }));
				} catch (e) {
					send(e.status || 500, "application/json", JSON.stringify({ exception: e.message }));
				}
			});
			return;
		}
		if (p === "/api/method/logout") return send(200, "application/json", "{}");
		if (p === "/login") return send(200, "text/html", "<h1>Login</h1>");
		send(404, "text/plain", "Not found");
	});
	return new Promise((r) => server.listen(port, () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	start(Number(process.env.PORT) || 8765).then(() => console.log("Mock server on http://localhost:8765/ssm"));
}

export { randomUUID };
