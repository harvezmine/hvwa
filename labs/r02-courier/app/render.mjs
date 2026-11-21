// labs/r02-courier/app/render.mjs — the Courier look (its own small CSS) and HTML helpers. No endpoint list, no hints.
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `
:root{--orange:#e8602c;--navy:#1f2a44;--paper:#fbf7f3;--line:#e5d8cc}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 "Segoe UI",system-ui,sans-serif;color:var(--navy);background:var(--paper)}
header{background:var(--navy);color:#fff;padding:16px 24px;display:flex;align-items:center;gap:12px}
header .dot{width:14px;height:14px;border-radius:50%;background:var(--orange)}header h1{margin:0;font-size:20px}
main{max-width:720px;margin:28px auto;padding:0 16px}
.btn{display:inline-block;background:var(--orange);color:#fff;border:0;border-radius:8px;padding:10px 18px;font-weight:700;text-decoration:none;cursor:pointer}
.parcel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
.parcel h3{margin:0 0 4px}.parcel .status{color:var(--orange);font-weight:600}
.parcel a{color:var(--navy);font-weight:600}
footer{color:#9a8b7d;font-size:12px;text-align:center;margin:40px 0 20px}
`;

export function page(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${esc(title)} — Courier</title><style>${CSS}</style></head><body>`
    + `<header><span class="dot"></span><h1>Courier</h1></header><main>${bodyHtml}`
    + `<footer>Courier • Track every step • Customer portal</footer></main></body></html>`;
}
