// src/public/quest.js — the story quest stage (src/quest): a visual novel played in a modal <dialog> over the quest
// journal. The server hands over one unlocked chapter at a time (GET /quests/<id>/chapter/<n>): a list of scene steps
// (src/quest/types.ts) that this file plays in order.
//   Picture: backdrops crossfade and slowly drift, a camera can push in, colour grades and cinema bars, particles
//   (dust in the lamplight, fireflies, embers, ash), a location caption, portraits that face whoever they talk to,
//   breathe while idle and flinch on a reveal, full-screen pictures, letters, items and a stamped contract.
//   Sound: music crossfades between tracks, a synthesized ambience per place (a busy hall, a night street, a crowd,
//   a quiet room, a fire), every character has a voice pitch for the typed line, and reveals land with a sting.
//   Play: the narrator's box in the middle of the screen, the guild's parchment dialogue box, choices on wooden
//   plaques (keys 1-9), places to search marked on the picture itself, and a case file at the end of a case chapter:
//   the answer is checked by the server (POST), which then sends the scenes after it.
// The player's place in a chapter is kept in this browser, so closing the stage loses nothing.
// Controls: click / Space / Enter advance (a click while a line types finishes it), 1-9 pick a choice, A toggles
// auto, hold Ctrl to skip, L opens the log, M switches sound, Esc leaves. With reduced motion nothing drifts, shakes or
// floats; text still types.
(function () {
  'use strict';
  var bootEl = document.getElementById('quest-boot');
  var page = document.querySelector('[data-quest-page]');
  if (!bootEl || !page) return;
  var boot = JSON.parse(bootEl.textContent);
  var UI = boot.ui;
  var ART = '/static/quest/' + boot.quest.art;
  var QID = boot.quest.id;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var S = window.hvwaSound || null;

  function el(tag, cls, parent) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }
  function sleep(ms) { return new Promise(function (r) { window.setTimeout(r, ms); }); }
  function fill(text) {
    return String(text).replace(/\{name\}/g, boot.player.name).replace(/\{host13\}/g, rot13(boot.host)).replace(/\{host\}/g, boot.host);
  }
  function rot13(s) {
    return String(s).replace(/[a-z]/gi, function (c) { var b = c <= 'Z' ? 65 : 97; return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b); });
  }
  function store(k, v) { try { if (v === null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, String(v)); } catch (e) { /* storage blocked */ } }
  function load(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  var placeKey = function (n) { return 'hvwa-quest:' + QID + ':' + n; };
  var soundOn = function () { return !!(S && S.isOn()); };

  // ---- synthesis helpers (Web Audio, through the guild's mixer) ----------------------------------------------------
  function ac() { return S ? S.context() : null; }
  function noiseBuf(c) {
    if (noiseBuf.b && noiseBuf.b.sampleRate === c.sampleRate) return noiseBuf.b;
    var b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf.b = b;
    return b;
  }
  function gainAt(c, out, at, peak, attack, hold, release) {
    var g = c.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), at + attack);
    g.gain.setValueAtTime(Math.max(0.0002, peak), at + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
    g.connect(out);
    return g;
  }
  function osc(c, out, type, f, at, dur, peak, glide, attack) {
    var o = c.createOscillator();
    o.type = type; o.frequency.setValueAtTime(f, at);
    if (glide) o.frequency.exponentialRampToValueAtTime(glide, at + dur);
    o.connect(gainAt(c, out, at, peak, attack || 0.005, 0, dur));
    o.start(at); o.stop(at + dur + 0.1);
  }
  function band(c, out, at, dur, peak, from, to, q, attack, type) {
    var s = c.createBufferSource(); s.buffer = noiseBuf(c); s.loop = true;
    var f = c.createBiquadFilter(); f.type = type || 'bandpass'; f.Q.value = q || 1;
    f.frequency.setValueAtTime(from, at);
    if (to) f.frequency.exponentialRampToValueAtTime(to, at + dur);
    s.connect(f); f.connect(gainAt(c, out, at, peak, attack || 0.02, dur * 0.4, dur * 0.6));
    s.start(at, Math.random()); s.stop(at + dur + 0.2);
  }

  // ---- music: two players crossfade from track to track; silent while sound is off --------------------------------
  var Music = (function () {
    var VOL = 0.45;
    var cur = null, name = null, cache = {};
    function fadeTo(a, target, ms, then) {
      var start = a.volume, t0 = performance.now();
      function step(now) {
        var k = ms <= 0 ? 1 : Math.min(1, (now - t0) / ms);
        a.volume = Math.max(0, Math.min(1, start + (target - start) * k));
        if (k < 1) window.requestAnimationFrame(step); else if (then) then();
      }
      window.requestAnimationFrame(step);
    }
    function player(n) {
      if (!cache[n]) { var a = new Audio(ART + '/music/' + n + '.mp3'); a.loop = true; a.preload = 'auto'; cache[n] = a; }
      return cache[n];
    }
    function play(n, fade) {
      if (n === name) return;
      var old = cur;
      name = n; cur = null;
      if (old) fadeTo(old, 0, fade, function () { old.pause(); });
      if (!n) return;
      var a = player(n);
      cur = a;
      if (!soundOn()) return;
      a.volume = 0;
      try { a.currentTime = 0; } catch (e) { /* not seekable yet */ }
      var p = a.play();
      if (p && p.catch) p.catch(function () { /* no gesture yet: the next advance resumes */ });
      fadeTo(a, VOL, fade);
    }
    function resume() {
      if (cur && cur.paused && soundOn()) { var p = cur.play(); if (p && p.catch) p.catch(function () {}); fadeTo(cur, VOL, 600); }
    }
    function silence(ms) { if (cur) { var a = cur; fadeTo(a, 0, ms, function () { a.pause(); }); } }
    function duck(on) { if (cur && !cur.paused) fadeTo(cur, on ? VOL * 0.35 : VOL, on ? 120 : 1400); }
    function stop(ms) { silence(ms); name = null; cur = null; }
    function preload(n) { if (n) player(n).load(); }
    return { play: play, resume: resume, silence: silence, stop: stop, preload: preload, duck: duck, current: function () { return name; } };
  })();

  // ---- ambience: a place's sound bed, synthesized (no files) --------------------------------------------------------
  var Amb = (function () {
    var cur = null, name = null;
    function bed(c, out, type, freq, q, vol, lfoRate, lfoDepth) {
      var s = c.createBufferSource(); s.buffer = noiseBuf(c); s.loop = true;
      var f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      var g = c.createGain(); g.gain.value = vol;
      s.connect(f); f.connect(g); g.connect(out);
      var nodes = [s];
      if (lfoRate) {
        var l = c.createOscillator(); l.frequency.value = lfoRate;
        var lg = c.createGain(); lg.gain.value = lfoDepth;
        l.connect(lg); lg.connect(g.gain); l.start(); nodes.push(l);
      }
      s.start(0, Math.random() * 1.5);
      return nodes;
    }
    var BEDS = {
      hall: function (c, o, every) {   // a full guild hall: low chatter, the odd mug set down
        var n = bed(c, o, 'lowpass', 420, 0.7, 0.16, 0.13, 0.06).concat(bed(c, o, 'bandpass', 720, 1.4, 0.1, 0.37, 0.05));
        every(1600, 4600, function (t) { osc(c, o, 'sine', 2300 + Math.random() * 600, t, 0.18, 0.012); osc(c, o, 'sine', 3500 + Math.random() * 500, t, 0.12, 0.006); });
        every(2500, 6500, function (t) { band(c, o, t, 0.5 + Math.random() * 0.6, 0.03, 400 + Math.random() * 500, 0, 3, 0.1); });
        return n;
      },
      night: function (c, o, every) {  // wind between houses, crickets
        var n = bed(c, o, 'bandpass', 480, 0.7, 0.12, 0.07, 0.07);
        every(900, 2600, function (t) { for (var i = 0; i < 3 + (Math.random() * 3 | 0); i++) osc(c, o, 'sine', 4300 + Math.random() * 300, t + i * 0.075, 0.035, 0.008); });
        return n;
      },
      park: function (c, o, every) {   // a crowd at play, far off, and birds
        var n = bed(c, o, 'bandpass', 950, 0.6, 0.1, 0.29, 0.04).concat(bed(c, o, 'lowpass', 300, 0.7, 0.06, 0.1, 0.02));
        every(2200, 5500, function (t) { var f = 2800 + Math.random() * 1200; osc(c, o, 'sine', f, t, 0.09, 0.01, f * 1.3); osc(c, o, 'sine', f * 1.1, t + 0.13, 0.08, 0.008, f * 1.45); });
        return n;
      },
      crowd: function (c, o, every) {  // a frightened crowd close by
        var n = bed(c, o, 'bandpass', 680, 0.9, 0.2, 0.9, 0.1).concat(bed(c, o, 'lowpass', 320, 0.7, 0.14, 0.5, 0.05));
        every(500, 1400, function (t) { band(c, o, t, 0.4 + Math.random() * 0.5, 0.05, 350 + Math.random() * 900, 0, 4, 0.05); });
        return n;
      },
      room: function (c, o, every) {   // a still room: a clock, the house settling
        var n = bed(c, o, 'lowpass', 180, 0.7, 0.05, 0, 0);
        var tick = 0;
        every(1000, 1000, function (t) { tick++; band(c, o, t, 0.03, tick % 2 ? 0.05 : 0.035, tick % 2 ? 3200 : 2400, 0, 6, 0.002); });
        every(7000, 15000, function (t) { osc(c, o, 'sawtooth', 110, t, 0.5, 0.006, 80, 0.1); });
        return n;
      },
      pyre: function (c, o, every) {   // a fire in a crowded square: the crackle, a crowd keeping very quiet, crows
        var n = bed(c, o, 'lowpass', 220, 0.7, 0.18, 0.3, 0.06).concat(bed(c, o, 'bandpass', 600, 0.9, 0.05, 0.5, 0.02));
        every(70, 300, function (t) { band(c, o, t, 0.02 + Math.random() * 0.04, 0.04 + Math.random() * 0.08, 1800 + Math.random() * 3000, 0, 2, 0.001, 'highpass'); });
        every(3500, 8000, function (t) { var f = 560 + Math.random() * 120; osc(c, o, 'sawtooth', f, t, 0.24, 0.03, f * 0.72, 0.01); band(c, o, t, 0.22, 0.06, 1300, 900, 2.5, 0.01); });
        return n;
      },
      fire: function (c, o, every) {   // a house burning: the roar and the crackle
        var n = bed(c, o, 'lowpass', 190, 0.7, 0.3, 0.4, 0.1).concat(bed(c, o, 'bandpass', 900, 0.8, 0.05, 0.7, 0.03));
        every(50, 240, function (t) { band(c, o, t, 0.02 + Math.random() * 0.04, 0.05 + Math.random() * 0.12, 1800 + Math.random() * 3000, 0, 2, 0.001, 'highpass'); });
        return n;
      },
    };
    function stopCur(ms) {
      if (!cur) return;
      var x = cur; cur = null;
      x.alive = false;
      x.timers.forEach(function (id) { window.clearTimeout(id); });
      try {
        var c = x.ctx, t = c.currentTime;
        x.out.gain.cancelScheduledValues(t);
        x.out.gain.setValueAtTime(x.out.gain.value, t);
        x.out.gain.linearRampToValueAtTime(0, t + ms / 1000);
        window.setTimeout(function () { x.nodes.forEach(function (n) { try { n.stop(); } catch (e) { /* already stopped */ } }); x.out.disconnect(); }, ms + 100);
      } catch (e) { /* the context went away */ }
    }
    function start() {
      if (!name || !soundOn() || !BEDS[name]) return;
      var c = ac();
      if (!c) return;
      var out = c.createGain(); out.gain.value = 0; out.connect(S.output());
      var x = { ctx: c, out: out, nodes: [], timers: [], alive: true };
      function every(min, max, fn) {
        (function next() {
          var id = window.setTimeout(function () { if (!x.alive) return; fn(c.currentTime + 0.02); next(); }, min + Math.random() * (max - min));
          x.timers.push(id);
          if (x.timers.length > 50) x.timers.splice(0, 25);
        })();
      }
      x.nodes = BEDS[name](c, out, every);
      out.gain.linearRampToValueAtTime(1, c.currentTime + 2.2);
      cur = x;
    }
    function set(n) {
      if (n === name && (cur || !soundOn())) return;
      name = n || null;
      stopCur(1400);
      start();
    }
    function pause(ms) { stopCur(ms || 400); }
    function resume() { if (!cur) start(); }
    function stop(ms) { name = null; stopCur(ms || 600); }
    return { set: set, pause: pause, resume: resume, stop: stop, current: function () { return name; } };
  })();

  // ---- effects: the guild's own (paper, seal, chime...) plus the quest's ---------------------------------------------
  var QSFX = {
    bell: function (c, o, t) { [[2093, 0.09, 1.6], [2512, 0.05, 1.1], [3346, 0.04, 0.7], [4702, 0.02, 0.4]].forEach(function (p) { osc(c, o, 'sine', p[0], t, p[2], p[1]); osc(c, o, 'sine', p[0] * 1.004, t + 0.12, p[2] * 0.8, p[1] * 0.6); }); },
    // One lub-dub for the running heartbeat: a heavy low thump, then a lighter one right behind it.
    beat: function (c, o, t) {
      osc(c, o, 'sine', 64, t, 0.2, 0.75, 34);
      band(c, o, t, 0.09, 0.12, 180, 60, 0.8, 0.002, 'lowpass');
      osc(c, o, 'sine', 54, t + 0.19, 0.18, 0.5, 32);
    },
    // A quick-time moment opens: a low hit and a tone that climbs, the body bracing.
    qte: function (c, o, t) { osc(c, o, 'sine', 70, t, 0.7, 0.6, 38); osc(c, o, 'sawtooth', 220, t, 0.55, 0.025, 660, 0.05); band(c, o, t, 0.4, 0.12, 300, 2200, 1.2, 0.02); },
    // A quick-time moment won: air let out, a bright release.
    release: function (c, o, t) { band(c, o, t, 0.6, 0.18, 2600, 500, 0.8, 0.01); osc(c, o, 'sine', 880, t + 0.02, 0.5, 0.05, 1320); osc(c, o, 'sine', 1320, t + 0.08, 0.45, 0.03, 1760); },
    // A miss: a dull knock and a short scrape.
    miss: function (c, o, t) { osc(c, o, 'sine', 95, t, 0.3, 0.55, 45); band(c, o, t, 0.18, 0.12, 900, 300, 2, 0.003); },
    // Crows: three hoarse caws, falling in pitch, from somewhere above.
    crows: function (c, o, t) {
      [0, 0.42, 0.95].forEach(function (d, i) {
        var f = 620 - i * 50 + Math.random() * 60;
        osc(c, o, 'sawtooth', f, t + d, 0.26, 0.05, f * 0.72, 0.01);
        band(c, o, t + d, 0.24, 0.12, 1400, 900, 2.5, 0.01);
      });
    },
    // The ears ringing after a blow: a thin high tone that swells and takes a long time to go.
    ring: function (c, o, t) { osc(c, o, 'sine', 6200, t, 5.5, 0.03, 6100, 0.6); osc(c, o, 'sine', 3100, t, 4, 0.008, 3080, 0.8); },
    heartbeat: function (c, o, t) { [0, 0.28, 1.05, 1.33].forEach(function (d, i) { osc(c, o, 'sine', i % 2 ? 52 : 62, t + d, 0.22, i % 2 ? 0.35 : 0.5, 38); }); },
    scream: function (c, o, t) {
      band(c, o, t, 1.4, 0.35, 900, 2600, 3, 0.04);
      [1046, 1108, 1174].forEach(function (f) { osc(c, o, 'sawtooth', f, t, 1.2, 0.04, f * 1.35); });
      osc(c, o, 'sine', 70, t, 1.2, 0.5, 40);
    },
    // A reveal: a sub drop under a scrape of strings, the "something is wrong" of a horror score.
    sting: function (c, o, t) {
      osc(c, o, 'sine', 90, t, 1.6, 0.7, 32);
      [1244, 1318, 1396, 1480].forEach(function (f, i) { osc(c, o, 'sawtooth', f, t + i * 0.012, 1.1, 0.03, f * 0.96, 0.02); });
      band(c, o, t, 0.9, 0.3, 4000, 900, 1.2, 0.005);
    },
    // A powder keg: a hard sub punch, a long roar of noise falling away, and debris.
    boom: function (c, o, t) {
      osc(c, o, 'sine', 95, t, 1.4, 0.9, 28);
      band(c, o, t, 2.4, 0.5, 900, 120, 0.7, 0.004, 'lowpass');
      for (var i = 0; i < 6; i++) band(c, o, t + 0.3 + Math.random() * 1.2, 0.12, 0.05, 2000 + Math.random() * 2000, 0, 2, 0.002);
    },
    arrow: function (c, o, t) { band(c, o, t, 0.28, 0.16, 5000, 1200, 2.5, 0.01); osc(c, o, 'sine', 160, t + 0.3, 0.2, 0.45, 70); },
    thud: function (c, o, t) { osc(c, o, 'sine', 120, t, 0.45, 0.6, 40); band(c, o, t, 0.2, 0.12, 300, 0, 1, 0.003, 'lowpass'); },
    murmur: function (c, o, t) { for (var i = 0; i < 7; i++) band(c, o, t + i * 0.35, 1.8, 0.05, 300 + Math.random() * 700, 0, 4, 0.3); },
    glitch: function (c, o, t) { for (var i = 0; i < 4; i++) { var d = i * (0.025 + Math.random() * 0.03); band(c, o, t + d, 0.03, 0.16, 300 + Math.random() * 5000, 0, 0.6, 0.001); osc(c, o, 'square', 60 + Math.random() * 900, t + d, 0.025, 0.035); } },
    clash: function (c, o, t) { [1720, 2890, 4370, 6150].forEach(function (f, i) { osc(c, o, 'sine', f, t, 0.55 - i * 0.1, 0.06 - i * 0.012, f * 0.996); }); band(c, o, t, 0.07, 0.35, 2500, 9000, 1.1, 0.001); },
    cut: function (c, o, t) { band(c, o, t, 0.28, 0.25, 2500, 6000, 1.5, 0.01); osc(c, o, 'triangle', 900, t + 0.05, 0.12, 0.05, 400); },
    door: function (c, o, t) { osc(c, o, 'sawtooth', 120, t, 0.5, 0.04, 85); band(c, o, t, 0.6, 0.05, 400, 900, 3); osc(c, o, 'sine', 70, t + 0.55, 0.3, 0.45, 45); },
    armor: function (c, o, t) { [0, 0.33, 0.6, 0.9].forEach(function (d) { osc(c, o, 'square', 1800 + Math.random() * 600, t + d, 0.06, 0.03); band(c, o, t + d, 0.12, 0.12, 150, 0, 1, 0.005); }); },
    alarm: function (c, o, t) { for (var i = 0; i < 4; i++) { [[880, 0.07], [1320, 0.04], [2211, 0.02]].forEach(function (p) { osc(c, o, 'sine', p[0], t + i * 0.9, 1.4, p[1]); }); } },
    whoosh: function (c, o, t) { band(c, o, t, 0.5, 0.2, 400, 3000, 0.8, 0.12); },
    spot: function (c, o, t) { osc(c, o, 'sine', 1568, t, 0.25, 0.04); osc(c, o, 'sine', 2349, t + 0.06, 0.3, 0.03); },
    pick: function (c, o, t) { osc(c, o, 'triangle', 660, t, 0.08, 0.06, 990); band(c, o, t, 0.12, 0.08, 1800, 3600, 2, 0.002); },
  };
  // Recorded effects (static/quest/<art>/sfx/<file>.mp3): an effect listed here plays one of its recordings, picked at
  // random so a second scream is not the first one again; if a file cannot play, the synthesized one stands in.
  var SFX_FILES = { scream: ['scream-1', 'scream-2', 'scream-3'] };
  var sfxCache = {};
  function sfxFile(name) {
    var list = SFX_FILES[name];
    if (!list) return false;
    var f = list[Math.floor(Math.random() * list.length)];
    var a = sfxCache[f] || (sfxCache[f] = new Audio(ART + '/sfx/' + f + '.mp3'));
    if (a.error) return false;
    try { a.currentTime = 0; } catch (e) { /* not loaded yet */ }
    a.volume = 0.8;
    var p = a.play();
    if (p && p.catch) p.catch(function () { /* blocked or missing: stay silent */ });
    return true;
  }
  function preloadSfx() { Object.keys(SFX_FILES).forEach(function (k) { SFX_FILES[k].forEach(function (f) { if (!sfxCache[f]) { sfxCache[f] = new Audio(ART + '/sfx/' + f + '.mp3'); sfxCache[f].preload = 'auto'; } }); }); }
  function sfx(name) {
    if (!soundOn()) return;
    if (sfxFile(name)) return;
    if (QSFX[name]) {
      var c = ac();
      if (!c) return;
      QSFX[name](c, S.output(), c.currentTime + 0.02);
    } else S.play(name);
  }
  // Each character speaks with a pitch of their own: the classic RPG "talk" chirp every other letter while the line
  // types, a short square wave softened by a low-pass, a little random in pitch so a sentence sounds like speech.
  function voice(pitch, soft) {
    if (!soundOn()) return;
    var c = ac();
    if (!c) return;
    var t = c.currentTime + 0.005;
    var f = pitch * (0.93 + Math.random() * 0.14);
    var o = c.createOscillator(); o.type = 'square'; o.frequency.setValueAtTime(f, t);
    var lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = Math.min(6000, f * 5);
    o.connect(lp); lp.connect(gainAt(c, S.output(), t, soft ? 0.028 : 0.075, 0.003, 0.014, 0.035));
    o.start(t); o.stop(t + 0.08);
  }
  // Key phrases are written **like this** in the story: drawn in gold (narrator) or deep red (dialogue).
  function plain(text) { return String(text).replace(/\*\*/g, ''); }
  function rich(target, text) {
    target.textContent = '';
    String(text).split('**').forEach(function (part, i) {
      if (!part) return;
      if (i % 2) el('span', 'qs-key', target).textContent = part; else target.appendChild(document.createTextNode(part));
    });
  }

  // ---- the stage -----------------------------------------------------------------------------------------------
  var dlg = el('dialog', 'qs');
  dlg.tabIndex = -1;
  dlg.setAttribute('aria-label', boot.quest.title);
  dlg.setAttribute('data-testid', 'quest-stage');
  var scene = el('div', 'qs-scene', dlg);
  var cam = el('div', 'qs-cam', scene);
  var bgWrap = el('div', 'qs-bg', cam);
  var bgA = el('img', 'qs-bg-img', bgWrap), bgB = el('img', 'qs-bg-img', bgWrap);
  [bgA, bgB].forEach(function (i) { i.alt = ''; i.decoding = 'async'; });
  var bgFront = bgA;
  // One censor layer per backdrop picture (boot.censor), above both pictures: see showCensor.
  var censorA = el('div', 'qs-censor', bgWrap), censorB = el('div', 'qs-censor', bgWrap);
  censorA.setAttribute('aria-hidden', 'true'); censorB.setAttribute('aria-hidden', 'true');
  var castLayer = el('div', 'qs-cast', cam);
  var tint = el('div', 'qs-tint', scene);
  el('div', 'qs-memory', scene);   // a flashback's soft edge and grain; graded by .qs[data-flashback]
  el('div', 'qs-tears', scene);    // eyes welling up: the picture swims ({ tears })
  el('div', 'qs-vignette', scene);
  var canvas = el('canvas', 'qs-particles', scene);
  var spots = el('div', 'qs-spots', scene);
  var cgWrap = el('div', 'qs-cg', scene);
  var cgImg = el('img', '', cgWrap); cgImg.alt = '';
  var seekWrap = el('div', 'qs-seek', scene);   // a picture searched with the eye ({ seek })
  var glitchWrap = el('div', 'qs-glitch', scene); // a mind coming apart ({ glitch })
  var glitchR = el('div', 'qs-glitch-r', glitchWrap), glitchC = el('div', 'qs-glitch-c', glitchWrap);
  var glitchNoise = el('canvas', 'qs-glitch-noise', glitchWrap);
  el('div', 'qs-glitch-lines', glitchWrap);
  var bars = el('div', 'qs-bars', dlg);
  el('span', 'qs-bar-top', bars); el('span', 'qs-bar-bottom', bars);
  var black = el('div', 'qs-black is-on', dlg);
  var flash = el('div', 'qs-flash', dlg);
  var heartEl = el('div', 'qs-heart', dlg);
  el('div', 'qs-maskview', dlg);   // the world seen through the eyeholes of a mask ({ maskview })
  var placeCard = el('div', 'qs-place', dlg);
  var placeName = el('p', 'qs-place-name', placeCard), placeTime = el('p', 'qs-place-time', placeCard);
  var titleCard = el('div', 'qs-title', dlg);
  el('span', 'qs-title-orn', titleCard);
  var titleSub = el('p', 'qs-title-sub', titleCard), titleMain = el('h2', 'qs-title-main', titleCard);
  el('span', 'qs-title-rule', titleCard);
  // End credits: lines rolling up over black, at reading pace; a click lets them go.
  var creditsBox = el('div', 'qs-credits', dlg), creditsRoll = el('div', 'qs-credits-roll', creditsBox);
  var narrBox = el('div', 'qs-narr', dlg);
  var narrText = el('p', 'qs-narr-text', narrBox);
  narrText.setAttribute('aria-live', 'polite');
  el('span', 'qs-narr-more', narrBox).setAttribute('aria-hidden', 'true');
  var overlay = el('div', 'qs-overlay', dlg);
  var box = el('div', 'qs-box dialogue', dlg);
  var nameTag = el('p', 'dialogue-name qs-name', box);
  var nameSpeaker = el('span', 'dialogue-speaker', nameTag), nameRole = el('span', 'dialogue-role', nameTag);
  var face = el('img', 'qs-face', box); face.alt = '';
  var boxText = el('p', 'dialogue-text qs-line', box);
  boxText.setAttribute('aria-live', 'polite');
  el('span', 'dialogue-more qs-more', box).setAttribute('aria-hidden', 'true');
  var choices = el('div', 'qs-choices', dlg);
  var qteWrap = el('div', 'qs-qte', dlg);
  var caseWrap = el('div', 'qs-case-wrap', dlg);
  var hint = el('p', 'qs-hint', dlg); hint.textContent = UI.tap;
  var bar = el('div', 'qs-bar', dlg);
  function barBtn(label, key, icon) {
    var b = el('button', 'qs-btn', bar);
    b.type = 'button'; b.setAttribute('data-qs', key); b.title = label;
    b.innerHTML = '<svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#' + icon + '"></use></svg><span>' + label + '</span>';
    return b;
  }
  var autoBtn = barBtn(UI.auto, 'auto', 'i-rotate'), skipBtn = barBtn(UI.skip, 'skip', 'i-arrow-right');
  var logBtn = barBtn(UI.log, 'log', 'i-messages'), soundBtn = barBtn(UI.sound, 'sound', 'i-sound-on');
  var textBtn = barBtn(UI.text, 'text', 'i-type');
  var closeBtn = barBtn(UI.close, 'close', 'i-x');
  // Text size: three steps (the default already a little larger than the guild's paper), kept on this device.
  var TEXT_SIZES = [1, 1.15, 1.3];
  function textSize() { var i = Number(load('qs-text-size')); return i >= 0 && i < TEXT_SIZES.length ? i : 0; }
  function applyTextSize() {
    var i = textSize();
    dlg.style.setProperty('--qs-fs', String(TEXT_SIZES[i]));
    textBtn.setAttribute('aria-label', UI.text + ' ' + (i + 1) + '/' + TEXT_SIZES.length);
    textBtn.setAttribute('data-size', String(i + 1));
  }
  applyTextSize();
  textBtn.addEventListener('click', function () {
    store('qs-text-size', (textSize() + 1) % TEXT_SIZES.length);
    applyTextSize();
    dlg.focus({ preventScroll: true });
  });
  autoBtn.setAttribute('aria-pressed', 'false'); skipBtn.setAttribute('aria-pressed', 'false');
  function syncSound() {
    soundBtn.setAttribute('aria-pressed', String(soundOn()));
    var use = soundBtn.querySelector('use');
    if (use) use.setAttribute('href', '/static/icons.svg#' + (soundOn() ? 'i-sound-on' : 'i-sound-off'));
  }
  syncSound();
  var logPanel = el('div', 'qs-log', dlg);
  var logHead = el('div', 'qs-log-head', logPanel);
  var logTitle = el('h3', '', logHead); logTitle.textContent = UI.backlog;
  var logClose = el('button', 'qs-btn', logHead); logClose.type = 'button'; logClose.textContent = UI.close;
  var logList = el('ol', 'qs-log-list', logPanel);
  var endWrap = el('div', 'qs-end-wrap', dlg);
  var skipWrap = el('div', 'qs-skip-wrap', dlg);
  var clueBox = el('div', 'qs-clue', dlg);
  // A language picked on the stage swaps every word the stage set up front.
  function relabel() {
    hint.textContent = UI.tap;
    [[autoBtn, UI.auto], [skipBtn, UI.skip], [logBtn, UI.log], [soundBtn, UI.sound], [closeBtn, UI.close]].forEach(function (p) {
      p[0].title = p[1];
      var s = p[0].querySelector('span');
      if (s) s.textContent = p[1];
    });
    logTitle.textContent = UI.backlog;
    logClose.textContent = UI.close;
  }
  clueBox.setAttribute('role', 'status');
  document.body.appendChild(dlg);

  // ---- particles: dust in the lamplight, fireflies, embers, ash --------------------------------------------------
  var Particles = (function () {
    var g = canvas.getContext('2d');
    var mode = null, ps = [], raf = 0, W = 0, H = 0;
    var KIND = {
      dust: { n: 70, rgb: '255,220,170' },
      fireflies: { n: 26, rgb: '214,255,150' },
      embers: { n: 90, rgb: '255,150,60' },
      ash: { n: 90, rgb: '205,200,195' },
    };
    function resize() {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      W = canvas.clientWidth; H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    function spawn(fresh) {
      var p = { x: Math.random() * W, y: Math.random() * H, t: Math.random() * 100, life: 1 };
      if (mode === 'dust') { p.r = 0.6 + Math.random() * 1.6; p.vx = (Math.random() - 0.5) * 0.12; p.vy = (Math.random() - 0.6) * 0.08; p.a = 0.15 + Math.random() * 0.4; }
      if (mode === 'fireflies') { p.r = 1.4 + Math.random() * 1.4; p.vx = (Math.random() - 0.5) * 0.3; p.vy = (Math.random() - 0.5) * 0.3; p.a = 0.6; p.y = H * (0.35 + Math.random() * 0.65); }
      if (mode === 'embers') { p.r = 0.8 + Math.random() * 1.8; p.vx = (Math.random() - 0.5) * 0.4; p.vy = -(0.5 + Math.random() * 1.3); p.a = 0.5 + Math.random() * 0.5; if (!fresh) p.y = H + 10; }
      if (mode === 'ash') { p.r = 0.8 + Math.random() * 2; p.vx = (Math.random() - 0.5) * 0.3; p.vy = 0.2 + Math.random() * 0.5; p.a = 0.25 + Math.random() * 0.45; if (!fresh) p.y = -10; }
      return p;
    }
    function frame() {
      raf = window.requestAnimationFrame(frame);
      if (!mode) return;
      g.clearRect(0, 0, W, H);
      g.globalCompositeOperation = mode === 'ash' ? 'source-over' : 'lighter';
      var rgb = KIND[mode].rgb;
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        p.t += 0.016;
        p.x += p.vx + Math.sin(p.t * (mode === 'fireflies' ? 1.3 : 0.6) + i) * (mode === 'embers' ? 0.35 : 0.12);
        p.y += p.vy;
        var a = p.a;
        if (mode === 'dust') a *= 0.6 + 0.4 * Math.sin(p.t * 1.7 + i);
        if (mode === 'fireflies') a *= Math.max(0, Math.sin(p.t * 0.9 + i * 1.7));
        if (mode === 'embers') { p.life -= 0.004; a *= Math.max(0, p.life); }
        if (p.y < -20 || p.y > H + 20 || p.x < -20 || p.x > W + 20 || p.life <= 0) { ps[i] = spawn(false); continue; }
        if (a <= 0.01) continue;
        if (mode !== 'ash') {
          var gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4);
          gr.addColorStop(0, 'rgba(' + rgb + ',' + a + ')');
          gr.addColorStop(1, 'rgba(' + rgb + ',0)');
          g.fillStyle = gr;
          g.beginPath(); g.arc(p.x, p.y, p.r * 4, 0, 6.283); g.fill();
        } else {
          g.fillStyle = 'rgba(' + rgb + ',' + a + ')';
          g.beginPath(); g.ellipse(p.x, p.y, p.r, p.r * 0.6, p.t, 0, 6.283); g.fill();
        }
      }
    }
    function set(m) {
      mode = reduce ? null : (KIND[m] ? m : null);
      canvas.classList.toggle('is-on', !!mode);
      if (!mode) { window.cancelAnimationFrame(raf); raf = 0; return; }
      resize();
      ps = [];
      for (var i = 0; i < KIND[mode].n; i++) ps.push(spawn(true));
      if (!raf) frame();
    }
    function stop() { set(null); }
    window.addEventListener('resize', function () { if (mode) resize(); });
    return { set: set, stop: stop, current: function () { return mode; } };
  })();

  // ---- state ---------------------------------------------------------------------------------------------------
  var run = null;       // the chapter being played: { n, alive, chapter }
  var waiter = null;    // resolves the current "wait for the player"
  var typing = null;    // the line being typed: { finish }
  var auto = false, skip = false, ctrlSkip = false;
  var onStage = {};     // cast id -> { img, at }
  var progressed = false;
  var skipAll = false;  // the player chose "skip ahead" after reading the recap: run to the case (or the end)
  var phase = 'pre';    // which recap applies: before the case, or after it
  var fast = function () { return skip || ctrlSkip || skipAll; };

  // A censored picture (boot.censor: the healer on the cross) never shows without its boxes. Each box is laid out in
  // the picture's own coordinates (the backdrop is object-fit: cover), on a layer the size of the scene that drifts in
  // step with the picture. The layer is on the moment its picture starts to show, and lets go only in the second half of
  // the picture's fade out, so a crossfade never uncovers the face.
  function censorOf(img) { return img === bgA ? censorA : censorB; }
  function nameOf(img) { return (img.getAttribute('src') || '').replace(/^.*\/bg\//, '').replace(/\.webp$/, ''); }
  function censored(name) { return !!(boot.censor && boot.censor[name] && boot.censor[name].length); }
  function layoutCensor(img) {
    var layer = censorOf(img), boxes = boot.censor && boot.censor[layer.getAttribute('data-for')];
    layer.innerHTML = '';
    if (!boxes) return;
    var W = scene.clientWidth, H = scene.clientHeight;
    var iw = img.naturalWidth || 1672, ih = img.naturalHeight || 941;
    var k = Math.max(W / iw, H / ih), dw = iw * k, dh = ih * k, ox = (W - dw) / 2, oy = (H - dh) / 2;
    boxes.forEach(function (b) {
      var w = b.size[0] * dw, h = b.size[1] * dh;
      var box = el('span', 'qs-censor-box is-' + b.kind, layer);
      box.style.left = (ox + b.at[0] * dw - w / 2).toFixed(1) + 'px';
      box.style.top = (oy + b.at[1] * dh - h / 2).toFixed(1) + 'px';
      box.style.width = w.toFixed(1) + 'px';
      box.style.height = h.toFixed(1) + 'px';
    });
  }
  function driftOf(e) {
    if (!e.getAnimations) return null;
    return e.getAnimations().filter(function (a) { return a.animationName === 'qs-drift'; })[0] || null;
  }
  function showCensor(img, name) {
    var layer = censorOf(img);
    layer.style.transition = 'none';
    layer.classList.remove('is-on', 'is-drift');
    layer.innerHTML = '';
    if (!censored(name)) { layer.removeAttribute('data-for'); return; }
    layer.setAttribute('data-for', name);
    layoutCensor(img);
    if (img.classList.contains('is-drift')) layer.classList.add('is-drift');
    layer.classList.add('is-on');
    var a = driftOf(img), b = driftOf(layer);
    if (a && b && a.currentTime !== null) b.currentTime = a.currentTime;
  }
  function hideCensor(img, ms) {
    var layer = censorOf(img);
    if (!layer.classList.contains('is-on')) return;
    var half = Math.round((ms || 0) / 2);
    layer.style.transition = ms ? 'opacity ' + half + 'ms linear ' + half + 'ms' : 'none';
    layer.classList.remove('is-on');
  }
  [bgA, bgB].forEach(function (img) {
    img.addEventListener('load', function () { if (censorOf(img).hasAttribute('data-for')) layoutCensor(img); });
  });
  window.addEventListener('resize', function () {
    [bgA, bgB].forEach(function (img) { if (censorOf(img).hasAttribute('data-for')) layoutCensor(img); });
  });

  function setBg(name, fx) {
    if (!name) { // an empty stage: the backdrop fades out to the dark behind it
      bgFront.classList.remove('is-cut', 'is-slow'); bgFront.classList.add(fast() ? 'is-cut' : 'is-fade');
      bgFront.classList.remove('is-on');
      hideCensor(bgFront, fast() ? 0 : 1000);
      return fast() ? 0 : 600;
    }
    var src = ART + '/bg/' + name + '.webp';
    if (bgFront.getAttribute('src') === src && bgFront.classList.contains('is-on')) return 0;
    var back = bgFront === bgA ? bgB : bgA;
    back.classList.remove('is-on', 'is-slow', 'is-cut', 'is-fade', 'is-drift');
    back.setAttribute('src', src);
    void back.offsetWidth;
    var mode = fast() ? 'cut' : (fx || 'fade');
    back.classList.add(mode === 'cut' ? 'is-cut' : mode === 'slow' ? 'is-slow' : 'is-fade');
    back.classList.add('is-on', 'is-drift');
    showCensor(back, name);
    // The old picture leaves the same way the new one arrives, so a crossfade never flashes the black behind.
    var old = bgFront;
    old.classList.remove('is-slow', 'is-cut', 'is-fade');
    old.classList.add(mode === 'cut' ? 'is-cut' : mode === 'slow' ? 'is-slow' : 'is-fade', 'is-leaving');
    hideCensor(old, mode === 'cut' ? 0 : mode === 'slow' ? 1900 : 1000);
    window.setTimeout(function () { old.classList.remove('is-on', 'is-leaving'); }, mode === 'cut' ? 0 : mode === 'slow' ? 1900 : 1000);
    bgFront = back;
    return mode === 'cut' ? 0 : mode === 'slow' ? 1100 : 600;
  }
  function setBlack(on) { black.classList.toggle('is-on', !!on); return fast() ? 150 : on ? 1000 : 800; }

  function member(id) { return boot.cast[id] || {}; }
  function castArt(id, pose) {
    var m = member(id);
    if (!m.art) return null;
    return m.art[pose || ''] || m.art[''];
  }
  // Two sides of a talk face each other: a portrait drawn looking left is mirrored on the left of the stage, one drawn
  // looking right is mirrored on the right; one drawn facing us never is.
  function facing(img, id, at) {
    var f = member(id).face || 'left';
    img.classList.toggle('is-flip', (at === 'left' && f === 'left') || (at === 'right' && f === 'right'));
  }
  // The stage holds two portraits at most, one per side. Whoever steps onto an occupied side takes it over (the one
  // they replace remembers that side and walks back onto it the next time they speak), and a lone portrait in the
  // middle steps aside to the other side when someone joins it. A three-way talk is a fixed partner and a turn-taking
  // other side, never three faces in the frame.
  var bench = {};
  function other(side) { return side === 'left' ? 'right' : 'left'; }
  function occupant(side, except) {
    return Object.keys(onStage).filter(function (k) { return k !== except && onStage[k].at === side; })[0];
  }
  function moveTo(id, at) {
    var s = onStage[id];
    if (!s || s.at === at) return;
    s.wrap.setAttribute('data-at', at); s.at = at; facing(s.img, id, at);
  }
  function makeRoom(id, at) {
    var others = Object.keys(onStage).filter(function (k) { return k !== id; });
    if (!others.length) return at || 'center';
    if (!at || at === 'center') {
      var mid = occupant('center', id);
      if (mid) { moveTo(mid, 'left'); return 'right'; }
      at = occupant('left', id) ? 'right' : 'left';
    }
    var mid2 = occupant('center', id);
    if (mid2) moveTo(mid2, other(at));
    var held = occupant(at, id);
    if (held) { bench[held] = at; hide(held); }
    return at;
  }
  function show(id, pose, at) {
    var src = castArt(id, pose);
    if (!src) return 0;
    var s = onStage[id];
    if (s) {
      if (at && at !== s.at) { at = makeRoom(id, at); moveTo(id, at); }
      if (src !== s.img.getAttribute('src')) {
        s.img.setAttribute('src', src);
        s.img.classList.remove('is-pop'); void s.img.offsetWidth; s.img.classList.add('is-pop');
      }
      return 0;
    }
    at = makeRoom(id, bench[id] && (!at || at === 'center') ? bench[id] : at);
    delete bench[id];
    var wrap = el('div', 'qs-actor', castLayer);
    var img = el('img', 'qs-sprite', wrap);
    img.alt = ''; img.src = src;
    wrap.setAttribute('data-at', at);
    wrap.setAttribute('data-cast', id);
    if (/shadow-/.test(src)) wrap.classList.add('is-shadow');
    facing(img, id, at);
    void wrap.offsetWidth;
    wrap.classList.add('is-on');
    onStage[id] = { img: img, wrap: wrap, at: at };
    return fast() ? 0 : 380;
  }
  function hide(id) {
    if (id === 'all') bench = {};
    var ids = id === 'all' ? Object.keys(onStage) : [id];
    ids.forEach(function (k) {
      var s = onStage[k];
      if (!s) return;
      delete onStage[k];
      s.wrap.classList.remove('is-on');
      s.wrap.classList.add('is-off');
      window.setTimeout(function () { s.wrap.remove(); }, 600);
    });
    return ids.length && !fast() ? 420 : 0;
  }
  function focusSpeaker(id) {
    Object.keys(onStage).forEach(function (k) {
      onStage[k].wrap.classList.toggle('is-dim', !!id && k !== id);
      onStage[k].wrap.classList.toggle('is-speaking', k === id);
    });
  }
  function react(id, how) {
    var s = onStage[id];
    if (!s || reduce) return;
    s.wrap.classList.remove('is-shake', 'is-jump'); void s.wrap.offsetWidth;
    s.wrap.classList.add(how === 'jump' ? 'is-jump' : 'is-shake');
  }
  function setCg(name) {
    if (!name) { cgWrap.classList.remove('is-on'); return fast() ? 0 : 550; }
    cgImg.src = picture(name);
    cgWrap.classList.remove('is-on'); void cgWrap.offsetWidth; cgWrap.classList.add('is-on');
    return fast() ? 0 : 800;
  }
  // A picture that shows a challenge's answer is not public: 'sealed:<name>' comes from the quest router, which serves
  // it only to a player who has finished the chapter.
  function picture(name) {
    return name.indexOf('sealed:') === 0 ? '/quests/' + QID + '/sealed/' + (run ? run.n : 0) + '/' + name.slice(7) + '.webp' : ART + '/bg/' + name + '.webp';
  }
  function setTint(t) { tint.className = 'qs-tint' + (t ? ' is-' + t : ''); }
  function setFlashback(f) { if (f) dlg.setAttribute('data-flashback', f); else dlg.removeAttribute('data-flashback'); }
  // A point-of-view scene's body: the whole picture trembles under the lines that follow ('soft' unease, 'hard' a body
  // that can't hold still) until { tremble: null }; tears blur it in slow swells; a mask narrows it to two eyeholes.
  // Reduced motion keeps the tears and the mask but never the trembling.
  // A mind coming apart: the picture tears into slices that slide out of place, its colours split red from cyan, static
  // and scanlines crawl over it, the frame now and then flips to its negative, and the line on screen shivers. 'soft' is
  // the hum of it under a scene; 'hard' is the break. Off with { glitch: null }. Reduced motion keeps only a still split.
  var Glitch = (function () {
    var level = null, timer = 0, nctx = null;
    glitchNoise.width = 480; glitchNoise.height = 270;
    // The slices copy the picture on screen; a censored backdrop is never copied (its face would show through the
    // slices), so over it the tear is colour and static only.
    function source() {
      if (cgWrap.classList.contains('is-on') && cgImg.getAttribute('src')) return cgImg.src;
      return censored(nameOf(bgFront)) ? '' : bgFront.src;
    }
    function slice(e, hard) {
      var top = Math.random() * 92, h = (hard ? 3 : 1.5) + Math.random() * (hard ? 20 : 8);
      e.style.clipPath = 'inset(' + top.toFixed(1) + '% 0 ' + Math.max(0, 100 - top - h).toFixed(1) + '% 0)';
      e.style.transform = 'translateX(' + ((Math.random() - 0.5) * (hard ? 70 : 20)).toFixed(1) + 'px)';
    }
    function noise() {
      nctx = nctx || glitchNoise.getContext('2d');
      if (!nctx) return;
      var img = nctx.createImageData(480, 270), d = img.data;
      for (var i = 0; i < d.length; i += 4) { var v = Math.random() * 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      nctx.putImageData(img, 0, 0);
    }
    function tick() {
      if (!level) return;
      var hard = level === 'hard', src = source();
      [glitchR, glitchC].forEach(function (e) { if (e.getAttribute('data-src') !== src) { e.style.backgroundImage = src ? 'url("' + src + '")' : 'none'; e.setAttribute('data-src', src); } });
      slice(glitchR, hard); slice(glitchC, hard); noise();
      if (hard && Math.random() < 0.1) {
        dlg.classList.add('is-glitch-flip');
        window.setTimeout(function () { dlg.classList.remove('is-glitch-flip'); }, 60 + Math.random() * 50);
        sfx('glitch');
      } else if (Math.random() < (hard ? 0.22 : 0.05)) sfx('glitch');
      timer = window.setTimeout(tick, hard ? 50 + Math.random() * 90 : 110 + Math.random() * 220);
    }
    return {
      set: function (l) {
        window.clearTimeout(timer);
        dlg.classList.remove('is-glitch-flip');
        level = l || null;
        if (level) dlg.setAttribute('data-glitch', level); else dlg.removeAttribute('data-glitch');
        if (level && !reduce && !fast()) tick();
      },
      kind: function () { return level; },
    };
  })();
  function setTremble(t) { if (t && !reduce) dlg.setAttribute('data-tremble', t); else dlg.removeAttribute('data-tremble'); }
  function setTears(on) { if (on) dlg.setAttribute('data-tears', ''); else dlg.removeAttribute('data-tears'); }
  function setMaskView(on) { if (on) dlg.setAttribute('data-maskview', ''); else dlg.removeAttribute('data-maskview'); }
  // A one-off shake ends by giving the scene back to a running tremble.
  scene.addEventListener('animationend', function (e) { if (e.target === scene) scene.classList.remove('is-shake', 'is-shake-big'); });
  function setCam(c) { cam.classList.toggle('is-push', c === 'push' && !reduce); }
  function setBars(on) { bars.classList.toggle('is-on', !!on); }
  var placeTimer = 0;
  function showPlace(name, time) {
    window.clearTimeout(placeTimer);
    placeName.textContent = name;
    placeTime.textContent = time || '';
    placeTime.hidden = !time;
    placeCard.classList.remove('is-on'); void placeCard.offsetWidth; placeCard.classList.add('is-on');
    placeTimer = window.setTimeout(function () { placeCard.classList.remove('is-on'); }, 4200);
  }
  // The running heartbeat: a lub-dub every second (dread) or twice a second (panic), the picture throbbing with it and
  // the screen's edges pulsing dark red (that much shows even on a black screen). The music sinks under it. Skipping
  // keeps it silent; with reduced motion only the edges pulse.
  var Heart = (function () {
    var timer = 0, rate = 0, now = null;
    function beat() {
      if (!fast()) {
        sfx('beat');
        if (!reduce) { cam.classList.remove('is-beat'); void cam.offsetWidth; cam.classList.add('is-beat'); }
        heartEl.classList.remove('is-beat'); void heartEl.offsetWidth; heartEl.classList.add('is-beat');
      }
      timer = window.setTimeout(beat, rate);
    }
    function set(kind) {
      var was = !!timer;
      window.clearTimeout(timer); timer = 0;
      heartEl.classList.remove('is-on', 'is-fast', 'is-beat'); cam.classList.remove('is-beat');
      now = kind || null;
      if (!kind) { if (was) Music.duck(false); return; }
      rate = kind === 'fast' ? 470 : 1000;
      dlg.style.setProperty('--qs-beat', (kind === 'fast' ? 440 : 820) + 'ms');
      heartEl.classList.add('is-on');
      if (kind === 'fast') heartEl.classList.add('is-fast');
      if (!was) Music.duck(true);
      beat();
    }
    return { set: set, stop: function () { set(null); }, kind: function () { return now; } };
  })();

  // A reveal lands four ways: 'big' a white flash, a sting and a hard shake (a discovery); 'small' a dark blink and a
  // thud; 'dark' the edges of the screen dim like a held breath, on a heartbeat, while the line it is placed before is
  // read (dread: it does not hold the scene up); 'blood' a red pulse (violence only).
  function shock(kind) {
    if (fast()) return 0;
    var big = kind === 'big', blood = kind === 'blood', dark = kind === 'dark';
    sfx(big || blood ? 'sting' : dark ? 'heartbeat' : 'thud');
    Music.duck(true); window.setTimeout(function () { Music.duck(false); }, big || blood ? 1600 : dark ? 1800 : 700);
    if (!dark) { flash.className = 'qs-flash ' + (big ? 'is-white' : blood ? 'is-red' : 'is-dark'); void flash.offsetWidth; flash.classList.add('is-on'); }
    if (!reduce) {
      scene.classList.remove('is-shake', 'is-shake-big', 'is-punch'); void scene.offsetWidth;
      if (big || blood) scene.classList.add('is-shake-big', 'is-punch');
      else if (!dark) scene.classList.add('is-shake');
      dlg.classList.remove('is-pulse', 'is-iris'); void dlg.offsetWidth;
      if (blood) dlg.classList.add('is-pulse');
      if (dark) dlg.classList.add('is-iris');
    }
    return big || blood ? 650 : dark ? 250 : 300;
  }
  var clueTimer = 0;
  function showClue(text) {
    window.clearTimeout(clueTimer);
    clueBox.innerHTML = '';
    el('p', 'qs-clue-kicker', clueBox).textContent = UI.clue;
    rich(el('p', 'qs-clue-text', clueBox), fill(text));
    clueBox.classList.remove('is-on'); void clueBox.offsetWidth; clueBox.classList.add('is-on');
    sfx('spot');
    log(UI.clue, plain(fill(text)));
    clueTimer = window.setTimeout(function () { clueBox.classList.remove('is-on'); }, 5200);
  }

  // The typed line: laid out hidden first (no reflow), letters revealed one by one; a click finishes it.
  function type(target, text, pitch, soft) {
    target.textContent = '';
    var sr = el('span', 'sr-only', target); sr.textContent = plain(text);
    var shown = el('span', '', target); shown.setAttribute('aria-hidden', 'true');
    var chars = [];
    String(text).split('**').forEach(function (seg, k) {
      seg.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { shown.appendChild(document.createTextNode(part)); return; }
        var w = el('span', 'tw-word' + (k % 2 ? ' qs-key' : ''), shown);
        Array.prototype.forEach.call(part, function (ch) { var c = el('span', 'tw-ch', w); c.textContent = ch; chars.push(c); });
      });
    });
    var i = 0, timer = 0, done = false, resolve;
    var p = new Promise(function (r) { resolve = r; });
    target.classList.add('is-typing');
    var speed = soft ? 34 : 22;
    if (dlg.hasAttribute('data-flashback')) speed = Math.round(speed * 1.4);   // memories are told more slowly
    function finish() {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      chars.forEach(function (c) { c.classList.add('on'); });
      target.classList.remove('is-typing');
      typing = null;
      resolve();
    }
    function step() {
      if (i >= chars.length) { finish(); return; }
      var c = chars[i++];
      c.classList.add('on');
      if (pitch && i % 2 === 1 && /\w/.test(c.textContent)) voice(pitch, soft);
      else if (!pitch && i % 4 === 1 && /\w/.test(c.textContent)) sfx('tick');
      var ch = c.textContent;
      timer = window.setTimeout(step, /[.!?…]/.test(ch) ? 260 : /[,;:—]/.test(ch) ? 130 : speed);
    }
    typing = { finish: finish };
    if (fast()) finish(); else timer = window.setTimeout(step, 90);
    return p;
  }

  function waitAdvance(textLen) {
    return new Promise(function (resolve) {
      var t = 0;
      waiter = function () { window.clearTimeout(t); waiter = null; resolve(); };
      if (fast()) t = window.setTimeout(function () { if (waiter) waiter(); }, 70);
      else if (auto) t = window.setTimeout(function () { if (waiter) waiter(); }, 1500 + (textLen || 0) * 32);
    });
  }
  function advance() {
    if (!run) return;
    if (!progressed) { progressed = true; hint.classList.add('is-gone'); Music.resume(); Amb.resume(); }
    if (typing) { typing.finish(); return; }
    if (waiter) { sfx('tick'); waiter(); }
  }
  function log(name, text) {
    var li = el('li', '', logList);
    if (name) el('b', '', li).textContent = name;
    el('span', '', li).textContent = plain(text);
  }
  function clearText(keep) {
    if (keep !== 'narr') narrBox.classList.remove('is-on');
    if (keep !== 'box') box.classList.remove('is-on');
  }

  async function line(kind, who, text, opts) {
    opts = opts || {};
    text = fill(text);
    if (kind === 'narr') {
      clearText('narr');
      focusSpeaker(null);
      // A portrait in the middle keeps its face, and a picture on screen stays clear: the narrator steps down to the foot.
      narrBox.classList.toggle('is-low', cgWrap.classList.contains('is-on') || seekWrap.classList.contains('is-on') || Object.keys(onStage).some(function (k) { return onStage[k].at === 'center'; }));
      narrBox.classList.remove('is-on'); void narrBox.offsetWidth; narrBox.classList.add('is-on');
      log('', text);
      await type(narrText, text, 0, false);
      await waitAdvance(text.length);
      return;
    }
    var m = kind === 'you' ? null : member(who);
    var name = kind === 'you' ? boot.player.name : (opts.as || (m && m.name) || who);
    var wasOn = box.classList.contains('is-on');
    var sameSpeaker = box.getAttribute('data-who') === (kind === 'you' ? '@you' : who);
    clearText('box');
    nameSpeaker.textContent = name;
    nameRole.textContent = kind === 'you' ? '' : (m && m.role) || '';
    // A thought or a memory told is the self: no title under the name.
    if (opts.style === 'inner' || opts.style === 'recall') nameRole.textContent = '';
    nameRole.hidden = !nameRole.textContent;
    box.setAttribute('data-who', kind === 'you' ? '@you' : who);
    box.classList.toggle('has-face', kind === 'you');
    box.classList.toggle('is-shout', opts.style === 'shout');
    box.classList.toggle('is-whisper', opts.style === 'whisper');
    // 'inner': a thought, never spoken (the point-of-view character); 'recall': the same voice years later, telling it.
    box.classList.toggle('is-inner', opts.style === 'inner');
    box.classList.toggle('is-recall', opts.style === 'recall');
    // The name plate sits on the speaker's side of the stage.
    var side = kind === 'you' ? 'left' : (onStage[who] && onStage[who].at) || opts.at || 'left';
    box.setAttribute('data-side', side === 'right' ? 'right' : 'left');
    if (kind === 'you') face.src = boot.player.face;
    // A line marked `off` is heard, not seen: the speaker stays off stage (a voice behind the camera).
    if (kind === 'say' && m && m.art && !opts.off) { await sleep(show(who, opts.pose, opts.at || (onStage[who] && onStage[who].at) || 'center')); }
    if (opts.off && opts.react && !reduce && !fast()) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); }
    focusSpeaker(kind === 'say' && onStage[who] ? who : null);
    if (opts.react) react(who, opts.react);
    if (opts.style === 'shout' && !reduce && !fast()) { box.classList.remove('is-jolt'); void box.offsetWidth; box.classList.add('is-jolt'); }
    box.classList.add('is-on');
    if (!wasOn || !sameSpeaker) { box.classList.remove('is-new'); void box.offsetWidth; box.classList.add('is-new'); }
    log(name, text);
    var pitch = kind === 'you' ? 480 : (m && m.voice) || 420;
    await type(boxText, text, pitch, opts.style === 'whisper' || opts.style === 'inner' || opts.style === 'recall');
    await waitAdvance(text.length);
  }

  var GLYPHS = {
    envelope: '<svg viewBox="0 0 120 90" aria-hidden="true"><rect x="6" y="14" width="108" height="66" rx="4" class="g-dark"/><path d="M6 18 60 54 114 18" class="g-line"/><circle cx="60" cy="52" r="13" class="g-wax"/><path d="M53 50q7 7 14 0" class="g-wax-line"/><circle cx="55" cy="47" r="1.6" class="g-wax-line"/><circle cx="65" cy="47" r="1.6" class="g-wax-line"/></svg>',
    crystal: '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M60 8 92 44 60 112 28 44Z" class="g-crystal"/><path d="M28 44h64M60 8 48 44l12 68 12-68Z" class="g-line"/><circle cx="60" cy="54" r="6" class="g-glow"/></svg>',
    musicbox: '<svg viewBox="0 0 120 100" aria-hidden="true"><path d="M14 44h88v44H14Z" class="g-dark"/><path d="M14 44 22 24h72l8 20Z" class="g-paper"/><path d="M58 27l9 6-9 7-9-7Z" class="g-wax"/><path d="M58 40q-3 3 0 6" class="g-line"/><path d="M26 58h64M26 70h64" class="g-line"/><path d="M102 64h10v-12" class="g-line"/><circle cx="112" cy="50" r="4" class="g-glow"/></svg>',
    note: '<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M12 12h96l-4 66H16Z" class="g-paper"/><path d="M24 34h70M24 48h56M24 62h40" class="g-ink"/><path d="M96 18l6 10-10 2Z" class="g-ink"/></svg>',
    ledger: '<svg viewBox="0 0 120 100" aria-hidden="true"><path d="M60 22C46 14 26 12 10 16v66c16-4 36-2 50 6Z" class="g-paper"/><path d="M60 22c14-8 34-10 50-6v66c-16-4-36-2-50 6Z" class="g-paper"/><path d="M60 22v66" class="g-line"/><path d="M20 32h30M20 44h30M20 56h24M70 32h30M70 44h30M70 56h22" class="g-ink"/><path d="M8 84c18-5 38-3 52 6 14-9 34-11 52-6" class="g-line"/><path d="M86 70l6 10 6-10" class="g-wax"/></svg>',
  };
  // Painted items (static/quest/<art>/item/<name>.webp): when a step names one of these, the picture is shown instead
  // of a drawn glyph. The 22 painted tarot cards (…/tarot/<sign>.webp) likewise replace the drawn card.
  var ITEM_ART = ['apple', 'bear', 'blindfold', 'dagger', 'diary', 'envelope', 'envelope-black', 'gloves', 'kite', 'knife', 'poster',
    'knife-bloody', 'ledger', 'letter', 'lily', 'mask', 'photo', 'poison-apple', 'sword', 'tarot-back',
    'musicbox', 'crystal', 'stem', 'barrel', 'drawing', 'scepter',
    'half-mask', 'letter-knife', 'teacup', 'signet-ring', 'stick-blade', 'stick-broken', 'bell', 'gold-purse', 'burned-hand', 'ledger-page', 'note-copy'];
  var TAROT_ART = ['fool', 'magician', 'priestess', 'empress', 'emperor', 'hierophant', 'lovers', 'chariot', 'strength', 'hermit',
    'wheel', 'justice', 'hanged', 'death', 'temperance', 'devil', 'tower', 'star', 'moon', 'sun', 'judgement', 'world'];
  function itemArt(glyph) { return ITEM_ART.indexOf(glyph) >= 0 ? ART + '/item/' + glyph + '.webp' : ''; }
  function tarotArt(sign) { return TAROT_ART.indexOf(sign) >= 0 ? ART + '/tarot/' + sign + '.webp' : ''; }
  // Tarot signs, drawn in gold on the card's face (viewBox 100 x 100), for a card without a painting.
  var TAROT = {
    fool: '<path class="t-l" d="M22 70c4-22 14-34 28-38 14 4 24 16 28 38"/><path class="t-l" d="M50 32c-2-12-14-18-26-14 8 2 12 8 12 14M50 32c2-12 14-18 26-14-8 2-12 8-12 14M50 32V14"/><circle class="t-f" cx="24" cy="18" r="4"/><circle class="t-f" cx="76" cy="18" r="4"/><circle class="t-f" cx="50" cy="11" r="4"/><path class="t-l" d="M20 72h60M30 86h40"/><path class="t-f" d="M50 46l6 9-6 9-6-9Z"/>',
    emperor: '<path class="t-l" d="M24 44l8-20 10 14 8-18 8 18 10-14 8 20Z"/><path class="t-l" d="M24 44h52M30 52v34M70 52v34M24 52h52M24 86h52M30 68h40"/><circle class="t-f" cx="50" cy="20" r="3"/>',
    hierophant: '<g class="t-l"><circle cx="34" cy="28" r="9"/><path d="M40 35l30 44M62 66l8-5M67 73l7-5"/><circle cx="66" cy="28" r="9"/><path d="M60 35L30 79M38 66l-8-5M33 73l-7-5"/></g><path class="t-l" d="M50 12v20M44 18h12M42 24h16"/>',
    justice: '<path class="t-l" d="M50 10v80M30 26h40M30 26l-12 26h24ZM70 26l-12 26h24Z"/><path class="t-l" d="M18 52c0 7 24 7 24 0M58 52c0 7 24 7 24 0M40 90h20"/><path class="t-f" d="M50 6l4 6h-8Z"/>',
    hanged: '<path class="t-l" d="M16 14h68M24 14v76M76 14v76"/><path class="t-l" d="M50 14v18M50 32l0 22M50 32l12 10-12 4"/><circle class="t-l" cx="50" cy="62" r="8"/><path class="t-l" d="M42 50l-8 8M58 50l8 8"/><path class="t-f" d="M44 76h12l-6 8Z"/>',
    devil: '<path class="t-l" d="M34 30c-8-6-10-16-6-22 2 8 8 12 14 14M66 30c8-6 10-16 6-22-2 8-8 12-14 14"/><path class="t-l" d="M34 30c0 18 6 28 16 28s16-10 16-28c-8-6-24-6-32 0Z"/><path class="t-f" d="M42 38l5 3-5 2ZM58 38l-5 3 5 2Z"/><path class="t-l" d="M50 58v8M22 70h56M30 70c0 8-6 12-6 18M70 70c0 8 6 12 6 18"/><circle class="t-l" cx="40" cy="78" r="4"/><circle class="t-l" cx="60" cy="78" r="4"/>',
    tower: '<path class="t-l" d="M38 90V34h24v56M34 34h32l-4-10H38Z"/><path class="t-l" d="M46 48h8v10h-8zM46 70h8v10h-8z"/><path class="t-f" d="M70 6L56 26h10L54 44l22-24H66Z"/><path class="t-l" d="M24 56l-8 6M78 52l8 4M28 80l-10 2"/>',
    lovers: '<path class="t-l" d="M50 40V88M50 60c-12 0-20-8-20-18 8 0 16 6 20 14 4-8 12-14 20-14 0 10-8 18-20 18"/><circle class="t-f" cx="36" cy="44" r="3.5"/><circle class="t-f" cx="64" cy="44" r="3.5"/><path class="t-l" d="M50 30c-10-10-24-12-32-8 10 0 18 4 24 10M50 30c10-10 24-12 32-8-10 0-18 4-24 10"/><circle class="t-l" cx="50" cy="16" r="6"/><path class="t-l" d="M34 88h32"/>',
  };
  async function card(step) {
    clearText(null);
    focusSpeaker(null);
    overlay.innerHTML = '';
    var c;
    if (step.item) {
      c = el('div', 'qs-item', overlay);
      el('span', 'qs-item-rays', c).setAttribute('aria-hidden', 'true');
      var glyphBox = el('div', 'qs-item-glyph', c);
      var pix = itemArt(step.item.glyph);
      if (pix) { var pi = el('img', 'qs-item-pix', glyphBox); pi.alt = ''; pi.src = pix; } else glyphBox.innerHTML = GLYPHS[step.item.glyph] || '';
      el('p', 'qs-item-kicker', c).textContent = UI.found;
      el('h3', 'qs-item-title', c).textContent = step.item.title;
      var p = el('p', 'qs-item-text' + (step.item.hand ? ' is-hand' : ''), c);
      // A handwritten address breaks only after its slashes, never inside a word.
      p.textContent = step.item.hand ? fill(step.item.text).split('/').join('/​') : fill(step.item.text);
      log(step.item.title, fill(step.item.text));
      sfx('spot');
    } else if (step.tarot) {
      // A tarot card: dark face, gold frame, the numeral at the top, the sign, the name plate; turned over if reversed.
      var t = step.tarot;
      c = el('div', 'qs-tarot' + (t.reversed ? ' is-reversed' : ''), overlay);
      var faceT = el('div', 'qs-tarot-card', c);
      faceT.setAttribute('aria-hidden', 'true');
      var paint = tarotArt(t.sign);
      if (paint) {
        // The painted card carries its own numeral and name.
        faceT.classList.add('is-art');
        var ti = el('img', '', faceT); ti.alt = ''; ti.src = paint;
      } else {
        el('span', 'qs-tarot-n', faceT).textContent = t.n;
        el('div', 'qs-tarot-sign', faceT).innerHTML = '<svg viewBox="0 0 100 100">' + (TAROT[t.sign] || '') + '</svg>';
        el('span', 'qs-tarot-plate', faceT).textContent = String(t.name).split(',')[0]; // "Justice, reversed": the card says Justice
      }
      var cap = el('div', 'qs-tarot-cap', c);
      el('h3', 'qs-tarot-name', cap).textContent = t.n + ' · ' + t.name;
      if (t.text) rich(el('p', 'qs-tarot-text', cap), fill(t.text));
      log(t.n + ' · ' + t.name, t.text ? plain(fill(t.text)) : '');
      sfx('whoosh');
    } else if (step.intro) {
      // A character card: the portrait on the left looking towards the words, name, standing and who they are.
      var who = member(step.intro.who);
      c = el('div', 'qs-intro', overlay);
      var pic = el('div', 'qs-intro-art', c);
      var im = el('img', '', pic); im.alt = ''; im.src = castArt(step.intro.who) || '';
      if ((who.face || 'left') === 'left') im.classList.add('is-flip');
      if (/shadow-/.test(im.src)) pic.classList.add('is-shadow');
      var body = el('div', 'qs-intro-body', c);
      el('p', 'qs-intro-kicker', body).textContent = step.intro.title;
      el('h3', 'qs-intro-name', body).textContent = who.name || step.intro.who;
      if (who.role) el('p', 'qs-intro-role', body).textContent = who.role;
      rich(el('p', 'qs-intro-text', body), fill(step.intro.text));
      log(who.name, plain(fill(step.intro.text)));
      sfx('whoosh');
    } else if (step.notes) {
      // A guild case folder: a tab with the kicker, the title under a red "filed" stamp, numbered entries, and a
      // reminder that a click moves on.
      c = el('div', 'qs-notes', overlay);
      el('p', 'qs-notes-tab', c).textContent = UI.notes;
      var head = el('div', 'qs-notes-head', c);
      el('h3', 'qs-notes-title', head).textContent = step.notes.title;
      el('span', 'qs-notes-stamp', head).textContent = boot.quest.title;
      var ol = el('ol', 'qs-notes-list', c);
      step.notes.items.forEach(function (it, k) {
        var li = el('li', '', ol);
        li.style.setProperty('--i', String(k));
        rich(li, fill(it));
      });
      el('p', 'qs-notes-foot', c).textContent = UI.tap;
      log(UI.notes, step.notes.items.map(function (it) { return plain(fill(it)); }).join(' · '));
      sfx('page');
    } else if (step.letter) {
      c = el('div', 'qs-letter', overlay);
      fill(step.letter).split('\n\n').forEach(function (para) { el('p', '', c).textContent = para; });
      log('', fill(step.letter).replace(/\n+/g, ' '));
      sfx('unroll');
    } else if (step.accept) {
      c = el('div', 'qs-accept', overlay);
      el('p', 'qs-accept-kicker', c).textContent = UI.grand;
      el('h3', 'qs-accept-title', c).textContent = step.accept.title;
      var r = el('p', 'qs-accept-reward', c);
      el('span', 'coin', r).setAttribute('aria-hidden', 'true');
      r.appendChild(document.createTextNode(UI.reward + ': ' + step.accept.reward + ' ' + UI.gold));
      el('span', 'qs-stamp', c).textContent = UI.accepted;
      window.setTimeout(function () { sfx('seal'); }, reduce ? 0 : 520);
    }
    overlay.classList.add('is-on');
    await sleep(fast() ? 0 : 500);
    await waitAdvance(40);
    overlay.classList.remove('is-on');
    await sleep(fast() ? 0 : 320);
  }

  async function titleShow(step) {
    clearText(null);
    titleSub.textContent = step.sub || '';
    titleMain.textContent = step.title;
    setBars(true);
    titleCard.classList.add('is-on');
    sfx('bell');
    await new Promise(function (r) {
      var t = window.setTimeout(done, fast() ? 300 : 3400);
      function done() { window.clearTimeout(t); if (waiter === done) waiter = null; r(); }
      waiter = done;
    });
    titleCard.classList.remove('is-on');
    setBars(false);
    await sleep(fast() ? 0 : 1000);
  }

  async function creditsShow(step) {
    clearText(null);
    creditsRoll.innerHTML = '';
    step.credits.forEach(function (t) {
      if (!t || t === '-') el('span', 'qs-credits-gap', creditsRoll);
      else if (t.indexOf('# ') === 0) el('h3', 'qs-credits-head', creditsRoll).textContent = t.slice(2);
      else el('p', 'qs-credits-line', creditsRoll).textContent = t;
    });
    var still = fast() || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var ms = fast() ? 300 : Math.max(16000, step.credits.length * 3200);
    creditsRoll.style.transition = 'none';
    creditsRoll.style.transform = still ? 'translateY(-50%)' : 'translateY(0)';
    creditsRoll.classList.toggle('is-still', !!still);
    creditsBox.classList.add('is-on');
    void creditsRoll.offsetHeight;
    if (!still) {
      creditsRoll.style.transition = 'transform ' + ms + 'ms linear';
      creditsRoll.style.transform = 'translateY(' + -(creditsBox.clientHeight + creditsRoll.offsetHeight) + 'px)';
    }
    await new Promise(function (r) {
      var t = window.setTimeout(done, ms);
      function done() { window.clearTimeout(t); if (waiter === done) waiter = null; r(); }
      waiter = done;
    });
    creditsBox.classList.remove('is-on');
    await sleep(fast() ? 0 : 1200);
    creditsRoll.style.transition = 'none';
    creditsRoll.innerHTML = '';
  }

  // Choices: wooden plaques with a number key each; the picked one glows, the others fall away.
  function menu(options, head, done) {
    narrBox.classList.remove('is-on'); // the narrator steps aside for the question
    choices.innerHTML = '';
    var panel = el('div', 'qs-choice-panel', choices);
    el('p', 'qs-choice-head', panel).textContent = head || UI.choose;
    var list = el('div', 'qs-choice-list', panel);
    var buttons = [];
    options.forEach(function (o, i) {
      var b = el('button', 'qs-choice' + (o.visited ? ' is-visited' : ''), list);
      b.type = 'button';
      b.style.setProperty('--i', String(i));
      el('span', 'qs-choice-key', b).textContent = String(i + 1);
      el('span', 'qs-choice-text', b).textContent = o.label;
      el('span', 'qs-choice-mark', b).setAttribute('aria-hidden', 'true');
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (choices.classList.contains('is-picking')) return;
        sfx('pick');
        choices.classList.add('is-picking');
        b.classList.add('is-picked');
        dlg.focus({ preventScroll: true });
        window.setTimeout(function () {
          choices.classList.remove('is-on', 'is-picking');
          done(i);
        }, fast() || reduce ? 0 : 420);
      });
      buttons.push(b);
    });
    choices.classList.add('is-on');
    choices.buttons = buttons;
    var first = list.querySelector('button:not(.is-visited)') || list.querySelector('button');
    if (first) window.setTimeout(function () { first.focus({ preventScroll: true }); }, 80);
  }
  function pick(options, head) {
    if (skipAll) return Promise.resolve(Math.max(0, options.findIndex(function (o) { return !o.visited; })));
    skip = false; skipBtn.setAttribute('aria-pressed', 'false');
    return new Promise(function (resolve) { menu(options, head, resolve); });
  }

  // Places to search, marked on the picture: each spot is a glowing ring (a button) laid over the backdrop where the
  // thing is drawn. The backdrop stops drifting while the player looks, so the marks stay on their objects.
  function spotXY(at) {
    var img = bgFront, W = scene.clientWidth, H = scene.clientHeight;
    var iw = img.naturalWidth || 1672, ih = img.naturalHeight || 941;
    var k = Math.max(W / iw, H / ih), dw = iw * k, dh = ih * k;
    var pos = (window.getComputedStyle(img).objectPosition || '50% 50%').split(' ');
    var px = parseFloat(pos[0]) / 100, py = parseFloat(pos[1] || '50%') / 100;
    var x = (W - dw) * (isNaN(px) ? 0.5 : px) + at[0] * dw, y = (H - dh) * (isNaN(py) ? 0.5 : py) + at[1] * dh;
    return [Math.min(W - 40, Math.max(40, x)), Math.min(H - 150, Math.max(90, y))];
  }
  function searchOnPicture(ex, seen) {
    if (skipAll) return Promise.resolve(seen.indexOf(false));
    skip = false; skipBtn.setAttribute('aria-pressed', 'false');
    return new Promise(function (resolve) {
      spots.innerHTML = '';
      var left = seen.filter(function (s) { return !s; }).length;
      var head = el('p', 'qs-spots-head', spots);
      head.textContent = ex.prompt;
      el('span', 'qs-spots-left', head).textContent = UI.left.replace('{n}', left);
      var marks = [];
      ex.spots.forEach(function (s, i) {
        var b = el('button', 'qs-spot' + (seen[i] ? ' is-seen' : ''), spots);
        b.type = 'button';
        b.setAttribute('aria-label', s.label);
        el('span', 'qs-spot-ring', b);
        el('span', 'qs-spot-label', b).textContent = s.label;
        marks.push({ b: b, at: s.at });
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          sfx('pick');
          spots.classList.remove('is-on');
          window.removeEventListener('resize', place);
          dlg.focus({ preventScroll: true });
          resolve(i);
        });
      });
      function place() { marks.forEach(function (m) { var p = spotXY(m.at); m.b.style.left = p[0] + 'px'; m.b.style.top = p[1] + 'px'; }); }
      place();
      window.addEventListener('resize', place);
      spots.classList.add('is-on');
      var first = spots.querySelector('.qs-spot:not(.is-seen)');
      if (first) window.setTimeout(function () { first.focus({ preventScroll: true }); }, 120);
    });
  }

  // Every beat belongs to the run that started it (`me`). Leaving and opening a chapter again starts a new run; an old
  // loop still waiting on a pause must not wake up and play its steps (a black screen, a backdrop) over the new one.
  async function exec(step, me) {
    me = me || run;
    if (!run || run !== me || !me.alive) return;
    // A line already read does not linger over a change of scene: a new backdrop, black, a picture or a title clear
    // the text; a portrait stepping on or off clears only the narrator.
    if ('bg' in step || 'black' in step || ('cg' in step && step.cg) || 'title' in step || 'credits' in step) clearText(null);
    else if ('show' in step || 'hide' in step) clearText('box');
    if ('bg' in step) {
      if (step.bg) await picReady(ART + '/bg/' + step.bg + '.webp');
      // Under a black screen nobody sees a crossfade: cut, so the dark lasts only as long as the scene wants.
      await sleep(setBg(step.bg, black.classList.contains('is-on') ? 'cut' : step.fx));
      return;
    }
    if ('music' in step) { Music.play(step.music, fast() ? 150 : (step.fade || 1400)); return; }
    if ('amb' in step) { Amb.set(step.amb); return; }
    if ('particles' in step) { Particles.set(step.particles); return; }
    if ('tint' in step) { setTint(step.tint); return; }
    if ('flashback' in step) { setFlashback(step.flashback); return; }
    if ('qte' in step) {
      // A timed moment can be lost: its short bad ending plays, then the card offers it again from where it began.
      for (;;) {
        clearText(null);
        var snap = stageSnap();
        var result = await qte(step.qte);
        if (result !== 'fail' || run !== me) return;
        await steps(step.qte.fail, false, 0, me);
        if (run !== me || !me.alive) return;
        clearText(null);
        await badEnd(step.qte.end);
        if (run !== me || !me.alive) return;
        stageRestore(snap);
        await sleep(900);
      }
    }
    if ('seek' in step) { clearText(null); await seek(step.seek, me); return; }
    if ('tremble' in step) { setTremble(step.tremble); return; }
    if ('glitch' in step) { Glitch.set(step.glitch); return; }
    if ('tears' in step) { setTears(step.tears); return; }
    if ('maskview' in step) { setMaskView(step.maskview); await sleep(fast() ? 0 : 900); return; }
    if ('cam' in step) { setCam(step.cam); return; }
    if ('letterbox' in step) { setBars(step.letterbox); await sleep(fast() ? 0 : 500); return; }
    if ('place' in step) { if (!fast()) showPlace(step.place, step.time); return; }
    if ('sfx' in step) { if (!fast()) sfx(step.sfx); return; }
    if ('shock' in step) { await sleep(shock(step.shock)); return; }
    if ('heart' in step) { Heart.set(step.heart); return; }
    if ('black' in step) { if (step.black) clearText(null); await sleep(setBlack(step.black)); return; }
    if ('narr' in step) { await line('narr', null, step.narr); return; }
    if ('say' in step) { await line('say', step.say, step.text, step); return; }
    if ('you' in step) { await line('you', null, step.you); return; }
    if ('show' in step) { await sleep(show(step.show, step.pose, step.at)); return; }
    if ('hide' in step) { await sleep(hide(step.hide)); return; }
    if ('cg' in step) { if (step.cg) { clearText(null); await picReady(picture(step.cg)); } await sleep(setCg(step.cg)); return; }
    if ('item' in step || 'tarot' in step || 'letter' in step || 'accept' in step || 'intro' in step || 'notes' in step) { await card(step); return; }
    if ('clue' in step) { if (!fast()) showClue(step.clue); else log(UI.clue, plain(fill(step.clue))); return; }
    if ('title' in step) { await titleShow(step); return; }
    if ('credits' in step) { await creditsShow(step); return; }
    if ('choice' in step) {
      var i = await pick(step.choice.map(function (c) { return { label: c.label }; }));
      log('', '› ' + step.choice[i].label);
      await steps(step.choice[i].then, false, 0, me);
      return;
    }
    if ('explore' in step) {
      var ex = step.explore;
      var seen = ex.spots.map(function () { return false; });
      var onPicture = ex.spots.every(function (s) { return s.at; });
      while (run === me && me.alive && seen.indexOf(false) >= 0) {
        clearText(null);
        focusSpeaker(null);
        var k;
        if (onPicture) {
          bgFront.classList.add('is-still');
          k = await searchOnPicture(ex, seen);
        } else {
          var left = seen.filter(function (s) { return !s; }).length;
          k = await pick(ex.spots.map(function (s, j) { return { label: s.label, visited: seen[j] }; }), ex.prompt + ' · ' + UI.left.replace('{n}', left));
        }
        log('', '› ' + ex.spots[k].label);
        await steps(ex.spots[k].then, false, 0, me);
        seen[k] = true;
      }
      bgFront.classList.remove('is-still');
      return;
    }
    if ('shake' in step) { if (!reduce && !fast()) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); } return; }
    if ('flash' in step) { flash.className = 'qs-flash is-' + step.flash; void flash.offsetWidth; flash.classList.add('is-on'); await sleep(fast() ? 0 : 250); return; }
    if ('wait' in step) { await sleep(fast() ? 0 : step.wait); return; }
  }

  async function steps(list, top, from, me) {
    me = me || run;
    for (var i = from || 0; i < list.length; i++) {
      if (!run || run !== me || !me.alive) return;
      if (top) store(placeKey(me.n), i);
      // One broken beat must never close the whole stage: it is logged and the scene goes on.
      try { await exec(list[i], me); } catch (e) { if (window.console) console.error('quest step', i, e); }
    }
  }
  // A picture is put on stage only once it has arrived (or after a short wait on a slow line), so a crossfade never
  // fades into an empty black frame.
  var ready = {};
  function picReady(src, ms) {
    if (ready[src] || fast()) return Promise.resolve();
    var img = new Image();
    img.src = src;
    var done = (img.decode ? img.decode() : new Promise(function (r) { img.onload = r; img.onerror = r; }))
      .then(function () { ready[src] = true; }, function () { ready[src] = true; });
    return Promise.race([done, sleep(ms || 2500)]);
  }

  // Resuming mid-chapter: replay the state-only steps up to the saved place, instantly.
  function restore(list, upto) {
    var st = { bg: null, cg: null, black: true, music: null, amb: null, particles: null, tint: null, flashback: null, cam: null, bars: false, tremble: null, tears: false, maskview: false, glitch: null };
    var cast = {};
    for (var i = 0; i < upto; i++) {
      var s = list[i];
      ['bg', 'cg', 'black', 'music', 'amb', 'particles', 'tint', 'flashback', 'cam', 'tremble', 'tears', 'maskview', 'glitch'].forEach(function (k) { if (k in s) st[k] = s[k]; });
      if ('letterbox' in s) st.bars = s.letterbox;
      if ('show' in s) cast[s.show] = { pose: s.pose, at: s.at };
      if ('hide' in s) { if (s.hide === 'all') cast = {}; else delete cast[s.hide]; }
      if ('say' in s && cast[s.say] && s.pose) cast[s.say].pose = s.pose;
    }
    skip = true;
    if (st.bg) setBg(st.bg, 'cut');
    if (st.cg) setCg(st.cg);
    Object.keys(cast).forEach(function (id) { show(id, cast[id].pose, cast[id].at); });
    setBlack(st.black); setTint(st.tint); setFlashback(st.flashback); setCam(st.cam); setBars(st.bars);
    setTremble(st.tremble); setTears(st.tears); setMaskView(st.maskview); Glitch.set(st.glitch);
    Particles.set(st.particles); Amb.set(st.amb);
    Music.play(st.music, 600);
    skip = false;
  }

  // ---- the case file (a chapter's challenge) -------------------------------------------------------------------
  function linkify(p, text) {
    var host = boot.host;
    text.split('\n').forEach(function (ln, i) {
      if (i) p.appendChild(document.createElement('br'));
      if (host && ln.indexOf(host + '/') === 0) {
        var a = el('a', 'qs-case-url', p);
        a.href = window.location.protocol + '//' + ln; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ln;
      } else p.appendChild(document.createTextNode(ln));
    });
  }
  // The Guildmaster's counsel, inside the case file: three sealed scrolls (Insight, Revelation, Oracle), one per tier.
  // Pressing one asks first, since the scroll is used up; the server checks the bag and only then sends the words,
  // which unroll below as a note in his hand. On a solved case only what was already heard is shown.
  var ROMAN = ['I', 'II', 'III'];
  function richText(p, text) {
    String(text).split('`').forEach(function (part, i) {
      if (!part) return;
      if (i % 2) el('code', 'qs-counsel-code', p).textContent = part;
      else p.appendChild(document.createTextNode(part));
    });
  }
  function counselBox(f, counsel) {
    var done = run.chapter.done;
    var heardAny = counsel.tiers.some(function (x) { return x.text !== undefined; });
    if (done && !heardAny) return;
    var box = el('section', 'qs-counsel', f);
    box.setAttribute('data-testid', 'quest-counsel');
    var head = el('div', 'qs-counsel-head', box);
    var gm = member('gm');
    var face = el('span', 'qs-counsel-face', head); face.setAttribute('aria-hidden', 'true');
    if (gm.art && gm.art['']) { var img = el('img', '', face); img.src = gm.art['']; img.alt = ''; img.decoding = 'async'; }
    var hw = el('div', 'qs-counsel-who', head);
    el('p', 'qs-case-label', hw).textContent = UI.counsel_title;
    var say = el('p', 'qs-counsel-say', hw); say.setAttribute('aria-live', 'polite');
    var allHeard = function () { return counsel.tiers.every(function (x) { return x.text !== undefined; }); };
    var greet = function () { say.textContent = allHeard() ? UI.counsel_all : heardAny ? UI.counsel_more : UI.counsel_intro; };
    greet();

    var seals = el('ol', 'qs-counsel-seals', box);
    var ask = el('div', 'qs-counsel-ask', box); ask.hidden = true; ask.setAttribute('role', 'status');
    var notes = el('div', 'qs-counsel-notes', box);
    var cards = {};
    var bag = counsel.bag || {};
    var scrollName = function (kind) { return (boot.scrolls && boot.scrolls[kind]) || kind; };

    function note(x, fresh) {
      var n = el('article', 'qs-counsel-note' + (fresh ? ' is-fresh' : ''), notes);
      n.setAttribute('data-kind', x.kind); n.id = 'qs-counsel-' + x.tier;
      el('span', 'qs-counsel-wax', n).setAttribute('aria-hidden', 'true');
      var tl = el('p', 'qs-counsel-tier', n);
      tl.textContent = UI.counsel_n.replace('{n}', ROMAN[x.tier - 1]) + ' · ' + scrollName(x.kind);
      richText(el('p', 'qs-counsel-text', n), x.text);
      // Keep the notes in tier order, whatever order they were heard in.
      Array.prototype.slice.call(notes.children).sort(function (a, b) { return a.id < b.id ? -1 : 1; }).forEach(function (k) { notes.appendChild(k); });
      return n;
    }
    function paint(x) {
      var b = cards[x.tier];
      if (!b) return;
      var heard = x.text !== undefined;
      b.classList.toggle('is-heard', heard);
      b.setAttribute('aria-pressed', heard ? 'true' : 'false');
      b.querySelector('.qs-seal-count').textContent = heard ? UI.counsel_heard : UI.counsel_have.replace('{n}', bag[x.kind] || 0);
      b.classList.toggle('is-empty', !heard && !(bag[x.kind] > 0));
    }
    function closeAsk() { ask.hidden = true; ask.innerHTML = ''; Object.keys(cards).forEach(function (k) { cards[k].classList.remove('is-armed'); }); }
    function hear(x, btn, go) {
      if (go.disabled) return;
      go.disabled = true; btn.classList.add('is-busy');
      ask.innerHTML = ''; el('p', 'qs-counsel-ask-text', ask).textContent = UI.counsel_reading;
      fetch('/quests/' + QID + '/chapter/' + run.n + '/counsel', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: boot.csrf, tier: x.tier }),
      }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'error' }; }); }).then(function (j) {
        btn.classList.remove('is-busy');
        if (j.bag) bag = j.bag;
        if (!j.ok) {
          sfx('error');
          paint(x);
          if (j.error === 'no_scroll') { offer(x, btn); return; }
          ask.innerHTML = ''; el('p', 'qs-counsel-ask-text is-bad', ask).textContent = j.error === 'solved' ? UI.counsel_solved : UI.error;
          return;
        }
        x.text = j.text; heardAny = true;
        closeAsk(); paint(x);
        Object.keys(cards).forEach(function (k) { paint(counsel.tiers[k - 1]); });
        sfx('seal'); window.setTimeout(function () { sfx('scroll'); }, reduce ? 0 : 380);
        var n = note(x, true);
        greet();
        window.setTimeout(function () { n.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }); }, 60);
      }, function () { btn.classList.remove('is-busy'); go.disabled = false; ask.innerHTML = ''; el('p', 'qs-counsel-ask-text is-bad', ask).textContent = UI.error; });
    }
    function offer(x, btn) {
      ask.innerHTML = ''; ask.hidden = false;
      ask.setAttribute('data-kind', x.kind);
      Object.keys(cards).forEach(function (k) { cards[k].classList.toggle('is-armed', cards[k] === btn); });
      var have = bag[x.kind] > 0;
      el('p', 'qs-counsel-ask-text', ask).textContent = (have ? UI.counsel_ask : UI.counsel_need).replace('{scroll}', scrollName(x.kind));
      var row = el('div', 'qs-counsel-ask-row', ask);
      if (have) {
        var go = el('button', 'btn btn-primary btn-sm', row); go.type = 'button'; go.textContent = UI.counsel_yes;
        go.addEventListener('click', function () { hear(x, btn, go); });
        window.setTimeout(function () { go.focus({ preventScroll: true }); }, 30);
      } else {
        var shop = el('a', 'btn btn-primary btn-sm', row); shop.textContent = UI.counsel_shop;
        shop.href = '/shop?need=' + encodeURIComponent(x.kind); shop.target = '_blank'; shop.rel = 'noopener';
      }
      var no = el('button', 'btn btn-ghost btn-sm', row); no.type = 'button'; no.textContent = UI.counsel_no;
      no.addEventListener('click', function () { closeAsk(); btn.focus({ preventScroll: true }); });
      sfx('paper');
    }

    counsel.tiers.forEach(function (x) {
      if (x.text !== undefined) note(x, false);
      if (done && x.text === undefined) return;
      var li = el('li', '', seals);
      var b = el('button', 'qs-seal', li); b.type = 'button'; b.setAttribute('data-kind', x.kind);
      b.setAttribute('data-testid', 'quest-counsel-' + x.tier);
      el('span', 'scroll-icon scroll-icon-md', b).setAttribute('data-kind', x.kind);
      var t = el('span', 'qs-seal-text', b);
      el('b', 'qs-seal-tier', t).textContent = UI.counsel_n.replace('{n}', ROMAN[x.tier - 1]);
      el('span', 'qs-seal-name', t).textContent = scrollName(x.kind);
      el('small', 'qs-seal-count', t);
      cards[x.tier] = b;
      paint(x);
      b.addEventListener('click', function () {
        if (x.text !== undefined) {
          var n = document.getElementById('qs-counsel-' + x.tier);
          if (n) { n.classList.remove('is-flash'); void n.offsetWidth; n.classList.add('is-flash'); n.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }); }
          return;
        }
        if (b.classList.contains('is-armed')) { closeAsk(); return; }
        offer(x, b);
      });
    });
    if (done) seals.hidden = true;

    // A scroll bought in another tab (the merchant opens in one) shows up here when the player comes back.
    function refresh() {
      if (!box.isConnected) { window.removeEventListener('focus', refresh); return; }
      fetch('/quests/' + QID + '/chapter/' + run.n, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
          var cs = j && j.challenge && j.challenge.counsel;
          if (!cs) return;
          bag = cs.bag || bag;
          counsel.tiers.forEach(paint);
          var armed = seals.querySelector('.qs-seal.is-armed');
          if (armed && !ask.hidden) { var tier = Number(armed.getAttribute('data-testid').slice(-1)); offer(counsel.tiers[tier - 1], armed); }
        }, function () { /* offline: keep the counts */ });
    }
    window.addEventListener('focus', refresh);
  }

  function caseFile(ch) {
    var c = run.chapter.challenge;
    return new Promise(function (resolve) {
      clearText(null);
      focusSpeaker(null);
      caseWrap.innerHTML = '';
      var f = el('section', 'qs-case', caseWrap);
      f.setAttribute('data-testid', 'quest-case');
      el('span', 'qs-case-clip', f).setAttribute('aria-hidden', 'true');
      el('p', 'qs-case-kicker', f).textContent = UI.case + ' · ' + ch.sub;
      el('h3', 'qs-case-title', f).textContent = c.title;
      var brief = el('div', 'qs-case-brief', f);
      c.brief.split('\n\n').forEach(function (para) { linkify(el('p', '', brief), fill(para)); });
      if (/\{host(?:13)?\}/.test(c.brief)) el('p', 'qs-case-note', f).textContent = UI.archive_hint;
      if (c.evidence.length) {
        var ev = el('div', 'qs-case-evidence', f);
        el('p', 'qs-case-label', ev).textContent = UI.evidence;
        c.evidence.forEach(function (e) {
          var a = el('a', 'qs-evidence', ev);
          a.href = e.href; a.setAttribute('download', e.name);
          el('span', 'qs-evidence-icon', a).setAttribute('aria-hidden', 'true');
          var t = el('span', 'qs-evidence-text', a);
          el('b', '', t).textContent = e.label;
          el('small', '', t).textContent = e.name;
        });
      }
      if (c.counsel) counselBox(f, c.counsel);
      var form = el('form', 'qs-case-form', f);
      var lab = el('label', 'qs-case-label', form); lab.textContent = UI.answer; lab.htmlFor = 'qs-answer';
      var row = el('div', 'qs-case-row', form);
      var input = el('input', 'input qs-answer', row);
      input.id = 'qs-answer'; input.name = 'answer'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = c.placeholder;
      input.setAttribute('data-testid', 'quest-answer');
      var go = el('button', 'btn btn-primary', row); go.type = 'submit'; go.textContent = UI.submit;
      var msg = el('p', 'qs-case-msg', form); msg.setAttribute('role', 'status');
      if (run.chapter.done) {
        input.value = '✓'; input.disabled = true; go.textContent = UI.next;
        msg.textContent = UI.solved; msg.className = 'qs-case-msg is-ok';
      }
      caseWrap.classList.add('is-on');
      window.setTimeout(function () { (run.chapter.done ? go : input).focus({ preventScroll: true }); }, 350);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (run.chapter.done) { caseWrap.classList.remove('is-on'); dlg.focus({ preventScroll: true }); resolve(run.chapter.post || []); return; }
        // (a replay already holds the recap of the scenes after the case)
        if (!input.value.trim() || go.disabled) return;
        go.disabled = true; msg.className = 'qs-case-msg'; msg.textContent = UI.checking;
        fetch('/quests/' + QID + '/chapter/' + run.n, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ _csrf: boot.csrf, answer: input.value }),
        }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'error' }; }); }).then(function (j) {
          go.disabled = false;
          if (j.ok) {
            sfx('seal'); sfx('fanfare');
            f.classList.add('is-solved');
            el('span', 'qs-stamp qs-case-stamp', f).textContent = UI.solved;
            msg.className = 'qs-case-msg is-ok'; msg.textContent = UI.solved;
            markDone(run.n);
            run.chapter.recapPost = j.recapPost;
            window.setTimeout(function () { caseWrap.classList.remove('is-on'); dlg.focus({ preventScroll: true }); resolve(j.post || []); }, reduce ? 600 : 1800);
            return;
          }
          sfx('error');
          msg.className = 'qs-case-msg is-bad';
          msg.textContent = j.error === 'slow' ? UI.slow : j.error === 'wrong' ? UI.wrong : UI.error;
          f.classList.remove('is-wrong'); void f.offsetWidth; f.classList.add('is-wrong');
          input.select();
        }, function () { go.disabled = false; msg.className = 'qs-case-msg is-bad'; msg.textContent = UI.error; });
      });
    });
  }

  // ---- chapters ------------------------------------------------------------------------------------------------
  var changed = false;
  function markDone(n) {
    changed = true;
    boot.chapters.forEach(function (c) { if (c.n === n) c.state = 'done'; if (c.n === n + 1 && c.state === 'locked') c.state = 'open'; });
    store(placeKey(n), null);
  }
  function preloadChapter(ch) {
    preloadSfx();
    var seen = {};
    (function walk(list) {
      (list || []).forEach(function (s) {
        if (s.bg && !seen[s.bg]) { seen[s.bg] = 1; new Image().src = ART + '/bg/' + s.bg + '.webp'; }
        if (s.cg && !seen[s.cg] && s.cg.indexOf('sealed:') !== 0) { seen[s.cg] = 1; new Image().src = ART + '/bg/' + s.cg + '.webp'; }
        var who = s.show || s.say;
        if (who) { var a = castArt(who, s.pose); if (a && !seen[a]) { seen[a] = 1; new Image().src = a; } }
        if (s.music) Music.preload(s.music);
        var pic = (s.item && itemArt(s.item.glyph)) || (s.tarot && tarotArt(s.tarot.sign));
        if (pic && !seen[pic]) { seen[pic] = 1; new Image().src = pic; }
        if (s.choice) s.choice.forEach(function (c) { walk(c.then); });
        if (s.explore) s.explore.spots.forEach(function (c) { walk(c.then); });
        if (s.qte && s.qte.fail) walk(s.qte.fail);
        if (s.seek) { var sp = picture(s.seek.pic); if (!seen[sp]) { seen[sp] = 1; new Image().src = sp; } s.seek.marks.forEach(function (m) { walk(m.then); }); }
      });
    })(ch.pre);
  }

  function resetStage() {
    Heart.stop();
    clearText(null);
    hide('all');
    setCg(null); setTint(null); setFlashback(null); setCam(null); setBars(false);
    setTremble(null); setTears(false); setMaskView(false); Glitch.set(null);
    if (qteNow) qteNow.finish();
    if (badWrap) { badWrap.classList.remove('is-on'); badWrap.innerHTML = ''; }
    if (seekNow) seekNow.end();
    Particles.stop();
    choices.classList.remove('is-on'); choices.innerHTML = '';
    spots.classList.remove('is-on'); spots.innerHTML = '';
    caseWrap.classList.remove('is-on'); caseWrap.innerHTML = '';
    overlay.classList.remove('is-on');
    titleCard.classList.remove('is-on');
    placeCard.classList.remove('is-on');
    endWrap.classList.remove('is-on');
    black.classList.add('is-on');
    logList.innerHTML = '';
  }

  function endCard(n) {
    return new Promise(function (resolve) {
      clearText(null);
      endWrap.innerHTML = '';
      var c = el('section', 'qs-end', endWrap);
      c.setAttribute('data-testid', 'quest-end');
      var next = boot.chapters.find(function (x) { return x.n === n + 1; });
      var cur = boot.chapters.find(function (x) { return x.n === n; });
      el('span', 'qs-end-seal', c).setAttribute('aria-hidden', 'true');
      el('p', 'qs-end-kicker', c).textContent = cur.sub;
      el('h3', 'qs-end-title', c).textContent = next ? UI.chapter_done : UI.end;
      el('p', 'qs-end-sub', c).textContent = next ? cur.title : (boot.upcoming && boot.upcoming[0] ? boot.upcoming[0].sub + ' · ' + boot.upcoming[0].title : '');
      var acts = el('div', 'qs-end-actions', c);
      if (next && next.state !== 'locked') {
        var go = el('button', 'btn btn-primary', acts); go.type = 'button'; go.textContent = UI.next_chapter;
        go.addEventListener('click', function () { endWrap.classList.remove('is-on'); dlg.focus({ preventScroll: true }); resolve(next.n); });
        window.setTimeout(function () { go.focus({ preventScroll: true }); }, 300);
      }
      var back = el('button', 'btn btn-secondary', acts); back.type = 'button'; back.textContent = UI.back;
      back.addEventListener('click', function () { endWrap.classList.remove('is-on'); resolve(-1); });
      if (!next) window.setTimeout(function () { back.focus({ preventScroll: true }); }, 300);
      endWrap.classList.add('is-on');
      sfx('fanfare');
    });
  }

  async function play(n, fresh) {
    var meta = boot.chapters.find(function (c) { return c.n === n; });
    if (!meta) return;
    var res = await fetch('/quests/' + QID + '/chapter/' + n, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!res.ok) { leave(); return; }
    var ch = await res.json();
    var me = { n: n, alive: true, chapter: ch };
    phase = 'pre'; skipAll = false;
    run = me;
    preloadChapter(ch);
    resetStage();
    var saved = fresh || ch.done ? 0 : Number(load(placeKey(n)) || 0);
    if (saved > 0 && saved < ch.pre.length) restore(ch.pre, saved); else saved = 0;
    await steps(ch.pre, true, saved, me);
    if (run !== me || !me.alive) return;
    Heart.stop();
    if (ch.challenge) {
      skipAll = false; skipBtn.setAttribute('aria-pressed', 'false');
      var post = await caseFile(ch);
      phase = 'post';
      if (run !== me || !me.alive) return;
      await steps(post, false, 0, me);
    } else if (!ch.done) {
      await fetch('/quests/' + QID + '/chapter/' + n, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: boot.csrf }),
      }).catch(function () {});
      markDone(n);
    }
    store(placeKey(n), null);
    Heart.stop();
    if (run !== me || !me.alive) return;
    clearText(null); hide('all');
    skipAll = false; skipBtn.setAttribute('aria-pressed', 'false');
    var nextN = await endCard(n);
    if (run !== me || !me.alive) return;
    if (nextN >= 0) { me.alive = false; Amb.stop(800); Particles.stop(); await play(nextN, true); } else leave();
  }

  function open(n, fresh) {
    if (!dlg.open) {
      dlg.showModal();
      dlg.focus({ preventScroll: true }); // not the first control: Space must advance, not press Auto
      document.documentElement.classList.add('qs-open');
    }
    progressed = false;
    hint.classList.remove('is-gone');
    if (run) run.alive = false;
    run = null;
    syncSound();
    var token = {};
    opening = token;
    askWarning().then(function (ok) {
      if (!ok || opening !== token || !dlg.open) return false;
      return askLang();
    }).then(function (ok) {
      if (!ok || opening !== token || !dlg.open) return;
      play(n, fresh).catch(function () { leave(); });
    });
  }
  function leave() {
    if (run) run.alive = false;
    run = null;
    if (waiter) waiter();
    if (typing) typing.finish();
    Heart.stop(); Music.stop(500); Amb.stop(500); Particles.stop();
    auto = false; skip = false; ctrlSkip = false;
    autoBtn.setAttribute('aria-pressed', 'false'); skipBtn.setAttribute('aria-pressed', 'false');
    logPanel.classList.remove('is-on');
    hidePanel(); opening = null;
    if (dlg.open) dlg.close();
    document.documentElement.classList.remove('qs-open');
    if (changed) {
      // A ?lang= left in the address would undo a language picked on the stage, so it goes before the reload.
      var u = new URL(window.location.href);
      if (u.searchParams.has('lang')) { u.searchParams.delete('lang'); window.location.replace(u.toString()); } else window.location.reload();
    }
  }
  // The browser may close the stage on its own (a second Esc in a row): tidy up exactly as if the player had left.
  dlg.addEventListener('close', function () { if (run || opening || skipWrap.classList.contains('is-on')) leave(); });

  // ---- a picture searched with the eye ({ seek }) ---------------------------------------------------------------------
  // The picture fills the stage; the player clicks where something is wrong. Each mark is a circle (`at` and radius `r`
  // as fractions of the picture's width). A find is ringed in red ink and its lines play over the picture; a miss
  // leaves a small cross. After three misses in a row, or on the hint button, the next mark glows; a second hint on
  // the same mark simply shows it. Skipping plays every mark's lines in order.
  var seekNow = null;
  async function seek(sk, me) {
    var marks = sk.marks, found = marks.map(function () { return false; });
    if (fast()) {
      for (var j = 0; j < marks.length; j++) if (marks[j].then) await steps(marks[j].then, false, 0, me);
      return;
    }
    seekWrap.innerHTML = '';
    var head = el('p', 'qs-seek-head', seekWrap);
    var headText = el('span', '', head); headText.textContent = sk.prompt;
    var left = el('span', 'qs-seek-left', head);
    var frame = el('div', 'qs-seek-frame', seekWrap);
    var img = el('img', 'qs-seek-img', frame); img.alt = sk.prompt;
    var layer = el('div', 'qs-seek-marks', frame);
    var hintBtn = el('button', 'qs-seek-hint', seekWrap); hintBtn.type = 'button'; hintBtn.textContent = UI.hint;
    var src = picture(sk.pic);
    await picReady(src);
    img.src = src;
    seekWrap.classList.add('is-on');
    sfx('paper');
    var count = 0, misses = 0, hinted = -1, ended = false;
    function update() { left.textContent = UI.left.replace('{n}', String(marks.length - count)); }
    update();
    function nextOpen() { return found.indexOf(false); }
    function ring(k, cls) {
      var m = marks[k], d = el('span', 'qs-seek-ring' + (cls ? ' ' + cls : ''), layer);
      d.style.left = (m.at[0] * 100) + '%'; d.style.top = (m.at[1] * 100) + '%'; d.style.width = (m.r * 200) + '%';
      return d;
    }
    function pulse(k) {
      layer.querySelectorAll('.qs-seek-ring.is-hint').forEach(function (n) { n.remove(); });
      ring(k, 'is-hint'); sfx('spot');
    }
    var picked = null;
    function choose(k) {
      if (!picked) return;
      var r = picked; picked = null; r(k);
    }
    frame.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!picked) return;
      var box = img.getBoundingClientRect();
      var fx = (e.clientX - box.left) / box.width, fy = (e.clientY - box.top) / box.width;
      for (var k = 0; k < marks.length; k++) {
        if (found[k]) continue;
        var dx = fx - marks[k].at[0], dy = fy - marks[k].at[1] * box.height / box.width;
        if (Math.sqrt(dx * dx + dy * dy) <= marks[k].r) { choose(k); return; }
      }
      // A miss: a small cross where you looked, a knock, and after three in a row the next seam glows.
      var x = el('span', 'qs-seek-miss', layer);
      x.style.left = (fx * 100) + '%'; x.style.top = ((e.clientY - box.top) / box.height * 100) + '%';
      window.setTimeout(function () { x.remove(); }, 900);
      sfx('miss');
      frame.classList.remove('is-miss'); void frame.offsetWidth; frame.classList.add('is-miss');
      misses++;
      if (misses % 3 === 0) { hinted = nextOpen(); pulse(hinted); }
    });
    hintBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var k = nextOpen();
      if (k < 0) return;
      if (hinted === k) { choose(k); return; }   // asked twice: just show it
      hinted = k; pulse(k);
    });
    seekNow = { end: function () { ended = true; choose(-1); seekWrap.classList.remove('is-on'); seekWrap.innerHTML = ''; seekNow = null; } };
    while (!ended && run === me && me.alive && count < marks.length) {
      var k = await new Promise(function (r) { picked = r; });
      if (k < 0 || ended) break;
      found[k] = true; count++; misses = 0; hinted = -1;
      layer.querySelectorAll('.qs-seek-ring.is-hint').forEach(function (n) { n.remove(); });
      var done = ring(k, 'is-found');
      el('span', 'qs-seek-label', done).textContent = marks[k].label;
      sfx('seal');
      update();
      seekWrap.classList.add('is-busy');
      if (marks[k].then) await steps(marks[k].then, false, 0, me);
      clearText(null);
      seekWrap.classList.remove('is-busy');
    }
    if (ended || run !== me) return;
    await sleep(900);
    seekWrap.classList.remove('is-on');
    await sleep(500);
    seekWrap.innerHTML = '';
    seekNow = null;
  }

  // ---- quick-time moments ({ qte }) ------------------------------------------------------------------------------------
  // The body does something and the player does it with him: 'mash' (press again and again; it drains if you stop),
  // 'alternate' (left, right, left: shouldering through a crowd), 'hold' (hold, and let go inside the line: pulling a
  // bandage tight), 'timing' (press while the mark is inside the line, `rounds` times: a step on a broken leg). A miss
  // never ends the story; it shakes and goes again. 'still' (hiding: hold, and keep holding for `time` ms while danger
  // passes; let go early and you are nearly heard) and 'dodge' (running: an arrow shows, press it before it is gone,
  // `rounds` times). `hopeless` is a struggle that cannot be won: the gauge is pulled back faster than anyone can
  // press, and after `time` ms the scene goes on regardless. Skipping and auto play it for you. Keys: Space/Enter (or
  // the arrows for 'alternate' and 'dodge'); every control is also a button for touch. 'parry' (a sword fight) reads like
  // 'dodge', but each arrow is a blow coming in: meet it and steel rings, sparks flash and the stage jolts.
  var qteNow = null;
  // A quick-time moment, v3: no buttons. The stage shows the keys to press as keycaps, the whole screen is the touch
  // target (tap, hold, or the left/right half and the left/middle/right third for arrows), and a gauge shows the
  // effort. With `fail` steps the moment is timed: run out of time (or miss too often, or let go while hiding) and it
  // resolves 'fail'; the caller then plays the short bad ending and offers a retry. Without them a miss just goes
  // again. Resolves 'win' or 'fail'; skipping, Ctrl and auto play it for you ('win').
  var QTE_LIMIT = { mash: 7000, alternate: 7500, hold: 8000, timing: 11000, still: 0, dodge: 0, parry: 0 };
  function qte(q) {
    if (fast()) return Promise.resolve('win');
    return new Promise(function (resolve) {
      var kind = q.kind, hopeless = !!q.hopeless, timed = !!(q.fail && q.fail.length) && !hopeless;
      var v = 0, side = 'left', holding = false, started = false, done = false, round = 0, rounds = q.rounds || 3, misses = 0;
      var zone = kind === 'hold' ? [0.68, 0.86] : [0.42, 0.58], m = 0, dir = 1;
      var t0 = performance.now(), last = t0, raf = 0, autoT = 0, nextBeat = 0, nextCreak = 0, nextTick = 0, cueMax = 1;
      var limit = timed ? (q.limit || QTE_LIMIT[kind] || 0) : 0;
      var DIRS = { left: '←', up: '↑', right: '→' }, want = null, cueLeft = 0;
      var held = kind === 'hold' || kind === 'still', arrows = kind === 'dodge' || kind === 'parry';
      qteWrap.innerHTML = '';
      qteWrap.setAttribute('data-kind', kind);
      qteWrap.classList.remove('is-won', 'is-lost', 'is-late');
      dlg.setAttribute('data-qte', kind);
      sfx('qte');
      var stage = el('div', 'qs-qte-stage', qteWrap);
      var prompt = el('p', 'qs-qte-prompt', stage); prompt.textContent = q.prompt; prompt.setAttribute('aria-live', 'assertive');
      var gauge = el('div', 'qs-qte-gauge', stage);
      var zoneEl = el('span', 'qs-qte-zone', gauge), fill = el('span', 'qs-qte-fill', gauge), mark = el('span', 'qs-qte-mark', gauge);
      var pips = el('div', 'qs-qte-pips', stage);
      if (kind === 'timing' || arrows) for (var i = 0; i < rounds; i++) el('span', 'qs-qte-pip', pips);
      var keys = el('div', 'qs-qte-keys', stage); keys.setAttribute('aria-hidden', 'true');
      var caps = {};
      function cap(k, label) { var c = el('kbd', 'qs-qte-cap' + (label.length > 1 ? ' is-wide' : ''), keys); c.textContent = label; caps[k] = c; return c; }
      if (kind === 'alternate') { cap('left', '←'); cap('right', '→'); }
      else if (arrows) { var cue = cap('cue', '·'); cue.classList.add('is-cue'); }
      else cap('one', UI.qte_space);
      var verb = el('p', 'qs-qte-verb', stage); verb.textContent = UI['qte_' + kind] || '';
      el('p', 'qs-qte-touch', stage).textContent = UI.qte_touch;
      var timer = el('div', 'qs-qte-timer', stage), timerFill = el('span', '', timer);
      timer.hidden = !limit && kind !== 'still';
      function placeZone() { zoneEl.style.left = (zone[0] * 100) + '%'; zoneEl.style.width = ((zone[1] - zone[0]) * 100) + '%'; }
      if (kind === 'hold' || kind === 'timing') placeZone(); else zoneEl.hidden = true;
      mark.hidden = kind !== 'timing';
      if (kind === 'still' && timed) verb.textContent = UI.qte_still;
      // ---- feedback
      function strain(level) {
        if (!soundOn()) return;
        var c = ac(); if (!c) return;
        var t = c.currentTime + 0.01, f = 140 + level * 360;
        osc(c, S.output(), 'sawtooth', f, t, 0.09, 0.035, f * 0.9, 0.005);
        band(c, S.output(), t, 0.07, 0.05, 500 + level * 1500, 0, 2, 0.002);
      }
      function press1(c) { if (!c) return; c.classList.remove('is-press'); void c.offsetWidth; c.classList.add('is-press'); }
      function kick() { stage.classList.remove('is-kick'); void stage.offsetWidth; stage.classList.add('is-kick'); }
      function jolt() {
        stage.classList.remove('is-miss'); void stage.offsetWidth; stage.classList.add('is-miss');
        sfx('miss');
        if (!reduce) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); }
        flash.className = 'qs-flash is-red is-soft'; void flash.offsetWidth; flash.classList.add('is-on');
      }
      function strike() { misses++; if (kind === 'parry') sfx('cut'); jolt(); if (timed && misses >= 3) lose(); }
      // ---- input
      function press(which) {
        if (done) return;
        started = true;
        if (kind === 'mash') {
          if (hopeless) {
            v = Math.min(0.97, v + (q.step || 0.09) * 1.7 * Math.pow(1 - v, 1.6));
            if (v > 0.7 && !reduce) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); }
          } else v = Math.min(1, v + (q.step || 0.07));
          press1(caps.one); kick(); strain(v);
        }
        else if (kind === 'alternate') {
          if (which !== side) { press1(caps[which]); jolt(); return; }
          press1(caps[side]); v = Math.min(1, v + 0.075); side = side === 'left' ? 'right' : 'left'; kick(); strain(v * 0.7);
          qteWrap.setAttribute('data-next', side);
        } else if (kind === 'timing') {
          press1(caps.one);
          if (m >= zone[0] && m <= zone[1]) {
            pips.children[round].classList.add('is-on'); round++; sfx('thud'); kick();
            if (round >= rounds) { win(); return; }
            var c = 0.2 + Math.random() * 0.6, w = Math.max(0.1, 0.16 - round * 0.02); zone = [c - w / 2, c + w / 2]; placeZone();
          } else strike();
        } else if (arrows) {
          if (!want) return;
          press1(caps.cue);
          if (which === want) {
            pips.children[round].classList.add('is-on'); round++; kick();
            if (kind === 'parry') {
              sfx('clash');
              flash.className = 'qs-flash is-white is-soft'; void flash.offsetWidth; flash.classList.add('is-on');
              if (!reduce) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); }
            } else sfx('whoosh');
            if (round >= rounds) { win(); return; }
            nextCue();
          } else { strike(); if (!done) nextCue(); }
        }
        if (!hopeless && v >= 1) win();
      }
      function nextCue() {
        var k = Object.keys(DIRS), pick = k[Math.floor(Math.random() * k.length)];
        want = pick; cueLeft = cueMax = Math.max(0.55, (q.time || 1300) / 1000 - round * 0.08);
        caps.cue.textContent = DIRS[pick];
        caps.cue.classList.remove('is-new'); void caps.cue.offsetWidth; caps.cue.classList.add('is-new');
        sfx('tick');
      }
      function down() {
        if (done || !held || holding) return;
        holding = true; started = true; stage.classList.add('is-holding'); caps.one.classList.add('is-down');
      }
      function up() {
        if (done || !held || !holding) return;
        holding = false; stage.classList.remove('is-holding'); caps.one.classList.remove('is-down');
        if (kind === 'still') {
          if (v < 1) { if (timed) { lose(); return; } jolt(); v = 0; prompt.textContent = UI.qte_again + ' · ' + q.prompt; }
          return;
        }
        if (v >= zone[0] && v <= zone[1]) win(); else { jolt(); v = 0; prompt.textContent = UI.qte_again + ' · ' + q.prompt; }
      }
      // The whole screen is the control on touch; a mouse works the same way.
      function where(e) {
        var r = qteWrap.getBoundingClientRect(), x = (e.clientX - r.left) / r.width;
        if (kind === 'alternate') return x < 0.5 ? 'left' : 'right';
        if (arrows) return x < 1 / 3 ? 'left' : x < 2 / 3 ? 'up' : 'right';
        return null;
      }
      function onDown(e) {
        if (e.target.closest && e.target.closest('.qs-bar')) return;
        e.preventDefault(); e.stopPropagation();
        if (held) down(); else press(where(e));
      }
      function onUp(e) { e.stopPropagation(); if (held) up(); }
      qteWrap.addEventListener('pointerdown', onDown);
      qteWrap.addEventListener('pointerup', onUp);
      qteWrap.addEventListener('pointercancel', onUp);
      qteWrap.addEventListener('click', function (e) { e.stopPropagation(); });
      // ---- the clock
      function frame(now) {
        var dt = Math.min(0.1, (now - last) / 1000); last = now;
        if (fast()) { finish('win'); return; }
        if (done) return;
        var age = now - t0;
        if (kind === 'mash' || kind === 'alternate') {
          var T = q.time || 5200, late = age / T;
          var drain = hopeless ? (late < 0.78 ? 0.1 + 0.3 * late : 2.4) : (kind === 'mash' ? 0.2 : 0.12);
          v = Math.max(0, v - drain * dt);
          if (hopeless) {
            if (late >= 0.78 && now >= nextBeat) { nextBeat = now + 320; sfx('beat'); if (!reduce) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); } }
            stage.style.setProperty('--strain', String(Math.min(1, age / (q.time || 5200))));
            stage.classList.add('is-strain');
          }
        } else if (kind === 'hold') {
          if (holding && now >= nextCreak) { nextCreak = now + 130; strain(v * 0.8); }
          if (holding) { v += 0.5 * dt; if (v > 1) { holding = false; stage.classList.remove('is-holding'); caps.one.classList.remove('is-down'); jolt(); v = 0; } }
        } else if (kind === 'timing') {
          m += dir * dt * (0.75 + round * 0.25);
          if (m > 1) { m = 1; dir = -1; sfx('tick'); } else if (m < 0) { m = 0; dir = 1; sfx('tick'); }
          mark.style.left = (m * 100) + '%';
        } else if (kind === 'still') {
          if (holding) { v += dt / ((q.time || 3500) / 1000); if (v >= 1) { win(); return; } }
          if (now >= nextBeat) { nextBeat = now + (holding ? 820 - v * 420 : 1000); sfx('beat'); kick(); }
          // Hiding has its own clock: get still before the danger arrives.
          if (timed && !started) {
            var wait = 1 - age / (q.limit || 2600);
            timerFill.style.width = (Math.max(0, wait) * 100) + '%';
            if (wait <= 0) { lose(); return; }
          } else timerFill.style.width = '0%';
        } else if (arrows) {
          if (want) {
            cueLeft -= dt;
            caps.cue.style.setProperty('--left', String(Math.max(0, cueLeft / cueMax)));
            if (cueLeft <= 0) { strike(); if (!done) nextCue(); }
          }
        }
        fill.style.width = (Math.max(0, Math.min(1, kind === 'timing' || arrows ? round / rounds : v)) * 100) + '%';
        if (limit) {
          var leftT = 1 - age / limit;
          timerFill.style.width = (Math.max(0, leftT) * 100) + '%';
          qteWrap.classList.toggle('is-late', leftT < 0.3);
          if (leftT < 0.3 && now >= nextTick) { nextTick = now + 380; sfx('tick'); }
          if (leftT <= 0) { lose(); return; }
        }
        if (hopeless && age >= (q.time || 5200)) {
          sfx('thud'); qteWrap.classList.add('is-lost');
          flash.className = 'qs-flash is-dark'; void flash.offsetWidth; flash.classList.add('is-on');
          done = true; window.setTimeout(function () { finish('win'); }, 500); return;
        }
        raf = window.requestAnimationFrame(frame);
      }
      function win() {
        if (done) return;
        done = true;
        fill.style.width = '100%';
        sfx('release');
        qteWrap.classList.add('is-won');
        flash.className = 'qs-flash is-white is-soft'; void flash.offsetWidth; flash.classList.add('is-on');
        window.setTimeout(function () { finish('win'); }, 560);
      }
      function lose() {
        if (done) return;
        done = true;
        sfx('sting'); qteWrap.classList.add('is-lost');
        flash.className = 'qs-flash is-red'; void flash.offsetWidth; flash.classList.add('is-on');
        window.setTimeout(function () { finish('fail'); }, 650);
      }
      var finished = false;
      function finish(result) {
        if (finished) return;
        finished = true; done = true;
        window.cancelAnimationFrame(raf); window.clearTimeout(autoT);
        qteNow = null;
        qteWrap.classList.remove('is-on');
        qteWrap.removeAttribute('data-kind');
        dlg.removeAttribute('data-qte');
        dlg.focus({ preventScroll: true });
        window.setTimeout(function () { qteWrap.innerHTML = ''; resolve(result || 'win'); }, 260);
      }
      qteNow = {
        key: function (e) {
          if (e.type === 'keydown') {
            if (e.repeat && !held) return;
            var arrow = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up' }[e.key];
            if ((kind === 'alternate' && arrow && arrow !== 'up') || (arrows && arrow)) press(arrow);
            else if (e.key === ' ' || e.key === 'Enter') { if (held) down(); else if (kind !== 'alternate' && !arrows) press(null); }
          } else if (e.type === 'keyup' && (e.key === ' ' || e.key === 'Enter')) up();
        },
        finish: function () { finish('win'); },
      };
      qteWrap.setAttribute('data-next', 'left');
      qteWrap.classList.add('is-on');
      if (arrows) window.setTimeout(function () { if (!done) nextCue(); }, 700);
      raf = window.requestAnimationFrame(frame);
      if (auto && !hopeless) autoT = window.setTimeout(win, 1400);
    });
  }
  // A short bad ending: the screen holds a card ("Bad end" and one line) and offers the moment again.
  var badWrap = null;
  function badEnd(text) {
    if (fast()) return Promise.resolve(true);
    return new Promise(function (resolve) {
      if (!badWrap) badWrap = el('div', 'qs-badend', dlg);
      badWrap.innerHTML = '';
      var c = el('section', 'qs-badend-card', badWrap);
      c.setAttribute('role', 'alertdialog');
      el('p', 'qs-badend-kicker', c).textContent = UI.qte_end;
      if (text) el('p', 'qs-badend-text', c).textContent = text;
      var again = el('button', 'qs-badend-go', c); again.type = 'button'; again.textContent = UI.qte_retry;
      badWrap.classList.add('is-on');
      sfx('bell');
      again.addEventListener('click', function (e) {
        e.stopPropagation();
        badWrap.classList.remove('is-on');
        window.setTimeout(function () { badWrap.innerHTML = ''; }, 400);
        dlg.focus({ preventScroll: true });
        resolve(true);
      });
      window.setTimeout(function () { again.focus({ preventScroll: true }); }, 60);
    });
  }
  // What the stage looks and sounds like right now, so a retried moment starts where it was.
  function stageSnap() {
    var src = bgFront.getAttribute('src') || '';
    return { black: black.classList.contains('is-on'), tint: tint.className, flashback: dlg.getAttribute('data-flashback'),
      tremble: dlg.getAttribute('data-tremble'), tears: dlg.hasAttribute('data-tears'), glitch: Glitch.kind(), music: Music.current(), amb: Amb.current(),
      heart: Heart.kind(), bg: bgFront.classList.contains('is-on') ? src.replace(/^.*\/bg\//, '').replace(/\.webp$/, '') : null };
  }
  function stageRestore(st) {
    clearText(null);
    Heart.set(st.heart);
    tint.className = st.tint;
    setFlashback(st.flashback); setTremble(st.tremble); setTears(st.tears); Glitch.set(st.glitch);
    Music.play(st.music, 600); Amb.set(st.amb);
    if (st.bg) setBg(st.bg, 'cut');
    setBlack(st.black);
  }
  // While a quick-time moment is on, its keys are its own (Esc still leaves, Ctrl still skips it).
  dlg.addEventListener('keydown', function (e) {
    if (!qteNow || e.key === 'Escape') return;
    if (e.key === 'Control') { qteNow.finish(); return; }
    if (/^(?: |Enter|ArrowLeft|ArrowRight|ArrowUp)$/.test(e.key)) { e.preventDefault(); e.stopImmediatePropagation(); qteNow.key(e); }
  }, true);
  dlg.addEventListener('keyup', function (e) {
    if (qteNow && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); e.stopImmediatePropagation(); qteNow.key(e); }
  }, true);

  // ---- input -----------------------------------------------------------------------------------------------------
  dlg.addEventListener('click', function (e) {
    if (skipWrap.classList.contains('is-on')) return;
    if (e.target.closest('.qs-bar, .qs-choices, .qs-spots, .qs-qte, .qs-badend, .qs-case-wrap, .qs-end-wrap, .qs-log, .qs-skip-wrap, a, button, input')) return;
    advance();
  });
  dlg.addEventListener('cancel', function (e) {
    e.preventDefault();
    if (logPanel.classList.contains('is-on')) { logPanel.classList.remove('is-on'); return; }
    if (skipWrap.classList.contains('is-on') && panelEsc) { panelEsc(); return; }
    askClose();
  });
  dlg.addEventListener('keydown', function (e) {
    var inField = e.target.matches && e.target.matches('input, textarea');
    if (e.key === 'Control') { ctrlSkip = true; if (typing) typing.finish(); if (waiter && !choices.classList.contains('is-on')) waiter(); return; }
    if (inField) return;
    if (/^[1-9]$/.test(e.key) && choices.classList.contains('is-on') && choices.buttons) {
      var b = choices.buttons[Number(e.key) - 1];
      if (b) { e.preventDefault(); b.click(); }
      return;
    }
    // Space and Enter belong to a control only while its panel is showing; anywhere else they advance the scene.
    if (skipWrap.classList.contains('is-on') && !(e.target.matches && e.target.matches('button'))) { e.preventDefault(); return; }
    var control = e.target.closest && e.target.closest('.qs-choices.is-on, .qs-spots.is-on, .qs-badend.is-on, .qs-case-wrap.is-on, .qs-end-wrap.is-on, .qs-log.is-on, .qs-skip-wrap.is-on') && e.target.matches('button, a');
    if ((e.key === ' ' || e.key === 'Enter') && !control) { e.preventDefault(); advance(); }
    else if (e.key === 'a' || e.key === 'A') autoBtn.click();
    else if (e.key === 'l' || e.key === 'L') logBtn.click();
    else if (e.key === 'm' || e.key === 'M') soundBtn.click();
  });
  dlg.addEventListener('keyup', function (e) { if (e.key === 'Control') ctrlSkip = false; });
  // When the button that had focus goes away (a spot, a choice, a quick-time key), focus falls to <body> and the keys
  // would stop reaching the stage: take focus back and hand the key on, so Space never "freezes" a scene.
  ['keydown', 'keyup'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (!dlg.open || dlg.contains(e.target)) return;
      dlg.focus({ preventScroll: true });
      var copy = new KeyboardEvent(type, { key: e.key, code: e.code, repeat: e.repeat, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, bubbles: true, cancelable: true });
      if (!dlg.dispatchEvent(copy)) e.preventDefault();
    });
  });
  window.addEventListener('blur', function () { ctrlSkip = false; });
  autoBtn.addEventListener('click', function () {
    auto = !auto; autoBtn.setAttribute('aria-pressed', String(auto));
    if (auto && !typing && waiter) waiter();
    dlg.focus({ preventScroll: true });
  });
  // The stage's own small panels (skip, leave, language) share one parchment card over a dimmed scene. Esc takes the
  // panel's own way out.
  var panelEsc = null, opening = null;
  function hidePanel() { skipWrap.classList.remove('is-on'); skipWrap.removeAttribute('data-mode'); panelEsc = null; }
  function panel(mode, kicker, text, extra) {
    skipWrap.innerHTML = '';
    var c = el('section', 'qs-skip' + (extra ? ' ' + extra : ''), skipWrap);
    c.setAttribute('role', 'alertdialog');
    var k = el('p', 'qs-skip-kicker', c); k.textContent = kicker; k.id = 'qs-panel-title';
    var t = el('p', 'qs-skip-text', c); t.textContent = text; t.id = 'qs-panel-text';
    c.setAttribute('aria-labelledby', k.id); c.setAttribute('aria-describedby', t.id);
    skipWrap.setAttribute('data-mode', mode);
    return el('div', 'qs-skip-actions', c);
  }
  function showPanel(focusEl) {
    skipWrap.classList.add('is-on');
    window.setTimeout(function () { if (focusEl) focusEl.focus({ preventScroll: true }); }, 60);
  }
  // Leaving asks on the stage itself, not in the browser's own box. Before a chapter starts there is nothing to lose.
  function askClose() {
    if (!dlg.open) return;
    var mode = skipWrap.getAttribute('data-mode');
    if (mode === 'lang' || !run) { leave(); return; }
    if (mode === 'close') return;
    var acts = panel('close', UI.close_title, UI.confirm_close, 'qs-leave');
    var stay = el('button', 'btn btn-secondary', acts); stay.type = 'button'; stay.textContent = UI.close_stay;
    var go = el('button', 'btn btn-primary', acts); go.type = 'button'; go.textContent = UI.close_go;
    stay.addEventListener('click', function () { hidePanel(); dlg.focus({ preventScroll: true }); });
    go.addEventListener('click', function () { leave(); });
    panelEsc = function () { stay.click(); };
    showPanel(stay);
  }
  // Every chapter opens on a language choice, so nobody has to leave the story to switch. Picking the other one asks
  // the server for the stage's words in it (which also remembers the choice), and the chapter then loads in it.
  var LANG_OPTS = [{ id: 'en', label: 'English' }, { id: 'id', label: 'Bahasa Indonesia' }];
  function switchLang(lang) {
    return fetch('/quests/' + QID + '/stage?lang=' + encodeURIComponent(lang), { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('stage'); return r.json(); })
      .then(function (w) {
        boot.lang = w.lang; boot.quest = w.quest; boot.cast = w.cast; boot.chapters = w.chapters; boot.upcoming = w.upcoming;
        UI = boot.ui = w.ui; boot.scrolls = w.scrolls;
        relabel();
        changed = true; // the journal behind the stage is still in the old language: reload it on the way out
      });
  }
  // A quest's content warning (age, flashing lights, violence) comes first, before the language, once per browser
  // session. Leaving closes the stage; nothing has started yet.
  var WARN_KEY = 'hvwa-quest-warned:' + QID;
  function askWarning() {
    var w = boot.warning, seen = false;
    try { seen = window.sessionStorage.getItem(WARN_KEY) === '1'; } catch (e) { /* storage blocked: ask every time */ }
    if (!w || seen) return Promise.resolve(true);
    return new Promise(function (done) {
      var acts = panel('warn', w.title, '', 'qs-warn');
      hint.classList.add('is-gone');
      var card = acts.parentNode, text = card.querySelector('.qs-skip-text');
      var age = el('span', 'qs-warn-age'); age.textContent = w.age; age.setAttribute('aria-hidden', 'true');
      card.insertBefore(age, card.firstChild);
      var list = el('ul', 'qs-warn-list'); list.id = 'qs-panel-text';
      w.items.forEach(function (it) {
        var li = el('li', 'qs-warn-item', list);
        el('strong', 'qs-warn-head', li).textContent = it.head;
        el('span', 'qs-warn-text', li).textContent = it.text;
      });
      card.replaceChild(list, text);
      var out = el('button', 'btn btn-secondary', acts); out.type = 'button'; out.textContent = w.leave;
      var go = el('button', 'btn btn-primary', acts); go.type = 'button'; go.textContent = w.go;
      out.addEventListener('click', function () { done(false); leave(); });
      go.addEventListener('click', function () {
        try { window.sessionStorage.setItem(WARN_KEY, '1'); } catch (e) { /* storage blocked */ }
        hidePanel();
        hint.classList.remove('is-gone');
        dlg.focus({ preventScroll: true });
        done(true);
      });
      panelEsc = function () { out.click(); };
      showPanel(go);
    });
  }
  function askLang() {
    return new Promise(function (done) {
      var acts = panel('lang', 'Language · Bahasa', 'Choose the language for this chapter.\nPilih bahasa untuk bab ini.', 'qs-lang');
      hint.classList.add('is-gone');
      acts.classList.add('qs-lang-actions');
      var current = null;
      LANG_OPTS.forEach(function (o) {
        var on = o.id === boot.lang;
        var b = el('button', 'btn ' + (on ? 'btn-primary' : 'btn-secondary'), acts);
        b.type = 'button'; b.lang = o.id; b.textContent = o.label; b.setAttribute('aria-pressed', String(on));
        if (on) current = b;
        b.addEventListener('click', function () {
          acts.querySelectorAll('button').forEach(function (x) { x.disabled = true; });
          (on ? Promise.resolve() : switchLang(o.id).catch(function () { /* keep the language we have */ })).then(function () {
            hidePanel();
            hint.classList.remove('is-gone');
            dlg.focus({ preventScroll: true });
            done(true);
          });
        });
      });
      panelEsc = function () { done(false); leave(); };
      showPanel(current || acts.querySelector('button'));
    });
  }

  // Skip asks first: a short recap of what this part says, then "skip ahead" runs to the case (or the end).
  function askSkip() {
    if (!run || skipAll) return;
    var recap = phase === 'post' ? run.chapter.recapPost : run.chapter.recap;
    skipWrap.innerHTML = '';
    var c = el('section', 'qs-skip', skipWrap);
    el('p', 'qs-skip-kicker', c).textContent = UI.skip_title;
    rich(el('p', 'qs-skip-text', c), fill(recap || ''));
    var acts = el('div', 'qs-skip-actions', c);
    var stay = el('button', 'btn btn-secondary', acts); stay.type = 'button'; stay.textContent = UI.skip_stay;
    var go = el('button', 'btn btn-primary', acts); go.type = 'button'; go.textContent = UI.skip_go;
    stay.addEventListener('click', function () { hidePanel(); dlg.focus({ preventScroll: true }); });
    panelEsc = function () { stay.click(); };
    skipWrap.setAttribute('data-mode', 'skip');
    go.addEventListener('click', function () {
      hidePanel();
      skipAll = true; skipBtn.setAttribute('aria-pressed', 'true');
      dlg.focus({ preventScroll: true });
      if (typing) typing.finish();
      if (waiter) waiter();
      if (choices.classList.contains('is-on') && choices.buttons && choices.buttons[0]) choices.buttons[0].click();
      var spot = spots.classList.contains('is-on') && spots.querySelector('.qs-spot:not(.is-seen)');
      if (spot) spot.click();
    });
    skipWrap.classList.add('is-on');
    window.setTimeout(function () { go.focus({ preventScroll: true }); }, 60);
  }
  skipBtn.addEventListener('click', askSkip);
  soundBtn.addEventListener('click', function () {
    if (!S) return;
    S.set(!S.isOn());
    syncSound();
    dlg.focus({ preventScroll: true });
  });
  if (S) S.onChange(function (on) {
    syncSound();
    if (on) { Music.resume(); Amb.resume(); } else { Music.silence(300); Amb.pause(300); }
  });
  logBtn.addEventListener('click', function () {
    logPanel.classList.toggle('is-on');
    if (logPanel.classList.contains('is-on')) logList.scrollTop = logList.scrollHeight;
  });
  logClose.addEventListener('click', function () { logPanel.classList.remove('is-on'); dlg.focus({ preventScroll: true }); });
  closeBtn.addEventListener('click', askClose);

  // ---- the journal -----------------------------------------------------------------------------------------------
  document.querySelectorAll('[data-quest-chapter]').forEach(function (b) {
    var n = Number(b.getAttribute('data-quest-chapter'));
    var meta = boot.chapters.find(function (c) { return c.n === n; });
    if (meta && meta.state === 'open' && Number(load(placeKey(n)) || 0) > 0) b.textContent = UI.resume;
    b.hidden = false;
    b.addEventListener('click', function () { open(n, meta && meta.state === 'done'); });
  });
  var playBtn = document.querySelector('[data-quest-play]');
  if (playBtn) {
    var target = boot.chapters.find(function (c) { return c.state === 'open'; }) || boot.chapters[boot.chapters.length - 1];
    if (target.state === 'done') playBtn.textContent = UI.replay;
    playBtn.hidden = false;
    playBtn.addEventListener('click', function () { open(target.n, target.state === 'done'); });
  }
})();
