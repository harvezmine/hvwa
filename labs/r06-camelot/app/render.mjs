// labs/r06-camelot/app/render.mjs — the Camelot Court look (parchment, night blue, crimson and gold; one inline CSS
// system, inline SVG illustrations, no external assets) and every page builder. Every interpolated value goes through
// esc(). This module never sees a key, the true words or the dream plaintext; the only secret it can render is the flag,
// and only on a stone page the server builds after a proof was accepted.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const FAVICON = 'data:image/svg+xml,'
  + '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E'
  + '%3Cpath d=%22M20 2 34 7v12c0 9-6 15-14 19C12 34 6 28 6 19V7Z%22 fill=%22%237a1f24%22/%3E'
  + '%3Cpath d=%22M20 7v19M15.5 11h9%22 stroke=%22%23f3e6c4%22 stroke-width=%222.2%22/%3E%3C/svg%3E';

const CREST = `<svg class="crest" viewBox="0 0 40 40" aria-hidden="true" focusable="false">`
  + `<path d="M20 2 34 7v12c0 9-6 15-14 19C12 34 6 28 6 19V7Z" fill="#7a1f24" stroke="#e0b94a" stroke-width="1.6"/>`
  + `<path d="M20 7v19M15.5 11h9" stroke="#f3e6c4" stroke-width="2.2" stroke-linecap="round"/>`
  + `<path d="M12 28h16l-2 4H14Z" fill="#e0b94a"/></svg>`;

// ---- Illustrations (decorative: aria-hidden) ----------------------------------------------------------------------

const HERO = `<svg class="hero-art" viewBox="0 0 480 340" aria-hidden="true" focusable="false">
<defs>
 <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#151a3a"/><stop offset=".65" stop-color="#2b2550"/><stop offset="1" stop-color="#4a2c4f"/></linearGradient>
 <radialGradient id="moonglow"><stop offset="0" stop-color="#e2574a" stop-opacity=".55"/><stop offset="1" stop-color="#e2574a" stop-opacity="0"/></radialGradient>
 <radialGradient id="swordglow"><stop offset="0" stop-color="#ffe7a3" stop-opacity=".9"/><stop offset="1" stop-color="#ffe7a3" stop-opacity="0"/></radialGradient>
 <clipPath id="frame"><rect width="480" height="340" rx="22"/></clipPath>
</defs>
<g clip-path="url(#frame)">
 <rect width="480" height="340" fill="url(#sky)"/>
 <g fill="#f6e7bf"><circle cx="40" cy="38" r="1.6"/><circle cx="96" cy="70" r="1.2"/><circle cx="150" cy="28" r="1.8"/><circle cx="214" cy="58" r="1.1"/><circle cx="262" cy="22" r="1.4"/><circle cx="300" cy="96" r="1"/><circle cx="440" cy="40" r="1.5"/><circle cx="452" cy="128" r="1.1"/><circle cx="24" cy="120" r="1.2"/></g>
 <g class="twinkle" fill="#fff6d8"><circle cx="186" cy="92" r="1.8"/><circle cx="414" cy="168" r="1.6"/><circle cx="68" cy="160" r="1.5"/></g>
 <circle cx="372" cy="86" r="78" fill="url(#moonglow)"/>
 <circle cx="372" cy="86" r="40" fill="#d24a3e"/>
 <circle cx="358" cy="74" r="7" fill="#b93b31"/><circle cx="386" cy="98" r="5" fill="#b93b31"/><circle cx="380" cy="70" r="3" fill="#b93b31"/>
 <path d="M0 228c60-26 120-30 180-14s120 10 180-10 90-8 120 2v134H0Z" fill="#251f3f"/>
 <g fill="#1a1630">
  <path d="M40 232V150h16v-10h8v10h10v-10h8v10h14v82Z"/>
  <path d="M96 232v-58h12v-8h7v8h9v-8h7v8h12v58Z"/>
  <path d="M60 128 70 104l10 24Z"/><rect x="62" y="128" width="16" height="22"/>
  <path d="M150 232V160h12v-8h7v8h8v-8h7v8h12v72Z"/>
  <path d="M164 140l10-22 10 22Z"/><rect x="166" y="140" width="16" height="20"/>
 </g>
 <g fill="#f2c45a"><rect x="66" y="136" width="4" height="7" rx="2"/><rect x="170" y="148" width="4" height="7" rx="2"/><rect x="110" y="186" width="4" height="7" rx="2"/><rect x="60" y="176" width="4" height="7" rx="2"/></g>
 <path d="M0 268c80-30 170-36 250-20s160 18 230-4v96H0Z" fill="#3a2a35"/>
 <circle cx="330" cy="236" r="64" fill="url(#swordglow)"/>
 <path d="M282 282c4-22 18-34 46-36 30-2 48 12 54 36Z" fill="#7d7387"/>
 <path d="M296 282c4-14 14-22 32-24 18-1 30 8 36 24Z" fill="#988da1"/>
 <path d="M300 262c10-6 22-8 34-6" stroke="#b8afc0" stroke-width="3" fill="none" stroke-linecap="round"/>
 <rect x="326" y="180" width="8" height="74" rx="2" fill="#e8ecf2"/>
 <path d="M330 180v74" stroke="#b9c2cf" stroke-width="2"/>
 <rect x="310" y="174" width="40" height="8" rx="4" fill="#e0b94a"/>
 <rect x="326" y="150" width="8" height="26" rx="3" fill="#7a1f24"/>
 <circle cx="330" cy="146" r="7" fill="#e0b94a"/>
 <path d="M0 300c90-14 200-16 300-6s140 8 180 0v46H0Z" fill="#2a1f2b"/>
</g></svg>`;

const ART = {
  dream: `<svg class="art" viewBox="0 0 120 120" aria-hidden="true" focusable="false"><circle cx="60" cy="60" r="58" fill="#26244a"/>
<g fill="#f6e7bf"><circle cx="26" cy="34" r="1.6"/><circle cx="92" cy="26" r="1.4"/><circle cx="98" cy="86" r="1.2"/></g>
<rect x="28" y="40" width="64" height="46" rx="4" fill="#f3e6c4"/><path d="M34 52h44M34 60h52M34 68h38M34 76h46" stroke="#b39463" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="5 3"/>
<rect x="22" y="34" width="12" height="58" rx="6" fill="#e0c98f"/><rect x="86" y="34" width="12" height="58" rx="6" fill="#e0c98f"/>
<circle cx="80" cy="84" r="9" fill="#7a1f24"/><path d="M76 84h8M80 80v8" stroke="#e0b94a" stroke-width="2" stroke-linecap="round"/></svg>`,
  petition: `<svg class="art" viewBox="0 0 120 120" aria-hidden="true" focusable="false"><circle cx="60" cy="60" r="58" fill="#3b2a24"/>
<path d="M30 40h50l10 10v38H30Z" fill="#f3e6c4"/><path d="M80 40v10h10" fill="#dcc690"/>
<path d="M38 54h34M38 62h40M38 70h26" stroke="#b39463" stroke-width="2.4" stroke-linecap="round"/>
<circle cx="72" cy="78" r="10" fill="#7a1f24"/><circle cx="72" cy="78" r="5.5" fill="none" stroke="#e0b94a" stroke-width="1.6"/>
<path d="M96 22c-10 6-22 22-28 38l4 2c8-14 20-28 28-36Z" fill="#e9ddc0"/><path d="M68 60l-4 10 6-6" fill="#2b1d12"/></svg>`,
  oracle: `<svg class="art" viewBox="0 0 120 120" aria-hidden="true" focusable="false"><circle cx="60" cy="60" r="58" fill="#1f2a4a"/>
<circle cx="88" cy="32" r="10" fill="#f3e6c4"/><circle cx="92" cy="28" r="9" fill="#1f2a4a"/>
<g fill="#f6e7bf"><circle cx="26" cy="30" r="1.5"/><circle cx="34" cy="52" r="1.2"/><circle cx="96" cy="60" r="1.3"/></g>
<path d="M48 104V50h24v54Z" fill="#4b5578"/><path d="M44 50l16-24 16 24Z" fill="#7a1f24"/>
<path d="M44 50h32v6H44Z" fill="#39415f"/><rect x="55" y="64" width="10" height="14" rx="5" fill="#f2c45a"/>
<path d="M60 18l1.8 4.6 4.8.2-3.8 3 1.4 4.8-4.2-2.8-4.2 2.8 1.4-4.8-3.8-3 4.8-.2Z" fill="#e0b94a"/>
<path d="M36 104h48" stroke="#2a3150" stroke-width="6" stroke-linecap="round"/></svg>`,
  stone: `<svg class="art" viewBox="0 0 120 120" aria-hidden="true" focusable="false"><circle cx="60" cy="60" r="58" fill="#2e2a3c"/>
<circle cx="60" cy="54" r="34" fill="#ffe7a3" opacity=".22"/>
<rect x="56" y="26" width="8" height="54" rx="2" fill="#e8ecf2"/><rect x="44" y="34" width="32" height="7" rx="3.5" fill="#e0b94a"/>
<rect x="56" y="14" width="8" height="21" rx="3" fill="#7a1f24"/><circle cx="60" cy="12" r="5" fill="#e0b94a"/>
<path d="M24 96c4-18 16-26 36-27 22-1 34 9 38 27Z" fill="#8a8095"/><path d="M38 96c3-10 10-15 22-16 13 0 21 6 24 16Z" fill="#a69bb0"/></svg>`,
};

// ---- Styles ---------------------------------------------------------------------------------------------------------

const CSS = `
:root{--paper:#f4e9cc;--paper2:#eadbb3;--card:#fcf6e4;--ink:#2b1d12;--muted:#6a5641;--line:#d6c194;--crimson:#7a1f24;
--crimson2:#5e161a;--gold:#e0b94a;--gold2:#9a7716;--night:#1d2142;--green:#2f6b3a;--green-soft:#dcebd5;--red-soft:#f4dcd4;
--r:16px;--shadow:0 14px 34px rgba(60,35,10,.16)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;color:var(--ink);background:var(--paper);font:17px/1.65 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif}
a{color:var(--crimson)}
h1,h2,h3{line-height:1.15;color:var(--crimson2);margin:0 0 .45em}
p{margin:0 0 .9em}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
.skip{position:absolute;left:-9999px;top:0;background:var(--card);padding:10px 16px;z-index:9}
.skip:focus{left:0}
header.top{background:var(--night);color:var(--paper)}
.top-in{max-width:1040px;margin:0 auto;padding:10px 20px;display:flex;gap:14px;align-items:center;flex-wrap:wrap}
.brand{display:flex;gap:10px;align-items:center;color:var(--paper);text-decoration:none;font-size:20px;font-weight:700}
.crest{width:34px;height:34px;flex:none}
nav.main{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
nav.main a{color:#e9e3d0;text-decoration:none;padding:9px 13px;border-radius:999px;font-size:15px;min-height:40px;display:inline-flex;align-items:center}
nav.main a:hover{background:rgba(255,255,255,.1)}
nav.main a[aria-current=page]{background:var(--gold);color:var(--night);font-weight:700}
main{max-width:1040px;margin:0 auto;padding:34px 20px 56px}
main.narrow,footer.narrow{max-width:800px}
.eyebrow{font-size:12.5px;letter-spacing:2.4px;text-transform:uppercase;color:var(--gold2);font-weight:700;margin-bottom:6px}
.lede{font-size:19px;color:var(--muted);max-width:52ch}
.tier{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;
background:var(--night);color:var(--gold);border-radius:999px;padding:5px 12px}
/* hall */
.hero{display:grid;grid-template-columns:1.05fr 1fr;gap:34px;align-items:center;margin-bottom:38px}
.hero h1{font-size:clamp(34px,5vw,52px);margin-top:12px}
.hero-art{width:100%;height:auto;border-radius:22px;box-shadow:var(--shadow)}
.riddle{font-style:italic;background:var(--card);border-radius:12px;padding:14px 18px;margin:18px 0 0;white-space:pre-line;
color:var(--crimson2);box-shadow:0 2px 0 var(--line);max-width:44ch}
.riddle b{display:block;font-style:normal;font-size:12.5px;letter-spacing:2px;text-transform:uppercase;color:var(--gold2);margin-bottom:4px}
h2.quest{font-size:26px;margin-bottom:16px}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;list-style:none;padding:0;margin:0}
.step a{position:relative;display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;height:100%;
background:var(--card);border-radius:var(--r);padding:22px 16px 20px;text-decoration:none;color:var(--ink);
box-shadow:0 4px 14px rgba(60,35,10,.08);transition:transform .2s ease,box-shadow .2s ease}
.step a:hover{transform:translateY(-3px);box-shadow:var(--shadow)}
.step .art{width:92px;height:92px}
.step .num{position:absolute;left:14px;top:12px;font-size:13px;font-weight:700;color:var(--gold2)}
.step h3{font-size:19px;margin:4px 0 0}
.step p{font-size:15px;color:var(--muted);margin:0}
.step .txt{display:flex;flex-direction:column;gap:6px}
.ribbon{position:absolute;right:-6px;top:14px;background:var(--crimson);color:#fbefd2;font-size:12px;font-weight:700;letter-spacing:.6px;
padding:4px 10px;border-radius:6px 0 0 6px;box-shadow:0 2px 0 var(--crimson2)}
.calm{margin-top:20px;color:var(--muted);font-size:15.5px}
/* rooms */
.room-head{display:grid;grid-template-columns:132px 1fr;gap:26px;align-items:center;margin-bottom:22px}
.room-head .art{width:132px;height:132px}
.room-head h1{font-size:clamp(30px,4.2vw,42px)}
.room-head .lede{margin:0}
.spell{display:flex;gap:14px;align-items:flex-start;background:var(--card);border-radius:12px;padding:14px 18px;margin:0 0 22px;
box-shadow:0 2px 0 var(--line);max-width:720px}
.spell .tag{flex:none;font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;border-radius:999px;padding:4px 10px;
background:var(--paper2);color:var(--muted);margin-top:2px}
.spell.weak .tag{background:var(--crimson);color:#fbefd2}
.spell p{margin:0;font-size:16px}
.panel{background:var(--card);border-radius:var(--r);padding:22px 24px;box-shadow:0 4px 14px rgba(60,35,10,.08);max-width:720px}
.panel h2{font-size:21px}
.scroll{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;line-height:1.6;word-break:break-all;
white-space:pre-wrap;background:#fffaf0;border:1px solid var(--line);border-radius:10px;padding:14px 16px;max-height:280px;overflow:auto;margin:0}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:12px}
.muted{color:var(--muted);font-size:14.5px}
form.f{display:grid;gap:10px}
label{font-weight:700;font-size:15.5px}
.help{font-size:14px;color:var(--muted);margin:-4px 0 4px}
input[type=text],textarea{width:100%;font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 13px;border:1px solid var(--line);
border-radius:10px;background:#fffaf0;color:var(--ink);min-height:46px}
textarea{min-height:104px;resize:vertical}
input:focus-visible,textarea:focus-visible,button:focus-visible,a:focus-visible,summary:focus-visible{outline:3px solid var(--gold);outline-offset:2px}
button{justify-self:start;font:700 16px/1 inherit;font-family:inherit;background:var(--crimson);color:#fbefd2;border:0;border-radius:999px;
padding:14px 24px;cursor:pointer;box-shadow:0 3px 0 var(--crimson2);min-height:46px;transition:background .2s ease}
button:hover{background:var(--crimson2)}
.or{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:14px;margin:6px 0}
.or:before,.or:after{content:"";flex:1;height:1px;background:var(--line)}
.verdict{border-radius:12px;padding:14px 16px;margin:16px 0 0;font-size:17px;max-width:720px}
.verdict.ok{background:var(--green-soft);color:#1f4a28}
.verdict.no{background:var(--red-soft);color:var(--crimson2)}
.flag{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px;background:var(--night);color:#f3d77a;border-radius:10px;
padding:14px 16px;display:inline-block;margin:8px 0 0;word-break:break-all}
details.api{max-width:720px;margin-top:20px;font-size:15px;color:var(--muted)}
details.api summary{cursor:pointer;font-weight:700;color:var(--crimson);padding:6px 0;min-height:32px}
details.api dl{margin:6px 0 0}
details.api dt{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;font-weight:700;color:var(--ink);margin-top:10px}
details.api dd{margin:2px 0 0}
.lost{text-align:center;padding:30px 0}
.lost .art{width:120px;height:120px;margin-bottom:12px}
footer{max-width:1040px;margin:0 auto;padding:0 20px 36px;color:var(--muted);font-size:13.5px}
@keyframes twinkle{0%,100%{opacity:1}50%{opacity:.25}}
.twinkle circle{animation:twinkle 3.2s ease-in-out infinite}
.twinkle circle:nth-child(2){animation-delay:1.1s}.twinkle circle:nth-child(3){animation-delay:2.2s}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:900px){.steps{grid-template-columns:repeat(2,1fr)}}
@media (max-width:760px){.hero{grid-template-columns:1fr;gap:22px}.hero-art{order:-1}nav.main{margin-left:0}}
@media (max-width:520px){.steps{grid-template-columns:1fr;gap:12px}.step a{flex-direction:row;text-align:left;gap:14px;padding:14px 16px}
.step .art{width:60px;height:60px;flex:none}.step .num{display:none}.step h3{font-size:18px;margin:0}.step .txt{gap:2px}
nav.main{gap:2px}nav.main a{padding:8px 10px;font-size:14.5px;min-height:38px}.brand{font-size:18px}.ribbon{top:-8px;right:10px;border-radius:6px}.room-head{grid-template-columns:84px 1fr;gap:16px}
.room-head .art{width:84px;height:84px}.panel{padding:18px}main{padding-top:24px}}
`;

// ---- Frame ----------------------------------------------------------------------------------------------------------

const NAV = [['/', 'Hall'], ['/dream', 'Dream'], ['/petition', 'Scribe'], ['/oracle', 'Merlin'], ['/stone', 'Stone']];
const TIER_NAMES = { acolyte: 'Common', templar: 'Dangerous', inquisitor: 'Deadly', divine: 'Warded' };

function page(title, current, body, narrow = current !== '/') {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} · Camelot Court</title><link rel="icon" href="${FAVICON}"><style>${CSS}</style></head><body>`
    + `<a class="skip" href="#main">Skip to the court</a>`
    + `<header class="top"><div class="top-in"><a class="brand" href="/">${CREST}<span>Camelot Court</span></a>`
    + `<nav class="main" aria-label="Court">${nav}</nav></div></header>`
    + `<main id="main"${narrow ? ' class="narrow"' : ''}>${body}</main>`
    + `<footer${narrow ? ' class="narrow"' : ''}>A practice court for learning cryptography. No real crowns were harmed.</footer></body></html>`;
}

/** Which rooms hold tonight's weak spell, per tier. Divine has none. */
const WEAK = { acolyte: ['dream'], templar: ['petition'], inquisitor: ['dream', 'oracle'], divine: [] };
const isWeak = (level, room) => (WEAK[level] ?? []).includes(room);

function roomHead(art, eyebrow, title, lede) {
  return `<div class="room-head">${art}<div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="lede">${lede}</p></div></div>`;
}

function spell(level, room, text) {
  const weak = isWeak(level, room);
  return `<div class="spell${weak ? ' weak' : ''}"><span class="tag">${weak ? 'Weak spell' : 'Tonight'}</span><p>${text}</p></div>`;
}

function api(rows) {
  return `<details class="api"><summary>For scripts</summary><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></details>`;
}

const STRONG = 'Sealed with Morgan’s binding (AES-GCM). Change one byte and it breaks. Nothing to find here tonight.';

// ---- Pages ----------------------------------------------------------------------------------------------------------

const RIDDLE = 'Twelve knights keep watch in turn,\nseven nights the dream returns.\nTell the King what he never told,\ndraw the blade and wear the gold.';

const STEPS = [
  ['dream', '/dream', 'Read the dream', 'The King’s sealed scroll.'],
  ['petition', '/petition', 'Visit the scribe', 'Get a seal with your name.'],
  ['oracle', '/oracle', 'Ask Merlin', 'He says clear or clouded.'],
  ['stone', '/stone', 'Pull the sword', 'Words or a knight’s seal.'],
];

export function hallPage(level) {
  const steps = STEPS.map(([room, href, title, line], i) =>
    `<li class="step"><a href="${href}"><span class="num">${i + 1}</span>${isWeak(level, room) ? '<span class="ribbon">Start here</span>' : ''}`
    + `${ART[room]}<span class="txt"><h3>${title}</h3><p>${line}</p></span></a></li>`).join('');
  const calm = (WEAK[level] ?? []).length === 0
    ? `<p class="calm">Every seal in Camelot holds tonight. This is the court done right.</p>` : '';
  return page('Great Hall', '/', `
<!-- scribe's draft, do not publish: HVWA{1s_th1s_c0rr3ct?} -->
<section class="hero">
  <div>
    <span class="tier">Tonight · ${esc(TIER_NAMES[level] ?? level)}</span>
    <h1>The King cannot sleep.</h1>
    <p class="lede">A stranger whispered a riddle to King Arthur. Now the same dream comes back every night, and he will not say what it is.</p>
    <p>Tell him his dream, or bring a knight’s seal, and the sword in the stone is yours.</p>
    <div class="riddle"><b>The stranger’s riddle</b>${esc(RIDDLE)}</div>
  </div>
  ${HERO}
</section>
<h2 class="quest">Your quest</h2>
<ol class="steps">${steps}</ol>${calm}`);
}

const DREAM_SPELL = {
  acolyte: 'Merlin’s old trick: twelve knights take turns, and each one twists his letter with his own secret mark (XOR). Merlin also starts every dream the same way: <code>"On the seventh night, "</code>',
  inquisitor: 'Sealed in chained blocks of sixteen (AES-CBC). The first sixteen bytes start the chain. Only Merlin holds the key, and his tower is open.',
};

export function dreamPage(level, scroll) {
  return page('The Dream', '/dream', `
${roomHead(ART.dream, 'The Great Hall', 'The King’s dream', 'Sealed and hung on the wall for anyone to copy. Reading it is the hard part.')}
${spell(level, 'dream', DREAM_SPELL[level] ?? STRONG)}
<section class="panel">
  <h2>The scroll</h2>
  <pre class="scroll" data-testid="dream-scroll">${esc(scroll)}</pre>
  <p class="muted" style="margin:12px 0 0">Written in hex. Found the three words? Take them to the <a href="/stone">stone</a>.</p>
</section>
${api([['GET /api/dream', '<code>{"scroll": "&lt;hex&gt;"}</code>']])}`);
}

export function petitionPage(level, { name, seal, error } = {}) {
  const result = seal
    ? `<div class="verdict ok">The scribe stamps it. Seal for <b>${esc(name)}</b>:</div><pre class="scroll" data-testid="seal">${esc(seal)}</pre>`
    : error ? `<div class="verdict no" role="alert">${esc(error)}</div>` : '';
  const text = level === 'templar'
    ? 'The night scribes are on duty. To go faster, they seal every sixteen letters on their own, all with the same spell (AES-ECB). Two matching blocks look exactly alike.'
    : STRONG;
  return page('The Scribe', '/petition', `
${roomHead(ART.petition, 'The petitioners’ desk', 'The royal scribe', 'Give your name and get a sealed petition. It always reads <code>petitioner=you;rank=peasant</code>.')}
${spell(level, 'petition', text)}
<section class="panel">
  <form class="f" method="post" action="/petition">
    <label for="name">Your name</label>
    <p class="help">1 to 64 letters. No <code>;</code> or <code>=</code>.</p>
    <input id="name" name="name" type="text" maxlength="64" required autocomplete="off" value="${esc(name ?? '')}">
    <button type="submit">Get my seal</button>
  </form>
  ${result}
</section>
${api([['POST /api/petition', '<code>{"name": "..."}</code> → <code>{"seal": "&lt;hex&gt;"}</code>. Names may use any byte 0x01 to 0x7e.']])}`);
}

export function oraclePage(level, { scroll, verdict } = {}) {
  const result = verdict
    ? `<div class="verdict ${verdict === 'clear' ? 'ok' : 'no'}" data-testid="verdict" role="status">Merlin squints. “The vision is <b>${verdict}</b>.”</div>`
    : '';
  const text = level === 'inquisitor'
    ? 'He opens your scroll with the King’s key (AES-CBC). <i>Clear</i> means it ends in a proper seal (valid padding). <i>Clouded</i> means it does not.'
    : 'He calls a scroll clear only when Morgan’s binding (AES-GCM) is whole. He gives nothing else away.';
  return page("Merlin's Tower", '/oracle', `
${roomHead(ART.oracle, 'Up two hundred steps', 'Merlin’s tower', '“I never read a dream aloud. Show me a scroll and I will tell you how it feels.”')}
${spell(level, 'oracle', text)}
<section class="panel">
  <form class="f" method="post" action="/oracle">
    <label for="scroll">Your scroll (hex)</label>
    <textarea id="scroll" name="scroll" required spellcheck="false">${esc(scroll ?? '')}</textarea>
    <button type="submit">Show Merlin</button>
  </form>
  ${result}
</section>
${api([['POST /api/oracle', '<code>{"scrolls": ["&lt;hex&gt;", ...]}</code> (up to 256) → <code>{"visions": ["clear" | "clouded", ...]}</code>, same order.']])}`);
}

export function stonePage(level, { outcome, flag, petitioner } = {}) {
  let result = '';
  if (outcome === 'knighted') {
    const who = petitioner ? `Sir ${esc(petitioner)}` : 'stranger';
    result = flag
      ? `<div class="verdict ok" data-testid="knighted" role="status">Excalibur slides free and the hall goes quiet. <b>Arise, ${who}, True Knight of the Round Table.</b></div><p class="row">Your writ of knighthood:</p><div class="flag" data-testid="flag">${esc(flag)}</div>`
      : `<div class="verdict ok" data-testid="knighted" role="status">The sword moves. This court is warded, so there is no writ to win here.</div>`;
  } else if (outcome === 'refused') {
    result = `<div class="verdict no" data-testid="refused" role="alert">You pull until your ears go red. The sword does not move. Somewhere, Sir Kay laughs.</div>`;
  }
  return page('The Stone', '/stone', `
${roomHead(ART.stone, 'The courtyard', 'The sword in the stone', 'Say the three words from the dream, or show a knight’s seal. Then pull.')}
<section class="panel">
  <form class="f" method="post" action="/stone">
    <label for="words">The three words</label>
    <input id="words" name="words" type="text" maxlength="128" autocomplete="off" placeholder="word-word-word">
    <div class="or">or</div>
    <label for="seal">A knight’s seal (hex)</label>
    <textarea id="seal" name="seal" spellcheck="false"></textarea>
    <button type="submit">Pull the sword</button>
  </form>
  ${result}
</section>
${api([['POST /api/stone', '<code>{"words": "..."}</code> or <code>{"seal": "&lt;hex&gt;"}</code> → <code>{"knighted": true | false, ...}</code>']])}`);
}

export function notFoundPage() {
  return page('Lost', '', `<div class="lost">${ART.oracle}<h1>You are lost in the castle.</h1><p class="lede" style="margin:0 auto 1em">This corridor leads nowhere.</p><p><a href="/">Back to the Great Hall</a></p></div>`);
}
