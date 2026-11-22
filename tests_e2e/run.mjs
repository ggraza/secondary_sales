// Browser test: online boot, offline reload from the service worker,
// order in every cart view while offline, sync when back online, XSS and
// CSP checks, and responsive layout at phone / tablet / desktop widths.
//   node tests_e2e/run.mjs [--shots <dir>]

import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { db, start } from "./server.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const shotsArg = process.argv.indexOf("--shots");
const SHOTS = shotsArg > 0 ? process.argv[shotsArg + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const PORT = 8765;
const BASE = `http://localhost:${PORT}`;

const server = await start(PORT);
const browser = await chromium.launch();
const problems = [];
let passed = 0;
// page.waitForFunction evaluates strings in some Playwright versions, which our
// strict CSP (no unsafe-eval) correctly blocks, so poll with page.evaluate.
async function waitFor(page, fn, { timeout = 10000 } = {}) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await page.evaluate(fn).catch(() => false)) return;
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`Timed out waiting for ${fn}`);
}
const step = async (name, fn) => {
	try {
		await fn();
		passed++;
		console.log(`ok - ${name}`);
	} catch (e) {
		problems.push(name);
		console.log(`not ok - ${name}\n  ${e.message.split("\n").join("\n  ")}`);
	}
};

try {
	const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: SHOTS ? 2 : 1, hasTouch: true });
	const page = await ctx.newPage();
	const consoleErrors = [];
	page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
	page.on("pageerror", (e) => consoleErrors.push(e.message));
	let dialogs = 0;
	page.on("dialog", (d) => {
		dialogs++;
		d.dismiss();
	});
	const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

	await step("online boot shows today's route with outstanding", async () => {
		await page.goto(`${BASE}/ssm`);
		await page.waitForSelector(".customer");
		const names = await page.locator(".customer .card-title").allTextContents();
		assert.ok(names.some((n) => n.includes("Bismillah Store")));
		assert.match(await page.locator(".kpis").innerText(), /Customers/);
		assert.ok((await page.locator(".customer .amount").first().innerText()).includes("15,400"));
		await shot("01-customers-phone");
	});

	await step("customer names are rendered as text (no XSS)", async () => {
		await page.locator(".segmented button", { hasText: "All" }).click();
		await page.waitForSelector("text=<img src=x onerror=alert(1)>Mashallah Mart");
		assert.equal(await page.locator(".customer img").count(), 0);
		assert.equal(dialogs, 0);
		await page.locator(".segmented button", { hasText: "Today" }).click();
	});

	await step("service worker takes control", async () => {
		await waitFor(page, () => !!navigator.serviceWorker?.controller, { timeout: 15000 }).catch(async () => {
			await page.reload();
			await waitFor(page, () => !!navigator.serviceWorker?.controller, { timeout: 15000 });
		});
	});

	await step("app reloads while offline from the cached shell and encrypted data", async () => {
		await ctx.setOffline(true);
		await page.reload();
		await page.waitForSelector(".customer", { timeout: 15000 });
		assert.match(await page.locator(".status-chip").innerText(), /Offline/);
	});

	await step("take an order offline using every cart view", async () => {
		await page.locator(".customer .card-main", { hasText: "Zulfiqar" }).click();
		await page.waitForSelector(".order-head");
		await shot("02-order-list-phone");
		const views = ["List", "Grid", "Table", "Compact", "Catalogue"];
		for (const [i, v] of views.entries()) {
			await page.locator(`.toolbar .segmented button[title="${v}"]`).click();
			const item = ["Cola 1500 ml", "Cola 1000 ml", "Mineral Water 1.5 L", "Mango Juice 250 ml", "Salted Chips 50 g"][i];
			await page.locator("input[type=search][aria-label='Search items']").fill(item);
			await page.waitForTimeout(250);
			await page.locator('button[aria-label="Increase"]').first().click();
			if (v === "Grid") await shot("03-order-grid-phone");
		}
		await page.locator("input[type=search][aria-label='Search items']").fill("");
		await page.waitForTimeout(250);
		assert.match(await page.locator(".cart-bar").innerText(), /5 lines/);
	});

	await step("cart survives an app restart (draft is saved)", async () => {
		await page.reload();
		await page.waitForSelector(".cart-bar");
		assert.match(await page.locator(".cart-bar").innerText(), /5 lines/);
	});

	await step("discount above the profile maximum is clamped", async () => {
		await page.locator(".cart-bar button", { hasText: "Review" }).click();
		const disc = page.locator(".sheet .mini-field input").first();
		await disc.fill("50");
		await disc.dispatchEvent("change");
		await page.waitForTimeout(100);
		assert.equal(await page.locator(".sheet .mini-field input").first().inputValue(), "5");
		await shot("04-cart-review-phone");
	});

	await step("placing the order offline queues it in the outbox", async () => {
		await page.locator(".sheet button", { hasText: "Place order" }).click();
		await page.locator(".sheet button", { hasText: "Place order" }).last().click();
		await page.waitForSelector(".customer");
		assert.match(await page.locator(".status-chip").innerText(), /Offline\s*1/);
		assert.equal(db.orders.length, 0);
	});

	await step("no-order visit is recorded offline", async () => {
		await page.locator(".customer .card-main", { hasText: "Hafiz" }).click();
		await page.locator("button", { hasText: "No order" }).click();
		await page.locator(".radio", { hasText: "Shop Closed" }).click();
		await page.locator(".sheet button", { hasText: "Record visit" }).click();
		await page.waitForSelector(".customer");
		assert.match(await page.locator(".status-chip").innerText(), /2/);
	});

	await step("back online: outbox syncs once, server gets both", async () => {
		await ctx.setOffline(false);
		await page.evaluate(() => window.dispatchEvent(new Event("online")));
		await waitFor(page, () => !/\d/.test(document.querySelector(".status-chip")?.innerText || "x"), { timeout: 15000 });
		assert.equal(db.orders.length, 2);
		const order = db.orders.find((o) => o.outcome === "order");
		assert.equal(order.customer, "CUST-0003");
		assert.equal(order.items.length, 5);
		assert.ok(order.items.every((i) => i.rate === undefined), "rate not sent when not editable");
		const visit = db.orders.find((o) => o.outcome === "no_order");
		assert.equal(visit.no_order_reason, "Shop Closed");
		await page.goto(`${BASE}/ssm#/orders`);
		await page.locator(".segmented button", { hasText: "Sent" }).click();
		await page.waitForSelector(".order-card");
		await shot("05-orders-phone");
	});

	await step("a server outage keeps the order and retries", async () => {
		db.failNext = 1;
		await page.goto(`${BASE}/ssm#/order/CUST-0001`);
		await page.waitForSelector(".order-head");
		await page.locator('button[aria-label="Increase"]').first().click();
		await page.locator(".cart-bar button", { hasText: "Review" }).click();
		await page.locator(".sheet button", { hasText: "Place order" }).click();
		await page.locator(".sheet button", { hasText: "Place order" }).last().click();
		await page.waitForSelector(".customer");
		await page.waitForTimeout(500);
		const before = db.orders.length;
		await page.goto(`${BASE}/ssm#/orders`);
		await page.locator(".segmented button", { hasText: "On this device" }).click();
		await page.waitForSelector(".order-card.st-pending", { timeout: 5000 });
		assert.match(await page.locator(".order-card.st-pending .tag").first().innerText(), /Will retry|Waiting/);
		await page.locator("button", { hasText: "Send now" }).click();
		await waitFor(page, () => !document.querySelector(".order-card.st-pending"), { timeout: 10000 });
		assert.equal(db.orders.length, before + 1);
	});

	await step("outstanding screen with ageing", async () => {
		await page.goto(`${BASE}/ssm#/outstanding`);
		await page.waitForSelector(".summary-card");
		assert.match(await page.locator(".summary-card").innerText(), /18,600/);
		await shot("06-outstanding-phone");
	});

	await step("no CSP violations or script errors", async () => {
		const bad = consoleErrors.filter((e) => !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|502/.test(e));
		assert.deepEqual(bad, []);
	});

	for (const [w, hgt, label] of [
		[360, 740, "phone-small"],
		[768, 1024, "tablet"],
		[1280, 800, "desktop"],
	]) {
		await step(`responsive at ${w}px: no horizontal scroll on any screen`, async () => {
			await page.setViewportSize({ width: w, height: hgt });
			for (const hash of ["#/route", "#/order/CUST-0001", "#/orders", "#/outstanding", "#/more"]) {
				await page.goto(`${BASE}/ssm${hash}`);
				await page.waitForSelector(".view");
				for (const v of ["List", "Table", "Grid"]) {
					if (hash.startsWith("#/order/")) {
						await page.locator(`.toolbar .segmented button[title="${v}"]`).click();
						await page.waitForTimeout(80);
					}
					const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
					assert.ok(overflow <= 1, `${hash} (${v}) overflows by ${overflow}px`);
					if (!hash.startsWith("#/order/")) break;
				}
			}
			if (w >= 960) {
				await page.goto(`${BASE}/ssm#/order/CUST-0003`);
				await page.waitForSelector(".order-head");
				assert.ok(await page.locator(".cart-side").isVisible(), "cart panel visible on desktop");
				assert.ok(!(await page.locator(".cart-bar").isVisible()), "phone cart bar hidden on desktop");
				await page.locator(`.toolbar .segmented button[title="Table"]`).click();
				await page.locator('button[aria-label="Increase"]').nth(1).click();
				await page.locator('button[aria-label="Increase"]').nth(3).click();
				await shot(`07-order-table-${label}`);
				await page.locator(`.toolbar .segmented button[title="Catalogue"]`).click();
				await shot(`08-order-catalogue-${label}`);
				await page.goto(`${BASE}/ssm#/route`);
				await page.waitForSelector(".customer");
				await shot(`09-customers-${label}`);
			} else if (w === 768) {
				await page.goto(`${BASE}/ssm#/order/CUST-0003`);
				await page.waitForSelector(".order-head");
				await page.locator(`.toolbar .segmented button[title="Grid"]`).click();
				await shot(`10-order-grid-${label}`);
			}
		});
	}
	await ctx.close();
} finally {
	await browser.close();
	server.close();
}

console.log(`\n${passed} passed, ${problems.length} failed`);
process.exit(problems.length ? 1 : 0);
