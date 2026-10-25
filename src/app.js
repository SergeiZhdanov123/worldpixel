// WorldPixel: accounts, pixels, the live map feed, Bitcoin purchases and
// the admin page, on plain node:http with MongoDB behind it.
import http from 'node:http';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';
import { World, loadBaseMap } from './world.js';
import { openStore } from './store.js';
import { satsToBtc } from './btc.js';

const scrypt = promisify(scryptCb);
const gzip = promisify(gzipCb);

export const RULES = {
  startPixels: 5,
  regenMs: 5 * 60_000,
  cap: 10,
  bigCap: 100,
};

export const PACKS = {
  p6: { usd: 5, pixels: 6 },
  p15: { usd: 10, pixels: 15 },
  p40: { usd: 20, pixels: 40 },
  p180: { usd: 50, pixels: 180 },
  cap100: { usd: 10, cap: RULES.bigCap },
};

const QUOTE_MS = 30 * 60_000; // how long a quoted bitcoin amount is shown as valid
const WATCH_MS = 7 * 24 * 3600_000; // payments to an invoice address are credited this long
const PAID_SHARE = 0.98; // a payment this close to the quote counts as full (wallet rounding)
const SESSION_MS = 30 * 24 * 3600_000;
const LOG_KEEP = 100_000; // recent placements kept so a reconnecting page can catch up
const DAY = 24 * 3600_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.gz': 'application/gzip', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
const DUMMY_HASH = `s1$${'00'.repeat(16)}$${'00'.repeat(64)}`;
async function checkPassword(pw, stored) {
  const [, salt, key] = stored.split('$');
  const got = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  return timingSafeEqual(got, Buffer.from(key, 'hex'));
}

// Fixed-window counters for rate limits, keyed by account or address.
function limiter(max, windowMs, now) {
  const hits = new Map();
  return {
    blocked(key) { const h = hits.get(key); return !!h && now() - h.at < windowMs && h.n >= max; },
    hit(key) {
      const t = now();
      let h = hits.get(key);
      if (!h || t - h.at >= windowMs) { h = { at: t, n: 0 }; hits.set(key, h); }
      h.n++;
      if (hits.size > 50_000) for (const [k, v] of hits) if (t - v.at >= windowMs) hits.delete(k);
    },
    clear(key) { hits.delete(key); },
  };
}

const startOfDay = (t) => t - (t % DAY); // UTC

export async function createApp({
  mongoUri,
  dbName = 'worldpixel',
  mapDir,
  publicDir,
  now = Date.now,
  btc = null, // { wallet, esplora, price, confirmations }
  trustProxy = 0,
  signupsPerHour = 10, // per address; schools and offices share one
  log = console,
} = {}) {
  const map = loadBaseMap(mapDir);
  const store = await openStore({ uri: mongoUri, dbName, width: map.width, height: map.height, base: map.base, log });
  if (btc?.startIndex) await store.atLeast('nextAddressIndex', btc.startIndex);
  const world = new World(map, store.grid);
  const usersById = new Map(store.users.map((u) => [u._id, u]));
  const usersByName = new Map(store.users.map((u) => [u.nameLower, u]));
  const sessions = new Map(store.sessions.map((s) => [s._id, { uid: s.uid, exp: +s.exp }]));
  const invoices = store.invoices;

  // ---- pixels on hand -------------------------------------------------
  // Free pixels grow by one every five minutes up to the storage cap.
  // Bought pixels sit on top of that and never expire; free ones are
  // spent first so the timer keeps running. Admins have no limit.
  function settle(u) {
    const t = now();
    if (u.free >= u.cap) { u.freeAt = t; return; }
    const gained = Math.floor((t - u.freeAt) / RULES.regenMs);
    if (gained <= 0) return;
    u.free = Math.min(u.cap, u.free + gained);
    u.freeAt = u.free >= u.cap ? t : u.freeAt + gained * RULES.regenMs;
    store.saveUser(u);
  }
  function me(u) {
    settle(u);
    return {
      name: u.name,
      country: u.country,
      free: u.free,
      paid: u.paid,
      cap: u.cap,
      nextAt: u.free < u.cap ? u.freeAt + RULES.regenMs : null,
      placed: u.placed,
      admin: !!u.admin,
      now: now(),
    };
  }

  // ---- live feed ------------------------------------------------------
  let seq = store.seq;
  let logStart = seq + 1; // seq of placements[0]
  const placements = []; // [i, c] pairs, in seq order
  const clients = new Map(); // response -> user id or 0
  let pending = [];
  function broadcast(obj) {
    const line = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of clients.keys()) c.write(line);
  }
  const flushTimer = setInterval(() => {
    if (!pending.length) return;
    broadcast({ s: seq, p: pending });
    pending = [];
  }, 200);
  const pingTimer = setInterval(() => broadcast({ online: clients.size }), 15_000);

  // Every change to the map goes through here: our users' clicks, and
  // pixels handed back when an admin removes a banned player's work.
  function setPixel(i, c, uid) {
    world.set(i, c);
    seq++;
    placements.push(i, c);
    pending.push(i, c);
    if (placements.length > LOG_KEEP * 2) {
      const drop = placements.length - LOG_KEEP * 2;
      placements.splice(0, drop);
      logStart += drop / 2;
    }
    store.placed({ _id: seq, i, c, uid, at: new Date(now()) }, i);
  }

  let worldGz = null; // { seq, at, body }
  let worldGzBusy = null;
  async function worldSnapshot() {
    if (worldGz && (worldGz.seq === seq || now() - worldGz.at < 3000)) return worldGz;
    worldGzBusy ||= (async () => {
      const at = seq;
      const body = await gzip(Buffer.from(world.grid), { level: 6 });
      worldGz = { seq: at, at: now(), body };
    })().finally(() => { worldGzBusy = null; });
    await worldGzBusy;
    return worldGz;
  }

  // ---- accounts -------------------------------------------------------
  const signups = limiter(signupsPerHour, 3600_000, now);
  const loginsByIp = limiter(30, 15 * 60_000, now);
  const loginsByName = limiter(10, 15 * 60_000, now);
  const placeRate = limiter(12, 1000, now);
  const adminPlaceRate = limiter(60, 1000, now);

  function startSession(res, req, u) {
    const token = randomBytes(32).toString('base64url');
    const exp = now() + SESSION_MS;
    sessions.set(sha(token), { uid: u._id, exp });
    store.addSession(sha(token), u._id, exp);
    res.setHeader('Set-Cookie', cookie(req, token, SESSION_MS / 1000));
  }
  function cookie(req, value, maxAge) {
    const secure = req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
    return `wp=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge)}${secure ? '; Secure' : ''}`;
  }
  const tokenOf = (req) => /(?:^|;\s*)wp=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
  function userOf(req) {
    const token = tokenOf(req);
    if (!token) return null;
    const s = sessions.get(sha(token));
    if (!s) return null;
    if (s.exp < now()) { sessions.delete(sha(token)); return null; }
    const u = usersById.get(s.uid);
    return u && !u.banned ? u : null;
  }
  function ipOf(req) {
    if (trustProxy) {
      const hops = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
      // Each trusted proxy appends the address it saw, so the client is
      // that many entries from the end. Entries before it can be forged.
      if (hops.length >= trustProxy) return hops[hops.length - trustProxy];
    }
    return req.socket.remoteAddress || '?';
  }
  function needUser(req) {
    const u = userOf(req);
    if (!u) throw new HttpError(401, 'Log in first.');
    return u;
  }
  function needAdmin(req) {
    const u = needUser(req);
    if (!u.admin) throw new HttpError(403, 'Admins only.');
    return u;
  }
  function countryCode(code) {
    const c = String(code || '').toUpperCase();
    if (!world.idOf.has(c)) throw new HttpError(400, 'Pick a country from the list.');
    return c;
  }

  // ---- payments -------------------------------------------------------
  function invoiceView(inv) {
    const p = PACKS[inv.pack];
    return {
      id: inv._id, pack: inv.pack, usd: inv.usd, pixels: p.pixels ?? null, cap: p.cap ?? null,
      address: inv.address, btc: satsToBtc(inv.sats), sats: inv.sats,
      received: inv.received, pending: inv.pending, status: inv.status,
      createdAt: inv.createdAt, expiresAt: inv.expiresAt, paidAt: inv.paidAt ?? null,
      uri: `bitcoin:${inv.address}?amount=${satsToBtc(inv.sats)}`,
    };
  }
  function credit(inv) {
    const u = usersById.get(inv.uid);
    const p = PACKS[inv.pack];
    if (!u) return;
    settle(u);
    if (p.pixels) u.paid += p.pixels;
    if (p.cap) u.cap = Math.max(u.cap, p.cap);
    store.saveUser(u);
    log.info?.(`invoice ${inv._id}: ${u.name} paid $${inv.usd} for ${inv.pack}`);
  }

  let checking = false;
  async function checkPayments() {
    if (!btc || checking) return;
    checking = true;
    try {
      const t = now();
      const open = invoices.filter((inv) => inv.status !== 'paid' && t - inv.createdAt < WATCH_MS);
      if (!open.length) return;
      const tip = await btc.esplora.tip();
      for (const inv of open) {
        let txs;
        try { txs = await btc.esplora.received(inv.address); } catch (e) { log.warn?.(`payment check ${inv._id}: ${e.message}`); continue; }
        let confirmed = 0, unconfirmed = 0;
        for (const tx of txs) {
          if (tx.height != null && tip - tx.height + 1 >= btc.confirmations) confirmed += tx.sats;
          else unconfirmed += tx.sats;
        }
        const before = `${inv.status}/${inv.received}/${inv.pending}`;
        inv.received = confirmed;
        inv.pending = unconfirmed;
        inv.txids = txs.map((tx) => tx.txid);
        if (confirmed >= inv.sats * PAID_SHARE) {
          inv.status = 'paid';
          inv.paidAt = t;
          credit(inv);
        } else if (confirmed + unconfirmed >= inv.sats * PAID_SHARE) inv.status = 'confirming';
        else if (confirmed + unconfirmed > 0) inv.status = 'underpaid';
        else if (t > inv.expiresAt) inv.status = 'expired';
        if (before !== `${inv.status}/${inv.received}/${inv.pending}`) store.saveInvoice(inv);
      }
    } catch (e) {
      log.warn?.(`payment check: ${e.message}`);
    } finally {
      checking = false;
    }
  }

  // ---- saving ---------------------------------------------------------
  let saving = null;
  function save() {
    saving ||= store.flush(world, seq)
      .catch((e) => log.error?.(`save failed, will retry: ${e.message}`))
      .finally(() => { saving = null; });
    return saving;
  }

  // ---- admin ----------------------------------------------------------
  function userRow(u) {
    const spent = invoices.filter((inv) => inv.uid === u._id && inv.status === 'paid').reduce((s, inv) => s + inv.usd, 0);
    return {
      name: u.name, country: u.country, createdAt: u.createdAt, lastPlacedAt: u.lastPlacedAt ?? null,
      placed: u.placed, free: u.free, paid: u.paid, cap: u.cap, spent,
      admin: !!u.admin, banned: !!u.banned, bannedAt: u.bannedAt ?? null,
    };
  }

  async function stats() {
    const t = now();
    const today = startOfDay(t);
    const paid = invoices.filter((inv) => inv.status === 'paid');
    const sum = (since) => paid.filter((inv) => inv.paidAt >= since).reduce((s, inv) => s + inv.usd, 0);
    const byDay = [];
    for (let k = 13; k >= 0; k--) {
      const from = today - k * DAY;
      const day = paid.filter((inv) => inv.paidAt >= from && inv.paidAt < from + DAY);
      byDay.push({ day: new Date(from).toISOString().slice(0, 10), usd: day.reduce((s, inv) => s + inv.usd, 0), count: day.length });
    }
    const users = [...usersById.values()];
    await save();
    const pixelsToday = await store.col.placements.countDocuments({ at: { $gte: new Date(today) } });
    const online = new Set([...clients.values()].filter(Boolean));
    return {
      now: t,
      online: { viewers: clients.size, players: online.size },
      users: {
        total: users.length,
        today: users.filter((u) => u.createdAt >= today).length,
        week: users.filter((u) => u.createdAt >= t - 7 * DAY).length,
        active24h: users.filter((u) => u.lastPlacedAt >= t - DAY).length,
        banned: users.filter((u) => u.banned).length,
      },
      pixels: { today: pixelsToday, total: seq },
      revenue: {
        today: sum(today), week: sum(t - 7 * DAY), month: sum(t - 30 * DAY), all: sum(0),
        payers: new Set(paid.map((inv) => inv.uid)).size,
        waiting: invoices.filter((inv) => ['open', 'confirming', 'underpaid'].includes(inv.status) && t - inv.createdAt < WATCH_MS).length,
        byDay,
      },
      payments: paid.sort((a, b) => b.paidAt - a.paidAt).slice(0, 15).map((inv) => ({
        user: usersById.get(inv.uid)?.name ?? '?', pack: inv.pack, usd: inv.usd, paidAt: inv.paidAt,
      })),
      countries: world.countries.map((c, k) => ({ code: c.code, name: c.name, pixels: world.count[k + 1], gain: world.count[k + 1] - c.pixels }))
        .sort((a, b) => b.gain - a.gain).slice(0, 8),
      recent: users.sort((a, b) => b.createdAt - a.createdAt).slice(0, 25).map(userRow),
      banned: users.filter((u) => u.banned).sort((a, b) => b.bannedAt - a.bannedAt).map(userRow),
    };
  }

  // Put back what was there before a banned player colored it: the last
  // pixel someone else placed, or the original map.
  async function undoPixelsOf(u) {
    await save();
    const col = store.col.placements;
    const spots = await col.distinct('i', { uid: u._id });
    let undone = 0;
    for (let k = 0; k < spots.length; k += 5000) {
      const chunk = spots.slice(k, k + 5000);
      const history = new Map();
      for await (const p of col.find({ i: { $in: chunk } }, { projection: { i: 1, c: 1, uid: 1 } }).sort({ _id: 1 })) {
        if (!history.has(p.i)) history.set(p.i, []);
        history.get(p.i).push(p);
      }
      for (const [i, list] of history) {
        const last = list.at(-1);
        if (last.uid !== u._id || world.grid[i] !== last.c) continue; // someone has colored over it since
        if (world.count[last.c] <= 1) continue; // every country keeps one pixel
        const before = list.findLast((p) => p.uid !== u._id && p.uid !== 0);
        const c = before ? before.c : world.base[i];
        if (c === world.grid[i]) continue;
        setPixel(i, c, 0);
        undone++;
      }
    }
    return undone;
  }

  // ---- routes ---------------------------------------------------------
  const routes = {
    'GET /api/config': () => ({
      width: world.W, height: world.H, rules: RULES,
      packs: Object.entries(PACKS).map(([key, p]) => ({ key, ...p })),
      payments: !!btc, online: clients.size,
    }),

    'GET /api/me': (req) => {
      const u = userOf(req);
      return { me: u ? me(u) : null };
    },

    'POST /api/signup': async (req, res, body) => {
      const ip = ipOf(req);
      if (signups.blocked(ip)) throw new HttpError(429, 'Too many new accounts from your network. Try again in an hour.');
      const name = String(body.username || '').trim();
      const password = String(body.password || '');
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) throw new HttpError(400, 'Usernames are 3 to 20 letters, numbers or underscores.');
      if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Passwords need at least 8 characters.');
      const country = countryCode(body.country);
      const taken = () => usersByName.has(name.toLowerCase());
      if (taken()) throw new HttpError(409, 'That username is taken.');
      const pass = await hashPassword(password);
      const id = await store.next('nextUserId');
      // Checked again after the awaits, in case the same name came in twice at once.
      if (taken()) throw new HttpError(409, 'That username is taken.');
      const u = {
        _id: id, name, nameLower: name.toLowerCase(), pass, country,
        free: RULES.startPixels, freeAt: now(), paid: 0, cap: RULES.cap, placed: 0,
        admin: false, banned: false, createdAt: now(), ip,
      };
      usersById.set(u._id, u);
      usersByName.set(u.nameLower, u);
      try {
        await store.insertUser(u);
      } catch (e) {
        usersById.delete(u._id);
        usersByName.delete(u.nameLower);
        if (e.code === 11000) throw new HttpError(409, 'That username is taken.');
        throw e;
      }
      signups.hit(ip);
      startSession(res, req, u);
      return { me: me(u) };
    },

    'POST /api/login': async (req, res, body) => {
      const ip = ipOf(req);
      const key = String(body.username || '').trim().toLowerCase().slice(0, 40);
      if (loginsByIp.blocked(ip) || loginsByName.blocked(key)) throw new HttpError(429, 'Too many wrong passwords. Try again in 15 minutes.');
      const u = usersByName.get(key);
      const ok = await checkPassword(String(body.password || ''), u?.pass || DUMMY_HASH);
      if (!u || !ok) {
        loginsByIp.hit(ip);
        loginsByName.hit(key);
        throw new HttpError(401, 'Wrong username or password.');
      }
      if (u.banned) throw new HttpError(403, 'This account has been banned.');
      loginsByName.clear(key);
      startSession(res, req, u);
      return { me: me(u) };
    },

    'POST /api/logout': (req, res) => {
      const token = tokenOf(req);
      if (token && sessions.delete(sha(token))) store.dropSession(sha(token));
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      return { ok: true };
    },

    'POST /api/country': (req, res, body) => {
      const u = needUser(req);
      u.country = countryCode(body.country);
      store.saveUser(u);
      return { me: me(u) };
    },

    'POST /api/place': (req, res, body) => {
      const u = needUser(req);
      const rate = u.admin ? adminPlaceRate : placeRate;
      if (rate.blocked(u._id)) throw new HttpError(429, 'Slow down a little.');
      rate.hit(u._id);
      settle(u);
      if (!u.admin && u.free + u.paid <= 0) throw new HttpError(400, 'You are out of pixels.', { me: me(u) });
      const id = world.idOf.get(u.country);
      const i = body.i;
      const why = world.refuse(id, i);
      if (why) throw new HttpError(400, why, { me: me(u) });
      if (u.admin) {
        // unlimited
      } else if (u.free > 0) {
        if (u.free >= u.cap) u.freeAt = now(); // the timer starts once there is room
        u.free--;
      } else u.paid--;
      u.placed++;
      u.lastPlacedAt = now();
      store.saveUser(u);
      setPixel(i, id, u._id);
      return { seq, me: me(u) };
    },

    'GET /api/pixel': async (req, res, body, url) => {
      const i = Number(url.searchParams.get('i'));
      if (!world.inBounds(i)) throw new HttpError(400, 'That pixel is off the map.');
      const v = world.grid[i];
      const last = await store.col.placements.find({ i }).sort({ _id: -1 }).limit(1).next();
      const by = last && last.c === v && last.uid ? usersById.get(last.uid) : null;
      return {
        country: v ? world.countries[v - 1].code : null,
        original: world.base[i] ? world.countries[world.base[i] - 1].code : null,
        by: by && !by.banned ? by.name : null,
        at: last ? +last.at : null,
      };
    },

    'GET /api/invoices': (req) => {
      const u = needUser(req);
      return { invoices: invoices.filter((inv) => inv.uid === u._id).slice(-20).reverse().map(invoiceView) };
    },

    'POST /api/buy': async (req, res, body) => {
      const u = needUser(req);
      if (!btc) throw new HttpError(503, 'Payments are not set up on this server yet.');
      const pack = PACKS[body.pack] ? body.pack : null;
      if (!pack) throw new HttpError(400, 'Pick a pack.');
      if (PACKS[pack].cap && u.cap >= PACKS[pack].cap) throw new HttpError(400, 'Your storage is already 100 pixels.');
      const t = now();
      const mine = invoices.filter((inv) => inv.uid === u._id && ['open', 'confirming', 'underpaid'].includes(inv.status) && t < inv.expiresAt);
      const same = mine.find((inv) => inv.pack === pack && inv.status === 'open');
      if (same) return { invoice: invoiceView(same) };
      if (mine.length >= 3) throw new HttpError(429, 'You already have 3 payments waiting. Finish or let one expire first.');
      let usd;
      try { usd = await btc.price.get(); } catch { throw new HttpError(503, 'Could not get the bitcoin price right now. Try again in a minute.'); }
      // A fresh address with no history, so an old payment to the same
      // wallet can never count toward this one.
      let index, address;
      for (let tries = 0; ; tries++) {
        index = await store.next('nextAddressIndex');
        address = btc.wallet.address(index);
        let seen;
        try { seen = await btc.esplora.received(address); } catch { throw new HttpError(503, 'Could not reach the Bitcoin network right now. Try again in a minute.'); }
        if (!seen.length) break;
        log.warn?.(`skipping bitcoin address #${index}: it already has payments`);
        if (tries >= 20) throw new HttpError(503, 'Could not find a fresh payment address. Try again later.');
      }
      const inv = {
        _id: randomBytes(6).toString('hex'), uid: u._id, pack, usd: PACKS[pack].usd,
        sats: Math.ceil((PACKS[pack].usd / usd) * 1e8), price: usd,
        address, index,
        createdAt: t, expiresAt: t + QUOTE_MS, status: 'open', received: 0, pending: 0, txids: [],
      };
      await store.insertInvoice(inv);
      invoices.push(inv);
      return { invoice: invoiceView(inv) };
    },

    'GET /api/admin/stats': async (req) => { needAdmin(req); return stats(); },

    'GET /api/admin/users': (req, res, body, url) => {
      needAdmin(req);
      const q = String(url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 40);
      const found = [...usersById.values()].filter((u) => u.nameLower.includes(q))
        .sort((a, b) => (a.nameLower.startsWith(q) ? 0 : 1) - (b.nameLower.startsWith(q) ? 0 : 1) || a.nameLower.localeCompare(b.nameLower));
      return { users: found.slice(0, 50).map(userRow), more: found.length > 50 };
    },

    'POST /api/admin/ban': async (req, res, body) => {
      const admin = needAdmin(req);
      const u = usersByName.get(String(body.username || '').trim().toLowerCase());
      if (!u) throw new HttpError(404, 'No user by that name.');
      if (u.admin) throw new HttpError(400, 'Admins can\'t be banned.');
      if (!u.banned) {
        u.banned = true;
        u.bannedAt = now();
        u.bannedBy = admin.name;
        store.saveUser(u);
        for (const [h, s] of sessions) if (s.uid === u._id) sessions.delete(h);
        store.dropSessionsOf(u._id);
        log.info?.(`${admin.name} banned ${u.name}`);
      }
      const undone = body.undo ? await undoPixelsOf(u) : 0;
      return { user: userRow(u), undone };
    },

    'POST /api/admin/unban': (req, res, body) => {
      const admin = needAdmin(req);
      const u = usersByName.get(String(body.username || '').trim().toLowerCase());
      if (!u) throw new HttpError(404, 'No user by that name.');
      u.banned = false;
      u.bannedAt = null;
      store.saveUser(u);
      log.info?.(`${admin.name} unbanned ${u.name}`);
      return { user: userRow(u) };
    },
  };

  // ---- http -----------------------------------------------------------
  const staticCache = new Map();
  async function serveStatic(req, res, path) {
    if (path === '/') path = '/index.html';
    if (path === '/admin') path = '/admin.html';
    let file;
    if (path === '/countries.json' || path === '/world.bin.gz') file = join(mapDir, path.slice(1));
    else {
      try { file = normalize(join(publicDir, decodeURIComponent(path))); } catch { throw new HttpError(404, 'Not found'); }
      if (!file.startsWith(publicDir + sep)) throw new HttpError(404, 'Not found');
    }
    if (!TYPES[extname(file)]) file = join(publicDir, 'index.html');
    let entry = staticCache.get(file);
    if (!entry) {
      let body;
      try { body = await readFile(file); } catch { throw new HttpError(404, 'Not found'); }
      const type = TYPES[extname(file)];
      entry = { body, type, gz: /text|json|svg/.test(type) ? await gzip(body) : null };
      if (staticCache.size < 100) staticCache.set(file, entry);
    }
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Cache-Control', /flags\.png$|world\.bin\.gz$/.test(file) ? 'public, max-age=86400' : 'no-cache');
    if (entry.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.end(req.method === 'HEAD' ? undefined : entry.gz);
    } else res.end(req.method === 'HEAD' ? undefined : entry.body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 8192) { reject(new HttpError(413, 'Too much data.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new HttpError(400, 'Bad JSON.')); }
      });
      req.on('error', reject);
    });
  }

  function events(req, res, url) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const since = Number(url.searchParams.get('since'));
    if (!Number.isInteger(since) || since < logStart - 1 || since > seq) res.write('data: {"reload":true}\n\n');
    else if (since < seq) {
      const from = (since + 1 - logStart) * 2;
      res.write(`data: ${JSON.stringify({ s: seq - pending.length / 2, p: placements.slice(from, placements.length - pending.length) })}\n\n`);
    }
    clients.set(res, userOf(req)?._id || 0);
    res.write(`data: ${JSON.stringify({ online: clients.size })}\n\n`);
    req.on('close', () => clients.delete(res));
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (path === '/api/events' && req.method === 'GET') return events(req, res, url);
      if (path === '/api/world' && req.method === 'GET') {
        const snap = await worldSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'gzip', 'Cache-Control': 'no-store', 'X-Seq': String(snap.seq) });
        return res.end(snap.body);
      }
      const route = routes[`${req.method} ${path}`];
      if (route) {
        let body = {};
        if (req.method === 'POST') {
          // Only same-site pages can post: browsers send Origin on
          // cross-site posts, and can't send JSON cross-site without it.
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request refused.');
          if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send JSON.');
          body = await readBody(req);
        }
        const out = await route(req, res, body, url);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(out));
      }
      if (path.startsWith('/api/')) throw new HttpError(404, 'Not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      return await serveStatic(req, res, path);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) log.error?.(e);
      if (res.headersSent) return res.end();
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: status === 500 ? 'Something went wrong on our side.' : e.message, ...(e.extra || {}) }));
    }
  });

  // ---- housekeeping ---------------------------------------------------
  const saveTimer = setInterval(save, 1000);
  const sessionTimer = setInterval(() => {
    const t = now();
    for (const [h, s] of sessions) if (s.exp < t) sessions.delete(h);
  }, 3600_000);
  const payTimer = btc ? setInterval(checkPayments, btc.pollMs || 30_000) : null;

  return {
    server,
    world,
    store,
    checkPayments,
    save,
    async close() {
      for (const t of [flushTimer, pingTimer, saveTimer, sessionTimer, payTimer]) if (t) clearInterval(t);
      for (const c of clients.keys()) c.end();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await saving;
      await store.close(world, seq);
    },
  };
}
