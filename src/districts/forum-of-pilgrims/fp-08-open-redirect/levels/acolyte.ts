// ACOLYTE — no defense: the share link continues to whatever `next` says, verbatim. Any URL on any host is accepted, so a
// share link of your own making, opened by the admin, sends the admin's browser to your server.
export function allowNext(_next: string): boolean {
  return true;
}
