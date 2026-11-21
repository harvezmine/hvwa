// src/range/hosts.ts — the range's host names and public origins (spec range §5 config). One level deep, so Cloudflare's
// Universal SSL covers them: the portal is HVWA_PORTAL_HOST (the domain), instances i-<instanceId>.<domain>. (The
// request catchers c-<userId>.<domain> left the POC with the victim bot, spec §16.) Locally hvwa.localhost and
// i-<id>.localhost. Public URLs use the public scheme (https behind the tunnel, http locally) and a port only when it is
// not the scheme's default.
import { INSTANCE_ID_RE } from './ids.js';

export type PublicScheme = 'http' | 'https';

export const instanceHost = (instanceId: string, domain: string) => `i-${instanceId}.${domain}`;

/** The instance id of a (lower-cased, port-less) host name, or undefined when it is not an instance host of this domain. */
export function instanceIdOfHost(hostname: string, domain: string): string | undefined {
  const suffix = `.${domain}`;
  if (!hostname.startsWith('i-') || !hostname.endsWith(suffix)) return undefined;
  const id = hostname.slice(2, -suffix.length);
  return INSTANCE_ID_RE.test(id) ? id : undefined;
}

const DEFAULT_PORT: Readonly<Record<PublicScheme, number>> = Object.freeze({ http: 80, https: 443 });
const portPart = (scheme: PublicScheme, port?: number) => (port === undefined || port === DEFAULT_PORT[scheme] ? '' : `:${port}`);
export const instanceOrigin = (instanceId: string, domain: string, scheme: PublicScheme = 'https', port?: number) =>
  `${scheme}://${instanceHost(instanceId, domain)}${portPart(scheme, port)}`;
export const portalOrigin = (portalHost: string, scheme: PublicScheme = 'https', port?: number) =>
  `${scheme}://${portalHost}${portPart(scheme, port)}`;
