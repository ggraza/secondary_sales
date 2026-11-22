import os
import tempfile
import unittest
from datetime import date

from secondary_sales.core.ageing import age_invoices, bucket_labels
from secondary_sales.core.assets import resolve_asset


class TestAgeing(unittest.TestCase):
	def test_labels(self):
		self.assertEqual(bucket_labels([30, 60, 90, 120]), ["Not Due", "1-30", "31-60", "61-90", "91-120", "121+"])

	def test_buckets(self):
		as_of = date(2026, 11, 22)
		invoices = [
			{"outstanding_amount": 100, "due_date": date(2026, 11, 30)},  # not due
			{"outstanding_amount": 50, "due_date": "2026-11-01"},  # 21 days
			{"outstanding_amount": 25, "due_date": "2026-09-01"},  # 82 days
			{"outstanding_amount": 10, "posting_date": "2025-01-01"},  # very old, no due date
		]
		r = age_invoices(invoices, as_of)
		b = {x["label"]: x["amount"] for x in r["buckets"]}
		self.assertEqual(r["total"], 185)
		self.assertEqual(b["Not Due"], 100)
		self.assertEqual(b["1-30"], 50)
		self.assertEqual(b["61-90"], 25)
		self.assertEqual(b["121+"], 10)
		self.assertGreater(r["oldest_days"], 600)


class TestAssetGuard(unittest.TestCase):
	def setUp(self):
		self.tmp = tempfile.TemporaryDirectory()
		self.base = os.path.join(self.tmp.name, "ssm")
		os.makedirs(os.path.join(self.base, "js"))
		for rel in ("js/app.js", "sw.js", "js/.hidden.js"):
			with open(os.path.join(self.base, rel), "w") as fh:
				fh.write("x")
		with open(os.path.join(self.tmp.name, "secret.js"), "w") as fh:
			fh.write("secret")
		os.symlink(os.path.join(self.tmp.name, "secret.js"), os.path.join(self.base, "js", "link.js"))
		self.ext = {".js": "text/javascript"}

	def tearDown(self):
		self.tmp.cleanup()

	def test_allows_normal_file(self):
		self.assertTrue(resolve_asset(self.base, "js/app.js", self.ext))

	def test_blocks_traversal_and_tricks(self):
		for rel in (
			"../secret.js",
			"js/../../secret.js",
			"/etc/passwd",
			"js\\app.js",
			"js/app.js\x00.png",
			"%2e%2e/secret.js",
			"js//app.js",
			"./js/app.js",
			"js/.hidden.js",
			"sw.js",
			"js/app.py",
			"js/link.js",
			"",
			None,
		):
			self.assertIsNone(resolve_asset(self.base, rel, self.ext), rel)


if __name__ == "__main__":
	unittest.main()
