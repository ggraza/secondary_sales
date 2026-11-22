import frappe
from frappe.utils import get_fullname, now_datetime

from secondary_sales import __version__
from secondary_sales.api._guard import device_data_key, get_settings, require


@frappe.whitelist(methods=["GET"])
def bootstrap():
	"""Everything the PWA needs to start: who the user is, what the profile allows,
	app settings, a fresh CSRF token and the device encryption key."""
	profile = require()
	settings = get_settings()
	user = frappe.session.user
	currency = frappe.get_cached_value("Company", settings.company, "default_currency")

	offline = bool(settings.enable_offline and profile["allow_offline"])
	key, key_id = device_data_key(user)

	return {
		"user": {
			"name": user,
			"full_name": get_fullname(user),
		},
		"profile": profile,
		"settings": {
			"app_title": settings.app_title or "Secondary Sales",
			"theme_color": settings.theme_color or "#0f6cbd",
			"company": settings.company,
			"currency": currency,
			"pack_uom": settings.pack_uom,
			"default_delivery_days": settings.default_delivery_days or 0,
			"enable_offline": offline,
			"encrypt_local_data": bool(settings.encrypt_local_data),
			"max_offline_hours": settings.max_offline_hours or 0,
			"max_order_age_days": settings.max_order_age_days or 0,
			"nearby_radius_m": settings.nearby_radius_m or 500,
			"require_location": bool(settings.require_location),
			"ageing_ranges": [
				settings.ageing_range_1,
				settings.ageing_range_2,
				settings.ageing_range_3,
				settings.ageing_range_4,
			],
		},
		"device": {"key": key, "key_id": key_id},
		"csrf_token": frappe.sessions.get_csrf_token(),
		"server_time": now_datetime().isoformat(),
		"app_version": __version__,
	}
