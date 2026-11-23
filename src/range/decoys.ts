// src/range/decoys.ts — honeypot / decoy flags. These are deliberately flag-SHAPED but MALFORMED (leet spelling,
// underscores, punctuation) so they never match RANGE_FLAG_RE: the portal recognises them and answers with a mocking
// popup instead of a plain "wrong", and a leak check that matches the real flag shape ignores them. This is the single
// source of truth: the labs plant these exact strings in DevTools-visible and exploit-reachable decoy spots (HTML
// comments, response headers, robots.txt, JS config, decoy tables/records), so a player who "cleverly" digs one out
// walks into a honeypot. Keep every `flag` here malformed — the test below asserts it.
import { RANGE_FLAG_RE } from '../warden/protocol.js';

export interface Decoy {
  /** The honeypot string, flag-shaped but malformed (never matches RANGE_FLAG_RE). */
  readonly flag: string;
  /** Where a lab plants it, for authors (not shown to players). */
  readonly where: string;
  /** The taunt shown when a player submits it, flavoured by where they found it. */
  readonly taunt: { readonly id: string; readonly en: string };
}

export const RANGE_DECOYS: readonly Decoy[] = Object.freeze([
  { flag: 'HVWA{1s_th1s_c0rr3ct?}', where: 'html-comment',
    taunt: { id: 'Ketemu di komentar HTML, ya? Itu memang sengaja ditaruh biar kelihatan. Bukan flag.',
      en: 'Found it in an HTML comment? That was left there to be found. Not the flag.' } },
  { flag: 'HVWA{v13w_s0urc3_ninja}', where: 'js-config',
    taunt: { id: 'View-source bukan exploit. Flag asli tidak menunggu di config JavaScript.',
      en: 'View-source is not an exploit. The real flag is not waiting in a JS config.' } },
  { flag: 'HVWA{h34d3r_hunt3r_lol}', where: 'response-header',
    taunt: { id: 'Baca response header memang pintar. Tapi header ini cuma umpan.',
      en: 'Reading response headers is smart. This one is just bait, though.' } },
  { flag: 'HVWA{r0b0ts_txt_tr4p}', where: 'robots',
    taunt: { id: 'robots.txt? Klasik. Dan ini jebakan klasik juga.',
      en: 'robots.txt? Classic. And this is a classic trap, too.' } },
  { flag: 'HVWA{y0u_f0und_th3_d3c0y}', where: 'sql-decoy-table',
    taunt: { id: 'Injeksimu jalan — sayang ke rak yang salah. Rak itu memang diisi umpan.',
      en: 'Your injection worked — into the wrong shelf. That shelf was stocked with bait.' } },
  { flag: 'HVWA{n1c3_try_sm4rt_guy}', where: 'api-field',
    taunt: { id: 'Ngulik response API? Bagus. Field ini sengaja diisi flag palsu.',
      en: 'Poking the API response? Nice. This field holds a fake flag on purpose.' } },
  { flag: 'HVWA{th1nk_y0u_h4ck3d_1t?}', where: 'hidden-field',
    taunt: { id: 'Kamu pikir sudah mengakali sistem? Ini cuma input tersembunyi berisi umpan.',
      en: 'Think you beat the system? That was just a hidden field full of bait.' } },
  { flag: 'HVWA{c10s3_but_n0_c1g4r}', where: 'decoy-file',
    taunt: { id: 'Dekat, tapi belum. File itu memang ditaruh untuk menyesatkan.',
      en: 'Close, but not quite. That file was placed to mislead you.' } },
  { flag: 'HVWA{c00k13_m0nst3r_tr4p}', where: 'cookie',
    taunt: { id: 'Baca cookie? Rajin. Isinya tetap umpan.',
      en: 'Reading cookies? Diligent. Still bait.' } },
  { flag: 'HVWA{wr0ng_sh3lf_buddy}', where: 'sql-decoy-table',
    taunt: { id: 'Rak yang salah lagi. Yang asli tidak di sini.',
      en: 'Wrong shelf again. The real one is not here.' } },
  { flag: 'HVWA{d3bug_m0d3_g0tch4}', where: 'comment',
    taunt: { id: 'Catatan debug yang "lupa dihapus"? Itu dipasang untukmu.',
      en: 'A debug note someone "forgot" to remove? It was planted for you.' } },
  { flag: 'HVWA{sm4rt3r_th4n_th3_l4b?}', where: 'meta',
    taunt: { id: 'Merasa lebih pintar dari lab-nya? Umpan ini tidak setuju.',
      en: 'Feeling smarter than the lab? This bait disagrees.' } },
]);

const BY_FLAG = new Map(RANGE_DECOYS.map((d) => [d.flag, d]));

/** The decoy a submission equals (trimmed, exact), or undefined. */
export function decoyOf(submission: string): Decoy | undefined {
  return BY_FLAG.get(submission.trim());
}

// Self-check: every decoy is malformed, so it can never collide with a real flag or be accepted as one.
for (const d of RANGE_DECOYS) {
  if (RANGE_FLAG_RE.test(d.flag)) throw new Error(`decoy ${d.flag} matches RANGE_FLAG_RE; decoys must be malformed`);
}
