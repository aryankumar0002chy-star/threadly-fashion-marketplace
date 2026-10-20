# THREADLY — Continuation Status

## LATEST: CHECKPOINT-RENDER-DEPLOY-READY (2026-10-20)
Built on the uploaded **CHECKPOINT-00-BASELINE** ZIP (the user asked for CHECKPOINT-02-WHOLESALE-API-INTEGRATION, which was not what was uploaded: no Weave365 adapter, no migrations folder, non-empty frontend).
Changes: persistence bug fixed (idempotent `openDb`, seed only when empty); static multi-file serving + `/healthz`; `server.js` binds `0.0.0.0:$PORT`, graceful SIGTERM, admin seeding survives restarts; `engines` fixed to >=22.13.0;
frontend split into index.html + assets and redesigned, categories/demo-checkout/honesty copy added, admin-login re-render bug fixed, wishlist heart state fixed; **admin takeover via demo forgot-password fixed**; `render.yaml`, root `package.json`, `scripts/verify-build.mjs`, `scripts/e2e-browser.mjs`, new `.env.example`, README.
Baseline bugs now: #1 persistence FIXED · #3 engines FIXED · #5 misleading log FIXED · #7 unread env vars removed from template · **#2 order privacy STILL OPEN** · #4 schema.sql mismatch STILL OPEN · Weave365 / any real supplier adapter NOT BUILT.
Tests: backend 38/38, browser E2E 27/27 (Chromium 390px + 1280px). Not deployed anywhere by the assistant.

---
# (Historical) CHECKPOINT-00 report follows

## Identity
- **Project:** THREADLY — Everyday. Better Dressed. (fashion marketplace)
- **Version:** unversioned (`backend/package.json` declares no version). Treat this as `0.0.0-baseline`.
- **Checkpoint:** 00 — BASELINE
- **Date:** 2026-10-09
- **Environment used for verification:** Node v22.22.2, npm 10.9.7

## What this checkpoint is
A safe, verified copy of the project exactly as uploaded (`THREADLY-FASHION-MARKETPLACE__3_.zip`),
plus this report and `docs/NEXT-PROMPT.txt`. **No application code was modified.**
Nothing was fixed in this checkpoint; the audit findings below are recorded for CHECKPOINT-01/02.

## Features completed in this session
None. Audit and packaging only.

## Features already present before this session
Status column distinguishes what I actually verified from what is only claimed in the README.

| Area | Status |
|---|---|
| Pricing engine (integer paise, platform fee, delivery, COD fee, coupon cap/min) | **Verified** — 8 pricing tests pass |
| Auth (register/login/logout, scrypt hashing, sessions), roles | **Verified by tests** (flow/more tests pass) |
| Orders: COD + DEMO online, stock reservation in `BEGIN IMMEDIATE` txn, cancel | **Verified by tests** (but see Bug 2) |
| Returns/refunds state machine, demo payment webhook (HMAC), demo shipping | **Verified by tests** |
| Reviews (delivered-order only), addresses, wishlist, pincode estimate, password reset | **Verified by tests** |
| Admin API: settings, analytics, order actions, read-only tables, review moderation | **Verified by tests** |
| Storefront UI (`frontend/index.html`, 130 lines, hash-routed vanilla JS) | **Claimed, NOT verified** — never run in a browser (README says the same) |
| Admin UI (`#/admin` inside the same `index.html`) | **Claimed, NOT verified** |

Routes present in the frontend: `#/about #/account #/admin #/cart #/checkout #/contact #/forgot-password #/help #/login #/privacy #/products #/refund-policy #/register #/reset #/shipping-policy #/success #/terms`

## Files in this checkpoint
Created: `docs/CONTINUATION-STATUS.md`, `docs/NEXT-PROMPT.txt`
Modified: none

Original contents: `README.md`, `.env.example`, `.gitignore`, `database/schema.sql`, `frontend/index.html`,
`backend/package.json`, `backend/src/{app,db,extra,more,pricing,server,suppliers}.js`,
`backend/test/{app,flow,more,pricing}.test.js`.
Empty directories in the original upload: `admin/`, `scripts/` (kept as-is).
No lockfile exists because the backend has zero npm dependencies.

## Tests actually executed (real results)
- `cd backend && npm test` → **30 tests, 30 pass, 0 fail**, ~1.9 s (Node v22.22.2).
- Ad-hoc probe 1 (anonymous client vs. a placed COD order): `GET /api/orders/:no` → 200 **with full name/phone/address**; `POST /api/orders/:no/cancel` → 200 `CANCELLED`. → Bug 2.
- Ad-hoc probe 2 (open the same `DB_FILE` twice): second open throws `table settings already exists`. → Bug 1.
- Secrets scan over all source: no real credentials found (only test fixtures and README placeholders).
- The existing suite does **not** cover either bug above.

## Known bugs (verified unless noted)
1. **CRITICAL — persistence is broken.** `db.js` runs plain `CREATE TABLE` (no `IF NOT EXISTS`) and re-inserts default settings/coupon/seed
   on every start. Setting `DB_FILE` works for the first run only; any restart crashes. The README's "set DB_FILE to persist" is therefore not true today.
   Default mode is `:memory:`, so all data is lost on every restart.
2. **HIGH — order privacy/authorization.** `GET /api/orders/:orderNo` and `POST /api/orders/:orderNo/cancel` have no auth or ownership check.
   Any anonymous client who knows/guesses an order number can read the customer's address and phone and cancel the order.
   Order numbers are `ORD-<year>-<6 hex chars>` (~16.7M possibilities per year). Guest checkout exists, so the fix needs a design
   decision (e.g. require login/ownership for registered users; for guests require order number + phone/email or a signed tracking token).
3. **MEDIUM — wrong Node requirement.** `package.json` says `"node": ">=20"` but `node:sqlite` needs Node >= 22.5 (README says 22+).
4. **MEDIUM — `database/schema.sql` does not match the app.** It defines `suppliers`, `categories`, `product_variants`, `audit_logs`, `platform_settings`, etc.;
   the running app uses `variants`, `settings`, `coupons`, `user_sessions`, `password_resets`, `wishlist_items`, `addresses`, `reviews`, `refunds`, `returns` and others.
   It is not usable as a PostgreSQL target as it stands.
5. **LOW — misleading startup log.** `server.js` prints "COD only" even though DEMO online payment is enabled by default.
6. **Unverified:** the frontend has never been exercised in a browser; layout/responsiveness unknown.
7. Env vars in `.env.example` that the code never reads: `DATABASE_URL, JWT_SECRET, PAYMENT_PROVIDER_KEY, PAYMENT_PROVIDER_SECRET, SHIPPING_API_KEY, EMAIL_API_KEY, SMS_API_KEY`.
8. Admin auth accepts a static `x-admin-token` header when `ADMIN_TOKEN` is set (acceptable for demo; review before production).

## Features still missing
Admin product / variant / inventory editors; supplier management; coupon administration (only hard-coded `WELCOME10`);
product import; support tickets; notifications (email/SMS); dashboard charts; product image management; SEO tags/sitemap;
PostgreSQL runtime; audit logging; real payment/shipping/supplier adapters; edit/delete-own-review UI (API exists);
separate admin panel (the `admin/` folder is empty); build tooling; broader security/integration tests.

## Required environment variables (those the code actually reads)
| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default 3000) |
| `DB_FILE` | SQLite file path (default `:memory:`; see Bug 1) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Seeds an ADMIN user at startup |
| `ADMIN_TOKEN` | Optional static admin header token |
| `APP_MODE` | `demo` (default) or `production` (disables demo payment/shipping → 501) |
| `SUPPLIER_MODE` | `mock` (default) or anything else = unconfigured adapter |
| `PAYMENT_WEBHOOK_SECRET` | HMAC secret for the demo payment webhook |
| `NODE_ENV` | `production` adds the `Secure` flag to the session cookie (`extra.js`) |

## Commands to resume
```powershell
cd backend
$env:ADMIN_EMAIL="admin@example.com"; $env:ADMIN_PASSWORD="choose-a-password"
npm start      # http://localhost:3000   (Node 22.5+ required)
npm test       # expect 30 pass
```

## Exact next steps
1. **CHECKPOINT-01-PROJECT-AUDIT** — add regression tests that *fail today* for Bug 1 and Bug 2, so the fixes are provable. (Optionally run the frontend in a headless browser to settle item 6.)
2. **CHECKPOINT-02-DATABASE** — make `openDb` idempotent (`IF NOT EXISTS`, seed only when empty, versioned migrations), then fix Bug 2 and Bug 3.
3. Then follow the priority order in the master prompt (customer journey → admin products/variants/inventory → suppliers/coupons/support → PostgreSQL/security → tests → final ZIP).
