<script setup>
import { ref, computed, watch } from 'vue'
import Icon from '../Icon.vue'

const props = defineProps({
  activeView: { type: String, default: 'viewer' },
  hasSelection: { type: Boolean, default: false },
  imageCount: { type: Number, default: 0 },
  matchCount: { type: Number, default: 0 },
  kpImageCount: { type: Number, default: 0 },
  gcpCount: { type: Number, default: 0 },
  poseCount: { type: Number, default: 0 },
  sensorCount: { type: Number, default: 0 },
  sparseReady: { type: Boolean, default: false },
  depthMapCount: { type: Number, default: 0 },
  cloudReady: { type: Boolean, default: false },
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
          { id: 'open-gcp-table',    label: 'GCPs',    icon: 'map-pin', needsGcps: true, aerialOnly: true },
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
          { id: 'import-gcps', label: 'GCP\nFile', icon: 'map-pin', aerialOnly: true },
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
          { id: 'detect-features', label: 'Detect\nFeatures', icon: 'sparkles', needsImages: true },
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
          { id: 'gen-dem',       label: 'DEM',     icon: 'dem',   needsCloud: true },
          { id: 'gen-ortho',     label: 'Ortho',   icon: 'ortho', needsDem: true, needsDepthMaps: true },
          { id: 'view-products', label: 'Preview', icon: 'image', needsProducts: true },
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
          { id: 'auto-mask', label: 'Auto\nMask', icon: 'mask', needsImages: true },
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
          { id: 'export-dem',   label: 'DEM',   icon: 'dem',   needsDem: true },
          { id: 'export-ortho', label: 'Ortho', icon: 'ortho', needsOrtho: true },
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
    { id: 'map-toggle-footprints', label: 'Footprints',  icon: 'footprint', disabled: true },
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
      ],
    },
    {
      label: 'Mask',
      commands: [
        { id: 'img-mask-draw',   label: 'Draw',   icon: 'pencil',   activeKey: 'maskDraw' },
        { id: 'img-mask-erase',  label: 'Erase',  icon: 'eraser',   activeKey: 'maskErase' },
        { id: 'img-mask-import', label: 'Import', icon: 'download' },
        { id: 'img-mask-clear',  label: 'Clear',  icon: 'x', disableKey: 'noMask' },
      ],
    },
    {
      id: 'brush',
      label: 'Brush',
      maskOnly: true,
      commands: [
        { id: 'img-brush-s', label: 'Small',  icon: 'brush-s', activeKey: 'brushS' },
        { id: 'img-brush-m', label: 'Medium', icon: 'brush-m', activeKey: 'brushM' },
        { id: 'img-brush-l', label: 'Large',  icon: 'brush-l', activeKey: 'brushL' },
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
  return cmd.aerialOnly && props.sceneType === 'object'
}

function isActive(cmd) {
  if (cmd.view != null && cmd.view === props.activeView) return true
  if (cmd.activeKey === 'consoleOpen')   return props.consoleOpen
  if (cmd.activeKey === 'showCameras')   return props.showCameras
  if (cmd.activeKey === 'showGraticule') return props.showGraticule
  const s = props.imageViewState
  if (!s || !cmd.activeKey) return false
  switch (cmd.activeKey) {
    case 'showKeypoints': return s.showKeypoints
    case 'showMask':      return s.showMask
    case 'showDepth':     return s.showDepth
    case 'showGcps':      return s.showGcps
    case 'maskDraw':      return s.maskMode === 'draw'
    case 'maskErase':     return s.maskMode === 'erase'
    case 'brushS':        return s.brushRadius === 10
    case 'brushM':        return s.brushRadius === 20
    case 'brushL':        return s.brushRadius === 40
  }
  return false
}

function isDisabled(cmd) {
  if (cmd.disabled) return true
  if (cmd.needsSelection && !props.hasSelection) return true
  if (cmd.needsImages   && props.imageCount === 0) return true
  if (cmd.needsMatches   && props.matchCount === 0)   return true
  if (cmd.needsSparse    && !props.sparseReady)       return true
  if (cmd.needsDepthMaps && props.depthMapCount === 0) return true
  if (cmd.needsCloud     && !props.cloudReady)        return true
  if (cmd.needsDem       && !props.demReady)          return true
  if (cmd.needsOrtho     && !props.orthoReady)        return true
  if (cmd.needsProducts  && !props.productReady)      return true
  if (cmd.needsKeypoints && props.kpImageCount === 0) return true
  if (cmd.needsGcps     && props.gcpCount === 0)   return true
  if (cmd.needsPoses    && props.poseCount === 0)  return true
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
  if (cmd.needsMatches   && props.matchCount === 0)   return 'Run feature matching first'
  if (cmd.needsSparse    && !props.sparseReady)       return 'Build the sparse model first'
  if (cmd.needsDepthMaps && props.depthMapCount === 0) return 'Compute depth maps first'
  if (cmd.needsCloud     && !props.cloudReady)        return 'Build a point cloud first'
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
        <div
          v-if="!group.maskOnly || imageViewState?.maskMode !== 'none'"
          class="group"
        >
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
  text-align: center;
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
