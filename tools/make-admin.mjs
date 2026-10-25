// Makes an admin account, or turns an existing account into one.
// Admins have unlimited pixels and can open /admin.
//
//   ADMIN_PASSWORD='...' node tools/make-admin.mjs <username> [country code]
//
// Uses MONGODB_URI and MONGODB_DB from the environment or .env. Restart the
// server afterwards so it picks the change up.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { hashPassword } from '../src/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const [name, country = 'US'] = process.argv.slice(2);
const password = process.env.ADMIN_PASSWORD;
if (!name || !/^[A-Za-z0-9_]{3,20}$/.test(name)) {
  console.error('usage: ADMIN_PASSWORD=... node tools/make-admin.mjs <username> [country code]');
  process.exit(1);
}
if (!process.env.MONGODB_URI) { console.error('Set MONGODB_URI first.'); process.exit(1); }
const { countries } = JSON.parse(readFileSync(join(ROOT, 'map', 'countries.json'), 'utf8'));
if (!countries.some((c) => c.code === country.toUpperCase())) { console.error(`Unknown country code ${country}`); process.exit(1); }

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db(process.env.MONGODB_DB || 'worldpixel');
const users = db.collection('users');
const existing = await users.findOne({ nameLower: name.toLowerCase() });
if (existing) {
  const set = { admin: true, banned: false };
  if (password) set.pass = await hashPassword(password);
  await users.updateOne({ _id: existing._id }, { $set: set });
  console.log(`${existing.name} is now an admin${password ? ', with the new password' : ''}.`);
} else {
  if (!password || password.length < 8) { console.error('New accounts need ADMIN_PASSWORD (8+ characters).'); process.exit(1); }
  await db.collection('meta').updateOne({ _id: 'meta' }, { $setOnInsert: { nextUserId: 1, nextAddressIndex: 0, worldSeq: 0 } }, { upsert: true });
  const { nextUserId: id } = await db.collection('meta').findOneAndUpdate({ _id: 'meta' }, { $inc: { nextUserId: 1 } }, { returnDocument: 'before' });
  const now = Date.now();
  await users.insertOne({
    _id: id, name, nameLower: name.toLowerCase(), pass: await hashPassword(password), country: country.toUpperCase(),
    free: 5, freeAt: now, paid: 0, cap: 10, placed: 0, admin: true, banned: false, createdAt: now, ip: 'make-admin',
  });
  console.log(`Created admin ${name} (${country.toUpperCase()}).`);
}
await client.close();
