# HVWA UI style guide ("The Range Guild — Guild Ledger")

How HVWA looks and how to keep it that way. Everything here is enforced in code or tests where it can be:
`src/public/app.css` (all styles), `src/public/icons.svg` (icons), `src/public/ui.js` (optional enhancements),
`src/core/views/layout.ejs` (the shell), `tests/ui-contrast.spec.ts` (colour pairs) and `tests/ui-shell.spec.ts`
(theme, language, district page, no inline script / handler / style, icon coverage).

**Identity.** A quiet guild hall for security contracts. The guild is a *visual metaphor* (contracts, seals, ledger,
intel, bounty) — not faux-medieval body copy. Warm parchment + ink, hairline rules, a serif spine for headings and
prose, mono for machine strings, one verdigris accent and copper for seals/hardware. No gradients, no shadows, no
rounded card grids, no coloured rules on cards/panels/rows.

**Vocabulary.** Labs = Contracts; levels = Tiers (Acolyte / Templar / Divine); hints = Intel; submit = Claim bounty;
leaderboard = Guild ledger; score = Bounty; solved = Sealed. Indonesian: Kontrak, Tier, Intelijen, Klaim bounty,
Ledger, Bounty, Tersegel.

**Hard constraints** (the lab depends on them, so they are not style choices):

- **Offline.** No CDN, no web font, no image or script from another origin. System font stacks only.
- **No inline script, no inline event handler, no `style=` attribute, no `<style>` element.** Some labs send
  `script-src 'self'` (SC-01 Divine); a future `style-src 'self'` must hold too. JavaScript lives in `/static/*.js`,
  is small, and is optional: every page works without it. The one remaining inline style is the Scroll Desk preview
  box (`desk.ts` `PREVIEW_BOX`, asserted by `desk-shell.spec.ts`): it bounds an attacker-sized image even when CSS
  fails, so it is part of the lab's behaviour and stays.
- **Escaped output.** Views use the escaped output tag for every value. The raw tag is only for HTML the platform
  built and escaped itself (the view body, `diffView`, `flashHtml`, a level module's deliberate XSS fragment).
- **Page budget.** The XSS oracle reads a whole lab page and refuses one over `XSS_LIMITS.htmlLength` (16 KiB). The
  layout around a lab view costs about 5 KiB; keep it there. That is why icons come from `/static/icons.svg` instead
  of an inline sprite. Check with the XSS lab specs (`xss-lab.testkit.ts`, "your page runs the payload only inside
  the sandboxed preview").
- **Presentation only.** Restyling never changes a lab's behaviour, a form field name, an action-less form, a
  `data-testid`, a message class a spec reads, or the XSS preview's sandbox and shim (`core/xss/preview.ts`): style
  around the hook.

## 1. Tokens

Colours are custom properties on `:root`. Components use the semantic names below, never a raw colour
(`ui-contrast.spec.ts` fails on a hex or `rgba()` outside the token blocks). Dark is the default; the light theme is
declared twice, identically: `:root[data-theme="light"]` (explicit choice) and inside
`@media (prefers-color-scheme: light)` for `:root:not([data-theme="dark"])` (system choice).

| Token | Use | Dark (Scriptorium) | Light (Manuscript) |
|---|---|---|---|
| `--bg` | page field | `#0e242c` | `#f5f1e8` |
| `--surface` / `--surface-2` / `--surface-3` | paper / hover / selected | `#14313b` / `#193a45` / `#204652` | `#faf7f0` / `#f1ecdf` / `#e8e2d2` |
| `--sunken` | inputs, tracks | `#0a1d24` | `#ece7da` |
| `--border` / `--border-strong` / `--border-input` | hairline / rule / form control (3:1) | `#2a4d57` / `#3d6873` / `#7f9aa0` | `#d8d0bd` / `#bdb39b` / `#7c7462` |
| `--text` / `--text-muted` / `--text-faint` | ink / secondary / mono labels | `#e8d9b8` / `#b9ae94` / `#9a917b` | `#1a1612` / `#5b5548` / `#6d6658` |
| `--primary` + `--on-primary` | verdigris action, buttons | `#7dd3c0` + `#0b1e24` | `#2f6a5f` + `#fbf7ec` |
| `--primary-text` | accent text (eyebrows, ids) | `#8ddcc9` | `#2f6a5f` |
| `--link` / `--focus` | links / focus ring | `#8ddcc9` | `#2f6a5f` |
| `--copper` | seal/hardware, never state | `#d49872` | `#a9682f` |
| `--inverted` + `--on-inverted` | the near-black emphasis slip | `#e8d9b8` + `#0e242c` | `#1a1612` + `#f5f1e8` |
| `--success`, `--danger`, `--warning`, `--info` (+ `-bg`, `-border`) | status | verdigris, oxblood, copper, azure | darker tones |
| `--lv-acolyte` / `--lv-templar` / `--lv-inquisitor` / `--lv-divine` (+ `-bg`) | the four tiers | teal / azure / copper-amber / violet | darker tones |
| `--on-level` | text on a solid level fill | `#0b1e24` | `#faf7f0` |
| `--code-bg`, `--code-text`, `--diff-del-bg`, `--diff-add-bg`, `--banner-*` | code, diff, banner | | |

**Contrast.** Every text pair is at least 4.5:1 and every UI boundary (input border, focus ring, seal ring) at least
3:1 in both themes. The full list of pairs lives in `tests/support/contrast.ts`; add a pair there when a component puts
a token on a new background.

**Levels.** One colour per tier, used for badges (`.level-badge[data-level]`), chips (`.level-chip.level-<l>`), the
lab bar's switcher and the dossier's tier rows. Any element with `data-level="<level>"` (or class `level-<level>`) gets
`--lv` and `--lv-bg`. Tiers are drawn as **monochrome seals, mono text and tonal washes** — never a coloured rail or a
solid level card. Colour is never the only signal: the tier's name is always written.

**Contracts.** The challenge `title` is the player-facing name (funny/self-own) and the primary heading (catalog card, lab `h1`, continue slip, My Lab chip); the in-world `app` name stays as the muted secondary line. Five labs: r01 I Trusted the Search Bar (Mercy Clinic), r02 Oops, That Parcel Wasn't Mine (Courier), r03 It's Just a Ping, Bro (Beacon), r04 My Greeting Card Is Possessed (Postcard), r05 I Believe My Crypto Web Is Very Secure (Binanse). r05 is hard-only, with a single Inquisitor tier and no Divine reference.

**Contract dossier (lab page).** A mono `CONTRACT rNN · N TIERS · BOUNTY N` meta line opens the hero, then the category + difficulty eyebrow, a huge serif challenge title, the in-world app as a mono subtitle, the scenario, and the sealed stamp; the per-lab illustration sits on the right. Under the hero is a full-width **tier-card ladder** — one card per tier (name serif, meaning, points mono, state seal; the current tier gets a tonal wash + ink dot, solved gets a seal; 2×2 on tablet, one column on mobile, one row on desktop). The body is two columns: the main column holds the mission brief (serif lead with a thin ink hairline), the intel accordion and a prominent **claim-bounty** fieldset (one large mono flag input + one primary button); the sticky right rail holds the active-contract panel and "How the range works".

**Adventurer rank (E → S).** Derived from bounty points (`src/range/rank.ts`), never stored: E 0, D 300, C 1000, B 2000,
A 3000, S 3750. Everyone starts at E; the names are Initiate / Scout / Adept / Veteran / Elite / Legend (Pemula /
Pengintai / Ahli / Veteran / Elit / Legenda). Shown as a copper seal letter + mono name (`.rank-seal` + `.rank-name`) in
the Guild Hall ledger (with a `points / next` progress bar), the account menu, and every leaderboard row — always
distinct from the numeric `#1` position, which stays mono text. There is no rank entry in the DB; the existing score is
the only source.

**Teams and team mode.** One team per member, run from the `/team` page (plain form page: create with a name and a
generated 8-char base32 join code, join by code, leave). A lab in team mode (an admin switch, default individual) gets a
small mono `TEAM` badge (`data-mode="team"`) on its catalog card and dossier hero; individual labs get no badge. The
Guild ledger has two plain-link tabs — Individual (unchanged) and Teams (`/leaderboard?board=teams`) — where a team's
bounty is the sum of the best level any member proved per team-mode lab, with rank, score, solved, members and last
solve. The badge is neutral ink (`.team-mode-badge`), never a coloured rail.

**Admin dashboard (role admin, `src/range/admin.ts`).** An `Admin` masthead tab (admin only) opens `/admin`, with a
compact five-link sub-nav — Overview / Activity / Instances / Teams / Labs (`.tabs.admin-tabs`). Players and anonymous
users get the ordinary 404 / login for every `/admin/*` path, and the tab is not rendered for them. Overview is ledger
stat cards (live/capacity, users, teams, exploits in 24h) plus a mono state-count strip (queued/starting/running/stopping),
the **live exploit feed** (`/admin/live`, an `<ol class="admin-live">` polled by htmx every 5 s, `aria-live="polite"`,
no focus steal — never a flag, only time/user/team/lab-level/points), the latest activity and a running-instances preview.
Activity is the full feed with an event select (groups `range.*`, `team.*`, `auth.*`, `admin.*` plus exact events), user,
team, lab and date filters and 50 rows per page. Instances is a Portainer-like table (instance id, user, team, lab/level,
state, started, age, expires, the warden's container state where known) with a Stop action, then recently ended rows —
read-only diagnostics, no socket/port/secret. Teams shows the join code, members (removable), score and created, with
create/delete (confirm via `data-confirm`). Labs is one row per registry lab with its mode select and last-updated
by/time; flipping a lab to team mode immediately shows the TEAM badge and feeds the team leaderboard. Everything uses the
same paper/ink ledger surfaces, hairlines and mono machine strings — no coloured rails, no inline script/style; every
state-changing form is CSRF + Origin + Sec-Fetch-Site guarded, and every value is escaped.

**Type.** `--serif`: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif` (display
headings, the mission brief, contract titles); `--sans`: `ui-sans-serif, system-ui, "Segoe UI", Roboto,
"Helvetica Neue", Arial, sans-serif` (body UI, controls, forms); `--mono`: `ui-monospace, "Cascadia Code", "JetBrains
Mono", Consolas, monospace` (machine strings, ids, counts, timers, labels, bounty figures). Human prose may be serif;
controls are sans; machine strings are mono. Display: serif 600, `clamp(2.4rem, 4.2vw, 3.8rem)`, line-height 1.05,
`-0.02em`. Eyebrow/label: mono uppercase 11 px (`--fs-label`), `0.08em` tracking, 60% ink. Numbers: tabular mono.

**Space, shape, motion.** `--sp-1`..`--sp-7` = 4, 8, 12, 16, 24, 32, 48 px. 0 px on editorial surfaces (contract slips,
panels, tables); 4 px on buttons/inputs (`--radius-sm`); no pill CTAs. **No box-shadows**; depth = 1 px neutral ink
hairline + a 2–6% tonal wash. Touch targets `--tap` 44 px. Transitions 160 ms (`--dur`, `--ease`) on
background/transform/opacity only; `prefers-reduced-motion: reduce` turns them off. Z-index: `--z-header` 20,
`--z-menu` 30, `--z-skip` 100.

**No coloured rules (hard rule).** Never put a coloured line, rail, top border or left border on a card, contract
slip, panel, toast, table row or form. Every surface uses one neutral ink hairline. State (current tier, solved,
error, success, rank) is shown by a seal/monogram, mono text, a small dot, or a tonal background wash. A single accent
underline is allowed on the active masthead tab only.

**Breakpoints.** Mobile first; 480, 640, 768, 900, 1024, 1440 px. No page scrolls horizontally at 375 px; tables, `pre`
and the diff scroll inside their own box.

## 2. Theme and language

- **Language:** English by default. `?lang=id|en` sets the `hvwa_lang` cookie (`core/i18n.ts`); the EN/ID switch in
  the masthead is two plain mono text links separated by a `/`. Platform strings live in `core/i18n.ts` (both
  languages); lab-internal text is English.
- **Theme:** `?theme=dark|light|system` sets `hvwa_theme` (`core/theme.ts`, same cookie policy as the others). The
  server renders `data-theme` on `<html>` for an explicit choice; with none, CSS follows `prefers-color-scheme`. The
  toggle is a link to the theme you are not on (CSS hides the other one), so it works without JavaScript and never
  flashes the wrong theme.

## 3. The shell (`core/views/layout.ejs`)

Skip link, the thin safety strip, the default-password row (login on, default password in use), the sticky masthead
(brand, Contracts/Ledger tabs, EN/ID, theme, Active contract tag, account initials + caret menu), breadcrumbs
(`crumbs` data on portal pages), the lab bar on lab pages, the view, the victim panel, the footer, and the `#toasts`
slip layer. Portal pages pass `pageTitle` and `crumbs` (`[{ label, href? }]`); a lab view passes neither (the lab bar
owns both).

**Masthead, not a dashboard bar:** 64 px, hairline bottom, sparse. Left: the guild crest (inline SVG) + `HVWA`
wordmark + a tiny mono `RANGE GUILD` tag. Nav: `Contracts` / `Ledger` text tabs, active = 2 px verdigris underline.
Right: mono `EN / ID` text swap, one theme icon button, the **Active contract** tag (state dot + app + time), the
account initials square + caret menu.

**Lab bar** (every `/d/<district>/<slug>` page, automatic): breadcrumb Home › District › ID › Lab, Restart lab (when
the challenge has a reset hook) and Back to challenge, the id/title/level badge, the summary, the level switcher
(document tabs; the current one is a tonal wash + level dot), and "You are on <level>: <meaning>". Lab pages use one
centred column (`.content-lab`, 60 rem).

## 4. Components

| Component | Markup | Notes |
|---|---|---|
| Button | `<button class="btn btn-primary">` / `btn-secondary` / `btn-ghost` / `btn-quiet` / `btn-danger`; sizes `btn-sm`, `btn-xs`, `btn-lg`, `btn-block` | Flat, 4 px, one primary per screen. `btn-quiet` is an underlined text action (Reset/Stop). |
| Icon button | `<a class="icon-btn" aria-label="…">` + icon | Always an `aria-label`. |
| Icon | `<svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-…"></use></svg>` | Lucide style, 24 px grid, stroke 2; `icon-sm`, `icon-lg`. Add symbols to `icons.svg`; `ui-shell.spec.ts` checks every used id exists. Never emoji. |
| Surface / panel | `<section class="card panel">` + `<h2>` + `.panel-lead` | Paper slip, 1 px hairline, 0 radius, no shadow. |
| Seal | `<span class="seal">` (`.seal-sm`, `.seal-copper`) | Monochrome outlined ring with a letter/numeral. |
| Badge, tag | `.badge`, `.badge-ok`, `.badge-solved`, `.level-badge[data-level]`, `.tag` (mono) | Square, never pill; level colour in text + a dot, on a tonal wash. |
| Alert / result | `.alert alert-*`, `.result result-ok\|result-bad`, `[data-error][role="alert"]` | Icon/glyph + text, tonal wash, never colour alone. |
| Field | `<div class="field"><label for="x">…</label><input id="x"><p class="help">…</p><p class="field-error result result-bad" role="alert">…</p></div>` | Labels always visible; errors under their field; `aria-invalid` + `aria-describedby`. |
| Table | `<div class="table-wrap"><table class="table">` | Flat hairline rows, `.num` right-aligns mono figures. |
| Tabs / filters | `<nav class="tabs">` of `<a aria-current="page">` | Links, no JS. |
| Accordion | `<details class="accordion"><summary>…</summary><div class="accordion-body">…</div></details>` | Intel uses it (progressive). |
| Menu | `<details class="menu">` + `.menu-panel` + `.menu-item` | `ui.js` closes it on Escape / outside click. |
| Progress | `<progress class="progress" max value>` | No inline width needed. |
| Empty state | `<div class="empty">` icon + text + action | |
| Loading | `.skeleton`; htmx forms get a spinner on the submit button while `.htmx-request` | |
| Code | `<pre>`, `.source-view`, `.diff-wrap > .diff-view` | Scroll inside the block. |
| Contract slip | `<a class="contract-slip lab-card lab-theme-…" data-testid="lab-card" data-lab data-difficulty data-solved data-theme>` (src/range/views/catalog.ejs) | Paper dossier: category tab, monochrome rank seal, pin dot, serif app name, objective, tier rows with seals + points, mono bounty, arrow. |
| Active-contract panel | `<section id="lab-panel" class="card panel lab-panel" data-state>` (src/range/views/panel.ejs) | State dot + label, time bar, one primary action (Launch or Open lab), quiet Reset/Stop; full/failed/stopped reasons with relaunch. htmx re-fetches the whole section (`hx-swap="outerHTML"`): every 1 s starting, 30 s running. |
| Active contract tag | `<a class="my-lab" data-state>` (core/views/my-lab.ejs) | In the masthead on every signed-in page; state dot, app + time left; refreshes every 30 s. |
| Toast (stamped slip) | `<div id="toasts" class="toasts">` + `.toast toast-success\|error\|info` (built by ui.js) | Paper slip, seal glyph, mono eyebrow, serif message, close, auto-dismiss ~5 s, max 3, bottom-right (bottom-centre < 640 px), `role="status"`, no focus stealing, paused on hover/focus. Driven by `data-toast-*` on action-swap fragments only, never polls. |
| Solve dialog | `<dialog id="solve-dialog" class="solve-dialog" data-variant>` (core/views/layout.ejs) + `.solve-slip` / `.solve-seal` / `.solve-title` / `.solve-message` / `.solve-points` / `.solve-fact` / `.solve-confetti` / `.solve-continue` | The submit-result popup. Paper slip, monochrome/verdigris seal glyph (stamp animation), serif title, message, mono points, a bordered `FIELD NOTE` fact, and a Continue button; close on Escape/backdrop/Continue. Opens from `data-modal-*` on the submit-result fragment (never polls); the fact and confetti render only for a solved/new-best seal. `prefers-reduced-motion` disables the stamp/confetti animation. |

**Illustrations.** The sprite also carries a set of flat, single-weight line illustrations (`stroke="currentColor"`,
`aria-hidden`, no gradients, no emoji) used only on portal pages — never in the shared lab layout, so the lab page
budget is untouched: `i-guild-hall` (Guild Hall hero), `i-ill-clinic` / `i-ill-courier` / `i-ill-beacon` /
`i-ill-postcard` / `i-ill-binanse` (contract-slip watermark + dossier hero, mapped from the lab's `themeId`), `i-guild-gate` and
`i-key-seal` (login / register / password panels), `i-laurel` (leaderboard title) and `i-empty-scroll` (empty states
and the error page). Each page uses a distinct composition.

## 5. Writing a lab view

Lab views stay plain, semantic HTML; the stylesheet does the rest (`.lab` and its descendants):

```html
<section class="lab">
  <h1>Citadel Gate — Sign in</h1>
  <p class="lab-note">Your account: <code>pilgrim</code> / <code>pilgrim</code></p>
  <form method="post">
    <label>Username <input name="username" type="text" autocomplete="off" spellcheck="false" value="…"></label>
    <button type="submit">Sign in</button>
  </form>
  <p class="lab-message lab-success" role="status" data-testid="lab-message">…</p>
</section>
```

- One `<section class="lab">` per view; its first `<h1>` is the lab app's name. `<h2>` starts a sub-part (divider
  above). A nested `<section>` is drawn as an inset panel.
- Labels wrap their input (the label is always visible). Inputs are monospaced so payloads stay readable.
- Messages: `<p class="lab-message lab-success|lab-error">`; an inline flag inside a note may be
  `<span class="lab-success">` (a pill). Notes: `<p class="lab-note">`, with `<code>` for anything the player types.
- Lists of records: a `<ul>`/`<ol>` with a class becomes a list of bordered rows; a button inside a row is
  secondary automatically. Tables need no wrapper: inside `.lab` they scroll in their own box.
- Shared partials: the curl line (`_shared/views/curl-note.ejs`), the XSS proof (`xss-proof.ejs`), the Relic Market
  shop parts (`relic-market/_shared/views`), the Scroll Desk (`scriptorium/_shared/views/desk.ejs`), the victim panel
  (automatic). Prefer them, and prefer a shared class over per-lab CSS.
- Do not: add `style=`, `<style>`, `<script>` or `on*=`; add an icon or a wrapper inside an element a spec matches
  exactly (a `data-testid` element, a message); put platform guidance inside the lab (that is the lab bar's job);
  link a lab page from the portal (portal pages link `/c/<id>`).

## 6. Do and don't

- Do use tokens and existing components; add a token (both themes) and a contrast pair before a new colour.
- Do write the meaning in text next to every colour (tiers, statuses).
- Do keep focus visible (the global `:focus-visible` ring); never remove an outline.
- Do prefer hairlines and tonal washes over borders and shadows; one accent per view.
- Don't animate layout properties; don't add hover-only affordances; don't use emoji as icons; don't use gradients,
  glass or drop shadows; don't put a coloured rule on a card, slip, panel, toast, row or form.
- Don't rely on JavaScript: `ui.js` may enhance, never enable.
- Check a change in both themes at 390 and 1440 px (headless Chrome screenshots), and run `npm test`.
