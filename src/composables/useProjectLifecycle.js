import { computed, nextTick, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ensureProjection } from '../core/crs.js'
// NB: the projectArchive one — `core/dense/memBudget.js` exports a different
// `formatBytes` with different formatting.
import { formatBytes } from '../core/io/projectArchive.js'
import { clearProjectStores, restoreProjectStores } from '../stores/projectStores.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useLog } from './useLog.js'
import { showToast } from './useToasts.js'

// Everything that opens, creates, switches, moves, saves or deletes a project,
// lifted out of App.vue. Owns the blocking load overlay (`projectLoading` +
// friends) because it is driven by nothing else.
//
// The three storage flavours all funnel through `openProject`:
//   • OPFS — the default.
//   • folder-backed — must clear `openPlan` first; `requestPermission` needs a
//     user gesture, so an un-grantable handle raises `folderPrompt` (reconnect /
//     repick) instead of failing in a way indistinguishable from a corrupt project.
//   • `.websfm` archive — imported into a fresh project, then opened normally.
//
// Injected (these live in App.vue, not a store):
//   resetToViewer     — from useTabs; drop tabs back to the 3D viewer
//   clearViewerScene  — blank the Three.js scene (viewerRef.clearReconstructionData)
export function useProjectLifecycle({ resetToViewer, clearViewerScene }) {
  const { log } = useLog()
  const projectsStore = useProjectsStore()
  const { projects, currentProjectId, currentProjectName } = storeToRefs(projectsStore)
  const {
    createProject, switchProject, deleteProjectById, exportProject, importProject,
    openPlan, reconnectProjectFolder, relinkProjectFolder,
    createFolderProject, adoptFolderProject, moveProjectToFolder, moveProjectToBrowser,
  } = projectsStore
  const {
    projectPickerOpen, newProjectOpen, newProjectCanCancel, saveProjectOpen,
  } = storeToRefs(useModalsStore())

  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const { clearAll, restoreImages, migrateLegacyFiducialDetections, flushPendingWork } = imagesStore
  const externalStore = useExternalStore()
  const sensorsStore = useSensorsStore()
  const { sensors } = storeToRefs(sensorsStore)
  const { clearSensors, restoreSensors, migrateLegacyFiducialCalibrations } = sensorsStore

  async function flushProjectWork() {
    await Promise.all([flushPendingWork(), externalStore.flushPendingWork()])
  }

  // ── Blocking load overlay ───────────────────────────────────────────────────
  // Restoring a model still does a burst of synchronous work (decoding point
  // buffers, rebuilding tracks); the overlay stops the user acting on a
  // half-loaded project and then hitting the freeze mid-click.
  const projectLoading = ref(false)
  const projectLoadingProgress = ref(null)
  const projectLoadingLabel = ref('Loading project…')

  // Run `fn` behind the overlay under `label`, always restoring the default label.
  // `await nextTick()` before the work so the overlay actually paints first.
  async function withLoadingOverlay(label, fn) {
    projectLoadingLabel.value = label
    projectLoading.value = true
    try {
      await nextTick()
      return await fn()
    } finally {
      projectLoading.value = false
      projectLoadingProgress.value = null
      projectLoadingLabel.value = 'Loading project…'
    }
  }

  // Progress sink shared by the two migration paths and the archive import, which
  // all report a running file count rather than a known total.
  const fileProgress = ({ files, done, label }) => {
    const n = files ?? done ?? 0
    projectLoadingProgress.value = { done: n, total: 0, label: `${n} files — ${label}` }
  }

  // Drop all in-memory project state. `purge` also deletes the persisted data, so
  // it is ONLY for the explicit "clear everything" command — leaving a project to
  // open another must never purge the one being left.
  function resetInMemoryProject({ purge = false } = {}) {
    clearAll(resetToViewer, { purge })
    clearSensors({ purge })
    clearProjectStores({ purge })
    clearViewerScene()
  }

  // ── Open ────────────────────────────────────────────────────────────────────
  async function openProject(id) {
    await flushProjectWork()
    // A folder-backed project has to be reachable before anything reads it: the
    // stored directory handle may need a permission grant (which needs a user
    // gesture) or may be dead. `openPlan` registers the root when it can and
    // otherwise tells us which prompt to raise — reading project.json first would
    // just fail in a way indistinguishable from a corrupt project.
    let plan
    try {
      plan = await openPlan(id)
    } catch (err) {
      const detail = String(err?.message ?? err)
      log(`Could not prepare project: ${detail}`, 'error', 'Project')
      showToast('Could not open project', { detail, kind: 'error', ms: 6000 })
      return false
    }
    if (plan.action !== 'open') {
      folderPrompt.value = { id, action: plan.action, error: '' }
      return
    }
    let projectData
    try {
      projectData = await switchProject(id)
    } catch (err) {
      const detail = String(err?.message ?? err)
      log(`Could not open project: ${detail}`, 'error', 'Project')
      showToast('Could not open project', { detail, kind: 'error', ms: 6000 })
      return false
    }
    if (!projectData) {
      log('Could not open project: project.json is missing or unreadable', 'error', 'Project')
      showToast('Could not open project', {
        detail: 'project.json is missing or unreadable', kind: 'error', ms: 6000,
      })
      return false
    }
    await withLoadingOverlay('Loading project…', async () => {
      if (projectData.crs) await ensureProjection(projectData.crs).catch(() => {})
      // The destination is reachable and readable; only now is it safe to tear
      // down the project being left.
      resetInMemoryProject()
      // Let the overlay actually paint before the synchronous restore work runs.
      await nextTick()
      await new Promise((r) => requestAnimationFrame(() => r()))
      // Restore sensors before images: EXIF auto-grouping reacts to the image list,
      // so the saved sensors must already be in place or it would mint duplicates
      // and clobber manual sensor assignments. Both have bespoke restore signatures,
      // so they stay manual; every other project-scoped store restores through the
      // registry below (matches, reconstruction, GCPs, footprints, poses).
      await restoreSensors(id)
      await restoreImages(projectData.images || [], id, (done, total, label) => {
        projectLoadingProgress.value = { done, total, label }
      })
      migrateLegacyFiducialDetections(sensors.value)
      migrateLegacyFiducialCalibrations(images.value)
      projectLoadingProgress.value = null
      await restoreProjectStores({ projectId: id, projectData })
      // restore() sets selectedCloud, which the watcher pushes into the viewer.
    })
    return true
  }

  // ── New project ─────────────────────────────────────────────────────────────
  async function handleCreateProject({ name, sceneType, crs, dirHandle = null }) {
    newProjectOpen.value = false
    await flushProjectWork()
    if (crs) await ensureProjection(crs).catch(() => {})
    if (!dirHandle) {
      try {
        await createProject(name, sceneType, crs)
        resetInMemoryProject()
      } catch (err) {
        const detail = String(err?.message ?? err)
        log(`Could not create project: ${detail}`, 'error', 'Project')
        showToast('Could not create project', { detail, kind: 'error', ms: 6000 })
        newProjectCanCancel.value = !!currentProjectId.value
        newProjectOpen.value = true
      }
      return
    }

    // Folder-backed: the directory must be empty (websfm writes a whole tree into
    // it and prunes stale sidecars), so a non-empty one asks once.
    let res
    try {
      res = await createFolderProject(name, sceneType, crs, dirHandle)
    } catch (err) {
      res = { ok: false, error: String(err?.message ?? err) }
    }
    if (!res.ok && res.needsConfirm
        && confirm(`"${dirHandle.name}" is not empty. Create the project in it anyway?`)) {
      try {
        res = await createFolderProject(name, sceneType, crs, dirHandle, { confirmed: true })
      } catch (err) {
        res = { ok: false, error: String(err?.message ?? err) }
      }
    }
    if (res.ok) {
      resetInMemoryProject()
      log(`Project "${name}" created in folder "${dirHandle.name}"`, 'info', 'Project')
      return
    }
    log(`Could not create project in folder: ${res.error}`, 'error', 'Project')
    showToast('Could not use that folder', { detail: res.error, kind: 'error', ms: 6000 })
    newProjectCanCancel.value = !!currentProjectId.value
    newProjectOpen.value = true
  }

  // Cancelling the New Project dialog falls back to the picker when no project is
  // open yet, so the user is never left in an empty, project-less state.
  function handleCancelNewProject() {
    newProjectOpen.value = false
    if (!currentProjectId.value && projects.value.length > 0) {
      projectPickerOpen.value = true
    }
  }

  // ── Folder-backed projects ──────────────────────────────────────────────────
  // { id, action: 'reconnect' | 'repick', error } while a folder project is
  // waiting to be reached, else null. Held here (not in the modals store) because
  // it is a step *inside* opening a project, not a modal the user opens.
  const folderPrompt = ref(null)

  const folderPromptProject = computed(() =>
    folderPrompt.value ? projects.value.find((p) => p.id === folderPrompt.value.id) || null : null)

  async function pickDirectory() {
    try {
      return await window.showDirectoryPicker({ mode: 'readwrite' })
    } catch (err) {
      if (err?.name !== 'AbortError') {
        log(`Folder picker: ${err?.message ?? err}`, 'error', 'Project')
      }
      return null
    }
  }

  // "Connect" in the reconnect dialog — the user gesture requestPermission needs.
  async function onFolderConnect() {
    const prompt = folderPrompt.value
    if (!prompt) return
    const res = await reconnectProjectFolder(prompt.id)
    if (!res.ok) { folderPrompt.value = { ...prompt, action: 'repick', error: res.error }; return }
    folderPrompt.value = null
    await openProject(prompt.id)
  }

  // "Choose folder…" — re-point the project at a freshly picked directory.
  async function onFolderRepick() {
    const prompt = folderPrompt.value
    if (!prompt) return
    const dirHandle = await pickDirectory()
    if (!dirHandle) return
    const res = await relinkProjectFolder(prompt.id, dirHandle)
    if (!res.ok) { folderPrompt.value = { ...prompt, error: res.error }; return }
    folderPrompt.value = null
    await openProject(prompt.id)
  }

  // Adopt a directory that already holds a project.json — the Dropbox/git sharing
  // path. Its internal ids are kept, so the same folder is the same project
  // wherever it is opened.
  async function openProjectFolder() {
    const dirHandle = await pickDirectory()
    if (!dirHandle) return
    const res = await adoptFolderProject(dirHandle)
    if (!res.ok) {
      log(`Open project folder: ${res.error}`, 'error', 'Project')
      showToast('Not a project folder', { detail: res.error, kind: 'error', ms: 6000 })
      return
    }
    projectPickerOpen.value = false
    await openProject(res.id)
  }

  // Migration between backends. Both directions are a verified tree copy; only the
  // OPFS source is deleted afterwards — files on the user's disk are never removed
  // by websfm, so "move into browser storage" leaves the folder in place.
  async function moveCurrentProjectToFolder(id = currentProjectId.value) {
    if (!id) return
    await flushProjectWork()
    const dirHandle = await pickDirectory()
    if (!dirHandle) return
    await withLoadingOverlay('Moving project to folder…', async () => {
      let res = await moveProjectToFolder(id, dirHandle, { onProgress: fileProgress })
      if (!res.ok && res.needsConfirm
          && confirm(`"${dirHandle.name}" is not empty. Move the project into it anyway?`)) {
        res = await moveProjectToFolder(id, dirHandle, { confirmed: true })
      }
      if (res.ok) {
        log(`Project moved to folder "${dirHandle.name}" (${res.files} files)`, 'info', 'Project')
        showToast('Project moved to folder', { detail: dirHandle.name })
      } else {
        log(`Move to folder failed: ${res.error}`, 'error', 'Project')
        showToast('Could not move project', { detail: res.error, kind: 'error', ms: 6000 })
      }
    })
  }

  async function moveCurrentProjectToBrowser(id = currentProjectId.value) {
    if (!id) return
    await flushProjectWork()
    if (!confirm('Copy this project into browser storage? The folder on disk is left in place, '
      + 'and websfm will stop writing to it.')) return
    await withLoadingOverlay('Moving project into browser storage…', async () => {
      const res = await moveProjectToBrowser(id, { onProgress: fileProgress })
      if (res.ok) {
        log(`Project moved into browser storage (${res.files} files)`, 'info', 'Project')
        showToast('Project moved into browser storage')
      } else {
        log(`Move into browser storage failed: ${res.error}`, 'error', 'Project')
        showToast('Could not move project', { detail: res.error, kind: 'error', ms: 6000 })
      }
    })
  }

  // ── Project file (.websfm) ──────────────────────────────────────────────────
  // Save/load of a whole project as one file. Both directions block the UI behind
  // the same overlay as a project open: they rewrite (or create) a project on
  // disk, and a half-unpacked project must not be clickable.

  async function onSaveProject({ includeDerived }) {
    saveProjectOpen.value = false
    const id = currentProjectId.value
    if (!id) return
    try {
      await flushProjectWork()
      const res = await exportProject(id, { includeDerived, onLog: (m, l, c) => log(m, l, c) })
      if (res?.cancelled) return
      showToast('Project saved', { detail: `${res.fileName} · ${formatBytes(res.archiveBytes)}` })
    } catch (err) {
      const detail = String(err?.message ?? err)
      log(`Save project failed: ${detail}`, 'error', 'Project')
      showToast('Could not save project', { detail, kind: 'error', ms: 6000 })
    }
  }

  // A `.websfm` file always lands as a NEW project — never merged into the open
  // one. Importing then switching is therefore non-destructive, so it needs no
  // confirmation: the current project is untouched and still in the picker.
  async function importProjectFile(file) {
    if (!file) return
    await flushProjectWork()
    const id = await withLoadingOverlay('Opening project file…', async () => {
      try {
        return await importProject(file, {
          onLog: (m, l, c) => log(m, l, c),
          onProgress: fileProgress,
        })
      } catch (err) {
        const detail = String(err?.message ?? err)
        log(`Open project file failed: ${detail}`, 'error', 'Project')
        showToast('Could not open project file', { detail, kind: 'error', ms: 6000 })
        return null
      }
    })
    if (!id) return
    projectPickerOpen.value = false
    await openProject(id)
    showToast('Project opened', { detail: currentProjectName.value || '' })
  }

  function onProjectFilePick(event) {
    const file = event.target.files?.[0]
    if (file) importProjectFile(file)
    event.target.value = ''
  }

  // ── Project picker actions ──────────────────────────────────────────────────
  async function handleSwitchProject(id) {
    if (id === currentProjectId.value) { projectPickerOpen.value = false; return }
    projectPickerOpen.value = false
    await openProject(id)
  }

  async function handleDeleteProject(id) {
    await flushProjectWork()
    // Capture before deleting: deleteProjectById nulls currentProjectId itself.
    const wasCurrent = id === currentProjectId.value
    await deleteProjectById(id)

    // Deleting the last project leaves nothing to pick — close the picker and go
    // straight to project creation (non-cancellable), never an empty list.
    if (projects.value.length === 0) {
      projectPickerOpen.value = false
      resetInMemoryProject()
      newProjectCanCancel.value = false
      newProjectOpen.value = true
      return
    }

    if (wasCurrent) {
      // Deleting the open project blanks the background and returns to the picker
      // (now non-dismissible, since currentProjectId is null) rather than silently
      // switching into some other project the user didn't choose.
      resetInMemoryProject()
      projectPickerOpen.value = true
    }
  }

  return {
    projectLoading, projectLoadingProgress, projectLoadingLabel,
    resetInMemoryProject,
    handleCreateProject, handleCancelNewProject,
    folderPrompt, folderPromptProject,
    onFolderConnect, onFolderRepick, openProjectFolder,
    moveCurrentProjectToFolder, moveCurrentProjectToBrowser,
    onSaveProject, importProjectFile, onProjectFilePick,
    handleSwitchProject, handleDeleteProject,
  }
}
