// src/core/errors.ts
import type { ErrorRequestHandler } from 'express';

function htmlPage(status: number, label: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${status}</title></head>` +
    `<body><h1>${status} — ${label}</h1></body></html>`;
}

// Final error middleware. Never sends stack traces or error messages to the
// client: /api/* gets JSON, everything else a minimal HTML page. Client errors
// raised by body parsers (4xx with err.status) keep their status.
export function errorHandler(): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) { next(err); return; }
    const status = Number(err?.status ?? err?.statusCode);
    const clientError = Number.isInteger(status) && status >= 400 && status < 500;
    if (!clientError && process.env.NODE_ENV !== 'test') console.error(err);
    const path = req.originalUrl.split('?')[0];
    const isApi = path === '/api' || path.startsWith('/api/');
    const code = clientError ? status : 500;
    res.status(code);
    if (isApi) {
      res.json({ error: clientError ? 'bad_request' : 'internal_error' });
    } else {
      res.type('html').send(htmlPage(code, clientError ? 'Bad Request' : 'Internal Server Error'));
    }
  };
}
