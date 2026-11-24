// labs/r06-camelot/app/render.mjs — the Camelot Court look (parchment, crimson and gold; one inline CSS system, inline
// SVG crest, no external assets) and every page builder. Every interpolated value goes through esc(). This module never
// sees a key, the true words or the dream plaintext; the only secret it can render is the flag, and only on a stone
// page the server builds after a proof was accepted.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CREST = `<svg class="crest" viewBox="0 0 40 40" aria-hidden="true" focusable="false">`
  + `<path d="M20 2 34 7v12c0 9-6 15-14 19C12 34 6 28 6 19V7Z" fill="#7a1f24" stroke="#c9a227" stroke-width="1.6"/>`
  + `<path d="M20 7v19M15.5 11h9" stroke="#f3e6c4" stroke-width="2.2" stroke-linecap="round"/>`
  + `<path d="M12 28h16l-2 4H14Z" fill="#c9a227"/></svg>`;

const FAVICON = 'data:image/svg+xml,'
  + '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E'
  + '%3Cpath d=%22M20 2 34 7v12c0 9-6 15-14 19C12 34 6 28 6 19V7Z%22 fill=%22%237a1f24%22/%3E'
  + '%3Cpath d=%22M20 7v19M15.5 11h9%22 stroke=%22%23f3e6c4%22 stroke-width=%222.2%22/%3E%3C/svg%3E';

const CSS = `
:root{--paper:#f3e6c4;--paper2:#ead9ae;--card:#fbf3dc;--ink:#2b1d12;--muted:#6b5640;--line:#cdb68a;--crimson:#7a1f24;
--crimson2:#5e161a;--gold:#c9a227;--gold2:#a8851a;--green:#2f6b3a;--green-soft:#dcebd5;--red-soft:#f2d6cf;--radius:10px;
--shadow:0 10px 28px rgba(60,35,10,.18)}
*{box-sizing:border-box}
body{margin:0;color:var(--ink);background:var(--paper) radial-gradient(ellipse at top,rgba(255,255,255,.45),transparent 60%);
font:17px/1.6 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,"Times New Roman",serif}
a{color:var(--crimson)}
h1,h2,h3{font-family:inherit;line-height:1.15;color:var(--crimson2);margin:0 0 .5em}
p{margin:0 0 .9em}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em}
.skip{position:absolute;left:-9999px;top:0;background:var(--card);padding:10px 16px;z-index:9}
.skip:focus{left:0}
header.top{background:var(--crimson);color:var(--paper);box-shadow:0 2px 0 var(--gold)}
.top-in{max-width:1080px;margin:0 auto;padding:10px 20px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
.brand{display:flex;gap:10px;align-items:center;color:var(--paper);text-decoration:none;font-size:21px;font-weight:700;letter-spacing:.5px}
.brand small{display:block;font-size:10.5px;letter-spacing:2.4px;text-transform:uppercase;color:#e9cf86;font-weight:600}
.crest{width:36px;height:36px;flex:none}
nav.main{margin-left:auto;display:flex;gap:2px;flex-wrap:wrap}
nav.main a{color:#f6e9c8;text-decoration:none;padding:7px 11px;border-radius:6px;font-size:15px}
nav.main a:hover{background:rgba(255,255,255,.12)}
nav.main a[aria-current=page]{background:rgba(0,0,0,.22);color:#fff}
main{max-width:1080px;margin:0 auto;padding:30px 20px 60px}
.eyebrow{font-size:12px;letter-spacing:2.6px;text-transform:uppercase;color:var(--gold2);font-weight:700}
.lede{font-size:19px;color:var(--muted);max-width:60ch}
.decree{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:28px 30px;box-shadow:var(--shadow);
position:relative;margin:18px 0 26px}
.decree h1{font-size:clamp(30px,4.4vw,46px);margin:.2em 0 .4em}
.decree .seal{position:absolute;right:22px;top:-18px;width:62px;height:62px;border-radius:50%;background:var(--crimson);
color:#f3e6c4;display:grid;place-items:center;font-size:12px;letter-spacing:1px;box-shadow:0 4px 0 var(--crimson2);text-align:center;line-height:1.1}
.riddle{font-style:italic;border-left:0;background:var(--paper2);border-radius:8px;padding:16px 20px;margin:16px 0;white-space:pre-line}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:0 4px 12px rgba(60,35,10,.08)}
.card h3{font-size:20px}
.card p{color:var(--muted);font-size:15.5px}
.card a.go{font-weight:700;text-decoration:none}
.note{background:var(--paper2);border:1px dashed var(--line);border-radius:8px;padding:14px 16px;font-size:15.5px;margin:14px 0}
.note b{color:var(--crimson2)}
.scroll{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13.5px;line-height:1.55;word-break:break-all;
background:#fffaf0;border:1px solid var(--line);border-radius:8px;padding:16px;max-height:320px;overflow:auto}
form.f{display:grid;gap:12px;max-width:640px;margin:14px 0}
label{font-weight:700;font-size:15px}
input[type=text],textarea{width:100%;font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:11px 12px;border:1px solid var(--line);
border-radius:8px;background:#fffaf0;color:var(--ink)}
textarea{min-height:110px}
input:focus,textarea:focus,button:focus,a:focus{outline:3px solid var(--gold);outline-offset:2px}
button{justify-self:start;font:700 15px/1 inherit;font-family:inherit;background:var(--crimson);color:#f8ecd0;border:0;border-radius:8px;
padding:12px 20px;cursor:pointer;box-shadow:0 3px 0 var(--crimson2)}
button:hover{background:var(--crimson2)}
.verdict{border-radius:8px;padding:14px 16px;margin:14px 0;font-size:17px}
.verdict.ok{background:var(--green-soft);color:#1f4a28}
.verdict.no{background:var(--red-soft);color:var(--crimson2)}
.flag{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:18px;background:#1d140c;color:#f3d77a;border-radius:8px;
padding:14px 16px;display:inline-block;margin:6px 0;word-break:break-all}
table{border-collapse:collapse;width:100%;background:var(--card);border-radius:var(--radius);overflow:hidden;border:1px solid var(--line)}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--line);font-size:15.5px;vertical-align:top}
th{background:var(--paper2);font-size:13px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted)}
tr.perilous td{color:var(--crimson);font-style:italic}
.api dt{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14.5px;font-weight:700;margin-top:14px;color:var(--crimson2)}
.api dd{margin:4px 0 0 0;color:var(--muted);font-size:15.5px}
footer{max-width:1080px;margin:0 auto;padding:0 20px 40px;color:var(--muted);font-size:13.5px}
@media (max-width:640px){.decree{padding:22px 18px}.decree .seal{display:none}nav.main{margin-left:0}}
`;

const NAV = [
  ['/', 'Great Hall'], ['/dream', 'The Dream'], ['/petition', 'Petitioners'], ['/oracle', "Merlin's Tower"],
  ['/stone', 'The Stone'], ['/table', 'Round Table'], ['/clerks', 'Clerks'],
];

function page(title, current, body, { extraHead = '' } = {}) {
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} · Camelot Court</title><link rel="icon" href="${FAVICON}"><style>${CSS}</style>${extraHead}</head><body>`
    + `<a class="skip" href="#main">Skip to the court</a>`
    + `<header class="top"><div class="top-in"><a class="brand" href="/">${CREST}<span>Camelot Court<small>By order of King Arthur</small></span></a>`
    + `<nav class="main" aria-label="Court">${nav}</nav></div></header>`
    + `<main id="main">${body}</main>`
    + `<footer>Camelot Court is a fictional, deliberately vulnerable training court. No real crowns were harmed.</footer></body></html>`;
}

const TIER_NAMES = { acolyte: 'Common', templar: 'Dangerous', inquisitor: 'Deadly', divine: 'Warded' };

const RIDDLE ='Twelve knights keep watch in turn,\nseven nights the dream returns.\nTell the King what he never told,\ndraw the blade and wear the gold.';

/** In-world notes that describe the one spell each level uses (what a court clerk would say). */
const NOTES = {
  dream: {
    acolyte: `<b>Merlin's old cipher.</b> The dream was written in Merlin's favourite trick from his apprentice days: twelve knights carry the letters in turn, and each knight twists every byte he carries by his own secret mark (an XOR), then hands the next byte to the next knight. The scroll is shown in hex. Merlin is a creature of habit: every vision he has ever written down begins with the very same words, <i>"On the seventh night, "</i>.`,
    templar: `<b>Morgan's binding.</b> After last winter's scandal the dream is sealed with an authenticated binding (AES-GCM). It is genuinely unbreakable, and the clerks will laugh at you for trying. The petitioners' desk, on the other hand, is staffed by the night scribes.`,
    inquisitor: `<b>Chained seals.</b> The dream is sealed sixteen bytes at a time, each seal chained to the one before it (AES-CBC). The first sixteen bytes of the scroll are the random charm that starts the chain. Merlin keeps the key, and he never reads a dream aloud, but he will look at any scroll you bring to his tower.`,
    divine: `<b>Morgan's binding.</b> Every scroll in Camelot is sealed with an authenticated binding (AES-GCM). A changed byte breaks the seal; nothing about the contents leaks.`,
  },
  petition: {
    templar: `<b>The night scribes.</b> To keep up with the queue, the scribes seal each sixteen-byte block of your petition separately, every block under the same spell and with no charm (AES-ECB). Fast and tidy, and two identical blocks come out looking identical. The stone accepts any seal it can read.`,
    other: `<b>Morgan's binding.</b> Petitions are sealed with an authenticated binding (AES-GCM). Change one byte and the seal breaks.`,
  },
  oracle: {
    inquisitor: `<b>Merlin reads, but never speaks.</b> Bring him a scroll in hex, charm first, then the chained seals. He opens it with the King's key and tells you only one thing: whether the vision is <i>clear</i> (it ends in a well-formed seal) or <i>clouded</i>. His tower also accepts a satchel of up to 256 scrolls at once through the clerks' window.`,
    other: `<b>Merlin reads, but never speaks.</b> He calls a scroll <i>clear</i> only when its binding is whole. A forged or altered scroll is always clouded, and he says nothing more.`,
  },
};

export function hallPage(level) {
  return page('Great Hall', '/', `
<!-- scribe's draft, do not publish: HVWA{1s_th1s_c0rr3ct?} -->
<section class="decree">
  <div class="seal" aria-hidden="true">ROYAL<br>DECREE</div>
  <div class="eyebrow">Hear ye, hear ye</div>
  <h1>The King cannot sleep.</h1>
  <p class="lede">On the seventh night King Arthur dreamt, and a hooded stranger whispered a riddle in his ear. Since then the King has not slept a wink. He wrote the dream down, sealed the scroll, and refuses to say what is in it.</p>
  <p><b>By royal decree:</b> whoever can tell the King his own dream, without being told it, or arrives bearing the seal of a knight, may try the sword in the stone. The one who draws Excalibur shall be named <b>True Knight of the Round Table</b>.</p>
  <div class="riddle" aria-label="The stranger's riddle">${esc(RIDDLE)}</div>
</section>
<div class="grid">
  <div class="card"><h3>The Dream Scroll</h3><p>The sealed scroll hangs in the Great Hall for anyone to copy. Reading it is another matter.</p><a class="go" href="/dream">Study the scroll →</a></div>
  <div class="card"><h3>Petitioners' Desk</h3><p>Every petitioner is given a seal with their name and rank. Most of you are peasants. Sorry.</p><a class="go" href="/petition">Take a number →</a></div>
  <div class="card"><h3>Merlin's Tower</h3><p>The wizard will look at any scroll you bring and tell you how the vision feels. Only that.</p><a class="go" href="/oracle">Climb the stairs →</a></div>
  <div class="card"><h3>The Sword in the Stone</h3><p>Speak the words of the dream, or show a knight's seal, and pull.</p><a class="go" href="/stone">Approach the stone →</a></div>
</div>
<p class="note">Court tier: <b>${esc(TIER_NAMES[level] ?? level)}</b>. The clerks post the spell each room uses on the room itself.</p>`);
}

export function dreamPage(level, scroll) {
  return page('The Dream', '/dream', `
<div class="eyebrow">Hung in the Great Hall</div>
<h1>The King's sealed dream</h1>
<p class="lede">The scroll below is the dream itself, sealed. Tell it back to the King and the words in it will move the sword.</p>
<div class="note">${NOTES.dream[level]}</div>
<h2>The scroll (hex)</h2>
<div class="scroll" data-testid="dream-scroll">${esc(scroll)}</div>
<p>Also available to clerks as <code>GET /api/dream</code>.</p>`);
}

export function petitionPage(level, { name, seal, error } = {}) {
  const note = level === 'templar' ? NOTES.petition.templar : NOTES.petition.other;
  const result = seal
    ? `<div class="verdict ok">The scribe stamps your petition. Seal for <b>${esc(name)}</b>:</div><div class="scroll" data-testid="seal">${esc(seal)}</div>`
    : error ? `<div class="verdict no">${esc(error)}</div>` : '';
  return page('Petitioners', '/petition', `
<div class="eyebrow">Take a number</div>
<h1>Petitioners' Desk</h1>
<p class="lede">Give your name and the scribe will seal a petition for you. Every seal records exactly <code>petitioner=&lt;your name&gt;;rank=peasant</code>. The rank is not negotiable.</p>
<div class="note">${note}</div>
<form class="f" method="post" action="/petition">
  <label for="name">Your name (1 to 64 characters, no <code>;</code> or <code>=</code>)</label>
  <input id="name" name="name" type="text" maxlength="64" required autocomplete="off" value="${esc(name ?? '')}">
  <button type="submit">Request a seal</button>
</form>
${result}
<p>Clerks: <code>POST /api/petition</code> with JSON <code>{"name": "..."}</code> returns <code>{"seal": "&lt;hex&gt;"}</code>. JSON strings may carry any byte from 0x01 to 0x7e.</p>`);
}

export function oraclePage(level, { scroll, verdict } = {}) {
  const note = level === 'inquisitor' ? NOTES.oracle.inquisitor : NOTES.oracle.other;
  const result = verdict
    ? `<div class="verdict ${verdict === 'clear' ? 'ok' : 'no'}" data-testid="verdict">Merlin squints at your scroll. "The vision is <b>${verdict}</b>."</div>`
    : '';
  return page("Merlin's Tower", '/oracle', `
<div class="eyebrow">Two hundred and twelve steps</div>
<h1>Merlin's Tower</h1>
<p class="lede">"Bring me a scroll and I shall tell you how it feels. I do not read dreams aloud. The King was very clear about that."</p>
<div class="note">${note}</div>
<form class="f" method="post" action="/oracle">
  <label for="scroll">A scroll (hex)</label>
  <textarea id="scroll" name="scroll" required spellcheck="false">${esc(scroll ?? '')}</textarea>
  <button type="submit">Hand it to Merlin</button>
</form>
${result}
<p>Clerks: <code>POST /api/oracle</code> with JSON <code>{"scrolls": ["&lt;hex&gt;", ...]}</code> (at most 256) returns <code>{"visions": ["clear" | "clouded", ...]}</code> in the same order.</p>`);
}

export function stonePage(level, { outcome, flag, petitioner } = {}) {
  let result = '';
  if (outcome === 'knighted') {
    const who = petitioner ? `Sir ${esc(petitioner)}` : 'stranger';
    result = flag
      ? `<div class="verdict ok" data-testid="knighted">Excalibur slides free with a sound like a bell. The court falls silent. <b>Arise, ${who}, True Knight of the Round Table.</b></div><p>Your writ of knighthood:</p><div class="flag" data-testid="flag">${esc(flag)}</div>`
      : `<div class="verdict ok" data-testid="knighted">The sword moves. (This is the secure reference court: there is no writ to win here.)</div>`;
  } else if (outcome === 'refused') {
    result = `<div class="verdict no" data-testid="refused">You pull until your ears go red. The sword does not move. Somewhere, Sir Kay laughs.</div>`;
  }
  return page('The Stone', '/stone', `
<div class="eyebrow">The courtyard</div>
<h1>The Sword in the Stone</h1>
<p class="lede">Speak the three words from the King's dream, or lay a seal of knightly rank upon the stone, and pull.</p>
<form class="f" method="post" action="/stone">
  <label for="words">The words of the dream</label>
  <input id="words" name="words" type="text" maxlength="128" autocomplete="off" placeholder="word-word-word">
  <label for="seal">Or a petition seal (hex)</label>
  <textarea id="seal" name="seal" spellcheck="false"></textarea>
  <button type="submit">Pull</button>
</form>
${result}
<p>Clerks: <code>POST /api/stone</code> with JSON <code>{"words": "..."}</code> or <code>{"seal": "&lt;hex&gt;"}</code>.</p>`);
}

export function tablePage(knights) {
  const rows = knights.map((k) => `<tr${k.seat === 12 ? ' class="perilous"' : ''}><td>${k.seat}</td><td>${esc(k.name)}</td><td>${esc(k.note)}</td></tr>`).join('');
  return page('Round Table', '/table', `
<div class="eyebrow">Seating chart</div>
<h1>The Round Table</h1>
<p class="lede">Twelve seats. Eleven knights. One seat waits for the chosen one.</p>
<table><thead><tr><th>Seat</th><th>Knight</th><th>Court gossip</th></tr></thead><tbody>${rows}</tbody></table>`);
}

export function clerksPage() {
  return page('Clerks', '/clerks', `
<div class="eyebrow">For scribes, squires and scripts</div>
<h1>The Clerks' Window</h1>
<p class="lede">Every room of the court also answers in JSON, so that squires with scripts need not climb the tower by hand.</p>
<dl class="api">
  <dt>GET /api/dream</dt><dd>The sealed dream: <code>{"scroll": "&lt;hex&gt;"}</code>.</dd>
  <dt>POST /api/petition</dt><dd><code>{"name": "..."}</code> → <code>{"seal": "&lt;hex&gt;"}</code>. The seal records <code>petitioner=&lt;name&gt;;rank=peasant</code>.</dd>
  <dt>POST /api/oracle</dt><dd><code>{"scrolls": ["&lt;hex&gt;", ...]}</code> (1 to 256) → <code>{"visions": ["clear" | "clouded", ...]}</code>.</dd>
  <dt>POST /api/stone</dt><dd><code>{"words": "word-word-word"}</code> or <code>{"seal": "&lt;hex&gt;"}</code> → <code>{"knighted": true | false, ...}</code>.</dd>
</dl>`);
}

export function notFoundPage() {
  return page('Lost', '', `<h1>You are lost in the castle.</h1><p class="lede">This corridor leads nowhere. The <a href="/">Great Hall</a> is back that way.</p>`);
}
