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

  // Sound: the guild's background music (static/audio, "Adventures Begin" by Pufino) and small effects synthesized with
  // Web Audio (no files): a wooden knock on clicks, paper on menus, a slide between boards, a seal and coins on a solve.
  // One toggle in the masthead switches all of it; the choice is remembered in this browser. Browsers refuse audio
  // before the first user gesture, so the music starts on the first click or key press when sound is on.
  var sound = (function () {
    var KEY = 'hvwa-sound';
    var POS = 'hvwa-music-pos';
    var MUSIC_URL = '/static/audio/adventures-begin.mp3';
    var MUSIC_VOLUME = 0.28;
    var on = true; // shortcut: sound defaults on; flip to false here if the guild should start silent
    try { var saved = window.localStorage.getItem(KEY); if (saved === 'off') on = false; } catch (e) { /* storage blocked */ }
    var ctx = null;
    var noise = null;
    var music = null;
    var fade = 0;

    function audio() {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      if (!ctx) {
        ctx = new C();
        noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
        var d = noise.getChannelData(0);
        for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    }
    function env(c, at, peak, attack, decay) {
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(peak, at + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
      g.connect(c.destination);
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
      click: function (c, t) { tone(c, 190, t, 0.22, 0.07, 'triangle', 120); hiss(c, t, 0.12, 0.04, 2200, 0, 2.5); },
      open: function (c, t) { hiss(c, t, 0.09, 0.16, 2600, 4200, 0.9); tone(c, 330, t, 0.05, 0.08, 'triangle'); },
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

    function setVolume(target, ms) {
      window.clearInterval(fade);
      var step = (target - music.volume) / Math.max(1, ms / 40);
      fade = window.setInterval(function () {
        var v = music.volume + step;
        if ((step >= 0 && v >= target) || (step < 0 && v <= target)) { v = target; window.clearInterval(fade); if (v === 0) music.pause(); }
        music.volume = Math.min(1, Math.max(0, v));
      }, 40);
    }
    function startMusic() {
      if (!on) return;
      if (!music) {
        music = new Audio(MUSIC_URL);
        music.loop = true;
        music.preload = 'auto';
        music.volume = 0;
        var resumeAt = 0;
        try { resumeAt = parseFloat(window.sessionStorage.getItem(POS) || '0') || 0; } catch (e) { /* storage blocked */ }
        if (resumeAt > 0) music.addEventListener('loadedmetadata', function () { try { music.currentTime = resumeAt; } catch (e) { /* not seekable yet */ } }, { once: true });
      }
      var p = music.play();
      if (p && p.catch) p.catch(function () { /* still no gesture: the next one retries */ });
      setVolume(MUSIC_VOLUME, 1200);
    }
    function stopMusic() { if (music) setVolume(0, 300); }
    // Carry the track's position to the next page of this tab, so a click through the guild does not restart it.
    window.addEventListener('pagehide', function () {
      if (music && !music.paused) { try { window.sessionStorage.setItem(POS, String(music.currentTime)); } catch (e) { /* storage blocked */ } }
    });
    function firstGesture() {
      document.removeEventListener('pointerdown', firstGesture, true);
      document.removeEventListener('keydown', firstGesture, true);
      startMusic();
    }
    document.addEventListener('pointerdown', firstGesture, true);
    document.addEventListener('keydown', firstGesture, true);

    document.querySelectorAll('[data-sound-toggle]').forEach(function (btn) {
      btn.hidden = false;
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.addEventListener('click', function () {
        on = !on;
        try { window.localStorage.setItem(KEY, on ? 'on' : 'off'); } catch (e) { /* storage blocked */ }
        document.querySelectorAll('[data-sound-toggle]').forEach(function (b) { b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
        if (on) { startMusic(); play('coin'); } else stopMusic();
      });
    });

    // Effects on the shell: a knock for clicks, paper for a menu or accordion opening. Board links play their slide
    // from the carousel instead, so they are skipped here.
    document.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('a, button, summary, select, input[type="submit"]') : null;
      if (!el || el.matches('[data-board-link], [data-board-prev], [data-board-next], [data-sound-toggle], summary')) return;
      play('click');
    }, true);
    document.addEventListener('toggle', function (e) { if (e.target && e.target.open) play('open'); }, true);
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
      if (node.getAttribute('data-toast') === 'unlocked') sound.play('coin');
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

  // A plain (non-htmx) submit of a form with data-confirm asks first. htmx forms use hx-confirm instead, so skip them
  // here to avoid asking twice.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute || !f.hasAttribute('data-confirm') || f.hasAttribute('hx-post')) return;
    if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
  }, true);
})();
