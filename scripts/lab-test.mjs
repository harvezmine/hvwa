// scripts/lab-test.mjs — `npm run labs:test [-- --lab r0N]`. Black-box range-lab tests (spec §8.5, 4 levels). NOT part of
// `npm test`: it drives the Docker CLI. For each lab it builds hvwa-lab/<id>:test, then per level runs one hardened
// container (scripts/lab-harness.mjs dockerRunArgs) on a per-lab INTERNAL network (no egress), and drives it with runner
// containers on that same network (the lab has no published port and no route out — Traefik's role in production).
// Runtime: HVWA_LAB_TEST_RUNTIME (default runc; runsc on a gVisor host). Exit 0 iff every check of every lab passed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { isMainModule } from './main-module.mjs';
import { labDirs, readManifest, dockerRunArgs, newFlag, RUNNER_IMAGE } from './lab-harness.mjs';

const RUNTIME = (process.env.HVWA_LAB_TEST_RUNTIME ?? 'runc').trim() || 'runc';
/** Bound every Docker call so a wedged daemon (or a hung container) fails the run instead of hanging it. */
const TIMEOUT_MS = (() => {
  const n = Number(process.env.HVWA_LAB_TEST_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 120_000;
})();
const LEVEL_RANK = { acolyte: 0, templar: 1, inquisitor: 2, divine: 3 };

function docker(args, { capture = true, input, timeout = TIMEOUT_MS } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, timeout, stdio: capture ? ['pipe', 'pipe', 'pipe'] : 'inherit' });
  if (r.error) {
    if (r.error.code === 'ETIMEDOUT') {
      throw new Error(`docker ${args.slice(0, 3).join(' ')} timed out after ${timeout} ms (HVWA_LAB_TEST_TIMEOUT_MS)`);
    }
    throw r.error;
  }
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}
function dockerOk(args, msg) {
  const r = docker(args);
  if (r.status !== 0) throw new Error(`${msg}: docker ${args.slice(0, 3).join(' ')} exited ${r.status}\n${r.stderr}`);
  return r.stdout;
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/** Poll Docker's health until `healthy`, or fail (collecting the container's logs for the report). */
async function waitHealthy(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = docker(['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}', name]).stdout;
    if (status === 'healthy') return;
    if (status === 'none') throw new Error(`${name}: image has no HEALTHCHECK`);
    if (Date.now() > deadline) {
      const logs = docker(['logs', '--tail', '40', name]).stdout;
      throw new Error(`${name}: not healthy within ${timeoutMs} ms (last status ${status})\n${logs}`);
    }
    await sleep(500);
  }
}

/** Run a one-shot Node runner on the lab's internal network; returns { status, stdout }. `mount` adds -v <host>:<dst>:ro. */
function runner(network, nodeArgs, { mount } = {}) {
  const args = ['run', '--rm', '--network', network, '--user', '10001:10001',
    ...(mount ? ['-v', `${mount.host}:${mount.dst}:ro`] : []), RUNNER_IMAGE, ...nodeArgs];
  return docker(args);
}

/** The reference solve for `solveLevel`, run against `targetName`'s HTTP endpoint; returns trimmed stdout. */
function runSolve(network, solveDir, solveLevel, targetName, port) {
  const r = runner(network, ['node', `/solve/${solveLevel}.mjs`, `http://${targetName}:${port}`], { mount: { host: solveDir, dst: '/solve' } });
  return r.stdout;
}

/** A depth-1 same-origin crawl from `/`, asserting no page body leaks a flag (check 5). */
function browseHasNoFlag(network, baseName, port) {
  const script = [
    `const base = 'http://${baseName}:${port}';`,
    "const seen = new Set(['/']); const bodies = [];",
    'async function get(p){ try { const r = await fetch(base+p,{redirect:"follow",signal:AbortSignal.timeout(5000)}); const t = await r.text(); bodies.push(t);',
    '  for (const m of t.matchAll(/(?:href|src|action)=["\\x27]([^"\\x27#?]+)/g)) { let u=m[1];',
    '    if (u.startsWith("http")){ if(!u.startsWith(base)) continue; u=u.slice(base.length)||"/"; }',
    '    if (!u.startsWith("/")) continue; if (seen.size<25) seen.add(u); } } catch {} }',
    '(async()=>{ await get("/"); for (const p of [...seen].slice(1)) await get(p);',
    '  process.stdout.write(bodies.some((b)=>/HVWA\\{/.test(b))?"LEAK":"CLEAN"); })();',
  ].join('\n');
  return runner(network, ['node', '-e', script]).stdout === 'CLEAN';
}

/** check 6: an internal network has no route to the public internet. */
function egressBlocked(network) {
  const script = "fetch('http://1.1.1.1',{signal:AbortSignal.timeout(2500)}).then(()=>process.exit(1),()=>process.exit(0));";
  return runner(network, ['node', '-e', script]).status === 0;
}

async function testLab(dir, report) {
  const manifest = readManifest(dir.path);
  const id = manifest.id;
  const image = `hvwa-lab/${id}:test`;
  const net = `hvwa-labtest-${id}-${randomBytes(4).toString('hex')}`;
  const solveDir = join(dir.path, 'solve');
  const containers = {};
  const flags = {};
  const pass = (msg) => report.push({ id, ok: true, msg });
  const fail = (msg) => { report.push({ id, ok: false, msg }); throw new Error(`[${id}] ${msg}`); };

  dockerOk(['build', '-t', image, dir.path], `${id}: build`);
  dockerOk(['network', 'create', '--internal', net], `${id}: network`);
  try {
    for (const level of manifest.levels) {
      const flag = level === 'divine' ? undefined : newFlag();
      flags[level] = flag;
      const name = `${net}-${level}`;
      containers[level] = name; // tracked before `run`: a failed start can still leave a Created container behind
      dockerOk(dockerRunArgs({ manifest, level, network: net, name, image, runtime: RUNTIME }), `${id}/${level}: run`);
      if (flag !== undefined) {
        // Deliver the flag exactly as the warden does (spec §6): after start, into /tmp, as a one-shot file — never an
        // env var (a read-only rootfs blocks `docker cp`/the archive endpoint, so both use a tiny exec that writes it).
        const r = docker(['exec', name, 'sh', '-c', "umask 077; printf '%s\\n' \"$1\" > /tmp/.hvwa-flag; chmod 400 /tmp/.hvwa-flag", 'sh', flag]);
        if (r.status !== 0) fail(`${level}: deliver the one-shot flag file (docker exec exited ${r.status}): ${r.stderr}`);
      }
      await waitHealthy(name);                                                             // check 1
      pass(`${level}: health passes`);

      // No-leak checks: the flag must be reachable only through the intended exploit, never from the environment,
      // inspect output, logs or the delivered file itself (which the start hook must have unlinked).
      const inspectOut = docker(['inspect', name]).stdout;
      const logsOut = docker(['logs', name]).stdout;
      if (/HVWA\{/.test(inspectOut) || /HVWA\{/.test(logsOut)) fail(`${level}: docker inspect or logs leak the flag`);
      pass(`${level}: docker inspect and logs contain no HVWA{`);
      if (flag !== undefined) {
        const imageCfg = docker(['inspect', image]).stdout;
        if (imageCfg.includes(flag) || inspectOut.includes(flag)) fail(`${level}: the image or container config holds the flag`);
        pass(`${level}: image and container config hold no flag`);
      } else {
        pass(`${level}: no flag to leak at Divine`);
      }
      if (docker(['exec', name, 'test', '!', '-e', '/tmp/.hvwa-flag']).status !== 0) fail(`${level}: the one-shot flag file still exists`);
      pass(`${level}: the one-shot flag file is gone`);
    }

    const exploitable = manifest.levels.filter((l) => l !== 'divine');
    for (const level of exploitable) {
      const got = runSolve(net, solveDir, level, containers[level], manifest.port);        // check 2
      if (got !== flags[level]) fail(`${level}: solve did not return the ${level} flag (got ${JSON.stringify(got).slice(0, 80)})`);
      pass(`${level}: reference solve obtains the flag`);
      for (const higher of manifest.levels.filter((l) => LEVEL_RANK[l] > LEVEL_RANK[level])) {  // check 3
        const h = runSolve(net, solveDir, level, containers[higher], manifest.port);
        if (flags[higher] !== undefined && h === flags[higher]) fail(`${level} solve unexpectedly beat ${higher}`);
        pass(`${level}: solve fails against ${higher}`);
      }
    }

    if (containers.divine) {                                                               // check 4
      for (const level of exploitable) {
        const d = runSolve(net, solveDir, level, containers.divine, manifest.port);
        if (/HVWA\{/.test(d)) fail(`Divine leaked a flag to the ${level} solve`);
      }
      pass('divine: resists every solve');
    }

    for (const level of manifest.levels) {                                                 // check 5
      if (!browseHasNoFlag(net, containers[level], manifest.port)) fail(`${level}: a main page leaks the flag`);
    }
    pass('browse: no flag on the main pages');

    if (!egressBlocked(net)) fail('the lab network has egress');                           // check 6
    pass('network: no egress');
  } finally {
    const cleanup = (args) => { try { docker(args); } catch { /* best effort: never mask the failure */ } };
    for (const name of Object.values(containers)) cleanup(['rm', '-f', name]);
    // Also remove anything else under this run's name prefix (a `docker run -d` that failed after creating it).
    let leftover = [];
    try { leftover = docker(['ps', '-aq', '--filter', `name=${net}`]).stdout.split(/\s+/).filter(Boolean); } catch { /* best effort */ }
    for (const ref of leftover) cleanup(['rm', '-f', ref]);
    cleanup(['network', 'rm', net]);
  }
}

export async function main(argv) {
  const only = (() => { const i = argv.indexOf('--lab'); return i >= 0 ? argv[i + 1] : undefined; })();
  const dirs = labDirs().filter((d) => !only || d.name.startsWith(`${only}-`));
  if (dirs.length === 0) throw new Error(only ? `no lab ${only}` : 'no labs under labs/');
  const report = [];
  let failed = 0;
  for (const dir of dirs) {
    try { await testLab(dir, report); }
    catch (err) { failed++; console.error(String(err instanceof Error ? err.message : err)); }
  }
  for (const r of report) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.id} — ${r.msg}`);
  console.log(failed === 0
    ? `labs:test OK — ${dirs.length} lab(s) hold (spec §8.5), runtime ${RUNTIME}`
    : `labs:test FAILED — ${failed} lab(s) failed`);
  return failed === 0 ? 0 : 1;
}

if (isMainModule(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; },
    (err) => { console.error(`labs:test: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; });
}
