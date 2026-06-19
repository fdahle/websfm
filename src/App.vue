<script setup>
import { ref, computed, reactive, onMounted } from 'vue'
import Ribbon from './components/Ribbon.vue'
import Sidebar from './components/Sidebar.vue'
import Viewer from './components/Viewer.vue'
import ImageViewer from './components/ImageViewer.vue'
import ImageInfoModal from './components/ImageInfoModal.vue'
import DetectFeaturesModal from './components/DetectFeaturesModal.vue'
import SettingsModal from './components/SettingsModal.vue'
import DevConsole from './components/DevConsole.vue'
import MetadataTable from './components/MetadataTable.vue'
import { useImages } from './composables/useImages.js'
import { useTabs } from './composables/useTabs.js'

// ── Theme ────────────────────────────────────────────────────────────────────
const theme = ref(localStorage.getItem('theme') || 'dark')

function applyTheme(t) {
  if (t === 'light') document.documentElement.setAttribute('data-theme', 'light')
  else document.documentElement.removeAttribute('data-theme')
}

function setTheme(t) {
  theme.value = t
  applyTheme(t)
  localStorage.setItem('theme', t)
}

onMounted(() => {
  applyTheme(theme.value)
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      consoleOpen.value = !consoleOpen.value
    }
  })
})

// ── Images ───────────────────────────────────────────────────────────────────
const {
  images, selectedId,
  imageById, selectImage,
  addImages, removeImage,
  updateMask, detectOne, detectAll, clearAll,
} = useImages()

// ── Tabs ─────────────────────────────────────────────────────────────────────
const {
  tabs, activeTabId,
  activeTab, activeImageTab, activeView,
  activateTab, openImageTab, openMetadataTab,
  closeTab, closeTabForImage, onImageDetected, resetToViewer,
} = useTabs(imageById)

// ── Derived state ─────────────────────────────────────────────────────────────
const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

const activeImageViewState = computed(() => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return null
  const img = imageById(tab.imageId)
  if (!img) return null
  return {
    showKeypoints: tab.showKeypoints,
    maskMode:      tab.maskMode,
    brushRadius:   tab.brushRadius,
    kpStatus:      img.kpStatus,
    kpCount:       img.kpCount,
    hasMask:       !!img.mask,
  }
})

// ── Console ───────────────────────────────────────────────────────────────────
const consoleOpen = ref(false)

// ── Modals ────────────────────────────────────────────────────────────────────
const settingsOpen = ref(false)
const infoImageId = ref(null)
const detectFeaturesOpen = ref(false)
const infoImage = computed(() => (infoImageId.value ? imageById(infoImageId.value) : null))

// ── ImageViewer refs (for imperative mask ops) ────────────────────────────────
const imageViewerRefs = reactive({})
const ribbonInput = ref(null)

// ── Commands ──────────────────────────────────────────────────────────────────
function handleCommand(id) {
  switch (id) {
    case 'import-images':      ribbonInput.value.click(); break
    case 'clear-all':          clearAll(resetToViewer); break
    case 'remove-selected':    if (selectedId.value) removeImage(selectedId.value, closeTabForImage); break
    case 'view-viewer':        activateTab('viewer'); break
    case 'view-map':           activateTab('map'); break
    case 'view-table':         openMetadataTab(); break
    case 'detect-features':    detectFeaturesOpen.value = true; break
    case 'open-settings':      settingsOpen.value = true; break
    case 'toggle-console':     consoleOpen.value = !consoleOpen.value; break
    case 'img-detect-sift':    if (activeImageTab.value) detectOne(activeImageTab.value.id, {}, onImageDetected); break
    case 'img-show-info':      if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
    case 'img-remove':         if (activeImageTab.value) removeImage(activeImageTab.value.id, closeTabForImage); break
    case 'img-toggle-keypoints': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showKeypoints = !tab.showKeypoints
      break
    }
    case 'img-mask-draw': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.maskMode = tab.maskMode === 'draw' ? 'none' : 'draw'
      break
    }
    case 'img-mask-erase': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.maskMode = tab.maskMode === 'erase' ? 'none' : 'erase'
      break
    }
    case 'img-mask-import': imageViewerRefs[activeImageTab.value?.id]?.triggerMaskImport(); break
    case 'img-mask-clear':  imageViewerRefs[activeImageTab.value?.id]?.clearMask(); break
    case 'img-brush-s': { const t = activeTab.value; if (t?.type === 'image') t.brushRadius = 10; break }
    case 'img-brush-m': { const t = activeTab.value; if (t?.type === 'image') t.brushRadius = 20; break }
    case 'img-brush-l': { const t = activeTab.value; if (t?.type === 'image') t.brushRadius = 40; break }
  }
}

function onRibbonPick(event) {
  const files = [...event.target.files].filter((f) => f.type.startsWith('image/'))
  if (files.length) addImages(files)
  event.target.value = ''
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
      :image-view-state="activeImageViewState"
      :console-open="consoleOpen"
      @command="handleCommand"
    />
    <input ref="ribbonInput" type="file" accept="image/*" multiple hidden @change="onRibbonPick" />

    <Teleport to="body">
      <DetectFeaturesModal
        v-if="detectFeaturesOpen"
        @close="detectFeaturesOpen = false"
        @run="(s) => { detectFeaturesOpen = false; detectAll(s, onImageDetected) }"
      />
    </Teleport>

    <Teleport to="body">
      <SettingsModal
        v-if="settingsOpen"
        :theme="theme"
        @close="settingsOpen = false"
        @set-theme="setTheme"
      />
    </Teleport>

    <div class="layout">
      <Sidebar
        :images="images"
        :selected-id="selectedId"
        @add-images="addImages"
        @remove-image="(id) => removeImage(id, closeTabForImage)"
        @select="selectImage"
        @open="(id) => openImageTab(id)"
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
          <div v-show="activeTabId === 'map'" class="placeholder-2d">2D view — coming soon</div>
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
              :show-keypoints="tab.showKeypoints"
              :mask-mode="tab.maskMode"
              :brush-radius="tab.brushRadius"
              @update-mask="(dataUrl) => updateMask(tab.imageId, dataUrl)"
            />
          </template>

          <Teleport to="body">
            <ImageInfoModal
              v-if="infoImage"
              :image="infoImage"
              @close="infoImageId = null"
              @detect="(id, s) => detectOne(id, s, onImageDetected)"
            />
          </Teleport>
        </div>
      </main>
    </div>

    <DevConsole v-if="consoleOpen" />
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

.tab:hover { color: var(--text); }

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

.placeholder-2d {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--text-dim);
  font-style: italic;
}
</style>
