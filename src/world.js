// The map: one byte per pixel, 0 for water and 1..N for the country at
// countries[value - 1]. The left and right edges meet, like the real
// globe, so Russia can grow across the date line into Alaska.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

export function loadBaseMap(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'countries.json'), 'utf8'));
  const base = new Uint8Array(gunzipSync(readFileSync(join(dir, 'world.bin.gz'))));
  if (base.length !== meta.width * meta.height) throw new Error('map/world.bin.gz does not match map/countries.json');
  return { ...meta, base };
}

export class World {
  constructor({ width, height, countries, base }, grid = base.slice()) {
    this.W = width;
    this.H = height;
    this.countries = countries;
    this.base = base;
    this.grid = grid;
    this.idOf = new Map(countries.map((c, k) => [c.code, k + 1]));
    this.count = new Uint32Array(countries.length + 1);
    for (const v of grid) this.count[v]++;
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

  // Why a country can't take pixel i, or null if it can. A country that
  // has lost every pixel may start again anywhere on its original land.
  refuse(id, i) {
    if (!this.inBounds(i)) return 'That pixel is off the map.';
    if (this.grid[i] === id) return 'That pixel is already yours.';
    if (this.borders(id, i)) return null;
    if (this.count[id] === 0 && this.base[i] === id) return null;
    return `You can only color pixels that touch ${this.countries[id - 1].name}.`;
  }

  set(i, id) {
    const old = this.grid[i];
    this.count[old]--;
    this.count[id]++;
    this.grid[i] = id;
    return old;
  }
}
