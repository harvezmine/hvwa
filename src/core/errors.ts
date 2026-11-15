// src/core/errors.ts — 404 and error responses that never leak internals.
import { STATUS_CODES } from 'node:http';
import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';

function isApi(req: Request): boolean {
  const path = req.originalUrl.split('?')[0];
  return path === '/api' || path.startsWith('/api/');
}

/** 'Payload Too Large' → 'payload_too_large'. */
function codeFor(status: number): string {
  return (STATUS_CODES[status] ?? 'error').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function htmlPage(status: number): string {
  const label = STATUS_CODES[status] ?? 'Error';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${status} ${label}</title></head>` +
    `<body><h1>${status} — ${label}</h1></body></html>`;
}

function send(req: Request, res: Response, status: number, apiError: string): void {
  res.status(status);
  if (isApi(req)) res.json({ error: apiError });
  else res.type('html').send(htmlPage(status));
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
    if (clientError) send(req, res, status, codeFor(status));
    else send(req, res, 500, 'internal_error');
  };
}
