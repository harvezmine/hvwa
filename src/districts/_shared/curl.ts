// src/districts/_shared/curl.ts — the curl example a lab page shows, for the labs of every district (with the partial
// views/curl-note.ejs). Plumbing only: which path, header or body the example carries is the lab's choice.
// Not a challenge: nothing here is served by View Source.
import type { Request, Response } from 'express';
import { labPath } from '../../core/lab.js';

/** A curl example a player can actually use: the data `_shared/views/curl-note.ejs` renders. */
export interface CurlView {
  readonly url: string;
  /** '' for the default (GET, or POST when there is a body), else e.g. 'PUT'. */
  readonly method: string;
  readonly headers: readonly string[];
  readonly cookies: readonly string[];
  readonly data: string;
  /** Form fields, each already shell-quoted: `--data-urlencode '<field>'`. */
  readonly form: readonly string[];
  /**
   * Multipart parts, each already shell-quoted: `-F '<part>'`. Files first (in the order given), then the form
   * fields. Present only when the spec has files; then `form` is empty and the fields are here instead.
   */
  readonly multipart?: readonly string[];
  /** false for a lab the player never signs in to: the note says to open the page instead. Absent otherwise. */
  readonly signIn?: false;
}

/** A file part of a multipart example: `-F 'field=@filename;filename=sendAs;type=type'`. */
export interface CurlFile {
  readonly field: string;
  /** The local file (curl's `@path`), e.g. './local-file'. */
  readonly filename: string;
  /** The name the server receives, when it differs from the local one (`;filename=`). */
  readonly sendAs?: string;
  /** The content type to claim (`;type=`). */
  readonly type?: string;
}

export interface CurlSpec {
  /** Path below the lab, e.g. '/vault'. */
  readonly path: string;
  /** Extra headers, "Name: value" (use <placeholders>). */
  readonly headers?: readonly string[];
  /** Extra cookies besides the platform session, "name=value" (use <placeholders>). */
  readonly cookies?: readonly string[];
  /** An HTTP method for `-X` (PUT, PATCH, DELETE ...); omit for GET, or for a POST that has a body. */
  readonly method?: string;
  /** A request body (JSON), shown after `-d` in single quotes. */
  readonly data?: string;
  /** Form fields, sent with `--data-urlencode 'name=value'` (curl encodes them). */
  readonly form?: Readonly<Record<string, string>>;
  /** Files to upload: the example becomes multipart (`-F`), and `form` fields are sent as `-F 'name=value'` too. */
  readonly files?: readonly CurlFile[];
  /** false for a lab the player never signs in to (a shop whose customer is already signed in). Default true. */
  readonly signIn?: boolean;
}

/** Text for inside single quotes in a shell line: each `'` closes the quote, adds an escaped quote and reopens. */
export function shellQuote(text: string): string {
  return text.replace(/'/g, "'\\''");
}

/**
 * The curl example for a lab page. It always carries the FULL quoted URL (origin + canonical lab path + the served
 * level) and a `-b` for the platform session cookie with a placeholder: a lab belongs to the browser session, and curl
 * without it starts another session whose state and flags the browser cannot submit. Never prints the real session id.
 */
export function curlFor(req: Request, res: Response, spec: CurlSpec): CurlView {
  const files = (spec.files ?? []).map((f) =>
    shellQuote(`${f.field}=@${f.filename}${f.sendAs === undefined ? '' : `;filename=${f.sendAs}`}${f.type === undefined ? '' : `;type=${f.type}`}`));
  const fields = Object.entries(spec.form ?? {}).map(([k, v]) => shellQuote(`${k}=${v}`));
  const multipart = files.length > 0;
  const origin = `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`;
  return {
    url: `${origin}${labPath(res)}${spec.path}?level=${req.level}`,
    method: spec.method ?? '', headers: spec.headers ?? [], cookies: spec.cookies ?? [],
    data: shellQuote(spec.data ?? ''), form: multipart ? [] : fields,
    ...(multipart ? { multipart: [...files, ...fields] } : {}),
    ...(spec.signIn === false ? { signIn: false as const } : {}),
  };
}
