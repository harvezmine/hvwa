### Task group RM: Relic Market RM-01 … RM-14 (binding level designs)

Each lab follows **`docs/RECIPES.md`** and the real Gatekeeper code (GK-01 for SQL labs, GK-02 for clocks and counters, GK-12 for
IDOR, GK-14 for raw-body handling), exactly as Tasks 11–27 did: spec first (exploit matrix + lab-specific cases), then `model.ts`,
`levels/*.ts`, `challenge.ts`, `views/`, the district `index.ts` import, mutation self-check, `npm test`, `npm run typecheck`,
`npm run verify:dist`, commit `feat(relic-market): <ID> <title>`. District key `relic-market`, folders `rm-NN-<slug>`. Lab content
is English; title, summary and the three hints (cost 10/20/40) are bilingual and are drafted below for every lab.

**Execution: four batches, one implementer per batch (sequential, never parallel in one checkout), spec review + quality review per
batch.** The designs below are binding. Each level's flaw is distinct, so matrix case (g) holds: the exploit for level L is resisted
at every implemented level above L. No `cumulative` entries are needed anywhere in this district.

---

#### District rules that apply to every RM lab

- **Money is integer minor units** (US cents unless a lab says otherwise), held in JS numbers that are always safe integers.
  Percentages are `Math.floor(amount * pct / 100)` on integers. A discount never takes a running total below 0. Each lab states
  its own rounding rules below. Display goes through one formatter (`formatMoney`); no level code formats money.
- **The shopper is already signed in** as `pilgrim` (customer `C-1042`, `pilgrim@relic-market.test`) in every shop lab. There is
  no sign-in form, because authentication is not what these labs teach. All shop state is keyed by `hvwa_sid` through
  `perSession`, so it is per player and per level. RM-04 is the exception: it is a login lab with its own staff accounts
  (`pilgrim`/`pilgrim` and `relic_admin`, which mirror Gatekeeper's `PLAYER`/`citadel_admin`).
- **Every form on `GET /` posts back with no `action`** (so `describeLabView` passes). It posts to `<lab>?level=<level>` and carries a hidden
  `intent` field. The same handlers are also mounted on named paths (`POST <lab>/cart`, `/checkout`, `/cart/coupon`, ...) for curl
  and scripts. An unknown or missing `intent` answers 200 with `Unknown action.` (`lab-error`), never a 500.
- **Server-side catalog prices at every level**, except where the lab's flaw is the price itself (RM-09). Every route checks the SKU
  against the lab's catalog before calling a level (`Unknown product.`). Maps keyed by SKU therefore only ever hold catalog SKUs.
- **Flags.** The flag is shown only for a recorded fact that proves the flaw: a paid order, a balance or a result row. Each lab
  defines that fact as a predicate `proves(...)` in `model.ts`. It is the oracle, not the flaw, so it is never in a level file.
  The view-data builder adds `Flag: <flagFor(req, C)>` for each proving fact below Divine. It calls `flagFor` outside `tryDb`.
  Divine never shows a flag. A proof stays visible on the page (for example on the order row) after the action that made it.
- **Restart.** No RM lab has a limiter, lockout or attempt budget. Shop labs whose wallet, voucher or workflow can be spent into a
  dead end get `reset: (req) => labs.reset(req)` (RM-05, 06, 07, 08, 09, 10, 13, 14). Each spec asserts that Restart restores the
  starting wallet and empties the cart and orders, and that the flag can still be earned afterwards. Every proof is measured
  against the current instance (its own `startWallet`, its own voucher), so a reset never helps an exploit. RM-01–04, 11 and 12
  mutate nothing and have no Restart (`POST <lab>/_reset` is 404).
- **Platform-safety bounds live in `_shared/`, not in level files**, and a comment says "platform safety, not the lesson". The
  bounds are: cart ≤ 20 lines, orders ≤ 30 (oldest dropped), discounts ≤ 10, history lists ≤ 30, `|qty| ≤ 9 999 999 999`, stored
  free text clipped to 100 chars, wallet arithmetic asserted `Number.isSafeInteger`.

---

#### 1. Common shape: `src/districts/relic-market/_shared/` (built in Batch RM-A)

What is shared is plumbing only. Every parse rule, check, rounding rule, lock and query lives in the lab's `levels/*.ts`.

| File | Exports | Notes |
|---|---|---|
| `shop.ts` (pure) | `Product { sku, name, price, blurb }`, `catalogOf(products) → Catalog` (frozen; `get(sku)` is a `Map` lookup, never an object index), `CartLine { sku, qty, unitPrice, kind?: 'return' }`, `Discount { code, amount }`, `OrderLine { sku, name, qty, unitPrice, listPrice }`, `Order { no, owner, lines, discounts, subtotal, total, charged, status, at }`, `ShopState`, `newShop({ catalog, wallet })`, `setLine(state, line) → Result`, `pushOrder(state, order)`, `formatMoney(cents)`, `exactValue(lines) → bigint` (Σ `BigInt(listPrice) * BigInt(qty)`), `CUSTOMER`, `LIMITS` | `ShopState = { catalog, startWallet, wallet, cart, discounts, orders, nextOrderNo, clock, gate }`. `setLine` sets the line's quantity (0 removes it), refuses a 21st line (`Your cart is full (20 lines).`) and `\|qty\| > 9 999 999 999` (`Quantity too large for this shop.`), and stores what the level decided without judging it. `formatMoney` uses `Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })` on `cents / 100` and gives `-$10.00` for negatives. |
| `clock.ts` | `LabClock { now(): number; wait(ms): Promise<void> }`, `realClock`, `setClockForTests({ now?, wait? }) → restore` | `realClock.wait(ms)` is a real `setTimeout`, clamped to 0–5000 ms. This is the injectable clock that RM-03 delays and race windows use. Tests swap it per spec file (Vitest isolates module state per file). |
| `race.ts` | `Gate { arrive(): void; pass(ms): Promise<void> }`, `waitGate(clock)`, `KeyedMutex { run(key, fn) }` | Production `waitGate`: `arrive` is a no-op and `pass(ms)` is `clock.wait(ms)`, so the race window is real. `KeyedMutex` is a FIFO promise chain per key, deletes idle keys, and its callers pass constant keys only. |
| `sql.ts` | `firstRows(stmt, max, ...params)`, `clip(v, n = 200)`, `hardenSeed(raw)` | `firstRows` reads with `stmt.iterate()` and stops at `max` (the result cap where the player controls the query). `hardenSeed` (seed callback, raw handle) redefines `randomblob(n)` and `zeroblob(n)` with a 65 536-byte cap. Application-defined functions take precedence over SQLite built-ins, verified on Node 22.22 / SQLite 3.50.4. This blocks the one-call memory bombs and the heavy-query timing trick. |
| `staff-code.ts` | `redeemCode(req, challenge, secret, input, noun) → Result` | For the blind labs (RM-02 `noun = 'staff code'`, RM-03 `noun = 'vault PIN'`). Compares with `timingSafeEqual` on equal-length buffers. Below Divine: `<Noun> accepted. Flag: …`. At Divine: `<Noun> accepted.`. Otherwise: `Invalid <noun>.`. There is deliberately no limiter: an 8- or 6-hex-character code space is not a brute-force target, and the spec says so. |
| `shop-lab.ts` (Express) | `Result`, `mountIntents(router, intents, render)`, `shopView(req, res, state, extra)`, `welcome(req, challenge, who)`, `flagLine(req, challenge)` | `mountIntents` takes `{ [intent]: { path, run(req, res) → Outcome } }`. It mounts `POST /` (dispatch on `field(req, 'intent')`) and `POST <path>` for each intent, then calls `render(req, res, outcome)`. An `Outcome` is `{ result, status? }`. `shopView` builds the shared view data: `base` (= `labPath(res)`), `served` (the level, because `level` is a reserved view key), the customer, the wallet `{ cents, text }`, catalog rows, the cart with lines and totals as the lab computed them, orders with flag lines, and the `curl` view. |
| `views/` | `shop-header.ejs`, `catalog.ejs`, `cart.ejs`, `orders.ejs`, `api.ejs`, `staff-code.ejs`, `message.ejs` | Machine-readable hooks for tests and scripts: `data-testid="wallet" data-cents="…"`, `<li data-order="<no>" data-total data-charged data-status>`, `<tr data-sku data-qty data-line>`. The header always says `Signed in as <code>pilgrim</code>`. That is the `account` regex of `describeLabView`. |
| `shop-lab.testkit.ts` | `barrierGate(n, fallbackMs = 2000) → { gate, timedOut(), arrived() }`, `useInstantWaits()`, `useFakeClock() → { now() }`, `walletOf(html)`, `ordersOf(html)`, `cartOf(html)`, `describeShopBasics({ challenge, path, labState, hasRestart })` | `describeShopBasics` checks: GET / is 200 at every level, a purchase in one session leaves another session's wallet unchanged, levels are isolated, Restart restores the start state (and the cooldown answers 429) or `_reset` is 404, the 21st cart line is refused, orders are trimmed to 30, and money formatting (including negatives). |
| `shop.spec.ts` | unit tests of the shell | `setLine` bounds, `exactValue`, `formatMoney`, `KeyedMutex` FIFO order, and `barrierGate` (releases at n arrivals; the fallback sets `timedOut`). |

**How a lab creates its per-session shop** (typed, never `as`):

```ts
// rm-05 model.ts
export interface LabState extends ShopState { readonly owned: Map<string, number>; readonly returned: Map<string, number> }
const labs = perSession((): LabState => ({ ...newShop({ catalog: CATALOG, wallet: 5000 }), owned: new Map(), returned: new Map() }));
export const labFor = (req: { sessionId: string; level: Level }): LabState => labs.for(req);
export const labState = (sessionId: string, level: Level): LabState => labs.for({ sessionId, level }); // test seam
export const resetLab = (req: { sessionId: string; level: Level }): void => labs.reset(req);
```

`newShop` sets `clock: realClock` and `gate: waitGate(realClock)`. Tests replace `state.gate` on one session's instance through
the `labState` seam.

**Races (RM-07, RM-08): real in production, deterministic in tests.**

- The level code is `check → await state.gate.pass(WINDOW_MS) → update`. In production that `await` is a real timer, so two
  requests that arrive within the window really interleave on the Node event loop. Nothing about the race itself is simulated.
- The route calls `state.gate.arrive()` as its first statement, immediately before calling the level function. **Rule: a racy
  level function does no `await` before its check.** Arrival, check and the `await` must then run in one synchronous segment.
- In tests, `barrierGate(n)` makes the interleaving deterministic. Its `pass()` resolves once `n` requests have arrived; it counts
  requests that **arrived**, not requests that reached `pass`.
  - Run-to-completion guarantees that each request's synchronous segment (arrive, then check) finishes before any released
    continuation runs. Released waiters resume as microtasks, after the current segment ends.
  - So with `Promise.all([post, post])`, every request has done its check before any request does its update, whatever the
    network timing.
  - A Divine request that is refused before `pass` still counts as an arrival, so the barrier never deadlocks.
  - The 2 s fallback fires only on a regression, and the spec asserts `timedOut() === false`.
- Legit cases run with `useInstantWaits()` (in `beforeAll`), so no test ever waits for real time.

**Time-based (RM-03): the delay is simulated on the injectable clock.**

- The SQL `sleep(seconds)` function is registered in the seed with `raw.function('sleep', { directOnly: true }, fn)`. It never
  blocks. It adds `clamp(Number(s), 0, 5) * 1000` ms to the DB's own accumulator, and the accumulator is capped at 5000 ms.
- The route resets the accumulator, runs the query, then reads it, all in one synchronous section, because `node:sqlite` is
  synchronous. It then `await`s `realClock.wait(delayMs)` and answers.
- Tests call `useFakeClock()`: `wait(ms)` advances virtual time and resolves at once, and `now()` reads virtual time. An exploit
  script measures `clock.now()` before and after each request: the delay is exact, the test instant.
- Players measure real time with `curl -o /dev/null -s -w '%{time_total}\n' …`.

**curl.** The pages use the Gatekeeper `curlFor` / `curl-note.ejs` pattern: the full URL with `?level=`, `-b "hvwa_sid=<copy from devtools>"`,
and the bash vs `curl.exe` note. Where these helpers live is open question Q1.

---

#### 2. Per-lab designs

- **Batch RM-A — shop shell + cart arithmetic: `_shared/` (all of section 1), RM-05, RM-09, RM-14.** Common shape: the storefront
  (header with wallet, catalog with add-to-cart forms, cart with computed totals, checkout, orders list with flag lines). The flaw
  is in how a level turns the add-to-cart request into a line and the cart into a charge. Every Divine answer to an exploit ends
  on checkout with `Insufficient funds: the total is <X> and your wallet holds <Y>.` (`resisted: /Insufficient funds/`).
  - **RM-05 Negative quantity** (`negative-quantity`; maps `A06:2025`, `CWE-1284`, `CWE-840`; perSession; Restart).
    - *Shop and goal.* The wallet starts at $50.00. The catalog: `RELIQUARY` "Reliquary of the First Pilgrim" $1,000.00 (100000),
      `ROSARY` "Pilgrim's Rosary" $40.00 (4000), `CANDLE` "Votive Candle" $2.50 (250). State adds
      `owned`/`returned: Map<sku, number>`.
    - *Page.* Header, catalog (qty text field), cart (negative lines shown honestly: `× −25 = −$1,000.00`). There is a
      "Return an item for store credit" form (SKU select of owned items, qty text): it adds a `kind: 'return'` line with
      qty `−n`. Orders list, curl note for `POST <lab>/cart`.
    - *Intents.* `add` → `/cart` `{sku, qty}`; `return` → `/cart/return` `{sku, qty}`; `checkout` → `/checkout`.
    - *Shared route behaviour.*
      - The total is Σ `qty × listPrice` over all lines; prices come from the server catalog at every level.
      - Checkout moves positive lines into `owned` and return lines into `returned`, takes `wallet −= total` (so a negative total
        credits the wallet) and empties the cart.
    - *Level interface.* `parseQty(raw) → number | string`, `returnable(state, sku, n) → true | string`,
      `checkoutAllowed(total, wallet) → true | string`.
    - *Acolyte.* `parseQty` is `Number.parseInt(raw, 10)` (only NaN is refused), so negatives pass. `returnable` is always true.
      Checkout needs only `total <= wallet`.
    - *Templar.* Naive blacklist: `if (raw.startsWith('-')) 'Quantity cannot be negative.'`, then `parseInt`. A leading
      space (`' -25'`) passes, because `parseInt` skips whitespace. `returnable` checks only that the SKU was bought at least once.
    - *Inquisitor.* Strict quantities: `/^\d{1,2}$/`, 1–99, everywhere. Checkout refuses `total < 0`. The flaw is in returns:
      `returnable` checks that you bought the SKU, but not **how many**, so one rosary bought can be returned 25 times.
    - *Divine.* Strict 1–99. A return is bounded by `owned − returned − already pending in the cart`, otherwise
      `You can return at most N <name>.`. Checkout requires `0 ≤ total ≤ wallet`. Server prices only. ASVS 5.0 V2.2 (validate
      business limits) and V2.3 (business-logic integrity).
    - *Proof.* A paid order with a `RELIQUARY` line of qty ≥ 1. With a $50 wallet this is impossible without the flaw.
    - *Solve.*
      - A: add `RELIQUARY` 1, add `ROSARY` `-25` (total $0.00), checkout.
      - T: the same with qty `' -25'`.
      - I: add `ROSARY` 1, checkout (wallet $10, owned 1). Add `RELIQUARY` 1, return `ROSARY` 25 (total $0.00), checkout.
    - *Matrix.* legit: buy 2 candles → `Order #1 placed` (no flag). malformed `[]`. privileged `null`.
    - *Seams.* `labState(sid, level)`.
    - *Pitfalls.* The order must store `qty`, `unitPrice` and `listPrice` per line, because the proof reads the order and never the
      current catalog. The returns map is keyed by catalog SKUs only. A $0 order is a valid paid order.
    - *Text.*
      - Title: `{ id: 'Celah Logika Kuantitas Negatif', en: 'Negative Quantity Logic Flaw' }`.
      - Summary: `{ id: 'Bayar pesanan berisi Reliquary of the First Pilgrim ($1,000.00) padahal dompetmu hanya $50.00.', en: 'Pay for an order containing the Reliquary of the First Pilgrim ($1,000.00) with only $50.00 in your wallet.' }`.
      - Hints:
        1. `{ id: 'Total pesanan adalah jumlah dari kuantitas kali harga. Angka apa saja yang diterima server sebagai kuantitas?', en: 'The order total is quantity times price, summed. Which numbers does the server accept as a quantity?' }`
        2. `{ id: 'Filter Templar melihat karakter pertama teks kuantitas. Apakah pengurai angka juga mulai membaca dari karakter itu?', en: 'Templar\'s filter looks at the first character of the quantity text. Does the number parser start reading at that same character?' }`
        3. `{ id: 'Di Inquisitor kuantitas sudah selalu positif. Fitur mana yang sengaja menambahkan baris bernilai negatif, dan apa yang lupa dihitungnya?', en: 'At Inquisitor quantities are always positive. Which feature adds a negative line on purpose, and what does it forget to count?' }`
  - **RM-09 Client-side price manipulation** (`client-side-price`; maps `A06:2025`, `CWE-602`, `CWE-472`; perSession; Restart).
    - *Shop and goal.* Wallet $25.00. `RELIQUARY` $500.00 (50000), `CHALICE` $40.00, `CANDLE` $2.50.
      `PRICE_LISTS = retail 100 %, partner 60 % ("registered resellers"), staff 1 % ("staff samples, employees only")`. A list
      price is `Math.floor(retail × pct / 100)`, so staff `RELIQUARY` is $5.00.
    - *Page.* Catalog rows each have an add-to-cart form (qty text field plus the level's hidden fields, rendered verbatim so
      devtools shows them), then cart, orders, and an API box listing `GET <lab>/api/price-lists` (JSON, every level).
    - *Level interface.* `formFields(p) → Record<string, string>` (the hidden fields) and `unitPrice(p, body) → number | string`.
      The route stores `unitPrice` on the line.
    - *Acolyte.* Hidden `price` (cents). `unitPrice` is `Number.parseInt(field(body, 'price'), 10)`, accepted if it is a safe
      integer. There is no other check.
    - *Templar.* Hidden `price` + `sig = sha256hex(`${sku}:${price}`)`, computed in the level file with `createHash` and no secret.
      A mismatch answers `Tampering detected: the price checksum does not match.`, otherwise the client price is used. Anyone can
      recompute the checksum.
    - *Inquisitor.* A real fix for the price: client `price`/`sig` are ignored and the server computes the price. The flaw: hidden
      `price_list=retail`, and the server prices from **whichever list the client names** (`staff` exists). There is no
      entitlement check.
    - *Divine.* No price-related fields at all. The price is always retail; the customer's list comes from the session (pilgrim is
      retail). Client fields are ignored. ASVS 5.0 V2.3 (business logic) and V8 (authorization of price tiers).
    - *Proof.* A paid order with a line whose `unitPrice < listPrice` (retail).
    - *Solve.*
      - A: `sku=RELIQUARY&qty=1&price=100` (or edit the hidden field in devtools), then checkout.
      - T: `price=100&sig=$(printf 'RELIQUARY:100' | sha256sum | cut -d' ' -f1)`, then checkout.
      - I: `price_list=staff`, then checkout.
    - *Matrix.* legit: buy a candle with the form's own hidden fields. malformed `[]`. privileged `null`.
    - *Seams.* `labState`, `PRICE_LISTS`.
    - *Pitfalls.* Templar's `sha256hex` must live in `levels/templar.ts`, so View Source shows the formula.
      `/api/price-lists` is public at every level (nothing is hidden); only Inquisitor misuses it. Parse `price_list` with
      `field()` (arrays and objects become `''`, which means retail).
    - *Text.*
      - Title: `{ id: 'Manipulasi Harga di Sisi Klien', en: 'Client-Side Price Manipulation' }`.
      - Summary: `{ id: 'Bayar Reliquary ($500.00) dengan dompet $25.00 dengan mengubah apa yang dikirim browsermu.', en: 'Pay for the Reliquary ($500.00) with a $25.00 wallet by changing what your browser sends.' }`.
      - Hints:
        1. `{ id: 'Buka formulir "Add to cart" di devtools. Field tersembunyi apa yang ikut terkirim bersama SKU, dan apakah server memercayainya?', en: 'Open the "Add to cart" form in devtools. Which hidden fields travel with the SKU, and does the server trust them?' }`
        2. `{ id: 'Checksum tanpa rahasia bisa dihitung oleh siapa saja. Dari bagian mana checksum itu dibuat?', en: 'A checksum without a secret can be computed by anyone. What is it made from?' }`
        3. `{ id: 'Di Inquisitor harga dihitung di server. Tetapi siapa yang memilih daftar harga mana yang dipakai?', en: 'At Inquisitor the price is computed on the server. But who chooses which price list it uses?' }`
  - **RM-14 Integer overflow in cart total** (`cart-total-overflow`; maps `A05:2025`, `CWE-190` (see Q2); perSession; Restart).
    - *Shop and goal.* Wallet $50.00. Catalog (cents):

      | SKU | Name | Cents |
      |---|---|---|
      | `RELIQUARY` | Reliquary | 999 900 |
      | `ALTAR` | Golden Altar | 19 999 999 |
      | `THRONE` | Jeweled Throne | 14 999 999 |
      | `CHALICE` | Silver Chalice | 125 000 |
      | `CANDLE` | Votive Candle | 250 |
      | `SLIP` | Prayer Slip | 1 |

    - *How overflow is modelled.* Java/C `int` cents, visible in View Source: products with `Math.imul`, sums with
      `(a + b) | 0`, quantities with `qty | 0`. Cart lines merge by SKU (`set quantity`).
    - *Page.* Catalog, cart (line totals and the cart total exactly as the level computed them), an "INT32 range" note on the
      cart (`−2,147,483,648 … 2,147,483,647 cents`), orders.
    - *Level interface.* `parseQty(raw) → number | string`, `lineTotal(price, qty) → number | string`,
      `addToTotal(total, line) → number`, `checkoutAllowed(total, wallet) → true | string`.
    - *Acolyte.* `parseQty`: `parseInt` and `>= 1`. `lineTotal = Math.imul(price, qty | 0)`, `addToTotal = (total + line) | 0`.
      Checkout needs only `total <= wallet`, so a wrapped negative total is "affordable" and credits the wallet.
    - *Templar.* The same arithmetic, plus a naive sanity check at checkout: `total <= 0 → 'Invalid order total.'`. The flaw:
      the quantity is validated as a JS double (`>= 1`) and then truncated with `qty | 0`, so a 10-digit quantity wraps negative
      inside the line.
    - *Inquisitor.* A real fix for the lines: qty must match `/^\d{1,4}$/` (1–9999), and `lineTotal = price * qty` is computed
      exactly and refused if it is above `2_147_483_647` (`Line total too large.`). The flaw: the **sum** is still
      `(total + line) | 0`, so several lines that each fit wrap the total.
    - *Divine.* Strict 1–99. Exact arithmetic with `Number.isSafeInteger` checks on every multiply and add. An order cap of
      $1,000,000.00 (`Orders above $1,000,000.00 need a quote.`). `total <= wallet`. ASVS 5.0 V2.2 (numeric range validation).
    - *Proof.* A paid order with a `RELIQUARY` line whose `charged` is less than `exactValue(order.lines)` (BigInt).
    - *Solve.*
      - A: `RELIQUARY` qty 3000. `Math.imul(999900, 3000)` is −1 295 267 296, which is ≤ the wallet. Checkout.
      - T: `RELIQUARY` 1 + `SLIP` 4293967496. `4293967496 | 0` is −999 800, so the total is 100 ($1.00). Checkout.
      - I: `ALTAR` 107 + `THRONE` 143 + `RELIQUARY` 1 + `CHALICE` 71 + `CANDLE` 370 + `SLIP` 246. The exact sum is
        4 294 967 396 = 2³² + 100, so the wrapped total is 100 ($1.00). Every line is ≤ INT32_MAX. Checkout.
      - Both the T and I totals were verified with Node.
    - *Matrix.* legit: 2 candles. malformed `[]`. privileged `null`.
    - *Seams.* `labState`.
    - *Pitfalls.*
      - The shell's `|qty| ≤ 9 999 999 999` bound must stay above Templar's 4 293 967 496.
      - The proof must use BigInt, because Σ price × qty can exceed 2⁵³ at Templar.
      - Inquisitor's per-line refusal happens at `add` time, but the total wraps on every render and at checkout.
      - Never use `| 0` outside the level files, or View Source stops telling the story.
    - *Text.*
      - Title: `{ id: 'Integer Overflow pada Total Keranjang', en: 'Integer Overflow in Cart Total' }`.
      - Summary: `{ id: 'Bayar pesanan berisi Reliquary ($9,999.00) dengan dompet $50.00 dengan mendorong total keranjang melewati batas integer.', en: 'Pay for an order containing the Reliquary ($9,999.00) with a $50.00 wallet by pushing the cart total past an integer limit.' }`.
      - Hints:
        1. `{ id: 'Total disimpan dalam sen sebagai integer 32-bit bertanda. Berapa nilai terbesarnya, dan apa yang terjadi satu sen setelahnya?', en: 'The total is kept in cents as a signed 32-bit integer. What is its largest value, and what happens one cent past it?' }`
        2. `{ id: 'Templar menolak total yang tidak positif. Bagaimana kuantitas itu sendiri disimpan, dan bisakah kamu membuat total mendarat sedikit di atas nol setelah membungkus?', en: 'Templar refuses totals that are not positive. How is the quantity itself stored, and can you make the total land just above zero after it wraps?' }`
        3. `{ id: 'Di Inquisitor setiap baris diperiksa agar muat. Apakah jumlah semua baris juga diperiksa?', en: 'At Inquisitor each line is checked to fit. Is the sum of the lines checked too?' }`

- **Batch RM-B — injection: RM-01, RM-02, RM-03, RM-04.**
  - *Common shape.* A read-only target. SQL labs use one `challengeDb` per level via **`perLevel`** (the GK-01 precedent: an
    injected SELECT cannot mutate, and a secret extracted at one level is worthless at another). The seed calls
    `hardenSeed(raw)`. Attacker input reaches SQL only through `prepare()`, and rows are read with `firstRows(stmt, 50)` or
    `.get()`.
  - *Errors.* RM-01 and RM-04 show the real error below Divine (`tryDb`). The **blind labs RM-02/03 deliberately show no DB text
    at any level**: an error is rendered as the level's normal negative answer. Their `divine.ts` comment and spec say so, they
    use `malformed: []`, and they add a lab-specific case: "a lone quote shows no DB text at any level" (Q4).
  - **RM-01 SQLi product search (UNION)** (`sqli-product-search`; maps `A05:2025`, `CWE-89`; perLevel).
    - *Schema.* `products(id, sku, name, category, price_cents, description, hidden)` with about 12 relics, plus
      `secrets(id, name, value)` holding `('vault_key', randomBytes(12).hex)` and `('backup_note', 'rotate quarterly')`.
    - *Page.* "Relic Market catalog search" as a guest (`You are browsing as a guest.` is the `account` regex). Fields `q` and
      `max` ("Max price (whole dollars)"), both text inputs. An empty `max` means `1000000`. Results table (Name, Category,
      Price, Description; at most 50 rows, cells clipped to 200 chars), a row count, the curl note.
    - *Levels.* `search(db, q, max)` returns rows or a validation message.
      - Acolyte: `SELECT name, category, price_cents, description FROM products WHERE hidden = 0 AND name LIKE '%${q}%' AND price_cents / 100 <= ${max} ORDER BY name`.
        Both inputs are concatenated.
      - Templar: blacklist `x.replace(/union|select/gi, '')` applied once (not recursively) to both inputs, then the Acolyte SQL.
        Nested keywords survive the single pass.
      - Inquisitor: `q` is bound (`LIKE ?` with `%${q}%`). `max` is "validated" with `Number.isNaN(Number.parseInt(max, 10))` →
        `Max price must be a number.`. The flaw is that the **raw string** is still concatenated, so
        `1000000 UNION SELECT …` passes `parseInt`.
      - Divine: both bound; `max` must match `/^\d{1,7}$/` (`Max price must be a whole number of dollars.`); `LIMIT 50`; generic
        errors. ASVS 5.0 V1.2 (parameterized queries) and V2.2 (validate the value you use).
    - *Proof.* Any rendered result cell contains `vaultKey(level)`. The echoed search term is not a result cell.
    - *Solve.*
      - A: `q = x' UNION SELECT name, value, 0, 'vault' FROM secrets-- `.
      - T: `q = x' UNIunionON SELselectECT name, value, 0, 'vault' FROM secrets-- ` (verified: one pass leaves `UNION SELECT`).
      - I: `max = 1000000 UNION SELECT name, value, 0, 'vault' FROM secrets`. No comment is needed: the compound ends with
        `ORDER BY name`. Verified.
    - *Matrix.*
      - resisted: `{ acolyte: 'No relics match', templar: 'No relics match', inquisitor: 'Max price must be a whole number of dollars.' }`.
      - legit: `q=chalice` → `Silver Chalice`.
      - malformed: `{q: "'"}` at `[acolyte, templar]`; `{max: "1'"}` at `[acolyte, templar, inquisitor]`.
      - privileged `null`.
    - *Seams.* `vaultKey(level)`, `catalogDb(level)`.
    - *Pitfalls.* The 50-row cap must come from `firstRows`, not from SQL `LIMIT`, which an attacker can comment out. Send the
      ORDER BY alias `name` in the first SELECT. Do not count the echo of `q` as proof.
    - *Text.*
      - Title: `{ id: 'SQLi Pencarian Produk (UNION)', en: 'Product Search SQLi (UNION)' }`.
      - Summary: `{ id: 'Munculkan kunci brankas toko dari tabel secrets di hasil pencarian katalog.', en: 'Make the shop\'s vault key from the secrets table show up in the catalog search results.' }`.
      - Hints:
        1. `{ id: 'Kata pencarianmu masuk ke query SQL. Berapa kolom yang dikembalikan query itu, dan bisakah kamu menambahkan baris dari tabel lain?', en: 'Your search term ends up in an SQL query. How many columns does it return, and could you add rows from another table?' }`
        2. `{ id: 'Kalau kata kunci tertentu dihapus dari inputmu, apa yang tersisa sesudah penghapusan? Apakah filter itu berjalan lebih dari sekali?', en: 'If certain keywords are removed from your input, what is left after the removal? Does the filter run more than once?' }`
        3. `{ id: 'Di Inquisitor kotak pencarian sudah aman. Field lain mana yang masih masuk ke query, dan apa yang sebenarnya dibuktikan oleh pemeriksaan "apakah ini angka"?', en: 'At Inquisitor the search box is safe. Which other field still reaches the query, and what does its "is this a number?" check really prove?' }`
  - **RM-02 Blind boolean SQLi** (`blind-boolean-sqli`; maps `A05:2025`, `CWE-89`; perLevel).
    - *Schema.* `products(sku, name)`, `stock(sku, region, qty)` (`RELIC-CHALICE` in stock in eu/us, `RELIC-LANTERN` 0
      everywhere, `RELIC-ICON` apac only), `staff_codes(id, holder, code)` with `('relic_admin', 8 hex chars)`.
    - *Page.*
      - "Stock checker": a SKU text field and a region selector. `intent=region` sets the cookie `relic_region_<level>` (not
        HttpOnly, a preference; Path = labPath; default `eu`), and the page shows its current value.
      - The product SKU list, so players know an in-stock SKU.
      - A "Redeem staff code (8 characters)" form (`intent=redeem`) and the curl note (with `-b relic_region_<level>=…`).
    - *Answers.* `<sku>: In stock (<region>).` (`lab-success`) when `.get()` returns a row with `qty > 0`, otherwise
      `Not available.` (`lab-error`). A DB error is also `Not available.`.
    - *Levels.* `inStock(db, sku, region) → boolean | string`.
      - Acolyte: `SELECT qty FROM stock WHERE sku = '${sku}' AND region = '${region}'`. Both are concatenated (the region from
        the cookie).
      - Templar: reject either input matching `/\b(and|or)\b|--|#|;/i` → `Invalid SKU.`, then the Acolyte SQL. `IIF`/`CASE`
        and `||` concatenation are not blocked.
      - Inquisitor: the SKU is bound (`sku = ?`), but the region cookie is still concatenated. It is "trusted" because the app
        set it itself.
      - Divine: both bound; the region is allowlisted (`eu|us|apac`, otherwise `eu`); uniform answers. ASVS 5.0 V1.2 (every
        input channel, cookies included).
    - *Proof.* Redeeming `staffCode(level)` (`redeemCode`).
    - *Solve.* Binary search per character over the sorted hex alphabet (8 × 4 requests, then redeem).
      - A: `sku = RELIC-CHALICE' AND substr((SELECT code FROM staff_codes),i,1) > 'c'--`.
      - T: `sku = ' || IIF(substr((SELECT code FROM staff_codes),i,1) > 'c', 'RELIC-CHALICE', '') || '` (verified: passes the
        blacklist, true/false as expected).
      - I: `sku = RELIC-CHALICE`, cookie `relic_region_inquisitor = eu' AND substr((SELECT code FROM staff_codes),i,1) > 'c' AND 'x'='x`,
        URL-encoded (cookie-parser decodes `%XX`).
    - *Matrix.* resisted `Invalid staff code.` (the final redeem). legit: `RELIC-CHALICE` → `In stock`. malformed `[]`.
      privileged: redeem the real code at Divine → `Staff code accepted.` (no flag).
    - *Seams.* `staffCode(level)`.
    - *Pitfalls.*
      - Never let a DB error message reach the page, since that would make the lab not blind.
      - The extraction script must decide by "In stock" versus anything else, so a broken oracle extracts garbage instead of
        hanging.
      - The region setter only writes allowlisted values; the player edits the cookie directly.
    - *Text.*
      - Title: `{ id: 'SQLi Buta Boolean', en: 'Blind Boolean SQLi' }`.
      - Summary: `{ id: 'Pemeriksa stok hanya menjawab "tersedia" atau "tidak". Gunakan jawaban itu untuk membaca kode staf, lalu tukarkan kodenya.', en: 'The stock checker only answers "in stock" or "not available". Use that answer to read the staff code, then redeem it.' }`.
      - Hints:
        1. `{ id: 'Halaman ini tidak pernah menampilkan data. Bisakah kamu membuat jawabannya bergantung pada pertanyaan benar/salah buatanmu sendiri?', en: 'The page never shows data. Can you make its answer depend on a true/false question of your own?' }`
        2. `{ id: 'Kalau operator logika yang biasa diblokir, cara lain apa yang dimiliki SQL untuk memilih nilai berdasarkan sebuah kondisi?', en: 'If the usual logical operators are blocked, what other ways does SQL have to pick a value depending on a condition?' }`
        3. `{ id: 'Di Inquisitor SKU sudah aman. Apa lagi yang dikirim browsermu ke pemeriksa stok setiap kali, tanpa kamu ketik?', en: 'At Inquisitor the SKU is safe. What else does your browser send to the stock checker every time, without you typing it?' }`
  - **RM-03 Blind time-based SQLi** (`blind-time-sqli`; maps `A05:2025`, `CWE-89`; perLevel; delay mechanics in section 1).
    - *Schema.* `orders(order_no, email, status)` (`RM-1001`…`RM-1005`) and `vault(id, pin)` (6 hex chars). The seed registers
      `sleep()` and calls `hardenSeed`.
    - *Page.* "Track your order" with an `order_no` text field ("Your last order: RM-1001"). A note: "Relic Market runs on SQLite
      with a MySQL-compatible `sleep(seconds)` helper; heavy queries do not slow it down". A "Redeem vault PIN (6 characters)"
      form and the curl note with `-w '%{time_total}'`.
    - *Answer.* Always `If order <no> exists, its status has been emailed to the address on file.` (escaped echo), with the same
      markup for hits, misses and errors.
    - *Levels.* `lookup(db, orderNo) → void | string` (a string is a validation refusal, shown as `Invalid order number.`).
      - Acolyte: `SELECT status FROM orders WHERE order_no = '${orderNo}'`.
      - Templar: rejects input containing a space (`orderNo.includes(' ')`), then the same SQL. Comments (`/**/`), tabs and
        newlines still separate words.
      - Inquisitor: allowlist regex `/^RM-\d{4}$/m.test(orderNo)`, then concatenated. With the `m` flag, `^` and `$` match at
        line boundaries, so `RM-1001\n' UNION …` passes.
      - Divine: `/^RM-\d{4}$/` (no `m`; in JS a bare `$` matches only at the end of the input), a bound parameter, and no
        data-dependent work. ASVS 5.0 V1.2 and V2.2 (anchored allowlists).
    - *Proof.* Redeeming `vaultPin(level)`.
    - *Solve.* Each request takes about 2 s when the condition is true, 0 otherwise; binary search, 6 × 4 requests, then redeem.
      - A: `x' UNION SELECT sleep(CASE WHEN substr((SELECT pin FROM vault),i,1) > 'c' THEN 2 ELSE 0 END)--`.
      - T: the same with `/**/` in place of every space.
      - I: `RM-1001` + `\n` + `' UNION SELECT sleep(CASE WHEN … THEN 2 ELSE 0 END)--` (curl `--data-urlencode` with a real
        newline, or `%0A`). Verified: the regex passes and the delay is recorded once.
      - Tests decide with `dt >= 1000` on the fake clock.
    - *Matrix.* resisted `Invalid vault PIN.`. legit: `RM-1001` → the uniform answer. malformed `[]`. privileged: the real PIN at
      Divine → `Vault PIN accepted.`.
    - *Seams.* `vaultPin(level)`, `useFakeClock()`. Lab-specific cases:
      - a true condition records 2000 ms and a false one 0 at A/T/I;
      - Divine never delays;
      - the delay cap is 5000 ms per request;
      - the response bytes are identical for a hit and a miss.
    - *Pitfalls.*
      - The UNION form makes `sleep` run exactly once. With `AND`/`OR` forms it runs per scanned row, or never when the literal
        has a trailing newline. Tests and hints must not depend on row counts.
      - Reset the accumulator in a `finally`.
      - Never let `sleep` block, and never use a real SQL slow path.
    - *Text.*
      - Title: `{ id: 'SQLi Buta Berbasis Waktu', en: 'Blind Time-Based SQLi' }`.
      - Summary: `{ id: 'Pelacak pesanan selalu memberi jawaban yang sama. Ukur waktu jawabannya untuk membaca PIN brankas, lalu tukarkan PIN itu.', en: 'The order tracker always gives the same answer. Time its replies to read the vault PIN, then redeem it.' }`.
      - Hints:
        1. `{ id: 'Kalau isi jawaban tidak pernah berubah, apa lagi yang bisa kamu ukur? Fungsi apa yang disediakan lapisan database toko ini?', en: 'If the content of the answer never changes, what else can you measure? Which functions does this shop\'s database layer provide?' }`
        2. `{ id: 'Filter Templar menolak satu karakter yang biasanya ada di antara kata-kata SQL. Apa lagi yang bisa memisahkan kata dalam SQL?', en: 'Templar\'s filter rejects one character that usually sits between SQL words. What else can separate words in SQL?' }`
        3. `{ id: 'Di Inquisitor input dicek dengan regex. Apa arti ^ dan $ ketika regex memakai flag m, dan apakah input harus satu baris?', en: 'At Inquisitor the input is checked with a regex. What do ^ and $ mean when the regex has the m flag, and must the input be one line?' }`
  - **RM-04 NoSQL injection login** (`nosql-login`; maps `A05:2025`, `CWE-943`; perLevel; tryDb label `Query error`; `errorRe: /Query error/`).
    - *Document store.* It lives in the lab folder: `rm-04-nosql-login/docstore.ts` (plumbing, the "database") plus
      `docstore.spec.ts`. It never uses `eval`, `Function` or `vm`, and a guard test scans its source for them.
      - `findOne(query)` returns the first match in insertion order.
      - Docs are null-prototype objects:
        `{ username: 'relic_admin', username_lc, password: randomBytes(8).hex, role: 'admin' }` (first),
        `{ username: 'pilgrim', username_lc, password: 'pilgrim', role: 'customer' }`,
        `{ username: 'Brother_Tobias', …, role: 'staff' }`.
      - Field-level operators: `$eq $ne $gt $gte $lt $lte` (same-type comparison, otherwise false), `$in`/`$nin` (arrays of ≤ 20
        primitives), `$exists`, `$not` (nesting ≤ 5), and `$regex` + `$options` (`i` only).
      - `$regex` safety: source ≤ 64 chars; reject a quantified group (`/\)[*+?{]/`) or more than 4 quantifier characters; every
        document string is ≤ 32 chars; an invalid pattern is an error.
      - Top level: field names, or `$where`. Any other `$` key is `unknown top-level operator`.
      - A value object that mixes `$` keys and plain keys is an error. A plain object or array value never equals a string.
        `undefined` matches only a missing field. Iterate `Object.keys`, skip `__proto__`, `constructor` and `prototype`, and
        read fields with `Object.hasOwn`.
      - `$where` (a string) goes to a **simulated JS-subset evaluator** (tokenizer + recursive descent):
        - `this.<field>`, `.toLowerCase()`, `.toUpperCase()`, `.trim()`, `.length`;
        - string literals (`'`/`"` with `\\`, `\'`, `\"` escapes), numbers, `true false null undefined`;
        - `== === != !== < > <= >=`, `&& || !`, parentheses, `//` and `/* */` comments;
        - `==` is strict except null/undefined;
        - limits: 1000 chars, 300 tokens, depth 32;
        - errors are `SyntaxError: …` or `TypeError: …` and include the expression clipped to 200 chars.
    - *Which operators are reachable per level:*
      - Acolyte: all field operators. `$where` is not reachable: the query shape is fixed, so only field values are controlled.
      - Templar: all except `$ne`/`$gt`.
      - Inquisitor: none. Only the app-built `$where` is used.
      - Divine: `$eq` only, built by the app.
    - *Parsing.* No engine change. Bodies are parsed by `express.urlencoded({ extended: true })` (qs, depth 32), so
      `password[$ne]=x` becomes `{ password: { $ne: 'x' } }`, and JSON goes through `express.json()`. The query parser stays
      "simple"; the login is POST.
    - *Page.* "Relic Market staff portal" (`Your account: pilgrim / pilgrim`), text inputs `username` and `password`, the curl
      note (`--data-urlencode` and JSON variants).
    - *Levels.* `login(store, body: unknown) → Doc | null | string` (a string is a refusal message).
      - Acolyte: `store.findOne({ username: b.username, password: b.password })` with the raw values.
      - Templar: blacklist. If either value is an object with own key `$ne` or `$gt` → `Hacking attempt blocked.`, otherwise as
        Acolyte. `$regex`, `$gte`, `$nin`, `$exists` and `$not` pass.
      - Inquisitor: a real fix against operators: `u = String(b.username ?? '').toLowerCase()`, `p = String(b.password ?? '')`.
        The flaw: a case-insensitive lookup is written as
        `{ $where: "this.username.toLowerCase() == '" + u + "' && this.password == '" + p + "'" }`, so a quote ends the string.
      - Divine: non-strings answer the uniform `Invalid username or password.`. Query
        `{ username_lc: { $eq: u.normalize('NFKC').toLowerCase() }, password: { $eq: p } }`, no `$where`, generic errors. The
        comment notes that password hashing and rate limiting are out of scope. ASVS 5.0 V1.2 (NoSQL injection).
    - *Proof.* Signed in as `relic_admin` (shared `welcome()`: `Welcome, relic_admin (role: admin). Flag: …`).
    - *Solve.*
      - A: `username=relic_admin&password[$ne]=x`.
      - T: `username=relic_admin&password[$regex]=.`.
      - I: `username=relic_admin'//&password=x`.
    - *Matrix.*
      - resisted `Invalid username or password.`.
      - legit `pilgrim`/`pilgrim` → `Welcome, pilgrim (role: customer)`.
      - malformed: `{username: 'pilgrim', 'password[$foo]': '1'}` at `[acolyte, templar]`; `{username: "'", password: 'x'}` at
        `[inquisitor]`.
      - privileged: `relic_admin` + `adminPassword('divine')`.
    - *Seams.* `adminPassword(level)`, `staffStore(level)`.
    - *Pitfalls.* `describeLabView` odd bodies (nested objects) must answer 200 at every level: at A/T they are a failed match or a
      `Query error`, never a 500. ReDoS bounds are mandatory at every level.
    - *Text.*
      - Title: `{ id: 'Injeksi NoSQL pada Login', en: 'NoSQL Injection Login' }`.
      - Summary: `{ id: 'Masuk ke portal staf sebagai relic_admin tanpa mengetahui kata sandinya.', en: 'Sign in to the staff portal as relic_admin without knowing the password.' }`.
      - Hints:
        1. `{ id: 'Basis data dokumen mencocokkan field dengan sebuah objek query. Apa yang terjadi bila password yang kamu kirim bukan teks, melainkan objek?', en: 'A document database matches fields against a query object. What happens if the password you send is not text but an object?' }`
        2. `{ id: 'Daftar hitam hanya memblokir beberapa operator. Operator perbandingan lain mana yang juga cocok dengan kata sandi apa pun?', en: 'The blacklist blocks only a few operators. Which other comparison operators also match any password?' }`
        3. `{ id: 'Di Inquisitor input dipaksa menjadi teks lalu ditempel ke dalam ekspresi $where. Bagaimana teksmu bisa mengakhiri string itu dan mengubah sisa ekspresinya?', en: 'At Inquisitor inputs are forced to text and pasted into a $where expression. How could your text end that string and change the rest of the expression?' }`

- **Batch RM-C — promotions, races and money movement: RM-06, RM-07, RM-08, RM-10.** Common shape: the shop shell. RM-07 and RM-08
  use `Gate` (+ `KeyedMutex`). Their specs fire `Promise.all` with `barrierGate(2)` installed on that session's state, and run
  every other case with `useInstantWaits()`. Production windows are real timers, wide enough for ordinary tools (Q6).
  - **RM-06 Coupon stacking** (`coupon-stacking`; maps `A06:2025`, `CWE-837`; perSession; Restart).
    - *Shop and promotions.* Wallet $70.00. `RELIQUARY` $100.00 (10000), `ICON` $35.00, `CANDLE` $2.50.
      - `WELCOME10`: 10 %.
      - `SPRING15`: 15 %.
      - `RELIC20`: $20.00 off when the running total is ≥ $80.00.
      - Rule shown on the page: **one promotion per order**.
    - *Discount math (model, every level).* Walk the applied codes in order. A percentage takes
      `Math.floor(running × pct / 100)`. A fixed amount takes `running >= min ? Math.min(amount, running) : 0`. The total is
      what remains.
    - *Page.* Catalog, cart with an applied-promotions list, a `code` text field (`intent=coupon`, path `/cart/coupon`),
      "remove promotions" (`intent=uncoupon`), checkout, orders, the promotions table, the curl note (form and JSON).
    - *Levels.* `applyCoupon(state, body: unknown) → Result`.
      - Acolyte: `code = String(body.code ?? '').trim().toUpperCase()`. Must be a known code; appended, even if it is already
        applied.
      - Templar: naive. Refuses only the **same** code twice (`This code is already applied.`); different codes stack.
      - Inquisitor: the real rule, `state.coupons.length >= 1 → 'Only one promotion per order.'`. The flaw: it reads
        `codes = [].concat(body.code).map(String).slice(0, 5)` and checks "is there already one?" once **per request**, then
        appends every known, distinct code in the array (`code=A&code=B`, `code[]=…`, JSON arrays).
      - Divine: `field(req, 'code')` (strings only), normalized. Applying **replaces** the single slot. Discounts are recomputed
        at checkout from list prices with at most one code. ASVS 5.0 V2.3 (enforce business rules server-side, once per business
        action).
    - *Proof.* A paid order where `listSubtotal − charged > bestSingle(listSubtotal)`, and `bestSingle` is the largest discount
      any one promotion gives alone on the list subtotal (for $100 that is $20).
    - *Solve.*
      - A: add `RELIQUARY`; apply `RELIC20` twice ($60.00); checkout.
      - T: `WELCOME10`, then `RELIC20` ($90, then $70.00); checkout.
      - I: one request `code=WELCOME10&code=RELIC20` ($70.00); checkout.
    - *Matrix.* resisted `/Insufficient funds/` (Divine: $80 > $70). legit: one `WELCOME10` on a candle order. malformed `[]`.
      privileged `null`.
    - *Seams.* `labState`, `COUPONS`, `bestSingle`.
    - *Pitfalls.* A and T must still `String()` an array (`"A,B"` is an unknown code), so only Inquisitor has the array flaw. The
      proof must use list prices, never the discounted lines.
    - *Text.*
      - Title: `{ id: 'Menumpuk Kupon', en: 'Coupon Stacking' }`.
      - Summary: `{ id: 'Aturannya satu promo per pesanan. Bayar pesanan dengan diskon lebih besar daripada yang bisa diberikan satu promo mana pun.', en: 'The rule is one promotion per order. Pay for an order with a bigger discount than any single promotion can give.' }`.
      - Hints:
        1. `{ id: 'Saat kamu memasukkan kode kedua, apa yang diperiksa server: kode yang sama, atau berapa kode yang sudah ada di keranjang?', en: 'When you enter a second code, what does the server check: the same code, or how many codes the cart already holds?' }`
        2. `{ id: 'Kalau permintaan kedua ditolak, tanyakan bagaimana server menghitung: per permintaan, atau per kode di dalam permintaan?', en: 'If a second request is refused, ask how the server counts: per request, or per code inside the request?' }`
        3. `{ id: 'Bisakah satu field formulir membawa lebih dari satu nilai? Bagaimana body parser mengubah field yang diulang atau berbentuk array?', en: 'Can one form field carry more than one value? How does the body parser turn a repeated or array-shaped field into data?' }`
  - **RM-07 Race: coupon reuse** (`race-coupon-reuse`; levels **A I D**; maps `A06:2025`, `CWE-362`, `CWE-367`; perSession; Restart).
    - *Shop and voucher.* Wallet $25.00. `LANTERN` $50.00 (5000), `CANDLE` $2.50. Voucher `FIRSTRELIC`: $15.00 off, minimum
      subtotal $20.00, **single use per account**. State adds `voucherUsed: boolean` and `inFlight: Set<string>` (≤ 10).
    - *Page.*
      - Catalog, cart with its discount lines, and a `code` field (`intent=voucher`, path `/cart/voucher`).
      - A note: "Vouchers are checked with the promotions service; this takes about a second." The in-page tool hint: "Requests
        that arrive together can interleave. Burp Repeater can send a group in parallel, and a shell can run background jobs."
      - Checkout, orders, the curl note.
    - *Route.* `state.gate.arrive()`, then `await impl.applyVoucher(state, field(req, 'code'))`. `VALIDATION_MS = 1000` at every
      level.
    - *Acolyte.* Check, then await, then mark. Normalize (`trim().toUpperCase()`); unknown → `Unknown voucher.`; `voucherUsed` →
      `This voucher has already been used.`; subtotal < 2000 → refused. Then `await state.gate.pass(VALIDATION_MS)`, then
      `discounts.push({ code, amount: 1500 }); voucherUsed = true`.
    - *Inquisitor.* A double-submit guard that is not atomicity, keyed on the **raw** input:
      - `inFlight.has(raw)` → `This voucher is already being applied.`; a full set → `Too many pending requests.`;
      - `inFlight.add(raw)`, then the Acolyte body in `try`, then `inFlight.delete(raw)` in `finally`.
      - Spelling variants (`firstrelic`, ` FIRSTRELIC`) are different keys but the same voucher after normalizing.
    - *Divine.* The atomic reservation. Normalize and check, then set `voucherUsed = true` **in the same synchronous step, before
      any await**. Await the validation; on failure set it back to `false` in `catch`/`finally`. Then append, and refuse a second
      `FIRSTRELIC` discount in the cart. The comment gives the SQL equivalent: one statement,
      `UPDATE vouchers SET redeemed_by = ? WHERE code = ? AND redeemed_by IS NULL`, then check `changes === 1`, or
      `SELECT … FOR UPDATE` in a transaction. `challengeDb` rejects `BEGIN`, so JS shows the same idea. ASVS 5.0 V2.3 (atomic
      business operations, single-use resources).
    - *Proof.* A paid order with ≥ 2 `FIRSTRELIC` discounts. Two bring the total to $20.00 ≤ $25.00; one leaves $35.00.
    - *Solve.* Add `LANTERN`.
      - A: two parallel `POST <lab>/cart/voucher` with `code=FIRSTRELIC`, then checkout.
      - I: in parallel, `code=FIRSTRELIC` and `code=firstrelic`, then checkout.
      - Players use `curl … & curl … & wait`, Burp's "send group in parallel", or `Promise.all([fetch(…), fetch(…)])` in the
        browser console.
    - *Spec.*
      - `send` installs `barrierGate(2)` on `labState(sid, level)`, fires both with `Promise.all`, asserts `!timedOut()`, then
        checks out and returns the checkout response.
      - resisted `/Insufficient funds/`.
      - legit: 9 candles ($22.50 ≥ the $20 minimum), apply `FIRSTRELIC` once (instant waits), checkout at $7.50 →
        `Order #1 placed`, no flag.
      - Lab-specific cases: a sequential second apply is refused at every level (so the race really is required); Divine
        under the barrier keeps one discount.
    - *Pitfalls.* No `await` before the check. Release the reservation and `inFlight` in `finally`. Bound `inFlight` (attacker
      spellings).
    - *Text.*
      - Title: `{ id: 'Race Condition: Memakai Ulang Kupon', en: 'Race Condition: Coupon Reuse' }`.
      - Summary: `{ id: 'Voucher FIRSTRELIC hanya boleh dipakai sekali. Bayar pesanan yang memakainya dua kali.', en: 'The FIRSTRELIC voucher may be used once. Pay for an order that uses it twice.' }`.
      - Hints:
        1. `{ id: 'Validasi voucher memakan waktu sekitar satu detik. Kapan tepatnya voucher ditandai sudah dipakai: sebelum atau sesudah jeda itu?', en: 'Validating a voucher takes about a second. When exactly is it marked as used: before or after that pause?' }`
        2. `{ id: 'Apa yang terjadi bila dua permintaan tiba hampir bersamaan? Alat apa yang bisa mengirim beberapa permintaan sekaligus?', en: 'What happens when two requests arrive at almost the same moment? Which tools can send several requests at once?' }`
        3. `{ id: 'Di Inquisitor permintaan ganda untuk kode yang sama ditolak. Apakah "kode yang sama" dibandingkan persis seperti yang kamu ketik, atau sesudah dinormalkan?', en: 'At Inquisitor a duplicate request for the same code is refused. Is "the same code" compared exactly as you typed it, or after normalising?' }`
  - **RM-08 Race: balance underflow (single-packet)** (`race-balance-underflow`; levels **A I D**; maps `A06:2025`, `CWE-362`, `CWE-367`; perSession; Restart).
    - *Shop.* $20.00 store credit. Two ways to spend it, $15.00 each:
      - `POST <lab>/wallet/buy` (`intent=buy`) buys a "Pilgrim's Lantern";
      - `POST <lab>/wallet/gift` (`intent=gift`, `to` text, clipped to 100 chars, gifts list ≤ 10) sends a gift card.
    - *Page.*
      - Store-credit panel (`data-cents`), buy button, gift form, purchase and gift history.
      - A note: "Every payment is written to the ledger before your balance updates."
      - The single-packet note: "These requests only race if they arrive together. Burp Repeater's *send group in parallel* uses
        the single-packet technique; parallel shell jobs or `Promise.all` in the console usually land close enough here."
      - The curl note.
    - *Simulated vs real.* Only the ledger latency is simulated: an awaited `state.gate.pass(LEDGER_MS)` on a real timer. The
      interleaving itself is real Node concurrency. No packet-level behaviour is simulated or needed.
    - *Route.* `state.gate.arrive()`, then the level.
    - *Acolyte.* `if (wallet < 1500) 'Insufficient store credit.'; await gate.pass(1500); state.wallet -= 1500; record`. Both
      endpoints do this. The write re-reads the wallet, so two parallel debits go negative (an underflow, not a lost update).
    - *Inquisitor.* Each endpoint takes a lock, but on the **endpoint**, not the wallet:
      `state.mutex.run('buy', …)` and `state.mutex.run('gift', …)` around the Acolyte body, with `LEDGER_MS = 400`. Two buys
      serialize (the second sees $5.00); a buy and a gift run concurrently. This is the multi-endpoint race that single-packet
      sending is made for.
    - *Divine.* One `debit(state, amount)` for every spending path. A synchronous check-and-subtract (reserve) runs before the
      ledger await, and a failure refunds. The comment gives the SQL equivalent:
      `UPDATE wallets SET balance = balance - ? WHERE id = ? AND balance >= ?`, then `changes === 1`, or a per-wallet row lock.
      ASVS 5.0 V2.3.
    - *Proof.* `state.wallet < 0`. The store-credit panel shows `Store credit: −$10.00. Flag: …` below Divine.
    - *Solve.*
      - A: two parallel `POST /wallet/buy`.
      - I: `POST /wallet/buy` ‖ `POST /wallet/gift` with `to=friend@relic-market.test`.
    - *Spec.* As RM-07. The final step is `GET <lab>?level=`. resisted `Store credit: $5.00`. legit: one buy (instant waits) →
      `Store credit: $5.00`, no flag. Lab-specific case: at Inquisitor, two parallel buys under the barrier leave $5.00, which
      proves the lock is real and only mis-keyed.
    - *Pitfalls.* The `arrive()` call must come before `mutex.run`, so a queued request still counts for the barrier. `KeyedMutex`
      keys are constants.
    - *Text.*
      - Title: `{ id: 'Race Condition: Saldo Minus (Single-Packet)', en: 'Race Condition: Balance Underflow (Single-Packet)' }`.
      - Summary: `{ id: 'Buat saldo kredit tokomu negatif dengan membelanjakan lebih dari yang kamu punya.', en: 'Make your store-credit balance go negative by spending more than you have.' }`.
      - Hints:
        1. `{ id: 'Setiap pembayaran dicatat ke buku besar dan itu butuh waktu. Apakah saldo diperiksa dan dikurangi dalam satu langkah, atau ada jeda di antaranya?', en: 'Every payment is written to the ledger, and that takes time. Is the balance checked and reduced in one step, or is there a pause in between?' }`
        2. `{ id: 'Permintaan baru benar-benar balapan bila tiba bersamaan. Bagaimana alat seperti Burp ("send group in parallel") atau job paralel di shell menyelaraskannya?', en: 'Requests only really race if they arrive together. How do tools like Burp ("send group in parallel") or parallel shell jobs line them up?' }`
        3. `{ id: 'Di Inquisitor setiap endpoint memakai kunci. Apakah kunci itu melindungi dompet, atau hanya endpoint itu sendiri? Ada berapa cara membelanjakan kredit?', en: 'At Inquisitor each endpoint takes a lock. Does the lock protect the wallet, or only that endpoint? How many ways are there to spend credit?' }`
  - **RM-10 Currency rounding abuse** (`currency-rounding`; maps `A06:2025`, `CWE-682`, `CWE-1339`; perSession; Restart).
    - *Wallet and units.* The wallet holds three balances and does not use the cart:
      - USD in cents (starts at 1000);
      - crowns (₡, whole units, 1 ₡ = $1.00);
      - IDR in whole rupiah, posted at 1 USD = 16,250 IDR (1 cent = 162.5 IDR).
    - *Exact net worth.* In units of 1/325 cent: `scaled = usd × 325 + crowns × 32 500 + idr × 2`, so the start is 325 000.
      It is integer and exact.
    - *Route (plumbing at every level).*
      - Pairs USD↔CRN and USD↔IDR only.
      - `amount` is the minor units of `from`, `/^\d{1,9}$/`, ≤ that balance.
      - Then `impl.convert(from, to, n) → { debit, credit } | string`.
      - History ≤ 30 entries.
    - *Page.*
      - Balances; net worth (`$X.XX`, floored, plus the exact value in cents).
      - Goal line: `Goal: net worth $11.00 or more. Goal not reached yet.` / `Goal reached. Flag: …`.
      - Exchange form (`from`/`to` selects, `amount` text, `intent=exchange`, path `/exchange`).
      - Posted-rates table, exchange history, and an API box with `GET <lab>/api/rates`. That endpoint serves the level's own
        exported `RATES` table, so whatever the level uses is public.
    - *Acolyte.* No minimum.
      - USD→CRN `Math.round(n / 100)` (half-up: 50 cents gives 1 ₡);
      - CRN→USD `n × 100`;
      - USD→IDR `Math.round(n × 16250 / 100)`;
      - IDR→USD `Math.round(n × 100 / 16250)`.
    - *Templar.* A naive minimum: $1.00 / 1 ₡ / 16,250 IDR (`Minimum exchange is $1.00.`). Still `Math.round`, so $1.50 gives
      2 ₡.
    - *Inquisitor.* A real fix for amounts: the same minimums, and every credit rounds **down**: USD→CRN `Math.floor(n / 100)`,
      USD→IDR `Math.floor(n × RATES.IDR.unitsPerUsd / 100)`. The flaw is in the **rate**: IDR→USD uses the table's second column,
      `usdPerUnitE4 = 1`. That is "0.0001 USD per IDR, kept to 4 decimals", rounded from the true 0.0000615. So
      `cents = Math.floor(n × 1 × 100 / 10 000)`, and a round trip gains 62.5 %.
    - *Divine.* One exact rational per pair, in units per cent: CRN `{ num: 1, den: 100 }`, IDR `{ num: 325, den: 2 }`.
      - USD→X `Math.floor(n × num / den)`; X→USD `Math.floor(n × den / num)`.
      - The same minimums; a zero credit is refused (`Amount too small to exchange.`).
      - Credits always round toward the house, so no sequence of exchanges can raise net worth. A spec property test checks this:
        200 random exchanges never increase `scaled`.
      - ASVS 5.0 V2.3 (financial calculations); a spread and fraud monitoring are out of scope.
    - *Proof.* `scaled ≥ startScaled + 100 × 325`, i.e. at least +$1.00.
    - *Solve.*
      - A: USD→CRN 50, twice (+2 ₡ for $1.00, net worth $11.00).
      - T: USD→CRN 150, twice (+4 ₡ for $3.00).
      - I: USD→IDR 1000 (162 500 IDR), then IDR→USD 162500 (1625 cents, net worth $16.25).
    - *Step-ups (verified).* The A exploit at T is refused by the minimum. The T exploit at I gets `floor(1.5) = 1 ₡` per $1.50,
      a loss.
    - *Matrix.* The final step is `GET /`. resisted `Goal not reached yet`. legit: USD→CRN 300 (3 ₡). malformed `[]`. privileged
      `null`.
    - *Seams.* `labState` (balances), `netWorthScaled(state)`.
    - *Pitfalls.*
      - Integer math only: Inquisitor's "4-decimal rate" is an integer `E4` field, never a float `0.0001`.
      - Keep the rate tables in the level files and serve them from there, so the inconsistency is visible.
      - The proof is measured against this instance's start.
    - *Text.*
      - Title: `{ id: 'Penyalahgunaan Pembulatan Mata Uang', en: 'Currency Rounding Abuse' }`.
      - Summary: `{ id: 'Tukar uang di money changer pasar sampai nilai bersihmu naik setidaknya $1.00 dari modal awal.', en: 'Trade at the market\'s money changer until your net worth is at least $1.00 above what you started with.' }`.
      - Hints:
        1. `{ id: 'Crown hanya ada dalam satuan utuh. Ke arah mana penukaran membulatkan setengah crown, dan siapa yang diuntungkan?', en: 'Crowns only come in whole units. Which way does an exchange round half a crown, and who gains?' }`
        2. `{ id: 'Batas minimum menghentikan penukaran kecil. Apakah batas itu juga mengubah cara hasilnya dibulatkan?', en: 'A minimum stops tiny exchanges. Does it also change how the result is rounded?' }`
        3. `{ id: 'Di Inquisitor jumlah selalu dibulatkan ke bawah. Bandingkan kedua kurs IDR yang diterbitkan di /api/rates: apakah keduanya benar-benar saling berkebalikan?', en: 'At Inquisitor amounts always round down. Compare the two IDR rates published at /api/rates: are they really the inverse of each other?' }`

- **Batch RM-D — access, API and workflow: RM-11, RM-12, RM-13.**
  - **RM-11 IDOR order access** (`idor-orders`; maps `A01:2025`, `API1:2023`, `CWE-639`; perSession, read-only; no Restart).
    - *Data.* Customers: pilgrim `C-1042` (order 1001: Votive Candle ×3; order 1003: Pilgrim's Rosary ×1), Sister Maren
      `C-1043` (order 1002: Silver Chalice ×1, the target), Brother Tobias `C-1044` (order 1004). Maren's order has Bandung shipping and the gift message
      `"For Brother Anselm: the vault seal rests under the third lantern."`.
    - *Ids per level.* A: `"1001"`…; T: base64url of the number (`MTAwMQ`); I and D: `ORD-` + 10 random Crockford base32
      characters, per player.
    - *Page.*
      - "My orders" (links to `GET <lab>/orders/:id`) and a "Find an order" form (`intent=find`, `id` text; renders the
        channel-`page` lookup).
      - A "Recently shipped" feed: city + item for every order, **with the order id below Divine**.
      - An API box: `GET <lab>/api/orders/:id` and `GET <lab>/api/orders?ids=a,b` (comma-separated, ≤ 10; repeated `ids` → 400).
      - The curl note.
    - *Level interface* (GK-12 style). `idStyle`, `feedShowsIds`, `uniformNotFound`, `canRead(viewerId, order, channel)`,
      `authorizeBatch(viewerId, orders) → orders | 'deny'`.
    - *Acolyte.* Sequential ids; `canRead` true; the batch returns everything.
    - *Templar.* Security by obscurity: ids are base64url-encoded ("nobody can guess them"), but there is still no ownership
      check anywhere.
    - *Inquisitor.* Random ids and a real ownership check on both single-order doors. The flaw: `authorizeBatch` checks only
      the **first** id (`orders[0]?.owner === viewer ? orders : 'deny'`), and the feed leaks Maren's id.
    - *Divine.* Random ids; the feed has no ids; every id in a batch must be owned, otherwise the whole request is a uniform 404
      `Order not found.`. Ownership comes from the session only. ASVS 5.0 V8.2 (object-level authorization).
    - *Statuses.* Denials are `403 Forbidden: this order belongs to another customer.` below Divine (when `uniformNotFound` is
      false); Divine answers 404.
    - *Proof.* Any order in the response whose owner is not `C-1042`. HTML gets a flag line; JSON gets `"flag": "HVWA{…}"`.
    - *Solve.*
      - A: `GET /orders/1002`.
      - T: `GET /orders/MTAwMg`.
      - I: take Maren's id from the feed, then `GET /api/orders?ids=<own id>,<maren id>`.
    - *Matrix.* resistedStatus 404, resisted `Order not found.`. legit: your own order → `Votive Candle`. malformed `[]`.
      privileged `null`.
    - *Seams.* `idsFor(sid, level) → { own: [a, b], victim }`.
    - *Pitfalls.* Compare ids, never use them as object keys. The batch at A/T/I still caps at 10 ids. The Inquisitor single doors
      must deny Maren's id, otherwise its exploit collapses into Acolyte's.
    - *Text.*
      - Title: `{ id: 'IDOR Akses Pesanan', en: 'IDOR Order Access' }`.
      - Summary: `{ id: 'Baca pesanan Sister Maren beserta pesan hadiahnya, padahal pesanan itu bukan milikmu.', en: 'Read Sister Maren\'s order, gift message included, although it is not yours.' }`.
      - Hints:
        1. `{ id: 'Pesananmu punya nomor di alamatnya. Pesanan siapa yang ada di nomor sebelahnya?', en: 'Your order has a number in its address. Whose order sits at the next number?' }`
        2. `{ id: 'Id yang tampak acak belum tentu acak. Bisakah kamu mendekode id pesananmu sendiri?', en: 'An id that looks random may not be. Can you decode your own order id?' }`
        3. `{ id: 'Di Inquisitor setiap pesanan tunggal diperiksa. Bagaimana dengan permintaan yang meminta beberapa pesanan sekaligus: apakah setiap id diperiksa?', en: 'At Inquisitor every single order is checked. What about a request for several orders at once: is every id checked?' }`
  - **RM-12 API4 unbounded bulk export** (`unbounded-export`; maps `API4:2023`, `CWE-770`; stateless; no Restart).
    - *Data model.* A **virtual** sales ledger of `TOTAL_ROWS = 2 500 000`. Row `i` is derived from `i`; nothing is stored.
      - Relation graph: row → `product` (×1); product → `related` (×20, products) | `reviews` (×50, a leaf).
      - The route computes `cost = rows × Π fan-out` **arithmetically** and materializes a preview of at most 20 rows (each
        expansion ≤ 3 children, preview depth ≤ 3).
      - It answers JSON `{ rows, cost, returned, next, data, note, flag? }`, where `note` reads "Truncated by the lab: the real
        server would have built N rows". Costs ≥ 10¹⁵ are shown as `>= 10^15`.
    - *Page.* An HTML landing page (API-only lab): an endpoint table for
      `GET <lab>/api/export?limit=&cursor=&expand=`, an example, and a "Try it" form (`intent=export`, `limit` and `expand` text)
      that renders the same JSON escaped in a `<pre>`. The curl note.
    - *Level interface.* `plan({ limit, cursor, expand }) → { offset, rows, expand: string[] } | { status, error }`.
      - The cursor is base64url of the offset at every level (not the lesson).
      - `expand` is split on `.` and walked along the relation graph. At A, T and I an unknown segment is a 400. Parsing stops
        at 10 segments (a parser bound, not the lesson).
    - *Acolyte.* `rows = min(parseInt(limit) || 100, TOTAL_ROWS − offset)`. No cap.
    - *Templar.* Naive cap: `limit > 100 → 100`, but a legacy branch treats `limit <= 0` as "everything" (`TOTAL_ROWS − offset`).
    - *Inquisitor.* A real page cap: `rows = clamp(parseInt(limit) || 100, 1, 100)`. The flaw: expansion depth is unlimited and
      there is no cost budget, so each `.related` multiplies the work by 20.
    - *Divine.* `limit` must match `/^\d{1,3}$/` and be 1–100 (`400 limit must be between 1 and 100.`). At most one expansion,
      `product` (`400 expand: at most one level.`). A cost budget of 10 000 (`413`). Cursor pagination. ASVS 5.0 V4 (API
      resource limits) and V2.4 (anti-automation, noted out of scope: no rate limit, so no limiter state).
    - *Proof.* `cost >= FLAG_COST (100 000)` on a served plan.
    - *Solve.*
      - A: `GET /api/export?limit=1000000`.
      - T: `?limit=0`.
      - I: `?expand=product.related.related.related` (100 × 20³ = 800 000).
    - *Matrix.* `send` uses GET. resistedStatus 400. resisted
      `{ acolyte: 'limit must be between 1 and 100', templar: 'limit must be between 1 and 100', inquisitor: 'expand: at most one level' }`.
      legit: `limit=10&expand=product` → `"returned":10`. malformed `[]`. privileged `null`.
    - *Seams.* `TOTAL_ROWS`, `FANOUT`, `FLAG_COST`.
    - *Pitfalls.* **Never** build the full result or allocate per planned row. Compute in Numbers and never loop to `rows`. A spec
      checks that a `limit=0` request at Templar responds quickly and that its JSON stays under 64 KB.
    - *Text.*
      - Title: `{ id: 'Ekspor Massal Tanpa Batas (API4)', en: 'Unbounded Bulk Export (API4)' }`.
      - Summary: `{ id: 'Buat API ekspor membangun jauh lebih banyak data daripada yang pantas dilayani satu permintaan.', en: 'Make the export API build far more data than one request should ever be served.' }`.
      - Hints:
        1. `{ id: 'Parameter mana yang menentukan berapa baris yang dibangun server, dan berapa nilai terbesar yang diterimanya?', en: 'Which parameter decides how many rows the server builds, and what is the largest value it accepts?' }`
        2. `{ id: 'Sekarang ada batas atas. Apa arti nol atau angka negatif bagi kode lama itu?', en: 'There is an upper cap now. What do zero or a negative number mean to that legacy code?' }`
        3. `{ id: 'Di Inquisitor ukuran halaman sudah dibatasi. Apa yang melipatgandakan pekerjaan per baris, dan apakah kedalamannya dibatasi?', en: 'At Inquisitor the page size is capped. What multiplies the work per row, and is its depth limited?' }`
  - **RM-13 Workflow skip (pay-step bypass)** (`workflow-skip`; maps `A06:2025`, `CWE-841`; perSession; Restart).
    - *Shop.* Wallet $5.00. `RELIQUARY` $200.00 (20000), `CANDLE` $2.50.
    - *State.* `checkouts: Checkout[]` (≤ 10). Each is `{ id: 8 random hex, lines, total, state: 'created' | 'shipping' | 'paid' | 'confirmed', paid, address }`.
      There is also `pspKey` (32 random bytes per instance; Divine signs with it).
    - *Simulated PSP "Pilgrim Pay".* An in-process function: `charge(state, amount)` debits if `wallet ≥ amount`.
    - *Page.* Catalog, cart, then a checkout panel per open checkout showing its steps (start → shipping → pay → confirm), with
      the current state and buttons. Plus orders and the curl note.
    - *Intents.* `start` (`/checkout/start`), `shipping` (`/checkout/shipping`, `{checkout, address}`), `pay`
      (`/checkout/pay`), `confirm` (`/checkout/confirm`). Plus `GET <lab>/checkout/return?checkout=&status=` (the PSP return
      page).
    - *Level interface.* `pay(state, co, res) → Result | redirect`, `paymentReturn(state, co, status) → Result`,
      `confirm(state, co, { stepCookie }) → Result`.
    - *Acolyte.* `confirm` sets `confirmed` with **no** check. `pay` charges and sets `paid` when funds allow.
    - *Templar.* `pay`, on success, also sets the cookie `relic_step_templar=paid` (not HttpOnly, Path = labPath). `confirm`
      checks only that **client-held** cookie (`Payment required.`).
    - *Inquisitor.* Server-side state. `confirm` requires `co.state === 'paid'`. `pay` calls the PSP and answers 303 to the
      lab-local `…/checkout/return?checkout=<id>&status=success|failed&level=inquisitor`. The flaw: `paymentReturn` sets
      `paid` (and `co.paid = co.total`) whenever the query says `status=success`. The browser's return URL is trusted, and
      nothing proves the PSP charged.
    - *Divine.* On success the PSP makes a "server-to-server" notify. It is an internal call with an HMAC-SHA256 over
      `checkout|amount|status` under `pspKey`; the comment says a real deployment receives it as a signed webhook. The handler
      verifies the signature with `timingSafeEqual` and requires `amount === co.total`. The return page only displays the
      server's state. `confirm` requires `state === 'paid' && paid === total`. Transitions are one-way and each happens once.
      ASVS 5.0 V2.3 (sequential steps, no skipping) and V4 (verify webhook authenticity).
    - *Statuses.* Confirm without payment answers `402 Payment required.` at every level.
    - *Proof.* A checkout in state `confirmed` with `paid < total`. The confirmation reads
      `Order <id> confirmed for shipping. Flag: …`.
    - *Solve.*
      - A: add `RELIQUARY`, start, confirm.
      - T: add, start, set the cookie `relic_step_templar=paid` (devtools or `-b`), confirm.
      - I: add, start, `GET /checkout/return?checkout=<id>&status=success`, confirm.
    - *Matrix.* resistedStatus 402, resisted `Payment required.`. legit: the full flow with a candle (pay succeeds) →
      `confirmed for shipping` and no flag at every level. malformed `[]`. privileged `null`.
    - *Lab-specific cases at Divine.* A notify signed with `pspKey(sid, 'divine')` (seam) for the right amount marks the checkout
      paid. A wrong amount, a wrong signature, or `status=success` on the return URL leaves it unpaid.
    - *Seams.* `labState`, `pspKey`, `signNotify`.
    - *Pitfalls.* The 303 to the return page is a real **lab-local** redirect (`labPath(res)` + path + `level=`), never a sim URL.
      The cookie is per level. Confirming twice must not create two orders.
    - *Text.*
      - Title: `{ id: 'Melewati Langkah Pembayaran', en: 'Workflow Skip (Pay-Step Bypass)' }`.
      - Summary: `{ id: 'Buat pesanan Reliquary ($200.00) dikonfirmasi untuk dikirim tanpa benar-benar membayarnya.', en: 'Get an order for the Reliquary ($200.00) confirmed for shipping without actually paying for it.' }`.
      - Hints:
        1. `{ id: 'Checkout punya beberapa langkah. Apakah langkah terakhir memastikan langkah pembayaran benar-benar terjadi?', en: 'Checkout has several steps. Does the last step make sure the payment step really happened?' }`
        2. `{ id: 'Kalau server mengingat "sudah bayar", di mana ia menyimpannya, dan bisakah kamu menulis di tempat itu sendiri?', en: 'If the server remembers "paid", where does it keep that, and can you write there yourself?' }`
        3. `{ id: 'Di Inquisitor status pembayaran ada di server. Siapa yang memberi tahu server bahwa pembayaran berhasil, dan bagaimana server tahu pesan itu asli?', en: 'At Inquisitor the payment state lives on the server. Who tells the server that a payment succeeded, and how does it know the message is genuine?' }`

---

#### 3. Batching (sequential, one implementer each)

| Batch | Contents | Why together |
|---|---|---|
| **RM-A** | Engine-free prep (Q1, if accepted). The whole `_shared/` from section 1 (shop, clock, race, sql, staff-code, shop-lab, views, testkit, `shop.spec.ts`), `relic-market/index.ts`, the import in `src/districts/index.ts`, RECIPES additions ("Relic Market shop shell", "Race labs", "Time-based labs"). Then RM-05, RM-09, RM-14. | All district-shared pieces land first. The three labs are pure cart and checkout arithmetic, so they exercise the shell end to end. |
| **RM-B** | RM-01, RM-02, RM-03, RM-04 | Injection labs on `perLevel` targets with `sql.ts`, `staff-code.ts`, and the RM-04 docstore. No shop state. |
| **RM-C** | RM-06, RM-07, RM-08, RM-10 | Promotions and money movement. RM-06 and RM-07 share the voucher and discount model. RM-07 and RM-08 share `Gate`/`barrierGate`/`KeyedMutex`. RM-08 and RM-10 are wallet arithmetic. |
| **RM-D** | RM-11, RM-12, RM-13 | Access control, API resource limits and workflow state machines: JSON APIs and non-cart flows. Ends with `npm run gen:catalog` and the full gate. |

---

#### 4. Engine changes needed

**None.** Each building block was checked against the engine at 70f42ae (and on Node 22.22.0 / SQLite 3.50.4 where noted):

- `challengeDb`'s seed already gets the raw handle. `raw.function()` (`sleep`, and the capped `randomblob`/`zeroblob`
  overrides) and `stmt.iterate()` are available on Node 22.22.0 / SQLite 3.50.4 (verified).
- `perSession` (with `reset`), `perLevel`, `tryDb`, `field`, `labPath`, `flagFor`, `defineChallenge({ reset })` and
  `describeExploitMatrix` cover everything. `send` may already fire `Promise.all` scenarios, and `resisted` / `resistedStatus`
  maps cover per-exploit answers.
- Body parsing already handles both RM-04 and RM-06 forms: extended urlencoded (qs, depth 32, arrays for repeated fields) plus
  JSON. The query parser stays "simple".
- Race determinism (`barrierGate`) and fake time (`useFakeClock`) live in the district test kit, not in `tests/` or `core/`.

The only cross-cutting change is optional and districts-level, not engine: see Q1.

---

#### 5. Open questions (with recommended answers)

1. **Where do `curlFor` / `shellQuote` / `curl-note.ejs` (and `Result`, `flagLine`) live?** They are in `gatekeeper/_shared`
   today, and RM needs them. *Recommend:* move them to `src/districts/_shared/` (`curl.ts`, `views/curl-note.ejs`) and re-export
   them from `gatekeeper/_shared/lab.ts`. Update the Gatekeeper view include paths mechanically, as the first step of RM-A.
   Scriptorium and Forum will need the same, and one district should not import another's `_shared`.
2. **RM-14's map.** The catalog says `A05` (Injection in 2025), but integer overflow is really CWE-190 business-logic damage.
   *Recommend:* keep `A05:2025` to match the catalog row and add `CWE-190`. Revisit only if the controller wants to regenerate
   `CATALOG.md` with `A06`.
3. **Memory bombs in SQL labs.** An injected `randomblob(900000000)` allocates about 900 MB, and Node 22 has no
   `sqlite3_limit`. *Recommend:* use `hardenSeed` in RM-01–03 (capped overrides) and open a follow-up to apply it to GK-01 and
   GK-06. Accept the remaining multi-call vectors (`printf` width, `replace`) as the documented availability gap of a loopback
   single-player lab.
4. **Blind labs hide DB errors at every level.** This deviates from "real message below Divine". *Recommend:* yes. A blind lab
   that echoes SQLite errors is no longer blind. Document it in both `divine.ts` comments and in RECIPES, and use
   `malformed: []` plus the explicit "no DB text at any level" case.
5. **perLevel (shared) secrets for RM-01–04.** A player could pass a vault key to another player at the same level. *Recommend:*
   accept it, as GK-01 already does. The targets are read-only and flags stay per session. Per-session SQLite DBs would cost
   memory and need a `close` on the facade.
6. **Production race windows.** RM-07 uses 1000 ms; RM-08 uses 1500 ms (Acolyte) and 400 ms (Inquisitor). *Recommend:* keep them
   wide, so parallel curl, Burp's group send and `Promise.all` in the console all work on loopback. Explain single-packet
   sending (page note, hint 2) but do not require it. Narrower windows cannot be tested anyway: tests use the barrier.
7. **RM-03's delay primitive.** A provided `sleep(seconds)` (with randomblob neutralized) or "the app is slower when a row
   matches"? *Recommend:* `sleep()`. It mirrors how time-based SQLi is taught (`SLEEP`, `pg_sleep`), keeps the injected
   condition inside SQL, and makes Templar's filter meaningful.
8. **Restart on shop labs.** *Recommend:* enable it on RM-05, 06, 07, 08, 09, 10, 13 and 14. None of them has a limiter, every
   proof is relative to the instance, and a spent wallet or voucher otherwise sticks for 26 h. Do not enable it on 01–04, 11 or
   12.
9. **Shop labs without a sign-in form.** *Recommend:* yes, an implicit `pilgrim` customer. Authentication is Gatekeeper's
   subject, and a form per lab only adds steps. RM-04 keeps its own staff login because that login is the lesson.
10. **RM-13 Divine notify as a route?** *Recommend:* an internal call plus test seams, not a public `POST /psp/notify`. Exposing it
    adds a forgery surface that only Divine would defend, and that would blur the Diff.

---

## Controller decisions (2026-11-16, binding)

- **Q1 curl helpers:** accepted. `curlFor`/`shellQuote`/`curl-note.ejs` (+ `Result`, `flagLine` if district-agnostic) move to `src/districts/_shared/`, re-exported from `gatekeeper/_shared/lab.ts`. Done in the shared-template task before RM batch A.
- **Q2 RM-14 map:** keep `A05:2025` (catalog row) and add `CWE-190` in metadata text.
- **Q3 SQL memory bombs:** CHANGED from the recommendation. Mitigate at the ENGINE level, not per lab: the `challengeDb` facade registers capped overrides of `randomblob()` and `zeroblob()` (node:sqlite `db.function` overrides built-ins; verified on Node 22.22) on EVERY challenge DB, so GK-01/GK-06 are covered too. Residual vectors (`printf` width, `replace`, doubling recursive CTEs) are documented in RECIPES §4 as an accepted self-DoS gap of a loopback single-player lab. Done in the shared-template task.
- **Q4 blind labs hide DB errors at every level:** accepted; document in `divine.ts` comments and RECIPES.
- **Q5 perLevel secrets in RM-01–04:** accepted (as GK-01).
- **Q6 race windows (1000 / 1500 / 400 ms):** accepted; tests use the barrier.
- **Q7 RM-03 delay primitive:** `sleep()` accepted.
- **Q8 Restart:** enabled on RM-05, 06, 07, 08, 09, 10, 13, 14 only.
- **Q9 implicit `pilgrim` shopper:** accepted; RM-04 keeps its staff login.
- **Q10 RM-13 Divine notify:** internal call + test seams, no public route.

## Amendments after the RM-A review (2026-11-16, binding)

- **§1 `sql.ts`:** no `hardenSeed` — the engine's `challengeDb` caps `randomblob`/`zeroblob` (Q3). Stored text uses the shell's copying `clipText`; the slicing `clip` is for display cells only.
- **Shell (landing with RM-A fixes):** `KeyedMutex` lives on `ShopState.locks` (per player+level; never module-level); `formatMoney(cents, currency)` throws on non-integers; `addDiscount` / bounded history enforce `LIMITS`; `shopView` splits into base + optional cart/orders parts; shop holders default to `maxEntries: 1000` (~25 KB/instance).
- **Batch D prerequisites (RM-11 / RM-13), to do in batch D's first commit:** `shopView` lists only orders with `owner === CUSTOMER.id`; seeded orders of other customers live in a PINNED store (never evicted by the player's own 30); `Order` ids may be strings (RM-11 UUID-like ids); the API listing supports example paths with parameters (`/api/orders/:id`) without a broken link; `placeOrder` takes a status (RM-13 needs states other than `paid`).
- **Race labs (batch C):** install `barrierGate` right before the race (set-up requests through a racy route count as arrivals); reinstall it after Restart.

## Amendments after the RM-C / RM-D reviews (2026-11-17, binding)

- **RM-07:** the voucher minimum is re-checked at CHECKOUT at every level (applying on a big item, then swapping it for a cheap one, must not charge $0.00).
- **RM-11 Templar:** the activity feed shows the plain order NUMBER (`#1002`); the doors take base64url ids, so the player encodes it (the lesson: encoded ids are not secret).
- **RM-12:** the "unbounded export" is unbounded only in the lab's simulated cost model; the real response is capped (largest API body ~16 KB, Try-it page ~56 KB). `plan()` receives `{ limit, offset, expand }`; one strict canonical cursor parser lives in the model.
- **RM-13:** the flag proof is `confirmed && charged < total`, where `charged` is the PROVIDER's ledger (`received`), not the shop's `paid` (the design's "paid < total" can never hold at Inquisitor, whose forged return sets `paid = total`). The provider charge is idempotent (a checkout is never charged twice). RM-13 builds its confirmed order by hand (`placeOrder` would debit twice).
- **Races (RM-07/08):** `barrierGate` releases passes in a MACROTASK (`setImmediate`), not a microtask; Divine's synchronous reserve/debit is pinned by a level-module unit test with no await.
