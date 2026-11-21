// labs/r01-mercy-clinic/app/render.mjs — the Mercy Clinic look (its own small CSS) and HTML helpers. No HVWA chrome,
// no endpoint list, no tool hints. User-supplied text is HTML-escaped; the SQL flaw is in db.mjs, not in the markup.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--teal:#0e7c7b;--ink:#163a3a;--paper:#f3f8f8;--line:#cfe3e3}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--ink);background:var(--paper)}
header{background:var(--teal);color:#fff;padding:18px 24px}header h1{margin:0;font-size:20px;letter-spacing:.3px}
header p{margin:2px 0 0;opacity:.85;font-size:13px}
main{max-width:760px;margin:24px auto;padding:0 16px}
nav a{color:var(--teal);text-decoration:none;margin-right:16px;font-weight:600}
form.search{display:flex;gap:8px;margin:18px 0}
form.search input{flex:1;padding:10px;border:1px solid var(--line);border-radius:8px}
form.search button{padding:10px 16px;border:0;border-radius:8px;background:var(--teal);color:#fff;font-weight:600;cursor:pointer}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.card h3{margin:0 0 6px;font-size:16px}table{width:100%;border-collapse:collapse}
td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left}
footer{color:#6c8b8b;font-size:12px;text-align:center;margin:40px 0 20px}
`;

export function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} — Mercy Clinic</title><style>${CSS}</style></head><body>`
    + `<header><h1>Mercy Clinic</h1><p>Caring for our community since 1996</p></header>`
    + `<main><nav><a href="/">Home</a><a href="/patients">Our team</a></nav>${bodyHtml}`
    + `<footer>Mercy Clinic • Registered charity • This portal is for patient use</footer></main></body></html>`;
}

export const noticeCard = (n) => `<div class="card"><h3>${esc(n.title)}</h3><p>${esc(n.body)}</p></div>`;
