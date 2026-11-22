import assert from "node:assert/strict";
import test from "node:test";
import { Api, AuthError, isGuestCookie, NetworkError, ServerError } from "../secondary_sales/public/ssm/js/api.js";
import { distanceM, isSafeUrl, matchesQuery, round, uuid4 } from "../secondary_sales/public/ssm/js/util.js";

function fakeFetch(responses) {
	const seen = [];
	const fn = async (url, init) => {
		seen.push({ url, init });
		const r = responses.shift();
		if (r instanceof Error) throw r;
		return { ok: r.status < 400, status: r.status, json: async () => r.body };
	};
	fn.seen = seen;
	return fn;
}

test("GET encodes params, POST sends CSRF token and JSON", async () => {
	const f = fakeFetch([{ status: 200, body: { message: 1 } }, { status: 200, body: { message: 2 } }]);
	const api = new Api({ fetchImpl: f });
	api.csrf = "tok";
	assert.equal(await api.call("data.master_data", { params: { known_hash: "a&b" } }), 1);
	assert.match(f.seen[0].url, /secondary_sales\.api\.data\.master_data\?known_hash=a%26b$/);
	assert.equal(f.seen[0].init.credentials, "same-origin");
	assert.equal(await api.call("orders.submit_orders", { body: { orders: [] } }), 2);
	assert.equal(f.seen[1].init.method, "POST");
	assert.equal(f.seen[1].init.headers["X-Frappe-CSRF-Token"], "tok");
});

test("error mapping", async () => {
	const api = new Api({
		fetchImpl: fakeFetch([
			new TypeError("Failed to fetch"),
			{ status: 401, body: {} },
			{ status: 502, body: null },
			{ status: 417, body: { exc_type: "ValidationError", _server_messages: JSON.stringify([JSON.stringify({ message: "Credit limit <b>crossed</b>" })]) } },
		]),
	});
	await assert.rejects(api.call("x"), NetworkError);
	await assert.rejects(api.call("x"), AuthError);
	await assert.rejects(api.call("x"), NetworkError);
	await assert.rejects(api.call("x"), (e) => e instanceof ServerError && e.message === "Credit limit crossed");
});

test("expired CSRF token is refreshed once", async () => {
	const f = fakeFetch([{ status: 400, body: { exc_type: "CSRFTokenError" } }, { status: 200, body: { message: "ok" } }]);
	const api = new Api({ fetchImpl: f });
	api.csrf = "old";
	api.onCsrfExpired = async () => "new";
	assert.equal(await api.call("orders.submit_orders", { body: {} }), "ok");
	assert.equal(f.seen[1].init.headers["X-Frappe-CSRF-Token"], "new");
});

test("guest cookie detection", () => {
	assert.equal(isGuestCookie("user_id=Guest; sid=x"), true);
	assert.equal(isGuestCookie(""), true);
	assert.equal(isGuestCookie("sid=1; user_id=rep%40example.com"), false);
});

test("only safe URLs are allowed in links", () => {
	assert.equal(isSafeUrl("javascript:alert(1)"), false);
	assert.equal(isSafeUrl(" JavaScript:alert(1)"), false);
	assert.equal(isSafeUrl("data:text/html,x"), false);
	assert.equal(isSafeUrl("#/order/C1"), true);
	assert.equal(isSafeUrl("tel:0300"), true);
});

test("helpers", () => {
	assert.match(uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.equal(round(1.005, 2), 1.01);
	assert.equal(round(1e-12, 2), 0);
	assert.equal(round(-2.345, 2), -2.35);
	assert.ok(matchesQuery(["Zulfiqar GS", "0331"], "zul 0331"));
	assert.ok(!matchesQuery(["Zulfiqar GS"], "hafiz"));
	const d = distanceM({ lat: 31.5204, lng: 74.3587 }, { lat: 31.5304, lng: 74.3587 });
	assert.ok(d > 1100 && d < 1120, d);
});
