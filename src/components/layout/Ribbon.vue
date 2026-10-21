<script setup>
import { ref, computed, watch } from 'vue'
import Icon from '../Icon.vue'
import RibbonMenu from './RibbonMenu.vue'
import { commandReason } from '../../core/help/commands.js'
import {
  TABS,
  CAMERA_GROUP,
  SCENE_GROUP,
  MAP_GROUP,
  PICTURE_TAB,
  rasterTab as buildRasterTab,
  measureMenu,
  menuReason,
  stepValue,
} from '../../core/help/ribbonTabs.js'

// Renders the command tables in core/help/ribbonTabs.js. The ribbon only CHOOSES
// (opens, toggles, sets a display value); a running tool's own controls live in
// its floating toolbox in the view. Prerequisites go through the one shared
// guard table (core/help/commands.js NEED_CHECKS), so the ribbon and the console
// command line can never disagree about why something is unavailable.
const props = defineProps({
  activeView: { type: String, default: 'viewer' },
  // App.vue `commandState`: the counts/flags NEED_CHECKS reads.
  state: { type: Object, default: () => ({}) },
  // Display toggles and values the View tab shows as active / as stepper values:
  // { showCameras, showGrid, showLegend, showMapGrid, showMapCameras, showFootprints, pointSize,
  //   cameraScale, selectRect, selectLasso, mapGcpEdit, mapBasemap,
  //   mapBasemapReasons: { [value]: why that base layer is unavailable } }.
  viewState: { type: Object, default: () => ({}) },
  activeImageId: { type: String, default: null },
  activeImageName: { type: String, default: null },
  imageViewState: { type: Object, default: null },
  // The raster tab currently in front, if any: { kind: 'dem'|'ortho',
  // imported: boolean, visible: boolean, mapBlocked?: string — why a computed product
  // cannot go on the map }. Drives the contextual Raster tab, the
  // exact mirror of PICTURE_TAB for an image tab.
  activeRaster: { type: Object, default: null },
  // The 2D map's measuring context (App): { targets: [{ id, name, kind }],
  // targetId, kind (the target's), measure (RasterMeasurements state) } — null
  // when no raster is on the map. Adds the target rows to Tools ▸ Measure ▾.
  mapMeasure: { type: Object, default: null },
  consoleOpen: { type: Boolean, default: false },
  persistenceEnabled: { type: Boolean, default: false },
  currentProjectName: { type: String, default: null },
  sceneType: { type: String, default: null },
})

// `command` carries (id) or, for a stepper, (id, newValue).
const emit = defineEmits(['command'])

const rasterTab = computed(() => buildRasterTab(props.activeRaster))
// Whose Measure tools the ribbon is showing: the raster tab in front, else the 2D
// map's target. Same commands, same state shape, one set of checks below.
const measureCtx = computed(() => props.activeRaster ?? (props.activeView === 'map' ? props.mapMeasure : null))

const activeTab = ref('view')

watch(
  () => !!props.activeImageId,
  (hasImage) => {
    if (hasImage) {
      activeTab.value = 'picture'
    } else if (activeTab.value === 'picture') {
      activeTab.value = 'view'
    }
  },
)

watch(
  () => !!props.activeRaster,
  (hasRaster) => {
    if (hasRaster) {
      activeTab.value = 'raster'
    } else if (activeTab.value === 'raster') {
      activeTab.value = 'view'
    }
  },
)

const allTabs = computed(() => {
  const extra = []
  if (props.activeImageId) extra.push(PICTURE_TAB)
  if (props.activeRaster) extra.push(rasterTab.value)
  return extra.length ? [...TABS, ...extra] : TABS
})
const currentTab = computed(() => {
  const tab = allTabs.value.find((t) => t.id === activeTab.value) || TABS[0]
  if (tab.id === 'view') {
    // The contextual groups track the *active viewer*, not merely "not map": while
    // an image detail tab is open activeView is neither, so no 3D/2D group applies.
    // Display only — the tools these views run are in the Tools tab.
    if (props.activeView === 'map') return { ...tab, groups: [...tab.groups, MAP_GROUP] }
    if (props.activeView === 'viewer') return { ...tab, groups: [...tab.groups, CAMERA_GROUP, SCENE_GROUP] }
    return tab
  }
  if (tab.id === 'tools' && props.activeView === 'map' && !props.activeRaster && props.mapMeasure?.targets?.length) {
    // The map stacks rasters, so its Measure menu also picks which one is measured.
    const menu = measureMenu(props.mapMeasure)
    return {
      ...tab,
      groups: tab.groups.map((g) => ({
        ...g,
        commands: g.commands.map((c) => (c.id === 'menu-measure' ? { ...c, menu } : c)),
      })),
    }
  }
  return tab
})

function isHidden(cmd) {
  // `aerialOnly` deliberately does NOT hide: an object-capture project greys the
  // command out with a reason instead, the same discoverability rule the Evaluate
  // hub follows. Hiding made a whole ribbon group silently vanish, which reads as
  // a broken build rather than as "not applicable here".
  // Film-only overlays (fiducial marks) show only for a scanned-film image tab.
  // (A DEM-only measure row is greyed with its reason, not hidden: a menu never
  // hides a row by state.)
  if (cmd.filmOnly && !props.imageViewState?.isFilm) return true
  return false
}

// Keys answered by the View tab's display state rather than the image view.
const VIEW_KEYS = new Set([
  'showCameras',
  'showGrid',
  'showLegend',
  'showMapGrid',
  'showMapCameras',
  'showFootprints',
  'selectRect',
  'selectLasso',
  'mapModelFrame',
])

function isActive(cmd) {
  // A disabled toggle never renders as "on": its state refers to data that isn't
  // there yet (an empty project's Footprints toggle defaults to showFootprints
  // true, so it drew as an active-but-greyed button that shows nothing), and the
  // user can't click it to find out otherwise.
  if (isDisabled(cmd)) return false
  if (cmd.activeKey === 'consoleOpen') return props.consoleOpen
  if (VIEW_KEYS.has(cmd.activeKey)) return !!props.viewState[cmd.activeKey]
  if (cmd.activeKey === 'rasterVisible') return !!props.activeRaster?.visible
  if (cmd.selected !== undefined) return cmd.selected // a map measure-target row
  if (cmd.basemap) return props.viewState.mapBasemap === cmd.basemap
  // Edit GCPs is one mode per view: the map's own flag, else the image view's.
  if (cmd.activeKey === 'gcpEdit' && props.activeView === 'map') return !!props.viewState.mapGcpEdit
  if (cmd.measureTool) return measureCtx.value?.measure?.tool === cmd.measureTool
  if (cmd.activeKey === 'measureSaved') return !!measureCtx.value?.measure?.showSaved
  const s = props.imageViewState
  if (!s || !cmd.activeKey) return false
  return !!s[cmd.activeKey]
}

// One list: a command is disabled exactly when it has a reason to be. Two parallel
// copies of these checks drifted once (a greyed Footprints toggle with an empty
// tooltip), so the boolean is derived rather than restated.
function isDisabled(cmd) {
  return disabledReason(cmd) !== ''
}

function disabledReason(cmd) {
  // Coming-soon, aerial-only and prerequisites: the console's checks too.
  const base = commandReason(cmd, { ...props.state, sceneType: props.sceneType })
  if (base) return base
  const m = measureCtx.value?.measure
  if (cmd.demOnly && measureCtx.value?.kind !== 'dem')
    return props.activeRaster
      ? 'Needs a DEM — this is an orthophoto'
      : 'Needs a DEM — pick a DEM layer to measure below'
  if (cmd.measureTool && !m?.available)
    return 'Measuring needs a current frame with linear coordinates (not geographic, not an outdated frame)'
  if (cmd.measureTool && cmd.demOnly && !m?.heights) return 'Needs the DEM elevation values, which are not loaded yet'
  if (cmd.needsSavedMeasurements && !m?.savedCount) return 'No saved measurements on this raster yet'
  // A computed product in the local frame has no map position (productLayers.js).
  if (cmd.activeKey === 'rasterVisible' && props.activeRaster?.mapBlocked) return props.activeRaster.mapBlocked
  if (cmd.id === 'raster-style' && props.activeRaster?.imported && !props.activeRaster.styleable)
    return 'Nothing to style — an 8-bit raster with up to 3 bands is shown as it is'
  if (cmd.basemap && props.viewState.mapBasemapReasons?.[cmd.basemap])
    return props.viewState.mapBasemapReasons[cmd.basemap]
  const s = props.imageViewState
  if (cmd.disableKey === 'kpNotDone' && s?.kpStatus !== 'done') return 'Detect keypoints first'
  if (cmd.disableKey === 'noMask' && !s?.hasMask) return 'No mask available'
  if (cmd.disableKey === 'noDepth' && !s?.hasDepth) return 'No depth map available'
  if (cmd.disableKey === 'noGcps' && !s?.gcpCount) return 'No GCPs on this image'
  return ''
}

// A row that is a mode (it has an on state) or an option (a map measure target,
// a base layer).
const isToggleRow = (row) => !!(row.activeKey || row.measureTool || row.selected !== undefined || row.basemap)

// A menu's rows, resolved: each real row carries its own disabled reason (printed
// inline in the menu) and, for a mode, whether it is on; sections pass through;
// hidden rows are dropped.
function menuRows(cmd) {
  return cmd.menu
    .filter((row) => row.section || !isHidden(row))
    .map((row) =>
      row.section ? row : { ...row, reason: disabledReason(row), active: isToggleRow(row) ? isActive(row) : undefined },
    )
}
// A menu whose tool is running shows as on, so a mode entered from a menu is
// visible without opening it (a chosen target is an option, not a running tool).
function menuActive(cmd) {
  return cmd.menu.some((row) => !row.section && (row.activeKey || row.measureTool) && isActive(row))
}
function menuDisabledReason(cmd) {
  return menuReason(
    cmd.menu.filter((row) => row.section || !isHidden(row)),
    disabledReason,
  )
}

function cmdLabel(cmd) {
  return cmd.labelFn ? cmd.labelFn(props.imageViewState) : cmd.label
}

function run(cmd) {
  if (isDisabled(cmd)) return
  emit('command', cmd.id)
}

function stepperValue(cmd) {
  return props.viewState[cmd.valueKey]
}
function stepperText(cmd) {
  const v = stepperValue(cmd)
  if (!Number.isFinite(v)) return '—'
  return cmd.format ? cmd.format(v) : String(v)
}
function step(cmd, dir) {
  const next = stepValue(cmd, stepperValue(cmd), dir)
  if (next !== stepperValue(cmd)) emit('command', cmd.id, next)
}
</script>

<template>
  <div class="ribbon">
    <div class="ribbon-tabs">
      <button
        v-if="persistenceEnabled"
        class="project-btn"
        :title="currentProjectName || 'Project'"
        @mousedown.stop
        @click="emit('command', 'open-project-picker')"
      >
        {{ currentProjectName || '—' }}
        <span class="project-caret">▾</span>
      </button>
      <span v-else class="brand">websfm</span>

      <button
        v-for="tab in TABS"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeTab }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>

      <template v-if="activeImageId">
        <div class="ctx-separator"></div>
        <button class="tab ctx-tab" :class="{ active: activeTab === 'picture' }" @click="activeTab = 'picture'">
          {{ activeImageName || 'Image' }}
        </button>
      </template>

      <template v-if="activeRaster">
        <div class="ctx-separator"></div>
        <button class="tab ctx-tab" :class="{ active: activeTab === 'raster' }" @click="activeTab = 'raster'">
          {{ activeRaster.name || rasterTab.label }}
        </button>
      </template>
    </div>

    <div class="ribbon-body">
      <template v-for="group in currentTab.groups" :key="group.label">
        <div v-if="!group.hidden" class="group">
          <div class="group-commands">
            <template v-for="(item, i) in group.commands" :key="item.id || `pair-${i}`">
              <!-- A stacked pair of two half-height rows in one button's footprint -->
              <div v-if="item.pair" class="cmd-pair">
                <template v-for="cmd in item.pair" :key="cmd.id">
                  <div v-if="cmd.stepper" class="stepper" :title="cmd.label">
                    <Icon :name="cmd.icon" class="cmd-icon-sm" />
                    <span class="cmd-label-sm stepper-label">{{ cmd.label }}</span>
                    <button
                      class="step-btn"
                      :aria-label="`Smaller ${cmd.label.toLowerCase()}`"
                      :disabled="stepperValue(cmd) <= cmd.min"
                      @click="step(cmd, -1)"
                    >
                      −
                    </button>
                    <span class="step-val">{{ stepperText(cmd) }}</span>
                    <button
                      class="step-btn"
                      :aria-label="`Larger ${cmd.label.toLowerCase()}`"
                      :disabled="stepperValue(cmd) >= cmd.max"
                      @click="step(cmd, 1)"
                    >
                      +
                    </button>
                  </div>
                  <button
                    v-else
                    v-show="!isHidden(cmd)"
                    class="cmd cmd-small"
                    :class="{ active: isActive(cmd), disabled: isDisabled(cmd) }"
                    :aria-disabled="isDisabled(cmd)"
                    :title="isDisabled(cmd) ? disabledReason(cmd) : cmdLabel(cmd)"
                    @click="run(cmd)"
                  >
                    <Icon :name="cmd.icon" class="cmd-icon-sm" />
                    <span class="cmd-label-sm">{{ cmdLabel(cmd) }}</span>
                  </button>
                </template>
              </div>
              <RibbonMenu
                v-else-if="item.menu"
                :label="item.label"
                :icon="item.icon"
                :rows="menuRows(item)"
                :reason="menuDisabledReason(item)"
                :active="menuActive(item)"
                @run="(id) => emit('command', id)"
              />
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

.cmd.danger {
  color: #c0604a;
}
.cmd.danger:hover:not(.disabled) {
  background: rgba(220, 80, 60, 0.1);
  border-color: rgba(220, 80, 60, 0.3);
}

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

/* A half-height "− value +" row (display values like point size). */
.stepper {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 2px 4px 2px 8px;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text);
}
.stepper:hover {
  border-color: var(--panel-border);
}
.stepper-label {
  min-width: 44px;
}
.step-btn {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0;
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.step-btn:hover:not(:disabled) {
  background: var(--hover-bg);
}
.step-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
.step-val {
  min-width: 30px;
  text-align: center;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
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
