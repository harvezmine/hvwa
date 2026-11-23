// labs/r02-courier/app/render.mjs — the Courier look: one small, hand-built CSS system (orange/navy logistics), the
// shared page shell, status/progress components and the printable-label document. No external assets, fonts or CDNs;
// the mark and favicon are inline SVG. Every interpolated value goes through esc(). No endpoint list, no hints.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">`
  + `<rect width="32" height="32" rx="8" fill="#f26a2e"/>`
  + `<path d="M7 11.5h18v9.5H7z" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/>`
  + `<path d="M7 11.5 16 18l9-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linejoin="round"/></svg>`;

const FAVICON = 'data:image/svg+xml,'
  + '%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 32 32%22%3E'
  + '%3Crect width=%2232%22 height=%2232%22 rx=%228%22 fill=%22%23f26a2e%22/%3E'
  + '%3Cpath d=%22M7 11.5h18v9.5H7z%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%222.4%22 stroke-linejoin=%22round%22/%3E'
  + '%3Cpath d=%22M7 11.5 16 18l9-6.5%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%222.4%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E';

const CSS = `
:root{--navy:#0d1b2f;--navy-2:#16294a;--ink:#122238;--muted:#61708a;
--orange:#f26a2e;--orange-deep:#d9541d;--orange-soft:#fff0e8;
--paper:#f4f1ec;--card:#fff;--line:#e6ded3;--line-2:#f0e9e0;
--green:#1e8f5c;--green-soft:#e8f6ee;--blue:#2b6cb0;--blue-soft:#eaf2fb;
--amber:#a96b12;--amber-soft:#fdf3df;--red:#c3472f;--red-soft:#fdeeea;
--shadow:0 10px 30px rgba(17,32,54,.07);--radius:16px}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--paper)}
a{color:var(--navy-2)}
img,svg{display:block;max-width:100%}
h1,h2,h3{line-height:1.15}
p{margin:0 0 12px}
.skip{position:absolute;left:-9999px;top:0;background:#fff;color:var(--navy);padding:10px 16px;border-radius:0 0 8px 0;z-index:50}
.skip:focus{left:0}
.site-header{position:sticky;top:0;z-index:20;background:rgba(13,27,47,.97);color:#fff;border-top:4px solid var(--orange)}
.header-inner{max-width:1120px;margin:0 auto;padding:11px 20px;display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:10px;color:#fff;text-decoration:none;font-weight:800;font-size:19px;letter-spacing:.2px}
.brand .mark{width:30px;height:30px;flex:none}
.nav{margin-left:auto;display:flex;gap:3px;overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.nav a{color:#bfcada;text-decoration:none;font-size:14px;font-weight:600;padding:8px 11px;border-radius:999px;white-space:nowrap}
.nav a:hover{color:#fff;background:rgba(255,255,255,.08)}
.nav a[aria-current="page"]{color:#fff;background:rgba(255,255,255,.12)}
.wrap{max-width:1120px;margin:0 auto;padding:30px 20px 58px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.4px}
.eyebrow{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;color:var(--orange-deep)}
.eyebrow .dot{width:7px;height:7px;border-radius:50%;background:var(--orange);box-shadow:0 0 0 4px var(--orange-soft)}
.lede{color:var(--muted);font-size:18px;max-width:46ch}
.fineprint{color:var(--muted);font-size:13px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--orange);color:#fff;border:1px solid var(--orange);border-radius:10px;padding:11px 18px;font-weight:750;font-size:14px;text-decoration:none;cursor:pointer;transition:transform .15s ease,background .15s ease,box-shadow .15s ease}
.btn:hover{background:var(--orange-deep);border-color:var(--orange-deep);transform:translateY(-1px);box-shadow:0 8px 18px rgba(242,106,46,.24)}
.btn.ghost{background:#fff;color:var(--navy);border-color:var(--line)}
.btn.ghost:hover{background:var(--paper);border-color:#d7cabb;box-shadow:none}
.btn.small{padding:8px 12px;font-size:12.5px;border-radius:8px}
.btn[aria-disabled="true"]{opacity:.55;cursor:not-allowed}
.hero{display:grid;grid-template-columns:1.08fr .92fr;gap:44px;align-items:center;padding:18px 0 10px}
.hero h1{font-size:clamp(36px,5.2vw,60px);letter-spacing:-2px;margin:12px 0 14px;line-height:1}
.hero h1 span{color:var(--orange)}
.actions{display:flex;gap:12px;flex-wrap:wrap;margin:26px 0 14px}
.hero-visual{background:var(--card);border:1px solid var(--line);border-radius:22px;box-shadow:var(--shadow);padding:20px}
.hv-top,.hv-bottom{display:flex;justify-content:space-between;align-items:center;gap:12px}
.hv-bottom{margin-top:12px;padding-top:14px;border-top:1px dashed var(--line)}
.hv-bottom span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.hv-bottom b{font-size:14px}
.route-svg{width:100%;height:auto;margin:8px 0}
.route-svg text{fill:var(--muted);font-size:12px;font-weight:700}
.route-svg .van{animation:bob 2.8s ease-in-out infinite}
@keyframes bob{50%{transform:translateY(-4px)}}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:30px 0}
.stat{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.stat b{display:block;font-size:26px;letter-spacing:-.6px}
.stat span{color:var(--muted);font-size:12.5px}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-top:16px}
.feature{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:20px;box-shadow:var(--shadow)}
.feature h3{margin:12px 0 6px;font-size:17px}
.feature p{margin:0;color:var(--muted);font-size:14px}
.feature .icon{width:40px;height:40px;border-radius:12px;background:var(--orange-soft);color:var(--orange-deep);display:flex;align-items:center;justify-content:center;font-weight:900}
.privacy{margin-top:26px;background:linear-gradient(135deg,var(--navy),var(--navy-2));color:#dfe7f3;border-radius:var(--radius);padding:22px 24px;display:flex;gap:18px;align-items:center;justify-content:space-between;flex-wrap:wrap}
.privacy h2{margin:0 0 4px;font-size:18px;color:#fff}
.privacy p{margin:0;color:#a9b8cc;font-size:14px;max-width:66ch}
.privacy .lock{width:48px;height:48px;border-radius:14px;background:rgba(242,106,46,.16);color:var(--orange);display:flex;align-items:center;justify-content:center;flex:none}
.page-head{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin:6px 0 22px;flex-wrap:wrap}
.page-head h1{margin:6px 0 4px;font-size:clamp(30px,4vw,42px);letter-spacing:-1.2px}
.page-head p{margin:0;color:var(--muted)}
.sync{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--muted);background:#fff;border:1px solid var(--line);border-radius:999px;padding:7px 13px}
.sync-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 0 3px var(--green-soft)}
.parcel-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(302px,1fr));gap:16px}
.parcel-card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:18px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:14px;transition:transform .18s ease,box-shadow .18s ease}
.parcel-card:hover{transform:translateY(-2px);box-shadow:0 16px 38px rgba(17,32,54,.11)}
.pc-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.pc-id{font-weight:850;font-size:17px;letter-spacing:-.2px}
.pc-id small{display:block;color:var(--muted);font-weight:600;font-size:11px;letter-spacing:.7px;text-transform:uppercase;margin-top:2px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:750;padding:5px 10px;border-radius:999px;white-space:nowrap;line-height:1.2}
.chip .chip-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
.chip.delivered{color:var(--green);background:var(--green-soft)}
.chip.out{color:var(--orange-deep);background:var(--orange-soft)}
.chip.transit{color:var(--blue);background:var(--blue-soft)}
.chip.held{color:var(--amber);background:var(--amber-soft)}
.chip.booked{color:var(--muted);background:#eef1f5}
.route{display:grid;grid-template-columns:18px 1fr;gap:4px 10px;font-size:13.5px;color:var(--ink)}
.route .pin{grid-row:span 2;display:flex;flex-direction:column;align-items:center;padding-top:4px}
.route .pin i{width:9px;height:9px;border-radius:50%;border:2px solid var(--orange);background:#fff}
.route .pin em{width:2px;flex:1;min-height:16px;background:repeating-linear-gradient(var(--orange) 0 3px,transparent 3px 6px);margin:3px 0}
.route .from{color:var(--muted);font-size:12.5px}
.route .to{font-weight:650}
.route .arrow{color:var(--orange);font-weight:800}
.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;background:var(--paper);border-radius:11px;padding:10px}
.meta span{display:block;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.55px}
.meta b{font-size:12.5px;display:block;line-height:1.3}
.pc-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:auto}
.progress{list-style:none;display:flex;padding:0;margin:4px 0 0}
.progress li{flex:1;position:relative;text-align:center;font-size:10px;color:var(--muted);line-height:1.25}
.progress li:before{content:"";position:absolute;top:5px;left:-50%;width:100%;height:2px;background:var(--line);z-index:0}
.progress li:first-child:before{display:none}
.progress .dot{display:block;width:11px;height:11px;border-radius:50%;background:#fff;border:2px solid var(--line);margin:0 auto 6px;position:relative;z-index:1}
.progress li.done:before{background:var(--orange)}
.progress li.done .dot{background:var(--orange);border-color:var(--orange)}
.progress li.now .dot{border-color:var(--orange);box-shadow:0 0 0 4px var(--orange-soft)}
.progress li.now .stage{color:var(--orange-deep);font-weight:800}
.panel{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow)}
.grid-2{display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px}
.grid-3{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.panel h2{margin:0 0 12px;font-size:19px}
.panel h3{margin:0 0 8px;font-size:16px}
.panel p:last-child{margin-bottom:0}
.rows{display:grid;gap:0}
.row{display:flex;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--line-2);font-size:14px}
.row:last-child{border-bottom:0}
.row span{color:var(--muted)}
.row b{text-align:right}
.preference{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--line-2);font-size:14px}
.preference:last-child{border-bottom:0}
.toggle{width:40px;height:22px;border-radius:999px;background:var(--green);position:relative;flex:none;opacity:.8}
.toggle:after{content:"";position:absolute;top:3px;right:3px;width:16px;height:16px;border-radius:50%;background:#fff}
.track-form{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 4px}
.track-form input{flex:1 1 220px;min-width:0;border:1px solid var(--line);background:#fff;border-radius:10px;padding:11px 14px;font:inherit;font-size:15px;color:var(--ink)}
.track-form input:focus{outline:3px solid var(--orange-soft);outline-offset:1px;border-color:var(--orange)}
.timeline{list-style:none;margin:6px 0 0;padding:0}
.timeline li{display:grid;grid-template-columns:18px 1fr;gap:12px;padding:0 0 20px;position:relative}
.timeline li:before{content:"";position:absolute;left:7px;top:18px;bottom:0;width:2px;background:var(--line)}
.timeline li:last-child{padding-bottom:0}
.timeline li:last-child:before{display:none}
.tl-dot{width:16px;height:16px;border-radius:50%;border:2px solid var(--line);background:#fff;margin-top:2px;position:relative;z-index:1}
.timeline li.latest .tl-dot{border-color:var(--orange);background:var(--orange);box-shadow:0 0 0 4px var(--orange-soft)}
.timeline strong{display:block;font-size:14px}
.tl-meta{color:var(--muted);font-size:12.5px}
.pricing{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.tier{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow);display:flex;flex-direction:column;gap:12px;position:relative}
.tier.featured{border-color:var(--orange);box-shadow:0 16px 40px rgba(242,106,46,.16)}
.tier .flag{position:absolute;top:-11px;left:20px;background:var(--orange);color:#fff;font-size:11px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;padding:3px 10px;border-radius:999px}
.tier .price{font-size:34px;font-weight:850;letter-spacing:-1px}
.tier .price small{font-size:13px;font-weight:600;color:var(--muted);letter-spacing:0}
.tier ul{list-style:none;margin:0;padding:0;display:grid;gap:8px;font-size:14px;color:var(--muted)}
.tier li:before{content:"✓";color:var(--orange-deep);font-weight:900;margin-right:8px}
.tier .btn{margin-top:auto}
details.faq{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:10px;box-shadow:var(--shadow)}
details.faq summary{cursor:pointer;font-weight:750;font-size:15px;list-style:none;display:flex;justify-content:space-between;gap:12px;align-items:center}
details.faq summary::-webkit-details-marker{display:none}
details.faq summary:after{content:"+";color:var(--orange);font-size:22px;font-weight:700;line-height:1}
details.faq[open] summary:after{content:"–"}
details.faq p{margin:12px 0 0;color:var(--muted);font-size:14px}
.empty-state{text-align:center;padding:56px 24px;background:var(--card);border:1px solid var(--line);border-radius:20px;box-shadow:var(--shadow)}
.empty-state .big{font-size:80px;font-weight:900;line-height:1;color:var(--orange);letter-spacing:-5px}
.empty-state h1{margin:10px 0 8px;font-size:26px;letter-spacing:-.6px}
.empty-state p{color:var(--muted);max-width:44ch;margin:0 auto 20px}
.label-sheet{background:#fff;border:1px solid var(--line);border-radius:16px;max-width:560px;margin:0 auto;padding:26px;box-shadow:var(--shadow)}
.label-top{display:flex;justify-content:space-between;align-items:center;gap:14px;border-bottom:2px solid var(--navy);padding-bottom:14px}
.label-top .brand{color:var(--navy)}
.label-top .tag{font-size:11px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:var(--orange-deep)}
.label-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:18px;margin:20px 0}
.label-grid h2{margin:0 0 4px;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.label-grid p{margin:0;font-size:15px;font-weight:650}
.label-meta{display:grid;gap:9px}
.label-meta div{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;border-bottom:1px dashed var(--line);padding-bottom:5px}
.label-meta span{color:var(--muted)}
.barcode-wrap{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;text-align:center}
.barcode{display:flex;align-items:flex-end;justify-content:center;gap:2px;height:62px}
.barcode i{display:block;background:var(--navy);height:100%}
.barcode-wrap .tracking-no{margin:9px 0 0;font-size:12px;letter-spacing:2.4px;color:var(--muted)}
.label-note{margin-top:18px;border:1px solid var(--line);background:var(--paper);border-radius:10px;padding:14px 16px}
.label-note h2{margin:0 0 6px;font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--muted)}
.label-note p{margin:0;font-size:14.5px;font-weight:600;overflow-wrap:anywhere}
.label-foot{margin-top:18px;color:var(--muted);font-size:11.5px;text-align:center}
.print-bar{max-width:560px;margin:16px auto 0;display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
.site-footer{background:var(--navy);color:#9fb0c9;margin-top:64px;padding:42px 20px 26px}
.footer-inner{max-width:1120px;margin:0 auto;display:grid;grid-template-columns:1.5fr 1fr 1fr;gap:28px}
.footer-inner p{color:#8ba0bd;font-size:13.5px;max-width:38ch;margin:12px 0 0}
.footer-inner h2{font-size:11px;letter-spacing:1.3px;text-transform:uppercase;color:#dce5f2;margin:4px 0 10px}
.footer-inner a{display:block;color:#9fb0c9;text-decoration:none;font-size:14px;padding:3px 0}
.footer-inner a:hover{color:#fff}
.footer-inner .brand{display:flex;color:#fff;padding:0;width:max-content}
.footer-inner .brand:hover{color:#fff}
.footer-base{max-width:1120px;margin:28px auto 0;border-top:1px solid rgba(255,255,255,.1);padding-top:16px;font-size:12px;color:#7287a3}
@media (max-width:980px){.hero{grid-template-columns:1fr;gap:26px}.hero-visual{order:-1}.stats{grid-template-columns:repeat(2,1fr)}}
@media (max-width:700px){.footer-inner{grid-template-columns:1fr 1fr}.footer-inner>div:first-child{grid-column:1/-1}}
@media (max-width:560px){.wrap{padding:22px 14px 42px}.header-inner{padding:10px 14px;gap:10px}.nav{margin-left:0;width:100%;order:3;flex-wrap:wrap;overflow:visible;gap:2px}.nav a{padding:7px 9px;font-size:13px}.hero h1{letter-spacing:-1px}.actions .btn{flex:1 1 100%}.meta{grid-template-columns:1fr 1fr}.meta>div:last-child{grid-column:1/-1}.parcel-grid{grid-template-columns:1fr}.label-grid{grid-template-columns:1fr}.footer-inner{grid-template-columns:1fr}.stat b{font-size:22px}}
@media print{.site-header,.site-footer,.no-print,.print-bar{display:none!important}body{background:#fff}.wrap{padding:0}.parcel-card,.panel{box-shadow:none}}
@media (prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important}}
`;

const LABEL_CSS = `
*{box-sizing:border-box}
body{margin:0;font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#122238;background:#f4f1ec;padding:28px 16px}
${CSS}
.label-page{padding:0}
@media print{@page{size:A6;margin:8mm}body{background:#fff;padding:0}.no-print{display:none!important}.label-sheet{box-shadow:none;border:1px solid #111;margin:0;max-width:none}.barcode i{background:#000}}
`;

const NAV = [['/dashboard', 'Dashboard'], ['/track', 'Track'], ['/pricing', 'Pricing'], ['/support', 'Support'], ['/account', 'Account']];

function header(active) {
  const links = NAV.map(([href, label]) =>
    `<a href="${href}"${href === active ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<header class="site-header"><div class="header-inner">`
    + `<a class="brand" href="/">${MARK}<span>Courier</span></a>`
    + `<nav class="nav" aria-label="Main">${links}</nav>`
    + `</div></header>`;
}

function footer() {
  return `<footer class="site-footer"><div class="footer-inner">`
    + `<div><a class="brand" href="/">${MARK}<span>Courier</span></a>`
    + `<p>Parcel tracking for people who like to know exactly where things are.</p></div>`
    + `<div><h2>Product</h2><a href="/pricing">Pricing</a><a href="/track">Track a parcel</a><a href="/dashboard">Dashboard</a></div>`
    + `<div><h2>Company</h2><a href="/support">Support</a><a href="/faq">FAQ</a><a href="/account">Account</a></div>`
    + `</div><p class="footer-base">© 2026 Courier Logistics · Demonstration environment · No real parcels are harmed.</p></footer>`;
}

/** The whole site shell. `body` must already be escaped/trusted HTML built by the page helpers. */
export function page(title, body, { active = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    // Honeypot for the view-source crowd — a decoy, not the flag (decoys.ts: 1s_th1s_c0rr3ct?).
    + `<!-- staging note: tracking key = HVWA{1s_th1s_c0rr3ct?} -->`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="theme-color" content="#0d1b2f">`
    + `<meta name="description" content="Courier parcel tracking — follow every parcel from depot to door.">`
    + `<title>${esc(title)} — Courier</title>`
    + `<link rel="icon" href="${FAVICON}">`
    + `<style>${CSS}</style></head><body>`
    + `<a class="skip" href="#main">Skip to content</a>`
    + header(active)
    + `<main id="main" class="wrap">${body}</main>`
    + footer()
    + `</body></html>`;
}

const TONE = (status) => {
  const s = String(status).toLowerCase();
  if (s.includes('delivered')) return 'delivered';
  if (s.includes('out for delivery')) return 'out';
  if (s.includes('in transit')) return 'transit';
  if (s.includes('held') || s.includes('depot')) return 'held';
  return 'booked';
};

export function statusChip(status) {
  return `<span class="chip ${TONE(status)}"><span class="chip-dot" aria-hidden="true"></span>${esc(status)}</span>`;
}

const STAGES = ['Depot', 'In transit', 'Out for delivery', 'Delivered'];

/** 0 = at/before depot, 1 = line-haul, 2 = final mile, 3 = delivered. */
function stageRank(status) {
  const s = String(status).toLowerCase();
  if (s.includes('delivered')) return 3;
  if (s.includes('out for delivery')) return 2;
  if (s.includes('in transit')) return 1;
  return 0;
}

export function progress(status) {
  const rank = stageRank(status);
  const items = STAGES.map((label, i) => {
    const cls = i < rank ? 'done' : i === rank ? 'now' : '';
    const current = i === rank ? ' aria-current="step"' : '';
    return `<li class="${cls}"${current}><span class="dot" aria-hidden="true"></span><span class="stage">${label}</span></li>`;
  }).join('');
  return `<ol class="progress" aria-label="Delivery progress">${items}</ol>`;
}

/** A CSS barcode derived deterministically from the parcel id — printable and stable, no external assets. */
export function barcode(id) {
  let seed = (Number(id) * 2654435761) >>> 0;
  let bars = '';
  for (let i = 0; i < 52; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const w = 1 + (seed % 3);
    const h = 64 + ((seed >>> 7) % 36);
    bars += `<i style="width:${w}px;height:${h}%"></i>`;
  }
  return `<div class="barcode" role="img" aria-label="Tracking barcode for parcel ${esc(id)}">${bars}</div>`;
}

export function timeline(events) {
  const list = Array.isArray(events) && events.length ? [...events].reverse() : [];
  if (!list.length) return '<p class="fineprint">No scans recorded yet.</p>';
  const items = list.map((e, i) =>
    `<li class="${i === 0 ? 'latest' : ''}"><span class="tl-dot" aria-hidden="true"></span><div>`
    + `<strong>${esc(e.status ?? 'Scan')}</strong>`
    + `<span class="tl-meta">${esc(e.at ?? '')}${e.place ? ` · ${esc(e.place)}` : ''}</span>`
    + `</div></li>`).join('');
  return `<ol class="timeline" aria-label="Scan history">${items}</ol>`;
}

/** One dashboard card. The private note is deliberately never rendered here. */
export function parcelCard(p) {
  return `<article class="parcel-card" id="parcel-${p.id}" data-parcel="${p.id}">`
    + `<div class="pc-head"><div class="pc-id">Parcel ${p.id}<small>${esc(p.service ?? 'Courier Standard')}</small></div>${statusChip(p.status)}</div>`
    + `<div class="route"><span class="pin" aria-hidden="true"><i></i><em></em></span>`
    + `<span class="from">From ${esc(p.from ?? 'Courier network')}</span>`
    + `<span class="to">${esc(p.to)}</span></div>`
    + `<div class="meta">`
    + `<div><span>Service</span><b>${esc(p.service ?? 'Standard')}</b></div>`
    + `<div><span>Weight</span><b>${esc(p.weight ?? '—')}</b></div>`
    + `<div><span>ETA</span><b data-eta>${esc(p.eta ?? '—')}</b></div>`
    + `</div>`
    + progress(p.status)
    + `<div class="pc-actions"><a class="btn small ghost" href="/track?id=${p.id}">Track</a>`
    + `<a class="btn small" href="/api/parcels/${p.id}/label" target="_blank" rel="noopener">Print label</a></div>`
    + `</article>`;
}

/** The printable label delivered by the label route when the client asks for HTML. */
export function labelDocument(parcel) {
  const id = parcel.id;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>Label ${esc(id)} — Courier</title>`
    + `<link rel="icon" href="${FAVICON}">`
    + `<style>${LABEL_CSS}</style></head><body class="label-page">`
    + `<main class="label-sheet">`
    + `<div class="label-top"><span class="brand">${MARK}<span>Courier</span></span><span class="tag">Priority parcel label</span></div>`
    + `<div class="label-grid">`
    + `<div><h2>Deliver to</h2><p>${esc(parcel.to)}</p></div>`
    + `<div class="label-meta">`
    + `<div><span>Parcel</span><b>${esc(id)}</b></div>`
    + `<div><span>Service</span><b>${esc(parcel.service ?? 'Standard')}</b></div>`
    + `<div><span>Weight</span><b>${esc(parcel.weight ?? '—')}</b></div>`
    + `<div><span>ETA</span><b>${esc(parcel.eta ?? '—')}</b></div>`
    + `</div></div>`
    + `<div class="barcode-wrap">${barcode(id)}<p class="tracking-no">CR ${esc(id)} ${esc(String(parcel.status ?? 'PARCEL').toUpperCase())}</p></div>`
    + `<section class="label-note"><h2>Private delivery note</h2><p>${esc(parcel.labelNote ?? parcel.note)}</p></section>`
    + `<p class="label-foot">Courier · Depot to door · This label is generated for the signed-in customer.</p>`
    + `</main>`
    + `<div class="print-bar no-print"><button class="btn" id="print-btn" type="button">Print label</button>`
    + `<a class="btn ghost" href="/dashboard">Back to dashboard</a></div>`
    + `<script>var b=document.getElementById("print-btn");if(b){b.addEventListener("click",function(){window.print();});}</script>`
    + `</body></html>`;
}
