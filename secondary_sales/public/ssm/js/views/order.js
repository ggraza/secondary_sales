// One-screen order taking: customer header, item browser in five display
// options, and a cart that is a side panel on tablets/desktop and a bottom
// bar + sheet on phones. Orders go to the encrypted outbox first.

import { backgroundSync, savePrefs } from "../app.js";
import { Cart, priceFor } from "../cart.js";
import { confirmDialog, empty, icon, qtyControl, segmented, sheet, toast } from "../ui.js";
import { addDaysISO, clear, debounce, h, initials, matchesQuery, money, qty as fmtQty, uuid4 } from "../util.js";
import { locate } from "./route.js";

const VIEW_META = {
	list: { label: "List", icon: "list" },
	grid: { label: "Grid", icon: "grid" },
	table: { label: "Table", icon: "table" },
	compact: { label: "Compact", icon: "compact" },
	catalogue: { label: "Catalogue", icon: "catalogue" },
};
const PAGE = 120;

let ui = { q: "", group: "", limit: PAGE, inCart: false };

export async function render(app, [customerName]) {
	if (!customerName) return pickCustomer(app);
	const customer = app.customersById.get(customerName);
	if (!customer) {
		return { el: empty("alert", "Customer not available", "This customer is not in your list. Refresh data or pick another customer.", h("a", { class: "btn", href: "#/route" }, "Back to customers")), title: "New order", back: true };
	}
	const currency = app.settings.currency;
	const draftKey = `cart:${customer.name}`;
	const cart = Cart.fromJSON((await app.store.get("kv", draftKey)) || { customer: customer.name, priceList: customer.price_list, fallbackList: app.masters.default_price_list });
	cart.priceList = customer.price_list;
	cart.fallbackList = app.masters.default_price_list;
	// Saved on every change (not debounced) so an app kill never loses the cart.
	let saving = Promise.resolve();
	const saveDraft = () => {
		const snapshot = cart.lines.size ? cart.toJSON() : null;
		saving = saving.then(() => (snapshot ? app.store.put("kv", draftKey, snapshot) : app.store.del("kv", draftKey))).catch(() => {});
	};

	const views = app.profile.cart_views;
	let view = views.includes(app.prefs.view) ? app.prefs.view : app.profile.default_view;
	if (!views.includes(view)) view = views[0];
	const packLabel = app.settings.pack_uom || "Case";
	const showPrice = app.visible("item.price");
	const showStock = app.visible("item.stock");
	const showImage = app.visible("item.image");

	const items = app.masters.items || [];
	const groups = [...new Set(items.map((i) => i.item_group).filter(Boolean))].sort();

	// ----- item area -----
	const itemsEl = h("div", { class: "items" });
	const onQty = (item, v) => {
		cart.setQty(item, v);
		saveDraft();
		updateTotals();
	};

	const priceOf = (item) => (showPrice ? priceFor(item, cart.priceList, cart.fallbackList) : null);
	const priceText = (item) => {
		const p = priceOf(item);
		if (p == null) return showPrice ? "No price" : "";
		return item.pack_factor > 0 ? `${money(p, currency)} / ${item.stock_uom} · ${money(p * item.pack_factor, currency)} / ${packLabel}` : `${money(p, currency)} / ${item.stock_uom}`;
	};
	const stockText = (item) => (showStock ? `Stock ${fmtQty(item.stock)}` : "");
	const control = (item, dense) => qtyControl({ qty: cart.qtyOf(item.item_code), factor: item.pack_factor, uom: item.stock_uom, packLabel, dense, onChange: (v) => onQty(item, v) });
	const thumb = (item, cls = "thumb") =>
		showImage && item.image
			? h("img", { class: cls, src: item.image, alt: "", loading: "lazy", decoding: "async" })
			: h("div", { class: `${cls} placeholder`, "aria-hidden": "true" }, initials(item.item_name));

	const renderers = {
		list: (rows) =>
			h(
				"div",
				{ class: "item-list" },
				rows.map((it) =>
					h("div", { class: "item-row" }, thumb(it), h("div", { class: "item-info" }, h("div", { class: "item-name" }, it.item_name), h("div", { class: "muted small" }, it.item_code, stockText(it) ? ` · ${stockText(it)}` : ""), h("div", { class: "price" }, priceText(it))), control(it))
				)
			),
		grid: (rows) =>
			h(
				"div",
				{ class: "item-grid" },
				rows.map((it) => h("div", { class: "item-card" }, thumb(it, "thumb-lg"), h("div", { class: "item-name clamp2" }, it.item_name), h("div", { class: "price small" }, priceText(it)), stockText(it) ? h("div", { class: "muted small" }, stockText(it)) : null, control(it, true)))
			),
		table: (rows) =>
			h(
				"div",
				{ class: "table-wrap" },
				h(
					"table",
					{ class: "item-table" },
					h("thead", null, h("tr", null, h("th", null, "Item"), showPrice ? h("th", { class: "num" }, "Price") : null, showStock ? h("th", { class: "num" }, "Stock") : null, h("th", null, "Quantity"))),
					h(
						"tbody",
						null,
						rows.map((it) =>
							h(
								"tr",
								null,
								h("td", null, h("div", { class: "item-name" }, it.item_name), h("div", { class: "muted small" }, it.item_code)),
								showPrice ? h("td", { class: "num" }, priceOf(it) == null ? "–" : money(priceOf(it), currency)) : null,
								showStock ? h("td", { class: "num" }, fmtQty(it.stock)) : null,
								h("td", null, control(it, true))
							)
						)
					)
				)
			),
		compact: (rows) =>
			h(
				"div",
				{ class: "item-compact" },
				rows.map((it) => h("div", { class: "compact-row" }, h("div", { class: "item-name clamp" }, it.item_name), showPrice ? h("span", { class: "muted small nowrap" }, priceOf(it) == null ? "–" : money(priceOf(it), currency)) : null, control(it, true)))
			),
		catalogue: (rows) =>
			h(
				"div",
				{ class: "item-catalogue" },
				rows.map((it) =>
					h(
						"div",
						{ class: "cat-card" },
						thumb(it, "thumb-xl"),
						h("div", { class: "cat-body" }, h("div", { class: "item-name" }, it.item_name), h("div", { class: "muted small" }, [it.brand, it.item_group].filter(Boolean).join(" · ") || it.item_code), h("div", { class: "price" }, priceText(it)), stockText(it) ? h("div", { class: "muted small" }, stockText(it)) : null, control(it))
					)
				)
			),
	};

	const drawItems = () => {
		clear(itemsEl);
		let rows = items;
		if (ui.inCart) rows = rows.filter((i) => cart.qtyOf(i.item_code) > 0);
		if (ui.group) rows = rows.filter((i) => i.item_group === ui.group);
		if (ui.q) rows = rows.filter((i) => matchesQuery([i.item_name, i.item_code, i.brand, i.item_group], ui.q));
		if (!rows.length) {
			itemsEl.appendChild(empty("search", items.length ? "No items match" : "No items yet", items.length ? "Try another search or group." : "Refresh data when online."));
			return;
		}
		itemsEl.appendChild(renderers[view](rows.slice(0, ui.limit)));
		if (rows.length > ui.limit) {
			itemsEl.appendChild(
				h("button", { class: "btn block", onclick: () => ((ui.limit += PAGE), drawItems()) }, `Show more (${rows.length - ui.limit} left)`)
			);
		}
	};

	// ----- header -----
	const outstanding = app.visible("customer.outstanding") ? customer.outstanding || 0 : null;
	const header = h(
		"div",
		{ class: "order-head" },
		h("div", { class: "avatar lg", "aria-hidden": "true" }, initials(customer.customer_name)),
		h(
			"div",
			{ class: "grow" },
			h("div", { class: "card-title" }, customer.customer_name),
			h("div", { class: "muted small" }, [customer.name, customer.mobile_no, customer.territory].filter(Boolean).join(" · "))
		),
		outstanding !== null
			? h(
					"button",
					{ class: `amount-btn ${outstanding > 0 ? "due" : "clear"}`, type: "button", onclick: () => showOutstanding(app, customer) },
					h("small", null, "Outstanding"),
					money(outstanding, currency)
			  )
			: null,
		h("button", { class: "btn ghost", type: "button", onclick: () => noOrder(app, customer) }, icon("block", 18), h("span", null, "No order"))
	);

	// ----- toolbar -----
	const search = h("input", {
		type: "search",
		placeholder: "Search items",
		value: ui.q,
		"aria-label": "Search items",
		oninput: debounce((e) => {
			ui.q = e.target.value.trim();
			ui.limit = PAGE;
			drawItems();
		}, 150),
	});
	const groupChips = h(
		"div",
		{ class: "chips", role: "tablist", "aria-label": "Item groups" },
		[{ v: "", l: "All" }, ...groups.map((g) => ({ v: g, l: g }))].map((g) =>
			h(
				"button",
				{
					class: `chip${ui.group === g.v ? " active" : ""}`,
					type: "button",
					onclick: (e) => {
						ui.group = g.v;
						ui.limit = PAGE;
						for (const c of groupChips.children) c.classList.remove("active");
						e.currentTarget.classList.add("active");
						drawItems();
					},
				},
				g.l
			)
		)
	);
	const inCartChip = h(
		"button",
		{
			class: `chip${ui.inCart ? " active" : ""}`,
			type: "button",
			"aria-pressed": String(ui.inCart),
			onclick: () => {
				ui.inCart = !ui.inCart;
				inCartChip.classList.toggle("active", ui.inCart);
				drawItems();
			},
		},
		icon("cart", 16),
		"In cart"
	);
	const viewSwitch =
		views.length > 1
			? segmented(
					views.map((v) => ({ value: v, label: VIEW_META[v].label, icon: VIEW_META[v].icon, hideLabel: true })),
					view,
					async (v) => {
						view = v;
						await savePrefs({ view: v });
						for (const b of viewSwitch.children) {
							const on = b.title === VIEW_META[v].label;
							b.classList.toggle("active", on);
							b.setAttribute("aria-selected", String(on));
						}
						drawItems();
					},
					"Display option"
			  )
			: null;

	// ----- cart -----
	const sidePanel = h("aside", { class: "cart-side", "aria-label": "Cart" });
	const bar = h("div", { class: "cart-bar" });

	const updateTotals = () => {
		const t = cart.totals();
		clear(bar);
		bar.append(
			h("div", { class: "grow" }, h("b", null, `${t.lines} ${t.lines === 1 ? "line" : "lines"}`), h("span", { class: "muted small" }, t.cases ? ` · ${fmtQty(t.cases)} ${packLabel}` : ` · ${fmtQty(t.qty)} pcs`)),
			showPrice ? h("b", { class: "bar-total" }, money(t.amount, currency)) : null,
			h("button", { class: "btn primary", disabled: !t.lines, onclick: () => openCartSheet() }, "Review")
		);
		bar.classList.toggle("is-empty", !t.lines);
		drawSide();
	};

	const drawSide = () => {
		clear(sidePanel).appendChild(cartPanel(app, customer, cart, { onChange: () => (saveDraft(), updateTotals(), drawItems()), onPlace: place, compact: false }));
	};

	let cartSheet = null;
	const openCartSheet = () => {
		const body = h("div");
		const redraw = () => clear(body).appendChild(cartPanel(app, customer, cart, { onChange: () => (saveDraft(), updateTotals(), drawItems(), redraw()), onPlace: place, compact: true }));
		redraw();
		cartSheet = sheet(`Order for ${customer.customer_name}`, body, { wide: true });
	};

	async function place(extra) {
		const t = cart.totals();
		if (!t.lines) return;
		const ok = await confirmDialog("Place order?", `${customer.customer_name}: ${t.lines} lines${showPrice ? `, about ${money(t.amount, currency)}` : ""}. It is saved on this device and sent automatically.`, "Place order");
		if (!ok) return;
		let geo = null;
		if (app.settings.require_location) {
			geo = await locate();
			if (!geo) return toast("Turn on location to place orders.", "warn");
		}
		const payload = cart.toPayload({
			client_uuid: uuid4(),
			created_at: new Date().toISOString(),
			delivery_date: app.editable("order.delivery_date") ? extra.delivery_date : null,
			remarks: app.editable("order.remarks") ? extra.remarks : null,
			geo,
			canRate: app.editable("order.rate"),
			canDiscount: app.editable("order.discount"),
		});
		await app.sync.enqueue(payload, {
			customer_name: customer.customer_name,
			total: t.amount,
			lines: t.lines,
			items: [...cart.lines.values()].slice(0, 50).map((l) => ({ item_name: l.item_name, qty: l.qty, uom: l.stock_uom })),
		});
		cart.clear();
		await app.store.del("kv", draftKey);
		cartSheet?.close();
		toast(navigator.onLine ? "Order saved, sending now" : "Order saved. It will be sent when you're back online.", "success");
		backgroundSync();
		app.go(app.can("route") ? "#/route" : "#/orders");
	}

	const el = h(
		"section",
		{ class: "view order-view" },
		h(
			"div",
			{ class: "order-main" },
			header,
			h("div", { class: "toolbar sticky" }, h("label", { class: "search" }, icon("search", 18), search), inCartChip, viewSwitch),
			groups.length > 1 ? groupChips : null,
			itemsEl
		),
		sidePanel,
		bar
	);
	ui.limit = PAGE;
	drawItems();
	updateTotals();
	return { el, title: "New order", back: true };
}

function cartPanel(app, customer, cart, { onChange, onPlace, compact }) {
	const currency = app.settings.currency;
	const packLabel = app.settings.pack_uom || "Case";
	const showPrice = app.visible("item.price");
	const t = cart.totals();
	if (!t.lines) {
		return h("div", { class: "cart-panel" }, h("h2", { class: "panel-title" }, "Cart"), empty("cart", "Cart is empty", "Add quantities from the item list."));
	}
	const canRate = app.editable("order.rate");
	const canDisc = app.editable("order.discount");
	const maxDisc = app.profile.max_discount_percent || 0;

	const lines = [...cart.lines.values()].map((l) => {
		const eff = Cart.effectiveRate(l);
		return h(
			"div",
			{ class: "cart-line" },
			h(
				"div",
				{ class: "row between" },
				h("div", { class: "item-name clamp" }, l.item_name),
				h("button", { class: "icon-btn small", type: "button", "aria-label": `Remove ${l.item_name}`, onclick: () => (cart.remove(l.item_code), onChange()) }, icon("trash", 18))
			),
			h(
				"div",
				{ class: "row between gap" },
				qtyControl({ qty: l.qty, factor: l.pack_factor, uom: l.stock_uom, packLabel, dense: true, onChange: (v) => (cart.setQty(l, v), onChange()) }),
				showPrice ? h("b", { class: "nowrap" }, eff == null ? "No price" : money(eff * l.qty, currency)) : null
			),
			canRate || canDisc
				? h(
						"div",
						{ class: "row gap edit-row" },
						canRate
							? h("label", { class: "mini-field" }, h("span", null, "Rate"), h("input", { type: "number", inputmode: "decimal", min: "0", step: "0.01", value: l.rate ?? l.price ?? "", onchange: (e) => (cart.setRate(l.item_code, e.target.value), onChange()) }))
							: null,
						canDisc
							? h(
									"label",
									{ class: "mini-field" },
									h("span", null, `Disc % (max ${maxDisc})`),
									h("input", {
										type: "number",
										inputmode: "decimal",
										min: "0",
										max: String(maxDisc),
										step: "0.5",
										value: l.discount_percentage ?? "",
										onchange: (e) => {
											let v = e.target.value;
											if (v !== "" && Number(v) > maxDisc) {
												v = String(maxDisc);
												toast(`Discount is limited to ${maxDisc}%`, "warn");
											}
											cart.setDiscount(l.item_code, v);
											onChange();
										},
									})
							  )
							: null
				  )
				: null
		);
	});

	const delivery = app.editable("order.delivery_date")
		? h("input", { type: "date", min: addDaysISO(0), value: cart.delivery_date || addDaysISO(app.settings.default_delivery_days || 0), onchange: (e) => (cart.delivery_date = e.target.value) })
		: null;
	const remarks = app.editable("order.remarks") ? h("textarea", { rows: "2", maxlength: "1000", placeholder: "Remarks for the office (optional)", oninput: (e) => (cart.remarks = e.target.value) }, cart.remarks || "") : null;

	const outstanding = app.visible("customer.outstanding") ? customer.outstanding || 0 : 0;
	const limit = app.visible("customer.credit_limit") ? customer.credit_limit || 0 : 0;
	const overLimit = limit && outstanding + t.amount > limit;

	return h(
		"div",
		{ class: `cart-panel${compact ? " compact" : ""}` },
		compact ? null : h("h2", { class: "panel-title" }, "Cart"),
		h("div", { class: "cart-lines" }, lines),
		delivery ? h("label", { class: "field" }, h("span", null, "Delivery date"), delivery) : null,
		remarks ? h("label", { class: "field" }, h("span", null, "Remarks"), remarks) : null,
		h(
			"dl",
			{ class: "totals" },
			h("dt", null, "Lines"),
			h("dd", null, String(t.lines)),
			t.cases ? [h("dt", null, packLabel), h("dd", null, fmtQty(t.cases))] : null,
			h("dt", null, "Pieces"),
			h("dd", null, fmtQty(t.qty)),
			showPrice ? [h("dt", { class: "grand" }, "Estimated total"), h("dd", { class: "grand" }, money(t.amount, currency))] : null
		),
		t.unpriced && showPrice ? h("p", { class: "note warn" }, icon("alert", 16), `${t.unpriced} item(s) have no price on this device. The office will price them.`) : null,
		overLimit ? h("p", { class: "note warn" }, icon("alert", 16), `Outstanding plus this order exceeds the credit limit of ${money(limit, currency)}.`) : null,
		showPrice ? h("p", { class: "muted small" }, "Final prices, promotions and taxes are applied by the server when the order syncs.") : null,
		h(
			"div",
			{ class: "row gap end" },
			h(
				"button",
				{
					class: "btn",
					type: "button",
					onclick: async () => {
						if (await confirmDialog("Clear cart?", "All quantities for this customer will be removed.", "Clear", "danger")) {
							cart.clear();
							onChange();
						}
					},
				},
				"Clear"
			),
			h("button", { class: "btn primary", type: "button", onclick: () => onPlace({ delivery_date: cart.delivery_date || (delivery && delivery.value), remarks: cart.remarks || "" }) }, icon("check", 18), "Place order")
		)
	);
}

async function showOutstanding(app, customer) {
	const currency = app.settings.currency;
	const body = h("div", { class: "stack" }, h("p", { class: "muted" }, "Loading…"));
	sheet(`Outstanding · ${customer.customer_name}`, body, { wide: true });
	let data = null;
	if (navigator.onLine) {
		try {
			data = await app.api.call("outstanding.get_outstanding", { params: { customer: customer.name } });
		} catch (e) {
			data = null;
		}
	}
	clear(body);
	body.appendChild(h("div", { class: "big-amount" }, h("small", null, "Total outstanding"), money(data ? data.total : customer.outstanding, currency)));
	if (!data) {
		body.appendChild(h("p", { class: "muted small" }, "Offline: showing the balance from the last sync. Connect to see invoices and ageing."));
		return;
	}
	body.appendChild(ageingBar(data.buckets || [], currency));
	if (data.unallocated && Math.abs(data.unallocated) > 0.009) body.appendChild(h("p", { class: "muted small" }, `Includes unallocated payments/credits of ${money(data.unallocated, currency)}.`));
	const invs = data.invoices || [];
	body.appendChild(
		invs.length
			? h(
					"div",
					{ class: "table-wrap" },
					h(
						"table",
						{ class: "item-table" },
						h("thead", null, h("tr", null, h("th", null, "Invoice"), h("th", null, "Due"), h("th", { class: "num" }, "Total"), h("th", { class: "num" }, "Outstanding"))),
						h("tbody", null, invs.map((i) => h("tr", null, h("td", null, i.name), h("td", null, i.due_date), h("td", { class: "num" }, money(i.grand_total, currency)), h("td", { class: "num" }, money(i.outstanding_amount, currency)))))
					)
			  )
			: h("p", { class: "muted" }, "No open invoices.")
	);
}

export function ageingBar(buckets, currency) {
	const total = buckets.reduce((s, b) => s + Math.max(b.amount, 0), 0) || 1;
	return h(
		"div",
		{ class: "ageing" },
		h("div", { class: "ageing-bar", role: "img", "aria-label": "Ageing" }, buckets.map((b, i) => (b.amount > 0 ? h("span", { class: `seg s${i}`, style: { width: `${(b.amount / total) * 100}%` }, title: `${b.label}: ${b.amount}` }) : null))),
		h("div", { class: "ageing-legend" }, buckets.map((b, i) => h("div", { class: "legend-item" }, h("i", { class: `sw s${i}` }), h("span", null, b.label === "Not Due" ? "Not due" : `${b.label} days`), h("b", null, money(b.amount, currency)))))
	);
}

async function noOrder(app, customer) {
	const reasons = app.masters.no_order_reasons || [];
	let chosen = null;
	const list = h(
		"div",
		{ class: "radio-list", role: "radiogroup" },
		reasons.map((r) =>
			h("label", { class: "radio" }, h("input", { type: "radio", name: "reason", value: r, onchange: () => (chosen = r) }), h("span", null, r))
		)
	);
	const remarks = h("textarea", { rows: "2", maxlength: "1000", placeholder: "Note (optional)" });
	const s = sheet(`No order · ${customer.customer_name}`, h("div", { class: "stack" }, reasons.length ? list : h("p", { class: "muted" }, "No reasons configured."), app.editable("order.remarks") ? remarks : null), {
		actions: [
			h("button", { class: "btn", onclick: () => s.close() }, "Cancel"),
			h(
				"button",
				{
					class: "btn primary",
					onclick: async () => {
						if (!chosen) return toast("Pick a reason", "warn");
						let geo = null;
						if (app.settings.require_location) {
							geo = await locate();
							if (!geo) return toast("Turn on location to record visits.", "warn");
						}
						const payload = { client_uuid: uuid4(), outcome: "no_order", customer: customer.name, no_order_reason: chosen, created_at: new Date().toISOString() };
						if (geo) payload.geo = geo;
						if (app.editable("order.remarks") && remarks.value.trim()) payload.remarks = remarks.value.trim();
						await app.sync.enqueue(payload, { customer_name: customer.customer_name, reason: chosen });
						s.close();
						toast("Visit recorded", "success");
						backgroundSync();
						app.go(app.can("route") ? "#/route" : "#/orders");
					},
				},
				"Record visit"
			),
		],
	});
}

function pickCustomer(app) {
	const list = h("div", { class: "cards" });
	const draw = (q) => {
		clear(list);
		const rows = (app.masters.customers || []).filter((c) => matchesQuery([c.customer_name, c.name, c.mobile_no, c.address], q)).slice(0, 200);
		if (!rows.length) return list.appendChild(empty("search", "No customers match", ""));
		for (const c of rows)
			list.appendChild(
				h("a", { class: "card card-main pick", href: `#/order/${encodeURIComponent(c.name)}` }, h("div", { class: "avatar", "aria-hidden": "true" }, initials(c.customer_name)), h("div", { class: "card-body" }, h("div", { class: "card-title" }, c.customer_name), h("div", { class: "muted small" }, [c.name, c.mobile_no].filter(Boolean).join(" · "))))
			);
	};
	const input = h("input", { type: "search", placeholder: "Search customer", "aria-label": "Search customer", oninput: debounce((e) => draw(e.target.value.trim()), 150) });
	draw("");
	setTimeout(() => input.focus(), 50);
	return { el: h("section", { class: "view" }, h("h2", { class: "section-title" }, "Who is this order for?"), h("div", { class: "toolbar" }, h("label", { class: "search" }, icon("search", 18), input)), list), title: "New order" };
}

