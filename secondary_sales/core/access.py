"""Access profile resolution and field-level filtering.

Every rule here is enforced on the server. The PWA only mirrors the result to
hide controls, so a user who edits the client cannot see or change data the
profile does not allow.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

SCREENS = ("route", "order", "orders", "outstanding")
CART_VIEWS = ("list", "grid", "table", "compact", "catalogue")
CUSTOMER_SCOPES = ("Route Plan Only", "All Permitted Customers")
ORDER_ACTIONS = ("Save as Draft", "Submit")

# Fields that can be controlled per profile, as "<entity>.<field>".
# visible=0 removes the value from every API response.
# editable=0 makes the server ignore a value sent by the client.
FIELD_CATALOG: dict[str, str] = {
	"customer.mobile_no": "Customer mobile number",
	"customer.address": "Customer address",
	"customer.territory": "Customer territory",
	"customer.customer_group": "Customer group",
	"customer.outstanding": "Customer outstanding balance",
	"customer.credit_limit": "Customer credit limit",
	"item.price": "Item price",
	"item.stock": "Item stock",
	"item.image": "Item image",
	"item.brand": "Item brand",
	"item.item_group": "Item group",
	"order.rate": "Order line rate",
	"order.discount": "Order line discount",
	"order.delivery_date": "Order delivery date",
	"order.remarks": "Order remarks",
}

# Defaults: everything visible; only remarks/delivery date editable.
DEFAULT_EDITABLE = {"order.delivery_date", "order.remarks"}


def _truthy(value: Any) -> bool:
	return bool(value) and value not in ("0", 0)


def matches(profile: dict, user: str, roles: Iterable[str]) -> bool:
	if not _truthy(profile.get("enabled", 1)):
		return False
	applies_to = profile.get("applies_to")
	if applies_to == "User":
		return bool(profile.get("user")) and profile.get("user") == user
	if applies_to == "Role":
		return bool(profile.get("role")) and profile.get("role") in set(roles)
	return False


def resolve_profile(profiles: list[dict], user: str, roles: Iterable[str]) -> dict | None:
	"""Pick the single profile that governs ``user``.

	A profile assigned to the user wins over any role profile. Among role
	profiles the highest ``priority`` wins, ties broken by name for
	determinism. Profiles are not merged: one profile, one predictable result.
	Returns ``None`` when nothing matches, which means no access.
	"""
	roles = list(roles or [])
	if not user or user == "Guest":
		return None

	candidates = [p for p in profiles if matches(p, user, roles)]
	if not candidates:
		return None

	def sort_key(p: dict):
		return (
			0 if p.get("applies_to") == "User" else 1,
			-int(p.get("priority") or 0),
			str(p.get("name") or ""),
		)

	chosen = sorted(candidates, key=sort_key)[0]
	return normalize_profile(chosen)


def normalize_profile(p: dict) -> dict:
	screens = {s: _truthy(p.get(f"screen_{s}", 1 if s in ("route", "order", "orders") else 0)) for s in SCREENS}
	views = [v for v in CART_VIEWS if _truthy(p.get(f"view_{v}", 1))]
	if not views:
		views = ["list"]
	default_view = p.get("default_view") or views[0]
	if default_view not in views:
		default_view = views[0]

	fields: dict[str, dict[str, bool]] = {
		key: {"visible": True, "editable": key in DEFAULT_EDITABLE} for key in FIELD_CATALOG
	}
	for rule in p.get("field_rules") or []:
		key = rule.get("field")
		if key in fields:
			fields[key] = {
				"visible": _truthy(rule.get("visible", 1)),
				"editable": _truthy(rule.get("editable", 0)) and _truthy(rule.get("visible", 1)),
			}

	# Outstanding screen needs the outstanding field.
	if not fields["customer.outstanding"]["visible"]:
		screens["outstanding"] = False

	try:
		max_discount = float(p.get("max_discount_percent") or 0)
	except (TypeError, ValueError):
		max_discount = 0.0
	max_discount = min(max(max_discount, 0.0), 100.0)

	customer_scope = p.get("customer_scope")
	if customer_scope not in CUSTOMER_SCOPES:
		customer_scope = "Route Plan Only"
	order_action = p.get("order_action")
	if order_action not in ORDER_ACTIONS:
		order_action = "Save as Draft"

	return {
		"name": p.get("name"),
		"screens": screens,
		"cart_views": views,
		"default_view": default_view,
		"fields": fields,
		"customer_scope": customer_scope,
		"order_action": order_action,
		"max_discount_percent": max_discount,
		"allow_update_location": _truthy(p.get("allow_update_location", 0)),
		"view_all_orders": _truthy(p.get("view_all_orders", 0)),
		"allow_offline": _truthy(p.get("allow_offline", 1)),
	}


def is_visible(profile: dict, key: str) -> bool:
	return bool(profile["fields"].get(key, {}).get("visible", True))


def is_editable(profile: dict, key: str) -> bool:
	return bool(profile["fields"].get(key, {}).get("editable", False))


def strip_hidden(records: list[dict], entity: str, profile: dict, mapping: dict[str, list[str]]) -> list[dict]:
	"""Remove hidden values from records.

	``mapping`` maps a catalog field (e.g. ``price``) to the record keys that
	carry it (e.g. ``["rate", "prices"]``).
	"""
	hidden_keys: set[str] = set()
	for field, keys in mapping.items():
		if not is_visible(profile, f"{entity}.{field}"):
			hidden_keys.update(keys)
	if not hidden_keys:
		return records
	return [{k: v for k, v in r.items() if k not in hidden_keys} for r in records]
