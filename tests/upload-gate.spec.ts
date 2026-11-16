// uploadGate() over real sockets: a stalled body is answered 408 and frees its slot; a request beyond the slots is
// answered 503 while its body is still streaming (the gate never reads or buffers it).
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { describe, it, expect, vi } from 'vitest';
import { UPLOADS_IN_FLIGHT, UPLOAD_LIMITS, uploadGate, uploadsInFlight } from '../src/core/upload.js';
import { serve } from './helpers.js';

/** A minimal upload route: the gate, the raw body, then an answer. `reached` counts requests the gate let through. */
async function uploadServer(bodyTimeoutMs: number) {
  const reached: number[] = [];
  const app = express();
  app.post('/up', uploadGate({ bodyTimeoutMs }), (req, _res, next) => { reached.push(Number(req.headers['x-n'])); next(); },
    express.raw({ type: 'multipart/form-data', limit: UPLOAD_LIMITS.maxBytes }), (req, res) => { res.send(`got ${(req.body as Buffer).length}`); });
  const server = await serve(app);
  return { port: (server.address() as AddressInfo).port, reached };
}

interface Answer { readonly status: number | undefined; readonly headers: IncomingHttpHeaders; readonly body: string }

/** A client that sends its headers (declaring `total` body bytes) and only `sent` of them, then waits. */
function partialUpload(port: number, n: number, total: number, sent: number): { req: ClientRequest; answer: Promise<Answer> } {
  const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/up',
    headers: { 'content-type': 'multipart/form-data; boundary=b', 'content-length': String(total), 'x-n': String(n) } });
  const answer = new Promise<Answer>((resolve, reject) => {
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', reject);
    });
  });
  req.on('error', () => {}); // the server may close the connection under the unsent rest of the body
  req.write(Buffer.alloc(sent, 0x61));
  return { req, answer };
}

describe('uploadGate over real sockets', () => {
  it('a body that stalls is answered 408 after the idle timeout, and its slot comes back', async () => {
    const { port, reached } = await uploadServer(200);
    const t0 = Date.now();
    const { req, answer } = partialUpload(port, 1, 64 * 1024, 1024); // 1 KiB of 64 KiB, then nothing
    const a = await answer;
    expect([a.status, a.body, a.headers.connection]).toEqual([408, 'The upload stalled (no data for 1 s): send it again.', 'close']);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150);
    expect(reached).toEqual([1]);
    await vi.waitFor(() => { expect(uploadsInFlight()).toBe(0); });
    req.destroy();
  });

  it('beyond the slots, the answer is 503 while the body is still streaming: it is never waited for or buffered', async () => {
    const { port, reached } = await uploadServer(10_000);
    const holders = Array.from({ length: UPLOADS_IN_FLIGHT }, (_, i) => partialUpload(port, i, 64 * 1024, 1024));
    await vi.waitFor(() => { expect(uploadsInFlight()).toBe(UPLOADS_IN_FLIGHT); });
    // Only 1 KiB of a declared 2 MiB is ever sent: an answer proves the server did not wait for (or read) the rest.
    const fifth = partialUpload(port, 99, UPLOAD_LIMITS.maxBytes, 1024);
    const a = await fifth.answer;
    expect([a.status, a.headers.connection, a.headers['retry-after']]).toEqual([503, 'close', '2']);
    expect(a.body).toBe('Too many uploads in progress (at most 4 at once): try again in a moment.');
    expect(reached).toEqual([0, 1, 2, 3]); // the fifth never got past the gate, so express.raw never read it
    expect(uploadsInFlight()).toBe(UPLOADS_IN_FLIGHT); // and it took no slot
    for (const h of [...holders, fifth]) h.req.destroy();
    await vi.waitFor(() => { expect(uploadsInFlight()).toBe(0); });
  });
});
