// node server.js
//
// Settings come from environment variables (or a .env file next to this
// one): see README.md. MONGODB_URI is the only one it can't run without;
// with no BTC_XPUB, buying is switched off.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { btcPrice, btcWallet, esplora } from './src/btc.js';

const ROOT = dirname(fileURLToPath(import.meta.url));

// A minimal .env reader: KEY=value lines, # comments.
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const env = process.env;
if (!env.MONGODB_URI) {
  console.error('Set MONGODB_URI to your MongoDB connection string (in .env or the environment).');
  process.exit(1);
}

let btc = null;
if (env.BTC_XPUB) {
  const wallet = btcWallet(env.BTC_XPUB);
  const defaults = wallet.net === 'main'
    ? 'https://mempool.space/api,https://blockstream.info/api'
    : 'https://mempool.space/testnet/api,https://blockstream.info/testnet/api';
  btc = {
    wallet,
    esplora: esplora((env.ESPLORA_URLS || defaults).split(',').map((s) => s.trim()).filter(Boolean)),
    price: btcPrice((env.BTC_PRICE_URLS || 'https://mempool.space/api/v1/prices,https://api.coinbase.com/v2/prices/BTC-USD/spot').split(',').map((s) => s.trim())),
    confirmations: Math.max(0, Number(env.BTC_CONFIRMATIONS ?? 1)),
    pollMs: Math.max(5, Number(env.BTC_POLL_SECONDS ?? 30)) * 1000,
    startIndex: Math.max(0, Number(env.BTC_START_INDEX || 0)),
  };
  console.log(`Bitcoin payments on (${wallet.net}net). Address #0 of this wallet: ${wallet.address(0)}`);
  console.log('  Check that it matches the first receiving address in your wallet.');
} else {
  console.log('Bitcoin payments off: set BTC_XPUB to your wallet\'s master public key to sell pixels.');
}

const app = await createApp({
  mongoUri: env.MONGODB_URI,
  dbName: env.MONGODB_DB || 'worldpixel',
  mapDir: join(ROOT, 'map'),
  publicDir: join(ROOT, 'public'),
  btc,
  trustProxy: Number(env.TRUST_PROXY || 0),
});

const port = Number(env.PORT || 3000);
app.server.listen(port, env.HOST || undefined, () => {
  console.log(`WorldPixel on http://localhost:${port}`);
});

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    console.log('Saving and stopping…');
    await app.close();
    process.exit(0);
  });
}
