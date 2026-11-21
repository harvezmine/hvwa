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

  // After an ACTION swap (not a poll), move focus to the swapped panel so keyboard and screen-reader users land on the
  // new state. The server marks those responses data-focus-after-swap; poll responses never carry it.
  document.addEventListener('htmx:afterSwap', function () {
    var el = document.querySelector('[data-focus-after-swap]');
    if (!el) return;
    el.removeAttribute('data-focus-after-swap');
    window.requestAnimationFrame(function () { try { el.focus(); } catch (e) { /* not focusable */ } });
  });

  // A plain (non-htmx) submit of a form with data-confirm asks first. htmx forms use hx-confirm instead, so skip them
  // here to avoid asking twice.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || !f.getAttribute || !f.hasAttribute('data-confirm') || f.hasAttribute('hx-post')) return;
    if (!window.confirm(f.getAttribute('data-confirm'))) e.preventDefault();
  }, true);
})();
