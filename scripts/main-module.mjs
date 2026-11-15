// scripts/main-module.mjs — "is this script being run directly?" for ESM.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * True when `argv1` (process.argv[1]) is this module, comparing real paths so
 * relative, non-normalised or symlinked invocations still match.
 */
export function isMainModule(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false; // argv1 does not exist
  }
}
