"""Customer outstanding balances with ageing, scoped to what the rep may see."""

from __future__ import annotations

import frappe
from frappe import _
from frappe.query_builder.functions import Sum
from frappe.utils import flt, getdate, today

from secondary_sales.api._guard import allowed_customers, get_settings, is_customer_allowed, require
from secondary_sales.core.access import is_visible
from secondary_sales.core.ageing import age_invoices

CHUNK = 500


def _chunks(seq, size=CHUNK):
	for i in range(0, len(seq), size):
		yield seq[i : i + size]


def ledger_balances(customers: list[str], company: str) -> dict[str, float]:
	"""Net receivable per customer from the Payment Ledger (invoices, payments,
	credit notes and unallocated advances all included)."""
	if not customers:
		return {}
	ple = frappe.qb.DocType("Payment Ledger Entry")
	out: dict[str, float] = {}
	for chunk in _chunks(customers):
		rows = (
			frappe.qb.from_(ple)
			.select(ple.party, Sum(ple.amount))
			.where(
				(ple.party_type == "Customer")
				& (ple.party.isin(chunk))
				& (ple.company == company)
				& (ple.delinked == 0)
			)
			.groupby(ple.party)
		).run()
		for party, amount in rows:
			out[party] = flt(amount, 2)
	return out


def open_invoices(customers: list[str], company: str) -> list[dict]:
	result = []
	for chunk in _chunks(customers):
		result += frappe.get_all(
			"Sales Invoice",
			filters={
				"docstatus": 1,
				"company": company,
				"customer": ["in", chunk],
				"outstanding_amount": [">", 0],
			},
			fields=["name", "customer", "posting_date", "due_date", "grand_total", "outstanding_amount"],
			order_by="due_date asc",
		)
	return result


def build_outstanding(customers: list[str], with_invoices: bool = False) -> list[dict]:
	settings = get_settings()
	ranges = [settings.ageing_range_1, settings.ageing_range_2, settings.ageing_range_3, settings.ageing_range_4]
	balances = ledger_balances(customers, settings.company)
	invoices = open_invoices(customers, settings.company)
	by_customer: dict[str, list] = {}
	for inv in invoices:
		by_customer.setdefault(inv.customer, []).append(inv)

	as_of = getdate(today())
	names = (
		dict(
			frappe.get_all(
				"Customer", filters={"name": ["in", customers]}, fields=["name", "customer_name"], as_list=True
			)
		)
		if customers
		else {}
	)

	result = []
	for customer in customers:
		invs = by_customer.get(customer, [])
		ageing = age_invoices(invs, as_of, ranges)
		total = balances.get(customer, ageing["total"])
		if not total and not invs:
			continue
		row = {
			"customer": customer,
			"customer_name": names.get(customer, customer),
			"total": flt(total, 2),
			"invoiced": ageing["total"],
			"unallocated": flt(total - ageing["total"], 2),
			"buckets": ageing["buckets"],
			"oldest_days": ageing["oldest_days"],
			"invoice_count": len(invs),
		}
		if with_invoices:
			row["invoices"] = [
				{
					"name": i.name,
					"posting_date": str(i.posting_date),
					"due_date": str(i.due_date or i.posting_date),
					"grand_total": flt(i.grand_total, 2),
					"outstanding_amount": flt(i.outstanding_amount, 2),
				}
				for i in invs[:100]
			]
		result.append(row)
	result.sort(key=lambda r: -r["total"])
	return result


@frappe.whitelist(methods=["GET"])
def get_outstanding(customer: str | None = None):
	"""All outstanding for the rep's customers, or one customer's detail with invoices."""
	if customer:
		profile = require(any_of=("order", "outstanding", "route"))
		if not is_visible(profile, "customer.outstanding"):
			frappe.throw(_("Outstanding is hidden for your profile."), frappe.PermissionError)
		if not is_customer_allowed(profile, customer):
			frappe.throw(_("You are not allowed to view this customer."), frappe.PermissionError)
		rows = build_outstanding([customer], with_invoices=True)
		return rows[0] if rows else {"customer": customer, "total": 0, "buckets": [], "invoices": []}

	profile = require("outstanding")
	customers = allowed_customers(profile, limit=get_settings().max_customers or 5000)
	return {"as_of": today(), "rows": build_outstanding(customers)}
