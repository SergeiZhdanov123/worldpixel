// A throwaway MongoDB for tests: a one-node replica set (transactions need
// one) in a temp folder, started at most once per process and removed on
// exit. Set TEST_MONGODB_URI to use an existing server instead.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

let started = null;

export function testMongo() {
  if (process.env.TEST_MONGODB_URI) return Promise.resolve(process.env.TEST_MONGODB_URI);
  started ??= (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mongo-'));
    const port = await freePort();
    const proc = spawn(process.env.MONGOD_PATH || 'mongod', [
      '--replSet', 'rs0', '--port', String(port), '--bind_ip', '127.0.0.1', '--dbpath', dir,
      '--quiet', '--wiredTigerCacheSizeGB', '0.25', '--setParameter', 'diagnosticDataCollectionEnabled=false',
    ], { stdio: 'ignore' });
    proc.unref(); // don't keep the test process alive; it is killed on exit
    let exited = false;
    proc.on('error', () => { exited = true; });
    proc.on('exit', () => { exited = true; });
    const cleanup = () => {
      try { proc.kill('SIGKILL'); } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    };
    process.on('exit', cleanup);
    // A cancelled or timed-out test file is stopped with a signal, which
    // skips 'exit' handlers.
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { cleanup(); process.exit(130); });

    const direct = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 500 });
    for (let i = 0; ; i++) {
      if (exited) throw new Error('mongod failed to start (is it installed? brew install mongodb-community, or set TEST_MONGODB_URI)');
      try {
        await direct.connect();
        await direct.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } })
          .catch((e) => { if (e.codeName !== 'AlreadyInitialized') throw e; });
        while (!(await direct.db('admin').command({ hello: 1 })).isWritablePrimary) await sleep(100);
        break;
      } catch (e) {
        if (i > 150) throw e;
        await sleep(100);
      }
    }
    await direct.close();
    return `mongodb://127.0.0.1:${port}/?replicaSet=rs0&directConnection=true`;
  })();
  return started;
}

export const testDbName = (tag = 't') => `wp_${tag}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

// Remove a test database (only matters with TEST_MONGODB_URI; the temp
// server is deleted on exit anyway).
export async function dropDb(uri, name) {
  if (!process.env.TEST_MONGODB_URI) return;
  const c = new MongoClient(uri);
  await c.connect();
  await c.db(name).dropDatabase();
  await c.close();
}
