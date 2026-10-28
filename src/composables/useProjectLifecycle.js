import { flushPersistence, retryPersistence } from '../utils/persistence.js'
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { crsInfo, ensureProjection } from '../core/crs.js'
import { formatBytes } from '../core/formatBytes.js'
import { clearProjectStores, restoreProjectStores } from '../stores/projectStores.js'
import { loadProgressView } from '../utils/loadProgress.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useLogStore } from '../stores/useLogStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useLog } from './useLog.js'
import { showToast } from './useToasts.js'
import { setStorageFullHandler } from '../utils/storageFull.js'
import { isFolderProject } from '../core/io/folderProject.js'
import { confirmDialog } from './useConfirmations.js'
import { rememberNewProjectDraft } from './newProjectDraft.js'
import { pluralize } from '../core/textFormat.js'
import { EXAMPLES, downloadExample } from '../core/examples.js'
import { useGuideStore } from '../stores/useGuideStore.js'

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
//   isBusy            — true while a compute run or workflow is in flight
export function useProjectLifecycle({ resetToViewer, clearViewerScene, isBusy = () => false }) {
  const { log } = useLog()
  const projectsStore = useProjectsStore()
  const { projects, currentProjectId, currentProjectName } = storeToRefs(projectsStore)
  const {
    createProject,
    switchProject,
    deleteProjectById,
    exportProject,
    importProject,
    openPlan,
    reconnectProjectFolder,
    relinkProjectFolder,
    createFolderProject,
    adoptFolderProject,
    moveProjectToFolder,
    dropBrowserCopy,
    moveProjectToBrowser,
    setProjectCrs,
  } = projectsStore
  const gcpsStore = useGcpsStore()
  const footprintsStore = useFootprintsStore()
  const posesStore = usePosesStore()
  const reconstructionStore = useReconstructionStore()
  const { projectPickerOpen, newProjectOpen, newProjectCanCancel, saveProjectOpen } = storeToRefs(useModalsStore())

  const imagesStore = useImagesStore()
  const matchesStore = useMatchesStore()
  const { images } = storeToRefs(imagesStore)
  const { clearAll, restoreImages, flushPendingWork } = imagesStore
  const externalStore = useExternalStore()
  const sensorsStore = useSensorsStore()
  const { clearSensors, restoreSensors } = sensorsStore

  const logStore = useLogStore()

  // Runs before currentProjectId moves, so every queued write — console lines
  // included — still lands in the project that produced it.
  async function flushProjectWork() {
    await Promise.all([flushPendingWork(), externalStore.flushPendingWork()])
    await nextTick() // run store watchers that schedule autosaves
    await Promise.all([flushPersistence(), logStore.flushNow()])
  }

  // A run captures the open project's data and writes its result back on finish;
  // tearing that project down underneath it would land the result in the next one.
  // The progress overlay already blocks the UI, so this is the backstop for any
  // path that gets past it (keyboard, a workflow between stages).
  function refuseWhileBusy(action) {
    if (!isBusy()) return false
    log(`${action}: not while a computation is running — cancel it or wait for it to finish`, 'warn', 'Project')
    showToast(`Can't ${action.toLowerCase()} now`, { detail: 'A computation is running.', kind: 'error', ms: 5000 })
    return true
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

  // Drop all in-memory project state. Never purges: leaving a project to open
  // another must leave everything it saved on disk.
  function resetInMemoryProject() {
    clearAll(resetToViewer)
    clearSensors()
    clearProjectStores()
    clearViewerScene()
  }

  // What a reopened project holds — the data that once filled the renderer's ~4 GB
  // V8 heap (TODO ▸ MEM). Keypoints and matches are typed (24 B per keypoint, 8 B per
  // match, outside the heap) and live on disk, loaded on demand (TODO ▸ SC-2/SC-3):
  // the counts are what the project holds, the cache figures what is resident now.
  // A DevTools heap snapshot is the measurement.
  function logHeapInventory() {
    let keypoints = 0
    for (const img of images.value) keypoints += img.kpCount ?? 0
    let matches = 0
    for (const entry of matchesStore.matchStore.values()) matches += entry.nMatches ?? 0
    const kc = imagesStore.keypointCacheStats(),
      mc = matchesStore.matchCacheStats()
    const mem = globalThis.performance?.memory
    log(
      `Heap inventory: ${keypoints.toLocaleString()} keypoints (${pluralize(kc.entries, 'image')} resident, ` +
        `${formatBytes(kc.bytes)} typed), ${matches.toLocaleString()} matches (${pluralize(mc.entries, 'pair')} resident, ` +
        `${formatBytes(mc.bytes)} typed)` +
        (mem?.usedJSHeapSize
          ? ` · JS memory (heap + ArrayBuffers) ${formatBytes(mem.usedJSHeapSize)}, heap limit ${formatBytes(mem.jsHeapSizeLimit)}`
          : ''),
      'info',
      'Project',
    )
  }

  // ── Open ────────────────────────────────────────────────────────────────────
  async function openProject(id) {
    if (refuseWhileBusy('Open project')) return false
    const loadStarted = performance.now()
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
    // A move during a run whose tab closed before the run ended left its browser copy.
    await dropBrowserCopy(id).catch(() => {})
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
        detail: 'project.json is missing or unreadable',
        kind: 'error',
        ms: 6000,
      })
      return false
    }
    await withLoadingOverlay('Loading project…', async () => {
      const timings = []
      const timed = async (phase, fn) => {
        const started = performance.now()
        const result = await fn()
        timings.push({ phase, ms: performance.now() - started })
        return result
      }
      if (projectData.crs) {
        await timed('projection', () => ensureProjection(projectData.crs).catch(() => {}))
      }
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
      await timed('sensors', () => restoreSensors(id))
      // Sensors restore outside the registry (images depend on them); same rule as
      // restoreProjectStores: a read that finished after a switch must not stay.
      if (currentProjectId.value !== id) clearSensors()
      // restoreImages publishes the image list (ids + names) synchronously before
      // its first await; only previews and keypoints load after that. The registry
      // stores need the list, never the pixels, so both phases run concurrently.
      // Both phases feed one overlay view (utils/loadProgress.js), refreshed at most
      // once per frame: match restore reports once per pair file.
      let imagesState = { done: 0, total: projectData.images?.length ?? 0, label: '' }
      const storeStates = new Map()
      let refreshQueued = false
      const refreshProgress = () => {
        refreshQueued = false
        if (projectLoading.value && currentProjectId.value === id) {
          projectLoadingProgress.value = loadProgressView(imagesState, storeStates)
        }
      }
      const queueProgress = () => {
        if (refreshQueued) return
        refreshQueued = true
        requestAnimationFrame(refreshProgress)
      }
      const imagesDone = timed('images', () =>
        restoreImages(
          projectData.images || [],
          id,
          (done, total, label) => {
            imagesState = { done, total, label }
            queueProgress()
          },
          { groups: projectData.imageGroups },
        ),
      ).then(() => {
        imagesState = null
        refreshProgress()
      })
      const storesDone = timed('project stores', () =>
        restoreProjectStores({
          projectId: id,
          projectData,
          isCurrent: () => currentProjectId.value === id,
          onProgress: (store, state) => {
            storeStates.set(store, state)
            queueProgress()
          },
        }),
      )
      const [, storeTimings] = await Promise.all([imagesDone, storesDone])
      const detail = [...timings, ...storeTimings.map(({ store, ms }) => ({ phase: store, ms }))]
        .sort((a, b) => b.ms - a.ms)
        .map(({ phase, ms }) => `${phase} ${Math.round(ms)} ms`)
        .join(' · ')
      log(`Project load timing: ${Math.round(performance.now() - loadStarted)} ms total — ${detail}`, 'info', 'Project')
      logHeapInventory()
      // restore() sets selectedCloud, which the watcher pushes into the viewer.
    })
    return true
  }

  // ── New project ─────────────────────────────────────────────────────────────
  async function handleCreateProject({ name, sceneType, crs, dirHandle = null }) {
    if (refuseWhileBusy('Create project')) return
    newProjectOpen.value = false
    return withLoadingOverlay('Creating project…', async () => {
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
          // The reopened dialog is a fresh mount: hand it what was typed (newProjectDraft.js).
          rememberNewProjectDraft({ name, sceneType, crs, dirHandle })
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
      if (
        !res.ok &&
        res.needsConfirm &&
        (await confirmDialog({
          title: 'Folder not empty',
          message: `"${dirHandle.name}" is not empty. Create the project in it anyway?`,
          confirmLabel: 'Create',
        }))
      ) {
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
      rememberNewProjectDraft({ name, sceneType, crs, dirHandle })
      newProjectCanCancel.value = !!currentProjectId.value
      newProjectOpen.value = true
    })
  }

  // ── Example project ─────────────────────────────────────────────────────────
  // Download first (core/examples.js), so a failed download leaves no empty project
  // behind; then create the project, import the images as a drop would, and open
  // the example's walkthrough in the guide.
  async function openExample(id) {
    if (refuseWhileBusy('Open example')) return
    const example = EXAMPLES[id]
    projectPickerOpen.value = false
    newProjectOpen.value = false
    let files
    try {
      files = await withLoadingOverlay(`Downloading example "${example.title}"…`, () =>
        downloadExample(id, {
          onProgress: ({ done, total, bytes, totalBytes }) => {
            projectLoadingProgress.value = {
              done,
              total,
              label: 'Images',
              detail: `${formatBytes(bytes)} of ${formatBytes(totalBytes)}`,
            }
          },
        }),
      )
    } catch (err) {
      const detail = String(err?.message ?? err)
      log(`Could not download the example: ${detail}`, 'error', 'Project')
      showToast('Could not download the example', { detail, kind: 'error', ms: 8000 })
      // Back to where the user came from, never to an empty, project-less app.
      if (!currentProjectId.value) {
        if (projects.value.length) projectPickerOpen.value = true
        else {
          newProjectCanCancel.value = false
          newProjectOpen.value = true
        }
      }
      return
    }
    const before = currentProjectId.value
    await handleCreateProject({ name: example.title, sceneType: example.sceneType, crs: example.crs })
    if (!currentProjectId.value || currentProjectId.value === before) return
    log(
      `Example "${example.title}": ${files.length} photos by ${example.credit} (${example.dataset}, ${example.license})`,
      'info',
      'Project',
    )
    await imagesStore.addImages(files)
    if (example.tutorial) useGuideStore().openOp(example.tutorial)
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
    folderPrompt.value ? projects.value.find((p) => p.id === folderPrompt.value.id) || null : null,
  )

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
    if (!res.ok) {
      folderPrompt.value = { ...prompt, action: 'repick', error: res.error }
      return
    }
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
    if (!res.ok) {
      folderPrompt.value = { ...prompt, error: res.error }
      return
    }
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
  //
  // The open project is then reopened from its new root. Its stores hold File handles
  // into the old one (image copies, masks, depth previews, products, LOD files,
  // reference rasters, the match document): a move to a folder deletes the tree they
  // point at, and a move back stops writing to it. The copies have the same names, and
  // the open path is the one place that fetches all of them.
  // Writes that failed before the move (browser storage full) are retried first: they
  // now land in the new root, and an open refuses to leave unsaved changes behind.
  async function reopenMoved(id) {
    if (id !== currentProjectId.value) return
    await retryPersistence().catch((err) => log(err?.message ?? String(err), 'warn', 'Project'))
    log('Reopening the project from its new location', 'info', 'Project')
    await openProject(id).catch((err) =>
      log(`Could not reopen the project: ${err?.message ?? err}`, 'error', 'Project'),
    )
  }

  // The move behind the overlay, said in the log and a toast. A folder that is not
  // empty is asked about between two attempts, outside the overlay, which would
  // otherwise cover the question. → true when the project moved.
  async function moveToFolder(id, dirHandle, opts = {}) {
    const attempt = (confirmed) =>
      withLoadingOverlay('Moving project to folder…', () =>
        moveProjectToFolder(id, dirHandle, { ...opts, confirmed, onProgress: fileProgress }),
      )
    let res = await attempt(false)
    if (
      !res.ok &&
      res.needsConfirm &&
      (await confirmDialog({
        title: 'Folder not empty',
        message: `"${dirHandle.name}" is not empty. Move the project into it anyway?`,
        confirmLabel: 'Move',
      }))
    ) {
      res = await attempt(true)
    }
    if (res.ok) {
      log(`Project moved to folder "${dirHandle.name}" (${res.files} files)`, 'info', 'Project')
      showToast('Project moved to folder', { detail: dirHandle.name })
    } else if (!res.needsConfirm) {
      log(`Move to folder failed: ${res.error}`, 'error', 'Project')
      showToast('Could not move project', { detail: res.error, kind: 'error', ms: 6000 })
    }
    return res.ok
  }

  async function moveCurrentProjectToFolder(id = currentProjectId.value) {
    if (!id || refuseWhileBusy('Move project')) return
    // Failed writes do not stop a move (a full browser storage is the reason to move):
    // the copy holds what was saved, and reopenMoved retries the rest in the folder.
    await flushProjectWork().catch(() => {})
    const dirHandle = await pickDirectory()
    if (!dirHandle) return
    if (await moveToFolder(id, dirHandle)) await reopenMoved(id)
  }

  // ── Browser storage full during a run ──────────────────────────────────────
  // A run whose write finds browser storage full asks here (utils/storageFull.js; the
  // depth-map run): move the project to a folder on disk and the run carries on
  // there. The browser copy stays until the run has ended, because the run still
  // reads its files; then it goes, and the project reopens from the folder as after
  // any move. A tab closed before that drops it at the next open (openProject).
  let movedDuringRun = null
  async function offerMoveOnStorageFull({ projectId }) {
    const entry = projects.value.find((p) => p.id === projectId)
    if (!entry || projectId !== currentProjectId.value || isFolderProject(entry)) return false
    if (typeof window.showDirectoryPicker !== 'function') return false
    for (;;) {
      const move = await confirmDialog({
        title: 'Browser storage is full',
        message:
          'The browser has no room left for this project. Move it to a folder on your disk, ' +
          'and the run continues there. If you stop, the run ends and has to start again.',
        confirmLabel: 'Choose a folder…',
        cancelLabel: 'Stop the run',
        danger: false,
      })
      if (!move) {
        log('Browser storage full: the run was stopped instead of moving the project to a folder', 'warn', 'Project')
        return false
      }
      const dirHandle = await pickDirectory()
      if (dirHandle && (await moveToFolder(projectId, dirHandle, { keepBrowserCopy: true }))) {
        movedDuringRun = projectId
        log('The run continues with the project in its folder', 'info', 'Project')
        return true
      }
      // No folder picked, or the move failed: ask again, so stopping stays a choice.
    }
  }
  setStorageFullHandler(offerMoveOnStorageFull)
  watch(isBusy, async (busy) => {
    if (busy || !movedDuringRun) return
    const id = movedDuringRun
    movedDuringRun = null
    await dropBrowserCopy(id).catch((err) =>
      log(`Could not delete the browser copy of the moved project: ${err?.message ?? err}`, 'warn', 'Project'),
    )
    await reopenMoved(id)
  })

  async function moveCurrentProjectToBrowser(id = currentProjectId.value) {
    if (!id || refuseWhileBusy('Move project')) return
    await flushProjectWork()
    if (
      !(await confirmDialog({
        title: 'Move into browser storage?',
        message:
          'Copy this project into browser storage? The folder on disk is left in place, ' +
          'and WebSfM will stop writing to it.',
        confirmLabel: 'Copy',
      }))
    )
      return
    let moved = false
    await withLoadingOverlay('Moving project into browser storage…', async () => {
      const res = await moveProjectToBrowser(id, { onProgress: fileProgress })
      if (res.ok) {
        moved = true
        log(`Project moved into browser storage (${res.files} files)`, 'info', 'Project')
        showToast('Project moved into browser storage')
      } else {
        log(`Move into browser storage failed: ${res.error}`, 'error', 'Project')
        showToast('Could not move project', { detail: res.error, kind: 'error', ms: 6000 })
      }
    })
    if (moved) await reopenMoved(id)
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
    if (!file || refuseWhileBusy('Open project file')) return
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

  // ── Coordinate system ───────────────────────────────────────────────────────
  // Changing the project CRS re-projects everything stored in it, after a
  // confirmation that says what that touches: a CRS picked by accident while
  // searching must not silently move every GCP and camera. Resolves true once applied.
  async function handleSetCrs(crs) {
    if (!currentProjectId.value) return false
    const prevCrs = projects.value.find((p) => p.id === currentProjectId.value)?.crs || 'EPSG:4326'
    if (crs === prevCrs) return false
    await ensureProjection(crs).catch(() => {})
    if (
      !(await confirmDialog({
        title: 'Change the project CRS?',
        message: crsChangeMessage(prevCrs, crs),
        confirmLabel: 'Change CRS',
      }))
    )
      return false
    await setProjectCrs(currentProjectId.value, crs, async (fromCrs, toCrs) => {
      await gcpsStore.reprojectGcps(fromCrs, toCrs)
      await footprintsStore.reprojectFootprints(fromCrs, toCrs)
      await posesStore.reprojectPoses(fromCrs, toCrs)
    })
    log(`Project CRS: ${prevCrs} → ${crs}`, 'info', 'Project')
    return true
  }

  function crsChangeMessage(fromCrs, toCrs) {
    const named = (code) => {
      const n = crsInfo(code).name
      return n && n !== code ? `${code} (${n})` : code
    }
    const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
    const polygons = footprintsStore.sets.reduce((n, s) => n + s.footprints.length, 0)
    const moved = [
      gcpsStore.gcps.length && count(gcpsStore.gcps.length, 'GCP'),
      posesStore.poses.length && count(posesStore.poses.length, 'camera position'),
      polygons && count(polygons, 'footprint polygon'),
    ].filter(Boolean)
    return (
      `Switch from ${named(fromCrs)} to ${named(toCrs)}. ` +
      (moved.length
        ? `${moved.join(', ')} will be reprojected into the new CRS. `
        : 'Nothing stored in the project needs reprojecting. ') +
      (reconstructionStore.georef ? 'The current georeference is cleared; run Georeference again afterwards. ' : '') +
      'Imported rasters, DEMs and orthophotos keep the CRS they were made in.'
    )
  }

  // The one-click projected CRS offered while the project CRS is geographic
  // (reconstructionStore.crsSuggestion, core/crsSuggest.js). Same path as picking it
  // by hand; the log line carries the derived value and its inputs.
  async function applyCrsSuggestion(suggestion) {
    if (!suggestion?.code) return
    if (!(await handleSetCrs(suggestion.code))) return
    log(
      `Project CRS ${suggestion.code} (${suggestion.name}) was suggested from the median of ` +
        `${pluralize(suggestion.count, 'camera position')} at ${suggestion.lat.toFixed(4)}, ${suggestion.lon.toFixed(4)} (lat, lon)`,
      'info',
      'Project',
    )
  }

  // ── Project picker actions ──────────────────────────────────────────────────
  async function handleSwitchProject(id) {
    if (id === currentProjectId.value) {
      projectPickerOpen.value = false
      return
    }
    projectPickerOpen.value = false
    await openProject(id)
  }

  async function handleDeleteProject(id) {
    if (refuseWhileBusy('Delete project')) return
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
    projectLoading,
    projectLoadingProgress,
    projectLoadingLabel,
    handleCreateProject,
    handleCancelNewProject,
    openExample,
    folderPrompt,
    folderPromptProject,
    onFolderConnect,
    onFolderRepick,
    openProjectFolder,
    moveCurrentProjectToFolder,
    moveCurrentProjectToBrowser,
    onSaveProject,
    importProjectFile,
    onProjectFilePick,
    handleSwitchProject,
    handleDeleteProject,
    handleSetCrs,
    applyCrsSuggestion,
  }
}
