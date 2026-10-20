// Optional browser end-to-end test. Not part of `npm test` because Playwright is NOT a project dependency.
//   npm i --no-save playwright && npx playwright install chromium
//   node backend/src/server.js &   (ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=adminpass1 PORT=3111)
//   BASE_URL=http://127.0.0.1:3111 node scripts/e2e-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3111', SHOTS = process.env.SHOT_DIR;
const ADMIN = { email: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'adminpass1' };
const results = []; let failed = 0;
const step = async (name, fn) => { let r; try { await fn(); r = ['PASS', name]; } catch (e) { failed++; r = ['FAIL', name + ' :: ' + String(e.message).split('\n')[0]]; } results.push(r); console.log(r[0], r[1]); };
const assert = (c, m) => { if (!c) throw new Error(m); };
const browser = await chromium.launch();

for (const [label, vp] of [['phone-390', { width: 390, height: 800 }], ['desktop-1280', { width: 1280, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport: vp }); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); /* hermetic: web fonts are optional */ const pg = await ctx.newPage(), bad = [];
  pg.on('pageerror', (e) => bad.push('pageerror: ' + e.message));
  pg.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('/api/me') && !r.url().endsWith('/api/products/does-not-exist') && !r.url().includes('/api/wishlist')) bad.push(r.status() + ' ' + r.url()); });
  const shot = (n) => SHOTS && pg.screenshot({ path: `${SHOTS}/${label}-${n}.png`, fullPage: false });
  const noOverflow = async () => assert(await pg.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'horizontal overflow at ' + label);
  const P = (s) => `[${label}] ${s}`;

  await step(P('home renders products, categories, no overflow'), async () => {
    await pg.goto(BASE + '/'); await pg.waitForSelector('.c'); assert(await pg.locator('.c').count() >= 8, 'few cards');
    assert(await pg.locator('.tiles a').count() === 12, 'category tiles'); assert(/DEMO STORE/.test(await pg.locator('#dm').innerText()), 'demo banner'); await noOverflow(); await shot('home'); });
  await step(P('search returns results'), async () => {
    await pg.fill('header input[name=q]', 'hoodie'); await pg.press('header input[name=q]', 'Enter'); await pg.waitForSelector('text=/products for/');
    assert(/products for/.test(await pg.locator('main').innerText()), 'no result count'); assert(/hoodie/i.test(await pg.locator('.c').first().innerText()), 'result not a hoodie'); await noOverflow(); await shot('search'); });
  await step(P('category filter works'), async () => {
    await pg.goto(BASE + '/#/products?category=Jeans'); await pg.waitForFunction(() => { const c = [...document.querySelectorAll('.c')]; return c.length > 0 && c.every((x) => /jeans/i.test(x.innerText)); });
    const t = await pg.locator('.c').allInnerTexts(); assert(t.length > 0 && t.every((x) => /jeans/i.test(x)), 'non-jeans in Jeans category'); await shot('category'); });
  await step(P('product page, size select, add to cart'), async () => {
    await pg.locator('.c a').first().click(); await pg.waitForSelector('.pd'); await noOverflow();
    await pg.locator('[data-act=size]:not([disabled])').first().click(); await pg.locator('[data-act=add]').click();
    await pg.waitForFunction(() => /Cart \(1\)/.test(document.querySelector('#hdr').innerText)); await shot('product'); });
  await step(P('cart quote + coupon'), async () => {
    await pg.goto(BASE + '/#/cart'); await pg.waitForSelector('.sum'); const t = await pg.locator('.sum').innerText(); assert(/Platform fee/.test(t) && /Grand total/.test(t), 'summary missing');
    await noOverflow(); await shot('cart'); });
  await step(P('demo checkout (online, simulated) -> success'), async () => {
    await pg.locator('a:has-text("Proceed to checkout")').click(); await pg.waitForSelector('form[data-f=order]');
    assert(/Demo checkout/.test(await pg.locator('.notice').innerText()), 'no demo notice');
    for (const [n, v] of [['name', 'Test Buyer'], ['phone', '9876543210'], ['line1', '1 Demo Street'], ['city', 'Pune'], ['state', 'MH'], ['pin', '411001']]) await pg.fill(`form[data-f=order] [name=${n}]`, v);
    await noOverflow(); await shot('checkout'); await pg.locator('form[data-f=order] button.p').click(); await pg.waitForSelector('text=Demo order placed');
    const t = await pg.locator('main').innerText(); assert(/ORD-\d{4}-[A-F0-9]{6}/.test(t), 'no order number'); assert(/simulated/i.test(t), 'no simulation disclosure'); await shot('success'); });
  await step(P('cart emptied after order; order page shows tracking + totals'), async () => {
    assert(/Cart \(0\)/.test(await pg.locator('#hdr').innerText()), 'cart not cleared'); await pg.locator('a:has-text("Track order")').click(); await pg.waitForSelector('.tl');
    const t = await pg.locator('main').innerText(); assert(/CONFIRMED/.test(t) && /PAID/.test(t), 'demo payment status not reflected'); await noOverflow(); await shot('order'); });
  await step(P('COD checkout adds COD fee'), async () => {
    await pg.goto(BASE + '/#/products?sort=low'); await pg.waitForSelector('.c'); await pg.locator('.c [data-act=quick]').first().click(); await pg.waitForFunction(() => /Added/.test(document.querySelector('#t').textContent)); await pg.goto(BASE + '/#/checkout');
    await pg.waitForSelector('form[data-f=order]'); await pg.locator('input[value=COD]').check(); await pg.waitForSelector('.sum:has-text("COD fee")'); });
  await step(P('guest wishlist click goes to login'), async () => {
    await pg.goto(BASE + '/#/'); await pg.waitForSelector('.c'); await pg.locator('.hrt').first().click(); await pg.waitForSelector('text=Create account'); });
  await step(P('register + account area'), async () => {
    await pg.goto(BASE + '/#/register'); const email = `e2e-${label}-${Date.now()}@example.com`;
    await pg.fill('[name=name]', 'E2E'); await pg.fill('[name=email]', email); await pg.fill('[name=password]', 'password123'); await pg.fill('[name=confirm]', 'password123');
    await pg.locator('form[data-f=register] button.p').click(); await pg.waitForSelector('.tabs'); assert(/My account/.test(await pg.locator('main').innerText()), 'not in account'); await shot('account'); });
  await step(P('unknown route and bad product show friendly state'), async () => {
    await pg.goto(BASE + '/#/nope'); await pg.waitForSelector('text=Page not found'); await pg.goto(BASE + '/#/products/does-not-exist'); await pg.waitForSelector('text=Something went wrong'); });
  await step(P('info pages render'), async () => { await pg.goto(BASE + '/#/about'); assert(/no live supplier is connected/.test(await pg.locator('main').innerText()), 'about lacks supplier disclosure'); });
  await step(P('no JS errors / failed requests during run'), async () => assert(bad.length === 0, bad.join(' | ')));
  await ctx.close();
}

// admin (desktop) in a fresh context
{ const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); const pg = await ctx.newPage();
  await step('[admin] login + dashboard + orders table', async () => {
    await pg.goto(BASE + '/#/admin'); await pg.fill('[name=email]', ADMIN.email); await pg.fill('[name=password]', ADMIN.password); await pg.locator('form[data-f=login] button.p').click();
    await pg.waitForSelector('.cards'); assert(/Gross sales/.test(await pg.locator('main').innerText()), 'no dashboard');
    await pg.goto(BASE + '/#/admin/orders'); await pg.waitForSelector('table'); assert(await pg.locator('tr').count() > 1, 'no orders listed'); if (SHOTS) await pg.screenshot({ path: `${SHOTS}/admin-orders.png` }); });
  await ctx.close(); }

await browser.close();
console.log(`\n${results.length - failed}/${results.length} browser checks passed`); process.exit(failed ? 1 : 0);
