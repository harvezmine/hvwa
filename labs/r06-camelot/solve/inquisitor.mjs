// Reference solve — Camelot Court, Inquisitor. The dream is AES-128-CBC (IV first) and Merlin is a padding oracle:
// POST /api/oracle answers "clear" for valid PKCS#7 padding and "clouded" otherwise, for up to 256 scrolls per request.
// For each ciphertext block C[i], forge a previous block P' and send P'|C[i]: when the padding is valid, the
// intermediate byte I = D(C[i]) at that position equals guess ^ pad. Walk from the last byte to the first (pad 1..16);
// one satchel of 256 guesses per byte. Plaintext = I ^ C[i-1]. Then speak the dream's words at the stone.
// Prints only the flag; on any refusal (no clear guess, e.g. an authenticated court) it exits 0 silently.
const base = process.argv[2];
if (!base) process.exit(0);
const B = 16;

async function oracle(scrolls) {
  const res = await fetch(`${base}/api/oracle`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scrolls }),
  });
  const v = (await res.json()).visions;
  if (!Array.isArray(v) || v.length !== scrolls.length) throw new Error('no oracle');
  return v.map((x) => x === 'clear');
}

/** Recover D(block) (the intermediate state) with the oracle. */
async function intermediate(block) {
  const inter = Buffer.alloc(B);
  for (let pad = 1; pad <= B; pad++) {
    const pos = B - pad;
    const prev = Buffer.alloc(B);
    for (let j = pos + 1; j < B; j++) prev[j] = inter[j] ^ pad;
    const scrolls = [];
    for (let g = 0; g < 256; g++) { prev[pos] = g; scrolls.push(Buffer.concat([prev, block]).toString('hex')); }
    const clear = await oracle(scrolls);
    let hits = clear.flatMap((ok, g) => (ok ? [g] : []));
    if (pad === 1 && hits.length > 1) {
      // A hit may be a longer valid padding (…02 02) by accident: flip the byte before and keep the guess that holds.
      const checks = hits.map((g) => { const p = Buffer.alloc(B); p[pos] = g; p[pos - 1] = 0xff; return Buffer.concat([p, block]).toString('hex'); });
      const still = await oracle(checks);
      hits = hits.filter((_, k) => still[k]);
    }
    if (hits.length !== 1) throw new Error('no clear guess');
    inter[pos] = hits[0] ^ pad;
  }
  return inter;
}

try {
  const { scroll } = await (await fetch(`${base}/api/dream`)).json();
  const ct = Buffer.from(String(scroll), 'hex');
  if (ct.length < 2 * B || ct.length % B !== 0) process.exit(0);
  const parts = [];
  for (let i = B; i < ct.length; i += B) {
    const inter = await intermediate(ct.subarray(i, i + B));
    parts.push(Buffer.from(inter.map((x, k) => x ^ ct[i - B + k])));
  }
  let plain = Buffer.concat(parts);
  plain = plain.subarray(0, plain.length - plain[plain.length - 1]);
  const words = plain.toString('utf8').match(/speaks these words: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
  if (!words) process.exit(0);
  const res = await fetch(`${base}/api/stone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words }),
  });
  const writ = (await res.json()).writ;
  if (typeof writ === 'string' && /^HVWA\{[a-z2-7]{26}\}$/.test(writ)) process.stdout.write(writ);
} catch { /* a refusal: stay quiet */ }
