# HANDOVER — the record: baselines + done log

Roles: `CLAUDE.md` = architecture/conventions, `METHODS.md` = the science,
`TODO.md` = the plan (all open work), `VERIFICATION.csv` = the manual-check
register, and this file = the **record** — measured baselines that future runs are
compared against, and a reverse-chronological done log. When an item ships, move it
from TODO.md to one done-log line here (date · what · where it lives). When a
`VERIFICATION.csv` row produces a *number* (throughput, camera counts, cull
percentages, storage per image), that number belongs in §Baselines below — the CSV
records that the check was done, this file records what it measured.
Git history holds the detail.

---

## Baselines (before/after yardsticks)

| id | what | date | still the current yardstick for |
| --- | --- | --- | --- |
| **B4** | South Building, 128 images, two front ends | 2026-07-22 | init-pair selection, self-cal on a known focal (fx ≈ 2566), dense throughput |
| **B3** | the 2-camera registration stall, 4 runs | 2026-07-16 | the registration/rescue work (RS); superseded for B1 only when SFM-03/04 are re-run |
| **B1** | Metashape building set, 50 images | 2026-07-04 | the R-track acceptance targets (pre-BA p95, ≥3-view share, bridge pairs) |
| **B0** | CA213732V… aerial film strip, 5 images | 2026-07-03 | intrinsics-limited film behaviour, dense cost medians, fusion kept-% |
| **B0-ingest** | TIFF ingest per image | 2026-07-16 | ingest cost; next lever is the canvas PNG encode |
| **B-detect** | SIFT detection throughput | 2026-07-17 | the detection pyramid + the wasted-descriptor finding (P10) |
| **B-mesh** | screened-Poisson meshing | 2026-08-11 | meshing cost per depth; the finest-layer solve is the remaining pole |
| **B-georef-polar** | error-free control, grid fit vs local metric frame | 2026-10-04 | georeferencing in a projected CRS (synthetic; real-data check is REV-06) |
| **B-match-gpu** | brute-force NN, WASM vs WebGPU kernel (synthetic, Dawn) | 2026-10-05 | the GPU matcher's kernel cost; the real-data numbers are MAT-02/MAT-03 |

### B-match-gpu — brute-force NN kernel, WASM vs WebGPU (2026-10-05, synthetic)
Before (real data, 2026-10-04, South Building 128, ≤2400 px SIFT, ~8.4k kp/img,
exhaustive, subset gate on, 8 WASM workers): matching **1206 s** wall, ~2.75 s per
fully matched pair per worker; 6967/8128 pairs gated, 984 accepted (COLMAP GPU
exhaustive: 99 s, 2678 verified). After (single pair, ms, cross-check on unless
noted; WASM = Node/V8 simd128 build, GPU = Dawn/D3D12 on an NVIDIA Turing card via
the `webgpu` npm package — same backend as Chrome on Windows):

| pair | WASM two-pass (before) | WASM one-matrix | WebGPU | agreement |
| --- | --- | --- | --- | --- |
| 4000×4000×128, random | 370 | 210 (no cross-check: 190 both) | — | bit-identical (crate test) |
| 8400×8400×128, SIFT-like, 25 % planted | — | 919 | 16.5 (2 dispatch chunks) | 1888/1888 |
| 3000×2500×256 | — | 172 | 10.7 | 149/149 |
| 30 images × 3000 kp, exhaustive (435 pairs) | — | 52.6 s | 7.6 s incl. 369 forced cache resends | 435/435 pairs PASS |

~1.1 TFLOP/s effective on the GPU — far from peak (TODO ▸ MT). Integer-valued
descriptors (exact arithmetic) match WASM bit for bit, distances included.

**Real data, browser (2026-10-05, Chrome, same GPU, MAT-01–03):** South Building
128, SIFT ≤2400 px (4.3k–10k kp), exhaustive, subset gate **off**, ratio 0.75 +
cross-check. All 8128 pairs on the GPU, validate PASS, 0 fallbacks.

| | WASM + gate (2026-10-04) | GPU, gate off (2026-10-05) | COLMAP |
| --- | --- | --- | --- |
| matching wall | 1206 s | 598 s | 99 s |
| pairs fully matched | 1161 | 8128 | 8128 |
| accepted pairs | 984 | 1589 (1863 rejected, 4676 skipped) | 2678 |
| ≥3-view points after SfM | 51,869 | 51,964 | 80,792 |
| SfM | — | 128/128 cams, fx 2565.3, median 0.31 px, 152 s | 128/128 |

Pace was ~33 ms/pair while the GPU set it (first image's 127 pairs in 4.2 s) and
~90 ms/pair by the end; 8 drains × 598 s = 4784 s of drain time vs 2050 s inside
worker calls. The main thread bounded the rest (fixed the same day, re-run owed):
the log buffer cost **5.6 ms per line** once full (20,000 lines: 112.7 s → 1.25 s
after the fix, node, no rendering). Gate off raised accepted pairs 61 % but ≥3-view
points 0.2 % — the point gap is downstream of matching (TODO ▸ MT).

**After the main-thread fixes (MAT-05, same day; ratio 0.8, different image order):**
matching **109.5 s** wall (COLMAP 99 s) — 13.5 ms/pair, now GPU-bound (summed GPU
latency 695 s ≈ 6.4 pairs in flight), remainder 15 s (was 1510 s), postMessage 0.6 s
(was 41 s). Pairs: 1694 accepted / 6282 rejected / 152 skipped (ratio 0.8 turns most
"skipped" into verified-and-rejected). SfM: 128/128, **54,728** ≥3-view points (+5 %),
38,990 two-view points dropped in the final cleanup, cycle filter removed 331/1694.

### B-georef-polar — similarity fit on error-free polar control (2026-10-04, synthetic)
40 control points, true ECEF geometry under an arbitrary SfM similarity, targets in
EPSG:3031 grid + ellipsoidal height; 3-D RMS of the fitted similarity (m).

| site | extent / relief | k | grid fit (before) | local metric frame (after) |
| --- | --- | --- | --- | --- |
| 75°S | 2 km / 100 m | 0.98962 | 0.273 | 9.9e-6 |
| 80°S | 6 km / 400 m | 0.98021 | 2.084 | 6.6e-5 |
| 85°S | 10 km / 1000 m | 0.97462 | 6.661 | 2.7e-4 |
| 65°S | 10 km / 1500 m | 1.02053 | 7.878 | 6.8e-4 |

Pinned (cm bound) by `localFrame.test.js`. Fiducial native refine on a synthetic 4×
scan (4 corner marks, node): 107 ms planned window vs 7,621 ms for the old
±0.45·half all-variant sweep, same centres to < 0.5 px — not a browser measurement.

### B-workflow-followups — synthetic Chrome checks (2026-09-27)

Three cold-worker pairs, 800 SIFT descriptors per image, three synthetic cameras:
matching wall **966 ms**; summed pair stages **1.30 ms descriptor loading**, **1.25 ms
postMessage serialization**, **760 ms matching**, **592 ms verification**. Worker
stage times include backend startup; parallel sums exceed wall time. These are
instrumentation checks, not the 50-image real matching baseline. No worker cache
or fused matching/verification optimization was enabled from these numbers.

A 1024² six-band uint16 EPSG:3031 synthetic raster produced its preview in **767 ms**
and a three-level COG. Chrome rendered it through WebGL, changed RGB bands/gamma
and an index style, and preserved raw values. This is not a large real tile timing.

Streamed fusion and both orthophoto blend modes exactly match resident outputs in
synthetic tests. Chrome also fused OPFS depth maps with **zero resident store maps**.
For 50 maps at 1024² with normals, input planes alone are about **1150 MiB**; two
maps plus agreement/angle scratch planes are about **58 MiB**. This is arithmetic
for the new residency bound, not a measured browser heap peak; accumulator/output,
codec buffers and GC remain additional memory.

### B-detect-batch — Chromium synthetic scheduling baseline (2026-09-27)

Eight deterministic 1200×1200 PNGs, SIFT, contrast 0.01, cap 5000, four warmed
workers, no persistence, Chrome 154 on this Mac: **serial 3672 ms → bounded batch
943 ms (3.89×)**. Every keypoint record and descriptor element matched exactly.
A repeat measured 3744 ms → 970 ms (3.86×).
Reproduce with the throughput case in `tests/browser/workflow-tools.spec.js`.
This measures scheduling on synthetic images, not the Building 50 matching run,
large-film-scan peak memory, cold model startup or disk throughput.

### B4 — South Building, 128 images (2026-07-22, two runs) — supersedes the 86-camera SB number
Two front ends on the same set: **SIFT/brute-force** (17:27–17:38 console log, dense
on CPU) and **SuperPoint/LightGlue** (`south_gpu` quality report, 19:45). This is the
SB re-run acceptance record.

| run | registered | points | reproj median / p95 | ≥3-view | graph |
| --- | --- | --- | --- | --- | --- |
| SIFT + brute-force | **122 / 128** | 20,953 | **0.52 / 2.05 px** | 51.2% | 2 components |
| SuperPoint + LightGlue | 85 / 128 | 27,104 | 1.07 / 2.64 px | 54.0% | **1 component** |
| (previous, 2026-07-21) | 86 / 128 | 13,942 | 0.53 / 2.03 px | — | — |

**The focal is settled: fx ≈ 2566, EXIF nominal 2389.3 is wrong by +7.4%.** The two
runs land on **2565.9** and **2565.8** — independent detectors, matchers and seeds
agreeing to 0.1px. Read every self-cal number on this set against 2566, not 2389.
(LightGlue's report: self-cal fit RMS 0.153px, Δ 7.385%.)

**Seed choice — not matching — decided the run.** The SIFT run's three attempts:
- primary **P1180211↔P1180210** (5.21° parallax, 496 pts): **19/128 cams**, and the
  staged self-cal *ran away* — fx 2389 → 2879 → 3162 → 3655 → 4087 → 4685 → **4796
  (+101%)**, cx/cy walking 1536/1152 → 1669/888. Its own final "median 1.28px" on
  1360 points is survivor bias; the model is wrong and does not say so.
- retry 1 **P1180204↔P1180205** (11.54°): **4/128**.
- retry 2 **P1180215↔P1180321** (2.68°, 640 pts, init reproj 0.63px): **122/128**,
  with fx pinned at ~2566 from the *first* interim BA and never moving again.
- ⇒ the 2026-07-21 alternate-seed guard is what produced this model (**19 → 122
  cams**). Without it the run ships a 19-camera cloud that looks healthy by its own
  metrics. The guard is validated; the *selection* heuristic is not.
- ⚠ **The seed heuristic changed twice on 2026-07-22** (parallax became a gate; then graph
  degree was made to outrank point count — see the done log). A future SB run is therefore
  *not* comparing like with like against the attempts below; those are the record of the old
  scorer's failure. The measured intermediate state — gate only, connectivity still capped
  at 1 — reached **86/128** (first seed attempt 3/128), *worse* than the 122 the retry guard
  had been producing; that regression is what motivated the second change. Target for the
  next run: the 122-camera model on the first attempt, no retry line.
- The heuristic picked wrong: only **2 of 8** init candidates clear the 2° parallax
  bar (a high-overlap set — candidate medians 0.23–5.21°), and it preferred the
  higher-parallax pair over one with more points (640 vs 496), lower init reproj
  (0.63 vs 0.79px) and higher graph degree (21 vs 18). Parallax is outranking the
  three signals that actually predicted the outcome here.

**Matching / graph** (SIFT run): exhaustive 8128 pairs → subset gate skipped **7446
(91.6%)**, 647 accepted, 15 rejected, 20 skipped; 145,289 inliers, mean ratio 0.85;
≈4 min. Median **8 pairs/image**, 2 components (largest 126/128). LightGlue reaches a
**connected** graph and still registers 37 *fewer* cameras — the B3 finding again:
better matching does not move a registration/seed-bound failure.

**Rotation-cycle filter skipped for the opposite reason to every prior baseline**:
median triangle cycle error **42.3°** over 2010 triangles, *above* the 30° sanity
ceiling, so it declined to drop edges. Expected — it runs before self-cal, on a focal
that is 7.4% wrong. Correction to TODO ▸ Later: it is no longer true that the ceiling
is never approached.

**BA committed cleanly** (the SB acceptance item): global 1.17→1.17, post-retriangulation
already converged (1.15, no-op), post-filter 1 1.16→1.13, post-filter 2 0.96→0.96 — the
two 4.03→4.21px *rejections* from the 2026-07-21 run are gone. (One REJECT survives, in
the discarded 4-camera retry.)

**Dense** (CPU/WASM, medium, ≤768px, ≤6 sources, 3 iters) — throughput is now the
bottleneck, not photometrics:
- **≈40 s/image** (38.0–41.3 s over the 4 maps before the user cancelled) ⇒ **≈81 min
  for 122 images**.
- Per-map 78–86% pixels with depth; cost median **0.14–0.16**, p95 0.49–0.57 ⇒ median
  ZNCC ≈0.85. Compare B0/B1's 0.51–0.70 medians: this set is well-textured and the
  MVS cost function is behaving.
- Projected fusion peak **1.81 GB** vs the 12 GB budget.
- LightGlue run's report: **depth-map coverage 49.4%** (warn, threshold 50%).

Not measured here: whether the LightGlue run also needed a seed retry (only its report
survives, not its log); WebGPU depth (this console log is WASM-pinned); fused dense
cloud / DEM / ortho for either run.

### B1 — Metashape building set (2026-07-04 15:09 run, 50 images)
Intrinsics are *right* here (seed E σ2/σ1 = 1.00) — the failure is registration
contaminating the model. The R track in TODO.md exists to move these numbers:

- Pre-BA reprojection **mean 88.75px, p95 282.5px, max 213,412px** — broken
  before BA ever runs. Global BA lands in a bad local minimum (RMS 1289 → 43px
  "plateaued"; post-retriangulation BA REJECTED 43.0 → 44.3).
- Cameras accepted on almost no support: IMG_4315 **6/137** PnP inliers (4%),
  IMG_4320 7/65, IMG_4294 10/22, IMG_4314 12/100.
- Pass-2 gate ballooned to **32px** (adaptive gate follows model p95); 15
  cameras registered at 8–16px mean inlier reproj, each triangulating 100–1000
  points at that quality (IMG_4333 +1019, IMG_4336 +971).
- Track filter then deletes 41% of points (18304 → 10741) to reach median
  0.52px — survivor bias; wrong cameras stay wrong.
- Tracks: 9719 ×2 / 823 ×3 / 199 ×4+ = **9.5% ≥3-view** (target 30%+).
- Distortion fingerprint in the init-candidate table: init reproj grows with
  parallax (4306↔4307 0.64px @ 6.0° vs 4332↔4333 16.58px @ 16.5°) ⇒ unmodeled
  radial distortion (24mm wide-angle), *not* focal error. Self-calib cy
  drifting 1456→1638→1554→1519 is BA soaking that up.
- Matching: the 0.25 inlier-ratio gate rejects genuine medium-overlap bridge
  pairs (4319↔4321 27 inliers @ 0.23) — the glue that closes building loops.
- Dense (downstream symptom): cost medians 0.51–0.69 (weak ZNCC), fusion kept
  **5.0%**, 55.5% cost-culled; many depth maps report min depth **0.00**
  (degenerate planes surviving to output).

### B0-ingest — CA213732V… TIFF ingest (2026-07-16, 5 scans, 10137×9600 ≈ 97 MP gray)
Per-image transcode (decode → JPEG display + lossless PNG compute), Chrome, worker pool.
| stage | geotiff.js (before) | wasm `tiff` crate (after) |
| --- | --- | --- |
| decode | ≈34.0 s | ≈1.0 s |
| repack | ≈0.7 s | 0 (wasm returns RGBA) |
| JPEG+PNG encode (overlapping) | ≈4 s | ≈4 s |
| **total / image** | **≈39 s** | **≈5.3 s** |
Decode ~34× faster; total ingest ~7.4×. Compute-PNG blob sizes unchanged (≈103–108 MB),
i.e. identical decoded pixels. Next tall pole is the canvas PNG encode (~4 s).

### B-mesh — screened-Poisson meshing (2026-08-11)
Native `cargo test -p mesh --release`, Apple silicon. The "before" is HEAD c8b9943.

**End-to-end, identical output** (`reconstructs_sphere_near_unit_radius`, depth 5,
2000 pts — the crate's own test, so the geometry is pinned, not just the clock):
**69.80 s → 9.47 s (7.4×)**, and byte-for-byte the same mesh: 18440 verts / 36604 tris,
mean radius 1.080, RMS 0.190 both sides. The shipped wasm reproduces those exact
numbers under Node/V8 via both entry points (`poisson_mesh` and the staged
`PoissonMesher` the worker drives).

**Phase breakdown** (`cargo test -p mesh --release --test bench_phases -- --ignored`,
synthetic terrain, one point per leaf cell — the shape `generateMesh` feeds the solver):

| phase | depth 7, 16k pts (before) | (after) | depth 8, 65k pts (after) |
| --- | --- | --- | --- |
| build (octree + vector field) | 0.46 s | 0.62 s | 2.28 s |
| solve, coarsest layer | **462.99 s** | **0.80 s** | 3.05 s |
| solve, all layers | — | 52.33 s | 227.00 s |
| marching cubes | 194.51 s | **1.40 s** | 6.27 s |
| **total** | — | **54.47 s** | **236.12 s** |

The before column's coarsest layer was **462.39 s of it inside `build_rhs`**, with
matrix assembly and CG both at 0.00 s. Depth 8 costs 8× that per layer, so the old code
needed roughly an hour for the *first* of nine layers — which is the "hangs forever"
report this came from. Two numbers say where it went: the extraction flood visited
**17.4M cells for a 129k-node octree** (134× the data), and `cells_intersecting_aabb`
probes `3·2^depth + 3` cells per axis (771³ ≈ 4.6e8 per node at depth 8).

Ceilings that remain: the finest-layer solve is now the tall pole (123 s of the 227 s
at depth 8) and is genuine work — sparse assembly + CG over the largest layer. It is
also the part that would gain most from threads; the app is already cross-origin
isolated for ORT, so `SharedArrayBuffer` is available and the rayon strip is a build
flag, not a hard limit.

### B-detect — SIFT detection throughput (2026-07-17)
The "before" is the pre-`2026-07-17` pyramid (blur-from-base + no SIMD). Two measurements,
because the isolated and end-to-end numbers differ and both are worth keeping:

**Blur, isolated** (native `cargo test --release -- --ignored bench_pyramid`, 2048²; x86
SSE stands in for wasm simd128, so treat as indicative):
| | before | after |
| --- | --- | --- |
| taps / octave | 124 | **82** (octave 0) / **71** (octaves 1+) |
| one σ=1.6 blur | 174.9 ms | **43.3 ms** (4.04×) |
| full octave (6 levels) | 1836.8 ms | **291.3 ms** (6.30×) |

**End-to-end**, the real wasm binary under Node/V8 (5000×5000 synthetic, `contrast_threshold`
0.003, ~18.4k raw keypoints capped to 10k — both builds given the same workload):
**12.7 s → 4.1 s (3.1×)**. Lower than the blur's 6.3× because the extrema scan and
descriptors are now the tall poles (Amdahl). At the cap the run computes **18288
descriptors to keep 10000** — ~45% thrown away, the obvious next lever.

Not measured here: real scans in a browser (this box has no browser); the synthetic
image's keypoint mix is not a photo's. The 3.1× is the honest order of magnitude, not a
promise about a specific project.

### B3 — the 2-camera registration stall (2026-07-16, four runs, default settings)
The "before" for TODO ▸ Now ▸ RS. Building set = 50× Canon 5D (24mm full-frame);
TMA = 5 film scans. Each dataset run twice, SIFT/brute-force and SuperPoint/LightGlue:

| run | matching | reconstruction |
| --- | --- | --- |
| building + SIFT | 166/1225 pairs, 13k inliers | **2/50 cams** |
| building + LightGlue | 1112/1225 pairs, 163k inliers | **2/50 cams** |
| TMA + SIFT | 6/10 pairs, 391 inliers | 2/5 cams |
| TMA + LightGlue | 8/10 pairs, 1445 inliers | **5/5 cams** (rescue fired) → dense OK |

The diagnostic pair is the two building runs: **12× the matching quality, identical
result** ⇒ the bottleneck is registration, not matching. Fingerprints of the deadlock:
- Init reproj median **1.77px** — the seed looks perfect because the 2-view model
  absorbs the radial distortion into its point positions.
- Third-view PnP inlier ratios **10–29%** against the 30% gate; the "pose fits loosely"
  defers show ~half the correspondences holding at the 8px gate but not the 4px
  recheck (IMG_4326: 259/596 @ 8px, only 128 within 4px) — a radial gradient, exactly
  what `register.js`'s D3 comment predicts.
- The run's own later self-cal measures k1 ≈ **−0.025** (~58px corner shift) — the
  thing that would fix it, unreachable at 2 cameras (`distortionCalMinCams` = 6).
- Only TMA+LightGlue escaped, via the rescue — which is why the rescue guard was the
  fix (see done log 2026-07-16).
- Both TMA runs: k1 oscillates between post-filter passes (+0.032 → −0.010; −0.049 →
  −0.005), every composed fit trips the "corner shift exceeds 50px" runaway warning
  (⇒ the <3-camera self-cal skip), and both warn `implied film width 253mm is not a
  standard aerial format` (⇒ the resolveK format-over-pitch flip; also check the TMA
  sensor config — 253mm is no real format).
- Rotation-cycle filter: never engaged on any of the four (median cycle error always
  under the 30° ceiling).

### B0 — CA213732V… aerial film strip (2026-07-03 00:12 run, 5 images, Medium dense, GPU)
The intrinsics-limited case (contrast with B1):

**Sparse** (healthy-looking but self-flattering):
- 3,066 points; track lengths **2712 ×2 / 352 ×3 / 2 ×4+** (88% 2-view —
  weakly constrained; the honest quality metric).
- Final reprojection median 0.50px — but measured *after* a 4px track filter,
  so bounded by construction. Pre-BA p95 was 12.5px.
- Init-candidate anomalies (fingerprints of an intrinsics error):
  0033↔0034 median parallax **0.48°** / 65% cheirality (others 9.8–17.7°);
  0032↔0033 init reproj **17.8px** vs 0.72px for 0035↔0036; PnP inlier ratios
  collapse toward the strip's left end (41/71, 75/183).

**Dense** (the user-visible pain: freckled depth maps, huge z-spread):
- Cost = 1 − ZNCC ∈ [0,2]. Per-image **cost median 0.63–0.70 ⇒ median ZNCC
  0.30–0.37** — barely above random. Root symptom; freckle + z-spread follow.
- Fusion auto maxCost = p70 = **0.71** (self-referential: a bad cost
  distribution sets a bad threshold). Kept **6.6%**; culled 31.4% no-depth,
  21.3% cost, **40.7% <2-views**.
- DEM: 235k measured vs 200k IDW-filled cells (~46% interpolated).

**Intrinsics suspicion (likely upstream cause):** K = 154mm ÷ 0.025mm/px =
fx 6160, but 10137px × 0.025mm = **253mm — wider than standard 230mm aerial
film**. If the scan spans the full frame, true pitch ≈ 0.0227mm ⇒ fx ≈ 6716
(~9% higher). A ~9% focal error explains the init anomalies, the 40.7%
<2-views cull, and dome/tilt z-spread. The user is verifying scan pitch /
fiducials; self-calibration (A2) + fiducials (F4) are the code-side support.
**Do not hard-code a "correct" focal.**

---

## Done log (most recent first)

- **2026-10-05 · Main-thread cost of long matching runs.** The first browser GPU run
  (MAT-02) was main-thread-bound in its second half. `composables/useLog.js`: the
  console buffer is a `shallowRef` appended in place, notified ≤20 Hz and trimmed in
  500-line chunks (was a deep `ref` whose `shift()` re-triggered all 5000 indices per
  line once full); DevConsole's `watch(entries)` is no longer `deep`.
  `useMatchesStore`: per-pair `touch()` throttled to ≤10 Hz with a flush at the end
  of `matchAll`; verification posts only the putatives' packed coordinates
  (`verify.js` `packMatchedPoints` → `verifyPoints` op, transferred) instead of
  cloning both keypoint object arrays. Re-run of MAT-02 owed.

- **2026-10-05 · WebGPU brute-force matcher + one-matrix cross-check.** *CPU*
  (`crates/matching` `nn2_rows_cols`): cross-check reads B→A column-wise off the same
  A·Bᵀ instead of a second scan — bit-identical output (native test vs the old
  two-pass code incl. exact ties), 1.8× on cross-check. *GPU* (`workers/gpu/
  matchGpu.js` + `match.wgsl`): tiled kernel returning per-row/per-column top-2 only;
  ratio + mutual decision in `core/features/nnSelect.js` (the crate's rule in JS,
  tested against the wasm). Pinned to `GPU_MATCH_WORKER` with a per-run descriptor
  LRU (`{ needs }` → resend); store router `stores/matching/gpuMatchRun.js` validates
  the first full and first subset-gate match per run against WASM (fail ⇒ rest of run
  on WASM), falls back per pair on error, and records `matchRun.backend`. Behind
  Settings ▸ Compute "Use GPU" (default on with WebGPU). Verified headless on an
  NVIDIA GPU via Dawn (B-match-gpu); browser runs owed: VERIFICATION `MAT-01`–`MAT-04`.

- **2026-10-04 · Review follow-ups: polar georeferencing, PatchMatch, survey-held
  gradual selection, fiducial detection.** *Georeferencing* (`core/products/
  localFrame.js`, `georef.js` `fitGeoreference`, `sim.local`): the similarity is fitted
  in a local metric frame — grid with the point scale factor k divided out and
  curvature restored about the targets' centroid — and composed back to the grid;
  saved fits without `sim.local` behave as before. GCP anchors and camera priors in
  BA share one such survey frame (`cameraPriors.js` `surveyFrameFor`/
  `gcpToSurveyFrame`; σ_h scales by 1/k). Error-free control: 2.1 m → 0.07 mm at 80°S
  (B-georef-polar). With `sim.local`, `sim.scale` is SfM → *ground* units, so
  metric-scale readouts and scaled-local exports from a polar georeference shift by
  k (~2 % at 80°S) — now correct. *Measurements* report ground values (÷k, ÷k² for area and
  volume) with k on the result card and saved in the record (`groundScale`); records
  saved earlier stay grid values, unlabelled. *PatchMatch* (`planeCost.js`, `mvs.rs`,
  `patchmatch.wgsl` in lockstep): a flat SOURCE patch now costs 2.0 instead of being
  dropped from best-K (a flat REFERENCE patch stays "no measurement"), and ZNCC sums
  are shifted by the first sample — f32 error on 240 ± 1.5 patches 1.5e-2 → 3.4e-7
  median. WGSL validated with naga 30 (Tint/browser A/B still owed). *Gradual
  selection* runs the same GCP anchors + camera priors as the solve
  (`core/sfm/surveyConstraints.js`, shared with sfm.js; store `surveyConstraintInput`)
  and accepts the survey reprojection allowance only when constrained. *Fiducials*:
  native refine searches ±3 coarse px with the coarse winner's variant/polarity
  (`nativeRefinePlan`, ~70× cheaper) and the scan is decoded once; concurrency is
  bounded by a full-resolution decode budget (`fiducialDetectionConcurrency`); a new
  per-image opposite-pair symmetry gate (`fiducialShapeCheck`, affine-invariant)
  demotes to review alongside batch consensus, which now ignores low-confidence
  frames; donor templates come only from marks that pass both; template-retry
  confidence uses the detector's scale; missing-slot drafts can't be accepted; every
  slot can be hand-placed before calibration; sidebar/viewer mark counts read
  `fiducialDetections` (every detected film image showed "0 (incomplete)"). New
  guide article `film-fiducials.md`. Removed the uncalled layout-driven detector
  (`useImagesStore.autonomousFiducials`/`autoDetectFiducials`, the `bootstrapFiducials`
  op + client, `core/sfm/fiducialBootstrap.js`, `gateFiducialDetections`,
  `FIDUCIAL_DETECT_DEFAULTS`); the template matcher in `fiducialDetect.js` stays for
  the batch retry. VERIFICATION's older "Review hardening" rows renamed
  `HRD-01`…`HRD-03` (their ids collided with the review's `REV-01`…`REV-03`). Validation: 1,572 unit tests (13 tests of the deleted detector went with it), 19 native Rust
  tests (reconstruction, release), typecheck/bindings/lint, production build. Owed:
  `REV-06`…`REV-09`.

- **2026-10-03 · Senior code review + SfM maths review: fixes.** Verified against the
  code (and mostly reproduced) before fixing; open findings are in TODO ▸ RV.
  *Geometry kernels* (`crates/reconstruction`, wasm rebuilt + stamped): `svd3` treats a
  singular value as zero relative to s₁ and Gram–Schmidts U (rank-2 inputs left U
  without a third column), and P3P negates an all-negative λ instead of discarding it.
  Before: 478/1977 random noise-free P3P minimal sets recovered, 1305/2000 Procrustes
  triples, non-rotation essential candidates at ‖E‖≈3–4; after: ≥99.5 %, ≥1990/2000,
  none (three new randomized tests). BA step acceptance evaluates the Huber loss the
  IRLS weight descends. `recoverPose` normalises each image with its own K.
  *Sparse maths*: Newton (tolerance-driven) Brown inverse instead of 8 fixed-point
  steps; self-cal guard rejects a bag with no inverse at the observed corner; the
  composed self-cal bag keeps every term ever folded; GCP marks are undistorted and
  folded with their image's keypoints in `sfm.js`; store-side GCP/marker
  triangulation (georef fit, accuracy report, scale bars, guides, estimate) maps
  scan marks into the pinhole/canonical frame (`displayFrame.js`
  `makeScanToPinhole`/`makeFrameModelResolver`/`gcpsInPinholeFrame`/`guideToScan`);
  y-up fiducial certificates no longer mirror the canonical film frame (`ySign`).
  *Products/geo*: 3D Tiles up axis is a vertical metre, not a grid unit (heights were
  ×1/k); GeoTIFF import honours tiepoint (I,J) and PixelIsPoint
  (`edgeOriginFromTags`; rasters imported earlier keep their stored origin —
  re-import to correct); fused normals face the camera; mesh trim radius follows the
  subsampled Poisson input spacing; mesh ortho surface stays Float64; streamed ortho
  linearises the affine `toSfm` once instead of per cell × map and allocates only
  the blend's per-cell state; streamed fusion reads depth-only comparison maps
  (~6× less N² I/O) and its progress no longer runs backwards; Find GCPs maps the
  reference window with nearest-sampling centres (was ~31 m off on Sentinel-2).
  *App bugs*: renaming an image no longer detaches its GCP marks/poses/footprints
  (`relinkImageRecord`); 3D selection respects near/far clipping, Escape aborts a
  stroke, a restyle drops a stale selection, Cancel stops a multi-cloud edit, the
  first edit keeps the camera, an edit racing a removal no longer resurrects a
  cloud, and the lasso test is banded (exact, no longer O(points × vertices));
  volume custom base no longer defaults to 0 and measurements apply the reference
  DEM's vOffset; plane-less orthos reopen without a false "missing data" or a
  full-resolution decode on restyle, and a GPU-path restyle refreshes the preview;
  GPU stretch ranges cannot compile NaN; a damaged attribute sidecar drops only that
  cloud's attributes; LAS files with 8-bit colour in 16-bit fields no longer import
  black; gradual selection keeps provenance/style, warns on a failed save and never
  leaves the status spinning; product tabs close only when an edit committed;
  live fiducial residuals use the calibration's own transform model; match overview
  counts the main sparse model. *Structure*: Ribbon disable state derives from its
  reason list (the footprints toggle had an empty tooltip); four dead `opfs.js`
  exports removed (incl. the forbidden whole-set `loadDepthPlanes`).
  Validation: 1,561 unit tests, 15 native Rust tests (3 new randomized), typecheck/
  vue-tsc/bindings/lint, production build, 22 Chrome specs (real WASM). Real-data and
  external-tool checks owed: `REV-01`…`REV-05`.

- **2026-10-03 · Measurement tools moved to the Ribbon.** DEM/Orthophoto contextual
  tab gains a Measure group (Ruler, Area, Profile, Volume, Saved); the in-view
  select-and-buttons toolbar is replaced by a drawing bar, a styled result card
  (headline value + detail rows, perimeter/relief added) and a saved-measurement
  list. Enter/Backspace/Esc shortcuts. Fixed a latent watch that reset the tool on
  any parent re-render. Guides: `dem.md`, `orthophoto.md`. Validation: unit suite,
  typecheck/lint, 22 Chrome specs (measurement spec rewritten for the new UI),
  dark/light screenshots in the real app.

- **2026-10-03 · DEM volume measurement (F11).** Measure ▸ Volume (cut / fill) on a DEM
  polygon against a best-fit vertex plane, lowest vertex or custom height
  (`core/products/measure.js` `polygonVolume`/`fitBasePlane`, scanline over cell
  centres). Holes and off-raster area are counted as missing coverage, never
  interpolated. Saved with the other measurements. Guide: `dem.md` ▸ Measure a volume.
  Validation: unit tests + the extended `workflow-tools.spec.js` ruler/area/profile/
  volume Chrome spec. External GIS cross-check owed (`UX-MEAS-02`).

- **2026-10-03 · 3D-viewer rectangle/lasso point selection (F9).** Select dense-cloud
  points in the 3D view (Shift adds, Alt subtracts), then delete or keep only. Pure
  `core/products/screenSelect.js` projects the exact Float32 render buffer through the
  drawn matrix, so the highlight is the selection. `maskCloud` + `mode:'mask'` reuse the
  cloud-edit worker path. The first edit forks a derived copy and hides the source;
  edits on a derived cloud replace it in place. Guide: `dense-cloud.md` ▸ Cleaning the
  cloud. Validation: 1524 unit tests, typecheck/lint, 22 Chrome specs incl. the new
  `cloud-selection.spec.js`; large-cloud and hidden-class checks owed (`UX-EDIT-02`).

- 2026-09-28 · Fixed the blank Workflow Builder on new projects; initialize on open, provide an actionable empty canvas, keep the settings inspector accessible in compact windows, and add keyboard reorder controls. Added the workflow guide and Chrome coverage for editing, templates, OPFS reopen, and interactive execution (`App.vue`, `WorkflowBuilderModal.vue`, `workflow-builder.spec.js`).

- **2026-09-27 · Five workflow follow-ups.** GCP close-ups, optional source-photo
  crops, DEM height/accuracy filling and checkpoint roles in Find GCPs; named
  persisted 2D measurements and stale-source stamps; matching RPC stage timings;
  File-handle depth-map streaming for fusion and ortho with eviction after save;
  fast ortho previews, serialized COG preparation, Blob-part assembly and WebGL
  raster tabs/map layers with GPU styles. Guides describe the workflows and
  remaining limits. Real historical accuracy and large-dataset memory/timings
  remain in VERIFICATION.csv. Validation: 1508 tests in the full unit run plus
  four shader-expression cases; 19 Chrome integration tests, with grayscale and
  application startup rechecked after the final viewer split; typecheck/lint and
  production build pass. Main bundle: 1744.32 kB, below the 1750 kB warning.

- **2026-09-27 · Throughput, reference candidates and editing.** Added bounded SIFT
  batches with memory-aware concurrency estimates and wall-clock logs; raw
  GeoTIFF window reads and a bounded restyle-band cache; reviewed reference-ortho
  SIFT/H-RANSAC GCP candidates tied to measured sparse tracks; temporary 2D
  ruler/area/DEM profiles with CSV; and sparse gradual selection with worker BA,
  track/calibration preservation and dependent-product invalidation. Five
  synthetic Chromium workflows pass, including actual SIFT, GeoTIFF and BA WASM.
  Real historical matching and large-image peak memory remain manual checks.


*Entries often name a `PLAN-*.md` / `plan-*.md` file. Those are deleted when their
feature ships (the documented rule), so older links point at files that now exist
only in git history — that is expected, not rot. Live plans are in `docs/planning/`.*

- **2026-09-11 · Senior-review fixes and regression coverage.** Confirmation keyboard
  handling and shared modal focus; immutable reconstruction/product generations;
  pending-save barriers and retry feedback; cross-tab index merging and project
  leases; georeference evidence invalidation and native CRS units; Float64 import,
  editing and persistence with relative render buffers; bounded worker ZIP imports,
  validated LAS/LAZ allocation and incremental LAZ compression; typed DEM staging;
  versioned ORT runtime paths; cache-presence and spreadsheet-safe CSV fixes.
  Extracted frame resolution and persistence helpers, added incremental TypeScript,
  Vue binding checks, JavaScript correctness lint and GitHub Actions. Local checks:
  1,470 unit/store tests, 8 Chrome integration tests, 40 native Rust tests (5 ignored),
  static checks, production build and real LAZ WASM round-trip passed. Rebuilt all
  six WASM packages and recorded source/artifact hashes. npm reports zero known
  vulnerabilities after dependency updates. Compatibility and import budgets are
  documented in README; large real-data/GPU and deployed-server checks remain in
  VERIFICATION.csv.

- **2026-09-01 · Geographic camera priors now constrain sparse BA automatically.**
  `core/sfm/cameraPriors.js` converts enabled 3D positions from a geographic project
  CRS into one survey-centred azimuthal-equidistant metre frame, including an
  antimeridian-safe centre and canonical EXIF altitude/uncertainty. Projected-CRS
  behaviour is unchanged, and the project CRS remains the display/export CRS.
  Focused unit coverage pins metric baselines and EXIF metre sidecars; a real-browser
  folded-block rerun remains in `VERIFICATION.csv`.

- **2026-09-01 · Visual Workflow Builder replaces one-click U4.** Reconstruct ▸
  Workflow now opens a full-screen ordered block builder rather than hiding the
  pipeline behind “Run All”. One pure, versioned registry (`core/workflow.js`) owns
  workflow-suitable processing commands from preparation through reconstruction,
  products and evaluation; input and export remain explicit user actions outside
  recipes. Automatic blocks call the existing `usePipeline` runners,
  while commands requiring a file picker or human judgement open their existing
  modal and pause until the user confirms completion. Per-workflow defaults and
  per-block overrides choose `Reuse valid` / `Ask` / `Always rerun` and
  `Pause` / `Continue` / `Stop` on warnings. Dependency preflight, drag reorder,
  disable/duplicate, Run / Run selected / Run from selected, live status, execution
  preview, an empty-by-default canvas, Guided/Standard/Expert disclosure and
  generated recipe text are in
  `WorkflowBuilderModal.vue`; no second reconstruction implementation exists.
  `useWorkflowsStore` persists project-owned copies + the latest 30 immutable run
  snapshots in `workflows.json`; global templates live in localStorage and are
  copied—not linked—into a project. `useWorkflowRunner` owns sequential execution,
  pauses and snapshots. The console command `workflow` opens the same builder.
  A 2026-09-01 UI follow-up aligned the builder with shared modal controls and
  migrated only untouched auto-generated v1 starters to the empty canvas.
  Automated: 1,395 JS tests (new schema/store/runner coverage), typecheck and
  production build pass. Browser acceptance remains `VERIFICATION.csv` ▸ `UI-15`;
  quality-gate branching and editable text are explicit TODO ▸ WF follow-ups.
- **2026-09-01 · Planning/TODO consolidation.** Audited every file in
  `docs/planning/` against the current stores, workers, UI and verification register;
  added `docs/planning/README.md` as the live-plan index. Retired six specs whose
  implementation is complete or whose remaining idea is already owned elsewhere:
  fiducial detection/calibration, dense sky/vegetation cleanup, the Evaluate/Quality
  hub, the original learned feature-backend foundation, professional interop formats
  and the SfM interop hub.
  Their historical detail remains in git; their open acceptance checks remain in
  `VERIFICATION.csv`, and mesh texturing / SP3–SP5 remain in `TODO.md`. Refreshed the
  four live plan headers, narrowed SP3 to its still-unmeasured concurrency decision,
  aligned the plan lifecycle rule in `CLAUDE.md`/`TODO.md`, corrected the register
  summary to **123 checks / 47 P1**,
  and changed the stale `DEN-05` wording from deciding GPU-default work to validating
  the automatic default that shipped 2026-08-25. No code changed.
- **2026-08-25 · WebGPU is now the automatic compute default + CPU PatchMatch hot-loop
  cleanup.** `useComputeSettings` enables GPU on first use when `navigator.gpu` is
  exposed, while preserving a stored explicit opt-out; adapter acquisition and every
  per-image failure still fall back to WASM, and first-image GPU↔CPU validation remains.
  The WASM kernel's innermost `agg_cost` no longer allocates and fully sorts a `Vec`
  for every hypothesis: it keeps only the requested best-K costs in a fixed 16-entry
  stack array. The rebuilt reconstruction WASM is 135,556 → 130,014 bytes. Automated:
  1,378 JS tests, 12 optimized Rust tests, typecheck, production build, release check.
  Browser acceptance remains `VERIFICATION.csv` ▸ `DEN-05`/`DEN-06`.
- **2026-08-25 · Scale constraints (F11 slice 1 — WS0–WS2).** An object-capture
  project (no GCPs, no CRS) can now be given a metric unit from a measured
  distance. Pure fit in `core/products/scale.js` (weighted LSQ `fitScale`, mm/cm/m
  conversion, `scaleEvidenceDigest`); the factor is applied as a property of the
  *frame* — `frameFromScaledLocal` in `core/products/projection.js`, descriptor kind
  `scaled-local` in `workers/ops/products.js` — never by rescaling the cloud, which
  would invalidate the depth-map staleness stamp and every recorded `summary.*`
  number. `useReconstructionStore.effectiveFrameSpec` is THE unit resolver
  (`georeference > scale bars > none`) and DEM/ortho/cloud/mesh export now all ask it
  instead of choosing independently. Evidence (`useScaleBarsStore` /
  `scalebars.json`) is split from the derived fit (`reconstruction.json.scaleFit`),
  which carries a cloud stamp + evidence digest and is refused when either moves
  (`stores/reconstruction/scaling.js` `scaleFitStatus`); a DEM/ortho records the
  frame it was built in and shows an "outdated frame" banner after a refit. New
  **`marker`** role = image marks with no surveyed position; the ground-control gate
  is now one explicit `core/io/gcp.js` `isGroundControl` (`role === 'control'`, never
  "has finite coordinates") shared by the georef fit, its LOO prediction, anchored BA
  and the worker marshalling, so a marker can never become a constraint. UI: Tools ▸
  Georeferencing ▸ **Scale Bars** (`ScaleBarsModal`), the GCP table/toolbar/right-click
  renamed **Control & Markers** with two explicit create actions, a Scale Bars tab in
  Quality Report ▸ Accuracy + a section in the exported HTML report + `scaleFit` in the
  Debug digest. Glossary: `scale-bar`, `gauge-freedom`. Method: METHODS.md §6.6
  (why post-hoc is exact, not an approximation). 38 new tests
  (`scale.test.js`, `scaling.test.js`, `projection.test.js`, `gcp.test.js`);
  `npm test` 1373 pass, `npm run typecheck` clean, `npm run build` clean, App.vue +
  every touched SFC re-checked for `_ctx.*` leaks (still empty). **Not browser-run** —
  `VERIFICATION.csv` rows `MEAS-01`…`MEAS-04`, `MEAS-10`…`MEAS-13`.
  Remaining F11 slices (measurement tools, WS3–WS6) still specified in
  `docs/planning/plan-scale-and-measurement.md`.

- **2026-08-19 · Up-front mobile-device notice.** websfm is a desktop app (WASM compute,
  OPFS projects, ribbon+sidebar+canvas layout) with no mobile story, so a phone/tablet
  user now gets a blocking acknowledgement before anything else:
  `components/layout/MobileWarning.vue` over `composables/useMobileWarning.js`, the same
  shared-ref + one-localStorage-key shape as `useBrowserWarning` (so the modal's confirm
  and the Settings ▸ Display toggle can't drift). Detection is of the **device, not the
  window** — `userAgentData.mobile`, then UA tokens, then the iPadOS `Macintosh` +
  `maxTouchPoints` case, then coarse-pointer/no-hover media queries — because a narrow
  desktop window must not raise a blocking dialog. Deliberately *not* `ModalShell`:
  that shell closes on Escape and on a backdrop click, and this gate must be dismissed
  only by its explicit button (z-index 9500, above the BrowserWarning toast). Manual
  check owed: VERIFICATION.csv `UI-16`.

- **2026-08-18 · Digest reports three run-shape figures; verdict gains contributing-cause
  rules.** A 127-image DJI nadir run came back yellow on a 4.7× reprojection tail whose
  cause could not be read off the digest: the three figures that explained it were either
  unrecorded or split across sections. Added, all *reported* (no new measurement): the
  **H/F-degenerate share of accepted pairs** (`useMatchesStore` tallied it per pair but
  only ever logged it at debug — counted over accepted pairs, the exact population where
  `hSkipBelow` let H run); the **keypoint-cap hit share** (`useQualityReport.detectConfig`
  — at 100% the cap, not `contrastThreshold`, selected the keypoints, by response, which
  biases against spatial uniformity); and the **track-filter gate beside the observed
  p95** it was applied to, since a 9.12 px gate over a 4.0 px p95 removed nothing and the
  two numbers previously sat in different sections. `core/sfm/verdict.js` turns each into
  a rule (`gate-headroom` / `keypoint-cap` / `cycle-filter-skipped`), all three
  **contributing-cause**: they explain a finding that already fired and are silent
  otherwise, because a run can do all three and still be a good reconstruction. The
  cycle-filter rule reads the degeneracy share to pick between the abort's two causes,
  which have opposite fixes. Evidence value: this run closes the "move it after the
  distortion fold" option in TODO ▸ RS — see that entry.
  Where: `stores/useMatchesStore.js`, `composables/useQualityReport.js`,
  `core/eval/summaryDigest.js`, `core/sfm/verdict.js` (+ tests for the last two).

- **2026-08-18 · OPFS writes serialize per file ("Failed to create swap file").**
  A folder-backed project reported `Pose save failed — Failed to execute
  'createWritable' on 'FileSystemHandle': Failed to create swap file` right after
  an EXIF-GPS sync. `createWritable()` stages into a sibling `<name>.crswap` and
  renames on close, so two writables on one file collide on that name — the same
  race `useSensorsStore` had already patched locally for sensors.json, hit here
  because `usePosesStore.restore` fires an un-awaited `save()` from
  `resolveImageMatches` and then awaits another from `syncExifPoses`, while the
  EXIF watcher fires a third. Folder storage loses the race reliably where OPFS
  won it by luck: real-disk latency widens the window. Fixed at the layer that
  owns the invariant — every write in `utils/opfs.js` now goes through
  `writeFileIn`, a per-path queue (append offsets are read inside the lock, so
  concurrent `appendLog` calls can no longer overwrite each other), which covers
  every project file rather than the two stores that had been patched. Poses
  additionally got the coalescing sensors/images already have. `src/utils/opfs.test.js`
  is new: a fake FSA backend that throws the real swap-file error reproduces the
  failure with the queue bypassed and passes with it. `core/crs.js`'s
  fetched-proj4-def cache had its own hand-rolled `createWritable` with the same
  race (two unknown codes resolving at once) behind a bare `catch {}` that hid it;
  it now goes through `opfs.readAppJson`/`writeAppJson`. The only remaining
  `createWritable` outside opfs.js is the archive sink in `utils/projectFile.js`,
  which has no second writer. Also `core/textFormat.js` (new): `pluralize`/
  `nounFor`, in core so core call sites can use it — "1 camera position(s)" was
  the reported symptom, ~120 sibling strings are TODO ▸ LG.
- **2026-08-18 · Image sources that die mid-session are detected, healed, and
  reported.** A deployed run produced `GET blob:… net::ERR_FILE_NOT_FOUND` for some
  images once matching finished. Cause: a blob URL is a handle to a *file*, not a
  copy of the bytes — an in-session image's `url` points at the user's original file
  on disk (`utils/image.js`) and a restored one's at the OPFS copy
  (`opfs.loadImageBlob` → `getFile()`), and both are re-validated on every read.
  Matching never touches pixels, so it neither caused nor noticed the loss; it just
  supplied the long window. Nothing detected it either — there was not one `@error`
  handler in the app, and `previewFailed` had a single writer (the TIFF transcode
  catch). Now: all five `<img>`s bound to `img.url` route `@error` to
  `useImagesStore.reportImageLoadError`, which re-creates the URL from the OPFS copy
  (one shared attempt per image per session, validated by a 1-byte read so a heal
  can't return a second dead URL) and only flags `previewFailed` +
  `previewFailReason: 'source-lost'` when there is nothing to heal from — sidebar ⚠,
  viewer/table/info text, and a log line naming what will now fail. Separately,
  `opfs.ensureDurableStorage()` is requested once on project create/open
  (`useProjectsStore`), so OPFS is no longer best-effort/evictable, with the verdict
  logged. Verification rows STO-0x.
- **2026-08-17 · Documentation consolidation + `VERIFICATION.csv`.** The four docs had
  accumulated the failure mode they were meant to prevent: TODO.md was 1042 lines of
  which most of §Now was *shipped* work carrying browser-verification checklists, the
  same checks were restated in the plan files, and seven cross-referenced plan files
  no longer existed. Split by role instead: **`VERIFICATION.csv`** (new, repo root) is
  now the single register of every check this environment cannot run — 105 rows across
  release / sparse / dense / products / interop / storage / UI / fiducials / reference
  data / GCP / detection, each with dataset, browser, pass criteria, source doc and
  empty status/result/date columns. TODO.md keeps only open *work* (1042 → 556 lines):
  each shipped-but-unverified item collapsed to its conditional follow-ups (the ones
  that need a measurement before a knob moves) plus a pointer to its rows. Deleted as
  shipped: W0/W1 (committed since 2026-07-07), Q ▸ P0.2 (self-cal reached k2/k3 in
  WS2), A5 (shipped as Stage A′), EX ▸ A-4, MC Phase 0, G2, DR, and the F3/F7/F8/F12
  entries. Docs rule updated in CLAUDE.md (the register + the plan-file lifecycle);
  HANDOVER gained a baselines index and this note; METHODS gained §8.1 (the ortho
  reprojects onto a *surface* — DEM / mesh / plane — which was a method change never
  written up) and lost two stale claims (self-cal row in the comparison table, the
  glossary path). Crate count corrected to six (lazcodec) in CLAUDE.md + README.
  `docs/feature-matching-backends.md` moved to `docs/planning/` with a status header;
  every live plan file now opens with status / open-work pointer / owed rows.
  No code changed.

- **2026-08-11 · Screened-Poisson meshing made usable (7.4× end to end, identical
  output).** Meshing was effectively unusable at the default depth 8 — see the B-mesh
  baseline. Five patches to the vendored solver, all exact restructurings rather than
  approximations, plus two on our side:
  (1) `PoissonVectorField::build_rhs` **scatters from the non-zero splatted normals**
  instead of every node probing an AABB range in every other layer's grid.
  `HGrid::cells_intersecting_aabb` walks the whole integer range and only *filters* to
  occupied cells, so its cost was the box volume — `O(nodes · 8^depth)`. This was 98% of
  the runtime. Exact because `grad_grad` is zero off-support, so both forms enumerate a
  superset of the same pairs. Whichever of range-walk / node-scan is cheaper is chosen
  per source (`PoissonLayer::range_is_cheaper_than_scan`).
  (2) `PoissonLayer::solve` gathers the screening points **once per node** and uses the
  B-spline's separability — 15 one-dimensional evaluations per point cover the whole ±2
  stencil — instead of re-gathering and evaluating two tri-quadratics per (neighbour,
  point). Same for the coarser-layer subtraction.
  (3) Marching cubes **memoizes cube corners** (each is shared by up to 8 cells; ~6×
  reuse measured). Upstream had left this as a `PERF:` note.
  (4) `PoissonBuilder::finish` returns the **sample-average iso** it can accumulate in
  the pass it already makes over every point; `finalize_mesh` was making a second one.
  (5) `reconstruct_mesh_buffers_iso_within` lets the caller **bound the isosurface walk
  to the region trimming would keep**, so extraction stops chasing extrapolated sheets
  it was generating only to discard: 5.78M verts → 32.7k, 194.51 s → 1.40 s at depth 7.
  Pinned by `bounded_extraction_matches_unbounded_after_trimming`, which compares the
  trimmed mesh *geometrically* (the walk order changes, so the vertex numbering does).
  Note the naive "stay inside the octree AABB" bound is **wrong** and that test catches
  it — the coarse multigrid layers have support far wider than the finest layer's extent.
  (6) `core/products/mesh.js` uses the fusion accumulator's **numeric packed cell keys**
  in `subsampleForMesh` / `buildColorGrid` rather than a template string per point (the
  colour grid spans the whole dense cloud). Packing needs a per-axis bounds check, since
  Poisson extrapolates past the cloud and an out-of-range offset otherwise aliases onto
  a valid neighbouring key — tested.
  (7) `workers/ops/mesh.js` emits each progress label **before** the work it names. The
  label used to be posted after `solve_step` returned, so "Building octree (depth 8)…"
  stayed on screen through the entire first layer solve — the build is ~0.5 s, and the
  label was pointing at the wrong phase for the whole run.

- **2026-08-11 · Orthophoto surface choice (DEM / mesh / plane) + its own GSD.** The
  ortho no longer requires a DEM: `core/products/surface.js` (new, pure) builds the
  same height grid from the **mesh** (z-buffer rasterisation of the Poisson triangles
  — watertight, so no surface holes, the fix for a patchy ortho) or from a robust
  least-squares **plane** through the cloud, and `resampleSurface` decouples the
  ortho's GSD from the surface's. `OrthoModal` gained a Surface select (rendering the
  store's new `orthoSurfaces` getter, the list `generateOrtho` consumes), a coordinate
  frame for mesh/plane surfaces, and a GSD field; the ribbon/console gate moved from
  `needsDem` to `needsSurface` (DEM **or** mesh). The ortho result now carries its own
  `gsd/originX/originY/frame/crs`, and the exporters read it from there instead of the
  DEM (older orthos fall back). Rebuilding a DEM only invalidates a DEM-surface ortho.

- **2026-08-10 · System theme detection + quick theme button.** `composables/useTheme.js`
  now stores a *preference* (`system` | `light` | `dark`) and exposes the resolved
  `theme`; `system` reads `prefers-color-scheme` and re-resolves live when the OS
  flips. `data-theme` is written explicitly for dark too (ViewerMap's
  `[data-theme="dark"]` OpenLayers rules never matched before), and
  `documentElement.style.colorScheme` follows so native controls/scrollbars match.
  UI: Settings ▸ General is a three-way toggle that names what "system" resolved to,
  plus a cycling `Other ▸ App ▸ Theme` ribbon button (label/icon report the current
  choice) and a `theme` console command. No stored preference now means "follow the
  OS" instead of the old hardcoded dark.

- **2026-08-10 · Fix: image import aborted on `meta: null`.** `exifPoseFromMetadata`
  used a default parameter, which does not fill in for `null` — and `createImage`
  sets `meta: null` until EXIF extraction resolves, so `usePosesStore`'s immediate
  `exifSig` watcher threw on the first pushed image and killed the ingest.

- **2026-08-10 · First-beta release packaging.** Versioned the app as
  `0.1.0-beta.1`, added and bundled the MIT license, exposed the version in About,
  added favicon/social metadata, made root versus subpath deployment explicit via
  `VITE_BASE_PATH`, documented the HTTPS/MIME/CORS/cache requirements, and patched
  the PostCSS/nanoid advisories. `check:release` guards the required static/runtime
  assets. Root and `/websfm/` production builds, 1,285 JS tests, typecheck,
  optimized Rust workspace tests, and npm audit pass.

- **2026-08-07 · Product-side interoperability: undistorted images, COG, LAZ, 3D Tiles.**
  Four independent formats from `docs/planning/plan-interop-formats.md`, in that
  order.
  **Undistorted images** (ribbon: Export ▸ Interoperability ▸ Undistorted Images…)
  write a COLMAP `image_undistorter`-shaped workspace — `images/` + `sparse/*.bin`
  with PINHOLE cameras — for OpenMVS/MVE/MVS-Texturing. No new geometry was
  written: the composed map already used by dense MVS was generalized to
  `core/sfm/displayFrame.js` `makeSampleMap` (scaled output/source grids) and the
  resampling extracted to the new pure `core/products/undistort.js`; **dense now
  imports both**, so there is one composition, not two. Crop mode reproduces
  `blank_pixels=0` via `validSampleRect`.
  **Cloud-Optimized GeoTIFF** for DEM + ortho. `writeCog` was split into
  `planCog`/`assembleCog` so per-tile DEFLATE can go through the injected async
  callback (`writeCogDeflate`); a GDAL ghost area makes readers report LAYOUT=COG.
  **LAZ** export + import via the new `crates/lazcodec` (the `laz` crate, Apache-2.0,
  recorded in `core/help/licenses.js`); `core/io/las.js` was split into shareable
  header/record halves and `core/io/laz.js` holds the container rules with the
  codec injected. LAZ *import* falls out — `parseLas`'s hard rejection is gone and
  the sniff reads the LASzip high bit, not the extension.
  **3D Tiles 1.1** (`core/products/tiles3d.js`): single-tile `tileset.json` + a
  points `.glb`. The ECEF placement is measured from probe points one project-CRS
  unit east/north rather than assuming grid axes are ENU — the shortcut that fails
  near the poles.
  1,285 tests (+39), typecheck, SFC `_ctx` diff and production build pass; four
  Rust tests in `lazcodec` incl. a 200k-point multi-chunk round trip.
  **Owed: browser + external-application verification** — nothing here has been
  opened in COLMAP, OpenMVS, gdalinfo, CloudCompare, QGIS or Cesium from this
  environment. See the plan doc's per-item checklist.

- **2026-08-06 · F7 expanded into the SfM interoperability hub.** Import and Export
  now end with an **Interoperability** group and one **SfM Project…** action. The
  staged import modal accepts complete COLMAP folders/ZIPs, `database.db`, sparse
  text/binary models, optional images, transforms.json, OpenMVG JSON, VisualSFM NVM,
  and OpenSfM reconstruction JSON. An official SQLite/WASM worker inspects and reads
  COLMAP cameras, keypoints, compatible descriptors, raw/verified pairs and F/E/H;
  selected data commits through bulk store APIs. Export adds `database.db`, a complete
  database+sparse+optional-images workspace, transforms.json, OpenMVG, and NVM while
  retaining sparse text/binary ZIPs. ZIP image payloads remain compressed during
  inspection. Pure convention/blob adapters are unit-tested; full suite 1,227 tests,
  typecheck, SFC compilation, and production build pass. Still owed: real COLMAP GUI
  round-trip and large-workspace browser memory/cancellation verification.

- **2026-08-05 · F10 shipped · EXIF-GPS camera priors and automatic proximity matching.**
  `usePosesStore` materializes EXIF longitude/latitude/altitude as enabled project-CRS
  poses, preserves canonical metre altitude/accuracy across CRS changes, and lets an
  explicitly imported pose win. Two or more linked positions now select proximity
  matching by default; geographic coordinates are transformed to a shared local metric
  frame and altitude is excluded from neighbour ranking. EXIF-derived poses render as
  distinct map triangles, feed post-hoc pose georeferencing, and—with altitude in a
  projected CRS—enter fixed-intrinsics BA as independently X/Y/Z-weighted camera-centre
  residuals behind a reprojection-damage guard. Missing EXIF accuracy uses conservative
  10 m horizontal / 20 m vertical defaults; non-metre projected CRSs receive converted
  Z and σ values. Imported poses, XY-only fixes, disabled records, and geographic-CRS BA
  boundaries are integration-tested. **2026-08-05 follow-up:** XMP extraction now
  consumes complete DJI-compatible camera-gimbal yaw/pitch/roll (never airframe-only
  attitude), converts drone −90°-nadir angles to OPK, and rotates true-north attitude
  into project grid north. Vendor per-axis GNSS/RTK sigmas, including DJI
  `RtkStdLon`/`RtkStdLat`/`RtkStdHgt`, are preserved in ENU, rotated into project X/Y,
  and passed to the existing weighted position priors. Canonical ENU values make CRS
  changes lossless; missing angular accuracy uses a conservative 5° default.

- **2026-07-31 · U3 · Recommended settings are now an explicit modal action.**
  `useDatasetRecommendations` reactively profiles the current image/sensor/pose/GCP
  stores and threads C1's real device-memory signal into U2. Each recommendation is
  surfaced **on the control it concerns** rather than in a banner above the modal (the
  first cut's `ui/RecommendationBanner` competed with `PresetCards` for the same decision,
  restated the form below it, and clipped its own rationale): detection gains a
  "Recommended ★" **preset card**, depth-map quality **badges** the card it points at plus
  a note line, and matching's pairing strategy gets an inline "Use recommended" link under
  the field. Dense fusion and SfM derive nothing to apply, so they get no affordance —
  SfM's rationale extends the self-calibration hint instead. Only values differing from
  static defaults appear, each rationale stays readable, and selecting is the only
  mutation (logged with value + reason). `core/recommendUi.js` pins the diff/card policy;
  `composables/useRecommendedPreset.js` is the shared glue.
  Integration fixed two previously-unrunnable U2 suggestions: large scans now
  select the live `tiling:'auto'` mode, and raw EXIF GPS does not offer position
  preselection until it becomes project-CRS camera positions. Browser visual/apply
  smoke-check remains owed; F10 subsequently made the usable-position choice automatic.

- **2026-07-31 · C1 completed · Hardware-aware dense safety limit.**
  `useComputeSettings` now reads the optional main-thread memory signals and passes them to
  the pure `deviceBudget`; its resolved byte value is the single input used by both Build
  Depth Maps and Build Dense Cloud. It logs the derivation, keeps existing saved limits as
  explicit manual overrides, and Settings ▸ Compute can reset them to Auto. The actual
  `deviceMemoryGB` (never the user's override) is threaded into U2 through
  `recommendForDataset(profile)`. The two main-thread wiring regressions plus all 1,165
  tests, typecheck and the production build pass; browser smoke-check of the reported
  source/value remains owed.

- **2026-07-31 · Batch consensus for fiducial detection** (`core/sfm/fiducialConsensus.js`,
  wired in `useImagesStore.detectFiducialsForSensor`, reason `batch-outlier` in the review
  queue). Motivated by a measured TMA failure: on a synthetic Trimetrogon scan with the
  data strip (clock faces + annotation blocks in the left border), the left mid-side mark
  is captured by a text block and **silently accepted 60 px off** with a healthy ZNCC score
  (0.52) — no per-image gate can see it. Cross-image disagreement can: the mark sits at the
  same frame-relative place in every scan of a flight, the annotations do not. Measured on
  an 8-image synthetic batch with per-image annotation text: 3 of 8 left marks captured
  (67–78 px off), **3/3 caught, 0 false positives**, tolerance 10 px against a batch spread
  of 0.02% of frame width. Known limit, by construction: if a majority of the batch is
  captured by the *same* wrong feature, the median follows it.
  Also measured on the same synthetic (Generic + Sides + polarity Auto, tolerance 0.5):
  4/4 marks at ≤1 px under grain, 0.35× contrast, and ±40 px mark displacement.

- **2026-07-30 · Detect Fiducials modal redesigned; the generic prototype family was
  three blobs, not three shapes.** The modal now follows the shared framework (hero
  choice → grouped fields → `AdvancedDisclosure`, `SegmentedControl` for positions and
  polarity, `StatTiles` + `DataTable` for results instead of hand-rolled tables).
  Detection type is a new shared `ui/ChoiceCards.vue` — a `SegmentedControl` with room
  for an example picture — each card carrying a small SVG of the mark
  (`components/modals/fiducial/FiducialFamilyGlyph.vue`). Drawing those pictures is what
  surfaced the bug: `makeFiducialPrototype`'s generic branch folded the variant test and
  the geometry test into one condition, so every pixel outside a variant's own shape fell
  through to the `else` and got the **ring** drawn on it. Measured before the fix: the
  "dot" variant (radius 4.5 in a 25 px patch) had dark pixels out to radius **10.2** — a
  solid disc; the "crosshair" was a cross inside that disc. All three swept templates were
  therefore near-identical, costing the family the discrimination it exists for. Fixed by
  branching on the variant first (`core/sfm/fiducialPrimitives.js`), pinned by a regression
  test. **This changes detection results on real scans** — the generic sweep is genuinely
  three shapes now, so re-check a film set whose marks were tuned against the old blob.

- **2026-07-25 · Model-download consent was unreachable behind the progress modal.** First
  SuperPoint (or LightGlue) run: the stage opens `ProgressModal` (overlay `z-index: 300`)
  and only *then* does the store raise the weight-download prompt from inside the run —
  `ModalShell`'s overlay is `z-index: 200`, so the consent dialog rendered underneath a bar
  stuck at 0% and could never be clicked. Fixed at both levels: `composables/usePipeline.js`
  now resolves consent **before** `openProgress` (`ensureModels`, a no-op once the weights
  are cached; the LightGlue pre-warm is gated on the same SuperPoint/256-d precondition
  `useMatchesStore` enforces, so a run that cannot start still errors before asking for a
  download), and `ModelDownloadModal.vue` stacks its overlay at 400 so the paths that never
  open a progress modal (per-image detect, Smart Select) stay clickable. The store-side
  `ensureReady` guards are unchanged — this was prompt *ordering*, not the gate.

- **2026-07-25 · Run record: the digest becomes a baseline entry.** The owed verification
  runs are all "dataset × settings → numbers", but `summary` carried only the five outcome
  figures — no settings, no seed, no fx trajectory, no resolved gates, no timings — so a
  pasted digest could not be attributed to a run, and a missed target needed the full log
  to diagnose. Producers now record what they were asked to do beside what they achieved:
  · `core/sfm/sfm.js` → `summary.config` (requested knobs, captured **before** the `auto`
  resolutions and the detect-px→native-px scaling mutate `cfg`), `gates` (factor + median
  detection scale + resolved PnP/filter px, recorded even at factor 1 — "no correction
  applied" is the measurement a full-resolution set owes), `initPair` (+ score, degree,
  PnP-ready views, candidates scored, runner-up), `attempts` (seed retries, which attempt
  was kept, per-attempt cams/points — B4's guard turned 19 cameras into 122 and the run's
  own metrics never flagged the bad one), `selfCal` (requested → resolved, staged, per-pass
  mode + reduction reason), `intrinsics` (fx nominal → final + Δ% per sensor),
  `cycleFilter`, `timings`.
  · `image.detectSettings` (persisted, absent ⇒ null) — `detector` + `detectScale` alone
  cannot tell a Balanced run from a Detailed one.
  · `useMatchesStore.matchRun` (session-scoped) — gate accounting + the user knobs; the
  "542 of 1280 pairs gated" class of bug is invisible in any per-pair record.
  · `workers/ops/dense.js` → `depthSummary` (persisted): backend **as requested vs as
  ended** + GPU fallback count, Stage A settings, median s/image, median coverage + cost,
  and the cross-view filter's wall clock *and* bite (median/min kept %, marginal maps) —
  the two numbers TODO ▸ DF asks for.
  · `core/eval/summaryDigest.js` renders Verdict (U6's `buildVerdict`, finally wired) →
  Run config → Health → Offenders → Run details → Diagnostics; `DebugSummaryModal` also
  streams the markdown into `log.ndjson` at debug level. Unknown settings render as
  *absent* rather than as their default. 11 new tests pin the sections against a B4-shaped
  fixture. `npm test` (1137) + typecheck + build green; the digest itself is browser-only
  and unverified there.

- **2026-07-25 · Self-cal identifiability guard reaches the in-registration BA.** The
  2026-07-24 `distortionIdentifiable` fix (radial terms are identifiable only from
  multi-view track redundancy, never from camera count) was applied at one of the **two**
  BA call sites: `sfm.js`'s post-filter passes. `register.js`'s interim + rescue solves
  still gated on the `distortionCalMinCams: 6` camera-count proxy that the same module's
  comment disowns, so a ≥6-camera model built almost entirely of 2-view tracks refined
  `f,k1` against nothing that constrained it. BA lowers its own cost while doing this, so
  the cost-only divergence guard in `runBundleAdjust` passes it, and the fold then bakes
  the bad calibration into the keypoints. Symptom in the SB log (seed retries 3–4): fx
  2389 → 5459, k1 −0.897, one interim BA at 995px RMS — the same runaway B4 already
  records for the P1180211 seed (fx 2389 → 4796, +101%). Now `register.js` computes the
  ≥3-view track share and runs the same predicate: unidentifiable outright ⇒ `'none'`,
  identifiable focal but 2-view-dominated ⇒ radial terms dropped, focal still solved;
  `distortionCalMinCams` demoted to a cheap pre-filter. Reduction logged once per distinct
  reason. Not the cause of any registration count — a diverged retry was already discarded
  by `structuredClone` per attempt, so the damage was contained to the attempt.
  Lives in `core/sfm/register.js` (`identifiableRefine`); pinned by `register.test.js`
  (WS-C1, 4 cases — the 2-view-dominated one fails without the guard).

- **2026-07-25 · Sequential pairing bypasses the subset gate.** The gate's per-run
  bypass ("the pair set was already chosen for overlap, so the gate can only add false
  negatives") was wired only to the `preselect` strategy — `preselectionApplied` was set
  inside that branch alone. **Sequential pairing is the same kind of prefilter**: it has
  already decided which pairs plausibly overlap, using capture order. Worse, a sequential
  chain has no redundancy, so a false veto severs the graph outright rather than costing
  one edge. Measured on the 128-image building set: **542 of 1280 sequential pairs gated**,
  match graph split into 2 components (largest 85/128), 101 images left with zero
  correspondences to the registered set, primary stuck at 65/128 after four seed retries.
  The flag is now `overlapPrefiltered` and covers both strategies. Root cause is a
  threshold calibrated against strongly-overlapping pairs: at the 4% sampling fraction,
  a weak chain link with ~300 true matches expects well under one subset putative against
  a threshold of 8. Found by reading the browser log for the DR verification run.

- **2026-07-25 · Data-relative thresholds: pixel gates and sampled counts.** Three
  defaults were absolute constants whose *meaning* varied with the input.
  · **Pixel gates** (`core/scaleContext.js`, new, 20 tests). Detection runs at
  `maxDim` but keypoints come back in native px, so `ransacThreshPx` 2.0 and
  `reprjThreshold` 4.0 were native-px gates applied to data measured at `1/s` native
  px. On the CA…V film scan (10137px at `maxDim` 2400, `s` ≈ 0.237) the RANSAC gate
  sat *below* the ~4.2px measurement quantum — RANSAC discriminating below its own
  noise floor — while the identical constant is loose on a full-resolution set. Gates
  are now configured in **detection px**: matching resolves per pair (coarser image
  wins), SfM resolves once in `reconstruct()` and injects `detectScaleFactor` so
  retries/secondary models share one factor. `detectScale` persists on the image;
  **absent ⇒ 1 ⇒ bit-identical behaviour**, so old projects and full-resolution sets
  do not move. Reported at info level with the median scale behind the factor; a
  half-downscaled set (median 1, no correction) still warns, which an early
  "factor === 1 ⇒ nothing to say" return had swallowed — caught by a test.
  · **Sampled counts** (`core/features/subsetGate.js` `resolveSubsetGateSize`, 11
  tests). The gate compared a fixed threshold (8) against putatives from a fixed
  200-keypoint sample, but expected yield is `(s/Na)(s/Nb)·M` — ~16 at 1000 kp/img,
  ~3 at 5000, ~0.6 at 25000. The SIFT **Detailed** preset would therefore have vetoed
  nearly every pair and severed the match graph, with the damage surfacing stages
  later as a tiny reconstruction. Sample size now holds `s/√(Na·Nb)` constant (0.04,
  reproducing 200 at the 5000-kp calibration point); `subsetGateSize` becomes a floor,
  the O(s²) ceiling outranks it. Plausibly a second cause of the 2026-07-24 CA…V
  gating (7/10 pairs) alongside the low pair count.
  · **Detection resolution** (`core/features/detectResolution.js`, 15 tests). `maxDim`
  as a fraction of each image's own native size, clamped into a per-preset band.
  **Opt-in** (`maxDimMode`, default `absolute`) so the owed SB/B1 acceptance runs are
  not invalidated. Each band's floor *is* that preset's absolute value, which makes
  "auto never resolves lower than absolute" true at every image size — a test pins it
  against `defaults.user.js`. An earlier draft with a lower floor silently detected a
  2000px image at 1600px; the monotonicity test caught it.
  · **Owed: a browser run.** All three change matching/SfM behaviour on downscaled
  sets and none of it is exercised by the node test environment. Re-run CA…V (the
  motivating set) and SB medium with `maxDimMode: absolute` first, so the pixel-gate
  change is measured in isolation from the resolution change.

- **2026-07-24 · Progress bar: phase-weighted, monotonic, throttled.** Four reported
  problems, four distinct causes.
  · **Sparse "finished" several times** — the bar was the *registered-camera count*,
  which maxes out at the end of registration (~half the run), and every alternate-seed
  retry / secondary model re-ran the whole single-model pipeline, driving that counter
  0→100% again. Replaced by `core/sfm/progressPlan.js`: a weighted phase walk
  (cycleFilter→initPair→register .45→bundle→retriangulate→trackFilter→gcpBundle→
  finalize) plus `scopeProgress`, which remaps each nested sub-run's honest 0..1 into a
  slice of the parent's range (primary 0–0.75, recovery 0.75–0.97). 14 tests; the
  sfm.test.js progress assertion now pins monotonicity + "not full at end of
  registration" instead of the old `[3,3,'Done']` literal.
  · **Numbers churned** — `matchAll` emits once per *pair* (thousands of synchronous
  reactive writes). `usePipeline` now ingests into a plain object and flushes to refs
  on a rAF at ≤10 Hz; labels still flush on change.
  · **Premature 100%** — the modal caps in-flight progress at 99% and only fills on
  the `complete` flag, which `closeProgress` sets for 350 ms as it closes. Bar value is
  a monotonic `fraction`, no longer `current/total`.
  · **uuids in the dense progress text** — fusion's label was `m.uuid.slice(0,8)`; the
  `name` was dropped by the store's densify marshalling (and absent from the depth-map
  index). Store now resolves uuid→name from the image list (derived, not persisted).
  Also: indeterminate mode for the count-less product ops (DEM / cloud edit),
  a sub-item bar from the fractional part of `current` (dense Stage A / fusion),
  "longer than expected" instead of a stuck 0:00 ETA, cancel freezes the fill, and
  Stage A's per-image loop was rescaled to 0–0.85 so the cross-view filter that runs
  *after* it isn't hidden behind a full bar.

- **2026-07-24 · useReconstructionStore split (3 modules under `stores/reconstruction/`).**
  1630 → 1155 lines, **public API byte-identical** (41 exports, none added or
  removed — verified by diffing the setup `return` against HEAD), so none of the 17
  consumers changed.
  · `cloudSerde.js` — cloud ↔ on-disk shape (3 kinds, the CSR view-track layout, two
  legacy shapes). Had **zero** test coverage; now has 16 round-trip tests that
  passed first run, i.e. the extraction was behaviour-preserving.
  · `depthMapCache.js` — the lazy depth-map cache + persistence. Returns its two
  `shallowRef`s rather than hiding them: the pipeline runners assign to them
  directly and a setter would buy nothing.
  · `georeferencing.js` — the SfM→CRS similarity fit and the read-only accuracy
  reports, with the two METHODS.md rules (GCPs beat poses; the reports are
  deliberately non-robust) restated at the top so they can't be optimized away.
  Placement is load-bearing: the factory calls sit exactly where the moved blocks
  were, so every consumer is still below them and nothing hits a TDZ.
  **Also fixed: `vitest.config.js` only globbed `src/core/**` and `src/utils/**`**,
  so a test written anywhere under `stores/` or `composables/` silently never ran —
  which is why the store layer had no tests at all. `src/stores/**` is now included
  (still node env, no Vue plugin: plain `.js` only, no SFCs, no DOM, no live Pinia).
  What deliberately stayed: the pipeline runners (reconstruct / depth / densify /
  mesh / DEM / ortho / editClouds, ~590 lines) are the store's actual job and are
  cohesive — splitting them would just move the store somewhere else.

- **2026-07-24 · ViewerImage split: `useDepthOverlay` + `useSmartSelect`.** 1750 →
  1589 lines. The depth overlay (its own canvas, the colorize-on-import
  normalization, export/clear, the external-change watcher) and SAM2 Smart Select
  (model consent, per-image encode, click points, decode loop, cyan preview) were
  both clean seams. Smart Select's commit is expressed as
  `buildCommitCanvas(w, h)` → "the accepted segment as an OffscreenCanvas ready to
  blit", so the composable never touches the mask canvas, undo stack or store, and
  `commitSmart` keeps its snapshot/blit/export ordering. Both canvases became
  `shallowRef`s so the renderer can read them without a getter (the draw path is
  rAF-driven, not a reactive effect, so nothing tracks them).
  **`useMaskEditor` was considered and rejected**: painting is a three-way coupling
  between pointer input, the mask canvas and the renderer, so the composable would
  have needed ~28 exports and ~8 deps — moving lines without reducing coupling.
  Left in place deliberately; don't "finish the job" without a better seam.

- **2026-07-24 · App.vue split: `useConfirmations` + `useProjectLifecycle`.**
  2623 → 2253 lines. `composables/useConfirmations.js` owns both confirm dialogs
  (`pendingImageDelete` for images, the generic `pendingConfirm` for everything
  else) and the six `confirmRemove*`; `composables/useProjectLifecycle.js` owns
  open/create/switch/delete, folder-backed storage, `.websfm` save+load, and the
  blocking load overlay they all share. Both read stores directly and take only
  the App-level callbacks (tab closing, blanking the Three.js scene) as deps —
  the `useImportRouting` convention. Two things fell out on the way: the
  `clearAll`/`clearSensors`/`clearProjectStores`/`clearViewerScene` quartet was
  written out **7 times** and is now `resetInMemoryProject({ purge })`, and
  `openProject`/`pickDirectory` turned out to have no caller outside the moved
  block, so they are private to the composable rather than re-exported.
  **Verified with the SFC compiler**, not just a green build: `<script setup>`
  compiles an unresolved template identifier to `_ctx.foo` and fails *silently* at
  runtime, so both App.vue versions were compiled and their `_ctx.*` sets diffed —
  0 before, 0 after. Also checked every `clear()` treats `{purge:false}` as `{}`.

- **2026-07-24 · Import-modal chrome deduped.** `CameraImportModal` and
  `GcpImportModal` carried **byte-identical** 151-line stylesheets;
  `FootprintImportModal` a near-copy. Extracted to
  `components/modals/ui/import-modal.css` (`<style scoped src>`), with the four
  genuinely divergent selectors (`.modal` width, `.controls` grid, `.ctrl-crs`
  grid-column, `.preview th`/`td`) declared per modal — a shared value plus a
  per-modal "undo" would be worse than no sharing. ~230 lines removed; repo-wide
  jscpd 1120 → 867 duplicated lines. **Verified by building both versions and
  diffing the emitted per-scope CSS**: camera/GCP effective rules are identical,
  footprint gains only rules for classes its template never renders. Note these
  three are the *import previewer* family, not the `ModalShell` + `modal.css`
  settings family — different chrome on purpose.

- **2026-07-24 · Ribbon command dispatch: trivial cases → data.** `handleCommand`
  in App.vue lost 29 switch cases to three tables: `MODAL_COMMANDS` (22 commands
  whose whole effect is opening a modal), `EVAL_SECTIONS` (Quality-hub deep links),
  and a `view-preset-*` prefix rule. Every remaining case carries a guard, a toggle
  or a side effect, so the table never hides behaviour. Coverage cross-checked
  against every dispatch id in `Ribbon.vue` + `core/help/commands.js` — no
  regression. (The store's flag declarations stay explicit: generating them would
  cost grep-ability and `tsc` inference for no real gain.)

- **2026-07-24 · Fiducial primitives dedup + two live bugs.** `fiducialDetection.js`
  was a copy-paste fork of `fiducialBootstrap.js` and had drifted, producing two
  shipping bugs. (1) **`estimateFilmBounds` crashed on every real scan**: its dynamic
  range was `Math.max(...gray.data)`, which throws `RangeError` past ~124k arguments —
  scans are downscaled to `maxDim` 1536 (~2.4M samples), and the call sits outside the
  op's `try`, so `bootstrapFiducials` rejected wholesale. (2) **peak margin measured
  against a near-duplicate of the peak itself** (the fork dropped the "runner-up must be
  spatially distinct" guard), so unambiguous marks scored margin ≈ 0 and were filed as
  `'two-peaks'`. Both existing tests disabled the margin gate (`minPeakMargin: -1`),
  which is why it hid. Shared math now lives in `core/sfm/fiducialPrimitives.js`
  (`makeFiducialPrototype` / `estimateFrameBounds` / `bestPrototypeHit`, parameterised
  by `strokeFrac` + `polarity`); the two modules are policy layers over it. Also fixed:
  a prototype wider than the image produced an inverted `clamp(v, lo, hi)` range and an
  out-of-bounds search box instead of being skipped. 9 new tests pin all three at the
  shipped defaults (`fiducialPrimitives.test.js`, + one in `fiducialDetection.test.js`).

- **2026-07-24 · One home for image-name matching.** `core/io/nameMatch.js`
  (`makeNameResolver`, `basename`, `stem`). GCP observations, poses, footprints and
  COLMAP import each carried their own copy, each commented "same matching as" the
  others; only COLMAP's handled path components, and the three store copies decided
  per-candidate rather than per-tier (an earlier stem hit beat a later exact hit). Now
  one tiered indexed resolver — exact → basename → lowercase basename → lowercase stem
  — behind a `computed` in each store, so a reconcile pass is O(N+M) instead of O(N·M).
  13 tests (`nameMatch.test.js`).

- **2026-07-24 · ViewerImage overlay: coalesced + batched.** `drawOverlay` is now an
  rAF scheduler over `renderOverlay`; 18 prop watchers plus pan/zoom/paint funnelled
  into it synchronously, and one user action trips several at once (a drag fired a full
  repaint per mousemove). Keypoint drawing: response min/max hoisted into a `computed`
  keyed on the keypoint array instead of a full pass per frame, off-screen points
  culled, and the per-point `fillStyle` + `arc` replaced by one `Path2D` per hue bucket
  (24) — N context-state flushes became ≤24. Not verifiable in this environment
  (browser runtime); tests/typecheck/build pass.

- **2026-07-24 · U5 · Pre-flight checks.** Pure `core/preflight.js` `preflight(state)`
  → `[{ level, code, msg, fix }]` + `hasBlockers()`, ordered blocks-first. Blocks: <2
  images / no keypoints / no verified matches / all pairs disabled (distinct message from
  "none"). Warns: sensor missing focal (labels listed), film sensor without calibrated
  fiducials, dense projection over budget (`formatBytes`), GPU requested but no adapter.
  Every check carries an actionable `fix`; a `block` disables Run. 12 tests
  (`preflight.test.js`). Owed: store assembles the snapshot + gates Run on `hasBlockers`.

- **2026-07-24 · U6 follow-up · dense depth-coverage verdict.** `verdict.js` gained a
  `depth-coverage` finding off `EVAL_THRESHOLDS.depthCoveragePct` (absent on sparse-only
  runs, so it stays silent then), so a thin dense run also gets an actionable verdict.
  Test added; verdict now 12 tests.

- **2026-07-24 · G2 follow-up · `preselection` glossary entry.** Added
  `src/glossary/algorithms/preselection.md` (position / footprint / capture-order pair
  pruning + the subset-gate fallback) — the term `recommend.js`'s match-strategy pick
  leans on. Cross-links to baseline / camera-pose / keypoint / match-graph. `glossary.test.js`
  green (27).

- **2026-07-24 · C1 (pure half) · Hardware-aware memory budget.** `core/dense/memBudget.js`
  gains `deviceBudget({ deviceMemoryGB, jsHeapLimitBytes })` → `{ budgetBytes,
  deviceMemoryGB, source, note }`, deriving from **injected** readings so core stays pure
  (the main thread reads the two Chrome-only globals and passes numbers in): 50% of
  `navigator.deviceMemory` clamped to [1, 6] GB; else 75% of the JS-heap limit; else the
  existing `DEFAULT_BUDGET_BYTES` (Safari/Firefox, unchanged behaviour). `deviceMemoryGB`
  passes through for `recommendSettings`' (U2) dense pick and is null unless deviceMemory
  was the source. 6 tests in `memBudget.test.js`. Owed: main-thread wiring (seed the store's
  dense gate + log `note` + feed U2 + U5 warn).

- **2026-07-24 · U6 · Post-run verdict.** Pure `core/sfm/verdict.js` `buildVerdict(snapshot)`
  → `{ level:green|yellow|red, headline, findings[] }`, each finding `{ level, code, title,
  fix }` with an actionable next-step. Rules: degenerate run (red, short-circuits), low
  registration (via `EVAL_THRESHOLDS.registeredPct`, lists ≤5 unregistered names), p95 ≥
  {3,5}× median ⇒ distortion fingerprint, high absolute median (suppressed if distortion
  already fired), ≥3-view < 20% ⇒ weak geometry, split match graph, large focal Δ. Reuses
  the single `EVAL_THRESHOLDS` table (health.js) + `classify` — the only verdict-local
  number is the residual-tail *ratio* (a shape no single threshold sees). 11 tests incl.
  the B1 fingerprints (282px-tail distortion, 9.5% ≥3-view). The cheap 20% of F8; the rule
  engine is pure so F8 / U4's Run-All summary can reuse it. Owed: browser panel wiring.

- **2026-07-24 · G2 · Glossary entries for load-bearing terms.** Added
  `src/glossary/algorithms/matching-density.md` (Fast vs Full / tiled LightGlue) and
  `cycle-consistency.md` (the rotation-cycle match filter, incl. why it re-admits edges
  after the first self-cal fold); **self-calibration** already shipped. Both cross-link to
  existing entries and auto-link by title/alias. `glossary.test.js` green (26). Figures
  still marked `<!-- TODO(image) -->`.

- **2026-07-24 · U2 · Recommended settings (derived from the U1 profile).** New pure
  `src/core/recommend.js` `recommendSettings(profile, budget)` → `{ detect, match, sfm,
  depthmap, fuse }`, each stage a map of knob→`{ value, reason }` — only the knobs it can
  derive from metadata (unlisted knobs keep their `defaults.user.js` value), so U3 can diff
  against defaults and banner just the deviations. Derives: `detect.maxDim` =
  clamp(round(0.5·nativeLongEdge), 1200, 3200), `detect.maxKeypoints` inverse to set size
  (SIFT units — SuperPoint keeps its own ~2048 cap), `detect.tiling`/`tileSize` on for
  >6000 px scans; `match.strategy` from poses/GPS (→ preselect) / large+sequential-names
  (→ sequential) / else exhaustive; `sfm.refineIntrinsics` stays `auto` with a
  calibration-aware reason; `depthmap.quality` from an optional `budget.deviceMemoryGB`
  (C1) + set size. 13 tests (`recommend.test.js`) incl. pinned **B0** (aerial film →
  3200 px tiled detect / sequential match / low dense) and **B1** (building → 2184 px
  detect / exhaustive). **Design refinement over the TODO sketch:** sequential *matching*
  only fires on a **large** set — contiguous filenames alone don't prove a strip. `npm
  test` (new files) + `typecheck` green. Next: C1 (device budget), then U3 (banner, browser).

- **2026-07-24 · U1 · Dataset profiler (usability track foundation).** New pure
  `src/core/profile.js` `profileDataset({images, sensors, poses, gcps})` classifies an
  image set from metadata only (no pixel reads) → `{ nImages, minDim, maxDim, medianMP,
  kind:film|drone|phone|unknown, hasGps, hasPoses, hasCalibratedDistortion,
  sequentialNames, scale, notes[] }`, every decision carrying a `notes[]` rationale.
  `DatasetProfile` type in `core/types.ts`; 11 unit tests (`profile.test.js`) pin the
  film / declared-film-sensor-wins / drone-make / phone-make / no-EXIF-tentative-film /
  single-EXIF-not-film / sequential-vs-gappy / calibrated-distortion / mixed-resolution /
  scale-bucket / empty cases. `npm test` (new file) + `npm run typecheck` green. No
  importers yet — this is the input `core/recommend.js` (U2) will turn into settings.

- **2026-07-24 · Debug ▸ Project Summary — copy-pasteable reconstruction-health digest.**
  Large runs produce logs too long to skim for "did this succeed?", so a new ribbon entry
  (**Other ▸ Debug ▸ Project Summary**, `summary` icon) opens a small read-only modal with
  a Markdown⇄JSON toggle + Copy button: status roll-up, per-section classified health rows,
  top offenders (worst-RMS + unregistered-with-reason), and sparse/dense run figures.
  It is a *second view* of `useQualityReport().computeHealth`, not new compute — so it can
  never drift from the Quality Report hub. Pure formatter `core/eval/summaryDigest.js`
  (`buildProjectDigest` + `digestToMarkdown`/`digestToJson`, tested); `computeDigest` in
  `composables/useQualityReport.js`; `components/modals/DebugSummaryModal.vue`;
  `debugSummaryOpen` in `useModalsStore`; wired in `App.vue`/`Ribbon.vue`.

- **2026-07-22 · Init selection now scores real one-step growth** — the first browser
  acceptance run exposed two remaining blind spots in the seed heuristic: the good South
  Building seed ranked ninth while only eight candidates were probed, and graph-degree
  reward saturated so degree 20 and 22 were indistinguishable. `core/sfm/initPair.js`
  now probes 24 candidates and scores the number of third images with enough distinct
  triangulated seed-point correspondences for PnP (`growthHealth`), rather than treating
  nominal graph edges as proof that a seed can grow. The per-pair summary and diagnostic
  log carry ready-view support; the synthetic regression holds degree equal while only
  one seed has reusable tracks.
  **Acceptance follow-up:** the next run reached **123/128**, 20,723 points and 0.53px
  median, but through retry 1: the first seed had 20 PnP-ready views and stalled at 3,
  while the retry seed had 23 and reached 123. The initial logarithmic growth factor
  compressed 23:20 to 1.04× and still selected the richer stalled pair; growth is now
  proportional, with that measured 23-versus-20 shape pinned in a regression.

- **2026-07-22 · Init-pair selection: parallax is a gate, not a ranking** — `parallaxHealth`
  (`core/sfm/initPair.js`) no longer ramps from `minInitAngleDeg`; it is flat at 1 between a
  soft band (`initSoftFloorFactor`, default 1.25 ⇒ 2.5°) and the unchanged grazing knee, so
  the seed is decided by cheirality-surviving points, init reprojection and graph
  connectivity. The old ramp turned B4's 5.21° vs 2.68° into a 4.7× factor and picked the
  19-camera seed over the 122-camera one. Seed scores + their factors are now logged per
  candidate and per selection (with the runner-up), and `summary.perPairInitReproj` carries
  `score`/`cheiralKept`/`degree`/`selected`. Regression pinned in `initPair.test.js` (it fails
  on the old curve); METHODS §4.2 rewritten (it also still described a "lowest init
  reprojection" rule the scorer had outgrown).
  **Follow-up the same day — graph degree now outranks point count.** The first SB run
  under the gate regressed to 86/128 (3/128 on the first seed attempt): with parallax flat,
  the score ranked by raw point count and took a 1177-point pair at graph degree 7 over a
  670-point pair at degree 22, because `connectivityHealth` capped at 1 scored degree 22 and
  degree 8 alike. Fixed by (a) clamping connectivity to `[initConnFloor, initConnCeil]` =
  0.4–2 so a hub is *rewarded*, not just a satellite penalised, and (b) taking `√cheiralKept`
  so a big match count cannot dominate. Both pinned by a new `initPair.test.js` case that
  fails on the capped/linear score. **Browser acceptance run owed — see TODO ▸ SB.**

- **2026-07-22 · No-GPS sequential-window matching + clearer LightGlue fallback logs** —
  Sequential pairing now matches a configurable number of following capture-order
  images and can close circular orbits end-to-start (`sequentialPairs.js`, Match
  Features modal/store). LightGlue tiled logs now distinguish a coarse keypoint
  probe, a rejected tile guide, and the ensuing unguided retry.

- **2026-07-22 · Project I/O gathered behind the project picker** — UX follow-up to
  the save/load feature the same day. `ProjectPicker`'s footer is now a primary
  "+ New project" plus an "Open existing" pair whose sublabels finally state the
  file-vs-folder difference (a `.websfm` is *copied into* the browser; a folder is
  *edited in place*) — it was nowhere explained. The per-row ✏/✕ pair became one
  `⋯` (also right-click) menu: Rename · Save a copy… · Move to folder… / Move to
  browser storage · Delete/Remove; the storage entries are shown **disabled with
  the reason** on non-open projects, since both need the project's root
  registered. The ribbon's `Project` + `Project Folder` groups collapsed to a
  single `Save a Copy…` — "Save Project" implied work wasn't autosaved, when the
  only real action is writing a portable copy. `projectStorage`/
  `needsBrowserProject`/`needsFolderProject` dropped from `Ribbon.vue` with them.
  The row menu is teleported to `<body>` (the picker clips, and its centered
  variant is a transformed ancestor that would re-root `position: fixed`).

- **2026-07-22 · Cloud editing: Filter / Crop / Merge (Tools ▸ Point Cloud)** — the
  three placeholder ribbon buttons are now live. Pure math in
  `core/products/cloudEdit.js` (+ 34 tests): `cropCloud` (axis-aligned box, invert,
  per-side-nullable bounds), `filterCloud` — an *ordered* method chain over
  `statisticalOutlierFilter` (grid-accelerated kNN mean-distance, mean+ratio·σ),
  `removeIsolated` (occupancy grid, keeps points rather than merging — unlike the
  dense accumulator's `filterIsolated`), `voxelDownsample` (reuses
  `createVoxelAccumulator`, origin-shifted for CRS-sized coords), `filterRange`
  (elevation + Rec.709 luma band) — and `mergeClouds` (concat + optional seam
  dedupe). Worker op `editCloud` (`workers/ops/cloud.js`), store action
  `useReconstructionStore.editClouds`, three modals, `usePipeline.runEditClouds`.
  Two invariants worth remembering: the op **never throws** (source buffers are
  transferred in, so a rejection would destroy the user's cloud — failures come back
  as `{ cloud: null, error }` with the buffers round-tripped home), and results are
  new `derived: true` clouds that `upsertDenseCloud` refuses to overwrite. Scope is
  `kind:'dense'` only — a sparse cloud carries the view-tracks dense/ortho/COLMAP
  read. Not yet exercised in a browser on a real multi-million-point cloud.

- **2026-07-22 · Project save/load (`.websfm`) + folder-backed projects** — both
  from one enabling fact: the per-project OPFS directory already *is* a
  file-based project format, so save/load is a zip/unzip of it and folder storage
  is a swapped root handle. **Phase 1**: `core/io/projectArchive.js` (pure rules —
  manifest, include/exclude, per-entry compression, entry-path safety, the 4 GB
  ZIP32 pre-flight) + `utils/projectFile.js` (fflate, streaming both ways, save
  picker with a buffered `<a download>` fallback) + `opfs.walkProjectFiles` /
  `writeProjectFile` + `useProjectsStore.exportProject/importProject`. Entry 0 is
  the manifest, so `peekArchiveManifest` rejects a foreign zip / newer format
  after a few kB. UI: Ribbon ▸ Other ▸ Project, `SaveProjectModal` (with live
  size + a cached/derived opt-out), the project picker + first-run New Project
  dialog, and drag-and-drop (magic bytes + manifest peek, so a COLMAP `.zip` is
  never mistaken for a project). **Phase 2**: `opfs.setProjectRoot` registry +
  `utils/handleStore.js` (IndexedDB — a directory handle is cloneable, not a
  string) + `core/io/folderProject.js` (storage flag, the open/reconnect/repick
  state machine, adopt/new-folder verdicts, copy verification) +
  `NewProjectModal` storage choice, `FolderReconnectModal`, picker badges,
  "Open project folder…", and verified-copy migration both ways. websfm never
  deletes files on the user's disk; only the OPFS source tree is dropped after a
  migration, and only once file count *and* bytes match. **Not runtime-verified**:
  OPFS, File System Access and IndexedDB need a real browser — `npm test` (869)
  + `npm run typecheck` + `npm run build` pass, and the archive round trip is
  covered against an in-memory OPFS fake plus the independent `utils/zip.js`
  writer, but nothing here has been exercised in Chromium yet. New dep: `fflate`.
  Where it lives: `core/io/projectArchive.js`, `core/io/folderProject.js`,
  `utils/projectFile.js`, `utils/handleStore.js`, `utils/opfs.js`,
  `stores/useProjectsStore.js`. (`plan-project-save-load.md` deleted per the
  four-docs rule.)

- **2026-07-21 · Glossary content pass** — the 8 stub entries (descriptor, sift,
  track, baseline, fundamental-matrix, focal-length, principal-point, depth-map)
  are written out; 18 new entries added across a new `georeferencing/` topic
  (ground-control-point, georeferencing, coordinate-reference-system) plus
  sensor / camera-pose / ground-sample-distance / fiducial-marks, triangulation /
  homography / pnp / lowe-ratio-test, structure-from-motion / match-graph /
  self-calibration, patchmatch / photometric-consistency / point-cloud, and mesh.
  36 wanted figures are recorded in-place as `TODO(image)` comments
  (`grep -rn 'TODO(image)' src/glossary`) — none exist yet, so the entries render
  text-only until they are drawn. `<GlossaryTerm>` wired into Detect / Match /
  Reconstruct / DepthMaps / Dense / Mesh / DEM / Ortho modals. New
  `glossary.test.js` content block pins id↔filename, non-empty title/summary/body,
  and that every `help:` cross-link resolves — it caught a nested `-->` in the
  schema header that had silently broken `reprojection-error.md`'s frontmatter.

- **2026-07-21 · South Building run-driven hardening** — the 128-image medium
  run (86 registered, 13,942 sparse points, 5.96M dense points) drives four
  guarded improvements: final sparse BA removes gross tracks before its first
  global solve; WebGPU depth setup reports cached `device.lost` details when an
  error scope collapses and the dense worker remains pinned to WASM for the run;
  depth-filter diagnostics use image names, retain per-map survival stats and warn
  for <1%-survival marginal maps; sparse summaries persist coherent
  `unregisteredComponents`. `sfm.js` now reconstructs viable stranded components
  with a primary overlap halo; `multiModel.js` accepts a merge only after shared-camera
  position/rotation/focal/radial/scale gates, otherwise the store persists a named
  non-main secondary sparse cloud. The first browser rerun exposed seed-lock rather
  than a bad merge (primary 3/128; merge rejected): primaries below 50% now retry up to
  four excluded initial pairs, keep the largest model, and suppress secondary recovery
  if every retry remains below 25%.

- **2026-07-20 · FDR — detection/calibration separation** — **Detect
  Fiducials** is now a calibration-free image task. `core/sfm/fiducialDetection.js`
  searches anonymous corner and side slots with Generic/right-angle/45°/Frame
  families, polarity and tolerance controls; the worker performs coarse detection
  plus native-resolution refinement. Batch-relative consensus and anonymous donor
  patches retry incomplete scans without reading metric marks. Accepted centres
  persist as `image.fiducialDetections`; uncertain centres stay in an explicit
  accept/reject queue, and confident frames can generate background masks.
  **Calibrate Fiducials** is a separate ribbon/sensor command and modal backed by
  `core/sfm/fiducialCalibration.js`: certificate or batch layout,
  conformal/affine/projective fitting, slot identity mapping, residual validation,
  focal/principal-point fields and `sensor.fiducialCalibration`. Legacy projects
  migrate on restore. Sparse and dense join detections to calibration only for
  interior orientation; uncalibrated detections remain viewable and do not affect
  reconstruction. Automated tests/typecheck/build are the code acceptance;
  representative real-scan browser acceptance remains tracked in TODO.

- **2026-07-20 · FDA — autonomous fiducial bootstrap** — film scans no longer
  require a hand-marked reference. `core/sfm/fiducialBootstrap.js` generates
  multi-scale Generic/right-angle/45° prototypes, measures strong film bounds for
  Frame mode, maps the calibrated layout under an explicit batch orientation and
  refines centres in native-resolution worker crops. `bootstrapFiducials` is wired
  through the compute client and `useImagesStore`; results stay buffered behind the
  existing score/population/affine gates. The strongest safe scan automatically
  donates real ZNCC templates to retry failures; the old marked-reference mode
  remains available. `FiducialDetectModal` exposes family/orientation and failed
  rows continue into the viewer's manual + ghost-guide workflow. Verified: 807
  tests, typecheck and production build; browser acceptance on representative real
  scans is still owed (tracked in TODO).

- **2026-07-20 · FD — auto-detect fiducial marks on film scans** — mark the
  fiducials once on one reference image per film sensor, then measure them on
  every other image of that sensor by ZNCC template matching (coarse→fine→
  sub-pixel). Pure math + QC gates in `core/sfm/fiducialDetect.js`
  (`FIDUCIAL_DETECT_TUNING` co-located); worker ops `prepareFiducialTemplates` /
  `detectFiducials` in `workers/ops/detect.js` (ImageBitmap + source-rect crops —
  never a full-res raster of a 10k×10k scan); orchestration in
  `useImagesStore.autoDetectFiducials` (buffered detections, one `sync()`);
  user knobs `FIDUCIAL_DETECT_DEFAULTS`; UI `FiducialDetectModal.vue` reached
  from the film-sensor fiducial editor. Method + QC rationale in METHODS.md §5.1.
  Three findings worth keeping: (1) `downscalePatch` could return an **even**
  template size, making `half` a half-integer and every ZNCC read a fractional
  array index — NaN laundered by the zero-denominator guard into a plausible
  score of 0, which with the shipped defaults (65px ÷ 8 → 8) would have zeroed
  the whole coarse pass; sizes are now forced odd and `znccAt` floors defensively.
  (2) The planned whole-image rotation probe cannot work — an 8px coarse template
  over ~1.5M positions hits spurious ZNCC ≈ 1.0 for every k — so each k is probed
  in its own rotated *predicted window*, scored across all marks, and accepted
  only if it beats every alternative (a tie ⇒ k=0, since identical marks in a
  symmetric layout are genuinely undecidable). (3) The affine drop-and-refit
  requires ≥5 marks: with a 4-mark camera any 3 points fit a 6-DOF affine
  exactly, so the outlier is unlocalizable and the image fails instead.
  **Not browser-verified** — the modal flow and both worker ops need
  OffscreenCanvas/`createImageBitmap`, which this environment cannot run.

- **2026-07-20 · Logic/robustness audit fixes** — reference-raster sampling now
  treats failed CRS resolution as runtime-only/retryable state and refuses unsafe
  identity fallback; map probes use the tuple-shaped raster bounds; rotated,
  sheared, and perspective GeoTIFF transforms are rejected explicitly. Blank GCPs
  use `z:null` while a real `z:0` is preserved, Quality Overview leaves match-graph
  health missing until matching has a terminal result, and a crashed compute worker
  rejects only its own calls before its pool slot is replaced. Regression coverage
  lives in `utils/tiff.test.js`, `core/io/gcp.test.js`,
  `core/eval/matchGraph.test.js`, and `utils/computeClient.test.js`; 775 tests,
  typecheck, and production build pass.

- **2026-07-20 · COG writer, Phase 1 (plan-reference-raster-rearchitecture)** —
  `writeCog(spec)` in `core/products/geotiff.js` alongside `writeGeoTiff`: internally
  tiled, multi-IFD (full resolution + halving overviews down to a single tile), COG
  layout rules honoured (all IFDs before all image data, overview tile data first,
  full-res last, offsets ascending). Unlike `writeGeoTiff` it takes a **TypedArray**,
  not raw bytes — it has to interpret pixels to tile and downsample. Overviews are
  box-averaged with nodata skipped (a cell whose whole source block is nodata stays
  nodata); decimation would render a noisy DEM as noise. Uncompressed only: per-tile
  DEFLATE would need the injected async callback for every tile of every level, and
  the plan's open question says measure first. Single-tile levels keep TileOffsets/
  TileByteCounts **inline** (count·size ≤ 4) — externalising them makes a reader take
  the offset as a pointer to the offset. 13 tests round-trip through the real `geotiff`
  reader (pixel-exact full-res, int16/uint16/float32, 6-band interleave, non-multiple
  dims, nodata-aware averaging, overview selection on a downscaled read, byte layout).
  Pure + sync; no store, no UI, nothing wired to it yet. Phases 0 and 2–6 are browser
  work and remain open.

- **2026-07-18 · Reference rasters on the map, A-4 (plan-external-reference-data)** —
  per-raster "Display on map" toggle in the Reference Data right-click menu, an accent
  ◉ row indicator (the state is otherwise invisible until you reopen the menu), and an
  opacity slider in the row's expanded detail, shown only while the layer is up.
  `onMap`/`opacity` persist in `external/index.json` as view state (absent on older
  projects ⇒ hidden at full opacity, no file rewrite). `ViewerMap` gains a raster
  `LayerGroup` above the basemap and below every project vector layer; the group is
  diffed rather than rebuilt so dragging the opacity slider doesn't tear down and reload
  the image. **The layer renders `previewDataUrl`, not the pixel plane** — it never calls
  `ensureRasterLoaded`, so a REMA tile on the map costs no decode and the lazy-loading
  invariant holds; and the extent is handed to OL in the raster's *native* CRS so
  reprojection is on-the-fly and `handleSetCrs` needs no resampling. Sidebar list order
  is draw order. **Not browser-verified** — it is almost entirely OpenLayers runtime.
- **2026-07-18 · Review fixes: viewer up-vector, GCP seed/step guards, residual frame** —
  five correctness fixes from a working-diff review.
  (1) Two different `estimateUpFromCameras` existed; the one `Viewer3D` used averaged the
  cameras' *image-up* axes, which is horizontal on nadir aerial — an Antarctic block
  framed 90° tilted. `core/sfm/geometry.js` now weighs that candidate against the
  viewing-direction one using the camera-centre covariance (thin axis = vertical,
  dominant axis = travel), falling back to the historical answer when ambiguous;
  `core/products/projection.js`'s copy is renamed `estimateUpFromViewingDirs` with its
  DEM/ortho null semantics deliberately unchanged.
  (2) `refineGcpPoint` accepted a Gauss-Newton step that made a view unprojectable —
  the lost view's error dropped out of the sum, so a worse point looked cheaper; the
  step is now refused.
  (3) `triangulateGcp`'s robust path seeded from the single widest-baseline pair, so a
  misclick *inside* that pair poisoned the basin. Measured: a 300 px misclick on the
  seed pair landed the point **270 world units** from truth (600 px → ~7e5) even though
  stage 2 rejected it. Now seeds from the 3 widest pairs by Huber cost — every magnitude
  recovers exactly. Regression test pins it.
  (4) `useQualityReport.buildExportReport` ran the GCP report twice (re-triangulating
  every GCP, and able to straddle a mid-edit change); `computeHealth` returns the reports
  it already pulled.
  (5) The image-view residual overlay drew BA-pinhole-frame vectors on the raw image.
  New pure `core/sfm/displayFrame.js` (`makeCanonicalToScan` + the `distortComposed`
  that `workers/ops/dense.js` now shares) maps both endpoints back; `mag` stays the
  pinhole-frame error so the overlay agrees with the tables.
  Also: `Viewer3D` rebuilds OrbitControls instead of poking its private `_quat` cache;
  `CloudRows` hides the camera badge/detail row on dense/mesh clouds (always an empty
  Map) and shows the imported chip alongside `main` rather than instead of it; removed
  the unused `needsGeoref`/`georefReady` ribbon gate.
- **2026-07-18 · Sidebar provenance taxonomy (plan-external-reference-data WS B)** — split
  the type-based "Point Clouds vs Products" sections by **provenance + role**:
  `ReconstructionSection.vue` (all sparse clouds, computed or COLMAP-imported),
  `ProductsSection.vue` (computed dense/mesh + DEM/ortho), new `ReferenceSection.vue`
  (imported clouds + imported rasters). Shared row rendering extracted to
  `CloudRows.vue`; Sidebar owns the three computeds over the already-persisted
  `imported` flag. `useReconstructionStore` now sets/persists/restores `imported` on a
  COLMAP-imported *sparse* cloud too, which renders an "imported" chip. No migration.
- **2026-07-18 · External reference rasters, A-1…A-3 (plan-external-reference-data)** —
  import a georeferenced DEM/orthophoto you did not produce and use it as ground truth.
  New pure `core/io/rasterKind.js` (DEM-vs-ortho classifier → `{kind,confidence,reasons}`),
  `core/io/rasterSample.js` (**the** bilinear/nodata sampler; `core/eval/demCheck.js`
  reduced to an adapter over it), `core/io/rasterSource.js` (the `RasterSource` accessor
  boundary that makes remote-COG a second implementation, not a rewrite). New `parseRaster`
  worker op (geotiff decode + classify + preview off-thread, plane transferred), new
  `useExternalStore` (index-only restore + `ensureRasterLoaded`, native-CRS rasters with
  reprojected *queries*, `verticalDatum`/`verticalAccuracy` first-class). Dropped/picked
  TIFFs now fork through `forkGeoreferencedRasters` before the image path. `ProductViewer`
  generalised to any raster descriptor (computed product *or* imported raster) and gained a
  `raster:` tab. GCP **Fill Z / Check Z from reference DEM** in the GCP table — Fill refuses
  when the dataset declares no vertical accuracy, Check flags a mean-dominates-scatter
  offset as a probable vertical-datum mismatch. Hillshade math extracted to
  `core/products/colormap.js` `hillshadeRgba` (shared by both previews).
  **Not browser-verified** — see the plan file's remaining phases A-4…A-7.

- **2026-07-17 · Quality Report hub (plan-eval-quality-hub WS0–WS6)** — replaced the eight
  isolated Evaluate modals with one `QualityReportModal.vue` (left section nav + Overview
  landing page; greyed nav entries with a prerequisite hint are the discoverability surface
  that replaced the per-button ribbon gating). Section bodies extracted to
  `components/modals/eval/Eval{Overview,Sparse,Calibration,Accuracy,Matching,Dense,Coverage}Section.vue`
  (old 8 modals deleted; `useModalsStore` 8 `eval*Open` flags → `qualityOpen`+`qualitySection`;
  old command ids deep-link into hub sections). New pure core (each +test): `core/eval/health.js`
  (`EVAL_THRESHOLDS` single threshold table + `projectHealth(snapshot)` overview rows),
  `core/eval/coverage.js` (top-down `coverageGrid`), `core/eval/compareRuns.js` (`diffSummaries`),
  `core/products/report.js` (`buildReportHtml` self-contained export). Extended
  `core/eval/matchGraph.js` (`bridgeEdges` articulation edges + `componentIndex`),
  `core/eval/imageStats.js` (`unregisteredReason` + `imageResidualVectors`). Assembly composable
  `composables/useQualityReport.js` feeds both the Overview and the export from one snapshot.
  WS2 fixes: consistent derived Sparse tiles + labelled run-summary strip, per-image
  keypoint/edge columns + unregistered reasons, graph component membership + fragile links,
  pose XY/Z split, depth-coverage split + real median-depth GSD (`depthMapCodec` index → **v3**,
  adds `depthMedian`; v1/v2 fall back). WS3 residual overlay: `showResiduals` in
  `useImageViewSettings` + ribbon toggle + `ViewerImage.vue` ×25 amplified vectors; Sparse row
  click opens the image with the overlay on. WS5: `summaryHistory` (last 5) + `healthDirty` in
  `useReconstructionStore` (persisted in `reconstruction.json`). WS6 = F8 (see Later). All
  numbers stay derive-from-the-cloud so an imported COLMAP model works. `npm test` (673) /
  `typecheck` / `vite build` green; **all UI unverified in-browser** (headless) — see TODO ▸ QH.

- **2026-07-17 · Evaluate ribbon tab: 8 quality/accuracy views** — wired all eight
  placeholder commands in the Evaluate tab (`Ribbon.vue`) to read-only modals over
  existing state (no new pipeline stage; only eval-gcps writes, via GCP enable/disable
  toggles). Shared UI: `components/modals/ui/DataTable.vue` (sortable, nulls-last,
  `cell-<key>`/`expanded` slots) + `StatTiles.vue`, table/tile classes in `ui/modal.css`.
  Pure derive-from-the-cloud modules under `src/core/eval/` (each +test): `reconStats.js`
  (track-length histogram + reprojection stats), `imageStats.js` (per-image residuals),
  `calibration.js` (radial curve + focal delta), `matchGraph.js` (union-find graph health),
  `demCheck.js` (bilinear DEM-at-GCP sampler). Modals: `ReconReportModal`, `ImageErrorsModal`,
  `CalibrationModal`, `GcpAccuracyModal`, `PoseResidualsModal`, `MatchGraphHealthModal`,
  `DepthCoverageModal`, `DemGcpCheckModal`. Store: `poseResidualReport()` added to
  `useReconstructionStore`; `depthMapCodec` index bumped to **v2** (per-map `validPx`/
  `depthMin`/`depthMax` written at Stage A so Depth Coverage never re-hydrates planes;
  v1 still reads, shows "—"). New `georefReady` Ribbon prop (+ `needsGeoref` gate) for
  eval-poses. **Intentionally deferred** (the three F13 "known gaps", nobody may miss
  them): registration-pass-per-image + self-cal-drift-per-image on eval-images, and
  cycle-filter/spread-gate kill counts on eval-match-graph — each would need a small new
  `summary` field. **Not yet browser-verified** — the modals need a manual run; 645 unit
  tests + typecheck + production build pass. Fold into the F8 report + TODO ▸ V baseline
  session (these views display exactly the numbers §Baselines wants recorded by hand).

- **2026-07-17 · Dense: cross-view consistency filter (sky/vegetation freckles)** —
  sky and bush pixels reached the dense cloud as freckles because **every** outlier
  filter ran at fusion, per-point, and fusion's "geometric consistency" check was too
  weak to see them: it searched a `(2·consistencyPx+1)²` = 5×5 window in each source
  and accepted if *any* pixel there had a depth within 1%. A bush is a cloud of depths
  spanning a range, so some pixel in a 5×5 window is near the right depth by chance —
  it passed trivially. Nor could any *cost* gate help: vegetation is strongly textured
  (genuinely high NCC) and gradient sky correlates at any depth. New
  `filterDepthMapsGeometric` (`core/dense/mvs.js`) is COLMAP's `filter` pass — a true
  forward–backward reprojection through **one** source pixel (`maxGeomCost` px,
  `minConsistent` views) plus an absolute `minNcc` floor. Runs once after the Stage A
  loop in `workers/ops/dense.js` and zeroes pixels **in the maps**, so the persisted
  planes and the ortho (z-buffer reuse) are cleaned too. Judged against *unfiltered*
  planes via staged masks — in-place filtering would cascade drops in map order. Knobs
  in `DEPTHMAP_DEFAULTS` + `DepthMapsModal`; fusion's filters kept as a second line of
  defence. COLMAP's second `geom_consistency` *optimisation* pass (a completeness win,
  ~2× Stage A) is deliberately deferred — see TODO. **Not yet measured on real data**:
  the before/after baseline below is owed.
- **2026-07-17 · GCP triangulation: N-view refinement + robust guides** — a GCP's
  3rd..Nth mark did nothing: `gcpTriangulation.js` DLT-triangulated the
  widest-baseline *pair* and used every other observation only as a reprojection
  diagnostic, so marking a GCP in eight images predicted exactly what the best two
  did (and one misclick in the chosen pair silently poisoned it). The pair now only
  **seeds** a Gauss-Newton refinement over all observations (`refineGcpPoint`, pure
  JS — a handful of points, no WASM needed). `opts.robust` adds outlier rejection,
  taken by the guide path (`gcpGuides.js`) and deliberately *not* by the georef fit /
  accuracy report. **The lesson worth keeping**: the first cut of robust mode was a
  median cut on a plain-LSQ fit's residuals and rejected nothing — LSQ has a
  breakdown point of zero, so the outlier drags the point toward itself until it
  stops looking like one (measured: a 4-view GCP with a ~108px misclick fits to
  residuals 42/11/50/27, median 34, 3× cut 103 > the outlier's own 50). Rejection now
  runs a Huber/IRLS fit *first* and cuts on **its** residuals, which separate ≈0 vs
  ≈108. Method + numbers in METHODS.md §6.5. Guide-vs-mark stays advisory —
  no snap-to-guide. Observability: the guide label shows "7 of 9 marks", and one
  **info line per placed mark** (`logGcpMark`, App.vue) reports the guide-vs-click
  gap. Two earlier cuts were removed for a shared reason worth remembering — both
  logged inside `gcpGuides()`, which recomputes on every tab switch, selection and
  re-render, so they narrated the app's re-rendering instead of the user's work
  (movement-since-last-prediction only ever printed "first prediction", since marking
  retires that image's guide; the per-recompute lines then repeated whatever was
  already on screen). Also fixed en route: guides gated on `showGcps || gcpEdit` kept
  drawing after edit mode was switched off (enabling gcpEdit force-enables showGcps),
  and two watchers feeding one refresh double-logged every line (now coalesced per
  tick).
- **2026-07-17 · SIFT: incremental scale-space + vectorised blur (and the
  over-blur bug it uncovered)** — detection was ~7 s on a 5000px scan; the pyramid was
  the reason. `blur()` re-blurred the octave base with the *full* σ_i at every level
  (124 taps/octave vs 82 incremental, `crates/sift/src/lib.rs`), and neither pass
  vectorised: the horizontal one clamped a data-dependent index in its inner loop, the
  vertical one strided by `w` on its innermost index, so LLVM declined both despite
  `simd128` being on globally. Both passes now split into clamped borders + an
  unclamped contiguous interior (`conv_row_interior`, `fma_scaled`, explicit f32x4 with
  a scalar fallback, same shape as `crates/matching`); the vertical pass accumulates
  into one row buffer with the clamp hoisted, which also drops it from 2·radius+1
  strided rows in flight to one. B-detect above: 6.3× on a full octave, 3.1×
  end-to-end. **The real find was a correctness bug**: making the incremental build
  correct forced the octave-base question, and the old code was re-blurring a base that
  already carried σ0 — over-blurring every octave above the first by √2, which flattened
  DoG contrast so coarse-scale extrema failed `contrastThreshold` and vanished. On a
  smooth synthetic at threshold 0.02 the old build found **0** keypoints where the new
  one finds 18278 (at 0.003 both find ~18.4k — the extrema were always there, the
  contrast gate was eating them). Real photos kept firing in octave 0, so this never
  looked like breakage — just quietly missing large-scale structure. Verified in the
  browser: detection faster, keypoints look right. See METHODS.md §2. **Gotcha worth
  keeping**: `cargo test` compiles the *scalar* fallbacks (x86 has no simd128), so the
  f32x4 kernels are unexercised by the suite — `scripts/simd-parity.mjs` runs the built
  wasm under Node against the crate's `parity_digest` test on identical input; the two
  digests must match exactly.

- **2026-07-16 · Registration stall: let the rescue fire at the 2-camera seed
  (WS-A + WS-C)** — four baselines (B3 below) showed matching quality moving 12×
  between the building set's SIFT and LightGlue runs while the result did not move at
  all: **2/50 cameras both times**. The bottleneck was registration, and specifically a
  deadlock: uncorrected radial distortion (24mm full-frame, self-cal later measures
  k1 ≈ −0.025 ≈ 58px of corner shift) is absorbed by the 2-view seed, so init
  reprojection looks perfect (median 1.77px) while every third-view PnP misses the
  acceptance ratios — and the designed mitigation, in-registration self-cal at
  `distortionCalMinCams` = 6 cameras, can never engage because the model never leaves
  2. The stalled-model rescue (retriangulate + one relaxed sweep) is exactly the escape
  hatch, and it saved the TMA+LightGlue run, but its guard was `cameras.size >= 3` —
  unreachable from a 2-camera stall. Relaxed to `>= 2` (`core/sfm/register.js`); the
  inner focal-solve guard stays `>= 3` (f/k1 are not observable from 2 views), so a
  2-camera rescue is retriangulation + one relaxed sweep and `rescued` keeps it
  one-shot. Rescue log line now reports the stall's camera count and no longer claims a
  focal solve it skips. Also (WS-C): post-filter self-cal is skipped below 3 cameras
  with a reason line — the TMA runs' 2-camera models flipped k1 between passes
  (+0.032 → −0.010) and tripped the composed-fit runaway warning every time, i.e. BA
  was fitting noise into a destructive keypoint fold; and `resolveK`
  (`core/sfm/reconstruction.js`) now ranks an explicit **film format above the scan
  pixel pitch** — a certificate is measured, a pitch is inferred and is the value that
  goes wrong (both TMA runs warn `implied film width 253mm`). New `register.test.js`
  (5 tests, mocked ctx) pins the guard, the skipped intrinsics solve, one-shot-ness,
  and the `rescueStalled: false` / no-linked-images negatives; 3 of them fail on the old
  `>= 3` guard. `npm test` (604) + `typecheck` green. **Not verified: the recovery
  itself.** A synthetic scene would not reproduce the stall (a noise-free co-visible
  rig registers all 8 cameras even at k1 = −0.35), and the browser re-baselines cannot
  run headlessly — see TODO ▸ Now ▸ RS. WS-B (obs-aware earlier f,k1) deliberately NOT
  built: it is gated on those baselines showing WS-A alone is insufficient.

- **2026-07-16 · Guided GCP marking (epipolar guides in the image view)** — marking
  a GCP across dozens of images was unassisted hunting, even though the posed
  cameras already say where it must be. Now, for GCPs not yet marked on the open
  image: ≥2 other observations ⇒ a ghost cross-hair at the triangulated-and-
  reprojected pixel; exactly 1 ⇒ the epipolar line the mark must lie on (drawn for
  the selected GCP only). Pure math + F-from-poses in `core/sfm/gcpGuides.js`
  (`fundamentalFromCams`/`epipolarLine`/`clipLineToRect`/`closestPointOnLine`/
  `gcpGuideForImage`/`gcpGuidesForImage`), 16 unit tests on a *rotated* 3-camera rig
  (an identity-R rig hides transpose/convention bugs); store entry point
  `useReconstructionStore.gcpGuides(imageId)`; `activeImageGcpGuides` + two watchers
  in App.vue; dashed-green rendering in `ViewerImage.vue`. Method + the raw-pixel/
  pinhole frame caveat in METHODS.md §6.4.
  **No snap-to-guide, by design** (rejected, not deferred — METHODS.md §6.4): a
  guide is derived from the reconstruction, so snapping a mark onto it would feed
  the model's own estimate back in as ground truth. GCPs must stay independent
  evidence that can *correct* the model; the guide-vs-click gap is the diagnostic,
  and it matters most exactly when the reconstruction is wrong. The user's mark
  stays the user's. (`closestPointOnLine` was written for snap and deleted with
  it — don't reintroduce.)
  Verified: `npm test` (599) + typecheck + `npm run build` green; **overlay
  rendering confirmed in a browser by Felix** (the one part unit tests can't
  reach).

- **2026-07-16 · Depth maps persist across a project reopen (P3, persistence half)** —
  Stage A output was the one expensive artifact that died on reload: only its
  display PNG was saved, so `depthMaps` came back empty and Densify/Ortho were
  gated off pending a full (minutes/image) re-run. Now persisted to `depthmaps/`
  — tiny `index.json` + per-image binary sidecars `{uuid}.{depth|cost|nrm|rgb}.bin`,
  mirroring the reconstruction cloud sidecars. Pure codec in
  `core/dense/depthMapCodec.js` (serialize/deserialize + index stamping + size
  math, unit-tested); I/O in `utils/opfs.js` (`saveDepthPlanes`/`loadDepthIndex`/
  `loadDepthPlanes`/`saveDepthIndex`/`deleteDepthPlanes`); wiring in
  `useReconstructionStore` (`persistDepthMaps` after Stage A,
  `ensureDepthMapsLoaded` from densify/ortho, `loadDepthIndexIntoMeta` on restore).
  **Load is lazy** — restore reads only the index into `depthMapsMeta`; the planes
  (hundreds of MB) hydrate on first use, so opens that never densify don't pay.
  `depthMapCount` moved to a store getter counting saved-but-unhydrated maps, or
  the reopened project would show both stages gated despite the data being there.
  Staleness: the index stamps the main sparse cloud's `id` + `createdAt`
  (`upsertSparseCloud` carries the id forward on a rebuild but refreshes
  `createdAt`, so `createdAt` is what detects a re-run) and a mismatch discards the
  set; an unstamped index is treated as stale. A missing map (its image was
  removed) drops alone and re-stamps the index; a *corrupt* one (truncated/wrong
  size) discards the whole set rather than fusing a partial plane. The densify
  error path now reloads from disk instead of demanding a Stage A re-run.
  Types: `DepthMap`/`DepthMapMeta` in `core/types.ts`. `npm test` (583) +
  `typecheck` green; **browser paths unproven — see TODO ▸ Owed runtime
  validations** (incl. measuring real bytes/image; the ~50 MB/image at medium
  quality is projected, not measured). Remaining P3 work: quantization + per-image
  spill.

- **2026-07-16 · LightGlue concurrency freeze fix + tiled guided matching (LG, plan `PLAN-lightglue-tiled-matching.md`)** —
  Part A: ORT sessions are not reentrant, so LightGlue runs are now serialized two
  ways — a module-scoped promise-chain mutex (`serialized` in
  `core/features/lightglue.js`) and serial store dispatch (`useMatchesStore.matchAll`
  concurrency 1 for LightGlue); cancel hard-terminates the pool
  (`terminateAll`, wired in `usePipeline.js`). Part B: coarse-to-fine
  homography-guided tile matching (`core/features/guidedTiles.js` pure math +
  `matchLightGlueTiled`) matches at full keypoint density in bounded memory,
  opt-in via `lgTiled` (Fast/Full toggle in `MatchFeaturesModal`); routed on
  `args.tiled` in `workers/ops/match.js`, defaults in `defaults.user.js` /
  `tuning.js`. `npm test`/`typecheck` green; browser-verified (no freeze, serial
  progress, tiled matching works).

- **2026-07-16 · Native TIFF decoder to speed up ingest (TC) — SHIPPED + verified** —
  new `crates/imagecodec` (the `tiff` crate → interleaved 8-bit RGBA), injected as
  the `decoder` into `tiffToDisplayBlob` (`src/utils/tiff.js`) by `workers/ops/tiff.js`
  (lazy wasm init like the mesh op), with a full geotiff.js fallback on any unsupported
  variant. Motivated by per-stage timing added the same day: on the CA213732V strip
  (10137×9600 ≈ 97 MP grayscale scans) **decode was ≈34 s of ≈39 s ingest (87%)**.
  **Browser-verified 2026-07-16** on the same 5 scans, `wasm` backend confirmed active:
  **decode ≈34 s → ≈1.0 s (~34×); total ingest ≈39 s → ≈5.3 s/image (~7.4×)** — see
  §Baselines B0-ingest. Correctness signal: the compute-PNG blob sizes came out
  byte-identical to the geotiff path (103.1/108.2/… MB), i.e. identical decoded pixels.
  Rust round-trip tests (gray8/rgb8) + full JS suite + typecheck + vite build green.
  **New tall pole: the canvas PNG encode (~4 s, ~75% of the remaining 5.3 s)** — a Rust
  grayscale PNG encoder is the obvious follow-up if ingest needs to go lower (TODO ▸ TC).

- **2026-07-16 · SfM quality overhaul WS1–WS5 (plan modular-cuddling-beaver)** —
  five workstreams toward COLMAP/Metashape parity, on branch `sfm-quality-overhaul`.
  **WS1 matching acceptance** (`core/features/pairGate.js` new): decoupled the three
  gates `minMatches` conflated — it stays the accept + H-skip floor, new
  `MATCH_TUNING.rawSkipFloor` (clamped ≤ minMatches) drives the raw-putative skip. Added
  **weak pairs**: a valid F with ≥ `weakMinInliers` inliers below the accept gate is kept
  (`entry.weak`, persisted) as a registration-only bridge — fed ONLY to `register.js`
  PnP correspondence collection (`corrPairs = strong + weak`), never seeding init/cycle
  filter/triangulation. `verifiedPairs`/`matchStats` exclude weak; MatchFeaturesModal cap
  500→100 + warn-box. **WS2 self-calibration** (`crates/reconstruction/src/bundle.rs`,
  wasm rebuilt): `refine_mode` enum → **bitmask** (1=f,2=cxcy,4=k1,8=k2,16=k3), full
  radial polynomial `1+k1r²+k2r⁴+k3r⁶` with analytic Jacobians (g ≡ k1+2k2r²+3k3r⁴),
  output intrinsics nCam×5→×7. JS: `refineModeMask` parser; staged schedule
  (`core/sfm/selfCalSchedule.js` — base f,k1 during registration, escalate k2/cx,cy/k3 in
  post-filter passes by cam+obs counts); **fold rework** (`core/sfm/selfCalCompose.js` —
  pristine-keypoint snapshot + linear-LSQ composed {k1,k2,k3} bag replacing the wrong
  additive-k1 sum; monotonicity guard warns on runaway). Dense applies `dist` then a
  second `selfCal` bag sequentially. **WS3 cycle filter** (`core/sfm/cycleFilter.js`):
  `protectBridges` (never sever the graph — provably a no-op for the current cycle-edge
  drop gate, kept as insurance) + `reevaluateDroppedEdges` (weighted-support re-vote); a
  final second-chance sweep re-fits F on folded keypoints, re-admits mis-dropped edges on
  the self-calibrated graph, and re-runs registration (rescue off). **WS4 dense filters**
  (`core/dense/mvs.js`): min-triangulation-angle (kills ~0°-parallax sky, default 2°),
  grazing-incidence reject (edge-on vegetation, default 80°, fallback normals inert),
  post-fusion isolated-cell removal (`filterIsolated`, default on) — all opt-out, cull
  breakdown extended, DenseModal Advanced section. **WS5 modal framework**
  (`components/modals/ui/`): ModalShell/SettingsField/SettingsSection/AdvancedDisclosure/
  SegmentedControl/WarnBox/PresetSelector + shared `modal.css`; `.btn` hoisted to global
  `style.css`; `RECONSTRUCT_PRESETS` (deltas over defaults); ReconstructModal migrated as
  the template. **Owed: browser verification** (WS5 remaining 8 modal migrations + the
  Phase-0/Verification dataset runs — see TODO.md ▸ Now ▸ V). 567 unit tests pass +
  Rust crate tests + production build clean.

- **2026-07-12 · Import/export interop (PLAN-import-export.md, Phases 1–6)** —
  broadened format coverage across the pipeline. **Cloud export** (Phase 1):
  `core/io/las.js` (LAS 1.2 point-format-2 writer + a header-authoritative
  reader supporting formats 0–3/6–8, LAZ rejected) and `core/io/cloudText.js`
  (XYZ writer/reader); the export modal's cloud kind gained LAS/XYZ formats, a
  georeference toggle (Horn fit → project CRS) and a voxel-downsample cell, via a
  new pure `prepareCloudForExport` (georef-then-downsample, streams through the
  dense voxel accumulator — no per-point objects). **Cloud/mesh import**
  (Phase 2): `core/io/ply.js` (ascii + binary-LE reader, points + faces, unknown
  props skipped by stride) and `core/io/cloudImport.js` (magic-byte sniff, parser
  dispatch, unit-scale/Y-up→Z-up/subsample transform); parsed off-thread by a new
  `workers/ops/io.js` `parseCloud` op; `useReconstructionStore.importCloud` adds
  an `imported`-flagged `dense`/`mesh` cloud (never replaced by a re-fuse/re-mesh);
  routing sniffs binary magic before any text decode; new `ImportCloudModal` +
  Ribbon *Import ▸ Interop ▸ Point Cloud / Mesh*. **COLMAP `.bin`** (Phase 3,
  finishes F7): `serializeColmapModelBin`/`parseColmapModelBin` share the
  ColmapModel struct (txt↔bin equivalence tested); export modal `bin` format,
  import routes `.bin` keys through the binary parser (warn+ignore non-PINHOLE
  distortion). **Mesh export** (Phase 4): `meshToObj` (1-based faces, 0–1 vertex
  colour) + `meshToStl` (binary, per-face normals, degenerate → zero not NaN);
  modal mesh kind gained OBJ/STL (STL disables colour). **transforms.json**
  (Phase 5): `core/io/transforms.js` — camera-to-world OpenGL poses (OpenCV→GL
  column flip, round-trip tested) for nerfstudio/instant-ngp/3DGS; model kind's
  `transforms` format. (Bundler/NVM import — Phase 5b — skipped as time-boxed.)
  **Raster polish** (Phase 6): GeoTIFF DEFLATE (writer stays sync; the caller
  injects a `CompressionStream` deflater, tag 8), DEM hillshade PNG + world file,
  JPEG ortho with a quality slider, and real OGC WKT1 `.prj` via `core/products/
  wkt.js` (WGS84 geographic + UTM zones formulaic, else proj4 fallback). All pure
  writers/readers unit-tested (round-trip / byte-layout / convention). **Owed:
  in-browser verification** — headless can't open the downloads or drive the
  import pickers. Manual checks: open exported LAS/PLY/XYZ in CloudCompare,
  OBJ/STL in MeshLab, GeoTIFF (incl. DEFLATE) in QGIS, COLMAP `.bin` in COLMAP,
  `transforms.json` in nerfstudio; import each of our own exports back
  (round-trip is the cheapest end-to-end check); confirm imported clouds render
  in Viewer3D and can feed DEM/mesh.

- **2026-07-12 · Mesh product — screened Poisson from the dense cloud (all 6 phases)** —
  a vertex-coloured triangle mesh product, generated in-browser via screened
  Poisson (Rust→WASM), rendered in Viewer3D, persisted to OPFS, exportable as
  PLY (faces) + GLB. **Phase 1 — normals through the dense pipeline**: the WASM
  PatchMatch kernel (`crates/reconstruction/src/mvs.rs` `compute_depth_map`) now
  emits its converged plane normals as a trailing `3·npix` block (output widened
  `2·npix`→`5·npix`; JS unwrap in `core/sfm/reconstruction.js`), matching the GPU
  backend's existing camera-frame convention; fusion (`core/dense/mvs.js`
  `fuseDepthMaps`) rotates each kept pixel's normal to world (`Rᵀ·n_cam`) and the
  voxel accumulator averages+renormalizes them into a flat `DenseCloud.nrm`
  (Float32 3N), threaded op→cache→store→OPFS sidecar (`recon.{id}.nrm.bin`) and
  optional in PLY export. **Phase 2 — `crates/mesh`**: wraps Dimforge's
  `poisson_reconstruction`, **vendored + patched** (rayon removed — its two
  `par_iter_mut()` sites made threadless-wasm panic; plus a marching-cubes
  iso-value patch: extract at the sample-average iso, not 0, fixing an ~8%
  surface-inflation bias). One flat wasm entry `poisson_mesh(pos,nrm,depth,
  screening,trim)→bytes` with voxel-hash trimming of far-from-data triangles.
  **Phase 3** `core/products/mesh.js` (byte-buffer parse + nearest-cell colour
  transfer), worker op `workers/ops/mesh.js`. **Phase 4** store `generateMesh()`
  + `kind:'mesh'` cloud (flat pos/idx/col), Viewer3D `THREE.Mesh`
  (MeshStandardMaterial, computed normals, DoubleSide), sidebar row (triangles/
  vertices), OPFS persist/restore. **Phase 5** `MeshModal.vue` + Ribbon `gen-mesh`
  / `export-mesh`, `meshToPly`/`meshToGlb` exporters. **Phase 6 (decimation) —
  PARKED** per the plan (adds an npm dep; ship without). **Naming note:** the
  library exposes a *screening* weight, not PoissonRecon's samples-per-node, so
  `MESH_DEFAULTS.screening` replaces the plan's `samplesPerNode`. **Tests:** Rust
  slanted-plane normal-export + sphere/trim (run `cargo test -p mesh --release` —
  debug is ~40× slower); JS accumulator-normal parity, mesh parse/colour, PLY/GLB
  round-trip. **Owed: in-browser verification** — headless can't drive the full
  detect→…→densify→mesh flow, Viewer3D rendering, OPFS restore, or open the
  exported PLY/GLB in CloudCompare/MeshLab/a glTF viewer. Also confirm GPU-vs-WASM
  normal agreement on the first depth map (Phase 1b diagnostic not yet auto-logged).

- **2026-07-12 · Match preview aligned/unused colouring + drop Candidates column** —
  `ViewerMatch.vue` now two-tones tie-point lines/dots once a sparse cloud exists
  (green = aligned/became a surviving tie-point, red = verified inlier that never
  triangulated — Metashape's aligned/not-aligned convention), via a `usedKeys`
  prop threaded `App.vue` (`usedMatchesByPair`, already computed) → `MatchListModal`
  → `ViewerMatch`; falls back to neutral gold pre-alignment (`usedKeys===null`).
  Also **dropped the "Candidates" (`rawCount`) column** from the match table as
  redundant UI noise. **NOTE — the data is NOT gone**: `rawCount` is still stored
  on every match entry (`useMatchesStore.matchPair`, persisted to OPFS) and still
  carried on `matchSummaries[].rawCount` in `App.vue`; it's logged per pair
  ("N/M inliers") and the inlier *ratio* it feeds still drives `minInlierRatio`.
  Only the table cell/header were removed — to resurface it (or a ratio column),
  re-add a `<th sortBy('rawCount')>`/`<td>{{ m.rawCount }}</td>` and bump the
  empty-row colspan. RANSAC outliers, however, ARE discarded (only inliers kept in
  `entry.matches`), so they can never be drawn/tabulated without a store change.
- **2026-07-12 · F12 — SAM2 smart mask selection (click-to-segment)** — new
  `core/segment/` module: `sam2.js` (pure preprocessing/decoding math + ORT
  encoder/decoder glue, same lazy/cached/serialized-session pattern as LightGlue;
  15-test `sam2.test.js` locks the shape/normalization math + the decoder
  input-name resolution against both onnx-community *and* Meta export names) and
  `workers/ops/segment.js` (`segmentEncode` once-per-image + worker-side LRU
  embedding cache, `segmentDecode` per-click returning the **raw 256² logits**,
  `segmentForget`; pinned to worker 0 via `computeClient.js`). UI: "Smart Select"
  (`sparkles`) tool in `MaskToolbar.vue` — click an object → cyan candidate preview
  (independent per click; Alt-click refines with a negative point), Enter/"Add to
  mask" commits into the red mask canvas (undoable), Del discards. **Click vs drag**:
  a Smart-tool press that doesn't move segments; a drag pans (so you can still move
  around without a modifier). **Finer boundary**: the decoder's fixed 256² logits
  are bilinear-upsampled straight to **native image resolution** at commit (not
  nearest-scaled from a pre-thresholded ≤1024 mask). Wired through `ViewerImage.vue`
  (encode on tool activate, reset+forget on image switch/unmount). **Mask-edit save
  behavior** (all tools, not just Smart): commits during an edit session now update
  only the in-memory mask (undo/redo/overlay/badge stay live) and persist once —
  one OPFS write + "Mask saved" log — when edit mode closes (`updateMask(…, persist)`
  in `useImagesStore`; `ViewerImage.persistMask`/`flushMask`). The mask overlay is
  also always visible while editing regardless of the view toggle. **Verified end-to-end in-browser**
  on onnx-community/sam2-hiera-tiny: encoder on **WebGPU** (~1.2 s/img, once),
  decoder on **WASM** (ORT's WebGPU EP crashes when re-run with a varying point
  count — `getBindGroupLayout` undefined / wasm OOB — so the decoder is CPU-pinned).
  The downloaded exports needed a one-time fix: their `/conv_s0,s1/Conv` nodes had
  bad rank-0 `value_info` that failed ORT shape inference — stripped all internal
  `value_info` from both `.onnx` files (they re-infer at load). Models bundled at
  `public/models/sam2_{encoder,decoder}.onnx` (encoder fp32 **128 MB** — TODO F12:
  quantize / OPFS-cache / LFS). Contract + gotchas in `src/core/segment/README.md`.

- **2026-07-12 · Dense-fusion OOM fix + smooth pipeline progress (7 phases)** —
  the 50-image building set OOM-killed the tab at Build Dense Cloud. Fixed +
  flattened the whole dense memory path (all unit-tested; **in-browser
  verification still owed — see TODO ▸ Now ▸ M**):
  - **P1+2 (fusion crash):** `fuseDepthMaps` (`core/dense/mvs.js`) no longer
    materializes a per-pixel point-object list (~3 GB). Kept pixels stream
    straight into a numeric-keyed **voxel accumulator** (`createVoxelAccumulator`
    — SoA typed-array sums, world-origin cell anchoring identical to
    `mergePointsSpatial`, packed `(dix·ny+diy)·nz+diz` keys sized from a coarse
    scene bbox, float64-exactness clamp) and finalize straight to the flat wire
    buffer. Cost histogram is sampled + sorted **once** (`autoFusionMaxCost` now
    returns the median too; `medianOf` deleted). New `DENSE_TUNING` knobs
    (`fuseBboxStride`/`fuseProgressMs`/`fuseCostMaxSamples`/`fuseMaxCells`).
    `ProgressModal` renders `Math.floor(current)` so fractional emits read clean.
  - **P3 (transfer, not clone):** `streamingOp` takes a `transfer` list; the
    store transfers each depth map's depth/cost/rgb buffers to the worker (strips
    the heavy `displayDataUrl`), the `densify` op round-trips them home, the store
    re-attaches them (ortho reuse). Densify error clears the (now-detached)
    depth-map cache; ortho guards on `byteLength === 0`.
  - **P4/P5 (progress):** depth maps emit fractional within-image progress
    (pyramid-level weighted); sparse SfM emits during init-pair scoring
    (`initPair.js`), interim BA / rescue (`register.js`), and the final BA /
    retriangulation / filter / GCP-anchor stretch (`sfm.js`).
  - **P6 (flat dense cloud):** a `kind:'dense'` cloud is stored **flat**
    (`{ count, pos:Float32Array(3N), col:Uint8Array(3N) }`, `DenseCloud` in
    `types.ts`), not point objects — the viewer (`Viewer3D`), PLY (`cloudToPly`),
    DEM marshalling, persist/restore (`serialize/deserializeCloud` + legacy
    back-compat), sidebar count, and `App.vue`/`useExports` all branch on kind.
    Sparse clouds keep their object/track shape.
  - **P7 (Stage B pre-flight):** `projectDensifyPeakBytes` (`memBudget.js`)
    projects the fusion peak (input + voxel accumulator + flat output) from the
    real maps; the store gates **before transferring** so a refusal keeps the
    depth maps, logging an actionable breakdown vs `memBudgetBytes`.

- **2026-07-11 · GCP sidebar link correctness + multi-image inspector view** —
  observation jump-to-image links now render only for images that actually exist:
  `useGcpsStore` gained `reconcileObservationImageIds` + a `watch` on the image
  list that re-resolves every observation's `imageId` by name on any add/remove/
  rename (backfills when a referenced image is added later, clears it on removal),
  and `GcpsSection.vue` renders a dimmed non-clickable label when `imageId` is
  null. **Double-clicking a GCP** now opens a read-only multi-image inspector tab
  (`components/viewers/ViewerGcp.vue`, `type:'gcp'` via `useTabs.openGcpTab`): a
  grid of panels, one per registered observation, each cropped + zoomed (shared
  zoom control) to centre the marked pixel under a crosshair, with per-observation
  reproj error + jump-to-image link. Wired sidebar `open-gcp` → App `openGcpView`;
  `removeGcpAndCloseTab` closes the tab when its GCP is deleted. (The panel image
  transform pins the corner to the viewport centre and offsets by `−px·s,−py·s` —
  a naïve `translate(calc(50% − …))` resolves `50%` against the image's own huge
  scaled size and flings the raster off-screen.)

- **2026-07-11 · M1+M2 — mask editing overhaul (floating toolbar + tools)** — the
  ribbon's Picture tab dropped its Mask (Draw/Erase/Import/Clear) + Brush (S/M/L)
  groups for a single **"Edit Mask" toggle** (`img-mask-edit`, per-tab `maskEdit`
  flag in `useTabs`); the tools moved to a floating draggable panel over the image
  view (`components/viewers/MaskToolbar.vue`). Tool state (brush/eraser/rectangle,
  brush-size + overlay-opacity sliders) lives locally in `ViewerImage.vue`, which
  gained: a **rectangle** drag-fill tool (dashed preview, Alt = erase), **invert**
  (`invertMaskPixels` pure op in `core/mask.js`, unit-tested — returns the excluded
  count so an all-clear inversion commits `null`), an **undo/redo** stack of the
  persisted mask dataUrls (cap 10, snapshot before each committed stroke/rect/
  invert/import/clear), and keyboard shortcuts (B/E/R/I, `[`/`]` size, Ctrl+Z /
  Ctrl+Shift+Z / Ctrl+Y, Esc exits via App's global handler — `closeTopModal` now
  returns whether it consumed the Escape). Clear became undoable, so its confirm
  dialog + `pendingMaskClear` plumbing were removed (`useModalEscape` signature
  slimmed). **Empty-mask invariant** (never persist an all-transparent PNG / show
  Mask ✓ for a mask that excludes nothing): a brush/erase stroke fully outside the
  image rectangle is a no-op (`circleIntersectsImage` gate + a `strokeHit`
  accumulator over the drag — the mask canvas is image-sized, so an outside stroke
  paints zero pixels), and erase-type commits (erase stroke / erase-rectangle /
  import) pass `checkEmpty` to `exportMask`, which scans via the new pure
  `anyExcluded` op (`core/mask.js`, unit-tested) and commits `null` + `hasMask =
  false` when nothing remains masked (draws skip the scan — trivially non-empty).
  `npm test` (428) + typecheck + build green; **browser-manual run owed** (toolbar
  drag, tools, undo across tab switches, Esc ordering vs modals; confirm
  draw-outside and erase-to-empty both leave no mask).
- **2026-07-11 · P8 — GEMM-form NN matcher kernel (`crates/matching`)** — replaced the
  per-pair early-exit L2 scan (`l2_sq_early`/`nn2`) with the norm-identity form
  `‖a−b‖² = ‖a‖² + ‖b‖² − 2·a·b`: row norms precomputed once (`descriptor_norms`), and
  the nearest-neighbour search reduced to a branch-free multiply-add dot product
  (`dots_tile`) that register-blocks BQ=4 queries against each database row (one SIMD
  load of the row reused across four f32x4 accumulators). The distance search runs in
  "s-space" (`s = ‖b‖² − 2·a·b`, dropping the per-query constant `‖a‖²`); the query norm
  is folded back only to materialise true squared distances for the ratio test + reported
  distance (`ratio_pass`), clamped ≥0 against cancellation. `match_descriptors` signature
  unchanged (dim-parametric); A→B and B→A both go through the shared `ratio_pass`. SIMD
  path behind `target_feature = "simd128"` with a structurally-identical scalar fallback
  (native tests exercise the search/ratio logic; SIMD dot is validated by the wasm build +
  the owed browser run). New cargo tests: `match_descriptors_agrees_with_naive` (exact
  match-set equality vs a naive diff-square reference across cross-check on/off and a
  non-multiple-of-4 `dim`) + `match_descriptors_reports_l2_distance`. Expected 3–8× on the
  matcher hot loop; **actual speedup unmeasured** — folds into the owed matching wall-clock
  re-run (TODO ▸ Now ▸ Q ▸ P5). `cargo test` (7) + `npm test` (423) + typecheck green; wasm
  rebuilt + committed (`src/wasm/matching/*`; signature identical so only the binary
  changed). Lives in `crates/matching/src/lib.rs`. TODO ▸ Next ▸ P5–P9.

- **2026-07-11 · G1 — GPU/WASM correctness batch** (folded from the 2026-07-07 compute
  review). Six small hardening fixes so the WebGPU dense backend agrees with WASM and
  fails diagnosably. (1) `maxSources` clamped to 16 where dense settings resolve
  (`workers/ops/dense.js`) — the GPU kernel packs a fixed MAX_SRC=16 and silently drops
  the rest while WASM + the first-image A/B check use all, so >16 sources tripped a
  spurious RMS-divergence warning. (2) Texture-dimension pre-flight: `device.js` now
  raises `maxTextureDimension2D` to the adapter max alongside the buffer limits, and
  `computeDepthMapGPU` pre-flights `max(refW,refH,maxW,maxH)` against it with a "lower
  maxDim" error instead of an opaque createTexture failure. (3) The mid-run GPU→WASM
  fallback retry now passes `{ onLog: hooks.onLog }` so the coarse-to-fine plan keeps
  streaming after the drop. (4) `computeDepthMapGPU` mirrors mvs.rs's depth-range guards
  (`dmin ≥ 1e-4`, `dmax ≥ dmin·1.001`) before packing params. (5) Comment hygiene:
  `computeDepthMap` docstring/default were `window=2` while the pipeline passes 3
  (reconstruction.js) — aligned to 3 (the `mvs.rs:188` "32-sample" note was already
  corrected). (6) `pushErrorScope`/`popErrorScope` (out-of-memory + validation) wrap
  resource creation + the init dispatch in `computeDepthMapGPU`, so a GPU failure throws
  a named cause the worker logs before falling back to WASM, rather than an opaque
  "mapAsync was not successful" at readback. Pure JS (no crate/wasm change). `npm test`
  (423) + typecheck green. **Browser-runtime paths unverified here** (the error-scope
  trigger, texture pre-flight on a >8192px scan, and the GPU→WASM fallback all need a
  real WebGPU run) — fold into the owed dense browser session. Lives in
  `src/workers/gpu/{device,depthMapGpu}.js`, `src/workers/ops/dense.js`,
  `src/core/sfm/reconstruction.js`.

- **2026-07-10 · P2.5 — fusion dedupe + `step: 1` (`core/dense/mvs.js`)** — multi-view
  fusion emitted one point per source pixel, so a surface seen by k views produced k
  near-coincident "shell" points, and `step: 2` was throwing away 75% of resolution to
  keep the count down. New pure `mergePointsSpatial(points, cellSize)` does an
  order-independent world-space voxel merge (one averaged position+colour per cell);
  `autoMergeCell` sizes the cell at the median GSD (median depth / fx ≈ one ground-pixel
  footprint). `fuseDepthMaps` now fuses at full res and merges its output (logs
  `raw → merged` dupes; `mergeCell`/`mergedPct` in the summary). Default `step` flipped
  to **1** (`DENSE_FUSE_DEFAULTS` + core fallback). Tests in `mvs.test.js`.
  **⚠ Provisional pending B2**: the `step:1` default and auto cell-size want validation
  against a real dense re-run — the step-1 fuse does ~4× the consistency-check work, and
  the cell-size is an eyeball until measured. Revisit both after B2 lands its baseline.
- **2026-07-10 · P6 — adaptive RANSAC termination (`crates/matching`)** — F/H RANSAC ran
  a fixed 1000 iters/pair regardless of pair quality. `ransac_fundamental` (s=8) and
  `ransac_homography` (s=4) now shrink their iteration cap after each new best model via
  `adaptive_iters` (`N = ln(1−0.99)/ln(1−wˢ)`) — clean pairs stop in <100 iters, noisy
  pairs still run to the cap. `verify_matches_hf` gained an `h_skip_below` param wired to
  the store's `minMatches` (`verify.js` `hSkipBelow`): H is skipped (reported 0) on pairs
  below the hard acceptance floor, since the H/F degeneracy label is only read for pairs
  that survive to seed SfM. Behaviour-preserving inlier sets; cargo + JS tests added.
  **Not runtime-verified here** (wasm path) — needs the owed matching wall-clock re-run to
  confirm the 2–5× on verify. wasm rebuilt + committed.
- **2026-07-10 · COLMAP model import (F7, text half)** — completes the F7 round-trip
  (export shipped earlier same day). Pure core: `colmapToSparse({images,points},
  resolveUuid)` + `makeNameResolver` (tiered name→uuid: exact → basename →
  case-insensitive → extension-stripped) in `core/io/colmapModel.js`; imported points
  carry a synthetic per-image `views` index (dense reads only view *uuids*) with the
  real pixel in `viewsPx` for coherent re-export. `utils/zip.js` gains `unzipStore`
  (STORE-method inverse of `zipStore`, EOCD+central-directory reader, throws on
  compressed/malformed). `core/io/importKind.js` gains `isColmapFile` +
  a `'colmap'` kind. Store: `useReconstructionStore.importColmapModel(files)` parses →
  reads → matches names to loaded images → `upsertSparseCloud(…, { replaceId:null,
  asMain:!main })` so the import is a NEW sparse cloud alongside any computed one (MC
  Phase 0), with heavy logging of matched/unmatched/dropped-distortion counts and a
  <2-match guard. UI: Ribbon *Import ▸ Interop ▸ COLMAP Model* (+ console `import
  colmap`) → hidden multi-file/zip `<input>` → `useImportRouting.openColmapImport`
  (accepts a `.zip` or the loose `cameras.txt`/`images.txt`/`points3D.txt` set,
  case-insensitive, canonicalising keys). Tests: `colmapToSparse` + `makeNameResolver`
  round-trip/unmatched-drop cases, `unzipStore` round-trip + comment-scan + non-zip
  throw, `isColmapFile` sniffing. **Also fixed a latent gap:** `vitest.config.js` only
  globbed `src/core/**`, so `src/utils/zip.test.js` never ran — added
  `src/utils/**/*.test.{js,ts}` (utils tests must stay Vue/Pinia/DOM-free). `npm test`
  (418) + typecheck + build green. Owed: **browser run** — import a real model into a
  project with matching images, confirm the cloud lands + set-main → dense; plus `.bin`
  variants (fast follow). See TODO ▸ Later ▸ F7. Lives in the `core/io/` line of CLAUDE.md.

- **2026-07-10 · MC Phase 0 — multiple sparse clouds with a "main" designation** —
  groundwork so a COLMAP import (F7) can sit alongside a computed reconstruction
  instead of destructively replacing it. `useReconstructionStore` gains `mainSparseId`
  + `mainSparseCloud` getter (fallback: first sparse) + `setMainSparse`; the invariant
  *one sparse cloud is always main whenever any exists* is held by `ensureMainSparse`
  (after `removeCloud`/`restore`/`clear`). Downstream consumers repointed from
  `find(kind==='sparse')` → `mainSparseCloud`: `sparseCameras`, `computeDepthMaps`,
  `generateDem`'s sparse source, and `useExports.sparseCloud()`. `upsertSparseCloud`
  grew an `{ replaceId, asMain, name }` intent — reconstruct replaces the main in place
  (id/name carried forward, default `replaceId = mainSparseId`); import will pass
  `replaceId:null` to add a fresh cloud, `asMain` only when none exists. `mainSparseId`
  persists in `reconstruction.json` (absent ⇒ first sparse, back-compat). UI:
  `CloudsSection.vue` right-click "Set as main" (sparse, non-main only) + a "main"
  badge, wired through `Sidebar.vue`/`App.vue`. `npm test` (406) + typecheck + build
  green. Store/UI is browser-runtime — **owed** a real-app run (set-main, delete-main
  promotion, persistence round-trip). Lives in the `useReconstructionStore` paragraph of
  CLAUDE.md. Next: Phase 0b (dense multiplicity + lineage) then F7 import (TODO ▸ Next ▸ MC).

- **2026-07-10 · Stalled-strip rescue for registration (S1, `register.js`)** — when a
  sweep registers nothing but images still link to the model (short film strips: end
  frames fail on a ~10%-wrong focal + a strip-end structure gap), run one rescue round:
  focal-only BA (`refineIntrinsics 'f'`, safe pre-filter) + retriangulation, then a
  single relaxed-recheck retry (recount at the PnP gate, ratio `rescueRefineRatio 0.2`).
  Guarded one-shot (`rescued`), knob `rescueStalled` (default on). Absolute inlier floor
  + gate-1 + final track filter still apply, so it can't manufacture a pose. Motivated by
  a B0 run (2026-07-10) that registered only 3/5 with the film flag *off*: `0033` failed
  the tight 4px recheck (18/29 held at 8px), `0032` starved (0/20 usable correspondences).
  `npm test` (406) + typecheck green; **owed** a real B0 re-run to confirm it lifts the
  count (expected 4/5 — `0033` via relaxed recheck; `0032` depends on retriangulation
  reaching its overlap). NB the proper fix for film is still the fiducial/interior-
  orientation path (mark the sensor film) — this only hardens the no-film case.

- **2026-07-10 · Code-review batch (cycle filter, COLMAP export frame, perf, hardening)** —
  from a review of the working tree. **B1** cycle filter: strong-edge protection now
  auto-disables on a uniform-quality graph (no/equal inlier counts) instead of shielding
  every edge (`cycleFilter.js` + regression test). **B2** COLMAP export: 2D observations
  now export in the **BA (pinhole) frame** — `sfm.js` bakes each view's
  undistorted/canonical/self-cal-folded pixel into the returned points, the store carries
  it as `viewsPx` and persists it (`recon.*.vx/vy.bin`, `RECON_BIN_KEYS`), and
  `doExportColmap` prefers it (falls back to store keypoints + warns for distortion/film
  projects). Fixes silently-inconsistent exports for distortion/film/self-cal projects.
  **B3/B4** UI: LightGlue `lgMaxKeypoints:0` reads as uncapped (no false cap warning);
  `formatClock` floors minutes (no "1h 60m"). **B5** `colmapModel.fmt` throws on non-finite
  instead of writing 0. **P1** correspondences swept once per registration pass and cached
  (reused for NBV scoring + PnP attempt). **P2** cycle filter reuses its initial full-graph
  pass. **G2** `utils/zip.test.js` structural round-trip test. Docs: CLAUDE.md §3 +
  METHODS.md §4.3 (NBV ordering, two-gate PnP), TODO F7. `npm test` (406) + typecheck green;
  a real COLMAP round-trip (film + self-cal projects) is still owed — see TODO F7.
- **2026-07-10 · Extracted `core/sfm/register.js` (G1)** — lifted the incremental-resection
  stage (next-best-view ordering, two-gate PnP, track extension/triangulation, interleaved
  BA + its `collectCorrespondences`/`nextViewScore`/`countMatchesToRegistered` helpers) out
  of the 1349-line `sfm.js` into `registerImages(ctx)`. `sfm.js` → 1019 lines. Shared model
  state passed via `ctx` and mutated in place (Maps/Sets by reference; the reassignable
  `points3d` via a live `getPoints3d()` getter, since injected BA/filter closures replace
  the array). `registeredUuids` stays in `sfm.js` (the `foldOneEndpointMatches` closure
  reads it). Behaviour-preserving move — `npm test` (406) + typecheck green; owed a real-data
  reconstruction run to confirm no regression vs. the pre-extraction pipeline.
- **2026-07-10 · COLMAP model export (F7, export half)** — pure
  `core/io/colmapModel.js` (R↔quaternion, `serialize/parseColmapModel` text
  round-trip, `build/readColmapModel` websfm↔COLMAP adapters; 15 unit tests) +
  dependency-free `utils/zip.js` (STORE ZIP, verified against the `unzip`
  binary). Wired *Export ▸ Interop ▸ COLMAP Model* (new Ribbon group) →
  `useExports.doExportColmap` resolves each point's `views` to pixel
  observations from keypoints, emits a zipped 3-file PINHOLE model in the local
  SfM frame. `npm test` (404) + typecheck green. Import half + `.bin` +
  browser run still owed — see TODO F7.

- **2026-07-10 · Reconstruction-quality overhaul (PLAN-reconstruction-quality.md, P0/P1/P2/P3/P4/P6)** —
  from the 2026-07-10 building + aerial log audit. **P0** intrinsics: `refineIntrinsics`
  now defaults to `'auto'` (`defaults.user.js`), resolved in `core/sfm/sfm.js` to
  `'f,k1'` when no sensor carries a calibrated distortion model (EXIF-only / film) and
  `'none'` otherwise — self-calibration on by default, the biggest single lever for both
  datasets. **P1** PatchMatch freckle fix: spatial propagation now intersects the pixel's
  ray with the neighbour's *plane* (`cand_d = (n·P_j)/(n·ray_i)`) instead of copying the
  neighbour's raw depth (fronto-parallel-only) — fixed in lockstep in
  `crates/reconstruction/src/mvs.rs` + `src/workers/gpu/patchmatch.wgsl`, plus the two
  decoupled refinement hypotheses (random-normal / depth-only); pure-JS slanted-plane
  convergence test in `planeCost.test.js` (≥95% within 1%, vs raw-depth <50%). **P2.1**
  no-measurement pixels (cost≈2.0) are zeroed before the speckle filter (`workers/ops/dense.js`);
  **P2.3** ZNCC half-window cap lifted 3→5 (11×11) across `mvs.rs`/`patchmatch.wgsl`/
  `depthMapGpu.js`/`mvs.js` + `DepthMapsModal`. **P3** rotation-cycle filter
  (`core/sfm/cycleFilter.js`) now evidence-weights each triangle by its weakest edge's
  inlier count, uses an adaptive+capped threshold (`max(5°, 2×median)`, ≤15°), shields
  strong edges, and logs a single summary; new noisy-graph + strong-edge unit tests.
  **P4** registration: next-best-view ordering by correspondences to well-triangulated,
  spatially-spread points; `minPnpInlierRatio` 0.15→0.3 (`tuning.js`); refine-then-recheck
  at the tight `reprjThreshold`; new points gated on ≥`filterMinTriAngleDeg` parallax not
  cheirality alone. **P6** Match modal: one "Matching density" Fast/Full radio over
  `lgTiled`, caps moved under Advanced, auto-hint when the Fast cap discards most detected
  keypoints. wasm rebuilt + committed. **Not verified in-browser** (dense visual quality,
  GPU↔CPU A/B, real-data reconstruction deltas) — needs a manual run. Deferred: P0.2 (k2
  self-cal), P0.3 (film-width sensor field), P2.2/P2.4/P2.5 (bilateral ZNCC, geometric
  consistency, fusion dedupe), P5 (matching speed: retrieval preselection, escalation
  gating, parallel LightGlue). Remaining items now live in TODO ▸ Now ▸ Q (the plan
  file was folded in + deleted 2026-07-10).
- **2026-07-09 · TIFF transcode OPFS cache + display-first ingest** — reopening a
  project with TIFFs no longer re-runs the multi-second decode+re-encode: both
  transcode outputs (display JPEG + lossless compute PNG) are cached in OPFS under
  `images-derived/{uuid}.display|.compute` (`opfs.saveImageDerived`/
  `loadImageDerivedBlob`/`deleteImageDerived`), written at ingest and read on
  restore; cache miss (older project / partial write) transcodes + backfills so
  projects heal on reopen. Ingest now encodes **display-first** (`tiffToDisplayBlob`
  serial JPEG→PNG + streamed `display` event through the tiff op/computeClient) so
  the viewer shows the full-res image while the PNG still encodes; a per-uuid
  `whenComputeReady` promise gates the two compute entry points (`detectOne`, dense
  marshalling in `useReconstructionStore`) and rejects on transcode failure so
  compute errors loudly instead of falling back to the lossy JPEG. Files:
  `utils/opfs.js`, `utils/tiff.js` (+`nativeTiffDecodeResult`), `workers/ops/tiff.js`,
  `workers/computeClient.js`, `stores/useImagesStore.js`, `stores/useReconstructionStore.js`.
  Phase 2b (geotiff decoder pool) left as measure-first/optional. Not yet
  browser-verified (OPFS + OffscreenCanvas are runtime-only). Lives in the TIFF
  gotcha paragraph of CLAUDE.md.

- **2026-07-08 · F4 — Fiducial-mark interior orientation for film scans** — treats
  scan geometry like lens distortion: removed once at ingest so the pipeline stays
  pinhole with one shared K per sensor. New pure core `core/sfm/fiducials.js`
  (`fitFiducialAffine` least-squares scan→mm, `canonicalFrame`, `scanToCanonical`/
  `canonicalToScan`; `fiducials.test.js`). Data model: `kind`/`fiducials` on
  sensors (`useSensorsStore.setFiducialMarks`), `fiducialObs` on images
  (`setFiducialObservation`/`addFiducialObservations`), both persisted. UI: film
  Kind + fiducial editor (marks table + certificate paste) in `SensorTable.vue`;
  "Mark fiducial…" right-click flow + distinct overlay + live per-mark residual in
  `ViewerImage.vue`; `<3`-marks flag in `ImagesSection`. Import: `core/io/fiducialObs.js`
  parser routed via `importKind.js`/`useImportRouting`. Sparse: `sfm.js` ingest fits
  per film image, builds one canonical frame per sensor (median pitch), moves the
  worker's keypoints + GCP observations, adds `resolveK` **path 0** (`_fiducialK`),
  records `summary.fiducialTransforms`. Dense: `workers/ops/dense.js` warps each film
  raster+mask into the canonical frame (`warpFilmRaster`/`filmMaskLut`) from the
  sparse run's stored transform (never re-fits). Method in METHODS.md §5.1, invariant
  in CLAUDE.md. `npm test` (film reconstruction test in `sfm.test.js`) + typecheck +
  build green; browser run (mark fiducials on CA…V scans, check the pitch log,
  compare §B0 baselines) still pending — this environment can't drive it.

- **2026-07-08 · Fix: project switch/close silently destroyed the left project**
  — teardown ran *before* the project switch, so every `clear*` operated on the
  still-current (old) project. `useImagesStore.clearAll` `sync()`'d an empty
  image list over its `project.json`, and `useSensorsStore.clearSensors` +
  `useMatchesStore/useGcpsStore/useFootprintsStore/usePosesStore.clear()`
  unconditionally deleted their OPFS files — wiping images/sensors/keypoints/
  matches/GCPs/etc. on switch or "new project" (only reconstruction survived,
  as its `clear({ purge })` already gated OPFS deletion). Fix: all six teardowns
  now take `{ purge = false }` and only touch OPFS when purged; only the explicit
  `clear-all` command purges (App.vue), switch/create do not. Lives in the six
  stores + `App.vue` dispatch.

- **2026-07-08 · Console = append-only OPFS stream** — the dev console no longer
  loses verbose SfM output to the buffer cap. `utils/opfs.js` `log.ndjson` is an
  append-only NDJSON stream (`appendLog`/`readLog`/`truncateLog`, legacy
  `log.json` migrated once); `useLogStore` batches every logged line onto it
  (single-flight, `flushNow`/`readAll`/`clearConsole`) while `useLog` keeps only
  a capped display tail (`MAX_BUFFER` 1000→5000, still shift-on-overflow but no
  longer lossy). `DevConsole.vue` scroll-to-top progressively prepends older
  chunks from the file (500/chunk, scroll-anchored) and Save TXT exports the
  whole unfiltered stream. Browser-runtime (OPFS writable) — not verified here.

- **2026-07-08 · P7 subset gate (two-stage exhaustive matching)** — the
  structural fix for the no-poses/no-GPS exhaustive case (a building shot in a
  circle: sequential misses the loop closures, exhaustive is too slow, preselect
  has no positions to work with). New pure helper `core/features/subsetGate.js`
  (`pickSpreadIndices` grid-buckets keypoints and keeps one per cell — spatially
  uniform, not response-sorted top-K, so it doesn't collapse onto a façade's
  repeated high-contrast blobs; `sliceDescriptorRows` gathers the subset into a
  compact buffer) + `subsetGate.test.js` (6 tests). Wired into
  `useMatchesStore.matchPair` before the full match (brute-force only, skipped
  for LightGlue): match a ~200-kp spatially-uniform subset per image, and if
  fewer than `subsetGateThreshold` (default 8) putatives survive, mark the pair
  `gated` and skip the O(Na·Nb) full match. Only engages when both images have
  >1.5× the subset size in keypoints (small images pay the full match). Keeps
  exhaustive *coverage* (loop closures still found anywhere in the graph) at a
  fraction of the per-pair cost. Toggle + subset-size/threshold controls in
  `MatchFeaturesModal` (on by default for brute-force); gated count reported in
  the run summary; per-pair gate decisions logged at debug. This is TODO's P7
  with a spatial-spread refinement over the planned response-sorted `subarray`;
  the scale-up beyond it (global-descriptor / vocab-tree retrieval to cut the
  O(N²) pair count itself) stays Parked for 1000+ image sets. `npm test` +
  typecheck clean. Owed: a real browser run on the circular building set to tune
  `subsetGateThreshold` (watch the `Gated:`/`Gate passed:` debug lines and the
  `N gated` summary — if genuine weak-overlap pairs get gated, lower the
  threshold or keep a sequential band unconditionally).

- **2026-07-08 · GCP UX overhaul** — reworked the GCP workflow per user
  feedback on the F2 landing below. (1) Removed the control/check `role` split
  entirely (every enabled GCP is now used); dropped it from `useGcpsStore`,
  `useReconstructionStore` (qualify/report/marshalling), `sfm.js` anchoring,
  and the UI. (2) Split the single image (marker) accuracy into per-axis
  `accuracyImgX`/`accuracyImgY` px (2D — no Z); back-compat seeds both from the
  old `accuracyRel`. (3) Moved marking out of the table into the **image
  view's right-click menu** (`ViewerImage.vue` `@contextmenu`): "Add new GCP
  here" (`addGcp` + `setObservation`, auto-selects + enables the GCP overlay)
  or "Assign to existing ▸ <list>" (`allGcps` prop). Removed the table/sidebar
  "Mark" buttons and the old select-then-left-click `gcpMarkMode`. (4) Added
  the requested extras: a magnifier **loupe** (zoomed inset sampled from the
  `<img>`, shown while the GCP overlay is on), **live reprojection** error
  drawn next to each marker + in the sidebar observation list (refreshed after
  every mark), a per-GCP **observation list** in the sidebar (jump-to-image +
  per-observation remove via new `jump-to-image`/`remove-gcp-observation`
  events), and **coverage** flags (⚠ on GCPs with <2 marks) in table + sidebar.
  Table row-click now highlights (`selectedGcpId`) instead of a Mark button.
  Follow-ups same day: the image-view right-click is now a **general** context
  menu (Add GCP here… / Copy pixel / Copy color / Zoom in here / Fit to view);
  "Add GCP here…" flips the same popup to the new-vs-existing chooser in place.
  The sidebar lost its "+ Add GCP" and per-GCP "Remove GCP" buttons — removal is
  now a right-click context menu on the GCP row (`useContextMenu`, matching the
  other sidebar sections); adding is via the table or image right-click only.
  Docs (CLAUDE.md CRS/GCP section) updated; `sfm.test.js` fixtures dropped
  `role`. 347/347 tests, typecheck + build clean. Still owed the same manual
  browser verification as the entry below (marking click accuracy at zoom,
  loupe, end-to-end georeference).

- **2026-07-07 · GCP-driven georeferencing + GCP-in-BA (F2, full scope)** —
  GCPs now participate in georeferencing, not just display. Data model: GCPs
  get a `role: 'control' | 'check'` (`useGcpsStore`) plus `setObservation`/
  `removeObservation` mutations for interactive marking. New pure
  `core/sfm/gcpTriangulation.js` (`triangulateGcp`/`triangulateAllGcps`)
  2-view-DLT-triangulates a GCP's registered-image observations into the
  current SfM frame. `useReconstructionStore`: `georeference()` now prefers a
  GCP-based Horn fit (`method: 'gcps'`) over the pose-based one when ≥3 control
  GCPs triangulate, and a new `gcpAccuracyReport()` surfaces per-GCP CRS
  residual + mean reprojection px in `GcpTable`/`GcpTableModal`/`GcpsSection`
  (role toggle + a refresh button). `ViewerImage.vue` gained click-to-mark:
  select a GCP (table "Mark" button or sidebar), click a pixel in an open
  image tab, it upserts that GCP's observation for the active image
  (`gcpMarkMode`/`selectedGcpId` props, `mark-gcp` emit). `GcpTable.vue` also
  gained a "+ Add GCP" toolbar button (`useGcpsStore.addGcp()` — a blank
  control GCP at the origin, no import needed) and made name/X/Y/Z editable
  inline (`setGcpName`/`setGcpPosition`), so a project with zero imported GCPs
  can still build one entirely from clicks: add → edit position → mark
  observations. Deepest part: GCPs
  now also constrain bundle adjustment directly (previously TODO's explicit
  "later") — `bundle_adjust` (`crates/reconstruction/src/bundle.rs`) takes new
  `anchor_flat`/`anchor_weight` params, adding a `Σ w·‖pt−target‖²` residual
  that only touches each anchored point's own 3×3 Schur block (no camera
  Jacobian changes; empty arrays ⇒ identical to prior behavior). `sfm.js`'s
  new `runGcpAnchoredBundleAdjust` runs after the main pipeline settles:
  triangulate control GCPs → Horn-fit → inverse-transform each GCP's CRS
  position into the SfM frame as the anchor target → re-run BA with the
  GCP observations injected as extra points/residuals → repeat once more
  (hard-coded, not a setting) as insurance against a poor seed fit; only the
  refined camera poses + original points are kept, so the *final* georeference
  used for products is still a fresh post-hoc fit, not the anchoring pass's
  scratch state. wasm rebuilt (`src/wasm/reconstruction/*`, not yet
  committed — see TODO ▸ Now ▸ W1). Tested: new Rust unit test
  (`bundle_adjust_gcp_anchor_pulls_point`), JS unit tests
  (`gcpTriangulation.test.js`, `reconstruction.test.js` gcpAnchors case,
  `sfm.test.js` GCP describe block) — 347/347 passing, typecheck clean. Owed:
  manual browser verification of the marking UI + end-to-end georeference/DEM
  path (TODO ▸ Now ▸ W1) before this is fully done.

- **2026-07-07 · Full-app audit vs COLMAP/Metashape + docs rebuild** — genuine
  state check of code vs docs. Findings: (1) tiled detection (TD) and
  native-width matching were implemented but **uncommitted and undocumented**
  (entries below); (2) `handover_gpu.md` held open work outside TODO.md,
  violating the three-doc rule — its open items are folded into TODO.md
  (Now ▸ G1, Backlog ▸ GPU/WASM dense perf), its verification record into the
  entry below, and the file is marked as an archived deep-dive reference;
  (3) EXIF GPS is parsed (`core/io/metadata.js`) but unconsumed — now TODO F10;
  (4) stale backlog line (`utils/detection.js` already deleted by RESTRUCT)
  removed. TODO.md rewritten with an explicit "general SfM tool" goal + gap
  analysis: new feature tracks F7 (COLMAP model import/export), F8 (processing
  report), F9 (cloud editing/gradual selection), F10 (EXIF-GPS priors), F11
  (scale bars), LAS + undistorted-image export under F1 polish, video import +
  16-bit TIFF + deploy story in Backlog. Test suite at audit time: 340/340,
  typecheck clean (per the GPU review run, same tree).

- **2026-07-07 · GPU/WASM compute review (record; plan folded into TODO)** —
  line-by-line review of the three PatchMatch kernels + orchestration at
  `89977ee`. **Verified**: cost math/aggregation/struct layouts/red-black
  semantics/bilinear edge behaviour in lockstep across WGSL↔JS↔Rust; committed
  wasm in sync with crate sources; 340/340 tests + typecheck green; fallback
  paths correct. **Issues found** (all secondary, none invalidates current
  defaults — fixes tracked as TODO G1): GPU silently truncates sources to 16
  while WASM/validation use all; no texture-dimension pre-flight (>8192px
  cameras fail opaquely); mid-run fallback retry drops the `onLog` hook; GPU
  lacks Rust's depth-range clamps; two stale comments; no GPU error scopes.
  Perf/quality follow-ups (half-grid dispatch, CPU/GPU overlap, on-GPU
  pyramid, f32 WASM loop, Stage-A geometric term) → TODO Backlog.
  (`handover_gpu.md`, which held the full deep-dive, was deleted 2026-07-16 once
  its open items were confirmed folded into TODO — this entry is the record.)

- **2026-07-07 · TD1–TD4 tiled detection (native-resolution keypoints)** —
  **in working tree, uncommitted** (ship = TODO W0; browser run owed). Pure
  helpers `core/features/tiling.js` (`planTiles` edge-flushed overlapping grid,
  `sliceRaster`, `nmsByPosition` seam dedup, `autoTileSize` from GPU
  `maxStorageBufferBindingSize`; unit-tested in `tiling.test.js`).
  Orchestration in `workers/ops/detect.js` (`runTiled` wraps both SIFT and
  SuperPoint runners; per-tile coord offset → merged set → positional NMS →
  global top-K; adapter limit queried once; per-run tile-size resolve with a
  conservative SuperPoint GPU cap). UI: `DetectFeaturesModal.vue` Advanced
  disclosure per detector (Tiling Off/Auto/Manual, tile size, overlap px;
  "Max resolution" relabelled "Detection resolution"). Off by default
  (single-tile path == before). Kills the SuperPoint grid-density cap + the
  WebGPU OOM at source (the 2026-07-07 per-image fallback remains as belt).

- **2026-07-07 · Native-width descriptor matching (128/256; completes SP1's
  SuperPoint→brute-force path)** — **in working tree, uncommitted** (ship =
  TODO W0). `crates/matching` `l2_sq_early`/`match_descriptors` take a `dim`
  param (SIMD 32-dim block loop + scalar tail; no 128→256 padding, each width
  matched in its own space); `core/features/bruteforce.js` passes
  `options.dim`; `useMatchesStore.matchPair` supplies `srcA.descDim ?? 128`
  (wrong dim mis-slices into phantom rows → out-of-range indices — the
  `reading 'x'` crash in verify, hence the loud comments). WASM rebuilt
  (`src/wasm/matching/*` in tree).

- **2026-07-07 · TIFF input support (Chrome/Firefox)** — source TIFFs were
  invisible in every browser but Safari (WebKit decodes TIFF via system ImageIO;
  Skia/Gecko don't), so `<img>`, the metadata dimension probe, and the worker's
  `createImageBitmap` rasterize all failed silently. New `utils/tiff.js`
  (`isTiff` + `tiffToDisplayBlob` via the `geotiff` dep) transcodes TIFF→PNG at
  ingest (`addImages`) and restore (`restoreImages`) so `image.url` is always a
  browser-native raster; every downstream consumer works unchanged. Original TIFF
  still persists to OPFS.
- **2026-07-07 · Detect UX: size-aware GPU pin, non-Chromium warning, hard
  cancel** — `core/features/superpoint.js` (the WASM pin is now per input size:
  `gpuFailedAtPx` Map replaces the all-or-nothing `pinnedWasm` set, so a
  full-frame OOM no longer condemns small tiles; backend log states the real
  reason), `components/modals/DetectFeaturesModal.vue` (warn-box on
  Safari/Firefox that SuperPoint runs CPU-only + rewritten detection-resolution
  hints explaining the tiling interaction), `composables/usePipeline.js` +
  `stores/useImagesStore.js` (detect Cancel now hard-terminates the worker pool
  like reconstruct; a cancelled in-flight image reverts instead of erroring).
  Needs a manual browser run (Safari warn-box, cancel mid-SuperPoint).

- **2026-07-07 · SuperPoint per-image GPU→CPU fallback** —
  `core/features/superpoint.js`. WebGPU EP was hard-failing on large inputs
  (`std::bad_alloc` from a full-res convolutional activation exceeding the GPU
  buffer limit — e.g. 1200×1136), killing every image with no recovery. Mirrored
  LightGlue's self-healing pattern: sessions keyed `${modelKey}:${backend}`,
  `pinnedWasm` set + `chooseBackend`, and a try/catch around `session.run` that on
  a WebGPU failure pins CPU WASM for the rest of the run and re-runs the image on
  CPU (input tensor rebuilt per attempt so the re-run isn't handed a consumed
  buffer). Stopgap until tiled detection (TODO.md TD) removes the OOM at source.
  Typecheck + 330 tests green; in-browser fallback path unverified (Verification
  policy).

- **2026-07-07 · RESTRUCT · codebase reorganisation (RESTRUCTURE.md, all phases)** —
  mechanical, behaviour-preserving. `src/core/` grouped into `features/ sfm/ dense/
  products/ io/ help/` (crs/footprint/mask/types stay flat); `utils/` grab-bag
  dissolved (`detection.js`→pure `core/features/sift.js` + worker routed through it,
  `camera.js`→`io/cameraKind.js`, `importKind.js`→`io/importKind.js`,
  `cameraEstimated.js`→`sfm/cameraEstimated.js`); `matching.js` split into
  `features/bruteforce.js` + `features/verify.js`. God files broken up: `sfm.js`
  1417→1029 (`rotations`/`cycleFilter`/`tracks`/`initPair`); `App.vue` 1641→1297
  (composables `useTabDrag`/`useSidebarResize`/`useImportRouting`/`useExports`/
  `useModalEscape`); `Sidebar.vue` 1118→181 (6 section components under
  `components/layout/sidebar/` + `useContextMenu`); `compute.worker.js` 694→65
  (`workers/ops/{detect,match,sfm,dense,products}.js`). Each phase: `npm test`
  (188 pass) + typecheck + build green; the Vue/worker phases are browser-runtime
  and were NOT verified in a real browser (typecheck/build + binding audits only —
  needs a manual run). App.vue's remaining length is the flat template modal stack,
  left intact by choice (extracting a `<ModalStack>` would add prop/emit indirection
  for a cosmetic line win).

- **2026-07-07 · DX · Dense plane-cost homography sign (freckle root cause)** — the
  plane-induced homography in all three PatchMatch kernels computed `R·ray −
  t·(n·ray)/d`, but with the code's plane convention `d = n·P` (`n·X = d`) the correct
  sign is **`+`** (the `R − t·nᵀ/d` form assumes the opposite `n·X + d = 0`). Verified
  numerically: at the true depth/normal the old sign scores cost 0.11 (never bottoms
  out) vs 0.0000 flipped. Effect: PatchMatch settled on wrong depths everywhere → cost
  median ~0.7 (ZNCC ~0.29) *regardless of resolution/iterations* (the tell — a High-vs-
  Medium run left cost identical) → freckle + source-overlap seams, while sparse stayed
  clean (it uses `projectPoint`/`project_k1`, not `plane_cost`). Fixed in lockstep:
  `crates/reconstruction/src/mvs.rs`, `core/planeCost.js`, `workers/gpu/patchmatch.wgsl`
  (rebuilt `src/wasm/*`). Hidden for so long because `planeCost.test.js` only ever
  passed `t=[0,0,0]`, vanishing the term — now a non-zero-baseline ground-truth warp
  test guards it. Owed: re-run dense on CA…V to confirm cost medians fall to ~0.2–0.35
  and the freckle clears.

- **2026-07-06 · D3 · Distortion-model selector (general-SfM)** — sensors now declare
  a Brown-Conrady model — Pinhole / Radial (k1) / Radial (k1,k2) / Brown
  (k1,k2,k3,p1,p2) — in `core/distortion.js` (`DISTORTION_MODELS`, `coeffsForModel`,
  `inferDistortionModel`; `distortionOf` applies only the active model's coefficients,
  so a stale term from a model switch can't leak; undefined model ⇒ all five,
  back-compat). Store: `distortionModel` field on every sensor (EXIF → `pinhole`,
  imported → inferred from coefficients), validated edit path (`useSensorsStore`). UI:
  a Distortion column in `SensorTable.vue` (dropdown in Initial, read-only label
  elsewhere; inactive coefficient inputs disabled). Tests in `distortion.test.js`.
  Fisheye deferred to F6 (needs a virtual-pinhole dense undistort). UI is browser-only
  — unverified in-app.

- **2026-07-06 · D2 · Propagate self-calibrated distortion to dense** — the k1 D1
  folds into the sparse keypoints was lost at densify (dense undistorts rasters with
  the *sensor's* coefficients only), leaving the dense cloud in a slightly distorted
  frame vs the sparse cloud. `reconstruct` now accumulates the self-calibrated k1 per
  sensor across passes and exports it (`summary.selfCalDistortion`); the reconstruction
  store adds it to each sensor's dense `dist` (dense's camera K is the same BA-refined K
  the fold used, so applying k1 there reproduces the sparse frame — passes compose ≈
  additively for small residuals). Logs the applied calibration ('Dense' category).
  Covered by the D1 test's summary assertions (`sfm.test.js`). Pure JS — no wasm rebuild.

- **2026-07-06 · D1 · Fold self-calibrated k1 back into keypoints** — `refineIntrinsics:
  'f,k1'` estimated a shared radial k1 inside BA (`project_k1`, bundle.rs) that no
  downstream consumer applied — `projectPoint`, the track filter, reprojection stats,
  and the dense/ortho warp are all pinhole — so the model K carried a stranded k1: BA
  reported RMS 0.83px while pinhole stats read 7.35px, the pass-2 filter then gutted
  2862 → 737 points and dense froze on a k1-inflated fx (freckle). Fix in
  `runBundleAdjust` (`core/sfm.js`): after each self-cal pass, re-undistort each
  image's keypoints with the estimated k1 (`undistortPixel` is the exact inverse of
  BA's `project_k1`) and reset the model k1 to 0, so the pinhole invariant holds and
  stats/filter agree with BA. Logs the fold (image count + mean px shift). Test in
  `sfm.test.js` (distorted synthetic, no sensor, `f,k1` → K.k1 = 0, postBA median <
  1px, model survives). Pure JS — no wasm rebuild. D2 (propagate the calibration to
  dense) + D3 (distortion-model selector UI) remain in TODO.

- **2026-07-06 · LightGlue un-hang: fused model + keypoint cap + wasm threads** —
  the "stuck on one-time graph warm-up" had three stacked causes. (1) Bundled
  `lightglue.onnx` was the fabio-sim **v0.1.0** export: 9,729 nodes of dynamic-shape
  bookkeeping that hang ORT's WebGPU EP in shader-compile warm-up → replaced with
  **v1.0.0 `superpoint_lightglue_fused_cpu`** (1,359 nodes, fused MHA/LayerNorm/Gelu;
  offline-verified **bit-identical matches** and runnable on the repo's
  onnxruntime-web 1.27 wasm EP; outputs are now `matches0` [M,2] + `mscores0` [M] —
  parser already handled both formats). (2) CPU fallback fed up to 5000 kpts/image
  into O(N²) attention (~45–60 s/pair measured) → new `maxKeypoints` cap in
  `matchLightGlue` (default 2048, strongest-first prefix so indices stay valid;
  `lgMaxKeypoints` in MatchFeaturesModal). (3) The 15 s "still matching" watchdog
  could never fire on CPU (ORT wasm `run()` blocks the worker event loop) → watchdog
  now GPU-only, CPU logs honest post-hoc timing. Also: COOP + **COEP credentialless**
  headers in `vite.config.js` (dev+preview) → cross-origin isolation → multi-threaded
  ORT wasm (~3× measured at 4 threads; credentialless keeps basemap tiles working,
  Safari degrades to single-thread); `classifyOutputs` in `core/superpoint.js`
  hardened against N=256 shape-collision. Offline validation also confirmed
  SuperPoint emits **(x,y)** keypoints + L2-normed descriptors (SP1 risk retired).
  **Browser run still unverified** — needs a manual Chrome + Safari pass (tiles
  under COEP, GPU warm-up, thread pickup).

- **2026-07-06 · Fix project-open freeze on projects with a saved model** — three
  causes. (1) `clouds` was a plain `ref`, so every point object + its `views` Map
  became deeply reactive → `markRaw` the per-cloud `points`/`cameras` at all
  construction sites (`useReconstructionStore.js`). (2) `reconstruction.json` stored
  the whole point cloud as JSON, so restore did a multi-MB main-thread `JSON.parse`
  → new **version-2 binary format**: metadata (cameras, viewUuids) in JSON, point
  data in transferable `recon.{cloudId}.{pos|col|vcount|vcam|vkp}.bin` sidecars
  (positions Float64, colours Uint8, view-tracks CSR); `opfs.js` splits/reassembles,
  store `serializeCloud`/`deserializeCloud` pack/unpack. Legacy inline shape still
  reads. (3) added an interaction-blocking "Loading project…" overlay
  (`projectLoading` in `App.vue`) so users can't act on a half-restored project.
  Also fixed doubled console lines on reopen: log ids are now globally unique
  (`useLog.js`, was `++_seq` which reset per page-load → duplicate Vue `:key`s) and
  the log-store restore trims the previous open's re-logged banner lines
  (`useLogStore.js`).

- **2026-07-06 · 3D viewer: frustum size ← camera spacing, not cloud extent**
  — camera frustums / image thumbnails were sized off the point-cloud bounding
  radius (`radius * 0.15`), so a small or outlier-inflated sparse cloud made every
  quad the same big size and they overlapped heavily. Now `cameraFrustumDepth`
  (`Viewer3D.vue`) uses the **median nearest-neighbour distance between camera
  centres** (`× 0.6`, invariant to cloud outliers + absolute scale), with a robust
  95th-pctile point radius as the <2-camera fallback.

- **2026-07-06 · 3D viewer: "View options" popover** — a viewer-local gear popover
  (top-right of `Viewer3D.vue`, NOT the ribbon / global Settings — these are
  ephemeral session-scoped display tweaks) with live **Camera size** (`cameraScale`
  multiplier on the auto frustum depth; rebuilds frustums via `buildFrustums` with
  no cloud recompute) and **Point size** sliders. Room to grow (background,
  thumbnail on/off); the ribbon "Cameras" toggle can migrate in later.

- **2026-07-06 · Command console C1 (power-user command line)** — a typed prompt
  in the DevConsole that drives the *same* dispatch as the ribbon
  (`handleCommand(id)`). Pure registry `core/commands.js` (tokenize / resolve /
  alias / completions / `guardReason` mirroring the ribbon's disabled-tooltips /
  help) with 30 Tier-1 parity commands incl. 2-token `export <what>`; unit-tested
  (`core/commands.test.js`, 17 cases). Impure binding `composables/useCommands.js`
  (echo → resolve → guard → dispatch, plus `help`/`clear` built-ins). `DevConsole.vue`
  gains a prompt (↑/↓ history persisted to localStorage, Tab completion to longest
  shared prefix, auto-focus on open); `App.vue` passes `handleCommand` +
  `commandState`. Tier-2/3 (`run` chaining, `set`, `stats`, `pair`, Cmd/Ctrl-K)
  remain in TODO CC. `npm test` + typecheck + `vite build` green; runtime prompt
  behaviour is browser-only, not yet manually exercised here.

- **2026-07-05 · Six UX/quality improvements** — (1) Console
  (`DevConsole.vue`) sticky-bottom auto-scroll made explicit (`stickToBottom` set
  from a `@scroll` handler) + floating "↓ New logs" chip when detached. (2)
  Unaligned images: `App.vue` `alignedUuids` (union of sparse-cloud camera uuids)
  dims/flags unregistered images in the sidebar (`Sidebar.vue` `isUnaligned`) and
  fades their markers on the map (`ViewerMap.vue`); the 3D view already only draws
  registered-camera frustums. (3) Removed the "run reconstruction" link in the
  empty Point Clouds state. (4) Match **soft-disable**: `useMatchesStore`
  `setPairDisabled` adds a persisted `disabled` flag (excluded at reconstruct time
  in `useReconstructionStore.js`); toggled from `MatchListModal` (row/preview) —
  reversible, survives reload. (5) Connected-Papers-style **graph view**
  (`components/viewers/MatchGraph.vue`, canvas force layout, no dep) as a
  List/Graph toggle in `MatchListModal`; click edge → preview, double-click →
  exclude/restore, node colour = aligned/unaligned. (6) Progress ETA
  (`ProgressModal.vue`) now blends the cumulative mean with a per-item EMA and
  eases the displayed value (`smoothedEta`) for a smoother countdown.

- **2026-07-05 · Glossary (in-app help) overhaul** — replaced the CK3-style
  cascading side panels with a single centered **tabbed** modal
  (`components/glossary/GlossaryModal.vue`, `useGlossaryStore` = `tabs`/`activeId`)
  with a home index + search. Hover popup (`GlossaryTooltip.vue`) now shows a
  **border progress ring** that pins the popup once filled (interactive:
  cross-links + "Read more"); the keyword itself is no longer a click target
  (`GlossaryTerm.vue`, hover-only, setting-gated). `core/help.js` →
  `core/glossary.js`: adds `getAllHelpEntries`/`searchGlossary`, KaTeX
  (`$…$`/`$$…$$`, `marked-katex-extension` + `katex/dist/katex.min.css` in
  `main.js`), `assets/*` image resolution, and **auto-linking** of any entry
  title/alias (opt out with `<span class="no-help">`). New persisted
  `glossaryTermsEnabled` toggle (`composables/useGlossarySettings.js`, wired into
  Settings ▸ Display) and Ribbon *Other ▸ Glossary* entry (`open-glossary`, new
  `book` icon). Verified: `npm test` (164, incl. 16 new glossary), `typecheck`,
  `npm run build` all green. **Not browser-verified here**: the ring/pin hover
  interaction, tab management, and KaTeX/image rendering need a manual run.

- **2026-07-04 · Duplicate-keypoint suppression + inlier-spread reject (two more
  repetitive-structure defenses)** — closes the many-to-one escape hatch: the SIFT
  detector emitted several index-distinct keypoints within ~1px of one strong blob
  (same DoG extremum across adjacent scales/octaves), letting a repetitive-structure
  pair pass cross-check + ratio (each duplicate is a *distinct* index) and then get
  RANSAC-blessed by a degenerate F that parks the epipole at the shared point — while
  the H/F flag reads *healthy* (a homography can't fit a many-to-one bundle). Two layers:
  - **Detection-side dedup (root fix, `crates/sift/src/lib.rs`, WASM rebuilt):**
    `suppress_duplicate_positions` runs after response-desc sort, before the
    `max_keypoints` cap — spatial-hash NMS (cell = radius) keeping the strongest
    keypoint within `DEDUP_RADIUS_PX` (2px). `detect_sift` now emits a *second* trailing
    sentinel (`suppressed`) after `raw_found`; parse is `kept = floor((len-2)/STRIDE)`,
    updated in both parsers (`utils/detection.js`, `workers/compute.worker.js`) and
    logged per image (`SIFT … −N duplicate-position keypoints suppressed`).
  - **Position-aware reject (belt-and-suspenders for old keypoints / future matchers,
    JS only):** `inlierSpread` (`core/matching.js`, pure/exported/unit-tested) measures
    the accepted inliers' unique rounded positions + bounding-box diagonal per image;
    `useMatchesStore.matchPair` hard-rejects a pair whose inliers collapse — unique spots
    < `minInlierUniqueFrac` (0.5) × inliers (many-to-one) **or** extent < `minInlierSpreadPx`
    (8px) in either image (epipole degeneracy). Distinct from the `degenerate` label
    (planar/pure-rotation, a seed-quality tag): this is a hard drop with its own
    `rejectReason` + debug spread line. **Acceptance owed on the real building set**
    (browser run): confirm the stone many-to-one bundles from B1 are gone and the
    suppressed-count log is non-trivial on the building images.

- **2026-07-04 · Rotation-cycle match filter + match-run logging (sparse)** — a fourth
  repetitive-structure defense plus two smaller diagnostics. **Acceptance owed on the
  real building set** (browser run): the target is B1's 4289↔4324 window-swap pair being
  dropped before it poisons registration. Where each lives:
  - **Rotation-cycle consistency filter** (`core/sfm.js` `rotationCycleFilter` + call site
    in `reconstruct()`, pure/exported, no WASM change): the graph-level catch for pairs
    that clear every count/ratio gate but are geometrically false. Decomposes each
    verified pair's essential matrix into a relative rotation (reuses existing
    `fundamentalToEssential`/`recoverPose`), then for every triangle `{i<j<k}` (enumerated
    once from its min–mid edge) measures the cycle error `‖R_ik⁻¹·R_jk·R_ij‖` as a geodesic
    angle and credits all three edges. **Greedy** removal: drop the single least
    cycle-consistent edge, recompute support (so a good edge dragged down by a bad
    neighbour recovers), repeat until every survivor with ≥`minTriangles` triangles clears
    the support floor. Runs after K-map/undistort, before init-pair selection; prunes
    `donePairs` in-memory only (store/OPFS untouched — recomputable). Unjudgeable edges
    (< `minTriangles`, or no `F`) are kept. Knobs: `cycleErrorDeg` 5°, `cycleMinTriangles`
    2, `cycleMinSupport` 0.3, gated by `rotationCycleFilter` (default on). A false edge
    breaks essentially every cycle it sits in, so it separates cleanly from true edges
    (~few°) regardless of inlier count. Tests: K4-with-one-bad-edge, all-consistent,
    reversed-edge canonicalisation, single-triangle-unjudged.
  - **Match-run knob logging** (`stores/useMatchesStore.js` `matchAll`): the run-start line
    now reports `cross-check on (mutual NN)/off` + `ratio`. cross-check was already wired
    (modal → `settings.crossCheck` → WASM matcher) but defaults **off** and left no console
    trace, so a run's putative-matching behaviour was unauditable. No behaviour change.
  - Not touched (owner's runtime call): the PnP inlier-fraction floor `minPnpInlierRatio`
    (`core/sfm.js`, default 0.15) — raising it to 0.30–0.40 gates borderline cameras but
    has no modal control yet.
  - Verified: `npm test` (155) + typecheck clean. No `crates/` change → no WASM rebuild.
- **2026-07-04 · Repetitive-structure defenses (sparse)** — three COLMAP/Metashape-parity
  guards against matches that survive fundamental-matrix RANSAC but link the wrong
  repeated feature (window↔window on B1's building façade: epipolar-consistent yet
  geometrically wrong). Landed as three separate commits on branch
  `matching-degeneracy-robust-tri`; **acceptance owed on the real building set** (a
  browser run — this env can't drive OPFS/WGSL). Where each lives:
  - **Robust multi-view track triangulation** (`crates/reconstruction/src/pose.rs`
    `triangulate_tracks` + `core/reconstruction.js` `triangulateTracks` +
    `core/sfm.js` `robustRetriangulateTracks`, the high-leverage one): batched RANSAC
    over a track's view pairs (parallax-gated seeds) → largest consensus → N-view DLT
    refine → per-observation inlier mask. In sfm.js it re-votes each ≥3-view track
    after retriangulation/merge and before the filter passes, dropping the
    observations that disagree with the majority + a settling BA. Fixes the case
    `filterTracks` can't: when the 2-view seed was the wrong window, the point sits
    wrong and the old filter deleted the *good* views to fit it. 2-view tracks pass
    through untouched. Toggle `robustRetriangulate` (default on). Tests: Rust
    `triangulate_tracks_recovers_point_and_rejects_outlier`, JS batch-marshalling case.
  - **H-vs-F degeneracy flag** (`crates/matching/src/lib.rs` `verify_matches_hf` +
    `homography_dlt`/`ransac_homography`; `core/matching.js`; `stores/useMatchesStore.js`;
    seed tweak in `sfm.js`): fit a homography via RANSAC alongside F, compare inlier
    counts. `hfRatio ≥ 0.8` ⇒ `entry.degenerate` (planar façade / pure rotation — a
    poor SfM seed with an ambiguous E decomposition). Not a rejection (the pair still
    bridges the graph); the flag rides through `useReconstructionStore` into SfM, where
    seed selection prefers non-degenerate adequate pairs. Output layout of the verify
    call grew by one (`hInlierCount`). Tests: Rust planar (H≈F) vs general (H≪F), JS
    parse guard.
  - **Min-views-per-point gate** (`core/sfm.js` `minTrackViews` + `ReconstructModal.vue`):
    drop points seen by < N images, applied **once** after all BA/filter passes
    (earlier would starve registration). Default 2 = no-op; 3 mirrors Metashape's
    "image count" gradual selection and kills 2-view window-swap residue at the cost of
    cloud density. Recorded in the run summary. Test: a scene with genuine 2-view tracks
    asserts the ≥3-view gate drops exactly those.
  - Both crates rebuilt (`src/wasm/*` committed with source). Verified: `cargo test`
    (matching 2, reconstruction 8) + `npm test` (147) + typecheck. The end-to-end effect
    on B1's window-swap matches is the number still to measure in-browser.
- **2026-07-04 · R1–R6 registration-robustness track (sparse)** — the fix for B1's
  poisoned-during-registration model. All six landed; **acceptance still owed on the
  real building set** (see Owed validations in TODO.md). Where each lives:
  - **R1 honest PnP acceptance** (`core/sfm.js`): a pose now needs
    `inliers ≥ max(minPnpInliers=15, minPnpInlierRatio=0.15·correspondences)`, not the
    old bare `≥6`. Kills the 6/137 (4%) coincidence fits; deferring is cheap (the sweep
    retries every pass).
  - **R2 fixed PnP gate** (`sfm.js`): the adaptive `min(reprj·maxGateScale, max(reprj,
    p95))` gate — which ballooned to 32px on B1 exactly when the model was worst — is
    replaced by a fixed `reprjThreshold × min(pnpGateScale=2, 2)`. Images that can't
    clear it wait for the next pass's tighter model rather than being let in loose.
  - **R3 interleaved bundle adjustment** (`sfm.js`, the big one): after every
    `interimBaEvery=5` new cameras, run a global BA (`interimBaIterations=12`, poses+
    points only) + a track-filter pass, `rebuildViewIndex()`, then continue the sweep
    against the tightened model. Reuses `runBundleAdjust`/`filterTracks`; BA + filter
    settings + the sensor-group map were hoisted above the registration loop.
  - **R4 track extension beyond PnP inliers** (`sfm.js`): `foldOneEndpointMatches(gate)`
    — for a verified match between two registered images with exactly one endpoint
    already on a track, add the other endpoint's observation when it reprojects ≤ gate.
    Called at each pass end + after each interim BA. Directly raises the ≥3-view share.
  - **R5 matching absolute-inlier override** (`stores/useMatchesStore.js`): accept a pair
    below the 0.25 ratio gate when `inlierCount ≥ overrideInliers=30` — the medium-overlap
    bridge pairs (27 inliers @ 0.23) that close building loops. Ratio gate still guards
    the low-count junk. Logs a `ratio-override` note.
  - **R6 solve for radial k1 in BA** (`crates/reconstruction/src/bundle.rs` +
    `core/reconstruction.js` + `sfm.js` + modal): new `refine_mode==3` ('f,k1') adds a
    shared per-sensor `k1` (Brown r²) to the intrinsic block with the **full analytic
    Jacobian** (distortion folded into `dudc/dvdc`, focal column, + a k1 column);
    `project_k1` applies it in the cost. Output intrinsics widened 4→**5** per camera
    (`fx,fy,cx,cy,k1`) — reconstruction.js parses the new stride; refined k1 is logged
    for the user to copy into the sensor table. Intrinsic refinement (f,cxcy/f,k1) is now
    restricted to the **post-filter** BAs (refining against the pre-filter mess drifted
    cy 180px on B1). WASM rebuilt. Tests: Rust `bundle_adjust_refines_shared_k1`
    (recovers k1 <0.02, sub-px), JS `refines a shared radial k1`, existing tests moved to
    the 5-wide stride.
  - **Instrumentation**: per-camera median-residual table after the final BA, flagging
    cameras > 2× the global median (would have surfaced B1's pass-2 cameras by name).
- **2026-07-04 · Docs restructure** — CLAUDE.md = evergreen, TODO.md = the one
  plan, HANDOVER.md = record (baselines + done log). Duplicated status text
  removed from all three.
- **2026-07-04 · P2 parallel + preselected matching** — matching was serial O(N²).
  (1) **Concurrency-safe match store**: `useMatchesStore` now `shallowRef` + in-place
  mutate + `triggerRef` (was `matchStore.value = new Map(...)` on every write, which
  races under concurrency). `descCache` caches the in-flight *promise* so shared
  images load once. (2) **Parallel `matchAll`**: concurrency-limited pool of
  `POOL_SIZE` drain loops over a shared cursor; POOL_SIZE `min(2,…)` → `min(8, hc−1)`.
  Cancellation cooperative. (3) **Preselection**: `core/preselect.js`
  (`preselectPairs` — k-nearest by camera position) + modal strategy/knob;
  `matchAll` prunes the exhaustive set via imported-pose positions, keeps pairs
  with an unpositioned endpoint. Tests: `preselect.test.js`. Note:
  `useImagesStore.sync()` was *not* a hazard here — matching writes matches, not
  the image doc. (Remnants → TODO "P2 remnants" + owed timing validation.)
- **2026-07-04 · A3 retriangulation + track merging** — post-BA structure recovery
  in `core/sfm.js` as two pure exported functions: `retriangulatePairs` (matches
  with *both* keypoints unassigned → triangulate with improved poses, keep if in
  front of both cams + reprojects ≤ `filterMaxReprojPx`; injected WASM DLT) and
  `mergeSplitTracks` (endpoints in two *different* points = split track → fold when
  the union is consistent + reprojects ≤ gate). Runs after the first global BA,
  then one more BA; logs the 2/3/4+ histogram delta. Unit-tested (`sfm.test.js`).
  (Runtime yield on real data → TODO "owed validations".)
- **2026-07-04 · F1 export dialogs + GeoTIFF** — reusable `ExportModal.vue`
  (`kind` = cloud|model|dem|ortho). Dependency-free **GeoTIFF** writer
  `core/geotiff.js` (`writeGeoTiff` + `geoKeysForEpsg`; LE, uncompressed, single
  strip, ModelPixelScale/Tiepoint + GeoKeyDirectory, GDAL_NODATA); exporters gained
  `demToGeoTiff` (float32, NaN→nodata) + `orthoToGeoTiff` (RGBA + alpha
  extra-sample); `cloudToPly` takes `{ binary, color }`. CRS→EPSG parsed from the
  working CRS. Formats: cloud PLY binary/ascii, model JSON (±tracks), DEM
  GeoTIFF/`.asc`, ortho GeoTIFF/PNG+`.wld`. Tests: `geotiff.test.js` (parse-back)
  + `exporters.test.js`. (Polish list → TODO "F1 polish".)
- **2026-07-04 · F1 exports (first cut)** — pure `core/exporters.js` (`cloudToPly`
  binary LE, `reconstructionToJson`, `demToAsciiGrid`, `rasterWorldFile`) +
  UI-layer `utils/download.js`; Ribbon export commands enabled, handlers in
  `App.vue`.
- **2026-07-04 · A4 radial/tangential distortion (undistort-at-ingest)** — pure
  `core/distortion.js` (Brown–Conrady forward + iterative inverse, k1,k2,k3,p1,p2;
  round-trip < 0.05px tested). Sparse: `sfm.js` undistorts keypoints once after
  the K map is built, so init/PnP/triangulation/BA stay pinhole (init-pair `F` is
  still the distorted-space fit — BA corrects it). Dense/ortho:
  `compute.worker.js` `undistortRaster` remaps each working-res raster +
  `undistortMaskLut` moves masks, in `getRaster`; DEM + ortho inherit it. Coeffs
  flow via the store (`sensor.k1..p2`); the sensor table already had the columns.
  Tests: `distortion.test.js` + sfm end-to-end (corrected < 1px, uncorrected > 2×
  worse). No WASM change. (Solving *for* k1 → TODO R6.)
- **2026-07-03 · A2 intrinsics self-calibration** — `bundle.rs` generalised:
  points still Schur-eliminated, reduced system carries optional **shared
  per-sensor intrinsic** blocks (focal scale `s`, `dcx,dcy` for `f,cxcy`) with
  analytic Jacobians. New wasm-bindgen args `sensor_of_cam` + `refine_mode`;
  output includes refined per-camera K. Wired through `bundleAdjust`, `sfm.js`
  (sensor→group map, refined K applied back, before→after focal +
  implied-film-width log with weak-observability caveat), store, and modal
  (`refineIntrinsics: none|f|f,cxcy`, default off). Tests: Rust (recovers 1.1×
  focal <1%), JS boundary + no-op. Mode-0 byte-unchanged. WASM rebuilt.
- **2026-07-03 · A1 LM bundle adjustment** — found already implemented
  (`bundle.rs`: LM + Schur complement + analytic Jacobians + adaptive Huber;
  never accepts a worsening step; hand-rolled linalg, dependency-free). Closed
  loose ends: noisy-convergence Rust test + BA-enabled end-to-end JS test.
- **2026-07-03 · Q1–Q5 quick wins** — Q1 fusion auto-maxCost clamp→0.45 +
  weak-signal warn (`core/mvs.js`); Q2 converged-BA logs debug not warn; Q3
  persisted run summaries (sparse + dense) in `reconstruction.json`; Q4
  implied-film-width sanity log + off-standard warn (`resolveK`); Q5 dense
  window default 2→3 (7×7). Tests in `mvs.test.js` / `reconstruction.test.js`.
- **2026-07 (earlier) · WebGPU dense backend, Phases 1–2 + buffer limits** —
  GPU PatchMatch kernel (see CLAUDE.md Pipelines for the stable description).
  Phase 1: single-source ZNCC `plane_cost` port + first-image A/B validation.
  Phase 2: full multi-source PatchMatch (~0.1s/img vs minutes on CPU).
  Buffer-limit fix: `device.js` requests the adapter's max
  `maxBufferSize`/`maxStorageBufferBindingSize` (defaults 256/128 MiB; state is
  npix×16 B, ~380 MB at maxDim≈5000 → cryptic "map async" failure);
  `depthMapGpu.js` pre-flights the state buffer and throws a clear "lower
  maxDim" message (worker catches → WASM fallback). (Phase 3 = TODO P1.)
- **2026-07 (earlier) · Products: DEM + orthophoto** — local vertical frame
  (`core/projection.js`, PCA fallback, aerial Z-up auto-orient via
  `rotateReconstruction`), Horn similarity georef (`core/georef.js`, persisted
  in `reconstruction.json`), DEM rasteriser (`core/dem.js`, IDW fill, auto GSD,
  hillshade preview), true-reprojection ortho (`core/ortho.js`, depth maps as
  z-buffer + colour), `DemModal`/`OrthoModal`/`ProductPreviewModal`, products
  sidebar + per-product tabs (`ProductViewer.vue`), OPFS persistence
  (`products/{kind}.json` + `.bin`; DEM rebuild deletes the stale ortho). All
  core parts unit-tested. Legacy models need one Reconstruct re-run for Z-up.
- **2026-07 (earlier) · Dense MVS pipeline (two-stage)** — Stage A per-image
  PatchMatch depth maps (WASM `compute_depth_map`, COLMAP/Gipuma-style:
  seeded random init, checkerboard propagation, plane-induced-homography ZNCC,
  best-K aggregation, random refinement) + Stage B `fuseDepthMaps` (cross-view
  consistency → dense cloud, `kind:'dense'`). Worker ops `computeDepthMaps` +
  `densify`; orchestration `core/mvs.js`; view-tracks persist in
  `reconstruction.json` so dense runs on a restored project. Runtime-tested on
  real aerial film.
- **2026-07 (earlier) · Camera intrinsics + sensor table** — `resolveK` gained
  a focal-mm + film/sensor-format-mm path (`fx = focal / formatMm × widthPx`),
  ranked above EXIF guesses; sensor table px/mm toggle + pixel-size/format
  columns; `Sensor.sensorWidthMm`. Follow-up fixes: `sensorWidthMm` was
  initially dropped from the worker payload (K stayed default-FOV — now
  forwarded); sensor table read the *selected* cloud's cameras so a dense cloud
  blanked Estimated/Diff (store now exposes `sparseCameras`).
- **2026-07 (earlier) · Phase 3: Web Workers** — all heavy wasm off the main
  thread: `compute.worker.js` + `computeClient.js` (round-robin pool, promise
  RPC); ~400-line reconstruction orchestration extracted verbatim into pure
  `core/sfm.js` with `onLog`/`onProgress` hooks; store became serialise → call
  worker → apply + persist.
- **2026-07 (earlier) · Phase 2: test harness** — Vitest, node env, wasm from
  bytes in `beforeAll`; reconstruction/crs/sfm tests. **Bug found & fixed:**
  the wasm essential-matrix decomposition recovered a wrong rotation — `svd3`'s
  degenerate column filled the wrong vector and `decompose_essential` didn't
  force det(U)=det(V)=+1 before U·W·Vᵀ. Fixed + rebuilt; ground-truth pose test
  passes to 3 decimals.
- **2026-07 (earlier) · Phase 1: `src/core/` extraction + TS foundation** —
  8 pure modules moved `utils/` → `core/` (rule: core imports no Vue/Pinia);
  `tsconfig` scoped to `src/core/**/*.ts`, `types.ts` value types, JS modules
  opt into TS by renaming.
- **2026-07 (earlier) · Pinia migration** — all shared domain state moved from
  composables to stores; project-store registry collapses restore/clear fan-out
  (sensors + images stay manual for ordering); old composables deleted.
