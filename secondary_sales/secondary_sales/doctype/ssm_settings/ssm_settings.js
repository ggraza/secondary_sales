// Copyright (c) 2026, Ghulam Ghous and contributors
frappe.ui.form.on("SSM Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Open Sales App"), () => window.open("/ssm", "_blank"));
		if (frappe.user.has_role("System Manager")) {
			frm.add_custom_button(__("Revoke Offline Data"), () => {
				frappe.confirm(
					__("Every device will erase its locally stored customers, items and unsynced orders at its next connection. Continue?"),
					() => frm.call("revoke_offline_data").then(() => frm.reload_doc())
				);
			});
		}
	},
});
