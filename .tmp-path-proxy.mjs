// Local-only path-mode proxy for the HVWA range when the player reaches the portal through a single forwarded port.
// Portal stays at /, each lab instance is served at /i/<instanceId>/... (Traefik still sees the instance Host header).
// This is a dev shim for port-forward testing, not part of the POC stack.
import http from 'node:http';

const PORT = Number(process.env.PATH_PROXY_PORT || 18080);
const BIND = process.env.PATH_PROXY_BIND || '127.0.0.1';
const UP_HOST = process.env.PATH_PROXY_UPSTREAM_HOST || '127.0.0.1';
const UP_PORT = Number(process.env.PATH_PROXY_UPSTREAM_PORT || 18090);
const PORTAL_HOST = 'localhost:18080';

function rewriteBody(body, inst) {
  const prefix = `/i/${inst}/`;
  return body
    .replace(/(\b(?:href|src|action)\s*=\s*["'])\/(?!\/)/gi, (_m, a) => a + prefix)
    .replace(/(\bfetch\s*\(\s*["'])\/(?!\/)/gi, (_m, a) => a + prefix)
    .replace(/(\blocation(?:\.href)?\s*=\s*["'])\/(?!\/)/gi, (_m, a) => a + prefix)
    .replace(/(\bnew\s+Image\(\)\s*\.src\s*=\s*["'])\/(?!\/)/gi, (_m, a) => a + prefix);
}

const server = http.createServer((req, res) => {
  const raw = req.url || '/';
  const m = /^\/i\/([a-z0-9]+)(\/.*)?$/.exec(raw);
  const inst = m?.[1];
  const upstreamPath = inst ? (m[2] || '/') : raw;
  const host = inst ? `i-${inst}.localhost:18080` : PORTAL_HOST;
  const headers = { ...req.headers, host, 'accept-encoding': 'identity' };

  const upstream = http.request({ host: UP_HOST, port: UP_PORT, path: upstreamPath, method: req.method, headers }, (up) => {
    // Location: portal's Open-lab 303 -> /i/<id>/...; lab-internal redirects -> keep the prefix.
    const loc = up.headers.location;
    if (loc) {
      const im = /^http:\/\/i-([a-z0-9]+)\.localhost:18080(\/.*)?$/.exec(loc);
      if (im) up.headers.location = `/i/${im[1]}${im[2] || '/'}`;
      else if (inst && loc.startsWith('/')) up.headers.location = `/i/${inst}${loc}`;
    }

    // Lab cookies must stay inside the path prefix.
    if (inst && up.headers['set-cookie']) {
      up.headers['set-cookie'] = up.headers['set-cookie'].map((c) => {
        let s = c.replace(/;\s*Domain=[^;]*/gi, '');
        if (/;\s*Path=/i.test(s)) s = s.replace(/;\s*Path=[^;]*/i, `; Path=/i/${inst}/`);
        else s += `; Path=/i/${inst}/`;
        return s;
      });
    }

    const ct = String(up.headers['content-type'] || '');
    const rewrite = Boolean(inst) && /text\/html|application\/javascript|text\/javascript|text\/plain|text\/css/i.test(ct);
    const outHeaders = { ...up.headers };
    if (!rewrite) {
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
      return;
    }
    const chunks = [];
    up.on('data', (d) => chunks.push(d));
    up.on('end', () => {
      const body = Buffer.from(rewriteBody(Buffer.concat(chunks).toString('utf8'), inst), 'utf8');
      delete outHeaders['content-encoding'];
      outHeaders['content-length'] = String(body.length);
      res.writeHead(up.statusCode || 502, outHeaders);
      res.end(body);
    });
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('path proxy: upstream unavailable');
  });
  req.pipe(upstream);
});

server.listen(PORT, BIND, () => {
  console.log(`path proxy on http://localhost:${PORT} -> ${UP_HOST}:${UP_PORT} (labs at /i/<instanceId>/)`);
});
