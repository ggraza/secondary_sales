// Outbox: orders are saved locally first, then pushed to the server. The
// server is idempotent on client_uuid so retries are always safe.

import { AuthError, NetworkError } from "./api.js";

export const BATCH = 20;
export const MAX_AUTO_ATTEMPTS = 8;

export function backoffMs(attempts) {
	return Math.min(30000 * 2 ** Math.max(attempts - 1, 0), 30 * 60 * 1000);
}

export class SyncEngine {
	constructor({ store, api, onChange = () => {}, onAuthError = () => {}, now = () => Date.now(), isOnline = () => globalThis.navigator?.onLine !== false }) {
		this.store = store;
		this.api = api;
		this.onChange = onChange;
		this.onAuthError = onAuthError;
		this.now = now;
		this.isOnline = isOnline;
		this.running = null;
		this.lastError = null;
	}

	async enqueue(payload, display) {
		const rec = {
			client_uuid: payload.client_uuid,
			state: "pending",
			attempts: 0,
			next_at: 0,
			message: "",
			payload,
			display,
			queued_at: new Date(this.now()).toISOString(),
		};
		await this.store.put("outbox", rec.client_uuid, rec);
		this.onChange();
		return rec;
	}

	async outbox() {
		const all = await this.store.all("outbox");
		return all.sort((a, b) => (a.queued_at < b.queued_at ? -1 : 1));
	}

	async pendingCount() {
		return (await this.outbox()).filter((o) => o.state !== "rejected").length;
	}

	async due() {
		const t = this.now();
		return (await this.outbox()).filter(
			(o) => (o.state === "pending" || (o.state === "failed" && o.attempts < MAX_AUTO_ATTEMPTS)) && (o.next_at || 0) <= t
		);
	}

	/** Push due orders. Concurrent calls share one run. */
	run({ force = false } = {}) {
		if (!this.running) {
			this.running = this._run(force).finally(() => {
				this.running = null;
			});
		}
		return this.running;
	}

	async _run(force) {
		if (!this.isOnline()) return { sent: 0, offline: true };
		let sent = 0;
		const queue = force
			? (await this.outbox()).filter((o) => o.state === "pending" || o.state === "failed")
			: await this.due();
		for (let i = 0; i < queue.length; i += BATCH) {
			const batch = queue.slice(i, i + BATCH);
			let response;
			try {
				response = await this.api.call("orders.submit_orders", { body: { orders: batch.map((o) => o.payload) } });
				this.lastError = null;
			} catch (e) {
				this.lastError = e.message;
				if (e instanceof AuthError) {
					this.onAuthError(e);
					break;
				}
				if (e instanceof NetworkError) break;
				// Whole batch refused (e.g. profile no longer allows ordering).
				for (const o of batch) await this._fail(o, e.message, true);
				break;
			}
			const byId = new Map((response?.results || []).map((r) => [r.client_uuid, r]));
			for (const o of batch) {
				const r = byId.get(o.client_uuid);
				if (!r) await this._fail(o, "No response for this order", false);
				else if (r.status === "ok" || r.status === "duplicate") {
					await this._done(o, r);
					sent++;
				} else if (r.status === "rejected") await this._fail(o, r.message, true);
				else await this._fail(o, r.message || "Will retry", false);
			}
			this.onChange();
		}
		this.onChange();
		return { sent };
	}

	async _done(o, r) {
		await this.store.put("synced", o.client_uuid, {
			...o,
			state: "synced",
			synced_at: new Date(this.now()).toISOString(),
			server: { doctype: r.doctype, name: r.name, docstatus: r.docstatus, grand_total: r.grand_total, message: r.message || r.warning || "", price_changed: !!r.price_changed },
		});
		await this.store.del("outbox", o.client_uuid);
	}

	async _fail(o, message, rejected) {
		const attempts = (o.attempts || 0) + 1;
		await this.store.put("outbox", o.client_uuid, {
			...o,
			state: rejected ? "rejected" : "failed",
			attempts,
			message: message || "",
			next_at: rejected ? 0 : this.now() + backoffMs(attempts),
		});
	}

	async retry(client_uuid) {
		const o = await this.store.get("outbox", client_uuid);
		if (!o) return;
		await this.store.put("outbox", client_uuid, { ...o, state: "pending", next_at: 0, attempts: 0, message: "" });
		this.onChange();
		return this.run();
	}

	async discard(client_uuid) {
		await this.store.del("outbox", client_uuid);
		this.onChange();
	}
}
