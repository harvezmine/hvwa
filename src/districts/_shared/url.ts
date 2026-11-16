// src/districts/_shared/url.ts — URL plumbing for the labs of every district. Not a challenge: nothing here is served
// by View Source, and no level's flaw lives here.

/**
 * `uri` with `params` appended to its query, as an authorization server does: the uri is otherwise left as given, and a
 * fragment stays last (params after the `#` would be part of the fragment, which a browser never sends).
 */
export function withParams(uri: string, params: Readonly<Record<string, string>>): string {
  const hash = uri.indexOf('#');
  const before = hash === -1 ? uri : uri.slice(0, hash);
  const fragment = hash === -1 ? '' : uri.slice(hash);
  return `${before}${before.includes('?') ? '&' : '?'}${new URLSearchParams(params).toString()}${fragment}`;
}
