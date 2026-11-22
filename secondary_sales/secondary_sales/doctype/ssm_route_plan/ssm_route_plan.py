# Copyright (c) 2026, Ghulam Ghous and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class SSMRoutePlan(Document):
	def validate(self):
		seen = set()
		for idx, row in enumerate(self.customers, start=1):
			if row.customer in seen:
				frappe.throw(_("Row {0}: customer {1} is listed twice.").format(row.idx, row.customer))
			seen.add(row.customer)
			if not row.sequence:
				row.sequence = idx

	def on_update(self):
		from secondary_sales.api._guard import clear_access_cache

		clear_access_cache(self.sales_user)
