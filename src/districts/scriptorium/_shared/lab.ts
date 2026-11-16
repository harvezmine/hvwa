// src/districts/scriptorium/_shared/lab.ts — plumbing the Scriptorium's upload and file labs share: the player's
// notice, the upload route (uploadGate -> express.raw -> parseMultipart, docs/RECIPES.md section 9), how a name is
// shown, and the curl example for a multipart upload. Plumbing only: which names are refused, where a file lands and
// what "runs" are decided in each lab's levels/*.ts, never here. Not a challenge: nothing here is served by View Source.
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { curlFor, type CurlView } from '../../_shared/curl.js';
import { tryDb } from '../../../core/lab.js';
import {
  UPLOAD_LIMITS, parseMultipart, settle, uploadGate, type UploadLimits, type UploadedFile,
} from '../../../core/upload.js';

export type { Result } from '../../_shared/result.js';

/** The player's account in the Scriptorium's labs (they sign in to nothing: the lab page says who they are). */
export const PLAYER = 'pilgrim';

/**
 * A name or path as the lab page shows it: control characters (NUL, CR, LF ...) as visible \uXXXX escapes, so a name
 * that is "exactly as sent" can be read. The file system keeps the real characters; this is display only.
 */
export function visible(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** What `receive` makes of one POST: a refusal message, or the parsed form (the file in the named field, if any). */
export type Received =
  | { readonly ok: false; readonly text: string }
  | { readonly ok: true; readonly fields: Readonly<Record<string, string>>; readonly file: UploadedFile | undefined };

/**
 * Parse the raw multipart body `express.raw` read, through tryDb ('Upload error: <message>' below Divine, 'Invalid
 * request.' at Divine). The parse is awaited OUTSIDE tryDb (settle). One file at most; a lab that stores what it
 * receives passes `maxFileBytes: SIMFS_LIMITS.fileBytes`.
 */
export async function receive(req: Request, fileField: string, limits: Partial<UploadLimits> = {}): Promise<Received> {
  const up = tryDb(req, await settle(parseMultipart(req, { maxFiles: 1, ...limits })), 'Upload error');
  if (!up.ok) return { ok: false, text: up.message };
  return { ok: true, fields: up.value.fields, file: up.value.files.find((f) => f.field === fileField) };
}

/**
 * Mount the lab's upload at POST / (the page's form has no action, so it posts back to the page): uploadGate before
 * the body is read, then the raw multipart body on THIS route only (owner decision Q6) with the engine's cap. A body
 * over the cap gets the lab's own page at status 413 (`tooLarge`); any other error goes on to the platform handler.
 */
export function mountUpload(
  router: Router,
  handler: (req: Request, res: Response) => unknown,
  tooLarge: (req: Request, res: Response) => unknown,
): void {
  router.post('/', uploadGate(), express.raw({ type: 'multipart/form-data', limit: UPLOAD_LIMITS.maxBytes }), handler,
    (err: unknown, req: Request, res: Response, next: NextFunction) => {
      if ((err as { type?: unknown } | null)?.type !== 'entity.too.large') return next(err);
      res.status(413);
      return tooLarge(req, res);
    });
}

/** The multipart curl example of an upload form (the shared curl-note partial): the file's name and type spelled out. */
export function uploadCurl(req: Request, res: Response, field: string): CurlView {
  return curlFor(req, res, {
    path: '', signIn: false, form: { caption: '<text>' },
    files: [{ field, filename: './local-file', sendAs: '<name>', type: '<content type>' }],
  });
}
