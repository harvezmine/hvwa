// src/warden/docker.ts — the warden's Docker Engine API client: plain HTTP to the write-limited socket proxy
// (tecnativa/docker-socket-proxy with CONTAINERS=1, NETWORKS=1, POST=1 and every other section off). Only container and
// network endpoints, versioned /v1.44 (Engine 25+; Engine 29 refuses anything older). Never images, exec, volumes,
// swarm or system: the proxy refuses them too, and tests/warden-ops.spec.ts proves the warden never asks.
export const DOCKER_API = '/v1.44';

export class DockerError extends Error {
  constructor(readonly status: number, readonly path: string, message: string) {
    super(`docker ${status} ${path}: ${message}`);
    this.name = 'DockerError';
  }
}

export interface ContainerInspect {
  readonly Id: string;
  readonly Name: string;
  readonly State: {
    readonly Status: string; readonly Running: boolean; readonly ExitCode: number; readonly OOMKilled: boolean;
    readonly Health?: { readonly Status: string };
  };
  readonly Config: { readonly Image: string; readonly Labels: Record<string, string> | null };
  readonly HostConfig: Record<string, unknown>;
}

export interface ContainerSummary {
  readonly Id: string;
  readonly Names: readonly string[];
  readonly Labels: Record<string, string>;
  readonly State: string;
}

export interface DockerClient {
  ping(): Promise<void>;
  createNetwork(body: object): Promise<string>;
  removeNetwork(nameOrId: string): Promise<void>;
  connectNetwork(network: string, container: string): Promise<void>;
  disconnectNetwork(network: string, container: string): Promise<void>;
  createContainer(name: string, body: object): Promise<string>;
  startContainer(nameOrId: string): Promise<void>;
  removeContainer(nameOrId: string): Promise<void>;
  inspectContainer(nameOrId: string): Promise<ContainerInspect | undefined>;
  listContainers(label: string): Promise<ContainerSummary[]>;
}

export function createDockerClient(baseUrl: string, opts: { timeoutMs?: number } = {}): DockerClient {
  const root = baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body: object | undefined, ok: readonly number[]): Promise<{ status: number; json: unknown }> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw new DockerError(0, path, err instanceof Error ? err.message : String(err));
    }
    const text = await res.text();
    let json: unknown;
    try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
    if (!ok.includes(res.status)) {
      const message = (json as { message?: unknown } | undefined)?.message;
      throw new DockerError(res.status, path, typeof message === 'string' ? message : text.slice(0, 200));
    }
    return { status: res.status, json };
  }

  const idOf = (path: string, json: unknown): string => {
    const id = (json as { Id?: unknown } | undefined)?.Id;
    if (typeof id !== 'string') throw new DockerError(500, path, 'no Id in the answer');
    return id;
  };

  return Object.freeze({
    async ping() { await call('GET', '/_ping', undefined, [200]); },
    async createNetwork(body: object) {
      const path = `${DOCKER_API}/networks/create`;
      return idOf(path, (await call('POST', path, body, [201])).json);
    },
    async removeNetwork(name: string) { await call('DELETE', `${DOCKER_API}/networks/${enc(name)}`, undefined, [204, 404]); },
    async connectNetwork(network: string, container: string) {
      await call('POST', `${DOCKER_API}/networks/${enc(network)}/connect`, { Container: container }, [200]);
    },
    async disconnectNetwork(network: string, container: string) {
      await call('POST', `${DOCKER_API}/networks/${enc(network)}/disconnect`, { Container: container, Force: true }, [200, 404]);
    },
    async createContainer(name: string, body: object) {
      const path = `${DOCKER_API}/containers/create?name=${enc(name)}`;
      return idOf(path, (await call('POST', path, body, [201])).json);
    },
    async startContainer(name: string) { await call('POST', `${DOCKER_API}/containers/${enc(name)}/start`, undefined, [204, 304]); },
    async removeContainer(name: string) { await call('DELETE', `${DOCKER_API}/containers/${enc(name)}?force=true&v=true`, undefined, [204, 404]); },
    async inspectContainer(name: string) {
      const r = await call('GET', `${DOCKER_API}/containers/${enc(name)}/json`, undefined, [200, 404]);
      return r.status === 404 ? undefined : r.json as ContainerInspect;
    },
    async listContainers(label: string) {
      const filters = enc(JSON.stringify({ label: [label] }));
      return (await call('GET', `${DOCKER_API}/containers/json?all=true&filters=${filters}`, undefined, [200])).json as ContainerSummary[];
    },
  });
}
