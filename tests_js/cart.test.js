import assert from "node:assert/strict";
import test from "node:test";
import { Cart, priceFor, splitPieces, toPieces } from "../secondary_sales/public/ssm/js/cart.js";

const cola = { item_code: "COLA-1L", item_name: "Cola 1L", stock_uom: "Nos", pack_factor: 12, prices: { Retail: 50, Special: 45 } };
const chips = { item_code: "CHIPS", item_name: "Chips", stock_uom: "Nos", pack_factor: 0, prices: { Retail: 20 } };

test("cases and pieces convert both ways", () => {
	assert.equal(toPieces(2, 3, 12), 27);
	assert.equal(toPieces(-1, -5, 12), 0);
	assert.equal(toPieces(5, 3, 0), 3);
	assert.deepEqual(splitPieces(27, 12), { cases: 2, pcs: 3 });
	assert.deepEqual(splitPieces(7, 0), { cases: 0, pcs: 7 });
});

test("customer price list wins, falls back to default", () => {
	assert.equal(priceFor(cola, "Special", "Retail"), 45);
	assert.equal(priceFor(chips, "Special", "Retail"), 20);
	assert.equal(priceFor({ prices: {} }, "Special", "Retail"), null);
});

test("totals with discount and unpriced lines", () => {
	const cart = new Cart({ customer: "C1", priceList: "Retail", fallbackList: "Retail" });
	cart.setQty(cola, 24);
	cart.setQty(chips, 5);
	cart.setDiscount("COLA-1L", 10);
	cart.setQty({ item_code: "X", item_name: "X", stock_uom: "Nos", prices: {} }, 1);
	const t = cart.totals();
	assert.equal(t.lines, 3);
	assert.equal(t.amount, 24 * 45 + 5 * 20);
	assert.equal(t.cases, 2);
	assert.equal(t.unpriced, 1);
});

test("setting qty to zero removes the line; JSON round trip", () => {
	const cart = new Cart({ customer: "C1", priceList: "Retail" });
	cart.setQty(cola, 12);
	cart.setQty(chips, 2);
	cart.setQty(chips, 0);
	const copy = Cart.fromJSON(JSON.parse(JSON.stringify(cart.toJSON())));
	assert.equal(copy.lines.size, 1);
	assert.equal(copy.qtyOf("COLA-1L"), 12);
});

test("payload only carries rate/discount when the profile allows editing", () => {
	const cart = new Cart({ customer: "C1", priceList: "Retail" });
	cart.setQty(cola, 12);
	cart.setRate("COLA-1L", 40);
	cart.setDiscount("COLA-1L", 5);
	const base = { client_uuid: "u", created_at: "2026-01-01T00:00:00Z" };
	const locked = cart.toPayload({ ...base, canRate: false, canDiscount: false });
	assert.equal(locked.items[0].rate, undefined);
	assert.equal(locked.items[0].discount_percentage, undefined);
	const open = cart.toPayload({ ...base, canRate: true, canDiscount: true });
	assert.equal(open.items[0].rate, 40);
	assert.equal(open.items[0].discount_percentage, 5);
	assert.equal(open.outcome, "order");
	assert.equal(open.estimated_total, 12 * 38);
});

test("discount is clamped to 0..100", () => {
	const cart = new Cart({ customer: "C1", priceList: "Retail" });
	cart.setQty(cola, 1);
	cart.setDiscount("COLA-1L", 500);
	assert.equal(cart.get("COLA-1L").discount_percentage, 100);
	cart.setDiscount("COLA-1L", -3);
	assert.equal(cart.get("COLA-1L").discount_percentage, 0);
});
