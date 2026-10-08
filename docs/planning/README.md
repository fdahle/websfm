# Planning index

Only plans with open implementation work live in this directory. `TODO.md` is the
source of truth for priority and scope; these files describe *how*. Shipped work is
recorded in `HANDOVER.md`, and browser or external-application checks live in
`VERIFICATION.csv`. When a plan's implementation work closes, delete it here even
if manual verification is still pending—the register owns that obligation.

Audit: 2026-09-01.

| Plan | State | Canonical open item |
| --- | --- | --- |
| [Auto-Mask strategies](PLAN-automask-strategies.md) | Not started | `TODO.md` ▸ M4 |
| [Reference-raster rearchitecture](plan-reference-raster-rearchitecture.md) | COG writer shipped; spikes and phases 2–6 remain | `TODO.md` ▸ RR |
| [Scale and measurement](plan-scale-and-measurement.md) | Scale WS0–WS2 shipped; measurement WS3–WS7 remain | `TODO.md` ▸ F11 |
| [SfM compact memory](plan-sfm-compact-memory.md) | Not started — for review | `TODO.md` ▸ MEM |

Retired in the 2026-09-01 consolidation (available in git history): fiducial
detection/calibration, dense sky/vegetation cleanup, Evaluate/Quality hub,
feature-matching backend foundation, professional interop formats, and SfM
interoperability. Registration stall followed on 2026-10-06, once the headless bench
registered the building and TMA sets in full, and the ribbon tool menus on 2026-10-07. Their implementation is shipped; remaining acceptance checks,
data-driven tuning or later feature ideas are already represented in
`VERIFICATION.csv` and `TODO.md`.
