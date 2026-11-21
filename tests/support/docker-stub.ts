// tests/support/docker-stub.ts — a stub Docker Engine API over real HTTP, in memory: just the endpoints the warden calls
// (/_ping, containers and networks under /v1.44), answering with the Engine's status codes and JSON shapes. It records
// every call; anything it does not model gets 404 and is recorded in `unexpected`, so a spec can prove the warden never
// touches images, exec, volumes, swarm or system endpoints. No Docker needed.
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

export const STUB_API = '/v1.44';
export interface StubCall { readonly method: string; readonly path: string; readonly body: unknown }
export type StubHealth = 'starting' | 'healthy' | 'unhealthy';
export interface StubContainer {
  readonly id: string;
  readonly name: string;
  readonly body: Record<string, unknown>;
  status: 'created' | 'running' | 'exited';
  exitCode: number;
  oom: boolean;
  health: StubHealth | undefined;
  readonly networks: Set<string>;
}
export interface StubNetwork { readonly id: string; readonly name: string; readonly body: Record<string, unknown>; readonly containers: Set<string> }

export interface DockerStub {
  readonly url: string;
  readonly calls: StubCall[];
  readonly unexpected: StubCall[];
  /** Images present on the "host": reference -> whether the image declares a HEALTHCHECK. */
  readonly images: Map<string, { healthcheck: boolean }>;
  container(nameOrId: string): StubContainer | undefined;
  containers(): StubContainer[];
  network(nameOrId: string): StubNetwork | undefined;
  networks(): StubNetwork[];
  setHealth(name: string, health: StubHealth | undefined): void;
  exit(name: string, code: number, oom?: boolean): void;
  /** The next request matching `method` and the path regex answers `status` (once). */
  failNext(method: string, path: RegExp, status: number): void;
  /** A container that exists without the warden (Traefik, an orphan). */
  addContainer(name: string, labels?: Record<string, string>, status?: 'running' | 'exited'): void;
  close(): Promise<void>;
}

export async function startDockerStub(): Promise<DockerStub> {
  const calls: StubCall[] = [];
  const unexpected: StubCall[] = [];
  const images = new Map<string, { healthcheck: boolean }>();
  const containers = new Map<string, StubContainer>();
  const networks = new Map<string, StubNetwork>();
  const failures: { method: string; path: RegExp; status: number }[] = [];
  let seq = 0;
  const newId = () => (++seq).toString(16).padStart(64, '0');
  const findC = (k: string) => containers.get(k) ?? [...containers.values()].find((c) => c.id === k);
  const findN = (k: string) => networks.get(k) ?? [...networks.values()].find((n) => n.id === k);

  function addContainer(name: string, labels: Record<string, string> = {}, status: 'running' | 'exited' = 'running'): void {
    containers.set(name, {
      id: newId(), name, body: { Image: 'stub', Labels: labels, HostConfig: {} }, status, exitCode: 0, oom: false, health: undefined, networks: new Set(),
    });
  }

  function inspect(c: StubContainer) {
    return {
      Id: c.id, Name: `/${c.name}`,
      State: { Status: c.status, Running: c.status === 'running', ExitCode: c.exitCode, OOMKilled: c.oom, ...(c.health ? { Health: { Status: c.health } } : {}) },
      Config: { Image: c.body.Image, User: c.body.User, Env: c.body.Env, Labels: c.body.Labels ?? {}, Healthcheck: c.body.Healthcheck },
      HostConfig: c.body.HostConfig ?? {},
      NetworkSettings: { Networks: Object.fromEntries([...c.networks].map((n) => [n, {}])) },
    };
  }

  /** [status, payload]; null payload = no body; undefined = not modelled. */
  function handle(method: string, url: URL, body: unknown): [number, unknown] | undefined {
    const p = url.pathname;
    if (method === 'GET' && p === '/_ping') return [200, 'OK'];
    if (!p.startsWith(`${STUB_API}/`)) return undefined;
    const rest = p.slice(STUB_API.length);
    const b = (body ?? {}) as Record<string, unknown>;
    let m: RegExpExecArray | null;
    if (method === 'POST' && rest === '/networks/create') {
      const name = String(b.Name ?? '');
      if (networks.has(name)) return [409, { message: `network with name ${name} already exists` }];
      const n: StubNetwork = { id: newId(), name, body: b, containers: new Set() };
      networks.set(name, n);
      return [201, { Id: n.id, Warning: '' }];
    }
    if (method === 'POST' && (m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(rest))) {
      const n = findN(decodeURIComponent(m[1]));
      const c = findC(String(b.Container ?? ''));
      if (!n || !c) return [404, { message: 'No such network or container' }];
      if (m[2] === 'connect') { n.containers.add(c.name); c.networks.add(n.name); return [200, null]; }
      if (!n.containers.has(c.name)) return [404, { message: `container ${c.name} is not connected to network ${n.name}` }];
      n.containers.delete(c.name);
      c.networks.delete(n.name);
      return [200, null];
    }
    if (method === 'DELETE' && (m = /^\/networks\/([^/]+)$/.exec(rest))) {
      const n = findN(decodeURIComponent(m[1]));
      if (!n) return [404, { message: 'network not found' }];
      if (n.containers.size > 0) return [403, { message: `error while removing network: network ${n.name} has active endpoints` }];
      networks.delete(n.name);
      return [204, null];
    }
    if (method === 'POST' && rest === '/containers/create') {
      const name = url.searchParams.get('name') ?? '';
      if (containers.has(name)) return [409, { message: `Conflict. The container name "/${name}" is already in use` }];
      if (!images.has(String(b.Image ?? ''))) return [404, { message: `No such image: ${String(b.Image)}` }];
      const net = findN(String(((b.HostConfig ?? {}) as Record<string, unknown>).NetworkMode ?? ''));
      if (!net) return [404, { message: 'network not found' }];
      const c: StubContainer = { id: newId(), name, body: b, status: 'created', exitCode: 0, oom: false, health: undefined, networks: new Set([net.name]) };
      net.containers.add(name);
      containers.set(name, c);
      return [201, { Id: c.id, Warnings: [] }];
    }
    if (method === 'POST' && (m = /^\/containers\/([^/]+)\/start$/.exec(rest))) {
      const c = findC(decodeURIComponent(m[1]));
      if (!c) return [404, { message: 'No such container' }];
      if (c.status === 'running') return [304, null];
      c.status = 'running';
      c.health = images.get(String(c.body.Image))?.healthcheck ? 'starting' : undefined;
      return [204, null];
    }
    if (method === 'GET' && (m = /^\/containers\/([^/]+)\/json$/.exec(rest))) {
      const c = findC(decodeURIComponent(m[1]));
      return c ? [200, inspect(c)] : [404, { message: 'No such container' }];
    }
    if (method === 'DELETE' && (m = /^\/containers\/([^/]+)$/.exec(rest))) {
      const c = findC(decodeURIComponent(m[1]));
      if (!c) return [404, { message: 'No such container' }];
      for (const n of c.networks) networks.get(n)?.containers.delete(c.name);
      containers.delete(c.name);
      return [204, null];
    }
    if (method === 'GET' && rest === '/containers/json') {
      const filters = JSON.parse(url.searchParams.get('filters') ?? '{}') as { label?: string[] };
      const wanted = (filters.label ?? []).map((l) => l.split('='));
      const all = url.searchParams.get('all') === 'true';
      const list = [...containers.values()].filter((c) => {
        const labels = (c.body.Labels ?? {}) as Record<string, string>;
        return (all || c.status === 'running') && wanted.every(([k, v]) => (v === undefined ? k in labels : labels[k] === v));
      });
      return [200, list.map((c) => ({ Id: c.id, Names: [`/${c.name}`], Labels: c.body.Labels ?? {}, State: c.status, Status: c.status }))];
    }
    return undefined;
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8').on('data', (d: string) => { raw += d; }).on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stub');
      let body: unknown;
      try { body = raw === '' ? undefined : JSON.parse(raw); } catch { body = raw; }
      const call: StubCall = { method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, body };
      calls.push(call);
      const f = failures.findIndex((x) => x.method === call.method && x.path.test(url.pathname));
      let out: [number, unknown] | undefined;
      if (f >= 0) {
        const [fail] = failures.splice(f, 1);
        out = [fail.status, { message: `stub failure ${fail.status}` }];
      } else {
        out = handle(call.method, url, body);
      }
      if (out === undefined) { unexpected.push(call); out = [404, { message: 'page not found' }]; }
      const [status, payload] = out;
      if (payload === null) { res.writeHead(status).end(); return; }
      if (typeof payload === 'string') { res.writeHead(status, { 'content-type': 'text/plain' }).end(payload); return; }
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`, calls, unexpected, images,
    container: findC, containers: () => [...containers.values()],
    network: findN, networks: () => [...networks.values()],
    setHealth(name, health) { const c = findC(name); if (c) c.health = health; },
    exit(name, code, oom = false) { const c = findC(name); if (c) { c.status = 'exited'; c.exitCode = code; c.oom = oom; c.health = undefined; } },
    failNext(method, path, status) { failures.push({ method, path, status }); },
    addContainer,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
