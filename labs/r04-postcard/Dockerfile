# labs/r04-postcard — Server-side template injection, Hard (real Flask/Jinja2). One image, three levels by HVWA_LEVEL.
# Runtime contract: plan 2026-11-20-range-a-platform.md "Interfaces for Plans B–E". The flag file lives in the /tmp tmpfs.
# Flask stack is pinned and installed from wheels (no C toolchain: MarkupSafe ships musllinux wheels for cp313).
FROM python:3.13.18-alpine3.24
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY app/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
 && rm -rf /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.* /root/.cache \
 && (find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true)
COPY app/ ./
COPY seed/ ./seed/
COPY lab.json ./lab.json
USER 10001:10001
EXPOSE 5000
HEALTHCHECK --interval=2s --timeout=2s --start-period=30s --start-interval=500ms --retries=3 CMD ["python", "/app/health.py"]
CMD ["python", "/app/app.py"]
