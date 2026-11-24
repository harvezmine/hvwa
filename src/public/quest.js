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
    return String(text).replace(/\{name\}/g, boot.player.name).replace(/\{host\}/g, boot.host);
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
    return { play: play, resume: resume, silence: silence, stop: stop, preload: preload, duck: duck };
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
    return { set: set, pause: pause, resume: resume, stop: stop };
  })();

  // ---- effects: the guild's own (paper, seal, chime...) plus the quest's ---------------------------------------------
  var QSFX = {
    bell: function (c, o, t) { [[2093, 0.09, 1.6], [2512, 0.05, 1.1], [3346, 0.04, 0.7], [4702, 0.02, 0.4]].forEach(function (p) { osc(c, o, 'sine', p[0], t, p[2], p[1]); osc(c, o, 'sine', p[0] * 1.004, t + 0.12, p[2] * 0.8, p[1] * 0.6); }); },
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
    thud: function (c, o, t) { osc(c, o, 'sine', 120, t, 0.45, 0.6, 40); band(c, o, t, 0.2, 0.12, 300, 0, 1, 0.003, 'lowpass'); },
    murmur: function (c, o, t) { for (var i = 0; i < 7; i++) band(c, o, t + i * 0.35, 1.8, 0.05, 300 + Math.random() * 700, 0, 4, 0.3); },
    cut: function (c, o, t) { band(c, o, t, 0.28, 0.25, 2500, 6000, 1.5, 0.01); osc(c, o, 'triangle', 900, t + 0.05, 0.12, 0.05, 400); },
    door: function (c, o, t) { osc(c, o, 'sawtooth', 120, t, 0.5, 0.04, 85); band(c, o, t, 0.6, 0.05, 400, 900, 3); osc(c, o, 'sine', 70, t + 0.55, 0.3, 0.45, 45); },
    armor: function (c, o, t) { [0, 0.33, 0.6, 0.9].forEach(function (d) { osc(c, o, 'square', 1800 + Math.random() * 600, t + d, 0.06, 0.03); band(c, o, t + d, 0.12, 0.12, 150, 0, 1, 0.005); }); },
    alarm: function (c, o, t) { for (var i = 0; i < 4; i++) { [[880, 0.07], [1320, 0.04], [2211, 0.02]].forEach(function (p) { osc(c, o, 'sine', p[0], t + i * 0.9, 1.4, p[1]); }); } },
    whoosh: function (c, o, t) { band(c, o, t, 0.5, 0.2, 400, 3000, 0.8, 0.12); },
    spot: function (c, o, t) { osc(c, o, 'sine', 1568, t, 0.25, 0.04); osc(c, o, 'sine', 2349, t + 0.06, 0.3, 0.03); },
    pick: function (c, o, t) { osc(c, o, 'triangle', 660, t, 0.08, 0.06, 990); band(c, o, t, 0.12, 0.08, 1800, 3600, 2, 0.002); },
  };
  function sfx(name) {
    if (!soundOn()) return;
    if (QSFX[name]) {
      var c = ac();
      if (!c) return;
      QSFX[name](c, S.output(), c.currentTime + 0.02);
    } else S.play(name);
  }
  // Each character speaks with a pitch of their own: a soft blip per few letters while the line types.
  function voice(pitch, soft) {
    if (!soundOn()) return;
    var c = ac();
    if (!c) return;
    var f = pitch * (0.92 + Math.random() * 0.16);
    osc(c, S.output(), pitch < 300 ? 'square' : 'triangle', f, c.currentTime + 0.005, 0.045, soft ? 0.012 : (pitch < 300 ? 0.014 : 0.03));
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
  var castLayer = el('div', 'qs-cast', cam);
  var tint = el('div', 'qs-tint', scene);
  el('div', 'qs-vignette', scene);
  var canvas = el('canvas', 'qs-particles', scene);
  var spots = el('div', 'qs-spots', scene);
  var cgWrap = el('div', 'qs-cg', scene);
  var cgImg = el('img', '', cgWrap); cgImg.alt = '';
  var bars = el('div', 'qs-bars', dlg);
  el('span', 'qs-bar-top', bars); el('span', 'qs-bar-bottom', bars);
  var black = el('div', 'qs-black is-on', dlg);
  var flash = el('div', 'qs-flash', dlg);
  var placeCard = el('div', 'qs-place', dlg);
  var placeName = el('p', 'qs-place-name', placeCard), placeTime = el('p', 'qs-place-time', placeCard);
  var titleCard = el('div', 'qs-title', dlg);
  el('span', 'qs-title-orn', titleCard);
  var titleSub = el('p', 'qs-title-sub', titleCard), titleMain = el('h2', 'qs-title-main', titleCard);
  el('span', 'qs-title-rule', titleCard);
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
  var closeBtn = barBtn(UI.close, 'close', 'i-x');
  autoBtn.setAttribute('aria-pressed', 'false'); skipBtn.setAttribute('aria-pressed', 'false');
  function syncSound() {
    soundBtn.setAttribute('aria-pressed', String(soundOn()));
    var use = soundBtn.querySelector('use');
    if (use) use.setAttribute('href', '/static/icons.svg#' + (soundOn() ? 'i-sound-on' : 'i-sound-off'));
  }
  syncSound();
  var logPanel = el('div', 'qs-log', dlg);
  var logHead = el('div', 'qs-log-head', logPanel);
  el('h3', '', logHead).textContent = UI.backlog;
  var logClose = el('button', 'qs-btn', logHead); logClose.type = 'button'; logClose.textContent = UI.close;
  var logList = el('ol', 'qs-log-list', logPanel);
  var endWrap = el('div', 'qs-end-wrap', dlg);
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
  var fast = function () { return skip || ctrlSkip; };

  function setBg(name, fx) {
    var src = ART + '/bg/' + name + '.webp';
    if (bgFront.getAttribute('src') === src && bgFront.classList.contains('is-on')) return 0;
    var back = bgFront === bgA ? bgB : bgA;
    back.classList.remove('is-on', 'is-slow', 'is-cut', 'is-fade', 'is-drift');
    back.setAttribute('src', src);
    void back.offsetWidth;
    var mode = fast() ? 'cut' : (fx || 'fade');
    back.classList.add(mode === 'cut' ? 'is-cut' : mode === 'slow' ? 'is-slow' : 'is-fade');
    back.classList.add('is-on', 'is-drift');
    // The old picture leaves the same way the new one arrives, so a crossfade never flashes the black behind.
    var old = bgFront;
    old.classList.remove('is-slow', 'is-cut', 'is-fade');
    old.classList.add(mode === 'cut' ? 'is-cut' : mode === 'slow' ? 'is-slow' : 'is-fade', 'is-leaving');
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
  function show(id, pose, at) {
    var src = castArt(id, pose);
    if (!src) return 0;
    var s = onStage[id];
    if (s) {
      if (at && at !== s.at) { s.wrap.setAttribute('data-at', at); s.at = at; facing(s.img, id, at); }
      if (src !== s.img.getAttribute('src')) {
        s.img.setAttribute('src', src);
        s.img.classList.remove('is-pop'); void s.img.offsetWidth; s.img.classList.add('is-pop');
      }
      return 0;
    }
    var wrap = el('div', 'qs-actor', castLayer);
    var img = el('img', 'qs-sprite', wrap);
    img.alt = ''; img.src = src;
    at = at || 'center';
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
    cgImg.src = ART + '/bg/' + name + '.webp';
    cgWrap.classList.remove('is-on'); void cgWrap.offsetWidth; cgWrap.classList.add('is-on');
    return fast() ? 0 : 800;
  }
  function setTint(t) { tint.className = 'qs-tint' + (t ? ' is-' + t : ''); }
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
  function shock(kind) {
    if (fast()) return 0;
    var big = kind === 'big';
    sfx(big ? 'sting' : 'thud');
    Music.duck(true); window.setTimeout(function () { Music.duck(false); }, big ? 1600 : 700);
    flash.className = 'qs-flash ' + (big ? 'is-white' : 'is-dark'); void flash.offsetWidth; flash.classList.add('is-on');
    if (!reduce) {
      scene.classList.remove('is-shake', 'is-shake-big', 'is-punch'); void scene.offsetWidth;
      scene.classList.add(big ? 'is-shake-big' : 'is-shake');
      if (big) scene.classList.add('is-punch');
      dlg.classList.remove('is-pulse'); void dlg.offsetWidth; dlg.classList.add('is-pulse');
    }
    return big ? 650 : 300;
  }

  // The typed line: laid out hidden first (no reflow), letters revealed one by one; a click finishes it.
  function type(target, text, pitch, soft) {
    target.textContent = '';
    var sr = el('span', 'sr-only', target); sr.textContent = text;
    var shown = el('span', '', target); shown.setAttribute('aria-hidden', 'true');
    var chars = [];
    text.split(/(\s+)/).forEach(function (part) {
      if (!part) return;
      if (/^\s+$/.test(part)) { shown.appendChild(document.createTextNode(part)); return; }
      var w = el('span', 'tw-word', shown);
      Array.prototype.forEach.call(part, function (ch) { var c = el('span', 'tw-ch', w); c.textContent = ch; chars.push(c); });
    });
    var i = 0, timer = 0, done = false, resolve;
    var p = new Promise(function (r) { resolve = r; });
    target.classList.add('is-typing');
    var speed = soft ? 34 : 22;
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
      if (pitch && i % 3 === 1 && /\w/.test(c.textContent)) voice(pitch, soft);
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
    el('span', '', li).textContent = text;
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
      // A portrait in the middle keeps its face: the narrator steps down to the foot of the screen.
      narrBox.classList.toggle('is-low', Object.keys(onStage).some(function (k) { return onStage[k].at === 'center'; }));
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
    nameRole.hidden = !nameRole.textContent;
    box.setAttribute('data-who', kind === 'you' ? '@you' : who);
    box.classList.toggle('has-face', kind === 'you');
    box.classList.toggle('is-shout', opts.style === 'shout');
    box.classList.toggle('is-whisper', opts.style === 'whisper');
    // The name plate sits on the speaker's side of the stage.
    var side = kind === 'you' ? 'left' : (onStage[who] && onStage[who].at) || opts.at || 'left';
    box.setAttribute('data-side', side === 'right' ? 'right' : 'left');
    if (kind === 'you') face.src = boot.player.face;
    if (kind === 'say' && m && m.art) { await sleep(show(who, opts.pose, opts.at || (onStage[who] && onStage[who].at) || 'center')); }
    focusSpeaker(kind === 'say' && onStage[who] ? who : null);
    if (opts.react) react(who, opts.react);
    if (opts.style === 'shout' && !reduce && !fast()) { box.classList.remove('is-jolt'); void box.offsetWidth; box.classList.add('is-jolt'); }
    box.classList.add('is-on');
    if (!wasOn || !sameSpeaker) { box.classList.remove('is-new'); void box.offsetWidth; box.classList.add('is-new'); }
    log(name, text);
    var pitch = kind === 'you' ? 480 : (m && m.voice) || 420;
    await type(boxText, text, pitch, opts.style === 'whisper');
    await waitAdvance(text.length);
  }

  var GLYPHS = {
    envelope: '<svg viewBox="0 0 120 90" aria-hidden="true"><rect x="6" y="14" width="108" height="66" rx="4" class="g-dark"/><path d="M6 18 60 54 114 18" class="g-line"/><circle cx="60" cy="52" r="13" class="g-wax"/><path d="M53 50q7 7 14 0" class="g-wax-line"/><circle cx="55" cy="47" r="1.6" class="g-wax-line"/><circle cx="65" cy="47" r="1.6" class="g-wax-line"/></svg>',
    crystal: '<svg viewBox="0 0 120 120" aria-hidden="true"><path d="M60 8 92 44 60 112 28 44Z" class="g-crystal"/><path d="M28 44h64M60 8 48 44l12 68 12-68Z" class="g-line"/><circle cx="60" cy="54" r="6" class="g-glow"/></svg>',
    note: '<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M12 12h96l-4 66H16Z" class="g-paper"/><path d="M24 34h70M24 48h56M24 62h40" class="g-ink"/><path d="M96 18l6 10-10 2Z" class="g-ink"/></svg>',
  };
  async function card(step) {
    clearText(null);
    focusSpeaker(null);
    overlay.innerHTML = '';
    var c;
    if (step.item) {
      c = el('div', 'qs-item', overlay);
      el('span', 'qs-item-rays', c).setAttribute('aria-hidden', 'true');
      el('div', 'qs-item-glyph', c).innerHTML = GLYPHS[step.item.glyph] || '';
      el('p', 'qs-item-kicker', c).textContent = UI.found;
      el('h3', 'qs-item-title', c).textContent = step.item.title;
      var p = el('p', 'qs-item-text' + (step.item.hand ? ' is-hand' : ''), c);
      // A handwritten address breaks only after its slashes, never inside a word.
      p.textContent = step.item.hand ? fill(step.item.text).split('/').join('/​') : fill(step.item.text);
      log(step.item.title, fill(step.item.text));
      sfx('spot');
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

  async function exec(step) {
    if (!run || !run.alive) return;
    // A line already read does not linger over a change of scene: a new backdrop, black, a picture or a title clear
    // the text; a portrait stepping on or off clears only the narrator.
    if ('bg' in step || 'black' in step || ('cg' in step && step.cg) || 'title' in step) clearText(null);
    else if ('show' in step || 'hide' in step) clearText('box');
    if ('bg' in step) { await sleep(setBg(step.bg, step.fx)); return; }
    if ('music' in step) { Music.play(step.music, fast() ? 150 : (step.fade || 1400)); return; }
    if ('amb' in step) { Amb.set(step.amb); return; }
    if ('particles' in step) { Particles.set(step.particles); return; }
    if ('tint' in step) { setTint(step.tint); return; }
    if ('cam' in step) { setCam(step.cam); return; }
    if ('letterbox' in step) { setBars(step.letterbox); await sleep(fast() ? 0 : 500); return; }
    if ('place' in step) { if (!fast()) showPlace(step.place, step.time); return; }
    if ('sfx' in step) { if (!fast()) sfx(step.sfx); return; }
    if ('shock' in step) { await sleep(shock(step.shock)); return; }
    if ('black' in step) { if (step.black) clearText(null); await sleep(setBlack(step.black)); return; }
    if ('narr' in step) { await line('narr', null, step.narr); return; }
    if ('say' in step) { await line('say', step.say, step.text, step); return; }
    if ('you' in step) { await line('you', null, step.you); return; }
    if ('show' in step) { await sleep(show(step.show, step.pose, step.at)); return; }
    if ('hide' in step) { await sleep(hide(step.hide)); return; }
    if ('cg' in step) { if (step.cg) clearText(null); await sleep(setCg(step.cg)); return; }
    if ('item' in step || 'letter' in step || 'accept' in step) { await card(step); return; }
    if ('title' in step) { await titleShow(step); return; }
    if ('choice' in step) {
      var i = await pick(step.choice.map(function (c) { return { label: c.label }; }));
      log('', '› ' + step.choice[i].label);
      await steps(step.choice[i].then, false);
      return;
    }
    if ('explore' in step) {
      var ex = step.explore;
      var seen = ex.spots.map(function () { return false; });
      var onPicture = ex.spots.every(function (s) { return s.at; });
      while (run && run.alive && seen.indexOf(false) >= 0) {
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
        await steps(ex.spots[k].then, false);
        seen[k] = true;
      }
      bgFront.classList.remove('is-still');
      return;
    }
    if ('shake' in step) { if (!reduce && !fast()) { scene.classList.remove('is-shake'); void scene.offsetWidth; scene.classList.add('is-shake'); } return; }
    if ('flash' in step) { flash.className = 'qs-flash is-' + step.flash; void flash.offsetWidth; flash.classList.add('is-on'); await sleep(fast() ? 0 : 250); return; }
    if ('wait' in step) { await sleep(fast() ? 0 : step.wait); return; }
  }

  async function steps(list, top, from) {
    for (var i = from || 0; i < list.length; i++) {
      if (!run || !run.alive) return;
      if (top) store(placeKey(run.n), i);
      await exec(list[i]);
    }
  }

  // Resuming mid-chapter: replay the state-only steps up to the saved place, instantly.
  function restore(list, upto) {
    var st = { bg: null, cg: null, black: true, music: null, amb: null, particles: null, tint: null, cam: null, bars: false };
    var cast = {};
    for (var i = 0; i < upto; i++) {
      var s = list[i];
      ['bg', 'cg', 'black', 'music', 'amb', 'particles', 'tint', 'cam'].forEach(function (k) { if (k in s) st[k] = s[k]; });
      if ('letterbox' in s) st.bars = s.letterbox;
      if ('show' in s) cast[s.show] = { pose: s.pose, at: s.at };
      if ('hide' in s) { if (s.hide === 'all') cast = {}; else delete cast[s.hide]; }
      if ('say' in s && cast[s.say] && s.pose) cast[s.say].pose = s.pose;
    }
    skip = true;
    if (st.bg) setBg(st.bg, 'cut');
    if (st.cg) setCg(st.cg);
    Object.keys(cast).forEach(function (id) { show(id, cast[id].pose, cast[id].at); });
    setBlack(st.black); setTint(st.tint); setCam(st.cam); setBars(st.bars);
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
      if (/\{host\}/.test(c.brief)) el('p', 'qs-case-note', f).textContent = UI.archive_hint;
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
    var seen = {};
    (function walk(list) {
      (list || []).forEach(function (s) {
        if (s.bg && !seen[s.bg]) { seen[s.bg] = 1; new Image().src = ART + '/bg/' + s.bg + '.webp'; }
        if (s.cg && !seen[s.cg]) { seen[s.cg] = 1; new Image().src = ART + '/bg/' + s.cg + '.webp'; }
        if (s.show) { var a = castArt(s.show, s.pose); if (a && !seen[a]) { seen[a] = 1; new Image().src = a; } }
        if (s.music) Music.preload(s.music);
        if (s.choice) s.choice.forEach(function (c) { walk(c.then); });
        if (s.explore) s.explore.spots.forEach(function (c) { walk(c.then); });
      });
    })(ch.pre);
  }

  function resetStage() {
    clearText(null);
    hide('all');
    setCg(null); setTint(null); setCam(null); setBars(false);
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
    run = me;
    preloadChapter(ch);
    resetStage();
    var saved = fresh || ch.done ? 0 : Number(load(placeKey(n)) || 0);
    if (saved > 0 && saved < ch.pre.length) restore(ch.pre, saved); else saved = 0;
    await steps(ch.pre, true, saved);
    if (run !== me || !me.alive) return;
    if (ch.challenge) {
      var post = await caseFile(ch);
      if (run !== me || !me.alive) return;
      await steps(post, false);
    } else if (!ch.done) {
      await fetch('/quests/' + QID + '/chapter/' + n, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ _csrf: boot.csrf }),
      }).catch(function () {});
      markDone(n);
    }
    store(placeKey(n), null);
    if (run !== me || !me.alive) return;
    clearText(null); hide('all');
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
    play(n, fresh).catch(function () { leave(); });
  }
  function leave() {
    if (run) run.alive = false;
    run = null;
    if (waiter) waiter();
    if (typing) typing.finish();
    Music.stop(500); Amb.stop(500); Particles.stop();
    auto = false; skip = false; ctrlSkip = false;
    autoBtn.setAttribute('aria-pressed', 'false'); skipBtn.setAttribute('aria-pressed', 'false');
    logPanel.classList.remove('is-on');
    if (dlg.open) dlg.close();
    document.documentElement.classList.remove('qs-open');
    if (changed) window.location.reload();
  }

  // ---- input -----------------------------------------------------------------------------------------------------
  dlg.addEventListener('click', function (e) {
    if (e.target.closest('.qs-bar, .qs-choices, .qs-spots, .qs-case-wrap, .qs-end-wrap, .qs-log, a, button, input')) return;
    advance();
  });
  dlg.addEventListener('cancel', function (e) {
    e.preventDefault();
    if (logPanel.classList.contains('is-on')) { logPanel.classList.remove('is-on'); return; }
    if (window.confirm(UI.confirm_close)) leave();
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
    var control = e.target.closest && e.target.closest('.qs-choices.is-on, .qs-spots.is-on, .qs-case-wrap.is-on, .qs-end-wrap.is-on, .qs-log.is-on') && e.target.matches('button, a');
    if ((e.key === ' ' || e.key === 'Enter') && !control) { e.preventDefault(); advance(); }
    else if (e.key === 'a' || e.key === 'A') autoBtn.click();
    else if (e.key === 'l' || e.key === 'L') logBtn.click();
    else if (e.key === 'm' || e.key === 'M') soundBtn.click();
  });
  dlg.addEventListener('keyup', function (e) { if (e.key === 'Control') ctrlSkip = false; });
  window.addEventListener('blur', function () { ctrlSkip = false; });
  autoBtn.addEventListener('click', function () {
    auto = !auto; autoBtn.setAttribute('aria-pressed', String(auto));
    if (auto && !typing && waiter) waiter();
    dlg.focus({ preventScroll: true });
  });
  skipBtn.addEventListener('click', function () {
    skip = !skip; skipBtn.setAttribute('aria-pressed', String(skip));
    if (skip) { if (typing) typing.finish(); if (waiter) waiter(); }
    dlg.focus({ preventScroll: true });
  });
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
  closeBtn.addEventListener('click', function () { if (window.confirm(UI.confirm_close)) leave(); });

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
