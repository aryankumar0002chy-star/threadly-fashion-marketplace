# THREADLY — Everyday. Better Dressed.

A **demo** fashion storefront and its API, served by **one Node.js process** (no npm dependencies, built-in SQLite).
`/` is the storefront, `/api/*` is the API, `/healthz` is the health check.

> **Read this first — what this is and is not**
> - Everything customer-facing is a **demo**: fictional catalog, **simulated** payment, shipping and fulfilment. No real money moves, no courier is booked, no supplier order is sent.
> - **Weave365 is NOT connected.** The code base this was built from contains no Weave365 adapter and no wholesale-API client (see [Supplier status](#supplier-status-weave365)). The storefront never claims otherwise.
> - Build base: the uploaded ZIP was `THREADLY-CHECKPOINT-00-BASELINE`, **not** `CHECKPOINT-02-WHOLESALE-API-INTEGRATION`. Its `frontend/` was not empty (a single-file, never-browser-tested SPA) and it has no `migrations/` folder. See `docs/CONTINUATION-STATUS.md`.

## Render deployment (exact settings)

| Setting | Value |
|---|---|
| Service type | Web Service, runtime **Node** |
| Build command | `npm run build` |
| Start command | `npm start` |
| Health check path | `/healthz` |
| Node version | `22.22.2` (env `NODE_VERSION`; anything `>= 22.13.0` works) |
| Port / host | Render injects `PORT`; the server binds `0.0.0.0:$PORT` automatically |
| Instance type | **Starter or higher** (a persistent disk is required for data to survive; see below) |
| Persistent disk | mount path `/var/data`, 1 GB |

`npm run build` runs `scripts/verify-build.mjs`: it checks the Node version, that the frontend files exist, syntax-checks every JS file and proves the database schema and demo seed run. There is nothing to compile; it exists so a broken deploy fails *before* going live.

### Option A — Blueprint (recommended)
1. Push this folder's contents to the **root** of a GitHub/GitLab repo (so `render.yaml` and `package.json` sit at the top).
2. Render Dashboard → **New → Blueprint** → select the repo.
3. When prompted, enter `ADMIN_EMAIL` and `ADMIN_PASSWORD` (use a long random password). Everything else is pre-filled by `render.yaml`.
4. Apply. After the first deploy, open `https://<your-service>.onrender.com/`, then `/#/admin` to log in.

### Option B — manual
New → Web Service → connect repo → set the build/start commands from the table → Instance: Starter → **Advanced → Add Disk** (name `threadly-data`, mount path `/var/data`, 1 GB) → add the environment variables below → set Health Check Path `/healthz` → Create.

### Environment variables
| Variable | Value on Render | Notes |
|---|---|---|
| `NODE_VERSION` | `22.22.2` | Must be ≥ 22.13.0 (built-in `node:sqlite` without a flag). |
| `NODE_ENV` | `production` | Adds the `Secure` flag to the session cookie (Render serves HTTPS). |
| `APP_MODE` | `demo` | `demo` = simulated payment/shipping, so the demo checkout works. `production` **disables** them and checkout returns HTTP 501 until real adapters exist. |
| `SUPPLIER_MODE` | `mock` | Simulated fulfilment. There is no live supplier adapter. |
| `DB_FILE` | `/var/data/threadly.db` | **Must be on the mounted disk.** If empty, the DB is in memory and is lost on every restart. |
| `ADMIN_EMAIL` | *(you choose)* | Creates the admin user. Without it there is no admin. |
| `ADMIN_PASSWORD` | *(you choose)* | Re-applied on every boot, so changing it and redeploying is how you rotate/recover the admin password (staff accounts can't use forgot-password). |
| `PAYMENT_WEBHOOK_SECRET` | *(auto-generated)* | HMAC secret for `POST /api/payments/webhook`. Unused by the demo flow. |
| `ADMIN_TOKEN` | *(leave unset)* | Optional static `x-admin-token` header; leaving it unset disables that access path. |
| `PORT` | *(set by Render)* | Don't set it yourself. |

### Persistent database (important)
- The app uses **SQLite in a single file** (`DB_FILE`). Render's container filesystem is **ephemeral**: it is wiped on every deploy and restart.
- To keep customers, orders, reviews and admin settings you need **(1) a paid instance, (2) an attached persistent disk, (3) `DB_FILE` pointing inside the disk's mount path.** This repo's `render.yaml` does all three.
- Startup is idempotent: restarting on an existing file keeps your data, does not re-seed the catalog and does not reset settings (covered by tests; the original code crashed on the second start).
- Limits of this setup: SQLite on a disk means **one instance only** (no horizontal scaling) and a brief downtime on each deploy. Back up `/var/data/threadly.db` (Render disk snapshots, or copy it out) before relying on it. A PostgreSQL port is **not** implemented; `database/schema.sql` is an old, incomplete target schema that does not match the running app.
- The catalog is a generated demo seed (108 fictional products). There is no product import yet.

### Free-tier demo (no persistence)
If you only want a throw-away demo, delete the `disk:` block, set `plan: free`, and leave `DB_FILE` out. Everything works, but **all data (orders, accounts, admin settings) is lost whenever the service restarts or redeploys, and free services also sleep after inactivity.** The startup log prints a warning in this mode.

## Run locally
Requires Node ≥ 22.13.0.
```bash
export ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=choose-a-long-password
export DB_FILE=./data/threadly.db   # optional; omit for in-memory
mkdir -p data
npm start                           # http://localhost:3000  (admin: http://localhost:3000/#/admin)
npm run build                       # same check Render runs
npm test                            # backend test suite (38 tests)
```
Windows PowerShell: `$env:ADMIN_EMAIL="..."; $env:ADMIN_PASSWORD="..."; npm start`.

Optional real-browser test (Playwright is *not* a dependency): `npm i --no-save playwright && npx playwright install chromium`, start the server on `PORT=3111`, then `BASE_URL=http://127.0.0.1:3111 npm run e2e`.

## What the storefront does (all through the existing API)
Home with category tiles · product listing with search, category/gender/colour/size/price/rating filters, sorting and pagination · product page (colour, size, stock, quantity, size chart, pincode estimate, reviews, wishlist) · cart (quantity, coupon `WELCOME10`, server-side quote with platform fee, delivery and COD fee) · **demo checkout** (online = simulated, or Cash on Delivery) · order page with tracking · register/login/forgot-password · account (orders, wishlist, addresses) · admin dashboard (orders and state-machine actions, reviews moderation, customers, payments, shipments, refunds, returns, fee settings). Product images are CSS placeholders, not photography.

## Supplier status (Weave365)
- **Not connected. Not tested. Not claimed.** `backend/src/suppliers.js` contains only `MockSupplierAdapter` (simulated) and `UnconfiguredSupplierAdapter`. There is no Weave365 client, no credentials handling, no product sync and no order push in this code base.
- The UI labels fulfilment as simulated, and the startup log prints `supplier=mock (no live supplier connected)`.
- Before any "live" claim, all of this must exist and be verified: genuine Weave365 credentials and API documentation, an adapter implementing `createOrder` (and catalog/stock sync), a sandbox end-to-end test, and a deliberate `SUPPLIER_MODE` value for it. Until then keep `SUPPLIER_MODE=mock`.

## Security notes — read before putting this on the public internet
Fixed in this build (with regression tests): **admin takeover** — in demo mode `POST /api/auth/forgot` returned a working reset token to anyone, including for the admin's email. Staff accounts can no longer be reset that way.

Still open (not changed, because this task preserved existing order logic):
1. **Order privacy:** `GET /api/orders/:orderNo` and `POST /api/orders/:orderNo/cancel` need no login. Anyone who knows/guesses an order number (`ORD-<year>-<6 hex>`) can read the delivery name, phone and address and cancel the order. **Tell visitors to use fictional details** (the checkout says so). Fix before handling any real customer data.
2. **Demo mode is open by design:** anyone can place demo orders, mark demo payments paid, and (for customers) use the demo reset link. Don't use `APP_MODE=demo` with real customers.
3. **Login rate limit is shared behind Render's proxy:** the limiter keys on the socket address, which is the proxy for every visitor, so ~20 auth requests/minute are shared across *all* users (fails closed, but heavy use can lock everyone out briefly).
4. No CSP header, no audit log, no email/SMS sending (no provider exists), no HTTPS redirect logic in-app (Render terminates TLS).
5. The browser console shows one expected `401 /api/me` per page load for signed-out visitors.

## Verification performed for this build
| Check | Result |
|---|---|
| `npm test` (backend) | **38 / 38 pass** (30 original + 8 new: persistence across restart, storefront at `/`, assets, SPA fallback, path-traversal, `/healthz`, binds `PORT` on `0.0.0.0` and restarts on same `DB_FILE`, admin-takeover regression, admin password re-apply) |
| `npm run build` | passes on Node 22.22.2 |
| Browser E2E (headless Chromium, 390 px phone and 1280 px desktop) | **27 / 27** checks: browse, search, category filter, product, cart, demo checkout, order tracking, COD fee, wishlist redirect, register, 404 states, admin login/dashboard/orders, no horizontal overflow, no JS errors |
| Not verified | An actual deployment on Render (not possible here); Safari/Firefox/real devices; Google Fonts (blocked in the test sandbox, so the system-font fallback was what ran); behaviour under load; anything involving real payment, courier or supplier |

## Layout
```
render.yaml            Render Blueprint
package.json           root scripts: build / start / test / e2e
backend/src/           server.js (entry), app.js (HTTP + static), db.js, pricing.js, suppliers.js, extra.js, more.js
backend/test/          node:test suites
frontend/              index.html + assets/styles.css + assets/app.js (hash-routed SPA)
scripts/               verify-build.mjs, e2e-browser.mjs
docs/                  CONTINUATION-STATUS.md, NEXT-PROMPT.txt
```
