"""Server-side access checks shared by every API endpoint.

Rules:
* Guest is always refused.
* A user needs an enabled SSM Access Profile (by user or by role).
* Each endpoint names the screen it serves; disabled screens are refused.
* Customer access = Frappe permission on Customer (incl. User Permissions)
  AND, for "Route Plan Only" profiles, membership in the rep's route plans.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

import frappe
from frappe import _

from secondary_sales.core.access import resolve_profile

CACHE_PREFIX = "ssm_access:"
CACHE_TTL = 300


def clear_access_cache(user: str | None = None):
	if user:
		frappe.cache.delete_value(f"{CACHE_PREFIX}{user}")
		frappe.cache.delete_value(f"{CACHE_PREFIX}route:{user}")
	else:
		frappe.cache.delete_keys(CACHE_PREFIX)


def get_settings():
	return frappe.get_cached_doc("SSM Settings")


def get_profile(user: str | None = None) -> dict | None:
	user = user or frappe.session.user
	if not user or user == "Guest":
		return None

	key = f"{CACHE_PREFIX}{user}"
	cached = frappe.cache.get_value(key)
	if cached is not None:
		return cached or None

	profiles = frappe.get_all("SSM Access Profile", filters={"enabled": 1}, fields=["*"])
	if profiles:
		rules = frappe.get_all(
			"SSM Field Rule",
			filters={"parenttype": "SSM Access Profile", "parent": ["in", [p.name for p in profiles]]},
			fields=["parent", "field", "visible", "editable"],
		)
		by_parent: dict[str, list] = {}
		for r in rules:
			by_parent.setdefault(r.parent, []).append(r)
		for p in profiles:
			p["field_rules"] = by_parent.get(p.name, [])

	profile = resolve_profile(profiles, user, frappe.get_roles(user))
	frappe.cache.set_value(key, profile or {}, expires_in_sec=CACHE_TTL)
	return profile


def require(screen: str | None = None, any_of: tuple[str, ...] = ()) -> dict:
	user = frappe.session.user
	if not user or user == "Guest":
		frappe.throw(_("Please sign in to continue."), frappe.AuthenticationError)

	if not frappe.db.get_single_value("SSM Settings", "company"):
		frappe.throw(_("The Secondary Sales app is not configured yet. Ask your administrator to fill SSM Settings."))

	profile = get_profile(user)
	if not profile:
		frappe.throw(
			_("You do not have access to the Secondary Sales app. Ask your administrator for an SSM Access Profile."),
			frappe.PermissionError,
		)

	screens = (screen,) if screen else ()
	screens += tuple(any_of)
	if screens and not any(profile["screens"].get(s) for s in screens):
		frappe.throw(_("This screen is disabled for your profile."), frappe.PermissionError)
	return profile


def throttle(action: str, limit: int, seconds: int = 60):
	"""Per-user rate limit (per IP limits punish reps sharing one mobile network)."""
	key = frappe.cache.make_key(f"ssm_rl:{action}:{frappe.session.user}")
	if not frappe.cache.get(key):
		frappe.cache.setex(key, seconds, 0)
	if frappe.cache.incrby(key, 1) > limit:
		frappe.throw(_("Too many requests. Please wait a minute and try again."), frappe.RateLimitExceededError)


def route_customers(user: str) -> dict[str, dict]:
	"""Customers in the user's enabled route plans: {customer: {"days": [...], "sequence": n}}."""
	key = f"{CACHE_PREFIX}route:{user}"
	cached = frappe.cache.get_value(key)
	if cached is not None:
		return cached

	plans = frappe.get_all("SSM Route Plan", filters={"sales_user": user, "enabled": 1}, fields=["name", "day_of_week"])
	result: dict[str, dict] = {}
	if plans:
		day_by_plan = {p.name: p.day_of_week for p in plans}
		rows = frappe.get_all(
			"SSM Route Customer",
			filters={"parenttype": "SSM Route Plan", "parent": ["in", list(day_by_plan)]},
			fields=["parent", "customer", "sequence"],
			order_by="sequence asc",
		)
		for r in rows:
			entry = result.setdefault(r.customer, {"days": [], "sequence": r.sequence or 0})
			day = day_by_plan[r.parent]
			if day not in entry["days"]:
				entry["days"].append(day)
	frappe.cache.set_value(key, result, expires_in_sec=CACHE_TTL)
	return result


def allowed_customers(profile: dict, limit: int = 5000) -> list[str]:
	"""Customer names the current user may work with. Uses frappe.get_list so
	DocType permissions and User Permissions always apply."""
	user = frappe.session.user
	filters: dict = {"disabled": 0}
	if profile["customer_scope"] == "Route Plan Only":
		route = route_customers(user)
		if not route:
			return []
		filters["name"] = ["in", list(route)]
	return frappe.get_list(
		"Customer", filters=filters, pluck="name", limit_page_length=limit, order_by="customer_name asc"
	)


def is_customer_allowed(profile: dict, customer: str) -> bool:
	if not customer or not frappe.db.exists("Customer", {"name": customer, "disabled": 0}):
		return False
	if not frappe.has_permission("Customer", "read", doc=customer):
		return False
	if profile["customer_scope"] == "Route Plan Only":
		return customer in route_customers(frappe.session.user)
	return True


def device_data_key(user: str) -> tuple[str, str]:
	"""Per-user key the PWA uses to encrypt its local IndexedDB data.

	Derived (HMAC-SHA256) from the site's encryption key, the user, the global
	key version and the user's last password reset, so rotating the version or
	resetting a password makes old device data unreadable and forces a wipe.
	Returns (base64 key, short key id).
	"""
	from frappe.utils.password import get_encryption_key

	version = get_settings().data_key_version or 1
	reset = frappe.db.get_value("User", user, "last_password_reset_date") or ""
	msg = f"ssm-device-key:{user}:{version}:{reset}".encode()
	digest = hmac.new(get_encryption_key().encode(), msg, hashlib.sha256).digest()
	key_id = hashlib.sha256(b"id:" + digest).hexdigest()[:16]
	return base64.b64encode(digest).decode(), key_id
