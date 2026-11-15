# HVWA — Holy Vulnerable Web App: Riset Awal

> Status: riset (belum ada keputusan desain final). Tanggal: 15 November 2026.
> Tujuan: memahami DVWA secara menyeluruh, memetakan lanskap lab sejenis, standar keamanan terbaru, lalu merumuskan apa yang membuat HVWA lebih modern dan lebih kreatif.

---

## 1. Ringkasan

- **DVWA** masih hidup (repo aktif, rilis terakhir v2.5 Januari 2025 yang menambah modul API/OpenAPI), tapi konsepnya tetap era 2008: PHP + MariaDB, halaman form terpisah per kerentanan, tanpa SPA, tanpa auth modern, tanpa skoring, tanpa AI.
- **Kekuatan DVWA yang wajib dipertahankan:** tingkat kesulitan per modul (Low → Medium → High → Impossible), tombol *View Source* untuk membandingkan kode rentan vs aman, setup ringan, fokus belajar satu konsep pada satu waktu.
- **Kekurangan terbesar:** tidak mencakup OWASP Top 10:2025 (supply chain, exceptional conditions, logging), API modern (GraphQL, WebSocket, JWT/OAuth), serangan riset terbaru (request smuggling, cache poisoning, parser differential), serta seluruh domain **AI/LLM/Agentic** yang kini punya Top 10 sendiri.
- **Celah pasar untuk HVWA:** belum ada satu lab yang menggabungkan (1) slider kesulitan ala DVWA, (2) aplikasi realistis terintegrasi ala Juice Shop, (3) modul AI/LLM/MCP/agent, (4) mode *defense* (patch kode + uji otomatis), dan (5) mode *blue team* (log dan deteksi). Masing-masing ada di proyek berbeda; belum ada yang menyatukannya.

---

## 2. DVWA secara mendalam

### 2.1 Identitas
| Aspek | Detail |
|---|---|
| Nama | Damn Vulnerable Web Application |
| Pembuat awal | Ryan Dewhurst (RandomStorm), sekitar 2008 |
| Maintainer sekarang | Robin Wood (digininja) — `github.com/digininja/DVWA` |
| Lisensi | GPL-3.0 |
| Stack | PHP (mendukung PHP 8.x) + MariaDB/MySQL, Apache; tersedia image Docker dan paket Kali Linux |
| Rilis terakhir | v2.5 (29 Jan 2025) — menambah modul API berbasis OpenAPI. Repo tetap aktif (commit hingga Okt 2026) |

### 2.2 Modul kerentanan (±18–19 modul)
1. Brute Force
2. Command Injection
3. CSRF
4. File Inclusion (LFI/RFI)
5. File Upload
6. Insecure CAPTCHA
7. SQL Injection
8. SQL Injection (Blind)
9. Weak Session IDs
10. XSS (DOM)
11. XSS (Reflected)
12. XSS (Stored)
13. CSP Bypass
14. JavaScript Attacks (manipulasi logika sisi klien)
15. Authorisation Bypass
16. Open HTTP Redirect
17. Cryptography
18. API (OpenAPI, ditambahkan v2.5)

### 2.3 Mekanik inti
- **Security level per sesi:** *Low* (tanpa proteksi), *Medium* (filter naif/blacklist), *High* (lebih sulit, sering bergaya teka-teki CTF), *Impossible* (implementasi aman sebagai referensi).
- **View Source:** pengguna bisa melihat kode PHP tiap level dan membandingkannya. Ini nilai pedagogis paling kuat DVWA.
- **View Help:** petunjuk dan tautan referensi per modul.
- **Reset DB:** satu klik mengembalikan state.
- (Sejarah) Dulu ada integrasi PHPIDS sebagai WAF; sudah dihapus di versi modern.

### 2.4 Kelebihan
- Sangat ringan dan mudah di-setup; cocok untuk kelas dan pemula.
- Satu modul = satu konsep, sehingga mudah diajarkan.
- Gradasi level memaksa pengguna memahami *mengapa* filter gagal, bukan sekadar menempel payload.

### 2.5 Kekurangan (relevan untuk HVWA)
| Area | Masalah |
|---|---|
| Arsitektur | Halaman server-rendered terpisah; tidak mencerminkan aplikasi modern (SPA + API + microservices + cloud) |
| Realisme | Tiap modul berupa form terisolasi, tanpa narasi bisnis, tanpa rantai serangan (chaining) |
| Cakupan | Tidak ada SSTI, deserialization, XXE, SSRF, prototype pollution, race condition, business logic, GraphQL, WebSocket, JWT/OAuth/SAML, request smuggling, cache poisoning, supply chain, AI/LLM |
| Gamifikasi | Tidak ada skor, flag, progres, atau mode CTF |
| Sisi defensif | Hanya "lihat kode aman"; tidak ada latihan menambal kode dan memverifikasinya |
| Blue team | Tidak ada log, alert, atau latihan deteksi |
| Level "High" | Sebagian terasa dibuat-buat (misalnya input lewat popup) alih-alih pola pertahanan dunia nyata yang keliru |

---

## 3. Lanskap lab sejenis

| Proyek | Stack / bentuk | Fokus | Fitur menonjol | Catatan untuk HVWA |
|---|---|---|---|---|
| **DVWA** | PHP/MariaDB | Web klasik | Level kesulitan, View Source | Basis konsep |
| **OWASP Juice Shop** | Node/Angular | Web modern, OWASP Top 10+ | 100+ tantangan berbintang 1–6, scoreboard, hint bertingkat, flag CTF + `juice-shop-ctf-cli` (CTFd/RootTheBox), *coding challenges* (temukan dan pilih fix), tutorial mode | Standar emas gamifikasi; tidak punya slider level per modul |
| **OWASP WebGoat** | Java/Spring | Pembelajaran berbasis pelajaran | Penjelasan teori sebelum eksploitasi | Bagus untuk alur edukasi |
| **bWAPP** | PHP | 100+ bug | Sangat luas | Sudah tua, tidak terawat |
| **OWASP Mutillidae II** | PHP | Web klasik | Banyak hint, level | Mirip DVWA |
| **NodeGoat** | Node.js | Top 10 untuk Node | Cocok untuk SAST | Sempit |
| **OWASP crAPI** | Microservices REST | API Top 10 | Skenario bengkel mobil (identitas, komunitas, toko, portal mekanik), 18+ tantangan | Contoh bagus untuk realisme microservices |
| **VAmPI / DVWS** | REST / WebSocket | API, WS | Ringan | Inspirasi modul API |
| **DVGA** | GraphQL | GraphQL | ±25 skenario (introspection, batching, DoS, injection) | Inspirasi modul GraphQL |
| **PortSwigger Web Security Academy** | Online | Riset terbaru | Lab per teknik, materi terbaik | Online-only, tidak bisa self-host |
| **Damn Vulnerable LLM Agent** (WithSecure/Reversec) | LangChain ReAct | Prompt injection pada agent | Berasal dari CTF BSides London 2023 | Inspirasi modul agent |
| **DVMCP** (harishsg993010) | MCP server | Keamanan MCP | 10 tantangan, 3 level: tool poisoning, token theft, excessive permission, RCE | Inspirasi modul MCP |
| **DVMCP** (Kyze Labs) | MCP server | Keamanan MCP | 28 tool, prompt injection langsung/tak langsung | Proyek terpisah dari yang di atas |
| **DVAA** (opena2a) | Agent | Red teaming agent | Image Docker | Inspirasi tambahan |
| **Gandalf (Lakera), Prompt Airlines (Wiz)** | Online | Prompt injection | Gamifikasi level demi level | Online-only |

**Kesimpulan lanskap:** domain web klasik sudah jenuh. Nilai baru HVWA ada pada **penggabungan** (level ala DVWA + realisme ala Juice Shop/crAPI + AI/agent + defense + blue team) serta **lokalisasi** (bilingual Indonesia/Inggris, belum ada yang serius menggarapnya).

---

## 4. Standar dan taksonomi terbaru (acuan pemetaan modul)

### 4.1 OWASP Top 10:2025 (final Januari 2026)
| ID | Kategori | Catatan |
|---|---|---|
| A01 | Broken Access Control | SSRF kini digabung ke sini |
| A02 | Security Misconfiguration | Naik dari #5 |
| A03 | Software Supply Chain Failures | **Baru** |
| A04 | Cryptographic Failures | |
| A05 | Injection | |
| A06 | Insecure Design | |
| A07 | Authentication Failures | |
| A08 | Software or Data Integrity Failures | |
| A09 | Security Logging & Alerting Failures | Diganti nama/diperluas |
| A10 | Mishandling of Exceptional Conditions | **Baru** |

> Urutan lengkap perlu dicek ulang langsung di owasp.org/Top10/2025 sebelum dipakai di UI.

### 4.2 OWASP API Security Top 10:2023
API1 BOLA · API2 Broken Authentication · API3 Broken Object Property Level Authorization (mass assignment + excessive data exposure) · API4 Unrestricted Resource Consumption · API5 BFLA · API6 Unrestricted Access to Sensitive Business Flows · API7 SSRF · API8 Security Misconfiguration · API9 Improper Inventory Management · API10 Unsafe Consumption of APIs.

### 4.3 OWASP Top 10 for LLM Applications 2026 (rilis Agustus 2026)
Menurut sumber sekunder (perlu verifikasi di situs OWASP GenAI):
LLM01 Prompt Injection (kini termasuk cross-modal) · LLM02 Sensitive Information Disclosure · LLM03 Excessive Agency (naik dari #6) · LLM04 Supply Chain · LLM05 Data & Model Poisoning · LLM06 Unbounded Consumption · LLM07 Misinformation · LLM08 Hidden Context Exposure (dulu System Prompt Leakage) · LLM09 Vector & Embedding Weaknesses · LLM10 Improper Output Handling.

### 4.4 OWASP Top 10 for Agentic Applications 2026 (rilis 9 Des 2025)
ASI01 Agent Goal Hijack · ASI02 Tool Misuse & Exploitation · ASI03 Identity & Privilege Abuse · ASI04 Agentic Supply Chain Vulnerabilities · ASI05 Unexpected Code Execution · ASI06 Memory & Context Poisoning · ASI07 Insecure Inter-Agent Communication · ASI08 Cascading Failures · ASI09 Human-Agent Trust Exploitation · ASI10 Rogue Agents.
(Judul dikonfirmasi oleh beberapa sumber sekunder: Speakeasy, Teleport, HUMAN Security. Halaman resmi genai.owasp.org belum dibuka langsung.)

### 4.5 Acuan lain
- **OWASP ASVS 5.0** (2025): checklist verifikasi, cocok sebagai acuan level "Divine" (aman).
- **CWE Top 25**: pemetaan teknis per modul.
- **MITRE ATT&CK / ATLAS**: pemetaan teknik untuk mode blue team dan modul AI.
- **PortSwigger Top 10 Web Hacking Techniques 2025**: tren riset, yaitu *parser differentials*, cache poisoning, Unicode normalization, SSRF, kebocoran ORM, error-based code injection; runner-up: request smuggling baru dan bypass SAML.

---

## 5. Katalog kandidat modul HVWA

Legenda prioritas: **P1** = MVP, **P2** = rilis berikutnya, **P3** = lanjutan.

### 5.1 Klasik yang dimodernisasi (warisan DVWA)
| Modul | Varian modern | Map | Prio |
|---|---|---|---|
| SQL Injection | via ORM raw query, JSON operator Postgres, second-order, blind time-based | A05 | P1 |
| NoSQL Injection | operator `$ne/$regex` Mongo, login bypass | A05 | P1 |
| XSS | React `dangerouslySetInnerHTML`, Markdown renderer, DOM clobbering, mXSS sanitizer bypass, XSS di SVG upload | A05 | P1 |
| Command Injection | argumen injection (`--output`) bukan cuma `;` | A05 | P1 |
| SSTI | Jinja2/Nunjucks/Handlebars → RCE | A05 | P1 |
| File Upload | polyglot, ekstensi ganda, path traversal di nama file, ImageMagick/PDF processor, ZIP slip | A01/A05 | P1 |
| Path Traversal / LFI | normalisasi Unicode, double encoding | A01 | P1 |
| CSRF | SameSite=None, CORS misconfig, JSON CSRF | A01 | P2 |
| Brute Force / Credential stuffing | rate limit bypass via header `X-Forwarded-For`, race | A07 | P1 |
| Open Redirect | → pencurian token OAuth | A01 | P2 |
| Insecure Deserialization | Node `node-serialize`, Python pickle, Java gadget (opsional) | A08 | P2 |
| XXE | upload DOCX/SVG | A05 | P2 |
| Cryptography | JWT `alg:none`/key confusion, ECB, nonce reuse, hash tanpa salt, timing attack | A04 | P1 |

### 5.2 Access control dan auth modern
| Modul | Isi | Map | Prio |
|---|---|---|---|
| IDOR/BOLA | REST dan GraphQL, UUID yang bisa ditebak (v1) | A01/API1 | P1 |
| BFLA | endpoint admin tersembunyi, method override | API5 | P1 |
| Mass Assignment | `isAdmin: true` di body | API3 | P1 |
| JWT Lab | `none`, HS/RS confusion, `kid` injection, `jku` | A07 | P1 |
| OAuth 2.0 / OIDC | redirect_uri lemah, state hilang, PKCE downgrade, token leakage | A07 | P2 |
| SAML | signature wrapping, comment injection | A07 | P3 |
| MFA / OTP | brute force OTP, response manipulation, backup code | A07 | P2 |
| Passkeys/WebAuthn | fallback ke password lemah, account recovery flow | A07/A06 | P3 |
| Password reset | host header poisoning, token yang bisa diprediksi | A07 | P1 |

### 5.3 API dan protokol modern
| Modul | Isi | Prio |
|---|---|---|
| GraphQL | introspection, batching brute force, alias DoS, depth attack, IDOR lewat resolver | P1 |
| WebSocket | CSWSH, otorisasi per pesan hilang | P2 |
| gRPC / REST versioning | `/v1` lama masih hidup (API9 Improper Inventory) | P2 |
| Webhooks | SSRF via URL callback, signature tidak diverifikasi | P2 |
| Rate limiting | API4, biaya tak terbatas (export besar, regex ReDoS) | P2 |

### 5.4 Riset terbaru (level "High"/"Inquisitor" ke atas)
| Modul | Isi | Prio |
|---|---|---|
| SSRF → cloud metadata | metadata palsu ala AWS IMDS dalam container, bypass blacklist IP (decimal, IPv6, DNS rebinding) | P1 |
| Prototype Pollution | server-side (Node) → RCE/priv-esc, client-side → XSS | P2 |
| HTTP Request Smuggling | reverse proxy + backend dengan parser berbeda (CL.TE/TE.CL, H2 downgrade) | P3 |
| Web Cache Poisoning/Deception | cache layer (Varnish/nginx) dengan key yang lemah | P3 |
| Parser Differential | URL parser, JSON duplicate key, Unicode normalization | P3 |
| Race Condition | kupon dipakai dua kali, saldo negatif (single-packet attack) | P2 |
| Business Logic | harga negatif, workflow skip, diskon ditumpuk | P1 |
| Exceptional Conditions | error handling yang fail-open, stack trace bocor, kebocoran ORM | P2 (A10 baru) |

### 5.5 Supply chain dan DevSecOps (A03:2025 — kategori baru)
| Modul | Isi | Prio |
|---|---|---|
| Dependency confusion | registry npm/pypi lokal palsu | P2 |
| Malicious package | postinstall script, typosquatting | P2 |
| Secrets di repo | `.git` exposed, `.env`, history commit | P1 |
| CI/CD pipeline | GitHub Actions-like runner lokal: injection lewat judul PR, `pull_request_target` | P3 |
| Container/IaC misconfig | Docker socket ter-mount, IaC salah konfigurasi | P3 |
| Integrity | update tanpa signature, SRI hilang di CDN | P2 |

### 5.6 AI / LLM / Agentic (pembeda utama HVWA)
| Modul | Isi | Map | Prio |
|---|---|---|---|
| Prompt Injection langsung | chatbot "Oracle" dengan rahasia di system prompt | LLM01/LLM08 | P1 |
| Indirect Prompt Injection | instruksi tersembunyi di halaman web, PDF, email, atau gambar yang dibaca bot | LLM01/ASI01 | P1 |
| Improper Output Handling | output LLM dirender sebagai HTML (XSS), dieksekusi sebagai SQL atau shell | LLM10 | P1 |
| Excessive Agency / Tool Misuse | agent dengan tool `send_email`, `refund`, `run_sql` tanpa konfirmasi | LLM03/ASI02 | P1 |
| RAG Poisoning | dokumen beracun di knowledge base, kebocoran lintas tenant di vector DB | LLM09 | P2 |
| MCP Security | tool poisoning (deskripsi tool berisi instruksi), rug pull, shadowing, token theft | ASI04/ASI02 | P2 |
| Memory Poisoning | memori jangka panjang agent disusupi | ASI06 | P2 |
| Multi-agent | agent A memanipulasi agent B, pesan antar-agent tidak diautentikasi | ASI07/ASI08 | P3 |
| Unbounded Consumption | loop agent, denial-of-wallet | LLM06 | P2 |
| Vibe-coded app | fitur yang "ditulis AI" dengan bug khas kode AI (hardcoded secret, validasi hilang) | LLM10/A06 | P2 |
| Human-Agent Trust | agent yang meyakinkan user menyetujui aksi berbahaya | ASI09 | P3 |

**Catatan teknis penting untuk modul AI:** LLM sungguhan bersifat non-deterministik, berbiaya, dan butuh hardware. Rekomendasinya, sediakan tiga *backend*:
1. **Simulator deterministik** (default, offline, gratis): mesin aturan/state machine yang meniru perilaku LLM rentan. Hasilnya stabil untuk penilaian otomatis dan kelas.
2. **Model lokal** via Ollama/llama.cpp (model kecil).
3. **Bawa API key sendiri** (opsional), tidak pernah disimpan ke repo.
Deteksi keberhasilan memakai *canary secret* atau aksi tool yang tercatat, bukan penilaian subjektif.

### 5.7 Blue team (fitur yang tidak dimiliki DVWA maupun Juice Shop secara serius)
- Setiap serangan menghasilkan log terstruktur (JSON) ke dashboard mini-SIEM.
- Tantangan sebaliknya: "temukan di log siapa yang mencuri data", "tulis aturan deteksi" (Sigma-like/regex) lalu diuji terhadap replay serangan.
- Modul A09 (Logging & Alerting Failures): log injection, log yang tidak mencatat event penting, alert yang bisa dimatikan.

---

## 6. Ide kreatif dan pembeda HVWA

### 6.1 Tema "Holy"
Gunakan dunia **fantasi fiksi**, bukan agama nyata, agar tidak menyinggung dan tetap seru. Contoh: *The Holy Citadel*, sebuah kerajaan digital fiksi.
- **Level kesulitan bertema:**
  - **Acolyte** (setara Low): tanpa proteksi
  - **Templar** (Medium): filter naif
  - **Inquisitor** (High): pertahanan nyata tetapi keliru
  - **Divine** (Impossible): implementasi aman dan referensi ASVS
- **Aplikasi terintegrasi:** satu dunia dengan beberapa "bangunan", setiap bangunan adalah satu layanan:
  - *Relic Market*: e-commerce (business logic, race condition, payment)
  - *Scriptorium*: arsip dokumen (upload, XXE, path traversal)
  - *Oracle*: chatbot AI (prompt injection, RAG, agent)
  - *Forum of Pilgrims*: sosial (XSS, CSRF, IDOR)
  - *Gatekeeper SSO*: auth (JWT, OAuth, MFA)
  - *Watchtower*: dashboard log dan SIEM (blue team)
  - *Forge*: CI/CD dan registry paket (supply chain)
  - *Archive API*: GraphQL dan REST (API Top 10)
- **Mode ganda:** pengguna bisa memilih **mode Modul** (satu kerentanan terisolasi dengan slider level, gaya DVWA) atau **mode Pilgrimage/Campaign** (rantai serangan berurutan dari recon sampai takeover, gaya CTF).

### 6.2 Fitur pembelajaran
| Fitur | Penjelasan |
|---|---|
| **Diff View** | Bandingkan kode Acolyte vs Divine dalam bentuk diff berwarna (peningkatan dari View Source DVWA) |
| **Patch Mode** | Pengguna mengedit kode rentan di editor dalam browser, lalu test suite (eksploit otomatis) membuktikan tambalannya berhasil tanpa merusak fungsi |
| **Hint bertingkat** | 3 tingkat: arah → teknik → hampir solusi; opsional memotong skor |
| **Penjelasan bilingual** | Bahasa Indonesia dan Inggris, sejak awal pakai i18n |
| **Pemetaan standar** | Setiap modul diberi tag OWASP 2025, API 2023, LLM 2026, ASI, CWE, ATT&CK |
| **Flag unik per instance** | Mencegah salin-tempel jawaban; kompatibel dengan CTFd |
| **Scoreboard dan progres** | Lokal plus ekspor (JSON/CTFd) |
| **Instructor mode** | Dosen bisa memilih modul aktif, melihat progres kelas, dan mengunci level |
| **WAF toggle** | Pasang WAF (misal ModSecurity/Coraza dengan CRS) lalu latih bypass, sebagai pengganti modern PHPIDS lama |
| **Replay & writeup** | Rekam request yang berhasil dan jadikan writeup otomatis |

### 6.3 Polyglot stack sebagai materi ajar
Setiap layanan bisa ditulis dengan bahasa berbeda (Node, Python, Go, PHP legacy, Java opsional) agar pengguna belajar bahwa kerentanan bergantung pada konteks bahasa dan framework. Konsekuensinya: kompleksitas pemeliharaan naik, jadi perlu dibatasi di MVP.

---

## 7. Gambaran arsitektur (draf, belum keputusan)

```
                 ┌───────────────────────────────┐
 Browser ──────► │  Gateway (nginx / Caddy)       │ ◄─ WAF toggle (Coraza + CRS)
                 └──────────────┬────────────────┘
        ┌──────────┬────────────┼────────────┬──────────────┐
        ▼          ▼            ▼            ▼              ▼
   Portal UI   Core API     GraphQL API   Oracle (AI)   Watchtower (log/SIEM)
   (Next.js)   (Node/Py)    (Node)        (Python)      (log collector + UI)
        │          │            │            │
        └──────────┴──────┬─────┴────────────┘
                          ▼
           Postgres · MongoDB · Redis · Vector DB (pgvector/Chroma)
           Fake cloud metadata · Fake package registry · Mail catcher (Mailpit)
```

- **Orkestrasi:** Docker Compose dengan *profile* (`lite` = hanya modul inti; `full` = semua termasuk AI dan supply chain).
- **Level switching:** setiap modul membaca level dari sesi/konfigurasi; implementasi per level dipisah per file agar mudah ditampilkan di Diff View.
- **Reset:** endpoint reset per modul dan global; seed data deterministik.
- **Registry modul:** metadata (judul, tag standar, hint, flag, checker) dalam file deklaratif (YAML/JSON), sehingga kontributor mudah menambah modul.

---

## 8. Keamanan proyek HVWA itu sendiri

Aplikasi ini **sengaja rentan**, jadi pengamanan lingkungannya justru wajib:
- Default bind ke `127.0.0.1`, peringatan keras di README dan UI agar tidak diekspos ke internet.
- Modul RCE/command injection berjalan di container terisolasi: non-root, tanpa Docker socket, filesystem read-only bila memungkinkan, limit CPU/RAM.
- Egress jaringan diblokir secara default; SSRF diarahkan ke target palsu di jaringan internal Compose.
- Tidak ada rahasia sungguhan; semua kredensial adalah dummy.
- API key LLM (jika dipakai) hanya dari environment variable, tidak pernah ditulis ke disk atau log.
- Paket "malicious" untuk modul supply chain hanya berisi payload jinak (misal menulis flag), dan hanya ada di registry lokal.
- **Lisensi:** DVWA berlisensi GPL-3.0. Jika HVWA ingin lisensi lain (misal MIT), tulis dari nol dan jangan menyalin kode DVWA.
- Disclaimer etika dan hukum: hanya untuk lab sendiri dan pembelajaran.

---

## 9. Rekomendasi roadmap

| Fase | Isi |
|---|---|
| **0 — Fondasi** | Monorepo, Compose, portal UI, sistem level (Acolyte → Divine), registry modul, Diff View, reset, i18n ID/EN |
| **1 — MVP (±12 modul)** | SQLi, NoSQLi, XSS, Command Injection, SSTI, File Upload, IDOR/BOLA, Mass Assignment, JWT, Business Logic, SSRF→metadata, Prompt Injection (langsung + tidak langsung) dengan simulator deterministik |
| **2 — Modern API & Auth** | GraphQL, OAuth/OIDC, MFA, race condition, prototype pollution, password reset, WebSocket, scoreboard dan flag |
| **3 — AI & Supply Chain** | Agent + tool misuse, RAG poisoning, MCP, dependency confusion, secrets di repo, backend Ollama |
| **4 — Blue team & Defense** | Watchtower SIEM, tantangan deteksi, Patch Mode dengan test otomatis, WAF toggle |
| **5 — Lanjutan** | Request smuggling, cache poisoning, parser differential, SAML, CI/CD, multi-agent, Campaign mode, instructor mode, ekspor CTFd |

---

## 10. Keputusan yang perlu diambil sebelum build

1. **Target pengguna utama:** pemula/mahasiswa (prioritas kemudahan), praktisi pentest (prioritas kedalaman), atau keduanya?
2. **Stack inti:** satu bahasa (lebih mudah dirawat) atau polyglot (lebih edukatif)?
3. **Backend AI default:** simulator deterministik saja, atau langsung dukung Ollama?
4. **Model penyajian:** modul terisolasi ala DVWA, dunia terintegrasi ala Juice Shop, atau keduanya (direkomendasikan, dengan mode Modul dulu)?
5. **Lisensi:** MIT/Apache-2.0 (bebas dipakai kampus dan perusahaan) atau GPL-3.0?
6. **Bahasa antarmuka default:** Indonesia atau Inggris?

---

## 11. Sumber

- DVWA repo resmi — https://github.com/digininja/DVWA
- DVWA tutorial 2026 (info v2.5 dan modul API) — https://hackerdna.com/blog/dvwa
- DVWA docs (security levels) — https://www.mintlify.com/digininja/DVWA/configuration/security-levels
- Kali Linux DVWA — https://www.kali.org/tools/dvwa/
- Statistik repo DVWA — https://awesome.ecosyste.ms/projects/github.com%2Fdigininja%2Fdvwa
- OWASP Top 10:2025 — https://owasp.org/Top10/2025/0x00_2025-Introduction/
- The Register: OWASP Top 10 2025 — https://www.theregister.com/2025/11/11/new_owasp_top_ten_broken/
- Qualys: perubahan OWASP Top 10 2025 — https://blog.qualys.com/qualys-insights/2026/06/15/what-changed-in-owasp-top-10-2025-and-recommendations-for-each-category
- OWASP API Security Top 10 2023 — https://apisecurity.io/owasp-api-security-top-10/
- OWASP LLM Top 10 2026 (Help Net Security) — https://www.helpnetsecurity.com/2026/08/06/owasp-2026-llm-top-10-released/
- OWASP LLM Top 10 2026 (perubahan) — https://www.imperva.com/blog/owasp-llm-top-10-2026-what-changed/
- OWASP Top 10 Agentic Applications 2026 — https://www.giskard.ai/knowledge/owasp-top-10-for-agentic-application-2026
- OWASP Agentic Top 10 explained — https://www.speakeasy.com/blog/owasp-agentic-top-10-explained
- PortSwigger Top 10 Web Hacking Techniques 2025 — https://portswigger.net/research/top-10-web-hacking-techniques-of-2025
- Juice Shop CTF — https://help.owasp-juice.shop/part1/ctf.html
- Juice Shop challenge tracking — https://pwning.owasp-juice.shop/companion-guide/latest/part1/challenges.html
- Damn Vulnerable LLM Agent — https://github.com/WithSecureLabs/damn-vulnerable-llm-agent
- Damn Vulnerable MCP Server — https://github.com/harishsg993010/damn-vulnerable-MCP-server
- DVMCP Kyze Labs — https://glama.ai/mcp/servers/Kyze-Labs/damn-vulnerable-MCP-Server
- Damn Vulnerable AI Agent — https://github.com/opena2a-org/damn-vulnerable-ai-agent
- Awesome vulnerable apps — https://github.com/kaiiyer/awesome-vulnerable
- Studi komparatif lab rentan 2026 (RMA Belgia) — https://cylab.be/publications/92/download/2026-teaching-web-security-through-vulnerabilities-a-comparative-study-of-vulnerable-web-applications.pdf

- OWASP Agentic Top 10 (Teleport) — https://goteleport.com/blog/owasp-top-10-agentic-applications
- OWASP Agentic Top 10 (HUMAN Security) — https://www.humansecurity.com/learn/blog/owasp-top-10-agentic-applications/

> **Catatan verifikasi:** daftar OWASP LLM 2026 dan Agentic 2026 berasal dari sumber sekunder yang saling konsisten. Cek ulang di genai.owasp.org sebelum dipakai sebagai label resmi di aplikasi.
