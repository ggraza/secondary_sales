// Thin client for the app's whitelisted Frappe methods. Uses the browser
// session cookie plus the CSRF token for writes; never stores passwords.

const BASE = "/api/method/secondary_sales.api.";

export class NetworkError extends Error {}
export class AuthError extends Error {}
export class ServerError extends Error {
	constructor(message, status, excType) {
		super(message);
		this.status = status;
		this.excType = excType;
	}
}

function serverMessage(data) {
	try {
		if (data?._server_messages) {
			const msgs = JSON.parse(data._server_messages).map((m) => {
				try {
					return JSON.parse(m).message;
				} catch {
					return m;
				}
			});
			return msgs.join("\n").replace(/<[^>]*>/g, "");
		}
	} catch {
		/* ignore */
	}
	return (data?.exception || data?.message || "").toString().replace(/<[^>]*>/g, "").slice(0, 300);
}

export function isGuestCookie(cookie = globalThis.document?.cookie || "") {
	const m = cookie.match(/(?:^|;\s*)user_id=([^;]*)/);
	return !m || decodeURIComponent(m[1]) === "Guest";
}

export class Api {
	constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), timeoutMs = 20000 } = {}) {
		this.fetch = fetchImpl;
		this.timeoutMs = timeoutMs;
		this.csrf = null;
		this.onCsrfExpired = null; // async () => new token
	}

	async call(method, { params, body, httpMethod = body ? "POST" : "GET", retry = true } = {}) {
		let url = BASE + method;
		const init = { method: httpMethod, credentials: "same-origin", headers: { Accept: "application/json" } };
		if (httpMethod === "GET" && params) {
			const qs = new URLSearchParams();
			for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.set(k, typeof v === "object" ? JSON.stringify(v) : v);
			url += "?" + qs.toString();
		}
		if (httpMethod !== "GET") {
			init.headers["Content-Type"] = "application/json";
			if (this.csrf) init.headers["X-Frappe-CSRF-Token"] = this.csrf;
			init.body = JSON.stringify(body || {});
		}
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
		init.signal = ctrl.signal;

		let res;
		try {
			res = await this.fetch(url, init);
		} catch (e) {
			throw new NetworkError(e?.name === "AbortError" ? "Request timed out" : "No connection");
		} finally {
			clearTimeout(timer);
		}

		let data = null;
		try {
			data = await res.json();
		} catch {
			data = null;
		}

		if (res.ok) return data?.message;

		const exc = data?.exc_type || "";
		if (res.status === 400 && exc === "CSRFTokenError" && retry && this.onCsrfExpired) {
			this.csrf = await this.onCsrfExpired();
			return this.call(method, { params, body, httpMethod, retry: false });
		}
		if (res.status === 401 || exc === "AuthenticationError" || exc === "SessionExpired" || (res.status === 403 && isGuestCookie())) {
			throw new AuthError("Your session has ended. Please sign in again.");
		}
		if (res.status >= 500 || res.status === 429 || res.status === 0) {
			throw new NetworkError(serverMessage(data) || `Server error ${res.status}`);
		}
		throw new ServerError(serverMessage(data) || `Request failed (${res.status})`, res.status, exc);
	}
}
