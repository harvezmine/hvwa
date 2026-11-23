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

    function audio() {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      if (!ctx) {
        ctx = new C();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
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
      g.gain.exponentialRampToValueAtTime(peak, at + attack);
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
      click: function (c, t) { tone(c, 190, t, 0.22, 0.07, 'triangle', 120); hiss(c, t, 0.12, 0.04, 2200, 0, 2.5); },
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
      if (!on || document.hidden) return;
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
    var SKIP = '[data-board-link], [data-board-prev], [data-board-next], [data-sound-toggle], summary';
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

  // A plain (non-htmx) submit of a form with data-confirm asks first. htmx forms use hx-confirm instead, so skip them
  // here to avoid asking twice.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute || !f.hasAttribute('data-confirm') || f.hasAttribute('hx-post')) return;
    if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
  }, true);
})();
