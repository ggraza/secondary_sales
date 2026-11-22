# Security model

## Authentication
* The app uses the normal Frappe session (login page, 2FA and password policy all apply). No passwords or API secrets are stored on the device.
* Write calls send the Frappe CSRF token; an expired token is refreshed once through an authenticated GET.
* Every API method rejects Guest. A user also needs an enabled **SSM Access Profile**; without one every endpoint returns PermissionError.

## Authorisation (server side, every request)
* Screens: each endpoint names its screen; disabled screens are refused.
* Customers: `frappe.get_list` / `frappe.has_permission` on Customer (so User Permissions apply), plus route-plan membership for "Route Plan Only" profiles. Orders, outstanding and location updates for other customers are refused.
* Sales Orders are inserted and submitted with standard permission checks (no `ignore_permissions`). Visits and sync logs are written by the server only.
* Field controls: hidden fields are stripped from responses; values for non-editable fields are ignored; rates and discounts are checked against the profile's maximum discount.
* Order history is limited to the user's own orders unless the profile allows all.
* Replaying another user's order UUID returns a generic rejection and reveals nothing.

## Input validation
* Every order is strictly validated before touching the database: v4 UUID, name patterns (no markup/control characters, max 140), numeric bounds (no NaN/Infinity, qty 0 < q <= 1,000,000, discount 0-100), at most 200 lines per order and 50 orders per request, remarks <= 1000 characters, timestamps not in the future and not older than the configured limit, GPS bounds.
* Each order is processed in its own savepoint and committed independently; server errors are logged for admins and never returned to the device.
* Per-user rate limits on data and order endpoints.

## Data on the device
* IndexedDB records are encrypted with AES-256-GCM (random IV per record). The key is derived on the server with HMAC-SHA256 from the site encryption key, the user, a global key version and the user's last password reset, and imported as a **non-extractable** CryptoKey.
* **Revoke Offline Data** (SSM Settings) or resetting a user's password changes the key; the device wipes its local data at the next connection.
* When a different user signs in on the same device, the previous user's data is deleted. "Sign out" erases all local data and caches.
* After the configured hours without a server connection the app locks until the user connects again.
* The service worker never caches `/api/` responses or `/private/files`.
* Honest limit: the key lives in the browser next to the data, so encryption protects against casual inspection, other apps and copied storage files, but not against someone who has the unlocked device and the signed-in browser. Use device screen locks and keep the offline-hours limit short for sensitive data.

## Browser hardening
* `/ssm` and app files are served with `Content-Security-Policy` (`script-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, a restrictive `Permissions-Policy` and COOP.
* The UI builds DOM with text nodes only (no `innerHTML`), so customer or item names cannot inject markup; links are restricted to safe schemes.
* App files are served from an allow-list of extensions with a path traversal and symlink guard, content-hashed so updates are atomic.

## Tests that cover this
`secondary_sales/tests/unit` (validation, access resolution, path guard), `tests_js` (encryption, no plaintext at rest, key mismatch, sync idempotency), `tests_e2e/run.mjs` (XSS, CSP violations, offline), and `secondary_sales/tests/test_integration.py` (Guest, missing profile, route scoping, hidden fields, idempotency, cross-user replay, discount limits, malformed payloads, renderer headers and traversal).
