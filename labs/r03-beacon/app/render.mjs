// labs/r03-beacon/app/render.mjs — the Beacon "network gear" look (its own small CSS) and HTML helpers. Probe output is
// shown inside a <pre> and HTML-escaped; the injection is in the shell (diag.mjs), not in the markup.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--bg:#0f141b;--panel:#161d27;--line:#28323f;--lime:#8bd450;--ink:#d7e0ea;--mut:#7d8aa0}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 "DejaVu Sans Mono",ui-monospace,monospace;background:var(--bg);color:var(--ink)}
header{background:var(--panel);border-bottom:2px solid var(--lime);padding:14px 22px}
header h1{margin:0;font-size:18px;color:var(--lime);letter-spacing:1px}header span{color:var(--mut);font-size:12px}
main{max-width:740px;margin:24px auto;padding:0 16px}
nav a{color:var(--lime);text-decoration:none;margin-right:16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;margin:14px 0}
input,button{font:inherit}input{background:#0b0f15;border:1px solid var(--line);color:var(--ink);padding:9px;border-radius:6px;width:60%}
button{background:var(--lime);color:#0b0f15;border:0;border-radius:6px;padding:9px 16px;font-weight:700;cursor:pointer;margin-left:8px}
pre{background:#0b0f15;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;color:var(--ink)}
table{width:100%;border-collapse:collapse}td{border-bottom:1px solid var(--line);padding:7px 6px;color:var(--mut)}
`;

export function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} — Beacon</title><style>${CSS}</style></head><body>`
    + `<header><h1>BEACON</h1><span>Router administration</span></header>`
    + `<main><nav><a href="/">Dashboard</a><a href="/diagnostics">Diagnostics</a><a href="/status">Status</a></nav>${bodyHtml}</main></body></html>`;
}
