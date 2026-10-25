// The map: one byte per pixel, 0 for water and 1..N for the country at
// countries[value - 1]. The left and right edges meet, like the real
// globe, so Russia can grow across the date line into Alaska.
//
// Water can't be colored. Countries grow over land that touches them, and
// reach other continents by sea: a country with a coastline can land on
// any other country's coastline.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

// Bodies of water at least this many pixels count as sea (oceans, the
// Mediterranean, the Black and Caspian Seas); smaller lakes don't.
export const SEA_MIN = 5000;

export function loadBaseMap(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'countries.json'), 'utf8'));
  const base = new Uint8Array(gunzipSync(readFileSync(join(dir, 'world.bin.gz'))));
  if (base.length !== meta.width * meta.height) throw new Error('map/world.bin.gz does not match map/countries.json');
  return { ...meta, base };
}

// 1 for every land pixel that touches sea.
export function coastline(grid, W, H) {
  const N = grid.length;
  const sea = new Uint8Array(N);
  const seen = new Uint8Array(N);
  let queue = new Int32Array(1 << 20);
  for (let s = 0; s < N; s++) {
    if (grid[s] || seen[s]) continue;
    let n = 0, head = 0;
    queue[n++] = s;
    seen[s] = 1;
    while (head < n) {
      const i = queue[head++];
      const x = i % W;
      const near = [x ? i - 1 : i + W - 1, x < W - 1 ? i + 1 : i - W + 1, i >= W ? i - W : -1, i < N - W ? i + W : -1];
      for (const j of near) {
        if (j < 0 || grid[j] || seen[j]) continue;
        seen[j] = 1;
        if (n === queue.length) { const q = new Int32Array(queue.length * 2); q.set(queue); queue = q; }
        queue[n++] = j;
      }
    }
    if (n >= SEA_MIN) for (let k = 0; k < n; k++) sea[queue[k]] = 1;
  }
  const coast = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (!grid[i]) continue;
    const x = i % W;
    if (sea[x ? i - 1 : i + W - 1] || sea[x < W - 1 ? i + 1 : i - W + 1] || (i >= W && sea[i - W]) || (i < N - W && sea[i + W])) coast[i] = 1;
  }
  return coast;
}

export class World {
  constructor({ width, height, countries, base }, grid = base.slice()) {
    this.W = width;
    this.H = height;
    this.countries = countries;
    this.base = base;
    this.grid = grid;
    this.idOf = new Map(countries.map((c, k) => [c.code, k + 1]));
    this.coast = coastline(grid, width, height);
    this.count = new Uint32Array(countries.length + 1);
    this.coastCount = new Uint32Array(countries.length + 1);
    for (let i = 0; i < grid.length; i++) {
      this.count[grid[i]]++;
      this.coastCount[grid[i]] += this.coast[i];
    }
  }

  inBounds(i) { return Number.isInteger(i) && i >= 0 && i < this.grid.length; }

  // The four pixels sharing an edge with i.
  neighbours(i) {
    const { W, H } = this;
    const x = i % W, y = (i - x) / W;
    const out = [y * W + ((x + W - 1) % W), y * W + ((x + 1) % W)];
    if (y > 0) out.push(i - W);
    if (y < H - 1) out.push(i + W);
    return out;
  }

  borders(id, i) { return this.neighbours(i).some((j) => this.grid[j] === id); }

  // Why a country can't take pixel i, or null if it can. Every country
  // keeps at least one pixel: its last one can't be taken. (A country
  // with none, from an older map, may start again on its original land.)
  refuse(id, i) {
    if (!this.inBounds(i)) return 'That pixel is off the map.';
    const owner = this.grid[i];
    if (!owner) return 'Water can\'t be colored. Land on a coast instead.';
    if (owner === id) return 'That pixel is already yours.';
    if (this.count[owner] <= 1) return `That is ${this.countries[owner - 1].name}'s last pixel. Every country keeps at least one.`;
    if (this.borders(id, i)) return null;
    if (this.count[id] === 0 && this.base[i] === id) return null;
    if (this.coast[i] && this.coastCount[id] > 0) return null; // landing from the sea
    const name = this.countries[id - 1].name;
    if (this.coast[i]) return `${name} has no coastline, so it can only grow over land that touches it.`;
    return `You can only color land touching ${name}, or a coast anywhere.`;
  }

  set(i, id) {
    const old = this.grid[i];
    this.count[old]--;
    this.coastCount[old] -= this.coast[i];
    this.count[id]++;
    this.coastCount[id] += this.coast[i];
    this.grid[i] = id;
    return old;
  }
}
