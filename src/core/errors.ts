// src/core/errors.ts — 404 and error responses that never leak internals.
import { STATUS_CODES } from 'node:http';
import { escapeHtml } from './render.js';
import { t, isLang, DEFAULT_LANG, type Lang } from './i18n.js';
import { NewSessionLimitError } from './lab.js';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';

function isApi(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return path === '/api' || path.startsWith('/api/');
}

/** 'Payload Too Large' → 'payload_too_large'. */
function codeFor(status: number): string {
  return (STATUS_CODES[status] ?? 'error').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// A friendly, self-contained page (no layout render, so an error can never loop through the view engine): the
// status, a plain explanation and a way home, in the request's language and theme when the middleware got that far.
function htmlPage(status: number, res: Response): string {
  const label = STATUS_CODES[status] ?? 'Error';
  const lang: Lang = isLang(res.locals?.lang) ? res.locals.lang : DEFAULT_LANG;
  const theme = res.locals?.uiTheme === 'dark' || res.locals?.uiTheme === 'light' ? ` data-theme="${res.locals.uiTheme}"` : '';
  const kind = status === 404 ? 'not_found' : status < 500 ? 'client' : 'server';
  const mark = '<svg class="brand-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M12 2.5c-3.9 2.1-6.5 5.6-6.5 9.7v9.3h13v-9.3c0-4.1-2.6-7.6-6.5-9.7Z"/><path d="M3 21.5h18"/><circle cx="12" cy="12.5" r="2"/><path d="M12 14.5v3"/></svg>';
  return `<!doctype html><html lang="${lang}"${theme}><head><meta charset="utf-8">`
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light">'
    + `<title>${status} ${escapeHtml(label)}</title><link rel="stylesheet" href="/static/app.css"></head><body>`
    + `<header class="topbar"><div class="topbar-inner"><a href="/" class="brand">${mark}<span class="brand-name">HVWA</span></a></div></header>`
    + '<main class="content" id="main"><section class="error-page" data-status="' + status + '"><div>'
    + '<span class="error-seal" aria-hidden="true"><svg class="icon" viewBox="0 0 24 24" focusable="false"><use href="/static/icons.svg#i-empty-scroll"></use></svg></span>'
    + `<p class="error-code">${status} — ${escapeHtml(label)}</p>`
    + `<h1>${escapeHtml(t(`error.${kind}_title`, lang))}</h1>`
    + `<p>${escapeHtml(t(`error.${kind}_lead`, lang))}</p>`
    + `<a class="btn btn-primary" href="/">${escapeHtml(t('error.home', lang))}</a>`
    + '</div></section></main></body></html>';
}

// htmx callers (HX-Request) get a minimal fragment they can swap into their
// target: just the status label, escaped, no layout and no details.
function htmxFragment(status: number): string {
  const label = STATUS_CODES[status] ?? 'Error';
  return `<p data-error="${status}" role="alert">${status} — ${escapeHtml(label)}</p>`;
}

function send(req: Request, res: Response, status: number, apiError: string): void {
  res.status(status);
  if (isApi(req)) res.json({ error: apiError });
  else if (req.get('HX-Request') === 'true') res.type('html').send(htmxFragment(status));
  else res.type('html').send(htmlPage(status, res));
}

/** Final non-error middleware: JSON `{ error: 'not_found' }` for /api/*, minimal HTML otherwise. */
export function notFoundHandler(): RequestHandler {
  return (req, res) => { send(req, res, 404, 'not_found'); };
}

// Final error middleware. Never sends stack traces or error messages to the
// client. Client errors (4xx with err.status, e.g. from body parsers) keep
// their status and get a label from http.STATUS_CODES; anything else is a
// generic 500 `internal_error`.
export function errorHandler(): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) { next(err); return; }
    const status = Number(err?.status ?? err?.statusCode);
    const clientError = Number.isInteger(status) && status >= 400 && status < 500;
    if (!clientError && process.env.NODE_ENV !== 'test') console.error(err);
    if (err instanceof NewSessionLimitError && !isApi(req)) {
      res.status(429).type('text/plain').send('Too many new lab sessions — wait a minute and keep your cookie jar.');
      return;
    }
    if (clientError) send(req, res, status, codeFor(status));
    else send(req, res, 500, 'internal_error');
  };
}
