# Copyright (c) 2026, Ghulam Ghous and contributors
# For license information, please see license.txt

import frappe
from frappe import _
from frappe.model.document import Document


class SSMSettings(Document):
	def validate(self):
		ranges = [self.ageing_range_1, self.ageing_range_2, self.ageing_range_3, self.ageing_range_4]
		ranges = [int(r or 0) for r in ranges]
		if any(r <= 0 for r in ranges) or ranges != sorted(set(ranges)):
			frappe.throw(_("Ageing ranges must be positive and increasing, for example 30, 60, 90, 120."))
		for field in ("max_offline_hours", "max_order_age_days", "default_delivery_days", "nearby_radius_m"):
			if (self.get(field) or 0) < 0:
				frappe.throw(_("{0} cannot be negative.").format(self.meta.get_label(field)))
		if not self.data_key_version:
			self.data_key_version = 1

	def on_update(self):
		from secondary_sales.api._guard import clear_access_cache

		clear_access_cache()

	@frappe.whitelist()
	def revoke_offline_data(self):
		"""Rotate the device data key. Every device wipes its local data at its next sync."""
		frappe.only_for("System Manager")
		self.data_key_version = (self.data_key_version or 1) + 1
		self.save()
		return self.data_key_version
