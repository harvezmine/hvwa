// Reference solve — Camelot Court, Templar. Petition seals are AES-128-ECB over `petitioner=<name>;rank=peasant`, so
// every 16-byte block is sealed alone and blocks can be cut and pasted:
//   name A = 15 × "A"   → "petitioner=AAAAA" | "AAAAAAAAAA;rank=" | "peasant" + pad      (keep blocks 0 and 1)
//   name B = "AAAAA" + "knight" + 10 × 0x0a → "petitioner=AAAAA" | "knight" + 0x0a×10 | ...   (keep block 1)
// A0 | A1 | B1 decrypts to `petitioner=AAAAAAAAAAAAAAA;rank=knight` with valid PKCS#7 padding. Lay it on the stone.
// Prints only the flag; on any refusal it exits 0 silently.
const base = process.argv[2];
if (!base) process.exit(0);

async function seal(name) {
  const res = await fetch(`${base}/api/petition`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const s = (await res.json()).seal;
  return typeof s === 'string' ? s : '';
}

try {
  const a = await seal('A'.repeat(15));
  const b = await seal(`AAAAAknight${'\n'.repeat(10)}`);
  if (a.length < 64 || b.length < 64) process.exit(0);
  const forged = a.slice(0, 64) + b.slice(32, 64); // hex: 32 chars per block
  const res = await fetch(`${base}/api/stone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seal: forged }),
  });
  const writ = (await res.json()).writ;
  if (typeof writ === 'string' && /^HVWA\{[a-z2-7]{26}\}$/.test(writ)) process.stdout.write(writ);
} catch { /* a refusal: stay quiet */ }
