# WebSfM — benchmarks

How WebSfM compares with COLMAP, Metashape and reference data on public and
well-known datasets. Every number here is a measured run, not an estimate, and the
weak results are listed beside the strong ones. [METHODS.md](METHODS.md) explains the
methods behind them.

**How the runs were made.** WebSfM runs in Chromium through the headless bench
(`scripts/bench/`, the same code paths as the app), on one Linux workstation: Intel
i9-10900X (20 threads), 64 GB RAM, NVIDIA Quadro RTX 5000. Depth maps run on WebGPU
where noted, otherwise on the CPU through WebAssembly. COLMAP is 4.0.3 with CUDA,
Metashape 2.2.2, on the same machine, both at their defaults unless a row says
otherwise. Each table gives the date of its run; WebSfM was the `main` branch of that
day. Releases: 0.2.0 on 2026-10-12, 0.3.0 on 10-18, 0.4.0 on 10-21, 0.5.0 on 10-28, 0.6.0 on 10-31.

Camera positions are compared after a similarity fit to the reference (seven
parameters, so only the shape of the block counts). "Median" is the median camera-centre
error, and "off" counts cameras more than five times the median away.

---

## Sparse reconstruction

### ETH3D high-res: camera centres against the ground-truth cameras

ETH3D's six training scenes with laser-scanned ground truth (eth3d.net). The images
carry no EXIF focal length, so the focal length is estimated from the image pairs.
Registered cameras · median centre error (mm).

| scene | WebSfM (2026-11-07) | WebSfM, detection at 4,000 px | COLMAP (2026-10-16) | Metashape (2026-10-16) |
| --- | --- | --- | --- | --- |
| courtyard | 38/38 · 6.7 | 38/38 · 7.5 | 38/38 · 32 | 38/38 · 5.3 |
| delivery_area | 44/44 · 2.9 | – | 44/44 · 22 | 44/44 · 1.4 |
| office | **20/26** · 1.6 · 1 off | 26/26 · 2.6 | 26/26 · 5.8 · 3 off | 26/26 · 5.4 · 1 off |
| pipes | **8/14** · 3.9 | 14/14 · 1.6 | 14/14 · 5.1 | 14/14 · 1.1 |
| playground | 35/38 · 1.3 | 38/38 · 1.4 | 37/38 · broken (880 mm) | 38/38 · 1.5 |
| terrace | 23/23 · 2.2 | – | 23/23 · 5.9 · 1 off | 23/23 · 2.1 |

The gap is **registration on low-texture interiors**: office and pipes yield 500–2,000
keypoints per image at the default 2,400 px detection size; on pipes the unregistered
images reach 14–18 of the 20 correspondences that registration requires. Detecting at
4,000 px (Detect Features ▸ Detection resolution) registers every image of all three scenes;
doubling the keypoints at 2,400 px does not.

### Drone blocks against RTK, and GCP-free bending

Camera centres against the drones' RTK positions (cm, horizontal / vertical RMS), all
three tools without the positions in the solve. WebSfM 2026-11-07 (2026-10-11 in
brackets), COLMAP 2026-10-11.

| block | WebSfM | COLMAP incremental | COLMAP GLOMAP |
| --- | --- | --- | --- |
| quarry (Pix4D example, 347 images) | 20.3 / 13.4 (28.7 / 70.2) | 49.5 / 84.7 | 49.0 / 86.4 |
| GeoScan PUTI (444 images) | 26.5 / 14.6 (24.8 / 49.6) | 24.0 / 65.0 | 176.1 / 83.6 |

| block | WebSfM time (detect + match + SfM) | COLMAP incremental | COLMAP GLOMAP |
| --- | --- | --- | --- |
| quarry | ~530 s (2026-10-11) | 1,104 s | 624 s |
| PUTI | 332 s (2026-11-07, matching on WebGPU) | 1,511 s | 1,783 s |

Without control, COLMAP bends a nadir block into a dome of 0.65–0.85 m. WebSfM did too
(0.5–0.7 m) until its self-calibration was reworked: the whole lens is now solved, and
the decentring terms p1/p2 are kept where they explain the observations. Quarry's
vertical error went from 67 to 13 cm (Metashape: 12 cm, next section), PUTI's from 50 to
15 cm. **With the RTK positions inside bundle adjustment**, PUTI's
cameras are 1.59 / 1.33 cm and its 15 GCP checkpoints 3.35 / 7.0 cm.

COLMAP keeps 40–260 % more sparse points on these blocks. WebSfM's tracks are shorter
because it accepts fewer image pairs (South Building: 1,158 against 2,597).

### WebSfM against Metashape, sparse, same machine

Each tool at its defaults on the same photos, one run at a time: Metashape 2.2.2 Align
Photos (High, 40,000 / 4,000 points, generic preselection; photo positions switched off
in the solve) through `scripts/bench/metashape-ref.mjs`, WebSfM through the bench. Camera
centres after a similarity fit: against ETH3D's ground-truth cameras (median, mm),
COLMAP's South Building model (median, model units), RTK (quarry) and UseGeo's reference
orientations (H / V RMS, cm). WebSfM 2026-11-07, Metashape 2026-11-06.

| set | registered (WebSfM · Metashape) | camera error (WebSfM · Metashape) | time, s (WebSfM · Metashape) | peak memory, GB (WebSfM · Metashape) |
| --- | --- | --- | --- | --- |
| South Building (128) | 128 · 128 | 0.0049 · 0.0055 | 378 · 100 | 3.9 · 1.1 |
| ETH3D courtyard (38) | 38 · 38 | 6.7 · 5.2 | 56 · 36 | 3.2 · 1.5 |
| ETH3D delivery_area (44) | 44 · 44 | 2.9 · 1.4 | 33 · 31 | 2.9 · 1.5 |
| ETH3D office (26) | **20** · 26 | 1.6 (1 off) · 2.6 | 11 · 18 | 2.7 · 1.4 |
| ETH3D pipes (14) | **8** · 14 | 3.9 · 1.0 | 9 · 10 | 2.4 · 1.4 |
| ETH3D playground (38) | 35 · 35 | 1.3 · 4.2 (3 off, up to 1.06 m) | 45 · 42 | 3.4 · 1.5 |
| ETH3D terrace (23) | 23 · 23 | 2.2 · 2.1 | 27 · 22 | 3.2 · 1.5 |
| quarry, no GCPs (347) | 346 · 347 | 20 / 13 · 13 / 12 | 1,233 · 308 | 4.8 · 1.5 |
| UseGeo dataset 1 (224, 42 MP) | 224 · 224 | 3.8 / 6.1 · 3.3 / 8.5 | 708 · 247 | 3.8 · 2.2 |

- **Accuracy is level**: WebSfM is better on South Building, playground and UseGeo's
  heights, Metashape on four ETH3D scenes and quarry's horizontal. WebSfM was given
  UseGeo's reference calibration; Metashape calibrated itself.
- **Registration** still misses 6 of 26 office and 6 of 14 pipes images (low texture).
- **Time**: WebSfM matched on the CPU here (WebAssembly; the run had no WebGPU adapter),
  Metashape on the GPU, which is most of the gap on the large sets (quarry: matching
  1,062 s of WebSfM's 1,233). On WebGPU, PUTI's 444 photos match in 132 s. WebSfM's memory is the peak of the browser's renderer
  processes, Metashape's the peak of its process.

### Fisheye: FIORD MeetingRoom (200° lens)

106 images of 3264² px from an Insta360 One-inch (FIORD, Zenodo, CC-BY-4.0). Camera
centres against FIORD's model, as % of the 10.6-unit span (median / p95). 2026-10-15.

| run | registered | centre error median / p95 | self-calibrated f · cx · cy |
| --- | --- | --- | --- |
| WebSfM, FIORD's calibration | 104/106 | 0.174 / 0.355 % | — |
| WebSfM, self-calibrated | 103/106 | 0.155 / 0.387 % | 996.4 · 1610.6 · 1616.6 |
| COLMAP, self-calibrated | 106/106 | 0.180 / 0.447 % | 995.7 · 1610.9 · 1616.9 |
| Metashape, self-calibrated | 106/106 | 0.175 / 0.454 % | 996.1 · 1610.9 · 1617.0 |

The three self-calibrations agree to ~1 px. WebSfM registers 2–3 fewer images with a
quarter of COLMAP's points: rays more than 75° off-axis are dropped (33 % of the
keypoints on this lens).

---

## Bundle adjustment against Ceres (BAL)

The 98 problems of Bundle Adjustment in the Large (Agarwal et al. 2010): real photo
collections with their published tie points and starting cameras, 16 to 13,682 cameras.
WebSfM's solver, with the policy the app uses (the sparse direct solve; each camera its own
focal length, k1 and k2; no robust loss), against Ceres 2.2 (SPARSE_SCHUR, its defaults).
Both minimise the same ½Σ‖r‖², both on 20 threads, natively (`scripts/bench/bal/`; the app
runs the same Rust compiled to WebAssembly). Each run is capped at 2 h. 2026-11-05/06.

Final cost against Ceres' final cost, and time against Ceres' time (medians):

| set | problems | cameras | cost vs Ceres | worst | time vs Ceres |
| --- | --- | --- | --- | --- | --- |
| Ladybug | 31 | 49–1,723 | +0.00005 % | +4.0 % | 1.51× |
| Trafalgar | 14 | 21–257 | +0.00004 % | +0.3 % | 1.15× |
| Dubrovnik | 16 | 16–356 | +0.008 % | +2.6 % | 0.94× |
| Venice | 29 | 52–1,778 | −0.07 % | +10 % | 2.31× |
| Final | 5 of 8 | 93–1,936 | −0.003 % | +0.002 % | 1.19× |
| **all** | **95 of 98** | | **+0.00004 %** | | **1.40×** (p90 3.6×) |

- **Same minimum on most problems.** 84 of the 95 end within 1 % of Ceres' cost, 69
  within 0.1 %, and 45 lower than Ceres.
- **Lower than Ceres on 12** by more than 1 %. Ceres stops early on two: venice-951 at 60×
  WebSfM's cost, venice-1638 at 1.5×.
- **Higher than Ceres on 11** by more than 1 %: eight dense Ladybug problems (+1.7 to
  +4.0 %), dubrovnik-135 (+2.6 %) and venice-1672 (+10 %). Four of the Ladybug gaps come
  from the start: the app's interface rounds it to f32, and Ceres given the same rounded
  start ends as high or higher. The others are different paths through a non-convex
  problem: Ceres tries a few far larger steps, recovers and settles lower, while WebSfM
  descends steadily into a nearby valley. On venice-1672 Ceres
  from the f32 start still ends at its own cost, so this is the path, not the start.
- **Speed depends on size.** Median 1.08× Ceres' time below 100 cameras, 1.07× for
  100–500, 1.18× for 500–1,000 and 2.29× above 1,000. WebSfM is faster on 23 problems, up
  to 5.8× (ladybug-539, 6.9 s against 40 s, ending 1.3 % lower). On the dense problems the
  factorisation dominates: Ceres hands it to an optimised BLAS, which WebAssembly does not
  have, so WebSfM uses its own.
- **The largest problems are the weak result.** Above 1 GiB of factor, the solve falls
  back to a preconditioned iterative one. final-1936 reaches Ceres' cost (+0.002 %) but
  takes 3,929 s against Ceres' 353 s. final-3068 and final-4585 do not finish in 2 h;
  Ceres takes 144 s and 1,018 s. On final-13682 (29 M observations) neither finishes:
  Ceres gives up after one iteration, WebSfM runs out of time.

The run found two bugs in WebSfM's solver, both fixed before these numbers were taken:
bundle adjustment gave up after eight rejected steps (the three largest Ladybug problems
ended at 28× Ceres' cost), and a single very distant point could hold back the damping of
the whole solve (dubrovnik-173: +1.3 % of Ceres' cost in 131 s, now +0.02 % in 16 s).
[METHODS.md](METHODS.md) §4.5 explains both, and the options that were tried and rejected.

---

## Dense reconstruction

### ETH3D high-res, ETH3D's own evaluator

Depth maps from the ground-truth cameras, scored by ETH3D's `multi-view-evaluation`,
F1 at 2 cm (%). WebSfM: Medium quality on WebGPU, Depth Maps ▸ Method Full (the default
on a GPU), object-capture scene type. COLMAP: `patch_match_stereo` with geometric
consistency, then `stereo_fusion`, at 2,000 px. 2026-10-26.

| scene | WebSfM | COLMAP |
| --- | --- | --- |
| courtyard | **74.3** | 66.7 |
| delivery_area | **71.9** | 69.5 |
| office | **62.4** | 39.0 |
| pipes | **53.7** | 39.2 |
| playground | 54.3 | **57.2** |
| terrace | **80.4** | 78.9 |
| **mean** | **66.2** | 58.4 |

The resolutions differ. At the same 2,000 px, with the defaults before Method Full,
WebSfM scored 59.0 against COLMAP's 58.4. COLMAP is the more precise (accuracy 87–98 %
against WebSfM's 76–93 % in that run), and WebSfM the more complete. Full takes 2.2–3×
the depth time of Fast (courtyard 66 → 202 s); Fast scores 62.0.

### ETH3D high-res against Metashape: time and quality

The same six scenes from the ground-truth cameras, each tool at Medium: WebSfM on WebGPU
(Depth Maps + Dense Cloud), Metashape 2.2.2 (Build Depth Maps + Build Point Cloud, CUDA).
ETH3D's evaluator could not be run here, so these scores come from
`scripts/bench/eth3d_score.py`, which follows its method with a model of what each laser
scan saw; it lands within about ±4 points of the official numbers above, so read the
differences between tools, not the levels. F1 at 2 cm (%), time in seconds. 2026-11-07.

| scene | WebSfM time | Metashape Medium time | Metashape High time | WebSfM F1 | Metashape Medium F1 | Metashape High F1 |
| --- | --- | --- | --- | --- | --- | --- |
| courtyard | 159 | 104 | 393 | 69.7 | **81.8** | 83.7 |
| delivery_area | 185 | 93 | 353 | 76.5 | **83.5** | 84.1 |
| office | 114 | 60 | 209 | **63.7** | 56.4 | 54.0 |
| pipes | 85 | 46 | 171 | **57.7** | 47.2 | 46.6 |
| playground | 166 | 84 | 324 | 65.0 | **76.9** | 77.8 |
| terrace | 118 | 60 | 219 | 85.4 | **87.5** | 86.9 |
| **total / mean** | 827 | 447 | 1,669 | 69.7 | 72.2 | 72.2 |

- **Time:** WebSfM takes 1.85× Metashape Medium's time and half of Metashape High's
  (before the PatchMatch changes of 2026-11-07: 1,230 s).
- **Quality:** level at 5 cm (mean F1 80.3 both). At 2 cm Metashape is more accurate
  (91.5 % against 83.0 %) at the same completeness (62.7 % against 62.2 %). WebSfM is
  ahead on the low-texture interiors and behind on courtyard and playground, where it
  is less complete (playground 50 % against 66 %).

### Aerial: UseGeo dataset 1 against LiDAR

224 undistorted 42 MP nadir drone images, ~2 cm GSD (UseGeo, ISPRS, CC BY-NC-SA 4.0),
with the reference orientations in the solve as camera positions. Dense cloud against the airborne
LiDAR on flat ground. 2026-10-28, WebGPU.

| Depth Maps ▸ Method | depth time | points | after removing the bowl: median / within 10 cm |
| --- | --- | --- | --- |
| Full (default on a GPU) | 41 min | 102 M | **2.9 cm** / 91 % |
| Fast | 13 min | 125 M | 5.1 cm / 78 % |

Both clouds also carry a bowl of −0.41 m at 229 m from the centre; with it, the median
error is 10 cm. Camera centres: 3.7 / 8.2 cm horizontal / vertical RMS against the
reference.

---

## Historical aerial film

The Grenoble historical-image benchmark: scanned aerial film with GCPs and a modern
reference DEM. GCPs split into control and checkpoints (every fourth label a checkpoint),
the same split for every tool. Checkpoints in metres (H / V RMS). 2026-10-13/14.

### Casa Grande 1978: 37 scans of 9139² px, 44 GCPs (33 control, 11 checks)

| run | cameras | checkpoints H / V | DEM vs 1 m reference RMSE / NMAD |
| --- | --- | --- | --- |
| WebSfM, preprocessed scans | 37/37 | 1.25 / 1.17 m | **1.42 / 0.73 m** |
| WebSfM, raw scans + fiducials | 37/37 | **1.05 / 0.96 m** | — |
| COLMAP defaults + GCP similarity | 37/37 | 1.18 / 14.1 m (leave-one-out) | 13.0 / 13.5 m |
| Metashape defaults (High) | **13/37** | 0.62 / 0.73 m (4 checks) | 16.0 / 1.04 m |
| Metashape, a tuned pipeline (LightGlue / RoMa matching) | 37/37 | — | 1.57–2.51 / 0.69–1.27 m |

COLMAP has no GCPs in its bundle adjustment, so the block's bend stays. Learned
features (DISK, SuperPoint with LightGlue) registered 9–10 of the 37 scans.

### Iceland 1980: 125 scans of 11425² px, 70 GCPs (52 control, 18 checks)

| run | cameras | checkpoints H / V |
| --- | --- | --- |
| WebSfM, detection size Auto | 124/125 | 1.74 / 1.98 m |
| COLMAP defaults + GCP similarity | 125/125 | 3.94 / 103 m (leave-one-out) |
| Metashape defaults | 117/125 | 1.51 / **0.95 m** |

WebSfM's vertical error is about twice Metashape's here; keypoint precision is the
lead.

### Antarctic trimetrogon film (TMA), no ground control

A glacier block from the USGS Trimetrogon Aerial archive (1960s), georeferenced from
DISK + LightGlue matches against Sentinel-2 imagery (Find GCPs), with no survey data.
DEM against the REMA reference DEM on stable rock, NMAD. 2026-10-24.

| run | NMAD on rock |
| --- | --- |
| WebSfM, Medium depth maps | 9.1 m |
| WebSfM, High depth maps, strict fusion | 7.1 m |
| hist-sfm (a Metashape-based research pipeline) | 6.4 m |

The ground control WebSfM found sits a median 6–7 m from hist-sfm's camera solution.
Coverage over snow and ice is the gap: in an earlier High run on the same block
(2026-10-23) the DEM covered 55 % of the area against Metashape's 99 %, because WebSfM
does not interpolate where matching finds no texture.

---

## Not yet measured

- Metashape's numbers for the drone blocks with RTK in the solve, beside WebSfM's.
- 1,000+ image real blocks (the 1,600- and 3,000-camera runs so far are synthetic).
- Strecha's fountain and Herz-Jesu sets.
