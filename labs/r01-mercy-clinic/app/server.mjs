// labs/r01-mercy-clinic/app/server.mjs — Mercy Clinic. Start hook: read the one-shot flag file (HVWA_FLAG_FILE) once and
// unlink it, then open the main SQLite DB in /tmp, seed it and plant the flag on the level's shelf (spec §6): Acolyte a
// staff-only notice, Templar a random vault table named by `vault_index`, Inquisitor a random ledger table reached
// through the token-gated /staff/ledger route. The notice search at /search is the vulnerable feature; its behaviour is
// chosen by HVWA_LEVEL (db.mjs). At Inquisitor the search runs against a separate public DB (public notices + service
// token) so the flag stays out of its reach; the token opens the staff list, whose notice only names a ledger record.
// Listens on 0.0.0.0:$HVWA_PORT.
import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openDb, openPublicDb, plantFlag, getLedger, listPublic, getPublic, relatedPublic, listPatients, listAppointments, searchNotices, staffToken, listStaff } from './db.mjs';
import {
  page, noticeCard, esc, searchForm, badge, staffCard, stat, sectionHead,
  formatDate, formatDayDate, formatTime, favicon, notFoundPage, errorPage,
} from './render.mjs';

const LEVELS = ['acolyte', 'templar', 'inquisitor', 'divine'];
const level = LEVELS.includes(process.env.HVWA_LEVEL ?? '') ? process.env.HVWA_LEVEL : 'acolyte';
const port = Number(process.env.HVWA_PORT || 8080);
const flagSource = process.env.HVWA_FLAG_FILE || '/tmp/.hvwa-flag';

/** Poll for the one-shot flag file, read it once and unlink it. Below Divine only; otherwise exit non-zero. */
async function readFlag() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const value = readFileSync(flagSource, 'utf8').trim();
      if (value) { unlinkSync(flagSource); return value; }
    } catch { /* the warden has not written it yet */ }
    if (Date.now() >= deadline) {
      console.error('mercy-clinic: the flag file never appeared'); // never the flag itself
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const flag = level === 'divine' ? undefined : await readFlag();
const db = openDb('/tmp/clinic.db');
const publicDb = openPublicDb('/tmp/public.db');
const planted = plantFlag(db, level, flag); // { ledgerTable }, the shelf Inquisitor's staff route opens

const send = (res, status, type, body) => {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  res.end(body);
};
const html = (res, status, body) => send(res, status, 'text/html; charset=utf-8', body);

const DEPARTMENTS = [
  {
    name: 'General practice', rooms: 'Rooms 1A–1C', ext: '100',
    blurb: 'Our GPs are the first point of contact for most health concerns, from a new symptom to an ongoing condition.',
    services: ['Routine and urgent appointments', 'Long-term condition reviews', 'Referrals to specialist care', 'Minor surgery'],
  },
  {
    name: 'Nursing & vaccinations', rooms: 'Rooms 2A–2B', ext: '200',
    blurb: 'The nursing team provides vaccinations, dressings, health checks and advice on managing medicines at home.',
    services: ['Winter flu and MMR clinics', 'Travel health and vaccinations', 'Blood pressure and health checks', 'Wound care and dressings'],
  },
  {
    name: 'Pharmacy', rooms: 'Counter 0A', ext: '011',
    blurb: 'Our pharmacist works alongside the GPs to review medicines, answer questions and prepare repeat prescriptions.',
    services: ['Repeat prescription queries', 'Medication reviews', 'Advice on side effects', 'Collection from the pharmacy counter'],
  },
  {
    name: 'Physiotherapy', rooms: 'Room 3C', ext: '301',
    blurb: 'Dr. Priya Shah helps patients recover from joint, muscle and back pain with a plan they can keep up at home.',
    services: ['Back and joint pain assessment', 'Exercise programmes', 'Post-injury rehabilitation', 'Weekly movement group'],
  },
  {
    name: 'Mental health & wellbeing', rooms: 'Room 3A', ext: '310',
    blurb: 'Confidential short-term counselling and a weekly drop-in for anyone who would like to talk things through.',
    services: ['Short-term counselling', 'Thursday drop-in', 'Stress and sleep support', 'Signposting to local services'],
  },
  {
    name: 'Administration', rooms: 'Front desk and room 2C', ext: '001',
    blurb: 'Reception and the practice management team look after appointments, letters, records and patient feedback.',
    services: ['Appointments and cancellations', 'Letters and records', 'Access and support requests', 'Patient feedback'],
  },
];

const CAPACITY = {
  'General practice': 8,
  'Nursing & vaccinations': 10,
  Pharmacy: 6,
  Physiotherapy: 5,
  'Mental health & wellbeing': 4,
};

const SUGGESTIONS = ['flu', 'prescriptions', 'parking', 'opening hours', 'vaccinations'];

const HOURS_UTC = {
  0: null,
  1: [8 * 60, 18 * 60 + 30],
  2: [8 * 60, 18 * 60 + 30],
  3: [8 * 60, 18 * 60 + 30],
  4: [8 * 60, 18 * 60 + 30],
  5: [8 * 60, 18 * 60 + 30],
  6: [9 * 60, 12 * 60 + 30],
};
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

function clinicStatus(now = new Date()) {
  const day = now.getUTCDay();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const today = HOURS_UTC[day];
  if (today && mins >= today[0] && mins < today[1]) {
    return { open: true, label: 'Open now', detail: `Reception closes at ${hhmm(today[1])} UTC` };
  }
  for (let offset = 0; offset < 8; offset += 1) {
    const d = (day + offset) % 7;
    const hours = HOURS_UTC[d];
    if (!hours) continue;
    if (offset === 0 && mins >= hours[1]) continue;
    const when = offset === 0 ? 'today' : DAY_NAMES[d];
    return { open: false, label: 'Closed now', detail: `Opens ${when} at ${hhmm(hours[0])} UTC` };
  }
  return { open: false, label: 'Closed now', detail: 'Opens Monday at 08:00 UTC' };
}

function nextFluClinic(now = new Date()) {
  let ahead = (2 - now.getUTCDay() + 7) % 7;
  if (ahead === 0 && now.getUTCHours() >= 12) ahead = 7;
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + ahead, 9, 0)).toISOString();
}

function suggestionChips() {
  return `<ul class="suggestions">${SUGGESTIONS.map((s) =>
    `<li><a class="chip" href="/search?q=${encodeURIComponent(s)}">${esc(s)}</a></li>`).join('')}</ul>`;
}

function homePage() {
  const notices = listPublic(db);
  const staff = listPatients(db).filter((p) => p.department !== 'Administration');
  const status = clinicStatus();
  const flu = nextFluClinic();
  return `<section class="hero"><div>`
    + `<p class="eyebrow">Community healthcare in Ashford since 1996</p>`
    + `<h1>Care that knows your name.</h1>`
    + `<p class="lede">Book an appointment, order a repeat prescription and read the latest news from Mercy Clinic — all in one place.</p>`
    + searchForm()
    + `<ul class="quick-actions"><li><a href="/appointments">Book an appointment</a></li><li><a href="/notices">Patient notices</a></li>`
    + `<li><a href="/opening-hours">Opening hours</a></li><li><a href="/contact">Find us</a></li></ul>`
    + `</div><aside class="hero-panel" aria-label="Clinic at a glance"><h2>At a glance</h2>`
    + `<p><span class="dot${status.open ? '' : ' closed'}"></span><strong>${esc(status.label)}</strong>`
    + `<span class="status-value"><small>${esc(status.detail)}</small></span></p>`
    + `<hr class="panel-rule"><p><strong>Reception</strong><br><a href="tel:+441233555014">01233 555 014</a></p>`
    + `<p><strong>Find us</strong><br>14 Willow Lane<br>Ashford, Kent TN23 4MC</p>`
    + `<p><a class="text-link" href="/contact">Directions and parking →</a></p></aside></section>`
    + `<section class="status-strip" aria-label="Clinic information">`
    + `<div class="status-item"><span class="status-label">Next flu clinic</span><span class="status-value">${esc(formatDayDate(flu))}<small>09:00–12:00 UTC · walk in</small></span></div>`
    + `<div class="status-item"><span class="status-label">Pharmacy counter</span><span class="status-value">Mon–Fri 08:30–18:00<small>Saturday 09:00–12:30</small></span></div>`
    + `<div class="status-item"><span class="status-label">Appointments</span><span class="status-value">Request online or call reception<small>01233 555 014</small></span></div>`
    + `<div class="status-item"><span class="status-label">Out of hours</span><span class="status-value">Call NHS 111<small>999 for a life-threatening emergency</small></span></div>`
    + `</section>`
    + `<section class="section"><div class="section-head"><h2>Mercy Clinic at a glance</h2></div><div class="stats">`
    + stat(String(staff.length), 'clinicians and nurses') + stat('6', 'departments') + stat('3,200', 'registered patients') + stat('30', 'years in Ashford')
    + `</div></section>`
    + `<section class="section">${sectionHead('Latest patient notices', '/notices', 'All notices')}`
    + `<div class="notice-grid">${notices.slice(0, 6).map((n) => noticeCard(n)).join('')}</div></section>`
    + `<section class="section"><div class="section-head"><h2>How to get care</h2><a class="text-link" href="/appointments">Book online →</a></div>`
    + `<div class="values"><div class="value"><h3>Book an appointment</h3><p>Request a routine or urgent appointment online, or call reception. We will confirm the time with you.</p></div>`
    + `<div class="value"><h3>Repeat prescriptions</h3><p>Order a repeat prescription through the portal or at reception. Please allow two working days.</p></div>`
    + `<div class="value"><h3>Urgent advice</h3><p>For urgent medical help when we are closed, call NHS 111. For a life-threatening emergency, call 999.</p></div></div></section>`
    + `<section class="section">${sectionHead('Meet the team', '/patients', 'Our whole team')}`
    + `<div class="team-grid">${staff.slice(0, 4).map((p) => staffCard(p)).join('')}</div></section>`;
}

function noticesPage(url) {
  const all = listPublic(db);
  const categories = [...new Set(all.map((n) => n.category).filter(Boolean))];
  const requested = (url.searchParams.get('category') || '').trim();
  const rows = requested ? all.filter((n) => n.category === requested) : all;
  const chips = [`<li><a class="chip" href="/notices"${requested ? '' : ' aria-current="true"'}>All notices</a></li>`]
    .concat(categories.map((c) => `<li><a class="chip" href="/notices?category=${encodeURIComponent(c)}"${c === requested ? ' aria-current="true"' : ''}>${esc(c)}</a></li>`))
    .join('');
  const list = rows.length
    ? `<div class="notice-grid">${rows.map((n) => noticeCard(n)).join('')}</div>`
    : `<div class="no-results"><p><strong>No notices in that category.</strong></p><p><a href="/notices">Browse all patient notices</a>.</p></div>`;
  return `<h1>Patient notices</h1><p class="lede">Closures, clinics and practical information from the Mercy Clinic team.</p>`
    + `<ul class="suggestions" aria-label="Filter notices by category">${chips}</ul>`
    + `<p class="result-summary"><strong>${rows.length}</strong> ${rows.length === 1 ? 'notice' : 'notices'}${requested ? ` in “${esc(requested)}”` : ''}</p>`
    + list;
}

function searchPage(url) {
  const q = url.searchParams.get('q') ?? '';
  // Inquisitor searches only the public DB, so even a direct UNION over notices cannot surface the staff flag.
  const searchDb = level === 'inquisitor' ? publicDb : db;
  const found = q.trim() === '' ? [] : searchNotices(searchDb, level, q);
  // Inquisitor's SELECT carries visibility; only genuine public rows (or injected rows that claim it) may render.
  const rows = level === 'inquisitor' ? found.filter((r) => r.visibility === 'public') : found;
  const metaById = new Map(listPublic(db).map((n) => [n.id, n]));
  const cards = rows.map((r) => {
    const meta = metaById.get(r.id);
    // Highlight only rows that really are in the public table: an injected row must never have its body split by markup.
    const isPublic = Boolean(meta && meta.title === r.title && meta.body === r.body);
    return noticeCard(r, { term: isPublic ? q : '', meta });
  }).join('');
  let result;
  if (q.trim() === '') {
    result = `<div class="no-results"><p><strong>Search our patient notices.</strong></p>`
      + `<p>Enter a word such as “flu”, “parking” or “prescriptions”.</p>${suggestionChips()}</div>`;
  } else if (rows.length === 0) {
    result = `<div class="no-results"><p><strong>No notices matched “${esc(q)}”.</strong></p>`
      + `<p>Check the spelling, try a shorter word, or browse all notices.</p>`
      + `<p><a class="btn btn-secondary" href="/notices">Browse all notices</a></p>${suggestionChips()}</div>`;
  } else {
    result = `<p class="result-summary"><strong>${rows.length}</strong> ${rows.length === 1 ? 'notice' : 'notices'} matching “${esc(q)}”</p>`
      + `<div class="notice-grid">${cards}</div>`;
  }
  return `<h1>Search notices</h1><p class="lede">Search patient notices by title or content.</p>`
    + searchForm(q, 'q-search') + result;
}

/** The token-gated staff notices. Every value is escaped; the token itself is never rendered. */
function staffNoticesPage(notices) {
  const cards = notices.map((n) => {
    const when = formatDate(n.published_at);
    return `<article class="notice-card"><div class="notice-hit">`
      + `<span class="notice-top">${badge(n.category)}${when ? `<time datetime="${esc(n.published_at)}">${esc(when)}</time>` : ''}</span>`
      + `<h3>${esc(n.title)}</h3><p class="notice-body">${esc(n.body)}</p>`
      + `<span class="notice-foot"><span class="byline">${n.author ? esc(n.author) : 'Mercy Clinic'}</span><span class="more">Staff only</span></span>`
      + `</div></article>`;
  }).join('');
  return `<h1>Staff notices</h1><p class="lede">Internal notices for Mercy Clinic staff. Do not share outside the practice.</p>`
    + (notices.length
      ? `<div class="notice-grid">${cards}</div>`
      : `<div class="no-results"><p><strong>No staff notices.</strong></p></div>`);
}

function staffDeniedPage() {
  return `<div class="not-found"><p class="big">401</p><h1>Staff sign-in required</h1>`
    + `<p class="lede">This area is for Mercy Clinic staff. A valid service token is required.</p>`
    + `<p><a class="btn btn-secondary" href="/">Return to the home page</a></p></div>`;
}

/** One record from the vault ledger. The staff notice only carries its number; the token opens the record. */
function ledgerPage(record) {
  return `<h1>${esc(record.title)}</h1>`
    + `<p class="lede">A record from the clinic's internal vault ledger.</p>`
    + `<article class="notice-detail"><div class="body">${esc(record.body)}</div></article>`;
}

function noticePage(notice) {
  const related = notice.category ? relatedPublic(db, notice.category, notice.id) : [];
  const meta = [
    notice.published_at ? `Published <time datetime="${esc(notice.published_at)}">${esc(formatDate(notice.published_at))}</time>` : '',
    notice.author ? `By ${esc(notice.author)}` : '',
    notice.category ? esc(notice.category) : '',
  ].filter(Boolean).map((part) => `<span>${part}</span>`).join('');
  return `<p class="crumbs"><a href="/notices">Patient notices</a> / ${esc(notice.category || 'Notice')}</p>`
    + `<article class="notice-detail">${badge(notice.category)}<h1>${esc(notice.title)}</h1>`
    + `<div class="meta">${meta}</div><div class="body">${esc(notice.body)}</div></article>`
    + (related.length
      ? `<section class="section">${sectionHead('Related notices', '/notices', 'All notices')}<div class="notice-grid">${related.map((n) => noticeCard(n)).join('')}</div></section>`
      : '');
}

function patientsPage() {
  const staff = listPatients(db);
  return `<h1>Our team</h1><p class="lede">The people who look after Mercy Clinic — from your GP to the reception desk.</p>`
    + `<div class="team-grid">${staff.map((p) => staffCard(p)).join('')}</div>`
    + `<div class="callout"><h3>Need to speak to someone?</h3><p>Call reception on <a href="tel:+441233555014">01233 555 014</a> or use the <a href="/appointments">appointment request form</a>. Please do not send clinical information by email.</p></div>`;
}

function departmentsPage() {
  const staff = listPatients(db);
  const cards = DEPARTMENTS.map((d) => {
    const names = staff.filter((p) => p.department === d.name).map((p) => p.name);
    return `<article class="dept-card"><h2>${esc(d.name)}</h2>`
      + `<p class="dept-meta">${esc(d.rooms)} · ext ${esc(d.ext)}</p>`
      + `<p>${esc(d.blurb)}</p><ul>${d.services.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>`
      + (names.length ? `<p class="person-meta">Team: ${names.map((n) => esc(n)).join(', ')}</p>` : '')
      + `</article>`;
  }).join('');
  return `<h1>Our departments</h1><p class="lede">Six teams working together under one roof. Ask at reception if you are not sure who to see.</p>`
    + `<div class="dept-grid">${cards}</div>`;
}

function capacityFor(department) {
  return CAPACITY[department] ?? 8;
}

function sessionRows() {
  const rows = listAppointments(db);
  const sessions = new Map();
  for (const a of rows) {
    const date = a.starts_at.slice(0, 10);
    const key = `${a.clinician}|${date}`;
    let s = sessions.get(key);
    if (!s) {
      s = { clinician: a.clinician, department: a.department, room: a.room, date,
        first: a.starts_at, endMs: new Date(a.starts_at).getTime() + (a.duration_min || 15) * 60000,
        booked: 0, capacity: capacityFor(a.department) };
      sessions.set(key, s);
    }
    if (a.starts_at < s.first) s.first = a.starts_at;
    const endMs = new Date(a.starts_at).getTime() + (a.duration_min || 15) * 60000;
    if (endMs > s.endMs) s.endMs = endMs;
    if (a.status === 'booked') s.booked += 1;
  }
  return [...sessions.values()]
    .sort((x, y) => x.first.localeCompare(y.first) || x.clinician.localeCompare(y.clinician))
    .slice(0, 12);
}

function sessionTable() {
  const rows = sessionRows();
  if (!rows.length) return `<p class="empty">No clinic sessions are listed at the moment.</p>`;
  return `<div class="table-wrap"><table><caption>Clinic sessions in the next seven days</caption><thead><tr>`
    + `<th scope="col">Day</th><th scope="col">Time</th><th scope="col">Clinician</th><th scope="col">Department</th><th scope="col">Room</th><th scope="col">Availability</th>`
    + `</tr></thead><tbody>${rows.map((s) => {
      const left = Math.max(0, s.capacity - s.booked);
      const availability = left === 0 ? 'Waiting list' : `${left} of ${s.capacity} slots free`;
      return `<tr><td>${esc(formatDayDate(s.first))}</td>`
        + `<td>${esc(formatTime(s.first))}–${esc(formatTime(new Date(s.endMs).toISOString()))}</td>`
        + `<td>${esc(s.clinician)}</td><td>${esc(s.department)}</td><td>${esc(s.room)}</td><td>${esc(availability)}</td></tr>`;
    }).join('')}</tbody></table></div>`;
}

const DAY_OPTIONS = ['Next available', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function appointmentsPage({ form = null, errors = [], confirmed = null } = {}) {
  const value = (key) => {
    const raw = form?.get(key);
    return typeof raw === 'string' ? raw.slice(0, 200) : '';
  };
  const name = value('name');
  const phone = value('phone');
  const email = value('email');
  const department = value('department');
  const day = value('day') || DAY_OPTIONS[0];
  const reason = value('reason');
  const errorHtml = errors.length
    ? `<div class="error-summary" role="alert"><h2>Please check your request</h2><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`
    : '';
  const formHtml = confirmed ? `<div class="confirmation" role="status"><h2>Request received</h2>`
    + `<p>Thank you, ${esc(confirmed.name)}. Your reference is <span class="ref">${esc(confirmed.ref)}</span>.</p>`
    + `<p>Our reception team will call you on ${esc(confirmed.phone)} within one working day to confirm a time. `
    + `You asked for <strong>${esc(confirmed.department)}</strong> and your preferred day is <strong>${esc(confirmed.day)}</strong>.</p>`
    + (confirmed.reason ? `<p>Your note: “${esc(confirmed.reason)}”</p>` : '')
    + `<p>No appointment has been booked yet. If your symptoms get worse, call reception or NHS 111.</p>`
    + `<p><a class="btn btn-secondary" href="/appointments">Make another request</a></p></div>`
    : `<form class="panel" method="post" action="/appointments">`
      + `<h2>Request an appointment</h2><p>Tell us a little about what you need and we will call you back to confirm a time. Fields marked * are required.</p>`
      + errorHtml
      + `<div class="form-grid">`
      + `<div class="field"><label for="ap-name">Full name *</label><input id="ap-name" name="name" value="${esc(name)}" autocomplete="name" required></div>`
      + `<div class="field"><label for="ap-phone">Phone number *</label><input id="ap-phone" name="phone" value="${esc(phone)}" autocomplete="tel" inputmode="tel" required></div>`
      + `<div class="field"><label for="ap-email">Email <span class="hint">(optional)</span></label><input id="ap-email" name="email" type="email" value="${esc(email)}" autocomplete="email"></div>`
      + `<div class="field"><label for="ap-dept">Department *</label><select id="ap-dept" name="department" required><option value="">Choose a department</option>`
      + DEPARTMENTS.map((d) => `<option value="${esc(d.name)}"${d.name === department ? ' selected' : ''}>${esc(d.name)}</option>`).join('')
      + `</select></div>`
      + `<div class="field"><label for="ap-day">Preferred day</label><select id="ap-day" name="day">`
      + DAY_OPTIONS.map((d) => `<option${d === day ? ' selected' : ''}>${esc(d)}</option>`).join('')
      + `</select></div>`
      + `<div class="field field-full"><label for="ap-reason">What would you like help with? <span class="hint">(optional)</span></label>`
      + `<textarea id="ap-reason" name="reason" placeholder="For example: a persistent cough, a medication review, or a vaccination question.">${esc(reason)}</textarea></div>`
      + `<div class="field-full check"><input id="ap-consent" name="consent" type="checkbox" value="yes">`
      + `<label for="ap-consent">I am happy for the reception team to contact me about this request. *</label></div>`
      + `</div><div class="form-actions"><button class="btn" type="submit">Send request</button>`
      + `<span class="hint">Requests are reviewed during reception hours. For urgent help, call 01233 555 014.</span></div></form>`;
  return `<h1>Appointments</h1><p class="lede">Request a routine appointment below, or call reception on <a href="tel:+441233555014">01233 555 014</a>. `
    + `If you need urgent medical help, please call us rather than using this form.</p>`
    + `<section class="section"><div class="section-head"><h2>This week at the clinic</h2></div>${sessionTable()}</section>`
    + `<section class="section">${formHtml}</section>`
    + `<div class="callout"><h3>Help us keep appointments free</h3><p>If you can no longer attend, please let us know at least 24 hours in advance so another patient can use the slot.</p></div>`;
}

function aboutPage() {
  return `<h1>About Mercy Clinic</h1><p class="lede">A community practice on Willow Lane, looking after around 3,200 patients in Ashford and the surrounding villages.</p>`
    + `<div class="values"><div class="value"><h3>Continuity of care</h3><p>We try to keep you with the same clinician where it matters, especially for long-term conditions.</p></div>`
    + `<div class="value"><h3>Straightforward advice</h3><p>We explain options in plain language and make sure you know what happens next.</p></div>`
    + `<div class="value"><h3>Part of the community</h3><p>From coffee mornings to vaccination clinics, we want the practice to feel like a place you can drop into.</p></div></div>`
    + `<section class="section"><h2>Our story</h2><ol class="timeline">`
    + `<li><strong>1996</strong><span>Mercy Clinic opens as a two-room practice on Willow Lane.</span></li>`
    + `<li><strong>2004</strong><span>The practice expands into the neighbouring building, adding nursing and treatment rooms.</span></li>`
    + `<li><strong>2016</strong><span>The pharmacy counter opens on the ground floor.</span></li>`
    + `<li><strong>2024</strong><span>A new third-floor wing adds physiotherapy and mental health consulting rooms.</span></li>`
    + `<li><strong>2026</strong><span>Thirty years of caring for Ashford — and still independently run.</span></li></ol></section>`
    + `<section class="section"><div class="section-head"><h2>Get involved</h2><a class="text-link" href="/contact">Contact the practice →</a></div>`
    + `<p>Our patient participation group meets four times a year to share feedback and help shape services. Ask at reception or email the practice if you would like to join.</p></section>`;
}

function contactPage() {
  return `<h1>Contact and find us</h1><p class="lede">Mercy Clinic is on Willow Lane, a short walk from Ashford town centre and the library.</p>`
    + `<div class="contact-grid">`
    + `<div class="contact-card"><h2>Address</h2><p>Mercy Clinic<br>14 Willow Lane<br>Ashford, Kent<br>TN23 4MC</p><p><a href="/contact">Directions and parking</a></p></div>`
    + `<div class="contact-card"><h2>Phone and email</h2><p>Reception: <a href="tel:+441233555014">01233 555 014</a></p>`
    + `<p>Email: <a href="mailto:hello@mercyclinic.example">hello@mercyclinic.example</a></p><p>Please do not send clinical information by email.</p></div>`
    + `<div class="contact-card"><h2>Accessibility</h2><p>The main entrance is step-free. A lift serves all floors and an accessible toilet is on the ground floor.</p>`
    + `<p>Ask at reception if you need help with mobility, hearing or sight.</p></div>`
    + `<div class="contact-card"><h2>Parking and transport</h2><p>Pay-and-display parking is opposite the library. Accessible bays are by the main door.</p>`
    + `<p>Buses 12 and 14 stop on Willow Lane, a two-minute walk from the practice.</p></div>`
    + `</div>`
    + `<section class="section"><figure class="map-card">`
    + `<svg viewBox="0 0 640 300" role="img" aria-labelledby="map-title map-desc">`
    + `<title id="map-title">Illustrative map showing Mercy Clinic on Willow Lane</title>`
    + `<desc id="map-desc">Willow Lane runs east to west. The clinic is on the north side, opposite the library and next to the pay-and-display car park.</desc>`
    + `<rect width="640" height="300" fill="#eef3e9"/>`
    + `<path d="M0 190h640" stroke="#c9d4c4" stroke-width="34"/><path d="M0 190h640" stroke="#fdfbf4" stroke-width="26"/>`
    + `<path d="M170 0v300M470 0v300" stroke="#c9d4c4" stroke-width="24"/><path d="M170 0v300M470 0v300" stroke="#fdfbf4" stroke-width="18"/>`
    + `<rect x="205" y="60" width="150" height="88" rx="6" fill="#d9e2d4" stroke="#a9b9a2"/>`
    + `<rect x="245" y="205" width="170" height="70" rx="6" fill="#d9e2d4" stroke="#a9b9a2"/>`
    + `<rect x="500" y="58" width="105" height="90" rx="6" fill="#d9e2d4" stroke="#a9b9a2"/>`
    + `<rect x="30" y="215" width="105" height="60" rx="6" fill="#d9e2d4" stroke="#a9b9a2"/>`
    + `<rect x="280" y="125" width="72" height="58" rx="8" fill="#0d6e6e"/>`
    + `<path d="M309 140h8v10h10v8h-10v10h-8v-10h-10v-8h10z" fill="#fbf7ee"/>`
    + `<circle cx="330" cy="150" r="5" fill="#b96b32"/>`
    + `<text x="240" y="205" font-family="Georgia,serif" font-size="17" fill="#17312f">Mercy Clinic</text>`
    + `<text x="205" y="112" font-family="system-ui,sans-serif" font-size="13" fill="#46615e">Library</text>`
    + `<text x="500" y="112" font-family="system-ui,sans-serif" font-size="13" fill="#46615e">Car park</text>`
    + `<text x="432" y="187" font-family="system-ui,sans-serif" font-size="13" fill="#46615e">Willow Lane</text>`
    + `<text x="500" y="272" font-family="system-ui,sans-serif" font-size="12" fill="#5d7468">Illustration, not to scale</text>`
    + `</svg><figcaption>Illustrative map — 14 Willow Lane, Ashford TN23 4MC. The clinic is on the north side of Willow Lane, opposite the library.</figcaption></figure></section>`
    + `<div class="callout"><h3>Out of hours</h3><p>When the practice is closed, call NHS 111 for urgent medical help. For a life-threatening emergency, call 999.</p></div>`;
}

function hoursPage() {
  return `<h1>Opening hours</h1><p class="lede">Reception, the pharmacy counter and our clinics. All times are shown in UTC.</p>`
    + `<div class="table-wrap"><table><caption>Reception and pharmacy hours</caption><thead><tr>`
    + `<th scope="col">Day</th><th scope="col">Reception</th><th scope="col">Pharmacy counter</th></tr></thead><tbody>`
    + `<tr><th scope="row">Monday to Friday</th><td>08:00–18:30</td><td>08:30–18:00</td></tr>`
    + `<tr><th scope="row">Saturday</th><td>09:00–12:30</td><td>09:00–12:30</td></tr>`
    + `<tr><th scope="row">Sunday</th><td>Closed</td><td>Closed</td></tr>`
    + `</tbody></table></div>`
    + `<section class="section"><div class="values">`
    + `<div class="value"><h3>Extended hours</h3><p>From 2 December the practice opens at 07:30 on weekdays and stays open until 19:00 on Tuesdays and Thursdays.</p></div>`
    + `<div class="value"><h3>Winter flu clinic</h3><p>Every Tuesday, 09:00–12:00, in the community room. No appointment is needed.</p></div>`
    + `<div class="value"><h3>Bank holidays</h3><p>The practice is closed on 25 and 26 December and on 1 January. Please plan repeat prescriptions ahead.</p></div>`
    + `</div></section>`
    + `<div class="callout"><h3>When we are closed</h3><p>Call NHS 111 for urgent medical help. For a life-threatening emergency, call 999. Repeat prescriptions can be requested online at any time.</p></div>`;
}

/** Read a small urlencoded body (the appointment request form); never stored. */
function readForm(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error('form too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(body)));
    req.on('error', reject);
  });
}

const makeReference = () => `MC-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${randomBytes(2).toString('hex').toUpperCase()}`;

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://clinic');
    const p = url.pathname;

    if (p === '/healthz') return send(res, 200, 'application/json', '{"status":"ok"}');
    if (p === '/favicon.svg') return send(res, 200, 'image/svg+xml; charset=utf-8', favicon);

    if (p === '/') return html(res, 200, page('Home', homePage(), { active: 'home' }));

    if (p === '/search') return html(res, 200, page('Search', searchPage(url), { active: 'notices' }));

    // Staff notices exist at every level but are reachable only with the service token. Only Inquisitor's search leaks
    // that token; at Divine the search is parameterised, so this route stays 401 to anyone without it.
    if (p === '/staff/notices') {
      const presented = (url.searchParams.get('token') || '').trim();
      // The token lives in the public DB (which Inquisitor can leak); the staff notices come from the main clinic DB.
      const expected = staffToken(publicDb);
      if (!presented || !expected || presented !== expected) {
        return html(res, 401, page('Staff sign-in', staffDeniedPage(), { active: '' }));
      }
      return html(res, 200, page('Staff notices', staffNoticesPage(listStaff(db)), { active: '' }));
    }

    // Inquisitor's second step: the staff notice names a ledger record; this route opens it with the same token.
    // The ledger table is random and its name is never rendered, so the staff list alone does not reveal the flag.
    const mLedger = p.match(/^\/staff\/ledger\/(\d+)$/);
    if (mLedger) {
      const presented = (url.searchParams.get('token') || '').trim();
      const expected = staffToken(publicDb);
      if (!presented || !expected || presented !== expected) {
        return html(res, 401, page('Staff sign-in', staffDeniedPage(), { active: '' }));
      }
      const record = getLedger(db, planted.ledgerTable, Number(mLedger[1]));
      if (!record) return html(res, 404, page('Not found', notFoundPage(), { active: '' }));
      return html(res, 200, page('Vault ledger', ledgerPage(record), { active: '' }));
    }

    if (p === '/notices') return html(res, 200, page('Patient notices', noticesPage(url), { active: 'notices' }));

    if (p === '/patients') return html(res, 200, page('Our team', patientsPage(), { active: 'team' }));

    if (p === '/departments') return html(res, 200, page('Departments', departmentsPage(), { active: 'departments' }));

    if (p === '/appointments' && req.method === 'POST') {
      const form = await readForm(req);
      const name = (form.get('name') || '').trim().slice(0, 120);
      const phone = (form.get('phone') || '').trim().slice(0, 40);
      const department = (form.get('department') || '').trim();
      const day = (form.get('day') || '').trim();
      const reason = (form.get('reason') || '').trim().slice(0, 400);
      const errors = [];
      if (!name) errors.push('Please enter your full name.');
      if (!phone) errors.push('Please enter a phone number so reception can confirm your request.');
      if (!DEPARTMENTS.some((d) => d.name === department)) errors.push('Please choose a department.');
      if (form.get('consent') !== 'yes') errors.push('Please confirm that we may contact you about this request.');
      if (errors.length) {
        return html(res, 422, page('Appointments', appointmentsPage({ form, errors }), { active: 'appointments' }));
      }
      const confirmed = {
        ref: makeReference(), name, phone, department,
        day: DAY_OPTIONS.includes(day) ? day : DAY_OPTIONS[0],
        reason,
      };
      return html(res, 200, page('Appointments', appointmentsPage({ confirmed }), { active: 'appointments' }));
    }

    if (p === '/appointments') return html(res, 200, page('Appointments', appointmentsPage(), { active: 'appointments' }));

    if (p === '/about') return html(res, 200, page('About us', aboutPage(), { active: 'about' }));

    if (p === '/contact') return html(res, 200, page('Contact', contactPage(), { active: 'contact' }));

    if (p === '/opening-hours') return html(res, 200, page('Opening hours', hoursPage(), { active: 'hours' }));

    const mNotice = p.match(/^\/notices\/(\d+)$/);
    if (mNotice) {
      const notice = getPublic(db, Number(mNotice[1]));
      if (notice) return html(res, 200, page(notice.title, noticePage(notice), { active: 'notices' }));
      return html(res, 404, page('Not found', notFoundPage(), { active: '' }));
    }

    return html(res, 404, page('Not found', notFoundPage(), { active: '' }));
  } catch (err) {
    console.error('mercy-clinic: request failed', err instanceof Error ? err.message : err); // never the flag
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      return html(res, 500, page('Something went wrong', errorPage(), { active: '' }));
    }
    if (!res.writableEnded && !res.destroyed) return res.end();
    return undefined;
  }
}).listen(port, '0.0.0.0', () => console.log(`mercy-clinic on :${port} (${level})`));
