import frappe


def before_tests():
	"""Complete ERPNext's setup wizard on a fresh test site (fiscal year,
	warehouse types, root groups), exactly like ERPNext's own test suite."""
	frappe.clear_cache()
	from erpnext.setup.utils import before_tests as erpnext_before_tests

	erpnext_before_tests()
