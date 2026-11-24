// src/range/facts.ts — per-lab field notes (a fun fact / backstory) for the submit-result popup. Keyed by lab id,
// bilingual; the fact is only shown for a solved / new-best seal (src/range/submit.ts), never for wrong / already.
export interface LabFact {
  readonly en: string;
  readonly id: string;
}

export const LAB_FACTS: Readonly<Record<string, LabFact>> = Object.freeze({
  r01: {
    en: 'SQL injection has appeared in every OWASP Top 10 since the list began. The first public demo was in 1998 — and it still shows up in production today.',
    id: 'SQL injection muncul di setiap OWASP Top 10 sejak daftar itu ada. Demo publik pertamanya pada 1998 — dan masih ditemukan di produksi sampai sekarang.',
  },
  r02: {
    en: 'Broken access control is OWASP Top 10 #1 in 2021. In API breaches the password is rarely the problem; the missing ownership check is.',
    id: 'Broken access control adalah #1 OWASP Top 10 2021. Dalam kebocoran API, kata sandi jarang jadi masalah; pemeriksaan kepemilikan yang hilang itulah masalahnya.',
  },
  r03: {
    en: 'Command injection is older than the web. In 2014 Shellshock let one malformed HTTP header run shell commands on millions of servers.',
    id: 'Command injection lebih tua dari web. Pada 2014, Shellshock membuat satu header HTTP yang cacat menjalankan perintah shell di jutaan server.',
  },
  r04: {
    en: 'Server-side template injection was popularized by James Kettle in 2015. A single pair of braces can turn a greeting card into remote code execution.',
    id: 'Server-side template injection dipopulerkan James Kettle pada 2015. Sepasang kurung kurawal bisa mengubah kartu ucapan menjadi eksekusi kode jarak jauh.',
  },
  r05: {
    en: 'Binanse is fictional, but its story echoes a 2022 crypto-exchange DevOps compromise: one stolen staff session can be the skeleton key to the vault. Stored XSS is often the quietest way in.',
    id: 'Binanse fiktif, tetapi kisahnya bergema dengan kompromi DevOps di sebuah bursa kripto 2022: satu sesi staf yang dicuri bisa menjadi kunci utama brankas. Stored XSS sering menjadi jalan masuk paling sunyi.',
  },
  r06: {
    en: 'Padding oracles are older than most of the web: Serge Vaudenay described the attack in 2002, and it went on to break ASP.NET (2010) and, as POODLE, SSL 3.0 (2014). A server that only says "valid" or "invalid" can still read you the whole message.',
    id: 'Padding oracle lebih tua dari sebagian besar web: Serge Vaudenay menjabarkan serangan ini pada 2002, lalu serangan itu menjebol ASP.NET (2010) dan, sebagai POODLE, SSL 3.0 (2014). Server yang hanya menjawab "valid" atau "tidak valid" tetap bisa membacakan seluruh pesannya.',
  },
});

export function labFact(labId: string): LabFact | undefined {
  return Object.hasOwn(LAB_FACTS, labId) ? LAB_FACTS[labId] : undefined;
}
