// scripts/quest-music.mjs — renders the Silent Friday quest's original music (no samples: every sound is synthesized
// here), so the tracks carry no third-party licence. Each track is rendered twice over, convolved with a generated
// room impulse, and the second pass is kept: the loop point then carries the reverb tail of the pass before it, so
// the track loops seamlessly in the browser.
//   node scripts/quest-music.mjs            → src/public/quest/sf/music/{dread,investigate,musicbox}.mp3 (needs ffmpeg)
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SR = 44100;
const OUT = 'src/public/quest/sf/music';
const midi = (n) => 440 * 2 ** ((n - 69) / 12);
let seed = 7;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function track(seconds) {
  const n = Math.ceil(seconds * SR);
  return { L: new Float32Array(n), R: new Float32Array(n), n };
}
function put(tr, i, v, pan) {
  if (i < 0 || i >= tr.n) return;
  tr.L[i] += v * Math.cos((pan + 1) * Math.PI / 4);
  tr.R[i] += v * Math.sin((pan + 1) * Math.PI / 4);
}

// A struck bell: inharmonic partials (hum, prime, tierce, quint, nominal...), each with its own decay.
function bell(tr, t, f, amp, pan = 0, decay = 7) {
  const parts = [[0.5, 1, 1], [1, 0.8, 0.8], [1.19, 0.45, 0.6], [1.5, 0.3, 0.5], [2, 0.4, 0.45], [2.51, 0.2, 0.3], [2.66, 0.18, 0.28], [3.01, 0.12, 0.2], [4.1, 0.08, 0.12]];
  const start = Math.floor(t * SR), len = Math.floor(decay * SR);
  for (const [r, a, d] of parts) {
    const w = 2 * Math.PI * f * r / SR, k = 1 / (decay * d * SR);
    for (let i = 0; i < len; i++) {
      const e = Math.exp(-i * k * 5) * Math.min(1, i / 40);
      put(tr, start + i, amp * a * e * Math.sin(w * i + r), pan);
    }
  }
}

// A music-box tine: a pure tone, a bright inharmonic overtone and a tick; `wow` bends the pitch like a tired spring.
function tine(tr, t, f, amp, pan = 0, wow = 0) {
  const start = Math.floor(t * SR), len = Math.floor(2.6 * SR);
  const detune = 1 + (wow ? (rand() - 0.5) * 0.012 : 0);
  let ph1 = 0, ph2 = 0, ph3 = 0;
  for (let i = 0; i < len; i++) {
    const tt = (start + i) / SR;
    const bend = detune * (1 + wow * (0.006 * Math.sin(2 * Math.PI * 0.31 * tt) + 0.003 * Math.sin(2 * Math.PI * 1.7 * tt)));
    ph1 += 2 * Math.PI * f * bend / SR; ph2 += 2 * Math.PI * f * 3.01 * bend / SR; ph3 += 2 * Math.PI * f * 5.42 * bend / SR;
    const v = Math.sin(ph1) * Math.exp(-i / (1.0 * SR)) + 0.28 * Math.sin(ph2) * Math.exp(-i / (0.22 * SR))
      + 0.12 * Math.sin(ph3) * Math.exp(-i / (0.06 * SR)) + (i < 90 ? (rand() - 0.5) * 0.5 * (1 - i / 90) : 0);
    put(tr, start + i, amp * v * Math.min(1, i / 25), pan);
  }
}

// Karplus-Strong pluck (pizzicato bass, harp).
function pluck(tr, t, f, amp, pan = 0, decay = 0.996, len = 2.2, bright = 0.5) {
  const p = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(p);
  for (let i = 0; i < p; i++) buf[i] = rand() * 2 - 1;
  let lp = 0;
  for (let i = 0; i < p; i++) { lp += bright * (buf[i] - lp); buf[i] = lp; }
  const start = Math.floor(t * SR), n = Math.floor(len * SR);
  let idx = 0;
  for (let i = 0; i < n; i++) {
    const a = buf[idx], b = buf[(idx + 1) % p];
    buf[idx] = decay * 0.5 * (a + b);
    put(tr, start + i, amp * a * Math.min(1, (n - i) / 2000), pan);
    idx = (idx + 1) % p;
  }
}

// A slow pad: detuned saws through a one-pole low-pass, with long attack and release.
function pad(tr, t, dur, notes, amp, cutoff = 900, attack = 2.5, release = 3) {
  const start = Math.floor(t * SR), n = Math.floor((dur + release) * SR);
  const k = 1 - Math.exp(-2 * Math.PI * cutoff / SR);
  notes.forEach((m, vi) => {
    const f = midi(m);
    const pan = (vi / Math.max(1, notes.length - 1)) * 1.2 - 0.6;
    for (const d of [-0.07, 0, 0.06]) {
      let ph = rand(), lp = 0, lp2 = 0;
      const inc = f * 2 ** (d / 12) / SR;
      for (let i = 0; i < n; i++) {
        ph += inc; ph -= Math.floor(ph);
        lp += k * ((ph * 2 - 1) - lp); lp2 += k * (lp - lp2);
        const s = i / SR;
        const env = Math.min(1, s / attack) * (s > dur ? Math.max(0, 1 - (s - dur) / release) : 1);
        put(tr, start + i, amp * env * lp2 / 3, pan);
      }
    }
  });
}

function sine(tr, t, dur, f, amp, pan = 0, attack = 3, release = 3, trem = 0) {
  const start = Math.floor(t * SR), n = Math.floor(dur * SR);
  for (let i = 0; i < n; i++) {
    const s = i / SR;
    const env = Math.min(1, s / attack, (dur - s) / release);
    const tr2 = trem ? 1 - trem * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.23 * s)) : 1;
    put(tr, start + i, amp * Math.max(0, env) * tr2 * Math.sin(2 * Math.PI * f * s), pan);
  }
}

// Wind or room noise: noise through a slowly swept band.
function air(tr, t, dur, amp, lo = 200, hi = 900, rate = 0.07) {
  const start = Math.floor(t * SR), n = Math.floor(dur * SR);
  let lp = 0, hp = 0;
  for (let i = 0; i < n; i++) {
    const s = i / SR;
    const fc = lo + (hi - lo) * (0.5 + 0.5 * Math.sin(2 * Math.PI * rate * s));
    const k = 1 - Math.exp(-2 * Math.PI * fc / SR);
    const x = rand() * 2 - 1;
    lp += k * (x - lp); hp += 0.02 * (lp - hp);
    const env = Math.min(1, s / 4, (dur - s) / 4);
    put(tr, start + i, amp * env * (lp - hp), Math.sin(s * 0.3) * 0.5);
  }
}

function tick(tr, t, amp, hi) {
  const start = Math.floor(t * SR);
  let lp = 0;
  for (let i = 0; i < 1400; i++) {
    const x = (rand() * 2 - 1) * Math.exp(-i / 140);
    lp += (hi ? 0.7 : 0.35) * (x - lp);
    put(tr, start + i, amp * (x - lp), hi ? 0.35 : -0.35);
  }
}

// ---- the tracks ------------------------------------------------------------------------------------------------

/** Dread: a low drone, a slow dark progression, a funeral bell every twelve seconds and two beating glass tones. */
function dread(tr, o) {
  sine(tr, o, 60, midi(26), 0.22, 0, 6, 6, 0.4);
  sine(tr, o, 60, midi(33), 0.09, 0.2, 8, 8, 0.6);
  air(tr, o, 60, 0.05, 150, 700, 0.05);
  const chords = [[50, 53, 57, 64], [46, 50, 57, 62], [43, 50, 55, 58], [45, 50, 52, 57]];
  chords.forEach((c, i) => pad(tr, o + i * 15, 13, c, 0.05, 700, 5, 4));
  for (let b = 0; b < 5; b++) bell(tr, o + 2 + b * 12, midi(50), 0.16, (b % 2 ? 0.25 : -0.25), 9);
  sine(tr, o + 20, 15, 1318.5, 0.012, -0.5, 5, 6);
  sine(tr, o + 20, 15, 1321.5, 0.012, 0.5, 5, 6);
  sine(tr, o + 44, 14, 1174.7, 0.011, 0.5, 5, 6);
  sine(tr, o + 44, 14, 1177.2, 0.011, -0.5, 5, 6);
}

/** Investigate: a clock, a pizzicato bass and a soft pad (Dm, Bb, Gm, A), then a celesta motif. 84 bpm. */
function investigate(tr, o) {
  const beat = 60 / 84;
  const prog = [[38, [50, 53, 57]], [34, [50, 53, 58]], [31, [50, 55, 58]], [33, [49, 52, 57]]];
  const motifs = [
    [[0, 69], [1, 74], [2, 77], [3.5, 76]],
    [[0, 74], [1.5, 77], [2, 74], [3, 70]],
    [[0, 70], [1, 74], [2, 79], [3.5, 77]],
    [[0, 76], [1, 73], [2, 69], [3, 64]],
  ];
  for (let pass = 0; pass < 3; pass++) {
    prog.forEach(([root, chord], ci) => {
      const t0 = o + (pass * 4 + ci) * 8 * beat;
      pad(tr, t0, 8 * beat - 0.4, chord, 0.032, 650, 1.8, 2);
      for (let bar = 0; bar < 2; bar++) {
        const b0 = t0 + bar * 4 * beat;
        pluck(tr, b0, midi(root), 0.5, -0.1, 0.995, 1.6, 0.45);
        pluck(tr, b0 + 1.5 * beat, midi(root + 7), 0.3, 0.1, 0.994, 1.2, 0.45);
        pluck(tr, b0 + 3 * beat, midi(root + 12), 0.22, 0, 0.993, 1, 0.5);
        if (pass > 0) motifs[ci].forEach(([b, m]) => { if (bar === 0 || pass === 2) tine(tr, b0 + b * beat, midi(m + (bar ? 12 : 0)), bar ? 0.03 : 0.05, 0.3, 0); });
      }
      for (let k = 0; k < 8; k++) tick(tr, t0 + k * beat, 0.05, k % 2 === 0);
    });
  }
  air(tr, o, 12 * 8 * beat, 0.02, 300, 1200, 0.03);
}

/** Music box: an out-of-tune children's waltz in A minor (72 bpm, 3/4) over a trembling drone. */
function musicbox(tr, o) {
  const beat = 60 / 72;
  const bars = [
    [57, [[0, 76], [1, 81], [2, 84]]], [57, [[0, 83, 2], [2, 81]]],
    [50, [[0, 77], [1, 81], [2, 86]]], [50, [[0, 84, 2], [2, 83]]],
    [52, [[0, 80], [1, 83], [2, 88]]], [52, [[0, 86, 1.5], [1.5, 84, 0.5], [2, 83]]],
    [57, [[0, 84], [1, 83], [2, 81]]], [57, [[0, 76, 3]]],
    [53, [[0, 81], [1, 84], [2, 89]]], [53, [[0, 88, 2], [2, 86]]],
    [50, [[0, 86], [1, 84], [2, 81]]], [46, [[0, 82, 2], [2, 81]]],
    [52, [[0, 80], [1, 83], [2, 86]]], [52, [[0, 89, 1.5], [1.5, 88, 0.5], [2, 87]]],
    [57, [[0, 84], [1, 83], [2, 81]]], [57, [[0, 81, 3]]],
  ];
  const chordOf = (root) => [root + 12, root + (root === 52 ? 16 : root === 46 || root === 53 ? 16 : 15), root + 19];
  bars.forEach(([root, notes], i) => {
    const t0 = o + i * 3 * beat;
    tine(tr, t0, midi(root - 12), 0.11, -0.3, 1);
    const ch = chordOf(root);
    tine(tr, t0 + beat, midi(ch[1]), 0.045, -0.15, 1);
    tine(tr, t0 + beat, midi(ch[2]), 0.04, -0.15, 1);
    tine(tr, t0 + 2 * beat, midi(ch[1]), 0.04, -0.15, 1);
    tine(tr, t0 + 2 * beat, midi(ch[2]), 0.035, -0.15, 1);
    notes.forEach(([b, m]) => tine(tr, t0 + b * beat, midi(m), 0.09, 0.25, 1));
  });
  const len = bars.length * 3 * beat;
  sine(tr, o, len, midi(33), 0.08, 0, 4, 4, 0.7);
  sine(tr, o, len, midi(33) * 1.006, 0.05, 0.3, 4, 4, 0.5);
  air(tr, o, len, 0.025, 600, 2400, 0.11);
}

// ---- render ----------------------------------------------------------------------------------------------------

function wav(file, tr) {
  const buf = Buffer.alloc(44 + tr.n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + tr.n * 4, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(tr.n * 4, 40);
  let peak = 0;
  for (let i = 0; i < tr.n; i++) peak = Math.max(peak, Math.abs(tr.L[i]), Math.abs(tr.R[i]));
  const g = peak > 0 ? 0.89 / peak : 1;
  for (let i = 0; i < tr.n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tr.L[i] * g)) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, tr.R[i] * g)) * 32767), 46 + i * 4);
  }
  writeFileSync(file, buf);
}

function impulse(seconds) {
  const tr = track(seconds);
  for (let i = 0; i < tr.n; i++) {
    const e = Math.exp(-i / (SR * seconds / 6));
    tr.L[i] = (rand() * 2 - 1) * e; tr.R[i] = (rand() * 2 - 1) * e;
  }
  tr.L[0] = 1; tr.R[0] = 1;
  return tr;
}

const tracks = { dread: [dread, 60], investigate: [investigate, 12 * 8 * 60 / 84], musicbox: [musicbox, 16 * 3 * 60 / 72] };
const dir = mkdtempSync(join(tmpdir(), 'quest-music-'));
try {
  wav(join(dir, 'ir.wav'), impulse(2.8));
  for (const [name, [fn, len]] of Object.entries(tracks)) {
    seed = 7 + name.length;
    const tr = track(len * 2 + 0.5);
    fn(tr, 0); fn(tr, len);
    wav(join(dir, `${name}.wav`), tr);
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', join(dir, `${name}.wav`), '-i', join(dir, 'ir.wav'), '-filter_complex',
      `[0]asplit[d][w];[w][1]afir=dry=10:wet=10[r];[d][r]amix=inputs=2:weights='1 0.35':normalize=0,atrim=start=${len}:end=${len * 2},asetpts=N/SR/TB,loudnorm=I=-21:TP=-2`,
      '-ar', '44100', '-b:a', '128k', join(OUT, `${name}.mp3`)], { stdio: 'inherit' });
    console.log(`${name}.mp3  ${len.toFixed(1)} s`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
