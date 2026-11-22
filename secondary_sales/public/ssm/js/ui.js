// Shared UI pieces: icons, toasts, bottom sheets, dialogs, quantity control.

import { h } from "./util.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
	route: "M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z",
	cart: "M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5.2 4l.9 2H20a1 1 0 0 1 .9 1.4l-3.4 6.4a2 2 0 0 1-1.8 1.2H8.1l-1 1.8V17h12v2H6a2 2 0 0 1-1.7-3l1.4-2.5L2.3 4H1V2h3a1 1 0 0 1 .9.6z",
	orders: "M19 3h-4.2A3 3 0 0 0 12 1a3 3 0 0 0-2.8 2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm-7 0a1 1 0 1 1 0 2 1 1 0 0 1 0-2zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z",
	money: "M11.8 10.9c-2.3-.6-3-1.2-3-2.1 0-1.1 1-1.9 2.7-1.9 1.8 0 2.4.8 2.5 2.1h2.2c-.1-1.7-1.1-3.3-3.2-3.8V3h-3v2.2c-1.9.4-3.5 1.7-3.5 3.6 0 2.3 1.9 3.5 4.7 4.1 2.5.6 3 1.5 3 2.4 0 .7-.5 1.8-2.7 1.8-2.1 0-2.9-.9-3-2.1H6.3c.1 2.2 1.8 3.5 3.7 3.9V21h3v-2.1c1.9-.4 3.5-1.5 3.5-3.6 0-2.9-2.4-3.9-4.7-4.4z",
	more: "M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
	search: "M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z",
	back: "M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20v-2z",
	plus: "M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z",
	minus: "M19 13H5v-2h14v2z",
	close: "M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z",
	sync: "M12 4V1L8 5l4 4V6a6 6 0 0 1 5.7 7.9l1.5 1.5A8 8 0 0 0 12 4zm0 14a6 6 0 0 1-5.7-7.9L4.8 8.6A8 8 0 0 0 12 20v3l4-4-4-4v3z",
	offline: "M23.6 7A17 17 0 0 0 12 3a17 17 0 0 0-5.6 1L19 16.7zM3.5 1.9 2 3.3l2 2A17 17 0 0 0 .4 7L12 21.5l3.9-4.8 3.4 3.4 1.4-1.4z",
	check: "M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z",
	trash: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
	list: "M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z",
	grid: "M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z",
	table: "M3 3h18v18H3V3zm2 4v4h6V7H5zm8 0v4h6V7h-6zm-8 6v4h6v-4H5zm8 0v4h6v-4h-6z",
	compact: "M3 5h18v2H3zm0 4h18v2H3zm0 4h18v2H3zm0 4h18v2H3z",
	catalogue: "M21 5v14H3V5h18zm-2 2H5v10h14V7zm-3 7-3-4-2.5 3.2L9 11.5 6 15h10z",
	pin: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1a7 7 0 0 0 5.9 5.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21v-2z",
	block: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.3L5.7 16.9A7.9 7.9 0 0 1 4 12zm8 8a7.9 7.9 0 0 1-4.9-1.7L18.3 7.1A8 8 0 0 1 12 20z",
	phone: "M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.2 11.4 11.4 0 0 0 3.6.6 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.6 3.6a1 1 0 0 1-.3 1z",
	alert: "M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z",
	lock: "M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z",
};

export function icon(name, size = 22) {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("width", size);
	svg.setAttribute("height", size);
	svg.setAttribute("aria-hidden", "true");
	svg.setAttribute("class", "icon");
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", ICONS[name] || ICONS.more);
	path.setAttribute("fill", "currentColor");
	svg.appendChild(path);
	return svg;
}

let toastHost;
export function toast(message, kind = "info", ms = 3200) {
	if (!toastHost) {
		toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
		document.body.appendChild(toastHost);
	}
	const t = h("div", { class: `toast toast-${kind}` }, message);
	toastHost.appendChild(t);
	setTimeout(() => t.classList.add("out"), ms);
	setTimeout(() => t.remove(), ms + 400);
}

/** Bottom sheet on phones, centered panel on wide screens. Returns {el, close}. */
export function sheet(title, body, { actions = [], onClose, wide = false } = {}) {
	const prevFocus = document.activeElement;
	const close = () => {
		backdrop.remove();
		document.removeEventListener("keydown", onKey);
		prevFocus?.focus?.();
		onClose?.();
	};
	const onKey = (e) => {
		if (e.key === "Escape") close();
	};
	const panel = h(
		"div",
		{ class: `sheet${wide ? " sheet-wide" : ""}`, role: "dialog", "aria-modal": "true", "aria-label": title },
		h("div", { class: "sheet-head" }, h("h2", null, title), h("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, icon("close"))),
		h("div", { class: "sheet-body" }, body),
		actions.length ? h("div", { class: "sheet-actions" }, actions) : null
	);
	const backdrop = h("div", { class: "backdrop", onclick: (e) => e.target === backdrop && close() }, panel);
	document.body.appendChild(backdrop);
	document.addEventListener("keydown", onKey);
	requestAnimationFrame(() => panel.classList.add("open"));
	panel.querySelector("input,select,textarea,button.primary")?.focus?.();
	return { el: panel, close };
}

export function confirmDialog(title, message, okLabel = "Confirm", kind = "primary") {
	return new Promise((resolve) => {
		let done = false;
		const finish = (v) => {
			if (done) return;
			done = true;
			s.close();
			resolve(v);
		};
		const s = sheet(title, h("p", { class: "muted" }, message), {
			actions: [
				h("button", { class: "btn", onclick: () => finish(false) }, "Cancel"),
				h("button", { class: `btn ${kind}`, onclick: () => finish(true) }, okLabel),
			],
			onClose: () => finish(false),
		});
	});
}

export function empty(iconName, title, text, action) {
	return h("div", { class: "empty" }, icon(iconName, 40), h("h3", null, title), text ? h("p", { class: "muted" }, text) : null, action || null);
}

/**
 * Quantity control. With a pack factor it shows cases and loose pieces,
 * otherwise a single stepper. onChange receives total pieces.
 */
export function qtyControl({ qty = 0, factor = 0, uom = "", packLabel = "Ctn", onChange, dense = false }) {
	const wrap = h("div", { class: `qty${dense ? " dense" : ""}` });
	let rendering = false;
	const render = (value) => {
		rendering = true;
		const cases = factor > 0 ? Math.floor(value / factor + 1e-9) : 0;
		const pcs = factor > 0 ? Math.round((value - cases * factor) * 1000) / 1000 : value;

		const casesInput = factor > 0 ? numInput(cases, `${packLabel}`, (v) => emit(v * factor + currentPcs())) : null;
		const pcsInput = numInput(pcs, uom || "Pcs", (v) => emit((factor > 0 ? currentCases() * factor : 0) + v), factor > 0 ? 0.001 : 0.001);
		const currentCases = () => Math.max(0, Math.floor(Number(casesInput?.querySelector("input").value) || 0));
		const currentPcs = () => Math.max(0, Number(pcsInput.querySelector("input").value) || 0);
		const step = factor > 0 ? factor : 1;

		const active = document.activeElement;
		if (active && wrap.contains(active)) active.blur();
		// replaceChildren is atomic: removing a focused input fires blur/change,
		// which must not re-enter render while the old nodes are being removed.
		wrap.replaceChildren(
			...[
				h("button", { class: "step", type: "button", "aria-label": "Decrease", disabled: value <= 0, onclick: () => emit(Math.max(0, value - step)) }, icon("minus", 18)),
				casesInput,
				pcsInput,
				h("button", { class: "step", type: "button", "aria-label": "Increase", onclick: () => emit(value + step) }, icon("plus", 18)),
			].filter(Boolean)
		);
		rendering = false;
	};
	const emit = (v) => {
		if (rendering) return;
		v = Math.max(0, Math.round(v * 1000) / 1000);
		onChange?.(v);
		render(v);
		wrap.classList.toggle("has-qty", v > 0);
	};
	render(qty);
	wrap.classList.toggle("has-qty", qty > 0);
	return wrap;
}

function numInput(value, label, onCommit, step = 1) {
	const input = h("input", {
		type: "number",
		inputmode: step < 1 ? "decimal" : "numeric",
		min: "0",
		step: String(step),
		value: value ? String(value) : "",
		placeholder: "0",
		"aria-label": label,
	});
	const commit = () => onCommit(Math.max(0, Number(input.value) || 0));
	input.addEventListener("change", commit);
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") input.blur();
	});
	input.addEventListener("focus", () => input.select());
	return h("label", { class: "qty-field" }, input, h("span", null, label));
}

export function segmented(options, value, onChange, label) {
	const wrap = h("div", { class: "segmented", role: "tablist", "aria-label": label || "" });
	for (const o of options) {
		wrap.appendChild(
			h(
				"button",
				{
					role: "tab",
					type: "button",
					"aria-selected": String(o.value === value),
					class: o.value === value ? "active" : "",
					title: o.label,
					onclick: () => onChange(o.value),
				},
				o.icon ? icon(o.icon, 18) : null,
				o.hideLabel ? h("span", { class: "sr-only" }, o.label) : h("span", null, o.label)
			)
		);
	}
	return wrap;
}
