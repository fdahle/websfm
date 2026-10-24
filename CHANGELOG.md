# Changelog

Notable changes to websfm. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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
- **Turntable (View ▸ Camera ▸ Turntable).** The 3D view turns the model slowly about
  its up direction, for presenting a result or checking a dense cloud; dragging steers
  it, and it carries on when you let go. Its toolbox sets the seconds per turn and
  **Record one turn** saves exactly one turn of the view as a looping video (WebM, or
  MP4 in Safari). A new guide article, **The 3D View**, covers navigation, the view
  presets and the turntable.
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
- **Find GCPs** matches the orthophoto to a georeferenced reference coarse to fine.
  It tolerates rotation and a different resolution, finds a small block inside a
  regional reference, and starts from the photos' GPS when the orthophoto is not yet
  georeferenced. Each candidate shows a confidence, a residual and an accuracy taken
  from the reference's pixel size. Candidates are spread over the block, and none is
  added until you tick it.
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
- **Workflow Builder**: arrange pipeline steps as blocks, choose per step whether to
  reuse or rerun existing results, and save recipes and run history with the project.
- **Tools menus with floating toolboxes**, plus many new tools:
  - point clouds: normals, transform, point-pair alignment, ICP, cloud-to-cloud and
    cloud-to-mesh distance, sections;
  - meshes: clean, smooth, decimate, crop, sample to points, area and volume;
  - DEMs: contours (GeoJSON/DXF), slope, aspect, hillshade, clip to polygon;
  - model: optimize cameras, region of interest, orient model;
  - images: image quality.
- **Ground classification and terrain models (DTM)**: Tools ▸ Point Cloud ▸ Classify
  ground labels every point as ground, above ground or low noise (standard LAS
  classes, kept in LAS/LAZ/PLY exports) with a cloth simulation filter. Build DEM ▸
  Points ▸ Ground only then makes a bare-earth DTM, and the new Fill enclosed gaps
  option interpolates the ground under removed buildings.
- **Measurements** on DEMs, orthophotos and the 2D map: ruler, area, elevation
  profile (CSV export) and cut/fill volume. Measurements are named and saved.
- **Scale bars**: give an object capture real-world units from known distances. New
  "marker" points carry image marks but no surveyed position.
- **Rectangle and lasso selection** in the 3D viewer, to delete or keep points.
- **Gradual selection**: remove weak tie points from the sparse model and re-adjust.
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
- **Find GCPs**: match photos against a reference orthophoto to propose
  control-point candidates for review.
- **WebGPU feature matching**, with automatic fallback to the CPU.
- **DISK** learned detector, with its own LightGlue matcher.
- Computed DEMs and orthophotos can be shown on the 2D map. Projects without a CRS
  get a top-down map in the model's own frame.
- Orthophotos can be projected onto a DEM, the mesh or a fitted plane, at their own
  resolution.
- **Orthophotos at the photos' own ground resolution**: no longer capped at 4,096
  pixels — up to about 28,000 pixels square. They are built in blocks and stored as a
  tiled Cloud-Optimized GeoTIFF, and the orthophoto tab and the 2D map draw them at
  full resolution as you zoom in.
- One-click suggestion of a projected CRS (UTM or polar stereographic) for
  geotagged projects.
- Image groups (folders) in the sidebar, a per-sensor GNSS antenna offset, and film
  width (mm) as the scale field for film scans.
- Extra point attributes (such as intensity and GPS time) survive import and are
  written to PLY and LAS exports.
- The theme can follow the operating system.
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
- Feature matching is reproducible: the same images now give the same matches in
  every project, where before a few percent of image pairs varied slightly.
- Sharper orthophotos: colour now comes from the original photos at full resolution
  instead of the lower-resolution depth maps.
- Orthophotos are now mosaicked by default: each area comes from the photo looking
  most straight down on it, exposure is balanced between photos, and seams are
  cross-faded. The previous per-pixel "Best match" and "Average" modes remain
  available.
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
- **Sparse reconstruction outside bundle adjustment.** The model's reprojection
  statistics, the self-calibration fit and guided track extension stopped allocating per
  observation, and guided extension only tries the cameras that can see a point. Quarry
  (347 images): 82 → 77 s, the identical model.
- **Depth maps on large scans, and the cross-view filter.** On a block of 58 film
  scans (97 MP) at High: masks and grey planes are built once per image instead of for
  every map they serve, the speckle filter is 5.7× faster (same output), previews are
  at most 2,048 px, greyscale scans are cached as one channel, and the next map's
  images are prepared while the current one matches. The cross-view filter checks each
  map against at most 12 overlapping views with enough parallax, and sizes its workers
  by memory: 30 → 4.4 min. Depth maps and filter together: 54 → 26 min. Fusion
  compares each map with at most 12 views too, and its planning passes read only depth
  and cost: 22 → 7.8 min, the same cloud for the planning change.
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
- Images without a focal length in their metadata (no EXIF) reconstructed on a guessed
  field of view that could be far off, which broke scenes or left most cameras out.
  The focal length is now estimated from the matched image pairs first (ETH3D
  playground and terrace: from broken to 34 of 38 and 23 of 23 cameras).
- A camera could be registered in the wrong place and stay there. After the
  reconstruction, each camera is now checked against the matches with its strongest
  partner images; cameras that disagree are taken out and registered again, or left
  out if they still disagree.
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
- COLMAP database import dropped the k4–k6 terms of `FULL_OPENCV` cameras without a
  warning.
- The same matches could reconstruct slightly differently in different sessions (the
  solver's input order followed random image ids); it now follows image names.

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
