import frappe
from frappe.custom.doctype.custom_field.custom_field import create_custom_fields

CUSTOM_FIELDS = {
	"Sales Order": [
		{
			"fieldname": "ssm_section",
			"fieldtype": "Section Break",
			"label": "Sales App",
			"insert_after": "items",
			"collapsible": 1,
		},
		{
			"fieldname": "ssm_client_uuid",
			"fieldtype": "Data",
			"label": "Sales App Reference",
			"insert_after": "ssm_section",
			"read_only": 1,
			"no_copy": 1,
			"search_index": 1,
		},
		{
			"fieldname": "ssm_remarks",
			"fieldtype": "Small Text",
			"label": "Remarks From Sales Rep",
			"insert_after": "ssm_client_uuid",
			"no_copy": 1,
		},
	],
	"Customer": [
		{
			"fieldname": "ssm_latitude",
			"fieldtype": "Float",
			"label": "Latitude",
			"insert_after": "territory",
			"precision": "7",
		},
		{
			"fieldname": "ssm_longitude",
			"fieldtype": "Float",
			"label": "Longitude",
			"insert_after": "ssm_latitude",
			"precision": "7",
		},
	],
}

DEFAULT_REASONS = ["Shop Closed", "Stock Available", "Not Interested", "Owner Not Available", "Payment Issue"]


def after_install():
	create_custom_fields(CUSTOM_FIELDS, update=True)
	for reason in DEFAULT_REASONS:
		if not frappe.db.exists("SSM No Order Reason", reason):
			frappe.get_doc({"doctype": "SSM No Order Reason", "reason": reason, "enabled": 1}).insert(
				ignore_permissions=True
			)
	if not frappe.db.exists("SSM Access Profile", "Field Sales Rep"):
		frappe.get_doc(
			{
				"doctype": "SSM Access Profile",
				"profile_name": "Field Sales Rep",
				"applies_to": "Role",
				"role": "Sales User",
				"enabled": 1,
				"customer_scope": "Route Plan Only",
				"order_action": "Save as Draft",
				"default_view": "list",
			}
		).insert(ignore_permissions=True)
	if not frappe.db.exists("SSM Access Profile", "Sales Supervisor"):
		frappe.get_doc(
			{
				"doctype": "SSM Access Profile",
				"profile_name": "Sales Supervisor",
				"applies_to": "Role",
				"role": "Sales Manager",
				"priority": 10,
				"enabled": 1,
				"customer_scope": "All Permitted Customers",
				"order_action": "Submit",
				"max_discount_percent": 10,
				"allow_update_location": 1,
				"view_all_orders": 1,
				"default_view": "table",
				"field_rules": [
					{"field": "order.discount", "visible": 1, "editable": 1},
				],
			}
		).insert(ignore_permissions=True)
	frappe.db.commit()


def after_migrate():
	create_custom_fields(CUSTOM_FIELDS, update=True)


def before_uninstall():
	for doctype, fields in CUSTOM_FIELDS.items():
		for field in fields:
			name = frappe.db.get_value("Custom Field", {"dt": doctype, "fieldname": field["fieldname"]})
			if name:
				frappe.delete_doc("Custom Field", name, ignore_permissions=True)


def on_user_update(doc, method=None):
	"""Role or user changes must take effect immediately, not after the cache TTL."""
	from secondary_sales.api._guard import clear_access_cache

	clear_access_cache(doc.name)
