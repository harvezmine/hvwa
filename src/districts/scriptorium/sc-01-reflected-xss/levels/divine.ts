import type { LabHeaders } from '../../../../core/http.js';
import { escapeHtml } from '../../../../core/render.js';

// DIVINE — secure reference: the query is escaped for each place it lands. In text, & < > " ' become entities; in the
// refine field the value is QUOTED and escaped the same way, so neither a tag nor a space nor a quote leaves it. That
// escaping is the fix. The Content-Security-Policy below is defence in depth only: were the escaping gone, the policy
// would block an inline script in a browser that honours it, but a CSP alone is not a fix (it differs per browser and
// per directive, and the XSS proof here does not count on it). Out of scope: there are no real search results; the
// lab's scrolls are not searched.
export const headers: LabHeaders = { csp: "script-src 'self'; object-src 'none'; base-uri 'none'" };

export function results(q: string): string {
  const shown = escapeHtml(q);
  return `<p>No scrolls match <b>${shown}</b>.</p>`
    + `<form class="refine"><label>Refine <input name="q" value="${shown}"></label> <button>Search again</button></form>`;
}
