# The image's HEALTHCHECK: exit 0 when the app answers lab.json's health path (/healthz), else 1.
import os, sys, urllib.request
port = os.environ.get("HVWA_PORT", "5000")
try:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=1.5) as r:
        sys.exit(0 if r.status < 300 else 1)
except Exception:
    sys.exit(1)
