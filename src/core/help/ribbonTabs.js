// The ribbon's command tables — pure data, so a test can pin them (every `needs`
// key exists in NEED_CHECKS, ids are unique, every menu has a working row).
// Ribbon.vue renders them; App.vue `handleCommand(id, value)` dispatches them.
//
// THE RULE (CLAUDE.md ▸ Layering): the ribbon *chooses*. It
// opens a dialog, enters a mode, toggles a display option, or sets a small display
// value (stepper). Everything done *inside* a running tool lives in that tool's
// floating toolbox in the view (components/viewers/FloatingToolbox.vue).
//
// Command shapes:
//   { id, label, icon, needs?: [...NEED_CHECKS keys], aerialOnly?, disabled?, activeKey? }
//   { pair: [cmd, cmd] }                 two half-height commands in one footprint
//   { id, label, icon, menu: [...] }     a dropdown; rows are commands plus
//                                        { section: 'Name' } headings. Rows carry a
//                                        one-line `blurb`. A greyed row prints its
//                                        reason inline (discoverability, as in the
//                                        Evaluate hub), it is never hidden by state.
//   { stepper: true, id, label, icon, valueKey, min, max, step, format? }
//                                        a half-height − value + row (inside a pair);
//                                        emits (id, newValue).
// `disabled: true` = "Coming soon": only for work already planned in TODO.md.
//
// ONE HOME PER TOOL. Anything that enters a mode or opens a toolbox (selection,
// mask/GCP editing, measuring, region, orient…) lives in the Tools tab, in its
// object family's menu. The View tab and the contextual tabs (Picture, DEM /
// Orthophoto) only show and arrange: camera presets, toggles, fit/zoom, styling,
// on-map, remove. A command that does appear twice (Rebuild / Export on a raster
// tab) is the SAME object below, so its prerequisites cannot drift.

import { BASEMAPS } from '../basemaps.js'

// Shared between Reconstruct/Export and the raster tab's object actions.
const GEN_DEM = { id: 'gen-dem', label: 'DEM', icon: 'dem', needs: ['cloud'], aerialOnly: true }
const GEN_ORTHO = {
  id: 'gen-ortho',
  label: 'Ortho',
  icon: 'ortho',
  needs: ['imagesReady', 'depthMaps', 'surface'],
  aerialOnly: true,
}
const EXPORT_DEM = { id: 'export-dem', label: 'DEM', icon: 'dem', needs: ['dem'], aerialOnly: true }
const EXPORT_ORTHO = { id: 'export-ortho', label: 'Ortho', icon: 'ortho', needs: ['ortho'], aerialOnly: true }

// Tools ▸ Measure ▾. Raster tools run on the raster in front: a DEM/Orthophoto
// tab, or the 2D map's measure target. On the map the menu also lists the
// target choices (the map stacks several rasters; profile/volume need a DEM even
// while an orthophoto is drawn above it).
//   m: { targets: [{ id, name, kind }], targetId } — the map's raster layers, or null.
// `measure-target:<id>` rows pick the target; App dispatches the prefix.
export function measureMenu(m = null) {
  const targets = m?.targets ?? []
  return [
    { section: 'DEM / orthophoto in front' },
    {
      id: 'measure-length',
      label: 'Ruler',
      icon: 'ruler',
      measureTool: 'length',
      needs: ['measureHost'],
      blurb: 'Ground distance along a polyline',
    },
    {
      id: 'measure-area',
      label: 'Area',
      icon: 'area',
      measureTool: 'area',
      needs: ['measureHost'],
      blurb: 'Planimetric area and perimeter of a polygon',
    },
    {
      id: 'measure-profile',
      label: 'Profile',
      icon: 'profile',
      measureTool: 'profile',
      demOnly: true,
      needs: ['measureHost'],
      blurb: 'Elevation profile along a line (DEM)',
    },
    {
      id: 'measure-volume',
      label: 'Volume',
      icon: 'volume',
      measureTool: 'volume',
      demOnly: true,
      needs: ['measureHost'],
      blurb: 'Cut / fill against a base surface (DEM)',
    },
    {
      id: 'measure-saved',
      label: 'Saved measurements',
      icon: 'list',
      activeKey: 'measureSaved',
      needsSavedMeasurements: true,
      needs: ['measureHost'],
      blurb: 'Show, reopen and export saved results',
    },
    ...(targets.length
      ? [
          { section: 'Map layer to measure' },
          ...targets.map((t) => ({
            id: `measure-target:${t.id}`,
            label: t.name,
            icon: t.kind === 'dem' ? 'dem' : 'ortho',
            selected: t.id === m.targetId,
            blurb: t.kind === 'dem' ? 'DEM — all tools, including profile and volume' : 'Orthophoto — ruler and area',
          })),
        ]
      : []),
    { section: 'Clouds & meshes' },
    {
      id: 'measure-3d',
      label: 'Measure in 3D',
      icon: 'ruler',
      needs: ['cloud'],
      blurb: 'Distance, height and surface area picked on clouds and meshes',
    },
    {
      id: 'cloud-distance',
      label: 'Distance to reference…',
      icon: 'distance',
      needs: ['dense'],
      blurb: 'Per-point distance to another cloud or a mesh (change detection)',
    },
    {
      id: 'cloud-section',
      label: 'Section…',
      icon: 'section',
      needs: ['dense'],
      blurb: 'Cut a thin slice and export it as a 2D profile',
    },
    {
      id: 'mesh-measure',
      label: 'Mesh area & volume…',
      icon: 'volume',
      needs: ['mesh'],
      blurb: 'Surface area; enclosed volume when watertight',
    },
    { section: 'Change' },
    {
      id: 'dem-difference',
      label: 'DEM of difference',
      icon: 'volume',
      needs: ['dem', 'demCrs'],
      blurb: 'Gain and loss inside a polygon against a reference DEM or the background terrain',
    },
  ]
}

export const TABS = [
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Inspect',
        commands: [
          { id: 'open-image-table', label: 'Images', icon: 'table', needs: ['images'] },
          { id: 'open-mask-manager', label: 'Masks', icon: 'mask', needs: ['images'] },
          { id: 'open-sensor-table', label: 'Sensors', icon: 'camera', needs: ['sensors'] },
          { id: 'open-pose-table', label: 'Camera\nPoses', icon: 'camera-pose', needs: ['poses'] },
          // The table edits existing points; one is born elsewhere (import, or a
          // right-click on the map / an image), so an empty project has nothing to show.
          // Deliberately NOT aerialOnly: it also holds markers (scale-bar endpoints),
          // which are an object-capture feature. Importing surveyed *ground control*
          // stays aerial-only — that command is in the Import tab, not this one.
          { id: 'open-gcp-table', label: 'Control &\nMarkers', icon: 'map-pin', needs: ['gcps'] },
          { id: 'open-match-list', label: 'Matches', icon: 'list', needs: ['matches'] },
        ],
      },
      // The remaining groups are contextual: see CAMERA_GROUP etc. below, injected by
      // `tabFor` depending on the active viewer.
    ],
  },
  {
    id: 'import',
    label: 'Import',
    groups: [
      {
        label: 'Images',
        commands: [
          { id: 'import-images', label: 'Images', icon: 'image' },
          // Frames of a video become images (keyframes by motion and sharpness, or a
          // fixed interval) — the dialog plans them before anything is written.
          { id: 'import-video', label: 'Video', icon: 'video' },
          // Scan-pixel mark positions per image (a row per mark, or a row per image
          // with x/y columns per position); rows match images by name, so
          // (unlike GCPs) the images must be there first.
          { id: 'import-image-fiducials', label: 'Image\nFiducials', icon: 'target', needs: ['images'] },
        ],
      },
      {
        label: 'Cameras',
        commands: [
          { id: 'import-camera-list', label: 'Camera\nPoses', icon: 'camera-pose' },
          // Intrinsics per sensor or per image; updates matching sensors (by label,
          // the images' sensor, or the only one) or adds new ones — the dialog shows which.
          { id: 'import-calib', label: 'Calibration', icon: 'calibration' },
          // A film camera's certificate marks (mm); rows match sensors by label.
          { id: 'import-camera-fiducials', label: 'Camera\nFiducials', icon: 'camera', needs: ['sensors'] },
        ],
      },
      {
        label: 'Ground Control',
        commands: [
          // GCP coordinates and filename-keyed observations are project data. They
          // can be imported before images and reconcile automatically as images arrive.
          { id: 'import-gcps', label: 'GCP\nFile', icon: 'map-pin', aerialOnly: true },
        ],
      },
      {
        // Evidence the user brought in; the pipeline never overwrites it. Mirrors the
        // sidebar's Reference Data section, which is where an imported cloud lands too —
        // hence the point cloud / mesh import sits here, not with COLMAP.
        label: 'Reference Data',
        commands: [
          // Explicit entry point, so the user never has to rely on the dropped-TIFF
          // geokey sniff.
          { id: 'import-raster', label: 'Reference\nDEM / Ortho', icon: 'layers' },
          { id: 'import-cloud', label: 'Point Cloud\n/ Mesh', icon: 'point-cloud' },
        ],
      },
      {
        label: 'Interoperability',
        commands: [{ id: 'import-colmap', label: 'SfM\nProject…', icon: 'cube' }],
      },
    ],
  },
  {
    id: 'reconstruct',
    label: 'Reconstruct',
    groups: [
      {
        label: 'Workflow',
        commands: [{ id: 'workflow-builder', label: 'Workflow\nBuilder', icon: 'list', needs: ['project'] }],
      },
      {
        label: 'Features',
        commands: [
          { id: 'detect-features', label: 'Detect\nFeatures', icon: 'sparkles', needs: ['images', 'imagesReady'] },
          { id: 'match-features', label: 'Match\nFeatures', icon: 'link', needs: ['imagesReady', 'keypoints'] },
        ],
      },
      // The groups are pipeline *stages*, in order: features → sparse →
      // georeferencing → dense → deliverables. Dense stays a reconstruction stage
      // rather than a product: it is still the scene geometry, and DEM/Ortho/Mesh
      // are all derived *from* it.
      {
        label: 'Sparse',
        commands: [
          { id: 'reconstruct', label: 'Sparse\nModel', icon: 'sparse-model', needs: ['imagesReady', 'matches'] },
        ],
      },
      {
        // Plain buttons, not a menu: a pipeline step done once per project, and the
        // step a new user most needs to find. Between Sparse and Dense: a GCP
        // adjustment rebuilds the sparse model and invalidates depth maps and
        // everything after them (guide: getting-started ▸ 4).
        // No "Project CRS" entry here: CRS is project *configuration*, set from the
        // Settings modal (App.vue `handleSetCrs`), not a tool that transforms data.
        // Edit GCPs is a mode, so it lives in Tools ▸ Images ▾ (ONE HOME PER TOOL).
        label: 'Georeferencing',
        commands: [
          { id: 'find-gcps', label: 'Find\nGCPs', icon: 'map-pin', needs: ['sparse'], aerialOnly: true },
          // One entry point for both GCP-constrained adjustment + final similarity fit
          // and the cheap transform-only path. The modal explains/validates each mode.
          { id: 'georeference', label: 'Geo-\nreference', icon: 'target', needs: ['sparse'], aerialOnly: true },
          // Same job as Georeference — fixing the datum — for a project that has no
          // CRS at all. Deliberately NOT aerialOnly: scale bars are the object-capture
          // way to get metres, and an object project is exactly where there is no
          // georeference to supply one.
          { id: 'scale-bars', label: 'Scale\nBars', icon: 'scale-bar', needs: ['sparse'] },
        ],
      },
      {
        label: 'Dense',
        commands: [
          { id: 'compute-depth', label: 'Depth\nMaps', icon: 'depth', needs: ['imagesReady', 'sparse'] },
          { id: 'dense', label: 'Dense\nModel', icon: 'point-cloud', needs: ['depthMaps'] },
        ],
      },
      {
        label: 'Products',
        commands: [GEN_DEM, GEN_ORTHO, { id: 'gen-mesh', label: 'Mesh', icon: 'cube', needs: ['dense'] }],
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    groups: [
      // One dropdown per OBJECT FAMILY, ordered the way the data flows: images →
      // model → cloud → mesh → raster products. A new tool is one
      // more menu row, never one more ribbon button, so this tab keeps its width.
      {
        label: 'Images',
        commands: [
          {
            id: 'menu-images',
            label: 'Images',
            icon: 'image',
            menu: [
              { section: 'Prepare' },
              {
                id: 'image-quality',
                label: 'Image quality…',
                icon: 'quality',
                needs: ['images', 'imagesReady'],
                blurb: 'Score sharpness and exposure; exclude blurry images',
              },
              {
                id: 'auto-mask',
                label: 'Auto mask…',
                icon: 'mask',
                needs: ['images', 'imagesReady'],
                blurb: 'Mask a border strip on every image (film edges, data strips)',
              },
              { section: 'Film scans' },
              {
                id: 'detect-fiducials',
                label: 'Detect fiducials…',
                icon: 'target',
                needs: ['filmSensor', 'imagesReady'],
                blurb: 'Find the fiducial marks on scanned film frames',
              },
              {
                id: 'calibrate-fiducials',
                label: 'Calibrate fiducials…',
                icon: 'calibration',
                needs: ['filmSensor'],
                blurb: 'Camera-certificate or batch-estimated fiducial layout',
              },
              {
                id: 'detect-reseau',
                label: 'Detect reseau…',
                icon: 'target',
                needs: ['images', 'imagesReady'],
                blurb: 'Measure the reseau crosses: scan placement and film deformation per scan',
              },
              {
                id: 'split-panoramic',
                label: 'Split panoramic strips…',
                icon: 'image',
                needs: ['images', 'imagesReady'],
                blurb: 'Cut panoramic (optical-bar) scans into frame-camera segments',
              },
              { section: 'Edit' },
              // A mode on the image in front; brush/eraser/rect/invert/undo live in the
              // floating MaskToolbar over the image view.
              {
                id: 'img-mask-edit',
                label: 'Edit mask',
                icon: 'pencil',
                activeKey: 'maskEdit',
                needs: ['imageView'],
                blurb: 'Paint the mask of the image in front',
              },
              // One mode for the view in front: on an image a click marks a GCP (the
              // floating GcpToolbar), on the map it places/moves surveyed points.
              {
                id: 'edit-gcps',
                label: 'Edit GCPs',
                icon: 'map-pin',
                activeKey: 'gcpEdit',
                needs: ['gcpView'],
                blurb: 'Mark GCPs on the image in front, or place them on the map',
              },
            ],
          },
        ],
      },
      {
        label: 'Model',
        commands: [
          {
            id: 'menu-model',
            label: 'Model',
            icon: 'sparse-model',
            menu: [
              { section: 'Refine' },
              {
                id: 'optimize-cameras',
                label: 'Optimize cameras…',
                icon: 'calibration',
                needs: ['sparse'],
                blurb: 'Re-run bundle adjustment with chosen lens parameters',
              },
              {
                id: 'gradual-selection',
                label: 'Gradual selection…',
                icon: 'sparse-model',
                needs: ['sparse'],
                blurb: 'Remove weak tie points by error, views or angle',
              },
              { section: 'Frame' },
              {
                id: 'set-region',
                label: 'Region…',
                icon: 'region',
                needs: ['sparse'],
                blurb: 'A box that limits depth maps, fusion, mesh and DEM',
              },
              {
                id: 'orient-model',
                label: 'Orient model…',
                icon: 'level',
                needs: ['sparse'],
                blurb: 'Level the model and set its origin (projects without CRS)',
              },
              { section: 'Cameras' },
              {
                id: 'footprints-from-poses',
                label: 'Footprints from poses…',
                icon: 'footprint',
                needs: ['poses', 'sensors'],
                aerialOnly: true,
                blurb: 'Project image outlines onto the ground',
              },
            ],
          },
        ],
      },
      {
        // These edit **dense** clouds (computed or imported) and always produce a
        // new cloud — the source is never modified. A sparse cloud is deliberately
        // not editable: its points carry the view-tracks dense/ortho/COLMAP read.
        label: 'Point Cloud',
        commands: [
          {
            id: 'menu-cloud',
            label: 'Point\nCloud',
            icon: 'point-cloud',
            menu: [
              { section: 'Clean' },
              {
                id: 'filter-cloud',
                label: 'Filter…',
                icon: 'point-cloud',
                needs: ['dense'],
                blurb: 'Height/brightness range, voxel, isolated points, outliers',
              },
              {
                id: 'cloud-outliers',
                label: 'Remove outliers…',
                icon: 'point-cloud',
                needs: ['dense'],
                blurb: 'Statistical outlier removal',
              },
              {
                id: 'cloud-subsample',
                label: 'Subsample…',
                icon: 'grid',
                needs: ['dense'],
                blurb: 'Thin to one point per voxel',
              },
              { section: 'Edit' },
              // Modes in the 3D view; Delete / Keep only / Clear are its floating toolbox.
              {
                id: 'view-select-rect',
                label: 'Select (rectangle)',
                icon: 'rect',
                activeKey: 'selectRect',
                needs: ['dense'],
                blurb: 'Drag a box in the 3D view, then delete or keep',
              },
              {
                id: 'view-select-lasso',
                label: 'Select (lasso)',
                icon: 'lasso',
                activeKey: 'selectLasso',
                needs: ['dense'],
                blurb: 'Draw a freehand outline in the 3D view, then delete or keep',
              },
              {
                id: 'crop-cloud',
                label: 'Crop…',
                icon: 'rect',
                needs: ['dense'],
                blurb: 'Keep or remove an axis-aligned box',
              },
              {
                id: 'transform-cloud',
                label: 'Transform…',
                icon: 'transform',
                needs: ['dense'],
                blurb: 'Move, rotate, scale, or apply a 4×4 matrix',
              },
              { section: 'Combine' },
              {
                id: 'merge-clouds',
                label: 'Merge…',
                icon: 'link',
                needs: ['twoClouds'],
                blurb: 'Concatenate clouds with an optional seam dedupe',
              },
              {
                id: 'align-points',
                label: 'Align by point pairs…',
                icon: 'align',
                needs: ['dense'],
                blurb: 'Pick ≥3 matching points in both clouds',
              },
              {
                id: 'align-icp',
                label: 'Align to reference (ICP)…',
                icon: 'align',
                needs: ['dense'],
                blurb: 'Refine an approximate alignment automatically',
              },
              { section: 'Attributes' },
              {
                id: 'estimate-normals',
                label: 'Estimate normals…',
                icon: 'normals',
                needs: ['dense'],
                blurb: 'Per-point normals, e.g. to mesh an imported cloud',
              },
              {
                id: 'classify-ground',
                label: 'Classify ground…',
                icon: 'dem',
                needs: ['dense'],
                blurb: 'Bare-earth classification for a DTM',
              },
            ],
          },
        ],
      },
      {
        // Same rules as clouds: every edit adds a derived mesh, never mutates one.
        label: 'Mesh',
        commands: [
          {
            id: 'menu-mesh',
            label: 'Mesh',
            icon: 'cube',
            menu: [
              { section: 'Clean' },
              {
                id: 'clean-mesh',
                label: 'Clean mesh…',
                icon: 'cube',
                needs: ['mesh'],
                blurb: 'Small pieces, long-edge bridges, holes (watertight)',
              },
              {
                id: 'smooth-mesh',
                label: 'Smooth…',
                icon: 'smooth',
                needs: ['mesh'],
                blurb: 'Taubin smoothing without shrinkage',
              },
              { section: 'Simplify' },
              {
                id: 'decimate-mesh',
                label: 'Decimate…',
                icon: 'decimate',
                needs: ['mesh'],
                blurb: 'Reduce to a target triangle count (quadric collapse)',
              },
              { section: 'Edit' },
              {
                id: 'crop-mesh',
                label: 'Crop…',
                icon: 'rect',
                needs: ['mesh'],
                blurb: 'Keep or remove an axis-aligned box',
              },
              { section: 'Convert' },
              {
                id: 'mesh-to-points',
                label: 'Sample to points…',
                icon: 'point-cloud',
                needs: ['mesh'],
                blurb: 'Uniform surface sampling into a dense cloud',
              },
              { section: 'Colour' },
              {
                id: 'texture-mesh',
                label: 'Texture…',
                icon: 'image',
                needs: ['mesh', 'sparse'],
                blurb: 'Photo texture from the registered cameras',
              },
            ],
          },
        ],
      },
      {
        label: 'Products',
        commands: [
          {
            id: 'menu-products',
            label: 'Products',
            icon: 'dem',
            menu: [
              { section: 'Terrain' },
              {
                id: 'dem-contours',
                label: 'Contours…',
                icon: 'contours',
                needs: ['dem'],
                aerialOnly: true,
                blurb: 'Contour lines from the DEM (GeoJSON / DXF)',
              },
              {
                id: 'dem-derivatives',
                label: 'Slope, aspect, hillshade…',
                icon: 'dem',
                needs: ['dem'],
                aerialOnly: true,
                blurb: 'Terrain derivative rasters as GeoTIFF',
              },
              { section: 'Export' },
              {
                id: 'clip-raster',
                label: 'Clip to polygon…',
                icon: 'clip',
                needs: ['products'],
                aerialOnly: true,
                blurb: 'Export a DEM/ortho clipped to a polygon',
              },
            ],
          },
        ],
      },
      {
        // Every measuring tool, whatever it measures. The rows are rebuilt with the
        // map's targets while the map is in front (Ribbon.vue → measureMenu).
        label: 'Measure',
        commands: [{ id: 'menu-measure', label: 'Measure', icon: 'ruler', menu: measureMenu() }],
      },
    ],
  },
  {
    // The Quality Report hub — one modal with an overview landing page + section tabs.
    // These buttons deep-link into it; the hub's own nav (with greyed prerequisites) is
    // the real discoverability surface, so a handful of entry points in workflow order
    // is enough.
    id: 'evaluate',
    label: 'Evaluate',
    groups: [
      // Grouped to mirror the Reconstruct tab's stages, so the same mental model
      // ("where in the pipeline am I?") carries across tabs.
      {
        label: 'Report',
        commands: [{ id: 'eval-overview', label: 'Quality\nReport', icon: 'report' }],
      },
      {
        label: 'Features',
        commands: [{ id: 'eval-match-graph', label: 'Matching', icon: 'link', needs: ['matches'] }],
      },
      {
        label: 'Sparse',
        commands: [
          { id: 'eval-reconstruction', label: 'Sparse\nModel', icon: 'sparse-model', needs: ['sparse'] },
          { id: 'eval-calibration', label: 'Calibration', icon: 'calibration', needs: ['sparse'] },
          { id: 'eval-gcps', label: 'Accuracy', icon: 'map-pin', needs: ['sparse'] },
          { id: 'eval-coverage', label: 'Coverage', icon: 'grid', needs: ['sparse'] },
        ],
      },
      {
        label: 'Dense',
        commands: [{ id: 'eval-depth-coverage', label: 'Depth\nCoverage', icon: 'depth', needs: ['depthMaps'] }],
      },
      {
        label: 'Products',
        commands: [
          // The computed DEM against an imported reference DEM (TODO.md ▸ A-6).
          {
            id: 'eval-dem-reference',
            label: 'DEM vs\nReference',
            icon: 'dem',
            needs: ['dem', 'referenceDem'],
            aerialOnly: true,
          },
        ],
      },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    groups: [
      // Keep the same data-oriented vocabulary and pipeline order as Import,
      // Reconstruct, and Evaluate. Interchange models are reconstruction data;
      // point clouds and meshes are geometry; DEM/ortho are mapping products.
      {
        label: 'Cameras',
        commands: [
          { id: 'export-cameras', label: 'Camera\nPoses', icon: 'camera-pose', needs: ['poses'] },
          { id: 'export-sensors', label: 'Calibration', icon: 'calibration', needs: ['sensors'] },
          { id: 'export-camera-fiducials', label: 'Camera\nFiducials', icon: 'camera', needs: ['fiducialMarks'] },
        ],
      },
      {
        label: 'Features',
        commands: [
          { id: 'export-image-fiducials', label: 'Image\nFiducials', icon: 'target', needs: ['fiducials'] },
          { id: 'export-keypoints', label: 'Key\npoints', icon: 'keypoints', needs: ['imagesReady', 'keypoints'] },
          { id: 'export-matches', label: 'Matches', icon: 'link', needs: ['matches'] },
        ],
      },
      {
        label: 'Reconstruction',
        commands: [{ id: 'export-model', label: 'Model\nJSON', icon: 'cube', needs: ['sparse'] }],
      },
      {
        label: 'Geometry',
        commands: [
          { id: 'export-cloud', label: 'Point\nCloud', icon: 'point-cloud', needs: ['cloud'] },
          { id: 'export-mesh', label: 'Mesh', icon: 'cube', needs: ['mesh'] },
        ],
      },
      {
        label: 'Products',
        commands: [
          EXPORT_DEM,
          EXPORT_ORTHO,
          // Saved ruler / area / profile / volume / 3D measurements as CSV or GeoJSON.
          { id: 'export-measurements', label: 'Measure-\nments…', icon: 'ruler', needs: ['measurements'] },
        ],
      },
      {
        label: 'Interoperability',
        commands: [
          { id: 'export-colmap', label: 'SfM\nProject…', icon: 'cube', needs: ['sparse'] },
          { id: 'export-undistorted', label: 'Undistorted\nImages…', icon: 'image', needs: ['sparse'] },
          { id: 'export-tiles3d', label: '3D Tiles…', icon: 'layers', needs: ['cloud'] },
        ],
      },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    groups: [
      {
        // Everything project-*scoped* (new / open / storage migration / delete)
        // lives behind the project button's picker, which is the project's one
        // home. The ribbon keeps only this: work is autosaved into invisible
        // browser storage, so writing a portable `.websfm` copy is a frequent,
        // verb-shaped action — and it is a *copy*, never "the save".
        label: 'Project',
        commands: [
          { id: 'open-project-settings', label: 'Project\nSettings', icon: 'settings', needs: ['project'] },
          { id: 'save-project-file', label: 'Save a\nCopy…', icon: 'save', needs: ['project'] },
        ],
      },
      {
        label: 'Panels',
        commands: [{ id: 'toggle-console', label: 'Console', icon: 'console', activeKey: 'consoleOpen' }],
      },
      {
        label: 'App',
        commands: [
          { id: 'open-glossary', label: 'Glossary', icon: 'book' },
          { id: 'open-guide', label: 'Guide', icon: 'book' },
          // Appearance lives in Settings ▸ Display (and the command palette's
          // `theme`) — deliberately not duplicated as a ribbon button.
          { id: 'open-settings', label: 'Settings', icon: 'settings' },
          { id: 'open-system-info', label: 'System info', icon: 'cpu' },
          { id: 'open-about', label: 'About', icon: 'info' },
        ],
      },
      {
        // A compact, classified reconstruction-health digest — copy-pasteable so a
        // run's outcome can be shared without the full (thousands-of-lines) log.
        label: 'Debug',
        commands: [{ id: 'open-debug-summary', label: 'Project\nSummary', icon: 'summary', needs: ['project'] }],
      },
    ],
  },
]

// ── View tab, contextual groups (the `dynamic` badge marks them) ─────────────────

export const CAMERA_GROUP = {
  label: 'Camera',
  dynamic: '3D',
  commands: [
    {
      pair: [
        { id: 'view-preset-top', label: 'Top', icon: 'view-top' },
        { id: 'view-preset-bottom', label: 'Bottom', icon: 'view-bottom' },
      ],
    },
    {
      pair: [
        { id: 'view-preset-left', label: 'Left', icon: 'view-left' },
        { id: 'view-preset-right', label: 'Right', icon: 'view-right' },
      ],
    },
    {
      pair: [
        { id: 'view-preset-front', label: 'Front', icon: 'view-front' },
        { id: 'view-preset-back', label: 'Back', icon: 'view-back' },
      ],
    },
    { id: 'reset-view', label: 'Reset\nView', icon: 'view-reset' },
    // The camera circles the scene; its toolbox holds the speed and the recording.
    { id: 'view-toggle-turntable', label: 'Turntable', icon: 'turntable', activeKey: 'turntable' },
  ],
}

// 3D scene display: toggles plus the two size steppers (persisted display values,
// useViewerSettings). Steppers are display settings, so they belong here.
export const SCENE_GROUP = {
  label: 'Scene',
  dynamic: '3D',
  commands: [
    { id: 'view-toggle-cameras', label: 'Cameras', icon: 'camera', activeKey: 'showCameras' },
    { id: 'view-toggle-grid', label: 'Grid', icon: 'grid', activeKey: 'showGrid' },
    { id: 'view-toggle-legend', label: 'Legend', icon: 'layers', activeKey: 'showLegend' },
    {
      pair: [
        {
          stepper: true,
          id: 'view-point-size',
          label: 'Points',
          icon: 'point-cloud',
          valueKey: 'pointSize',
          min: 1,
          max: 8,
          step: 1,
        },
        {
          stepper: true,
          id: 'view-camera-scale',
          label: 'Cameras',
          icon: 'camera',
          valueKey: 'cameraScale',
          min: 0.2,
          max: 3,
          step: 0.2,
          format: (v) => `${v.toFixed(1)}×`,
        },
      ],
    },
  ],
}

export const MAP_GROUP = {
  label: 'Map',
  dynamic: '2D',
  commands: [
    { id: 'map-fit-view', label: 'Fit\nView', icon: 'fit-view' },
    // The floating Layers panel: stack, show and fade the rasters on the map.
    { id: 'map-toggle-layers', label: 'Layers', icon: 'layers', activeKey: 'mapLayersPanel' },
    { id: 'map-toggle-grid', label: 'Grid', icon: 'grid', activeKey: 'showMapGrid' },
    { id: 'map-toggle-cameras', label: 'Cameras', icon: 'camera', activeKey: 'showMapCameras' },
    // Greyed (and never shown as on) until the project has a GCP or marker, as Footprints.
    { id: 'map-toggle-gcps', label: 'GCPs', icon: 'map-pin', activeKey: 'showMapGcps', needs: ['gcps'] },
    {
      id: 'map-toggle-footprints',
      label: 'Footprints',
      icon: 'footprint',
      activeKey: 'showFootprints',
      needs: ['footprints'],
    },
    // `map-basemap:<value>` rows pick the base layer (core/basemaps.js); App
    // dispatches the prefix. A layer the frame cannot show is greyed with its reason.
    {
      id: 'menu-basemap',
      label: 'Basemap',
      icon: 'layers',
      menu: BASEMAPS.map((b) => ({
        id: `map-basemap:${b.value}`,
        label: b.label,
        icon: b.icon,
        blurb: b.blurb,
        basemap: b.value,
      })),
    },
    // Project CRS ↔ the sparse model's local frame (composables/useMapProducts.js).
    {
      id: 'map-toggle-model-frame',
      label: 'Model\nFrame',
      icon: 'sparse-model',
      activeKey: 'mapModelFrame',
      needs: ['sparse'],
    },
  ],
}

// ── Contextual tabs ───────────────────────────────────────────────────────────

export const PICTURE_TAB = {
  id: 'picture',
  label: 'Picture',
  contextual: true,
  groups: [
    {
      label: 'Image',
      commands: [
        { id: 'img-show-info', label: 'Image\nInfo', icon: 'info' },
        { id: 'img-remove', label: 'Remove', icon: 'remove', danger: true },
      ],
    },
    {
      label: 'View',
      commands: [
        { id: 'img-fit', label: 'Fit\nView', icon: 'fit-view' },
        { id: 'img-zoom-in', label: 'Zoom\nIn', icon: 'zoom-in' },
        { id: 'img-zoom-out', label: 'Zoom\nOut', icon: 'zoom-out' },
      ],
    },
    {
      label: 'Toggles',
      commands: [
        {
          id: 'img-toggle-keypoints',
          labelFn: (s) => (s?.kpCount ? `KP\n${s.kpCount}` : 'Keypoints'),
          icon: 'keypoints',
          activeKey: 'showKeypoints',
          disableKey: 'kpNotDone',
        },
        { id: 'img-toggle-mask', label: 'Mask', icon: 'mask', activeKey: 'showMask', disableKey: 'noMask' },
        { id: 'img-toggle-depth', label: 'Depth', icon: 'depth', activeKey: 'showDepth', disableKey: 'noDepth' },
        { id: 'img-toggle-gcps', label: 'GCPs', icon: 'map-pin', activeKey: 'showGcps', disableKey: 'noGcps' },
        {
          id: 'img-toggle-residuals',
          label: 'Residuals',
          icon: 'target',
          activeKey: 'showResiduals',
          needs: ['sparse'],
        },
        { id: 'img-toggle-fiducials', label: 'Fiducials', icon: 'target', activeKey: 'showFiducials', filmOnly: true },
      ],
    },
    // Edit mask / Edit GCPs are tools: both in Tools ▸ Images ▾.
  ],
}

// The raster counterpart of PICTURE_TAB. Both provenances offer the same object
// actions in the same order — get a copy out, change how it looks, put it on the
// map, remove it — and differ only where the object does: a *computed* product
// can also be rebuilt, and exports through the Export tab's dialog; an *imported*
// reference raster downloads as the file it was (the pipeline never rebuilds
// one), and its Style… is band math (greyed when there is nothing to choose).
// The map toggle is one command; a product the map cannot place greys it with
// the reason. Same entries as the sidebar's right-click menus.
export function rasterTab(r) {
  const isOrtho = r?.kind === 'ortho'
  return {
    id: 'raster',
    label: isOrtho ? 'Orthophoto' : 'DEM',
    contextual: true,
    groups: [
      {
        label: 'View',
        commands: [
          { id: 'raster-fit', label: 'Fit\nView', icon: 'fit-view' },
          { id: 'raster-zoom-in', label: 'Zoom\nIn', icon: 'zoom-in' },
          { id: 'raster-zoom-out', label: 'Zoom\nOut', icon: 'zoom-out' },
        ],
      },
      r?.imported
        ? {
            label: 'Reference',
            commands: [
              { id: 'raster-download', label: 'Download', icon: 'download' },
              { id: 'raster-style', label: 'Style…', icon: 'settings' },
              { id: 'raster-toggle-map', label: 'On\nMap', icon: 'layers', activeKey: 'rasterVisible' },
              { id: 'raster-remove', label: 'Remove', icon: 'remove', danger: true },
            ],
          }
        : {
            label: isOrtho ? 'Orthophoto' : 'DEM',
            commands: [
              // The Reconstruct / Export commands themselves, relabelled.
              { ...(isOrtho ? GEN_ORTHO : GEN_DEM), label: 'Rebuild' },
              { ...(isOrtho ? EXPORT_ORTHO : EXPORT_DEM), label: 'Export', icon: 'download' },
              { id: 'raster-symbology', label: 'Symbology…', icon: 'settings' },
              { id: 'raster-toggle-map', label: 'On\nMap', icon: 'layers', activeKey: 'rasterVisible' },
              { id: 'raster-remove', label: 'Remove', icon: 'remove', danger: true },
            ],
          },
    ],
  }
}

/** Every leaf command in a list of groups (pairs and menus flattened). */
export function leafCommands(groups) {
  const out = []
  for (const g of groups) {
    for (const c of g.commands) {
      if (c.pair) out.push(...c.pair)
      else if (c.menu) out.push(...c.menu.filter((m) => !m.section))
      else out.push(c)
    }
  }
  return out
}

/** Every group of every tab, contextual ones included (for tests and lookups). */
export function allGroups() {
  return [
    ...TABS.flatMap((t) => t.groups),
    CAMERA_GROUP,
    SCENE_GROUP,
    MAP_GROUP,
    ...PICTURE_TAB.groups,
    ...rasterTab({ kind: 'dem', imported: true }).groups,
    ...rasterTab({ kind: 'ortho', imported: false }).groups,
    // The Measure menu as the map shows it, with its target rows.
    {
      label: 'Measure (map)',
      commands: [
        {
          id: 'menu-measure',
          label: 'Measure',
          icon: 'ruler',
          menu: measureMenu({ targets: [{ id: 'product:dem', name: 'DEM', kind: 'dem' }], targetId: 'product:dem' }),
        },
      ],
    },
  ]
}

/** A ribbon label as one line of text: 'Geo-\nreference' → 'Georeference'. */
export function labelText(cmd) {
  const label = cmd.label ?? cmd.labelFn?.(null) ?? cmd.id
  return label.replace(/-\n/g, '').replace(/\n/g, ' ')
}

/**
 * Every leaf command with where it lives, for the console's command list (core/help/
 * commands.js derives its verbs from this, so a new ribbon command is typeable without
 * a second table). → [{ cmd, tab, path }] in ribbon order, first occurrence of each id;
 * `path` is 'Tab ▸ Group' (▸ Menu for a menu row), the contextual groups under the
 * tab they appear in. Dynamic rows (`measure-target:` — the map's layers) are left out.
 */
export function ribbonEntries() {
  const sources = [
    ...TABS.map((t) => ({
      tab: t.label,
      groups: t.id === 'view' ? [...t.groups, CAMERA_GROUP, SCENE_GROUP, MAP_GROUP] : t.groups,
    })),
    { tab: PICTURE_TAB.label, groups: PICTURE_TAB.groups },
    { tab: 'DEM / Orthophoto', groups: rasterTab({ kind: 'dem', imported: false }).groups },
    { tab: 'Reference raster', groups: rasterTab({ kind: 'dem', imported: true }).groups },
  ]
  const out = [],
    seen = new Set()
  const add = (cmd, tab, path) => {
    if (!cmd.id || seen.has(cmd.id) || cmd.id.startsWith('measure-target:')) return
    seen.add(cmd.id)
    out.push({ cmd, tab, path })
  }
  for (const { tab, groups } of sources) {
    for (const g of groups) {
      for (const c of g.commands) {
        if (c.pair) for (const p of c.pair) add(p, tab, `${tab} ▸ ${g.label}`)
        else if (c.menu) {
          // 'Tools ▸ Mesh ▸ Mesh' reads as 'Tools ▸ Mesh' when the menu is its group.
          const menuPath = labelText(c) === g.label ? `${tab} ▸ ${g.label}` : `${tab} ▸ ${g.label} ▸ ${labelText(c)}`
          for (const m of c.menu) if (!m.section) add(m, tab, menuPath)
        } else add(c, tab, `${tab} ▸ ${g.label}`)
      }
    }
  }
  return out
}

/** A menu's own disabled reason: '' while any row is usable, else the first row's. */
export function menuReason(menu, rowReason) {
  const rows = menu.filter((m) => !m.section)
  let first = ''
  for (const row of rows) {
    const r = rowReason(row)
    if (!r) return ''
    if (!first) first = r
  }
  return first
}

/** Clamp + snap a stepper value; guards float drift (0.2 + 0.2 + 0.2 …). */
export function stepValue(cmd, current, dir) {
  const v = Number.isFinite(current) ? current : cmd.min
  const next = v + dir * cmd.step
  const snapped = Math.round(next / cmd.step) * cmd.step
  return Math.min(cmd.max, Math.max(cmd.min, Number(snapped.toFixed(6))))
}
