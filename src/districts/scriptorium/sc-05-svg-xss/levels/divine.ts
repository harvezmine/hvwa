import { escapeHtml } from '../../../../core/render.js';
import type { Accepted, Review } from '../model.js';

// DIVINE — secure reference: untrusted SVG is never rendered as markup, in any page or as a document of its own. The
// review page shows the sigil's source as escaped text (its first 2000 characters) and links to the file, which is
// only ever a download: GET /sigil sends application/octet-stream, Content-Disposition: attachment, nosniff and a CSP
// sandbox (the same for both browsers and every level, see model.ts DOWNLOAD_HEADERS). The fix is the encoding and
// the download, not a CSP: the review page needs none. A DOCTYPE is refused: a sigil needs none, and no DTD should
// reach any XML parser. Verbosity: the lab shows "Invalid request." for any upload error at this level. Out of scope:
// drawing the sigil (the engine has no SVG rasterizer, so Divine shows no picture rather than inline markup), quotas.
const SHOWN = 2000;

export function accept(svg: string): Accepted {
  if (/<!DOCTYPE/i.test(svg)) return { ok: false, text: 'A DOCTYPE is not accepted in a sigil.' };
  return { ok: true, svg };
}

export function review(sigil: string): Review {
  return {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': 'inline' },
    body: `<h1>Sigil review</h1>\n<p>The sigil's source, as text (first ${SHOWN} characters):</p>\n`
      + `<pre>${escapeHtml(sigil.slice(0, SHOWN))}</pre>\n<p><a href="/sigil" download>Download the sigil</a></p>`,
  };
}
