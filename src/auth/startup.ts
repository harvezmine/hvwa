// src/auth/startup.ts — what server.ts does with HVWA_ADMIN_PASSWORD around createApp(). It sets the admin
// account's FIRST password only; afterwards only /account/password changes it. Its value is never printed.

/**
 * The startup line about HVWA_ADMIN_PASSWORD, or undefined when there is nothing to say. It takes only WHETHER
 * a value was configured, never the value, so it cannot leak it.
 */
export function adminPasswordNotice(
  configured: boolean, auth: { readonly accountCreated: boolean } | undefined,
): string | undefined {
  if (!configured) return undefined;
  if (!auth) return 'HVWA: HVWA_ADMIN_PASSWORD is set but ignored: the login is off';
  if (!auth.accountCreated) {
    return 'HVWA: HVWA_ADMIN_PASSWORD is set but ignored: the admin account already exists ' +
      '(it only sets the first password; change it at /account/password)';
  }
  return undefined;
}

/**
 * Remove variables from the process environment once the config holds them. HVWA's labs are built to leak
 * things (and code-execution labs reach process.env): a secret the server no longer needs must not be there.
 */
export function scrubEnv(env: NodeJS.ProcessEnv, names: readonly string[]): void {
  for (const name of names) delete env[name];
}
