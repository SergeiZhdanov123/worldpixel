// Small clicks and pops, made in the browser with Web Audio (no sound
// files). Sound can be switched off; the choice is kept in this browser.
let ctx = null, out = null, hiss = null;
let on = true;
try { on = localStorage.getItem('wp-sound') !== 'off'; } catch {}

function audio() {
  if (!on) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(ctx.destination);
    hiss = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = hiss.getChannelData(0);
    for (let k = 0; k < d.length; k++) d[k] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
// Phones only let audio start during a tap, so wake it on the first one.
addEventListener('pointerdown', () => audio(), { once: true, capture: true });

function tone({ f, f2 = f, dur, type = 'sine', vol = 0.2, at = 0 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2 !== f) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function tick({ f, dur = 0.018, q = 0.9, vol = 0.25, at = 0 }) {
  const t = ctx.currentTime + at;
  const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
  src.buffer = hiss;
  bp.type = 'bandpass';
  bp.frequency.value = f;
  bp.Q.value = q;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.01);
}

// Pixels colored in quick succession climb in pitch, up to a fifth.
let streak = 0, lastPlace = 0;

export const sound = {
  get on() { return on; },
  toggle() {
    on = !on;
    try { localStorage.setItem('wp-sound', on ? 'on' : 'off'); } catch {}
    if (on && audio()) sound.click();
    return on;
  },
  // Buttons.
  click() {
    if (!audio()) return;
    tick({ f: 2600, vol: 0.22 });
    tone({ f: 1500, f2: 1100, dur: 0.03, vol: 0.05 });
  },
  // Coloring a pixel.
  place() {
    if (!audio()) return;
    const now = performance.now();
    streak = now - lastPlace < 1200 ? Math.min(streak + 1, 7) : 0;
    lastPlace = now;
    const r = 2 ** (streak / 12) * (0.97 + Math.random() * 0.06);
    tick({ f: 3800, dur: 0.012, vol: 0.16 });
    tone({ f: 480 * r, f2: 940 * r, dur: 0.075, type: 'triangle', vol: 0.24 });
  },
  // Can't color there, or out of pixels.
  deny() {
    if (!audio()) return;
    tone({ f: 210, f2: 150, dur: 0.09, type: 'triangle', vol: 0.22 });
    tone({ f: 190, f2: 130, dur: 0.11, type: 'triangle', vol: 0.2, at: 0.085 });
  },
  // Signed up, or a payment came through.
  chime() {
    if (!audio()) return;
    [784, 988, 1175].forEach((f, k) => tone({ f, dur: 0.32, vol: 0.13, at: k * 0.07 }));
  },
};
