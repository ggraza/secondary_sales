// Orders: the device outbox (waiting, failed, needs attention) and orders
// already accepted by the server.

import { backgroundSync } from "../app.js";
import { confirmDialog, empty, icon, segmented, sheet, toast } from "../ui.js";
import { clear, h, money, qty as fmtQty, relTime } from "../util.js";

let tab = "outbox";

const STATE = {
	pending: { label: "Waiting to send", tone: "pending" },
	failed: { label: "Will retry", tone: "pending" },
	rejected: { label: "Needs attention", tone: "error" },
	synced: { label: "Sent", tone: "order" },
};

export async function render(app) {
	const currency = app.settings.currency;
	const outbox = await app.sync.outbox();
	const synced = (await app.store.all("synced")).sort((a, b) => (a.synced_at < b.synced_at ? 1 : -1));
	const body = h("div", { class: "cards" });

	const tabs = segmented(
		[
			{ value: "outbox", label: `On this device (${outbox.length})` },
			{ value: "synced", label: "Sent" },
		],
		tab,
		(v) => {
			tab = v;
			app.refresh();
		},
		"Orders"
	);

	const actions = h(
		"div",
		{ class: "row gap end" },
		h(
			"button",
			{
				class: "btn",
				disabled: !outbox.length || !navigator.onLine,
				onclick: async (e) => {
					e.currentTarget.disabled = true;
					await app.sync.run({ force: true });
					await backgroundSync();
					app.refresh();
				},
			},
			icon("sync", 18),
			"Send now"
		)
	);

	if (tab === "outbox") {
		if (!outbox.length) body.appendChild(empty("check", "All orders sent", "Orders you place offline wait here until they reach the server."));
		for (const o of outbox) body.appendChild(outboxCard(app, o, currency));
	} else {
		for (const o of synced.slice(0, 100)) body.appendChild(syncedCard(app, o, currency));
		const serverList = h("div", { class: "cards" });
		body.appendChild(serverList);
		if (navigator.onLine) loadServerHistory(app, serverList, new Set(synced.map((s) => s.server?.name)), currency);
		else if (!synced.length) body.appendChild(empty("offline", "Offline", "Connect to see order history from the server."));
	}

	return { el: h("section", { class: "view" }, tabs, tab === "outbox" ? actions : null, body), title: "Orders" };
}

function summary(o, currency) {
	const d = o.display || {};
	if (o.payload.outcome === "no_order") return `No order: ${d.reason || o.payload.no_order_reason}`;
	return `${d.lines || o.payload.items.length} lines · about ${money(d.total || 0, currency)}`;
}

function outboxCard(app, o, currency) {
	const st = STATE[o.state] || STATE.pending;
	return h(
		"article",
		{ class: `card order-card st-${st.tone}` },
		h(
			"div",
			{ class: "card-body" },
			h("div", { class: "row between" }, h("div", { class: "card-title" }, o.display?.customer_name || o.payload.customer), h("span", { class: `tag ${st.tone}` }, st.label)),
			h("div", { class: "muted small" }, summary(o, currency), ` · saved ${relTime(o.queued_at)}`),
			o.message ? h("p", { class: `note ${o.state === "rejected" ? "error" : "warn"}` }, icon("alert", 16), o.message) : null,
			h(
				"div",
				{ class: "row gap end" },
				h("button", { class: "btn small", onclick: () => details(app, o, currency) }, "Details"),
				o.state !== "pending"
					? h(
							"button",
							{
								class: "btn small",
								onclick: async () => {
									await app.sync.retry(o.client_uuid);
									app.refresh();
								},
							},
							"Retry"
					  )
					: null,
				o.state === "rejected" && o.payload.outcome === "order"
					? h(
							"button",
							{
								class: "btn small",
								title: "Move the items back into the cart to fix and place again",
								onclick: async () => {
									const lines = [];
									for (const l of o.payload.items) {
										const item = app.itemsByCode.get(l.item_code);
										if (item) lines.push({ item_code: item.item_code, item_name: item.item_name, stock_uom: item.stock_uom, pack_factor: item.pack_factor, price: l.estimated_rate, qty: l.qty, rate: l.rate ?? null, discount_percentage: l.discount_percentage ?? null });
									}
									await app.store.put("kv", `cart:${o.payload.customer}`, { customer: o.payload.customer, lines });
									await app.sync.discard(o.client_uuid);
									app.go(`#/order/${encodeURIComponent(o.payload.customer)}`);
								},
							},
							"Edit"
					  )
					: null,
				o.state === "rejected"
					? h(
							"button",
							{
								class: "btn small danger",
								onclick: async () => {
									if (await confirmDialog("Discard order?", "It will be deleted from this device and never sent.", "Discard", "danger")) {
										await app.sync.discard(o.client_uuid);
										toast("Order discarded");
										app.refresh();
									}
								},
							},
							"Discard"
					  )
					: null
			)
		)
	);
}

function syncedCard(app, o, currency) {
	const s = o.server || {};
	return h(
		"article",
		{ class: "card order-card st-order" },
		h(
			"div",
			{ class: "card-body" },
			h("div", { class: "row between" }, h("div", { class: "card-title" }, o.display?.customer_name || o.payload.customer), h("span", { class: "tag order" }, s.doctype === "SSM Visit" ? "Visit saved" : s.docstatus === 1 ? "Submitted" : "Draft")),
			h("div", { class: "muted small" }, s.name || "", " · ", summary(o, currency), ` · sent ${relTime(o.synced_at)}`),
			s.grand_total != null && s.doctype === "Sales Order" ? h("div", null, "Server total ", h("b", null, money(s.grand_total, currency))) : null,
			s.message ? h("p", { class: `note ${s.price_changed ? "warn" : ""}` }, icon("alert", 16), s.message) : null
		)
	);
}

async function loadServerHistory(app, el, skip, currency) {
	el.appendChild(h("p", { class: "muted small" }, "Loading history…"));
	try {
		const rows = await app.api.call("orders.order_history", { params: { limit: 50 } });
		clear(el);
		const list = rows.filter((r) => !skip.has(r.name));
		if (list.length) el.appendChild(h("h3", { class: "section-title" }, "Recent orders"));
		for (const r of list)
			el.appendChild(
				h(
					"article",
					{ class: "card order-card", onclick: () => serverDetail(app, r.name, currency) },
					h(
						"div",
						{ class: "card-body" },
						h("div", { class: "row between" }, h("div", { class: "card-title" }, r.customer_name), h("span", { class: "tag subtle" }, r.status)),
						h("div", { class: "muted small" }, `${r.name} · ${r.transaction_date} · ${fmtQty(r.total_qty)} pcs`),
						h("b", null, money(r.grand_total, r.currency || currency))
					)
				)
			);
	} catch (e) {
		clear(el).appendChild(h("p", { class: "muted small" }, `Could not load history: ${e.message}`));
	}
}

async function serverDetail(app, name, currency) {
	const body = h("p", { class: "muted" }, "Loading…");
	const s = sheet(name, body, { wide: true });
	try {
		const d = await app.api.call("orders.order_detail", { params: { name } });
		const content = h(
			"div",
			{ class: "stack" },
			h("div", { class: "muted small" }, `${d.customer_name} · ${d.transaction_date} · delivery ${d.delivery_date} · ${d.status}`),
			h(
				"div",
				{ class: "table-wrap" },
				h(
					"table",
					{ class: "item-table" },
					h("thead", null, h("tr", null, h("th", null, "Item"), h("th", { class: "num" }, "Qty"), h("th", { class: "num" }, "Rate"), h("th", { class: "num" }, "Amount"))),
					h("tbody", null, d.items.map((i) => h("tr", null, h("td", null, i.item_name), h("td", { class: "num" }, `${fmtQty(i.qty)} ${i.uom}`), h("td", { class: "num" }, money(i.rate, d.currency)), h("td", { class: "num" }, money(i.amount, d.currency)))))
				)
			),
			h("dl", { class: "totals" }, h("dt", null, "Taxes"), h("dd", null, money(d.total_taxes_and_charges, d.currency)), h("dt", { class: "grand" }, "Grand total"), h("dd", { class: "grand" }, money(d.grand_total, d.currency)))
		);
		body.replaceWith(content);
	} catch (e) {
		body.textContent = e.message;
	}
	return s;
}

function details(app, o, currency) {
	const p = o.payload;
	const rows =
		p.outcome === "no_order"
			? h("p", null, `Reason: ${p.no_order_reason}`)
			: h(
					"div",
					{ class: "table-wrap" },
					h(
						"table",
						{ class: "item-table" },
						h("thead", null, h("tr", null, h("th", null, "Item"), h("th", { class: "num" }, "Qty"), h("th", { class: "num" }, "Est. rate"))),
						h(
							"tbody",
							null,
							p.items.map((l) => {
								const item = app.itemsByCode.get(l.item_code);
								return h("tr", null, h("td", null, item?.item_name || l.item_code), h("td", { class: "num" }, `${fmtQty(l.qty)} ${item?.stock_uom || ""}`), h("td", { class: "num" }, l.estimated_rate == null ? "–" : money(l.estimated_rate, currency)));
							})
						)
					)
			  );
	sheet(o.display?.customer_name || p.customer, h("div", { class: "stack" }, h("div", { class: "muted small" }, `Reference ${p.client_uuid}`), rows, p.remarks ? h("p", null, `Remarks: ${p.remarks}`) : null), { wide: true });
}
