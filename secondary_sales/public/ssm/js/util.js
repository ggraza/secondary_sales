// Small DOM and formatting helpers. h() only ever creates text nodes for
// strings, so data from the server can never be interpreted as HTML.

export function h(tag, attrs, ...children) {
	const el = document.createElement(tag);
	if (attrs) {
		for (const [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null || v === false) continue;
			if (k === "class") el.className = v;
			else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
			else if (k === "dataset") Object.assign(el.dataset, v);
			else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
			else if (k === "value") el.value = v;
			else if (k === "checked" || k === "disabled" || k === "selected") el[k] = !!v;
			else if (k === "style" || k === "innerHTML" || k.startsWith("on")) continue; // never allow raw HTML/handlers
			else if (k === "href" && !isSafeUrl(v)) continue;
			else el.setAttribute(k, v === true ? "" : String(v));
		}
	}
	append(el, children);
	return el;
}

function append(el, children) {
	for (const c of children) {
		if (c === null || c === undefined || c === false) continue;
		if (Array.isArray(c)) append(el, c);
		else if (c instanceof Node) el.appendChild(c);
		else el.appendChild(document.createTextNode(String(c)));
	}
}

export function isSafeUrl(url) {
	const s = String(url || "").trim().toLowerCase();
	return s.startsWith("/") || s.startsWith("#") || s.startsWith("tel:") || s.startsWith("https:") || s.startsWith("geo:");
}

export function clear(el) {
	// Blur a focused descendant first: removing a focused input fires
	// blur/change mid-removal, and change handlers may re-render this node.
	const active = globalThis.document?.activeElement;
	if (active && active !== el && el.contains(active)) active.blur();
	el.replaceChildren();
	return el;
}

export function uuid4() {
	if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
	const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
	b[6] = (b[6] & 0x0f) | 0x40;
	b[8] = (b[8] & 0x3f) | 0x80;
	const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function round(n, d = 2) {
	const x = Number(n) || 0;
	if (Math.abs(x) < 1e-9 || Math.abs(x) >= 1e15) return Math.round(x * 10 ** d) / 10 ** d;
	// Exponent shifting avoids binary float errors such as 1.005 -> 1.00.
	const sign = x < 0 ? -1 : 1;
	return sign * Number(`${Math.round(Number(`${Math.abs(x)}e${d}`))}e-${d}`);
}

const moneyFormatters = new Map();
export function money(n, currency) {
	const key = currency || "";
	if (!moneyFormatters.has(key)) {
		let fmt;
		try {
			fmt = new Intl.NumberFormat(undefined, currency ? { style: "currency", currency, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 });
		} catch {
			fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
		}
		moneyFormatters.set(key, fmt);
	}
	return moneyFormatters.get(key).format(Number(n) || 0);
}

export function qty(n) {
	return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(Number(n) || 0);
}

export function debounce(fn, ms = 200) {
	let t;
	return (...args) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...args), ms);
	};
}

export function distanceM(a, b) {
	if (!a || !b || a.lat == null || b.lat == null) return null;
	const R = 6371000;
	const toRad = (x) => (x * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(s));
}

export function fmtDistance(m) {
	if (m == null) return "";
	return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
}

export function todayISO(d = new Date()) {
	const p = (x) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysISO(days, d = new Date()) {
	const x = new Date(d);
	x.setDate(x.getDate() + (Number(days) || 0));
	return todayISO(x);
}

export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function dayName(d = new Date()) {
	return DAYS[d.getDay()];
}

export function initials(name) {
	return String(name || "?")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0].toUpperCase())
		.join("");
}

export function relTime(iso) {
	if (!iso) return "never";
	const diff = (Date.now() - new Date(iso).getTime()) / 1000;
	if (diff < 60) return "just now";
	if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
	if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
	return `${Math.floor(diff / 86400)} d ago`;
}

export async function sha256Hex(text) {
	const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function matchesQuery(fields, q) {
	if (!q) return true;
	const hay = fields.filter(Boolean).join(" ").toLowerCase();
	return q
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((t) => hay.includes(t));
}
