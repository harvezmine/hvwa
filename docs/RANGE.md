# HVWA range: measured lab footprint

The four POC lab images (`labs/r01-mercy-clinic`, `r02-courier`, `r03-beacon`, `r04-postcard`) were built and measured
in Plan B (Task 8). These numbers are the inputs Plan E uses for its capacity math (spec §11): how many concurrent
instances the POC host can carry. Re-measure after a base-image bump or a lab change.

Measured 2026-11-21 with the plan's commands under `runc` on the build host.

## Image size

| Lab | Base | Image size |
| --- | --- | --- |
| r01 Mercy Clinic | Node | 239 MB |
| r02 Courier | Node | 239 MB |
| r03 Beacon | Node | 239 MB |
| r04 Postcard | Python/Flask | 77.2 MB |

## Idle memory

One hardened container per lab (Acolyte level, range limits and tmpfs), measured idle and then removed.

| Lab | Idle memory |
| --- | --- |
| r01 Mercy Clinic | 15.6 MiB |
| r02 Courier | 15.0 MiB |
| r03 Beacon | 16.9 MiB |
| r04 Postcard | 24.0 MiB |
