// Reference solve — Camelot Court, Acolyte. The dream scroll is repeating-key XOR with a 12-byte key, and every dream
// starts with the crib "On the seventh night, " (22 bytes ≥ 12): crib XOR scroll gives the key, the key gives the
// dream, the dream gives the three words, and the words move the sword. Prints only the flag; on any refusal it exits
// 0 silently, like the other reference solves.
const base = process.argv[2];
if (!base) process.exit(0);

const CRIB = Buffer.from('On the seventh night, ', 'utf8');
const KEY_LENGTH = 12;

try {
  const { scroll } = await (await fetch(`${base}/api/dream`)).json();
  const ct = Buffer.from(String(scroll), 'hex');
  if (ct.length < CRIB.length) process.exit(0);
  const key = Buffer.alloc(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) key[i] = ct[i] ^ CRIB[i];
  const dream = Buffer.from(ct.map((b, i) => b ^ key[i % KEY_LENGTH])).toString('utf8');
  const words = dream.match(/speaks these words: ([a-z]+-[a-z]+-[a-z]+)/)?.[1];
  if (!words) process.exit(0);
  const res = await fetch(`${base}/api/stone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ words }),
  });
  const writ = (await res.json()).writ;
  if (typeof writ === 'string' && /^HVWA\{[a-z2-7]{26}\}$/.test(writ)) process.stdout.write(writ);
} catch { /* a refusal: stay quiet */ }
