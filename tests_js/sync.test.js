import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { AuthError, NetworkError, ServerError } from "../secondary_sales/public/ssm/js/api.js";
import { openDB, Store } from "../secondary_sales/public/ssm/js/store.js";
import { backoffMs, MAX_AUTO_ATTEMPTS, SyncEngine } from "../secondary_sales/public/ssm/js/sync.js";

let n = 0;
async function setup(handler, { online = true } = {}) {
	const store = new Store(await openDB(`sync-${n++}`, undefined, new IDBFactory()), null);
	const calls = [];
	const api = {
		async call(method, opts) {
			calls.push({ method, opts });
			return handler(opts.body.orders, calls.length);
		},
	};
	let now = 1_000_000;
	const engine = new SyncEngine({ store, api, now: () => now, isOnline: () => online });
	return { store, engine, calls, tick: (ms) => (now += ms) };
}
const payload = (id) => ({ client_uuid: id, outcome: "order", customer: "C", items: [{ item_code: "A", qty: 1 }] });

test("successful sync moves orders from outbox to synced", async () => {
	const { store, engine } = await setup((orders) => ({ results: orders.map((o) => ({ client_uuid: o.client_uuid, status: "ok", doctype: "Sales Order", name: `SO-${o.client_uuid}` })) }));
	await engine.enqueue(payload("a"), {});
	await engine.enqueue(payload("b"), {});
	const r = await engine.run();
	assert.equal(r.sent, 2);
	assert.equal((await engine.outbox()).length, 0);
	assert.equal((await store.get("synced", "a")).server.name, "SO-a");
});

test("duplicates count as success (idempotent retry after lost response)", async () => {
	const { engine } = await setup((orders) => ({ results: orders.map((o) => ({ client_uuid: o.client_uuid, status: "duplicate", name: "SO-1" })) }));
	await engine.enqueue(payload("a"), {});
	assert.equal((await engine.run()).sent, 1);
});

test("offline keeps everything queued and makes no calls", async () => {
	const { engine, calls } = await setup(() => ({ results: [] }), { online: false });
	await engine.enqueue(payload("a"), {});
	const r = await engine.run();
	assert.equal(r.offline, true);
	assert.equal(calls.length, 0);
	assert.equal(await engine.pendingCount(), 1);
});

test("network error leaves the order pending; failed result backs off", async () => {
	const { engine, calls, tick } = await setup((orders, i) => {
		if (i === 1) throw new NetworkError("down");
		return { results: orders.map((o) => ({ client_uuid: o.client_uuid, status: "failed", message: "deadlock" })) };
	});
	await engine.enqueue(payload("a"), {});
	await engine.run();
	assert.equal((await engine.outbox())[0].state, "pending");
	await engine.run();
	const o = (await engine.outbox())[0];
	assert.equal(o.state, "failed");
	assert.equal(o.attempts, 1);
	await engine.run(); // not due yet
	assert.equal(calls.length, 2);
	tick(backoffMs(1) + 1);
	await engine.run();
	assert.equal(calls.length, 3);
});

test("rejected orders stop retrying until the rep acts", async () => {
	const { engine, calls, tick } = await setup((orders) => ({ results: orders.map((o) => ({ client_uuid: o.client_uuid, status: "rejected", message: "Customer not allowed" })) }));
	await engine.enqueue(payload("a"), {});
	await engine.run();
	tick(10 * 60 * 60 * 1000);
	await engine.run();
	assert.equal(calls.length, 1);
	const o = (await engine.outbox())[0];
	assert.equal(o.state, "rejected");
	assert.equal(o.message, "Customer not allowed");
	assert.equal(await engine.pendingCount(), 0);
	await engine.discard("a");
	assert.equal((await engine.outbox()).length, 0);
});

test("auth error triggers callback and keeps orders", async () => {
	let authCalled = false;
	const { engine } = await setup(() => {
		throw new AuthError("expired");
	});
	engine.onAuthError = () => (authCalled = true);
	await engine.enqueue(payload("a"), {});
	await engine.run();
	assert.ok(authCalled);
	assert.equal((await engine.outbox())[0].state, "pending");
});

test("server refusing the whole batch marks orders rejected", async () => {
	const { engine } = await setup(() => {
		throw new ServerError("This screen is disabled for your profile.", 403, "PermissionError");
	});
	await engine.enqueue(payload("a"), {});
	await engine.run();
	assert.equal((await engine.outbox())[0].state, "rejected");
});

test("concurrent run() calls share one request", async () => {
	let resolveCall;
	const { engine, calls } = await setup((orders) => new Promise((r) => (resolveCall = () => r({ results: orders.map((o) => ({ client_uuid: o.client_uuid, status: "ok" })) }))));
	await engine.enqueue(payload("a"), {});
	const p1 = engine.run();
	const p2 = engine.run();
	assert.equal(p1, p2);
	await new Promise((r) => setTimeout(r, 20));
	resolveCall();
	await p1;
	assert.equal(calls.length, 1);
});

test("batches are capped and auto retries are bounded", async () => {
	assert.ok(backoffMs(20) <= 30 * 60 * 1000);
	assert.ok(MAX_AUTO_ATTEMPTS >= 3);
	const { engine, calls } = await setup((orders) => ({ results: orders.map((o) => ({ client_uuid: o.client_uuid, status: "ok" })) }));
	for (let i = 0; i < 45; i++) await engine.enqueue(payload(`id-${String(i).padStart(2, "0")}`), {});
	await engine.run();
	assert.deepEqual(calls.map((c) => c.opts.body.orders.length), [20, 20, 5]);
});
