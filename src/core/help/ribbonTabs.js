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
//   { id, label, icon, guide?, needs?: [...NEED_CHECKS keys], aerialOnly?, disabled?, activeKey? }
//                                        `guide` is the id of the src/guide/ article that
//                                        explains it (docs/features.md links it; a test
//                                        checks it resolves and links every article).
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
// measuring, region, orient…) lives in the Tools tab, in its object family's menu,
// which holds the tools that act on many objects at once. Two modes live elsewhere:
// one that edits the object in front lives on that object's contextual tab (Edit Mask
// on Picture), and one that is a step of a pipeline stage lives in that stage's group
// (Edit GCPs in Reconstruct ▸ Georeferencing, also offered as the same object on the
// Picture tab and an imported raster's tab). Otherwise the View tab and the
// contextual tabs only show and arrange: camera presets, toggles, fit/zoom, styling,
// on-map, remove. A command that does appear twice (Rebuild / Export on a raster
// tab) is the SAME object below, so its prerequisites cannot drift.

import { BASEMAPS } from '../basemaps.js'

// One mode for the view in front: on an image a click marks a GCP (the floating
// GcpToolbar), on the map or a reference raster it places/moves surveyed points. Its
// home is Reconstruct ▸ Georeferencing; the Picture tab and an imported raster's tab
// offer the same object (relabelled for a large button), as the object in front.
const EDIT_GCPS = {
  id: 'edit-gcps',
  guide: 'georeferencing',
  tip: 'Mark GCPs on the photo in front, or place them on the map or a reference raster',
  label: 'Edit GCPs',
  icon: 'map-pin',
  activeKey: 'gcpEdit',
  needs: ['gcpView'],
}
const EDIT_GCPS_TAB = { ...EDIT_GCPS, label: 'Edit\nGCPs', labelId: 'edit-gcps-tab' }

// Shared between Reconstruct/Export and the raster tab's object actions.
const GEN_DEM = {
  id: 'gen-dem',
  guide: 'dem',
  tip: 'Grid a point cloud into an elevation model: surface (DSM) or bare earth (DTM)',
  label: 'DEM',
  icon: 'dem',
  needs: ['cloud'],
  aerialOnly: true,
}
const GEN_ORTHO = {
  id: 'gen-ortho',
  guide: 'orthophoto',
  tip: 'Project the photos onto a DEM or mesh into one orthophoto',
  label: 'Ortho',
  icon: 'ortho',
  needs: ['imagesReady', 'depthMaps', 'surface'],
  aerialOnly: true,
}
// A multispectral camera's bands on the DEM (stores/reconstruction/reflectanceRun.js).
const GEN_REFLECTANCE = {
  id: 'gen-reflectance',
  guide: 'reflectance-map',
  tip: "Calibrated reflectance maps from a multispectral camera's bands",
  label: 'Reflect-\nance',
  icon: 'layers',
  needs: ['imagesReady', 'sparse', 'dem', 'bands'],
  aerialOnly: true,
}
const EXPORT_DEM = {
  id: 'export-dem',
  guide: 'dem',
  tip: 'A DEM as GeoTIFF, Cloud-Optimized GeoTIFF, ESRI ASCII grid or hillshade PNG',
  label: 'DEM',
  icon: 'dem',
  needs: ['dem'],
  aerialOnly: true,
}
const EXPORT_ORTHO = {
  id: 'export-ortho',
  guide: 'orthophoto',
  tip: 'An orthophoto as GeoTIFF, Cloud-Optimized GeoTIFF, PNG or JPEG, MBTiles or XYZ tiles',
  label: 'Ortho',
  icon: 'ortho',
  needs: ['ortho'],
  aerialOnly: true,
}

// Tools ▸ Measure ▾. Raster tools run on the raster in front: a DEM/Orthophoto
// tab, or one of the 2D map's rasters or the map itself (Ruler and Area on the
// ellipsoid), which the measuring window's Layer field picks (RasterMeasurements.vue);
// profile and volume take the map's DEM. The menu itself
// stays the same whatever is loaded.
export function measureMenu() {
  return [
    { section: 'Map, DEM or orthophoto in front' },
    {
      id: 'measure-length',
      guide: 'dem',
      label: 'Ruler',
      icon: 'ruler',
      measureTool: 'length',
      needs: ['measureHost'],
      blurb: 'Ground distance along a polyline',
    },
    {
      id: 'measure-area',
      guide: 'dem',
      label: 'Area',
      icon: 'area',
      measureTool: 'area',
      needs: ['measureHost'],
      blurb: 'Planimetric area and perimeter of a polygon',
    },
    {
      id: 'measure-profile',
      guide: 'dem',
      label: 'Profile',
      icon: 'profile',
      measureTool: 'profile',
      demOnly: true,
      needs: ['measureHost'],
      blurb: 'Elevation profile along a line (DEM)',
    },
    {
      id: 'measure-volume',
      guide: 'dem',
      label: 'Volume',
      icon: 'volume',
      measureTool: 'volume',
      demOnly: true,
      needs: ['measureHost'],
      blurb: 'Cut / fill against a base surface (DEM)',
    },
    {
      id: 'measure-saved',
      guide: 'dem',
      label: 'Saved measurements',
      icon: 'list',
      activeKey: 'measureSaved',
      needsSavedMeasurements: true,
      needs: ['measureHost'],
      blurb: 'Show, reopen and export saved results',
    },
    { section: 'Clouds & meshes' },
    {
      id: 'measure-3d',
      guide: 'point-cloud-tools',
      label: 'Measure in 3D',
      icon: 'ruler',
      needs: ['cloud'],
      blurb: 'Distance, height and surface area picked on clouds and meshes',
    },
    {
      id: 'cloud-distance',
      guide: 'cloud-distance',
      label: 'Distance to reference…',
      icon: 'distance',
      needs: ['dense'],
      blurb: 'Per-point distance to another cloud or a mesh (change detection)',
    },
    {
      id: 'cloud-section',
      guide: 'point-cloud-tools',
      label: 'Section…',
      icon: 'section',
      needs: ['dense'],
      blurb: 'Cut a thin slice and export it as a 2D profile',
    },
    {
      id: 'mesh-measure',
      guide: 'mesh',
      label: 'Mesh area & volume…',
      icon: 'volume',
      needs: ['mesh'],
      blurb: 'Surface area; enclosed volume when watertight',
    },
    { section: 'Change' },
    {
      id: 'dem-difference',
      guide: 'dem',
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
          {
            id: 'open-image-table',
            tip: "Each photo's EXIF, camera and pose, as read and as estimated",
            label: 'Images',
            icon: 'table',
            needs: ['images'],
          },
          {
            id: 'open-mask-manager',
            tip: "Each photo's mask; import masks one by one or a folder at once",
            label: 'Masks',
            icon: 'mask',
            needs: ['images'],
          },
          {
            id: 'open-sensor-table',
            guide: 'camera-groups',
            tip: 'The cameras and their calibration; split a group that holds several cameras',
            label: 'Sensors',
            icon: 'camera',
            needs: ['sensors'],
          },
          {
            id: 'open-pose-table',
            tip: "Each photo's camera position and orientation, imported or estimated",
            label: 'Camera\nPoses',
            icon: 'camera-pose',
            needs: ['poses'],
          },
          // The table edits existing points; one is born elsewhere (import, or a
          // right-click on the map / an image), so an empty project has nothing to show.
          // Deliberately NOT aerialOnly: it also holds markers (scale-bar endpoints),
          // which are an object-capture feature. Importing surveyed *ground control*
          // stays aerial-only — that command is in the Import tab, not this one.
          {
            id: 'open-gcp-table',
            tip: 'GCPs, checkpoints and markers: their coordinates, marks and residuals',
            label: 'Control &\nMarkers',
            icon: 'map-pin',
            needs: ['gcps'],
          },
          {
            id: 'open-match-list',
            tip: 'Every image pair and its matches; leave a pair out of the reconstruction',
            label: 'Matches',
            icon: 'list',
            needs: ['matches'],
          },
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
          {
            id: 'import-images',
            guide: 'getting-started',
            tip: 'Add photos to the project',
            label: 'Images',
            icon: 'image',
          },
          // Frames of a video become images (keyframes by motion and sharpness, or a
          // fixed interval) — the dialog plans them before anything is written.
          {
            id: 'import-video',
            guide: 'video-import',
            tip: 'Turn a video into sharp, overlapping frames that reconstruct like photos',
            label: 'Video',
            icon: 'video',
          },
        ],
      },
      {
        label: 'Cameras',
        commands: [
          {
            id: 'import-camera-list',
            guide: 'export-camera-poses',
            tip: 'Camera positions and orientations (GNSS, RTK or another tool) from a CSV or text file',
            label: 'Camera\nPoses',
            icon: 'camera-pose',
          },
          // Intrinsics per sensor or per image; updates matching sensors (by label,
          // the images' sensor, or the only one) or adds new ones — the dialog shows which.
          {
            id: 'import-calib',
            guide: 'export-calibration',
            tip: 'Camera calibration from a CSV or text file, as Export ▸ Calibration writes it',
            label: 'Calibration',
            icon: 'calibration',
          },
          // A film camera's certificate marks (mm); rows match sensors by label.
          {
            id: 'import-camera-fiducials',
            guide: 'film-fiducials',
            tip: "A film camera's calibrated fiducial positions, from its calibration certificate",
            label: 'Camera\nFiducials',
            icon: 'camera',
            needs: ['sensors'],
          },
        ],
      },
      // What was measured in the photos, as Export ▸ Features writes it.
      {
        label: 'Features',
        commands: [
          // Scan-pixel mark positions per image (a row per mark, or a row per image
          // with x/y columns per position); rows match images by name, so
          // (unlike GCPs) the images must be there first.
          {
            id: 'import-image-fiducials',
            guide: 'film-fiducials',
            tip: 'Fiducial marks measured on each film scan, from a CSV or text file',
            label: 'Image\nFiducials',
            icon: 'target',
            needs: ['images'],
          },
          // Plain text or CSV from another detector or matcher (core/io/featureText.js).
          // Both open the one dialog, which takes keypoint and match files together.
          {
            id: 'import-keypoints',
            guide: 'import-features',
            label: 'Key-\npoints',
            icon: 'keypoints',
            needs: ['images'],
            tip: "Keypoints from text or CSV files: another detector's, or the CSV this project's export writes",
          },
          {
            id: 'import-matches',
            guide: 'import-features',
            label: 'Matches',
            icon: 'link',
            needs: ['images'],
            tip: "Matches from text or CSV files: another matcher's, or the CSV this project's export writes",
          },
        ],
      },
      {
        label: 'Ground Control',
        commands: [
          // GCP coordinates and filename-keyed observations are project data. They
          // can be imported before images and reconcile automatically as images arrive.
          {
            id: 'import-gcps',
            guide: 'georeferencing',
            tip: 'Ground control points and their coordinates, from a CSV or text file',
            label: 'GCP\nFile',
            icon: 'map-pin',
            aerialOnly: true,
          },
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
          {
            id: 'import-raster',
            guide: 'coregister-dem',
            tip: 'A DEM or orthophoto to compare with, find GCPs in, or co-register to',
            label: 'Reference\nDEM / Ortho',
            icon: 'layers',
          },
          {
            id: 'import-cloud',
            guide: 'cloud-distance',
            tip: 'A point cloud or mesh from another tool, to edit, mesh, compare or align with',
            label: 'Point Cloud\n/ Mesh',
            icon: 'point-cloud',
          },
        ],
      },
      {
        label: 'Interoperability',
        commands: [
          // Another WebSfM project's photos, features and matches, into this one
          // (composables/useProjectMerge.js); then Add to the model joins them.
          {
            id: 'import-project',
            guide: 'import-project',
            label: 'WebSfM\nProject',
            icon: 'folder',
            needs: ['project'],
            tip: "Another WebSfM project's photos, features and matches, into this one",
          },
          // One button for every SfM tool, as Export ▸ SfM Project: its dialog
          // (InteropSourceModal.vue) starts with the format, COLMAP, Metashape or Other
          // SfM (Bundler, NVM, OpenMVG, OpenSfM, transforms.json; core/io/sfmInterop.js),
          // then shows what the files hold and asks what of it to bring in.
          {
            id: 'import-sfm',
            guide: 'import-sfm',
            label: 'SfM\nProject',
            icon: 'cube',
            tip: 'Cameras, keypoints, matches and the sparse model from COLMAP, Metashape, Bundler, VisualSFM, OpenMVG, OpenSfM or NeRF tools',
          },
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
          {
            id: 'workflow-builder',
            guide: 'workflow-builder',
            tip: 'Run several stages in one go, with quality checks between them',
            label: 'Workflow\nBuilder',
            icon: 'list',
            needs: ['project'],
          },
          {
            // A workflow of the steps that rebuild the outdated products, opened in the
            // Workflow Builder (composables/useRebuildOutdated.js).
            id: 'rebuild-outdated',
            guide: 'workflow-builder',
            tip: 'Rebuild the products a changed model outdated, in order, with their last settings',
            label: 'Rebuild\nOutdated',
            icon: 'redo',
            needs: ['outdated'],
          },
        ],
      },
      {
        label: 'Features',
        commands: [
          {
            id: 'detect-features',
            guide: 'detect-features',
            tip: 'Find keypoints in every photo, with SIFT or a learned detector',
            label: 'Detect\nFeatures',
            icon: 'sparkles',
            needs: ['images', 'imagesReady'],
          },
          {
            id: 'match-features',
            guide: 'match-features',
            tip: 'Match keypoints between image pairs and verify each pair geometrically',
            label: 'Match\nFeatures',
            icon: 'link',
            needs: ['imagesReady', 'keypoints'],
          },
        ],
      },
      // The groups are pipeline *stages*, in order: features → sparse →
      // georeferencing → dense → deliverables. Dense stays a reconstruction stage
      // rather than a product: it is still the scene geometry, and DEM/Ortho/Mesh
      // are all derived *from* it.
      {
        label: 'Sparse',
        commands: [
          {
            id: 'reconstruct',
            guide: 'sparse-reconstruction',
            tip: 'Solve the camera poses and calibration, and triangulate the tie points',
            label: 'Sparse\nModel',
            icon: 'sparse-model',
            needs: ['imagesReady', 'matches'],
          },
        ],
      },
      {
        // Plain buttons, not a menu: a pipeline step done once per project, and the
        // step a new user most needs to find. Between Sparse and Dense: a GCP
        // adjustment rebuilds the sparse model and invalidates depth maps and
        // everything after them (guide: getting-started ▸ 4). In work order: get the
        // GCPs (by hand or found), then fit; Scale Bars for a project without a CRS.
        // No "Project CRS" entry here: CRS is project *configuration*, set from the
        // Settings modal (App.vue `handleSetCrs`), not a tool that transforms data.
        label: 'Georeferencing',
        commands: [
          {
            pair: [
              EDIT_GCPS,
              {
                id: 'find-gcps',
                guide: 'georeferencing',
                tip: 'Find GCPs automatically by matching the photos to a reference orthophoto',
                label: 'Find GCPs',
                icon: 'map-pin',
                needs: ['sparse'],
                aerialOnly: true,
              },
            ],
          },
          // One entry point for both GCP-constrained adjustment + final similarity fit
          // and the cheap transform-only path. The modal explains/validates each mode.
          {
            id: 'georeference',
            guide: 'georeferencing',
            tip: 'Place the model in a coordinate system, from GCPs or camera positions',
            label: 'Geo-\nreference',
            icon: 'target',
            needs: ['sparse'],
            aerialOnly: true,
          },
          // Same job as Georeference — fixing the datum — for a project that has no
          // CRS at all. Deliberately NOT aerialOnly: scale bars are the object-capture
          // way to get metres, and an object project is exactly where there is no
          // georeference to supply one.
          {
            id: 'scale-bars',
            guide: 'georeferencing',
            tip: 'Scale the model from known distances between points in the photos',
            label: 'Scale\nBars',
            icon: 'scale-bar',
            needs: ['sparse'],
          },
        ],
      },
      {
        label: 'Dense',
        commands: [
          {
            id: 'compute-depth',
            guide: 'depth-maps',
            tip: 'Estimate a depth map for each photo from its neighbours (PatchMatch)',
            label: 'Depth\nMaps',
            icon: 'depth',
            needs: ['imagesReady', 'sparse'],
          },
          {
            id: 'dense',
            guide: 'dense-cloud',
            tip: 'Fuse the depth maps into a dense, coloured point cloud',
            label: 'Dense\nModel',
            icon: 'point-cloud',
            needs: ['depthMaps'],
          },
        ],
      },
      {
        label: 'Products',
        commands: [
          GEN_DEM,
          GEN_ORTHO,
          GEN_REFLECTANCE,
          {
            id: 'gen-mesh',
            guide: 'mesh',
            tip: 'Build a surface mesh from the dense cloud (screened Poisson)',
            label: 'Mesh',
            icon: 'cube',
            needs: ['dense'],
          },
        ],
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
                guide: 'model-tools',
                label: 'Image quality…',
                icon: 'quality',
                needs: ['images', 'imagesReady'],
                blurb: 'Score sharpness and exposure; exclude blurry images',
              },
              {
                id: 'detect-targets',
                guide: 'detect-targets',
                label: 'Detect targets…',
                icon: 'target',
                needs: ['images', 'imagesReady'],
                blurb: 'Mark GCP targets: checker mats where the model expects them, or AprilTags',
              },
              {
                id: 'reduce-overlap',
                guide: 'reduce-overlap',
                label: 'Reduce overlap…',
                icon: 'image',
                needs: ['sparse'],
                blurb: 'Disable the photos a dense block does not need for depth maps',
              },
              {
                id: 'auto-mask',
                guide: 'masks',
                label: 'Auto mask…',
                icon: 'mask',
                needs: ['images', 'imagesReady'],
                blurb: 'Mask the edges (a fixed strip or the film frame), the text on the photos, or both',
              },
              {
                id: 'read-text',
                guide: 'masks',
                label: 'Read text…',
                icon: 'image',
                needs: ['images', 'imagesReady'],
                blurb: 'Read the text on the photos: frame numbers, data strips, the focal length printed on them',
              },
              { section: 'Film scans' },
              {
                id: 'detect-fiducials',
                guide: 'film-fiducials',
                label: 'Detect fiducials…',
                icon: 'target',
                needs: ['filmSensor', 'imagesReady'],
                blurb: 'Find the fiducial marks on scanned film frames',
              },
              {
                id: 'calibrate-fiducials',
                guide: 'film-fiducials',
                label: 'Calibrate fiducials…',
                icon: 'calibration',
                needs: ['filmSensor'],
                blurb: 'Camera-certificate or batch-estimated fiducial layout',
              },
              {
                id: 'detect-reseau',
                guide: 'reseau',
                label: 'Detect reseau…',
                icon: 'target',
                needs: ['images', 'imagesReady'],
                blurb: 'Measure the reseau crosses: scan placement and film deformation per scan',
              },
              {
                id: 'split-panoramic',
                guide: 'panoramic',
                label: 'Split panoramic strips…',
                icon: 'image',
                needs: ['images', 'imagesReady'],
                blurb: 'Cut panoramic (optical-bar) scans into frame-camera segments',
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
                guide: 'optimize-cameras',
                label: 'Optimize cameras…',
                icon: 'calibration',
                needs: ['sparse'],
                blurb: 'Re-run bundle adjustment with chosen lens parameters',
              },
              {
                id: 'gradual-selection',
                guide: 'sparse-reconstruction',
                label: 'Gradual selection…',
                icon: 'sparse-model',
                needs: ['sparse'],
                blurb: 'Remove weak tie points by error, views or angle',
              },
              { section: 'Frame' },
              {
                id: 'set-region',
                guide: 'model-tools',
                label: 'Region…',
                icon: 'region',
                needs: ['sparse'],
                blurb: 'A box that limits depth maps, fusion, mesh and DEM',
              },
              {
                id: 'orient-model',
                guide: 'model-tools',
                label: 'Orient model…',
                icon: 'level',
                needs: ['sparse'],
                blurb: 'Level the model and set its origin (projects without CRS)',
              },
              { section: 'Cameras' },
              {
                id: 'footprints-from-poses',
                guide: 'footprints-from-poses',
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
                guide: 'filter-cloud',
                label: 'Filter…',
                icon: 'point-cloud',
                needs: ['dense'],
                blurb: 'Height/brightness range, voxel, isolated points, outliers',
              },
              {
                id: 'cloud-outliers',
                guide: 'filter-cloud',
                label: 'Remove outliers…',
                icon: 'point-cloud',
                needs: ['dense'],
                blurb: 'Statistical outlier removal',
              },
              {
                id: 'cloud-subsample',
                guide: 'filter-cloud',
                label: 'Subsample…',
                icon: 'grid',
                needs: ['dense'],
                blurb: 'Thin to one point per voxel',
              },
              { section: 'Edit' },
              // Modes in the 3D view; Delete / Keep only / Clear are its floating toolbox.
              {
                id: 'view-select-rect',
                guide: 'point-cloud-tools',
                label: 'Select (rectangle)',
                icon: 'rect',
                activeKey: 'selectRect',
                needs: ['dense'],
                blurb: 'Drag a box in the 3D view, then delete or keep',
              },
              {
                id: 'view-select-lasso',
                guide: 'point-cloud-tools',
                label: 'Select (lasso)',
                icon: 'lasso',
                activeKey: 'selectLasso',
                needs: ['dense'],
                blurb: 'Draw a freehand outline in the 3D view, then delete or keep',
              },
              {
                id: 'crop-cloud',
                guide: 'crop-cloud',
                label: 'Crop…',
                icon: 'rect',
                needs: ['dense'],
                blurb: 'Keep or remove an axis-aligned box',
              },
              {
                id: 'transform-cloud',
                guide: 'transform-cloud',
                label: 'Transform…',
                icon: 'transform',
                needs: ['dense'],
                blurb: 'Move, rotate, scale, or apply a 4×4 matrix',
              },
              { section: 'Combine' },
              {
                id: 'merge-clouds',
                guide: 'merge-clouds',
                label: 'Merge…',
                icon: 'link',
                needs: ['twoClouds'],
                blurb: 'Concatenate clouds with an optional seam dedupe',
              },
              {
                id: 'align-points',
                guide: 'transform-cloud',
                label: 'Align by point pairs…',
                icon: 'align',
                needs: ['dense'],
                blurb: 'Pick ≥3 matching points in both clouds',
              },
              {
                id: 'align-icp',
                guide: 'align-icp',
                label: 'Align to reference (ICP)…',
                icon: 'align',
                needs: ['dense'],
                blurb: 'Refine an approximate alignment automatically',
              },
              { section: 'Attributes' },
              {
                id: 'estimate-normals',
                guide: 'estimate-normals',
                label: 'Estimate normals…',
                icon: 'normals',
                needs: ['dense'],
                blurb: 'Per-point normals, e.g. to mesh an imported cloud',
              },
              {
                id: 'classify-ground',
                guide: 'classify-ground',
                label: 'Classify points…',
                icon: 'dem',
                needs: ['dense'],
                blurb: 'Ground for a DTM, then buildings and vegetation',
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
                guide: 'clean-mesh',
                label: 'Clean mesh…',
                icon: 'cube',
                needs: ['mesh'],
                blurb: 'Small pieces, long-edge bridges, holes (watertight)',
              },
              {
                id: 'smooth-mesh',
                guide: 'smooth-mesh',
                label: 'Smooth…',
                icon: 'smooth',
                needs: ['mesh'],
                blurb: 'Taubin smoothing without shrinkage',
              },
              { section: 'Simplify' },
              {
                id: 'decimate-mesh',
                guide: 'decimate-mesh',
                label: 'Decimate…',
                icon: 'decimate',
                needs: ['mesh'],
                blurb: 'Reduce to a target triangle count (quadric collapse)',
              },
              { section: 'Edit' },
              {
                id: 'crop-mesh',
                guide: 'crop-cloud',
                label: 'Crop…',
                icon: 'rect',
                needs: ['mesh'],
                blurb: 'Keep or remove an axis-aligned box',
              },
              { section: 'Convert' },
              {
                id: 'mesh-to-points',
                guide: 'sample-mesh',
                label: 'Sample to points…',
                icon: 'point-cloud',
                needs: ['mesh'],
                blurb: 'Uniform surface sampling into a dense cloud',
              },
              { section: 'Colour' },
              {
                id: 'texture-mesh',
                guide: 'texture-mesh',
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
                guide: 'contours',
                label: 'Contours…',
                icon: 'contours',
                needs: ['dem'],
                aerialOnly: true,
                blurb: 'Contour lines from the DEM (GeoJSON / DXF)',
              },
              {
                id: 'dem-derivatives',
                guide: 'terrain-derivatives',
                label: 'Slope, aspect, hillshade…',
                icon: 'dem',
                needs: ['dem'],
                aerialOnly: true,
                blurb: 'Terrain derivative rasters as GeoTIFF',
              },
              {
                id: 'coregister-dem',
                guide: 'coregister-dem',
                label: 'Co-register DEM…',
                icon: 'dem',
                needs: ['dem', 'referenceDem'],
                aerialOnly: true,
                blurb: 'Shift and tilt the DEM, or the georeference, onto a reference DEM',
              },
              { section: 'Export' },
              {
                id: 'clip-raster',
                guide: 'clip-raster',
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
        commands: [
          {
            id: 'eval-overview',
            guide: 'quality-report',
            tip: 'How each stage went, and what to fix first',
            label: 'Quality\nReport',
            icon: 'report',
          },
        ],
      },
      {
        label: 'Features',
        commands: [
          {
            id: 'eval-match-graph',
            guide: 'quality-report',
            tip: 'The match graph: weak links, disconnected groups, photos with few matches',
            label: 'Matching',
            icon: 'link',
            needs: ['matches'],
          },
        ],
      },
      {
        label: 'Sparse',
        commands: [
          {
            id: 'eval-reconstruction',
            guide: 'quality-report',
            tip: 'Registration, track lengths and reprojection errors of the sparse model',
            label: 'Sparse\nModel',
            icon: 'sparse-model',
            needs: ['sparse'],
          },
          {
            id: 'eval-calibration',
            guide: 'quality-report',
            tip: 'The estimated lens: focal length, principal point, distortion',
            label: 'Calibration',
            icon: 'calibration',
            needs: ['sparse'],
          },
          {
            id: 'eval-gcps',
            guide: 'quality-report',
            tip: 'Residuals at checkpoints and camera positions against their reference coordinates',
            label: 'Accuracy',
            icon: 'map-pin',
            needs: ['sparse'],
          },
          {
            id: 'eval-coverage',
            guide: 'quality-report',
            tip: 'Where tie points cluster or are missing, on a coverage map',
            label: 'Coverage',
            icon: 'grid',
            needs: ['sparse'],
          },
        ],
      },
      {
        label: 'Dense',
        commands: [
          {
            id: 'eval-depth-coverage',
            guide: 'quality-report',
            tip: 'How much of each photo its depth map covers',
            label: 'Depth\nCoverage',
            icon: 'depth',
            needs: ['depthMaps'],
          },
        ],
      },
      {
        label: 'Products',
        commands: [
          // The computed DEM against an imported reference DEM (TODO.md ▸ A-6).
          {
            id: 'eval-dem-reference',
            guide: 'quality-report',
            tip: 'The DEM against a reference DEM: the differences and their statistics',
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
      // Every export opens its dialog (ExportModal.vue), so no label here needs the
      // "…" that marks a command asking for more before it acts.
      {
        label: 'Cameras',
        commands: [
          {
            id: 'export-cameras',
            guide: 'export-camera-poses',
            tip: 'Camera positions and orientations as CSV, text or GeoJSON',
            label: 'Camera\nPoses',
            icon: 'camera-pose',
            needs: ['posesOrSparse'],
          },
          {
            id: 'export-sensors',
            guide: 'export-calibration',
            tip: 'Camera calibration as CSV or text',
            label: 'Calibration',
            icon: 'calibration',
            needs: ['sensors'],
          },
          {
            id: 'export-camera-fiducials',
            guide: 'film-fiducials',
            tip: "The film cameras' fiducial positions as CSV or text",
            label: 'Camera\nFiducials',
            icon: 'camera',
            needs: ['fiducialMarks'],
          },
          // The image footprints as GeoJSON (they have no sidebar row to download from).
          {
            id: 'export-footprints',
            guide: 'footprints-from-poses',
            tip: 'The ground each photo covers, as GeoJSON or KML',
            label: 'Foot-\nprints',
            icon: 'footprint',
            needs: ['footprints'],
          },
        ],
      },
      {
        label: 'Features',
        commands: [
          {
            id: 'export-image-fiducials',
            guide: 'film-fiducials',
            tip: 'The fiducial marks measured on each scan, as CSV or text',
            label: 'Image\nFiducials',
            icon: 'target',
            needs: ['fiducials'],
          },
          {
            id: 'export-keypoints',
            tip: "Every photo's keypoints as JSON or CSV",
            label: 'Key-\npoints',
            icon: 'keypoints',
            needs: ['imagesReady', 'keypoints'],
          },
          {
            id: 'export-matches',
            tip: 'The verified matches of every pair as JSON or CSV',
            label: 'Matches',
            icon: 'link',
            needs: ['matches'],
          },
        ],
      },
      {
        label: 'Reconstruction',
        commands: [
          {
            id: 'export-model',
            tip: 'Cameras and tracks as JSON, or transforms.json for NeRF and Gaussian splatting',
            label: 'Model\nJSON',
            icon: 'cube',
            needs: ['sparse'],
          },
        ],
      },
      {
        label: 'Geometry',
        commands: [
          {
            id: 'export-cloud',
            guide: 'point-cloud-tools',
            tip: 'A point cloud as PLY, LAS, LAZ, COPC or XYZ',
            label: 'Point\nCloud',
            icon: 'point-cloud',
            needs: ['cloud'],
          },
          {
            id: 'export-mesh',
            guide: 'texture-mesh',
            tip: 'A mesh as PLY, glTF, OBJ or STL',
            label: 'Mesh',
            icon: 'cube',
            needs: ['mesh'],
          },
        ],
      },
      {
        label: 'Products',
        commands: [
          EXPORT_DEM,
          EXPORT_ORTHO,
          // Saved ruler / area / profile / volume / 3D measurements as CSV or GeoJSON.
          {
            id: 'export-measurements',
            guide: 'dem',
            tip: 'Saved measurements as CSV or GeoJSON',
            label: 'Measure-\nments',
            icon: 'ruler',
            needs: ['measurements'],
          },
        ],
      },
      {
        label: 'Interoperability',
        commands: [
          {
            id: 'export-colmap',
            guide: 'import-sfm',
            tip: 'The cameras, features and sparse model for COLMAP, OpenMVG, VisualSFM, Metashape or NeRF tools',
            label: 'SfM\nProject',
            icon: 'cube',
            needs: ['sparse'],
          },
          {
            id: 'export-undistorted',
            tip: 'The photos with the lens distortion removed, as JPEG or PNG',
            label: 'Undistorted\nImages',
            icon: 'image',
            needs: ['sparse'],
          },
          {
            id: 'export-tiles3d',
            guide: 'export-3d-tiles',
            tip: 'A point cloud or mesh as Cesium 3D Tiles',
            label: '3D Tiles',
            icon: 'layers',
            needs: ['cloud'],
          },
          // Each aligned photo as a Georeference Annotation (core/io/allmaps.js).
          {
            id: 'export-allmaps',
            guide: 'export-allmaps',
            tip: 'Each aligned photo georeferenced for Allmaps and other IIIF viewers, from your IIIF image server',
            label: 'Allmaps',
            icon: 'footprint',
            needs: ['sparse', 'sparseGeoref'],
          },
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
        // home. The ribbon keeps only this: work is autosaved, so writing a
        // portable `.websfm` file is an export — the project stays where it is.
        label: 'Project',
        commands: [
          {
            id: 'open-project-settings',
            guide: 'projects-storage',
            tip: "This project's name, coordinate system and other settings",
            label: 'Project\nSettings',
            icon: 'settings',
            needs: ['project'],
          },
          {
            id: 'save-project-file',
            guide: 'projects-storage',
            tip: 'Save the whole project as one .websfm file, to back it up or move it',
            label: 'Export\nProject',
            icon: 'save',
            needs: ['project'],
          },
        ],
      },
      {
        label: 'Panels',
        commands: [
          {
            id: 'toggle-console',
            guide: 'command-console',
            tip: 'The log of every run, and a command line',
            label: 'Console',
            icon: 'console',
            activeKey: 'consoleOpen',
          },
        ],
      },
      {
        label: 'App',
        commands: [
          { id: 'open-glossary', tip: 'The methods and terms, explained', label: 'Glossary', icon: 'book' },
          {
            id: 'open-guide',
            tip: 'How each operation works and how to choose its settings',
            label: 'Guide',
            icon: 'book',
          },
          { id: 'open-shortcuts', tip: 'All keyboard shortcuts', label: 'Shortcuts', icon: 'keyboard' },
          // `badge`: Ribbon shows composables/useWhatsNew's count of unseen entries.
          {
            id: 'open-whats-new',
            tip: 'What changed in each release',
            label: "What's\nNew",
            icon: 'sparkles',
            badge: 'whatsNew',
          },
          // Appearance lives in Settings ▸ Display (and the command palette's
          // `theme`) — deliberately not duplicated as a ribbon button.
          { id: 'open-settings', tip: 'Settings for the app, in every project', label: 'Settings', icon: 'settings' },
          {
            id: 'open-system-info',
            tip: 'What this browser and machine support: GPU, memory, storage',
            label: 'System info',
            icon: 'cpu',
          },
          { id: 'open-about', tip: 'Version, license and third-party licenses', label: 'About', icon: 'info' },
        ],
      },
      {
        // A compact, classified reconstruction-health digest — copy-pasteable so a
        // run's outcome can be shared without the full (thousands-of-lines) log.
        label: 'Debug',
        commands: [
          {
            id: 'open-debug-summary',
            tip: "A technical summary of the project's data, for a bug report",
            label: 'Project\nSummary',
            icon: 'summary',
            needs: ['project'],
          },
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
    {
      pair: [
        { id: 'view-preset-top', guide: '3d-view', label: 'Top', icon: 'view-top' },
        { id: 'view-preset-bottom', guide: '3d-view', label: 'Bottom', icon: 'view-bottom' },
      ],
    },
    {
      pair: [
        { id: 'view-preset-left', guide: '3d-view', label: 'Left', icon: 'view-left' },
        { id: 'view-preset-right', guide: '3d-view', label: 'Right', icon: 'view-right' },
      ],
    },
    {
      pair: [
        { id: 'view-preset-front', guide: '3d-view', label: 'Front', icon: 'view-front' },
        { id: 'view-preset-back', guide: '3d-view', label: 'Back', icon: 'view-back' },
      ],
    },
    { id: 'reset-view', guide: '3d-view', label: 'Reset\nView', icon: 'view-reset' },
    // The camera circles the scene; its toolbox holds the speed and the recording.
    { id: 'view-toggle-turntable', guide: '3d-view', label: 'Turntable', icon: 'turntable', activeKey: 'turntable' },
  ],
}

// 3D scene display: toggles plus the two size steppers (persisted display values,
// useViewerSettings). Steppers are display settings, so they belong here.
export const SCENE_GROUP = {
  label: 'Scene',
  dynamic: '3D',
  commands: [
    { id: 'view-toggle-cameras', guide: '3d-view', label: 'Cameras', icon: 'camera', activeKey: 'showCameras' },
    { id: 'view-toggle-grid', guide: '3d-view', label: 'Grid', icon: 'grid', activeKey: 'showGrid' },
    { id: 'view-toggle-legend', guide: '3d-view', label: 'Legend', icon: 'layers', activeKey: 'showLegend' },
    {
      pair: [
        {
          stepper: true,
          id: 'view-point-size',
          guide: '3d-view',
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
          guide: '3d-view',
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
      guide: 'footprints-from-poses',
      label: 'Footprints',
      icon: 'footprint',
      activeKey: 'showFootprints',
      needs: ['footprints'],
    },
    // The source images drawn on the ground by the aligned model, or into their
    // footprints: a layer of the stack (Layers).
    {
      id: 'map-toggle-photos',
      guide: 'map-photos',
      label: 'Photos',
      icon: 'image',
      activeKey: 'showMapPhotos',
      needs: ['footprintsOrSparse'],
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
          label: 'Keypoints',
          // With keypoints detected, the button counts them (`countKey` of the image view).
          countLabel: 'KP\n{n}',
          countKey: 'kpCount',
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
    // A mode on the photo in front, beside its Mask toggle (ONE HOME PER TOOL);
    // brush/eraser/rect/invert/undo live in the floating MaskToolbar over the image.
    // Edit GCPs is Reconstruct ▸ Georeferencing's own command, offered here too.
    {
      label: 'Edit',
      commands: [
        {
          id: 'img-mask-edit',
          guide: 'masks',
          tip: 'Paint the mask of this photo',
          label: 'Edit\nMask',
          icon: 'pencil',
          activeKey: 'maskEdit',
          needs: ['imageView'],
        },
        EDIT_GCPS_TAB,
      ],
    },
  ],
}

// The raster counterpart of PICTURE_TAB. Both provenances offer the same object
// actions in the same order — get a copy out, change how it looks, put it on the
// map, remove it — and differ only where the object does: a *computed* product
// can also be rebuilt, and exports through the Export tab's dialog; an *imported*
// reference raster downloads as the file it was (the pipeline never rebuilds
// one), and its Style… is band math (greyed when there is nothing to choose).
// The map toggle (In Layers: on the map, listed in View ▸ Map ▸ Layers) is one
// command; a product the map cannot place greys it with the reason. Same entries as the sidebar's right-click menus.
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
              { id: 'raster-toggle-map', label: 'In\nLayers', icon: 'layers', activeKey: 'rasterVisible' },
              { id: 'raster-remove', label: 'Remove', icon: 'remove', danger: true },
              // Place GCPs off the reference (A-5). Not on a computed product: control
              // read off a product of the same photos would be circular.
              EDIT_GCPS_TAB,
            ],
          }
        : {
            label: isOrtho ? 'Orthophoto' : 'DEM',
            commands: [
              // The Reconstruct / Export commands themselves, relabelled.
              // `labelId`: the relabel's own catalogue key (core/help/ribbonText.js).
              { ...(isOrtho ? GEN_ORTHO : GEN_DEM), label: 'Rebuild', labelId: 'raster-rebuild' },
              { ...(isOrtho ? EXPORT_ORTHO : EXPORT_DEM), label: 'Export', labelId: 'raster-export', icon: 'download' },
              { id: 'raster-symbology', label: 'Symbology…', icon: 'settings' },
              { id: 'raster-toggle-map', label: 'In\nLayers', icon: 'layers', activeKey: 'rasterVisible' },
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
  const label = cmd.label ?? cmd.id
  return label.replace(/-\n/g, '').replace(/\n/g, ' ')
}

/**
 * Every leaf command with where it lives, for the console's command list (core/help/
 * commands.js derives its verbs from this, so a new ribbon command is typeable without
 * a second table). → [{ cmd, tab, path }] in ribbon order, first occurrence of each id;
 * `path` is 'Tab ▸ Group' (▸ Menu for a menu row), the contextual groups under the
 * tab they appear in.
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
    if (!cmd.id || seen.has(cmd.id)) return
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
