# WorldPixel

A world map you color in, one pixel at a time. Every player picks a country.
Each country is painted with its own flag, stretched over whatever shape it has
right now, so the flag grows as the country does.

## Running it

```
npm install
node server.js
```

It needs a MongoDB connection string. Put settings in a `.env` file next to
`server.js` (see `.env.example`) or in the environment:

| Variable | What it does |
|---|---|
| `MONGODB_URI` | **Required.** MongoDB connection string (Atlas or local). |
| `MONGODB_DB` | Database name. Default `worldpixel`. |
| `PORT` | Default 3000. |
| `BTC_XPUB` | Your Bitcoin wallet's master public key (zpub/xpub/ypub). Without it, buying is switched off. |
| `BTC_CONFIRMATIONS` | Confirmations before pixels are credited. Default 1. |
| `BTC_POLL_SECONDS` | How often payments are checked. Default 30. |
| `TRUST_PROXY` | Set to `1` on Render (or behind any one proxy) so rate limits see real visitor addresses. |
| `ESPLORA_URLS`, `BTC_PRICE_URLS` | Override the block explorers and price sources (comma separated). |

On start it prints the first Bitcoin address it will hand out. Check that it
matches the first receiving address in your wallet before taking real money.

## Admins

```
ADMIN_PASSWORD='...' npm run make-admin -- <username> [country code]
```

Creates the account (or turns an existing one into an admin, and resets its
password if `ADMIN_PASSWORD` is set). Restart the server afterwards. Admins have
unlimited pixels, and `/admin` shows who's online, signups, pixels colored,
revenue per day, recent payments, and lets you ban or unban players. Banning
logs them out, keeps their name taken, and can put back every pixel they
colored.

## The rules

- Sign up with a username and password and pick a country. You can switch later.
- You start with 5 pixels and get 1 more every 5 minutes, stored up to 10.
- You can color any pixel (land, ocean or someone else's country) that shares
  an edge with your country. The map wraps at the date line.
- A country that loses every pixel can restart anywhere on its original land.
- Bought with Bitcoin: 6 pixels for $5, 15 for $10, 40 for $20, 180 for $50.
  Bought pixels never expire and sit on top of the 10-pixel storage. Free
  pixels are spent first.
- Storage upgrade, $10: free pixels pile up to 100 instead of 10.

## Payments

The server only ever holds the wallet's *public* key. Each purchase gets a
fresh address from it, the price is quoted in BTC for 30 minutes, and payments
are read from mempool.space / blockstream.info. A payment within 2% of the
quote counts as full; a short payment waits for the rest at the same address;
late payments are still credited for 7 days. Because every purchase uses a new
address, raise Electrum's gap limit so it sees them all: in Electrum's console,
`wallet.change_gap_limit(500)`.

## How the map is stored

The map is 4800 × 2400 pixels, equirectangular, one byte per pixel (0 is water,
1–239 a country). In MongoDB:

- `users`, `sessions`, `invoices`: one document each
- `placements`: every colored pixel in order, which also says who colored what
- `world`: the map in 24 slices, rewritten when they change
- `meta`: id counters and how far the saved map has got

Changes are written every second; on start the server loads the saved map
and replays any placements after it.

## Rebuilding the map or flags

`map/` and `public/flags.png` are generated and checked in. To rebuild them:

```
node tools/build-map.mjs ne_10m_admin_0_countries.geojson ne_50m_lakes.geojson
node tools/build-flags.mjs <flag-icons>/flags/4x3 <playwright>/index.mjs
```

Country shapes and lakes are from [Natural Earth](https://www.naturalearthdata.com/)
(public domain). Flags are from [flag-icons](https://github.com/lipis/flag-icons)
(MIT). The QR code library in `public/vendor/qrcode.js` is Kazuhiko Arase's
qrcode-generator (MIT).

## Tests

```
npm test
```

They start a throwaway `mongod` (install with `brew install mongodb-community`),
or use `TEST_MONGODB_URI` if set.
