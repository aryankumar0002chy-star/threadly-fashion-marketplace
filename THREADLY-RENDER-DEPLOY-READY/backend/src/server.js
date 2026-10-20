import { openDb } from './db.js';
import { createServer } from './app.js';
import { createUser } from './extra.js';
import { randomBytes, scryptSync } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0'; // required on Render/containers: listen on all interfaces, not just localhost
const DB_FILE = process.env.DB_FILE || ':memory:';

const db = openDb(DB_FILE);
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
  try { createUser(db, { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, role: 'ADMIN', name: 'Admin' }); }
  catch (e) {
    if (e.status !== 409) throw e;
    // Admin already exists in a persistent DB. ADMIN_PASSWORD is the source of truth: re-apply it so rotating the env var + redeploying
    // is the (only) way to change/recover the admin password, because staff accounts cannot use the public forgot-password flow.
    const salt = randomBytes(16).toString('hex');
    db.prepare("UPDATE users SET password_hash=?, role='ADMIN' WHERE email=?").run(`${salt}:${scryptSync(process.env.ADMIN_PASSWORD, salt, 64).toString('hex')}`, process.env.ADMIN_EMAIL.toLowerCase());
    db.prepare('DELETE FROM user_sessions WHERE user_id=(SELECT id FROM users WHERE email=?)').run(process.env.ADMIN_EMAIL.toLowerCase());
  }
}

const server = createServer(db, { webDir: new URL('../../frontend/', import.meta.url) });
server.listen(PORT, HOST, () => {
  const mode = process.env.APP_MODE === 'production' ? 'production (demo payment/shipping DISABLED)' : 'demo';
  console.log(`THREADLY listening on http://${HOST}:${PORT} | mode=${mode} | supplier=${process.env.SUPPLIER_MODE || 'mock'} (no live supplier connected) | db=${DB_FILE === ':memory:' ? 'IN-MEMORY (data lost on restart)' : DB_FILE}`);
  if (DB_FILE === ':memory:') console.warn('WARNING: DB_FILE is not set. All data is lost on every restart/deploy. See README "Persistent database".');
});

// Render sends SIGTERM on deploy/restart: stop accepting connections, close the DB cleanly.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => { try { db.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 8000).unref(); });
