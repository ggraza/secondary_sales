app_name = "secondary_sales"
app_title = "Secondary Sales"
app_publisher = "Ghulam Ghous"
app_description = "Offline-first PWA for field order taking (secondary sales) on ERPNext"
app_email = "noreply@example.com"
app_license = "mit"
required_apps = ["erpnext"]

# The PWA shell (/ssm) and its service worker (/ssm-sw.js) are served by a
# custom page renderer so they can send strict security headers and a
# service-worker scope that covers /ssm.
page_renderer = ["secondary_sales.pwa.SSMRenderer"]

after_install = "secondary_sales.install.after_install"
after_migrate = "secondary_sales.install.after_migrate"
before_uninstall = "secondary_sales.install.before_uninstall"

doc_events = {
	"User": {"on_update": "secondary_sales.install.on_user_update"},
}

add_to_apps_screen = [
	{
		"name": "secondary_sales",
		"logo": "/assets/secondary_sales/ssm/icons/icon-192.png",
		"title": "Secondary Sales",
		"route": "/ssm",
	}
]

before_tests = "secondary_sales.tests.utils.before_tests"
