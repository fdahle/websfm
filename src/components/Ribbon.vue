<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  activeView: {
    type: String,
    default: 'viewer',
  },
  hasSelection: {
    type: Boolean,
    default: false,
  },
  imageCount: {
    type: Number,
    default: 0,
  },
  activeImageId: {
    type: String,
    default: null,
  },
  activeImageName: {
    type: String,
    default: null,
  },
})

const emit = defineEmits(['command'])

// Data-driven ribbon definition. Add tabs / groups / commands here.
// A command with `disabled: true` is a placeholder for future work.
const tabs = [
  {
    id: 'home',
    label: 'Home',
    groups: [
      {
        label: 'Session',
        commands: [
          { id: 'clear-all', label: 'Clear\nAll', icon: '🗑️', needsImages: true },
        ],
      },
      {
        label: 'Selection',
        commands: [{ id: 'remove-selected', label: 'Remove\nSelected', icon: '✖', needsSelection: true }],
      },
      {
        label: 'App',
        commands: [{ id: 'open-settings', label: 'Settings', icon: '⚙' }],
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
          { id: 'import-gcps', label: 'GCP\nFile', icon: '📍', disabled: true },
        ],
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Layout',
        commands: [
          { id: 'view-viewer', label: '3D\nViewer', icon: '🧊', view: 'viewer' },
          { id: 'view-table', label: 'Metadata\nTable', icon: '📋', view: 'table' },
        ],
      },
      {
        label: 'Camera',
        commands: [{ id: 'reset-view', label: 'Reset\nView', icon: '🎯', disabled: true }],
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
          { id: 'match-features', label: 'Match\nFeatures', icon: '🔗', disabled: true },
        ],
      },
      {
        label: 'Reconstruction',
        commands: [
          { id: 'sparse', label: 'Sparse\nModel', icon: '⠿', disabled: true },
          { id: 'dense', label: 'Dense\nModel', icon: '☁', disabled: true },
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
]

// Contextual tab shown only when an image tab is active.
const pictureTab = {
  id: 'picture',
  label: 'Picture',
  contextual: true,
  groups: [
    {
      label: 'View',
      commands: [
        { id: 'img-fit', label: 'Fit to\nView', icon: '⊡' },
        { id: 'img-zoom-in', label: 'Zoom\nIn', icon: '⊕' },
        { id: 'img-zoom-out', label: 'Zoom\nOut', icon: '⊖' },
      ],
    },
    {
      label: 'Analysis',
      commands: [
        { id: 'img-detect-sift', label: 'Detect\nSIFT', icon: '✨' },
      ],
    },
    {
      label: 'Image',
      commands: [
        { id: 'img-show-info', label: 'Image\nInfo', icon: 'ℹ' },
        { id: 'img-remove', label: 'Remove', icon: '✖' },
      ],
    },
  ],
}

const activeTab = ref('home')

// Auto-switch to/from Picture tab when image context changes.
watch(() => !!props.activeImageId, (hasImage) => {
  if (hasImage) {
    activeTab.value = 'picture'
  } else if (activeTab.value === 'picture') {
    activeTab.value = 'home'
  }
})

const allTabs = computed(() => (props.activeImageId ? [...tabs, pictureTab] : tabs))
const currentTab = computed(() => allTabs.value.find((t) => t.id === activeTab.value) || tabs[0])

function isActive(cmd) {
  return cmd.view != null && cmd.view === props.activeView
}

function isDisabled(cmd) {
  if (cmd.disabled) return true
  if (cmd.needsSelection && !props.hasSelection) return true
  if (cmd.needsImages && props.imageCount === 0) return true
  return false
}

function run(cmd) {
  if (isDisabled(cmd)) return
  emit('command', cmd.id)
}
</script>

<template>
  <div class="ribbon">
    <div class="ribbon-tabs">
      <span class="brand">websfm</span>
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

      <button class="settings-btn" title="Settings" @click="emit('command', 'open-settings')">⚙</button>
    </div>

    <div class="ribbon-body">
      <div v-for="group in currentTab.groups" :key="group.label" class="group">
        <div class="group-commands">
          <button
            v-for="cmd in group.commands"
            :key="cmd.id"
            class="cmd"
            :class="{ active: isActive(cmd) }"
            :disabled="isDisabled(cmd)"
            :title="cmd.disabled ? 'Coming soon' : ''"
            @click="run(cmd)"
          >
            <span class="cmd-icon">{{ cmd.icon }}</span>
            <span class="cmd-label">{{ cmd.label }}</span>
          </button>
        </div>
        <div class="group-label">{{ group.label }}</div>
      </div>
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

.settings-btn {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  padding: 5px 10px;
  cursor: pointer;
  border-radius: 4px;
  line-height: 1;
}

.settings-btn:hover {
  color: var(--text);
  background: var(--hover-bg);
}
</style>
