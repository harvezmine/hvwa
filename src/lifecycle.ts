// src/lifecycle.ts — start/stop the HTTP server around the platform DB.
import type { Server } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { HvwaApp } from './app.js';
import type { Edition } from './editions.js';

/** Printable URL for host:port; IPv6 literals get brackets (http://[::1]:1337). */
export function listenUrl(host: string, port: number): string {
  const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/** What the server runs with, for the banner lines after the count. */
export interface BannerInfo {
  /** The edition served (src/editions.ts). */
  edition?: Edition;
  /** Whether the platform login is on (src/auth). */
  login?: boolean;
}

/**
 * Lines printed once listening: the URL with the safety warning, then the
 * number of challenges served (the edition's; verify:dist compares it with
 * what the portal links), then the edition and the login state when given.
 */
export function startupBanner(url: string, challengeCount: number, info: BannerInfo = {}): string[] {
  const lines = [
    `HVWA on ${url} — DO NOT expose to untrusted networks`,
    `HVWA: ${challengeCount} challenge(s) registered`,
  ];
  if (info.edition) lines.push(`HVWA: edition ${info.edition}`);
  if (info.login !== undefined) {
    lines.push(info.login ? 'HVWA: login on (user admin)' : 'HVWA: login off (HVWA_AUTH=on requires it)');
  }
  return lines;
}

/** Listen on host:port; resolves once listening, rejects on bind errors (e.g. EADDRINUSE). */
export function listen(app: HvwaApp, port: number, host: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Express 5 passes listen errors to this callback instead of throwing.
    const server = app.listen(port, host, (err?: Error) => {
      if (err) reject(err);
      else resolve(server);
    });
  });
}

/**
 * Stop accepting connections, wait for server.close() to finish, THEN close
 * the DB. Idle keep-alive sockets are closed immediately; busy ones get
 * `timeoutMs` before being force-closed.
 */
export function closeGracefully(server: Server, db: DatabaseSync, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const force = setTimeout(() => server.closeAllConnections(), timeoutMs);
    force.unref();
    server.close((err) => {
      clearTimeout(force);
      try {
        if (db.isOpen) db.close();
      } catch (dbErr) {
        reject(dbErr);
        return;
      }
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(err);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
