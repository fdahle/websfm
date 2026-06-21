<script setup>
import { ref, computed, reactive, watch, onMounted } from 'vue'
import Ribbon from './components/Ribbon.vue'
import Sidebar from './components/Sidebar.vue'
import Viewer from './components/Viewer.vue'
import MapViewer from './components/MapViewer.vue'
import ImageViewer from './components/ImageViewer.vue'
import ImageInfoModal from './components/modals/ImageInfoModal.vue'
import DetectFeaturesModal from './components/modals/DetectFeaturesModal.vue'
import MatchFeaturesModal from './components/modals/MatchFeaturesModal.vue'
import MetadataModal from './components/modals/MetadataModal.vue'
import MatchListModal from './components/modals/MatchListModal.vue'
import ProgressModal from './components/modals/ProgressModal.vue'
import SettingsModal from './components/modals/SettingsModal.vue'
import AboutModal from './components/modals/AboutModal.vue'
import NewProjectModal from './components/modals/NewProjectModal.vue'
import ProjectPicker from './components/ProjectPicker.vue'
import DevConsole from './components/DevConsole.vue'
import { useImages } from './composables/useImages.js'
import { useMatches } from './composables/useMatches.js'
import { useTabs } from './composables/useTabs.js'
import { useProjects } from './composables/useProjects.js'
import { useTheme } from './composables/useTheme.js'
import { useModals } from './composables/useModals.js'
import { usePipeline } from './composables/usePipeline.js'
import { useReconstruction } from './composables/useReconstruction.js'
import ReconstructModal from './components/modals/ReconstructModal.vue'
import * as opfs from './utils/opfs.js'

// ── Theme ─────────────────────────────────────────────────────────────────────
const { theme, applyTheme, setTheme } = useTheme()

// ── Projects ──────────────────────────────────────────────────────────────────
const {
  persistenceEnabled, projects, currentProjectId, currentProjectName, currentSceneType,
  setPersistence, loadIndex, createProject, switchProject, renameProject,
  deleteProjectById,
} = useProjects()

async function syncProject(imgs) {
  if (!persistenceEnabled.value || !currentProjectId.value) return
  const proj = projects.value.find((p) => p.id === currentProjectId.value)
  if (!proj) return
  await opfs.writeProject(currentProjectId.value, {
    ...proj,
    lastModified: new Date().toISOString(),
    images: imgs.map((img) => ({
      id: img.id, uuid: img.uuid, name: img.name,
      kpStatus: img.kpStatus, kpCount: img.kpCount, kpMs: img.kpMs,
      hasMask: !!img.mask, meta: img.meta,
    })),
  })
}

const persistContext = { enabled: persistenceEnabled, projectId: currentProjectId, sync: syncProject }

// ── Images ────────────────────────────────────────────────────────────────────
const {
  images, selectedId,
  imageById, selectImage,
  addImages, removeImage,
  updateMask, detectAll, clearKeypoints, clearAll,
  restoreImages,
} = useImages({ persist: persistContext })

// ── Matches ───────────────────────────────────────────────────────────────────
const { matchStore, matchAll, restoreMatches, clearMatches } = useMatches({ persist: persistContext })

// ── Tabs ──────────────────────────────────────────────────────────────────────
const showMap = computed(() => currentSceneType.value !== 'object')

const {
  tabs, activeTabId,
  activeTab, activeImageTab, activeView,
  activateTab, openImageTab,
  closeTab, closeTabForImage, onImageDetected, resetToViewer,
} = useTabs(imageById, showMap)

// ── Reconstruction ────────────────────────────────────────────────────────────
const {
  cameras, points3d, reconStatus,
  reconstruct, clearReconstruction, restoreReconstruction,
} = useReconstruction({ images, matchStore, persist: persistContext })

// ── Modals ────────────────────────────────────────────────────────────────────
const {
  settingsOpen, aboutOpen,
  projectPickerOpen, newProjectOpen, newProjectCanCancel,
  detectFeaturesOpen, matchFeaturesOpen,
  metadataOpen, matchListOpen, reconstructOpen,
  infoImageId, infoImage,
} = useModals(imageById)

// ── Pipeline ──────────────────────────────────────────────────────────────────
const {
  progressOpen, progressTitle, progressCurrent, progressTotal, progressLabel,
  runDetect, runMatch, runReconstruct,
} = usePipeline({ images, detectAll, matchAll, onImageDetected, reconstruct })

// ── Derived state ──────────────────────────────────────────────────────────────
const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

const matchSummaries = computed(() => {
  const result = []
  for (const [pid, entry] of matchStore.value) {
    if (entry.status !== 'done' || entry.inlierCount === 0) continue
    const imgA = images.value.find((img) => img.uuid === entry.idA)
    const imgB = images.value.find((img) => img.uuid === entry.idB)
    if (!imgA || !imgB) continue
    result.push({
      pairId:      pid,
      idA:         imgA.id,
      idB:         imgB.id,
      nameA:       imgA.name,
      nameB:       imgB.name,
      inlierCount: entry.inlierCount,
      rawCount:    entry.rawCount,
    })
  }
  return result
})

const activeImageViewState = computed(() => {
  const tab = activeTab.value
  if (!tab || tab.type !== 'image') return null
  const img = imageById(tab.imageId)
  if (!img) return null
  return {
    showKeypoints: tab.showKeypoints,
    showMask:      tab.showMask,
    maskMode:      tab.maskMode,
    brushRadius:   tab.brushRadius,
    kpStatus:      img.kpStatus,
    kpCount:       img.kpCount,
    hasMask:       !!img.mask,
  }
})

// ── Viewer ref (for imperative point-cloud updates) ───────────────────────────
const viewerRef = ref(null)

watch(reconStatus, (s) => {
  if (s === 'done') viewerRef.value?.setReconstructionData(cameras.value, points3d.value)
})

// ── Console ───────────────────────────────────────────────────────────────────
const consoleOpen = ref(localStorage.getItem('consoleOpen') === 'true')
watch(consoleOpen, (v) => localStorage.setItem('consoleOpen', v))

// ── Bootstrap ─────────────────────────────────────────────────────────────────
onMounted(async () => {
  applyTheme(theme.value)
  window.addEventListener('keydown', (e) => {
    if (e.key === '`' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      consoleOpen.value = !consoleOpen.value
    }
  })

  if (!persistenceEnabled.value) return

  const available = await opfs.isAvailable()
  if (!available) {
    setPersistence(false)
    return
  }

  const lastOpenedId = await loadIndex()

  if (projects.value.length === 0) {
    newProjectCanCancel.value = false
    newProjectOpen.value = true
  } else {
    const idToOpen = lastOpenedId && projects.value.some((p) => p.id === lastOpenedId)
      ? lastOpenedId
      : projects.value[0].id
    await openProject(idToOpen)
  }
})

async function openProject(id) {
  const projectData = await switchProject(id)
  if (!projectData) return
  resetToViewer()
  clearReconstruction()
  viewerRef.value?.clearReconstructionData()
  await restoreImages(projectData.images || [], id)
  await restoreMatches(id)
  await restoreReconstruction(id)
  if (reconStatus.value === 'done')
    viewerRef.value?.setReconstructionData(cameras.value, points3d.value)
}

// ── Persistence toggle ────────────────────────────────────────────────────────
async function handleSetPersistence(enabled) {
  setPersistence(enabled)
  if (enabled) {
    const available = await opfs.isAvailable()
    if (!available) { setPersistence(false); return }
    if (projects.value.length === 0) {
      newProjectCanCancel.value = false
      newProjectOpen.value = true
    }
  }
}

// ── New project ───────────────────────────────────────────────────────────────
async function handleCreateProject({ name, sceneType }) {
  newProjectOpen.value = false
  clearAll(resetToViewer)
  clearMatches()
  clearReconstruction()
  viewerRef.value?.clearReconstructionData()
  await createProject(name, sceneType)
}

// ── Project picker actions ────────────────────────────────────────────────────
async function handleSwitchProject(id) {
  if (id === currentProjectId.value) { projectPickerOpen.value = false; return }
  projectPickerOpen.value = false
  clearAll(resetToViewer)
  clearMatches()
  await openProject(id)
}

async function handleDeleteProject(id) {
  const nextId = await deleteProjectById(id)
  if (id === currentProjectId.value) {
    clearAll(resetToViewer)
    clearReconstruction()
    viewerRef.value?.clearReconstructionData()
    if (nextId) await openProject(nextId)
    else { newProjectCanCancel.value = false; newProjectOpen.value = true }
  }
}

// ── Pipeline handlers (close modal, then delegate to usePipeline) ─────────────
function onDetectRun(settings)      { detectFeaturesOpen.value = false;  runDetect(settings)      }
function onMatchRun(settings)       { matchFeaturesOpen.value  = false;  runMatch(settings)       }
function onReconstructRun(settings) { reconstructOpen.value    = false;  runReconstruct(settings) }

// ── ImageViewer refs (for imperative mask ops) ────────────────────────────────
const imageViewerRefs = reactive({})
const ribbonInput = ref(null)

// ── Commands ──────────────────────────────────────────────────────────────────
function handleCommand(id) {
  switch (id) {
    case 'import-images':        ribbonInput.value.click(); break
    case 'clear-all':            clearAll(resetToViewer); clearMatches(); clearReconstruction(); viewerRef.value?.clearReconstructionData(); break
    case 'remove-selected':      if (selectedId.value) removeImage(selectedId.value, closeTabForImage); break
    case 'view-viewer':          activateTab('viewer'); break
    case 'view-map':             activateTab('map'); break
    case 'open-metadata':        metadataOpen.value = true; break
    case 'open-match-list':      matchListOpen.value = true; break
    case 'reconstruct':          reconstructOpen.value = true; break
    case 'detect-features':      detectFeaturesOpen.value = true; break
    case 'match-features':       matchFeaturesOpen.value = true; break
    case 'open-settings':        settingsOpen.value = true; break
    case 'open-about':           aboutOpen.value = true; break
    case 'open-project-picker':  projectPickerOpen.value = !projectPickerOpen.value; break
    case 'toggle-console':       consoleOpen.value = !consoleOpen.value; break
    case 'img-show-info':        if (activeImageTab.value) infoImageId.value = activeImageTab.value.id; break
    case 'img-remove':           if (activeImageTab.value) removeImage(activeImageTab.value.id, closeTabForImage); break
    case 'img-toggle-keypoints': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showKeypoints = !tab.showKeypoints
      break
    }
    case 'img-toggle-mask': {
      const tab = activeTab.value
      if (tab?.type === 'image') tab.showMask = !tab.showMask
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
      :match-count="matchSummaries.length"
      :active-image-id="activeImageTab?.id ?? null"
      :active-image-name="activeImageTab?.name ?? null"
      :image-view-state="activeImageViewState"
      :console-open="consoleOpen"
      :persistence-enabled="persistenceEnabled"
      :current-project-name="currentProjectName"
      :scene-type="currentSceneType"
      @command="handleCommand"
    />
    <input ref="ribbonInput" type="file" accept="image/*" multiple hidden @change="onRibbonPick" />

    <ProjectPicker
      v-if="projectPickerOpen"
      :projects="projects"
      :current-project-id="currentProjectId"
      @switch="handleSwitchProject"
      @rename="(id, name) => renameProject(id, name)"
      @delete="handleDeleteProject"
      @new="() => { projectPickerOpen = false; newProjectCanCancel = true; newProjectOpen = true }"
      @close="projectPickerOpen = false"
    />

    <Teleport to="body">
      <DetectFeaturesModal
        v-if="detectFeaturesOpen"
        @close="detectFeaturesOpen = false"
        @run="onDetectRun"
      />
    </Teleport>

    <Teleport to="body">
      <MatchFeaturesModal
        v-if="matchFeaturesOpen"
        @close="matchFeaturesOpen = false"
        @run="onMatchRun"
      />
    </Teleport>

    <Teleport to="body">
      <ReconstructModal
        v-if="reconstructOpen"
        @close="reconstructOpen = false"
        @run="onReconstructRun"
      />
    </Teleport>

    <Teleport to="body">
      <ProgressModal
        v-if="progressOpen"
        :title="progressTitle"
        :current="progressCurrent"
        :total="progressTotal"
        :label="progressLabel"
      />
    </Teleport>

    <Teleport to="body">
      <SettingsModal
        v-if="settingsOpen"
        :theme="theme"
        :persistence-enabled="persistenceEnabled"
        @close="settingsOpen = false"
        @set-theme="setTheme"
        @set-persistence="handleSetPersistence"
      />
    </Teleport>

    <Teleport to="body">
      <AboutModal v-if="aboutOpen" @close="aboutOpen = false" />
    </Teleport>

    <Teleport to="body">
      <MetadataModal
        v-if="metadataOpen"
        :images="images"
        :selected-id="selectedId"
        @close="metadataOpen = false"
        @select="selectImage"
        @open="(id) => { openImageTab(id); metadataOpen = false }"
      />
    </Teleport>

    <Teleport to="body">
      <MatchListModal
        v-if="matchListOpen"
        :match-summaries="matchSummaries"
        :images="images"
        :match-store="matchStore"
        @close="matchListOpen = false"
      />
    </Teleport>

    <Teleport to="body">
      <NewProjectModal
        v-if="newProjectOpen"
        :can-cancel="newProjectCanCancel"
        @create="handleCreateProject"
        @cancel="newProjectOpen = false"
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
        @delete-keypoints="clearKeypoints"
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
          <Viewer ref="viewerRef" v-show="activeTabId === 'viewer'" :theme="theme" />
          <MapViewer v-show="activeTabId === 'map'" :images="images" :selected-id="selectedId" @select="selectImage" />
          <template v-for="tab in tabs" :key="tab.id">
            <ImageViewer
              v-if="tab.type === 'image' && imageById(tab.imageId)"
              v-show="activeTabId === tab.id"
              :ref="(el) => { if (el) imageViewerRefs[tab.imageId] = el; else delete imageViewerRefs[tab.imageId] }"
              :image="imageById(tab.imageId)"
              :show-keypoints="tab.showKeypoints"
              :show-mask="tab.showMask"
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

</style>
