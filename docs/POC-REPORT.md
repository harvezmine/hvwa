# HVWA Range POC — Laporan Penyelesaian

> Status: **kode POC selesai dan terverifikasi lokal**; deploy publik menunggu langkah owner (push image, host harvez, gVisor, tunnel).
> Tanggal: 22 November 2026. Branch: `master`.
> Dokumen ini merangkum apa yang dibangun, hasil audit, pengujian, enhancement per challenge, jaminan keamanan flag, dan sisa pekerjaan deploy.

---

## 1. Ringkasan eksekutif

POC HVWA Range adalah platform latihan keamanan web di mana **setiap user mendapat container lab sendiri** untuk setiap (challenge, level). POC terdiri dari:

- **4 showcase lab + 1 lab hard-only**, masing-masing showcase lab punya **4 level**: Acolyte / Templar / **Inquisitor** (dieksploitasi dan dinilai) + Divine (referensi aman, tanpa flag):
  - **r01 Mercy Clinic** — *The Quiet Ward* — SQL injection (Easy)
  - **r02 Courier** — *Return to Nowhere* — Broken access control (Easy)
  - **r03 Beacon** — *Static Bloom* — OS command injection (Medium)
  - **r04 Postcard** — *The Paper Cut* — Server-side template injection (Hard)
  - **r05 Binanse** — *The Cold Ledger* — Stored XSS (Hard, **Inquisitor-only**: tanpa pilihan difficulty dan tanpa Divine)
- **Nama challenge bergaya riddle** menjadi judul utama yang dilihat pemain; nama produk in-world (Mercy Clinic, Courier, Beacon, Postcard, Binanse) tetap sebagai konteks sekunder. Setiap lab punya 3 hint riddle bilingual.
- **Portal** dengan registrasi terbuka, login, katalog, hint berbayar, leaderboard, panel Lab, submit flag, serta satu instance aktif per user.
- **Warden** sebagai satu-satunya komponen yang boleh membuat/menghapus container lab, melalui Docker socket proxy yang dibatasi.
- **Traefik v3 + forward-auth** di belakang Cloudflare Tunnel; setiap instance hanya punya satu container di jaringan internalnya sendiri.
- **Flag per instance** (HMAC), disimpan di DB hanya sebagai hash, dan **tidak pernah ada di environment container, image, config, `docker inspect`, atau log**.

Hasil verifikasi lokal terakhir:

| Gate | Hasil |
|---|---|
| `npx vitest run` | **4557 test lulus** (152 file) |
| `npm run typecheck` | exit 0 |
| `npm run labs:test` | **112 PASS** — 4 lab × 4 level, termasuk check no-leak |
| `npm run range:verify` | **16/16 PASS**, launch-to-ready 1.0–1.5 s |
| `npm run verify:dist` (full + lite) | OK |
| `npm run range:build` | image portal & warden dibuat |
| `npm run poc:e2e` | **PASS 4 lab × 4 level, 160 check** |
| UI | **Guild Ledger** light/dark, rank E–S, 8 ilustrasi custom, toast |
| Commit attribution | **0** (`Co-Authored-By`/Claude/chatbot tidak dipakai) |

---

## 2. Cakupan POC (compact amendment)

Keputusan owner 2026-11-21/22 yang menjadi batas POC:

- **4 lab × 4 level**, ditambah **r05 Binanse** hard-only dengan satu level Inquisitor; Inquisitor adalah level **chain** (dieksploitasi & dinilai), Divine tetap referensi aman.
- **Tanpa** victim bot, FIFO queue, Extend, ceiling, event code, admin pages.
- **Satu container per (user, challenge, level)**; **satu instance aktif per user** (launch lain menghentikan instance sebelumnya).
- Capacity penuh → launch ditolak `full`; idle 20 menit, lifetime maksimum 60 menit; Reset dan Stop tetap ada.
- Flag hanya keluar lewat celah yang memang dirancang; Divine tidak pernah menghasilkan flag.

---

## 3. Arsitektur singkat

```
Browser → Cloudflare Tunnel → Traefik (:80, hanya di hvwa-edge)
  ├── hvwa.my.id          → portal (login, katalog, panel, submit, leaderboard)
  └── i-<instance>.hvwa.my.id → forward-auth portal → container lab
                                  (jaringan internal per instance, tanpa egress)

portal ──HTTP──► warden ──► docker-socket-proxy (tulis, khusus warden)
                    └──────► Docker Engine: container + network lab
Traefik ──► docker-socket-proxy (read-only, hanya baca)
```

Prinsip keamanan kunci:

- Portal **tidak** bisa menjangkau socket proxy tulis (jaringan `docker` hanya warden).
- Warden hanya menerima body launch yang ketat (`.strict()`), tanpa image/mount/port/HostConfig dari pemanggil; image dipilih dari registry yang di-pin.
- Tidak ada port container yang dipublikasikan; satu-satunya jalur masuk adalah Traefik.
- Instance hanya bisa dijangkau lewat gate ticket sekali pakai + cookie `hvwa_gate` milik user/instance tersebut.

---

## 4. Enhancement per challenge

Sebelum enhancement, keempat lab hanya punya 2–3 halaman dan CSS minimal. Audit menilai challenge terasa generik. Setelah enhancement:

### r01 — Mercy Clinic (SQL injection, Easy)

- Home klinik nyata: hero, status buka/tutup, flu clinic berikutnya, pencarian, pengumuman terbaru, preview tim.
- **15 notice** ber-tanggal, berpenulis, berkategori; setiap kartu menuju `/notices/:id` dengan related notices.
- Pencarian tanpa syarat di hero dan `/search`: jumlah hasil, highlight aman (escaped), saran saat kosong, filter kategori.
- Direktori **10 staf** dengan departemen, ruang, ekstensi, bio; halaman departemen.
- Halaman `/departments`, `/appointments` (form booking simulasi), `/about`, `/contact`, `/opening-hours`.
- Notice staf kedua yang wajar (rota) menjadi "noise" di samping notice flag saat UNION.
- **Inquisitor (chain):** pencarian memakai DB publik terpisah (`public.db`) yang hanya berisi notices publik + `staff_tokens`; flag/staff notice tetap di DB utama. SQLi 4 kolom membocorkan **service token** 32-hex, lalu `/staff/notices?token=` membaca staff notices dari DB utama. UNION langsung ke staff notice tidak bisa karena flag tidak ada di DB pencarian; `ATTACH` tidak bisa menjembatani dua DB lewat satu statement.
- Identitas visual teal/cream, mark/favicon SVG, 404/500 bergaya, responsive 375 px.

### r02 — Courier (Broken access control, Easy)

- Dashboard pelacakan nyata: 7 paket demo, status chip, ETA, timeline depot → transit → out for delivery → delivered.
- **Printable label**: `GET /api/parcels/:id/label` dengan `Accept: text/html` mengembalikan label cetak (alamat, note, barcode CSS); `Accept` lain tetap JSON (solve tetap jalan).
- **6 paket vault** (1001–1006); 1001 pembawa flag, sisanya note decoy yang wajar.
- Halaman `/account`, `/support`, `/pricing`, `/faq`, `/signin`; landing menjelaskan demo mode.
- Dashboard melakukan refresh API nyata (`POST /api/session` → `GET /api/parcels`) sehingga endpoint terlihat natural di DevTools.
- **Inquisitor (chain):** semua rute parcel mewajibkan `X-Api-Key` milik pemilik parcel; endpoint support IDOR membocorkan API key customer `vault`; key itu dipakai bersama sesi demo untuk membaca parcel 1001. Key kosong/salah 403; Divine menolak kombinasi sesi demo + key vault.
- Identitas orange/navy, mark/favicon, status chip, print CSS, styled 404/500, responsive.

### r03 — Beacon (Command injection, Medium)

- UI appliance admin gelap: model/serial/firmware, uptime, LED WAN/LAN, jumlah client, gauge CPU/RAM/temperature, sparkline SVG.
- Halaman `/network` (uplink, DHCP lease, interface, firewall, client), `/wifi` (SSID/WPA3, channel, client + signal bar), `/logs` (syslog + recent probes), `/firmware`, `/system`.
- `/status` kini human-readable, bukan dump JSON.
- `/diagnostics`: preset target, output terminal dengan timestamp/exit code, spinner CSS, daftar recent probes (escaped, in-memory).
- Reboot simulasi murni CSS.
- **Inquisitor (chain):** host divalidasi ketat dan dijalankan via `execFile` (tanpa shell), tetapi `label` disimpan; `/diagnostics/report` menjalankan shell dengan label tersimpan (second-order command injection) dan menampilkan report. Dua sink shell total: `diag.mjs` dan `report.mjs`.
- Identitas dark/lime, LED, ilustrasi SVG, favicon, responsive.

### r04 — Postcard (SSTI, Hard)

- **10 gaya kartu** dengan palet, font, border, ornamen yang benar-benar berbeda (ulang tahun, terima kasih, selamat, pernikahan, bayi baru, anniversary, get well, sympathy, just because, seasonal).
- Home studio: hero, style swatch visual, recent cards, promise panel; gallery dengan filter occasion.
- `/preview`: kartu dengan print CSS, flip front/back statis (CSS 3D), metadata gaya, "Send" simulasi, "Edit".
- Halaman `/orders`, `/about`, `/pricing`, `/faq`, `/shipping`, `/contact`.
- Status studio statis ("press queue: 3 cards ahead", same-day cutoff).
- **Inquisitor (chain):** `/preview` tidak merender pesan; menyimpan draft (≤32, id acak) dan mengembalikan `data-draft`; `/orders/<id>/print` merender draft sebagai template (second-order SSTI). Divine merender draft sebagai data (escaped), jadi payload tidak dieksekusi.
- Identitas rose/plum, tekstur card stock, SVG mark/favicon, styled rejection card, 404/500, 375 px.

### Flow portal

- **Race capacity diperbaiki**: relaunch tidak lagi menghentikan lab lama lalu menolak start; keputusan capacity + reservasi slot atomik. Uji menutup skenario slot direbut user lain.
- **Copy portal** tidak lagi menampilkan "runs fully offline / never expose it to an untrusted network" pada halaman publik; copy standalone tetap.
- **CSRF htmx**: 403 pada request htmx memicu `HX-Refresh` (fragment kecil), bukan menukar seluruh halaman ke dalam panel.
- **State lab terlihat**: `failed`, `expired`, `idle`, `replaced` ditampilkan dengan alasan dan tombol relaunch; aturan idle 20 menit disurfacekan; chip My Lab disembunyikan saat tidak ada instance.
- **i18n**: `range.full` dan `range.submit_help` kini benar-benar Indonesia; test memastikan semua key `range.*` berbeda EN/ID.
- **Hardening**: `Cache-Control: private, no-store` + `Vary: Cookie` pada halaman per-user; `Secure` pada `hvwa_sid` dan cookie preferensi saat https; `nosniff` + CSP scoped pada halaman portal; halaman 401 instance bilingual dan bertema.
- **Wow**: aksen/ikon per `themeId`, kartu "Continue your lab", progress solved, pencarian/sort katalog, empty-state dengan aksi, leaderboard top-3 + baris viewer dipin.
- Aksesibilitas: `aria-current="page"`, live region countdown, fokus setelah swap htmx (polling tidak merebut fokus), konfirmasi Stop.

### UI/UX — “The Range Guild — Guild Ledger”

Redesain penuh dari tema navy+gold yang terasa generik menjadi sistem editorial paper-and-ink yang custom:

- **Identitas:** kertas hangat + tinta (light) dan teal-ink + parchment (dark); serif untuk judul/prosa, sans untuk kontrol, mono untuk semua angka/mesin; satu aksen verdigris + copper hanya untuk seal/hardware; sudut tajam, hairline, tanpa shadow/gradient/glass.
- **Aturan keras “no coloured rules”:** tidak ada garis warna di tepi kartu/slip/panel/row/toast. Status, rank, dan seleksi ditunjukkan oleh **seal, teks mono, dot kecil, atau wash tonal**; satu-satunya underline aksen adalah tab aktif di masthead.
- **Guild Hall:** hero poster ( “Take a contract. Break the app.”), ilustrasi guild hall custom, ledger strip (Bounty / Contracts sealed / Adventurer rank), progress campaign, continue slip, dan **mission board** berisi 4 contract slip kertas dengan tab kategori, seal difficulty Romawi, objective, tiga tier, dan bounty.
- **Contract dossier:** judul app serif + subtitle mono, mission brief, tier rows, intel accordion, claim bounty, rail active contract sticky (state, time bar, Open/Reset/Stop).
- **Guild ledger:** posisi `#N` mono, seal rank E–S, baris viewer dipin, empty state berilustrasi.
- **Login/register:** panel inverted dengan crest + ilustrasi gate/key + tiga fakta, form di kertas.
- **Ilustrasi:** 8 simbol SVG custom (guild hall, clinic, courier, beacon, postcard, gate, key/seal, laurel, empty scroll), line-art, per-lab watermark; tanpa asset eksternal/emoji.
- **Adventurer rank E–S:** semua mulai **E (Initiate / Pemula)**; bounty dikonversi otomatis ke rank dengan threshold **E 0 · D 300 · C 1000 · B 2000 · A 3000 · S 3750**, lengkap dengan progress “100 / 300 to D”. Tampil di ledger, account menu, dan leaderboard; posisi leaderboard tetap terpisah. Bounty maksimum **3750** karena r05 Binanse menambah 600 poin (Hard 300 × Inquisitor 2).
- **Toast:** slip cap untuk aksi sukses/gagal (flag accepted/rejected, intel unlocked, contract started/stopped), seal glyph, auto-dismiss, tidak merebut fokus; inline result tetap ada untuk no-JS.
- **Audit visual:** light/dark, 375 px tanpa horizontal scroll, panel starting/running, toast live, dan semua halaman (login, register, Guild Hall, dossier, ledger) sudah dicek lewat Chrome headless langsung ke server.

---

## 5. Keamanan flag (tidak bisa diambil dari env/inspect/log)

Perubahan keamanan 22 November 2026:

- Warden **tidak lagi** mengirim `HVWA_FLAG` sebagai env container.
- Container dibuat dan dijalankan, lalu warden mengirim flag lewat `docker exec` ke **file tmpfs sekali pakai** `/tmp/.hvwa-flag` (mode 0400, uid 10001).
- Lab membaca file itu saat start, **menghapusnya**, lalu menanam flag di lokasi manifest (DB/record/file). Divine tidak menunggu file dan menanam decoy.
- Flag tidak ada di: environment proses, `/proc/self/environ`, image, container config, `docker inspect`, `docker logs`, log portal/warden, HTML biasa, URL, DB (hanya SHA-256), atau tiket gate.
- Check otomatis:
  - `labs:test`: cek no-leak di setiap level (inspect + logs + image/config + file one-shot hilang), termasuk Inquisitor.
  - `range:verify`: 16 check, termasuk log portal/warden, inspect/log instance, dan file one-shot hilang.
- **Residual exposure (owner-only):** flag sesaat terlihat di exec store Docker (`GET /exec/{id}/json`), hanya bisa diakses lewat socket proxy tulis yang hanya dijangkau warden; proxy read-only tetap `EXEC=0`. Pemain tidak punya rute ke proxy tersebut. Ini didokumentasikan di spec dan plan.

---

## 6. Hasil audit dan perbaikan

Audit read-only menyimpulkan **tidak ada auth bypass, IDOR, XSS, open redirect, atau bypass gate** di portal. Temuan yang diperbaiki:

- **I4** race capacity/relaunch (hilangnya lab lama) — diperbaiki dan diuji.
- **I5** copy portal yang kontradiktif — diperbaiki.
- **M6** stale CSRF pada htmx — diperbaiki dengan `HX-Refresh`.
- **M7/M15** state failed/expired/idle tidak terlihat — diperbaiki.
- **M9** dua string ID masih Inggris — diperbaiki + test i18n.
- **M10** halaman per-user bisa di-cache — `private, no-store` + `Vary: Cookie`.
- **M13** `hvwa_sid`/preferensi tidak Secure di https — diperbaiki.
- **M16** halaman 401 instance English-only — bilingual + bertema.
- **M17–M20** defect lab (style Postcard tidak berpengaruh, notice detail tak tertaut, label JSON mentah, status Beacon dump) — diperbaiki lewat enhancement.
- **N21–N26** aksesibilitas, empty state, identitas `themeId`, header, chip My Lab, konfirmasi Stop — diperbaiki.

Review keamanan/kualitas khusus enhancement menyatakan **GO** (tidak ada XSS/sink baru, level/flag utuh). Temuan Minor/Nit-nya juga sudah diperbaiki:

- CSP scoped tidak lagi tertimpa pada respons 403/refusal dan halaman login/akun (`src/core/page-csp.ts`).
- Interpolasi `panel.replaces` memakai function replacement (aman terhadap `$&`).
- r03: skip link/`id="main"`, copy recent-probe konsisten.
- r02: dashboard memakai satu token API (tidak churn session map).
- r04: `MAX_CONTENT_LENGTH` 64 KiB + halaman 413 yang ramah.
- 401 instance: satu `<h1>`, blok Indonesia `lang="id"`; leaderboard punya caption + header scope.
- Test gap ditutup: CSP pada refusal, poll tidak merebut fokus, dan label HTML Courier (`Accept: text/html`).

Belum dikerjakan (dicatat jujur):

- `range:load` (load test p50/p95/p99, 40 user) — Plan E.
- Deployment kit (`range-setup.sh`, deployment README, `labs:push`, re-pin by repo digest) — Plan E.
- Uji `runsc`/gVisor di harvez (lokal hanya `runc`; Docker Desktop tidak punya runsc).
- Uji mobile/responsive otomatis dan aksesibilitas otomatis (axe/keyboard).
- Load/capacity sizing berdasarkan pengukuran nyata.

---

## 7. Pengujian

### 7.1 Unit/integration (`npm test`)

- **4557 test / 152 file lulus**, termasuk portal mode, auth/register/login, CSRF/Origin, katalog/filter, hint, submit, leaderboard, lifecycle, reaper, gate, forward-auth, warden, compose, images, fixture, rank E–S (threshold 3750), level Inquisitor/four-level manifest plus r05 Inquisitor-only, dan UI token/contrast.
- `npm run typecheck` exit 0.
- Catatan kejujuran: di mesin ini paralelisme fork default sempat OOM; run final memakai `--poolOptions.forks.maxForks=4 --poolOptions.forks.minForks=1` dan lulus **4557/4557**. Sebelumnya satu run juga sempat timeout pada satu test (flake timing suite lama), lalu dua rerun penuh lulus.

### 7.2 Black-box lab (`npm run labs:test`)

- **112 PASS**: 4 lab × 4 level — health, solve referensi mendapat flag level itu (termasuk Inquisitor chain), solve level bawah gagal di level atas, Divine menolak semua solve, browse tidak membocorkan flag, tidak ada egress, **inspect/log/image/config tidak mengandung `HVWA{`**, file one-shot hilang. r05 Binanse menyusul satu level Inquisitor; angka final diisi ulang oleh controller setelah lab mendarat.

### 7.3 Platform E2E (`npm run range:verify`)

- **16/16 PASS**: portal via tunnel stand-in, tidak ada port publik, cookie host-only, limit registrasi per IP, launch-to-ready, hardening container, gate ticket/cookie/replay, tidak ada cookie portal/secret ke lab, cross-user 401, egress/DNS/portal/warden/socket/instance lain/Traefik diblokir, flag file/env/uid dan penolakan flag milik user lain, socket-proxy allowlist, capacity penuh, reaper, reconcile, stop cleanup.
- Launch-to-ready pada run final: **1508 ms, 1617 ms, 1508 ms** (run sebelumnya 1031–1639 ms; satu run sempat flake di probe isolasi dan lolos bersih saat diulang).

### 7.4 E2E lab nyata lewat portal (`npm run poc:e2e`)

**160 check PASS.** Setiap lab dijalankan melalui portal: register/login (CSRF + Origin/Sec-Fetch-Site), katalog, launch, panel sampai `running`, open via gate ticket sekali pakai → cookie `hvwa_gate`, landing page lab, penolakan tanpa cookie, solve referensi di runner container pada jaringan instance, submit flag, cek no-leak di `docker inspect`/`docker logs`, lalu Stop dan cleanup. Divine menjalankan **acolyte, templar, dan inquisitor** dan tidak menghasilkan flag.

| Lab | Acolyte | Templar | Inquisitor | Divine |
|---|---|---|---|---|
| r01 Mercy Clinic | PASS (1573 ms) | PASS (1597 ms) | PASS (1552 ms) | PASS — resists (1387 ms) |
| r02 Courier | PASS (1501 ms) | PASS (1581 ms) | PASS (1558 ms) | PASS — resists (1439 ms) |
| r03 Beacon | PASS (1508 ms) | PASS (1852 ms) | PASS (1513 ms) | PASS — resists (1389 ms) |
| r04 Postcard | PASS (3639 ms) | PASS (3569 ms) | PASS (3795 ms) | PASS — resists (3457 ms) |

Detail lengkap ada di [`docs/poc-e2e-results.md`](poc-e2e-results.md) dan [`docs/poc-e2e-results.json`](poc-e2e-results.json). Cleanup terverifikasi: tidak ada container `hvwa.range=1`, network `hvwa-i-*`, maupun sisa project E2E.

### 7.5 Build

- `npm run verify:dist` full: OK.
- `npm run verify:dist` dengan `HVWA_EDITION=lite`: OK.
- `npm run range:build`: `sigmajo/hvwa:range-portal-0.1.0`, `sigmajo/hvwa:range-warden-0.1.0`.
- `npm run labs:build`: 4 image lab di-pin ulang di `labs/registry.json`.

### 7.6 Ukuran dan memori

| Lab | Image | Idle memory (runc, level Divine) |
|---|---|---|
| Mercy Clinic | 239 MB | 15.05 MiB |
| Courier | 239 MB | 15.45 MiB |
| Beacon | 239 MB | 16.14 MiB |
| Postcard | 77.3 MB | 24.83 MiB |

_(Diukur ulang 22 Nov 2026 setelah enhancement, `HVWA_LEVEL=divine`, limit 256 MiB.)_

---

## 8. Menjalankan lokal

```bash
# dari C:\Users\Sahuagin\Documents\hvwa (huruf C kapital)
npm ci
npm test
npm run typecheck

# lab black-box (butuh Docker)
npm run labs:test

# platform E2E di belakang tunnel stand-in (butuh Docker)
npm run range:verify

# E2E semua lab lewat portal
npm run poc:e2e
```

Portal mode lokal (contoh):

```bash
HVWA_MODE=portal \
HVWA_RANGE_DOMAIN=localhost \
HVWA_PORTAL_HOST=hvwa.localhost \
HVWA_RANGE_PUBLIC_SCHEME=http \
HVWA_ADMIN_PASSWORD='Admin-Pass-1234' \
HVWA_WARDEN_SECRET='<40 chars>' \
HVWA_FORWARD_AUTH_SECRET='<40 chars>' \
HVWA_LAB_REGISTRY="$PWD/labs/registry.json" \
npm run dev
```

Docker Compose range (lokal, `runc`):

```bash
HVWA_RANGE_RUNTIME=runc docker compose -f docker-compose.range.yml -p hvwa up -d
```

Di host POC (harvez) default compose adalah `runsc`; jangan override ke `runc` di sana.

---

## 9. Sisa pekerjaan deploy (owner)

1. `docker login` sebagai `sigmajo`, lalu `npm run range:push` (portal + warden).
2. Push 4 image lab `sigmajo/hvwa:lab-*-1.0.0`, lalu re-pin `labs/registry.json` dengan repo digest hasil push (bukan local image id).
3. Deploy compose di **harvez** (Ubuntu 26.04, gVisor `runsc`) dengan `HVWA_RANGE_RUNTIME=runsc`; jangan menyentuh stack lain di server itu.
4. Pastikan Cloudflare Tunnel (`hvwa.my.id`, `*.hvwa.my.id` → `http://traefik:80`) aktif; rotasi token API/tunnel yang pernah ditempel di chat.
5. Jalankan `HVWA_VERIFY_RUNTIME=runsc npm run range:verify` di host POC.
6. (Plan E) Tambahkan `scripts/range-setup.sh`, load test `range:load`, dan sizing host berdasarkan p95/p99 nyata.

---

## 10. Galeri screenshot

Diambil dengan Chrome headless dari container lab yang sudah di-enhance (level Divine, tanpa flag) dan dari portal hidup. Screenshot portal menampilkan **4 tier** (Acolyte/Templar/Inquisitor + Divine) dan rank E–S. Semua gambar ada di [`docs/screenshots/`](screenshots/).

### Portal — Guild Ledger

| Guild Hall (light) | Guild Hall (dark) |
|---|---|
| ![Guild Hall light](screenshots/final-catalog-light.png) | ![Guild Hall dark](screenshots/final-catalog-dark.png) |

| Contract dossier | Guild ledger |
|---|---|
| ![Contract dossier](screenshots/final-lab-light.png) | ![Guild ledger](screenshots/final-leaderboard-light.png) |

| Login | Register |
|---|---|
| ![Login](screenshots/final-login.png) | ![Register](screenshots/final-register.png) |

| Launch (toast + starting) | Running |
|---|---|
| ![Launch toast](screenshots/final-panel-starting.png) | ![Running panel](screenshots/final-panel-running.png) |

| Mobile 375 px |
|---|
| ![Mobile Guild Hall](screenshots/final-catalog-mobile-light.png) |

### r01 — Mercy Clinic

| Home | Our team |
|---|---|
| ![Mercy Clinic home](screenshots/r01-home.png) | ![Mercy Clinic team](screenshots/r01-team.png) |

### r02 — Courier

| Home | Dashboard |
|---|---|
| ![Courier home](screenshots/r02-home.png) | ![Courier dashboard](screenshots/r02-dashboard.png) |

### r03 — Beacon

| Dashboard | Network |
|---|---|
| ![Beacon dashboard](screenshots/r03-home.png) | ![Beacon network](screenshots/r03-network.png) |

### r04 — Postcard

| Studio | Gallery |
|---|---|
| ![Postcard studio](screenshots/r04-home.png) | ![Postcard gallery](screenshots/r04-gallery.png) |

---

## 11. Bukti commit & hygiene

- `master` berisi merge Plan A (platform), Plan B (labs), `sec-flag` (keamanan flag), enhancement lab r01–r04, enhancement flow portal, redesain UI Guild Ledger (rank E–S, ilustrasi, toast), dan pengembalian **Inquisitor** sebagai level ke-4 dengan chain per lab.
- **Tidak ada** `Co-Authored-By`, Claude, atau chatbot attribution di commit mana pun sejak `d49bf8e`.
- `context.md` tetap untracked dan tidak disentuh.
