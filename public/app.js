// WorldPixel in the browser: draws the map from the server's pixel grid,
// paints each country with its flag stretched over its current shape, and
// handles signing up, coloring pixels and buying more.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');

class ApiError extends Error {
  constructor(message, status, data) { super(message); this.status = status; this.data = data; }
}
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 3800 : 3000);
}

// ---------------------------------------------------------------------
// State

const S = {
  cfg: null,
  countries: [], // [{ code, name, pixels }] where index + 1 is the map value
  idOf: new Map(),
  me: null,
  clockSkew: 0, // server time minus ours
  seq: 0,
  online: 0,
  W: 0, H: 0,
  owners: null, // Uint8Array, one byte per pixel
};
const myId = () => (S.me ? S.idOf.get(S.me.country) || 0 : 0);
const serverNow = () => Date.now() + S.clockSkew;
function setMe(me) {
  S.me = me;
  if (me) S.clockSkew = me.now - Date.now();
  renderAccount();
  renderHint();
  renderBoard();
  requestDraw();
}

// ---------------------------------------------------------------------
// Flags. One image holds every flag in a grid, and the map samples it.

const OCEAN = [26, 140, 255];
let flag = null; // { data, FW, FH, cols, width }
let count, hx, hy; // per-country pixel counts and row/column histograms
let bx0, bw, by0, bh; // flag box: start and size, x wraps around the globe
let fx0, fw, fy0, fy1; // every pixel of the country lies inside this
let img, off, offCtx;

async function loadFlags() {
  const meta = await (await fetch('/flags.json')).json();
  const im = new Image();
  im.src = '/flags.png';
  await im.decode();
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(im, 0, 0);
  flag = { data: x.getImageData(0, 0, c.width, c.height).data, FW: meta.width, FH: meta.height, cols: meta.cols, width: c.width, height: c.height };
}

function flagHtml(code, w = 22) {
  const k = S.idOf.get(code) - 1;
  if (!(k >= 0) || !flag) return '';
  const h = Math.round(w * 0.75);
  const rows = flag.height / flag.FH;
  return `<span class="flag" style="width:${w}px;height:${h}px;background-size:${flag.cols * w}px ${rows * h}px;background-position:-${(k % flag.cols) * w}px -${Math.floor(k / flag.cols) * h}px"></span>`;
}

// The box the map zooms to for "go to my country": the country's pixels
// minus the outer 2% on each side, so far islands don't pull it wide.
// Across the date line it starts after the widest empty gap of columns.
function computeBox(c) {
  const { W, H } = S;
  const n = count[c];
  const old = `${bx0[c]},${bw[c]},${by0[c]},${bh[c]}`;
  if (!n) { bw[c] = 0; fw[c] = 0; return old !== `${bx0[c]},0,${by0[c]},${bh[c]}`; }
  const row = c * W;
  let start = 0;
  let bestLen = -1, runStart = -1, runLen = 0, firstZero = -1;
  for (let k = 0; k < W; k++) if (hx[row + k] === 0) { firstZero = k; break; }
  if (firstZero >= 0) {
    for (let s = 0; s <= W; s++) {
      const k = (firstZero + s) % W;
      if (s < W && hx[row + k] === 0) {
        if (runLen === 0) runStart = k;
        runLen++;
      } else {
        if (runLen > bestLen) { bestLen = runLen; start = (runStart + runLen) % W; }
        runLen = 0;
      }
    }
  }
  const trim = n < 40 ? 0 : Math.floor(n * 0.02);
  let acc = 0, a = -1, b = -1, first = -1, last = -1;
  for (let s = 0; s < W; s++) {
    const v = hx[row + ((start + s) % W)];
    if (!v) continue;
    if (first < 0) first = s;
    last = s;
    acc += v;
    if (a < 0 && acc > trim) a = s;
    if (b < 0 && acc >= n - trim) b = s;
  }
  bx0[c] = (start + a) % W; bw[c] = b - a + 1;
  fx0[c] = (start + first) % W; fw[c] = last - first + 1;
  const col = c * H;
  acc = 0; a = -1; b = -1; first = -1; last = -1;
  for (let y = 0; y < H; y++) {
    const v = hy[col + y];
    if (!v) continue;
    if (first < 0) first = y;
    last = y;
    acc += v;
    if (a < 0 && acc > trim) a = y;
    if (b < 0 && acc >= n - trim) b = y;
  }
  by0[c] = a; bh[c] = b - a + 1;
  fy0[c] = first; fy1[c] = last;
  return old !== `${bx0[c]},${bw[c]},${by0[c]},${bh[c]}`;
}

// Each separate piece of a country (a mainland, an island, a landing on
// another continent) shows the whole flag stretched over its own box, so
// France's mainland gets the full tricolour even though French Guiana and
// Réunion are far away. A piece is pixels of one country joined by edges.
let stamp, gen = 0; // stamp[i] === gen: already repainted in this pass
let queue = new Int32Array(1 << 16);
let colSeen; // scratch: which columns a piece covers
let dirtyTop = Infinity, dirtyBottom = -1;

function paintPixel(i, c, x0, w, y0, h) {
  const { W, H, owners } = S;
  const d = img.data, o = i * 4;
  const x = i % W, y = (i - x) / W;
  let dx = x - x0;
  if (dx < 0) dx += W;
  if (dx >= w) dx = w - 1;
  const u = Math.floor(((dx + 0.5) * flag.FW) / w);
  const v = Math.floor(((Math.min(h - 1, Math.max(0, y - y0)) + 0.5) * flag.FH) / h);
  const k = c - 1;
  const f = ((Math.floor(k / flag.cols) * flag.FH + v) * flag.width + (k % flag.cols) * flag.FW + u) * 4;
  // Edges are shaded: darker against another country, lighter on the coast.
  const l = owners[x ? i - 1 : i + W - 1], r = owners[x < W - 1 ? i + 1 : i - W + 1];
  const t = y ? owners[i - W] : c, btm = y < H - 1 ? owners[i + W] : c;
  let m = 1;
  if ((l && l !== c) || (r && r !== c) || (t && t !== c) || (btm && btm !== c)) m = 0.7;
  else if (!l || !r || !t || !btm) m = 0.86;
  const fd = flag.data;
  d[o] = fd[f] * m; d[o + 1] = fd[f + 1] * m; d[o + 2] = fd[f + 2] * m; d[o + 3] = 255;
}
function paintWater(i) {
  const d = img.data, o = i * 4;
  d[o] = OCEAN[0]; d[o + 1] = OCEAN[1]; d[o + 2] = OCEAN[2]; d[o + 3] = 255;
  const y = Math.floor(i / S.W);
  dirtyTop = Math.min(dirtyTop, y); dirtyBottom = Math.max(dirtyBottom, y);
}

// Finds the piece containing seed and repaints it with its own flag box.
function paintPiece(seed) {
  const { W, H, owners } = S;
  const N = W * H;
  const c = owners[seed];
  let n = 0, head = 0, top = H, bottom = -1;
  queue[n++] = seed;
  stamp[seed] = gen;
  while (head < n) {
    const i = queue[head++];
    const x = i % W, y = (i - x) / W;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
    colSeen[x] = 1;
    const a = x ? i - 1 : i + W - 1, b = x < W - 1 ? i + 1 : i - W + 1, u = i - W, dn = i + W;
    for (const j of [a, b, u, dn]) {
      if (j < 0 || j >= N || owners[j] !== c || stamp[j] === gen) continue;
      stamp[j] = gen;
      if (n === queue.length) { const q = new Int32Array(queue.length * 2); q.set(queue); queue = q; }
      queue[n++] = j;
    }
  }
  // Across the date line the box starts after the widest gap of columns.
  // Walk the columns starting from one the piece covers, so a gap that
  // runs over the map's edge is counted as one gap.
  let x0 = 0, w = W;
  let gapBest = 0, gapStart = -1, run = 0;
  const s0 = seed % W;
  for (let k = 1; k <= W; k++) {
    const x = (s0 + k) % W;
    if (!colSeen[x]) { if (!run) gapStart = x; run++; }
    else { if (run > gapBest) { gapBest = run; x0 = (gapStart + run) % W; } run = 0; }
  }
  if (gapBest) w = W - gapBest;
  for (let k = 0; k < n; k++) colSeen[queue[k] % W] = 0;
  for (let k = 0; k < n; k++) paintPixel(queue[k], c, x0, w, top, bottom - top + 1);
  dirtyTop = Math.min(dirtyTop, top); dirtyBottom = Math.max(dirtyBottom, bottom);
}
function nextGen() {
  gen++;
  if (gen === 65536) { stamp.fill(0); gen = 1; }
}

// Sea: bodies of water of at least SEA_MIN pixels (the same rule as the
// server). A country with a coast can land on any coastline.
const SEA_MIN = 5000;
let coast, coastCount;
function computeCoast() {
  const { W, H, owners } = S;
  const N = W * H;
  const sea = new Uint8Array(N);
  nextGen();
  for (let s = 0; s < N; s++) {
    if (owners[s] || stamp[s] === gen) continue;
    let n = 0, head = 0;
    queue[n++] = s;
    stamp[s] = gen;
    while (head < n) {
      const i = queue[head++];
      const x = i % W;
      for (const j of [x ? i - 1 : i + W - 1, x < W - 1 ? i + 1 : i - W + 1, i - W, i + W]) {
        if (j < 0 || j >= N || owners[j] || stamp[j] === gen) continue;
        stamp[j] = gen;
        if (n === queue.length) { const q = new Int32Array(queue.length * 2); q.set(queue); queue = q; }
        queue[n++] = j;
      }
    }
    if (n >= SEA_MIN) for (let k = 0; k < n; k++) sea[queue[k]] = 1;
  }
  coast = new Uint8Array(N);
  coastCount = new Int32Array(S.countries.length + 1);
  for (let i = 0; i < N; i++) {
    const c = owners[i];
    if (!c) continue;
    const x = i % W;
    if (sea[x ? i - 1 : i + W - 1] || sea[x < W - 1 ? i + 1 : i - W + 1] || (i >= W && sea[i - W]) || (i < N - W && sea[i + W])) {
      coast[i] = 1;
      coastCount[c]++;
    }
  }
}

function buildAll() {
  const { W, H, owners } = S;
  const n = S.countries.length + 1;
  count = new Int32Array(n); hx = new Int32Array(n * W); hy = new Int32Array(n * H);
  bx0 = new Int32Array(n); bw = new Int32Array(n); by0 = new Int32Array(n); bh = new Int32Array(n);
  fx0 = new Int32Array(n); fw = new Int32Array(n); fy0 = new Int32Array(n); fy1 = new Int32Array(n);
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++) {
      const c = owners[i];
      if (!c) continue;
      count[c]++; hx[c * W + x]++; hy[c * H + y]++;
    }
  }
  for (let c = 1; c < n; c++) computeBox(c);
  if (!off) {
    off = document.createElement('canvas');
    off.width = W; off.height = H;
    offCtx = off.getContext('2d');
    img = offCtx.createImageData(W, H);
    stamp = new Uint16Array(W * H);
    colSeen = new Uint8Array(W);
  }
  computeCoast();
  nextGen();
  for (let i = 0; i < W * H; i++) {
    if (!owners[i]) paintWater(i);
    else if (stamp[i] !== gen) paintPiece(i);
  }
  offCtx.putImageData(img, 0, 0);
  dirtyTop = Infinity; dirtyBottom = -1;
}

// Changes from the live feed and from our own clicks land here, and are
// drawn on the next frame: every piece touching a changed pixel is
// repainted, since its shape (and so its flag box) or its border changed.
let dirtyPixels = [];
let flushQueued = false;
function apply(i, c) {
  const { W, H, owners } = S;
  const old = owners[i];
  if (old === c) return;
  owners[i] = c;
  const x = i % W, y = (i - x) / W;
  if (old) { count[old]--; hx[old * W + x]--; hy[old * H + y]--; coastCount[old] -= coast[i]; }
  if (c) { count[c]++; hx[c * W + x]++; hy[c * H + y]++; coastCount[c] += coast[i]; }
  for (const k of [old, c]) if (k) computeBox(k);
  dirtyPixels.push(i);
  boardDirty = true;
  if (!flushQueued) { flushQueued = true; requestAnimationFrame(flush); }
}
function flush() {
  flushQueued = false;
  const { owners } = S;
  nextGen();
  for (const i of dirtyPixels) {
    for (const j of [i, ...neighbours(i)]) {
      if (!owners[j]) paintWater(j);
      else if (stamp[j] !== gen) paintPiece(j);
    }
  }
  dirtyPixels = [];
  if (dirtyBottom >= 0) offCtx.putImageData(img, 0, 0, 0, dirtyTop, S.W, dirtyBottom - dirtyTop + 1);
  dirtyTop = Infinity; dirtyBottom = -1;
  requestDraw();
}

function neighbours(i) {
  const { W, H } = S;
  const x = i % W, y = (i - x) / W;
  const out = [y * W + ((x + W - 1) % W), y * W + ((x + 1) % W)];
  if (y > 0) out.push(i - W);
  if (y < H - 1) out.push(i + W);
  return out;
}
function touches(i, id) {
  const { W, H, owners } = S;
  const x = i % W;
  return owners[x ? i - 1 : i + W - 1] === id || owners[x < W - 1 ? i + 1 : i - W + 1] === id
    || (i >= W && owners[i - W] === id) || (i < W * (H - 1) && owners[i + W] === id);
}
// Mirrors World.refuse on the server.
function lastPixel(i) {
  const owner = S.owners[i];
  return owner && count[owner] <= 1 ? owner : 0;
}
function canColor(i) {
  const id = myId();
  const o = S.owners[i];
  if (!id || !o || o === id || lastPixel(i)) return false;
  if (touches(i, id)) return true;
  if (count[id] === 0) { loadBase(); if (S.base?.[i] === id) return true; }
  return !!coast[i] && coastCount[id] > 0;
}
function refusal(i) {
  const id = myId();
  const o = S.owners[i];
  const name = S.countries[id - 1].name;
  if (!o) return 'Water can\'t be colored. Land on a coast instead.';
  if (o === id) return 'That pixel is already yours.';
  if (lastPixel(i)) return `That is ${S.countries[o - 1].name}'s last pixel. Every country keeps at least one.`;
  if (coast[i]) return `${name} has no coastline, so it can only grow over land that touches it.`;
  return `You can only color land touching ${name}, or a coast anywhere.`;
}

// ---------------------------------------------------------------------
// The view: s is screen pixels per map pixel, (cx, cy) the map point at
// the middle of the screen.

const canvas = $('#map');
const ctx = canvas.getContext('2d');
const view = { s: 1, cx: 0, cy: 0 };
let vw = 0, vh = 0, dpr = 1;
const MAX_S = 48;
const minS = () => Math.min(vw / S.W, vh / S.H);

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  vw = innerWidth; vh = innerHeight;
  canvas.width = Math.round(vw * dpr); canvas.height = Math.round(vh * dpr);
  if (S.W) clampView();
  requestDraw();
}
function clampView() {
  view.s = Math.min(MAX_S, Math.max(minS(), view.s));
  view.cx = ((view.cx % S.W) + S.W) % S.W;
  const half = vh / 2 / view.s;
  view.cy = half * 2 >= S.H ? S.H / 2 : Math.min(S.H - half, Math.max(half, view.cy));
}
function toMap(px, py) { return { x: view.cx + (px - vw / 2) / view.s, y: view.cy + (py - vh / 2) / view.s }; }
function pixelAt(px, py) {
  const p = toMap(px, py);
  const y = Math.floor(p.y);
  if (y < 0 || y >= S.H) return -1;
  const x = ((Math.floor(p.x) % S.W) + S.W) % S.W;
  return y * S.W + x;
}
function zoomAt(px, py, factor) {
  const before = toMap(px, py);
  view.s = Math.min(MAX_S, Math.max(minS(), view.s * factor));
  view.cx = before.x - (px - vw / 2) / view.s;
  view.cy = before.y - (py - vh / 2) / view.s;
  clampView();
  requestDraw();
}

let anim = null;
function flyTo(x, y, s) {
  const from = { ...view };
  let dx = x - from.cx;
  if (dx > S.W / 2) dx -= S.W; else if (dx < -S.W / 2) dx += S.W;
  const to = { cx: from.cx + dx, cy: y, s: Math.min(MAX_S, Math.max(minS(), s)) };
  const t0 = performance.now();
  cancelAnimationFrame(anim);
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 650);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    view.cx = from.cx + (to.cx - from.cx) * e;
    view.cy = from.cy + (to.cy - from.cy) * e;
    view.s = Math.exp(Math.log(from.s) + (Math.log(to.s) - Math.log(from.s)) * e);
    clampView();
    draw();
    if (k < 1) anim = requestAnimationFrame(step);
  };
  anim = requestAnimationFrame(step);
}
function flyToCountry(code) {
  const c = S.idOf.get(code);
  if (!c || !count[c]) return;
  const w = Math.max(bw[c], 6), h = Math.max(bh[c], 6);
  const s = Math.min((vw * 0.6) / w, (vh * 0.6) / h, 24);
  flyTo(bx0[c] + bw[c] / 2, by0[c] + bh[c] / 2, s);
}
// The starting view: the whole world on a wide screen; on a phone held
// upright, a bit under half of it at a size you can see.
const homeScale = () => Math.max(minS(), vh > vw ? vh / (S.H * 0.85) : Math.min(vh / (S.H * 0.78), vw / S.W));
function home() {
  flyTo(S.W * 0.53, S.H * 0.4, homeScale());
}

let drawQueued = false;
function requestDraw() {
  if (drawQueued || !S.W) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

function draw() {
  const { W, H } = S;
  const s = view.s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b4fa8';
  ctx.fillRect(0, 0, vw, vh);
  const left = view.cx - vw / 2 / s, top = view.cy - vh / 2 / s;
  const right = left + vw / s, bottom = top + vh / s;
  ctx.imageSmoothingEnabled = s < 1;
  ctx.imageSmoothingQuality = 'high';
  // The map repeats sideways, so draw whichever copies are on screen.
  for (let k = Math.floor(left / W); k * W < right; k++) {
    const x0 = Math.floor(Math.max(left, k * W) - k * W), x1 = Math.ceil(Math.min(right, (k + 1) * W) - k * W);
    const y0 = Math.floor(Math.max(0, top)), y1 = Math.ceil(Math.min(H, bottom));
    if (x1 <= x0 || y1 <= y0) continue;
    ctx.drawImage(off, x0, y0, x1 - x0, y1 - y0, (x0 + k * W - left) * s, (y0 - top) * s, (x1 - x0) * s, (y1 - y0) * s);
  }

  const gx0 = Math.floor(left), gx1 = Math.ceil(right), gy0 = Math.max(0, Math.floor(top)), gy1 = Math.min(H, Math.ceil(bottom));
  if (s >= 12) {
    ctx.beginPath();
    for (let x = gx0; x <= gx1; x++) { const X = Math.round((x - left) * s) + 0.5; ctx.moveTo(X, (gy0 - top) * s); ctx.lineTo(X, (gy1 - top) * s); }
    for (let y = gy0; y <= gy1; y++) { const Y = Math.round((y - top) * s) + 0.5; ctx.moveTo((gx0 - left) * s, Y); ctx.lineTo((gx1 - left) * s, Y); }
    ctx.strokeStyle = 'rgba(0,0,0,.13)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Where you can color: a dot on land touching your country, a ring on
  // coastline you can land on from the sea.
  const id = myId();
  if (id && s >= 3 && (gx1 - gx0) * (gy1 - gy0) < 500_000) {
    const r = Math.max(1.2, s * 0.16);
    const dots = new Path2D(), rings = new Path2D();
    for (let y = gy0; y < gy1; y++) {
      for (let x = gx0; x < gx1; x++) {
        const i = y * W + (((x % W) + W) % W);
        if (!canColor(i)) continue;
        const X = (x + 0.5 - left) * s, Y = (y + 0.5 - top) * s;
        const p = touches(i, id) ? dots : rings;
        p.moveTo(X + r, Y);
        p.arc(X, Y, r, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 1;
    ctx.fill(dots);
    if (s >= 8) ctx.stroke(dots);
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.stroke(rings);
  }

  if (hover.i >= 0 && hover.inside) {
    const x = hover.i % W, y = (hover.i - x) / W;
    let mx = x;
    while (mx < left - 1) mx += W;
    while (mx > right) mx -= W;
    const X = (mx - left) * s, Y = (y - top) * s;
    const ok = canColor(hover.i);
    if (s >= 3) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.strokeRect(X - 1, Y - 1, s + 2, s + 2);
      ctx.strokeStyle = ok ? '#fff' : 'rgba(255,255,255,.55)';
      ctx.strokeRect(X + 1, Y + 1, s - 2, s - 2);
    } else {
      ctx.beginPath();
      ctx.arc(X + s / 2, Y + s / 2, 7, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.stroke();
    }
  }
  renderHint();
}

// ---------------------------------------------------------------------
// Mouse, touch and keys

const hover = { i: -1, inside: false, timer: 0, info: null };
const pointers = new Map();
let drag = null;

canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  cancelAnimationFrame(anim);
  if (pointers.size === 1) drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
  else if (drag) drag.moved = true;
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId);
  if (p) {
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d0 = Math.hypot(a.x - b.x, a.y - b.y), m0 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      p.x = e.clientX; p.y = e.clientY;
      const [c, d] = [...pointers.values()];
      const d1 = Math.hypot(c.x - d.x, c.y - d.y), m1 = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
      view.cx -= (m1.x - m0.x) / view.s;
      view.cy -= (m1.y - m0.y) / view.s;
      if (d0 > 0) zoomAt(m1.x, m1.y, d1 / d0);
      return;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 5) { drag.moved = true; canvas.classList.add('grabbing'); }
      if (drag.moved) {
        view.cx = drag.cx - dx / view.s;
        view.cy = drag.cy - dy / view.s;
        clampView();
        requestDraw();
      }
    }
  }
  if (e.pointerType === 'mouse') setHover(e.clientX, e.clientY);
});
function endPointer(e) {
  if (!pointers.delete(e.pointerId)) return;
  if (pointers.size === 0) {
    canvas.classList.remove('grabbing');
    if (drag && !drag.moved && e.type === 'pointerup') clickAt(e.clientX, e.clientY);
    drag = null;
  } else if (pointers.size === 1) {
    const [p] = pointers.values();
    drag = { x: p.x, y: p.y, cx: view.cx, cy: view.cy, moved: true };
  }
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { hover.inside = false; $('#hover').hidden = true; requestDraw(); } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  cancelAnimationFrame(anim);
  const k = e.deltaMode === 1 ? 16 : 1;
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * k * (e.ctrlKey ? 0.01 : 0.0018)));
  setHover(e.clientX, e.clientY);
}, { passive: false });
addEventListener('keydown', (e) => {
  if (e.target.closest?.('input, dialog')) return;
  const step = 80 / view.s;
  const keys = {
    '+': () => zoomAt(vw / 2, vh / 2, 1.5), '=': () => zoomAt(vw / 2, vh / 2, 1.5), '-': () => zoomAt(vw / 2, vh / 2, 1 / 1.5),
    ArrowLeft: () => { view.cx -= step; }, ArrowRight: () => { view.cx += step; }, ArrowUp: () => { view.cy -= step; }, ArrowDown: () => { view.cy += step; },
  };
  if (!keys[e.key]) return;
  keys[e.key]();
  clampView();
  requestDraw();
});
addEventListener('resize', resize);
// The top bar can wrap onto two lines on a phone; panels below it follow.
new ResizeObserver(([e]) => document.documentElement.style.setProperty('--bar-h', `${Math.ceil(e.target.getBoundingClientRect().bottom)}px`)).observe($('.bar'));

$('#zoomIn').onclick = () => zoomAt(vw / 2, vh / 2, 1.8);
$('#zoomOut').onclick = () => zoomAt(vw / 2, vh / 2, 1 / 1.8);
$('#zoomHome').onclick = home;
$('#zoomMine').onclick = () => S.me && flyToCountry(S.me.country);

function latLon(i) {
  const x = i % S.W, y = (i - x) / S.W, d = 360 / S.W;
  const lat = 90 - (y + 0.5) * d, lon = -180 + (x + 0.5) * d;
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}
function setHover(px, py) {
  const i = pixelAt(px, py);
  hover.inside = i >= 0;
  if (i === hover.i) { requestDraw(); return; }
  hover.i = i;
  hover.info = null;
  renderHover();
  requestDraw();
  clearTimeout(hover.timer);
  if (i < 0) return;
  hover.timer = setTimeout(async () => {
    try {
      const info = await api(`/api/pixel?i=${i}`);
      if (hover.i === i) { hover.info = info; renderHover(); }
    } catch {}
  }, 350);
}
function renderHover() {
  const el = $('#hover');
  const i = hover.i;
  if (i < 0 || !hover.inside) { el.hidden = true; return; }
  el.hidden = false;
  const c = S.owners[i];
  const country = c ? S.countries[c - 1] : null;
  const info = hover.info;
  let sub = latLon(i);
  if (info?.by) sub = `Colored by <b>${esc(info.by)}</b> · ${sub}`;
  else if (info && info.original && info.original !== info.country) sub = `Was ${esc(S.countries[S.idOf.get(info.original) - 1].name)} · ${sub}`;
  else if (info && !info.original && info.country) sub = `Was ocean · ${sub}`;
  el.innerHTML = `<div class="row">${country ? `${flagHtml(country.code)}${esc(country.name)}` : 'Ocean'}</div><div class="sub">${sub}</div>`;
}

let placing = false;
async function clickAt(px, py) {
  const i = pixelAt(px, py);
  if (i < 0) return;
  if (view.s < 3) {
    const p = toMap(px, py);
    flyTo(p.x, p.y, 8);
    return;
  }
  if (!S.me) { openAuth('signup'); return; }
  if (!S.me.admin && S.me.free + S.me.paid <= 0) { toast('You are out of pixels. Wait for the next one, or buy more.', 'bad'); return; }
  const id = myId();
  if (!canColor(i)) { toast(refusal(i), S.owners[i] === id ? '' : 'bad'); return; }
  if (placing) return;
  placing = true;
  apply(i, id);
  try {
    const r = await api('/api/place', { i });
    setMe(r.me);
  } catch (e) {
    toast(e.message, 'bad');
    if (e.data?.me) setMe(e.data.me);
    // Put back whatever the pixel is on the server.
    try { const info = await api(`/api/pixel?i=${i}`); apply(i, info.country ? S.idOf.get(info.country) : 0); } catch {}
  } finally {
    placing = false;
  }
}

// ---------------------------------------------------------------------
// Top bar, hint and leaderboard

function renderAccount() {
  const el = $('#account');
  $('#zoomMine').hidden = !S.me;
  if (!S.me) {
    el.innerHTML = '<button class="btn light" data-act="login">Log in</button><button class="btn" data-act="signup">Sign up</button>';
  } else {
    const c = S.countries[S.idOf.get(S.me.country) - 1];
    el.innerHTML = `
      <button class="chip" data-act="country" title="Change country">${flagHtml(c.code)}<span class="cname">${esc(c.name)}</span><span class="muted">▾</span></button>
      <div class="chip pixels" id="pixels"></div>
      <button class="btn" data-act="buy">Buy pixels</button>
      <button class="chip user" data-act="menu" title="${esc(S.me.name)}"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="7" r="3.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 17c1-3.2 3.6-5 6.5-5s5.5 1.8 6.5 5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span class="uname">${esc(S.me.name)}</span></button>`;
    renderPixels();
  }
}
$('#account').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'login' || act === 'signup') openAuth(act);
  else if (act === 'country') openCountry();
  else if (act === 'buy') openBuy();
  else if (act === 'menu') openMenu();
});

let refreshing = false;
function renderPixels() {
  const el = $('#pixels');
  if (!el || !S.me) return;
  const m = S.me;
  if (m.admin) {
    el.title = 'Admins have unlimited pixels';
    el.innerHTML = '<b>∞</b><span class="of">pixels</span><span class="bonus">admin</span>';
    return;
  }
  const total = m.free + m.paid;
  let timer;
  if (m.nextAt) {
    const left = Math.max(0, m.nextAt - serverNow());
    const frac = 1 - left / S.cfg.rules.regenMs;
    const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
    timer = `<svg class="ring" viewBox="0 0 20 20"><circle class="track" cx="10" cy="10" r="7.5"/><circle class="fill" cx="10" cy="10" r="7.5" stroke-dasharray="47.1" stroke-dashoffset="${(47.1 * (1 - frac)).toFixed(1)}"/></svg><span class="num">+1 in ${mm}:${String(ss).padStart(2, '0')}</span><span class="label of">· ${m.free}/${m.cap}</span>`;
    if (left <= 0 && !refreshing) {
      refreshing = true;
      api('/api/me').then((r) => setMe(r.me)).catch(() => {}).finally(() => { refreshing = false; });
    }
  } else {
    timer = `<span class="label">Storage full · ${m.cap}/${m.cap}</span>`;
  }
  el.title = `Free pixels: ${m.free} of ${m.cap} (one every minute)\nBought pixels: ${m.paid}`;
  el.innerHTML = `<b class="num">${total}</b><span class="of">pixel${total === 1 ? '' : 's'}</span>${m.paid ? `<span class="bonus num">${m.paid} bought</span>` : ''}<span class="timer">${timer}</span>`;
}
setInterval(renderPixels, 1000);

function renderHint() {
  const el = $('#hint');
  if (!S.W) return;
  let msg = '';
  const c = S.me ? S.countries[S.idOf.get(S.me.country) - 1] : null;
  if (!S.me) msg = 'Sign up and pick a country to start coloring the map';
  else if (!S.me.admin && S.me.free + S.me.paid <= 0) msg = 'Out of pixels. A new one comes every minute.';
  else if (view.s < 3) msg = `Zoom in on ${c.name} to color the pixels around it`;
  else if (!count[S.idOf.get(c.code)]) msg = `${c.name} has no pixels left. You can color anywhere in its original land.`;
  else if (coastCount[S.idOf.get(c.code)]) msg = 'Dots: land touching you. Rings: coasts you can land on from the sea.';
  else msg = 'Dots are land you can color. Reach the coast to land on other continents.';
  if (el.textContent !== msg) el.textContent = msg;
  el.hidden = !msg;
}

let boardDirty = true;
let boardMode = 'size';
function renderBoard() {
  boardDirty = false;
  const list = $('#boardList');
  const rows = S.countries.map((c, k) => ({ c, n: count[k + 1], gain: count[k + 1] - c.pixels }));
  rows.sort(boardMode === 'size' ? (a, b) => b.n - a.n : (a, b) => b.gain - a.gain || b.n - a.n);
  const mine = S.me?.country;
  const top = rows.slice(0, 10);
  const myRank = rows.findIndex((r) => r.c.code === mine);
  const line = (r, rank) => `<li class="${r.c.code === mine ? 'mine' : ''}"><button data-code="${r.c.code}">
      <span class="rank num">${rank}</span>${flagHtml(r.c.code)}<span class="name">${esc(r.c.name)}</span>
      <span class="count num">${boardMode === 'size' ? fmt(r.n) : ''}${r.gain ? `<span class="delta ${r.gain > 0 ? 'up' : 'down'}">${r.gain > 0 ? '+' : ''}${fmt(r.gain)}</span>` : boardMode === 'gain' ? '<span class="delta">0</span>' : ''}</span></button></li>`;
  list.innerHTML = top.map((r, k) => line(r, k + 1)).join('') + (myRank >= 10 ? `<li class="sep"></li>${line(rows[myRank], myRank + 1)}` : '');
  $('#board').hidden = false;
}
$('#boardList').addEventListener('click', (e) => {
  const code = e.target.closest('[data-code]')?.dataset.code;
  if (code) flyToCountry(code);
});
$('#boardToggle').addEventListener('click', (e) => {
  if (e.target.closest('[data-mode]')) {
    boardMode = e.target.closest('[data-mode]').dataset.mode;
    renderBoardHead();
    renderBoard();
    return;
  }
  const b = $('#board');
  b.classList.toggle('closed');
  $('#boardToggle').setAttribute('aria-expanded', String(!b.classList.contains('closed')));
});
function renderBoardHead() {
  $('#boardToggle').innerHTML = `<span>Countries</span><span class="online">${S.online ? `${fmt(S.online)} online · ` : ''}<span data-mode="size" class="${boardMode === 'size' ? 'strong' : ''}">${boardMode === 'size' ? '<u>size</u>' : 'size'}</span> / <span data-mode="gain">${boardMode === 'gain' ? '<u>gained</u>' : 'gained'}</span></span>`;
}
setInterval(() => { if (boardDirty) renderBoard(); }, 2000);

// ---------------------------------------------------------------------
// Modals

const modal = $('#modal');
// Each modal gets a fresh body element, so listeners never pile up.
function openModal(html, { wide = false } = {}) {
  clearInterval(invoicePoll);
  const body = document.createElement('div');
  body.className = 'modal-body';
  body.id = 'modalBody';
  body.innerHTML = html;
  $('#modalBody').replaceWith(body);
  modal.classList.toggle('wide', wide);
  if (!modal.open) modal.showModal();
  return body;
}
modal.addEventListener('click', (e) => {
  if (e.target === modal || e.target.closest('.x')) modal.close();
});
modal.addEventListener('close', () => { clearInterval(invoicePoll); });
const head = (title, sub = '') => `<div class="modal-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div><button class="x" aria-label="Close">×</button></div>`;

// A searchable list of countries. Calls onPick(code) when one is chosen.
function picker(root, selected, onPick) {
  const sorted = S.countries.map((c, k) => ({ ...c, now: count[k + 1] })).sort((a, b) => a.name.localeCompare(b.name));
  root.innerHTML = '<input type="search" placeholder="Search countries" aria-label="Search countries"><ul></ul>';
  const ul = $('ul', root);
  const draw = (q) => {
    q = q.trim().toLowerCase();
    ul.innerHTML = sorted.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q)
      .map((c) => `<li><button type="button" data-code="${c.code}" class="${c.code === selected ? 'on' : ''}">${flagHtml(c.code)}<span>${esc(c.name)}</span><span class="size num">${fmt(c.now)} px</span></button></li>`).join('')
      || '<li class="small" style="padding:10px">No country by that name.</li>';
  };
  draw('');
  $('input', root).addEventListener('input', (e) => draw(e.target.value));
  ul.addEventListener('click', (e) => {
    const b = e.target.closest('[data-code]');
    if (!b) return;
    selected = b.dataset.code;
    for (const x of ul.querySelectorAll('.on')) x.classList.remove('on');
    b.classList.add('on');
    onPick(selected);
  });
  const on = $('.on', ul);
  if (on) on.scrollIntoView({ block: 'center' });
}

function openAuth(mode) {
  let country = null;
  const body = openModal(`${head(mode === 'signup' ? 'Join WorldPixel' : 'Welcome back')}
    <div class="tabs"><button type="button" data-mode="signup" class="${mode === 'signup' ? 'on' : ''}">Sign up</button><button type="button" data-mode="login" class="${mode === 'login' ? 'on' : ''}">Log in</button></div>
    <form novalidate>
      <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" maxlength="20" required></label>
      <label class="field"><span>Password</span><input type="password" name="password" autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}" required></label>
      ${mode === 'signup' ? '<div class="field"><span class="small" style="display:block;font-weight:600;color:var(--ink-2);margin-bottom:5px">Your country</span><div class="picker" id="authPicker"></div></div>' : ''}
      <p class="err" id="authErr"></p>
      <button class="btn wide" type="submit">${mode === 'signup' ? 'Create account' : 'Log in'}</button>
      ${mode === 'signup' ? `<p class="note">You start with ${S.cfg.rules.startPixels} pixels and get one more every minute, up to ${S.cfg.rules.cap}. You can switch country later.</p>` : ''}
    </form>`);
  body.querySelector('.tabs').addEventListener('click', (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (m && m !== mode) openAuth(m);
  });
  if (mode === 'signup') picker($('#authPicker'), null, (code) => { country = code; });
  $('input[name=username]', body).focus();
  $('form', body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#authErr');
    err.textContent = '';
    if (mode === 'signup' && !country) { err.textContent = 'Pick your country from the list.'; return; }
    const btn = $('button[type=submit]', f);
    btn.disabled = true;
    try {
      const r = await api(`/api/${mode}`, { username: f.username.value, password: f.password.value, country });
      modal.close();
      setMe(r.me);
      flyToCountry(r.me.country);
      if (mode === 'signup') toast(`Welcome! You have ${r.me.free} pixels. Color the ones touching your country.`, 'good');
    } catch (ex) {
      err.textContent = ex.message;
    } finally {
      btn.disabled = false;
    }
  });
}

function openCountry() {
  const body = openModal(`${head('Your country', 'Every pixel you color from now on goes to this country.')}<div class="picker" id="countryPicker"></div>`);
  picker($('#countryPicker', body), S.me.country, async (code) => {
    if (code === S.me.country) return;
    try {
      const r = await api('/api/country', { country: code });
      modal.close();
      setMe(r.me);
      flyToCountry(code);
      toast(`You now color for ${S.countries[S.idOf.get(code) - 1].name}.`);
    } catch (e) { toast(e.message, 'bad'); }
  });
}

function openMenu() {
  const body = openModal(`${head(esc(S.me.name), `${fmt(S.me.placed)} pixel${S.me.placed === 1 ? '' : 's'} colored · storage ${S.me.cap}`)}
    <div class="menu-list">
      ${S.me.admin ? '<a class="btn light wide" href="/admin">Admin page</a>' : ''}
      <button class="btn light wide" data-go="history">Payments</button>
      <button class="btn wide" data-go="logout">Log out</button>
    </div>`);
  body.addEventListener('click', async (e) => {
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (go === 'logout') {
      await api('/api/logout', {}).catch(() => {});
      modal.close();
      setMe(null);
    } else if (go === 'history') openBuy();
  });
}

const STATUS = {
  open: ['Waiting for your payment', ''],
  confirming: ['Payment seen, waiting for the network to confirm it', ''],
  underpaid: ['Less than the full amount arrived. Send the rest to the same address.', ''],
  paid: ['Paid. Your pixels are in.', 'paid'],
  expired: ['This quote expired. A late payment is still credited within 7 days.', 'dead'],
};
const packTitle = (p) => (p.cap ? `${p.cap}-pixel storage` : `${p.pixels} pixels`);

let invoicePoll = 0;
async function openBuy() {
  const packs = S.cfg.packs;
  const pixelPacks = packs.filter((p) => p.pixels);
  const storage = packs.find((p) => p.cap);
  const disabled = !S.cfg.payments;
  const hasBig = S.me.cap >= storage.cap;
  const body = openModal(`${head('Buy pixels', 'Paid in Bitcoin. Bought pixels never expire and don\'t count toward your storage.')}
    <div class="packs">${pixelPacks.map((p) => `<button class="pack" data-pack="${p.key}" ${disabled ? 'disabled' : ''}>
      <b class="num">${p.pixels}</b><span class="unit">pixels</span><span class="price">$${p.usd}</span><span class="each">$${(p.usd / p.pixels).toFixed(2)} each</span></button>`).join('')}</div>
    <button class="storage" data-pack="${storage.key}" ${disabled || hasBig ? 'disabled' : ''}>
      <span class="big num">${S.cfg.rules.cap} → ${storage.cap}</span>
      <span class="what"><strong>${hasBig ? 'Storage upgraded' : 'Bigger storage'}</strong>Free pixels keep piling up to ${storage.cap} instead of ${S.cfg.rules.cap}, so you can be away for over an hour and a half and lose nothing.</span>
      <span class="price">${hasBig ? '✓' : `$${storage.usd}`}</span>
    </button>
    ${disabled ? '<p class="note">Buying isn\'t switched on yet on this server.</p>' : '<p class="note">You get a Bitcoin address and amount to send from any wallet. Pixels arrive after one network confirmation, usually 10 to 30 minutes.</p>'}
    <div class="history" id="history" hidden><h3>Your payments</h3><ul></ul></div>`, { wide: true });
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pack]');
    if (b && !b.disabled) {
      b.disabled = true;
      try { showInvoice((await api('/api/buy', { pack: b.dataset.pack })).invoice); } catch (ex) { toast(ex.message, 'bad'); b.disabled = false; }
      return;
    }
    const inv = e.target.closest('[data-inv]');
    if (inv) showInvoice(JSON.parse(inv.dataset.inv));
  });
  try {
    const { invoices } = await api('/api/invoices');
    const h = $('#history', body);
    if (!h || !invoices.length) return;
    h.hidden = false;
    $('ul', h).innerHTML = invoices.map((inv) => `<li><button class="copy" style="margin:0;font-family:inherit" data-inv='${esc(JSON.stringify(inv))}'>
      ${packTitle(inv)} · $${inv.usd} · ${STATUS[inv.status][1] === 'paid' ? 'paid' : inv.status} · ${new Date(inv.createdAt).toLocaleDateString()}</button></li>`).join('');
  } catch {}
}

function showInvoice(inv) {
  clearInterval(invoicePoll);
  const qr = qrcode(0, 'M');
  qr.addData(inv.uri);
  qr.make();
  const render = (inv) => {
    const [label, cls] = STATUS[inv.status];
    const left = Math.max(0, inv.expiresAt - serverNow());
    const open = inv.status === 'open';
    return `${head(`${packTitle(inv)} for $${inv.usd}`, open ? `Send exactly this much bitcoin. Price held for ${Math.ceil(left / 60000)} more minutes.` : '')}
      <div class="invoice">
        <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
        <div>
          <span class="small">Amount</span>
          <button class="copy num" data-copy="${inv.btc}">${inv.btc} BTC</button>
          <span class="small">To this address</span>
          <button class="copy" data-copy="${esc(inv.address)}">${esc(inv.address)}</button>
          <div class="status"><span class="dot ${cls}"></span>${label}</div>
          ${inv.received || inv.pending ? `<p class="small">Received ${(inv.received / 1e8).toFixed(8)} BTC${inv.pending ? `, ${(inv.pending / 1e8).toFixed(8)} still confirming` : ''}.</p>` : ''}
        </div>
      </div>
      <p class="note">Tap the amount or address to copy it. This page updates by itself; you can close it and your pixels will still arrive.</p>
      <button class="btn light wide" data-back style="margin-top:12px">Back to packs</button>`;
  };
  const body = openModal(render(inv), { wide: true });
  const wire = () => {
    $('[data-back]', body).onclick = () => openBuy();
    for (const b of body.querySelectorAll('[data-copy]')) {
      b.onclick = async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); } catch { toast('Copy failed, select it by hand', 'bad'); }
      };
    }
  };
  wire();
  if (inv.status === 'paid') return;
  invoicePoll = setInterval(async () => {
    try {
      const { invoices } = await api('/api/invoices');
      const fresh = invoices.find((x) => x.id === inv.id);
      if (!fresh || !modal.open) return;
      if (fresh.status !== inv.status || fresh.received !== inv.received || fresh.pending !== inv.pending) {
        inv = fresh;
        body.innerHTML = render(inv);
        wire();
        if (inv.status === 'paid') {
          clearInterval(invoicePoll);
          toast(inv.cap ? 'Storage upgraded to 100 pixels.' : `${inv.pixels} pixels added.`, 'good');
          setMe((await api('/api/me')).me);
        }
      }
    } catch {}
  }, 8000);
}

// ---------------------------------------------------------------------
// Live feed

let feed = null;
function connect() {
  if (feed) feed.close();
  feed = new EventSource(`/api/events?since=${S.seq}`);
  feed.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.reload) { reloadWorld(); return; }
    if (d.online != null) { S.online = d.online; renderBoardHead(); }
    if (d.p) {
      for (let k = 0; k < d.p.length; k += 2) apply(d.p[k], d.p[k + 1]);
      S.seq = Math.max(S.seq, d.s);
    }
  };
  feed.onerror = () => {
    feed.close();
    feed = null;
    setTimeout(connect, 2500);
  };
}

async function loadWorld() {
  const res = await fetch('/api/world');
  if (!res.ok) throw new Error('Could not load the map');
  S.owners = new Uint8Array(await res.arrayBuffer());
  S.seq = Number(res.headers.get('X-Seq')) || 0;
  if (S.owners.length !== S.W * S.H) throw new Error('The map came back the wrong size');
}
async function reloadWorld() {
  await loadWorld();
  buildAll();
  connect();
  boardDirty = true;
  requestDraw();
}

// Original borders, so a country that lost everything knows where it
// can start again. Fetched only when that happens.
let baseLoading = null;
function loadBase() {
  baseLoading ||= (async () => {
    try {
      const res = await fetch('/world.bin.gz');
      S.base = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      requestDraw();
    } catch { baseLoading = null; }
  })();
}

// ---------------------------------------------------------------------

async function boot() {
  resize();
  try {
    const [cfg, meta, me] = await Promise.all([api('/api/config'), api('/countries.json'), api('/api/me'), loadFlags()]);
    S.cfg = cfg;
    S.W = meta.width; S.H = meta.height;
    S.countries = meta.countries;
    S.idOf = new Map(meta.countries.map((c, k) => [c.code, k + 1]));
    S.online = cfg.online;
    await loadWorld();
    buildAll();
    Object.assign(view, { s: homeScale(), cx: S.W * 0.53, cy: S.H * 0.4 });
    if (matchMedia('(max-width: 720px)').matches) $('#board').classList.add('closed');
    clampView();
    renderBoardHead();
    setMe(me.me);
    $('#loading').remove();
    connect();
    if (S.me) flyToCountry(S.me.country);
  } catch (e) {
    $('#loading').textContent = `Could not load WorldPixel: ${e.message}. Refresh to try again.`;
  }
}
boot();
