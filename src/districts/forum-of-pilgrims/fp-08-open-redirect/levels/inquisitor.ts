// INQUISITOR — a real parse, subtly wrong. Like a browser, it first deletes every tab, CR and LF from `next` (WHATWG
// deletes them anywhere in a URL, so "/<TAB>/host" would otherwise sneak past as "/ /host" and still mean "//host").
// A path must then start with a single "/" ("//" and "/\" are refused, so the Templar tricks fail). An absolute http(s)
// URL is accepted when the authority part (what sits between "//" and the next "/", "?" or "#") CONTAINS citadel.test.
// Containing a name is not being that host: "citadel.test.<your-domain>" is a host of yours, and the same string can sit
// in userinfo or after a backslash (browsers read "\" as "/", so "http://<your-host>\@citadel.test/" goes to <your-host>).
export function allowNext(next: string): boolean {
  const seen = next.replace(/[\t\n\r]/g, ''); // what the browser will actually see
  const absolute = /^https?:\/\/([^/?#]*)/i.exec(seen);
  if (absolute === null) return /^\/(?![/\\])/.test(seen);
  return absolute[1].includes('citadel.test');
}
