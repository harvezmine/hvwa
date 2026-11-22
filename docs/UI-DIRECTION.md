# HVWA UI — Research & Final Direction

> Controller research memo, 2026-11-22. This supersedes the "Field Manual" draft: keep its layout discipline, but the identity is **The Range Guild — Guild Ledger**.

## 1. What the research actually says

Sources and the patterns worth taking:

- **The Librarian dashboard** (editorial cockpit): warm paper field, one ink foreground, a single rubric accent (verdigris) plus copper "hardware"; serif spine for headings/prose, mono for machine strings; 32 px table rows; 1 px hairlines instead of borders/shadows; 0 px editorial corners; one accent per view; no rounded cards, no shadows, no glass, no SaaS slate.
- **Parchment Italic Editorial**: warm parchment (never pure white), oversized display serif with italic emphasis, near-black inverted cards for emphasis, 1 px warm borders, left-aligned grid, accent scarcity, no pill CTAs, no gradients/shadows, "editorial stillness".
- **Mission-select patterns** (Standard of Iron, Fortnite, Scaleform): mission rows/cards carry name, 1–2 line brief, status (Locked / Available / Completed), difficulty, reward; a detail surface with objectives and one Start CTA; a progress + Continue control; completed missions stay replayable.
- **Guild/quest board patterns**: a request/contract board with difficulty, duration/reward preview, roster/party assignment, and completion stamps.

The common thread: **paper + ink + hairline + one accent + serif/mono typography**, and **missions presented as documents**, not SaaS cards.

## 2. Identity

**The Range Guild — Guild Ledger.** A quiet guild hall for security contracts. The guild is a *visual metaphor* (contracts, seals, ledger, intel, bounty), not faux-medieval body copy. Modern product clarity first; the archival texture is in the materials, not in ornamental language.

- **Voice:** short, dry, confident. "Contracts are open." "Take a contract. Break the app. Claim the bounty." Avoid "Welcome, adventurer!".
- **Vocabulary:** Labs = **Contracts**; levels = **Tiers** (Acolyte / Templar / Divine); hints = **Intel**; submit = **Claim bounty**; leaderboard = **Guild ledger**; score = **Bounty**; solved = **Sealed**.
- **Indonesian:** Kontrak, Tier, Intel, Klaim bounty, Ledger guild, Bounty, Tersegel.

## 3. Tokens

### Light — Manuscript

| Token | Value | Use |
|---|---|---|
| `--bg` | `#f5f1e8` | page field |
| `--surface` | `#faf7f0` | paper surface / contract slip |
| `--surface-2` | `#f1ecdf` | raised / hover |
| `--surface-3` | `#e8e2d2` | selected / sunken alt |
| `--sunken` | `#ece7da` | inputs / tracks |
| `--border` | `#d8d0bd` | hairlines |
| `--border-strong` | `#bdb39b` | emphasised rule |
| `--border-input` | `#7c7462` | form controls (≥3:1) |
| `--text` | `#1a1612` | ink |
| `--text-muted` | `#5b5548` | secondary |
| `--text-faint` | `#6d6658` | mono labels |
| `--primary` | `#3f7f73` | verdigris action (darker than The Librarian for AA) |
| `--primary-hover` | `#32685e` | |
| `--on-primary` | `#fbf7ec` | |
| `--primary-text` | `#2f6a5f` | accent text |
| `--link` | `#2f6a5f` | links (same family) |
| `--focus` | `#2f6a5f` | focus ring |
| `--copper` | `#a9682f` | structural hardware / seal, never state |
| `--inverted` | `#1a1612` | near-black emphasis surface |
| `--on-inverted` | `#f5f1e8` | |

### Dark — Scriptorium

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0e242c` | deep teal-ink field |
| `--surface` | `#14313b` | raised paper-dark |
| `--surface-2` | `#193a45` | hover |
| `--surface-3` | `#204652` | selected |
| `--sunken` | `#0a1d24` | inputs |
| `--border` | `#2a4d57` | hairlines |
| `--border-strong` | `#3d6873` | |
| `--border-input` | `#7f9aa0` | |
| `--text` | `#e8d9b8` | parchment ink |
| `--text-muted` | `#b9ae94` | |
| `--text-faint` | `#9a917b` | |
| `--primary` | `#7dd3c0` | cyan-verdigris |
| `--primary-hover` | `#9be3d3` | |
| `--on-primary` | `#0b1e24` | |
| `--primary-text` | `#8ddcc9` | |
| `--link` | `#8ddcc9` | |
| `--focus` | `#8ddcc9` | |
| `--copper` | `#d49872` | |
| `--inverted` | `#e8d9b8` | rare inverted slip |
| `--on-inverted` | `#0e242c` | |

**Levels (muted seals, not neon):** acolyte teal `#3f7f73` / dark `#7dd3c0`; templar azure `#3b6ea5` / `#8fb8e8`; inquisitor copper-amber `#a9682f` / `#e0a060`; divine violet `#6f5a9e` / `#c4b0f0`. Tints derive from the level hue at ~10% for light and ~18% for dark, or use dedicated `-bg` tokens. Colour is never the only signal: the tier name is always written.

**Status:** success = verdigris; danger = oxblood `#9e3b2f` (dark `#f08a7a`); warning = copper; info = azure. Use icon + text, never colour alone.

**Shape & elevation:** 0 px on editorial surfaces (contract slips, panels, tables); 4 px on buttons/inputs; **no pill CTAs** (small square tags are fine). **No box-shadows**; depth = 1 px neutral ink hairline + 2–6% tonal wash. One inverted near-black slip per screen at most.

**No coloured rules (hard rule):** never put a coloured line, rail, top border or left border on a card, contract slip, panel, toast, table row or form. Every surface uses one neutral ink hairline. State (current tier, solved, error, success, rank) is shown by a **seal/monogram, mono text, a small dot, or a tonal background wash** — never by a coloured edge. A single accent underline is allowed on the active masthead tab only; no other coloured rules.

## 4. Typography

System fonts only (offline):

- `--serif`: `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif` — display headings, the mission brief, pull quotes, contract titles.
- `--sans`: existing system stack — body UI, controls, forms (keeps readability).
- `--mono`: existing system mono — machine strings, IDs, counts, timers, labels, bounty figures.
- **Rule:** human prose may be serif; controls/body UI are sans; every machine string is mono.
- Display: serif 600, `clamp(2.4rem, 4.2vw, 3.8rem)`, line-height 1.05, `-0.02em`. Section titles: serif 600, 1.5–1.75rem. Eyebrow/label: mono uppercase 11px, `0.08em`, 60% ink.
- Numbers: tabular, mono. No oversized hero metrics.

## 5. Shell

- **Masthead, not a dashboard bar:** 64 px, hairline bottom, sparse. Left: small custom guild crest (inline SVG, 28 px) + `HVWA` wordmark + tiny mono `RANGE GUILD` tag. Center/left: `Contracts` / `Ledger` text tabs, active = 2 px verdigris underline. Right: mono `EN / ID` text swap (no boxed segmented control), one theme icon, **Active contract** tag (small square, state dot + app + time), account initials square + caret menu. No empty boxes, no oversized buttons.
- Safety banner: a thin paper strip with a copper left rule, not a red alarm bar; keep the portal-mode text.
- Footer: hairline top, mono small, left-aligned.

## 6. Guild Hall (home / catalog)

1. **Hero poster:** left-aligned. Eyebrow mono `THE RANGE GUILD · CONTRACTS OPEN`. Headline serif, two lines, e.g. "Take a contract. / Break the app." Lead in sans or serif. Right side: a custom crest/seal illustration (inline SVG) and a **ledger strip** (Bounty / Contracts sealed / Rank) separated by hairlines — not stat cards.
2. **Continue strip:** if there is an active/recent contract, an inverted near-black slip with a single neutral ink hairline (no copper/coloured rule): app name, last state, "Resume contract →". One per screen.
3. **Mission board:** section header `MISSION BOARD` with a hairline and a mono count (`4 contracts`). The four labs are **contract slips** in a 2-column board (single column < 900 px):
   - Paper slip, 1 px hairline, 0 radius, subtle torn bottom edge via `clip-path` (optional, must not hurt text).
   - Top row: category tab (small square, mono), rank seal (monochrome outlined circle with the difficulty letter/numeral — no colour fill or coloured ring), and a pin dot.
   - Contract title: app name in serif ~1.5rem; subtitle (lab title) sans muted.
   - Objective: scenario, 2–3 lines.
   - **Tier rows:** three rows Acolyte / Templar / Divine, each with a small monochrome seal/state mark and points; solved = "SEALED" stamp (rotated 6°, ink/copper text, outlined, low-opacity) or a clear check. No coloured rail on the active/solved row — use the seal or a tonal wash.
   - Footer: bounty total in mono, arrow. Hover: background steps one tone, border darkens; no lift/shadow.
   - Locked/availability isn't a POC concept (all contracts open); show "Open contract" affordance via the arrow and accessible label.
4. **Filters:** a single inline toolbar under the board header: Search / Category / Difficulty / Show / Sort, small labels above flat 1 px controls; the primary filter action is a quiet outlined button. No card wrapper.

## 7. Contract Dossier (lab page)

- Breadcrumb `Contracts / <App>`.
- Hero: eyebrow category + rank seal; serif title; scenario; sealed stamp if solved.
- Two columns: main (max ~68ch) and a 20rem right rail.
- **Mission brief** as a serif lead paragraph with no coloured rule (optionally one neutral ink hairline on the left); not a card.
- **Tiers:** three large rows, each a selectable document line: tier name serif, meaning sans muted, points mono, state. Current tier = 5% tonal wash + a small filled ink dot or seal (no coloured rail); solved = seal. Keep the existing level links/testids.
- **Intel (hints):** a clean accordion; locked rows show cost in mono; unlocked rows show the text; keep the cost-once behaviour.
- **Claim bounty:** the submit form as a distinct fieldset with a mono label and one primary button; result inline (toast enhances).
- **Right rail:** sticky. Active contract panel as an inverted or paper slip with state dot, time bar, one primary action (Launch/Open), quiet Reset/Stop. Then a compact "How it works" with mono numerals 01/02/03.
- Keep the full-range message, failed/expired/idle/replaced reasons, and all data-testids.

## 8. Guild Ledger (leaderboard)

- Serif page title; mono total players.
- Top three as large ledger rows: big mono `01/02/03`, name serif, bounty mono, sealed count; #1 gets a copper/verdigris seal, not a gradient medal.
- Remaining rows in a flat table: mono rank, name, bounty, sealed; hairline rows, no zebra, no outer card.
- Viewer row pinned with a 5% tonal wash and a bold ink name (no coloured rail). Empty state: a short line + "Browse contracts".
- Responsive: on < 640 px, each row becomes a compact two-line ledger entry.

## 9. Login / Register

- Split surface: left ~45% an **inverted** near-black panel with the crest, a serif statement ("Enter the guild."), and three short mono facts (isolated instances · real containers · your own flags); right a paper form slip.
- Form: 1 px controls, visible labels, one primary action, secondary link underneath. No decorative avatar/arch. Stack under 800 px.
- Keep error/CSRF/banner behaviour and testids.

## 10. Toasts (stamped slips)

- Paper slip, 1 px neutral hairline (no coloured top/left rule), a small monochrome/copper seal glyph, mono eyebrow (`BOUNTY CLAIMED`), serif message, close. Success/error/info is carried by the seal glyph and text, not by a coloured edge.
- Bottom-right desktop / bottom-center mobile; stack max 3; auto-dismiss ~5 s; `role=status`/`aria-live=polite`; never steal focus; paused on hover/focus; reduced-motion off.
- Data-driven from action swaps only (`data-focus-after-swap`), never from polls.

## 11. Do / Don't

**Do:** warm paper, hairlines, serif spine, mono machines, one accent per view, sharp editorial corners, left-aligned type, generous whitespace, custom crest/seal and contract slips, stamped completion states, still motion.

**Don't:** coloured rails/borders on cards, slips, toasts, panels or rows; pure white or slate dark; navy+gold; rounded card grids; drop shadows; glass/gradients; pill CTAs; icon-heavy nav; emoji; stock SaaS stat cards; centered marketing stacks; animated bounce; more than one accent hue; faux-medieval body text.

## 12. Hard constraints

- Offline, system fonts only, inline SVG sprite only; no external assets.
- No inline style/script/handlers; tokens only, no raw colours outside token blocks.
- Contrast ≥4.5 text / ≥3 UI in both themes; 375 px no horizontal scroll; 44 px targets; visible focus; `aria-current` semantics.
- Keep every form field name, action, htmx attribute, message class and `data-testid`; presentation only.
- Keep `prefers-reduced-motion` support.
