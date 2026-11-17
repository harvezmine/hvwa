# HVWA UI style guide ("Sanctum")

How HVWA looks and how to keep it that way. Everything here is enforced in code or tests where it can be:
`src/public/app.css` (all styles), `src/public/icons.svg` (icons), `src/public/ui.js` (optional enhancements),
`src/core/views/layout.ejs` (the shell), `tests/ui-contrast.spec.ts` (colour pairs) and `tests/ui-shell.spec.ts`
(theme, language, district page, no inline script / handler / style, icon coverage).

**Identity.** A professional security-training platform with a quiet citadel theme: ink-navy surfaces, one sacred-gold
accent, pointed-arch shapes (the brand mark, district icons, the hero) and small diamond markers. Readable first; the
theme never gets in the way of a lab.

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

| Token | Use | Dark | Light |
|---|---|---|---|
| `--bg` | page | `#0b0f19` | `#f5f3ee` |
| `--surface` / `--surface-2` / `--surface-3` | card, raised panel, hover/selected | `#111827` / `#172034` / `#1f2a42` | `#ffffff` / `#fbfaf7` / `#efece4` |
| `--sunken` | inputs, segmented-control track | `#080b13` | `#f1efe8` |
| `--border` / `--border-strong` / `--border-input` | dividers / emphasised / form controls (3:1) | `#253149` / `#3a4865` / `#66789c` | `#ddd8cc` / `#c5bfb0` / `#868173` |
| `--text` / `--text-muted` / `--text-faint` | body / secondary / line numbers | `#e8ecf4` / `#a3aec2` / `#7d89a1` | `#151a26` / `#4a5365` / `#5f6678` |
| `--primary` + `--on-primary` | brand gold, primary buttons | `#e5b94e` + `#1a1406` | same |
| `--primary-text` | gold used as text (ids, eyebrows) | `#e9c264` | `#835c00` |
| `--link` / `--focus` | azure links / focus ring | `#6aa6ff` / `#7fb2ff` | `#1a5bd6` / `#1a5bd6` |
| `--success`, `--danger`, `--warning`, `--info` (+ `-bg`, `-border`) | status | emerald, crimson, amber, sky | darker tones |
| `--lv-acolyte` / `--lv-templar` / `--lv-inquisitor` / `--lv-divine` (+ `-bg`) | the four levels, everywhere | teal / azure / amber / violet | darker tones |
| `--on-level` | text on a solid level fill | `#0b0f19` | `#ffffff` |
| `--code-bg`, `--code-text`, `--diff-del-bg`, `--diff-add-bg` | code and diff | | |

**Contrast.** Every text pair is at least 4.5:1 and every UI boundary (input border, focus ring) at least 3:1 in both
themes; the lowest text pairs are 5.48:1 (dark) and 4.80:1 (light). The full list of pairs lives in
`tests/support/contrast.ts`; add a pair there when a component puts a token on a new background.

**Levels.** One colour per level, used for badges (`.level-badge[data-level]`), chips (`.level-chip.level-<l>`), the
lab bar's segmented control and the challenge page's level picker. Divine adds a gold edge. Any element with
`data-level="<level>"` (or class `level-<level>`) gets `--lv` and `--lv-bg`. Colour is never the only signal: the
level's name is always written.

**Type.** `--sans`: `ui-sans-serif, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
`--mono`: `ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace`. Scale `--fs-xs` 12, `--fs-sm` 14,
`--fs-md` 16 (body), `--fs-lg` 18, `--fs-xl` 24, `--fs-2xl` 32 px; line height 1.55.

**Space, shape, motion.** `--sp-1`..`--sp-7` = 4, 8, 12, 16, 24, 32, 48 px. Radii `--radius-sm` 6, `--radius` 10,
`--radius-lg` 14. Touch targets `--tap` 44 px. Transitions 180 ms (`--dur`, `--ease`) on `transform` and `opacity`
only; `prefers-reduced-motion: reduce` turns them off. Z-index: `--z-header` 20, `--z-menu` 30, `--z-skip` 100.

**Breakpoints.** Mobile first; 480, 640, 768, 1024, 1440 px. No page scrolls horizontally at 375 px; tables, `pre`
and the diff scroll inside their own box.

## 2. Theme and language

- **Language:** English by default. `?lang=id|en` sets the `hvwa_lang` cookie (`core/i18n.ts`); the EN/ID switch in
  the top bar is two links. Platform strings live in `core/i18n.ts` (both languages); lab-internal text is English.
- **Theme:** `?theme=dark|light|system` sets `hvwa_theme` (`core/theme.ts`, same cookie policy as the others). The
  server renders `data-theme` on `<html>` for an explicit choice; with none, CSS follows `prefers-color-scheme`. The
  toggle is a link to the theme you are not on (CSS hides the other one), so it works without JavaScript and never
  flashes the wrong theme.

## 3. The shell (`core/views/layout.ejs`)

Skip link, the slim safety line, the default-password row (login on, default password in use), the sticky top bar
(brand, Districts, Scoreboard, EN/ID, theme, account menu), breadcrumbs (`crumbs` data on portal pages), the lab bar
on lab pages, the view, the victim panel, the footer. Portal pages pass `pageTitle` and `crumbs`
(`[{ label, href? }]`); a lab view passes neither (the lab bar owns both).

**Lab bar** (every `/d/<district>/<slug>` page, automatic): breadcrumb Home › District › ID › Lab, Restart lab (when
the challenge has a reset hook) and Back to challenge, the id/title/level badge, the summary, the level switcher as a
segmented control in level colours, and "You are on <level>: <meaning>". Lab pages use one centred column
(`.content-lab`, 60 rem).

## 4. Components

| Component | Markup | Notes |
|---|---|---|
| Button | `<button class="btn btn-primary">` / `btn-secondary` / `btn-ghost` / `btn-danger`; sizes `btn-sm`, `btn-xs`, `btn-lg`, `btn-block` | One primary per screen. `btn-xs` keeps a 44 px hit area. |
| Icon button | `<a class="icon-btn" aria-label="…">` + icon | Always an `aria-label`. |
| Icon | `<svg class="icon" aria-hidden="true" focusable="false"><use href="/static/icons.svg#i-map"></use></svg>` | Lucide style, 24 px grid, stroke 2; `icon-sm`, `icon-lg`. Add symbols to `icons.svg`; `ui-shell.spec.ts` checks every used id exists. Never emoji. |
| Card / panel | `<section class="card panel">` + `<h2>` (icon optional) + `.panel-lead` | |
| Badge, tag | `.badge`, `.badge-ok`, `.badge-solved`, `.level-badge[data-level]`, `.tag` (mono: OWASP / CWE ids) | |
| Alert | `<div class="alert alert-success|error|warning|info">` + icon + `<p>` | Icon and text, never colour alone. Text-only hooks (`.result`, `.lab-message`) get a CSS glyph instead. |
| Field | `<div class="field"><label for="x">…</label><input id="x"><p class="help">…</p><p class="field-error result result-bad" role="alert">…</p></div>` | Labels always visible; errors under their field; `aria-invalid` + `aria-describedby`. |
| Table | `<div class="table-wrap"><table class="table">` | `.num` right-aligns figures. |
| Tabs / filters | `<nav class="seg">` of `<a class="seg-item" aria-current="page">` | Links, no JS. |
| Accordion | `<details class="accordion"><summary>…</summary><div class="accordion-body">…</div></details>` | Hints use it (progressive). |
| Menu | `<details class="menu">` + `.menu-panel` + `.menu-item` | `ui.js` closes it on Escape / outside click. |
| Progress | `<progress class="progress" max value>` | No inline width needed. |
| Empty state | `<div class="empty">` icon + text + action | |
| Loading | `.skeleton`; htmx forms get a spinner on the submit button while `.htmx-request` | |
| Code | `<pre>`, `.source-view`, `.diff-wrap > .diff-view` | Scroll inside the block. |

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
- Do write the meaning in text next to every colour (levels, statuses).
- Do keep focus visible (the global `:focus-visible` ring); never remove an outline.
- Don't animate layout properties; don't add hover-only affordances; don't use emoji as icons.
- Don't rely on JavaScript: `ui.js` may enhance, never enable.
- Check a change in both themes at 390 and 1440 px (headless Chrome screenshots), and run `npm test`.
