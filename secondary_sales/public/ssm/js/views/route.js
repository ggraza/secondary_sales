// Customers / route screen: today's route plan, search, nearby, visit status
// and outstanding at a glance. Tapping a customer opens the order screen.

import { touchContact, visitStatus } from "../app.js";
import { icon, segmented, sheet, toast } from "../ui.js";
import { clear, dayName, debounce, distanceM, fmtDistance, h, initials, matchesQuery, money } from "../util.js";

let state = { tab: "today", q: "", nearby: false, here: null };

const STATUS_LABEL = { order: "Ordered", no_order: "No order", pending: "Waiting to sync", error: "Needs attention" };

export async function render(app) {
	const today = dayName();
	const all = app.masters.customers || [];
	const routeToday = all.filter((c) => (c.route_days || []).some((d) => d === "Everyday" || d === today));
	const hasRoute = routeToday.length > 0;
	if (!hasRoute && state.tab === "today") state.tab = "all";
	const status = await visitStatus();
	const currency = app.settings.currency;

	const base = state.tab === "today" ? routeToday : all;
	const visited = base.filter((c) => status.has(c.name)).length;

	const listEl = h("div", { class: "cards", role: "list" });
	const countEl = h("span", { class: "muted small" });

	const draw = () => {
		clear(listEl);
		let rows = base.filter((c) => matchesQuery([c.customer_name, c.name, c.mobile_no, c.address, c.territory], state.q));
		if (state.nearby && state.here) {
			rows = rows
				.map((c) => ({ c, d: distanceM(state.here, c.lat != null ? { lat: c.lat, lng: c.lng } : null) }))
				.filter((x) => x.d != null && x.d <= (app.settings.nearby_radius_m || 500))
				.sort((a, b) => a.d - b.d)
				.map((x) => ({ ...x.c, _distance: x.d }));
		} else if (state.here) {
			rows = rows.map((c) => ({ ...c, _distance: distanceM(state.here, c.lat != null ? { lat: c.lat, lng: c.lng } : null) }));
		}
		countEl.textContent = `${rows.length} shown`;
		if (!rows.length) {
			listEl.appendChild(
				h("div", { class: "empty" }, icon("route", 40), h("h3", null, all.length ? "No customers match" : "No customers yet"), h("p", { class: "muted" }, all.length ? "Try another search or turn off Nearby." : "Ask your manager to add customers to your route plan, then refresh."))
			);
			return;
		}
		const frag = document.createDocumentFragment();
		for (const c of rows.slice(0, 400)) frag.appendChild(card(app, c, status.get(c.name), currency));
		listEl.appendChild(frag);
	};

	const search = h("input", {
		type: "search",
		placeholder: "Search name, code, phone, area",
		value: state.q,
		"aria-label": "Search customers",
		oninput: debounce((e) => {
			state.q = e.target.value.trim();
			draw();
		}, 150),
	});

	const nearbyBtn = h(
		"button",
		{
			class: `chip${state.nearby ? " active" : ""}`,
			type: "button",
			"aria-pressed": String(state.nearby),
			onclick: async () => {
				if (!state.nearby) {
					const pos = await locate();
					if (!pos) return toast("Location is unavailable. Turn on GPS and allow location.", "warn");
					state.here = pos;
				}
				state.nearby = !state.nearby;
				nearbyBtn.classList.toggle("active", state.nearby);
				nearbyBtn.setAttribute("aria-pressed", String(state.nearby));
				draw();
			},
		},
		icon("pin", 16),
		`Nearby ${fmtDistance(app.settings.nearby_radius_m || 500)}`
	);

	const tabs = hasRoute
		? segmented(
				[
					{ value: "today", label: `Today's route (${routeToday.length})` },
					{ value: "all", label: `All (${all.length})` },
				],
				state.tab,
				(v) => {
					state.tab = v;
					app.refresh();
				},
				"Customer list"
		  )
		: null;

	const el = h(
		"section",
		{ class: "view route-view" },
		h(
			"div",
			{ class: "kpis" },
			kpi("Customers", base.length),
			kpi("Visited", visited, "good"),
			kpi("Remaining", Math.max(base.length - visited, 0), visited < base.length ? "warn" : "good")
		),
		tabs,
		h("div", { class: "toolbar" }, h("label", { class: "search" }, icon("search", 18), search), nearbyBtn),
		h("div", { class: "row between" }, h("span", { class: "muted small" }, `${today}`), countEl),
		listEl
	);
	draw();
	return { el, title: "Customers" };
}

function kpi(label, value, tone = "") {
	return h("div", { class: `kpi ${tone}` }, h("b", null, String(value)), h("span", null, label));
}

function card(app, c, st, currency) {
	const outstanding = app.visible("customer.outstanding") && c.outstanding ? c.outstanding : 0;
	const over = c.credit_limit && outstanding > c.credit_limit;
	return h(
		"article",
		{ class: `card customer ${st ? `st-${st}` : ""}`, role: "listitem" },
		h(
			"a",
			{ class: "card-main", href: `#/order/${encodeURIComponent(c.name)}`, "aria-label": `Take order for ${c.customer_name}` },
			h("div", { class: "avatar", "aria-hidden": "true" }, initials(c.customer_name), h("i", { class: `dot ${st || "none"}` })),
			h(
				"div",
				{ class: "card-body" },
				h("div", { class: "card-title" }, c.customer_name, c.customer_name !== c.name ? h("small", { class: "muted" }, ` · ${c.name}`) : null),
				c.mobile_no ? h("div", { class: "muted small line" }, icon("phone", 14), c.mobile_no) : null,
				c.address ? h("div", { class: "muted small line clamp" }, icon("route", 14), c.address) : null,
				h(
					"div",
					{ class: "tags" },
					st ? h("span", { class: `tag ${st}` }, STATUS_LABEL[st]) : h("span", { class: "tag" }, "Not visited"),
					c.last_order_date ? h("span", { class: "tag subtle" }, `Last order ${c.last_order_date}`) : null,
					c._distance != null ? h("span", { class: "tag subtle" }, fmtDistance(c._distance)) : null
				)
			),
			app.visible("customer.outstanding")
				? h("div", { class: `amount ${outstanding > 0 ? (over ? "bad" : "due") : "clear"}` }, h("small", null, "Outstanding"), money(outstanding, currency))
				: null
		),
		app.profile.allow_update_location ? h("button", { class: "icon-btn card-action", type: "button", "aria-label": "Set location", title: "Set customer location here", onclick: () => setLocation(app, c) }, icon("pin", 18)) : null
	);
}

export function locate(timeout = 8000) {
	return new Promise((resolve) => {
		if (!navigator.geolocation) return resolve(null);
		navigator.geolocation.getCurrentPosition(
			(p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
			() => resolve(null),
			{ enableHighAccuracy: true, timeout, maximumAge: 60000 }
		);
	});
}

async function setLocation(app, c) {
	if (!navigator.onLine) return toast("Connect to the internet to update a location.", "warn");
	const s = sheet(
		"Set customer location",
		h("p", null, `Save your current GPS position as the location of ${c.customer_name}? Only do this while standing at the shop.`),
		{
			actions: [
				h("button", { class: "btn", onclick: () => s.close() }, "Cancel"),
				h(
					"button",
					{
						class: "btn primary",
						onclick: async (e) => {
							e.target.disabled = true;
							const pos = await locate();
							if (!pos) {
								e.target.disabled = false;
								return toast("Could not read your location.", "warn");
							}
							try {
								await app.api.call("data.update_customer_location", { body: { customer: c.name, lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy } });
								c.lat = pos.lat;
								c.lng = pos.lng;
								await app.store.put("kv", "masters", app.masters);
								await touchContact();
								toast("Location saved", "success");
								s.close();
							} catch (err) {
								e.target.disabled = false;
								toast(err.message, "error");
							}
						},
					},
					"Use my location"
				),
			],
		}
	);
}
