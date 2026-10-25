import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createApp, hashPassword, RULES } from '../src/app.js';
import { btcWallet } from '../src/btc.js';
import { testMongo, testDbName, dropDb } from './mongo.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// BIP84 test vector ("abandon ... about"); first address is known.
const ZPUB = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

let clock = Date.UTC(2026, 9, 25, 12);
const payments = new Map(); // address -> [{ txid, sats, height }]
const btc = {
  wallet: btcWallet(ZPUB),
  esplora: { tip: async () => 900_000, received: async (a) => payments.get(a) || [] },
  price: { get: async () => 50_000 },
  confirmations: 1,
  pollMs: 3_600_000,
};
const quiet = { info() {}, warn() {}, error() {} };
let uri, dbName, app, base;

async function start() {
  app = await createApp({ mongoUri: uri, dbName, mapDir: join(ROOT, 'map'), publicDir: join(ROOT, 'public'), now: () => clock, btc, log: quiet, signupsPerHour: 1000 });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${app.server.address().port}`; r(); }));
}
before(async () => {
  uri = await testMongo();
  dbName = testDbName();
  // An admin made the way tools/make-admin.mjs makes one.
  const c = new MongoClient(uri);
  await c.connect();
  await c.db(dbName).collection('users').insertOne({
    _id: 1000, name: 'boss', nameLower: 'boss', pass: await hashPassword('boss password'), country: 'CH',
    free: 5, freeAt: clock, paid: 0, cap: 10, placed: 0, admin: true, banned: false, createdAt: clock,
  });
  await c.close();
  await start();
});
after(async () => { await app.close(); await dropDb(uri, dbName); });

// A tiny client that keeps its session cookie.
function client() {
  let cookie = '';
  return async (path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, res };
  };
}

// Pixels around a country: another country's land touching it, inland
// land far from it, coastline far from it, and water next to it.
function spotsFor(code) {
  const w = app.world;
  const id = w.idOf.get(code);
  let touching = -1, far = -1, coastFar = -1, water = -1;
  for (let i = 0; i < w.grid.length; i++) {
    const o = w.grid[i];
    if (!o) { if (water < 0 && w.borders(id, i)) water = i; continue; }
    if (o === id || w.count[o] <= 1) continue;
    if (w.borders(id, i)) { if (touching < 0) touching = i; }
    else if (w.coast[i]) { if (coastFar < 0) coastFar = i; }
    else if (far < 0 && w.base[i] !== id) far = i;
    if (touching >= 0 && far >= 0 && coastFar >= 0 && water >= 0) break;
  }
  return { id, touching, far, coastFar, water };
}
// Somewhere the country can color next, near i if possible.
function nextTo(id, i) {
  const w = app.world;
  return w.neighbours(i).find((j) => w.refuse(id, j) === null) ?? spotsFor(w.countries[id - 1].code).touching;
}

test('sign up gives 5 pixels; names are unique ignoring case', async () => {
  const a = client();
  const r = await a('/api/signup', { username: 'Alice', password: 'correct horse', country: 'pt' });
  assert.equal(r.status, 200);
  assert.equal(r.data.me.free, RULES.startPixels);
  assert.equal(r.data.me.cap, 10);
  assert.equal(r.data.me.country, 'PT');
  assert.equal((await a('/api/me')).data.me.name, 'Alice');

  const dup = await client()('/api/signup', { username: 'aLiCe', password: 'another one', country: 'ES' });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /taken/);

  assert.equal((await client()('/api/signup', { username: 'x', password: 'long enough', country: 'ES' })).status, 400);
  assert.equal((await client()('/api/signup', { username: 'bob_1', password: 'short', country: 'ES' })).status, 400);
  assert.equal((await client()('/api/signup', { username: 'bob_1', password: 'long enough', country: 'ZZ' })).status, 400);
});

test('wrong passwords lock the account for 15 minutes', async () => {
  const c = client();
  await client()('/api/signup', { username: 'carol', password: 'carol password', country: 'FR' });
  assert.equal((await c('/api/login', { username: 'carol', password: 'nope nope' })).status, 401);
  for (let k = 0; k < 9; k++) await c('/api/login', { username: 'Carol', password: 'nope nope' });
  assert.equal((await c('/api/login', { username: 'carol', password: 'carol password' })).status, 429);
  clock += 15 * 60_000;
  const ok = await c('/api/login', { username: 'CAROL', password: 'carol password' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.me.name, 'carol');
});

test('one free pixel every 5 minutes, stored up to 10', async () => {
  const d = client();
  await d('/api/signup', { username: 'dave', password: 'dave password', country: 'DE' });
  clock += RULES.regenMs - 1;
  assert.equal((await d('/api/me')).data.me.free, 5);
  clock += 1;
  let me = (await d('/api/me')).data.me;
  assert.equal(me.free, 6);
  assert.equal(me.nextAt, clock + RULES.regenMs);
  clock += 10 * 3600_000;
  me = (await d('/api/me')).data.me;
  assert.equal(me.free, 10);
  assert.equal(me.nextAt, null);
  // Spending from a full store starts the timer from now, not from hours ago.
  const { touching } = spotsFor('DE');
  const placed = await d('/api/place', { i: touching });
  assert.equal(placed.status, 200, placed.data.error);
  assert.equal(placed.data.me.free, 9);
  assert.equal(placed.data.me.nextAt, clock + RULES.regenMs);
});

test('you can only color pixels touching your country', async () => {
  const e = client();
  await e('/api/signup', { username: 'erin', password: 'erin password', country: 'PT' });
  const { id, touching, far } = spotsFor('PT');
  const before = app.world.count[id];

  const no = await e('/api/place', { i: far });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /touching Portugal/);
  assert.equal(no.data.me.free, 5);

  const yes = await e('/api/place', { i: touching });
  assert.equal(yes.status, 200);
  assert.equal(app.world.grid[touching], id);
  assert.equal(app.world.count[id], before + 1);
  assert.equal(yes.data.me.free, 4);
  assert.equal(yes.data.me.placed, 1);

  assert.equal((await e('/api/place', { i: touching })).status, 400); // already ours
  assert.equal((await e('/api/place', { i: -1 })).status, 400);
  assert.equal((await e('/api/place', { i: 'abc' })).status, 400);

  await app.save();
  const info = await e(`/api/pixel?i=${touching}`);
  assert.deepEqual([info.data.country, info.data.original, info.data.by], ['PT', 'ES', 'erin']);

  // Spend the rest, then run out.
  let i = touching;
  for (let k = 0; k < 4; k++) {
    i = nextTo(id, i);
    const r = await e('/api/place', { i });
    assert.equal(r.status, 200, r.data.error);
  }
  const out = await e('/api/place', { i: nextTo(id, i) });
  assert.equal(out.status, 400);
  assert.match(out.data.error, /out of pixels/);
});

test('switching country changes who your pixels go to', async () => {
  const f = client();
  await f('/api/signup', { username: 'frank', password: 'frank password', country: 'NO' });
  const r = await f('/api/country', { country: 'se' });
  assert.equal(r.data.me.country, 'SE');
  const { id, touching } = spotsFor('SE');
  assert.equal((await f('/api/place', { i: touching })).status, 200);
  assert.equal(app.world.grid[touching], id);
  assert.equal((await client()('/api/country', { country: 'SE' })).status, 401);
});

test('water can\'t be colored; coasts can be landed on from the sea', async () => {
  const s = client();
  await s('/api/signup', { username: 'sven', password: 'sven password', country: 'NO' });
  const { id, water, coastFar } = spotsFor('NO');
  const wet = await s('/api/place', { i: water });
  assert.equal(wet.status, 400);
  assert.match(wet.data.error, /Water/);
  const landing = await s('/api/place', { i: coastFar });
  assert.equal(landing.status, 200, landing.data.error);
  assert.equal(app.world.grid[coastFar], id);

  // Switzerland has no coast, so it can't.
  const c = client();
  await c('/api/signup', { username: 'heidi', password: 'heidi password', country: 'CH' });
  const other = spotsFor('CH').coastFar;
  const no = await c('/api/place', { i: other });
  assert.equal(no.status, 400);
  assert.match(no.data.error, /no coastline/);
});

test('a country\'s last pixel can\'t be taken', async () => {
  const w = app.world;
  const va = w.idOf.get('VA'); // Vatican: one pixel, inside Italy
  const i = w.grid.indexOf(va);
  assert.equal(w.count[va], 1);
  const it = client();
  await it('/api/signup', { username: 'italo', password: 'italo password', country: 'IT' });
  assert.ok(w.borders(w.idOf.get('IT'), i));
  const r = await it('/api/place', { i });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Vatican's last pixel/);
  assert.equal(w.grid[i], va);
  assert.equal(r.data.me.free, 5, 'no pixel spent');
});

test('a country wiped off the map can restart on its own land', () => {
  const w = app.world;
  const id = w.idOf.get('VA'); // Vatican: one pixel
  const i = w.grid.indexOf(id);
  const other = w.idOf.get('IT');
  w.set(i, other);
  assert.equal(w.count[id], 0);
  assert.equal(w.refuse(id, i), null);
  w.set(i, id);
});

test('buying pixels: invoice, payment, credit', async () => {
  const g = client();
  await g('/api/signup', { username: 'gina', password: 'gina password', country: 'BR' });
  const r = await g('/api/buy', { pack: 'p6' });
  assert.equal(r.status, 200, r.data.error);
  const inv = r.data.invoice;
  assert.equal(inv.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(inv.sats, 10_000); // $5 at $50,000
  assert.equal(inv.btc, '0.00010000');
  assert.equal(inv.status, 'open');
  assert.equal((await g('/api/buy', { pack: 'p6' })).data.invoice.id, inv.id, 'same open pack is reused');

  payments.set(inv.address, [{ txid: 'aa', sats: 9_950, height: null }]);
  await app.checkPayments();
  let mine = (await g('/api/invoices')).data.invoices[0];
  assert.equal(mine.status, 'confirming');
  assert.equal((await g('/api/me')).data.me.paid, 0);

  payments.set(inv.address, [{ txid: 'aa', sats: 9_950, height: 900_000 }]);
  await app.checkPayments();
  mine = (await g('/api/invoices')).data.invoices[0];
  assert.equal(mine.status, 'paid');
  const me = (await g('/api/me')).data.me;
  assert.equal(me.paid, 6);
  await app.checkPayments();
  assert.equal((await g('/api/me')).data.me.paid, 6, 'paid once only');

  // Bought pixels go on top of the 10-pixel storage and are spent after free ones.
  clock += 10 * 3600_000;
  assert.deepEqual([(await g('/api/me')).data.me.free, (await g('/api/me')).data.me.paid], [10, 6]);
});

test('underpaying credits nothing until the rest arrives', async () => {
  const h = client();
  await h('/api/signup', { username: 'hank', password: 'hank password', country: 'AR' });
  const inv = (await h('/api/buy', { pack: 'p40' })).data.invoice;
  assert.equal(inv.sats, 40_000);
  payments.set(inv.address, [{ txid: 'b1', sats: 20_000, height: 899_990 }]);
  await app.checkPayments();
  assert.equal((await h('/api/invoices')).data.invoices[0].status, 'underpaid');
  assert.equal((await h('/api/me')).data.me.paid, 0);
  payments.set(inv.address, [{ txid: 'b2', sats: 20_000, height: 899_999 }, { txid: 'b1', sats: 20_000, height: 899_990 }]);
  await app.checkPayments();
  assert.equal((await h('/api/me')).data.me.paid, 40);
});

test('storage upgrade raises the cap to 100, once', async () => {
  const k = client();
  await k('/api/signup', { username: 'kim', password: 'kim password', country: 'KR' });
  const inv = (await k('/api/buy', { pack: 'cap100' })).data.invoice;
  assert.equal(inv.sats, 20_000);
  payments.set(inv.address, [{ txid: 'c1', sats: 20_000, height: 900_000 }]);
  await app.checkPayments();
  let me = (await k('/api/me')).data.me;
  assert.equal(me.cap, 100);
  clock += 100 * RULES.regenMs;
  me = (await k('/api/me')).data.me;
  assert.equal(me.free, 100);
  const again = await k('/api/buy', { pack: 'cap100' });
  assert.equal(again.status, 400);
});

test('addresses that already have payments are never handed out', async () => {
  const q = client();
  await q('/api/signup', { username: 'quinn', password: 'quinn password', country: 'CL' });
  const { nextAddressIndex: next } = await app.store.col.meta.findOne({ _id: 'meta' });
  payments.set(btc.wallet.address(next), [{ txid: 'old1', sats: 50_000, height: 800_000 }]);
  payments.set(btc.wallet.address(next + 1), [{ txid: 'old2', sats: 1, height: null }]);
  const inv = (await q('/api/buy', { pack: 'p6' })).data.invoice;
  assert.equal(inv.address, btc.wallet.address(next + 2));
  assert.equal(inv.status, 'open');
});

test('an expired quote still pays out when the bitcoin arrives late', async () => {
  const m = client();
  await m('/api/signup', { username: 'moe', password: 'moe password', country: 'EG' });
  const inv = (await m('/api/buy', { pack: 'p15' })).data.invoice;
  clock += 3600_000;
  await app.checkPayments();
  assert.equal((await m('/api/invoices')).data.invoices[0].status, 'expired');
  payments.set(inv.address, [{ txid: 'd1', sats: inv.sats, height: 900_000 }]);
  await app.checkPayments();
  assert.equal((await m('/api/me')).data.me.paid, 15);
  // Each invoice gets its own address.
  const addrs = new Set((await m('/api/invoices')).data.invoices.map((x) => x.address));
  assert.equal(addrs.size, 1);
  assert.notEqual(inv.address, 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
});

test('the map and the live feed', async () => {
  const res = await fetch(`${base}/api/world`);
  const grid = new Uint8Array(await res.arrayBuffer());
  assert.equal(grid.length, app.world.W * app.world.H);
  const seq = Number(res.headers.get('x-seq'));
  assert.ok(seq > 0);

  const n = client();
  await n('/api/signup', { username: 'nina', password: 'nina password', country: 'KR' });
  const { touching } = spotsFor('KR');
  await n('/api/place', { i: touching });
  await new Promise((r) => setTimeout(r, 300));

  const ctrl = new AbortController();
  const ev = await fetch(`${base}/api/events?since=${seq}`, { signal: ctrl.signal });
  const reader = ev.body.getReader();
  let text = '';
  while (!text.includes('"p"')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  const msg = JSON.parse(/data: (\{"s".*\})/.exec(text)[1]);
  const pairs = [];
  for (let k = 0; k < msg.p.length; k += 2) pairs.push([msg.p[k], msg.p[k + 1]]);
  assert.deepEqual(pairs.at(-1), [touching, app.world.idOf.get('KR')]);

  const countries = await (await fetch(`${base}/countries.json`)).json();
  assert.equal(countries.countries.length, app.world.countries.length);
});

test('posts from other sites and odd paths are refused', async () => {
  const c = client();
  assert.equal((await c('/api/signup', { username: 'evil', password: 'evil password', country: 'US' }, { Origin: 'https://evil.example' })).status, 403);
  const form = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=a' });
  assert.equal(form.status, 415);
  assert.equal((await fetch(`${base}/%2e%2e/server.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  const page = await fetch(`${base}/`);
  assert.match(await page.text(), /WorldPixel/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
});

test('everything survives a restart', async () => {
  const p = client();
  await p('/api/signup', { username: 'pat', password: 'pat password', country: 'CA' });
  const { id, touching } = spotsFor('CA');
  await p('/api/place', { i: touching });
  await app.close();
  await start();
  assert.equal(app.world.grid[touching], id);
  const again = await client()('/api/login', { username: 'pat', password: 'pat password' });
  assert.equal(again.status, 200);
  assert.equal(again.data.me.placed, 1);
  const info = await client()(`/api/pixel?i=${touching}`);
  assert.equal(info.data.by, 'pat');
});

test('admins have unlimited pixels and can see the stats', async () => {
  const boss = client();
  const r = await boss('/api/login', { username: 'boss', password: 'boss password' });
  assert.equal(r.data.me.admin, true);
  const freeBefore = r.data.me.free;
  const { id, touching } = spotsFor('CH');
  let i = touching;
  for (let k = 0; k < 25; k++) {
    const p = await boss('/api/place', { i });
    assert.equal(p.status, 200, p.data.error);
    i = nextTo(id, i);
  }
  assert.equal((await boss('/api/me')).data.me.free, freeBefore, 'admin pixels are not used up');

  const s = (await boss('/api/admin/stats')).data;
  assert.equal(s.revenue.all, 5 + 20 + 10 + 10);
  assert.equal(s.revenue.payers, 4);
  assert.ok(s.users.total >= 12);
  assert.ok(s.pixels.today >= 25);
  assert.equal(s.revenue.byDay.length, 14);
  assert.ok(s.recent.some((u) => u.name === 'gina' && u.spent === 5));

  const found = (await boss('/api/admin/users?q=GIN')).data.users;
  assert.deepEqual(found.map((u) => u.name), ['gina']);

  const alice = client();
  await alice('/api/login', { username: 'alice', password: 'correct horse' });
  assert.equal((await alice('/api/admin/stats')).status, 403);
  assert.equal((await client()('/api/admin/stats')).status, 401);
});

test('banning: locked out, and their pixels can be undone', async () => {
  const boss = client();
  await boss('/api/login', { username: 'boss', password: 'boss password' });
  const v = client();
  await v('/api/signup', { username: 'vandal', password: 'vandal password', country: 'NZ' });
  const w = app.world;
  const nz = w.idOf.get('NZ');
  // New Zealand has no land border: land on a coast, then grow inland.
  const touching = spotsFor('NZ').coastFar;
  const was = w.grid[touching];
  assert.equal((await v('/api/place', { i: touching })).status, 200);
  const next = nextTo(nz, touching);
  const wasNext = w.grid[next];
  assert.equal((await v('/api/place', { i: next })).status, 200);
  assert.equal(w.grid[next], nz);

  assert.equal((await boss('/api/admin/ban', { username: 'boss' })).status, 400, 'admins can\'t be banned');
  const ban = await boss('/api/admin/ban', { username: 'VANDAL', undo: true });
  assert.equal(ban.status, 200, ban.data.error);
  assert.equal(ban.data.undone, 2);
  assert.equal(w.grid[touching], was, 'given back to whoever had it');
  assert.equal(w.grid[next], wasNext);

  assert.equal((await v('/api/me')).data.me, null, 'their session is gone');
  assert.equal((await v('/api/place', { i: touching })).status, 401);
  const login = await client()('/api/login', { username: 'vandal', password: 'vandal password' });
  assert.equal(login.status, 403);
  assert.equal((await client()('/api/signup', { username: 'Vandal', password: 'other password', country: 'NZ' })).status, 409, 'the name stays taken');

  const s = (await boss('/api/admin/stats')).data;
  assert.deepEqual(s.banned.map((u) => u.name), ['vandal']);
  await boss('/api/admin/unban', { username: 'vandal' });
  assert.equal((await client()('/api/login', { username: 'vandal', password: 'vandal password' })).status, 200);
});
