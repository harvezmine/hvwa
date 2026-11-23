// labs/r01-mercy-clinic/app/render.mjs — the Mercy Clinic look (its own small CSS) and HTML helpers. No HVWA chrome,
// no endpoint list, no tool hints. User-supplied text is HTML-escaped; the SQL flaw is in db.mjs, not in the markup.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CATEGORY_CLASS = {
  'Clinic news': 'news',
  Prescriptions: 'prescriptions',
  Vaccinations: 'vaccinations',
  Parking: 'parking',
  'Opening hours': 'hours',
  Appointments: 'appointments',
  Community: 'community',
  'Staff rota': 'staff',
};

export const badge = (category) => {
  if (!category) return '';
  const cls = CATEGORY_CLASS[category] || 'general';
  return `<span class="badge badge-${cls}">${esc(category)}</span>`;
};

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

export function formatDayDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(d);
}

/** Escape text, wrapping each literal occurrence of `term` in <mark>. Every slice is escaped before it is emitted. */
export function highlight(text, term) {
  const raw = String(text ?? '');
  const needle = String(term ?? '').trim();
  if (!needle) return esc(raw);
  const hay = raw.toLowerCase();
  const lower = needle.toLowerCase();
  let out = '';
  let from = 0;
  let matches = 0;
  while (matches < 40) {
    const at = hay.indexOf(lower, from);
    if (at < 0) break;
    out += esc(raw.slice(from, at)) + '<mark>' + esc(raw.slice(at, at + needle.length)) + '</mark>';
    from = at + needle.length;
    matches += 1;
  }
  return out + esc(raw.slice(from));
}

export const initials = (name) => String(name || '')
  .replace(/^(Dr\.?|Sister|Nurse)\s+/i, '')
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0])
  .join('')
  .toUpperCase();

export const mark = (cls = 'brand-mark') => `<svg class="${cls}" viewBox="0 0 40 40" width="36" height="36" aria-hidden="true" focusable="false"><circle cx="20" cy="20" r="19" fill="currentColor" opacity=".16"/><path d="M17 8h6v9h9v6h-9v9h-6v-9H8v-6h9z" fill="currentColor"/></svg>`;

export const favicon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d6e6e"/><path d="M27 11h10v16h16v10H37v16H27V37H11V27h16z" fill="#fbf7ee"/></svg>';

const NAV = [
  ['/', 'Home', 'home'],
  ['/notices', 'Notices', 'notices'],
  ['/patients', 'Our team', 'team'],
  ['/departments', 'Departments', 'departments'],
  ['/appointments', 'Appointments', 'appointments'],
  ['/opening-hours', 'Opening hours', 'hours'],
  ['/about', 'About us', 'about'],
  ['/contact', 'Contact', 'contact'],
];

const navLinks = (active) => NAV.map(([href, label, key]) =>
  `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`).join('');

export function searchForm(q = '', id = 'q-home') {
  return `<form class="search" role="search" action="/search" method="get">`
    + `<label class="visually-hidden" for="${id}">Search clinic notices</label>`
    + `<input id="${id}" type="search" name="q" value="${esc(q)}" placeholder="Search notices, e.g. flu, parking, prescriptions" autocomplete="off">`
    + `<button type="submit" class="btn">Search</button></form>`;
}

/** The clinic's whole-card notice link. `meta` supplies date/author/category for rows from the public table. */
export function noticeCard(n, { term = '', meta = null } = {}) {
  const m = meta || n || {};
  const id = Number(n?.id) || 0;
  const title = term ? highlight(n.title, term) : esc(n.title);
  const body = term ? highlight(n.body, term) : esc(n.body);
  const when = formatDate(m.published_at);
  return `<article class="notice-card"><a class="notice-hit" href="/notices/${id}">`
    + `<span class="notice-top">${badge(m.category)}${when ? `<time datetime="${esc(m.published_at)}">${esc(when)}</time>` : ''}</span>`
    + `<h3>${title}</h3><p class="notice-body">${body}</p>`
    + `<span class="notice-foot"><span class="byline">${m.author ? esc(m.author) : 'Mercy Clinic'}</span><span class="more">Read notice →</span></span>`
    + `</a></article>`;
}

export function staffCard(p) {
  return `<article class="person"><span class="avatar" aria-hidden="true">${esc(initials(p.name))}</span><div>`
    + `<h3>${esc(p.name)}</h3>`
    + `<p class="role">${esc(p.role)}${p.pronouns ? ` <span class="pronouns">(${esc(p.pronouns)})</span>` : ''}</p>`
    + `<p class="person-meta">${esc(p.department)} · Room ${esc(p.room)} · ext ${esc(p.extension)}</p>`
    + `<p class="bio">${esc(p.bio)}</p></div></article>`;
}

export const stat = (value, label) => `<div class="stat"><strong>${esc(value)}</strong><span>${esc(label)}</span></div>`;

export const sectionHead = (title, linkHref, linkLabel) => `<div class="section-head"><h2>${esc(title)}</h2>`
  + (linkHref ? `<a class="text-link" href="${linkHref}">${esc(linkLabel)} →</a>` : '') + '</div>';

const CSS = `
:root{--teal:#0d6e6e;--teal-dark:#084f4f;--teal-soft:#e3f1ef;--ink:#17312f;--ink-soft:#46615e;--paper:#f6f1e6;--card:#fffdf8;--line:#dcd2bd;--accent:#9c5424;--accent-soft:#f7e6d7;--white:#fff;--serif:"Iowan Old Style","Palatino Linotype","Book Antiqua",Georgia,serif;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--shadow:0 1px 0 rgba(23,49,47,.05),0 10px 26px -18px rgba(23,49,47,.35)}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;font:16px/1.6 var(--sans);color:var(--ink);background:radial-gradient(circle at 12% 4%,rgba(13,110,110,.07),transparent 34rem),radial-gradient(circle at 90% 0%,rgba(185,107,50,.06),transparent 30rem),var(--paper)}
h1,h2,h3{font-family:var(--serif);line-height:1.2;color:var(--ink);margin:0 0 .5rem}
h1{font-size:clamp(2rem,5vw,3.15rem);letter-spacing:-.01em}
h2{font-size:clamp(1.45rem,3vw,2rem)}
h3{font-size:1.16rem}
p{margin:0 0 1rem}
a{color:var(--teal);text-underline-offset:3px}
a:hover{color:var(--teal-dark)}
:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:4px}
.wrap{width:min(1080px,100% - 2rem);margin-inline:auto}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.skip{position:absolute;left:1rem;top:-4rem;z-index:20;background:var(--ink);color:var(--white);padding:.6rem 1rem;border-radius:0 0 .5rem .5rem}
.skip:focus{top:0;color:var(--white)}
.site-head{background:linear-gradient(115deg,var(--teal-dark),var(--teal));color:#f8f3e9;border-bottom:4px solid var(--accent)}
.head-inner{display:flex;align-items:center;gap:1.25rem;min-height:86px;padding:.6rem 0;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.7rem;color:inherit;text-decoration:none;margin-right:auto}
.brand-mark{color:#f8f3e9;flex:none}
.brand-name{display:block;font-family:var(--serif);font-size:1.45rem;line-height:1.05;letter-spacing:.01em}
.brand-tag{display:block;font-size:.78rem;opacity:.92;letter-spacing:.03em}
.head-phone{color:#f8f3e9;text-decoration:none;border:1px solid rgba(255,255,255,.35);padding:.45rem .85rem;border-radius:999px;font-weight:600;font-size:.9rem;white-space:nowrap}
.head-phone:hover{background:rgba(255,255,255,.12);color:#fff}
.desktop-nav{display:flex;flex-wrap:wrap;gap:.15rem;align-items:center}
.desktop-nav a,.mobile-nav nav a{color:#f8f3e9;text-decoration:none;padding:.42rem .62rem;border-radius:7px;font-size:.92rem;font-weight:600;white-space:nowrap}
.desktop-nav a:hover,.mobile-nav nav a:hover{background:rgba(255,255,255,.13);color:#fff}
.desktop-nav a[aria-current="page"],.mobile-nav nav a[aria-current="page"]{background:rgba(255,255,255,.2);box-shadow:inset 0 -2px 0 var(--accent)}
.mobile-nav{display:none;position:relative;margin-left:auto}
.mobile-nav summary{cursor:pointer;list-style:none;border:1px solid rgba(255,255,255,.4);padding:.46rem .9rem;border-radius:999px;font-weight:700;font-size:.92rem}
.mobile-nav summary::-webkit-details-marker{display:none}
.mobile-nav summary::after{content:" ▾"}
.mobile-nav[open] summary::after{content:" ▴"}
.mobile-nav nav{position:absolute;right:0;top:calc(100% + .5rem);z-index:15;display:grid;min-width:13rem;background:var(--teal-dark);padding:.5rem;border-radius:12px;box-shadow:0 20px 40px -20px rgba(0,0,0,.55)}
.mobile-nav nav a{padding:.55rem .7rem}
main{padding:2rem 0 1rem}
.hero{display:grid;grid-template-columns:1.45fr .9fr;gap:2rem;align-items:start;padding:2.2rem 0 1.4rem}
.hero h1{margin-bottom:.7rem}
.eyebrow{margin:0 0 .7rem;color:var(--accent);font-weight:800;font-size:.78rem;letter-spacing:.14em;text-transform:uppercase}
.lede{font-size:1.12rem;color:var(--ink-soft);max-width:44ch}
.hero-panel{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:1.25rem;box-shadow:var(--shadow)}
.hero-panel h2{font-size:1.12rem;margin-bottom:.7rem}
.hero-panel p{font-size:.94rem;margin-bottom:.65rem}
.panel-rule{border:0;border-top:1px solid var(--line);margin:.9rem 0}
.search{display:flex;gap:.55rem;margin:1.1rem 0 .6rem;max-width:620px}
.search input{flex:1;min-width:0;padding:.78rem .9rem;border:1px solid var(--line);border-radius:10px;background:var(--white);font:inherit;color:var(--ink)}
.search input:focus{border-color:var(--teal)}
.btn{display:inline-block;padding:.72rem 1.15rem;border:1px solid transparent;border-radius:999px;background:var(--teal);color:#fff;font:inherit;font-weight:700;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--teal-dark);color:#fff}
.btn-secondary{background:transparent;color:var(--teal);border-color:var(--teal)}
.btn-secondary:hover{background:var(--teal-soft);color:var(--teal-dark)}
.quick-actions{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;margin:.4rem 0 0;padding:0}
.quick-actions a{display:inline-block;background:var(--card);border:1px solid var(--line);border-radius:999px;padding:.42rem .8rem;color:var(--ink);text-decoration:none;font-size:.9rem;font-weight:600}
.quick-actions a:hover{border-color:var(--teal);color:var(--teal-dark)}
.status-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:.8rem;margin:1.2rem 0 2.2rem}
.status-item{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--teal);border-radius:12px;padding:.85rem 1rem;box-shadow:var(--shadow)}
.status-label{display:block;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--ink-soft);font-weight:800;margin-bottom:.18rem}
.status-value{display:block;font-weight:700;line-height:1.35}
.status-value small{display:block;font-weight:500;color:var(--ink-soft);font-size:.82rem}
.dot{display:inline-block;width:.62rem;height:.62rem;border-radius:50%;background:#2f8f5b;margin-right:.38rem;vertical-align:.02em;box-shadow:0 0 0 3px rgba(47,143,91,.16)}
.dot.closed{background:var(--accent);box-shadow:0 0 0 3px rgba(185,107,50,.16)}
.section{margin:2.4rem 0}
.section-head{display:flex;align-items:baseline;justify-content:space-between;gap:1rem;margin-bottom:1rem}
.section-head h2{margin:0}
.text-link{font-weight:700;text-decoration:none;white-space:nowrap}
.text-link:hover{text-decoration:underline}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.8rem;margin:1.6rem 0 0}
.stat{background:var(--teal-soft);border-radius:12px;padding:.9rem 1rem;text-align:center}
.stat strong{display:block;font-family:var(--serif);font-size:1.55rem;line-height:1.1;color:var(--teal-dark)}
.stat span{font-size:.82rem;color:var(--ink-soft);font-weight:600}
.notice-grid,.team-grid,.dept-grid,.contact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(275px,1fr));gap:1rem}
.notice-card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease}
.notice-card:hover{transform:translateY(-3px);border-color:#c8bca2;box-shadow:0 2px 0 rgba(23,49,47,.05),0 18px 32px -20px rgba(23,49,47,.45)}
.notice-hit{display:flex;flex-direction:column;height:100%;padding:1.05rem 1.15rem;color:inherit;text-decoration:none}
.notice-hit:hover{color:inherit}
.notice-top{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;margin-bottom:.55rem;font-size:.8rem;color:var(--ink-soft)}
.notice-top time{font-weight:600}
.notice-card h3{margin:0 0 .45rem}
.notice-body{color:var(--ink-soft);margin:0 0 1rem;font-size:.95rem}
.notice-foot{display:flex;align-items:center;justify-content:space-between;gap:.6rem;margin-top:auto;padding-top:.7rem;border-top:1px dashed var(--line);font-size:.8rem;color:var(--ink-soft)}
.byline{font-weight:700;color:var(--ink-soft)}
.more{color:var(--teal);font-weight:800;white-space:nowrap}
.badge{display:inline-block;padding:.18rem .55rem;border-radius:999px;font-size:.7rem;font-weight:800;letter-spacing:.03em;text-transform:uppercase;background:#e6e1d5;color:#4d4638}
.badge-news{background:var(--teal-soft);color:#0a5555}
.badge-prescriptions{background:#e2ecf7;color:#274d73}
.badge-vaccinations{background:#e1f0df;color:#2f6330}
.badge-parking{background:#f7ecd2;color:#7a530d}
.badge-hours{background:#ece5f5;color:#4d3670}
.badge-appointments{background:#f7e0e3;color:#7a2b36}
.badge-community{background:#f3e6d6;color:#74461d}
.badge-staff{background:#e5e2dc;color:#45403a}
.badge-general{background:#e6e1d5;color:#4d4638}
.person{display:flex;gap:.9rem;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem;box-shadow:var(--shadow)}
.avatar{flex:none;display:grid;place-items:center;width:3.1rem;height:3.1rem;border-radius:50%;background:var(--teal);color:#fff;font-family:var(--serif);font-size:1.15rem;font-weight:700;letter-spacing:.02em}
.person h3{margin:0 0 .1rem;font-size:1.06rem}
.person p{margin:0 0 .35rem;font-size:.86rem}
.person .role{font-weight:700;color:var(--teal-dark)}
.person .pronouns{font-weight:500;color:var(--ink-soft)}
.person .person-meta{color:var(--ink-soft)}
.person .bio{color:var(--ink-soft);margin:.4rem 0 0;font-size:.86rem}
.panel{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1.3rem;box-shadow:var(--shadow)}
.panel h2{margin-top:0}
.callout{background:var(--accent-soft);border:1px solid #e6c6a8;border-left:5px solid var(--accent);border-radius:12px;padding:1rem 1.15rem;margin:1.4rem 0}
.callout h2,.callout h3{margin-top:0}
.callout p:last-child{margin-bottom:0}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
caption{text-align:left;padding:.85rem 1rem;font-family:var(--serif);font-size:1.1rem;font-weight:700;border-bottom:1px solid var(--line)}
th,td{padding:.65rem .85rem;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}
thead th{background:var(--teal-soft);color:var(--teal-dark);font-size:.76rem;text-transform:uppercase;letter-spacing:.08em}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even){background:#fbf8f0}
.notice-detail{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:1.6rem;box-shadow:var(--shadow);max-width:820px}
.notice-detail h1{margin:.55rem 0 .7rem}
.notice-detail .meta{display:flex;flex-wrap:wrap;gap:.55rem 1rem;color:var(--ink-soft);font-size:.9rem;margin-bottom:1.3rem;padding-bottom:1rem;border-bottom:1px solid var(--line)}
.notice-detail .body{font-size:1.05rem;color:var(--ink);white-space:pre-line}
.crumbs{font-size:.86rem;color:var(--ink-soft);margin-bottom:1rem}
.crumbs a{font-weight:600;text-decoration:none}
.crumbs a:hover{text-decoration:underline}
.result-summary{color:var(--ink-soft);margin:.2rem 0 1.2rem}
.result-summary strong{color:var(--ink)}
.no-results{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.3rem}
.suggestions{display:flex;flex-wrap:wrap;gap:.5rem;list-style:none;margin:.5rem 0 0;padding:0}
.chip{display:inline-block;background:var(--teal-soft);color:var(--teal-dark);border:1px solid #bcd9d5;padding:.32rem .72rem;border-radius:999px;text-decoration:none;font-size:.86rem;font-weight:700}
.chip:hover{background:#d3e9e6;color:var(--teal-dark)}
.chip[aria-current="true"]{background:var(--teal);color:#fff;border-color:var(--teal)}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.field{display:flex;flex-direction:column;gap:.3rem}
.field-full{grid-column:1/-1}
.field label{font-weight:700;font-size:.9rem}
.field .hint{font-size:.8rem;color:var(--ink-soft)}
.field input,.field select,.field textarea{width:100%;padding:.66rem .75rem;border:1px solid var(--line);border-radius:9px;background:var(--white);font:inherit;color:var(--ink)}
.field textarea{min-height:6.5rem;resize:vertical}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--teal)}
.check{display:flex;gap:.6rem;align-items:flex-start}
.check input{width:1.15rem;height:1.15rem;margin-top:.2rem;flex:none}
.check label{font-weight:500}
.form-actions{display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin-top:1.1rem}
.confirmation{background:#e6f2ea;border:1px solid #b9d8c3;border-left:5px solid #2f8f5b;border-radius:14px;padding:1.3rem 1.4rem;margin:1.2rem 0}
.confirmation h2{margin-top:0;color:#225c3b}
.confirmation .ref{display:inline-block;font-family:var(--serif);font-size:1.25rem;font-weight:700;background:#fff;border:1px dashed #8fbf9f;border-radius:8px;padding:.18rem .6rem;letter-spacing:.05em}
.error-summary{background:#fbeaea;border:1px solid #e6b9b9;border-left:5px solid #a33b3b;border-radius:14px;padding:1rem 1.2rem;margin:1rem 0;color:#6f2424}
.error-summary h2{margin-top:0;font-size:1.15rem;color:#6f2424}
.error-summary ul{margin:.4rem 0 0;padding-left:1.2rem}
.dept-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.15rem;box-shadow:var(--shadow)}
.dept-card h2{font-size:1.2rem;margin-bottom:.3rem}
.dept-card .dept-meta{font-size:.8rem;color:var(--ink-soft);font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:.6rem}
.dept-card p{font-size:.92rem;color:var(--ink-soft)}
.dept-card ul{margin:.4rem 0 0;padding-left:1.1rem;font-size:.9rem;color:var(--ink-soft)}
.dept-card li{margin-bottom:.2rem}
.contact-card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1.15rem;box-shadow:var(--shadow)}
.contact-card h2{font-size:1.15rem;margin-bottom:.35rem}
.contact-card p{margin:0 0 .45rem;color:var(--ink-soft);font-size:.94rem}
.contact-card a{font-weight:700;text-decoration:none}
.contact-card a:hover{text-decoration:underline}
.map-card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:1rem;box-shadow:var(--shadow)}
.map-card svg{display:block;width:100%;height:auto;border-radius:10px;background:#eef3e9}
.map-card figcaption{font-size:.8rem;color:var(--ink-soft);margin-top:.55rem}
.timeline{list-style:none;margin:1rem 0 0;padding:0 0 0 1.2rem;border-left:3px solid #c9ddd9}
.timeline li{position:relative;padding:0 0 1.15rem 1rem}
.timeline li::before{content:"";position:absolute;left:-1.62rem;top:.42rem;width:.72rem;height:.72rem;border-radius:50%;background:var(--teal);box-shadow:0 0 0 3px var(--paper)}
.timeline strong{display:block;font-family:var(--serif);font-size:1.05rem}
.timeline span{color:var(--ink-soft);font-size:.92rem}
.values{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem;margin-top:1rem}
.value{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:1rem 1.1rem}
.value h3{margin-bottom:.25rem;color:var(--teal-dark)}
.value p{margin:0;color:var(--ink-soft);font-size:.92rem}
.faq details{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:.85rem 1rem;margin-bottom:.6rem}
.faq summary{font-weight:700;cursor:pointer}
.faq p{margin:.6rem 0 0;color:var(--ink-soft)}
.site-foot{background:linear-gradient(115deg,var(--teal-dark),var(--teal));color:#efe9dc;margin-top:3rem;padding:2.2rem 0 1.2rem}
.foot-grid{display:grid;grid-template-columns:1.3fr 1fr 1fr;gap:2rem}
.site-foot h2{font-family:var(--serif);font-size:1.15rem;color:#fff;margin:0 0 .55rem}
.site-foot p,.site-foot li{font-size:.88rem;color:#efe9dc}
.site-foot ul{list-style:none;margin:0;padding:0;display:grid;gap:.3rem}
.site-foot a{color:#fff;text-decoration:none}
.site-foot a:hover{text-decoration:underline}
.foot-bottom{border-top:1px solid rgba(255,255,255,.22);margin-top:1.6rem;padding-top:1rem;display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;justify-content:space-between;font-size:.78rem;color:#efe9dc}
.foot-mark{display:flex;align-items:center;gap:.55rem;margin-bottom:.6rem}
.foot-mark .brand-mark{color:#f8f3e9}
.not-found{text-align:center;padding:2rem 0}
.not-found .big{font-family:var(--serif);font-size:clamp(4rem,14vw,7rem);line-height:.9;color:var(--teal);margin:0}
.not-found .search{margin-inline:auto}
.empty{color:var(--ink-soft);font-style:italic}
mark{background:#ffe6a3;color:var(--ink);padding:0 .1em;border-radius:3px}
@media (max-width:900px){
  .desktop-nav{display:none}
  .mobile-nav{display:block}
  .hero{grid-template-columns:1fr;gap:1.4rem;padding-top:1.4rem}
  .foot-grid{grid-template-columns:1fr 1fr}
}
@media (max-width:620px){
  .head-inner{min-height:72px}
  .head-phone{display:none}
  .search{flex-direction:column}
  .search .btn{width:100%}
  .form-grid{grid-template-columns:1fr}
  .foot-grid{grid-template-columns:1fr}
  .notice-detail{padding:1.15rem}
  .section-head{align-items:flex-start;flex-direction:column;gap:.3rem}
}
@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{transition:none!important;animation:none!important}
  .notice-card:hover{transform:none}
}
`;

export function page(title, bodyHtml, { active = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    // A "forgotten" debug marker for the view-source crowd — a honeypot, not the flag (decoys.ts: d3bug_m0d3_g0tch4).
    + `<!-- TODO(ops): drop debug build marker before go-live — build=HVWA{d3bug_m0d3_g0tch4} -->`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="theme-color" content="#0d6e6e">`
    + `<meta name="description" content="Mercy Clinic is a community GP practice in Ashford, Kent. Book appointments, request repeat prescriptions and read patient notices.">`
    + `<title>${esc(title)} — Mercy Clinic</title>`
    + `<link rel="icon" type="image/svg+xml" href="/favicon.svg"><style>${CSS}</style></head><body>`
    + `<a class="skip" href="#main">Skip to content</a>`
    + `<header class="site-head"><div class="wrap head-inner">`
    + `<a class="brand" href="/">${mark()}<span><span class="brand-name">Mercy Clinic</span><span class="brand-tag">Caring for our community since 1996</span></span></a>`
    + `<nav class="desktop-nav" aria-label="Primary">${navLinks(active)}</nav>`
    + `<a class="head-phone" href="tel:+441233555014">01233 555 014</a>`
    + `<details class="mobile-nav"><summary>Menu</summary><nav aria-label="Mobile">${navLinks(active)}</nav></details>`
    + `</div></header>`
    + `<main id="main" class="wrap">${bodyHtml}</main>`
    + `<footer class="site-foot"><div class="wrap"><div class="foot-grid">`
    + `<div><div class="foot-mark">${mark()}<span class="brand-name">Mercy Clinic</span></div>`
    + `<p>A community GP practice in Ashford, Kent. Registered charity 1042887.</p>`
    + `<p>14 Willow Lane<br>Ashford, Kent TN23 4MC</p></div>`
    + `<div><h2>Visit us</h2><ul><li>Reception: 01233 555 014</li><li><a href="mailto:hello@mercyclinic.example">hello@mercyclinic.example</a></li>`
    + `<li><a href="/opening-hours">Opening hours</a></li><li><a href="/contact">Directions and parking</a></li></ul></div>`
    + `<div><h2>Patient services</h2><ul><li><a href="/appointments">Book an appointment</a></li><li><a href="/notices">Patient notices</a></li>`
    + `<li><a href="/departments">Our departments</a></li><li><a href="/about">About the practice</a></li></ul></div>`
    + `</div><div class="foot-bottom"><span>Mercy Clinic · Registered charity 1042887 · This portal is for patient use</span>`
    + `<span>Site reviewed November 2026 · All times UTC</span></div></div></footer></body></html>`;
}

export function notFoundPage() {
  return `<div class="not-found"><p class="big">404</p><h1>We could not find that page</h1>`
    + `<p class="lede">The page may have moved, or the link may be out of date. Try searching our patient notices instead.</p>`
    + searchForm('', 'q-404')
    + `<p><a class="btn btn-secondary" href="/">Return to the home page</a></p></div>`;
}

export function errorPage() {
  return `<div class="not-found"><p class="big">500</p><h1>Something went wrong</h1>`
    + `<p class="lede">We are sorry — the clinic portal could not complete that request. Please try again, or call reception on 01233 555 014.</p>`
    + `<p><a class="btn" href="/">Return to the home page</a></p></div>`;
}
