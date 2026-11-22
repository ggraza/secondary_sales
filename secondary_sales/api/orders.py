"""Order and visit sync from the PWA outbox.

Each order carries a client UUID created on the device. The server is
idempotent on that UUID, so a retry after a lost response never creates a
second Sales Order. Every order is processed and committed on its own, so one
bad order never blocks the rest of the batch.
"""

from __future__ import annotations

import frappe
from frappe import _
from frappe.utils import add_days, flt, getdate, nowdate, strip_html

from secondary_sales.api._guard import get_settings, is_customer_allowed, require, throttle
from secondary_sales.core.access import is_editable
from secondary_sales.core.validation import PayloadError, check_rate, validate_batch, validate_order

LOG = "SSM Sync Log"


class Rejected(Exception):
	"""The order can never succeed as sent; the rep has to fix or discard it."""


def _message(exc: Exception) -> str:
	text = strip_html(str(exc) or "").strip()
	if not text and frappe.message_log:
		try:
			text = strip_html(frappe.parse_json(frappe.message_log[-1]).get("message", ""))
		except Exception:
			text = ""
	return (text or _("The server could not save this order."))[:500]


def _get_or_create_log(client_uuid: str):
	"""Return (log_name, existing_row). Creating the log first means a concurrent
	duplicate request hits the unique index instead of creating a second order."""
	row = frappe.db.get_value(
		LOG,
		{"client_uuid": client_uuid},
		["name", "status", "user", "reference_doctype", "reference_name", "attempts"],
		as_dict=True,
		for_update=True,
	)
	if row:
		return row.name, row
	log = frappe.get_doc(
		{"doctype": LOG, "client_uuid": client_uuid, "user": frappe.session.user, "status": "Failed", "attempts": 0}
	)
	log.insert(ignore_permissions=True)
	return log.name, None


def _set_log(name: str, status: str, error: str = "", ref: tuple[str, str] | None = None, attempts: int = 1):
	values = {"status": status, "error": error, "attempts": attempts}
	if ref:
		values.update({"reference_doctype": ref[0], "reference_name": ref[1]})
	frappe.db.set_value(LOG, name, values, update_modified=True)


def _visit(order: dict, outcome: str, sales_order: str | None = None):
	geo = order.get("geo") or {}
	visit = frappe.get_doc(
		{
			"doctype": "SSM Visit",
			"user": frappe.session.user,
			"customer": order["customer"],
			"visit_date": getdate(order["created_at"]) if order.get("created_at") else nowdate(),
			"visited_at": order.get("created_at"),
			"outcome": outcome,
			"no_order_reason": order.get("no_order_reason"),
			"sales_order": sales_order,
			"latitude": geo.get("lat"),
			"longitude": geo.get("lng"),
			"accuracy": geo.get("accuracy"),
			"client_uuid": order["client_uuid"],
			"remarks": order.get("remarks"),
		}
	)
	visit.insert(ignore_permissions=True)
	return visit.name


def _build_sales_order(order: dict, profile: dict, settings):
	customer_price_list = frappe.db.get_value("Customer", order["customer"], "default_price_list")
	delivery = order.get("delivery_date") if is_editable(profile, "order.delivery_date") else None
	min_delivery = getdate(nowdate())
	if not delivery or getdate(delivery) < min_delivery:
		delivery = add_days(min_delivery, settings.default_delivery_days or 0)

	so = frappe.new_doc("Sales Order")
	so.company = settings.company
	so.customer = order["customer"]
	so.transaction_date = nowdate()
	so.delivery_date = delivery
	so.order_type = "Sales"
	so.selling_price_list = customer_price_list or settings.price_list
	if settings.warehouse:
		so.set_warehouse = settings.warehouse
	so.ssm_client_uuid = order["client_uuid"]
	if order.get("remarks") and is_editable(profile, "order.remarks"):
		so.ssm_remarks = order["remarks"]

	for line in order["items"]:
		item = frappe.db.get_value(
			"Item", line["item_code"], ["name", "stock_uom", "disabled", "is_sales_item", "has_variants"], as_dict=True
		)
		if not item or item.disabled or not item.is_sales_item or item.has_variants:
			raise Rejected(_("Item {0} is not available for sale.").format(line["item_code"]))
		if not frappe.has_permission("Item", "read", doc=item.name):
			raise Rejected(_("You are not allowed to sell item {0}.").format(line["item_code"]))
		so.append(
			"items",
			{
				"item_code": item.name,
				"qty": line["qty"],
				"uom": item.stock_uom,
				"stock_uom": item.stock_uom,
				"conversion_factor": 1,
				"delivery_date": delivery,
				"warehouse": settings.warehouse or None,
			},
		)

	# Let ERPNext fill price list rates, pricing rules (promotions) and taxes.
	so.run_method("set_missing_values")

	may_rate = is_editable(profile, "order.rate")
	may_discount = is_editable(profile, "order.discount")
	max_disc = profile["max_discount_percent"]
	for row, line in zip(so.items, order["items"], strict=True):
		rate = line.get("rate") if may_rate else None
		discount = line.get("discount_percentage") if may_discount else None
		if rate is None and discount is None:
			continue
		errors = check_rate(flt(row.price_list_rate), rate, discount, max_disc)
		if errors:
			raise Rejected(_("{0}: {1}").format(row.item_code, "; ".join(errors)))
		if discount is not None:
			row.discount_percentage = discount
			row.rate = None
		if rate is not None:
			row.rate = rate
	return so


def _process(raw: dict, profile: dict, settings) -> dict:
	try:
		order = validate_order(raw, max_age_days=settings.max_order_age_days or 0)
	except PayloadError as e:
		return {
			"client_uuid": (raw or {}).get("client_uuid") if isinstance(raw, dict) else None,
			"status": "rejected",
			"message": "; ".join(e.errors),
		}

	uuid = order["client_uuid"]
	try:
		log_name, existing = _get_or_create_log(uuid)
	except (frappe.DuplicateEntryError, frappe.UniqueValidationError):
		frappe.db.rollback()
		return {"client_uuid": uuid, "status": "retry", "message": _("Already being processed.")}

	if existing:
		if existing.user != frappe.session.user:
			# Never reveal another user's document.
			return {"client_uuid": uuid, "status": "rejected", "message": _("Invalid order reference.")}
		if existing.status == "Success":
			return {
				"client_uuid": uuid,
				"status": "duplicate",
				"doctype": existing.reference_doctype,
				"name": existing.reference_name,
			}
	attempts = ((existing or {}).get("attempts") or 0) + 1

	frappe.db.savepoint("ssm_order")
	try:
		if not is_customer_allowed(profile, order["customer"]):
			raise Rejected(_("You are not allowed to take orders for customer {0}.").format(order["customer"]))

		if order["outcome"] == "no_order":
			if not frappe.db.exists("SSM No Order Reason", {"name": order["no_order_reason"], "enabled": 1}):
				raise Rejected(_("Unknown no-order reason."))
			visit = _visit(order, "No Order")
			_set_log(log_name, "Success", ref=("SSM Visit", visit), attempts=attempts)
			frappe.db.commit()
			return {"client_uuid": uuid, "status": "ok", "doctype": "SSM Visit", "name": visit}

		so = _build_sales_order(order, profile, settings)
		so.insert()  # standard permission checks apply

		warning = None
		if profile["order_action"] == "Submit":
			frappe.db.savepoint("ssm_submit")
			try:
				so.submit()
			except frappe.ValidationError as e:
				frappe.db.rollback(save_point="ssm_submit")
				so.reload()
				warning = _("Saved as draft, could not submit: {0}").format(_message(e))
				frappe.clear_messages()

		_visit(order, "Order", so.name)
		_set_log(log_name, "Success", error=warning or "", ref=("Sales Order", so.name), attempts=attempts)
		frappe.db.commit()

		result = {
			"client_uuid": uuid,
			"status": "ok",
			"doctype": "Sales Order",
			"name": so.name,
			"docstatus": so.docstatus,
			"grand_total": flt(so.grand_total, 2),
			"currency": so.currency,
			"lines": [
				{"item_code": r.item_code, "qty": r.qty, "rate": flt(r.rate, 2), "amount": flt(r.amount, 2)}
				for r in so.items
			],
		}
		result["net_total"] = flt(so.net_total, 2)
		est = order.get("estimated_total")
		if est is not None and abs(flt(est) - flt(so.net_total)) > 0.01:
			# The device estimate excludes taxes, so compare with the net total.
			result["price_changed"] = True
			result["message"] = _(
				"Net amount {0} differs from the device estimate {1} (current prices or promotions)."
			).format(flt(so.net_total, 2), flt(est, 2))
		if warning:
			result["warning"] = warning
		return result

	except (Rejected, frappe.ValidationError, frappe.PermissionError) as e:
		frappe.db.rollback(save_point="ssm_order")
		msg = _message(e)
		frappe.clear_messages()
		_set_log(log_name, "Rejected", error=msg, attempts=attempts)
		frappe.db.commit()
		return {"client_uuid": uuid, "status": "rejected", "message": msg}
	except Exception:
		frappe.db.rollback(save_point="ssm_order")
		frappe.clear_messages()
		_set_log(log_name, "Failed", error=frappe.get_traceback()[-4000:], attempts=attempts)
		frappe.db.commit()
		frappe.log_error(title=f"SSM order sync failed {uuid}", message=frappe.get_traceback())
		# Do not leak server internals to the device.
		return {"client_uuid": uuid, "status": "failed", "message": _("Temporary server error, will retry.")}


@frappe.whitelist(methods=["POST"])
def submit_orders(orders):
	"""Sync a batch of orders / no-order visits from the device outbox."""
	profile = require("order")
	throttle("submit_orders", limit=30)
	settings = get_settings()
	orders = frappe.parse_json(orders) if isinstance(orders, str) else orders
	try:
		validate_batch(orders)
	except PayloadError as e:
		frappe.throw("; ".join(e.errors))
	return {"results": [_process(o, profile, settings) for o in orders]}


@frappe.whitelist(methods=["GET"])
def order_history(limit: int = 50, customer: str | None = None):
	profile = require("orders")
	limit = min(max(int(limit or 50), 1), 200)
	filters = {"docstatus": ["<", 2], "company": get_settings().company}
	if not profile["view_all_orders"]:
		filters["owner"] = frappe.session.user
	if customer:
		if not is_customer_allowed(profile, customer):
			frappe.throw(_("You are not allowed to view this customer."), frappe.PermissionError)
		filters["customer"] = customer
	return frappe.get_list(
		"Sales Order",
		filters=filters,
		fields=[
			"name",
			"customer",
			"customer_name",
			"transaction_date",
			"delivery_date",
			"grand_total",
			"currency",
			"status",
			"docstatus",
			"total_qty",
			"ssm_client_uuid",
		],
		order_by="creation desc",
		limit_page_length=limit,
	)


@frappe.whitelist(methods=["GET"])
def order_detail(name: str):
	profile = require("orders")
	doc = frappe.get_doc("Sales Order", name)
	doc.check_permission("read")
	if not profile["view_all_orders"] and doc.owner != frappe.session.user:
		frappe.throw(_("Not permitted."), frappe.PermissionError)
	return {
		"name": doc.name,
		"customer": doc.customer,
		"customer_name": doc.customer_name,
		"transaction_date": str(doc.transaction_date),
		"delivery_date": str(doc.delivery_date),
		"status": doc.status,
		"docstatus": doc.docstatus,
		"grand_total": flt(doc.grand_total, 2),
		"total_taxes_and_charges": flt(doc.total_taxes_and_charges, 2),
		"discount_amount": flt(doc.discount_amount, 2),
		"currency": doc.currency,
		"items": [
			{
				"item_code": i.item_code,
				"item_name": i.item_name,
				"qty": i.qty,
				"uom": i.uom,
				"rate": flt(i.rate, 2),
				"amount": flt(i.amount, 2),
			}
			for i in doc.items
		],
	}
