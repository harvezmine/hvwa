// labs/r02-courier/app/pages.mjs — the Courier portal's pages. Everything shown is seeded, read-only customer data;
// private delivery notes are intentionally absent from every browsing page (they appear only on the label route, which
// requires a session). All interpolated values are escaped by the helpers in render.mjs.
import { esc, page, parcelCard, statusChip, progress, timeline, barcode } from './render.mjs';

const ICONS = {
  route: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 18c4 0 4-12 8-12s4 12 8 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="1 4"/><circle cx="4" cy="18" r="2" fill="currentColor"/><circle cx="20" cy="18" r="2" fill="currentColor"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  bell: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M10 20a2 2 0 0 0 4 0" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
};

const HERO_ROUTE = `<svg class="route-svg" viewBox="0 0 420 190" role="img" aria-label="A parcel route from the depot to a front door">`
  + `<path d="M36 138 C 100 138, 104 56, 186 56 S 292 134, 384 134" fill="none" stroke="#e6ded3" stroke-width="7" stroke-linecap="round"/>`
  + `<path d="M36 138 C 100 138, 104 56, 186 56 S 292 134, 384 134" fill="none" stroke="#f26a2e" stroke-width="3" stroke-dasharray="2 11" stroke-linecap="round"/>`
  + `<circle cx="36" cy="138" r="9" fill="#fff" stroke="#0d1b2f" stroke-width="4"/>`
  + `<text x="36" y="168" text-anchor="middle">Depot</text>`
  + `<circle cx="384" cy="134" r="9" fill="#fff" stroke="#0d1b2f" stroke-width="4"/>`
  + `<text x="384" y="164" text-anchor="middle">Door</text>`
  + `<g class="van"><circle cx="262" cy="88" r="16" fill="#f26a2e"/><path d="M254 82h9v8h-9z" fill="#fff"/><path d="M263 82h4l4 5v3h-8z" fill="#fff" opacity=".8"/></g>`
  + `<text x="150" y="30" text-anchor="middle">3.2 km to go</text>`
  + `</svg>`;

function heroVisual() {
  return `<div class="hero-visual">`
    + `<div class="hv-top"><span class="chip out"><span class="chip-dot" aria-hidden="true"></span>Out for delivery</span><span class="mono fineprint">CR-2001</span></div>`
    + HERO_ROUTE
    + `<div class="hv-bottom"><div><span>Estimated arrival</span><b>Today, 14:00–16:00</b></div>`
    + `<div><span>Driver</span><b>Sam · Van 12</b></div></div>`
    + `</div>`;
}

export function landingPage() {
  return page('Parcel tracking', `
<section class="hero">
  <div>
    <span class="eyebrow"><span class="dot" aria-hidden="true"></span>Live parcel network</span>
    <h1>Every parcel.<br><span>Every step.</span></h1>
    <p class="lede">Follow collections, line-haul and last-mile delivery in one calm place. Courier gives you the same view our drivers have — from the first depot scan to the knock at the door.</p>
    <div class="actions">
      <a class="btn" href="/dashboard">Continue as demo</a>
      <a class="btn ghost" href="/track">Track a parcel</a>
    </div>
    <p class="fineprint">Demo sign-in: no password or card needed. You will browse as a sample customer, and nothing you do here is saved. <a href="/signin">How demo sign-in works</a>.</p>
  </div>
  ${heroVisual()}
</section>
<section class="stats" aria-label="Courier at a glance">
  <div class="stat"><b>99.1%</b><span>On-time delivery</span></div>
  <div class="stat"><b>48 h</b><span>Typical express transit</span></div>
  <div class="stat"><b>340+</b><span>Depots and hubs</span></div>
  <div class="stat"><b>Live</b><span>Scan updates</span></div>
</section>
<section aria-labelledby="why">
  <h2 id="why" class="eyebrow">Why Courier</h2>
  <div class="features">
    <article class="feature"><div class="icon">${ICONS.route}</div><h3>A route you can read</h3><p>Depot, line-haul and final-mile scans are drawn as one simple timeline, without the jargon.</p></article>
    <article class="feature"><div class="icon">${ICONS.bell}</div><h3>Arrival windows that hold</h3><p>See the ETA before you leave the house, then watch it tighten as the van gets closer.</p></article>
    <article class="feature"><div class="icon">${ICONS.lock}</div><h3>Notes that stay private</h3><p>Delivery instructions are visible to you and your courier — never on a public tracking page.</p></article>
  </div>
</section>
<section class="privacy">
  <div><h2>Delivery notes are private</h2><p>Gate codes, concierge instructions and safe-place requests are attached to your parcel, not to a public tracking number. Only the signed-in customer and the assigned courier can read them.</p></div>
  <span class="lock" aria-hidden="true">${ICONS.lock}</span>
</section>`, { active: '/' });
}

export function dashboardPage(parcels) {
  const active = parcels.filter((p) => String(p.status).toLowerCase() !== 'delivered').length;
  const cards = parcels.map(parcelCard).join('');
  return page('Dashboard', `
<div class="page-head">
  <div>
    <span class="eyebrow">Customer portal</span>
    <h1>Welcome back, Demo</h1>
    <p>${parcels.length} parcels on this account · ${active} still on the move.</p>
  </div>
  <div class="sync" aria-live="polite"><span class="sync-dot" aria-hidden="true"></span><span id="sync-text">Synced just now</span></div>
</div>
<div class="parcel-grid">${cards}</div>
<p class="fineprint" style="margin-top:18px">Delivery notes are private to you and your courier. Use <b>Print label</b> to see the label and its handling instructions, or <b>Track</b> for the full scan history.</p>
<script>
(function () {
  var label = document.getElementById('sync-text');
  var token = null; // one session for this page's lifetime: no token churn in the bounded server store
  function say(t) { if (label) label.textContent = t; }
  async function refresh() {
    try {
      if (!token) {
        var s = await fetch('/api/session', { method: 'POST' });
        if (!s.ok) throw new Error('session');
        token = (await s.json()).token;
      }
      var r = await fetch('/api/parcels', { headers: { authorization: 'Bearer ' + token } });
      if (r.status === 401) { token = null; throw new Error('session'); }
      if (!r.ok) throw new Error('parcels');
      var data = await r.json();
      (data.parcels || []).forEach(function (p) {
        var card = document.querySelector('[data-parcel="' + p.id + '"]');
        if (!card) return;
        var chip = card.querySelector('.chip');
        if (chip && p.status) {
          chip.className = 'chip ' + (/delivered/i.test(p.status) ? 'delivered' : /out for delivery/i.test(p.status) ? 'out' : /in transit/i.test(p.status) ? 'transit' : /held|depot/i.test(p.status) ? 'held' : 'booked');
          chip.textContent = '';
          var dot = document.createElement('span');
          dot.className = 'chip-dot';
          dot.setAttribute('aria-hidden', 'true');
          chip.appendChild(dot);
          chip.appendChild(document.createTextNode(' ' + p.status));
        }
        var eta = card.querySelector('[data-eta]');
        if (eta && p.eta) eta.textContent = p.eta;
      });
      say('Synced just now');
    } catch (e) {
      say('Offline — retrying');
    }
    window.setTimeout(refresh, 20000);
  }
  window.setTimeout(refresh, 900);
})();
</script>`, { active: '/dashboard' });
}

export function trackPage({ parcel, mine, query }) {
  if (parcel) {
    return page('Tracking', `
<div class="page-head">
  <div>
    <span class="eyebrow">Tracking ${esc(parcel.id)}</span>
    <h1>${esc(parcel.status)}</h1>
    <p>${esc(parcel.to)} · ${esc(parcel.service ?? 'Courier Standard')}</p>
  </div>
  ${statusChip(parcel.status)}
</div>
<div class="grid-2">
  <section class="panel">
    <h2>Route progress</h2>
    ${progress(parcel.status)}
    <div class="meta" style="margin-top:16px">
      <div><span>From</span><b>${esc(parcel.from ?? 'Courier network')}</b></div>
      <div><span>Weight</span><b>${esc(parcel.weight ?? '—')}</b></div>
      <div><span>ETA</span><b>${esc(parcel.eta ?? '—')}</b></div>
    </div>
    <div class="pc-actions" style="margin-top:18px">
      <a class="btn small" href="/api/parcels/${parcel.id}/label" target="_blank" rel="noopener">Print label</a>
      <a class="btn small ghost" href="/dashboard">All parcels</a>
    </div>
  </section>
  <section class="panel">
    <h2>Scan history</h2>
    ${timeline(parcel.events)}
    <p class="fineprint" style="margin-top:14px">Delivery notes are private; they are printed on your label rather than shown on the public tracking view.</p>
  </section>
</div>`, { active: '/track' });
  }
  const quick = mine.slice(0, 6).map((p) =>
    `<a class="btn small ghost" href="/track?id=${p.id}">${p.id} · ${esc(p.status)}</a>`).join('');
  return page('Track a parcel', `
<div class="page-head">
  <div>
    <span class="eyebrow">Track</span>
    <h1>Where is your parcel?</h1>
    <p>Enter a tracking number from your account to see its route and scan history.</p>
  </div>
</div>
<div class="grid-2">
  <section class="panel">
    <h2>Find a parcel</h2>
    <form class="track-form" action="/track" method="get">
      <label class="skip" for="tracking-id">Tracking number</label>
      <input id="tracking-id" name="id" inputmode="numeric" autocomplete="off" placeholder="e.g. 2001" value="${esc(query)}">
      <button class="btn" type="submit">Track</button>
    </form>
    <p class="fineprint">${query ? 'No parcel with that number is on this demo account.' : 'Only parcels belonging to the signed-in demo account are shown.'}</p>
  </section>
  <section class="panel">
    <h2>Your recent parcels</h2>
    <p class="fineprint">Jump straight to a parcel on this account:</p>
    <div class="pc-actions">${quick || '<span class="fineprint">No parcels yet.</span>'}</div>
  </section>
</div>`, { active: '/track' });
}

export function accountPage() {
  return page('Account', `
<div class="page-head">
  <div>
    <span class="eyebrow">Account</span>
    <h1>Demo Customer</h1>
    <p>Sample profile for the Courier demonstration environment.</p>
  </div>
  <span class="chip delivered"><span class="chip-dot" aria-hidden="true"></span>Demo account</span>
</div>
<div class="grid-2">
  <section class="panel">
    <h2>Profile</h2>
    <div class="rows">
      <div class="row"><span>Name</span><b>Demo Customer</b></div>
      <div class="row"><span>Email</span><b>demo@courier.example</b></div>
      <div class="row"><span>Delivery address</span><b>A. Demo, 14 Harbour Row</b></div>
      <div class="row"><span>Member since</span><b>March 2024</b></div>
      <div class="row"><span>Account number</span><b class="mono">CR-DEMO-2001</b></div>
    </div>
  </section>
  <section class="panel">
    <h2>Delivery preferences</h2>
    <div class="preference"><span>Leave with a neighbour</span><span class="toggle" aria-hidden="true"></span></div>
    <div class="preference"><span>Use the parcel locker</span><span class="toggle" aria-hidden="true"></span></div>
    <div class="preference"><span>Ring the doorbell</span><span class="toggle" aria-hidden="true"></span></div>
    <p class="fineprint" style="margin-top:14px">Demo profile — these preferences are shown for realism and are not saved.</p>
  </section>
</div>
<section class="panel" style="margin-top:16px">
  <h2>Sign-in explanation</h2>
  <p>Courier normally signs customers in with an email link. This demonstration skips that step: <b>Continue as demo</b> issues a temporary sample session so you can browse the portal immediately.</p>
  <p class="fineprint">No authentication flaw is part of this demonstration — every visitor is simply the same sample customer.</p>
  <div class="pc-actions"><a class="btn" href="/dashboard">Open demo dashboard</a><a class="btn ghost" href="/support">Get help</a></div>
</section>`, { active: '/account' });
}

export function supportPage() {
  return page('Support', `
<div class="page-head">
  <div>
    <span class="eyebrow">Support</span>
    <h1>We are on the route with you</h1>
    <p>Answers for parcels, labels and delivery notes — day or night.</p>
  </div>
</div>
<div class="grid-3">
  <section class="panel"><h3>Track and trace</h3><p>Check the scan history first; most "where is it?" questions are answered by the latest depot scan.</p><a class="btn small ghost" href="/track">Track a parcel</a></section>
  <section class="panel"><h3>Labels and notes</h3><p>Print a label from any parcel card. Private delivery notes travel with the label, not the public tracker.</p><a class="btn small ghost" href="/dashboard">Open dashboard</a></section>
  <section class="panel"><h3>Talk to a human</h3><p>Our demo support desk is open Monday to Saturday, 07:00–20:00. Average reply: under four minutes.</p><p class="fineprint">support@courier.example · +44 (0)20 7946 0102</p></section>
</div>
<section class="panel" style="margin-top:16px">
  <h2>Common questions</h2>
  <div class="rows">
    <div class="row"><span>My ETA changed. Why?</span><b>Weather, traffic and depot volume can move a window.</b></div>
    <div class="row"><span>Can someone else read my delivery note?</span><b>No — notes are private to your account and the courier.</b></div>
    <div class="row"><span>How do I rebook a delivery?</span><b>Reply to your dispatch email; demo changes are not saved.</b></div>
  </div>
</section>`, { active: '/support' });
}

export function pricingPage() {
  return page('Pricing', `
<div class="page-head">
  <div>
    <span class="eyebrow">Pricing</span>
    <h1>Simple service levels</h1>
    <p>Pay for the speed you need. Every tier includes live tracking and private delivery notes.</p>
  </div>
</div>
<div class="pricing">
  <section class="tier">
    <h2>Standard</h2><div class="price">£4.95<small> / parcel</small></div>
    <ul><li>2–3 working days</li><li>Depot and delivery scans</li><li>Private delivery notes</li><li>Email arrival window</li></ul>
    <a class="btn ghost" href="/dashboard">Continue as demo</a>
  </section>
  <section class="tier featured"><span class="flag">Most popular</span>
    <h2>Express</h2><div class="price">£8.50<small> / parcel</small></div>
    <ul><li>Next working day</li><li>Live van progress</li><li>Tighter 2-hour windows</li><li>Priority support</li></ul>
    <a class="btn" href="/dashboard">Continue as demo</a>
  </section>
  <section class="tier">
    <h2>Freight</h2><div class="price">Custom</div>
    <ul><li>Pallet and oversize</li><li>Dedicated account desk</li><li>Cold-chain options</li><li>Signed chain of custody</li></ul>
    <a class="btn ghost" href="/support">Talk to sales</a>
  </section>
</div>
<p class="fineprint" style="margin-top:18px">Demonstration pricing only. No payment is taken and no real shipment is created.</p>`, { active: '/pricing' });
}

export function faqPage() {
  const items = [
    ['Are delivery notes public?', 'No. A note is attached to the parcel record and is visible only to the signed-in customer and the assigned courier. Public tracking shows status, route and ETA — never the note.'],
    ['How do I print a label?', 'Open the dashboard and choose Print label on any parcel card. The label page includes the address, service details, a scannable barcode block and the private note.'],
    ['What do the statuses mean?', 'Booked: the parcel is registered. At depot: it has been scanned in. In transit: it is moving between hubs. Out for delivery: it is on the final-mile van. Delivered: the courier has completed the route.'],
    ['Can I change my delivery address?', 'In the live product you would contact support before the final-mile scan. This demo is read-only, so address changes are not saved.'],
    ['How do I become a demo customer?', 'Choose Continue as demo anywhere on the site. You will be signed in to a sample account with a handful of seeded parcels.'],
  ];
  const body = items.map(([q, a]) => `<details class="faq"><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('');
  return page('FAQ', `
<div class="page-head"><div><span class="eyebrow">FAQ</span><h1>Questions, answered</h1><p>The short version of how Courier works.</p></div></div>
${body}
<p class="fineprint" style="margin-top:18px">Still stuck? <a href="/support">Contact support</a>.</p>`, { active: '/support' });
}

export function signinPage() {
  return page('Sign in', `
<div class="grid-2">
  <section class="panel">
    <span class="eyebrow">Sign in</span>
    <h1 style="margin:8px 0 10px">Welcome to Courier</h1>
    <p>In production, customers sign in with a secure email link. For this demonstration there is no password to find and no account to create.</p>
    <div class="actions"><a class="btn" href="/dashboard">Continue as demo</a><a class="btn ghost" href="/">Back to home</a></div>
    <p class="fineprint">Continuing as demo issues a temporary session for a sample customer. Sessions are held in memory and disappear when the lab restarts.</p>
  </section>
  <section class="panel">
    <h2>What you can do as demo</h2>
    <div class="rows">
      <div class="row"><span>Track parcels</span><b>Seven seeded deliveries</b></div>
      <div class="row"><span>Print labels</span><b>With private notes</b></div>
      <div class="row"><span>Review the route</span><b>Depot to door</b></div>
      <div class="row"><span>Change preferences</span><b>Read-only in the demo</b></div>
    </div>
  </section>
</div>`, { active: '/account' });
}

export function notFoundPage() {
  return page('Not found', `
<div class="empty-state">
  <div class="big">404</div>
  <h1>This route has gone off-road</h1>
  <p>The page or parcel you asked for is not here. Check the tracking number or head back to your dashboard.</p>
  <div class="pc-actions" style="justify-content:center">
    <a class="btn" href="/dashboard">Open dashboard</a>
    <a class="btn ghost" href="/track">Track a parcel</a>
  </div>
</div>`, { active: '' });
}

export function serverErrorPage() {
  return page('Something went wrong', `
<div class="empty-state">
  <div class="big">500</div>
  <h1>The depot lost the paperwork</h1>
  <p>Something failed on our side; the parcel data is safe. Try again, or return to the dashboard.</p>
  <div class="pc-actions" style="justify-content:center">
    <a class="btn" href="/dashboard">Open dashboard</a>
    <a class="btn ghost" href="/">Back to home</a>
  </div>
</div>`, { active: '' });
}
