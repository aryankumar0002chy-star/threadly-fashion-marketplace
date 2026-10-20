// "Build" step for Render. THREADLY has zero npm dependencies and no bundler, so there is nothing to compile.
// This script fails the deploy early (before the new version goes live) if the app could not start.
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (m) => { console.error('BUILD FAILED: ' + m); process.exit(1); };
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) fail(`Node ${process.versions.node} is too old: built-in SQLite needs Node >= 22.13.0 (set NODE_VERSION on Render).`);

for (const f of ['backend/src/server.js', 'backend/src/app.js', 'backend/src/db.js', 'frontend/index.html', 'frontend/assets/app.js', 'frontend/assets/styles.css'])
  if (!existsSync(path.join(root, f)) || statSync(path.join(root, f)).size === 0) fail(`missing or empty: ${f}`);

for (const f of ['backend/src/server.js', 'backend/src/app.js', 'backend/src/db.js', 'backend/src/extra.js', 'backend/src/more.js', 'backend/src/pricing.js', 'backend/src/suppliers.js', 'frontend/assets/app.js'])
  try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }); } catch (e) { fail(`syntax error in ${f}\n${e.stderr}`); }

// Prove the schema + seed run on this Node version (in-memory, nothing written to disk).
const { openDb } = await import(pathToFileURL(path.join(root, 'backend/src/db.js')).href);
const db = openDb(':memory:'); const n = db.prepare('SELECT COUNT(*) c FROM products').get().c; db.close();
if (!n) fail('demo catalog failed to seed');
console.log(`Build OK: Node ${process.versions.node}, ${n} demo products seed correctly, frontend files present. (No compile step is needed.)`);
