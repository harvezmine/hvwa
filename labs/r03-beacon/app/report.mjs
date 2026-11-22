// labs/r03-beacon/app/report.mjs — the report generator, Beacon's second-order sink. /diagnostics validates the host
// strictly (diag.mjs) but trusts the free-text label an operator saves; this route interpolates that saved label into
// a real `sh -c 'echo "<label>" >> /tmp/beacon/report.txt'` at Inquisitor, so command substitution in the label runs a
// second command (the "second-order" chain). Divine never calls this: it renders the escaped label without execution.
// This module and diag.mjs are the only places the lab reaches a shell.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const REPORT_FILE = '/tmp/beacon/report.txt';

/**
 * Generate the report for `label` at `level`. At Inquisitor the label is concatenated into a shell string (the flaw);
 * at every other level nothing is executed and the report is empty. Never resolves a flag directly: it returns the
 * report file's raw contents, which the server escapes before rendering. Errors are swallowed, never logged.
 */
export function generateReport(level, label) {
  if (level !== 'inquisitor') return Promise.resolve({ output: '' });
  return new Promise((resolve) => {
    const cmd = `echo "${label}" >> ${REPORT_FILE}`; // intentional second-order command injection
    execFile('/bin/sh', ['-c', cmd], { timeout: 4000 }, () => {
      let output = '';
      try { output = readFileSync(REPORT_FILE, 'utf8'); } catch { /* the file is created by the echo above */ }
      resolve({ output });
    });
  });
}
