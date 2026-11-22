"""Master data the PWA keeps on the device for offline order taking."""

from __future__ import annotations

import hashlib
import json

import frappe
from frappe import _
from frappe.query_builder.functions import Max
from frappe.utils import flt, getdate, now_datetime, today

from secondary_sales.api._guard import (
	allowed_customers,
	get_settings,
	is_customer_allowed,
	require,
	route_customers,
	throttle,
)
from secondary_sales.api.outstanding import ledger_balances
from secondary_sales.core.access import is_visible, strip_hidden

CUSTOMER_FIELD_MAP = {
	"mobile_no": ["mobile_no"],
	"address": ["address"],
	"territory": ["territory"],
	"customer_group": ["customer_group"],
	"outstanding": ["outstanding"],
	"credit_limit": ["credit_limit"],
}
ITEM_FIELD_MAP = {
	"price": ["prices"],
	"stock": ["stock"],
	"image": ["image"],
	"brand": ["brand"],
	"item_group": ["item_group"],
}


def _customers(profile: dict, settings) -> list[dict]:
	names = allowed_customers(profile, limit=settings.max_customers or 5000)
	if not names:
		return []
	rows = frappe.get_list(
		"Customer",
		filters={"name": ["in", names]},
		fields=[
			"name",
			"customer_name",
			"customer_group",
			"territory",
			"mobile_no",
			"primary_address",
			"default_price_list",
			"ssm_latitude",
			"ssm_longitude",
		],
		limit_page_length=len(names),
	)
	route = route_customers(frappe.session.user)

	limits = dict(
		frappe.get_all(
			"Customer Credit Limit",
			filters={"parenttype": "Customer", "parent": ["in", names], "company": settings.company},
			fields=["parent", "credit_limit"],
			as_list=True,
		)
	)
	balances = ledger_balances(names, settings.company) if is_visible(profile, "customer.outstanding") else {}

	so = frappe.qb.DocType("Sales Order")
	last_orders = dict(
		frappe.qb.from_(so)
		.select(so.customer, Max(so.transaction_date))
		.where((so.customer.isin(names)) & (so.docstatus < 2) & (so.company == settings.company))
		.groupby(so.customer)
		.run()
	)

	out = []
	for r in rows:
		plan = route.get(r.name) or {}
		out.append(
			{
				"name": r.name,
				"customer_name": r.customer_name,
				"customer_group": r.customer_group,
				"territory": r.territory,
				"mobile_no": r.mobile_no,
				"address": frappe.utils.strip_html(r.primary_address or "").replace("\n", ", ").strip(", "),
				"price_list": r.default_price_list or settings.price_list,
				"lat": r.ssm_latitude or None,
				"lng": r.ssm_longitude or None,
				"route_days": plan.get("days", []),
				"sequence": plan.get("sequence", 0),
				"outstanding": flt(balances.get(r.name, 0), 2),
				"credit_limit": flt(limits.get(r.name, 0), 2),
				"last_order_date": str(last_orders[r.name]) if last_orders.get(r.name) else None,
			}
		)
	out.sort(key=lambda c: (c["sequence"] or 99999, c["customer_name"] or ""))
	return strip_hidden(out, "customer", profile, CUSTOMER_FIELD_MAP)


def _items(profile: dict, settings, price_lists: set[str]) -> list[dict]:
	items = frappe.get_list(
		"Item",
		filters={"disabled": 0, "is_sales_item": 1, "has_variants": 0},
		fields=["name", "item_name", "item_group", "stock_uom", "brand", "image"],
		limit_page_length=settings.max_items or 5000,
		order_by="item_group asc, item_name asc",
	)
	if not items:
		return []
	codes = [i.name for i in items]
	code_set = set(codes)

	factors: dict[str, float] = {}
	if settings.pack_uom:
		for parent, factor in frappe.get_all(
			"UOM Conversion Detail",
			filters={"parenttype": "Item", "uom": settings.pack_uom},
			fields=["parent", "conversion_factor"],
			as_list=True,
		):
			if parent in code_set and flt(factor) > 0:
				factors[parent] = flt(factor)

	stock_uom = {i.name: i.stock_uom for i in items}
	prices: dict[str, dict[str, float]] = {}
	if price_lists and is_visible(profile, "item.price"):
		date = getdate(today())
		for p in frappe.get_all(
			"Item Price",
			filters={"price_list": ["in", list(price_lists)], "selling": 1},
			fields=["item_code", "price_list", "uom", "price_list_rate", "valid_from", "valid_upto", "customer"],
		):
			if p.item_code not in code_set or p.customer:
				continue
			if (p.valid_from and getdate(p.valid_from) > date) or (p.valid_upto and getdate(p.valid_upto) < date):
				continue
			rate = flt(p.price_list_rate)
			if p.uom and p.uom != stock_uom[p.item_code]:
				if p.uom == settings.pack_uom and factors.get(p.item_code):
					rate = rate / factors[p.item_code]
				else:
					continue
			prices.setdefault(p.item_code, {})[p.price_list] = flt(rate, 6)

	stock: dict[str, float] = {}
	if settings.warehouse and is_visible(profile, "item.stock"):
		for item_code, actual, reserved in frappe.get_all(
			"Bin",
			filters={"warehouse": settings.warehouse},
			fields=["item_code", "actual_qty", "reserved_qty"],
			as_list=True,
		):
			if item_code in code_set:
				stock[item_code] = flt(actual) - flt(reserved)

	out = [
		{
			"item_code": i.name,
			"item_name": i.item_name,
			"item_group": i.item_group,
			"brand": i.brand,
			"stock_uom": i.stock_uom,
			"pack_factor": factors.get(i.name) or 0,
			"image": i.image if i.image and i.image.startswith("/") else None,
			"prices": prices.get(i.name, {}),
			"stock": stock.get(i.name, 0),
		}
		for i in items
	]
	return strip_hidden(out, "item", profile, ITEM_FIELD_MAP)


@frappe.whitelist(methods=["GET"])
def master_data(known_hash: str | None = None):
	"""Customers, items, prices, stock, reasons and today's visits.

	When ``known_hash`` matches the current data the response is tiny, so the
	PWA can poll cheaply.
	"""
	profile = require(any_of=("route", "order"))
	throttle("master_data", limit=30)
	settings = get_settings()

	customers = _customers(profile, settings)
	price_lists = {settings.price_list} | {c.get("price_list") for c in customers if c.get("price_list")}
	items = _items(profile, settings, {p for p in price_lists if p})

	reasons = frappe.get_all("SSM No Order Reason", filters={"enabled": 1}, pluck="name", order_by="reason asc")
	visits = frappe.get_all(
		"SSM Visit",
		filters={"user": frappe.session.user, "visit_date": today()},
		fields=["customer", "outcome", "sales_order"],
	)

	payload = {
		"customers": customers,
		"items": items,
		"no_order_reasons": reasons,
		"visits_today": visits,
		"default_price_list": settings.price_list,
	}
	digest = hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()
	if known_hash and known_hash == digest:
		return {"unchanged": True, "hash": digest, "generated_at": now_datetime().isoformat()}
	payload["hash"] = digest
	payload["generated_at"] = now_datetime().isoformat()
	return payload


@frappe.whitelist(methods=["POST"])
def update_customer_location(customer: str, lat, lng, accuracy=None):
	profile = require("route")
	throttle("location", limit=20)
	if not profile["allow_update_location"]:
		frappe.throw(_("Updating customer location is not allowed for your profile."), frappe.PermissionError)
	if not is_customer_allowed(profile, customer):
		frappe.throw(_("You are not allowed to update this customer."), frappe.PermissionError)
	try:
		lat, lng = float(lat), float(lng)
	except (TypeError, ValueError):
		frappe.throw(_("Invalid coordinates."))
	if not (-90 <= lat <= 90 and -180 <= lng <= 180):
		frappe.throw(_("Invalid coordinates."))

	frappe.db.set_value("Customer", customer, {"ssm_latitude": lat, "ssm_longitude": lng})
	frappe.get_doc("Customer", customer).add_comment(
		"Info", _("Location set to {0}, {1} from the sales app").format(round(lat, 6), round(lng, 6))
	)
	return {"customer": customer, "lat": lat, "lng": lng}
