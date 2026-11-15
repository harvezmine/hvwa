// tests/support/supertest.ts — the `supertest` every spec gets (vitest.config.ts aliases the bare
// 'supertest' import here). supertest(app) with an Express app starts a NEW ephemeral server for
// EVERY request, and superagent opens a fresh connection each time: thousands of sockets in
// TIME_WAIT, and concurrent runs exhaust the ephemeral ports (EADDRINUSE). Here every app listens
// on ONE server for its lifetime and every request reuses its keep-alive sockets.
// Rule: never import the real supertest in a spec (tests/tooling.spec.ts guards it).
import http from 'node:http';
import { createRequire } from 'node:module';
import { afterAll, onTestFinished } from 'vitest';

type Supertest = typeof import('supertest');
const real = createRequire(import.meta.url)('supertest') as Supertest;

interface Served { readonly server: http.Server; readonly agent: http.Agent; readonly close: () => void }
const byApp = new WeakMap<object, Served>();
const live = new Set<() => void>();

function closeServed(app: object, s: Served): void {
  if (byApp.get(app) === s) byApp.delete(app);
  live.delete(s.close);
  s.agent.destroy();
  s.server.closeAllConnections();
  s.server.close();
}

/**
 * The one listening http.Server for an Express app (or request handler): created on first use,
 * reused after, closed when the current test finishes (or at the end of the file when first used
 * outside a test, e.g. in beforeAll). A closed app is re-served on its next use.
 */
export function serve(app: http.RequestListener): http.Server {
  return serveWithAgent(app).server;
}

function serveWithAgent(app: http.RequestListener): Served {
  const known = byApp.get(app);
  if (known) return known;
  const server = http.createServer(app);
  server.keepAliveTimeout = 60_000;
  const s: Served = {
    server, agent: new http.Agent({ keepAlive: true }), close: () => { closeServed(app, s); },
  };
  const close = s.close;
  byApp.set(app, s);
  live.add(close);
  // No host: that binds synchronously, so server.address() is set at once (supertest reads it).
  server.listen(0);
  try { onTestFinished(close); } catch { /* not inside a test: the file-level afterAll closes it */ }
  return s;
}

afterAll(() => { for (const close of [...live]) close(); });

function target(x: unknown): { server: http.Server; agent: http.Agent } {
  if (typeof x === 'function') {
    const s = serveWithAgent(x as http.RequestListener);
    return { server: s.server, agent: s.agent };
  }
  return { server: x as http.Server, agent: sharedAgent };
}
const sharedAgent = new http.Agent({ keepAlive: true });

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options'] as const;

function request(x: Parameters<Supertest>[0]): ReturnType<Supertest> {
  const { server, agent } = target(x);
  const inner = real(server) as unknown as Record<string, (...a: unknown[]) => { agent(a: http.Agent): unknown }>;
  const out: Record<string, unknown> = {};
  for (const m of METHODS) out[m] = (...a: unknown[]) => inner[m](...a).agent(agent);
  return out as unknown as ReturnType<Supertest>;
}

request.agent = ((x: Parameters<Supertest['agent']>[0], options?: Parameters<Supertest['agent']>[1]) => {
  const { server, agent } = target(x);
  const ta = real.agent(server, options) as unknown as Record<string, (...a: unknown[]) => { agent(a: http.Agent): unknown }>;
  for (const m of METHODS) {
    const orig = ta[m].bind(ta);
    ta[m] = (...a: unknown[]) => orig(...a).agent(agent) as { agent(a: http.Agent): unknown };
  }
  return ta;
}) as unknown as Supertest['agent'];

export default request as unknown as Supertest;
