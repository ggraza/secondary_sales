"""Integration and security tests. They need a site with ERPNext and this app:

	bench --site test_site run-tests --app secondary_sales

CI runs them on every push (.github/workflows/ci.yml).
"""

import uuid

import frappe
from frappe.utils import add_days, nowdate

try:  # Frappe v16
	from frappe.tests import IntegrationTestCase as TestCase
except ImportError:  # Frappe v15
	from frappe.tests.utils import FrappeTestCase as TestCase

from secondary_sales.api import boot, data, orders, outstanding
from secondary_sales.api._guard import clear_access_cache

COMPANY = "_SSM Test Co"
REP = "ssm-rep@example.com"
REP2 = "ssm-rep2@example.com"
OUTSIDER = "ssm-outsider@example.com"
CUST_A = "_SSM Customer A"
CUST_B = "_SSM Customer B"
ITEM = "_SSM-COLA"


def make_user(email, roles):
	if not frappe.db.exists("User", email):
		u = frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": email.split("@")[0], "send_welcome_email": 0}
		)
		u.insert(ignore_permissions=True)
	u = frappe.get_doc("User", email)
	u.set("roles", [])
	for r in roles:
		u.append("roles", {"role": r})
	u.save(ignore_permissions=True)


def order(customer=CUST_A, qty=12, **kw):
	o = {
		"client_uuid": str(uuid.uuid4()),
		"outcome": "order",
		"customer": customer,
		"items": [{"item_code": ITEM, "qty": qty}],
		"created_at": frappe.utils.now_datetime().isoformat(),
	}
	o.update(kw)
	return o


class TestSecondarySales(TestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		frappe.set_user("Administrator")
		if not frappe.db.exists("Company", COMPANY):
			frappe.get_doc(
				{
					"doctype": "Company",
					"company_name": COMPANY,
					"abbr": "SSMT",
					"default_currency": "USD",
					"country": "United States",
				}
			).insert()
		for name in (CUST_A, CUST_B):
			if not frappe.db.exists("Customer", name):
				frappe.get_doc(
					{
						"doctype": "Customer",
						"customer_name": name,
						"customer_group": "All Customer Groups",
						"territory": "All Territories",
					}
				).insert()
		if not frappe.db.exists("Item", ITEM):
			frappe.get_doc(
				{
					"doctype": "Item",
					"item_code": ITEM,
					"item_name": "SSM Cola",
					"item_group": "All Item Groups",
					"stock_uom": "Nos",
					"is_stock_item": 0,
					"is_sales_item": 1,
				}
			).insert()
		if not frappe.db.exists("Item Price", {"item_code": ITEM, "price_list": "Standard Selling"}):
			frappe.get_doc(
				{"doctype": "Item Price", "item_code": ITEM, "price_list": "Standard Selling", "price_list_rate": 100}
			).insert()

		make_user(REP, ["Sales User"])
		make_user(REP2, ["Sales User"])
		make_user(OUTSIDER, ["Accounts User"])

		settings = frappe.get_single("SSM Settings")
		settings.company = COMPANY
		settings.price_list = "Standard Selling"
		settings.warehouse = frappe.db.get_value("Warehouse", {"company": COMPANY, "is_group": 0}, "name")
		settings.save()

		for user, customer in ((REP, CUST_A), (REP2, CUST_B)):
			plan = f"_SSM Plan {user}"
			if not frappe.db.exists("SSM Route Plan", plan):
				frappe.get_doc(
					{
						"doctype": "SSM Route Plan",
						"plan_name": plan,
						"sales_user": user,
						"day_of_week": "Everyday",
						"customers": [{"customer": customer}],
					}
				).insert()

		# after_install creates this profile; make sure it is in its default state.
		if not frappe.db.exists("SSM Access Profile", "Field Sales Rep"):
			from secondary_sales.install import after_install

			after_install()
		profile = frappe.get_doc("SSM Access Profile", "Field Sales Rep")
		profile.enabled = 1
		profile.customer_scope = "Route Plan Only"
		profile.order_action = "Save as Draft"
		profile.max_discount_percent = 5
		profile.set("field_rules", [])
		profile.save()
		frappe.db.commit()

	def setUp(self):
		clear_access_cache()
		frappe.set_user(REP)

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.local.response = frappe._dict()

	# ---------- authentication & access ----------

	def test_guest_is_refused(self):
		frappe.set_user("Guest")
		with self.assertRaises(frappe.AuthenticationError):
			boot.bootstrap()

	def test_user_without_profile_is_refused(self):
		frappe.set_user(OUTSIDER)
		with self.assertRaises(frappe.PermissionError):
			boot.bootstrap()
		with self.assertRaises(frappe.PermissionError):
			data.master_data()

	def test_bootstrap_returns_profile_and_per_user_key(self):
		b1 = boot.bootstrap()
		self.assertEqual(b1["profile"]["name"], "Field Sales Rep")
		self.assertTrue(b1["csrf_token"])
		frappe.set_user(REP2)
		b2 = boot.bootstrap()
		self.assertNotEqual(b1["device"]["key"], b2["device"]["key"])
		self.assertNotEqual(b1["device"]["key_id"], b2["device"]["key_id"])

	def test_revoking_offline_data_rotates_key(self):
		before = boot.bootstrap()["device"]["key_id"]
		frappe.set_user("Administrator")
		frappe.get_single("SSM Settings").revoke_offline_data()
		frappe.set_user(REP)
		self.assertNotEqual(before, boot.bootstrap()["device"]["key_id"])

	# ---------- data scoping ----------

	def test_master_data_only_contains_route_customers(self):
		names = {c["name"] for c in data.master_data()["customers"]}
		self.assertIn(CUST_A, names)
		self.assertNotIn(CUST_B, names)

	def test_hidden_fields_are_removed_by_the_server(self):
		frappe.set_user("Administrator")
		profile = frappe.get_doc("SSM Access Profile", "Field Sales Rep")
		profile.append("field_rules", {"field": "item.price", "visible": 0})
		profile.append("field_rules", {"field": "customer.outstanding", "visible": 0})
		profile.save()
		try:
			frappe.set_user(REP)
			md = data.master_data()
			self.assertTrue(md["items"])
			self.assertTrue(all("prices" not in i for i in md["items"]))
			self.assertTrue(all("outstanding" not in c for c in md["customers"]))
			with self.assertRaises(frappe.PermissionError):
				outstanding.get_outstanding(customer=CUST_A)
		finally:
			frappe.set_user("Administrator")
			profile.reload()
			profile.set("field_rules", [])
			profile.save()

	def test_outstanding_of_other_reps_customer_is_refused(self):
		with self.assertRaises(frappe.PermissionError):
			outstanding.get_outstanding(customer=CUST_B)
		self.assertEqual(outstanding.get_outstanding(customer=CUST_A)["customer"], CUST_A)

	def test_known_hash_short_circuits(self):
		first = data.master_data()
		again = data.master_data(known_hash=first["hash"])
		self.assertTrue(again["unchanged"])
		self.assertEqual(again["hash"], first["hash"])
		self.assertNotIn("customers", again)

	# ---------- order sync ----------

	def test_order_creates_draft_sales_order_and_is_idempotent(self):
		o = order()
		r1 = orders.submit_orders([o])["results"][0]
		self.assertEqual(r1["status"], "ok", r1)
		so = frappe.get_doc("Sales Order", r1["name"])
		self.assertEqual(so.docstatus, 0)
		self.assertEqual(so.customer, CUST_A)
		self.assertEqual(so.ssm_client_uuid, o["client_uuid"])
		self.assertEqual(so.items[0].rate, 100)  # server price, not client

		r2 = orders.submit_orders([o])["results"][0]
		self.assertEqual(r2["status"], "duplicate")
		self.assertEqual(r2["name"], r1["name"])
		self.assertEqual(frappe.db.count("Sales Order", {"ssm_client_uuid": o["client_uuid"]}), 1)
		self.assertTrue(frappe.db.exists("SSM Visit", {"client_uuid": o["client_uuid"], "sales_order": so.name}))

	def test_order_for_customer_outside_route_is_rejected(self):
		o = order(customer=CUST_B)
		r = orders.submit_orders([o])["results"][0]
		self.assertEqual(r["status"], "rejected")
		self.assertFalse(frappe.db.exists("Sales Order", {"ssm_client_uuid": o["client_uuid"]}))

	def test_replaying_another_users_uuid_leaks_nothing(self):
		o = order()
		first = orders.submit_orders([o])["results"][0]
		frappe.set_user(REP2)
		r = orders.submit_orders([o])["results"][0]
		self.assertEqual(r["status"], "rejected")
		self.assertNotIn("name", r)
		self.assertNotIn(first["name"], str(r))

	def test_client_rate_is_ignored_unless_editable(self):
		r = orders.submit_orders([order(items=[{"item_code": ITEM, "qty": 1, "rate": 1}])])["results"][0]
		self.assertEqual(frappe.get_doc("Sales Order", r["name"]).items[0].rate, 100)

	def test_discount_above_max_is_rejected_when_editable(self):
		frappe.set_user("Administrator")
		profile = frappe.get_doc("SSM Access Profile", "Field Sales Rep")
		profile.append("field_rules", {"field": "order.discount", "visible": 1, "editable": 1})
		profile.save()
		try:
			frappe.set_user(REP)
			bad = orders.submit_orders([order(items=[{"item_code": ITEM, "qty": 1, "discount_percentage": 50}])])[
				"results"
			][0]
			self.assertEqual(bad["status"], "rejected")
			ok = orders.submit_orders([order(items=[{"item_code": ITEM, "qty": 1, "discount_percentage": 5}])])[
				"results"
			][0]
			self.assertEqual(ok["status"], "ok", ok)
			self.assertAlmostEqual(frappe.get_doc("Sales Order", ok["name"]).items[0].rate, 95)
		finally:
			frappe.set_user("Administrator")
			profile.reload()
			profile.set("field_rules", [])
			profile.save()

	def test_malformed_payloads_are_rejected(self):
		results = orders.submit_orders(
			[
				{"client_uuid": "x", "customer": CUST_A, "items": []},
				order(items=[{"item_code": "<script>", "qty": 1}]),
				order(items=[{"item_code": ITEM, "qty": -4}]),
				order(created_at="2001-01-01T00:00:00"),
			]
		)["results"]
		self.assertTrue(all(r["status"] == "rejected" for r in results), results)
		with self.assertRaises(frappe.ValidationError):
			orders.submit_orders([order()] * 51)

	def test_unknown_item_is_rejected_and_batch_continues(self):
		good = order()
		r = orders.submit_orders([order(items=[{"item_code": "NOPE-404", "qty": 1}]), good])["results"]
		self.assertEqual(r[0]["status"], "rejected")
		self.assertEqual(r[1]["status"], "ok")

	def test_no_order_visit(self):
		o = {
			"client_uuid": str(uuid.uuid4()),
			"outcome": "no_order",
			"customer": CUST_A,
			"no_order_reason": "Shop Closed",
			"created_at": frappe.utils.now_datetime().isoformat(),
		}
		r = orders.submit_orders([o])["results"][0]
		self.assertEqual(r["status"], "ok", r)
		self.assertEqual(frappe.db.get_value("SSM Visit", r["name"], "outcome"), "No Order")

	def test_delivery_date_in_past_is_corrected(self):
		frappe.set_user(REP)
		r = orders.submit_orders([order(delivery_date=add_days(nowdate(), -5))])["results"][0]
		self.assertGreaterEqual(str(frappe.db.get_value("Sales Order", r["name"], "delivery_date")), nowdate())

	def test_history_only_shows_own_orders(self):
		orders.submit_orders([order()])
		frappe.set_user(REP2)
		self.assertTrue(all(row.customer != CUST_A for row in orders.order_history()))

	# ---------- PWA serving ----------

	def test_renderer_headers_and_guards(self):
		from secondary_sales.pwa import SSMRenderer, asset_manifest

		frappe.set_user("Administrator")
		resp = SSMRenderer("ssm").render()
		self.assertIn("script-src 'self'", resp.headers["Content-Security-Policy"])
		self.assertEqual(resp.headers["X-Frame-Options"], "DENY")
		sw = SSMRenderer("ssm-sw.js").render()
		self.assertEqual(sw.headers["Service-Worker-Allowed"], "/ssm")
		build, _ = asset_manifest()
		self.assertEqual(SSMRenderer(f"ssm-assets/{build}/js/app.js").render().status_code, 200)
		for bad in ("../../hooks.py", "../../../sites/common_site_config.json", "js/../../pwa.py", "sw.js"):
			self.assertEqual(SSMRenderer(f"ssm-assets/{build}/{bad}").render().status_code, 404, bad)

		frappe.set_user("Guest")
		with self.assertRaises(frappe.Redirect):
			SSMRenderer("ssm").render()
