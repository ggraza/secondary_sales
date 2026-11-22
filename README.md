# Secondary Sales

An offline-first Progressive Web App for field order taking (secondary sales / pre-selling) on **Frappe + ERPNext v15/v16**.

Reps open `https://<your-site>/ssm` on any phone, tablet or laptop, install it to the home screen, and take orders with or without a connection. Orders are kept encrypted on the device and sync to ERPNext as Sales Orders when the connection returns. Managers control, per role or per user, which screens, fields and cart views each rep gets.

## What the rep sees

| Screen | What it does |
| --- | --- |
| **Customers** | Today's route (from the rep's route plan) or all permitted customers. Search by name, code, phone or area; "Nearby" filter by GPS; visited / remaining counters; outstanding balance and credit status on every card; set customer location (if allowed). |
| **New order** | One screen: customer header with outstanding (tap for ageing and open invoices), **No order** with reason, item search and group chips, and **five cart display options** (List, Grid, Table, Compact, Catalogue). Quantities are entered as cartons + loose pieces. On tablets/desktop the cart is a permanent side panel; on phones it is a bottom bar and review sheet. Creating an order takes two taps after picking the customer. |
| **Orders** | Outbox (waiting, will retry, needs attention with Retry / Edit / Discard) and orders already accepted by the server, plus server history. |
| **Outstanding** | Total receivable for all the rep's customers with ageing buckets (Not due, 1-30, 31-60 ... days), kept for offline viewing. |
| **More** | Refresh data, send now, default view, install app, sign out and erase device data. |

Everything is responsive from 360 px phones to desktop, supports dark mode, and has no inline scripts or styles.

## What the manager controls (Desk)

* **SSM Settings**: company, default price list and warehouse, carton UOM, delivery days, offline limits (lock after N hours offline, reject orders older than N days), local encryption, ageing ranges, nearby radius, GPS requirement, app title and colour, **Revoke Offline Data**.
* **SSM Access Profile** (per Role or per User; a user profile beats role profiles, otherwise the highest priority wins):
  * screens on/off: Customers, Take Orders, Order History, Outstanding
  * cart display options on/off and the default one
  * customer scope: *Route Plan Only* or *All Permitted Customers* (always filtered by Frappe User Permissions)
  * on sync: *Save as Draft* or *Submit*
  * max discount %, allow offline, allow updating customer location, see other reps' orders
  * **Field Controls**: per field `visible` / `editable` for customer mobile, address, territory, group, outstanding, credit limit; item price, stock, image, brand, group; order rate, discount, delivery date, remarks. Hidden fields are removed by the server, not just hidden in the app. Non-editable values sent by a modified client are ignored.
* **SSM Route Plan**: which customers a rep visits on which day.
* **SSM No Order Reason**: reasons offered when a shop does not order.
* **SSM Visit** (read only): every visit with outcome, reason, Sales Order, GPS and device time.
* **SSM Sync Log** (System Manager): one row per device order, for audit and troubleshooting.

Two profiles are created on install: *Field Sales Rep* (role Sales User, route only, drafts) and *Sales Supervisor* (role Sales Manager, all customers, submit, 10% discount editable).

## Install

```bash
cd ~/frappe-bench
bench get-app https://github.com/ggraza/secondary_sales
bench --site your.site install-app secondary_sales
bench --site your.site migrate
bench restart
```

No Node build step is needed: the app is plain ES modules served by the app itself.

Then in Desk:

1. Open **SSM Settings**, set Company and Default Selling Price List (warehouse and carton UOM recommended), save.
2. Give reps the **Sales User** role (or create your own profile in **SSM Access Profile**).
3. Create an **SSM Route Plan** per rep with their customers.
4. Reps open `https://your.site/ssm`, sign in, and choose "Install app" (Android/desktop Chrome) or "Add to Home Screen" (iOS Safari).

The site must be served over **HTTPS** (service workers and the Web Crypto API require it; `localhost` works for development).

## How offline works

1. On sign-in the app downloads the rep's customers, items, prices, stock, reasons and today's visits, and a per-user device key.
2. Data is stored in IndexedDB, encrypted with AES-256-GCM. The service worker caches only the app files, never API data.
3. Orders are written to an encrypted outbox first, then sent in batches. Each order carries a device UUID; the server is idempotent on it, so a retry after a lost response never creates a duplicate Sales Order.
4. The server re-validates everything: customer access, item availability, prices (from the price list and pricing rules, not from the device), discount limits and dates. Rejected orders show the reason and can be edited or discarded; temporary failures retry with back-off.
5. If the server's net amount differs from the device estimate (new prices or promotions), the rep sees it on the order.

## Tests

```bash
python -m unittest discover -s secondary_sales/tests/unit -t .   # validation, access rules, ageing, path guard
npm install && npm test                                           # cart, encryption, storage, sync, API client
node tests_e2e/run.mjs                                            # real browser: offline, sync, XSS, CSP, responsive
bench --site test_site run-tests --app secondary_sales           # ERPNext integration and permission tests
```

`node tests_e2e/server.mjs` starts a mock server at `http://localhost:8765/ssm` for UI work without a Frappe site.

See [docs/SECURITY.md](docs/SECURITY.md) for the security model.

## License

MIT
