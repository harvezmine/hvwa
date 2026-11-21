// The image's HEALTHCHECK: exit 0 when the app answers lab.json's health path (/healthz), else 1.
const port = Number(process.env.HVWA_PORT || 8080);
fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
  .then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1));
