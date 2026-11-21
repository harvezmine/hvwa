// src/range/warden-client.ts — the portal's client for the warden API (src/warden/server.ts): HTTP on the internal
// control network, `Authorization: Bearer <HVWA_WARDEN_SECRET>`. Every failure is a WardenError with a closed code;
// answers are validated (src/warden/protocol.ts), so a confused warden can never put odd data into the records.
import {
  instanceHealthSchema, listResponseSchema, WARDEN_ERROR_CODES, WardenError,
  type InstanceHealth, type LaunchRequest, type ListedInstance, type WardenApi, type WardenErrorCode,
} from '../warden/protocol.js';

export interface WardenClientOptions {
  /** HVWA_WARDEN_URL, e.g. http://warden:8080. */
  readonly baseUrl: string;
  /** HVWA_WARDEN_SECRET. */
  readonly secret: string;
  readonly timeoutMs?: number;
}

const isCode = (x: unknown): x is WardenErrorCode => typeof x === 'string' && (WARDEN_ERROR_CODES as readonly string[]).includes(x);

export function createWardenClient(opts: WardenClientOptions): WardenApi {
  const root = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${root}${path}`, {
        method, signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${opts.secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new WardenError('unavailable', 0);
    }
    const text = await res.text().catch(() => '');
    let json: unknown;
    try { json = text === '' ? undefined : JSON.parse(text); } catch { json = undefined; }
    if (res.ok) return json;
    const code = (json as { error?: unknown } | undefined)?.error;
    throw new WardenError(isCode(code) ? code : res.status === 401 ? 'unauthorized' : 'unavailable', res.status);
  }

  return Object.freeze({
    async launch(req: LaunchRequest) { await call('POST', '/v1/instances', req); },
    async stop(instanceId: string) { await call('DELETE', `/v1/instances/${enc(instanceId)}`); },
    async list(): Promise<ListedInstance[]> {
      const r = listResponseSchema.safeParse(await call('GET', '/v1/instances'));
      if (!r.success) throw new WardenError('unavailable', 200);
      return r.data.instances;
    },
    async health(instanceId: string): Promise<InstanceHealth> {
      const r = instanceHealthSchema.safeParse(await call('GET', `/v1/instances/${enc(instanceId)}/health`));
      if (!r.success) throw new WardenError('unavailable', 200);
      return r.data;
    },
  });
}
