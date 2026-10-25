// MongoDB storage. The server keeps users, sessions, payments and the
// map in memory and writes changes back in the background:
//
//   users, sessions, invoices  one document each
//   placements                 every colored pixel, in order (_id = seq)
//   world                      the map in 24 slices of 100 rows, rewritten
//                              when they change
//   meta                       counters, and the seq the saved map is at
//
// On start the saved map is loaded and any placements after it are
// replayed, so a crash loses at most the last second of clicks.
import { Binary, MongoClient } from 'mongodb';

const ROWS_PER_SLICE = 100;

export async function openStore({ uri, dbName, width, height, base, log = console }) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  const db = client.db(dbName);
  const col = {
    users: db.collection('users'),
    sessions: db.collection('sessions'),
    invoices: db.collection('invoices'),
    placements: db.collection('placements'),
    world: db.collection('world'),
    meta: db.collection('meta'),
  };
  await Promise.all([
    col.users.createIndex({ nameLower: 1 }, { unique: true }),
    col.sessions.createIndex({ exp: 1 }, { expireAfterSeconds: 0 }),
    col.invoices.createIndex({ uid: 1 }),
    col.placements.createIndex({ i: 1, _id: -1 }),
    col.placements.createIndex({ uid: 1 }),
    col.placements.createIndex({ at: 1 }),
  ]);

  await col.meta.updateOne({ _id: 'meta' }, { $setOnInsert: { nextUserId: 1, nextAddressIndex: 0, worldSeq: 0 } }, { upsert: true });
  const meta = await col.meta.findOne({ _id: 'meta' });

  // The map: saved slices over the original, then later placements.
  const grid = base.slice();
  const sliceBytes = width * ROWS_PER_SLICE;
  for await (const s of col.world.find()) {
    const bytes = s.data.buffer;
    if (bytes.length === sliceBytes || s._id * sliceBytes + bytes.length === grid.length) grid.set(bytes, s._id * sliceBytes);
  }
  let seq = meta.worldSeq;
  let replayed = 0;
  for await (const p of col.placements.find({ _id: { $gt: meta.worldSeq } }).sort({ _id: 1 })) {
    grid[p.i] = p.c;
    seq = p._id;
    replayed++;
  }
  if (replayed) log.info?.(`replayed ${replayed} placement(s) since the last map save`);

  const users = await col.users.find().toArray();
  const sessions = await col.sessions.find({ exp: { $gt: new Date() } }).toArray();
  const invoices = await col.invoices.find().toArray();

  // Writes waiting for the next flush.
  const dirtyUsers = new Set();
  const dirtyInvoices = new Set();
  let newPlacements = [];
  const dirtySlices = new Set();

  const bg = (p, what) => p.catch((e) => log.error?.(`mongo ${what}: ${e.message}`));

  // Duplicate-key errors mean a retried write already landed.
  const onlyDuplicates = (e) => e.code === 11000 || (e.writeErrors?.length && [].concat(e.writeErrors).every((w) => w.code === 11000));

  // Anything that fails to save goes back in the queue for the next try.
  async function flush(world, currentSeq) {
    const jobs = [];
    if (dirtyUsers.size) {
      const list = [...dirtyUsers];
      dirtyUsers.clear();
      jobs.push(col.users.bulkWrite(list.map((u) => ({ replaceOne: { filter: { _id: u._id }, replacement: u, upsert: true } })), { ordered: false })
        .catch((e) => { for (const u of list) dirtyUsers.add(u); throw e; }));
    }
    if (dirtyInvoices.size) {
      const list = [...dirtyInvoices];
      dirtyInvoices.clear();
      jobs.push(col.invoices.bulkWrite(list.map((inv) => ({ replaceOne: { filter: { _id: inv._id }, replacement: inv, upsert: true } })), { ordered: false })
        .catch((e) => { for (const inv of list) dirtyInvoices.add(inv); throw e; }));
    }
    if (newPlacements.length) {
      const docs = newPlacements;
      newPlacements = [];
      jobs.push(col.placements.insertMany(docs, { ordered: false })
        .catch((e) => { if (!onlyDuplicates(e)) { newPlacements = docs.concat(newPlacements); throw e; } }));
    }
    const results = await Promise.allSettled(jobs);
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;
    if (world && dirtySlices.size) {
      // Copy every changed slice at the same moment, then save them and
      // the seq they're at.
      const ks = [...dirtySlices];
      dirtySlices.clear();
      const slices = ks.map((k) => ({ k, data: Buffer.from(world.grid.subarray(k * sliceBytes, (k + 1) * sliceBytes)) }));
      try {
        await Promise.all(slices.map(({ k, data }) => col.world.replaceOne({ _id: k }, { _id: k, data: new Binary(data) }, { upsert: true })));
        await col.meta.updateOne({ _id: 'meta' }, { $set: { worldSeq: currentSeq } });
      } catch (e) {
        for (const k of ks) dirtySlices.add(k);
        throw e;
      }
    }
  }

  return {
    grid,
    seq,
    users,
    sessions,
    invoices,
    col,
    // Counters are saved before they're used, so an address or user id
    // is never handed out twice, even across a crash.
    // Never hand out a counter value below n (e.g. addresses another
    // site already used from the same wallet).
    async atLeast(name, n) { await col.meta.updateOne({ _id: 'meta' }, { $max: { [name]: n } }); },
    async next(name) {
      const r = await col.meta.findOneAndUpdate({ _id: 'meta' }, { $inc: { [name]: 1 } }, { returnDocument: 'before' });
      return r[name];
    },
    async insertUser(u) { await col.users.insertOne(u); },
    saveUser(u) { dirtyUsers.add(u); },
    markSlice(i) { dirtySlices.add(Math.floor(i / sliceBytes)); },
    saveInvoice(inv) { dirtyInvoices.add(inv); },
    async insertInvoice(inv) { await col.invoices.insertOne(inv); },
    addSession(hash, uid, exp) { bg(col.sessions.insertOne({ _id: hash, uid, exp: new Date(exp) }), 'session'); },
    dropSession(hash) { bg(col.sessions.deleteOne({ _id: hash }), 'session'); },
    dropSessionsOf(uid) { bg(col.sessions.deleteMany({ uid }), 'sessions'); },
    placed(doc, i) {
      newPlacements.push(doc);
      dirtySlices.add(Math.floor(i / sliceBytes));
    },
    flush,
    async close(world, currentSeq) {
      await flush(world, currentSeq);
      await client.close();
    },
  };
}
