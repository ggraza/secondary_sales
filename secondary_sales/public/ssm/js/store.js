// IndexedDB storage. One database per user (name derived from a hash of the
// user id) plus a small "meta" database that only remembers which user last
// signed in, the key id and the CryptoKey handle.

import { decryptJSON, encryptJSON } from "./crypto.js";

const VERSION = 1;
export const STORES = ["kv", "outbox", "synced"];

function req(r) {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

export function openDB(name, stores = STORES, idb = globalThis.indexedDB) {
	return new Promise((resolve, reject) => {
		const r = idb.open(name, VERSION);
		r.onupgradeneeded = () => {
			for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
		};
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
		r.onblocked = () => reject(new Error("Database blocked by another tab"));
	});
}

export function deleteDB(name, idb = globalThis.indexedDB) {
	return new Promise((resolve) => {
		const r = idb.deleteDatabase(name);
		r.onsuccess = r.onerror = r.onblocked = () => resolve();
	});
}

export class Store {
	/** @param {IDBDatabase} db @param {CryptoKey|null} key */
	constructor(db, key) {
		this.db = db;
		this.key = key;
	}

	tx(store, mode = "readonly") {
		return this.db.transaction(store, mode).objectStore(store);
	}

	async wrap(value) {
		if (!this.key) return { v: value };
		const { iv, ct } = await encryptJSON(this.key, value);
		return { iv, ct };
	}

	async unwrap(rec) {
		if (rec === undefined || rec === null) return undefined;
		if ("v" in rec) return rec.v;
		if (!this.key) throw new Error("Encrypted data but no key");
		return decryptJSON(this.key, rec);
	}

	async get(store, id) {
		return this.unwrap(await req(this.tx(store).get(id)));
	}

	async put(store, id, value) {
		const rec = await this.wrap(value); // encrypt before opening the transaction
		await req(this.tx(store, "readwrite").put(rec, id));
		return value;
	}

	async del(store, id) {
		await req(this.tx(store, "readwrite").delete(id));
	}

	async all(store) {
		const recs = await req(this.tx(store).getAll());
		const out = [];
		for (const r of recs) {
			try {
				out.push(await this.unwrap(r));
			} catch {
				/* unreadable record (old key) is skipped */
			}
		}
		return out;
	}

	async clear(store) {
		await req(this.tx(store, "readwrite").clear());
	}

	close() {
		this.db.close();
	}
}

/** Unencrypted bookkeeping that must be readable before the key is known. */
export class Meta {
	constructor(db) {
		this.db = db;
	}
	static async open(idb) {
		return new Meta(await openDB("ssm-meta", ["meta"], idb));
	}
	async get(k) {
		return req(this.db.transaction("meta").objectStore("meta").get(k));
	}
	async set(k, v) {
		return req(this.db.transaction("meta", "readwrite").objectStore("meta").put(v, k));
	}
	async del(k) {
		return req(this.db.transaction("meta", "readwrite").objectStore("meta").delete(k));
	}
}
