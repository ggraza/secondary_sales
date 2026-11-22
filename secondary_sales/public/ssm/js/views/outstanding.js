// Outstanding for all of the rep's customers, with ageing.

import { touchContact } from "../app.js";
import { empty, icon } from "../ui.js";
import { clear, debounce, h, matchesQuery, money } from "../util.js";
import { ageingBar } from "./order.js";

let q = "";

export async function render(app) {
	const currency = app.settings.currency;
	let data = null;
	let fromCache = false;
	if (navigator.onLine) {
		try {
			data = await app.api.call("outstanding.get_outstanding");
			await app.store.put("kv", "outstanding", { ...data, fetched_at: new Date().toISOString() });
			await touchContact();
		} catch {
			data = null;
		}
	}
	if (!data) {
		data = await app.store.get("kv", "outstanding");
		fromCache = true;
	}
	if (!data) {
		return { el: empty("offline", "Not available offline yet", "Open this screen once while online to keep a copy on the device."), title: "Outstanding" };
	}

	const rows = data.rows || [];
	const total = rows.reduce((s, r) => s + r.total, 0);
	const combined = {};
	for (const r of rows) for (const b of r.buckets) combined[b.label] = (combined[b.label] || 0) + b.amount;
	const buckets = Object.entries(combined).map(([label, amount]) => ({ label, amount }));

	const list = h("div", { class: "cards" });
	const draw = () => {
		clear(list);
		const shown = rows.filter((r) => matchesQuery([r.customer_name, r.customer], q));
		if (!shown.length) return list.appendChild(empty("money", "Nothing outstanding", ""));
		for (const r of shown) {
			const details = h("div", { class: "details hidden" }, ageingBar(r.buckets, currency), r.unallocated && Math.abs(r.unallocated) > 0.009 ? h("p", { class: "muted small" }, `Unallocated payments/credits ${money(r.unallocated, currency)}`) : null, h("a", { class: "btn small", href: `#/order/${encodeURIComponent(r.customer)}` }, "Take order"));
			list.appendChild(
				h(
					"article",
					{ class: "card" },
					h(
						"button",
						{ class: "card-main as-button", type: "button", "aria-expanded": "false", onclick: (e) => {
							const open = details.classList.toggle("hidden") === false;
							e.currentTarget.setAttribute("aria-expanded", String(open));
						} },
						h("div", { class: "card-body" }, h("div", { class: "card-title" }, r.customer_name), h("div", { class: "muted small" }, `${r.invoice_count} open invoices${r.oldest_days ? ` · oldest ${r.oldest_days} days overdue` : ""}`)),
						h("div", { class: `amount ${r.total > 0 ? "due" : "clear"}` }, money(r.total, currency))
					),
					details
				)
			);
		}
	};
	draw();

	const el = h(
		"section",
		{ class: "view" },
		h("div", { class: "summary-card" }, h("small", null, `Total outstanding · ${rows.length} customers`), h("div", { class: "big-amount" }, money(total, currency)), ageingBar(buckets, currency)),
		fromCache ? h("p", { class: "note" }, icon("offline", 16), `Offline copy from ${data.fetched_at ? new Date(data.fetched_at).toLocaleString() : "earlier"}.`) : null,
		h("div", { class: "toolbar" }, h("label", { class: "search" }, icon("search", 18), h("input", { type: "search", placeholder: "Search customer", value: q, "aria-label": "Search customer", oninput: debounce((e) => ((q = e.target.value.trim()), draw()), 150) }))),
		list
	);
	return { el, title: "Outstanding" };
}
