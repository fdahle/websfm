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
day. Releases: 0.2.0 on 2026-10-12, 0.3.0 on 10-18, 0.4.0 on 10-21, 0.5.0 on 10-28.

Camera positions are compared after a similarity fit to the reference (seven
parameters, so only the shape of the block counts). "Median" is the median camera-centre
error, and "off" counts cameras more than five times the median away.

---

## Sparse reconstruction

### ETH3D high-res: camera centres against the ground-truth cameras

ETH3D's six training scenes with laser-scanned ground truth (eth3d.net). The images
carry no EXIF focal length, so the focal length is estimated from the image pairs.
Registered cameras · median centre error (mm).

| scene | WebSfM (2026-10-25) | COLMAP (2026-10-16) | Metashape (2026-10-16) |
| --- | --- | --- | --- |
| courtyard | 38/38 · 7.4 | 38/38 · 32 | 38/38 · 5.3 |
| delivery_area | 44/44 · 2.9 | 44/44 · 22 | 44/44 · 1.4 |
| office | **20/26** · 1.7 | 26/26 · 5.8 · 3 off | 26/26 · 5.4 · 1 off |
| pipes | **8/14** · 3.9 | 14/14 · 5.1 | 14/14 · 1.1 |
| playground | 35/38 · 1.3 | 37/38 · broken (880 mm) | 38/38 · 1.5 |
| terrace | 23/23 · 2.5 | 23/23 · 5.9 · 1 off | 23/23 · 2.1 |

The gap is **registration on low-texture interiors**: office and pipes yield 500–2,000
keypoints per image at the default 2,400 px detection size; on pipes the unregistered
images reach 14–18 of the 20 correspondences that registration requires.

### Drone blocks against RTK, and GCP-free bending

Camera centres against the drones' RTK positions (cm, horizontal / vertical RMS), all
three tools without the positions in the solve. 2026-10-11.

| block | WebSfM | COLMAP incremental | COLMAP GLOMAP |
| --- | --- | --- | --- |
| quarry (Pix4D example, 347 images) | 28.7 / 70.2 | 49.5 / 84.7 | 49.0 / 86.4 |
| GeoScan PUTI (444 images) | 24.8 / 49.6 | 24.0 / 65.0 | 176.1 / 83.6 |

| block | WebSfM time (detect + match + SfM) | COLMAP incremental | COLMAP GLOMAP |
| --- | --- | --- | --- |
| quarry | ~530 s | 1,104 s | 624 s |
| PUTI | ~400 s | 1,511 s | 1,783 s |

Without control a nadir block bends, in every tool. It is the block's geometry, not the
self-calibration: with Metashape's calibration held fixed, PUTI is still 44 cm out
vertically. **With the RTK positions inside bundle adjustment**, PUTI's cameras are
1.59 / 1.33 cm and its 15 GCP checkpoints 3.35 / 7.0 cm.

COLMAP keeps 40–260 % more sparse points on these blocks. WebSfM's tracks are shorter
because it accepts fewer image pairs (South Building: 1,158 against 2,597).

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
