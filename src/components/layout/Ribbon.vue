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
  sparseReady: { type: Boolean, default: false },
  depthMapCount: { type: Number, default: 0 },
  cloudReady: { type: Boolean, default: false },
  denseReady: { type: Boolean, default: false },
  meshReady: { type: Boolean, default: false },
  demReady: { type: Boolean, default: false },
  orthoReady: { type: Boolean, default: false },
  productReady: { type: Boolean, default: false },
  activeImageId: { type: String, default: null },
  activeImageName: { type: String, default: null },
  imageViewState: { type: Object, default: null },
  consoleOpen: { type: Boolean, default: false },
  persistenceEnabled: { type: Boolean, default: false },
  currentProjectName: { type: String, default: null },
  sceneType: { type: String, default: null },
  showCameras: { type: Boolean, default: true },
  showGraticule: { type: Boolean, default: true },
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
          { id: 'open-gcp-table',    label: 'GCPs',    icon: 'map-pin', aerialOnly: true, needsImages: true },
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
        label: 'Camera',
        commands: [
          { id: 'import-camera-list', label: 'Camera\nPoses', icon: 'camera' },
          { id: 'import-calib', label: 'Calibration', icon: 'target' },
        ],
      },
      {
        label: 'Ground Control',
        commands: [
          { id: 'import-gcps', label: 'GCP\nFile', icon: 'map-pin', aerialOnly: true, needsImages: true },
        ],
      },
      {
        label: 'Interop',
        commands: [
          { id: 'import-colmap', label: 'COLMAP\nModel', icon: 'cube', needsImages: true },
          { id: 'import-cloud', label: 'Point Cloud\n/ Mesh', icon: 'point-cloud' },
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
      {
        label: 'Reconstruction',
        commands: [
          { id: 'reconstruct',   label: 'Sparse\nModel', icon: 'cube',        needsMatches: true },
          { id: 'compute-depth', label: 'Depth\nMaps',   icon: 'cloud',       needsSparse: true },
          { id: 'dense',         label: 'Dense\nModel',  icon: 'point-cloud', needsDepthMaps: true },
        ],
      },
      {
        label: 'Products',
        commands: [
          { id: 'gen-dem',       label: 'DEM',     icon: 'dem',   needsCloud: true, aerialOnly: true },
          { id: 'gen-ortho',     label: 'Ortho',   icon: 'ortho', needsDem: true, needsDepthMaps: true, aerialOnly: true },
          { id: 'gen-mesh',      label: 'Mesh',    icon: 'cube',  needsDense: true },
        ],
      },
    ],
  },
  {
    id: 'tools',
    label: 'Tools',
    groups: [
      {
        label: 'Footprints',
        commands: [
          { id: 'footprints-from-poses', label: 'From\nPoses', icon: 'footprint', needsPoses: true, needsSensors: true, aerialOnly: true },
        ],
      },
      {
        label: 'Georeferencing',
        commands: [
          { id: 'auto-georeference', label: 'Auto\nGeoref', icon: 'target', needsSparse: true, needsPoses: true, aerialOnly: true },
        ],
      },
      {
        label: 'Masks',
        commands: [
          { id: 'auto-mask', label: 'Auto\nMask', icon: 'mask', needsImages: true, needsImagesReady: true },
        ],
      },
      {
        label: 'Point Cloud',
        commands: [
          { id: 'filter-cloud', label: 'Filter\nCloud', icon: 'point-cloud', disabled: true },
        ],
      },
    ],
  },
  {
    // Quality/accuracy views over existing pipeline state (run summaries,
    // gcpAccuracyReport, match graph). All placeholders for now — see TODO F13.
    id: 'evaluate',
    label: 'Evaluate',
    groups: [
      {
        label: 'Sparse',
        commands: [
          { id: 'eval-reconstruction', label: 'Recon\nReport',   icon: 'cube',   disabled: true },
          { id: 'eval-images',         label: 'Image\nErrors',   icon: 'table',  disabled: true },
          { id: 'eval-calibration',    label: 'Calibration',     icon: 'target', disabled: true },
        ],
      },
      {
        label: 'Georeferencing',
        commands: [
          { id: 'eval-gcps',  label: 'GCP\nAccuracy',   icon: 'map-pin', disabled: true, aerialOnly: true },
          { id: 'eval-poses', label: 'Pose\nResiduals', icon: 'camera',  disabled: true, aerialOnly: true },
        ],
      },
      {
        label: 'Matching',
        commands: [
          { id: 'eval-match-graph', label: 'Graph\nHealth', icon: 'link', disabled: true },
        ],
      },
      {
        label: 'Dense',
        commands: [
          { id: 'eval-depth-coverage', label: 'Depth\nCoverage', icon: 'depth', disabled: true },
          { id: 'eval-dem-gcps',       label: 'DEM vs\nGCPs',    icon: 'dem',   disabled: true, aerialOnly: true },
        ],
      },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    groups: [
      {
        label: 'Scene',
        commands: [
          { id: 'export-cameras', label: 'Camera\nPoses', icon: 'camera', needsPoses: true },
          { id: 'export-sensors', label: 'Sensors',       icon: 'target', needsSensors: true },
          { id: 'export-cloud',   label: 'Point\nCloud',  icon: 'point-cloud', needsCloud: true },
          { id: 'export-model',   label: 'Model\nJSON',   icon: 'cube',        needsCloud: true },
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
        label: 'Products',
        commands: [
          { id: 'export-mesh',  label: 'Mesh',  icon: 'cube',  needsMesh: true },
          { id: 'export-dem',   label: 'DEM',   icon: 'dem',   needsDem: true, aerialOnly: true },
          { id: 'export-ortho', label: 'Ortho', icon: 'ortho', needsOrtho: true, aerialOnly: true },
        ],
      },
      {
        label: 'Interop',
        commands: [
          { id: 'export-colmap', label: 'COLMAP\nModel', icon: 'cube', needsCloud: true },
        ],
      },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    groups: [
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
          { id: 'open-settings', label: 'Settings', icon: 'settings' },
          { id: 'open-about',    label: 'About',    icon: 'info' },
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

// 3D scene display toggles (cameras / graticule). Sits beside the camera presets
// when the 3D viewer is active.
const sceneGroup = {
  label: 'Scene',
  dynamic: '3D',
  commands: [
    { id: 'view-toggle-cameras',   label: 'Cameras',   icon: 'camera', activeKey: 'showCameras' },
    { id: 'view-toggle-graticule', label: 'Graticule', icon: 'grid',   activeKey: 'showGraticule' },
  ],
}

const mapGroup = {
  label: 'Map',
  dynamic: '2D',
  commands: [
    { id: 'map-fit-view',          label: 'Fit\nView',   icon: 'fit-view' },
    { id: 'map-toggle-graticule',  label: 'Graticule',   icon: 'grid',      disabled: true },
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
  ],
}

const activeTab = ref('view')

watch(() => !!props.activeImageId, (hasImage) => {
  if (hasImage) {
    activeTab.value = 'picture'
  } else if (activeTab.value === 'picture') {
    activeTab.value = 'view'
  }
})

const allTabs = computed(() => (props.activeImageId ? [...tabs, pictureTab] : tabs))
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
  if (cmd.aerialOnly && props.sceneType === 'object') return true
  // Film-only overlays (fiducial marks) show only for a scanned-film image tab.
  if (cmd.filmOnly && !props.imageViewState?.isFilm) return true
  return false
}

function isActive(cmd) {
  if (cmd.view != null && cmd.view === props.activeView) return true
  if (cmd.activeKey === 'consoleOpen')   return props.consoleOpen
  if (cmd.activeKey === 'showCameras')   return props.showCameras
  if (cmd.activeKey === 'showGraticule') return props.showGraticule
  if (cmd.activeKey === 'showFootprints') return props.showFootprints
  const s = props.imageViewState
  if (!s || !cmd.activeKey) return false
  switch (cmd.activeKey) {
    case 'showKeypoints': return s.showKeypoints
    case 'showMask':      return s.showMask
    case 'showDepth':     return s.showDepth
    case 'showGcps':      return s.showGcps
    case 'showFiducials': return s.showFiducials
    case 'maskEdit':      return s.maskEdit
  }
  return false
}

function isDisabled(cmd) {
  if (cmd.disabled) return true
  if (cmd.needsSelection && !props.hasSelection) return true
  if (cmd.needsImages   && props.imageCount === 0) return true
  if (cmd.needsImagesReady && props.imagesLoading) return true
  if (cmd.needsMatches   && props.matchCount === 0)   return true
  if (cmd.needsSparse    && !props.sparseReady)       return true
  if (cmd.needsDepthMaps && props.depthMapCount === 0) return true
  if (cmd.needsCloud     && !props.cloudReady)        return true
  if (cmd.needsDense     && !props.denseReady)        return true
  if (cmd.needsMesh      && !props.meshReady)         return true
  if (cmd.needsDem       && !props.demReady)          return true
  if (cmd.needsOrtho     && !props.orthoReady)        return true
  if (cmd.needsProducts  && !props.productReady)      return true
  if (cmd.needsKeypoints && props.kpImageCount === 0) return true
  if (cmd.needsGcps     && props.gcpCount === 0)   return true
  if (cmd.needsPoses    && props.poseCount === 0)  return true
  if (cmd.needsFootprints && props.footprintCount === 0) return true
  if (cmd.needsSensors  && props.sensorCount === 0) return true
  const s = props.imageViewState
  if (cmd.disableKey === 'kpNotDone' && s?.kpStatus !== 'done') return true
  if (cmd.disableKey === 'noMask'    && !s?.hasMask)            return true
  if (cmd.disableKey === 'noDepth'   && !s?.hasDepth)           return true
  if (cmd.disableKey === 'noGcps'    && !s?.gcpCount)           return true
  return false
}

function disabledReason(cmd) {
  if (cmd.disabled) return 'Coming soon'
  if (cmd.needsImages   && props.imageCount === 0) return 'Import images first'
  if (cmd.needsImagesReady && props.imagesLoading) return 'Images still loading…'
  if (cmd.needsMatches   && props.matchCount === 0)   return 'Run feature matching first'
  if (cmd.needsSparse    && !props.sparseReady)       return 'Build the sparse model first'
  if (cmd.needsDepthMaps && props.depthMapCount === 0) return 'Compute depth maps first'
  if (cmd.needsCloud     && !props.cloudReady)        return 'Build a point cloud first'
  if (cmd.needsDense     && !props.denseReady)        return 'Build a dense cloud first'
  if (cmd.needsMesh      && !props.meshReady)         return 'Build a mesh first'
  if (cmd.needsDem       && !props.demReady)          return 'Build a DEM first'
  if (cmd.needsOrtho     && !props.orthoReady)        return 'Build an orthophoto first'
  if (cmd.needsProducts  && !props.productReady)      return 'Build a DEM or orthophoto first'
  if (cmd.needsKeypoints && props.kpImageCount === 0) return 'Detect keypoints first'
  if (cmd.needsGcps     && props.gcpCount === 0)   return 'Import GCPs first'
  if (cmd.needsPoses    && props.poseCount === 0)  return 'Import camera poses first'
  if (cmd.needsSensors  && props.sensorCount === 0) return 'No sensors available'
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
    </div>

    <div class="ribbon-body">
      <template v-for="group in currentTab.groups" :key="group.label">
        <div class="group">
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
                  <Icon :name="cmd.icon" class="cmd-icon-sm" />
                  <span class="cmd-label-sm">{{ cmdLabel(cmd) }}</span>
                </button>
              </div>
              <button
                v-else
                v-show="!isHidden(item)"
                class="cmd"
                :class="{ active: isActive(item), danger: item.danger, disabled: isDisabled(item) }"
                :aria-disabled="isDisabled(item)"
                :title="isDisabled(item) ? disabledReason(item) : ''"
                @click="run(item)"
              >
                <Icon :name="item.icon" class="cmd-icon" />
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
