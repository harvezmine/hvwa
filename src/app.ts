import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, migrate } from './db/index.js';
import { authModeFrom, editionFrom, type Config } from './config.js';
import { editionChallengeIds, type Edition } from './editions.js';
import { challengeSet, getChallenge, type ChallengeSet } from './core/registry.js';
import { setFlagSecret } from './core/flags.js';
import { hostGuard } from './core/host-guard.js';
import { resolveFlagSecret } from './core/secrets.js';
import { sessionMiddleware } from './core/session.js';
import { levelMiddleware } from './core/difficulty.js';
import { langMiddleware } from './core/i18n.js';
import { themeMiddleware } from './core/theme.js';
import { checkerRouter } from './core/checker.js';
import { errorHandler, notFoundHandler } from './core/errors.js';
import { mountChallenges } from './core/mount.js';
import { portalRouter } from './portal/index.js';
import { platformAuth, type AuthOptions, type AuthService } from './auth/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// Vendored htmx (pinned dependency), served locally — no network at runtime.
// Only this one file is exposed, not the rest of the package's dist/.
// sendFile gets it as a root + name: with a bare absolute path, send's
// dotfiles check covers every segment, so a checkout under any dot-directory
// (.worktrees/, ~/.local/...) would answer 404.
const htmxDistDir = join(
  dirname(createRequire(import.meta.url).resolve('htmx.org/package.json')), 'dist');

export interface AppOptions {
  /** Clock (ms) for the Restart-lab cooldown; tests inject one. Default Date.now. */
  resetClock?: () => number;
  /** Most new `hvwa_sid` sessions issued per rolling minute (default 60); beyond it: 429. */
  maxNewSessionsPerMinute?: number;
  /** Clock (ms) for the session-issuance limit; tests inject one. Default Date.now. */
  sessionClock?: () => number;
  /** SQLite path. Defaults to an in-memory database (tests). */
  dbPath?: string;
  /**
   * HMAC secret for flags. PROCESS-WIDE: the flag secret is a single module
   * value in core/flags.ts shared by every app in this process, so passing it
   * here changes it for all of them. When omitted, the current secret is kept
   * (by default a random value generated once per process). server.ts always
   * passes the env/persisted secret.
   */
  flagSecret?: string;
  /**
   * Extra Host names to answer to, besides localhost / 127.0.0.1 / [::1]
   * (DNS-rebinding guard). server.ts passes HVWA_ALLOWED_HOSTS.
   */
  allowedHosts?: readonly string[];
  /**
   * Which challenges to serve (src/editions.ts): 'full' = every registered one, 'lite' = the lite list.
   * Overrides the environment; when omitted, HVWA_EDITION decides (blank/unset = 'full'). server.ts
   * passes the validated config value; tests/support/setup.ts pins HVWA_EDITION=full for every spec.
   */
  edition?: Edition;
  /**
   * The platform login (src/auth): false = off, true or an AuthOptions object = on (`initialPassword` is
   * the admin's first password, used only when no account exists yet; `now` a clock for tests).
   * Overrides the environment; when omitted, HVWA_AUTH decides, and unset/blank HVWA_AUTH means ON only
   * when NODE_ENV=production (config.ts authModeFrom). server.ts passes the validated config value;
   * tests/support/setup.ts pins HVWA_AUTH=off, so only specs that pass `auth` run with the login.
   */
  auth?: boolean | AuthOptions;
}

/**
 * The options server.ts builds the app with: the DB in the data dir, the
 * configured or persisted flag secret (created on first use), the extra
 * Host names from HVWA_ALLOWED_HOSTS, the edition and the login.
 */
export function appOptionsFromConfig(
  config: Pick<Config, 'FLAG_SECRET' | 'HVWA_ALLOWED_HOSTS' | 'HVWA_EDITION' | 'HVWA_AUTH' | 'HVWA_ADMIN_PASSWORD'>,
  dataDir: string,
): AppOptions {
  return {
    dbPath: join(dataDir, 'hvwa.db'),
    flagSecret: resolveFlagSecret(dataDir, config.FLAG_SECRET),
    allowedHosts: config.HVWA_ALLOWED_HOSTS,
    edition: config.HVWA_EDITION,
    auth: config.HVWA_AUTH === 'on' ? { initialPassword: config.HVWA_ADMIN_PASSWORD } : false,
  };
}

/**
 * The Express app plus its typed platform DB handle on `locals.db`, the edition it serves
 * (`locals.challenges` is what it mounts, lists and scores; server.ts prints its count), and the
 * login service when auth is on (`locals.auth`, undefined when off).
 */
export type HvwaApp = Express & {
  locals: { db: DatabaseSync; edition: Edition; challenges: ChallengeSet; auth: AuthService | undefined };
};

/** The ChallengeSet of an edition. Every challenge the edition lists must be registered by now. */
function editionSet(edition: Edition): ChallengeSet {
  const ids = editionChallengeIds(edition);
  const missing = (ids ?? []).filter((id) => getChallenge(id) === undefined);
  if (missing.length > 0) {
    throw new Error(`createApp: the ${edition} edition lists ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not ` +
      'registered (import src/districts/index.js before createApp, or fix src/editions.ts)');
  }
  return challengeSet(ids);
}

export function createApp(opts: AppOptions = {}): HvwaApp {
  if (opts.flagSecret) setFlagSecret(opts.flagSecret);
  const edition = opts.edition ?? editionFrom(process.env);
  const challenges = editionSet(edition);
  const authOn = opts.auth === undefined ? authModeFrom(process.env) === 'on' : opts.auth !== false;

  const db = openDb(opts.dbPath ?? ':memory:');
  migrate(db);
  const login = authOn ? platformAuth(db, typeof opts.auth === 'object' ? opts.auth : {}) : undefined;

  // The app's DB handle: closed by server.ts on shutdown, and by tests that
  // use a file DB (Windows cannot delete a file SQLite still holds open).
  // Object.assign keeps the same locals object and yields the typed shape.
  const base = express();
  const app: HvwaApp = Object.assign(base, { locals: Object.assign(base.locals, { db, edition, challenges, auth: login?.service }) });

  // FIRST: requests for a foreign Host (DNS rebinding) never reach anything else.
  app.use(hostGuard(opts.allowedHosts));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());
  app.use(sessionMiddleware({ maxNewPerMinute: opts.maxNewSessionsPerMinute, now: opts.sessionClock }));
  app.use(levelMiddleware());
  app.use(langMiddleware());
  app.use(themeMiddleware());
  app.get('/static/vendor/htmx.min.js', (_req, res, next) => {
    res.sendFile('htmx.min.js', { root: htmxDistDir }, (err) => { if (err) next(err); });
  });
  app.use('/static', express.static(join(here, 'public'), { index: false }));

  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  // The platform login: /login stays open; EVERYTHING after the gate (the API, every lab, the portal,
  // the 404 page) needs a signed-in admin. Off: nothing is mounted and the portal is exactly as before.
  if (login) {
    app.use(login.publicRouter);
    app.use(login.gate);
    app.use(login.accountRouter);
  }
  app.use('/api', checkerRouter(db, challenges));
  mountChallenges(app, { now: opts.resetClock, challenges }); // the edition's challenges at /d/<district>/<slug>
  app.use('/', portalRouter(db, challenges));

  app.use(notFoundHandler());
  app.use(errorHandler()); // must stay last
  return app;
}
