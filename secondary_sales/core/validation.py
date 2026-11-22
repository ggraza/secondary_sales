"""Strict validation of order payloads coming from the PWA.

The client is never trusted: every field is type checked, bounded and
normalised before any database work happens.
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime, timedelta
from typing import Any

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
NAME_RE = re.compile(r"^[^<>\x00-\x1f]{1,140}$")
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

MAX_ORDERS_PER_BATCH = 50
MAX_LINES = 200
MAX_QTY = 1_000_000
MAX_REMARKS = 1000
OUTCOMES = ("order", "no_order")


class PayloadError(ValueError):
	def __init__(self, errors: list[str]):
		super().__init__("; ".join(errors))
		self.errors = errors


def _num(value: Any, field: str, errors: list[str], lo: float, hi: float, allow_none=False) -> float | None:
	if value is None or value == "":
		if allow_none:
			return None
		errors.append(f"{field} is required")
		return None
	if isinstance(value, bool):
		errors.append(f"{field} must be a number")
		return None
	try:
		num = float(value)
	except (TypeError, ValueError):
		errors.append(f"{field} must be a number")
		return None
	if math.isnan(num) or math.isinf(num) or num < lo or num > hi:
		errors.append(f"{field} must be between {lo:g} and {hi:g}")
		return None
	return num


def _name(value: Any, field: str, errors: list[str], required=True) -> str | None:
	if value in (None, ""):
		if required:
			errors.append(f"{field} is required")
		return None
	if not isinstance(value, str) or not NAME_RE.match(value.strip()):
		errors.append(f"{field} is invalid")
		return None
	return value.strip()


def _text(value: Any, field: str, errors: list[str], max_len: int) -> str:
	if value in (None, ""):
		return ""
	if not isinstance(value, str):
		errors.append(f"{field} must be text")
		return ""
	value = CONTROL_CHARS.sub("", value).strip()
	if len(value) > max_len:
		errors.append(f"{field} is longer than {max_len} characters")
		return ""
	return value


def _date(value: Any, field: str, errors: list[str]) -> date | None:
	if value in (None, ""):
		return None
	if not isinstance(value, str):
		errors.append(f"{field} must be a date")
		return None
	try:
		return date.fromisoformat(value[:10])
	except ValueError:
		errors.append(f"{field} must be a date (YYYY-MM-DD)")
		return None


def _datetime(value: Any, field: str, errors: list[str]) -> datetime | None:
	if value in (None, ""):
		return None
	if not isinstance(value, str):
		errors.append(f"{field} must be a timestamp")
		return None
	try:
		parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
	except ValueError:
		errors.append(f"{field} must be an ISO timestamp")
		return None
	return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def validate_batch(orders: Any) -> list:
	if not isinstance(orders, list):
		raise PayloadError(["orders must be a list"])
	if not orders:
		raise PayloadError(["orders is empty"])
	if len(orders) > MAX_ORDERS_PER_BATCH:
		raise PayloadError([f"at most {MAX_ORDERS_PER_BATCH} orders per request"])
	return orders


def validate_order(payload: Any, now: datetime | None = None, max_age_days: int = 7) -> dict:
	"""Return a cleaned order dict or raise PayloadError with every problem found."""
	errors: list[str] = []
	if not isinstance(payload, dict):
		raise PayloadError(["order must be an object"])

	client_uuid = payload.get("client_uuid")
	if not isinstance(client_uuid, str) or not UUID_RE.match(client_uuid.lower()):
		errors.append("client_uuid must be a v4 UUID")
		client_uuid = None
	else:
		client_uuid = client_uuid.lower()

	outcome = payload.get("outcome") or "order"
	if outcome not in OUTCOMES:
		errors.append("outcome is invalid")

	customer = _name(payload.get("customer"), "customer", errors)
	remarks = _text(payload.get("remarks"), "remarks", errors, MAX_REMARKS)
	delivery_date = _date(payload.get("delivery_date"), "delivery_date", errors)
	created_at = _datetime(payload.get("created_at"), "created_at", errors)

	now = now or datetime.now()
	if created_at:
		if created_at > now + timedelta(minutes=10):
			errors.append("created_at is in the future")
		elif max_age_days and created_at < now - timedelta(days=max_age_days):
			errors.append(f"order is older than {max_age_days} days and has expired")

	geo = payload.get("geo") or None
	clean_geo = None
	if geo is not None:
		if not isinstance(geo, dict):
			errors.append("geo must be an object")
		else:
			lat = _num(geo.get("lat"), "geo.lat", errors, -90, 90)
			lng = _num(geo.get("lng"), "geo.lng", errors, -180, 180)
			acc = _num(geo.get("accuracy"), "geo.accuracy", errors, 0, 100000, allow_none=True)
			if lat is not None and lng is not None:
				clean_geo = {"lat": lat, "lng": lng, "accuracy": acc}

	items: list[dict] = []
	no_order_reason = None
	if outcome == "no_order":
		no_order_reason = _name(payload.get("no_order_reason"), "no_order_reason", errors)
		if payload.get("items"):
			errors.append("a no-order visit cannot have items")
	else:
		raw_items = payload.get("items")
		if not isinstance(raw_items, list) or not raw_items:
			errors.append("items must be a non-empty list")
			raw_items = []
		if len(raw_items) > MAX_LINES:
			errors.append(f"at most {MAX_LINES} lines per order")
			raw_items = []
		for idx, row in enumerate(raw_items, start=1):
			if not isinstance(row, dict):
				errors.append(f"line {idx} must be an object")
				continue
			item_code = _name(row.get("item_code"), f"line {idx} item_code", errors)
			qty = _num(row.get("qty"), f"line {idx} qty", errors, 0, MAX_QTY)
			if qty is not None and qty <= 0:
				errors.append(f"line {idx} qty must be greater than 0")
			rate = _num(row.get("rate"), f"line {idx} rate", errors, 0, 1e12, allow_none=True)
			discount = _num(
				row.get("discount_percentage"), f"line {idx} discount_percentage", errors, 0, 100, allow_none=True
			)
			est = _num(row.get("estimated_rate"), f"line {idx} estimated_rate", errors, 0, 1e12, allow_none=True)
			items.append(
				{
					"item_code": item_code,
					"qty": qty,
					"rate": rate,
					"discount_percentage": discount,
					"estimated_rate": est,
				}
			)

	est_total = _num(payload.get("estimated_total"), "estimated_total", errors, 0, 1e15, allow_none=True)

	if errors:
		raise PayloadError(errors)

	return {
		"client_uuid": client_uuid,
		"outcome": outcome,
		"customer": customer,
		"no_order_reason": no_order_reason,
		"items": items,
		"remarks": remarks,
		"delivery_date": delivery_date,
		"created_at": created_at,
		"geo": clean_geo,
		"estimated_total": est_total,
	}


def check_rate(price_list_rate: float, rate: float | None, discount: float | None, max_discount: float) -> list[str]:
	"""Make sure a rate or discount sent by the rep stays within the allowed discount."""
	errors = []
	if discount is not None and discount > max_discount + 1e-9:
		errors.append(f"discount {discount:g}% exceeds the allowed {max_discount:g}%")
	if rate is not None and price_list_rate:
		floor = price_list_rate * (1 - max_discount / 100.0)
		if rate + 1e-9 < floor:
			errors.append(f"rate {rate:g} is below the allowed minimum {floor:g}")
	return errors
