# Changelog

Notable changes to websfm. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Merge blocks that do not overlap.** Import ▸ WebSfM Project now brings the other
  project's solved model too and places it in this one by photos both solved, GCPs and
  markers marked in both, or both georeferences (*Its model* and *Place it by*), as
  Metashape's Align Chunks and Merge Chunks do. The merged model becomes the main one, and
  the one it was merged into stays in the list; each block keeps its own shape and lens,
  and Optimize Cameras adjusts them together. Importing into a project without a model now
  brings the other model in as it is; *Leave behind* keeps the old behaviour (photos only,
  then Match only new pairs and Add to the model, which needs overlap). Shared photos along
  one flight line are placed by their camera directions as well as their centres, which
  their nearly collinear centres alone leave open. Tested against known truth: unit tests
  move a block by a known similarity and place it back by each of the three ways, and a
  browser test merges a 5-photo model moved by a similarity into a copy missing two of its
  cameras, which land back within 10⁻⁶ of the block's span. On real blocks: GeoScan PUTI
  split into a west (240 photos) and an east (102) block with 102 photos left out between
  them, each placed by its RTK positions, merged by both georeferences to 3.8 / 8.3 cm at
  11 check points (H / V RMS), where the whole 444-photo block solved at once gives 3.4 /
  11.1 cm at 15; Casa Grande 1978 (film, blocks of 20 and 17 photos with their GCPs) merged
  to 1.68 / 1.50 m by the GCPs and 1.09 / 1.29 m by the georeferences, at 11 check points.
  A merge took 12–47 s.
- **How well the focal is fixed.** The Quality Report's Calibration card shows the
  refined focal with its ± (how well the photos fixed it), and says when a nadir block
  without camera positions or GCPs cannot fix it at all, so its heights scale with it.
  The bundle adjustments that settle the lens report each camera group's standard
  deviations, marginal over every pose and point (one extra factorisation at the
  solution); the log gives fx ± σ and the share of the camera-to-ground distance it moves
  heights by, in place of a note that fired on every set. Unit tests check the σ against
  the spread of the solved focal over 40 noise draws (with camera positions, and without
  control on tilted photos) and against a dense numerical covariance. On a 444-photo RTK block
  the focal is 5,671.1 ± 0.3 px with the positions in the solve (5,638.8 ± 1.4 from the
  photos alone, 5,675.3 in Metashape): the ± is the precision under the lens model and the
  entered accuracies, not the error, which the check points measure. The extra
  factorisation added no measurable time (Reconstruct 80 s either way).

### Changed
- **The example opens where its walkthrough starts.** Opening the Aukerman example now
  brings the ribbon's Reconstruct tab to the front, and the console is open the first time
  you start WebSfM (Other ▸ Console closes it, and it stays as you leave it).
- **Weak photo pairs are verified, not dropped at random.** Match Features now tries the
  best-scoring matches first when it checks a pair's geometry (PROSAC), and tries up to
  10,000 samples instead of 1,000 (RANSAC iterations). A pair whose good matches are a
  minority, such as a side-lap bridge or a wide baseline, used to be found only by chance:
  on synthetic pairs with 30 % true matches, 31 of 100 were found, now 100 of 100 (15 %:
  1 → 98). A pair with nothing in common still gives up after 1,000 samples. On blocks whose
  pairs overlap well nothing changes but a little time: quarry and GeoScan PUTI with RTK
  keep their accepted pairs (6,589 / 6,591 and 2,625 / 2,626) and checkpoints, matching
  149 → 154 s and 120 → 125 s; Iceland 1980 and Casa Grande 1978 film register the same
  123 and 37 photos (GCP fit 1.03 → 1.04 m). The Strict matching preset no longer lowers
  the sample count.
- **Cancel stops only the run.** Cancelling a Reconstruct or Tools run now stops just the
  workers that run was using: importing photos, building their previews, map and DEM
  previews and the segmentation tool carry on, and a worker that was idle keeps what it
  had loaded (the GPU matcher's cache, the learned models). A cancel is logged as a
  cancel, no longer as an error. Before, Cancel restarted every worker.
- **Truer heights from RTK-only drone blocks.** With RTK or PPK camera positions in the
  solve, Auto self-calibration now always solves the lens's decentring (p1, p2) instead of
  testing whether it lowers the reprojection error. With the camera heights held, even a
  decentring too small to show there moved the ground under them. GeoScan PUTI (444
  photos, RTK only, GCPs as checkpoints): p1, p2 now Metashape's (0.00019 / −0.00006
  against 0.00017 / −0.00007), checkpoints H / V 3.5 / 9.2 → 3.7 / 7.8 cm, mean height
  +7.5 → +5.5 cm (Metashape 2.4 / 6.4 cm, +4.1); UseGeo (224 undistorted photos, its
  positions at ±3 / 5 cm) even against its LiDAR (offset 2.7 → 3.0 cm, edge dome −3.5 →
  −2.4 cm, RMS 5.4 → 5.3 cm). Where the positions are consumer GPS, or GCPs hold the
  block, the test stays: keeping p1, p2 there gave PUTI at ±10 / 20 m checkpoints H 9 →
  45 cm, Casa Grande 1978 1.09 / 1.01 → 1.12 / 1.05 m and Iceland 1980 the same.
- **GCPs and RTK positions hold the model more firmly.** In the bundle adjustment a tie
  point now counts as precisely as it was measured, at the size Detect Features ran at,
  so GCPs and accurate camera positions carry their stated weight against it. Before,
  a tie point found on a photo detected at a quarter of its size counted 16 times what it
  measured. Same day, `main` against the change, same detection and matching: Iceland
  1980 film (detected at 1/4.8) checkpoints 1.97 / 2.46 → 1.74 / 1.02 m (Metashape
  1.54 / 0.97), Casa Grande 1978 1.25 / 1.18 → 1.09 / 1.01 m; quarry with RTK checkpoints
  6.4 / 30.2 → 4.6 / 21.6 cm and cameras against RTK 10.4 / 5.4 → 6.3 / 4.4 cm; PUTI with
  RTK checkpoints 3.4 / 11.1 → 3.5 / 9.2 cm, cameras 1.8 / 1.2 → 0.55 / 0.88 cm (Metashape
  0.5 / 1.0). The DEMs follow: Iceland against its reference DEM NMAD 2.44 → 1.28 m
  (Metashape 1.38), Casa Grande RMSE / NMAD 1.41 / 0.68 → 1.38 / 0.59 m, coverage
  unchanged. Tie-point residuals, registered cameras and run times are unchanged. With
  consumer GPS (PUTI's RTK positions given 2 / 2 / 4 m of noise at the 10 / 20 m default
  accuracy) the block's shape stays the same (26.5 / 14.6 → 26.6 / 15.2 cm), and a run
  without positions or GCPs solves exactly as before.
- **Close-range photos are detected at more of their resolution.** Detect Features ▸
  Resolution rule now defaults to *By project type*: in an object project each photo is
  detected at two thirds of its long side, 2,400 to 4,000 px; aerial projects keep one
  size for every photo, as before. On ETH3D's 6,048 px photos, 2,400 px registered 20 of
  26 cameras of *office* and 8 of 14 of *pipes*; 4,000 px registers every camera of all six
  scenes, at similar pose error (median: courtyard 6.7 → 7.5 mm, delivery_area 2.86 → 2.62
  mm, pipes 3.9 → 1.6 mm). The keypoint limit stays as set in that band: scaling it to
  ~28k with the area changed the error within noise and took 2–4× the matching time
  (courtyard 93 → 352 s on the CPU). Aerial blocks were mixed, so they keep the fixed
  size: Scale with image size gained on the Iceland 1980 film scans (check points 1.97 /
  2.46 → 1.45 / 1.96 m, 124 of 125 photos against 123) and lost height on a 42 MP drone
  block (UseGeo 1, cameras against the reference 3.8 / 6.1 → 3.8 / 9.6 cm), at 2.5× the
  time on the GPU and 3.8× on the CPU. Projects that chose a rule keep it.
- **Hold to a reference DEM sets the heights of a block placed by drone GPS.** With camera
  positions and no GCPs, the model is now placed in the frame the hold solved it in, its
  height set between the camera positions and the DEM by their accuracies; before, a fit
  to the camera positions afterwards put it back on the GPS heights and the DEM only
  corrected the shape. Evaluate ▸ Accuracy shows the source as *reference DEM*. With three
  or more GCPs nothing changes. On a 444-photo RTK block with its positions loosened to
  ±1.3 / 1.8 m (drone GPS) and the Copernicus DEM at its declared ±2 m, the 15 check
  points' heights went from 101.6 to 17.3 cm RMS (mean +100 → −11 cm), horizontally
  15.3 → 12.6 cm; a firmer ±0.5 m gave 29 cm. A rigid shift of the block changes no image
  residual, so its height is set in closed form (least squares between the positions and
  the held tie points) rather than left to the iterative solve. The DEM sets the height
  only when its vertical datum and the control's are declared; otherwise it holds the
  shape alone (undeclared EXIF heights 52 m from the DEM's geoid had pulled a 346-photo
  block 45 m and shrunk it 6 %). The hold is no firmer than the DEM agrees with the
  photos: σ is at least their local disagreement about a smooth surface. On a quarry
  where Copernicus disagrees by 5.6 m, its ±2 m had bent the block (V 13.4 → 16.8 cm);
  now the shape stays and the heights move from +3.00 to +2.37 m toward the DEM, which
  itself lies ~1.4 m high there. On a 178-photo 1970s Antarctic block (camera positions
  ±10 m, REMA held on half the rock outcrops), the scanned photos disagree with REMA by
  20 m on the steep rock, so the hold stays soft: the tie points' heights on the other
  half went from −7.7 to −6.4 m median against REMA (NMAD 13.3 → 12.9 m). With these
  checks it is no longer marked Experimental.
- **Add to the model is no longer Experimental.** Sparse Reconstruction ▸ Add to the model
  places new photos in a finished model as well as a full rebuild does, in about half the
  time. On a 347-photo quarry with its last 60 photos added, both registered 346 photos,
  the camera centres agreed to 4.7 cm RMS and both fitted the GPS alike (H 23.5 / 21.9 cm),
  in 34 s against 72 s; on South Building (98 + 30 photos) both registered all 128 and
  matched COLMAP's cameras alike (0.14 % of the block), in 15 s against 29 s.
- **Less noise on flat ground in aerial dense clouds.** Build Dense Cloud ▸ Point position
  puts each point at the mean depth of its own depth map and the maps that agree with it,
  so their noise averages out; Auto does this for aerial and mapping projects and keeps
  each map's own depth for object captures. On the same depth maps of a 347-photo aerial
  block with airborne LiDAR, the dense cloud's scatter about flat ground fell from 5.1 to
  4.0 cm, and the points within 10 cm of the LiDAR rose from 92.9 to 97.4 % (16 % fewer
  points). On six close-range ETH3D scenes the mean lowered F1 at 2 cm by 0.17 on average
  (more accurate, less complete), so object captures keep the old behaviour; choose
  **Mean of the agreeing views** or **Own depth map** to override Auto.
- **Mesh size follows the block.** Build Mesh ▸ Octree depth is Auto by default: it picks
  the depth for leaves of about 8 point spacings of the dense cloud, lowered until the mesh
  stays within the card's triangle limit (Coarse 250 k, Balanced 1 M, Fine 4 M), and the
  step names the depth and size before you run. A small block keeps depth 8 as before; a
  347-photo aerial block now gets depth 9 at Balanced (0.65 M triangles instead of 0.15 M,
  mesh 140 s instead of 46 s, the tab at 9.8 GB instead of 8.0 GB; texturing 3.5 min either
  way) and depth 10 at Fine (2.8 M triangles, 171 s, 19 GB). The limit is there because
  depth 11 on that block (11 M triangles) solved and then outgrew the 32 GB the tab had.
  The cards used to set depth 6 / 8 / 10 on every project; a depth typed in by hand is
  still used as is, with a warning when it predicts more than 4 M triangles.
- **DEM and orthophoto size follow the block.** At Auto a DEM keeps about one point per
  cell up to 8,192 px a side (built in blocks past 4,096), and an orthophoto takes two photo
  pixels a cell up to 16,384 px, instead of both stopping at 4,096 px; each Grid step says
  what Auto chose, and for the orthophoto the photos' own GSD. A small block's DEM stays as
  it was; its orthophoto gets finer, since it no longer follows the DEM's cells. On a
  347-photo aerial block at Auto: DEM 8,192 px instead of 4,096 (91 s instead of 40 s),
  orthophoto 11,581 px instead of 4,096 (560 s instead of 253 s, the tab at 13.5 GB
  instead of 9.1 GB, GeoTIFF 220 MB instead of 31 MB; the photos read at 86 % of native
  instead of 34 %). Set the photos' GSD for a full-resolution orthophoto.
- **Colour balance follows the camera's exposure.** The orthophoto's Colour balance and
  the texture's colour levelling start each photo's gain from the exposure in its EXIF
  (time, ISO, aperture), so a flight whose auto-exposure changed comes out even. Before,
  every gain was pulled towards 1 and held within two stops of it, which gave back part of
  a real exposure trend: on a simulated 60-photo strip whose exposure drifts fourfold, the
  levelled photos still differed by 96 % from one end to the other; centred on the EXIF
  exposure, 0.2 %. On a 347-photo aerial block whose exposure varies 10.2× (f/2.8 at
  ISO 320 to f/5.6 at ISO 125), no channel gain is clamped any more (10–11 before; four
  photos need 0.21–0.25), the orthophoto's overall level is unchanged (median gain 1.077
  against 1.066), and the texture's seams are as before (mean step 12.6 levels). A block
  shot at one exposure is unchanged.

### Performance
- **Depth maps keep the GPU busier.** Each finished map's filtering and preview now run
  while the next map is matched on the GPU, instead of the GPU waiting for them, and the
  depth filter's 3×3 median is computed by a fixed comparison network. The maps are
  exactly the same. Depth Maps on ETH3D courtyard (38 photos, Full, Medium): 147 → 135 s
  (−9 %, both passes −10 %), the same depth-map digest; the filter alone 340 → 200 ms per
  2.6 MP map.
- **Reading a large streamed cloud takes half the memory.** A tool that reads points from a
  large cloud now keeps only the points it needs as each octree node arrives, so its peak
  is those points plus one node, not about twice the cloud's data. A failed or cancelled
  read or export frees its LAZ decoder's memory, and the viewer keeps at most four
  decoders open.

### Fixed
- **The time left is not inflated by a run's start-up.** The progress window now measures
  how fast a run goes from its first finished photo, pair or map, and a time left that has
  halved replaces the one shown at once. On the example's Detect Features, each worker's
  first photo took 8–12 s (loading and compiling) and every later one about 2 s; measured
  from the start, the estimate said 6 minutes for a 21 s run (and up to 20 minutes on a
  cold browser), and held it on screen for 15 s.
- **Depth maps without a GPU say when they are starting.** On the CPU, Build Depth Maps now
  shows "Starting the CPU threads…" before its first map, the console says how many threads
  started and how long it took, and warns when the threaded build cannot start (each map
  then runs on one thread, many times slower). Before, the run sat at 0 % for several
  seconds without a word, and the time left counted that wait as map time: Firefox showed
  an hour for the example. Measured on the example without a GPU (42 maps at 600 px):
  Chrome 278 s, Firefox 244 s, both on 19 threads, about 7 s of it starting the threads.
- **Switching projects no longer writes into the wrong one.** Opening another project while
  one was open could save a piece of the old project's state (a camera pose, a layer's
  visibility) into the new project's folder, if a save fired during the switch. Saves now
  wait until the switch is done. "Project opened" shows only when the project did open.
- **A crashed worker no longer spoils the rest of the session.** When a worker's
  WebAssembly crashes, WebSfM replaces that worker and fails only the jobs it held; before,
  later calls ran on the broken instance. A worker that cannot load fails with its cause
  after three tries instead of retrying without end, and a message a worker cannot read
  fails its job instead of leaving it waiting.
- **Matching moves to the CPU when the GPU is lost.** After three GPU errors in a row, Match
  Features matches the remaining pairs on the CPU and says so in its summary. Before, every
  later pair first paid a failed GPU call.
- **Detect Targets can be cancelled.** Cancel stops the run (markers already placed stay),
  and a failure is reported instead of the progress bar simply closing.
- **Photos register at any model scale.** Registering a photo (P3P) solved poorly when the
  model's points lay very close together in its units: points a hundredth of a unit apart
  found no pose. The solver now centres and scales them, and works the same from 10⁻⁴ to
  10⁴.
- **A raised Min matches no longer lets false pairs in as weak.** A pair whose matches pile
  onto a few spots in one photo is rejected, also when Min matches is above the weak-pair
  floor; before, it could be kept as a weak pair. The match log now also labels a flat
  scene's pairs as planar, as it was meant to.
- **A part of a streamed cloud that fails to load is tried again.** The viewer retries it
  after 1 s and 2 s and logs the failure, instead of leaving a hole until the page was
  reloaded.
- **Very large buffers count against the memory budget.** A buffer of 2–4 GiB was recorded
  as 0 bytes, so a run could plan beyond its memory budget.
- **Dialogs close on Escape.** Shortcuts, What's New, Reseau and Panoramic now close on
  Escape also when the focus is outside them.
- **Guided track extension follows the rolling shutter.** With Rolling shutter on, guided
  track extension now looks for a point where the rolling-shutter model puts it. Before, it
  searched at the global-shutter projection, so near the top and bottom of a photo taken
  at speed (about 5 px at 10 m/s, a 30 ms readout and 2.7 cm GSD) the keypoint was outside
  the search window and the observation was lost. A unit test with a 30 px shift at the
  frame edges: 20 of 20 points extended (4 before), in JS and in the WebAssembly search.
- **Long corridors keep their sub-pixel fit.** The bundle adjustment now works about the
  cameras' centre, so a block far from where the model started (a long corridor, a seed
  with a short baseline) no longer gains a reprojection floor from number rounding. A
  perfect strip 3,000 seed baselines from the start reprojected at 0.09 px from rounding
  alone; it now stays at 0.0002 px.
- **A tab left on an old version says it must reload.** When a tab that kept working
  through an update later opens a dialog, the 3D view or a worker of the version it
  started on, and that file is gone, the update prompt now says this tab is out of date
  and it reloads once its work ends. Before, the run failed with "Failed to fetch
  dynamically imported module" or a worker error and no hint that a reload fixes it.
  websfm.app now answers a missing file with 404 instead of the start page.
- **A broken COPC file is refused instead of hanging.** Importing a COPC file whose
  hierarchy pages point at each other, or whose entries point outside the file, now stops
  with an error. Before, the first kind kept a worker busy with the progress stuck until
  Cancel, and the second reached the reader with impossible sizes.
- **Matches near the frame edge survive verification when the lens is known.** Photos whose
  camera group has a lens calibration (imported, or entered in the Sensors table) now have
  their matches verified with the lens taken out, as fisheye photos already were. A wide
  lens bends the epipolar lines past the 2 px gate in the outer ring of the frame, so
  verification threw those matches away; they are the ones that fix k2 and k3 and tie
  strips together. Synthetic pair through an assumed 94° lens (k1 −0.13, k2 0.11), 80 %
  forward overlap: true matches kept beyond ¾ of the half-diagonal below 50 % → at least
  98 %, in every band. Photos without a known lens are verified as before.
- **Camera-position accuracies stay on their axes.** The bundle adjustment now applies a
  camera position's horizontal and vertical accuracy in the directions they belong to,
  whatever pair of photos started the model. Before, they were applied along the model's
  own axes, which match the survey's only when the model was started from a nadir pair: in
  an oblique or terrestrial block an RTK position's loose height could act sideways and its
  tight horizontal along the vertical. A unit test solves one block in two model frames 90°
  apart with σ 1 / 1 / 100 cm and one position 0.5 m off in height: the camera centres
  agree to 6 mm (32 cm before). Nadir blocks change only within noise: quarry with RTK
  checkpoints H / V 4.59 / 21.6 → 4.67 / 21.9 cm, cameras against RTK 6.32 / 4.42 → 6.26 /
  4.39 cm; GeoScan PUTI with RTK checkpoints 3.70 / 7.76 → 3.71 / 7.74 cm, cameras 0.55 /
  0.89 cm both.
- **Detect Targets places fewer false ArUco markers.** A 4×4 ArUco marker must now read
  exactly, and once a model exists, a marker found far from where its GCP should appear is
  left out and counted in the log. Before, one wrong cell was corrected, so about one random
  pattern in 20 inside a dark square (a window, a solar cell) read as a marker of the
  default 4X4_50 dictionary and became a mark of a real GCP. A unit test reads 300 random
  patterns: at most 4 decode (about 15 before).
- **Oblique forward flights over flat ground start from the right camera pose.** Reconstruct
  now uses the photos' recorded attitude, or a third photo's camera position, to choose
  between the two poses a pair of photos of flat ground allows, and in aerial projects
  falls back to the photos looking down. Before, it always took the pose that put the
  ground at the more uniform depth, which is the wrong one for a camera flying towards
  where it looks at less than about 45° below the horizon (low oblique drone flights, video
  along the view, vehicle cameras over fields, water or roads), and every seed pair made the
  same mistake. When no evidence decides, the log says so and a seed retry tries the other
  pose. Unit tests on flat ground at 30° pitch, forward flight: the old rule picks a
  baseline 94° off; the attitude picks the true one at 80°, 45°, 30° and 20° pitch, and a
  third photo's position at 30°. The SfM golden scenes keep their seeds and models.
- **A single flight strip is no longer georeferenced at a random tilt.** Placed by camera
  positions alone, a single strip or corridor now takes its roll about the flight line
  from the photos looking down (aerial projects) or from imported omega, phi, kappa;
  otherwise Georeference says so and asks for GCPs or a second strip. Before, the
  positions' noise let the fit pass while the model could be turned about the line by any
  angle (a median of 90° over a simulated 30-photo strip, at 1.5 m and at 3 cm GPS
  accuracy). Unit tests: the roll reported for one strip exceeds 1°, two strips 60 m apart
  report under 0.1°, an aerial strip comes out level within 0.5° over five noise draws,
  and an object project's strip is refused.
- **COLMAP, OpenSfM and transforms.json line up with their images.** Models, cameras,
  keypoints and matches exchanged with COLMAP, OpenSfM and nerfstudio's transforms.json
  now take the half-pixel difference in where these tools put a pixel's centre into
  account. Before, an exported model was half a pixel off its photos in every image, about
  a pixel between strips flown in opposite directions in COLMAP dense or a Gaussian
  splatting trainer, and an imported one had the mirror error. Unit tests check that a
  centred principal point exports as COLMAP writes it and comes back exactly, and that a
  fundamental matrix and a homography keep the same points on them.
- **Camera positions in a foot-based CRS are weighed in metres.** In a project whose CRS
  is in feet (a US state plane), RTK camera positions are now recognised as survey-grade,
  positions without an accuracy get the 5 m default, and the GNSS antenna offset is
  applied at its true length. Before, all three were read in feet: a 0.1 m threshold
  became 0.1 ft, the default 5 ft, and the lever arm about a third of its length. A unit
  test builds the same positions in UTM metres and in US survey feet and checks both
  give the same verdict and the same 5 m default.
- **Conformal fiducial transform works with y-up certificates.** Film calibration with
  the *Conformal* transform now fits a calibration certificate whose y axis points up
  (the usual case) as well as *Affine* does. Before, it could not represent the flip
  between the certificate and the scan rows, and every keypoint went through a
  near-singular map (134,722 µm RMS on a synthetic 230 mm frame, now 4.7 µm). *Affine*,
  the default, and *Projective* were not affected.
- **Continuing a stopped matching run matches every pair.** Continue now matches again the
  pairs that failed or were cut off by Cancel before the stop. Before, such a pair could be
  counted as done although it had no saved result, and was then never matched.
- **Huge clouds with stray points import again.** Importing or editing a very large cloud
  whose extent is far larger than its data (a few stray points at 0, 0, 0 in a UTM
  cloud, or millions of points in one spot) no longer fails with "Cannot read properties
  of undefined (reading 'idx')". The octree build numbered its deepest cells past what
  its index could hold; a unit test splits a cluster down to the deepest level.
- **A run that fails at its start no longer locks the project.** If a Reconstruct or Tools
  run failed before it got going, its progress window now closes and the error is
  logged. Before, the window could stay open, and opening, switching or deleting
  projects was refused until the page was reloaded.
- **Workflow Builder's Dense Model block replaces the main dense cloud when asked.** With
  *Replace the main dense cloud* on, a workflow now replaces it as the Build Dense Cloud
  dialog does, instead of adding "Dense cloud 2, 3, …" on every run. The Depth Maps, Dense,
  DEM, Orthophoto, Mesh and Texture blocks now turn their settings into a run by the same
  code as their dialogs, so a block runs exactly as its dialog would; unit tests check each
  block against its dialog, with the defaults and with Replace on.
- **Optimize cameras and Gradual selection keep GCPs and positions at full weight.**
  Both tools now weigh a tie point as the reconstruction does, one pixel of the size
  Detect Features ran at. Before, they re-solved with every tie at one full-size pixel, so
  on a film or downsampled project Optimize cameras after adding GCPs pulled the model
  back towards its tie-only shape (by 23× at a detection scale of 1/4.8), partly undoing
  what the GCPs and RTK positions had corrected. The reprojection error still fell, so
  the acceptance check could not see it. A unit test checks that both tools hand the
  solver ties at 1/16 for a project detected at a quarter of the size, and GCP marks at
  their own accuracy.
- **Georeference from camera positions applies the GNSS antenna offset.** With a lever
  arm set in the Sensors table (its GNSS antenna offset), Georeference now
  fits the model to the antenna's position in each photo, as the bundle adjustment
  already did. Before, the final fit paired the camera centre with the antenna, so every
  product of a block placed by RTK or PPK positions without GCPs was shifted by the arm,
  the full vertical offset on a nadir block (often 5–30 cm on drones), and Evaluate ▸
  Pose Residuals showed a ± pattern between strips flown in opposite directions. A unit
  test flies a lawnmower block with a (0.10, 0.05, −0.30) m arm: a ground point now lands
  within 1 mm of its true position (0.29 m before) and every pose residual is under 1 mm.
- **Georeferenced PLY, STL and GLB exports keep their millimetres.** A cloud or mesh
  exported in map coordinates now reads back where it was: binary PLY writes the
  positions in double precision, GLB keeps a rounded offset as its node translation, and
  STL is written relative to an offset named in its header and the log. Before, all
  three stored map coordinates in single precision, which rounds a UTM northing to
  0.5 m. LAS, LAZ, COPC, ASCII PLY, XYZ and OBJ were already exact. A local-frame export
  is unchanged. Unit tests export points at (512345.678, 5432109.876, 312.345) through
  each writer, including the streamed PLY export of a large cloud, and read them back
  within 1 mm.
- **A failed rerun no longer loses the saved model.** When Reconstruct unloads the old
  model to make room and the run then fails or is cancelled, WebSfM now reads the saved
  model back. Before, the next ordinary action (hiding a layer, renaming a cloud) saved
  the empty placeholder over it, and the solved cameras, the georeference and the
  secondary models were gone from the project. Nothing is saved while the old model is
  unloaded; a store test unloads a model, toggles a layer, fails the run and checks that
  nothing was written and the cameras and points came back.
- **A georeference survives reopening the project.** A project placed by its photos' GPS
  could lose its georeference when it was opened again, until Georeference ran once more:
  the check that retires a fit whose poses or GCPs changed saw the project half-restored,
  or a photo's position half-rewritten, and took it for a change. It now waits for the
  project to finish opening, and positions are never written through an empty value. A
  camera-position or marker file that names the photos in another case or without the
  extension also retired it on every reopen, when its rows took the photos' names; the
  names no longer count, and projects saved that way keep their georeference again (a
  GeoScan PUTI half placed by its RTK file came back without one). A project saved with a
  photo's positions read twice (for example after adding photos) needs Georeference once
  more.
- **Build Mesh keeps to its memory budget.** A mesh solved in tiles now plans its workers
  with what the open project already holds, sends each worker only its tile's points,
  starts each tile on a fresh worker, and frees the workers before the tiles are joined.
  Quarry at depth 11 (73 M points, 16 GB budget): the tab's peak 32.1 → 15.1 GB, the same
  11.1 M-triangle mesh, in 676 s instead of 540 s (four workers fit the budget, not six).
  Step by step: planning and freeing 25.4 GB, per-tile points 19.3 GB, a fresh worker per
  tile 15.1 GB (a worker's heap grew past its estimate tile after tile).
- **Importing camera positions again updates them.** Importing a camera file a second
  time now replaces each photo's position, even when the file names the photos without
  the extension or in another case. Before, such a re-import (or one after reopening the
  project) added a second copy of every position, and bundle adjustment counted each
  camera's prior once per import, as if the positions were more accurate than stated.
- **Complete third-party notices.** About ▸ Licenses now lists everything WebSfM includes
  from others, each with its license text, and every copy of the app carries the same list
  as THIRD_PARTY_NOTICES.txt. The list was kept by hand and had fallen behind: it named 15
  of the 48 npm packages the build bundles and 7 of the 75 Rust crates in the WebAssembly
  modules, and lacked the Rust standard library, the service worker's Workbox, the EPSG
  dataset's terms (IOGP's ownership must be acknowledged), the geoid grids' source and
  the full license texts of the models a deploy serves. The build now finds the packages
  (from the app, its workers and the service worker), `npm run build:wasm` the crates,
  and THIRD_PARTY.md in the repository says what else is someone else's: the vendored
  Poisson crate (which now carries its license files), the AprilTag, ArUco and MicaSense
  code, the models and the data. The video-import test now uses four CC0 example photos
  in place of South Building images, whose license is not stated.
- **Fusion keeps to its memory budget.** Build Dense Cloud no longer goes past the memory
  budget (Settings ▸ Compute) once the slabs are fused, and the tab gives the memory back
  as soon as the cloud is built. The fusion workers' merge buffers stayed allocated through
  the join and the level-of-detail octree; they are now released when the last slab is
  done. A large dense cloud is also kept in memory the workers share (in a cross-origin
  isolated tab, as websfm.app is), so the octree build and Build Mesh read it instead of
  copying it, and a saved cloud loads the same way. On a 347-photo aerial block
  (73 M points): at a 16 GB budget the tab peaked at 11.9 GB against a plan of 12.9 GB
  (14.6 GB before) and held 4.9 GB afterwards (14.5 GB before); at 8 GB, 8.1 GB against
  8.0 GB (10.2 GB before). The fusion plan also no longer counts on room the open project's
  clouds already take.
- **A very fine mesh finishes.** Build Mesh at a high octree depth no longer stops after
  the solve with no message; it colours the mesh and saves it. Chrome leaves a
  `Float64Array` of 2^28 elements (2 GiB) or more unfilled when one `fill()` covers it;
  the vertex-colour index of a 5.6 M-vertex mesh grew to that size, held no empty slot,
  and its search never ended. Every such array is now filled in pieces. The index's hash
  also mixes the whole key now: cells a power of two apart in the packed grid had landed
  in a few slots (a quadratic slow-down), and colouring is about 20 % faster (67 M points
  onto 4.2 M vertices: 64 + 31 s instead of 79 + 40 s). On a 347-photo aerial block,
  depth 11: 11.1 M triangles in 551 s, colouring and joining the 48 tiles 86 s, the tab
  at 35.7 GB.

## [0.7.0] — 2026-11-09

### Added
- **Experimental features are marked.** An amber **Experimental** badge sits beside
  rolling shutter, the multispectral rig, the reflectance map, Hold to a reference DEM,
  AprilTag and ArUco detection, and Add to the model; its hover text says what has not
  yet been checked on real data. They work, but compare their results with a reference
  (check points, a calibration panel) before relying on them. A badge goes when its
  checks pass: rolling shutter needs a DJI block with independent check points, the
  multispectral rig and reflectance map a real flight with a held-out panel, the DEM
  hold its benches against withheld check points, the tags real photos of printed
  tags, and Add to the model a comparison with a full rebuild.
- **COPC export.** Export ▸ Point Cloud has a **COPC** format (`.copc.laz`): LAZ 1.4
  stored as a level-of-detail octree, which QGIS, Potree and PDAL read a part at a time.
  A streamed cloud is written from its own octree, node for node, without being loaded;
  another is written with the georeference and downsample chosen. Colour, classes and
  other attributes, and the CRS as WKT, go in. A 300,000-point export reads in PDAL 2.10
  (readers.copc and readers.las) and laspy 2.7's CopcReader with every point; laspy's
  bounded queries return exactly the points a brute-force count finds in each box.
- **Whole Metashape projects.** Import ▸ **Metashape** now also opens a project (a `.psz`,
  or the folder of a `.psx`): besides the calibration, camera poses, markers and scale
  bars, its tie points come in as keypoints and matches (the unaligned photos' too),
  its aligned cameras and tie points as a sparse model in metres, and its mesh in the
  same frame. The dense cloud, DEM and orthomosaic are in formats of Metashape's own, so
  the dialog names those to export as LAS/LAZ or GeoTIFF. On a six-photo Metashape 2.2.2
  project the imported cameras reproject the tie points exactly as Metashape's own
  camera.project does (median 0.856 px, p90 2.195, max 11.175 over the same 349
  projections).
- **Runs show their steps.** The progress dialog of Sparse Model, Depth Maps, Dense
  Cloud and a mesh in tiles lists the run's steps under the bar (for Depth Maps:
  PatchMatch, the geometric pass of the Full method, the cross-view filter), ticks the
  ones done and gives the running one its own count and bar; a step the run leaves out
  is struck through. The bar on top still shows the whole run.
- **Keypoints and matches from text or CSV.** Import ▸ **Keypoints & Matches** reads what
  another detector or matcher writes: keypoints as an `image,x,y` table, one file per
  image or Lowe's `.key`, and matches as COLMAP's match list, an `imageA,imageB,indexA,
  indexB` table, or matched points by position (`imageA,xA,yA,imageB,xB,yB`), whose
  points become the keypoints. A dialog shows what the files hold and what to import,
  and the matches are verified as Match Features verifies its own (RANSAC at its default
  thresholds, on every worker), unless you say they already are. In the browser test,
  60 true and 6 false matches of a made-up two-view geometry keep 58–61 inliers.
- **Bundler files.** Import ▸ **Other SfM** reads a Bundler `bundle.out` with its
  `list.txt` as a sparse model, besides VisualSFM NVM, OpenMVG, OpenSfM and
  transforms.json; the imported cameras see each point within 0.01 px of where the file
  says.
- **A folder offered before a big batch of photos.** When the photos you add would bring
  a project in browser storage to 3 GB of photos or more, WebSfM asks once whether to
  move it to a folder on disk first (Chrome, Edge), and adds the photos there; Keep in
  browser adds them as before. Firefox and Safari, which cannot use folders, say it in
  the log. Keypoints, matches, depth maps and products take several times the photos,
  and a browser may limit or clear its storage.
- **Copy for bug report.** Other ▸ System info has a button that copies your browser and
  OS, GPU, CPU cores, memory, WebGPU and storage as a few lines of text, to paste into a
  bug report; nothing about the project is included, and nothing is sent anywhere. The
  console's Save TXT starts with the same lines, and System info now names the browser.
- **A toolbox while you mark a scale-bar point.** After *Mark point in photos* in Set
  Real-World Scale, a small Scale bar toolbox stays over the workspace: which point is
  being marked, in how many photos so far, and *Back to scale bars* or *Stop*.
- **Multispectral cameras.** Photos from a MicaSense RedEdge or Altum are read band by
  band: each band becomes its own sensor, the photos of one trigger form a capture, and
  captures of the calibration panel are disabled when imported, so alignment leaves them
  out. Matching pairs only the reference band (green) between captures and every other
  band with its own capture's reference image, and Sparse Model ▸ 5 · Camera rig solves
  one pose per capture, each band at its lens offset refined from the photos; a band
  that matches nothing, such as thermal, takes its capture's pose. On the MicaSense
  sample captures, the band offsets the camera records predict how each band lines up
  with green to within 0.7–1.5 px (RedEdge-MX, Altum), against 6–31 px when read the
  other way round. On a synthetic 15-capture block with four bands, offsets recorded
  0.15–0.2° wrong were solved to the truth within 0.01° (plus the 0.048° a 5 cm lever
  arm at 60 m turns into), and the thermal band placed within 5 cm. Not yet run on a
  real multispectral flight.
- **Reflectance maps for NDVI.** Reconstruct ▸ Products ▸ **Reflectance** puts every band
  of a MicaSense camera onto the DEM in reflectance, calibrated with the panel photos, the
  sun sensor or both, and adds it to Reference Data, shown as NDVI; Style bands… picks
  any band, a composite or NDVI, NDRE and GNDVI by the bands' names. Each cell takes the
  capture that sees it most from above, every band read from that capture's raw values
  through the camera's own radiometric model (black level, gain, exposure, vignetting),
  ported from MicaSense's MIT-licensed processing code; a thermal band is in °C. The
  GeoTIFF has one 32-bit band per lens, named as QGIS and GDAL read them. On MicaSense's
  sample captures the panel radiance and irradiance of all five RedEdge-MX bands come
  within 0.1 % of MicaSense's own test values, and the sun-sensor irradiance of the Altum
  and the 10-band RedEdge-MX Dual exactly. Not yet checked on a full flight.
- **GCP targets marked for you.** Tools ▸ Images ▸ **Detect targets…** finds the centre of
  each GCP's checker mat where the model expects it, or of every AprilTag 36h11 tag or
  ArUco marker in every photo, and places the mark, flagged as detected with a score, for you to check in
  Edit GCPs. A checker mat is looked for from its coordinates through the georeference,
  or from its marks in two other photos. An AprilTag needs no model, even before Align:
  tag 7 marks the GCP with 7 as the only number in its name, or a new marker "Tag 7".
  Marks you placed yourself always stay. In a GCP's marks view (double-click it in the
  sidebar) ✓ accepts a detected mark and **Accept** takes them all; from the keyboard,
  A accepts the highlighted one, X removes it and S moves on. On synthetic mats (turned, blurred, noisy, the
  guess 20 px off) the centre is found to within 0.1 px; on the Aukerman example the
  place it searches for a removed mark lies within 3 px of where the mark was. On
  rendered tags (turned, in perspective, blurred, noisy, two bits wrong) the tag's centre
  is found to within 0.1–0.3 px; a 20 MP photo takes about 2.5 s per worker, photos run
  on all workers. ArUco reads OpenCV's 4X4, 5X5 and 6X6 dictionaries (choose yours under
  Dictionary), correcting as many wrong cells as OpenCV does for each (none for 4X4_1000,
  5 for 6X6_250); on rendered markers the centre is within a third of a pixel. Metashape
  coded targets are not read.
- **Dialogs remember their settings.** The Reconstruct dialogs (Detect Features, Match
  Features, Sparse Model, Depth Maps, Dense Cloud, DEM, Orthophoto, Mesh, Reflectance) and Texture Mesh, Contour Lines,
  Co-register DEM, Align to Reference and Detect Targets open on the settings of their
  last run in the project, and **Presets ▾** in the title bar saves a set under a name
  for the next project of the same kind, brings it back, or resets to the defaults. Only
  what differs from the defaults is kept, so a setting renamed in a later version falls
  back to its default. Match Features' "only new pairs", Co-register DEM's "apply to" and
  the contours' output follow the project each time. Detect Features keeps each detector's
  settings, so a preset brings back the detector with its own values.
- **The orthophoto as a web map.** Export ▸ Orthophoto ▸ **MBTiles** or **XYZ tiles**
  cuts it into Web Mercator map tiles, from the zoom that shows the whole area to the
  first one as fine as its pixels, in PNG, JPEG or WebP: one file for QGIS, QField or
  MapLibre, or a `{z}/{x}/{y}` zip for a web server. The finest tiles are resampled from
  the stored orthophoto and every coarser one is built from its four children, so the
  orthophoto is read once. MBTiles uses the SQLite library WebSfM already loads for COLMAP
  databases, only when it is needed; GDAL 3 reads the result in place.
- **Hold a model to a reference DEM.** Georeference ▸ **Hold to a reference DEM** rebuilds
  the sparse model with its tie points over stable ground held to a reference DEM's
  heights, so a block with only drone GPS or a few GCPs cannot dome or dish; the GCPs or
  camera positions still place it. Choose the reference (or fetch the Copernicus DEM
  around the cameras), its height uncertainty (its declared vertical accuracy, else
  2 m) and optionally a layer of stable ground. Each tie point seen in three or more
  photos is held along the vertical only, those far from the DEM's height are left out,
  and the focal length and distortion are re-estimated over two rounds, as with GCPs.
  Quality Report ▸ Accuracy ▸ Reference DEM Hold shows how many points were held and
  their height against the DEM before and after. On a synthetic nadir block that domes
  under GPS alone (σ 2 m, k1 self-calibrated), shape error 0.45 → 0.08 m and height
  against the ground 0.70 → 0.07 m RMS; real benches (historical photos against REMA,
  drone blocks with RTK checks) are still to come.
- **Rolling shutter for drones without a mechanical shutter.** Sparse Model ▸ 4 · Rolling
  shutter ▸ **Estimate the readout time** solves each camera group's readout time in
  bundle adjustment, with each camera's motion taken from the photos taken just before
  and after it (their capture times). Off by default until a real drone block with check
  points measures the gain. A global-shutter solve hides the effect in a bent block with
  small residuals: on a synthetic two-strip block (10 m/s, 30 ms readout, 50 m) it fit to
  0.017 px while the points were 8.1 cm off in shape; with the readout time solved (30.005
  ms recovered from 0) the shape error was 0.003 mm. On 54 photos of a DJI Mavic Air 2
  (whole-second capture times) it found a 25.7 ms readout, the camera positions fitted
  the drone's GPS 20 % closer (0.75 against 0.94 RMS) and self-calibration moved the
  principal point less (5.3 against 11.7 px), at about the same reprojection (0.86 against
  0.88 px RMS); no check points there, so the default stays off. The model keeps each camera's readout, so GCP
  and check-point marks are triangulated from the pose at their own row, and the GCP
  guides and Detect targets look where that row sees them. Depth maps, orthophotos,
  textures and Export ▸ Undistorted Images read each such photo resampled onto its
  middle-row pose, every pixel moved by where the camera was when its row was read (the
  photo's sparse points give the depth that takes), so the dense cloud and the mosaic
  follow the corrected block. On the Mavic Air 2 photos with depth maps at 1,000 px, where
  the shift is under a pixel, the products came out the same within noise as with the
  setting off (depth-map cost median 0.282 against 0.279, 9.5 against 9.8 million dense
  points, orthophoto seams 1.89 against 1.91 × the interior). At 2,000 px (High) the
  depth maps matched slightly better (cost median 0.210 against 0.215 over the 54 maps,
  p95 0.695 against 0.697, 78.5 against 78.3 % of the pixels kept in fusion, 39.3 against
  41.2 million points) and the mosaic was unchanged (seams 1.88 against 1.87 ×).
- **Metashape interchange, both ways.** Import ▸ **Metashape Cameras**
  reads the XML of Metashape's Export Cameras or Export Markers and takes, as you choose,
  the calibration of each camera, the positions and orientations of the aligned cameras
  as priors in the project's coordinate system, the markers with the marks placed in
  Metashape (a disabled marker as a check point), and the scale bars between markers or
  cameras (a disabled one as a check). A calibration made at another photo
  size is scaled to the project's photos; terms WebSfM has no place for (k4, b1, b2) are
  named with how far they move a corner. Export ▸ SfM Project ▸ **Metashape XML** writes
  the registered cameras, their calibration, the GCPs with their marks and the scale bars
  back, for
  Metashape's Import Cameras and Import Markers. On the Aukerman example the imported
  cameras land where Metashape 2.2's own Omega Phi Kappa export puts them (1e-6 m, 1e-8
  in rotation), and Metashape 2.2 projects points through the exported cameras to within
  0.0001 px of WebSfM.
- **Photos left out of a large survey get a pose.** When matching leaves photos apart from
  the main block, or hanging on it by a few weak pairs, Match Features now detects them
  again at full size together with the photos of the main block they share most pairs
  with, and matches their pairs again (Match ▸ Repair a split graph ▸ **Detect gaps again
  at full size**, on by default). It acts only on SIFT photos detected at under 0.8× of
  their size, and not when the gap is more than half the block. Bridge repair now also
  finds pieces that hang on the main block by pairs of fewer than 30 inliers (100 in
  all), which it used to count as joined. On the Starbuck glacier survey (171 film scans
  of 10,400 px, detected at 0.38× by the automatic resolution), 43 photos in two flight
  lines hung on the block by 3 weak pairs; detecting them and 28 partners again took
  17 minutes and left 2 apart, and the sparse model posed 161 photos instead of 125
  (detection and matching 25 min instead of 6; detecting all 171 at full size poses 163
  in 48 min).
- **Camera groups that mix cameras are pointed out.** A sensor whose photos come in
  several scan formats, or whose film rolls fit its fiducial layout badly, gets a ⑂ in the
  Sensors list and a warning in Sparse Reconstruction, and right-click ▸ **Split camera
  group…** splits it, by the suggestion, by scan format or by roll. A scan batch has one
  exact size, so sizes a few pixels apart count as other cameras, unless every frame was
  cropped to its own size; a roll misfits when its fiducial residual is three times the
  rest's and over half a scan pixel. A fiducial layout estimated from the photos is
  estimated again per group. On the Melville glacier scans (173 photos, 20 rolls) grouped
  by camera position, the suggestion splits L and V into 6 groups by scan size and finds
  the roll whose marks fit at 171 µm against 21 µm; the sparse cameras then lie 13.3 m RMS
  (median 6.0 m) from the reference positions instead of 28.0 m (12.6 m), as close as
  Metashape's 9 groups by focal length and size (13.0 m). Grouping by focal length alone,
  as a calibration import does, made it worse (32.8 m). The DEM (depth maps at Medium)
  lies 7.0 m NMAD from REMA on stable rock instead of 8.2 m (Metashape 5.0 m), and its
  warped outer flight lines are mostly gone: after one 10 m shift north, 5.2 m instead
  of 7.1 m, against Metashape's 5.5 m.
- **Co-register a DEM onto a reference DEM.** Tools ▸ Products ▸ **Co-register DEM…**
  compares a DEM with an imported reference DEM on stable ground and removes the offset,
  either from a co-registered copy of the DEM or from the georeference, so every product
  built after it lands on the reference. Its steps follow xDEM, each optional: a horizontal
  shift (Nuth & Kääb), the median vertical shift, and a tilt (a plane, or for the DEM a
  quadratic surface). Moved, the georeference keeps the move through every refit until
  you remove it. Quality Report ▸ DEM vs reference opens it in place of *Move the control
  onto the reference*, which edited the control points. Nuth & Kääb (2011) and xDEM are
  now cited (About ▸ References, the Quality Report's methods). On Melville (Find GCPs
  control, 20 m DEM) the DEM lay 1.1 m east and 7.9 m north of REMA; its NMAD on stable
  rock went from 6.9 m to 5.2 m with both shifts, 5.0 m with a plane, 4.9 m with a
  quadratic surface. Moved through the georeference (both shifts and a plane), the DEM
  rebuilt afterwards measured 5.1 m, with 0.5 m of shift left. Metashape's DEM of the
  same photos is at 5.0 m as built and 4.5 m once co-registered the same way, so the
  step closes most of the gap, not all of it.

- **Co-register a DEM without a reference of your own.** In Tools ▸ Products ▸
  **Co-register DEM…**, **Copernicus DEM (30 m)** fetches the free global Copernicus DEM
  (made from TanDEM-X) over the DEM and uses it as the reference DEM. Only the part of
  the 1° tiles under the DEM is read, from Microsoft's Planetary Computer, which needs no
  account; the reference is imported with its datum (EGM2008) and its stated accuracy
  (σ 2.8 m horizontal, 2.4 m vertical). TanDEM-X itself needs a DLR login, and the AWS
  copy of the Copernicus DEM cannot be read from a browser (no CORS).
- **A preview of each Sentinel-2 scene.** Find GCPs ▸ **Sentinel-2…** shows the chosen
  scene's whole tile beside the list, with a box on the window that will be read, so
  cloud over the area shows before you fetch it. The preview is the catalogue's own
  343 px quicklook, about 45 KB a scene.
### Changed
- **Each sparse model keeps its own lens.** A model now stores the lens and film frame its
  cameras were solved in, and depth maps, orthophotos, textures, GCP tools and exports
  built from it use that lens, not the camera groups' current values or the last run's.
  Editing a camera group no longer changes a finished model; to start the next run from
  what a model solved, use Sensor table ▸ Estimated ▸ **Use for next run**. Imported
  models keep their own lens too: a COLMAP import keeps each camera's distortion
  (SIMPLE_RADIAL, RADIAL, OPENCV, FULL_OPENCV, OPENCV_FISHEYE; it was dropped) and
  undistorts its observations with it, and a Metashape model import does the same with
  the adjusted lens. Secondary models keep their own lens (they took the main model's).
  Projects are migrated to format 4 on opening: each model gets exactly the lens it was
  drawn with, so products and saved depth maps stay as they were; a model other than the
  main one is marked as such in the Quality Report, since its own run's lens was not
  recorded. The sensors CSV (Estimated) now writes the solved lens; it wrote the camera
  group's.
- **A faulty GPU no longer spoils depth maps.** Depth Maps checks the GPU's matching cost
  on the first map against the CPU's; when they disagree, that map, the rest of the run
  and later runs are computed on the CPU, and the log says so. The check now judges the
  median difference: the RMS it judged before reached 7e-3 on a correct NVIDIA GPU (its
  texture filter rounds a few low-texture pixels far off) and only warned. A correct
  GPU's median is 1.4e-4 on five Aukerman photos and ≤ 1.3e-5 on synthetic scenes; the
  shader with its homography sign flipped gave 2e-1 and moved the run, which is moved
  above 1e-2. The CPU's cost is now the reference itself (the check and the tests call
  the Rust code a CPU run uses), instead of a third copy in JavaScript, and both kernels
  are held to the same depth accuracy on six synthetic scenes (best-K, ACMH, a shallow
  plane, the sparse window, the planar prior on a textureless strip, the geometric pass):
  the CPU kernel on every push, the GPU kernel on a software GPU in the nightly browser
  tests.
- **A tidier project folder.** A project's folder now holds only `project.json` at its
  top, with the small documents (GCPs, poses, sensors, scale bars …) in `data/`, the
  model and its binary files in `reconstruction/`, and the log, last dialog settings,
  run journals and migration copies in `internal/`. A project from an earlier version
  is moved over when it is opened (project format 3); its model's files follow as it is
  read, or with its next save. The fixtures of formats 1 and 2 open with everything they
  held and end with nothing but `project.json` at the top.
- **Import ▸ Interoperability names the tools.** The buttons are now WebSfM Project,
  COLMAP, Metashape, Other SfM and Keypoints & Matches, each with a tooltip that says
  what it reads, and each opens a dialog that shows what the files hold and asks what
  of it to import. The COLMAP and Other SfM dialogs now start with what the file holds
  ticked; before, everything started unticked.
- **No upper limit on keypoints or detection resolution.** Max keypoints in Detect
  Features (SIFT, SuperPoint, DISK, ALIKED), the LightGlue keypoint budgets in Match
  Features and the detection resolution take any number; the keypoint fields say how much
  more matching work a value means than the default, and Detect Features warns when a
  photo at the chosen resolution needs Tiling or cannot be made at all.
  One SIFT pass holds about 64 MP: measured at 60 bytes per pixel of WebAssembly memory
  (16 MP 0.9 GB, 64 MP 3.7 GB), and 74 MP no longer fit the 4 GiB a module can address.
  The old 10,000 px limit allowed a 100 MP square scan, which failed the same way.
- **Greyed-out controls say why.** Hover a disabled button, field or option in any
  dialog, panel or toolbox to see what it is missing or what to do first, as the ribbon
  already did.
- **Georeference laid out like the other dialogs.** The coordinate system and the
  control on hand sit under Source, the three methods are cards (Adjust with GCPs, Hold
  to a reference DEM, Transform only) that say on hover why one cannot be chosen, and
  each method's steps say what it will do.
- **About ▸ Licenses easier to read.** Each entry fits on one line with a short note of
  what WebSfM uses it for, and a full license text opens under *License text* instead of
  filling the list.
- **Export dialogs laid out like the Tools dialogs.** The formats are cards, each saying
  what its file holds, followed by numbered steps: ① Format, ② the export's own
  settings, ③ the coordinate system of a DEM or orthophoto GeoTIFF, then the file name.
  What the dialog exports, and the source of camera poses or calibration, sit above the
  steps as Source.
- **Image lists in the Quality Report are links.** The images of each match component
  (Matching), the images not registered and those an extension added (Sparse) are listed
  in columns, and a click on a name opens the image; a click on a row of the Matching
  table does too. A long list shows its first 48 names and a *Show all* button.
- **Each step listed once, in every processing dialog.** Every step is a group headed by
  what it will do in a few words (Depth Maps: ① 1,500 px · 10 views, ② 7×7 · 5 sweeps ·
  Fast, ③ median 10 %, ④ ≥ 2 views agree); a click on the header opens or closes it.
  Open, a step shows what it does and the choices you make per project; **Show advanced
  settings** in the footer (the same switch as in Settings ▸ Display) adds the finer
  settings of every open step, and a closed step stays closed. Each dialog remembers
  which steps you opened or closed. A step that is switched off reads "off" but stays
  as usable as the others. The Advanced section that repeated
  the steps is gone from the Reconstruct dialogs (Detect and Match Features, Sparse
  Model, Depth Maps, Dense Cloud, DEM, Orthophoto, Mesh) and the Tools dialogs with
  finer settings (Texture, Filter Cloud, Classify Points, Clean and Smooth Mesh, Align to
  Reference, Detect Fiducials, Contour Lines).
- **Dialogs laid out alike.** Every processing dialog now shows its steps with what each
  will do, keeps the settings whose defaults suit almost every project under one
  **Advanced settings** section, and leaves only the choices you make per project in
  view. Dense Cloud, Orthophoto and Texture Mesh gain quality cards: **Light / Medium /
  Full** point density (every 4th, 2nd or every pixel), **Fast / Balanced** mosaics (nadir
  seams with feathering against graph cut with multiband blending, 68 s against 116 s
  on an 80-photo quarry block) and **Draft / Medium / Full** texture resolution. DEM,
  Orthophoto, Classify Points and Contour Lines move their tuning under Advanced; Sparse
  Model and Depth Maps show their steps' effects above it instead of inside it.
- **Measuring in one window.** Ruler, Area, Profile and Volume show their result in the
  measuring window itself, under the point buttons, instead of in a second panel; on the
  2D map the window's **Layer** field picks the raster to measure, and Profile and Volume
  start on the map's DEM. Tools ▸ Measure no longer lists the map's layers: the ribbon
  stays the same whatever is loaded. The window opens at the top left, out of the way of
  the drawing.
- **Every project on the start screen gets the same line.** Under each project's name
  come, in fixed columns, an icon for where it is stored (a folder on disk or this
  browser, the folder's name on hover), its CRS (**Local** without one), its size and
  when it was last edited. A folder project now shows its size too, whenever the browser
  can still read the folder without asking.
- **The live sparse view stays put.** While Sparse Reconstruction runs with the 3D view
  in front, the progress card stays in the view's corner from start to end, and the
  rest of the app is dimmed only lightly. The card used to start in the middle, move to
  the corner with the first cameras and come back for the last steps, and the earlier
  clouds flashed up before the finished model replaced the live one.
- **Guide and Glossary tabs move and close like the main tabs.** Drag a tab in the
  Guide or the Glossary to put it elsewhere in the strip, and right-click it for
  **Close**, **Close others**, **Close to the left**, **Close to the right** and **Close
  all**, as on the tabs of images and products.
- **A shorter guide.** Every guide article now says what a setting does and when to
  change it, in a few sentences; the hover help of a setting is the same short text.
  Test results and the history of each setting are gone from the app (they stay in this
  changelog). The guide is half as long, about 24,000 words instead of 51,000.
- **Help for every tool setting.** The settings of Filter, Crop, Transform, Merge,
  Align to reference (ICP), Estimate normals, Distance to reference, Clean mesh, Smooth,
  Decimate, Sample to points, Contours, Slope/aspect/hillshade, Clip to polygon and
  Optimize cameras now carry a **?**: hover it for what the setting does and when to
  change it, as in the Reconstruct dialogs. Each tool has its own article under
  **Tools** in the Guide, and the Guide's articles are named as the dialogs they explain
  (*Build Dense Cloud*, *Build DEM*, …).
- **Footprints from Poses in numbered steps.** Tools ▸ Model ▾ ▸ **Footprints from
  poses…** now lays out its settings as *1 · Ground* and *2 · Cameras*, each with a line
  saying what it does to this project: what the corners land on, in which height datum,
  and how many poses get a footprint and why the others are skipped. **Ground** is a
  row of buttons, and the manual intrinsics have their own help.
- **One look for every dialog's buttons and menu paths.** The import dialogs for GCPs,
  camera poses, calibration, fiducials and footprints, and the New Project dialog, use
  the same buttons as every other dialog. Import ▸ **WebSfM Project** and **SfM
  Project** lose the "…" no other large ribbon button has, and the guide and glossary
  write menu paths with ▸, as the app does. Messages that named commands the app does not
  have (*Densify*, *Depth maps → Densify*, *Mesh ▸ Clean mesh*) now name the real ones.

### Performance
- **Faster matching of large photo sets, and fewer overlapping pairs missed.** Match
  Features' quick check, which skips pairs that do not overlap, now samples each photo
  once per run instead of once per pair, and a pair that only just missed it gets a
  second look on a larger sample. On Agisoft's PUTI set (444 photos, 98,346 pairs)
  matching took 132 s instead of 236 s on the GPU and 287 s instead of 369 s on the CPU;
  picking and copying the samples per pair and a log line per skipped pair had been 140 s
  of main-thread work. The second look finds pairs the check had skipped: South Building
  970 instead of 951 of the 1,067 pairs COLMAP verifies with 100+ inliers, UseGeo 3,329
  accepted pairs instead of 3,020 (camera heights 6.1 instead of 8.4 cm RMS against the
  reference, matching +19 % on the CPU). No set of the ten measured got worse.
- **Depth maps on the GPU about a third faster.** Each PatchMatch sweep now runs only the
  pixels it updates, so the GPU no longer spends half its threads waiting, and each
  candidate plane's warp is set up once instead of at every window pixel. On six ETH3D
  scenes (Medium, Quadro RTX 5000) Depth Maps took 722 s instead of 1,127 s (courtyard
  141 instead of 227 s), with the same F1 score on every scene. The first change alone
  gives bit-identical dense clouds; the second moves 0.06 % of the points.
- **No long wait to compare GPU and CPU depth maps.** When the GPU is slow, Depth Maps
  still computes one map on the CPU to compare, but now gives up on it as soon as the CPU
  is clearly slower, and goes on with the GPU. It decides after each pyramid level: it
  gives up once the CPU has taken as long as the GPU would for the whole map, or is on
  course for twice that. On the Melville glacier scans at High, the comparison map took
  78 minutes against 94 s on the GPU. On the example project at 2,400 px it gave up
  after 42 s, when it was on course for 648 s (GPU 14 s).
- **Faster bundle adjustment from about 100 photos.** Sparse Model's bundle adjustment now
  spreads its heaviest step over all the threads it has, where a block of 100–300 photos
  used one to four. On the 347-image quarry it took 35 s instead of 43 s (Sparse Model
  73 s instead of 81 s) with the same cameras, points and GNSS fit; on 36 public BAL
  problems it went from a median 1.46× to 1.06× of Ceres' time, up to 2.6× faster
  (dubrovnik-88), with the same final costs.

### Fixed
- **Camera files with accuracy columns named as GeoScan and Agisoft write them.** Import ▸
  Camera Positions now recognises headers such as `# file`, `WGS84_lat`, `WGS84_H` and
  `Std Dev e (m)`, so an RTK file's own accuracies are mapped instead of the 5 m default.
  With the default the positions barely count: on Agisoft's PUTI sample (444 photos, RTK
  at 1–2 cm) the solve came out the same as without them, and with the file's accuracies
  its 15 checkpoints are 3.4 cm across and 11.1 cm in height (with the lens below; 3.1 /
  7.2 cm with the lens solved as before).
- **Drone blocks without ground control no longer bend into a dome.** Sparse Model's
  self-calibration now solves the whole lens, including decentring (p1, p2) where it
  clearly lowers the reprojection error, and fits it to the keypoints as the photos
  recorded them. On the 347-image quarry without GCPs or RTK in the solve, the cameras
  against RTK went from 30 / 67 cm (horizontal / vertical RMS) to 22 / 13 cm; Metashape
  2.2.2 gives 13 / 12 cm on the same photos. The solved lens matches Metashape's (focal
  4403.4 against 4403.1 px, principal point within 1.1 px, p1/p2 within 0.00005). Before,
  each pass's radial estimate was folded into the keypoints and one composed k1–k3 fitted
  to the sum, which could not express decentring. The decentring terms are kept only when
  the first solve that frees them lowers the RMS by 1 % against the same solve without
  them: quarry 3.8 %; South Building, four ETH3D scenes and UseGeo 0.0–0.2 %, where they
  are dropped and the cameras stay within 1 % of before, except UseGeo's vertical
  (8.18 → 8.37 cm, +2 %). Not a gain everywhere: on PUTI (444 photos) with its RTK
  positions in the solve, the checkpoints' height went from 7.2 to 11.1 cm, and without
  them its ground sits about 1 m off in height (a focal-length offset), so its lens is
  still being worked on.
- **Bundle adjustment no longer stops on a hard start.** When its first steps overshoot,
  Sparse Model's bundle adjustment now keeps damping them until one improves the model,
  instead of stopping after eight tries with the model where it was. Checked against Ceres
  on the 98 public BAL problems (Bundle Adjustment in the Large): the three largest Ladybug
  problems had stopped after one iteration at 28× Ceres' final cost and now end within
  0.2–2.9 % of it, and the other 31 problems re-run came out bit for bit the same. Over the 95
  problems both solved, the final cost is a median 0.00004 % from Ceres' (84 within 1 %),
  at a median 1.4× its time; the three largest do not finish within 2 h (docs/BENCHMARKS.md).
- **Distant points no longer slow bundle adjustment.** A tie point very far from the
  cameras (background, horizon) could keep Sparse Model's bundle adjustment from taking
  full steps, so it crept towards the solution and stopped short. It now converges as if
  the point were not there. On the public BAL problem dubrovnik-173 it took 16 s and 21
  iterations instead of 131 s and 100 to end within 0.02 % of Ceres' cost (it had stopped
  1.3 % above); none of the 46 problems re-run ended worse, and the 347-image quarry,
  which has no such points, came out the same.
- **One highlighted row in the sidebar.** Clicking an image, GCP, product, reference
  raster or vector layer now moves the highlight there; before, a cloud you had clicked
  (or a run had just added) stayed highlighted next to it. DEM, orthophoto, reference
  raster and vector rows highlight when clicked. The cloud last chosen is still the one
  the tools open on.
- **Cancel in Reconnect project folder no longer leaves an empty app.** With no project
  open, Cancel (or Esc) goes back to the project list, or to New Project when there is
  none.
- **Quality Report ▸ Sparse shows the residuals to two decimals.** The image table's
  RMS, Median and Max columns were rounded to whole pixels (0.71 px read "1").
- **The Quality Report's image tables fit short windows.** On a short screen (a laptop),
  Sparse squeezed its image table into a sliver that scrolled but never showed a whole
  row; each part of a section now keeps its height and the section scrolls. The stat
  tiles also leave a space between a number and its unit.
- **TIFF photos keep their camera details.** A TIFF that stores its tags after the
  pixels, as MicaSense cameras write them, came in without make, model or focal length,
  so its camera group read "Sensor 1 · NaN mm" and the band went unread; its metadata is
  now read from the whole file. Found importing MicaSense's Altum-PT sample captures:
  exifr's chunked reader found 53 of their 99 tags.
- **Exported camera angles taken where each camera is.** Export ▸ Camera Poses
  (estimated, georeferenced) now gives each camera's omega/phi/kappa against grid north
  and the vertical at that camera, as Metashape and Pix4D do, not at the georeference's
  origin. The two differed by the change of meridian convergence across the block:
  0.0002° on a small site, about 0.3° over 6 km near the poles. Checked against
  Metashape-convention XML written and read back: within 0.00001°.
- **Omega, phi and kappa read the way Metashape and Pix4D write them.** Camera poses
  imported with orientation angles now point the way their file meant, in footprints and
  as priors for Sparse Model; before, WebSfM turned them the opposite way, so a 60°
  kappa put a footprint's corners about 200 m off at 100 m flying height. Export ▸
  Camera Poses writes the same convention. Angles WebSfM took from a drone's gimbal
  were right and stay right: opening a project saved by an earlier version converts
  them (project format 2). Checked against Metashape 2.2's own Omega Phi Kappa export
  on 42 Aukerman photos: the same rotation to 1e-8.
- **Splitting a camera group keeps the original fiducial layout where it cannot be
  estimated.** Sensors ▸ right-click ▸ **Split camera group…** copied every group after
  the first from the first group, after its layout had been estimated from its own
  photos; a group whose layout could not be estimated then kept the first group's,
  not the camera's.
- **Co-register DEM moves the georeference only from a DEM built in it.** Applied to the
  georeference, it read the DEM's coordinates as the current fit's whenever the DEM was
  out of date for any reason. A DEM built before the georeference was refitted now
  blocks the run (rebuild it first), and one built in the co-registered georeference
  adds to the move even when it is out of date for another reason, such as a rebuilt
  dense cloud. **Co-register** also waits while the Copernicus DEM is still downloading.
- **Match Features no longer promises a full-size detection it skips.** With LightGlue,
  or when matching a selection, *5 · Repair a split graph* said pieces still apart would
  be detected again at full size; the run never does that there, and the line now says so.
- **The match view shows the tie points joined through other photos.** A pair's view
  in **Matches** listed "via PnP" tie points in its legend but never drew them: the tie
  points both photos see in the model, which this pair did not match directly. They are
  now drawn in blue, and the legend calls them **via other photos**. With them, the
  view's counts add up to the list's **Used** column.
- **Cancelling Project folder… keeps the project list.** On the start screen, cancelling
  the folder dialog of **Project folder…** left an empty workspace with a nameless
  project; the list now stays open until a folder has opened. **Move to folder…** and
  **Move to browser storage** from the list's ⋯ menu also keep it open while no project
  is open.
- **Gradual selection no longer reports unsaved changes.** On a project with depth maps,
  Tools ▸ Model ▸ **Gradual selection…** showed *Unsaved changes: Failed to execute
  'removeEntry' … modifications are not allowed*. Retiring the depth maps deleted each
  depth file twice at once, once with the image's preview and once in the sweep of all
  maps, and the browser refuses one of two overlapping deletes of the same file (22 of
  400 in a test). Deletes of one file now wait their turn, as its writes already did.
- **Retry faint images shows its checkbox again.** In Detect Features ▸ Advanced ▸
  *3 · Detect (SIFT)*, the checkbox sat alone in the middle of the dialog, away from
  its label; it is now an **Enabled** checkbox under it, like the others. It is on by
  default.
- **Setting help stays on screen.** A setting's help box that fits neither below nor
  above its label (*Repair a split graph* in Match Features) now moves up until all of
  it, **Read more** included, is in the window, and scrolls when it is taller than the
  window.
- **DISK without a GPU error.** Detect Features and Find GCPs now run DISK on the CPU
  from the start, instead of first trying the GPU, logging an ONNX Runtime error
  ("MaxPool … The Indices output is not supported yet") and then falling back to the CPU.
  DISK's keypoint step reads MaxPool's indices, which ONNX Runtime's WebGPU path cannot
  produce, so the GPU attempt failed every time; the keypoints are unchanged.
- **Detect Features says when Append has nothing to do.** With every image already
  detected, the dialog now says that **Append** would skip them all and keeps **Run**
  disabled until you choose **Overwrite**, instead of closing without detecting anything.
  When only some images lack keypoints, the button says how many it will detect.
- **Time left through the whole matching run.** The Matching Features progress bar now
  keeps moving, with its time estimate, while the gate rescue and bridge repair run after
  the last pair, and names the pass it is on. Before, the bar sat at 99% with no estimate
  through both; the pair pass now fills the bar to 90% when either can follow.

## [0.6.1] — 2026-10-31

### Changed
- **Folder choices shown in Firefox and Safari.** New project ▸ **In a folder…** and the
  project list's **Project folder…** now appear greyed out in browsers that cannot keep
  a project in a folder on disk, and say that it needs Chrome, Edge or another
  Chromium-based browser, instead of being hidden.
- **Photo names in a project folder.** A project's `images` folder now holds an
  `index.csv` that says which stored file is which photo, by its name in WebSfM and the
  file name it was imported with. The photos are stored under an internal id, since two
  can share a name; the list is kept up to date as photos are added, renamed or removed,
  and written when an older project is opened.

## [0.6.0] — 2026-10-31

### Added
- **Reduce overlap.** Tools ▸ Images ▾ ▸ **Reduce overlap…** disables the photos of a
  heavily overlapping block that the depth maps do not need, keeping every part of the
  surface in at least **Photos per point** photos (6), so the dense stages run on fewer.
  It counts which photos see each sparse point from the camera geometry (in frame, and
  within a **Viewing angle** of the side the point's own photos see it from), not from
  the tracks, which name only the photos that matched it; the dialog shows the result as
  you change a setting. Quarry (347 photos, a median of 29 seeing each point; WebGPU depth
  maps, Medium): all photos took 1,724 s of depth maps and 138 s of fusion. At 6 per
  point it keeps 145 photos, 646 s + 59 s, and the 0.5 m DEM covers 97.8 % of the full
  one's cells, median difference 0.006 m, NMAD 0.17 m. At 3 it keeps 87, 346 s + 35 s, but
  covers only 89.9 % (NMAD 0.19 m), which is why the default is 6.
- **Disable photos.** Right-click images ▸ **Disable** leaves them out of every later
  run (Sparse Reconstruction, depth maps, the dense cloud, the orthophoto and mesh
  texture) while their features, matches and pose stay; **Enable** brings them back.
  The image list dims them and tags them *off*, the run dialogs count without them, and
  each run logs how many it left out. Saved with the project; older projects open with
  every photo enabled. A browser test disables a photo of the five-photo fixture, gets
  four depth maps, and finds it still disabled after a reload.
- **Duplicate a project.** The project list's **⋯** menu ▸ **Duplicate** copies a
  project, to try other settings on the copy while the original stays as it is. A
  browser project is copied into this browser, a folder project into another folder you
  pick (**Duplicate…**). The copy is checked file by file like a move, gets its own id
  and the name *… (copy)*, and leaves out an unfinished run's journal. Browser tests in
  Chromium, Firefox and WebKit open the copy and change it without touching the original.
- **DEMs of chosen classes, for canopy and building heights.** Build DEM ▸ **Points ▸
  Classes…** builds the top surface of the classes you tick in a classified cloud (high
  vegetation by default); with a DTM and the DEM of difference that is a canopy height
  model. A browser test builds a DEM of a classified cloud's building class and gets
  the roof alone.
- **Detect or match only some images.** Right-click images in the image list ▸ **Detect
  features…** or **Match features…** opens the usual dialog for those images alone: they
  are detected again, or only their pairs are matched, and every other image and pair
  keeps its result. A browser test detects one photo of five again and matches back
  exactly its four pairs.
- **Adding photos no longer rebuilds every depth map.** Build Depth Maps ▸ **Keep valid
  depth maps** (on) keeps each saved map whose camera and settings are unchanged and
  computes only the others, so after Sparse Reconstruction ▸ Add to the model with
  Existing cameras ▸ Fixed only the new photos' maps are made; the step's line says how
  many are kept. The check across views still runs over every map. It is a setting
  because a full run would also rebuild the kept maps with the new photos as neighbours;
  turn it off for that. A browser test keeps all five maps of an unchanged run byte for
  byte, and after one camera moves computes that map alone.
- **Join two projects.** **Import ▸ WebSfM Project…** brings another project's photos
  into this one with their features, the matches between them, their sensors, GCP marks
  and camera positions, so two flights, two days or a colleague's block need no new
  detection or matching; Match only new pairs then matches across the blocks, and
  Sparse Reconstruction ▸ Add to the model places them in this model. A photo both
  projects hold is kept once, a sensor with the same calibration is shared, and a GCP
  already here keeps its position. The other project's model and products stay behind.
  Cancel stops between batches and keeps the photos already in. On the 77-photo Aukerman
  survey, lap 2 (44 photos) joined to a model of lap 1 (33) placed 43 of them (the one
  left out fails in a rebuild too) with the cameras 1.07 m RMS from their GPS positions,
  against 1.14 m for a rebuild of all 77, in 45 s against 85 s.
  A browser test imports the 5-photo test project into an empty one (Chromium and
  Firefox) and builds the same 5-camera model from what came.
- **Buildings and vegetation in a classified cloud.** Classify ground is now **Classify
  points** (Tools ▸ Point Cloud): after the ground it labels **Building** and **Low**,
  **Medium** and **High vegetation** (LAS 6, 3, 4, 5) among the points above it, as two
  more steps that can each be turned off, so the cloud exports with the classes GIS
  tools expect. Roofs and walls are found as large flat surfaces high enough above the
  ground (a wall alone, such as a retaining wall, is not a building), vegetation as what
  scatters or is green, banded by height at 1 and 3 m; a car stays unclassified. Every
  point also gets its height above the ground (`heightAboveGround`, metres), to colour
  by in Symbology and exported to LAS/LAZ and PLY. On a
  synthetic site 99.6 % of building points and every tree point land in their class; on
  UseGeo's 16 M-point MVS cloud the run takes 5.9 s against 1.2 s for the ground alone,
  and roofs, crowns and olive rows come out right by eye. Not yet scored against a
  labelled set. The Quality Report's **Methods and references** now names the ground
  filter and the class rules with their papers when a cloud was classified.
- **Add photos to an aligned model.** Sparse Reconstruction has a **Mode**, *Add to the
  model* or *Rebuild*: adding registers only the images the model lacks, starting from
  its cameras and points, and with **Existing cameras ▸ Fixed** every camera already in
  it stays exactly where it was, so depth maps, clouds, meshes, DEMs, orthophotos and the
  georeference built from it stay current. *Refined* then lets every camera move with
  the new ones (Optimize cameras); *Auto* keeps them fixed when something was built from
  them. Match Features gets **Match only new pairs**, on by itself when some images are in
  no pair yet, so only each new photo's pairs are matched. Photos a run could not place
  get **Try again…** in Quality Report ▸ Sparse, which reopens the dialog with looser
  registration gates. The model's frame is rebuilt
  from the detected keypoints and checked against the pixels the model saved (0.00002 px
  apart on the synthetic tests, with and without self-calibration), and a project whose
  features were detected again is told to rebuild. On the synthetic block, cameras added
  to a model of two thirds of it land 0.1 % of the camera spacing from the truth, where
  a run of every image puts them at 0.06–0.09 %. On the Aukerman example (32 images
  built, depth maps made, then 10 more added), adding took 3.7 s against 10.6 s for a
  rebuild of all 42, matching the new pairs 44 s against 84 s, all 10 images joined, the
  32 depth maps stayed, and the cameras sit 1.23 m RMS from their GPS positions against
  1.26 m for the rebuild (1.09 m with Refined).
- **Projects keep opening in newer versions.** A project saved by this or a later
  version of WebSfM opens in every version after it: when the way projects are saved
  changes, opening an older project brings it up to date where it is saved, and the
  console says what changed. Before, a beta could refuse projects saved by the one
  before it. A small saved project per format version is part of the tests, and each
  must still open with everything it held.
- **Continue a long run after the tab closed.** When a browser tab closes during Detect
  Features, Match Features or Build Depth Maps (out of memory, an update, a crash),
  opening the project again offers to **Continue** the run, doing only the work that is
  missing with the settings it was started with, or to **Discard** it. Each run keeps a
  small journal of what it has saved: every image's features, the matched pairs (saved
  about once a minute while matching), every depth map through both passes of the Full
  method and the filter (whose writes are now staged, so a filter that stops leaves the
  maps intact). A continued run gives the same result byte for byte as one that never
  stopped (browser tests kill the page during detection, the pair loop, and depth pass 1
  and pass 2).
- **See what your browser lacks, and what it costs.** When WebSfM starts in a browser
  that is missing something it uses, the note at the bottom right now lists each gap in
  plain terms ("Depth maps, matching and the learned matchers run on the CPU", "Projects
  are kept in browser storage only"), in Chrome too when it has no WebGPU, instead of a
  general warning on every browser but Chrome. **Other ▸ System info ▸ Browser support**
  shows every feature with what it is for. Firefox now runs the app's browser test suite
  as well as Chromium (100 of 110 tests passed at first; the fixes are below).
- **Open a project file into a folder.** Opening a `.websfm` file now asks whether to
  keep the project in this browser or in a folder on your disk, where it is unpacked
  straight away, so a file larger than the browser allows still opens. Only where
  folders are possible (Chrome, Edge); elsewhere it goes into the browser, as before.
- **See where each project is saved.** The project list shows a project's folder (its
  icon and name) or *In this browser* with its size, and at its foot how much WebSfM
  holds in this browser, with a warning and **Ask the browser to keep it** when the
  browser may clear that storage. **Project settings ▸ Where it is saved** has **Move
  to folder…** (or **Move to browser storage**) and **Export project file…**, and says
  when the project was last exported. A coordinate system looked up on epsg.io is
  saved in the project, so it opens offline in another browser.
- **Work with every DEM and orthophoto, not only the main one.** Any DEM or orthophoto
  in the sidebar now opens in a tab of its own, goes on the map, takes a symbology and
  downloads, where before these were greyed out until it was set as main. Main still
  decides what the next step uses. Several of a kind can be on the map at once, each a
  layer of its own in View ▸ Map ▸ Layers; a new build takes the place of the main one
  before it there. On a product's tab, the ribbon's Export, In Layers, Symbology and
  Remove act on that product (Remove did nothing on a product tab before). Measurements
  are kept per product; those saved before stay on the main one. A project saved before
  shows its main DEM and orthophoto on the map again.
- **Show information on every sidebar row.** Right-click a vector layer (an imported
  shapefile or contour lines), a reference raster, a sensor, a control point or the
  matches and choose **Show information**, as on clouds and products. A vector layer
  lists its polygons or lines, vertices, image links, contour levels and extent; a
  reference raster its CRS, size, GSD, bands, accuracy, elevations and vertical datum,
  and whether it was fetched from Sentinel-2; a sensor its calibration and lens
  coefficients; a point its position, σ, marks and residual; the matches the pairs
  tried, verified, excluded and used, their inliers, and how many images are in a pair.
  Layers imported from now on also show their source CRS and import time.
- **Every export opens a dialog.** Camera Poses, Calibration, Camera Fiducials, Image
  Fiducials, Footprints, Keypoints and Matches now ask for a format and a file name
  before they download, like the other exports, and the sidebar's **Download…** on a
  vector layer or on the matches opens the same dialog. New formats: tab-separated
  text for the camera and fiducial tables, GeoJSON points for camera poses, CSV for
  keypoints and matches (or the matched pair list alone), and KML or WGS 84 GeoJSON
  for footprints and other vector layers. Keypoint and match files are named after
  the project instead of the time of export, and the calibration file is
  `<project>-calibration` instead of `-sensors`. Every export dialog shows what the
  chosen format holds under **Format**. The Export tab's buttons no longer end in
  "…", since all of them open a dialog.
- **Export the poses and calibration the reconstruction estimated.** Export ▸ Camera
  Poses offers **Source ▸ Estimated by the reconstruction**: the poses bundle
  adjustment ended with, in the project CRS when the model is georeferenced (scaled or
  oriented like a point cloud export otherwise). Before, it wrote only imported poses
  and was greyed out without any. Export ▸ Calibration likewise writes the refined
  focal length and principal point, per camera group or per image. Estimated poses use
  the omega/phi/kappa convention of the pose import: a unit test turns an imported pose
  into the solver's camera and back, and gets the same position and angles to 1e-9°.
  The dialog can also leave out the angles or the accuracies.
- **Type a zoom into an image or raster tab.** Click the zoom percentage at the right of
  the tab's status bar and type a value; Enter or clicking elsewhere applies it, Esc keeps
  the old zoom.
- **Hide the bug-report button.** Settings ▸ General ▸ Notices ▸ **Bug report button**
  turns off the round button at the bottom right. Other ▸ About ▸ **Report a bug** opens
  the same GitHub page.
- **References say what each paper is used for.** Other ▸ About ▸ References lists,
  under each paper, the glossary entries that explain the method it describes; a click
  opens the entry. The learned detectors and LightGlue are now cited by the Keypoint
  entry, so every paper names at least one.

### Changed
- **A tidier start screen.** The project picker that opens on start is now two columns,
  your projects and **+ New project** on the left, **Open existing** and **Try an
  example** on the right, with the version and the browser storage in a strip along
  the foot. Each project takes two lines: the scene type is the icon before its name,
  and the version that created it shows only when it is not this one (hover a project
  for both). The dropdown from the project name keeps one column, in the same order.
- **Self-calibrated distortion stays exact when the principal point moves.** When
  bundle adjustment moves a camera's principal point, the tie points are corrected for
  distortion again about the new centre, so the depth maps undistort the images exactly
  as the sparse model did. Before, each correction stayed centred where it was made, and
  dense could differ from sparse by up to 0.18 px (South Building). The reconstruction
  log now gives, per sensor, how far the principal point moved and how many times the
  tie points were corrected again, and warns if the two still differ by more than
  0.25 px. On synthetic blocks with an off-centre principal point (28.8 px), camera
  positions are 2–4× closer to the truth. On real blocks the cameras are unchanged
  within noise (South Building, ETH3D, quarry vs RTK, Casa Grande and Iceland check
  points), and runs take 0–7 % longer.
- **A full browser storage no longer loses work.** Whatever finds browser storage full
  (adding images, a dense cloud, a mesh, a DEM, any save, as well as depth maps) asks to
  move the project to a folder on disk, then saves there and carries on; during a run,
  stopping ends it, as before. The browser copy is removed and the project reopened
  from the folder once nothing runs or waits to be saved. The "Unsaved changes" card
  says when storage is full, with **Move to folder…**, or, without folders (Firefox,
  Safari), how to free space; **Dismiss** forgets changes that cannot be saved, which
  before kept the card up for good. The point-cloud octree a large import builds is
  written by its worker, outside this, and still fails the import when storage is full.
- **Export project file, not "Save a copy".** **Other ▸ Export Project** and the project
  list's **Export project file…** write the `.websfm` file, named for what they do: the
  project stays where it is. Its dialog says what leaving out the derived data costs
  (depth maps, DEMs and orthophotos have to be built again; it said they rebuild on
  demand) and no longer mentions a 4 GB limit, which ZIP64 lifted; in Firefox and
  Safari it warns about a large file. Menu items that only ask "are you sure?" no
  longer end in "…" (**Delete**, **Remove from WebSfM**, **Convert to source image**),
  and the project list draws the capture type with the app's icons.
- **Settings in groups.** The General and Map & 3D tabs of Settings put their settings
  under headings (Appearance, Help and dialogs, During a run, Notices; Map, 3D view)
  instead of one long list of switches.
- **What's New without glossary links.** Its text no longer underlines the glossary
  terms it names, which in a changelog was nearly every line.

### Performance
- **Safari uses every core.** WebSfM now asks for cross-origin isolation with the
  header Safari understands (COEP `require-corp` instead of `credentialless`), so the
  bundle adjustment, depth maps and the learned detectors run on threads there as in
  Chrome and Firefox. Every cross-origin request the app makes (basemap tiles, epsg.io,
  STAC, models) already goes through CORS, so nothing is blocked: live OpenStreetMap
  tiles load in Chromium, Firefox and WebKit under the new header, and the shared-memory
  browser test now runs in WebKit too. A self-hosted copy needs the new header
  ([docs/deployment.md](docs/deployment.md)).
- **Sparse Reconstruction spends less time outside the bundle adjustment.** Placing each
  photo now scores its pose hypotheses on every core, guided track extension searches
  every camera on its own core, and the residual statistics that each bundle adjustment
  logs are computed without the slow sorts they used; the model is the same to the last
  bit. Quarry (347 photos): the time outside the bundle adjustment fell from 31.4 to
  25.3 s, the whole sparse run from 67.2 to 62.4 s (16 threads), with identical camera
  poses and points. Guided track extension then went from 3.8 to 1.5 s (the run 63.3 → 60.0 s, back to back).

### Fixed
- **Depth maps on integrated graphics no longer freeze the screen.** The graphics card
  now gets each pass in short pieces (about 30 ms each), so a laptop's integrated GPU,
  which also draws the screen, stays responsive and is not reset by the system for a
  long command; when a map is slow on the card, the next is computed on the processor to
  compare, and the run (and the session) continues on the faster. On a dedicated NVIDIA card
  the maps are unchanged (identical filter counts over 42 maps; the GPU path varies in
  the last bits between runs anyway) and the run takes about 5 % longer.
- **Long ribbon menus can be scrolled.** Scrolling a ▾ menu taller than the window
  closed it, so its last rows could not be reached on a small screen (or in Firefox,
  whose rows are taller).
- **Error notes can be clicked while the browser note is open.** The note at the bottom
  right that opens the console sat under the browser note in the same corner.
- **System info shows WASM SIMD correctly.** It said *Not supported* in every browser:
  its test module was malformed.
- **Moving a project while it saves.** A move to or from a folder could fail with "copy
  did not verify" when a file was being written meanwhile, such as the console log,
  which the move itself writes to. The copy is now checked without the log, which
  follows on its own, and a file's half-written temporary copy is never counted.
- **Convert to source image works after a reopen.** In a reopened project, Reference
  data ▸ right-click ▸ **Convert to source image** removed the raster and then failed
  with "Unsaved changes: A requested file … could not be found", which **Retry saving**
  could not clear; the file is now read before the raster is removed. The item now asks
  first and says what it does, and a Sentinel-2 window fetched by Find GCPs no longer
  offers it, since it is never a photo.
- **A reopened project counts every match pair it tried.** Pairs that matching rejected
  are now saved too, so **Total pairs** in the sidebar is the same after a reopen, and
  matching does not try those pairs again. The JSON match export still lists only the
  pairs with matches.
- **Product names stay readable in a narrow sidebar.** An outdated DEM or orthophoto
  squeezed its name to nothing; the name now keeps its room, the pixel size is left out
  below 320 px, and **outdated** becomes a **!** (with the same tooltip) below 260 px.
- **The "Unsaved changes" message matches the rest of the app.** It is a card in the
  lower left, styled like an error notification, instead of a dark red bar across
  the window.
- **Photos taken from the ground no longer show upside down.** In an Object capture
  project, the 3D view and Orient model take which way is up from the photos' own
  up direction when the cameras look up at their subject, as at a building from the
  street. On South Building (128 frames) the view's up was 180° off before and is
  right now. An aerial project still assumes the cameras look down; when the photos
  look up instead, the sparse run warns that the scene type is probably wrong, since
  its automatic orientation then turns the model over.
- **The Image Table's estimated angles match the imported ones.** Its Extrinsics ▸
  Estimated view showed omega, phi and kappa of the solver's camera axes (looking down
  +z with y down), so a camera looking straight down read 180°. It now uses the
  convention of the imported poses, and shows positions in the project CRS when the
  model is georeferenced.
- **An orthophoto too large for PNG or JPEG no longer says "coming soon".** The export
  dialog added "coming soon" to every greyed format, after the reason it was greyed.
- **The Guide's tab strip no longer overflows.** With operations open, the strip could
  show a stray scrollbar over the tabs. Home now stays at the left and only the operation
  tabs scroll, as in the Glossary, and a newly opened tab scrolls into view.

## [0.5.0] — 2026-10-28

### Added
- **A Beta badge, and projects that say why they cannot open.** A **Beta** badge beside
  the name (ribbon, project picker, About) says that features and the project format
  still change between versions. Each project now records the format it was saved in,
  and one this version cannot read, or one saved by a newer version, stops with a
  message that says so, both when opened and when imported from a `.websfm` file.
  Projects saved before count as the first format. The badge goes away at 1.0.
- **Show information on products.** Right-click a sparse cloud, dense cloud, mesh, DEM
  or orthophoto in the sidebar and choose **Show information** for its facts: cameras,
  tie-points, mean track length and reprojection error for a sparse cloud; points,
  normals and storage for a dense cloud; size, GSD, extent, frame and elevation range
  for a DEM, with the cloud it was built from (DEMs built from now on); surface,
  coverage and blend for an orthophoto.
- **Sentinel-2 as a Find GCPs reference.** Find GCPs ▸ **Sentinel-2…** lists the
  Sentinel-2 scenes over the search area and fetches the one you choose as a reference
  orthophoto, with no file to download and no account. Only the window over the area is
  read from the 10 m red, green and blue bands on AWS Open Data, stretched from its own
  reflectances so that snow and ice keep their texture, and imported in the scene's UTM
  zone with σ XY 8 m (Sentinel-2's geolocation is about 11–12.5 m CE95). The scenes
  cover Antarctica too: 21 under 20 % cloud over Neko Harbour.
- **Find GCPs: a search area, and footprints on offer.** Find GCPs ▸ Search area takes a
  polygon layer to search inside, and under it a line says where Auto will look: the
  georeferenced orthophoto, the photos' footprints, their GPS, or the whole reference.
  With only GPS or camera poses, **Compute footprints…** opens Footprints from poses
  over the dialog; with nothing at all, a warning asks for a search area.
- **Align to and measure against a survey too large to load.** An imported LAS/LAZ that
  is streamed from its octree can now be the reference of Align to reference (ICP) and
  Cloud distance, and Transform moves it as a whole. The reference is read around the
  source, at full detail up to 12 M points; a transformed cloud gets a new octree,
  quantised for its new coordinates. Align to reference also takes a streamed cloud as
  the source: the alignment is found on a sample of up to 2 M of its points, and every
  point then moves into a new streamed cloud.
- **Sources for every method.** Each glossary entry now lists the papers behind the
  method it explains, About ▸ References lists every method WebSfM implements, and the
  exported Quality Report ends with the methods this project used and their references,
  ready for a paper's methods section. WebSfM itself is citable via `CITATION.cff`.
- **What's New.** Other → What's New lists every release, newest first, with a badge
  counting the changes since you last opened it. Changes shows each entry's headline
  and first sentence, Full the whole entry. websfm now has numbered releases (0.2.0 to
  0.4.0 so far), cut with `npm run release`.
- **Keyboard shortcuts in one list.** Press **?** (or Other → Shortcuts) to see every
  shortcut and modifier gesture, grouped by where it works and filterable by action or
  key. Tooltips spell keys for the platform (⌘Z on a Mac). Plain mask-editing letters
  no longer fire with Shift held, and Ctrl+Alt+Z no longer undoes a mask.
- **Find GCPs aligns historical film with a satellite image.** The coarse look is now a
  learned matcher (DISK, or SuperPoint when installed, with LightGlue; SIFT stays
  selectable), with both rasters read at the same ground resolution and the
  orthophoto turned to the expected rotation. Scale and rotation come from the
  orthophoto's georeference, the photos' GPS, or the footprints of the near-vertical
  photos, else a sweep. The fine tiles match the same way. A reference with three or
  more bands is read as the mean of bands 1–3 (Reference band). On Rachel Glacier
  (1960s film against Sentinel-2 RGB), where SIFT found no alignment, 13 of 17 tiles
  align and the 30 candidates lie a median 7 m (at most 24 m) from where an
  independent Metashape solution of the block (hist-sfm) puts them; on Stubb 6 m
  (14 m), on Pequod 6 m (22 m).
- **DEM vs reference: co-registration, and moving the control onto the reference.**
  Quality Report ▸ Products now co-registers a DEM in a CRS to the reference DEM (Nuth &
  Kääb): the horizontal offset, and the NMAD once it is removed. **Move the control onto
  the reference** shifts every control and check point by that offset, refills its
  height from the reference DEM and refits. On Rachel Glacier, whose Find GCPs control
  took positions from Sentinel-2 and heights from REMA, the DEM sat 11.7 m north of
  REMA; after the move, NMAD on stable rock fell from 8.8 m to 5.4 m (hist-sfm's DEM:
  6.4 m), with medium-quality depth maps. With 90 Find GCPs candidates (the new default)
  instead of 30 the median bias after the move is +0.7 m instead of +2.8 m.
- **Find GCPs ▸ Candidates** sets how many candidates are proposed (default 90, was a
  fixed 30). Their heights pin the georeference's tilt: on Rachel Glacier 30 left the
  DEM 2.8 m high after moving the control onto REMA, 90 left it 0.7 m high.
- **Find GCPs by terrain.** Coarse matcher ▸ Terrain fits the sparse cloud to a
  reference DEM by ICP, with scale, starting from the same prior (footprints, GPS, a
  georeferenced orthophoto), and proposes tracks on the aligned surface. For when no
  reference image shows what the photos do: snow, cloud, or a DEM as the only
  reference. On Rachel Glacier against REMA: RMS 9.5 m in under a minute, candidates a
  median 13 m (at most 28 m) from the Metashape solution.
- **Meshes in tiles.** Build Mesh ▸ Advanced ▸ Tiles (Auto by default): a scene whose
  Poisson solve would not fit in memory is solved in tiles on the scene's own octree
  grid and welded along the grid edges the tiles share; every tile trims against the
  scene's support level, and floating pieces are judged on the joined mesh. The tiles
  solve on as many workers as the memory budget holds. The quarry at depth 10 (95 M
  points; one solve ≈ 18 GB) now builds: 2.8 M triangles in 4.5 min on 7 workers (14 min
  on one).
  Where a trimmed area or hole crosses a seam the tiles can end it slightly differently.
- **Matching repairs a split graph.** When matching leaves the block in pieces (the
  vertical and oblique cameras of a mapping flight, a facade and its roof), the most
  promising pairs between each piece and the main block are matched again with looser
  gates: near misses first, then pairs preselection skipped whose footprints overlap.
  On by default (Detect and Match Features ▸ step 5); the log says how many pieces
  joined.
- **DEM support layer.** Every DEM records which cells points landed in and which the
  gap interpolation filled. **Export ▸ DEM ▸ Support layer** writes it as a GeoTIFF
  (percentage measured per cell), and **Quality Report ▸ Products** gives the RMSE of
  measured and interpolated cells apart against a reference DEM.
- **DEM vs reference on stable ground.** **Quality Report ▸ Products** can limit the
  comparison to a polygon layer of stable ground (rock, roads) and to an area of
  interest, so a historical DEM is judged on terrain that has not changed. The
  exported report names both layers.
- **Find GCPs: stable ground and footprints.** A polygon layer (rock outcrops, built-up
  areas) can limit candidates to ground that has not changed since the photos, so
  candidates on a glacier or a pit face no longer reach the control. Without a
  georeferenced orthophoto, the search now starts from the photos' imported or
  computed footprints before their GPS positions, which places scans from an archive
  that come with footprints but no GPS.
- **Import a folder of masks (View ▸ Masks ▸ Import folder…).** One mask file per
  image, paired by name: the image's own name in a mask folder, COLMAP's
  `IMG_0001.jpg.png` or Metashape's `{filename}_mask`. The dialog shows what pairs
  before importing, can replace or merge with existing masks, and decodes the files on
  every worker. TIFF masks now import everywhere (1-bit CCITT Group 4 included), and a
  0/1 file reads 1 as kept.
- **DEM of difference against the background terrain.** The Volume tool's base can be
  the global terrain the Terrain basemap shades (Mapzen Terrain Tiles, about 30 m
  cells, EGM96 converted to the DEM's datum where it can be), so a DEM in a CRS can be
  compared without importing a reference DEM. Tools ▸ Measure ▸ DEM of difference now
  needs only a DEM in a CRS and picks the terrain when there is no reference DEM. The
  result names the coarse base and says what it can show; tiles stop at 85° latitude.
- **File name for exports.** Every export dialog (point cloud, mesh, model, COLMAP,
  3D Tiles, undistorted images, DEM, orthophoto, measurements) and the contour,
  terrain, clip and section tools have an optional **File name**. Empty, the file is
  named as before, and the field shows that name; a typed one names every file the
  export writes, the .wld / .prj beside an image included. Cloud names in file names
  keep letters of any script now (Süd, not S_d).
- **Photos on the map (View ▸ Map ▸ Photos).** The source images are drawn on the 2D
  map, each warped into its footprint from Footprints from poses (a projective map of
  the image onto the footprint's corners, drawn as a mesh of triangles), to check a
  camera's position and angles at a glance and see the area before reconstructing.
  The Photos layer sits in the Layers panel with an opacity and a choice between the
  selected image (the default, from its display image) and every image (from the
  thumbnails); only the photos in view are drawn.
- **Contours go on the map.** Tools ▸ Products ▾ ▸ Contours adds the lines to the 2D
  map as a layer of its own, listed in the sidebar's Products section and in the Layers
  panel (index contours heavier, the height in the hover label, "Contours" in the
  legend), with a map checkbox and a GeoJSON download in its right-click menu. Downloading straight away (GeoJSON or
  DXF) is now an option of the dialog, off by default; a DEM without a CRS is still
  always downloaded. Before, the lines only went to the browser's downloads folder.
- **Orthophoto export without an alpha band.** Export Orthophoto has an **Alpha band**
  checkbox (on by default) for GeoTIFF and PNG; unticked, the file has three bands and
  the empty pixels take a **NODATA value** (0–255), which a GeoTIFF records as GDAL
  NODATA. A real pixel equal to it moves one level, so it never reads as a hole. A JPEG
  uses the value for its empty pixels, which were always black before.

### Changed
- **Setting help and word explanations look different.** A setting label with advice
  in the Guide now has a small **?** after it, and a word with a glossary entry a
  dotted underline, as in the help text; both still open on hover. Before, both had
  the same dashed underline. Image Quality ▸ **Blurry below**, Detect Fiducials ▸
  **Detection type** and Find GCPs ▸ **Role** now have Guide sections of their own.
- **A rebuild adds a product instead of replacing it.** Building a dense cloud, mesh,
  DEM or orthophoto again adds a new one ("DEM 2") beside the old ones and makes it the
  main one, the input the next step uses; the build dialogs' new **Output ▸ Replace the
  main …** (off by default) replaces the main one instead. Right-click a product ▸
  **Set as main** to use another one; the map and the product tab show the main DEM and
  orthophoto. A sparse rebuild or edit (Optimize cameras, Gradual selection) no longer
  removes the products built on the old model, and a new DEM no longer removes the
  orthophoto built on the old one: they are kept and marked **outdated**, with the
  reason in the tooltip and in Show information, and the tools still offer them as
  inputs, named so. It is an option, not a pure win, because every kept product costs
  storage, and memory for a cloud. The depth maps and the georeference are still
  retired with the model they belong to. Each DEM and orthophoto is now saved in a file
  of its own.
- **Clearing the console asks first.** The developer console's **Clear** button asks
  before it deletes the project's log, saved copy included, since a cleared log cannot
  be brought back. The typed `clear` command still only empties the view.
- **Find GCPs reads like the other tool dialogs.** Its settings are numbered steps
  (Match, Pick candidates) with a line on what each does, and the results are steps 3 and
  4: the run's numbers as tiles, the candidates on both images, a sortable table, and the
  candidate under review with its close-ups and fields. Click a row or a number on an
  image to review it, and ‹ › to step through them.
- **Merge thins only where the clouds overlap.** With a Dedupe cell, a cell holding
  points of two or more clouds keeps only the first cloud's (in the order listed), and
  every other cell keeps all its points. It used to resample the whole merged cloud to
  one point per cell, thinning far more than the seam.
- **Region keeps towers and tree lines.** Fit to sparse / Fit to dense still leaves out
  stray points, but past the outermost 2 % on each side the box now follows points that
  continue without a gap, so tall structures above the 98th percentile of heights are no
  longer cut off.
- **The Region and the orientation survive Optimize cameras and Gradual selection.**
  Both edits keep the model's frame, so the box and the up direction drawn on it carry
  over (the log says so) instead of being set aside as drawn on an older model.
- **Classify ground shows the cloth's size.** The dialog's cloth line says how many cloth
  points the cloud needs at the chosen resolution, and for a cloud in memory the coarser
  resolution it will use past 4 million. On a streamed cloud, the log now says how many
  tiles used a coarser cloth than asked.
- **Clean contour lines from a photogrammetric DEM.** Contours smooths the DEM's heights
  before tracing (Smooth the DEM first, 2 cells) and drops lines shorter than 20 cells,
  so surface noise no longer traces as thousands of tiny rings. On the Aukerman example's
  DSM the lines went from 31,436 (96 % of them under 20 cells long) to 733, with the
  terrain and tree crowns kept. Both are settings; 0 gives the exact trace. Drop lines
  shorter than is now in cells of the DEM.
- **ICP aligns to a reference without normals as well as to one with them.** Align to
  reference (ICP) estimates the reference's normals where it is matched, so an imported
  survey cloud gets point-to-plane matching without running Estimate normals first. On
  the Aukerman dense cloud it converges in 34–40 iterations to 0.5 mm, where
  point-to-point had not converged after 100.
- **More accurate, more complete depth maps on a GPU (Method: Full).** Depth Maps ▸
  Advanced ▸ Method: Full runs three passes, ACMH view selection, planar priors that span
  textureless areas, and a pass that makes each map agree with its neighbours; Fast is the
  former single best-K pass. Auto, the default, uses Full on a GPU and Fast without one.
  On six ETH3D scenes (ETH3D's own evaluator) the F1 score at 2 cm rises from 62.0 to 66.2,
  better on every scene (ACMH +1.4, planar priors +0.7, geometric pass +2.0), against
  COLMAP's 58.4. Depth maps take about 2–4× as long: ETH3D 2.2–3×, the 347-image quarry
  block 7 → 26 min. The geometric pass works from the saved first-pass maps, so memory
  stays flat (quarry: 1.9 GB projected). On aerial blocks the surface is smoother (median
  height noise −20 to −29 %) with about 10 % fewer points. Methods after Xu & Tao (ACMH
  2019, ACMP 2020).
- **Much fuller dense clouds of objects and interiors.** In an object-capture project the
  depth filter now keeps a pixel that one other view confirms (aerial projects still need
  two), so plain walls, floors and edges seen in only two photos stay in the cloud. On
  six ETH3D scenes, scored by ETH3D's own evaluator, the F1 score at 2 cm rises from 57.1
  to 62.0, with every scene better (office 43.2 → 55.2); at Medium quality that is above
  COLMAP's 58.4 at a higher resolution. The Consistent views field is blank (auto) by
  default; a number there still applies to any project.
- **Sharper depth at object edges.** Depth maps compare image patches with each pixel
  weighted by how close it is to the patch centre and how similar its grey value is (as
  COLMAP does), so the far side of an edge no longer pulls a depth across it. On six
  ETH3D scenes (scored by ETH3D's own evaluator) the F1 score at 2 cm rises from 56.4 to
  57.1, better on five scenes and equal on the sixth; an aerial block is unchanged. No extra time on the
  GPU, about 10 % without one.
- **Fuller dense clouds.** Depth maps now compare each image with up to 10 neighbours
  instead of 6 and run 5 refinement sweeps instead of 3, so more of the surface gets a
  depth. On six ETH3D scenes (dense from the true cameras, scored by ETH3D's own
  evaluator) the F1 score at 2 cm rises from 53.6 to 56.4 on average, better on every
  scene (office 37.8 → 43.0, playground 36.0 → 41.8). Depth maps take about 9 % longer on the GPU and about
  2.2× as long without one (a 42-image block: 211 → 465 s); both values stay adjustable in
  the Depth Maps dialog.
- **More features on faint images.** An image that finds fewer than half the keypoint
  cap is detected again at half the contrast threshold, so plain walls, interiors and
  uniform fields get enough matches to register. On ETH3D (six scenes, camera centres
  vs the ground-truth cameras) every scene registers as many cameras or more (office
  18 → 20 of 26, playground 34 → 35 of 38) and five are more accurate (delivery_area
  4.0 → 2.9 mm, playground 3.6 → 1.3 mm median); quarry (53 of 347 images retried):
  14 % more sparse points and 0.766 → 0.738 m against RTK without priors, for 31 % more
  matching time; South Building (6 of 128 retried) is unchanged. Detect Features ▸
  Advanced ▸ Retry faint images turns it off.
- **Large cloud and mesh exports ask where to save first.** In Chrome and Edge, an export
  over about 256 MB opens the save dialog when you start it and writes the file there
  when it is done, instead of a download at the end. A 552 MB PLY download could be
  cancelled by the browser the first time; Firefox and Safari still download.
- **Tool dialogs read like the Reconstruct ones.** The Tools dialogs that run on a
  cloud, mesh, DEM or the model (Filter, Crop, Transform, Merge, Estimate normals,
  Classify ground, Align to reference, Distance to reference, Clean, Smooth, Decimate,
  Sample, Contours, Slope/aspect/hillshade, Clip to polygon, Optimize cameras, Gradual
  selection, Detect fiducials) now show their settings as numbered steps in run order,
  each with a live line saying what it will do to your data. A step that is switched
  off is dimmed. Drop-down lists are drawn like the other fields and are only as wide
  as their longest choice, and File name is a wider field without a help link.
- **The app is called WebSfM** in its interface, messages, help and the name it installs
  under, and in the LAS files it writes. Links, the `.websfm` project files and saved
  settings are unchanged.
- **DEMs take each cell's median height by default** (was the maximum). In a cell on a
  slope the maximum is the cell's highest corner: on Rachel Glacier's rock at 20 m cells
  it stood 14 m above the reference DEM (NMAD 8.2 m), the median 0.7 m (5.9 m). On flat
  Casa Grande the two agree within 0.1 m, so Max remains for small cells over roofs and
  canopy. A cloud too big for the median's buffer takes the mean, and the log says so.
- **Reference DEMs past 2 GB are read over the project.** A DEM too large for one buffer
  (a REMA 2 m tile, 25,100² cells) is no longer refused when the project's images have
  positions or it has GCPs: only the window over them (half their extent around them, at
  least 1 km) is read, at a coarser cell size if even that does not fit (Casa Grande's
  30,000 × 36,990 reference at 2 m instead of 1 m), and the map still draws the whole
  file.
- **Fusion on all workers.** Over saved depth maps, fusion spreads its slabs over up
  to 8 workers, as many as the memory budget holds; the finished slabs wait in
  WebAssembly memory, outside the tab's buffers. Quarry, 347 maps: 478 → 308 s at
  Medium, 922 → 200 s at half the merge cell (208 M points), the same cloud.
- **Text clouds past 89 million points.** XYZ and ASCII PLY imports past the browser's
  2 GB buffer cap continue in WebAssembly memory, up to about 715 million points.
- **WebAssembly memories are shared out.** A tab holds only about 125 of them (Chrome
  reserves address space for each), so arrays made together share one, and an
  allocation the browser refuses falls back to an ordinary buffer where it fits.
- **Dense clouds past the browser's buffer limits.** Fusion keeps its merge cells, and
  a finished cloud past 2 GB, in WebAssembly memory, which Chrome's 2 GB per-buffer cap
  and 16 GB of buffers per tab do not apply to. One piece of fusion holds up to about
  1.07 billion merge cells (was 134 million) and a cloud up to about 1.4 billion points
  (was 178 million); such a cloud saves, reopens and gets its octree like any other, and
  is drawn through the octree. The merge cells no longer count against the tab's
  buffers, so fusion may use the whole memory budget.
- **Meshes past 4 GB.** A Poisson solve too large for a 32-bit WebAssembly heap (4 GB)
  runs on a 64-bit build of the solver (16 GB) in browsers with 64-bit WebAssembly
  memory, and a 32-bit solve that runs out is retried there. The 64-bit build gives the
  same mesh and is about a sixth slower, so it runs only when needed; the log says
  which one ran. A dense cloud past 178 million points can be meshed (quarry, 208 M
  points, depth 9: 586 k triangles in 3.6 min). A solve past 16 GB stops with a message
  that says so, instead of a bare "unreachable".
- **The memory budget follows the machine.** Settings ▸ Compute ▸ Memory safety limit is
  half the memory the browser reports by default and can be raised to all of it; it
  stopped at 6 GB by default and 12 GB by hand, written when Chrome reported at most
  8 GB (Chrome 156 reports up to 32). Runs keep at most 12 GB of it in buffers, as
  before; fusion may use the rest. A saved manual limit is kept.
- **Layers panel: the layers on the map, as in a GIS.** View ▸ Map ▸ Layers opens a
  small panel over the 2D map listing the layers on it (imported reference rasters
  and polygon files, the DEM, the orthophoto and contour lines) in one stack, top
  first. The sidebar holds everything; a layer goes into the panel with its sidebar
  checkbox or In Layers on its ribbon tab (formerly On Map), and a newly built DEM,
  orthophoto or contour set goes there by itself. In the panel, drag a row or use
  ▲ ▼ to change what draws on top, untick it to hide it without taking it off, or
  take it off with ✕. Each row is one line; the selected one's opacity slider and
  Zoom to sit in a strip below the list, and the basemap is the last row. The order
  and what is hidden are saved with the project; a layer added later goes on top.
  Before, the order was fixed (reference rasters, then the DEM, then the orthophoto).
- **Footprints are an overlay; the Shapefiles section is gone.** The image footprints
  from Footprints from poses are drawn above every layer, and View ▸ Map ▸ Footprints
  shows and hides only them (it hid contour lines and imported polygons too). They
  have no sidebar row: an image's expanded row says whether it has one, and a
  right-click on a footprint or Export ▸ Footprints downloads them as GeoJSON or
  removes them. Contour lines are listed in Products and imported polygon files in
  Reference Data, each a layer with its own checkbox and opacity.
- **GCPs toggle on the map.** View ▸ Map ▸ GCPs shows or hides the GCP and marker
  symbols, as Cameras does for the camera positions. Editing GCPs always shows them.
- **Every processing dialog reads in steps.** Sparse Model, Depth Maps, Dense Cloud,
  DEM, Orthophoto, Mesh and Texture now show their settings as numbered steps in the
  order the run applies them, like Detect and Match Features, each with a line on what
  it does to this project with the current values (for example "42 depth maps at up
  to 1,500 px" or "About 3 points per cell"). A step that cannot matter is dimmed and
  says why. Depth Maps had its groups in reverse order, and DEM and Orthophoto had none.
  The guide articles follow the same order.
- **Map layers have a checkbox in the sidebar.** DEM, orthophoto, reference rasters,
  contour lines and polygon files go on the 2D map (into its Layers panel) with a
  checkbox on their row, like a cloud's 3D checkbox, instead of the ◉ marker and the
  right-click menu alone (which stays, as Add to / Remove from Layers). A layer the
  map cannot place yet (a product to rebuild, a raster without a CRS) has it greyed,
  with the reason as its tooltip.

### Performance
- **Remove outliers up to 4× faster.** The outlier filter finds each point's neighbours
  with the k-d tree the other cloud tools use, instead of a grid whose dense cells held
  hundreds of candidates; it keeps exactly the same points. ETH3D dense clouds: pipes
  (3.5 M points) 45 → 11 s, terrace (9.1 M) 58 → 26 s, courtyard (10.1 M) 51 → 32 s.
- **Filter and Classify ground on a streamed cloud use every core.** The tiles go to all
  workers at once, each with its share of the memory limit, and the outlier filter reads
  every tile once instead of twice. Rachel Glacier (51 M points, 8 workers): Filter
  332 → 62 s, the same 48,469,854 points kept.
- **Octrees build on every worker.** A large LAS/LAZ import, a streamed edit and the
  octree of a dense cloud past 4 M points sort the points into chunks once, then build
  the chunks on all workers. Rachel Glacier: import 77 → about 60 s (the LAZ decoding is
  most of what is left), a filtered cloud's octree 52 → 35 s.
- **Decimate splits a large mesh over the workers.** From half a million triangles the
  mesh is decimated in blocks, one per worker, with their shared vertices held in place,
  then once more across the seams. A 4.5 M triangle terrain: 26 → 7.7 s on 8 workers.
  The error is the same or slightly smaller than one pass over the whole mesh (RMS and
  largest distance of the input's vertices, on 2 M and 3.9 M triangle terrains and a 2 M
  triangle sphere).
- **Classify ground's cloth 1.4× faster.** Its springs skip the bounds tests away from
  the edges; the result is identical. Rachel Glacier streamed, 8 workers: 1,382 →
  1,088 s, the same 13,761,563 ground points.
- **Remove outliers and Estimate normals use every core.** From a million points the cloud
  is split into slabs over the worker pool, each with a margin wide enough that the
  outlier filter keeps exactly the points one worker would. On the Aukerman dense cloud
  (2.1 M points, 6 workers): outliers 7.4 → 4.0 s, normals 7.6 → 3.2 s.
- **Slope, aspect and hillshade about 40 % faster.** The DEM's nodata test runs once per
  cell instead of nine times: a 64-million-cell DEM 9.9 → about 6 s.
- **Depth maps without a GPU use every core for each map.** Each depth map now runs on all
  cores at once instead of one core per map, so the run no longer depends on how many maps
  fit the memory budget side by side. A 42-image block on the CPU: 465 → 263 s, the same
  maps whatever the number of cores.
- **Bundle adjustment of small blocks on every core.** A block under about 128 cameras now
  builds and reduces its bundle-adjustment system on all cores instead of one, in
  fixed point chunks, so every browser gets the same result. A 42-image block: SfM
  18.7 → 12.1 s (bundle adjustment 12.4 → 6.1 s); quarry (347 images, whose interim
  solves are small): 72.2 → 66.5 s. The sums are added in a different order, so the
  last digits differ; on a synthetic block with known cameras the error to the truth is
  the same (5.014 → 5.009), and the RTK camera check is unchanged.
- **Fewer stalls while long runs work.** Bookkeeping the page did itself while the workers
  computed — converting descriptors before SfM, per-pair match checks, each saved depth
  map's statistics — now takes a fraction of the time. On quarry (347 images): before
  SfM 4.9 → 1.8 s of a blocked page, during matching about 5 s less; on a 42-image
  block's depth maps 5.3 → 1.3 s. Results are unchanged.
- **Large projects open faster.** A check that a georeference still fits its evidence
  re-serialised every camera, image and pose each time one of them was restored, even
  with no georeference to check; it now runs only when there is one. Quarry (347
  images, a dense cloud and a mesh): reopen 9.7 → 1.2 s.
- **Fusion plans on every worker.** Over saved depth maps, fusion's planning passes (cost
  statistics, scene bounds, the cloud-size estimate, slab outlines) are now shared out
  over the workers that fuse the slabs, with the same plan and cloud. Quarry (347 maps
  at Low, 8 workers): fusion 58 → 37.5 s, the same 21,442,726 points. Fusion's
  per-pixel loops also stopped allocating a point per pixel (60.6 → 58.0 s before that).
- **Small orthophotos on several workers.** An orthophoto that fits in one or two
  2,048-pixel blocks is now cut into 1,024-pixel blocks, so more workers share it; the
  same pixels. The graph-cut seamlines also price each seam edge once per change
  instead of once per move. A 1,401 × 1,722 ortho of a 42-image block: 16.0 → 13.3 s
  (the seam cut 3.5 → 3.0 s).
- **Depth maps without a GPU, faster.** Each depth hypothesis now prepares its
  reference window once instead of once per source photo, and a pixel no longer re-scores
  a plane it has already scored. A 42-image block at Medium on the CPU: 277 → 216 s, the
  same depth maps.
- **Feature detection on every worker.** SIFT now detects as many images at once as the
  worker pool and the memory budget allow, instead of at most four. Quarry (347 images,
  8 workers): 161 → 86 s; a 42-image block 23 → 19 s; the same keypoints.
- **Faster meshes.** The surface solve's screening terms skip the products that are
  always zero, the same mesh in less time. A 42-image block (61 k samples, depth 8):
  Build Mesh 22.5 → 18.0 s; a 1 M-sample depth-10 terrain: solve 384 → 244 s, its
  coarsest levels 32 → 4.7 s each. The solver's coefficients are bit for bit the same.
- **Matching without a GPU uses the whole worker pool.** Each image pair now goes to an
  idle worker instead of the next one in turn, which could still be busy with a slower
  pair. Quarry (347 images, 1,909 pairs, WASM matcher): 429 → 297 s, the same matches.
- **Sparse reconstruction outside bundle adjustment.** The model's reprojection
  statistics, the self-calibration fit and guided track extension stopped allocating per
  observation, and guided extension only tries the cameras that can see a point. Each
  self-calibrating solve now moves the keypoints on all cores (in WebAssembly), and the
  composed lens for dense is fitted once, at the end. Guided extension searches camera
  by camera. Quarry (347 images): 82 → 77 s, then 84 → 73 s (SfM stages 70 → 60 s;
  the ten keypoint folds 8.9 → 2.2 s, guided extension 5.6 → 3.7 s), the identical model.
- **Depth maps on large scans, and the cross-view filter.** On a block of 58 film
  scans (97 MP) at High: masks and grey planes are built once per image instead of for
  every map they serve, the speckle filter is 5.7× faster (same output), previews are
  at most 2,048 px, greyscale scans are cached as one channel, and the next map's
  images are prepared while the current one matches. The cross-view filter checks each
  map against at most 12 overlapping views with enough parallax, and sizes its workers
  by memory: 30 → 4.4 min. Depth maps and filter together: 54 → 26 min. Fusion
  compares each map with at most 12 views too, and its planning passes read only depth
  and cost: 22 → 7.8 min, the same cloud for the planning change.

### Fixed
- **Matches ▸ Used in model counts matched pairs.** It counted every pair of images
  that share a tie-point, and a track seen in three images joins a pair that was never
  matched, so it could exceed the number of pairs (546 of 232). It now counts the
  verified pairs that share at least one tie-point in the model.
- **The mobile warning fits a phone's screen.** On a phone the page no longer pans
  sideways and the warning no longer runs past the screen's edge. The ribbon is wider
  than a phone, and mobile Chrome widened the whole page to fit it; the app now clips it.
- **Lists in the glossary and help boxes are indented.** Their bullets and numbers sat
  left of the text's margin.
- **Panoramic split of a portrait strip.** A strip scanned upright (taller than wide)
  was cut into segments that were mirror images, so the model came out mirrored and no
  georeference could fit it; the segments are now the strip turned a quarter.
- **Section keeps classes, other scalar fields and normals,** and its automatic slice
  thickness comes from the point spacing on the surface: on terrain it was several times
  too thick (the spacing was taken from the box's volume).
- **Footprints in a feet CRS.** With the global terrain as the ground, terrain heights in
  metres were compared with camera heights in feet; they are now converted, and the
  Ground elevation and Flying height fields are labelled in the project's unit.
- **No false "points outside the extent" warning on a cloud's octree.** A point within
  half a millimetre of the cloud's edge could round past it when stored, and the build
  then warned about a broken file header, even for a computed cloud.
- **Clip to polygon reprojects a GeoJSON file.** A file in longitude/latitude (standard
  GeoJSON, as QGIS writes it) or one that names its CRS is moved into the raster's CRS;
  it used to be taken as it was and reported as not overlapping.
- **One backend line per depth-map run.** Depth maps split over the worker pool printed
  "backend = WASM (CPU)" (and, without a GPU, its warning) once per worker; the console
  now shows it once.
- **Spinners keep turning with reduced motion.** With reduced motion on (Settings, or
  the system: remote desktop sessions often ask for it), the loading spinners and the
  indeterminate progress bar stopped and looked like a hang; they now keep moving,
  while decorative motion still stops.
- **Importing masks of large scans no longer knocks out the GPU.** Each imported mask
  was drawn into a GPU-backed canvas before it was saved; three 10,000-pixel scan masks
  at once ran Chrome's GPU process out of memory, and after three crashes the tab fell
  back to software rendering: matching and depth maps then ran on the CPU emulation,
  many times slower, with no error. Workers now draw such pixels on the CPU.
- **DISK no longer retries WebGPU on every tile.** Its WebGPU path lacks an operator;
  the first failure now keeps every later input on the CPU instead of only larger ones.
- **Local products of a historical block are level.** A block that mixes vertical
  photos with unbalanced left and right obliques (TMA film) took its vertical from the
  mean viewing direction, 21° off on Rachel Glacier, so the local DEM and ortho were
  projected onto a tilted plane and Find GCPs could not align them with a map. The
  viewing directions are now a trimmed mean that keeps the block's verticals (0.3° off).
- **High-quality depth maps on big blocks no longer run the tab out of memory.** A
  worker now waits while more than two of its finished maps are still being saved (a
  slow disk queued 0.6 GB per map on the page), the cross-view filter starts on a
  fresh pool and splits by memory, not by map count.
- **Film scans in dense, orthophoto and exports.** Depth maps and orthophotos of a
  film block failed at once with "could not be cloned": the fiducial transforms
  reached the workers as Vue proxies.
- **A DEM from a large georeferenced cloud read only the top of its octree** (the cell
  size was compared in metres against model units): 8,270 of 60 M points.
- **16-bit WhiteIsZero TIFFs no longer import as negatives.** The native decoder
  inverted them twice; it now matches the JavaScript fallback bit for bit. 1-bit
  (bilevel) TIFF scans, CCITT Group 4 included, now import through the native decoder.
- **The map legend matches the map.** It listed one purple camera triangle while camera
  positions from EXIF draw as blue triangles, and drew GCPs as diamonds while the map
  drew squares. The legend now lists exactly the symbols on the map, cameras by the
  source of their position (EXIF, imported, model), control and check points apart,
  and leaves out what a ribbon toggle hides; GCPs draw as diamonds on the map too.

## [0.4.0] — 2026-10-21

### Added
- **Turntable (View ▸ Camera ▸ Turntable).** The 3D view turns the model slowly about
  its up direction, for presenting a result or checking a dense cloud; dragging steers
  it, and it carries on when you let go. Its toolbox sets the seconds per turn and
  **Record one turn** saves exactly one turn of the view as a looping video (WebM, or
  MP4 in Safari). A new guide article, **The 3D View**, covers navigation, the view
  presets and the turntable.
- **Example project and tutorial.** New users without photos of their own can open an
  example from the New Project dialog (**New here? Open the example project**) or the
  project picker (**Try an example**): 42 drone photos of Aukerman Park, Ohio, from
  OpenDroneMap (public domain, about 50 MB). The images are imported as a drop would
  import them, and the guide opens a new **Tutorial: Your First Reconstruction** that
  walks through every stage to a DEM and an orthophoto, with what to expect at each.
  Hosts put the examples on their server with `npm run fetch:examples`
  (`VITE_EXAMPLE_BASE_URL` points elsewhere); a missing example says so and leaves no
  empty project behind.
- **Detect reseau (Tools ▸ Images ▾ ▸ Film scans).** For cameras that expose a grid of
  crosses onto every frame, such as the KH-9 mapping camera, the crosses are found in
  every scan and each scan is corrected for how it sat on the scanner and how its film
  has stretched or warped, centimetre by centimetre. On a synthetic satellite block
  with deformed film, checkpoint errors fell from tens of metres to under one pixel.
  Self-calibration on Auto keeps the camera's certificate values for such a camera.
- **Half-frame film scans.** Archives that scan a frame in two overlapping halves
  (`<frame>_a` and `<frame>_b`, as for the KH-9 mapping camera) can now be stitched
  into one frame in Detect reseau ▸ Half frames. The crosses on each half place it on
  the film and correct its deformation, ground control marks move to the stitched
  frame, and the halves are removed. On real KH-9 scans the stitched frame's crosses
  lie on their grid to 6 µm.
- **Panoramic satellite strips (Tools ▸ Images ▾ ▸ Film scans ▸ Split panoramic
  strips).** KH-9 and KH-4 panoramic frames are long strips of curved film that no
  frame camera describes. Each strip is now cut into segments, each resampled exactly
  into the image a frame camera turned to that part of the scan would take, and
  reconstructed like any frame images. Six Casa Grande KH-9 panoramic strips, of
  which two images registered before, now register as 96 of 96 segments. The
  satellite's motion during the scan is not modelled yet, so accuracy is coarse: tens
  to hundreds of metres on a synthetic block that moves as a real one does.
- **DEMs finer than 4,096 cells a side.** A DEM whose chosen cell size needs a bigger
  grid (a satellite frame at its native resolution) is no longer coarsened to fit: it is
  built block by block as a full-resolution Cloud-Optimized GeoTIFF, which the GeoTIFF
  export delivers. Its tab and the map draw it at full resolution as you zoom in,
  coloured and hillshaded. Readouts, profiles, volumes, the GCP check, contours,
  terrain derivatives, clips, the ASCII export and an orthophoto built on it all read
  the full-resolution grid (coarser only past their memory limits, which the log names).
- **Watch the sparse model grow.** During Sparse Reconstruction the 3D view draws the
  cameras registered so far and their points, in colour, updated every couple of
  seconds, and zooms out as the model expands. You can orbit and zoom it while it
  grows; the rest of the app is dimmed and locked until the run ends, and the progress
  bar sits in the view's corner.
- **Raster size in pixels, shown before the run.** The DEM and Orthophoto dialogs set
  the size by cell size or by pixels on the long side, and show the size the run will
  build (pixels, cell size, uncompressed size) and any cap before it starts.
- **Orthophotos and DEMs past 4 GB.** The stored GeoTIFF becomes a BigTIFF when it
  needs to, so a fine orthophoto is no longer coarsened to fit 4 GB. Rasters are capped
  at 65,535 pixels a side.
- **DEM and orthophoto GeoTIFFs in another CRS.** The GeoTIFF and COG exports can
  write a reprojected copy in any CRS (bilinear or nearest), block by block. The product
  itself stays as built, and heights keep their vertical datum.
- **Duplicate images are caught.** Adding an image whose name and size match one
  already in the project asks once per batch: skip the duplicates, or add them as
  separate images ("photo (2).jpg").
- **Camera positions on the map can be hidden** (View ▸ Map ▸ Cameras).
- **Long runs look after themselves.** While a stage or workflow runs, the screen is
  kept on so the computer does not sleep mid-run, and the tab's title shows the stage
  and its percentage, or "Waiting for you" when a workflow stops to ask something.
  Turn on **Notify when a run ends** (Settings ▸ General) for a desktop notification
  when a run ends, or a workflow needs you, while you work in another tab.
- **A stage that fails says so.** When a stage logs an error, a red note names it and
  shows the first error; click it to open the console. Before, the progress bar just
  closed and the reason was only in the log.
- **The Workflow Builder checks image files before a run.** When a run contains a
  block that reads pixels, every image's file is checked first. A moved, renamed or
  deleted file is restored from project storage where the project has a copy, and the
  rest are named in a warning before anything starts, instead of failing mid-run.
- **Footprints from poses follow the terrain.** Each image corner now lands where its
  ray meets a DEM: the global terrain behind the Terrain basemap, or an imported
  reference DEM. Before, footprints were cast onto one flat plane, so over relief they
  were too small or too large, and so was the overlap that preselection matches by.
  The terrain is the new default ground. The dialog asks which vertical datum the
  camera heights are in and converts the DEM to it. The flat plane and the
  height-above-ground plane remain.
- **Heights convert between ellipsoid and geoid.** GCPs and reference DEMs declare
  their vertical datum: ellipsoidal (WGS 84), EGM2008, EGM96, another geoid or local.
  Filling or checking a GCP's height from a DEM, and comparing a DEM with a reference,
  convert between the ellipsoid and the two global geoid models. The difference is up
  to about 100 m, and tens of metres over Antarctica. **Convert heights to…** in the GCP
  table changes a set of GCP heights to another datum. The geoid grids are part of the
  app and work offline.
- **GCPs straight off a reference orthophoto or DEM**: right-click an imported
  reference raster and choose Add GCP here, or move the selected GCP there. X/Y comes
  from the click and Z from a reference DEM. The accuracy comes from the raster's
  pixel size and its declared accuracy, so a project can be georeferenced with no
  survey data at all.
- **Accuracy & datum…** on each Reference Data row declares a raster's horizontal
  accuracy and, for a DEM, its vertical datum, accuracy and offset. Before, only a
  low-confidence import asked for these, so Fill Z could refuse with no way to fix it.
- **Quality gates and editable recipes in the Workflow Builder**: a Quality Gate
  block checks a Quality Report metric (registered images, reprojection error, track
  length, dense coverage …) after a stage and, when it fails, pauses, stops or jumps
  ahead to a named block; Go to jumps unconditionally. Jumps only go forward, so every
  run ends. The recipe text can now be edited and applied: a wrong line is refused with
  its line number and nothing changes. Point-cloud filter, normals, ICP and the mesh
  Clean, Smooth and Decimate tools are now blocks, each working on the previous
  block's result.
- **ALIKED** learned detector, with its own LightGlue matcher. Freely licensed
  (BSD-3-Clause / Apache-2.0) like DISK, and about four times faster to detect.
- **MAGSAC++** as an alternative to RANSAC for checking each image pair (Match
  Features ▸ Estimator). RANSAC stays the default: on the test sets both give the same
  accuracy.
- **COPC point clouds read in place**: a `.copc.laz` file is imported as it is and
  read node by node from its own octree, so a 93 million-point survey opens in seconds
  instead of minutes. The 3D view, crop, DEM, exports and 3D Tiles work on it as on any
  other large cloud.

### Changed
- **Sparse Reconstruction uses every core for its bundle adjustment.** Where the page
  can share memory with its workers (it can when served as the app is: Chrome,
  cross-origin isolated), the bundle adjustment runs on up to 16 threads, and gives the
  same result as on one, bit for bit. On 1,600 synthetic cameras it took 20–36 s instead
  of 62–120 s; on the 347-image quarry set 43 s instead of 92 s.
- **Orthophotos build on several workers, and faster on one.** Over saved depth maps,
  the blocks are shared among the compute workers: as many as the build predicts to be
  fastest, since each extra worker keeps a smaller cache of maps and photos. A worker
  that finishes early takes over blocks from a busier one. Photos are decoded a few at
  a time ahead of when they are needed and kept without their unused alpha channel,
  depth maps are read without their normals, and the per-cell passes do less work. The
  orthophoto is the same, pixel for pixel. Quarry at 12,000 pixels across: 18 minutes
  on one worker before, now 14 on one and under 6 on six.
- **Imported images stop depending on the original files.** Once an image's copy is
  written to the project, websfm reads the copy, so moving, renaming or deleting the
  originals afterwards (or a cloud-sync folder freeing them) no longer breaks images in
  the open session.
- **Workflow Match blocks pick their pairing per project.** A new Match Features block
  starts on **auto** pairing: Preselect when images have camera positions, Sequential
  for video frames, otherwise Exhaustive, the same as the Match Features dialog. A
  workflow used to match a video set exhaustively.
- **A long orthophoto or DEM reports its progress.** The progress bar names the block
  or group being built, and the log says how far the run has got (blocks done, or map
  visits while a group of blocks is still open) and roughly how long is left: after half
  a minute, then after 1, 2 and 4 minutes, then every 5, so a long run does not fill the
  log. A fine orthophoto used to stay silent until the end.
- **Counts read as English.** Log lines, reports and dialogs say "1 image" and
  "3 images" instead of "image(s)", and the verb agrees where it follows.
- **Georeferencing moved to the Reconstruct tab**, between Sparse and Dense, where it
  belongs in the pipeline: Find GCPs, Georeference and Scale Bars. Edit GCPs is a mode,
  so it stays a tool, now in Tools ▸ Images ▾ next to Edit mask. Every Tools group is
  now a menu.
- **Orthophoto seams**: the mosaic now chooses where seams run by graph cut, so they
  avoid roofs and tree crowns, and hides them by multiband blending, which keeps each
  photo's detail instead of averaging two photos across the seam band. Both are
  settings in Build Orthophoto (Seamlines, Seam blending); the old nearest-nadir seams
  and feathering are still offered. Colour balance may now correct a photo by up to
  ±2 stops (was ±1), for flights whose auto-exposure drifted.
- **Fisheye lenses: k4 in Auto self-calibration**: a four-term fisheye now gets its k4
  refined last, after k1–k3. If that fit would fold the lens curve, the pass is solved
  again without k4 rather than discarded.
- **Console `select`** now selects an image by name; the 3D lasso is `lasso`.

### Fixed
- An orthophoto over a DEM or mesh in a projected CRS was up to ten times slower than
  one in the model's local frame: the georeferenced frame is not exactly affine, so
  every cell took the full transform and no part of a photo was skipped as out of view.
  It now uses local fits checked against the exact frame. Quarry at 4,096 pixels across
  took 4 minutes instead of 14.
- Fusing a very large dense cloud (about 100 million points) failed near its end:
  Chrome holds at most 2 GB in one buffer and 16 GB for a tab, whatever the machine
  has. Fusion now finishes each slab straight into the cloud, splits a piece too large
  for one buffer, caps the memory budget at 12 GB and starts on fresh workers. Quarry
  at Medium, step 1, fuses 98 M points in under 10 minutes. Planning shows its
  progress, and the consistency check stops comparing once every pixel is settled.
- An orthophoto run no longer fails when the open project's clouds fill the tab:
  the photo cache leaves room for them and shrinks if the browser refuses memory.
  Orthophotos also decode fewer photos. On quarry the colour balance and seamline
  survey dropped from about 4 minutes to 1.5.
- A GeoTIFF nodata value of three characters or fewer ("255", "0") was read back as
  a different value by other programs.
- An orthophoto over very large scans (satellite frames past one canvas) refused to
  run, or fell back to depth-map colour: it reserved memory for each photo at its native
  size, and read photos at twice the resolution it asked for.
- In a floating-point Cloud-Optimized GeoTIFF with NaN as nodata, an empty cell
  turned the overview cells above it empty too, and partial edge tiles were padded with
  0 instead of nodata.
- After moving a project into a folder, its images, masks and products could no longer
  be read until it was reopened by hand. A moved project now reopens from its new
  location by itself, in both directions.

## [0.3.0] — 2026-10-18

### Added
- **Command console**: every ribbon command can be typed (by a short name, its id, or
  its id as words), taken from the ribbon itself, with per-command usage (`help
  <command>`, `help <tab>`). New commands: `run detect match sparse` and `run workflow
  <name>` through the workflow runner (`continue` / `reuse` / `stop` answer it),
  `stats` and `stats matches`, `set sfm.minPnpInlierRatio 0.5` for session-only tuning
  overrides (old → new echoed, key and type checked), `pair disable|enable <A> <B>` and
  `select <image>`. Ctrl+K (⌘K) opens the console with the cursor in the prompt; Tab
  also completes setting keys, stages and image names.
- **Measurement export**: Export ▸ Measurements… writes every saved measurement
  (rulers, areas, elevation profiles, volumes and 3D measurements) as CSV, one row
  each with its units in columns, or as GeoJSON lines and polygons with their values.
  GeoJSON is in the project CRS (heights kept) or in WGS 84 per RFC 7946; a
  measurement without a CRS is labelled with its frame and never placed on the map.
  Each saved-measurements list has its own Export… for just its records.
- **Video import**: Import ▸ Video (or dropping a video on the sidebar) extracts
  frames as images. The automatic mode scans the video and spaces the frames by how
  far the view moves, keeping the sharpest frame in each step and skipping blurry
  ones, up to a frame cap; a fixed interval (every N seconds or frames) is the
  alternative. The dialog shows how many frames it will extract before writing any.
  Frames are named `<video>_<time>.jpg`, share one sensor per video, and Match
  Features starts on Sequential pairing for them.
- **Level-of-detail point clouds**: a dense cloud of 4 million points or more gets an
  octree in the background (saved with the project, built once), and the 3D view then
  draws only a point budget's worth of it, the part in front of the camera in most
  detail, loading the rest as you move. The budget (5 million by default) is in
  Settings ▸ Map & 3D. Selection tools still see every point.
- **Streamed LAS/LAZ import**: a LAS or LAZ file too large to hold in memory is read
  in batches straight into its octree, so a 200-million-point survey imports (in a few
  minutes) and displays; LAZ is decoded a run of chunks at a time. Such a cloud is
  marked *streamed*. Build DEM grids it (also as a DTM of its ground class), reading
  the octree only as finely as the cell size needs; Crop copies a box of it into an
  ordinary cloud; Export writes LAS, LAZ, PLY or XYZ node by node. Selection (delete,
  keep only, assign class), an inverted crop, Filter and Classify ground run on it as
  it is, node by node or tile by tile, into a new streamed cloud.
- **3D Tiles with level of detail**: Export ▸ 3D Tiles can write a hierarchy of tiles
  that CesiumJS and other viewers stream in as the camera comes closer (the default from
  1 million points or 250,000 triangles). A point cloud is tiled by its octree, one tile
  per node with colour, classification and intensity, read node by node, so a streamed
  cloud of any size exports; a streamed LAS is placed in the CRS its file names. A mesh
  is split into a quadtree (terrain) or octree (object) of tiles and decimated per
  level, with tile borders kept so neighbours always meet; a textured mesh keeps its
  texture in the finest tiles.
- **Measure in 3D**: Tools ▸ Measure ▸ Measure in 3D measures distance, polylines and
  areas directly in the 3D view, picked on the surface of a mesh or on cloud points.
  Lengths are split into horizontal and height change, areas into surface area and
  footprint, all in metres once the project has a georeference or scale bars.
  Measurements can be saved with the project.
- **DEM of difference**: the volume tool can measure the computed DEM against an
  imported reference DEM, reporting gain, loss and net change inside a polygon
  (Tools ▸ Measure ▸ DEM of difference).
- **Reclassify by hand**: the 3D selection toolbox has an Assign class action, so
  points the ground filter got wrong (or any selection) can be set to a LAS class.
- **Textured meshes**: Tools ▸ Mesh ▸ Texture paints a mesh with the photos
  themselves, as a new mesh with an atlas of JPEG pages. Each triangle takes the photo
  that sees it largest, neighbouring triangles keep to the same photo so seams stay
  few, and tiny charts are merged into their neighbours. Exposure is levelled per photo
  (ignoring samples one photo sees differently) and then across every seam, so the
  two sides meet. A wall hidden behind a tree is still textured from the photo that
  hides least of it, and faces no photo sees can be kept in a flat colour or removed.
  An optional photo-consistency check leaves out what only some photos saw (people,
  cars), and photos scored blurrier by Image quality are used less.
  Crop, Clean and Smooth keep the texture (Clean's weld respects it), Sample to points
  takes its colours from it, and the workflow builder has a Texture Mesh block that can
  decimate first. Masks are respected, lenses
  and film scans are sampled through their own camera model, and the depth pass runs
  on the GPU when one is available. The 3D view shows the texture (Colour by ▸
  Texture), and it exports as GLB (pages embedded), OBJ (a zip with the material
  file and the pages) and 3D Tiles.
- **Installable app that works offline**: websfm can be installed from the browser
  and starts without a connection. A new version asks before reloading, and never
  interrupts a running task. Basemap areas viewed before stay available offline at
  lower detail, and the map says when it is offline instead of looking broken.
- **New app icon**: two cameras triangulating a point. The browser-tab icon has a
  transparent background and follows the browser's light or dark theme.
- **Ground classification and terrain models (DTM)**: Tools ▸ Point Cloud ▸ Classify
  ground labels every point as ground, above ground or low noise (standard LAS
  classes, kept in LAS/LAZ/PLY exports) with a cloth simulation filter. Build DEM ▸
  Points ▸ Ground only then makes a bare-earth DTM, and the new Fill enclosed gaps
  option interpolates the ground under removed buildings.
- **DEM vs reference DEM** in the Quality Report (Evaluate ▸ DEM vs Reference):
  bias, NMAD, RMSE, LE90 and overlap against an imported reference DEM, with a
  difference map and histogram, also in the exported report.
- **DEM and orthophoto symbology** (Products ▸ right-click ▸ Symbology…): colour
  ramp, height range and hillshade for the DEM; brightness, contrast and gamma for
  the orthophoto. Display only, kept across rebuilds.
- **Download from the sidebar**: right-click a point cloud, mesh, DEM or orthophoto
  for its export dialog (aimed at that item), or download a reference raster or
  source image as imported, a polygon layer as GeoJSON, or the match list.
- The **DEM / Orthophoto ribbon tab** offers the same actions for a computed and an
  imported raster: a computed one gains Symbology… and Remove, an imported one
  Download.
- **Orthophotos at the photos' own ground resolution**: no longer capped at 4,096
  pixels — up to about 28,000 pixels square. They are built in blocks and stored as a
  tiled Cloud-Optimized GeoTIFF, and the orthophoto tab and the 2D map draw them at
  full resolution as you zoom in.
- **Fiducial import and export** for film scans (Import / Export ▸ Image Fiducials
  and Camera Fiducials): each image's marks in pixels, and the camera's calibrated
  marks in mm with their slots, focal length and principal point, as CSV that
  imports back.
- **Fisheye and rational lens models**: sensors can use a Kannala–Brandt fisheye (one,
  two or four terms, as COLMAP's `SIMPLE_RADIAL_FISHEYE`, `RADIAL_FISHEYE` and
  `OPENCV_FISHEYE`) or OpenCV's rational model (k1–k6, p1, p2). Fisheye matches are
  verified in the pinhole frame and rays more than 75° off-axis are left out. Bundle
  adjustment fits fisheye cameras in the pixels the lens recorded, so self-calibration
  can refine the lens itself (up to k3) with the focal length and principal point; an
  uncalibrated fisheye (equidistant, all terms zero) reconstructs from EXIF alone. Depth
  maps use a fisheye's field up to 60° off-axis, and Optimize cameras handles fisheye
  models. COLMAP databases import these cameras instead of skipping them, and sensor CSVs read and write k4–k6 and a lens-model column.

### Changed
- **Region box handles**: while the Region toolbox is open, the box has drag handles
  in the 3D view: one per face moves that face, the centre one moves the whole box.
  The number fields follow, and Apply stores it as before.
- **LAZ export keeps every point attribute**: a distance, a PLY scalar or a class
  above 31 is written as an extra-bytes field in LAZ as it already was in LAS, instead
  of being left out. Streamed clouds exported as LAZ keep them too.
- **ICP to a mesh matches the surface**: Align to reference pairs each point with the
  closest point on the mesh's triangles instead of the nearest vertex, so a coarse
  mesh aligns to the cloud's noise level (a 10 m mesh: 0.4 mm instead of 0.5 m).
- **Project files past 4 GB**: a `.websfm` file is written as ZIP64 when it needs to
  be, so large projects can be saved and reopened whole. Opening a project file no
  longer reads each stored file into memory.
- **Calibration import updates sensors instead of always adding one**: Import ▸
  Calibration shows where each row goes before importing, and lets you change it. A
  row updates the sensor with its label, or the project's only sensor. With an image
  column, rows become sensors for the images they name. An update only sets the values
  the file has. The import also reads a film camera's certificate in one row (focal
  length, pixel pitch, principal point and fiducial marks in mm), and asks whether the
  focal length is in mm or pixels.
- **Image Fiducials import reads one row per image**: files with an x and a y column
  per mark position (`corner_top_left_x`, `midside_left_y`, …) are recognised on drop
  and each mark goes to the slot its columns name.
- **Fiducial imports preview first**: Image and Camera Fiducials open a dialog showing
  what will be imported (matched images, marks replaced, the target sensor) instead of
  applying the file straight away.
- **Changing the project CRS asks first**: the confirmation lists what will be
  reprojected (GCPs, camera positions, footprints) and whether the georeference has to
  be redone. Project Settings shows the CRS name, not just its code.
- **Help boxes stack**: hovering a link inside a pinned help box opens another box on
  top, and hovering a new word replaces them all. Setting labels in the pipeline
  dialogs (Detect, Match, Sparse, Depth maps, Dense, Mesh, DEM, Orthophoto) explain
  themselves on hover, without separate `?` icons. Each box shows the setting's
  current value next to its default. Every setting in these dialogs and in Auto mask
  now has a Guide section.
- **More help**: new Guide pages for masks and for working offline, a note on very
  large scans, and glossary entries for ICP, normals, contours, slope/aspect/hillshade,
  cloud distance, outlier removal, mesh smoothing and decimation, gap filling, COG,
  seamlines, image sharpness and masks, linked from the tool dialogs.
- EPSG codes from imported files, projects, GCPs and poses now resolve from the
  built-in catalog (over 7,000 coordinate systems), so they work offline. epsg.io is
  only asked for codes newer than the catalog.
- Orthophotos built with an earlier version must be rebuilt (the storage format
  changed). The Cloud-Optimized GeoTIFF export is now the stored file itself (always
  DEFLATE). PNG and JPEG exports are full resolution and offered up to 8,192 × 8,192
  pixels. Orthophoto builds follow the memory budget in Settings ▸ Compute.
- Orthophotos are now mosaicked by default: each area comes from the photo looking
  most straight down on it, exposure is balanced between photos, and seams are
  cross-faded. The previous per-pixel "Best match" and "Average" modes remain
  available.

### Performance
- **SfM on big blocks**: bundle adjustment solves its camera system exactly with a
  sparse Cholesky factorisation instead of a capped iterative solve, wherever the
  block has more than about 100 cameras. Registration scans only the image pairs a new
  camera touches, and re-solves of an already converged model stop sooner. Quarry
  (347 images) reconstructs in 135 s instead of 259 s and South Building in 48 s
  instead of 85 s, with the same cameras and accuracy against RTK; 1,600 synthetic
  cameras take 97 s instead of 353 s. Start-up on a large block with a calibrated lens no
  longer re-fits every image pair's epipolar geometry up front (1,600 synthetic
  cameras: 88 s → 3 s).
- **Outlier filter (statistical)**: about 16× faster on terrain and other surface-like
  clouds (a 2 M-point survey tile: 178 s → 11 s). Its neighbour grid was sized from
  the bounding box's volume, so on a surface each point compared against thousands of
  candidates; the grid now follows the occupancy, and the neighbour search is exact
  (results unchanged to 0.01 %).

### Fixed
- Picking a CRS from the search list by clicking it did nothing in Project Settings
  and the import dialogs; the field went back to the old CRS.
- Calibration and camera-position imports no longer assign unrecognised columns by
  their position when the file has a header (a camera-position file's `x_map` became
  omega).
- **GCP import reads files with several coordinate pairs and image marks**: a point
  label column (`gcp_label`, `point_label`) is the name, a bare `x`/`y` beside an image
  column is the pixel position, `x_map`/`y_map` and `*_acc` columns are recognised, and
  lon/lat is preferred with WGS 84 preselected. A file of image marks without
  coordinates adds them to existing points of the same name, or adds markers.
- Dropped files with an `image_file_name` (or `image_id`) column are recognised: a
  camera-position list opens the camera import with lon/lat read as WGS 84, and a
  file with a `gcp_label` / `point_label` column opens the GCP import, instead of the
  "what is this file?" chooser.
- Depth maps of a two-image project (or an image only one neighbour overlaps) came out
  empty: Consistent views now drops to the number of views that image overlaps, and
  the log says so.
- Importing a mask without transparency (JPEG, plain black-and-white PNG) masked the
  whole image. Such files are now read by brightness: black is masked, white is kept.
- Very large scans: Auto mask, mask import and fiducial frame masks no longer try to
  build a canvas at full scan size, which the browser can't hold. Masks for these
  scans are stored at 8,192 px on the long side. Import, Invert and Clear work in the
  viewer; painting says it isn't available yet instead of "editing resumes…" forever.
- Orthophoto: a Max match cost the depth maps' own Minimum NCC already made
  meaningless now shows a warning instead of silently doing nothing.
- The Auto mask ribbon entry described sky/people masking it doesn't do.
- Help boxes opened from inside a dialog could not be clicked ("Read more" and their
  links did nothing).
- Help text could link a word inside another link (e.g. "SIFT" inside "SIFT
  descriptor"); stale help text was brought up to date with recent changes.
- Imported image fiducial observations were ignored by calibration and
  reconstruction until the project was reopened; they now land as detections.
- An orthophoto built at a chosen pixel size lost its coordinate frame, so Find GCPs
  refused it and the model-frame map could not place it.
- An imported orthophoto's tab showed "no data" under the cursor; it now reads the
  pixel's band values.
- Images without a focal length in their metadata (no EXIF) reconstructed on a guessed
  field of view that could be far off, which broke scenes or left most cameras out.
  The focal length is now estimated from the matched image pairs first (ETH3D
  playground and terrace: from broken to 34 of 38 and 23 of 23 cameras).
- A camera could be registered in the wrong place and stay there. After the
  reconstruction, each camera is now checked against the matches with its strongest
  partner images; cameras that disagree are taken out and registered again, or left
  out if they still disagree.
- COLMAP database import dropped the k4–k6 terms of `FULL_OPENCV` cameras without a
  warning.
- The same matches could reconstruct slightly differently in different sessions (the
  solver's input order followed random image ids); it now follows image names.

## [0.2.0] — 2026-10-12

### Added
- **Find GCPs** matches the orthophoto to a georeferenced reference coarse to fine.
  It tolerates rotation and a different resolution, finds a small block inside a
  regional reference, and starts from the photos' GPS when the orthophoto is not yet
  georeferenced. Each candidate shows a confidence, a residual and an accuracy taken
  from the reference's pixel size. Candidates are spread over the block, and none is
  added until you tick it.
- **Workflow Builder**: arrange pipeline steps as blocks, choose per step whether to
  reuse or rerun existing results, and save recipes and run history with the project.
- **Tools menus with floating toolboxes**, plus many new tools:
  - point clouds: normals, transform, point-pair alignment, ICP, cloud-to-cloud and
    cloud-to-mesh distance, sections;
  - meshes: clean, smooth, decimate, crop, sample to points, area and volume;
  - DEMs: contours (GeoJSON/DXF), slope, aspect, hillshade, clip to polygon;
  - model: optimize cameras, region of interest, orient model;
  - images: image quality.
- **Measurements** on DEMs, orthophotos and the 2D map: ruler, area, elevation
  profile (CSV export) and cut/fill volume. Measurements are named and saved.
- **Scale bars**: give an object capture real-world units from known distances. New
  "marker" points carry image marks but no surveyed position.
- **Rectangle and lasso selection** in the 3D viewer, to delete or keep points.
- **Gradual selection**: remove weak tie points from the sparse model and re-adjust.
- **Find GCPs**: match photos against a reference orthophoto to propose
  control-point candidates for review.
- **WebGPU feature matching**, with automatic fallback to the CPU.
- **DISK** learned detector, with its own LightGlue matcher.
- Computed DEMs and orthophotos can be shown on the 2D map. Projects without a CRS
  get a top-down map in the model's own frame.
- Orthophotos can be projected onto a DEM, the mesh or a fitted plane, at their own
  resolution.
- One-click suggestion of a projected CRS (UTM or polar stereographic) for
  geotagged projects.
- Image groups (folders) in the sidebar, a per-sensor GNSS antenna offset, and film
  width (mm) as the scale field for film scans.
- Extra point attributes (such as intensity and GPS time) survive import and are
  written to PLY and LAS exports.
- The theme can follow the operating system.

### Changed
- Feature matching is reproducible: the same images now give the same matches in
  every project, where before a few percent of image pairs varied slightly.
- Sharper orthophotos: colour now comes from the original photos at full resolution
  instead of the lower-resolution depth maps.
- Dense clouds are more complete: fusion's matching-cost gate is now a fixed, looser
  default (0.8) instead of one adapted to each dataset, which was discarding real
  surface. On the ETH3D benchmark this closes the gap to COLMAP at 2 cm with no loss of
  accuracy.
- Camera positions from EXIF GPS now constrain bundle adjustment automatically.
- WebGPU is used automatically for dense depth maps when the browser supports it.
- SIFT uses RootSIFT descriptors and keeps coarse-scale keypoints first, which gives
  more multi-view tracks. Older projects are converted when matching runs.
- The default matching ratio changed from 0.75 to 0.8.
- Detection and matching settings are shown in the order they run, each with a live
  preview of its effect. A setting that would have no effect is greyed out with the
  reason.
- DEMs and orthophotos cover the dense core of the cloud by default. Choose
  "All points" to cover everything.
- Much larger projects fit in browser memory. A 347-image project now runs dense
  reconstruction at Medium quality where it was refused before, and fusion splits a
  cloud that does not fit in memory at once (tested at 69 M points).
- SuperPoint weights are no longer served by the app because of their
  non-commercial license. You can supply the file yourself.

### Performance
- Feature detection runs more images in parallel: its memory limit now follows the
  machine budget in Settings ▸ Compute instead of a fixed 1 GB.
- Project opening: the slowest step went from 11.6 s to 0.18 s on a 300 k-point
  model. Keypoints and matches now load on demand, and a progress bar names each
  loading step.
- Bundle adjustment stops once it has converged (608 → 205 s on one dataset), and
  sparse reconstruction is a further 14–50 % faster.
- Meshing is 7.4× faster end to end, and the solve itself 15× faster.
- The dense cross-view filter runs in parallel and is about 3× faster
  (444 → 101 s). Fusion is about 2× faster on large sets.
- Saving after a 3D edit writes only the clouds that changed.

### Fixed
- Building a mesh from a large dense cloud (around 17 million points or more) failed
  with "Map maximum size exceeded" after the surface was solved.
- Georeferencing in polar regions was off by metres. Error-free control at 80°S now
  fits to 0.07 mm, and measurements report ground values.
- Heights in 3D Tiles exports were scaled wrongly near the poles.
- GeoTIFF import now honours the tie point and the PixelIsPoint setting. Re-import
  affected rasters to correct them.
- Meshes showed "blob" artefacts. Meshing now also uses your cleaned cloud rather
  than the first dense cloud.
- Oblique drone captures are levelled, so DEMs and orthophotos are no longer tilted.
- Datasets that start with near-stationary bursts now reconstruct fully (one
  dataset: 7 → 127 of 127 cameras).
- 16-bit TIFFs had low contrast and gave few keypoints. Large TIFF batches used
  excessive memory.
- Tiled detection created duplicate keypoints, which cost matches.
- Dense clouds: sky could survive the filters, thin tall features collapsed, and very
  large fusions crashed or were wrongly refused.
- Renaming an image detached its GCP marks, poses and footprints.
- COLMAP database export contained no descriptors for saved projects.
- "Failed to create swap file" errors in folder-backed projects.
- Images whose source file disappears during a session are recovered from the
  project copy.
- Some LAS files with 8-bit colour imported black, and some LAZ files failed to load.
- Cancelling GPU matching did not stop the run.

## [0.1.0-beta.1] — 2026-08-10

First public beta.

- Runs entirely in the browser. Projects are stored locally, can be saved and loaded
  as `.websfm` files, or kept in a folder on disk (Chromium browsers).
- SIFT and learned (SuperPoint + LightGlue) features. Pairs can be chosen by GPS
  proximity or capture sequence.
- Incremental structure-from-motion with bundle adjustment, lens self-calibration and
  Brown distortion. Scanned aerial film is supported through fiducial marks.
- Georeferencing from ground control points (with guided marking) or camera
  positions, in any proj4 CRS, including polar projections.
- Dense point clouds (optional WebGPU), screened-Poisson meshes, DEMs and
  orthophotos.
- Reference GeoTIFF DEMs and orthophotos can be imported and shown on the map.
- A Quality Report with an exportable HTML summary.
- Import and export: COLMAP models, PLY, LAS/LAZ, XYZ, GeoTIFF/COG, 3D Tiles,
  `transforms.json`, undistorted images.
- Smart (SAM2) masking, an in-app guide and a glossary.
