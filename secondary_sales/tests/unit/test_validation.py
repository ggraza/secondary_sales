import unittest
import uuid
from datetime import datetime, timedelta

from secondary_sales.core.validation import (
	MAX_LINES,
	MAX_ORDERS_PER_BATCH,
	PayloadError,
	check_rate,
	validate_batch,
	validate_order,
)

NOW = datetime(2026, 11, 22, 12, 0, 0)


def order(**kw):
	base = {
		"client_uuid": str(uuid.uuid4()),
		"outcome": "order",
		"customer": "CUST-0001",
		"items": [{"item_code": "COLA-1L", "qty": 12}],
		"created_at": "2026-11-22T10:00:00Z",
	}
	base.update(kw)
	return base


class TestValidateOrder(unittest.TestCase):
	def errors(self, payload, **kw):
		with self.assertRaises(PayloadError) as ctx:
			validate_order(payload, now=NOW, **kw)
		return ctx.exception.errors

	def test_valid_order(self):
		o = validate_order(order(remarks="  deliver before noon  "), now=NOW)
		self.assertEqual(o["customer"], "CUST-0001")
		self.assertEqual(o["items"][0]["qty"], 12.0)
		self.assertEqual(o["remarks"], "deliver before noon")

	def test_uuid_must_be_v4(self):
		self.assertIn("client_uuid must be a v4 UUID", self.errors(order(client_uuid="1")))
		self.assertIn("client_uuid must be a v4 UUID", self.errors(order(client_uuid="' OR 1=1 --")))
		self.assertIn("client_uuid must be a v4 UUID", self.errors(order(client_uuid=str(uuid.uuid1()))))

	def test_uuid_is_normalised(self):
		u = str(uuid.uuid4()).upper()
		self.assertEqual(validate_order(order(client_uuid=u), now=NOW)["client_uuid"], u.lower())

	def test_quantities(self):
		for bad in (0, -1, "abc", None, float("nan"), float("inf"), True, 10**9):
			errs = self.errors(order(items=[{"item_code": "A", "qty": bad}]))
			self.assertTrue(any("qty" in e for e in errs), (bad, errs))

	def test_names_reject_markup_and_control_chars(self):
		self.assertIn("customer is invalid", self.errors(order(customer="<script>alert(1)</script>")))
		self.assertIn("customer is invalid", self.errors(order(customer="A\x00B")))
		self.assertIn("customer is invalid", self.errors(order(customer="x" * 141)))
		self.assertIn("customer is invalid", self.errors(order(customer={"$ne": 1})))

	def test_line_limits(self):
		self.assertIn("items must be a non-empty list", self.errors(order(items=[])))
		self.assertIn(
			f"at most {MAX_LINES} lines per order",
			self.errors(order(items=[{"item_code": "A", "qty": 1}] * (MAX_LINES + 1))),
		)

	def test_discount_and_rate_bounds(self):
		errs = self.errors(order(items=[{"item_code": "A", "qty": 1, "discount_percentage": 120, "rate": -5}]))
		self.assertTrue(any("discount_percentage" in e for e in errs))
		self.assertTrue(any("rate" in e for e in errs))

	def test_remarks_length_and_control_chars(self):
		self.assertTrue(any("remarks" in e for e in self.errors(order(remarks="x" * 1001))))
		self.assertEqual(validate_order(order(remarks="ok\x07"), now=NOW)["remarks"], "ok")

	def test_age_and_future_timestamps(self):
		old = (NOW - timedelta(days=8)).isoformat()
		self.assertTrue(any("expired" in e for e in self.errors(order(created_at=old), max_age_days=7)))
		future = (NOW + timedelta(hours=2)).isoformat()
		self.assertIn("created_at is in the future", self.errors(order(created_at=future)))
		validate_order(order(created_at=old), now=NOW, max_age_days=0)  # 0 disables the age check

	def test_geo(self):
		self.assertTrue(any("geo.lat" in e for e in self.errors(order(geo={"lat": 91, "lng": 0}))))
		o = validate_order(order(geo={"lat": 31.5, "lng": 74.3, "accuracy": 12}), now=NOW)
		self.assertEqual(o["geo"]["lat"], 31.5)

	def test_no_order_visit(self):
		o = validate_order(order(outcome="no_order", items=None, no_order_reason="Shop Closed"), now=NOW)
		self.assertEqual(o["items"], [])
		self.assertIn("no_order_reason is required", self.errors(order(outcome="no_order", items=None)))
		self.assertIn("a no-order visit cannot have items", self.errors(order(outcome="no_order", no_order_reason="x")))

	def test_unknown_outcome(self):
		self.assertIn("outcome is invalid", self.errors(order(outcome="delete")))

	def test_not_a_dict(self):
		self.assertEqual(self.errors("[]"), ["order must be an object"])


class TestBatch(unittest.TestCase):
	def test_batch_limits(self):
		with self.assertRaises(PayloadError):
			validate_batch({})
		with self.assertRaises(PayloadError):
			validate_batch([])
		with self.assertRaises(PayloadError):
			validate_batch([{}] * (MAX_ORDERS_PER_BATCH + 1))
		self.assertEqual(len(validate_batch([{}])), 1)


class TestCheckRate(unittest.TestCase):
	def test_rate_within_discount(self):
		self.assertEqual(check_rate(100, 95, None, 5), [])
		self.assertEqual(check_rate(100, 120, None, 0), [])  # selling above list is fine

	def test_rate_below_floor(self):
		self.assertTrue(check_rate(100, 94.99, None, 5))

	def test_discount_over_max(self):
		self.assertTrue(check_rate(100, None, 10, 5))
		self.assertEqual(check_rate(100, None, 5, 5), [])


if __name__ == "__main__":
	unittest.main()
