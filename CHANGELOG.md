# Changelog

Notable changes to websfm. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
- **A full browser storage no longer ends a depth-map run.** When browser storage runs
  full while depth maps are built, the run pauses and offers to move the project to a
  folder on disk, then carries on there; stopping ends it, as before. The browser copy
  is removed and the project reopened from the folder once the run has ended.
  **Move to folder…** now also works while some changes could not be saved, and saves
  them in the folder.
- **Settings in groups.** The General and Map & 3D tabs of Settings put their settings
  under headings (Appearance, Help and dialogs, During a run, Notices; Map, 3D view)
  instead of one long list of switches.
- **What's New without glossary links.** Its text no longer underlines the glossary
  terms it names, which in a changelog was nearly every line.

### Fixed
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
