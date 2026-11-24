// src/public/ui.js — optional enhancements of the platform shell. Every page works without it: menus are
// <details>, the theme and language toggles are links, forms post normally. Loaded with defer from the layout
// (a file, so it runs under a lab's script-src 'self'); it never touches a lab's own markup.
(function () {
  'use strict';

  // Menus (<details class="menu">): close on Escape and on a click outside, as a menu should.
  function openMenus() { return document.querySelectorAll('details.menu[open]'); }
  document.addEventListener('click', function (e) {
    openMenus().forEach(function (m) { if (!m.contains(e.target)) m.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    openMenus().forEach(function (m) {
      m.removeAttribute('open');
      var s = m.querySelector('summary');
      if (s) s.focus();
    });
  });

  // Password strength hint (/account/password): a rough length-and-variety estimate, shown as text, never sent.
  function strength(v) {
    var kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter(function (r) { return r.test(v); }).length;
    if (v.length >= 16 || (v.length >= 12 && kinds >= 3)) return 'strong';
    if (v.length >= 10 || (v.length >= 8 && kinds >= 3)) return 'fair';
    return 'weak';
  }
  document.querySelectorAll('input[data-strength]').forEach(function (input) {
    var out = document.getElementById(input.getAttribute('data-strength'));
    if (!out) return;
    var value = out.querySelector('[data-strength-value]');
    function update() {
      if (input.value === '') { out.hidden = true; return; }
      var s = strength(input.value);
      out.hidden = false;
      out.setAttribute('data-level', s);
      if (value) value.textContent = out.getAttribute('data-label-' + s) || s;
    }
    input.addEventListener('input', update);
    update();
  });

  // Sound: the guild's music (static/audio, "Adventures Begin" by Pufino) and effects synthesized with Web Audio (no
  // files), themed to the guild: wood knocks, paper, brass, coins, wax, creaking signs and doors. One masthead toggle
  // switches all of it and the choice is remembered in this browser. The music keeps one timeline across pages and
  // tabs: its position is saved with a time stamp and a new page resumes where the music is now; a page reached by a
  // click may play at once (Chrome), otherwise the next click or key press starts it, and every refused attempt is
  // retried. Only the tab in front plays: a tab that starts the music quiets the others.
  var sound = (function () {
    var KEY = 'hvwa-sound';
    var POS = 'hvwa-music-pos';
    var MUSIC_URL = '/static/audio/adventures-begin.mp3';
    // A page that scores itself (a story quest: [data-own-music]) keeps the guild's music quiet and plays its own.
    var OWN_MUSIC = !!document.querySelector('[data-own-music]');
    var listeners = [];
    var MUSIC_VOLUME = 0.28;
    function get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
    function put(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* storage blocked or full */ } }
    var on = get(KEY) !== 'off'; // sound defaults on; the toggle stores 'off'
    var channel = null;
    try { channel = new BroadcastChannel('hvwa-music'); } catch (e) { /* no channel: each tab plays on its own */ }
    var ctx = null;
    var master = null;
    var noise = null;
    var music = null;
    var fade = 0;
    var lastSave = 0;
    var SFX_GAIN = 3.2;

    function audio() {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      if (!ctx) {
        ctx = new C();
        // Effects are loud enough to hear over the music on laptop speakers; a compressor keeps the peaks clean.
        var limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -10;
        limiter.knee.value = 6;
        limiter.ratio.value = 8;
        limiter.connect(ctx.destination);
        master = ctx.createGain();
        master.gain.value = 1;
        master.connect(limiter);
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        var d = noise.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') { var r = ctx.resume(); if (r && r.catch) r.catch(function () { /* not allowed yet */ }); }
      return ctx;
    }
    function env(c, at, peak, attack, decay) {
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(Math.min(0.95, peak * SFX_GAIN), at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
      g.connect(master);
      return g;
    }
    function tone(c, freq, at, peak, decay, type, glideTo) {
      var o = c.createOscillator();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, at);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + decay);
      o.connect(env(c, at, peak, 0.005, decay));
      o.start(at);
      o.stop(at + decay + 0.05);
    }
    function hiss(c, at, peak, decay, from, to, q) {
      var s = c.createBufferSource();
      s.buffer = noise;
      var f = c.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q || 1.2;
      f.frequency.setValueAtTime(from, at);
      if (to) f.frequency.exponentialRampToValueAtTime(to, at + decay);
      s.connect(f);
      f.connect(env(c, at, peak, 0.01, decay));
      s.start(at, Math.random() * 0.5);
      s.stop(at + decay + 0.05);
    }
    var SFX = {
      tick: function (c, t) { hiss(c, t, 0.03, 0.02, 4200, 0, 4); },
      click: function (c, t) { tone(c, 420, t, 0.2, 0.09, 'triangle', 220); tone(c, 190, t, 0.16, 0.08, 'triangle', 120); hiss(c, t, 0.16, 0.06, 2400, 0, 2.5); },
      page: function (c, t) { hiss(c, t, 0.08, 0.07, 1800, 4200, 1.2); hiss(c, t + 0.06, 0.06, 0.06, 2600, 5200, 1.2); },
      open: function (c, t) { hiss(c, t, 0.09, 0.16, 2600, 4200, 0.9); tone(c, 330, t, 0.05, 0.08, 'triangle'); },
      close: function (c, t) { hiss(c, t, 0.07, 0.09, 3800, 2000, 1); },
      scroll: function (c, t) { hiss(c, t, 0.08, 0.3, 700, 2600, 0.9); tone(c, 220, t + 0.26, 0.06, 0.08, 'triangle'); },
      paper: function (c, t) { tone(c, 2400, t, 0.04, 0.05); hiss(c, t + 0.02, 0.11, 0.12, 1200, 3000, 0.8); },
      clink: function (c, t) { tone(c, 1318, t, 0.09, 0.35); tone(c, 1976, t, 0.05, 0.25); tone(c, 2637, t + 0.01, 0.03, 0.15); hiss(c, t, 0.05, 0.03, 6000, 0, 3); },
      creak: function (c, t) { tone(c, 120, t, 0.05, 0.32, 'sawtooth', 82); tone(c, 170, t + 0.3, 0.16, 0.08, 'triangle', 110); },
      candle: function (c, t) { hiss(c, t, 0.12, 0.26, 380, 1200, 0.6); tone(c, 90, t, 0.1, 0.2); },
      chime: function (c, t) { tone(c, 1046, t, 0.06, 0.5); tone(c, 1568, t + 0.05, 0.04, 0.6); },
      fanfare: function (c, t) { [392, 523, 659, 784].forEach(function (f, i) { tone(c, f, t + i * 0.11, 0.07, 0.28, 'triangle'); }); },
      quill: function (c, t) { hiss(c, t, 0.045, 0.05, 3000 + Math.random() * 2000, 0, 3); },
      unroll: function (c, t) { hiss(c, t, 0.09, 0.7, 600, 2400, 0.8); tone(c, 110, t + 0.65, 0.12, 0.15, 'triangle'); },
      gate: function (c, t) { tone(c, 85, t, 0.07, 0.9, 'sawtooth', 58); hiss(c, t, 0.05, 0.9, 300, 600, 2); tone(c, 60, t + 1, 0.25, 0.3); SFX.chime(c, t + 0.4); },
      slide: function (c, t) { hiss(c, t, 0.14, 0.32, 380, 1500, 0.8); tone(c, 150, t + 0.26, 0.18, 0.12, 'triangle', 95); },
      seal: function (c, t) { tone(c, 95, t, 0.32, 0.22, 'sine', 55); hiss(c, t, 0.14, 0.08, 900, 0, 1); tone(c, 880, t + 0.12, 0.09, 0.9); tone(c, 1320, t + 0.12, 0.05, 0.7); },
      coin: function (c, t) { tone(c, 1568, t, 0.08, 0.18); tone(c, 2093, t + 0.08, 0.07, 0.3); },
      blip: function (c, t) { tone(c, 620 + Math.random() * 160, t, 0.035, 0.045, 'triangle'); },
      pop: function (c, t) { tone(c, 520, t, 0.06, 0.07, 'sine', 880); hiss(c, t, 0.03, 0.04, 3200, 0, 3); },
      error: function (c, t) { tone(c, 233, t, 0.12, 0.16, 'triangle'); tone(c, 175, t + 0.14, 0.12, 0.22, 'triangle'); },
    };
    function play(name) {
      if (!on || !SFX[name]) return;
      var c = audio();
      if (c) SFX[name](c, c.currentTime + 0.01);
    }
    // A page-load cue (the gate opening, the letter unrolling) plays only where the browser already allows sound.
    function cue(name, delayMs) {
      if (!on) return;
      var c = audio();
      if (c) window.setTimeout(function () { if (c.state === 'running') play(name); }, delayMs);
    }

    // The music: one timeline, saved as { t: seconds, at: epoch ms } and resumed where it would be now.
    function savePos() {
      if (music && !music.paused) put(POS, JSON.stringify({ t: music.currentTime, at: Date.now() }));
    }
    function resumeTime() {
      var p = null;
      try { p = JSON.parse(get(POS) || 'null'); } catch (e) { p = null; }
      if (!p || typeof p.t !== 'number' || typeof p.at !== 'number') return 0;
      var gap = (Date.now() - p.at) / 1000;
      var t = p.t + (gap > 0 && gap < 60 ? gap : 0);
      return music && music.duration > 0 ? t % music.duration : t;
    }
    function setVolume(target, ms) {
      window.clearInterval(fade);
      var step = (target - music.volume) / Math.max(1, ms / 40);
      fade = window.setInterval(function () {
        var v = music.volume + step;
        if ((step >= 0 && v >= target) || (step < 0 && v <= target)) { v = target; window.clearInterval(fade); if (v === 0) music.pause(); }
        music.volume = Math.min(1, Math.max(0, v));
      }, 40);
    }
    function onGesture() { if (on && (!music || music.paused)) startMusic(400); }
    function armGesture(yes) {
      ['pointerdown', 'keydown'].forEach(function (type) {
        if (yes) document.addEventListener(type, onGesture, true); else document.removeEventListener(type, onGesture, true);
      });
    }
    function startMusic(fadeMs) {
      if (!on || document.hidden || OWN_MUSIC) return;
      if (!music) {
        music = new Audio(MUSIC_URL);
        music.loop = true;
        music.preload = 'auto';
        music.volume = 0;
        music.addEventListener('loadedmetadata', function () { try { music.currentTime = resumeTime(); } catch (e) { /* not seekable yet */ } });
        music.addEventListener('timeupdate', function () { var n = Date.now(); if (n - lastSave > 1000) { lastSave = n; savePos(); } });
      } else if (music.paused && music.readyState > 0) {
        try { music.currentTime = resumeTime(); } catch (e) { /* not seekable yet */ }
      }
      var p = music.play();
      if (p && p.then) {
        p.then(function () {
          armGesture(false);
          if (channel) channel.postMessage('playing');
          setVolume(MUSIC_VOLUME, fadeMs);
        }, function () { armGesture(true); }); // refused (no gesture yet): the next click or key press retries
      } else setVolume(MUSIC_VOLUME, fadeMs);
    }
    function stopMusic(ms) { if (music && !music.paused) { savePos(); setVolume(0, ms); } }
    function setOn(value, tell) {
      on = value;
      put(KEY, on ? 'on' : 'off');
      document.querySelectorAll('[data-sound-toggle]').forEach(function (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
      if (tell && channel) channel.postMessage(on ? 'on' : 'off');
      listeners.forEach(function (fn) { try { fn(on); } catch (e) { /* a listener's own bug */ } });
    }
    if (channel) {
      channel.onmessage = function (e) {
        if (e.data === 'playing') stopMusic(250); // another tab took the music over
        else if (e.data === 'off') { setOn(false, false); stopMusic(250); }
        else if (e.data === 'on') setOn(true, false);
      };
    }
    window.addEventListener('pagehide', savePos);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && on && (!music || music.paused)) startMusic(500); });
    armGesture(true);
    if (on) startMusic(500);

    document.querySelectorAll('[data-sound-toggle]').forEach(function (btn) {
      btn.hidden = false;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.addEventListener('click', function () {
        setOn(!on, true);
        if (on) { startMusic(400); play('coin'); } else stopMusic(300);
      });
    });

    // Every interaction has its sound. Clicks: paper for navigation and bounties, brass for the main action, a creak for
    // leaving, a candle for the theme, a wooden knock for the rest; board links play their slide from the carousel.
    var SKIP = '[data-board-link], [data-board-prev], [data-board-next], [data-sound-toggle], summary, .pick-button, [data-dialogue-next], [data-mira-poke], [data-tour-next], [data-tour-back], [data-tour-skip], [data-tour-start], [data-rank-open], [data-ladder-close]';
    function clickSound(el) {
      if (el.matches('.nav-link, .lang-switch a, .crumbs a, .tabs a, .admin-nav a, .letter-foot a, .board-step')) return 'page';
      if (el.matches('.poster, .lab-card, .continue-slip, .tier-card-link, .my-lab')) return 'paper';
      if (el.matches('.btn-primary, .seal-btn, .btn-office')) return 'clink';
      if (el.matches('.theme-toggle')) return 'candle';
      if (el.matches('.menu-item-danger, .btn-danger')) return 'creak';
      return 'click';
    }
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('a, button, summary, select, input[type="submit"], input[type="checkbox"], input[type="radio"]') : null;
      if (!el || el.matches(SKIP)) return;
      play(clickSound(el));
    }, true);
    // Menus and accordions: paper opening (a whisper unrolls), paper folding shut.
    document.addEventListener('toggle', function (e) {
      var d = e.target;
      if (!d || d.tagName !== 'DETAILS') return;
      play(d.open ? (d.classList.contains('accordion') ? 'scroll' : 'open') : 'close');
    }, true);
    // Writing: the quill scratches while any text field is typed in.
    var lastScratch = 0;
    document.addEventListener('input', function (e) {
      if (!e.target.matches || !e.target.matches('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea')) return;
      var n = Date.now();
      if (n - lastScratch > 70) { lastScratch = n; play('quill'); }
    }, true);
    document.addEventListener('change', function (e) { if (e.target.matches && e.target.matches('select')) play('page'); }, true);
    // Hovering what can be pressed: a soft tick, once per element (mouse only).
    var HOVER = '.btn, .nav-link, .board-sign, .poster, .tier-card-link, .seal-btn, .menu-item, .icon-btn, .board-nav, .continue-slip, .admin-nav a, .tabs a, summary';
    var hovered = null;
    document.addEventListener('pointerover', function (e) {
      if (e.pointerType !== 'mouse') return;
      var el = e.target.closest ? e.target.closest(HOVER) : null;
      if (el === hovered) return;
      hovered = el;
      if (el) play('tick');
    }, true);
    if (document.querySelector('.welcome-gate')) cue('gate', 950);
    if (document.querySelector('[data-letter]')) cue('unroll', document.documentElement.classList.contains('splash-done') ? 450 : 1750);
    // The quest stage (static/quest.js) borrows the effects, the switch and the mixer: its own sounds go through the
    // same limiter, and the masthead toggle silences them too.
    window.hvwaSound = {
      play: play, isOn: function () { return on; }, onChange: function (fn) { listeners.push(fn); },
      set: function (value) { setOn(!!value, true); },
      context: audio, output: function () { audio(); return master; }, tone: tone, hiss: hiss,
    };
    return { play: play };
  })();

  // Toasts (stamped slips). Built from the data-toast-* attributes the server puts on an ACTION-swap fragment; polls
  // never carry them, so polling never spams a toast. Progressive enhancement: the inline .result stays for no-JS.
  var TOAST_GLYPH = { success: '✓', error: '!', info: 'i', warning: '🎣' };
  function dismissToast(node) {
    node.classList.add('is-leaving');
    window.setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 200);
  }
  function showToast(opts) {
    var container = document.getElementById('toasts');
    if (!container) return;
    while (container.children.length >= 3) container.removeChild(container.firstChild);
    var node = document.createElement('div');
    node.className = 'toast toast-' + (opts.variant || 'info');
    node.setAttribute('role', 'status');
    var seal = document.createElement('span');
    seal.className = 'toast-seal';
    seal.setAttribute('aria-hidden', 'true');
    seal.textContent = TOAST_GLYPH[opts.variant] || 'i';
    var body = document.createElement('div');
    body.className = 'toast-body';
    var title = document.createElement('p');
    title.className = 'toast-title';
    title.textContent = opts.title || '';
    body.appendChild(title);
    if (opts.message) {
      var msg = document.createElement('p');
      msg.className = 'toast-message';
      msg.textContent = opts.message;
      body.appendChild(msg);
    }
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', container.getAttribute('data-dismiss') || 'Dismiss');
    close.textContent = '×';
    node.appendChild(seal);
    node.appendChild(body);
    node.appendChild(close);
    var timer;
    var arm = function () { timer = window.setTimeout(function () { dismissToast(node); }, 5000); };
    var disarm = function () { window.clearTimeout(timer); };
    close.addEventListener('click', function () { disarm(); dismissToast(node); });
    node.addEventListener('mouseenter', disarm);
    node.addEventListener('mouseleave', arm);
    node.addEventListener('focusin', disarm);
    node.addEventListener('focusout', arm);
    container.appendChild(node);
    arm();
  }

  // The submit-result popup (solve-dialog): built from the data-modal-* attributes the server puts on the submit-result
  // fragment. Only the submit fragment carries them, so a poll or a panel swap never opens it. The inline .result stays
  // for no-JS; the popup is pure enhancement.
  var solveDialog = (function () {
    var dialog = document.getElementById('solve-dialog');
    var lastTrigger = null;
    var MODAL_ATTRS = ['data-modal', 'data-modal-title', 'data-modal-message', 'data-modal-points', 'data-modal-fact'];
    function setText(id, value) {
      var node = document.getElementById(id);
      if (node) node.textContent = value;
    }
    function open(carrier) {
      if (!dialog || typeof dialog.showModal !== 'function') {
        MODAL_ATTRS.forEach(function (a) { carrier.removeAttribute(a); });
        return;
      }
      var variant = carrier.getAttribute('data-modal') || '';
      setText('solve-title', carrier.getAttribute('data-modal-title') || '');
      setText('solve-message', carrier.getAttribute('data-modal-message') || '');
      var points = carrier.getAttribute('data-modal-points') || '';
      var pointsEl = dialog.querySelector('.solve-points');
      if (pointsEl) {
        var figure = pointsEl.querySelector('.solve-points-figure');
        if (figure) figure.textContent = points;
        pointsEl.hidden = points === '';
      }
      var fact = carrier.getAttribute('data-modal-fact') || '';
      var factEl = dialog.querySelector('.solve-fact');
      if (factEl) {
        var factText = factEl.querySelector('.solve-fact-text');
        if (factText) factText.textContent = fact;
        factEl.hidden = fact === '';
      }
      // Drop the payload so a later swap never re-opens it, and so the toast pass below skips this slip.
      MODAL_ATTRS.forEach(function (a) { carrier.removeAttribute(a); });
      ['data-toast', 'data-toast-variant', 'data-toast-title', 'data-toast-message'].forEach(function (a) { carrier.removeAttribute(a); });
      dialog.setAttribute('data-variant', variant);
      if (!dialog.open) dialog.showModal();
      if (variant === 'solved') { sound.play('seal'); window.setTimeout(function () { sound.play('coin'); }, 380); }
      else if (variant === 'wrong' || variant === 'decoy') sound.play('error');
      else sound.play('coin');
      var closeBtn = dialog.querySelector('.solve-continue');
      if (closeBtn) { try { closeBtn.focus(); } catch (e) { /* not focusable */ } }
      lastTrigger = document.getElementById('flag-submit');
    }
    function close() {
      if (dialog && dialog.open) dialog.close();
    }
    if (dialog) {
      var closeBtn = dialog.querySelector('.solve-continue');
      if (closeBtn) closeBtn.addEventListener('click', close);
      dialog.addEventListener('click', function (e) { if (e.target === dialog) close(); });
      dialog.addEventListener('close', function () {
        if (lastTrigger && lastTrigger.focus) { try { lastTrigger.focus(); } catch (e) { /* not focusable */ } }
      });
    }
    return { open: open };
  })();

  // After an ACTION swap (not a poll), move focus to the swapped panel so keyboard and screen-reader users land on the
  // new state, and show any toast the fragment carries. The server marks those responses data-focus-after-swap;
  // poll responses never carry it, and never carry data-toast either. A submit-result fragment opens the popup instead.
  document.addEventListener('htmx:afterSwap', function () {
    var el = document.querySelector('[data-focus-after-swap]');
    var modalCarrier = document.querySelector('[data-modal]');
    if (modalCarrier) {
      // The popup owns focus now: don't move it to the fragment sitting behind the dialog.
      if (el) el.removeAttribute('data-focus-after-swap');
      solveDialog.open(modalCarrier);
    } else if (el) {
      el.removeAttribute('data-focus-after-swap');
      window.requestAnimationFrame(function () { try { el.focus(); } catch (e) { /* not focusable */ } });
    }
    document.querySelectorAll('[data-toast]').forEach(function (node) {
      // Action results the solve popup does not voice: a quest's fanfare, a closing creak, gold for a whisper, a failure.
      var cue = { launched: 'fanfare', stopped: 'creak', reset: 'page', unlocked: 'coin', full: 'error', failed: 'error' }[node.getAttribute('data-toast')];
      if (cue) sound.play(cue);
      showToast({
        variant: node.getAttribute('data-toast-variant') || 'info',
        title: node.getAttribute('data-toast-title') || '',
        message: node.getAttribute('data-toast-message') || '',
      });
      ['data-toast', 'data-toast-variant', 'data-toast-title', 'data-toast-message'].forEach(function (a) {
        node.removeAttribute(a);
      });
    });
  });

  // Bounty boards (range catalog): a scroll-snap carousel of wooden boards. Without JS the hanging signs and the plank
  // links are anchors (#board-<track>) and the browser snaps to them. Here: slide horizontally only (never jump the
  // page), wrap around at the ends, keep the active sign and the URL hash in step, arrow keys, and one slide sound
  // when a move settles (also after a touch swipe).
  document.querySelectorAll('[data-boards]').forEach(function (root) {
    var track = root.querySelector('[data-boards-track]');
    if (!track || !track.children.length) return;
    var slides = Array.prototype.slice.call(track.children);
    var signs = Array.prototype.slice.call(root.querySelectorAll('.board-signs [data-board-link]'));
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var current = 0;
    var settled = 0;
    var settleTimer = 0;
    function step() { return slides.length > 1 ? slides[1].offsetLeft - slides[0].offsetLeft : track.clientWidth; }
    function indexAt() { return Math.max(0, Math.min(slides.length - 1, Math.round(track.scrollLeft / Math.max(1, step())))); }
    var strip = root.querySelector('.board-signs');
    function mark(i) {
      current = i;
      signs.forEach(function (s, k) { if (k === i) s.setAttribute('aria-current', 'true'); else s.removeAttribute('aria-current'); });
      // On a phone the signs are a swipeable strip: keep the active one in view.
      var sign = signs[i];
      if (strip && sign && strip.scrollWidth > strip.clientWidth) {
        strip.scrollTo({ left: sign.offsetLeft - (strip.clientWidth - sign.offsetWidth) / 2, behavior: reduce ? 'auto' : 'smooth' });
      }
    }
    function go(i) {
      var n = slides.length;
      i = ((i % n) + n) % n;
      track.scrollTo({ left: i * step(), behavior: reduce ? 'auto' : 'smooth' });
      mark(i);
      try { window.history.replaceState(null, '', '#' + slides[i].id); } catch (e) { /* no history */ }
    }
    root.addEventListener('click', function (e) {
      var link = e.target.closest ? e.target.closest('[data-board-link]') : null;
      if (!link || !root.contains(link)) return;
      e.preventDefault();
      go(parseInt(link.getAttribute('data-board-link'), 10) || 0);
    });
    var prev = root.querySelector('[data-board-prev]');
    var next = root.querySelector('[data-board-next]');
    [[prev, -1], [next, 1]].forEach(function (pair) {
      if (!pair[0]) return;
      pair[0].hidden = false;
      pair[0].addEventListener('click', function () { go(current + pair[1]); });
    });
    root.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      e.preventDefault();
      go(current + (e.key === 'ArrowRight' ? 1 : -1));
    });
    track.addEventListener('scroll', function () {
      var i = indexAt();
      if (i !== current) mark(i);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(function () {
        var s = indexAt();
        if (s !== settled) { settled = s; sound.play('slide'); }
      }, 140);
    }, { passive: true });
    window.addEventListener('resize', function () { track.scrollLeft = current * step(); });
    var start = slides.findIndex(function (s) { return '#' + s.id === window.location.hash; });
    if (start > 0) { track.scrollLeft = start * step(); settled = start; }
    mark(Math.max(0, start));
  });

  // The guild letter (login / register): the quill follows the field being written and wiggles while it writes, the
  // signature copies the name, and a submit presses the wax seal and rolls the letter up before the form posts (the
  // server answers the same either way; without JS, or with reduced motion, the form posts at once).
  document.querySelectorAll('[data-letter]').forEach(function (letter) {
    var quill = letter.querySelector('[data-quill]');
    var signature = letter.querySelector('[data-signature]');
    var source = letter.querySelector('[data-signature-source]');
    var form = letter.querySelector('form');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var writing = 0;
    function aim(field) {
      if (!quill) return;
      var y = field.getBoundingClientRect().top - letter.getBoundingClientRect().top + field.offsetHeight * 0.75;
      quill.style.setProperty('--quill-y', y + 'px');
    }
    letter.addEventListener('focusin', function (e) { if (e.target.matches('input:not([type="hidden"])')) aim(e.target); });
    letter.addEventListener('input', function (e) {
      if (quill) {
        quill.classList.add('is-writing');
        window.clearTimeout(writing);
        writing = window.setTimeout(function () { quill.classList.remove('is-writing'); }, 260);
      }
      if (signature && e.target === source) signature.textContent = source.value;
    });
    if (document.activeElement && letter.contains(document.activeElement)) aim(document.activeElement);
    if (form) {
      form.addEventListener('submit', function (e) {
        if (reduce || letter.classList.contains('is-sealing')) return;
        e.preventDefault();
        letter.classList.add('is-sealing');
        sound.play('seal');
        window.setTimeout(function () { form.submit(); }, 1000);
      });
    }
    // Back from the next page (bfcache): the letter is open again.
    window.addEventListener('pageshow', function (e) { if (e.persisted) letter.classList.remove('is-sealing'); });
  });

  // The guild's own confirm popup (#confirm-dialog in layout.ejs) replaces the browser's confirm(): htmx forms ask
  // through hx-confirm (the htmx:confirm event), plain forms through data-confirm. A form may name the popup's title,
  // button and look with data-confirm-title / data-confirm-ok / data-confirm-kind (e.g. "coin" for a paid whisper).
  var confirmDialog = (function () {
    var d = document.getElementById('confirm-dialog');
    if (!d || typeof d.showModal !== 'function') return null;
    var title = d.querySelector('.confirm-title');
    var msg = d.querySelector('.confirm-message');
    var ok = d.querySelector('[data-confirm-ok]');
    var cancel = d.querySelector('[data-confirm-cancel]');
    var pending = null;
    var back = null;
    function ask(opts, onYes) {
      title.textContent = opts.title || d.getAttribute('data-title') || '';
      msg.textContent = opts.message || '';
      ok.textContent = opts.ok || d.getAttribute('data-ok') || 'OK';
      d.setAttribute('data-kind', opts.kind || '');
      pending = onYes;
      back = document.activeElement;
      d.showModal();
      sound.play('scroll');
      cancel.focus();
    }
    ok.addEventListener('click', function () { var go = pending; pending = null; d.close(); if (go) go(); });
    cancel.addEventListener('click', function () { d.close(); });
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.addEventListener('close', function () {
      if (pending) sound.play('close');
      pending = null;
      if (back && back.focus) { try { back.focus(); } catch (e) { /* gone */ } }
    });
    return { ask: ask };
  })();
  function confirmOpts(el, message) {
    return { title: el.getAttribute('data-confirm-title'), message: message, ok: el.getAttribute('data-confirm-ok'), kind: el.getAttribute('data-confirm-kind') };
  }
  document.addEventListener('htmx:confirm', function (e) {
    if (!e.detail.question || !confirmDialog) return; // only requests with hx-confirm carry a question
    e.preventDefault();
    confirmDialog.ask(confirmOpts(e.detail.elt, e.detail.question), function () { e.detail.issueRequest(true); });
  });
  // A plain (non-htmx) form with data-confirm asks first; htmx forms already asked through hx-confirm.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-confirm') || f.hasAttribute('hx-post')) return;
    if (f.hasAttribute('data-confirmed')) { f.removeAttribute('data-confirmed'); return; }
    e.preventDefault();
    var go = function () { f.setAttribute('data-confirmed', ''); if (f.requestSubmit) f.requestSubmit(); else f.submit(); };
    if (confirmDialog) confirmDialog.ask(confirmOpts(f, f.getAttribute('data-confirm')), go);
    else if (window.confirm(f.getAttribute('data-confirm'))) go(); // shortcut: native confirm only where <dialog> is missing
  }, true);

  // Form checks in the guild's ink instead of the browser's bubbles: the message goes under the field, the first
  // invalid field takes focus, and the note clears once the adventurer types again.
  var lastInvalid = 0;
  document.addEventListener('invalid', function (e) {
    var el = e.target;
    if (!el.closest || el.closest('.lab')) return;
    e.preventDefault();
    var field = el.closest('.field') || el.parentNode;
    var note = field.querySelector('.ink-warning');
    if (!note) { note = document.createElement('p'); note.className = 'ink-warning'; note.setAttribute('role', 'alert'); field.appendChild(note); }
    note.textContent = el.validationMessage;
    el.setAttribute('aria-invalid', 'true');
    var now = Date.now();
    if (now - lastInvalid > 400) { try { el.focus(); } catch (err) { /* not focusable */ } sound.play('error'); }
    lastInvalid = now;
    el.addEventListener('input', function clear() {
      if (note.parentNode) note.parentNode.removeChild(note);
      el.removeAttribute('aria-invalid');
      el.removeEventListener('input', clear);
    });
  }, true);

  // Guild dropdowns: every single <select> outside a lab becomes a button and a listbox in the guild's style. The
  // native select stays in the form (hidden) and receives every choice, so forms post exactly as before; without JS
  // the native select is used.
  document.querySelectorAll('select:not([multiple])').forEach(function (sel, n) {
    if (sel.closest('.lab, [data-native]')) return;
    var wrap = document.createElement('div');
    wrap.className = 'pick';
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('pick-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick-button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    var label = sel.id ? document.querySelector('label[for="' + sel.id + '"]') : null;
    var value = document.createElement('span');
    value.className = 'pick-value';
    value.id = 'pick-value-' + n;
    btn.appendChild(value);
    if (label) {
      if (!label.id) label.id = 'pick-label-' + n;
      btn.setAttribute('aria-labelledby', label.id + ' ' + value.id);
      label.addEventListener('click', function (e) { e.preventDefault(); btn.focus(); });
    }
    var list = document.createElement('ul');
    list.className = 'pick-list';
    list.id = 'pick-list-' + n;
    list.setAttribute('role', 'listbox');
    list.tabIndex = -1;
    list.hidden = true;
    if (label) list.setAttribute('aria-labelledby', label.id);
    btn.setAttribute('aria-controls', list.id);
    var items = Array.prototype.map.call(sel.options, function (o, i) {
      var li = document.createElement('li');
      li.id = list.id + '-' + i;
      li.setAttribute('role', 'option');
      li.textContent = o.textContent;
      if (o.disabled) li.setAttribute('aria-disabled', 'true');
      li.addEventListener('click', function () { if (!o.disabled) { choose(i); } });
      li.addEventListener('pointermove', function () { mark(i); });
      list.appendChild(li);
      return li;
    });
    wrap.appendChild(btn);
    wrap.appendChild(list);
    var active = sel.selectedIndex;
    function sync() {
      value.textContent = sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : '';
      items.forEach(function (li, i) { li.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false'); });
    }
    function mark(i) {
      active = Math.max(0, Math.min(items.length - 1, i));
      items.forEach(function (li, k) { li.classList.toggle('is-active', k === active); });
      list.setAttribute('aria-activedescendant', items[active].id);
      var li = items[active];
      if (li.offsetTop < list.scrollTop) list.scrollTop = li.offsetTop;
      else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
    }
    function open() {
      if (!list.hidden) return;
      document.querySelectorAll('.pick.is-open').forEach(function (p) { if (p !== wrap && p.closePick) p.closePick(false); });
      list.hidden = false;
      wrap.classList.add('is-open');
      btn.setAttribute('aria-expanded', 'true');
      mark(sel.selectedIndex < 0 ? 0 : sel.selectedIndex);
      list.focus();
      sound.play('open');
    }
    function close(refocus) {
      if (list.hidden) return;
      list.hidden = true;
      wrap.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus();
    }
    wrap.closePick = close;
    function choose(i) {
      if (i !== sel.selectedIndex) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync();
      close(true);
    }
    btn.addEventListener('click', function () { if (list.hidden) open(); else close(true); });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    var typed = '';
    var typedAt = 0;
    list.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); mark(active + 1); sound.play('tick'); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active - 1); sound.play('tick'); }
      else if (e.key === 'Home') { e.preventDefault(); mark(0); }
      else if (e.key === 'End') { e.preventDefault(); mark(items.length - 1); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'Tab') close(false);
      else if (e.key.length === 1) {
        var now = Date.now();
        typed = (now - typedAt > 700 ? '' : typed) + e.key.toLowerCase();
        typedAt = now;
        var hit = items.findIndex(function (li) { return li.textContent.toLowerCase().indexOf(typed) === 0; });
        if (hit >= 0) mark(hit);
      }
    });
    document.addEventListener('pointerdown', function (e) { if (!wrap.contains(e.target)) close(false); });
    sel.addEventListener('change', sync);
    sync();
  });
  // Mira, the guild receptionist (static/art/mira-*.webp). She talks like an RPG character: her lines type out with a
  // soft voice blip, she bobs while talking, pops into a new pose per line, and a click finishes the line at once.
  // With reduced motion the line appears whole and she stands still.
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function setPose(img, pose) {
    if (!img || !pose) return;
    var src = '/static/art/mira-' + pose + '.webp';
    if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    img.classList.remove('is-pop');
    void img.offsetWidth; // restart the pop animation
    img.classList.add('is-pop');
  }
  // The RPG text box: the whole line is laid out first (hidden, so lines never jump), then its letters pop in one by
  // one with a voice blip, pausing after punctuation. Screen readers get the line at once (a visually hidden copy).
  // It runs even with reduced motion (text appears, nothing moves); a click or Enter finishes the line at once.
  function typewriter(el, speaker) {
    var timer = 0;
    var full = '';
    var busy = false;
    var then = null;
    var chars = [];
    var at = 0;
    function finish() {
      window.clearTimeout(timer);
      chars.forEach(function (c) { c.classList.add('on'); });
      at = chars.length;
      busy = false;
      el.classList.remove('is-typing');
      if (speaker) speaker.classList.remove('is-talking');
      var cb = then;
      then = null;
      if (cb) cb();
    }
    function build(text) {
      el.textContent = '';
      var sr = document.createElement('span');
      sr.className = 'sr-only';
      sr.textContent = text;
      var shown = document.createElement('span');
      shown.setAttribute('aria-hidden', 'true');
      chars = [];
      text.split(/(\s+)/).forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part)) { shown.appendChild(document.createTextNode(part)); return; }
        var word = document.createElement('span');
        word.className = 'tw-word';
        Array.prototype.forEach.call(part, function (ch) {
          var c = document.createElement('span');
          c.className = 'tw-ch';
          c.textContent = ch;
          word.appendChild(c);
          chars.push(c);
        });
        shown.appendChild(word);
      });
      el.appendChild(sr);
      el.appendChild(shown);
    }
    function step() {
      if (at >= chars.length) { finish(); return; }
      var c = chars[at];
      c.classList.add('on');
      at += 1;
      if (at % 2 === 1) sound.play('blip');
      var ch = c.textContent;
      var pause = /[.!?]/.test(ch) ? 260 : /[,;:]/.test(ch) ? 140 : 26;
      timer = window.setTimeout(step, pause);
    }
    function say(text, done) {
      window.clearTimeout(timer);
      full = text;
      then = done || null;
      build(full);
      at = 0;
      busy = true;
      el.classList.add('is-typing');
      if (speaker) speaker.classList.add('is-talking');
      timer = window.setTimeout(step, 60);
    }
    return { say: say, finish: finish, busy: function () { return busy; } };
  }


  // The reception counter in the guild hall: "Tell me more" (or a poke at Mira) moves to her next line.
  document.querySelectorAll('[data-reception]').forEach(function (desk) {
    var lines = Array.prototype.map.call(desk.querySelectorAll('[data-dialogue-lines] li'), function (li) {
      return { pose: li.getAttribute('data-pose'), text: li.textContent };
    });
    var textEl = desk.querySelector('[data-dialogue-text]');
    var art = desk.querySelector('[data-mira-art]');
    var actions = desk.querySelector('[data-dialogue-actions]');
    if (!lines.length || !textEl) return;
    if (actions) actions.hidden = false;
    var tw = typewriter(textEl, art);
    var at = 0;
    function next() {
      if (tw.busy()) { tw.finish(); return; }
      at = (at + 1) % lines.length;
      setPose(art, lines[at].pose);
      tw.say(lines[at].text);
      sound.play('pop');
    }
    var nextBtn = desk.querySelector('[data-dialogue-next]');
    if (nextBtn) nextBtn.addEventListener('click', next);
    var poke = desk.querySelector('[data-mira-poke]');
    if (poke) poke.addEventListener('click', next);
    textEl.addEventListener('click', function () { if (tw.busy()) tw.finish(); });
    // Her first line types out once she has stepped up to the counter.
    var first = lines[0].text;
    window.setTimeout(function () { tw.say(first); }, reduceMotion ? 300 : document.documentElement.classList.contains('splash-done') ? 900 : 2600);
  });

  // The guild tour: Mira walks a first-time adventurer through the page. Steps come from <template id="tour-steps">
  // (each <p> has a pose, an optional target selector and her line); a spotlight follows the target and her dialogue
  // box moves out of its way. It starts on its own once per browser (remembered in localStorage), and again from the
  // counter's "Guild tour" button or a #tour link. Escape or "Skip tour" ends it.
  (function () {
    var tpl = document.getElementById('tour-steps');
    var d = document.getElementById('tour');
    if (!tpl || !d || typeof d.showModal !== 'function') return;
    var key = 'hvwa-tour-' + (tpl.getAttribute('data-tour') || 'page');
    var steps = Array.prototype.map.call(tpl.content.querySelectorAll('[data-pose]'), function (p) {
      return { pose: p.getAttribute('data-pose'), target: p.getAttribute('data-target'), text: p.textContent.trim() };
    });
    if (!steps.length) return;
    var spot = d.querySelector('[data-tour-spot]');
    var box = d.querySelector('[data-tour-box]');
    var art = d.querySelector('[data-tour-art]');
    var textEl = d.querySelector('[data-tour-text]');
    var count = d.querySelector('[data-tour-count]');
    var back = d.querySelector('[data-tour-back]');
    var next = d.querySelector('[data-tour-next]');
    var skip = d.querySelector('[data-tour-skip]');
    var tw = typewriter(textEl, art);
    var at = 0;
    var target = null;
    var placeTimer = 0;
    function remember() { try { window.localStorage.setItem(key, 'done'); } catch (e) { /* storage blocked */ } }
    function seen() { try { return window.localStorage.getItem(key) === 'done'; } catch (e) { return true; } }
    function visible(el) {
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
    }
    function find(sel) {
      if (!sel) return null;
      var all = Array.prototype.slice.call(document.querySelectorAll(sel)).filter(visible);
      return all[0] || null;
    }
    function place() {
      if (!target) { d.classList.add('is-open-floor'); d.classList.remove('box-top'); return; }
      d.classList.remove('is-open-floor');
      var r = target.getBoundingClientRect();
      var pad = 8;
      var x = Math.max(4, r.left - pad);
      var y = Math.max(4, r.top - pad);
      var w = Math.min(window.innerWidth - 8, r.right + pad) - x;
      var h = Math.min(window.innerHeight - 8, r.bottom + pad) - y;
      spot.style.setProperty('--spot-x', x + 'px');
      spot.style.setProperty('--spot-y', y + 'px');
      spot.style.setProperty('--spot-w', Math.max(0, w) + 'px');
      spot.style.setProperty('--spot-h', Math.max(0, h) + 'px');
      // The box sits at the bottom unless the spotlight is down there.
      d.classList.toggle('box-top', r.top + r.height / 2 > window.innerHeight * 0.55);
    }
    function show(i) {
      at = i;
      var s = steps[i];
      target = find(s.target); // a target this screen does not show: Mira talks without a spotlight
      if (target) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      place();
      window.clearTimeout(placeTimer);
      placeTimer = window.setTimeout(place, reduceMotion ? 0 : 420);
      setPose(art, s.pose);
      count.textContent = (d.getAttribute('data-step-label') || '{n} / {total}').replace('{n}', i + 1).replace('{total}', steps.length);
      back.hidden = i === 0;
      var last = i === steps.length - 1;
      next.textContent = last ? d.getAttribute('data-done') : d.getAttribute('data-next');
      skip.hidden = last;
      box.classList.remove('is-step');
      void box.offsetWidth;
      box.classList.add('is-step');
      tw.say(s.text);
      try { next.focus(); } catch (e) { /* not focusable */ }
    }
    function start() {
      if (d.open) return;
      d.showModal();
      document.documentElement.classList.add('touring');
      sound.play('scroll');
      show(0);
    }
    function end(done) {
      remember();
      tw.finish();
      if (d.open) d.close();
      document.documentElement.classList.remove('touring');
      sound.play(done ? 'fanfare' : 'close');
    }
    function forward() {
      if (tw.busy()) { tw.finish(); return; }
      if (at >= steps.length - 1) { end(true); return; }
      sound.play('page');
      var n = at + 1;
      while (n < steps.length - 1 && steps[n].target && !find(steps[n].target)) n += 1;
      show(n);
    }
    function backward() {
      if (at === 0) return;
      sound.play('page');
      var n = at - 1;
      while (n > 0 && steps[n].target && !find(steps[n].target)) n -= 1;
      show(n);
    }
    next.addEventListener('click', forward);
    back.addEventListener('click', backward);
    skip.addEventListener('click', function () { end(false); });
    textEl.addEventListener('click', function () { if (tw.busy()) tw.finish(); });
    d.addEventListener('cancel', function (e) { e.preventDefault(); end(false); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight') { e.preventDefault(); forward(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); backward(); }
    });
    window.addEventListener('resize', function () { if (d.open) place(); });
    window.addEventListener('scroll', function () { if (d.open) place(); }, { passive: true });
    document.querySelectorAll('[data-tour-start]').forEach(function (b) { b.addEventListener('click', start); });
    // A player still to make their adventurer meets Mira's preboarding popup first; the tour waits for the next visit.
    // A starter purse to hand over comes before the tour too: the tour starts once that popup is closed.
    var gift = document.querySelector('[data-gift]');
    if (gift && !seen() && window.location.hash !== '#tour') {
      gift.addEventListener('close', function () { window.setTimeout(start, 500); });
    } else if (window.location.hash === '#tour' || (!seen() && !document.querySelector('[data-preboard]'))) {
      // After the splash and the opening gate, so she does not talk over them.
      var wait = 1100;
      if (!document.documentElement.classList.contains('splash-done')) wait += 2200;
      if (document.querySelector('.welcome-gate')) wait += 2000;
      window.setTimeout(start, wait);
    }
  })();
  // Preboarding: a player with no adventurer yet meets Mira in a visual-novel scene: she steps in from the right, her
  // line types out in the dialogue box, then an RPG choice menu offers character creation or a skip that keeps the
  // default. Arrow keys move between the choices. Without JavaScript the same two choices sit at the reception counter.
  (function () {
    var d = document.querySelector('[data-preboard]');
    if (!d || typeof d.showModal !== 'function') return;
    var textEl = d.querySelector('[data-preboard-text]');
    var tw = typewriter(textEl, d.querySelector('[data-preboard-art]'));
    var choices = Array.prototype.slice.call(d.querySelectorAll('.vn-choice'));
    var line = textEl.textContent;
    function ready() {
      d.classList.add('is-ready');
      sound.play('open');
      if (choices[0]) { try { choices[0].focus(); } catch (e) { /* not focusable */ } }
    }
    var wait = 900;
    if (!document.documentElement.classList.contains('splash-done')) wait += 2200;
    if (document.querySelector('.welcome-gate')) wait += 2000;
    window.setTimeout(function () {
      document.documentElement.classList.add('preboarding');
      d.showModal();
      sound.play('chime');
      window.setTimeout(function () { tw.say(line, ready); }, reduceMotion ? 0 : 650);
    }, wait);
    // A click on the box finishes the line; the choices then take the focus.
    d.querySelector('.vn-box').addEventListener('click', function () { if (tw.busy()) tw.finish(); });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && tw.busy()) { e.preventDefault(); tw.finish(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var i = choices.indexOf(document.activeElement);
      e.preventDefault();
      var n = (i + (e.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      try { choices[n].focus(); } catch (err) { /* not focusable */ }
      sound.play('tick');
    });
    choices.forEach(function (c) { c.addEventListener('pointerenter', function () { try { c.focus(); } catch (e) { /* not focusable */ } }); });
    d.addEventListener('close', function () { document.documentElement.classList.remove('preboarding'); });
  })();
  // The starter purse: once, after the adventurer is made, Mira hands over the guild's gift. The amount counts up with
  // a jingle; closing it lets the gold land in the licence, which counts from the old purse to the new one and glints.
  (function () {
    var d = document.querySelector('[data-gift]');
    if (!d || typeof d.showModal !== 'function') return;
    var amount = Number(d.getAttribute('data-amount')) || 0;
    var before = Number(d.getAttribute('data-before')) || 0;
    var countEl = d.querySelector('[data-gift-count]');
    var label = countEl ? countEl.textContent : '';
    function countUp(el, from, to, ms, fmt, done) {
      if (!el) return;
      if (reduceMotion || to <= from) { el.textContent = fmt(to); if (done) done(); return; }
      var t0 = 0;
      var finished = false;
      function finish() { if (finished) return; finished = true; el.textContent = fmt(to); if (done) done(); }
      function frame(t) {
        if (finished) return;
        if (!t0) t0 = t;
        var k = Math.min(1, (t - t0) / ms);
        el.textContent = fmt(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
        if (k < 1) window.requestAnimationFrame(frame); else finish();
      }
      window.requestAnimationFrame(frame);
      // A hidden tab pauses animation frames: the final figure lands regardless.
      window.setTimeout(finish, ms + 150);
    }
    var wait = 900;
    if (!document.documentElement.classList.contains('splash-done')) wait += 2200;
    if (document.querySelector('.welcome-gate')) wait += 2000;
    window.setTimeout(function () {
      d.showModal();
      sound.play('chime');
      if (countEl) countEl.textContent = label.replace(String(amount), '0');
      window.setTimeout(function () {
        sound.play('coin');
        countUp(countEl, 0, amount, 700, function (n) { return label.replace(String(amount), String(n)); }, function () { sound.play('fanfare'); });
      }, reduceMotion ? 0 : 820);
      var ok = d.querySelector('[data-gift-ok]');
      if (ok) { try { ok.focus(); } catch (e) { /* not focusable */ } }
    }, wait);
    d.addEventListener('close', function () {
      sound.play('clink');
      var purse = document.querySelector('[data-testid="range-score"]');
      if (!purse) return;
      purse.classList.add('is-gifted');
      countUp(purse, before, before + amount, 900, String, function () {
        window.setTimeout(function () { purse.classList.remove('is-gifted'); }, 2400);
      });
    });
    // A click on the backdrop closes it like the button does.
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
  })();

  // Choose your avatar: the stage shows whichever hero is picked (art, name, class, what they are good at), Mira
  // comments on the pick, and "Surprise me" picks one at random.
  document.querySelectorAll('[data-creator]').forEach(function (root) {
    var form = root.querySelector('form.creator-form');
    var stage = root.querySelector('[data-preview]');
    var img = root.querySelector('[data-preview-img]');
    var nameEl = root.querySelector('[data-preview-name]');
    var clsEl = root.querySelector('[data-preview-class]');
    var descEl = root.querySelector('[data-preview-desc]');
    var textEl = root.querySelector('[data-dialogue-text]');
    var art = root.querySelector('[data-mira-art]');
    var tw = textEl ? typewriter(textEl, art) : null;
    var poses = ['cheer', 'smile', 'point', 'think'];
    var said = 0;
    if (!form || !stage) return;
    function show(card, line) {
      if (!card) return;
      if (img) {
        img.setAttribute('src', card.getAttribute('data-art'));
        img.classList.remove('is-pop');
        void img.offsetWidth;
        img.classList.add('is-pop');
      }
      stage.setAttribute('data-color', card.getAttribute('data-color'));
      if (nameEl) nameEl.textContent = card.getAttribute('data-name');
      if (clsEl) clsEl.textContent = card.getAttribute('data-cls');
      if (descEl) descEl.textContent = card.getAttribute('data-desc');
      if (tw) {
        setPose(art, poses[said % poses.length]);
        said += 1;
        tw.say(line || (root.getAttribute('data-pick-line') || '{name}').replace('{name}', card.getAttribute('data-name')).replace('{desc}', card.getAttribute('data-desc')));
      }
    }
    form.addEventListener('change', function (e) {
      if (!e.target || e.target.name !== 'hero') return;
      show(e.target.closest('.hero-card'));
      sound.play('pop');
    });
    var roll = root.querySelector('[data-avatar-random]');
    if (roll) {
      roll.hidden = false;
      roll.addEventListener('click', function () {
        var all = Array.prototype.slice.call(form.querySelectorAll('input[name="hero"]'));
        var others = all.filter(function (r) { return !r.checked; });
        var pick = others[Math.floor(Math.random() * others.length)] || all[0];
        pick.checked = true;
        var card = pick.closest('.hero-card');
        show(card, root.getAttribute('data-random-line'));
        card.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
        sound.play('coin');
      });
    }
    if (textEl) textEl.addEventListener('click', function () { if (tw && tw.busy()) tw.finish(); });
    form.addEventListener('submit', function () { sound.play('seal'); });
  });

  // The rank ladder: any rank plate or seal opens every rank from E to S, the player's own name on each plate.
  (function () {
    var d = document.getElementById('rank-ladder');
    if (!d || typeof d.showModal !== 'function') return;
    document.addEventListener('click', function (e) {
      var opener = e.target.closest ? e.target.closest('[data-rank-open]') : null;
      if (!opener) return;
      e.preventDefault();
      var menu = opener.closest('details.menu');
      if (menu) menu.removeAttribute('open');
      d.showModal();
      sound.play('unroll');
      var here = d.querySelector('[aria-current="step"]');
      if (here) here.scrollIntoView({ block: 'center' });
    });
    var close = d.querySelector('[data-ladder-close]');
    if (close) close.addEventListener('click', function () { d.close(); });
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.addEventListener('close', function () { sound.play('close'); });
  })();

  // The merchant and the Guildmaster talk like Mira: their opening line types out. When the Guildmaster reads a scroll
  // (an htmx swap carrying data-counsel-say), he speaks the counsel in his own box.
  document.querySelectorAll('[data-npc-text]').forEach(function (textEl) {
    var scene = textEl.closest('.npc-scene');
    var art = scene ? scene.querySelector('[data-npc-art]') : null;
    var tw = typewriter(textEl, art);
    var section = textEl.closest('[data-counsel]');
    if (section) section.hvwaSay = tw;
    var line = textEl.textContent;
    window.setTimeout(function () { tw.say(line); }, reduceMotion ? 200 : 650);
    textEl.addEventListener('click', function () { if (tw.busy()) tw.finish(); });
  });
  document.addEventListener('htmx:afterSwap', function (e) {
    var target = e.detail && e.detail.target;
    var said = target && target.querySelector ? target.querySelector('[data-counsel-say]') : null;
    if (!said) return;
    said.removeAttribute('data-counsel-say');
    var section = said.closest('[data-counsel]');
    var text = said.querySelector('.hint-text');
    if (section && section.hvwaSay && text) {
      var box = section.querySelector('.npc-scene');
      if (box) box.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
      if (section.hvwaPose) section.hvwaPose('read');
      section.hvwaSay.say(text.textContent);
    }
    sound.play('unroll');
  });

  // The Guildmaster's corner as a conversation: two choices. "Tell me about this quest" and he tells the client's
  // request; "I need a hint" and he nods, asks which scroll you brought, and the scrolls are laid out to choose from.
  document.querySelectorAll('[data-counsel]').forEach(function (sec) {
    var art = sec.querySelector('[data-npc-art]');
    var choices = sec.querySelector('[data-gm-choices]');
    var panels = {};
    sec.querySelectorAll('[data-gm-panel]').forEach(function (p) { panels[p.getAttribute('data-gm-panel')] = p; });
    sec.hvwaPose = function (name) {
      var src = art ? art.getAttribute('data-pose-' + name) : null;
      if (!src || art.getAttribute('src') === src) return;
      art.setAttribute('src', src);
      art.classList.remove('is-pop');
      void art.offsetWidth;
      art.classList.add('is-pop');
    };
    if (!choices) return;
    choices.hidden = false;
    var openHint = /^#(hint-\d+|intel-title)$/.test(window.location.hash);
    Object.keys(panels).forEach(function (k) { if (!(k === 'hint' && openHint)) panels[k].hidden = true; });
    function show(k) {
      Object.keys(panels).forEach(function (n) { panels[n].hidden = n !== k; });
      var p = panels[k];
      if (p) { p.classList.remove('is-shown'); void p.offsetWidth; p.classList.add('is-shown'); }
    }
    choices.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-gm-ask]') : null;
      if (!b) return;
      choices.querySelectorAll('[data-gm-ask]').forEach(function (x) { x.classList.toggle('is-chosen', x === b); });
      if (b.getAttribute('data-gm-ask') === 'brief') {
        sec.hvwaPose('talk');
        var brief = panels.brief ? panels.brief.querySelector('.brief') : null;
        if (sec.hvwaSay && brief) sec.hvwaSay.say(((sec.getAttribute('data-brief-lead') || '') + ' ' + brief.textContent.trim()).trim());
        show('brief');
        sound.play('unroll');
      } else {
        sec.hvwaPose('nod');
        if (sec.hvwaSay) sec.hvwaSay.say(sec.getAttribute('data-ask-scroll') || '');
        show('hint');
        sound.play('open');
      }
    });
  });

  // Mira at the claim desk reacts to the flag: a cheer for a sealed contract, a think for a miss.
  (function () {
    var say = document.querySelector('[data-desk-say]');
    var mira = document.querySelector('[data-desk-mira]');
    if (!say) return;
    var tw = typewriter(say, mira);
    document.addEventListener('htmx:afterSwap', function (e) {
      var target = e.detail && e.detail.target;
      if (!target || target.id !== 'submit-result') return;
      var ok = target.querySelector('.result-ok');
      var bad = target.querySelector('.result-bad');
      if (!ok && !bad) return;
      setPose(mira, ok ? 'cheer' : 'think');
      tw.say(say.getAttribute(ok ? 'data-ok' : 'data-bad') || '');
    });
  })();

  // Never swap a proxy's error page into a fragment: a gateway error (502/503/504, e.g. Cloudflare while the portal
  // restarts) or any whole HTML document is not one of our fragments. A poll simply tries again on its next tick.
  document.addEventListener('htmx:beforeSwap', function (e) {
    var x = e.detail && e.detail.xhr;
    if (!x || x.status < 400) return;
    var head = (x.responseText || '').slice(0, 4000);
    if (x.status === 502 || x.status === 503 || x.status === 504 || /<!doctype|<html[\s>]/i.test(head)) {
      e.detail.shouldSwap = false;
      e.detail.isError = true;
    }
  });
})();
