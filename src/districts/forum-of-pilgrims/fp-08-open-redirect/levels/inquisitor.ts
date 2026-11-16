// INQUISITOR — a real parse, subtly wrong. A path must start with a single "/" ("//" and "/\" are refused, so the Templar
// tricks fail). An absolute http(s) URL is accepted when the authority part (what sits between "//" and the next "/", "?"
// or "#") CONTAINS citadel.test. Containing a name is not being that host: "citadel.test.<your-domain>" is a host of yours,
// and the same string can sit in userinfo or after a backslash (browsers read "\" as "/", so
// "http://<your-host>\@citadel.test/" goes to <your-host>).
export function allowNext(next: string): boolean {
  const absolute = /^https?:\/\/([^/?#]*)/i.exec(next);
  if (absolute === null) return /^\/(?![/\\])/.test(next);
  return absolute[1].includes('citadel.test');
}
