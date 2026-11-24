# Camelot Court (r06): Cryptography (Medium, 4 tiers)

The first lab on the **Cipher Vault** board (`track: "crypto"`). King Arthur dreamt, a hooded stranger (Merlin)
whispered a riddle, and the King sealed the dream in a scroll he refuses to read aloud. By royal decree, whoever can
tell the King his own dream without being told it, or who arrives bearing a knight's seal, may try the sword in the
stone. Drawing Excalibur gives the writ of knighthood, which is the flag.

The theme is the public-domain Arthurian legend. Camelot Court is a fictional, deliberately vulnerable app with a
hand-built parchment UI (inline CSS and SVG, no external assets). It runs on the Node standard library only
(`node:http`, `node:crypto`, `node:fs`), is stateless (no sessions, no cookies) and keeps everything in memory.

## Runtime

- At start the app polls for the one-shot flag file (`HVWA_FLAG_FILE`, default `/tmp/.hvwa-flag`), reads it, unlinks it
  and holds it in memory. Divine has no flag.
- `app/court.mjs` mints the secrets once per start:
  - a 12-byte XOR key
  - a 16-byte block key (ECB/CBC)
  - a 32-byte GCM key
  - the **true words** (three random words from `seed/court.json`, joined by `-`)
- The dream plaintext is `seed/court.json` `dream` with the words substituted. It includes a decoy
  `HVWA{c10s3_but_n0_c1g4r}` "in the margin".
- The flag is rendered only by the stone (`POST /stone`, `POST /api/stone`) after a proof was accepted. It never
  appears in the environment, logs, hints or any GET page.
- Other decoys: an HTML comment on `/` (`HVWA{1s_th1s_c0rr3ct?}`), the `x-merlin-trace` JSON response header
  (`HVWA{h34d3r_hunt3r_lol}`) and `/robots.txt` (`HVWA{r0b0ts_txt_tr4p}`).
- Limits:
  - request bodies: 64 KiB (413 above that)
  - oracle satchel: at most 256 scrolls per request
  - seal hex: at most 1024 characters
  - scroll hex: at most 2048 characters
  - words: at most 128 characters
  - name: 1 to 64 characters, each 0x01 to 0x7e, no `;` or `=`

## Surfaces

| Route | What it does |
| --- | --- |
| `GET /dream`, `GET /api/dream` | The sealed dream (hex) |
| `POST /petition`, `POST /api/petition` `{name}` | A seal over `petitioner=<name>;rank=peasant` |
| `POST /oracle`, `POST /api/oracle` `{scrolls:[...]}` | Merlin's verdict per scroll: `clear` or `clouded` |
| `POST /stone`, `POST /api/stone` `{words}` or `{seal}` | Knighted (with the writ) for the true words or a seal whose `rank` is `knight` |
| `/` | Great Hall: the story, the riddle and a four-step quest map ("Start here" marks the weak room on each tier) |

The stone accepts both proofs at every tier. The tier changes only the cryptography behind each surface:

| Tier | Dream scroll | Petition seal | Merlin |
| --- | --- | --- | --- |
| Acolyte (Common) | **Repeating-key XOR**, 12-byte key | AES-256-GCM | GCM check (leaks nothing) |
| Templar (Dangerous) | AES-256-GCM | **AES-128-ECB** | GCM check |
| Inquisitor (Deadly) | **AES-128-CBC**, IV first | AES-256-GCM | **CBC padding oracle** |
| Divine (Warded) | AES-256-GCM | AES-256-GCM | GCM check |

Each room states, in one short line, which spell it uses on that tier; the weak one is tagged **Weak spell**. Every room
folds its JSON endpoint into a **For scripts** note. `/table` and `/clerks` (first edition) redirect to `/`.

## Reference solves

- **Acolyte** (`solve/acolyte.mjs`): every dream starts with the crib `"On the seventh night, "` (22 bytes). Since
  22 ≥ 12, crib ⊕ scroll gives the whole key. Decrypt, read the three words and speak them at the stone. The riddle
  carries both clues: "twelve knights keep watch in turn" and "seven nights the dream returns".
- **Templar** (`solve/templar.mjs`): ECB cut-and-paste.
  1. The name `"A"×15` makes blocks 0 and 1 read `petitioner=AAAAA` and `AAAAAAAAAA;rank=`.
  2. The name `"AAAAA" + "knight" + 0x0a×10` makes block 1 read `knight` followed by valid PKCS#7 padding.
  3. Joining A0, A1 and B1 decrypts to `petitioner=AAAAAAAAAAAAAAA;rank=knight`. Lay that seal on the stone.
- **Inquisitor** (`solve/inquisitor.mjs`): a Vaudenay CBC padding oracle, run through the 256-scroll satchel.
  1. Each request tests one byte with all 256 guesses.
  2. For pad 1, a false positive (`…02 02`) is ruled out by flipping the previous byte.
  3. For about 250 bytes of dream that is roughly 250 requests, about 1.2 s on a LAN.
  4. Read the words from the recovered plaintext and speak them at the stone.
- **Divine**: every surface is authenticated (GCM). Merlin calls a scroll `clear` only when it is authentic, so the
  oracle is useless. Every solve exits quietly.

Each solve prints only the flag and exits 0 silently on any refusal. A lower tier's solve fails against every higher
tier, because that tier's surface is GCM there.

## Defensive lessons

- **Never invent a cipher, and never reuse a keystream.** Repeating-key XOR with a known prefix gives up the key
  immediately. Use a vetted AEAD.
- **ECB is not a mode for data with structure.** Equal blocks encrypt equally and blocks can be rearranged, so
  encryption without authentication is malleable. A seal needs a MAC or an AEAD, not just a cipher.
- **Unauthenticated CBC plus any padding signal is a decryption oracle.** The signal can be an error message, a status
  code or a timing difference. Authenticate before you decrypt: AES-GCM, ChaCha20-Poly1305, or encrypt-then-MAC with a
  constant-time check. Then return one uniform error.
- **Fun fact:** Vaudenay described the padding-oracle attack in 2002. It later broke ASP.NET (2010) and, as POODLE,
  SSL 3.0 (2014).
