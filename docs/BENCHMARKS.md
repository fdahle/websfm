# WebSfM — benchmarks

How WebSfM compares with COLMAP, Metashape, OpenDroneMap (ODM) and reference data on
public datasets. Every number is a measured run; the weak results stand beside the strong
ones. [METHODS.md](METHODS.md) explains the methods.

**Setup.** One Linux workstation: Intel i9-10900X (20 threads), 64 GB RAM, NVIDIA Quadro
RTX 5000. WebSfM runs in Chromium through the headless bench (`scripts/bench/`, the app's
own code paths), the `main` branch of the date given. COLMAP 4.0.3 (CUDA), Metashape 2.2.2
and ODM 3.6.2 (GPU Docker image) run on the same machine at their defaults unless a row
says otherwise. Camera positions are compared after a seven-parameter similarity fit, so
only the shape of the block counts; "off" counts cameras more than five times the median
error away.

---

## Sparse reconstruction

### ETH3D high-res and South Building

Registered cameras · median camera-centre error: against ETH3D's laser-scanned ground
truth (mm), and against COLMAP's South Building model (model units). The ETH3D images
carry no EXIF focal length. All three tools on 2026-11-11, one after another, on the GPU
(`scripts/bench/scoreboard.mjs --only eth3d-sparse`).

| scene | WebSfM | COLMAP | Metashape | time, s (WebSfM · COLMAP · Metashape) |
| --- | --- | --- | --- | --- |
| courtyard | 38/38 · 7.5 | 38/38 · 32 | 38/38 · **5.2** | 49 · 79 · 37 |
| delivery_area | 44/44 · 2.6 | 44/44 · 27 | 44/44 · **1.4** | 46 · 82 · 33 |
| office | 26/26 · **2.6** | 26/26 · 9.2 | 26/26 · 3.9 · 2 off | 19 · 33 · 18 |
| pipes | 14/14 · 1.6 | 14/14 · 4.9 | 14/14 · **1.1** | 19 · 18 · 10 |
| playground | 38/38 · **1.4** | 37/38 · 4.5 | 38/38 · 1.5 | 40 · 76 · 34 |
| terrace | 23/23 · 2.5 | 23/23 · 8.5 | 23/23 · **2.1** | 32 · 42 · 20 |
| South Building | 128/128 · **0.0049** | reference | 128/128 · 0.0055 | 103 · – · 88 |

- **Every camera registers** at the defaults. The low-texture interiors (office, pipes)
  were the gap until detection scaled with the photo size in object projects (Detect
  Features ▸ Detection resolution ▸ By project type).
- **Accuracy is level with Metashape**: better on office, playground and South Building,
  behind on courtyard, delivery_area, pipes and terrace by 0.4–2.3 mm. COLMAP's median
  errors are 3–10× WebSfM's.
- **Time**: WebSfM takes 1.1–1.9× Metashape's time (detection, matching and
  reconstruction; copying the photos into the browser comes on top), and is faster than
  COLMAP on five of the six scenes.

### Drone blocks, no positions in the solve

Camera centres against the reference positions (RTK for quarry and PUTI, UseGeo's
reference orientations), horizontal / vertical RMS in cm. WebSfM 2026-11-07, COLMAP
2026-10-11, Metashape 2026-11-06, ODM 2026-11-08.

| block | WebSfM | COLMAP | COLMAP GLOMAP | Metashape | ODM |
| --- | --- | --- | --- | --- | --- |
| quarry (Pix4D, 347 images) | 20.3 / 13.4 | 49.5 / 84.7 | 49.0 / 86.4 | 13 / 12 | 58.0 / 11.6 |
| GeoScan PUTI (444) | 26.5 / 14.6 | 24.0 / 65.0 | 176.1 / 83.6 | – | 35.8 / 94.7 |
| UseGeo dataset 1 (224, 42 MP) | 3.8 / 6.1 | – | – | 3.3 / 8.5 | 4.5 / 16.6 |

- **Heights without control**: COLMAP domes both blocks by 0.65–0.85 m, ODM PUTI by
  95 cm; WebSfM and Metashape stay within 15 cm.
- ODM's quarry RMS comes from a few cameras metres off; its median is 13 / 7 cm. WebSfM was
  given UseGeo's reference calibration, the others calibrated themselves.
- COLMAP keeps 40–260 % more sparse points: WebSfM accepts fewer image pairs, so its
  tracks are shorter.

Time for detection, matching and SfM (s, photo import not counted). WebSfM with the
positions in the solve, the others without:

| block | WebSfM (WebGPU, 2026-11-08) | COLMAP (2026-10-11) | COLMAP GLOMAP | Metashape (2026-11-06) |
| --- | --- | --- | --- | --- |
| quarry | 331 | 1,104 | 624 | 308 |
| PUTI | 351 | 1,511 | 1,783 | – |
| UseGeo | 261 | – | – | 247 |

### Drone blocks, RTK positions in the solve

The same blocks with each camera's RTK position and its stated accuracy in the bundle
adjustment, every GCP a checkpoint. Checkpoints and cameras against RTK, horizontal /
vertical RMS in cm; time for detection, matching and SfM in s. WebSfM PUTI 2026-11-08,
the rest 2026-11-10. Metashape at its defaults with the same marks (`quarry_marks.py`,
`metashape_checkpoints.py`). Optimize Cameras afterwards changes Metashape's numbers by
less than 1 mm, so it gets no row of its own.

| block | run | checkpoints | mean height error | cameras vs RTK | time |
| --- | --- | --- | --- | --- | --- |
| quarry (347, 9 checkpoints) | WebSfM | 6.4 / 30.2 | +29.5 | 10.4 / 5.4 | 327 |
| | Metashape | **3.8 / 17.8** | +17.6 | **4.5 / 3.2** | 295 |
| GeoScan PUTI (444, 15 checkpoints) | WebSfM | 3.4 / 11.1 | +9.8 | 1.8 / 1.2 | 351 |
| | Metashape | **2.4 / 6.4** | +4.1 | **0.5 / 1.0** | 418 |

- **Metashape is ahead on both blocks.** Its checkpoint heights are 5–12 cm closer.
- **Both tools put the ground too high on both blocks**, by the same pattern: WebSfM's
  focal comes out about 2 px shorter (quarry 4,402.1 against 4,404.0 px, PUTI 5,673.5
  against 5,675.3). A flat nadir block with RTK alone barely fixes the focal, and the
  heights follow it. On PUTI, the lens shape, the lever arm and the tie points were ruled
  out. Metashape itself moves 6 cm when it is given one more lens term.
- **Most of the quarry's height offset is shared by both tools** (+18 cm in Metashape).
  The GCPs come in LV03 / LN02 and are converted to ETRS89 with swisstopo's CHENyx06 and
  CHGeo2004 grids. The camera heights are the drone's ellipsoidal RTK heights. A datum
  offset between the two would show up the same way in both tools.

### Fisheye: FIORD MeetingRoom (200° lens)

106 images of 3264² px (FIORD, CC-BY-4.0). Camera centres against FIORD's model, % of the
scene span (median / p95). 2026-10-15.

| run | registered | centre error | self-calibrated f · cx · cy |
| --- | --- | --- | --- |
| WebSfM, FIORD's calibration | 104/106 | 0.174 / 0.355 % | — |
| WebSfM, self-calibrated | 103/106 | 0.155 / 0.387 % | 996.4 · 1610.6 · 1616.6 |
| COLMAP, self-calibrated | 106/106 | 0.180 / 0.447 % | 995.7 · 1610.9 · 1616.9 |
| Metashape, self-calibrated | 106/106 | 0.175 / 0.454 % | 996.1 · 1610.9 · 1617.0 |

The calibrations agree to ~1 px. WebSfM registers 2–3 fewer images because it drops rays
more than 75° off-axis.

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

---

## Bundle adjustment against Ceres (BAL)

The 98 problems of Bundle Adjustment in the Large (Agarwal et al. 2010), 16 to 13,682
cameras, from their published starts. WebSfM's solver (the app's policy, run natively; the
app runs the same Rust as WebAssembly) against Ceres 2.2 (SPARSE_SCHUR), both minimising
the same cost on 20 threads, each run capped at 2 h (`scripts/bench/bal/`). 2026-11-06.

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
- **The largest problems are the weak result**: final-1936 takes 3,929 s against Ceres'
  353 s, final-3068 and final-4585 do not finish in 2 h (Ceres: 144 s, 1,018 s), and
  neither tool finishes final-13682.

---

## Dense reconstruction

### ETH3D high-res, ETH3D's own evaluator

Depth maps from the ground-truth cameras, F1 at 2 cm (%). WebSfM: Medium, Depth Maps ▸
Method Full, WebGPU. COLMAP: `patch_match_stereo` + `stereo_fusion` at 2,000 px. 2026-10-26.

| scene | WebSfM | COLMAP |
| --- | --- | --- |
| courtyard | **74.3** | 66.7 |
| delivery_area | **71.9** | 69.5 |
| office | **62.4** | 39.0 |
| pipes | **53.7** | 39.2 |
| playground | 54.3 | **57.2** |
| terrace | **80.4** | 78.9 |
| **mean** | **66.2** | 58.4 |

At the same 2,000 px WebSfM scored 59.0: COLMAP is the more precise, WebSfM the more
complete.

### ETH3D high-res against Metashape

The same scenes from the ground-truth cameras, both tools on the GPU. Scored with
`scripts/bench/eth3d_score.py` (ETH3D's method; within about ±4 points of the official
evaluator, so compare tools, not levels). F1 at 2 cm (%), time in seconds. 2026-11-07.

| scene | WebSfM | Metashape Medium | Metashape High |
| --- | --- | --- | --- |
| courtyard | 69.7 · 159 s | **81.8** · 104 s | 83.7 · 393 s |
| delivery_area | 76.5 · 185 s | **83.5** · 93 s | 84.1 · 353 s |
| office | **63.7** · 114 s | 56.4 · 60 s | 54.0 · 209 s |
| pipes | **57.7** · 85 s | 47.2 · 46 s | 46.6 · 171 s |
| playground | 65.0 · 166 s | **76.9** · 84 s | 77.8 · 324 s |
| terrace | 85.4 · 118 s | **87.5** · 60 s | 86.9 · 219 s |
| **mean / total** | 69.7 · 827 s | 72.2 · 447 s | 72.2 · 1,669 s |

- **Time**: WebSfM takes 1.85× Metashape Medium's time, half of High's.
- **Quality**: level at 5 cm. At 2 cm Metashape is more accurate; WebSfM leads on the
  low-texture interiors and is less complete on courtyard and playground.

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

--- | --- | --- | --- | --- |
| WebSfM, Method Full (default on a GPU) | 41 min | 102 M | 10 cm / – | **2.9 cm** / 91 % |
| WebSfM, Method Fast | 13 min | 125 M | 10 cm / – | 5.1 cm / 78 % |
| ODM, defaults | 7 min | 29 M | 9.2 cm / 55 % | **2.2 cm** / 98 % |

Both tools' clouds bend into the same bowl (−0.41 and −0.43 m at the edge), which points at
what they share (the reference orientations or the LiDAR heights) rather than at either
SfM. ODM's depth maps are at 1/8 of the photo size and filtered, which suits flat ground.

---

## Historical aerial film

The Grenoble historical-image benchmark: scanned film with GCPs and a modern reference
DEM. Every fourth GCP is a checkpoint, with the same split for every tool. Checkpoints in
metres (H / V RMS); DEM coverage is the share of the reference area the DEM covers.
WebSfM and Metashape (2.2.2 at its defaults: High, 40,000 / 4,000 points) were run on the
same day, 2026-11-10, and both put the GCPs into their bundle adjustment. COLMAP and the
raw-scan run are from 2026-10-13/14. COLMAP has no GCPs in its adjustment, so its block
keeps its bend; it is shown with a GCP similarity fit.

### Casa Grande 1978: 37 scans of 9139² px, 44 GCPs

| run | cameras | checkpoints | DEM vs reference RMSE / NMAD | DEM coverage |
| --- | --- | --- | --- | --- |
| WebSfM, preprocessed scans | **37/37** | 1.25 / 1.18 m | **1.41 / 0.68 m** | 41 % |
| WebSfM, raw scans + fiducials (10-13) | **37/37** | **1.05 / 0.96 m** | — | — |
| COLMAP (10-13) | **37/37** | 1.18 / 14.1 m | 13.0 / 13.5 m | — |
| Metashape defaults | 32/37 | 1.20 / 0.95 m (9 checks) | 9.06 / 0.82 m | **69 %** |
| Metashape, 80,000 points + guided matching | **37/37** | 1.20 / 1.29 m | 3.79 / 0.90 m | 65 % |

With every photo aligned, the checkpoints of the two tools are level. WebSfM's DEM is
more accurate, but it covers less ground: where matching finds no texture, WebSfM leaves
the cell empty rather than interpolating.

### Iceland 1980: 125 scans of 11425² px, 70 GCPs

| run | cameras | checkpoints | DEM vs reference RMSE / NMAD | DEM coverage |
| --- | --- | --- | --- | --- |
| WebSfM | 123/125 | 1.97 / 2.46 m (18 checks) | **20.0** / 2.44 m | 27 % |
| WebSfM (10-13) | 121/125 | 2.03 / 2.09 m (17 checks) | — | — |
| WebSfM (10-13), detection at Auto resolution | 124/125 | 1.74 / 1.98 m | — | — |
| COLMAP (10-13) | **125/125** | 3.94 / 103 m | — | — |
| Metashape defaults | **125/125** | **1.54 / 0.97 m** | 153.6 / **1.38 m** | **62 %** |

Metashape leads here:
- **Height error:** WebSfM's is two and a half times Metashape's.
- **DEM:** Metashape's is sharper (NMAD) and covers twice the area. Its RMSE comes from
  outliers that WebSfM leaves out.
- **Tracks:** WebSfM's are short. 65 % of its points are seen in three or more photos,
  and its reprojection median is 1.38 px.
- **Since October:** the heights look 0.37 m worse (2.46 against 2.09 m), but the two runs
  score different checkpoints. This run registers two more photos, which brings checkpoint
  153 into the score: it lies at the block's south-west end, is seen in only two photos and
  is 5.2 m off. Without it, the other 17 checkpoints give 2.18 m. The October run's files
  were lost, so which 17 checkpoints it scored cannot be confirmed; 153 is the only
  checkpoint seen in fewer than three photos.

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

## Not yet measured

- 1,000+ image real blocks (the 1,600- and 3,000-camera runs so far are synthetic).
- Strecha's fountain and Herz-Jesu sets.
