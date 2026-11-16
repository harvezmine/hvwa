// DIVINE — secure reference: the share link continues only to a RELATIVE PATH of this forum, chosen from a strict
// allowlist of characters: one leading "/" (never "//"), then letters, digits, "/", "_" and "-" only. No scheme, no
// authority, no backslash, no colon, no dot or percent escape: nothing a browser could read as another host. Anything
// else is refused (the page says so; nothing is sent anywhere). It never issues a flag.
// Out of scope here: signing the continue target (an HMAC over `next`) or mapping it to a page id server-side, which
// would also remove the free-form parameter, and logging refused targets.
export function allowNext(next: string): boolean {
  return /^\/(?!\/)[A-Za-z0-9/_-]{0,64}$/.test(next);
}
