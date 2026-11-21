const port = Number(process.env.HVWA_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
