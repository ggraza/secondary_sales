import unittest

from secondary_sales.core.access import FIELD_CATALOG, is_editable, is_visible, resolve_profile, strip_hidden


def role_profile(name, role, priority=0, **kw):
	return {"name": name, "enabled": 1, "applies_to": "Role", "role": role, "priority": priority, **kw}


class TestResolveProfile(unittest.TestCase):
	def test_guest_and_unknown_users_get_nothing(self):
		profiles = [role_profile("Reps", "Sales User")]
		self.assertIsNone(resolve_profile(profiles, "Guest", ["Guest"]))
		self.assertIsNone(resolve_profile(profiles, "", ["Sales User"]))
		self.assertIsNone(resolve_profile(profiles, "a@x.com", ["Accounts User"]))

	def test_disabled_profiles_are_ignored(self):
		profiles = [role_profile("Reps", "Sales User", enabled=0)]
		self.assertIsNone(resolve_profile(profiles, "a@x.com", ["Sales User"]))

	def test_user_profile_beats_role_profile(self):
		profiles = [
			role_profile("Managers", "Sales Manager", priority=100),
			{"name": "Ali only", "enabled": 1, "applies_to": "User", "user": "ali@x.com"},
		]
		self.assertEqual(resolve_profile(profiles, "ali@x.com", ["Sales Manager"])["name"], "Ali only")
		self.assertEqual(resolve_profile(profiles, "bob@x.com", ["Sales Manager"])["name"], "Managers")

	def test_highest_priority_role_wins_and_ties_are_deterministic(self):
		profiles = [
			role_profile("B", "Sales User", 1),
			role_profile("A", "Sales User", 1),
			role_profile("Top", "Sales Manager", 5),
		]
		self.assertEqual(resolve_profile(profiles, "u", ["Sales User", "Sales Manager"])["name"], "Top")
		self.assertEqual(resolve_profile(profiles, "u", ["Sales User"])["name"], "A")

	def test_user_profile_requires_exact_user(self):
		profiles = [{"name": "x", "enabled": 1, "applies_to": "User", "user": None}]
		self.assertIsNone(resolve_profile(profiles, "u", []))


class TestNormalize(unittest.TestCase):
	def test_defaults_are_safe(self):
		p = resolve_profile([role_profile("R", "Sales User")], "u", ["Sales User"])
		self.assertEqual(p["customer_scope"], "Route Plan Only")
		self.assertEqual(p["order_action"], "Save as Draft")
		self.assertEqual(p["max_discount_percent"], 0)
		self.assertFalse(is_editable(p, "order.rate"))
		self.assertFalse(is_editable(p, "order.discount"))
		self.assertTrue(is_editable(p, "order.remarks"))
		self.assertTrue(all(is_visible(p, k) for k in FIELD_CATALOG))

	def test_cart_views_and_default(self):
		p = resolve_profile(
			[
				role_profile(
					"R",
					"S",
					view_list=0,
					view_grid=1,
					view_table=0,
					view_compact=1,
					view_catalogue=0,
					default_view="list",
				)
			],
			"u",
			["S"],
		)
		self.assertEqual(p["cart_views"], ["grid", "compact"])
		self.assertEqual(p["default_view"], "grid")

	def test_no_views_falls_back_to_list(self):
		p = resolve_profile(
			[role_profile("R", "S", view_list=0, view_grid=0, view_table=0, view_compact=0, view_catalogue=0)],
			"u",
			["S"],
		)
		self.assertEqual(p["cart_views"], ["list"])

	def test_hidden_field_cannot_be_editable(self):
		rules = [{"field": "order.rate", "visible": 0, "editable": 1}]
		p = resolve_profile([role_profile("R", "S", field_rules=rules)], "u", ["S"])
		self.assertFalse(is_visible(p, "order.rate"))
		self.assertFalse(is_editable(p, "order.rate"))

	def test_hiding_outstanding_disables_screen(self):
		rules = [{"field": "customer.outstanding", "visible": 0}]
		p = resolve_profile([role_profile("R", "S", screen_outstanding=1, field_rules=rules)], "u", ["S"])
		self.assertFalse(p["screens"]["outstanding"])

	def test_unknown_rule_field_is_ignored(self):
		p = resolve_profile([role_profile("R", "S", field_rules=[{"field": "x.y", "visible": 0}])], "u", ["S"])
		self.assertNotIn("x.y", p["fields"])

	def test_discount_is_clamped(self):
		p = resolve_profile([role_profile("R", "S", max_discount_percent=250)], "u", ["S"])
		self.assertEqual(p["max_discount_percent"], 100)
		p = resolve_profile([role_profile("R", "S", max_discount_percent="bad")], "u", ["S"])
		self.assertEqual(p["max_discount_percent"], 0)

	def test_invalid_select_values_fall_back(self):
		p = resolve_profile([role_profile("R", "S", customer_scope="Everything", order_action="Delete")], "u", ["S"])
		self.assertEqual(p["customer_scope"], "Route Plan Only")
		self.assertEqual(p["order_action"], "Save as Draft")


class TestStripHidden(unittest.TestCase):
	def test_hidden_values_are_removed_from_payload(self):
		rules = [{"field": "item.price", "visible": 0}, {"field": "item.stock", "visible": 0}]
		p = resolve_profile([role_profile("R", "S", field_rules=rules)], "u", ["S"])
		rows = [{"item_code": "A", "prices": {"Std": 10}, "stock": 5, "image": "/files/a.png"}]
		out = strip_hidden(rows, "item", p, {"price": ["prices"], "stock": ["stock"], "image": ["image"]})
		self.assertEqual(out, [{"item_code": "A", "image": "/files/a.png"}])
		self.assertIn("prices", rows[0], "input must not be mutated")


if __name__ == "__main__":
	unittest.main()
