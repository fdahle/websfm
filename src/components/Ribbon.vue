<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  activeView: { type: String, default: 'viewer' },
  hasSelection: { type: Boolean, default: false },
  imageCount: { type: Number, default: 0 },
  matchCount: { type: Number, default: 0 },
  activeImageId: { type: String, default: null },
  activeImageName: { type: String, default: null },
  imageViewState: { type: Object, default: null },
  consoleOpen: { type: Boolean, default: false },
  persistenceEnabled: { type: Boolean, default: false },
  currentProjectName: { type: String, default: null },
  sceneType: { type: String, default: null },
})

const emit = defineEmits(['command'])

const tabs = [
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Camera',
        commands: [
          { id: 'view-preset-top',   label: 'Top\nView',   icon: '⬆', disabled: true },
          { id: 'view-preset-side',  label: 'Side\nView',  icon: '◧', disabled: true },
          { id: 'view-preset-front', label: 'Front\nView', icon: '▣', disabled: true },
          { id: 'reset-view',        label: 'Reset\nView', icon: '⊙', disabled: true },
        ],
      },
      {
        label: 'Panels',
        commands: [
          { id: 'toggle-console', label: 'Console', icon: '>_', activeKey: 'consoleOpen' },
        ],
      },
    ],
  },
  {
    id: 'import',
    label: 'Import',
    groups: [
      {
        label: 'Images',
        commands: [
          { id: 'import-images', label: 'Images', icon: '🖼️' },
        ],
      },
      {
        label: 'Camera',
        commands: [
          { id: 'import-camera-list', label: 'Camera\nList', icon: '📷', disabled: true },
          { id: 'import-calib', label: 'Calibration', icon: '🎯', disabled: true },
        ],
      },
      {
        label: 'Ground Control',
        commands: [
          { id: 'import-gcps', label: 'GCP\nFile', icon: '📍', aerialOnly: true, disabled: true },
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
          { id: 'detect-features', label: 'Detect\nFeatures', icon: '✨', needsImages: true },
          { id: 'match-features', label: 'Match\nFeatures', icon: '🔗', needsImages: true },
        ],
      },
      {
        label: 'Reconstruction',
        commands: [
          { id: 'reconstruct', label: 'Sparse\nModel', icon: '⠿', needsMatches: true },
          { id: 'dense',       label: 'Dense\nModel',  icon: '☁',  disabled: true },
        ],
      },
      {
        label: 'Results',
        commands: [
          { id: 'open-metadata',   label: 'Metadata\nTable', icon: '📋', needsImages: true },
          { id: 'open-match-list', label: 'Match\nList',     icon: '🔗' },
        ],
      },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    groups: [
      {
        label: 'Export',
        commands: [
          { id: 'export-cameras', label: 'Camera\nPoses', icon: '📷', disabled: true },
          { id: 'export-cloud', label: 'Point\nCloud', icon: '💾', disabled: true },
        ],
      },
    ],
  },
  {
    id: 'other',
    label: 'Other',
    groups: [
      {
        label: 'App',
        commands: [
          { id: 'open-settings', label: 'Settings', icon: '⚙' },
          { id: 'open-about',    label: 'About',    icon: 'ℹ' },
        ],
      },
    ],
  },
]

const pictureTab = {
  id: 'picture',
  label: 'Picture',
  contextual: true,
  groups: [
    {
      label: 'Toggles',
      commands: [
        {
          id: 'img-toggle-keypoints',
          labelFn: (s) => s?.kpCount ? `KP\n${s.kpCount}` : 'Keypoints',
          icon: '⊙',
          activeKey: 'showKeypoints',
          disableKey: 'kpNotDone',
        },
        {
          id: 'img-toggle-mask',
          label: 'Mask',
          icon: '◑',
          activeKey: 'showMask',
          disableKey: 'noMask',
        },
      ],
    },
    {
      label: 'Mask',
      commands: [
        { id: 'img-mask-draw',   label: 'Draw',   icon: '✏', activeKey: 'maskDraw' },
        { id: 'img-mask-erase',  label: 'Erase',  icon: '◻', activeKey: 'maskErase' },
        { id: 'img-mask-import', label: 'Import', icon: '📥' },
        { id: 'img-mask-clear',  label: 'Clear',  icon: '✕', disableKey: 'noMask' },
      ],
    },
    {
      id: 'brush',
      label: 'Brush',
      maskOnly: true,
      commands: [
        { id: 'img-brush-s', label: 'Small',  icon: '·', activeKey: 'brushS' },
        { id: 'img-brush-m', label: 'Medium', icon: '○', activeKey: 'brushM' },
        { id: 'img-brush-l', label: 'Large',  icon: '●', activeKey: 'brushL' },
      ],
    },
    {
      label: 'Image',
      commands: [
        { id: 'img-show-info', label: 'Image\nInfo', icon: 'ℹ' },
        { id: 'img-remove',    label: 'Remove',      icon: '✖', danger: true },
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
const currentTab = computed(() => allTabs.value.find((t) => t.id === activeTab.value) || tabs[0])

function isHidden(cmd) {
  return cmd.aerialOnly && props.sceneType === 'object'
}

function isActive(cmd) {
  if (cmd.view != null && cmd.view === props.activeView) return true
  if (cmd.activeKey === 'consoleOpen') return props.consoleOpen
  const s = props.imageViewState
  if (!s || !cmd.activeKey) return false
  switch (cmd.activeKey) {
    case 'showKeypoints': return s.showKeypoints
    case 'showMask':      return s.showMask
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
  if (cmd.needsMatches  && props.matchCount === 0) return true
  const s = props.imageViewState
  if (cmd.disableKey === 'kpNotDone' && s?.kpStatus !== 'done') return true
  if (cmd.disableKey === 'noMask'    && !s?.hasMask)            return true
  return false
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
            <button
              v-for="cmd in group.commands"
              v-show="!isHidden(cmd)"
              :key="cmd.id"
              class="cmd"
              :class="{ active: isActive(cmd), danger: cmd.danger }"
              :disabled="isDisabled(cmd)"
              :title="cmd.disabled ? 'Coming soon' : ''"
              @click="run(cmd)"
            >
              <span class="cmd-icon">{{ cmd.icon }}</span>
              <span class="cmd-label">{{ cmdLabel(cmd) }}</span>
            </button>
          </div>
          <div class="group-label">{{ group.label }}</div>
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

.cmd:hover:not(:disabled) {
  background: var(--hover-bg);
  border-color: var(--panel-border);
}

.cmd.active {
  background: rgba(14, 99, 156, 0.25);
  border-color: var(--accent);
}

.cmd:disabled {
  opacity: 0.4;
  cursor: default;
}

.cmd.danger       { color: #c0604a; }
.cmd.danger:hover:not(:disabled) { background: rgba(220, 80, 60, 0.1); border-color: rgba(220, 80, 60, 0.3); }

.cmd-icon {
  font-size: 18px;
  line-height: 1;
}

.cmd-label {
  font-size: 10px;
  line-height: 1.2;
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
