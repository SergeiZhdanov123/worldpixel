// The admin page: who's on, money in, and banning players.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (n) => Number(n).toLocaleString('en-US');
const usd = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const PACK = { p6: '6 pixels', p15: '15 pixels', p40: '40 pixels', p180: '180 pixels', cap100: 'Storage 100' };

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), 3200);
}
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const main = $('#main');
let countries = new Map();

function loginForm(msg) {
  main.innerHTML = `<section class="card narrow">
    <h2>Admin sign in</h2><p class="small">${esc(msg)}</p>
    <form id="login"><label class="field"><span>Username</span><input type="text" name="username" autocomplete="username"></label>
    <label class="field"><span>Password</span><input type="password" name="password" autocomplete="current-password"></label>
    <p class="err" id="err"></p><button class="btn wide">Sign in</button></form></section>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/login', { username: e.target.username.value, password: e.target.password.value });
      load();
    } catch (ex) { $('#err').textContent = ex.message; }
  });
}

// Revenue per day as columns, one series, so no legend: the heading says
// what it is. Hover a column for its numbers; the table toggle shows them all.
function revenueChart(days) {
  const max = Math.max(...days.map((d) => d.usd), 1);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000].find((s) => s * 4 >= max) || Math.ceil(max / 4);
  const top = step * 4;
  const W = 1000, H = 240, L = 44, B = 24, T = 16;
  const band = (W - L) / days.length;
  const bw = Math.min(24, band - 2);
  const y = (v) => T + (H - T - B) * (1 - v / top);
  const ticks = [0, 1, 2, 3, 4].map((k) => k * step);
  const peak = days.reduce((a, d) => (d.usd > a.usd ? d : a), days[0]);
  const bars = days.map((d, k) => {
    const x = L + k * band + (band - bw) / 2;
    const h = Math.max(0, y(0) - y(d.usd));
    const r = Math.min(4, h);
    const path = h > 0 ? `M${x},${y(0)}V${y(d.usd) + r}Q${x},${y(d.usd)} ${x + r},${y(d.usd)}H${x + bw - r}Q${x + bw},${y(d.usd)} ${x + bw},${y(d.usd) + r}V${y(0)}Z` : '';
    const label = (d === peak && d.usd > 0) || k === days.length - 1
      ? `<text class="val" x="${x + bw / 2}" y="${y(d.usd) - 5}" text-anchor="middle">${usd(d.usd)}</text>` : '';
    return `<g class="col" data-k="${k}"><rect class="hit" x="${L + k * band}" y="${T}" width="${band}" height="${H - T - B}"/>${path ? `<path d="${path}"/>` : ''}${label}
      ${k % 2 === days.length % 2 ? '' : `<text class="tick" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.day.slice(5).replace('-', '/')}</text>`}</g>`;
  }).join('');
  return `<div class="chart-wrap"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Revenue per day, last 14 days">
      ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${L - 8}" y="${y(v) + 4}" text-anchor="end">${usd(v)}</text>`).join('')}
      ${bars}</svg><div class="tip" hidden></div></div>
    <table class="table day-table" hidden><thead><tr><th>Day</th><th class="r">Payments</th><th class="r">Revenue</th></tr></thead>
      <tbody>${[...days].reverse().map((d) => `<tr><td>${d.day}</td><td class="r">${d.count}</td><td class="r">${usd(d.usd)}</td></tr>`).join('')}</tbody></table>`;
}
function wireChart(days) {
  const wrap = $('.chart-wrap');
  const tip = $('.tip', wrap);
  wrap.addEventListener('pointermove', (e) => {
    const g = e.target.closest('.col');
    for (const c of wrap.querySelectorAll('.col.on')) if (c !== g) c.classList.remove('on');
    if (!g) { tip.hidden = true; return; }
    g.classList.add('on');
    const d = days[g.dataset.k];
    tip.innerHTML = `<b>${new Date(`${d.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</b><br>${usd(d.usd)} · ${d.count} payment${d.count === 1 ? '' : 's'}`;
    tip.hidden = false;
    const r = wrap.getBoundingClientRect();
    tip.style.left = `${Math.min(r.width - 150, Math.max(0, e.clientX - r.left + 12))}px`;
    tip.style.top = `${Math.max(0, e.clientY - r.top - 48)}px`;
  });
  wrap.addEventListener('pointerleave', () => { tip.hidden = true; for (const c of wrap.querySelectorAll('.col.on')) c.classList.remove('on'); });
}

function userTable(rows, empty) {
  if (!rows.length) return `<p class="small">${empty}</p>`;
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Player</th><th>Country</th><th>Joined</th><th class="r">Colored</th><th class="r">Bought left</th><th class="r">Spent</th><th></th></tr></thead><tbody>
    ${rows.map((u) => `<tr class="${u.banned ? 'banned' : ''}">
      <td><b>${esc(u.name)}</b>${u.admin ? ' <span class="pill">admin</span>' : ''}${u.banned ? ' <span class="pill bad">banned</span>' : ''}</td>
      <td>${esc(countries.get(u.country) || u.country)}</td>
      <td>${ago(u.createdAt)}</td>
      <td class="r">${fmt(u.placed)}</td>
      <td class="r">${fmt(u.paid)}</td>
      <td class="r">${u.spent ? usd(u.spent) : '—'}</td>
      <td class="r">${u.admin ? '' : u.banned ? `<button class="mini" data-unban="${esc(u.name)}">Unban</button>` : `<button class="mini bad" data-ban="${esc(u.name)}">Ban</button>`}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

async function load() {
  let s;
  try {
    s = await api('/api/admin/stats');
  } catch (e) {
    if (e.status === 401) return loginForm('Sign in with an admin account.');
    if (e.status === 403) return loginForm('That account is not an admin. Sign in with one that is.');
    main.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    return;
  }
  if (!countries.size) {
    const meta = await api('/countries.json');
    countries = new Map(meta.countries.map((c) => [c.code, c.name]));
  }
  const tile = (label, value, sub = '') => `<div class="tile"><span class="label">${label}</span><b class="num">${value}</b>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
  main.innerHTML = `
    <div class="tiles">
      ${tile('On the site now', fmt(s.online.viewers), `${fmt(s.online.players)} logged in`)}
      ${tile('Players', fmt(s.users.total), `+${fmt(s.users.today)} today · +${fmt(s.users.week)} this week`)}
      ${tile('Active, last 24h', fmt(s.users.active24h), 'colored at least one pixel')}
      ${tile('Pixels colored today', fmt(s.pixels.today), `${fmt(s.pixels.total)} all time`)}
      ${tile('Revenue today', usd(s.revenue.today), `${fmt(s.revenue.waiting)} payment${s.revenue.waiting === 1 ? '' : 's'} waiting`)}
      ${tile('Last 7 days', usd(s.revenue.week), `30 days ${usd(s.revenue.month)}`)}
      ${tile('All time', usd(s.revenue.all), `from ${fmt(s.revenue.payers)} paying player${s.revenue.payers === 1 ? '' : 's'}`)}
    </div>

    <section class="card">
      <div class="card-head"><h2>Revenue per day</h2><span class="small">last 14 days, UTC · <button class="link" id="tableToggle">show table</button></span></div>
      ${revenueChart(s.revenue.byDay)}
    </section>

    <section class="card">
      <div class="card-head"><h2>Ban a player</h2></div>
      <form class="ban-form" id="banForm">
        <input type="search" name="q" placeholder="Search usernames" autocomplete="off" aria-label="Search usernames">
        <label class="check"><input type="checkbox" name="undo" checked> Also undo the pixels they colored</label>
      </form>
      <div id="search"></div>
    </section>

    <div class="cols">
      <section class="card"><div class="card-head"><h2>Recent payments</h2></div>
        ${s.payments.length ? `<table class="table"><thead><tr><th>Player</th><th>Pack</th><th class="r">Paid</th><th class="r">When</th></tr></thead><tbody>
        ${s.payments.map((p) => `<tr><td>${esc(p.user)}</td><td>${PACK[p.pack] || p.pack}</td><td class="r">${usd(p.usd)}</td><td class="r">${ago(p.paidAt)}</td></tr>`).join('')}</tbody></table>` : '<p class="small">No payments yet.</p>'}
      </section>
      <section class="card"><div class="card-head"><h2>Fastest-growing countries</h2></div>
        <table class="table"><thead><tr><th>Country</th><th class="r">Pixels</th><th class="r">Gained</th></tr></thead><tbody>
        ${s.countries.filter((c) => c.gain).map((c) => `<tr><td>${esc(c.name)}</td><td class="r">${fmt(c.pixels)}</td><td class="r ${c.gain > 0 ? 'up' : c.gain < 0 ? 'down' : ''}">${c.gain > 0 ? '+' : ''}${fmt(c.gain)}</td></tr>`).join('')}</tbody></table>
        ${s.countries.some((c) => c.gain) ? '' : '<p class="small">No country has gained or lost pixels yet.</p>'}
      </section>
    </div>

    <section class="card"><div class="card-head"><h2>Newest players</h2></div>${userTable(s.recent, 'Nobody has signed up yet.')}</section>
    <section class="card"><div class="card-head"><h2>Banned</h2></div>${userTable(s.banned, 'Nobody is banned.')}</section>`;
  wireChart(s.revenue.byDay);
  $('#tableToggle').onclick = () => {
    const t = $('.day-table');
    t.hidden = !t.hidden;
    $('#tableToggle').textContent = t.hidden ? 'show table' : 'hide table';
  };
  const form = $('#banForm');
  let timer = 0;
  const search = async () => {
    const q = form.q.value.trim();
    if (!q) { $('#search').innerHTML = ''; return; }
    const r = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
    $('#search').innerHTML = userTable(r.users, 'No player by that name.') + (r.more ? '<p class="small">Showing the first 50. Type more of the name.</p>' : '');
  };
  form.q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 200); });
  form.addEventListener('submit', (e) => e.preventDefault());
  main.onclick = async (e) => {
    const ban = e.target.closest('[data-ban]')?.dataset.ban;
    const unban = e.target.closest('[data-unban]')?.dataset.unban;
    if (!ban && !unban) return;
    const undo = form.undo.checked;
    if (ban && !confirm(`Ban ${ban}?${undo ? ' Their pixels will be put back the way they were.' : ''}`)) return;
    try {
      const r = ban ? await api('/api/admin/ban', { username: ban, undo }) : await api('/api/admin/unban', { username: unban });
      toast(ban ? `Banned ${ban}${undo ? `, ${fmt(r.undone)} pixel${r.undone === 1 ? '' : 's'} undone` : ''}.` : `Unbanned ${unban}.`, 'good');
      const q = form.q.value;
      await load();
      if (q) { $('#banForm').q.value = q; $('#banForm').q.dispatchEvent(new Event('input')); }
    } catch (ex) { toast(ex.message, 'bad'); }
  };
  $('#updated').textContent = `Updated ${new Date(s.now).toLocaleTimeString()}`;
}

load();
// Keep the numbers fresh, but not while someone is typing a search.
setInterval(() => { if (!$('#banForm')?.q.value) load(); }, 30_000);
