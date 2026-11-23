// src/public/splash.js — the opening splash plays once per browser tab session. Loaded synchronously in <head> so the
// class lands before the body paints (no flash on later pages), same-origin so the page CSP allows it, and inert when
// session storage is unavailable. With reduced motion the splash still shows, but statically, and is removed by a timer.
let seen = true;
try {
  seen = sessionStorage.getItem('hvwa.splash') === '1';
  sessionStorage.setItem('hvwa.splash', '1');
} catch {
  /* storage blocked: never show the splash */
}
if (seen) document.documentElement.classList.add('splash-done');
else if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  setTimeout(() => document.documentElement.classList.add('splash-done'), 1200);
}
