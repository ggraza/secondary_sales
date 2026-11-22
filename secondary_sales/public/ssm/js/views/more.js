// Account, data and device settings.

import { backgroundSync, refreshMasters, savePrefs, signOutAndWipe } from "../app.js";
import { confirmDialog, icon, toast } from "../ui.js";
import { h, relTime } from "../util.js";

const LABELS = { list: "List", grid: "Grid", table: "Table", compact: "Compact", catalogue: "Catalogue" };

export async function render(app) {
	const pending = await app.sync.pendingCount();
	const views = app.profile.cart_views;
	const current = views.includes(app.prefs.view) ? app.prefs.view : app.profile.default_view;

	const el = h(
		"section",
		{ class: "view more-view" },
		h(
			"div",
			{ class: "card pad" },
			h("div", { class: "card-title" }, app.boot.user.full_name),
			h("div", { class: "muted small" }, app.boot.user.name),
			h("div", { class: "muted small" }, `${app.settings.company} · profile: ${app.profile.name}`)
		),
		h(
			"div",
			{ class: "card pad stack" },
			h("h3", null, "Data"),
			h("div", { class: "row between" }, h("span", null, "Customers / items on device"), h("b", null, `${(app.masters.customers || []).length} / ${(app.masters.items || []).length}`)),
			h("div", { class: "row between" }, h("span", null, "Last refreshed"), h("b", null, relTime(app.lastMasters))),
			h("div", { class: "row between" }, h("span", null, "Orders waiting to send"), h("b", null, String(pending))),
			h(
				"div",
				{ class: "row gap" },
				h(
					"button",
					{
						class: "btn",
						disabled: !navigator.onLine,
						onclick: async (e) => {
							e.currentTarget.disabled = true;
							try {
								await refreshMasters();
								toast("Data refreshed", "success");
							} catch (err) {
								toast(err.message, "error");
							}
							app.refresh();
						},
					},
					icon("sync", 18),
					"Refresh data"
				),
				h("button", { class: "btn", disabled: !navigator.onLine, onclick: () => backgroundSync(true).then(() => app.refresh()) }, "Send orders")
			)
		),
		h(
			"div",
			{ class: "card pad stack" },
			h("h3", null, "Display"),
			h(
				"label",
				{ class: "field" },
				h("span", null, "Default item view"),
				h(
					"select",
					{ onchange: (e) => savePrefs({ view: e.target.value }).then(() => toast("Saved")) },
					views.map((v) => h("option", { value: v, selected: v === current }, LABELS[v]))
				)
			),
			app.installPrompt
				? h(
						"button",
						{
							class: "btn",
							onclick: async () => {
								app.installPrompt.prompt();
								await app.installPrompt.userChoice;
								app.installPrompt = null;
								app.refresh();
							},
						},
						"Install app on this device"
				  )
				: null
		),
		h(
			"div",
			{ class: "card pad stack" },
			h("h3", null, "Security"),
			h("p", { class: "muted small" }, app.settings.encrypt_local_data ? "Data on this device is encrypted (AES-256-GCM) with a key issued by your server." : "Local encryption is turned off by your administrator."),
			app.settings.max_offline_hours ? h("p", { class: "muted small" }, `The app locks after ${app.settings.max_offline_hours} hours without a connection.`) : null,
			h(
				"button",
				{
					class: "btn danger",
					onclick: async () => {
						const msg = pending
							? `${pending} order(s) have not been sent yet and will be lost. Sign out anyway?`
							: "Signing out erases all app data from this device.";
						if (await confirmDialog("Sign out", msg, "Sign out", "danger")) signOutAndWipe();
					},
				},
				icon("lock", 18),
				"Sign out and erase device data"
			)
		),
		h("p", { class: "muted small center" }, `Version ${app.boot.app_version}`)
	);
	return { el, title: "More" };
}
