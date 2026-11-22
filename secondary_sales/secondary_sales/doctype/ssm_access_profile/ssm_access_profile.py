# Copyright (c) 2026, Ghulam Ghous and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document

from secondary_sales.core.access import CART_VIEWS, FIELD_CATALOG


class SSMAccessProfile(Document):
	def validate(self):
		if self.applies_to == "Role":
			if not self.role:
				frappe.throw(_("Select the role this profile applies to."))
			self.user = None
		elif self.applies_to == "User":
			if not self.user:
				frappe.throw(_("Select the user this profile applies to."))
			self.role = None

		views = [v for v in CART_VIEWS if self.get(f"view_{v}")]
		if not views:
			frappe.throw(_("Enable at least one cart display option."))
		if self.default_view not in views:
			self.default_view = views[0]

		if not 0 <= (self.max_discount_percent or 0) <= 100:
			frappe.throw(_("Max Discount % must be between 0 and 100."))

		seen = set()
		for row in self.field_rules:
			if row.field not in FIELD_CATALOG:
				frappe.throw(_("Row {0}: unknown field {1}.").format(row.idx, row.field))
			if row.field in seen:
				frappe.throw(_("Row {0}: {1} is listed twice.").format(row.idx, row.field))
			seen.add(row.field)
			if not row.visible:
				row.editable = 0

		if self.enabled and self.applies_to == "User":
			dup = frappe.db.exists(
				"SSM Access Profile",
				{"applies_to": "User", "user": self.user, "enabled": 1, "name": ("!=", self.name)},
			)
			if dup:
				frappe.throw(_("User {0} already has an enabled profile: {1}.").format(self.user, dup))

	def on_update(self):
		from secondary_sales.api._guard import clear_access_cache

		clear_access_cache()

	def on_trash(self):
		from secondary_sales.api._guard import clear_access_cache

		clear_access_cache()
