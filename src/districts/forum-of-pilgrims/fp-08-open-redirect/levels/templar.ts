// TEMPLAR — a naive allow-check: `next` must START WITH "/", i.e. be "a path on this site". A leading slash does not
// make a URL local: "//host/x" is protocol-relative (it keeps the scheme and takes YOUR host), and browsers read a
// backslash as a slash, so "/\host/x" means the same thing.
export function allowNext(next: string): boolean {
  return next.startsWith('/');
}
