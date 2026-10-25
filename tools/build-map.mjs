// Turns Natural Earth country and lake shapes into the WorldPixel grid.
// Run once; the server only reads the output (map/world.bin.gz and
// map/countries.json).
//
//   node tools/build-map.mjs ne_10m_admin_0_countries.geojson ne_50m_lakes.geojson
//
// The grid is a flat equirectangular map, 4800 x 2400, so one pixel is
// 0.075 degrees (about 8 km at the equator). Cell value 0 is water, and
// 1..N is the country at countries[value - 1].
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [countriesPath, lakesPath] = process.argv.slice(2);
if (!countriesPath || !lakesPath) {
  console.error('usage: node tools/build-map.mjs <ne_10m_admin_0_countries.geojson> <ne_50m_lakes.geojson>');
  process.exit(1);
}
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'map');
const W = 4800, H = 2400, D = 360 / W;
const FILL = 255; // land with no country of its own; takes its neighbours' country

// Areas Natural Earth keeps apart that have no flag of their own.
const MERGE = { SOL: 'SO', CYN: 'CY', CNM: 'CY', ESB: 'CY', WSB: 'CY', USG: 'CU' };
const TO_NEIGHBOUR = new Set(['KAS', 'SPI', 'BRT']); // Siachen, Patagonian ice field, Bir Tawil
const DROP = new Set(['PGA', 'BJN', 'SER', 'SCR']); // reefs and sandbanks
const RENAME = { US: 'United States' };

const polygonsOf = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates);

function bbox(rings) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const r of rings) for (const [x, y] of r) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return [a, b, c, d];
}

// Even-odd scanline fill at pixel centres. Returns how many cells it set.
function fill(grid, rings, value) {
  const edges = [];
  for (const r of rings) {
    for (let i = 0; i < r.length - 1; i++) {
      const [x1, y1] = r[i], [x2, y2] = r[i + 1];
      if (y1 !== y2) edges.push([x1, y1, x2, y2]);
    }
  }
  const [, minLat, , maxLat] = bbox(rings);
  const top = Math.max(0, Math.floor((90 - maxLat) / D - 0.5));
  const bottom = Math.min(H - 1, Math.ceil((90 - minLat) / D - 0.5));
  let set = 0;
  for (let row = top; row <= bottom; row++) {
    const lat = 90 - (row + 0.5) * D;
    const xs = [];
    for (const [x1, y1, x2, y2] of edges) {
      if ((y1 <= lat && y2 > lat) || (y2 <= lat && y1 > lat)) xs.push(x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] + 180) / D - 0.5));
      const to = Math.min(W - 1, Math.floor((xs[k + 1] + 180) / D - 0.5));
      for (let col = from; col <= to; col++) { grid[row * W + col] = value; set++; }
    }
  }
  return set;
}

function centreCell(rings) {
  const [a, b, c, d] = bbox(rings);
  const col = Math.min(W - 1, Math.max(0, Math.floor(((a + c) / 2 + 180) / D)));
  const row = Math.min(H - 1, Math.max(0, Math.floor((90 - (b + d) / 2) / D)));
  return row * W + col;
}

const geo = JSON.parse(readFileSync(countriesPath, 'utf8'));
const countries = [];
const idOf = new Map();
const shapes = []; // { id, rings, area }
for (const f of geo.features) {
  const p = f.properties;
  if (DROP.has(p.ADM0_A3)) continue;
  let code = MERGE[p.ADM0_A3] || (TO_NEIGHBOUR.has(p.ADM0_A3) ? null : p.ISO_A2_EH);
  let id = FILL;
  if (code) {
    if (code === '-99') throw new Error(`no code for ${p.NAME} (${p.ADM0_A3})`);
    if (!idOf.has(code)) {
      countries.push({ code, name: null });
      idOf.set(code, countries.length);
    }
    id = idOf.get(code);
  }
  let area = 0;
  for (const rings of polygonsOf(f.geometry)) {
    const [a, b, c, d] = bbox(rings);
    area += (c - a) * (d - b);
    shapes.push({ id, rings, area: (c - a) * (d - b) });
  }
  // Several features can share a code (France and Clipperton); the
  // country takes the name of the biggest one that isn't a merged area.
  const c = countries[id - 1];
  if (c && !MERGE[p.ADM0_A3] && area > (c.nameArea || -1)) { c.name = RENAME[code] || p.ADMIN; c.nameArea = area; }
}
if (countries.length >= FILL) throw new Error('too many countries for one byte per cell');

const grid = new Uint8Array(W * H);
// Big shapes first so enclaves drawn later sit on top of them.
shapes.sort((a, b) => b.area - a.area);
for (const s of shapes) s.cells = fill(grid, s.rings, s.id);

for (const f of JSON.parse(readFileSync(lakesPath, 'utf8')).features) {
  for (const rings of polygonsOf(f.geometry)) fill(grid, rings, 0);
}

// Land that belongs to no flag goes to whichever country surrounds it.
for (let pass = 0, left = Infinity; left > 0 && pass < 500; pass++) {
  left = 0;
  const next = grid.slice();
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== FILL) continue;
    const x = i % W, y = (i - x) / W;
    const votes = new Map();
    for (const j of [y * W + ((x + W - 1) % W), y * W + ((x + 1) % W), y > 0 ? i - W : -1, y < H - 1 ? i + W : -1]) {
      const v = j >= 0 ? grid[j] : 0;
      if (v && v !== FILL) votes.set(v, (votes.get(v) || 0) + 1);
    }
    if (votes.size) next[i] = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    else left++;
  }
  grid.set(next);
}
for (let i = 0; i < grid.length; i++) if (grid[i] === FILL) grid[i] = 0;

// Islands smaller than a pixel still show up as one pixel, and every
// country gets at least one, so Monaco and Tuvalu are on the map.
for (const s of shapes) {
  if (s.cells === 0 && s.id !== FILL) {
    const i = centreCell(s.rings);
    if (grid[i] === 0) grid[i] = s.id;
  }
}
const count = new Uint32Array(countries.length + 1);
for (const v of grid) count[v]++;
for (let id = 1; id <= countries.length; id++) {
  if (count[id]) continue;
  const biggest = shapes.filter((s) => s.id === id).sort((a, b) => b.area - a.area)[0];
  const i = centreCell(biggest.rings);
  count[grid[i]]--; grid[i] = id; count[id]++;
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'world.bin.gz'), gzipSync(grid, { level: 9 }));
writeFileSync(join(OUT, 'countries.json'), JSON.stringify(
  { width: W, height: H, countries: countries.map((c, k) => ({ code: c.code, name: c.name, pixels: count[k + 1] })) },
  null, 1,
));
const small = countries.map((c, k) => [c.name, count[k + 1]]).sort((a, b) => a[1] - b[1]);
console.log(`${countries.length} countries, ${count[0]} water cells`);
console.log('smallest:', small.slice(0, 12).map(([n, k]) => `${n} ${k}`).join(', '));
console.log('largest:', small.slice(-5).map(([n, k]) => `${n} ${k}`).join(', '));
