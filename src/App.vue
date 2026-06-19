<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import Ribbon from './components/Ribbon.vue'
import Sidebar from './components/Sidebar.vue'
import Viewer from './components/Viewer.vue'
import ImageViewer from './components/ImageViewer.vue'
import ImageInfoModal from './components/ImageInfoModal.vue'
import DetectFeaturesModal from './components/DetectFeaturesModal.vue'
import MetadataTable from './components/MetadataTable.vue'
import { extractMetadata } from './utils/metadata.js'
import { detectKeypoints } from './utils/sift.js'

const images = ref([])
const selectedId = ref(null)
const ribbonInput = ref(null)

const theme = ref(localStorage.getItem('theme') || 'dark')
const settingsOpen = ref(false)
const infoImageId = ref(null)
const detectFeaturesOpen = ref(false)
const infoImage = computed(() => (infoImageId.value ? imageById(infoImageId.value) : null))

function applyTheme(t) {
  if (t === 'light') {
    document.documentElement.setAttribute('data-theme', 'light')
  } else {
    document.documentElement.removeAttribute('data-theme')
  }
}

function setTheme(t) {
  theme.value = t
  applyTheme(t)
  localStorage.setItem('theme', t)
}

onMounted(() => applyTheme(theme.value))

// Main-area tabs. The 3D viewer is always present and is the default tab.
const VIEWER_TAB = { id: 'viewer', type: 'viewer', title: '3D', closable: false }
const tabs = ref([{ ...VIEWER_TAB }])
const activeTabId = ref('viewer')

const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

// The image for whichever image tab is currently active (null otherwise).
const activeImageTab = computed(() => {
  const tab = tabs.value.find((t) => t.id === activeTabId.value)
  return tab?.type === 'image' ? imageById(tab.imageId) : null
})

// Refs to ImageViewer instances, keyed by imageId.
const imageViewerRefs = reactive({})

// For the ribbon's active-state highlighting.
const activeView = computed(() => {
  if (activeTabId.value === 'viewer') return 'viewer'
  if (activeTabId.value === 'metadata') return 'table'
  return ''
})

function imageById(id) {
  return images.value.find((img) => img.id === id) || null
}

function activateTab(id) {
  activeTabId.value = id
}

function openImageTab(id) {
  const img = imageById(id)
  if (!img) return
  const tabId = `img:${id}`
  if (!tabs.value.some((t) => t.id === tabId)) {
    tabs.value.push({ id: tabId, type: 'image', title: img.name, imageId: id, closable: true })
  }
  activeTabId.value = tabId
}

function openMetadataTab() {
  if (!tabs.value.some((t) => t.id === 'metadata')) {
    tabs.value.push({ id: 'metadata', type: 'table', title: 'Metadata', closable: true })
  }
  activeTabId.value = 'metadata'
}

function closeTab(id) {
  const idx = tabs.value.findIndex((t) => t.id === id)
  if (idx === -1 || !tabs.value[idx].closable) return
  const wasActive = activeTabId.value === id
  tabs.value.splice(idx, 1)
  if (wasActive) {
    const next = tabs.value[idx] || tabs.value[idx - 1] || tabs.value[0]
    activeTabId.value = next ? next.id : 'viewer'
  }
}

function addImages(files) {
  for (const file of files) {
    const id = `${file.name}-${file.size}-${file.lastModified}`
    if (images.value.some((img) => img.id === id)) continue
    const item = {
      id,
      name: file.name,
      url: URL.createObjectURL(file),
      file,
      meta: null,
      loading: true,
      keypoints: [],
      kpStatus: 'idle', // 'idle' | 'running' | 'done' | 'error'
      kpCount: 0,
      kpMs: 0,
    }
    images.value.push(item)
    extractMetadata(file, item.url)
      .then((meta) => {
        const found = images.value.find((img) => img.id === id)
        if (found) {
          found.meta = meta
          found.loading = false
        }
      })
      .catch(() => {
        const found = images.value.find((img) => img.id === id)
        if (found) found.loading = false
      })
  }
}

function removeImage(id) {
  const idx = images.value.findIndex((img) => img.id === id)
  if (idx !== -1) {
    URL.revokeObjectURL(images.value[idx].url)
    images.value.splice(idx, 1)
    if (selectedId.value === id) selectedId.value = null
    closeTab(`img:${id}`)
  }
}

function selectImage(id) {
  selectedId.value = id
}

async function detectOne(id, settings = {}) {
  const img = images.value.find((i) => i.id === id)
  if (!img || img.kpStatus === 'running') return
  img.kpStatus = 'running'
  try {
    const res = await detectKeypoints(img.url, settings)
    const found = images.value.find((i) => i.id === id)
    if (found) {
      found.keypoints = res.keypoints
      found.kpCount = res.keypoints.length
      found.kpMs = Math.round(res.ms)
      found.kpStatus = 'done'
    }
  } catch (err) {
    console.error('SIFT detection failed', err)
    const found = images.value.find((i) => i.id === id)
    if (found) found.kpStatus = 'error'
  }
}

async function detectAll(settings = {}) {
  // Sequential so the UI stays responsive between images.
  for (const img of images.value) {
    if (img.kpStatus !== 'done') await detectOne(img.id, settings)
  }
}

function clearAll() {
  for (const img of images.value) URL.revokeObjectURL(img.url)
  images.value = []
  selectedId.value = null
  // Drop all image tabs; keep the permanent 3D tab.
  tabs.value = tabs.value.filter((t) => !t.closable)
  activeTabId.value = 'viewer'
}

function onRibbonPick(event) {
  const files = [...event.target.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) addImages(files)
  event.target.value = ''
}

function handleCommand(id) {
  switch (id) {
    case 'import-images':
      ribbonInput.value.click()
      break
    case 'clear-all':
      clearAll()
      break
    case 'remove-selected':
      if (selectedId.value) removeImage(selectedId.value)
      break
    case 'view-viewer':
      activateTab('viewer')
      break
    case 'view-table':
      openMetadataTab()
      break
    case 'detect-features':
      detectFeaturesOpen.value = true
      break
    case 'open-settings':
      settingsOpen.value = true
      break
    case 'img-fit':
      imageViewerRefs[activeImageTab.value?.id]?.fit()
      break
    case 'img-zoom-in':
      imageViewerRefs[activeImageTab.value?.id]?.zoomIn()
      break
    case 'img-zoom-out':
      imageViewerRefs[activeImageTab.value?.id]?.zoomOut()
      break
    case 'img-detect-sift':
      if (activeImageTab.value) detectOne(activeImageTab.value.id)
      break
    case 'img-show-info':
      if (activeImageTab.value) infoImageId.value = activeImageTab.value.id
      break
    case 'img-remove':
      if (activeImageTab.value) removeImage(activeImageTab.value.id)
      break
    // Remaining Reconstruct / Export commands are placeholders for now.
  }
}
</script>

<template>
  <div class="app">
    <Ribbon
      :active-view="activeView"
      :has-selection="!!selected"
      :image-count="images.length"
      :active-image-id="activeImageTab?.id ?? null"
      :active-image-name="activeImageTab?.name ?? null"
      @command="handleCommand"
    />
    <input ref="ribbonInput" type="file" accept="image/*" multiple hidden @change="onRibbonPick" />

    <Teleport to="body">
      <DetectFeaturesModal
        v-if="detectFeaturesOpen"
        @close="detectFeaturesOpen = false"
        @run="(s) => { detectFeaturesOpen = false; detectAll(s) }"
      />
    </Teleport>

    <Teleport to="body">
      <div v-if="settingsOpen" class="modal-overlay" @click.self="settingsOpen = false" @keydown.esc="settingsOpen = false">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Settings">
          <div class="modal-header">
            <span class="modal-title">Settings</span>
            <button class="modal-close" title="Close" @click="settingsOpen = false">×</button>
          </div>
          <div class="modal-body">
            <div class="setting-row">
              <span class="setting-label">Theme</span>
              <div class="theme-toggle">
                <button :class="{ active: theme === 'dark' }" @click="setTheme('dark')">Dark</button>
                <button :class="{ active: theme === 'light' }" @click="setTheme('light')">Light</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <div class="layout">
      <Sidebar
        :images="images"
        :selected-id="selectedId"
        @add-images="addImages"
        @remove-image="removeImage"
        @select="selectImage"
        @open="openImageTab"
        @show-info="infoImageId = $event"
      />
      <main class="main">
        <div class="tabstrip">
          <button
            v-for="tab in tabs"
            :key="tab.id"
            class="tab"
            :class="{ active: tab.id === activeTabId }"
            @click="activateTab(tab.id)"
          >
            <span class="tab-title">{{ tab.title }}</span>
            <span v-if="tab.closable" class="tab-close" title="Close" @click.stop="closeTab(tab.id)">×</span>
          </button>
        </div>

        <div class="content">
          <Viewer v-show="activeTabId === 'viewer'" :theme="theme" />
          <template v-for="tab in tabs" :key="tab.id">
            <MetadataTable
              v-if="tab.type === 'table'"
              v-show="activeTabId === tab.id"
              :images="images"
              :selected-id="selectedId"
              @select="selectImage"
              @open="openImageTab"
            />
            <ImageViewer
              v-else-if="tab.type === 'image' && imageById(tab.imageId)"
              v-show="activeTabId === tab.id"
              :ref="(el) => { if (el) imageViewerRefs[tab.imageId] = el; else delete imageViewerRefs[tab.imageId] }"
              :image="imageById(tab.imageId)"
            />
          </template>

          <Teleport to="body">
            <ImageInfoModal
              v-if="infoImage"
              :image="infoImage"
              @close="infoImageId = null"
              @detect="detectOne"
            />
          </Teleport>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.layout {
  display: flex;
  flex: 1;
  min-height: 0;
  width: 100%;
}

.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.tabstrip {
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  gap: 1px;
  background: var(--bg);
  border-bottom: 1px solid var(--panel-border);
  overflow-x: auto;
}

.tab {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 200px;
  padding: 8px 12px;
  background: var(--panel);
  border: none;
  border-right: 1px solid var(--panel-border);
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.tab:hover {
  color: var(--text);
}

.tab.active {
  background: var(--bg);
  color: var(--text);
  box-shadow: inset 0 2px 0 var(--accent);
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}

.tab-close {
  font-size: 15px;
  line-height: 1;
  border-radius: 3px;
  padding: 0 3px;
  color: var(--text-dim);
}

.tab-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.content {
  flex: 1;
  position: relative;
  min-height: 0;
}

/* Settings modal */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 360px;
  max-width: 90vw;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.modal-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.modal-body {
  padding: 16px;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
}

.setting-label {
  font-size: 13px;
  color: var(--text);
}

.theme-toggle {
  display: flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
}

.theme-toggle button {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 12px;
  padding: 4px 16px;
  cursor: pointer;
  font: inherit;
}

.theme-toggle button:hover:not(.active) {
  background: var(--hover-bg);
  color: var(--text);
}

.theme-toggle button.active {
  background: var(--accent);
  color: #fff;
}
</style>
