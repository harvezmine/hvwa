# HVWA UI style guide ("The Adventurers' Guild")

How HVWA looks and how to keep it that way. Everything here is enforced in code or tests where it can be:
`src/public/app.css` (all styles), `src/public/icons.svg` (icons), `src/public/ui.js` (optional enhancements),
`src/public/fonts/`, `src/public/tex/` and `src/public/audio/` (same-origin assets), `src/core/views/layout.ejs`
(the shell), `tests/ui-contrast.spec.ts` (colour pairs) and `tests/ui-shell.spec.ts` (theme, language, district page,
no inline script / handler / style, icon coverage, same-origin assets).

**Identity.** An adventurers' guild. Every challenge is a **bounty** pinned to a wooden **board**, every player an
**adventurer** with a guild card, a rank plate and a place in the **Hall of Fame**. Materials, not decoration: a plaster
wall (the page), oak/walnut **wood** for the masthead beam, boards, hanging signs and the claim desk, **parchment** for
bounties and guild papers, red **wax** for seals, **brass** for actions, and **metal plates** for ranks. The look is
restrained skeuomorphism: textures are subtle, text only ever sits on a solid token colour (never on raw grain), and
the vulnerable app inside a lab keeps its own look.

**Vocabulary** (player-facing labels only; ids, URLs, DB values and `data-*` hooks keep the old names). Labs =
Bounties; categories = boards (`track`: Siegeworks = web, Cipher Vault = crypto, The Forge = pwn, Artificer's Bench =
reverse, Crypt & Clues = forensics, Tavern Rumours = osint, Odd Jobs = misc); the in-world app = the Client; levels =
Threat levels (acolyte Common, templar Dangerous, inquisitor Deadly, divine Warded); hints = Tavern whispers; points =
Gold (G); submit = Claim at the desk; solved = Sealed; leaderboard = Hall of Fame; team = Party; the active instance =
Quest. Indonesian: Bounty, Papan, Klien, Tingkat ancaman (Biasa / Berbahaya / Maut / Tak Tertembus), Bisikan kedai,
Gold, Klaim di meja, Tersegel, Papan Kehormatan, Party, Quest.

**Hard constraints** (the lab depends on them, so they are not style choices):

- **Same origin only.** No CDN, no script, image, font or sound from another origin. Fonts are self-hosted woff2
  (`fonts/`, OFL, latin subset, `font-display: swap`, each with a system fallback); textures are tiny SVG noise
  tiles (`tex/`); the music is one local mp3 (`audio/`). CSS `url()` may only point at `/static/…`.
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

Colours are custom properties on `:root`. Components use the semantic names, never a raw colour
(`ui-contrast.spec.ts` fails on a hex or `rgba()` outside the token blocks). Dark ("the tavern at night") is the
default; the light theme ("the guild hall by day") is declared twice, identically: `:root[data-theme="light"]`
(explicit choice) and inside `@media (prefers-color-scheme: light)` for `:root:not([data-theme="dark"])`.

| Group | Tokens | Use |
|---|---|---|
| Wall and papers | `--bg`, `--surface`, `--surface-2`, `--surface-3`, `--sunken`, `--border*`, `--text`, `--text-muted`, `--text-faint` | The page and its cards, panels, tables and forms (dark walnut/leather at night, plaster/paper by day). |
| Actions | `--primary` (brass) + `--on-primary`, `--primary-text`, `--link`, `--focus`, `--copper` | Buttons are brass plaques; links are wax-red by day, candle-peach at night. |
| Status, levels | `--success`, `--danger`, `--warning`, `--info` (+ `-bg`, `-border`), `--lv-<level>` (+ `-bg`), `--on-level` | Unchanged roles. Common green, Dangerous amber, Deadly blood-red, Warded arcane violet. |
| Wood | `--wood`, `--wood-2`, `--wood-3`, `--on-wood`, `--on-wood-muted` | Masthead beam, footer, boards, planks, signs, claim desk, the login door. Only on-wood text sits on wood. |
| Parchment | `--parch`, `--parch-2`, `--ink`, `--ink-muted`, `--ink-ok` | Bounty posters, the guild card, the quest note, the dossier hero, toasts, the solve receipt. The `.parchment` scope re-points `--text`/`--surface`/status tokens at ink so shared components read on paper in both themes. |
| Wax, metal | `--wax`, `--wax-hi`, `--wax-dark`, `--on-wax`; `--m-copper`…`--m-adam` (+ `-hi`), `--on-metal`, `--on-metal-dark` | Seals and pins; rank plates (`[data-plate="e".."s"]`) and the Hall of Fame plaques. |
| Depth | `--shade`, `--sheen`, `--shadow`, `--shadow-sm`, `--shadow-poster` | Soft shadows and highlights; one elevation scale. |
| Textures | `--tex-wood` (`tex/wood.svg`), `--tex-paper` (`tex/fibre.svg`, cards/panels), `--tex-parch` (`tex/paper.svg`, parchment) | Static noise tiles over a token colour, never animated. |

**Contrast.** Every text pair is at least 4.5:1 and every UI boundary at least 3:1 in both themes, including the
material pairs (on-wood on wood, ink on parchment, on-wax on wax, on-metal on each plate, brass on the beam). The list
lives in `tests/support/contrast.ts`; add a pair there when a component puts a token on a new background.

**Bounties.** The challenge `title` is the player-facing name, the in-world `app` is the **Client**. Titles name one
concrete thing from the lab's world plus a hint of the flaw: r01 The Clinic's Secret Ledger (Mercy Clinic, SQLi),
r02 The Courier Never Asks (Courier, access control), r03 Whisper to the Watchtower (Beacon, command injection), r04
The Ink That Writes Back (Postcard, SSTI), r05 The Dragon Hoard Heist (Binanse, stored XSS, hard-only: one Deadly
threat level, no Warded reference). Titles live in `labs/<lab>/lab.json` and `labs/registry.json` (kept equal).

**Guild Hall (catalog).** A hall heading beside the **guild card** (rank plate, name, title, gold, bounties done, two
progress bars), the pinned **quest-in-hand** note, then the **bounty boards**: one wooden board per `track` in a
horizontal scroll-snap carousel. The hanging signs above and each board's plank (‹ previous · name · next ›) are plain
`#board-<track>` anchors, so boards switch without JavaScript; `ui.js` slides horizontally only, wraps around, keeps
the active sign and the URL hash in step, adds brass arrow knobs and arrow keys, and plays one slide sound when a move
settles. Chromium also settles each board in with a scroll-driven scale/fade. A board with no lab yet shows "soon" and
three bare pins. Posters are parchment with a brass pin, a torn edge (`clip-path: var(--torn)` on `::before`, so the
pin and seal may overhang), a slight tilt per `:nth-child`, the blackletter "Bounty" kicker, the client, title,
scenario, vulnerability tag, threat-level pips, threat marks (◆◇) + difficulty word, the gold reward and a wax
`SEALED` seal once solved. A new lab picks its board with `"track"` in lab.json (default `web`).

**The bounty on the desk (lab page).** A parchment hero (`BOUNTY rNN · N THREAT LEVELS · REWARD N G`, client, title,
scenario, tag, threat, sealed line, illustration, a large wax seal when solved), the threat-level cards, then the
client's request (a quoted paper), the tavern whispers and the **claim desk** (a wooden panel with the flag input and
the brass Claim button); the rail holds the active-quest panel and "How a bounty works" (sticky on desktop, above the
request below 1024 px so Launch comes before reading).

**Adventurer rank (E → S).** Derived from gold (`src/range/rank.ts`), never stored. The thresholds are shares of the
full bounty (each lab paid once, at its best scored tier): D 10%, C 25%, B 45%, A 70%, S 95%, rounded to 10 G, so
they rescale by themselves when labs are added. With the six labs today (2400 G): D 240, C 600, B 1080, A 1680, S 2280.

**Gold and the merchant.** Every account holds a 20 G starter purse (exactly one Scroll of Revelation, the medium
scroll), shown once in Mira's gift popup on the hall after the avatar step. Gold = 20 + best-tier bounties − scrolls
and old paid hints. The merchant sells only when the purse holds the full price (no tab); a ware the purse cannot
pay for shows the missing gold and a disabled button. The same gold ranks the Hall of Fame, so a scroll is a fair
penalty and the equal starter purse leaves the order unchanged. Each letter has a plate and a title: E Copper
Greenhorn, D Iron Pathfinder, C Silver Sellsword, B Gold Knight-errant, A Mithril Champion, S Adamantite Legend
(Tembaga Anak Bawang, Besi Penjelajah, Perak Pendekar, Emas Ksatria Kelana, Mithril Jawara, Adamantit Legenda). Shown
as a `.rank-plate[data-plate]` on the guild card and as a metal `.rank-seal[data-plate]` in the account menu and every
Hall of Fame row — always distinct from the numeric position.

**Hall of Fame.** Gold, silver and copper plaques for the top three (1 in the middle and raised from 640 px), a
standing note for the viewer (`Top N%` and "N G to pass <name>", or "You stand first"), the table, the pinned "Your
position" row, and the Adventurers / Parties tabs.

**Party.** One party per adventurer (`/team`): found or join forms, or the party sheet with a wax pennant, the join
code, member chips and Leave. A lab in party mode shows a `PARTY` badge on its poster and hero.

**The Guildmaster's Office (role admin, `src/range/admin.ts`).** Never a player tab: admins get a wax **Guildmaster's
Office** button in the masthead (`.btn-office`, `data-testid="nav-admin"`; icon-only below 1200 px with a screen-reader
label), and an admin who signs in with no page to return to lands on `/adminportal` (`AuthOptions.adminHome`; an explicit
`next` still wins). Every `/adminportal/*` page renders the shell in **office mode** (`<body class="office">`): a wax-edged
beam with the office plaque in place of the player tabs, a wax **Guild Hall** button back (`nav-hall`), and the five
sections (Overview / Activity / Instances / Parties / Labs, `admin-nav.ejs`) as a wooden ledger spine beside the page
(a swipeable strip below 900 px). Players and anonymous users still get the ordinary 404 / login for `/adminportal/*`. The
pages keep their roles: ledger stat cards, the live exploit feed (`/adminportal/live`, htmx every 5 s, never a flag), the
filtered activity feed, the instances table with Stop, parties with create/delete, and the per-lab mode switch; every
state-changing form is CSRF + Origin + Sec-Fetch-Site guarded and every value is escaped.

**Type.** `--serif` EB Garamond (headings, prose, the brief; body 17 px because Garamond reads small); `--display`
Cinzel 700 (caps only: eyebrows, labels, buttons, nav, signs, plaques); `--poster` Pirata One (only the "Bounty" kicker,
≥ 2 rem); `--sans` system sans (kept for a few controls); `--mono` system mono (flags, ids, vulnerability tags, code).
Numbers use `tabular-nums lining-nums`.

**Space, shape, motion.** `--sp-1`..`--sp-7` = 4, 8, 12, 16, 24, 32, 48 px. Radius 3 / 5 / 10 px. One shadow scale
(`--shadow-sm`, `--shadow`, `--shadow-poster`). Touch targets `--tap` 44 px. Transitions 180 ms (`--dur`, `--ease`;
`--ease-swing` for posters, toasts and the dialog) on transform/opacity/rotate/translate only. Motion: posters
straighten on hover, signs swing, boards slide, the seal stamps, coins fall on a solve; `prefers-reduced-motion:
reduce` turns all of it off and removes the tilts.

**Sound.** `ui.js` plays the guild music (`audio/adventures-begin.mp3`, "Adventures Begin" by Pufino, freetouse.com,
credited in the footer) and Web Audio effects (knock on clicks, paper on menus/accordions, a slide between boards,
seal + coins on a solve, a low tone on a wrong flag, coins on a bought whisper). One masthead toggle
(`[data-sound-toggle]`, `aria-pressed`, hidden without JS) switches all of it; the choice is remembered per browser
(localStorage). Browsers block audio before a gesture, so music starts on the first click/key press (fade-in, low
volume) and resumes its position on the next page of the tab. Default: on (one constant in `ui.js`).

**Breakpoints.** Mobile first; 480, 640, 768, 900, 1024, 1400 px. No page scrolls horizontally at 375 px; tables, `pre`,
the diff, the board carousel and (on phones) the sign strip scroll inside their own box.

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
(brand, Bounty Board / Party / Hall of Fame tabs, EN/ID, theme, sound, Active quest tag, wax-seal account initial + caret menu), breadcrumbs
(`crumbs` data on portal pages), the lab bar on lab pages, the view, the victim panel, the footer, and the `#toasts`
slip layer. Portal pages pass `pageTitle` and `crumbs` (`[{ label, href? }]`); a lab view passes neither (the lab bar
owns both).

**Masthead: a wooden beam.** 64 px of wood grain with a 3 px dark edge. Left: the brass crest + Cinzel `HVWA` + the
`ADVENTURERS' GUILD` tag (hidden below 1400 px). Nav: display-caps tabs, active = 2 px brass underline. Right: `EN / ID`,
the theme icon, the sound toggle, the **Active quest** tag (state dot + bounty + time) and a wax-seal account initial with
its caret menu. The footer is the same wood, with the music credit.

**Lab bar** (every `/d/<district>/<slug>` page, automatic): breadcrumb Home › District › ID › Lab, Restart lab (when
the challenge has a reset hook) and Back to challenge, the id/title/level badge, the summary, the level switcher
(document tabs; the current one is a tonal wash + level dot), and "You are on <level>: <meaning>". Lab pages use one
centred column (`.content-lab`, 60 rem).

## 4. Components

| Component | Markup | Notes |
|---|---|---|
| Button | `<button class="btn btn-primary">` / `btn-secondary` / `btn-ghost` / `btn-quiet` / `btn-danger`; sizes `btn-sm`, `btn-xs`, `btn-lg`, `btn-block` | Display caps; the primary is a brass plaque; one primary per screen. `btn-quiet` is an underlined serif text action (Reset/Stop). |
| Icon button | `<a class="icon-btn" aria-label="…">` + icon | Always an `aria-label`. |
| Icon | `<svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-…"></use></svg>` | Lucide style, 24 px grid, stroke 2; `icon-sm`, `icon-lg`. Add symbols to `icons.svg`; `ui-shell.spec.ts` checks every used id exists. Never emoji. |
| Surface / panel | `<section class="card panel">` + `<h2>` + `.panel-lead` | Guild paper: fibre texture over `--surface`, hairline, 5 px radius, `--shadow-sm`. |
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
| Bounty poster | `<a class="poster contract-slip lab-card lab-theme-…" data-testid="lab-card" data-lab data-difficulty data-solved data-theme>` inside `.board-slide` (src/range/views/catalog.ejs) | Parchment, brass pin, torn edge, tilt, "Bounty" kicker, client, title, scenario, tag, threat pips, threat marks, gold, wax seal when solved. |
| Board carousel | `[data-boards]` > `.board-signs` (`[data-board-link]`) + `.boards-viewport` > `[data-boards-track]` > `.board-slide#board-<track>` | Scroll-snap slides, anchors work without JS; `ui.js` adds arrows, keys, hash and sound. |
| Rank plate | `.rank-plate[data-plate]` > `.plate-letter` + `.plate-metal`; `.rank-seal[data-plate]` | Metal by rank letter (e..s). |
| Wax seal | `.wax-seal` (`.wax-seal-lg`) | Pressed at an angle; `aria-hidden` or with a `title`. |
| Active-quest panel | `<section id="lab-panel" class="card panel lab-panel" data-state>` (src/range/views/panel.ejs) | State dot + label, time bar, one primary action (Launch or Open lab), quiet Reset/Stop; full/failed/stopped reasons with relaunch. htmx re-fetches the whole section (`hx-swap="outerHTML"`): every 1 s starting, 30 s running. |
| Active quest tag | `<a class="my-lab" data-state>` (core/views/my-lab.ejs) | In the masthead on every signed-in page; state dot, app + time left; refreshes every 30 s. |
| Toast (pinned note) | `<div id="toasts" class="toasts">` + `.toast toast-success\|error\|info` (built by ui.js) | Parchment note, wax/brass/silver seal glyph, display-caps title, serif message, close, auto-dismiss ~5 s, max 3, bottom-right (bottom-centre < 640 px), `role="status"`, no focus stealing, paused on hover/focus. Driven by `data-toast-*` on action-swap fragments only, never polls. |
| Solve dialog | `<dialog id="solve-dialog" class="solve-dialog" data-variant>` (core/views/layout.ejs) + `.solve-slip` / `.solve-seal` / `.solve-title` / `.solve-message` / `.solve-points` / `.solve-fact` / `.solve-confetti` / `.solve-continue` | The submit-result popup. A parchment receipt, a wax seal stamped onto it (silver for wrong/lower), display-caps title, italic message, gold figure, a dashed `FIELD NOTE` fact and a Continue button; falling coins on a solve; close on Escape/backdrop/Continue. Opens from `data-modal-*` on the submit-result fragment (never polls); the fact and confetti render only for a solved/new-best seal. `prefers-reduced-motion` disables the stamp/confetti animation. |

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
- Do keep text on solid token colours (parchment, paper, a plank); grain and stains stay behind, never under small text.
- Don't animate layout properties or textures; don't add hover-only affordances; don't use emoji as icons; don't load
  anything from another origin; don't play sound without the toggle.
- Don't rely on JavaScript: `ui.js` may enhance, never enable.
- Check a change in both themes at 390 and 1440 px (headless Chrome screenshots), and run `npm test`.
