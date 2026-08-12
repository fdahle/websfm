<script setup>
import { ref, computed, watch } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps({
  activeView: { type: String, default: 'viewer' },
  hasSelection: { type: Boolean, default: false },
  imageCount: { type: Number, default: 0 },
  // True while any imported image is still decoding/transcoding (TIFF PNG encode,
  // preview pending). Compute ops that read pixels are gated on this.
  imagesLoading: { type: Boolean, default: false },
  matchCount: { type: Number, default: 0 },
  kpImageCount: { type: Number, default: 0 },
  gcpCount: { type: Number, default: 0 },
  poseCount: { type: Number, default: 0 },
  footprintCount: { type: Number, default: 0 },
  sensorCount: { type: Number, default: 0 },
  // Film sensors available for the setup/detection modal. Calibration
  // prerequisites are validated inside the modal so its guidance is reachable.
  filmSensorCount: { type: Number, default: 0 },
  sparseReady: { type: Boolean, default: false },
  depthMapCount: { type: Number, default: 0 },
  cloudReady: { type: Boolean, default: false },
  denseReady: { type: Boolean, default: false },
  // How many clouds the crop/filter/merge tools can act on (kind:'dense',
  // computed or imported). Merge needs two; the rest gate on denseReady.
  editableCloudCount: { type: Number, default: 0 },
  meshReady: { type: Boolean, default: false },
  demReady: { type: Boolean, default: false },
  orthoReady: { type: Boolean, default: false },
  productReady: { type: Boolean, default: false },
  activeImageId: { type: String, default: null },
  activeImageName: { type: String, default: null },
  imageViewState: { type: Object, default: null },
  // The raster tab currently in front, if any: { kind: 'dem'|'ortho',
  // imported: boolean, onMap: boolean }. Drives the contextual Raster tab, the
  // exact mirror of `pictureTab` for an image tab.
  activeRaster: { type: Object, default: null },
  consoleOpen: { type: Boolean, default: false },
  persistenceEnabled: { type: Boolean, default: false },
  currentProjectName: { type: String, default: null },
  sceneType: { type: String, default: null },
  showCameras: { type: Boolean, default: true },
  showGrid: { type: Boolean, default: true },
  showMapGrid: { type: Boolean, default: true },
  showFootprints: { type: Boolean, default: true },
})

const emit = defineEmits(['command'])

const tabs = [
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Inspect',
        commands: [
          { id: 'open-image-table',  label: 'Images',  icon: 'table',   needsImages: true },
          { id: 'open-mask-manager', label: 'Masks',   icon: 'mask',    needsImages: true },
          { id: 'open-sensor-table', label: 'Sensors', icon: 'camera',  needsSensors: true },
          { id: 'open-pose-table',   label: 'Camera\nPoses', icon: 'camera-pose', needsPoses: true },
          // The table edits existing GCPs; a GCP is born elsewhere (import, or a
          // right-click on the map / an image), so an empty project has nothing to show.
          { id: 'open-gcp-table',    label: 'GCPs',    icon: 'map-pin', aerialOnly: true, needsGcps: true },
          { id: 'open-match-list',   label: 'Matches', icon: 'list',    needsMatches: true },
        ],
      },
      // The second group is contextual: see cameraGroup / mapGroup below. It is
      // injected by the currentTab computed depending on the active viewer.
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
        label: 'Features',
        commands: [
          { id: 'detect-features', label: 'Detect\nFeatures', icon: 'sparkles', needsImages: true, needsImagesReady: true },
          { id: 'match-features', label: 'Match\nFeatures', icon: 'link', needsKeypoints: true },
        ],
      },
      // The groups are pipeline *stages*, in order: features → sparse → dense →
      // deliverables. Dense stays a reconstruction stage rather than a product: it is
      // still the scene geometry, and DEM/Ortho/Mesh are all derived *from* it.
      {
        label: 'Sparse',
        commands: [
          { id: 'reconstruct',   label: 'Sparse\nModel', icon: 'sparse-model', needsMatches: true },
        ],
      },
      {
        label: 'Dense',
        commands: [
          { id: 'compute-depth', label: 'Depth\nMaps',   icon: 'depth',       needsSparse: true },
          { id: 'dense',         label: 'Dense\nModel',  icon: 'point-cloud', needsDepthMaps: true },
        ],
      },
      {
        label: 'Products',
        commands: [
          { id: 'gen-dem',       label: 'DEM',     icon: 'dem',   needsCloud: true, aerialOnly: true },
          { id: 'gen-ortho',     label: 'Ortho',   icon: 'ortho', needsSurface: true, needsDepthMaps: true, aerialOnly: true },
          { id: 'gen-mesh',      label: 'Mesh',    icon: 'cube',  needsDense: true },
        ],
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    groups: [
      // Grouped by the *object* each tool acts on, ordered the way the data flows:
      // images → cameras/scene → georeferencing → the resulting cloud. `disabled: true`
      // entries are deliberate placeholders — they exist so each group reads as a
      // category rather than a single orphan button.
      {
        label: 'Images',
        commands: [
          { id: 'auto-mask',        label: 'Auto\nMask',      icon: 'mask',   needsImages: true, needsImagesReady: true },
          { id: 'detect-fiducials', label: 'Detect\nFiducials', icon: 'target', needsFilmSensor: true },
          { id: 'calibrate-fiducials', label: 'Calibrate\nFiducials', icon: 'calibration', needsFilmSensor: true },
        ],
      },
      {
        label: 'Scene',
        commands: [
          { id: 'footprints-from-poses', label: 'Footprints\nfrom Poses', icon: 'footprint', needsPoses: true, needsSensors: true, aerialOnly: true },
        ],
      },
      {
        // No "Project CRS" entry here: CRS is project *configuration*, set from the
        // Settings modal (App.vue `handleSetCrs`), not a tool that transforms data.
        label: 'Georeferencing',
        commands: [
          // Mockup: automatic relative-ortho ↔ reference-ortho matching is tracked in
          // TODO.md. Keep the dialog reachable so the intended inputs/workflow are clear.
          { id: 'find-gcps',      label: 'Find\nGCPs',      icon: 'map-pin', needsSparse: true, aerialOnly: true },
          // One entry point for both GCP-constrained adjustment + final similarity fit
          // and the cheap transform-only path. The modal explains/validates each mode.
          { id: 'georeference',   label: 'Geo-\nreference', icon: 'target',  needsSparse: true, aerialOnly: true },
        ],
      },
      {
        // Operations that refine an already-georeferenced result against external
        // evidence belong after georeferencing, not beside the controls that establish it.
        label: 'Post-processing',
        commands: [
          // Placeholder: local surface registration against an imported reference DEM.
          // A practical ICP implementation needs an existing approximate georeference.
          { id: 'fit-reference', label: 'Fit to\nReference', icon: 'layers', disabled: true },
        ],
      },
      {
        label: 'Point Cloud',
        commands: [
          // These edit **dense** clouds (computed or imported) and always produce a
          // new cloud — the source is never modified. A sparse cloud is deliberately
          // not editable: its points carry the view-tracks dense/ortho/COLMAP read.
          { id: 'filter-cloud',    label: 'Filter\nCloud',  icon: 'point-cloud', needsDense: true },
          { id: 'crop-cloud',      label: 'Crop\nCloud',    icon: 'rect',        needsDense: true },
          { id: 'merge-clouds',    label: 'Merge\nClouds',  icon: 'link',        needsTwoClouds: true },
        ],
      },
    ],
  },
  {
    // The Quality Report hub — one modal with an overview landing page + section tabs.
    // These buttons deep-link into it; the hub's own nav (with greyed prerequisites) is
    // the real discoverability surface, so a handful of entry points in workflow order
    // is enough. See PLAN-eval-quality-hub.
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
          { id: 'eval-match-graph', label: 'Matching', icon: 'link', needsMatches: true },
        ],
      },
      {
        label: 'Sparse',
        commands: [
          { id: 'eval-reconstruction', label: 'Sparse\nModel',  icon: 'sparse-model', needsSparse: true },
          { id: 'eval-calibration',    label: 'Calibration',    icon: 'calibration',  needsSparse: true },
          { id: 'eval-gcps',           label: 'Accuracy',       icon: 'map-pin',      needsSparse: true },
          { id: 'eval-coverage',       label: 'Coverage',       icon: 'grid',         needsSparse: true },
        ],
      },
      {
        label: 'Dense',
        commands: [
          { id: 'eval-depth-coverage', label: 'Depth\nCoverage', icon: 'depth', needsDepthMaps: true },
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
          { id: 'export-cameras', label: 'Camera\nPoses', icon: 'camera-pose', needsPoses: true },
          { id: 'export-sensors', label: 'Calibration',   icon: 'calibration', needsSensors: true },
        ],
      },
      {
        label: 'Features',
        commands: [
          { id: 'export-keypoints', label: 'Key\npoints', icon: 'keypoints', needsKeypoints: true },
          { id: 'export-matches',   label: 'Matches',     icon: 'link',      needsMatches: true },
        ],
      },
      {
        label: 'Reconstruction',
        commands: [
          { id: 'export-model',  label: 'Model\nJSON',   icon: 'cube', needsSparse: true },
        ],
      },
      {
        label: 'Geometry',
        commands: [
          { id: 'export-cloud', label: 'Point\nCloud', icon: 'point-cloud', needsCloud: true },
          { id: 'export-mesh',  label: 'Mesh',         icon: 'cube',        needsMesh: true },
        ],
      },
      {
        label: 'Products',
        commands: [
          { id: 'export-dem',   label: 'DEM',   icon: 'dem',   needsDem: true, aerialOnly: true },
          { id: 'export-ortho', label: 'Ortho', icon: 'ortho', needsOrtho: true, aerialOnly: true },
        ],
      },
      {
        label: 'Interoperability',
        commands: [
          { id: 'export-colmap', label: 'SfM\nProject…', icon: 'cube', needsSparse: true },
          { id: 'export-undistorted', label: 'Undistorted\nImages…', icon: 'image', needsSparse: true },
          { id: 'export-tiles3d', label: '3D Tiles…', icon: 'layers', needsCloud: true },
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
          { id: 'open-project-settings', label: 'Project\nSettings', icon: 'settings', needsProject: true },
          { id: 'save-project-file', label: 'Save a\nCopy…', icon: 'save', needsProject: true },
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
          { id: 'open-debug-summary', label: 'Project\nSummary', icon: 'summary', needsProject: true },
        ],
      },
    ],
  },
]

// The View tab's second group swaps with the active viewer. The `dynamic` badge
// signals that it is contextual (3D camera presets ↔ 2D map controls).
const cameraGroup = {
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

// 3D scene display toggles (cameras / grid). Sits beside the camera presets
// when the 3D viewer is active.
const sceneGroup = {
  label: 'Scene',
  dynamic: '3D',
  commands: [
    { id: 'view-toggle-cameras',   label: 'Cameras',   icon: 'camera', activeKey: 'showCameras' },
    { id: 'view-toggle-grid', label: 'Grid', icon: 'grid',   activeKey: 'showGrid' },
  ],
}

const mapGroup = {
  label: 'Map',
  dynamic: '2D',
  commands: [
    { id: 'map-fit-view',          label: 'Fit\nView',   icon: 'fit-view' },
    { id: 'map-toggle-grid',  label: 'Grid',   icon: 'grid',      activeKey: 'showMapGrid' },
    { id: 'map-toggle-footprints', label: 'Footprints',  icon: 'footprint', activeKey: 'showFootprints', needsFootprints: true },
    { id: 'map-toggle-poses',      label: 'Poses',       icon: 'camera',    disabled: true },
  ],
}

const pictureTab = {
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
      label: 'Toggles',
      commands: [
        {
          id: 'img-toggle-keypoints',
          labelFn: (s) => s?.kpCount ? `KP\n${s.kpCount}` : 'Keypoints',
          icon: 'keypoints',
          activeKey: 'showKeypoints',
          disableKey: 'kpNotDone',
        },
        {
          id: 'img-toggle-mask',
          label: 'Mask',
          icon: 'mask',
          activeKey: 'showMask',
          disableKey: 'noMask',
        },
        {
          id: 'img-toggle-depth',
          label: 'Depth',
          icon: 'depth',
          activeKey: 'showDepth',
          disableKey: 'noDepth',
        },
        {
          id: 'img-toggle-gcps',
          label: 'GCPs',
          icon: 'map-pin',
          activeKey: 'showGcps',
          disableKey: 'noGcps',
        },
        {
          id: 'img-toggle-residuals',
          label: 'Residuals',
          icon: 'target',
          activeKey: 'showResiduals',
          needsSparse: true,
        },
        {
          id: 'img-toggle-fiducials',
          label: 'Fiducials',
          icon: 'target',
          activeKey: 'showFiducials',
          filmOnly: true,
        },
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

// The raster counterpart of pictureTab. Its second group depends on provenance:
// a *computed* product can be rebuilt and exported, an *imported* reference
// raster can be restyled, drawn on the map, or removed — the pipeline never
// rebuilds one.
const rasterTab = computed(() => {
  const r = props.activeRaster
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
                ? { id: 'gen-ortho', label: 'Rebuild', icon: 'ortho', needsSurface: true, needsDepthMaps: true }
                : { id: 'gen-dem',   label: 'Rebuild', icon: 'dem',   needsCloud: true },
              { id: isOrtho ? 'export-ortho' : 'export-dem', label: 'Export',  icon: 'download' },
            ],
          },
    ],
  }
})

const activeTab = ref('view')

watch(() => !!props.activeImageId, (hasImage) => {
  if (hasImage) {
    activeTab.value = 'picture'
  } else if (activeTab.value === 'picture') {
    activeTab.value = 'view'
  }
})

watch(() => !!props.activeRaster, (hasRaster) => {
  if (hasRaster) {
    activeTab.value = 'raster'
  } else if (activeTab.value === 'raster') {
    activeTab.value = 'view'
  }
})

const allTabs = computed(() => {
  const extra = []
  if (props.activeImageId) extra.push(pictureTab)
  if (props.activeRaster) extra.push(rasterTab.value)
  return extra.length ? [...tabs, ...extra] : tabs
})
const currentTab = computed(() => {
  const tab = allTabs.value.find((t) => t.id === activeTab.value) || tabs[0]
  if (tab.id === 'view') {
    // The contextual group tracks the *active viewer*, not merely "not map": while
    // an image detail tab is open activeView is neither, so no 3D/2D group applies.
    if (props.activeView === 'map')    return { ...tab, groups: [...tab.groups, mapGroup] }
    if (props.activeView === 'viewer') return { ...tab, groups: [...tab.groups, cameraGroup, sceneGroup] }
    return tab
  }
  return tab
})

function isHidden(cmd) {
  // `aerialOnly` deliberately does NOT hide: an object-capture project greys the
  // command out with a reason instead, the same discoverability rule the Evaluate
  // hub follows. Hiding made a whole ribbon group silently vanish, which reads as
  // a broken build rather than as "not applicable here".
  // Film-only overlays (fiducial marks) show only for a scanned-film image tab.
  if (cmd.filmOnly && !props.imageViewState?.isFilm) return true
  return false
}

function isActive(cmd) {
  if (cmd.view != null && cmd.view === props.activeView) return true
  if (cmd.activeKey === 'consoleOpen')   return props.consoleOpen
  if (cmd.activeKey === 'showCameras')   return props.showCameras
  if (cmd.activeKey === 'showGrid') return props.showGrid
  if (cmd.activeKey === 'showMapGrid') return props.showMapGrid
  if (cmd.activeKey === 'showFootprints') return props.showFootprints
  if (cmd.activeKey === 'rasterOnMap')    return !!props.activeRaster?.onMap
  const s = props.imageViewState
  if (!s || !cmd.activeKey) return false
  switch (cmd.activeKey) {
    case 'showKeypoints': return s.showKeypoints
    case 'showMask':      return s.showMask
    case 'showDepth':     return s.showDepth
    case 'showGcps':      return s.showGcps
    case 'showResiduals': return s.showResiduals
    case 'showFiducials': return s.showFiducials
    case 'maskEdit':      return s.maskEdit
    case 'gcpEdit':       return s.gcpEdit
  }
  return false
}

function isDisabled(cmd) {
  if (cmd.disabled) return true
  if (cmd.aerialOnly && props.sceneType === 'object') return true
  if (cmd.needsSelection && !props.hasSelection) return true
  if (cmd.needsImages   && props.imageCount === 0) return true
  if (cmd.needsImagesReady && props.imagesLoading) return true
  if (cmd.needsMatches   && props.matchCount === 0)   return true
  if (cmd.needsSparse    && !props.sparseReady)       return true
  if (cmd.needsDepthMaps && props.depthMapCount === 0) return true
  if (cmd.needsProject   && !props.currentProjectName) return true
  if (cmd.needsCloud     && !props.cloudReady)        return true
  if (cmd.needsDense     && !props.denseReady)        return true
  if (cmd.needsTwoClouds && props.editableCloudCount < 2) return true
  if (cmd.needsMesh      && !props.meshReady)         return true
  if (cmd.needsDem       && !props.demReady)          return true
  // An ortho reprojects onto a surface — a DEM or a mesh either way.
  if (cmd.needsSurface   && !props.demReady && !props.meshReady) return true
  if (cmd.needsOrtho     && !props.orthoReady)        return true
  if (cmd.needsProducts  && !props.productReady)      return true
  if (cmd.needsKeypoints && props.kpImageCount === 0) return true
  if (cmd.needsGcps     && props.gcpCount === 0)   return true
  if (cmd.needsPoses    && props.poseCount === 0)  return true
  if (cmd.needsFootprints && props.footprintCount === 0) return true
  if (cmd.needsSensors  && props.sensorCount === 0) return true
  if (cmd.needsFilmSensor && props.filmSensorCount === 0) return true
  const s = props.imageViewState
  if (cmd.disableKey === 'kpNotDone' && s?.kpStatus !== 'done') return true
  if (cmd.disableKey === 'noMask'    && !s?.hasMask)            return true
  if (cmd.disableKey === 'noDepth'   && !s?.hasDepth)           return true
  if (cmd.disableKey === 'noGcps'    && !s?.gcpCount)           return true
  return false
}

function disabledReason(cmd) {
  if (cmd.disabled) return 'Coming soon'
  if (cmd.aerialOnly && props.sceneType === 'object')
    return 'Only for aerial projects — an object capture has no coordinate system'
  if (cmd.needsImages   && props.imageCount === 0) return 'Import images first'
  if (cmd.needsImagesReady && props.imagesLoading) return 'Images still loading…'
  if (cmd.needsMatches   && props.matchCount === 0)   return 'Run feature matching first'
  if (cmd.needsSparse    && !props.sparseReady)       return 'Build the sparse model first'
  if (cmd.needsDepthMaps && props.depthMapCount === 0) return 'Compute depth maps first'
  if (cmd.needsProject   && !props.currentProjectName) return 'No project open'
  if (cmd.needsCloud     && !props.cloudReady)        return 'Build a point cloud first'
  if (cmd.needsDense     && !props.denseReady)        return 'Build a dense cloud first'
  if (cmd.needsTwoClouds && props.editableCloudCount < 2)
    return 'Merging needs at least two dense clouds'
  if (cmd.needsMesh      && !props.meshReady)         return 'Build a mesh first'
  if (cmd.needsDem       && !props.demReady)          return 'Build a DEM first'
  if (cmd.needsSurface   && !props.demReady && !props.meshReady) return 'Build a DEM or a mesh first'
  if (cmd.needsOrtho     && !props.orthoReady)        return 'Build an orthophoto first'
  if (cmd.needsProducts  && !props.productReady)      return 'Build a DEM or orthophoto first'
  if (cmd.needsKeypoints && props.kpImageCount === 0) return 'Detect keypoints first'
  if (cmd.needsGcps     && props.gcpCount === 0)
    return 'No GCPs yet — import a GCP file, or right-click the map or an image to add one'
  if (cmd.needsPoses    && props.poseCount === 0)  return 'Import camera poses first'
  if (cmd.needsSensors  && props.sensorCount === 0) return 'No sensors available'
  if (cmd.needsFilmSensor && props.filmSensorCount === 0) return 'Set at least one sensor to Film first'
  if (cmd.needsSelection && !props.hasSelection)   return 'Select an image first'
  const s = props.imageViewState
  if (cmd.disableKey === 'kpNotDone' && s?.kpStatus !== 'done') return 'Detect keypoints first'
  if (cmd.disableKey === 'noMask'    && !s?.hasMask)            return 'No mask available'
  if (cmd.disableKey === 'noDepth'   && !s?.hasDepth)           return 'No depth map available'
  if (cmd.disableKey === 'noGcps'    && !s?.gcpCount)           return 'No GCPs on this image'
  return ''
}

function cmdLabel(cmd) {
  return cmd.labelFn ? cmd.labelFn(props.imageViewState) : cmd.label
}

function cmdIcon(cmd) {
  return cmd.icon
}

function cmdTitle() {
  return ''
}

function run(cmd) {
  if (isDisabled(cmd)) return
  emit('command', cmd.id)
}
</script>

<template>
  <div class="ribbon">
    <div class="ribbon-tabs">
      <button
        v-if="persistenceEnabled"
        class="project-btn"
        :title="currentProjectName || 'Project'"
        @click="emit('command', 'open-project-picker')"
      >
        {{ currentProjectName || '—' }}
        <span class="project-caret">▾</span>
      </button>
      <span v-else class="brand">websfm</span>

      <button
        v-for="tab in tabs"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeTab }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>

      <template v-if="activeImageId">
        <div class="ctx-separator"></div>
        <button
          class="tab ctx-tab"
          :class="{ active: activeTab === 'picture' }"
          @click="activeTab = 'picture'"
        >
          {{ activeImageName || 'Image' }}
        </button>
      </template>

      <template v-if="activeRaster">
        <div class="ctx-separator"></div>
        <button
          class="tab ctx-tab"
          :class="{ active: activeTab === 'raster' }"
          @click="activeTab = 'raster'"
        >
          {{ activeRaster.name || rasterTab.label }}
        </button>
      </template>
    </div>

    <div class="ribbon-body">
      <template v-for="group in currentTab.groups" :key="group.label">
        <div v-if="!group.hidden" class="group">
          <div class="group-commands">
            <template v-for="(item, i) in group.commands" :key="item.id || `pair-${i}`">
              <!-- A stacked pair of two half-height buttons in one button's footprint -->
              <div v-if="item.pair" class="cmd-pair">
                <button
                  v-for="cmd in item.pair"
                  v-show="!isHidden(cmd)"
                  :key="cmd.id"
                  class="cmd cmd-small"
                  :class="{ active: isActive(cmd), disabled: isDisabled(cmd) }"
                  :aria-disabled="isDisabled(cmd)"
                  :title="isDisabled(cmd) ? disabledReason(cmd) : cmdLabel(cmd)"
                  @click="run(cmd)"
                >
                  <Icon :name="cmdIcon(cmd)" class="cmd-icon-sm" />
                  <span class="cmd-label-sm">{{ cmdLabel(cmd) }}</span>
                </button>
              </div>
              <button
                v-else
                v-show="!isHidden(item)"
                class="cmd"
                :class="{ active: isActive(item), danger: item.danger, disabled: isDisabled(item) }"
                :aria-disabled="isDisabled(item)"
                :title="isDisabled(item) ? disabledReason(item) : cmdTitle(item)"
                @click="run(item)"
              >
                <Icon :name="cmdIcon(item)" class="cmd-icon" />
                <span class="cmd-label">{{ cmdLabel(item) }}</span>
              </button>
            </template>
          </div>
          <div class="group-label">
            {{ group.label }}<span v-if="group.dynamic" class="group-badge">{{ group.dynamic }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ribbon {
  flex-shrink: 0;
  background: var(--panel);
  border-bottom: 1px solid var(--panel-border);
  user-select: none;
}

.ribbon-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px;
  border-bottom: 1px solid var(--panel-border);
}

.brand {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin-right: 10px;
  padding: 6px 0;
}

.project-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  background: none;
  border: none;
  color: var(--text);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.03em;
  padding: 5px 8px 5px 0;
  margin-right: 6px;
  cursor: pointer;
  border-radius: 4px;
  max-width: 180px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-btn:hover {
  color: var(--accent);
}

.project-caret {
  font-size: 9px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.tab {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 12px;
  padding: 7px 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.ribbon-body {
  display: flex;
  gap: 0;
  padding: 5px 6px;
  min-height: 72px;
  overflow-x: auto;
}

.group {
  display: flex;
  flex-direction: column;
  padding: 0 8px;
  border-right: 1px solid var(--panel-border);
}

.group:last-child {
  border-right: none;
}

.group-commands {
  display: flex;
  gap: 3px;
  flex: 1;
  align-items: flex-start;
  /* A group is as wide as its widest child — which is often the *label*, not the
     buttons ("Ground Control" over one narrow GCP button). Without this the buttons
     hug the left edge while the centered label makes them look mis-aligned. */
  justify-content: center;
}

.group-label {
  /* Fixed content height + centering so the bordered dynamic badge (3D/2D)
     can't grow the label's line-box and push the whole ribbon 1px taller. */
  display: flex;
  align-items: center;
  justify-content: center;
  height: 12px;
  box-sizing: content-box;
  font-size: 10px;
  color: var(--text-dim);
  padding-top: 4px;
}

.cmd {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 50px;
  padding: 5px 8px;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text);
  cursor: pointer;
  font: inherit;
}

.cmd:hover:not(.disabled) {
  background: var(--hover-bg);
  border-color: var(--panel-border);
}

.cmd.active {
  background: rgba(14, 99, 156, 0.25);
  border-color: var(--accent);
}

.cmd.disabled {
  opacity: 0.4;
  cursor: default;
}

.cmd.danger       { color: #c0604a; }
.cmd.danger:hover:not(.disabled) { background: rgba(220, 80, 60, 0.1); border-color: rgba(220, 80, 60, 0.3); }

.cmd-icon {
  width: 18px;
  height: 18px;
}

/* Two small buttons stacked in the footprint of one normal button. */
.cmd-pair {
  display: flex;
  flex-direction: column;
  gap: 3px;
  align-self: stretch;
}

.cmd-small {
  flex: 1;
  flex-direction: row;
  justify-content: flex-start;
  gap: 6px;
  min-width: 64px;
  padding: 4px 8px;
}

.cmd-icon-sm {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.cmd-label-sm {
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
}

.group-badge {
  display: inline-block;
  margin-left: 5px;
  padding: 0 4px;
  border-radius: 6px;
  font-size: 8px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 0.03em;
  color: #e8a820;
  border: 1px solid rgba(232, 168, 32, 0.5);
  vertical-align: middle;
}

.cmd-label {
  font-size: 10px;
  line-height: 1.2;
  /* Reserve two lines so single-line labels keep the same button height
     across tabs (otherwise the Other tab collapses shorter). */
  min-height: 24px;
  text-align: center;
  white-space: pre-line;
}

.ctx-separator {
  width: 1px;
  background: var(--panel-border);
  margin: 4px 8px;
  align-self: stretch;
}

.ctx-tab {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #d4900a !important;
}

.ctx-tab:hover {
  color: #e8a820 !important;
}

.ctx-tab.active {
  color: #e8a820 !important;
  border-bottom-color: #d4900a !important;
}
</style>
