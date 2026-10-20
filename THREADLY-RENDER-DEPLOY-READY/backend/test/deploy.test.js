// Deployment-readiness tests: persistence across restarts, static storefront, health check, listen on PORT/0.0.0.0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { openDb, getSettings } from '../src/db.js';
import { createServer } from '../src/app.js';
import { createUser } from '../src/extra.js';

const webDir = new URL('../../frontend/', import.meta.url);
const boot = (db) => new Promise((res) => { const s = createServer(db, { webDir }).listen(0, '127.0.0.1', () => res({ s, base: `http://127.0.0.1:${s.address().port}` })); });

test('DB_FILE persists across restarts: reopening does not crash, re-seed, or reset admin settings', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'threadly-')), file = path.join(dir, 't.db');
  try {
    const a = openDb(file); const n1 = a.prepare('SELECT COUNT(*) c FROM products').get().c;
    a.prepare("UPDATE settings SET value='12300' WHERE key='platformFee'").run();
    a.prepare("INSERT INTO users(email,password_hash) VALUES('keep@example.com','x')").run(); a.close();
    const b = openDb(file); // used to throw "table settings already exists"
    assert.equal(b.prepare('SELECT COUNT(*) c FROM products').get().c, n1, 'catalog must not be re-seeded');
    assert.equal(getSettings(b).platformFee, 12300, 'changed settings must survive restart');
    assert.equal(b.prepare("SELECT COUNT(*) c FROM users WHERE email='keep@example.com'").get().c, 1);
    assert.ok(b.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'user_id'));
    b.close(); openDb(file).close(); // third open also fine
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('root URL serves the storefront shell; assets have correct types; API still works', async () => {
  const { s, base } = await boot(openDb());
  try {
    const root = await fetch(base + '/'); assert.equal(root.status, 200); assert.match(root.headers.get('content-type'), /text\/html/);
    const html = await root.text(); assert.match(html, /THREADLY/); assert.match(html, /\/assets\/app\.js/);
    const js = await fetch(base + '/assets/app.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
    const css = await fetch(base + '/assets/styles.css'); assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /text\/css/);
    const api = await fetch(base + '/api/products'); assert.equal(api.status, 200); const j = await api.json(); assert.ok(j.total >= 100 && j.rows.length > 0);
  } finally { s.close(); }
});

test('SPA fallback for deep links; missing assets and unknown API routes are real 404s', async () => {
  const { s, base } = await boot(openDb());
  try {
    const deep = await fetch(base + '/products/some-client-route'); assert.equal(deep.status, 200); assert.match(await deep.text(), /<div class="b" id="dm">/);
    assert.equal((await fetch(base + '/assets/missing.js')).status, 404);
    const api = await fetch(base + '/api/nope'); assert.equal(api.status, 404); assert.equal((await api.json()).error, 'Not found');
    assert.equal((await fetch(base + '/', { method: 'POST' })).status, 405);
  } finally { s.close(); }
});

test('static handler cannot read files outside frontend/ (path traversal)', async () => {
  const { s, base } = await boot(openDb());
  try {
    for (const p of ['/../backend/package.json', '/%2e%2e/backend/package.json', '/assets/..%2f..%2fbackend%2fpackage.json', '/..%2f..%2f.env', '/%00']) {
      const r = await fetch(base + p); const t = await r.text();
      assert.ok(!t.includes('threadly-backend') && !t.includes('SUPPLIER_MODE'), `leaked via ${p}`);
    }
  } finally { s.close(); }
});

test('/healthz reports ok and sets hardening headers', async () => {
  const { s, base } = await boot(openDb());
  try {
    const r = await fetch(base + '/healthz'); assert.equal(r.status, 200); assert.deepEqual(await r.json(), { ok: true });
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.equal(r.headers.get('x-frame-options'), 'DENY');
  } finally { s.close(); }
});

test('server.js listens on process.env.PORT, answers on all interfaces, and survives a restart on the same DB_FILE with ADMIN_* set', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'threadly-')), file = path.join(dir, 'srv.db'), port = 20000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, PORT: String(port), DB_FILE: file, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'adminpass1', NODE_ENV: 'production', APP_MODE: 'demo' };
  const run = () => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], { env }); let out = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('exit', (code) => reject(new Error(`server exited early (${code}): ${out}`)));
    const t0 = Date.now(), poll = async () => {
      try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); if (r.ok) return resolve({ c, out: () => out }); } catch {}
      if (Date.now() - t0 > 8000) { c.kill(); return reject(new Error('timeout: ' + out)); } setTimeout(poll, 100);
    }; poll();
  });
  try {
    const first = await run(); assert.match(first.out(), new RegExp(`0\\.0\\.0\\.0:${port}`), 'must bind 0.0.0.0 on PORT');
    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: 'adminpass1' }) });
    assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /Secure/, 'NODE_ENV=production must set Secure cookies');
    await new Promise((r) => { first.c.removeAllListeners('exit'); first.c.on('exit', r); first.c.kill('SIGTERM'); });
    const second = await run(); // restart on same file + same ADMIN_EMAIL must not crash
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
    second.c.removeAllListeners('exit'); await new Promise((r) => { second.c.on('exit', r); second.c.kill('SIGTERM'); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SECURITY: demo-mode forgot-password cannot be used to take over the ADMIN (or any staff) account', async () => {
  const db = openDb(); createUser(db, { email: 'boss@example.com', password: 'adminpass1', role: 'ADMIN' }); createUser(db, { email: 'cust@example.com', password: 'custpass123' });
  const { s, base } = await boot(db), post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    const f = await (await post('/api/auth/forgot', { email: 'boss@example.com' })).json();
    assert.equal((await post('/api/auth/reset', { token: f.demoResetToken, password: 'attacker-pass-1' })).status, 400, 'admin reset must be refused');
    assert.equal((await post('/api/auth/login', { email: 'boss@example.com', password: 'adminpass1' })).status, 200, 'admin password unchanged');
    const g = await (await post('/api/auth/forgot', { email: 'cust@example.com' })).json(); // customers keep the documented demo flow
    assert.equal((await post('/api/auth/reset', { token: g.demoResetToken, password: 'newpassword1' })).status, 200);
  } finally { s.close(); }
});

test('restart re-applies ADMIN_PASSWORD from the environment (admin recovery path)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'threadly-')), file = path.join(dir, 'a.db'), port = 20000 + Math.floor(Math.random() * 20000);
  const start = (pw) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, [new URL('../src/server.js', import.meta.url).pathname], { env: { ...process.env, PORT: String(port), DB_FILE: file, ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: pw } });
    c.on('exit', (code) => reject(new Error('exited ' + code))); const t0 = Date.now();
    (async function poll() { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return resolve(c); } catch {} if (Date.now() - t0 > 8000) { c.kill(); return reject(new Error('timeout')); } setTimeout(poll, 100); })();
  });
  const login = (pw) => fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.com', password: pw }) });
  const stop = (c) => new Promise((r) => { c.removeAllListeners('exit'); c.on('exit', r); c.kill('SIGTERM'); });
  try {
    let c = await start('first-password-1'); assert.equal((await login('first-password-1')).status, 200); await stop(c);
    c = await start('rotated-password-2'); assert.equal((await login('rotated-password-2')).status, 200); assert.equal((await login('first-password-1')).status, 401); await stop(c);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
