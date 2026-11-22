import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { decryptJSON, encryptJSON, importKey } from "../secondary_sales/public/ssm/js/crypto.js";
import { deleteDB, openDB, Store } from "../secondary_sales/public/ssm/js/store.js";

const KEY_B64 = Buffer.from(new Uint8Array(32).map((_, i) => i * 7)).toString("base64");

test("AES-GCM round trip, random IV, tamper detection", async () => {
	const key = await importKey(KEY_B64);
	const a = await encryptJSON(key, { secret: "Bismillah Store" });
	const b = await encryptJSON(key, { secret: "Bismillah Store" });
	assert.notDeepEqual(a.iv, b.iv);
	assert.deepEqual(await decryptJSON(key, a), { secret: "Bismillah Store" });
	a.ct[0] ^= 1;
	await assert.rejects(decryptJSON(key, a));
});

test("key must be 256 bits and is not extractable", async () => {
	await assert.rejects(importKey(Buffer.from("short").toString("base64")));
	const key = await importKey(KEY_B64);
	assert.equal(key.extractable, false);
	await assert.rejects(crypto.subtle.exportKey("raw", key));
});

test("stored records are ciphertext, not readable JSON", async () => {
	const idb = new IDBFactory();
	const key = await importKey(KEY_B64);
	const store = new Store(await openDB("ssm-test", undefined, idb), key);
	await store.put("kv", "masters", { customers: [{ name: "CUST-1", customer_name: "Zulfiqar General Store", mobile_no: "03001234567" }] });

	const raw = await new Promise((res, rej) => {
		const r = store.db.transaction("kv").objectStore("kv").get("masters");
		r.onsuccess = () => res(r.result);
		r.onerror = () => rej(r.error);
	});
	assert.ok(raw.iv && raw.ct, "record is encrypted");
	assert.ok(!("v" in raw));
	const asText = Buffer.from(raw.ct).toString("latin1");
	assert.ok(!asText.includes("Zulfiqar") && !asText.includes("0300"), "no plaintext leaks");
	assert.equal((await store.get("kv", "masters")).customers[0].customer_name, "Zulfiqar General Store");

	// A different key (rotated / other user) cannot read it.
	const other = new Store(store.db, await importKey(Buffer.from(new Uint8Array(32).fill(9)).toString("base64")));
	await assert.rejects(other.get("kv", "masters"));
	assert.deepEqual(await other.all("kv"), [], "unreadable records are skipped, not crashed on");
	store.close();
	await deleteDB("ssm-test", idb);
});

test("plain mode when encryption is off", async () => {
	const idb = new IDBFactory();
	const store = new Store(await openDB("ssm-plain", undefined, idb), null);
	await store.put("outbox", "a", { x: 1 });
	await store.put("outbox", "b", { x: 2 });
	assert.deepEqual((await store.all("outbox")).map((r) => r.x).sort(), [1, 2]);
	await store.del("outbox", "a");
	assert.equal(await store.get("outbox", "a"), undefined);
	await store.clear("outbox");
	assert.deepEqual(await store.all("outbox"), []);
});
