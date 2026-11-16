// src/tools/gate-catalog.ts — `npm run gate:catalog`: the 100+ release gate. NOT part of `npm test`
// (it is red by design until Phases 2-4 land). Prints "N/122 registered"; exit code 1 below 100.
import '../districts/index.js'; // registers every challenge
import { pathToFileURL } from 'node:url';
import { CATALOG } from '../catalog.js';
import { allChallenges } from '../core/registry.js';

export const GATE_MIN = 100;

export interface GateResult { ok: boolean; registered: number; total: number; message: string }

export function evaluateGate(registered: number, total: number = CATALOG.length): GateResult {
  return { ok: registered >= GATE_MIN, registered, total, message: `${registered}/${total} registered` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = evaluateGate(allChallenges().length);
  console.log(`gate:catalog ${r.message}`);
  if (!r.ok) console.error(`gate:catalog FAILED: need >= ${GATE_MIN} registered challenges`);
  process.exitCode = r.ok ? 0 : 1;
}
