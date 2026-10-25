// Watch-only Bitcoin. Payment addresses come from the site's extended
// public key (the "master public key" Electrum shows), so the server can
// make addresses and see payments but can never spend anything. Plain
// node:crypto and BigInt, no packages.
import { createECDH, createHash, createHmac } from 'node:crypto';

const P = 2n ** 256n - 2n ** 32n - 977n; // secp256k1 field prime
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

// SLIP-132 version bytes say which kind of address a key makes. Electrum's
// default wallet (native segwit) exports a zpub.
const PREFIXES = {
  xpub: { version: 0x0488b21e, net: 'main', type: 'p2pkh' },
  ypub: { version: 0x049d7cb2, net: 'main', type: 'p2sh-p2wpkh' },
  zpub: { version: 0x04b24746, net: 'main', type: 'p2wpkh' },
  tpub: { version: 0x043587cf, net: 'test', type: 'p2pkh' },
  upub: { version: 0x044a5262, net: 'test', type: 'p2sh-p2wpkh' },
  vpub: { version: 0x045f1cf6, net: 'test', type: 'p2wpkh' },
};
const NET = { main: { hrp: 'bc', p2pkh: 0x00, p2sh: 0x05 }, test: { hrp: 'tb', p2pkh: 0x6f, p2sh: 0xc4 } };

const sha256 = (b) => createHash('sha256').update(b).digest();
const hash160 = (b) => createHash('ripemd160').update(sha256(b)).digest();

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58checkEncode(payload) {
  const buf = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let n = BigInt('0x' + (buf.toString('hex') || '0'));
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = '1' + s; }
  return s;
}
function b58checkDecode(s) {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('bad base58 character');
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lead = s.match(/^1*/)[0].length;
  const buf = Buffer.concat([Buffer.alloc(lead), Buffer.from(n ? hex : '', 'hex')]);
  const payload = buf.subarray(0, -4);
  if (!sha256(sha256(payload)).subarray(0, 4).equals(buf.subarray(-4))) throw new Error('bad checksum');
  return payload;
}

const BECH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= G[i];
  }
  return chk;
}
function segwitAddress(hrp, version, program) {
  const words = [version];
  let acc = 0, bits = 0;
  for (const b of program) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...exp, ...words, 0, 0, 0, 0, 0, 0]) ^ 1; // bech32, for version 0
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + '1' + [...words, ...check].map((w) => BECH[w]).join('');
}

const mod = (a, m = P) => ((a % m) + m) % m;
function inv(a, m = P) {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
  return mod(s0, m);
}
function powmod(b, e, m = P) {
  let r = 1n; b = mod(b, m);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r;
}
const toBig = (buf) => BigInt('0x' + buf.toString('hex'));
const to32 = (n) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

function decompress(pub) {
  const x = toBig(pub.subarray(1));
  let y = powmod(mod(x * x * x + 7n), (P + 1n) / 4n);
  if ((y & 1n) !== BigInt(pub[0] & 1)) y = P - y;
  return { x, y };
}
const compress = ({ x, y }) => Buffer.concat([Buffer.from([y & 1n ? 3 : 2]), to32(x)]);
function add(a, b) {
  if (a.x === b.x) throw new Error('point doubling is not expected here');
  const l = mod((b.y - a.y) * inv(b.x - a.x));
  const x = mod(l * l - a.x - b.x);
  return { x, y: mod(l * (a.x - x) - a.y) };
}

// BIP32 public child derivation (no hardened children, there's no
// private key to make them with).
function child({ key, chain }, index) {
  const I = createHmac('sha512', chain).update(Buffer.concat([key, Buffer.from([index >>> 24, (index >>> 16) & 255, (index >>> 8) & 255, index & 255])])).digest();
  const IL = I.subarray(0, 32);
  if (toBig(IL) >= N || toBig(IL) === 0n) throw new Error('invalid child, try the next index');
  const tweak = decompress(publicKeyOf(IL));
  return { key: compress(add(tweak, decompress(key))), chain: I.subarray(32) };
}
// IL times the generator point; OpenSSL does the scalar multiplication.
function publicKeyOf(priv) {
  const e = createECDH('secp256k1');
  e.setPrivateKey(priv);
  return e.getPublicKey(null, 'compressed');
}

export class BtcError extends Error {}

// Addresses on the receive chain (…/0/i), numbered the way Electrum and
// other wallets number them.
export function btcWallet(xpub) {
  const s = String(xpub || '').trim();
  const p = PREFIXES[s.slice(0, 4)];
  if (!p) throw new BtcError('BTC_XPUB must start with zpub, xpub or ypub (vpub, tpub or upub for testnet)');
  let receive;
  try {
    const raw = b58checkDecode(s);
    if (raw.length !== 78 || raw.readUInt32BE(0) !== p.version) throw new Error('wrong length or version');
    receive = child({ chain: raw.subarray(13, 45), key: raw.subarray(45, 78) }, 0);
  } catch (e) {
    throw new BtcError(`BTC_XPUB is not a valid extended public key (${e.message})`);
  }
  const net = NET[p.net];
  return {
    net: p.net,
    address(index) {
      const h = hash160(child(receive, index).key);
      if (p.type === 'p2wpkh') return segwitAddress(net.hrp, 0, h);
      if (p.type === 'p2pkh') return b58checkEncode(Buffer.concat([Buffer.from([net.p2pkh]), h]));
      return b58checkEncode(Buffer.concat([Buffer.from([net.p2sh]), hash160(Buffer.concat([Buffer.from([0x00, 0x14]), h]))]));
    },
  };
}

async function getJson(url, timeoutMs = 15_000) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new BtcError(`${new URL(url).host} unreachable: ${e.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new BtcError(`${new URL(url).host} HTTP ${res.status}: ${text.slice(0, 120)}`);
  try { return JSON.parse(text); } catch { throw new BtcError(`${new URL(url).host} sent something that isn't JSON`); }
}

// Esplora API (mempool.space, blockstream.info). Each call tries the next
// server if one fails.
export function esplora(bases) {
  async function get(path) {
    let last;
    for (const base of bases) {
      try { return await getJson(base + path); } catch (e) { last = e; }
    }
    throw last;
  }
  return {
    tip: async () => Number(await get('/blocks/tip/height')),
    // Payments to one address: [{ txid, sats, height|null }].
    async received(address) {
      const txs = await get(`/address/${encodeURIComponent(address)}/txs`);
      const out = [];
      for (const t of txs) {
        const sats = t.vout.filter((o) => o.scriptpubkey_address === address).reduce((s, o) => s + o.value, 0);
        if (sats > 0) out.push({ txid: t.txid, sats, height: t.status?.confirmed ? t.status.block_height : null });
      }
      return out;
    },
  };
}

// Dollar price of bitcoin from the first source that answers. Understands
// mempool.space ({ USD }) and Coinbase ({ data: { amount } }).
export function btcPrice(urls) {
  let cached = null;
  return {
    async get() {
      if (cached && Date.now() - cached.at < 60_000) return cached.usd;
      let last;
      for (const url of urls) {
        try {
          const j = await getJson(url);
          const usd = Number(j.USD ?? j.data?.amount);
          if (!(usd > 0)) throw new BtcError(`no price from ${new URL(url).host}`);
          cached = { usd, at: Date.now() };
          return usd;
        } catch (e) { last = e; }
      }
      throw last;
    },
  };
}

export const satsToBtc = (sats) => (Number(sats) / 1e8).toFixed(8);
