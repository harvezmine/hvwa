// src/range/gate.ts — the gate between a portal sign-in and an instance host (spec range §5.4-§5.5). PLATFORM code.
//
// GET /__hvwa/gate?t=<ticket> on i-<id>.<domain>: Traefik routes /__hvwa/* of an instance host to the portal (router
// g-<id>, priority 1000, no forward-auth). The single-use ticket must name THIS instance; its user must own it, it must be
// running, the account active. Then `hvwa_gate` is set HOST-ONLY on that instance host and the browser goes to the lab's /.
//
//   hvwa_gate = v1.<instanceId>.<userId>.<expMs>.<mac>
//   mac       = base64url(HMAC-SHA256(gateKey, "gate|v1|" + instanceId + "|" + userId + "|" + expMs))
//   gateKey   = HMAC-SHA256(rangeKey, "hvwa-gate-key|v1")   (domain-separated from the flag MAC)
//   attributes: HttpOnly, SameSite=Lax, Path=/, no Domain, Secure behind HTTPS, Max-Age until expMs, where
//   expMs = started_at + HVWA_RANGE_MAX_MIN (the instance's hard maximum life; forward-auth still requires it to be
//   running, so a stopped instance is closed at once).
//
// Every other request on an instance host, on the internal host, or for /__hvwa/* elsewhere ends here with 404, before
// the session middleware: no portal cookie is ever set on a lab host.
//
// GET /__hvwa/auth on the internal host (Traefik's forwardAuth, http://portal:1337): the shared secret header, Traefik's
// X-Forwarded-Host/-Uri/-Method, then hvwa_gate verified statelessly and bound to the X-Forwarded-Host's instance, which
// must be running, owned by the cookie's user, whose account is active. 200 = pass (last-seen kept in memory); 401 = the
// page home; 403 = not Traefik (no secret, no X-Forwarded-*).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { escapeHtml } from '../core/render.js';
import { hostnameOf, targetHostname } from '../core/host-guard.js';
import { instanceIdOfHost, portalOrigin } from './hosts.js';
import type { InstanceRecord } from './store.js';
import type { RangeContext } from './types.js';

export const GATE_COOKIE = 'hvwa_gate';
export interface GateClaims { readonly instanceId: string; readonly userId: number; readonly expMs: number }

export function gateKeyOf(rangeKey: string): Buffer {
  return createHmac('sha256', rangeKey).update('hvwa-gate-key|v1').digest();
}
const macOf = (key: Buffer, instanceId: string, userId: number, expMs: number) =>
  createHmac('sha256', key).update(`gate|v1|${instanceId}|${userId}|${expMs}`).digest('base64url');

export function mintGateCookie(key: Buffer, instanceId: string, userId: number, expMs: number): string {
  return `v1.${instanceId}.${userId}.${expMs}.${macOf(key, instanceId, userId, expMs)}`;
}

const COOKIE_RE = /^v1\.([a-z2-7]{26})\.([1-9]\d{0,15})\.([1-9]\d{0,15})\.([A-Za-z0-9_-]{43})$/;

/** Stateless check: format, MAC (constant time), expiry. Ownership and state are the caller's (the DB). */
export function verifyGateCookie(key: Buffer, raw: unknown, now: number): GateClaims | undefined {
  if (typeof raw !== 'string' || raw.length > 160) return undefined;
  const m = COOKIE_RE.exec(raw);
  if (!m) return undefined;
  const [, instanceId, uid, exp, mac] = m;
  const userId = Number(uid);
  const expMs = Number(exp);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(expMs) || expMs <= now) return undefined;
  const want = Buffer.from(macOf(key, instanceId, userId, expMs));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got) ? { instanceId, userId, expMs } : undefined;
}

/** The 401 of the gate and of forward-auth: self-contained (a lab host has no /static), one link back to the portal. */
export function deniedPage(portalUrl: string): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>401 Lab not open here</title></head><body><main>'
    + '<h1>This lab is not open in this browser</h1>'
    + '<p>Labs open only from your account on the HVWA portal, and only while they run. Open it again from the portal.</p>'
    + `<p><a href="${escapeHtml(portalUrl)}">Back to the HVWA portal</a></p>`
    + '</main></body></html>';
}

const notFound = (res: Response) => { res.set('Cache-Control', 'no-store'); res.status(404).type('text/plain').send('Not found\n'); };

/** What `edge` answers: the gate on instance hosts, 404 for the rest of them, the internal host and /__hvwa/* anywhere. */
export function edgeHandler(ctx: RangeContext): RequestHandler {
  const { opts, lifecycle, tickets, auth } = ctx;
  const gateKey = gateKeyOf(opts.rangeKey);
  const portalUrl = `${portalOrigin(opts.portalHost, opts.publicScheme ?? 'https', opts.publicPort)}/`;

  const deny = (res: Response) => {
    res.status(401).set({
      'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    }).type('html').send(deniedPage(portalUrl));
  };
  /** The record when the instance is running, owned by `userId`, and that account is active. */
  const owned = (instanceId: string, userId: number): InstanceRecord | undefined => {
    const rec = lifecycle.store.get(instanceId);
    return rec !== undefined && rec.state === 'running' && rec.userId === userId && auth.service.isActive(userId) ? rec : undefined;
  };

  function gate(req: Request, res: Response, instanceId: string): void {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer'); // the ticket never travels on in a Referer
    const claims = tickets.consume(req.query.t);
    const rec = claims !== undefined && claims.instanceId === instanceId ? owned(instanceId, claims.userId) : undefined;
    if (!claims || !rec || rec.startedAt === null) { deny(res); return; }
    const expMs = rec.startedAt + opts.limits.maxMs;
    res.cookie(GATE_COOKIE, mintGateCookie(gateKey, instanceId, claims.userId, expMs), {
      httpOnly: true, sameSite: 'lax', path: '/', secure: opts.secureCookies === true, maxAge: Math.max(0, expMs - ctx.now()),
    });
    lifecycle.touch(instanceId);
    res.redirect(303, '/');
  }

  const secretDigest = createHash('sha256').update(opts.forwardAuthSecret, 'utf8').digest();
  const secretOk = (v: string | undefined) =>
    v !== undefined && timingSafeEqual(createHash('sha256').update(v, 'utf8').digest(), secretDigest);
  const refused = (res: Response) => { res.status(403).type('text/plain').send('forward-auth: refused\n'); };

  /** Traefik's forwardAuth call for one request to an instance host (see the task notes: what it trusts and why). */
  function forwardAuth(req: Request, res: Response): void {
    res.set('Cache-Control', 'no-store');
    if (!secretOk(req.get('x-hvwa-auth-secret'))) { refused(res); return; }
    const method = req.get('x-forwarded-method');
    const uri = req.get('x-forwarded-uri');
    const forwardedHost = hostnameOf(req.get('x-forwarded-host'));
    if (!method || uri === undefined || forwardedHost === undefined) { refused(res); return; }
    const instanceId = instanceIdOfHost(forwardedHost, opts.domain);
    if (instanceId === undefined || /^\/__hvwa(?:\/|$)/i.test(uri)) { deny(res); return; }
    const claims = verifyGateCookie(gateKey, req.cookies?.[GATE_COOKIE], ctx.now());
    if (!claims || claims.instanceId !== instanceId || !owned(instanceId, claims.userId)) { deny(res); return; }
    lifecycle.touch(instanceId);
    res.status(200).end();
  }

  return (req, res, next) => {
    const headerHost = hostnameOf(req.headers.host);
    // An absolute-form target overrides Host (HTTP); when it names one of ours, that is what we answer for, so it can
    // never route an instance-host or internal-host request into the portal's pages.
    const target = targetHostname(req.originalUrl);
    const host = target !== null && target !== undefined
      && (target === opts.internalHost || instanceIdOfHost(target, opts.domain) !== undefined) ? target : headerHost;
    const instanceId = host === undefined ? undefined : instanceIdOfHost(host, opts.domain);
    if (instanceId !== undefined) {
      if (req.method === 'GET' && req.path === '/__hvwa/gate') { gate(req, res, instanceId); return; }
      notFound(res);
      return;
    }
    if (host === opts.internalHost) {
      if (req.method === 'GET' && req.path === '/__hvwa/auth') { forwardAuth(req, res); return; }
      notFound(res);
      return;
    }
    if (/^\/__hvwa(?:\/|$)/i.test(req.path)) { notFound(res); return; }
    next();
  };
}
