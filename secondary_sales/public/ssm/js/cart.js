// Pure cart logic shared by every cart display option.

import { round } from "./util.js";

export function toPieces(cases, pcs, factor) {
	const c = Math.max(0, Math.floor(Number(cases) || 0));
	const p = Math.max(0, Number(pcs) || 0);
	return factor > 0 ? c * factor + p : p;
}

export function splitPieces(total, factor) {
	total = Math.max(0, Number(total) || 0);
	if (!(factor > 0)) return { cases: 0, pcs: round(total, 3) };
	const cases = Math.floor(total / factor + 1e-9);
	return { cases, pcs: round(total - cases * factor, 3) };
}

export function priceFor(item, priceList, fallbackList) {
	const p = item?.prices;
	if (!p) return null;
	if (priceList && p[priceList] != null) return Number(p[priceList]);
	if (fallbackList && p[fallbackList] != null) return Number(p[fallbackList]);
	return null;
}

export class Cart {
	constructor({ customer, priceList, fallbackList, lines = [] } = {}) {
		this.customer = customer;
		this.priceList = priceList;
		this.fallbackList = fallbackList;
		this.lines = new Map();
		for (const l of lines) this.lines.set(l.item_code, { ...l });
	}

	static fromJSON(json) {
		return new Cart(json || {});
	}

	toJSON() {
		return { customer: this.customer, priceList: this.priceList, fallbackList: this.fallbackList, lines: [...this.lines.values()] };
	}

	get(itemCode) {
		return this.lines.get(itemCode);
	}

	qtyOf(itemCode) {
		return this.lines.get(itemCode)?.qty || 0;
	}

	setQty(item, qty) {
		qty = round(Math.max(0, Number(qty) || 0), 3);
		if (!qty) {
			this.lines.delete(item.item_code);
			return null;
		}
		const existing = this.lines.get(item.item_code);
		const line = existing || {
			item_code: item.item_code,
			item_name: item.item_name,
			stock_uom: item.stock_uom,
			pack_factor: item.pack_factor || 0,
			price: priceFor(item, this.priceList, this.fallbackList),
			rate: null,
			discount_percentage: null,
		};
		line.qty = qty;
		this.lines.set(item.item_code, line);
		return line;
	}

	setRate(itemCode, rate) {
		const l = this.lines.get(itemCode);
		if (l) l.rate = rate === "" || rate === null || rate === undefined ? null : Math.max(0, Number(rate) || 0);
	}

	setDiscount(itemCode, pct) {
		const l = this.lines.get(itemCode);
		if (l) l.discount_percentage = pct === "" || pct === null || pct === undefined ? null : Math.min(100, Math.max(0, Number(pct) || 0));
	}

	remove(itemCode) {
		this.lines.delete(itemCode);
	}

	clear() {
		this.lines.clear();
	}

	static effectiveRate(line) {
		let rate = line.rate != null ? line.rate : line.price;
		if (rate == null) return null;
		if (line.discount_percentage) rate = rate * (1 - line.discount_percentage / 100);
		return round(rate, 6);
	}

	totals() {
		let amount = 0;
		let qty = 0;
		let cases = 0;
		let unpriced = 0;
		for (const l of this.lines.values()) {
			const r = Cart.effectiveRate(l);
			if (r == null) unpriced++;
			else amount += r * l.qty;
			qty += l.qty;
			if (l.pack_factor > 0) cases += l.qty / l.pack_factor;
		}
		return { lines: this.lines.size, qty: round(qty, 3), cases: round(cases, 2), amount: round(amount, 2), unpriced };
	}

	/** Build the payload the server validates. Only send rate/discount when the profile allows editing them. */
	toPayload({ client_uuid, created_at, delivery_date, remarks, geo, canRate, canDiscount }) {
		const items = [...this.lines.values()].map((l) => {
			const row = { item_code: l.item_code, qty: l.qty, estimated_rate: Cart.effectiveRate(l) };
			if (canRate && l.rate != null) row.rate = l.rate;
			if (canDiscount && l.discount_percentage != null) row.discount_percentage = l.discount_percentage;
			return row;
		});
		const payload = { client_uuid, outcome: "order", customer: this.customer, items, created_at, estimated_total: this.totals().amount };
		if (delivery_date) payload.delivery_date = delivery_date;
		if (remarks) payload.remarks = remarks;
		if (geo) payload.geo = geo;
		return payload;
	}
}
