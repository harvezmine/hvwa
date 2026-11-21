// src/auth/client-ip.ts — the client's IP for per-IP limits (portal mode, spec range §12 "Client IP"). Behind the
// Cloudflare Tunnel the socket peer is always Traefik and the real client is Cloudflare's CF-Connecting-IP header. It is
// trusted because Traefik publishes no port (only cloudflared reaches it, and instances find nothing listening) and only
// Traefik reaches the portal. Locally the header is absent and the socket address is used. Express `trust proxy` stays off.
import { isIP } from 'node:net';
import type { Request } from 'express';

export const CF_CONNECTING_IP = 'cf-connecting-ip';

export function clientIp(req: Pick<Request, 'get' | 'socket'>): string {
  const cf = req.get(CF_CONNECTING_IP)?.trim();
  if (cf !== undefined && isIP(cf) !== 0) return cf;
  return req.socket.remoteAddress ?? 'unknown';
}
