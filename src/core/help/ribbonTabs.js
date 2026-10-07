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

export const TABS = [
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Inspect',
        commands: [
          { id: 'open-image-table',  label: 'Images',  icon: 'table',   needs: ['images'] },
          { id: 'open-mask-manager', label: 'Masks',   icon: 'mask',    needs: ['images'] },
          { id: 'open-sensor-table', label: 'Sensors', icon: 'camera',  needs: ['sensors'] },
          { id: 'open-pose-table',   label: 'Camera\nPoses', icon: 'camera-pose', needs: ['poses'] },
          // The table edits existing points; one is born elsewhere (import, or a
          // right-click on the map / an image), so an empty project has nothing to show.
          // Deliberately NOT aerialOnly: it also holds markers (scale-bar endpoints),
          // which are an object-capture feature. Importing surveyed *ground control*
          // stays aerial-only — that command is in the Import tab, not this one.
          { id: 'open-gcp-table',    label: 'Control &\nMarkers', icon: 'map-pin', needs: ['gcps'] },
          { id: 'open-match-list',   label: 'Matches', icon: 'list',    needs: ['matches'] },
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
        ],
      },
      {
        label: 'Cameras',
        commands: [
          { id: 'import-camera-list', label: 'Camera\nPoses', icon: 'camera-pose' },
          { id: 'import-calib', label: 'Calibration', icon: 'calibration' },
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
        commands: [
          { id: 'import-colmap', label: 'SfM\nProject…', icon: 'cube' },
        ],
      },
    ],
  },
  {
    id: 'reconstruct',
    label: 'Reconstruct',
    groups: [
      {
        label: 'Workflow',
        commands: [
          { id: 'workflow-builder', label: 'Workflow\nBuilder', icon: 'list', needs: ['project'] },
        ],
      },
      {
        label: 'Features',
        commands: [
          { id: 'detect-features', label: 'Detect\nFeatures', icon: 'sparkles', needs: ['images', 'imagesReady'] },
          { id: 'match-features', label: 'Match\nFeatures', icon: 'link', needs: ['imagesReady', 'keypoints'] },
        ],
      },
      // The groups are pipeline *stages*, in order: features → sparse → dense →
      // deliverables. Dense stays a reconstruction stage rather than a product: it is
      // still the scene geometry, and DEM/Ortho/Mesh are all derived *from* it.
      {
        label: 'Sparse',
        commands: [
          { id: 'reconstruct',   label: 'Sparse\nModel', icon: 'sparse-model', needs: ['imagesReady', 'matches'] },
        ],
      },
      {
        label: 'Dense',
        commands: [
          { id: 'compute-depth', label: 'Depth\nMaps',   icon: 'depth',       needs: ['imagesReady', 'sparse'] },
          { id: 'dense',         label: 'Dense\nModel',  icon: 'point-cloud', needs: ['depthMaps'] },
        ],
      },
      {
        label: 'Products',
        commands: [
          { id: 'gen-dem',       label: 'DEM',     icon: 'dem',   needs: ['cloud'], aerialOnly: true },
          { id: 'gen-ortho',     label: 'Ortho',   icon: 'ortho', needs: ['imagesReady', 'depthMaps', 'surface'], aerialOnly: true },
          { id: 'gen-mesh',      label: 'Mesh',    icon: 'cube',  needs: ['dense'] },
        ],
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    groups: [
      // One dropdown per OBJECT FAMILY, ordered the way the data flows: images →
      // model → georeferencing → cloud → mesh → raster products. A new tool is one
      // more menu row, never one more ribbon button, so this tab keeps its width.
      {
        label: 'Images',
        commands: [
          { id: 'menu-images', label: 'Images', icon: 'image', menu: [
            { section: 'Prepare' },
            { id: 'image-quality', label: 'Image quality…', icon: 'quality', needs: ['images', 'imagesReady'],
              blurb: 'Score sharpness and exposure; exclude blurry images' },
            { id: 'auto-mask', label: 'Auto mask…', icon: 'mask', needs: ['images', 'imagesReady'],
              blurb: 'Mask sky, people or background automatically' },
            { section: 'Film scans' },
            { id: 'detect-fiducials', label: 'Detect fiducials…', icon: 'target', needs: ['filmSensor', 'imagesReady'],
              blurb: 'Find the fiducial marks on scanned film frames' },
            { id: 'calibrate-fiducials', label: 'Calibrate fiducials…', icon: 'calibration', needs: ['filmSensor'],
              blurb: 'Camera-certificate or batch-estimated fiducial layout' },
          ] },
        ],
      },
      {
        label: 'Model',
        commands: [
          { id: 'menu-model', label: 'Model', icon: 'sparse-model', menu: [
            { section: 'Refine' },
            { id: 'optimize-cameras', label: 'Optimize cameras…', icon: 'calibration', needs: ['sparse'],
              blurb: 'Re-run bundle adjustment with chosen lens parameters' },
            { id: 'gradual-selection', label: 'Gradual selection…', icon: 'sparse-model', needs: ['sparse'],
              blurb: 'Remove weak tie points by error, views or angle' },
            { section: 'Frame' },
            { id: 'set-region', label: 'Region…', icon: 'region', needs: ['sparse'],
              blurb: 'A box that limits depth maps, fusion, mesh and DEM' },
            { id: 'orient-model', label: 'Orient model…', icon: 'level', needs: ['sparse'],
              blurb: 'Level the model and set its origin (projects without CRS)' },
            { section: 'Cameras' },
            { id: 'footprints-from-poses', label: 'Footprints from poses…', icon: 'footprint', needs: ['poses', 'sensors'], aerialOnly: true,
              blurb: 'Project image outlines onto the ground' },
          ] },
        ],
      },
      {
        // No "Project CRS" entry here: CRS is project *configuration*, set from the
        // Settings modal (App.vue `handleSetCrs`), not a tool that transforms data.
        // Plain buttons, not a menu: this is a pipeline step done once per project,
        // and the step a new user most needs to find.
        label: 'Georeferencing',
        commands: [
          { id: 'find-gcps',      label: 'Find\nGCPs',      icon: 'map-pin', needs: ['sparse'], aerialOnly: true },
          // One entry point for both GCP-constrained adjustment + final similarity fit
          // and the cheap transform-only path. The modal explains/validates each mode.
          { id: 'georeference',   label: 'Geo-\nreference', icon: 'target',  needs: ['sparse'], aerialOnly: true },
          // Same job as Georeference — fixing the datum — for a project that has no
          // CRS at all. Deliberately NOT aerialOnly: scale bars are the object-capture
          // way to get metres, and an object project is exactly where there is no
          // georeference to supply one.
          { id: 'scale-bars',     label: 'Scale\nBars',     icon: 'ruler',   needs: ['sparse'] },
        ],
      },
      {
        // These edit **dense** clouds (computed or imported) and always produce a
        // new cloud — the source is never modified. A sparse cloud is deliberately
        // not editable: its points carry the view-tracks dense/ortho/COLMAP read.
        label: 'Point Cloud',
        commands: [
          { id: 'menu-cloud', label: 'Point\nCloud', icon: 'point-cloud', menu: [
            { section: 'Clean' },
            { id: 'filter-cloud', label: 'Filter…', icon: 'point-cloud', needs: ['dense'],
              blurb: 'Height/brightness range, voxel, isolated points, outliers' },
            { id: 'cloud-outliers', label: 'Remove outliers…', icon: 'point-cloud', needs: ['dense'],
              blurb: 'Statistical outlier removal' },
            { id: 'cloud-subsample', label: 'Subsample…', icon: 'grid', needs: ['dense'],
              blurb: 'Thin to one point per voxel' },
            { section: 'Edit' },
            { id: 'select-points', label: 'Select points', icon: 'lasso', needs: ['dense'],
              blurb: 'Lasso or rectangle in the 3D view, then delete or keep' },
            { id: 'crop-cloud', label: 'Crop…', icon: 'rect', needs: ['dense'],
              blurb: 'Keep or remove an axis-aligned box' },
            { id: 'transform-cloud', label: 'Transform…', icon: 'transform', needs: ['dense'],
              blurb: 'Move, rotate, scale, or apply a 4×4 matrix' },
            { section: 'Combine' },
            { id: 'merge-clouds', label: 'Merge…', icon: 'link', needs: ['twoClouds'],
              blurb: 'Concatenate clouds with an optional seam dedupe' },
            { id: 'align-points', label: 'Align by point pairs…', icon: 'align', needs: ['dense'],
              blurb: 'Pick ≥3 matching points in both clouds' },
            { id: 'align-icp', label: 'Align to reference (ICP)…', icon: 'align', needs: ['dense'],
              blurb: 'Refine an approximate alignment automatically' },
            { section: 'Analyse' },
            { id: 'cloud-distance', label: 'Distance to reference…', icon: 'distance', needs: ['dense'],
              blurb: 'Per-point distance to another cloud or a mesh (change detection)' },
            { id: 'cloud-section', label: 'Section…', icon: 'section', needs: ['dense'],
              blurb: 'Cut a thin slice and export it as a 2D profile' },
            { section: 'Attributes' },
            { id: 'estimate-normals', label: 'Estimate normals…', icon: 'normals', needs: ['dense'],
              blurb: 'Per-point normals, e.g. to mesh an imported cloud' },
            // TODO.md ▸ F14.
            { id: 'classify-ground', label: 'Classify ground…', icon: 'dem', disabled: true,
              blurb: 'Bare-earth classification for a DTM' },
          ] },
        ],
      },
      {
        // Same rules as clouds: every edit adds a derived mesh, never mutates one.
        label: 'Mesh',
        commands: [
          { id: 'menu-mesh', label: 'Mesh', icon: 'cube', menu: [
            { section: 'Clean' },
            { id: 'clean-mesh', label: 'Clean mesh…', icon: 'cube', needs: ['mesh'],
              blurb: 'Small pieces, long-edge bridges, holes (watertight)' },
            { id: 'smooth-mesh', label: 'Smooth…', icon: 'smooth', needs: ['mesh'],
              blurb: 'Taubin smoothing without shrinkage' },
            { section: 'Simplify' },
            { id: 'decimate-mesh', label: 'Decimate…', icon: 'decimate', needs: ['mesh'],
              blurb: 'Reduce to a target triangle count (quadric collapse)' },
            { section: 'Edit' },
            { id: 'crop-mesh', label: 'Crop…', icon: 'rect', needs: ['mesh'],
              blurb: 'Keep or remove an axis-aligned box' },
            { section: 'Convert' },
            { id: 'mesh-to-points', label: 'Sample to points…', icon: 'point-cloud', needs: ['mesh'],
              blurb: 'Uniform surface sampling into a dense cloud' },
            { section: 'Analyse' },
            { id: 'mesh-measure', label: 'Area & volume…', icon: 'volume', needs: ['mesh'],
              blurb: 'Surface area; enclosed volume when watertight' },
            { section: 'Colour' },
            // TODO.md ▸ Remaining interoperability ▸ Mesh texturing.
            { id: 'texture-mesh', label: 'Texture…', icon: 'image', disabled: true,
              blurb: 'UV atlas + image texture' },
          ] },
        ],
      },
      {
        label: 'Products',
        commands: [
          { id: 'menu-products', label: 'Products', icon: 'dem', menu: [
            { section: 'Terrain' },
            { id: 'dem-contours', label: 'Contours…', icon: 'contours', needs: ['dem'], aerialOnly: true,
              blurb: 'Contour lines from the DEM (GeoJSON / DXF)' },
            { id: 'dem-derivatives', label: 'Slope, aspect, hillshade…', icon: 'dem', needs: ['dem'], aerialOnly: true,
              blurb: 'Terrain derivative rasters as GeoTIFF' },
            // TODO.md ▸ F11 (DEM-of-difference volume).
            { id: 'dem-difference', label: 'DEM of difference…', icon: 'volume', disabled: true,
              blurb: 'Change between the DEM and a reference DEM' },
            { section: 'Export' },
            { id: 'clip-raster', label: 'Clip to polygon…', icon: 'clip', needs: ['products'], aerialOnly: true,
              blurb: 'Export a DEM/ortho clipped to a polygon' },
          ] },
        ],
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
        commands: [
          { id: 'eval-overview', label: 'Quality\nReport', icon: 'report' },
        ],
      },
      {
        label: 'Features',
        commands: [
          { id: 'eval-match-graph', label: 'Matching', icon: 'link', needs: ['matches'] },
        ],
      },
      {
        label: 'Sparse',
        commands: [
          { id: 'eval-reconstruction', label: 'Sparse\nModel',  icon: 'sparse-model', needs: ['sparse'] },
          { id: 'eval-calibration',    label: 'Calibration',    icon: 'calibration',  needs: ['sparse'] },
          { id: 'eval-gcps',           label: 'Accuracy',       icon: 'map-pin',      needs: ['sparse'] },
          { id: 'eval-coverage',       label: 'Coverage',       icon: 'grid',         needs: ['sparse'] },
        ],
      },
      {
        label: 'Dense',
        commands: [
          { id: 'eval-depth-coverage', label: 'Depth\nCoverage', icon: 'depth', needs: ['depthMaps'] },
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
          { id: 'export-sensors', label: 'Calibration',   icon: 'calibration', needs: ['sensors'] },
        ],
      },
      {
        label: 'Features',
        commands: [
          { id: 'export-keypoints', label: 'Key\npoints', icon: 'keypoints', needs: ['imagesReady', 'keypoints'] },
          { id: 'export-matches',   label: 'Matches',     icon: 'link',      needs: ['matches'] },
        ],
      },
      {
        label: 'Reconstruction',
        commands: [
          { id: 'export-model',  label: 'Model\nJSON',   icon: 'cube', needs: ['sparse'] },
        ],
      },
      {
        label: 'Geometry',
        commands: [
          { id: 'export-cloud', label: 'Point\nCloud', icon: 'point-cloud', needs: ['cloud'] },
          { id: 'export-mesh',  label: 'Mesh',         icon: 'cube',        needs: ['mesh'] },
        ],
      },
      {
        label: 'Products',
        commands: [
          { id: 'export-dem',   label: 'DEM',   icon: 'dem',   needs: ['dem'], aerialOnly: true },
          { id: 'export-ortho', label: 'Ortho', icon: 'ortho', needs: ['ortho'], aerialOnly: true },
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
        commands: [
          { id: 'toggle-console', label: 'Console', icon: 'console', activeKey: 'consoleOpen' },
        ],
      },
      {
        label: 'App',
        commands: [
          { id: 'open-glossary', label: 'Glossary', icon: 'book' },
          { id: 'open-guide',    label: 'Guide',    icon: 'book' },
          // Appearance lives in Settings ▸ Display (and the command palette's
          // `theme`) — deliberately not duplicated as a ribbon button.
          { id: 'open-settings',    label: 'Settings',    icon: 'settings' },
          { id: 'open-system-info', label: 'System info', icon: 'cpu' },
          { id: 'open-about',       label: 'About',       icon: 'info' },
        ],
      },
      {
        // A compact, classified reconstruction-health digest — copy-pasteable so a
        // run's outcome can be shared without the full (thousands-of-lines) log.
        label: 'Debug',
        commands: [
          { id: 'open-debug-summary', label: 'Project\nSummary', icon: 'summary', needs: ['project'] },
        ],
      },
    ],
  },
]

// ── View tab, contextual groups (the `dynamic` badge marks them) ─────────────────

export const CAMERA_GROUP = {
  label: 'Camera',
  dynamic: '3D',
  commands: [
    { pair: [
      { id: 'view-preset-top',    label: 'Top',    icon: 'view-top' },
      { id: 'view-preset-bottom', label: 'Bottom', icon: 'view-bottom' },
    ] },
    { pair: [
      { id: 'view-preset-left',  label: 'Left',  icon: 'view-left' },
      { id: 'view-preset-right', label: 'Right', icon: 'view-right' },
    ] },
    { pair: [
      { id: 'view-preset-front', label: 'Front', icon: 'view-front' },
      { id: 'view-preset-back',  label: 'Back',  icon: 'view-back' },
    ] },
    { id: 'reset-view', label: 'Reset\nView', icon: 'view-reset' },
  ],
}

// 3D scene display: toggles plus the two size steppers (persisted display values,
// useViewerSettings). Steppers are display settings, so they belong here.
export const SCENE_GROUP = {
  label: 'Scene',
  dynamic: '3D',
  commands: [
    { id: 'view-toggle-cameras', label: 'Cameras', icon: 'camera', activeKey: 'showCameras' },
    { id: 'view-toggle-grid',    label: 'Grid',    icon: 'grid',   activeKey: 'showGrid' },
    { id: 'view-toggle-legend',  label: 'Legend',  icon: 'layers', activeKey: 'showLegend' },
    { pair: [
      { stepper: true, id: 'view-point-size',   label: 'Points',  icon: 'point-cloud', valueKey: 'pointSize',   min: 1,   max: 8, step: 1 },
      { stepper: true, id: 'view-camera-scale', label: 'Cameras', icon: 'camera',      valueKey: 'cameraScale', min: 0.2, max: 3, step: 0.2,
        format: (v) => `${v.toFixed(1)}×` },
    ] },
  ],
}

// Choosing a selection tool is a mode; what you do with the selection (count,
// Delete / Keep only / Clear) is the tool's floating toolbox in the 3D view.
export const SELECT_GROUP = {
  label: 'Select',
  dynamic: '3D',
  commands: [
    { pair: [
      { id: 'view-select-rect',  label: 'Rectangle', icon: 'rect',  activeKey: 'selectRect',  needs: ['dense'] },
      { id: 'view-select-lasso', label: 'Lasso',     icon: 'lasso', activeKey: 'selectLasso', needs: ['dense'] },
    ] },
  ],
}

export const MAP_GROUP = {
  label: 'Map',
  dynamic: '2D',
  commands: [
    { id: 'map-fit-view',          label: 'Fit\nView',   icon: 'fit-view' },
    { id: 'map-toggle-grid',       label: 'Grid',        icon: 'grid',      activeKey: 'showMapGrid' },
    { id: 'map-toggle-footprints', label: 'Footprints',  icon: 'footprint', activeKey: 'showFootprints', needs: ['footprints'] },
    { id: 'map-toggle-poses',      label: 'Poses',       icon: 'camera',    disabled: true },
    // Enters the mode; the floating "Points" toolbox on the map does the editing.
    { id: 'map-gcp-edit',          label: 'Edit\nGCPs',  icon: 'map-pin',   activeKey: 'mapGcpEdit' },
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
        { id: 'img-remove',    label: 'Remove',      icon: 'remove', danger: true },
      ],
    },
    {
      label: 'View',
      commands: [
        { id: 'img-fit',      label: 'Fit\nView', icon: 'fit-view' },
        { id: 'img-zoom-in',  label: 'Zoom\nIn',  icon: 'zoom-in' },
        { id: 'img-zoom-out', label: 'Zoom\nOut', icon: 'zoom-out' },
      ],
    },
    {
      label: 'Toggles',
      commands: [
        {
          id: 'img-toggle-keypoints',
          labelFn: (s) => s?.kpCount ? `KP\n${s.kpCount}` : 'Keypoints',
          icon: 'keypoints',
          activeKey: 'showKeypoints',
          disableKey: 'kpNotDone',
        },
        { id: 'img-toggle-mask',  label: 'Mask',  icon: 'mask',    activeKey: 'showMask',  disableKey: 'noMask' },
        { id: 'img-toggle-depth', label: 'Depth', icon: 'depth',   activeKey: 'showDepth', disableKey: 'noDepth' },
        { id: 'img-toggle-gcps',  label: 'GCPs',  icon: 'map-pin', activeKey: 'showGcps',  disableKey: 'noGcps' },
        { id: 'img-toggle-residuals', label: 'Residuals', icon: 'target', activeKey: 'showResiduals', needs: ['sparse'] },
        { id: 'img-toggle-fiducials', label: 'Fiducials', icon: 'target', activeKey: 'showFiducials', filmOnly: true },
      ],
    },
    {
      label: 'Mask',
      // One toggle — the tools themselves (brush/eraser/rect/invert/undo/…)
      // live in the floating MaskToolbar over the image view.
      commands: [
        { id: 'img-mask-edit', label: 'Edit\nMask', icon: 'pencil', activeKey: 'maskEdit' },
      ],
    },
    {
      label: 'GCPs',
      // One toggle — in GCP-edit mode a click on the image adds a new GCP (or marks
      // the sidebar-selected one). The floating GcpToolbar sits over the image view.
      commands: [
        { id: 'img-gcp-edit', label: 'Edit\nGCPs', icon: 'map-pin', activeKey: 'gcpEdit' },
      ],
    },
  ],
}

// The raster counterpart of PICTURE_TAB. Its last group depends on provenance:
// a *computed* product can be rebuilt and exported, an *imported* reference
// raster can be restyled, drawn on the map, or removed — the pipeline never
// rebuilds one.
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
          { id: 'raster-fit',      label: 'Fit\nView', icon: 'fit-view' },
          { id: 'raster-zoom-in',  label: 'Zoom\nIn',  icon: 'zoom-in' },
          { id: 'raster-zoom-out', label: 'Zoom\nOut', icon: 'zoom-out' },
        ],
      },
      {
        // Tools draw in the raster view; the drawing bar + result card live in
        // RasterMeasurements. Height tools need DEM samples, so an orthophoto
        // hides them rather than greying them (not applicable, not "not yet").
        label: 'Measure',
        commands: [
          { id: 'measure-length',  label: 'Ruler',   icon: 'ruler',   measureTool: 'length' },
          { id: 'measure-area',    label: 'Area',    icon: 'area',    measureTool: 'area' },
          { id: 'measure-profile', label: 'Profile', icon: 'profile', measureTool: 'profile', demOnly: true },
          { id: 'measure-volume',  label: 'Volume',  icon: 'volume',  measureTool: 'volume',  demOnly: true },
          { id: 'measure-saved',   label: 'Saved',   icon: 'list',    activeKey: 'measureSaved', needsSavedMeasurements: true },
        ],
      },
      r?.imported
        ? {
            label: 'Reference',
            commands: [
              { id: 'raster-style',      label: 'Style…',  icon: 'settings' },
              { id: 'raster-toggle-map', label: 'On\nMap', icon: 'layers', activeKey: 'rasterOnMap' },
              { id: 'raster-remove',     label: 'Remove',  icon: 'remove', danger: true },
            ],
          }
        : {
            label: isOrtho ? 'Orthophoto' : 'DEM',
            commands: [
              isOrtho
                ? { id: 'gen-ortho', label: 'Rebuild', icon: 'ortho', needs: ['depthMaps', 'surface'] }
                : { id: 'gen-dem',   label: 'Rebuild', icon: 'dem',   needs: ['cloud'] },
              { id: isOrtho ? 'export-ortho' : 'export-dem', label: 'Export',  icon: 'download' },
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
    CAMERA_GROUP, SCENE_GROUP, SELECT_GROUP, MAP_GROUP,
    ...PICTURE_TAB.groups,
    ...rasterTab({ kind: 'dem', imported: true }).groups,
    ...rasterTab({ kind: 'ortho', imported: false }).groups,
  ]
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
