# WebSfM — benchmarks

How WebSfM compares with COLMAP, Metashape, OpenDroneMap (ODM) and reference data on
public datasets. Every number is a measured run; the weak results stand beside the strong
ones. [METHODS.md](METHODS.md) explains the methods.

**Where the numbers come from.** The tables of the sparse, dense, film and held-out
sections are written from one scoreboard run, `results/2026-11-26-62712b2` (commit
62712b2b, WebSfM 0.9.0 with the fixes after it), by `npm run bench -- publish` from
`scripts/bench/published.json`; the scores are in [benchmarks.json](benchmarks.json). Don't
edit those tables by hand: a unit test fails when they differ from the data. The README's
results table and the paper's tables are made from the same run. The sections with a date
of their own (fisheye, full pipeline, Mill19, bundle adjustment, LiDAR, TMA) are separate
runs, not yet part of the scoreboard.

**Setup.** One Linux workstation: Intel i9-10900X (20 threads), 64 GB RAM, NVIDIA Quadro
RTX 5000. WebSfM runs in Chromium through the headless bench (`scripts/bench/`, the app's
own code paths) on WebGPU. COLMAP 4.0.3 (CUDA), Metashape 2.2.2 and ODM 3.6.2 (GPU Docker
image) run on the same machine at their defaults, one job at a time.

**On the same terms.** Every tool gets what the photos lack in the same way: a dataset's
own calibration (UseGeo) is every tool's starting calibration, each refining it as it does
by default; positions in the solve carry the same per-photo accuracies; pairing by position
is mirrored in COLMAP and Metashape. WebSfM's time includes copying the photos into the
browser. WebSfM runs three times per job (five on ETH3D sparse, as every tool does there);
the other tools once. A table gives the median of the sound runs: a run whose camera error is
more than ten times the median of its runs went wrong (a wrong camera arrangement) and is
counted as failed. Camera positions are compared after a seven-parameter similarity fit, so
only the shape of the block counts; "off" counts cameras more than five times the median
error away. A reference tool's run is reused from an earlier run when the tool's version,
its config, the photos and our runner are unchanged (each job's `record.json` says which).

**Home ground.** WebSfM's defaults were developed on most of these sets: the regression gate
holds ETH3D, South Building and Casa Grande, and quarry and PUTI were studied in depth. The
[held-out sets](#held-out-sets) were never used to tune it.

---

## Sparse reconstruction

### ETH3D high-res and South Building

Registered cameras · median camera-centre error: against ETH3D's laser-scanned ground
truth (mm), and against COLMAP's South Building model (model units). The ETH3D images
carry no EXIF focal length. Five runs per tool and scene.

<!-- table:eth3d-sparse -->
| scene | WebSfM | COLMAP | Metashape | SfM time, s (in tool order) |
| --- | --- | --- | --- | --- |
| courtyard | 38/38 · 5.84 | 38/38 · 32.9 | **38/38 · 5.06** | 53 · 80 · 36 |
| delivery_area | 44/44 · 2.50 | 44/44 · 27.1 | **44/44 · 1.40** | 44 · 76 · 32 |
| office | 26/26 · 2.61 | 26/26 · 10.4 | **26/26 · 2.56 · 2 of 5 runs failed** | 21 · 33 · 19 |
| pipes | 14/14 · 1.61 | 14/14 · 4.73 | **14/14 · 1.08** | 17 · 18 · 10 |
| playground | 38/38 · 2.51 | 38/38 · 4.36 | **38/38 · 1.49 · 1 of 5 runs failed** | 41 · 54 · 35 |
| terrace | 23/23 · 2.57 | 23/23 · 5.80 · 1 off | **23/23 · 2.11 · 1 of 5 runs failed** | 30 · 35 · 21 |
| South Building | **128/128 · 0.0050** | reference | 128/128 · 0.0055 | 103 · – · 90 |
<!-- /table -->

- **Every camera registers** in every WebSfM run, and its five runs agree to 0.03 mm.
- **Metashape is the more accurate on ETH3D**, by 0.05 mm (office) to 1.1 mm (delivery_area),
  but some of its runs fail with a wrong camera arrangement, 100 to 1,000 times off: office
  in two of five runs, playground and terrace in one. WebSfM leads on South Building.
  COLMAP's median errors are 1.7 to 11 times WebSfM's.
- **Time**: WebSfM takes 1.1 to 1.7 times Metashape's time and is faster than COLMAP on all
  six scenes.

### Drone blocks, no positions in the solve

Camera centres against the reference positions (RTK for quarry, PUTI and EuroSDR; UseGeo's
reference orientations), horizontal / vertical RMS in cm. No tool uses the positions in its
solve (ODM's copies of the photos have their GPS removed). In brackets: cameras registered,
when not all.

<!-- table:drone-free -->
| block | WebSfM | COLMAP | COLMAP GLOMAP | Metashape | ODM |
| --- | --- | --- | --- | --- | --- |
| quarry | 20.0 / 11.3 (346/347) | 49.5 / 85.3 | 48.6 / 86.5 | **13.3 / 11.8** | 441 / 76.4 (346/347) |
| GeoScan PUTI | 24.7 / 22.8 | 24.4 / 61.8 | 104 / 63.3 | **9.54 / 29.1** | 33.0 / 85.3 |
| EuroSDR Wards Hill | 21.4 / 11.4 | 78.0 / 596 | 82.2 / 701 | **3.79 / 3.56** | 3.76 / 3.61 |
| UseGeo dataset 1 | 3.77 / 4.66 | 3.75 / 3.33 | **3.78 / 2.97** | 3.33 / 8.65 | 4.55 / 16.5 |
<!-- /table -->

- **Metashape is the most accurate on three of the four blocks.** On EuroSDR, ODM matches it
  (3.8 / 3.6 cm) and WebSfM is about five times behind (21.4 / 11.4 cm).
- **Heights without control:** COLMAP's blocks bend on quarry, PUTI and EuroSDR (62 to 701 cm
  vertical); WebSfM stays within 23 cm on every block.
- **PUTI and EuroSDR trade off:** WebSfM now holds a measured focal while it registers the
  photos. That keeps EuroSDR from breaking (572 / 1,405 cm before) and costs PUTI 8 cm of
  height (14.8 cm before).
- ODM's quarry RMS comes from a few cameras metres off; its median is about 13 / 7 cm.
- **UseGeo**, every tool from the same calibration: COLMAP and GLOMAP are the closest in
  height, Metashape horizontally.

Time for detection, matching and SfM (s; WebSfM's includes copying the photos into the browser):

<!-- table:drone-free-time -->
| block | WebSfM | COLMAP | COLMAP GLOMAP | Metashape | ODM |
| --- | --- | --- | --- | --- | --- |
| quarry | 342 | 1,551 | 1,079 | **299** | 11,255 |
| GeoScan PUTI | 431 | 2,002 | 2,185 | **417** | 20,982 |
| EuroSDR Wards Hill | 659 | 5,335 | 3,261 | **498** | 24,765 |
| UseGeo dataset 1 | 419 | 931 | 738 | **221** | 5,407 |
<!-- /table -->

### Drone blocks, RTK positions in the solve

The same blocks with each camera's RTK position and its stated accuracy in the bundle
adjustment, every GCP a checkpoint. Checkpoints (their count in brackets) and cameras against
RTK, horizontal / vertical RMS in cm. Metashape at its defaults with the same marks and
accuracies (`prep/quarry_marks.py`, `ref/metashape_checkpoints.py`).

<!-- table:drone-rtk -->
| block | run | checkpoints (cm) | mean height error (cm) | cameras vs RTK (cm) | SfM time (s) |
| --- | --- | --- | --- | --- | --- |
| quarry | WebSfM | 3.65 / 11.6 (9) | +11.3 | 5.43 / 3.70 | 353 |
|  | Metashape | 3.76 / 18.1 (9) | +17.9 | 4.50 / 3.21 | 314 |
| GeoScan PUTI | WebSfM | 3.07 / 7.93 (15) | +5.95 | 0.54 / 0.87 | 413 |
|  | Metashape | 2.43 / 6.44 (15) | +4.19 | 0.52 / 0.96 | 410 |
| EuroSDR Wards Hill | WebSfM | 0.96 / 1.21 (58) | -0.89 | 0.90 / 0.66 | 651 |
|  | Metashape | 0.98 / 1.63 (58) | -1.48 | 0.54 / 0.60 | 710 |
<!-- /table -->

- **EuroSDR:** level horizontally, WebSfM closer in height (1.2 against 1.6 cm).
- **PUTI:** Metashape is ahead by 0.6 cm horizontally and 1.5 cm in height.
- **Quarry:** WebSfM's checkpoint heights are the closer (11.6 against 18.1 cm). Both tools
  put the ground too high (+11 and +18 cm). The GCPs come in LV03 / LN02 and are converted to
  ETRS89 with swisstopo's CHENyx06 and CHGeo2004 grids, the camera heights are the drone's
  ellipsoidal RTK heights: a datum offset between the two would show the same in both tools.



---

## Full pipeline: time and memory

Each tool from photos to dense cloud, DSM, orthophoto and textured mesh at its defaults,
positions in the solve, one run at a time on the same machine and GPU. Seconds; peak memory
in GiB. 2026-11-08/09.

| block | tool | total | import + SfM | depth + dense | mesh | texture | DSM + ortho | peak | dense points |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quarry (347) | WebSfM | **2,094** | 391 | 1,220 | 47 | 194 | 208 | 13 | 73 M |
| | Metashape | 2,858 | 290 | 1,038 | 717 | 328 | 486 | **10** | 27 M |
| | ODM | 3,927 | 1,551 | 320 | 497 | 1,058 | 217 | 28 | 22 M |
| PUTI (444) | WebSfM | **3,011** | 500 | 1,890 | 65 | 242 | 259 | 23 | 142 M |
| | Metashape | 3,887 | 351 | 1,161 | 1,254 | 348 | 773 | **13** | 77 M |
| | ODM | 6,097 | 2,733 | 465 | 346 | 1,738 | 254 | 36 | 34 M |
| UseGeo (224) | WebSfM | **2,943** | 474 | 1,660 | 55 | 289 | 414 | **13** | 102 M |
| | Metashape | 4,066 | 261 | 1,555 | 1,079 | 403 | 767 | 14 | 50 M |
| | ODM | 4,737 | 1,541 | 440 | 437 | 2,030 | 100 | 41 | 29 M |

The products are not the same size, so read the stage columns with this:

- **Depth:** WebSfM computes depth at up to 1,500 px, Metashape at 1/4 of the photo size
  (Medium), ODM at 1/8 (its default `pc-quality` medium).
- **Mesh:** WebSfM's default mesh has 120–150 k triangles, Metashape's (High, from the depth
  maps) 4.6–9.2 M, ODM's 330–360 k.
- **DSM and ortho:** WebSfM's defaults stop at 4,096 px on the long side; Metashape and ODM
  build them at the full ground resolution.
- **Peak memory:** WebSfM's is the browser tab's process, without the GPU process;
  Metashape's the process; ODM's the container.
- ODM's features, matching and texturing run on the CPU; the GPU only speeds its dense step.
- WebSfM's total includes copying the photos into browser storage (60–210 s).

### 1,940 photos: Mill19 building

WebSfM alone on Mill19's *building* scene (1,940 drone photos of 4,608 × 3,456 px), from
photos to orthophoto and mesh in one browser tab, defaults throughout, Similar images
matching, the reference positions (Mill19's, from PixSfM) in the solve at σ 5 m.
2026-11-15.

| stage | seconds | result |
| --- | --- | --- |
| import | 232 | photos copied into browser storage |
| detection | 637 | 17.5 M keypoints |
| matching | 577 | 31,871 pairs |
| sparse model | 822 | 1,931 of 1,940 cameras, 1.35 M points |
| depth maps | 5,589 | 1,931 maps (41 GB) |
| dense cloud | 710 | 173 M points |
| reopen project | 10 | 67 GB in browser storage |
| DSM | 39 | 8,192 × 3,993 px |
| orthophoto | 2,525 | 11,776 × 5,741 px |
| mesh | 146 | 608 k triangles |
| **total** | **11,287** | 3 h 8 min; peak memory 12.6 GiB |

- **Camera positions** against the reference: median 0.31 m horizontal, p95 1.42 m,
  RMS 0.80 / 0.40 m horizontal / vertical; the largest errors (up to 5.4 m) are at one
  strip's end.
- **Without the positions** the block's far end lands 0.2–1.6 m from the reference,
  varying from run to run: a weakly held block edge, not the lens (a fixed reference lens
  gives the same spread).
- **No limit reached:** the sparse solve held 9.7 M observations in 2.3 GB; the dense
  cloud's fusion ran at its 16 GB budget. The next limits are the bundle adjustment's
  32-bit WebAssembly memory (about 9,500 cameras) and that fusion budget.
- The DSM's Auto resolution was capped at one 8,192 px tile; the orthophoto shows light
  smeared streaks in two places, not yet investigated.
- Depth maps are half the time, the orthophoto a quarter.

---

---

## Bundle adjustment against Ceres (BAL)

The 98 problems of Bundle Adjustment in the Large (Agarwal et al. 2010), 16 to 13,682
cameras, from their published starts. WebSfM's solver (the app's policy, run natively; the
app runs the same Rust as WebAssembly) against Ceres 2.2 (SPARSE_SCHUR), both minimising
the same cost on 20 threads, each run capped at 2 h (`scripts/bench/suites/bal/`). 2026-11-06.

| set | problems | cameras | cost vs Ceres (median) | worst | time vs Ceres (median) |
| --- | --- | --- | --- | --- | --- |
| Ladybug | 31 | 49–1,723 | +0.00005 % | +4.0 % | 1.51× |
| Trafalgar | 14 | 21–257 | +0.00004 % | +0.3 % | 1.15× |
| Dubrovnik | 16 | 16–356 | +0.008 % | +2.6 % | 0.94× |
| Venice | 29 | 52–1,778 | −0.07 % | +10 % | 2.31× |
| Final | 5 of 8 | 93–1,936 | −0.003 % | +0.002 % | 1.19× |
| **all** | **95 of 98** | | **+0.00004 %** | | **1.40×** |

- **Same minimum on most problems**: 72 of 95 end within 1 % of Ceres' cost and 12 more
  than 1 % below it; 11 end more than 1 % above (dense Ladybug problems, dubrovnik-135,
  venice-1672).
- **Speed depends on size**: about 1.1× Ceres' time below 500 cameras, 2.3× above 1,000.
- **The largest problems**, on 2026-11-06: final-1936 took 3,929 s against Ceres' 353 s,
  final-3068 and final-4585 did not finish in 2 h (Ceres: 144 s, 1,018 s), and neither
  tool finishes final-13682. The implicit solve below replaces that path.

### Past the memory budget: the implicit solve (2026-11-13)

Where the direct solve would hold more than 3 GiB (the reduced matrix twice, its factor,
the observations and points), WebSfM now solves the reduced system without storing it
(PCG on the implicit Schur complement, as Ceres' ITERATIVE_SCHUR). These three dense
"final" problems are where that happens: final-1936's reduced matrix alone is 2.2 GB, too
big for the browser twice over. Same machine, 20 threads; peak = what the solve allocated
at most (`peak_alloc_mb`).

| problem | WebSfM before | WebSfM now | peak | in Chrome | Ceres SPARSE_SCHUR | Ceres ITERATIVE_SCHUR |
| --- | --- | --- | --- | --- | --- | --- |
| final-1936 | 3,929 s, cost 4,650,456 | **114 s**, 4,650,385 | 1.1 GB | 156 s, 1.1 GB | 353 s, 4,650,388 | 101 s, 4,650,391 |
| final-3068 | > 2 h | **226 s**, 1,561,126 | 0.4 GB | 295 s, 0.5 GB | 144 s, 1,686,400 | 22 s, 1,701,437 |
| final-4585 | > 2 h | **822 s**, 5,071,546 | 2.1 GB | 924 s, 2.0 GB | 1,018 s, 5,086,913 | 627 s, 5,099,288 |
| final-13682 | > 2 h | ~2,300 s, 21,698,424 | 4.9 GB | – (past wasm32) | fails, 1,126,371,623 | – |

final-13682 (13,682 cameras, 29 M observations) ran natively with the implicit solve
forced and the Jacobian cache allowed, from a cost of 1,126,371,468 to 21,698,424 in 60
iterations; Ceres' SPARSE_SCHUR ends without a successful step. Its 4.9 GB peak does not
fit wasm32's 4 GiB, so in the browser it would need a Memory64 build. The time is the run's
active time (it was paused for the browser runs).

*In Chrome*: the app's threaded WebAssembly build (19 threads) in headless Chrome, the same
inputs (dev probe), memory the WebAssembly memory's high-water mark. final-1936 and -4585
end at the native cost to the last digit; final-3068 at 1,561,412 (+0.02 %, after 48
iterations against 40), a path that diverges from rounding differences in the maths
library. The direct solve in Chrome, final-961: 394 s against 248 s natively, the same
final cost, 1.9 GB.

- **The direct solve stays wherever it fits**, though the implicit one is often faster
  there. WebSfM's implicit solve forced on problems the direct solve holds (time, then
  final cost against the direct solve's): final-394 18 vs 29 s (+0.01 %), final-871 59 vs
  104 s (+0.27 %), final-961 82 vs 248 s (−0.004 %), but ladybug-1723 stops at the
  iteration cap 2.7 % above the direct solve's cost (22 vs 114 s), and venice-1778 is
  slower (1,106 vs 877 s, −0.06 %).
  Ceres shows the same split (its implicit solve on venice-1778: 1,051 s against 92 s).
  Faster sometimes and worse sometimes, by nothing the problem size shows, is a trade-off,
  so memory alone decides.
- The memory model (`direct_bytes`, bundle/solve.rs) predicts the measured peak or a
  little more (ladybug-1723 662 vs 661 MB, venice-1778 1,679 vs 1,469 MB). Keeping the
  observations in the caller's 32-bit form and writing the step into the tentative points
  cut the peak by 13–18 % on trafalgar-257 and dubrovnik-356, the results bit for bit the
  same. An aerial block's
  factor is 0.55 GiB at 10,000 cameras (synthetic grid, each camera overlapping three
  rings of neighbours), so aerial projects stay on the direct solve.
- Reproduce: `crates/reconstruction/examples/bal.rs <problem> app` (the memory-chosen
  solve; `implicit` forces it, `BAL_MEMORY_MB` sets the budget) and
  `ceres_bal <problem> 100 20 iterative_schur`.

---

---

## Dense reconstruction

### ETH3D high-res, ETH3D's own evaluator

Depth maps from ETH3D's ground-truth cameras, every cloud scored by ETH3D's own evaluator:
F1 at 2 cm (%) · time for the depth maps and the cloud. WebSfM: Depth Maps at Medium, Method
Full, WebGPU. COLMAP: `patch_match_stereo` and `stereo_fusion` at 2,000 px. Metashape: depth
maps at Medium (a quarter of the photo size) and High (half).

<!-- table:eth3d-dense -->
| scene | WebSfM | COLMAP | Metashape Medium | Metashape High |
| --- | --- | --- | --- | --- |
| courtyard | 78.0 · 157 s | 66.7 · 1,422 s | 83.4 · 108 s | **85.4 · 394 s** |
| delivery_area | 73.9 · 182 s | 69.5 · 1,908 s | **82.6 · 96 s** | 82.3 · 363 s |
| office | **64.3 · 108 s** | 39.0 · 1,186 s | 55.9 · 62 s | 54.1 · 217 s |
| pipes | **58.7 · 81 s** | 39.2 · 455 s | 44.7 · 49 s | 44.0 · 167 s |
| playground | 61.1 · 157 s | 57.2 · 1,343 s | 67.2 · 83 s | **67.5 · 326 s** |
| terrace | 80.9 · 109 s | 78.9 · 792 s | **84.0 · 58 s** | 82.7 · 214 s |
| **mean / total** | 69.5 · 794 s | 58.4 · 7,106 s | 69.6 · 456 s | 69.3 · 1,681 s |
<!-- /table -->

- **Level on average:** mean F1 69.5 (WebSfM), 69.6 and 69.3 (Metashape Medium and High),
  58.4 (COLMAP). WebSfM leads on the low-texture interiors (office, pipes), Metashape on the
  open outdoor scenes.
- **Time:** WebSfM takes 1.7 times Metashape Medium's time, half of High's and a ninth of
  COLMAP's.

### UseGeo dataset 1 against airborne LiDAR

224 nadir 42 MP drone images, ~2 cm GSD (UseGeo, CC BY-NC-SA 4.0), reference positions in
the solve (given without accuracies, so each tool uses its default). Dense cloud against the
LiDAR on flat ground, after a horizontal shift and a vertical offset. The full-pipeline runs
above, 2026-11-08/09; WebSfM's Fast row 2026-10-28.

| run | depth time | points | median / within 10 cm | without the bowl | bowl at the edge |
| --- | --- | --- | --- | --- | --- |
| WebSfM, Method Full (default on a GPU) | 25 min | 102 M | **8.1 cm** / 61 % | 2.9 cm / 92 % | **−0.32 m** |
| WebSfM, Method Fast | 13 min | 125 M | 10 cm / – | 5.1 cm / 78 % | – |
| Metashape, Medium | 11 min | 50 M | 13.3 cm / 38 % | **2.1 cm** / 96 % | −0.54 m |
| ODM, defaults | 7 min | 29 M | 9.2 cm / 55 % | 2.2 cm / 98 % | −0.43 m |

All three clouds bend into a bowl, which points at what they share (the reference positions
or the LiDAR heights) rather than at any one SfM. Without it, Metashape's and ODM's clouds
are the closer to the LiDAR on flat ground: their depth maps are coarser and filtered, which
suits flat ground.

---

---

## Historical aerial film

Casa Grande and Iceland are two of the image sets of
[HistoriX](https://isprs-archives.copernicus.org/articles/XLIX-B2-2026/9/2026/), the
Historical Images for Surface Topography Reconstruction Intercomparison eXperiment
(Dehecq et al., 2026, ISPRS Archives XLIX-B2-2026, 9–16): scanned film with GCPs and a
modern reference DEM. WebSfM and Metashape put the GCPs into their bundle adjustment, every
fourth one a checkpoint, the same split for both. COLMAP has no GCPs in its adjustment, so
its block keeps its bend: it is fitted to them afterwards by a similarity, every GCP scored
leave-one-out. Checkpoints in metres (H / V RMS, their count in brackets); each DEM against
the reference on its own cells, every tool's at 2 m; coverage is the share of the reference
area a DEM covers.

### Casa Grande 1978: 37 scans of 9139² px, 44 GCPs

<!-- table:film-cg -->
| block | run | cameras | checkpoints (m) | DEM vs reference RMSE / NMAD (m) | DEM coverage |
| --- | --- | --- | --- | --- | --- |
| Casa Grande 1978 | WebSfM | 37/37 | 1.08 / 1.02 (11) | 4.87 / 0.71 | 58 % |
|  | COLMAP (GCP similarity fit) | 37/37 | 1.17 / 13.2 (40) | 12.2 / 12.6 | 14 % |
|  | Metashape defaults | 37/37 | 1.08 / 0.88 (11) | 11.3 / 0.78 | 65 % |
|  | Metashape, 80,000 points + guided | 37/37 | 1.20 / 1.31 (11) | 6.53 / 0.90 | 65 % |
<!-- /table -->

Every tool aligns all 37 scans. The checkpoints of WebSfM and Metashape are level
horizontally, Metashape's 0.14 m closer in height. WebSfM's DEM is the more accurate on its
own cells (NMAD 0.71 against 0.78 m) and covers less (58 against 65 %): where matching finds
no texture, WebSfM leaves the cell empty rather than interpolating.

### Iceland 1980: 125 scans of 11425² px, 70 GCPs

<!-- table:film-il -->
| block | run | cameras | checkpoints (m) | DEM vs reference RMSE / NMAD (m) | DEM coverage |
| --- | --- | --- | --- | --- | --- |
| Iceland 1980 | WebSfM | 121/125 | 1.80 / 1.03 (17) | 29.4 / 1.50 | 36 % |
|  | COLMAP (GCP similarity fit) | 125/125 | 4.63 / 156 (67) | 156 / 142 | 8 % |
|  | Metashape defaults | 125/125 | 1.55 / 0.98 (18) | 40.7 / 1.38 | 66 % |
<!-- /table -->

Metashape leads: it aligns all 125 scans against WebSfM's 121 (four at the block's ends have
too few correspondences), its checkpoints are 0.25 m closer horizontally and level in height,
and its DEM covers 66 against 36 % with a lower NMAD (1.38 against 1.50 m).

### Antarctic trimetrogon film (TMA), no ground control

A 1960s glacier block georeferenced only from matches against Sentinel-2 (Find GCPs). DEM
against REMA on stable rock, NMAD. 2026-10-24.

| run | NMAD on rock |
| --- | --- |
| WebSfM, Medium depth maps | 9.1 m |
| WebSfM, High depth maps, strict fusion | 7.1 m |
| hist-sfm (a Metashape-based research pipeline) | 6.4 m |

Coverage over snow and ice is the gap: WebSfM's DEM covered 55 % of the area against
Metashape's 99 %, because it does not interpolate where matching finds no texture.

---

---

## Held-out sets

Sets never used to choose a default or tune a method, run only at a release
(`--heldout`): they show how WebSfM does on data nobody fitted it to.

### Strecha multi-view sets

<!-- table:strecha -->
| set | WebSfM | COLMAP | Metashape | SfM time, s (in tool order) |
| --- | --- | --- | --- | --- |
| fountain-P11 | 11/11 · 2.76 | 11/11 · 6.18 | **11/11 · 2.53** | 16 · 18 · 11 |
| Herz-Jesu-P8 | 8/8 · 10.6 | 8/8 · 9.19 | **8/8 · 4.66** | 17 · 8 · 7 |
| Herz-Jesu-P25 | **25/25 · 4.90** | 25/25 · 16.2 | 25/25 · 5.50 | 31 · 39 · 41 |
| entry-P10 | **10/10 · 11.4** | 10/10 · 23.7 | 10/10 · 12.8 | 17 · 11 · 28 |
| castle-P19 | 19/19 · 37.2 · 1 off | 19/19 · 117 | **19/19 · 24.4** | 20 · 22 · 41 |
| castle-P30 | **30/30 · 27.1** | 30/30 · 124 | 30/30 · 27.4 | 27 · 52 · 24 |
<!-- /table -->

Strecha et al.'s multi-view sets, cameras against the ground truth fitted to a laser scan,
median error in mm. WebSfM is the most accurate on three of the six sets, Metashape on the
other three; COLMAP is far behind on the castle sets.

### Iceland 1980, KH-9 mapping camera

<!-- table:film-heldout -->
| block | run | cameras | checkpoints (m) | DEM vs reference RMSE / NMAD (m) | DEM coverage |
| --- | --- | --- | --- | --- | --- |
| Iceland 1980 KH-9 | WebSfM | 4/4 | 7.40 / 6.22 (5) | 69.7 / 11.5 | 39 % |
|  | COLMAP (GCP similarity fit) | 4/4 | 13.5 / 554 (28) | 380 / 255 | 2 % |
|  | Metashape defaults | 4/4 | 9.58 / 9.82 (5) | 22.2 / 9.98 | 64 % |
<!-- /table -->

Four KH-9 mapping-camera frames, scanned and used at a quarter of their size, 28 GCPs (every
fourth a checkpoint for WebSfM and Metashape); every tool's DEM at 30 m. WebSfM's checkpoints
are the closer (7.4 / 6.2 against 9.6 / 9.8 m), Metashape's DEM covers more and is more
accurate (NMAD 10.0 against 11.5 m).

### Drone block with RTK positions: helenenschacht

<!-- table:drone-heldout -->
| block | run | cameras | checkpoints (cm) | mean height error (cm) | SfM time (s) |
| --- | --- | --- | --- | --- | --- |
| helenenschacht (176) | WebSfM | 176/176 | 4.26 / 8.82 (5) | +5.47 | 167 |
|  | Metashape | 176/176 | 12.5 / 235 (5) | -235 | 152 |
<!-- /table -->

176 photos from an Autel EVO II Pro RTK, their RTK positions and accuracies in the photos'
metadata, used in the solve by both tools; all five GCPs are checkpoints. Metashape puts the
ground 2.35 m too low: over this flat nadir block its self-calibrated focal stays near the
drone's stated one (4,372 against 4,404 px), while the checkpoints confirm WebSfM's
(4,199 px). From 50 m, a 4 % longer focal lowers the ground by about 2 m: the focal–height
ambiguity of a flat block held by camera positions alone.

---

## Not yet measured

- COLMAP, Metashape and ODM on a 1,000+ image block (Mill19 so far has WebSfM alone;
  Metashape 2.2.2 at its defaults aligned 704 of its 1,940 photos).
- Real blocks past 2,000 images (the 3,000-camera runs so far are synthetic).
