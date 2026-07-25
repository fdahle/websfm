import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'
import { exportProjectArchive, importProjectArchive, peekArchiveManifest } from '../utils/projectFile.js'
import {
  buildManifest, validateManifest, archiveFileName, importedProjectName,
} from '../core/io/projectArchive.js'
import {
  STORAGE_FOLDER, STORAGE_OPFS, isFolderProject, folderOpenPlan, folderStorageSupported,
  adoptFolderVerdict, newFolderVerdict, copyVerified,
} from '../core/io/folderProject.js'
import { saveProjectHandle, loadProjectHandle, deleteProjectHandle } from '../utils/handleStore.js'

// The project index: which projects exist, which one is open, and its metadata
// (name, scene type, working CRS). Foundational store — most other stores read
// `currentProjectId` / `persistenceAvailable` / `currentCrs` from here to decide
// whether and where to persist. It is the project *index*, not project content,
// so it is not itself a registry-driven project-scoped store.
export const useProjectsStore = defineStore('projects', () => {
  // Persistence is always on; this only tracks whether OPFS is usable in this
  // environment. When false, the app runs transiently without a project.
  const persistenceAvailable = ref(true)
  const projects = ref([])        // [{ id, name, sceneType, createdAt, lastModified }]
  const currentProjectId = ref(null)

  const currentProject = computed(() =>
    projects.value.find((p) => p.id === currentProjectId.value) || null,
  )
  const currentProjectName = computed(() => currentProject.value?.name || null)
  const currentSceneType = computed(() => currentProject.value?.sceneType || null)
  const currentCrs = computed(() => currentProject.value?.crs || 'EPSG:4326')

  // True when there is an open project AND OPFS is usable — the single gate every
  // project-scoped store checks before reading/writing persistence. Hoisted here
  // (was duplicated as a local `isPersisting()` in each store).
  const isPersisting = computed(() => persistenceAvailable.value && !!currentProjectId.value)

  function setPersistenceAvailable(available) {
    persistenceAvailable.value = available
  }

  // ── Index I/O ───────────────────────────────────────────────────────────────

  async function loadIndex() {
    const index = await opfs.readIndex()
    if (index?.projects) projects.value = index.projects
    return index?.lastOpenedId || null
  }

  async function saveIndex() {
    await opfs.writeIndex({
      version: 1,
      lastOpenedId: currentProjectId.value,
      projects: projects.value,
    })
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async function createProject(name, sceneType, crs = 'EPSG:4326') {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const entry = { id, name, sceneType, crs, createdAt: now, lastModified: now }
    // Persist the project before exposing it as current. If storage fails the
    // caller remains in the old project instead of selecting a half-created one.
    await opfs.writeProject(id, { ...entry, images: [] })
    const previousId = currentProjectId.value
    projects.value.push(entry)
    currentProjectId.value = id
    try {
      await saveIndex()
    } catch (err) {
      projects.value = projects.value.filter((p) => p.id !== id)
      currentProjectId.value = previousId
      await opfs.deleteProject(id).catch(() => {})
      throw err
    }
    return id
  }

  async function setProjectCrs(id, crs, onChanged) {
    const p = projects.value.find((p) => p.id === id)
    if (!p || p.crs === crs) return
    const prevCrs = p.crs || 'EPSG:4326'
    p.crs = crs
    p.lastModified = new Date().toISOString()
    const data = await opfs.readProject(id)
    if (data) await opfs.writeProject(id, { ...data, crs })
    await saveIndex()
    await onChanged?.(prevCrs, crs)
  }

  // Returns the project.json payload, or null when it could not be read. For a
  // folder project that ALSO means "not connected" — the caller distinguishes
  // the two via `openPlan(id)`, which it must consult first.
  async function switchProject(id) {
    const p = projects.value.find((p) => p.id === id)
    if (!p) return null
    // Read first, commit second. Folder permission and corrupt/missing project
    // failures must not change lastOpenedId or abandon the active project.
    const data = await opfs.readProject(id)
    if (!data) return null
    const previousId = currentProjectId.value
    const previousModified = p.lastModified
    currentProjectId.value = id
    if (p) p.lastModified = new Date().toISOString()
    try {
      await saveIndex()
    } catch (err) {
      currentProjectId.value = previousId
      p.lastModified = previousModified
      throw err
    }
    return data
  }

  async function renameProject(id, newName) {
    const p = projects.value.find((p) => p.id === id)
    if (!p) return
    p.name = newName
    p.lastModified = new Date().toISOString()
    const data = await opfs.readProject(id)
    if (data) await opfs.writeProject(id, { ...data, name: newName })
    await saveIndex()
  }

  // For a folder project this FORGETS rather than deletes: the files are on the
  // user's own disk and removing them is not ours to do (opfs.deleteProject
  // enforces that; the picker's confirm text says so).
  async function deleteProjectById(id) {
    projects.value = projects.value.filter((p) => p.id !== id)
    await opfs.deleteProject(id)
    opfs.clearProjectRoot(id)
    await deleteProjectHandle(id)
    if (currentProjectId.value === id) currentProjectId.value = null
    await saveIndex()
    return projects.value[0]?.id || null
  }

  // ── Folder-backed projects ──────────────────────────────────────────────────
  // The project's files live in a directory the user picked instead of in OPFS.
  // The layout is identical, so all of this is about *reaching* the directory:
  // loading the stored handle, checking its permission, and re-registering it as
  // the project root (utils/opfs.js `setProjectRoot`) before anything restores.

  const folderSupported = computed(() => folderStorageSupported())

  function projectEntry(id) {
    return projects.value.find((p) => p.id === id) || null
  }

  // → { action: 'open' | 'reconnect' | 'repick', reason, handle }
  // Consult this BEFORE switchProject on any project that might be folder-backed:
  // reading project.json from an unpermitted handle just fails, and the failure
  // is indistinguishable from a corrupt project.
  async function openPlan(id) {
    const entry = projectEntry(id)
    if (!isFolderProject(entry)) return folderOpenPlan({ entry })
    const handle = await loadProjectHandle(id)
    let permission = null
    if (handle) {
      try { permission = await handle.queryPermission({ mode: 'readwrite' }) } catch { permission = null }
    }
    const plan = folderOpenPlan({ entry, handle, permission })
    if (plan.action === 'open') opfs.setProjectRoot(id, handle)
    return { ...plan, handle }
  }

  // Must be called from a user gesture — `requestPermission` is rejected outright
  // without one, which is exactly why this is a separate action behind a button
  // rather than a retry inside openPlan.
  async function reconnectProjectFolder(id) {
    const handle = await loadProjectHandle(id)
    if (!handle) return { ok: false, error: 'the folder link was lost — pick the folder again' }
    let permission
    try { permission = await handle.requestPermission({ mode: 'readwrite' }) } catch { permission = 'denied' }
    if (permission !== 'granted') return { ok: false, error: 'permission to read the folder was not granted' }
    // A granted handle can still point at a folder that has since moved or been
    // deleted; probing it now turns that into an honest "pick it again".
    try { await handle.getFileHandle('project.json') } catch {
      return { ok: false, error: 'the folder is no longer there — pick it again' }
    }
    opfs.setProjectRoot(id, handle)
    return { ok: true }
  }

  // Re-point an existing folder project at a freshly picked directory (folder
  // moved / renamed / handle lost).
  async function relinkProjectFolder(id, dirHandle) {
    const data = await opfs.readJsonAt(dirHandle, 'project.json')
    const verdict = adoptFolderVerdict({ hasProjectJson: !!data, isEmpty: await opfs.dirIsEmpty(dirHandle) })
    if (!verdict.ok) return verdict
    opfs.setProjectRoot(id, dirHandle)
    await saveProjectHandle(id, dirHandle)
    const entry = projectEntry(id)
    if (entry) { entry.storage = STORAGE_FOLDER; entry.folderName = dirHandle.name }
    await saveIndex()
    return { ok: true }
  }

  // Create a brand-new project whose files live in `dirHandle`.
  async function createFolderProject(name, sceneType, crs, dirHandle, { confirmed = false } = {}) {
    const hasProjectJson = !!(await opfs.readJsonAt(dirHandle, 'project.json'))
    const verdict = newFolderVerdict({ isEmpty: await opfs.dirIsEmpty(dirHandle), hasProjectJson, confirmed })
    if (!verdict.ok) return verdict

    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const entry = {
      id, name, sceneType, crs, createdAt: now, lastModified: now,
      storage: STORAGE_FOLDER, folderName: dirHandle.name,
    }
    opfs.setProjectRoot(id, dirHandle)
    await saveProjectHandle(id, dirHandle)
    await opfs.writeProject(id, { ...entry, images: [] })
    projects.value.push(entry)
    currentProjectId.value = id
    await saveIndex()
    return { ok: true, id }
  }

  // "Open folder as project": adopt a directory that already holds a project.
  // Its internal ids are kept (they are project-scoped), only the index entry is
  // new — so the same folder opened on two machines stays the same project.
  async function adoptFolderProject(dirHandle) {
    const data = await opfs.readJsonAt(dirHandle, 'project.json')
    const verdict = adoptFolderVerdict({ hasProjectJson: !!data, isEmpty: await opfs.dirIsEmpty(dirHandle) })
    if (!verdict.ok) return verdict

    // Re-adopting a folder already in the list re-links it instead of duplicating.
    const existing = projects.value.find((p) => p.id === data.id)
    if (existing) {
      const res = await relinkProjectFolder(existing.id, dirHandle)
      return res.ok ? { ok: true, id: existing.id } : res
    }

    const id = data.id || crypto.randomUUID()
    const now = new Date().toISOString()
    const entry = {
      id,
      name: data.name || dirHandle.name || 'Project',
      sceneType: data.sceneType || 'aerial',
      crs: data.crs ?? null,
      createdAt: data.createdAt || now,
      lastModified: now,
      storage: STORAGE_FOLDER,
      folderName: dirHandle.name,
    }
    opfs.setProjectRoot(id, dirHandle)
    await saveProjectHandle(id, dirHandle)
    if (data.id !== id) await opfs.writeProject(id, { ...data, id })
    projects.value.push(entry)
    await saveIndex()
    return { ok: true, id }
  }

  // ── Migration between backends ──────────────────────────────────────────────
  // A plain tree copy, because the two layouts are identical. The source is only
  // dropped once the copy is verified file-for-file and byte-for-byte — and only
  // when the source is OPFS. Files on the user's own disk are never deleted;
  // "move into browser storage" copies and detaches, leaving the folder in place.

  async function moveProjectToFolder(id, dirHandle, { confirmed = false, onProgress = null } = {}) {
    const entry = projectEntry(id)
    if (!entry) return { ok: false, error: 'project not found' }
    if (isFolderProject(entry)) return { ok: false, error: 'that project is already in a folder' }

    const hasProjectJson = !!(await opfs.readJsonAt(dirHandle, 'project.json'))
    const verdict = newFolderVerdict({ isEmpty: await opfs.dirIsEmpty(dirHandle), hasProjectJson, confirmed })
    if (!verdict.ok) return verdict

    const source = await opfs.getOpfsProjectDir(id)
    const before = await opfs.measureTree(source)
    const copied = await opfs.copyTree(source, dirHandle, { onProgress })
    if (!copyVerified(before, copied)) {
      return { ok: false, error: `copy did not verify (${copied.files}/${before.files} files) — the project was left in browser storage` }
    }

    opfs.setProjectRoot(id, dirHandle)
    await saveProjectHandle(id, dirHandle)
    entry.storage = STORAGE_FOLDER
    entry.folderName = dirHandle.name
    entry.lastModified = new Date().toISOString()
    await saveIndex()
    await opfs.deleteOpfsProjectTree(id)   // safe: verified, and the tree is ours
    return { ok: true, ...copied }
  }

  async function moveProjectToBrowser(id, { onProgress = null } = {}) {
    const entry = projectEntry(id)
    if (!entry) return { ok: false, error: 'project not found' }
    if (!isFolderProject(entry)) return { ok: false, error: 'that project is already in browser storage' }

    const plan = await openPlan(id)
    if (plan.action !== 'open') return { ok: false, error: 'connect to the folder first' }

    const source = plan.handle
    const before = await opfs.measureTree(source)
    const target = await opfs.getOpfsProjectDir(id, true)
    const copied = await opfs.copyTree(source, target, { onProgress })
    if (!copyVerified(before, copied)) {
      await opfs.deleteOpfsProjectTree(id)
      return { ok: false, error: `copy did not verify (${copied.files}/${before.files} files) — the project was left in its folder` }
    }

    opfs.clearProjectRoot(id)
    await deleteProjectHandle(id)
    entry.storage = STORAGE_OPFS
    delete entry.folderName
    entry.lastModified = new Date().toISOString()
    await saveIndex()
    return { ok: true, ...copied }
  }

  // ── Project file (.websfm) ──────────────────────────────────────────────────
  // Save/load is a zip/unzip of the project's own directory tree — see
  // core/io/projectArchive.js for why there is no separate format. The store's
  // only job either way is the *index*: the archive carries project content,
  // the index entry says the project exists.

  // → { cancelled } | { fileName, archiveBytes, … }. Throws with a user-facing
  // message (too large, no data, write failed) for the caller to surface.
  async function exportProject(id, { includeDerived = true, onProgress = null, onLog = null } = {}) {
    const project = projects.value.find((p) => p.id === id)
    if (!project) throw new Error('project not found')
    return exportProjectArchive({
      projectId: id,
      manifest: buildManifest({ project, includeDerived }),
      fileName: archiveFileName(project.name),
      includeDerived,
      onProgress,
      onLog,
    })
  }

  // Unpack into a FRESH project id. Internal image/pair/cloud uuids are
  // project-scoped, so nothing inside needs rewriting — only `project.json`'s own
  // id (and the name, on a clash) are stamped over afterwards.
  // Returns the new project id; the caller opens it through the normal restore path.
  async function importProject(file, { onProgress = null, onLog = null } = {}) {
    if (!persistenceAvailable.value) throw new Error('browser storage is unavailable — cannot import a project')

    // Validate before writing a single byte: the manifest is the archive's first
    // entry, so this costs a few kB rather than a multi-GB unpack-then-reject.
    const peeked = await peekArchiveManifest(file)
    const verdict = validateManifest(peeked)
    if (!verdict.ok) throw new Error(verdict.error)

    const id = crypto.randomUUID()
    let manifest
    try {
      ;({ manifest } = await importProjectArchive({ file, projectId: id, onProgress, onLog }))
    } catch (err) {
      await opfs.deleteProject(id).catch(() => {})   // never leave a half-written project behind
      throw err
    }

    const data = await opfs.readProject(id)
    if (!data) {
      await opfs.deleteProject(id).catch(() => {})
      throw new Error('project file is missing project.json')
    }

    const name = importedProjectName(manifest.project?.name || data.name || 'Imported project',
      projects.value.map((p) => p.name))
    const now = new Date().toISOString()
    const entry = {
      id,
      name,
      sceneType: data.sceneType || manifest.project?.sceneType || 'aerial',
      crs: data.crs ?? manifest.project?.crs ?? null,
      createdAt: data.createdAt || manifest.project?.createdAt || now,
      lastModified: now,
    }
    await opfs.writeProject(id, { ...data, ...entry })
    projects.value.push(entry)
    await saveIndex()
    return id
  }

  async function touchProject() {
    const p = currentProject.value
    if (!p) return
    p.lastModified = new Date().toISOString()
    await saveIndex()
  }

  return {
    persistenceAvailable,
    projects,
    currentProjectId,
    currentProject,
    currentProjectName,
    currentSceneType,
    currentCrs,
    isPersisting,
    setPersistenceAvailable,
    loadIndex,
    saveIndex,
    createProject,
    setProjectCrs,
    switchProject,
    renameProject,
    deleteProjectById,
    folderSupported,
    openPlan,
    reconnectProjectFolder,
    relinkProjectFolder,
    createFolderProject,
    adoptFolderProject,
    moveProjectToFolder,
    moveProjectToBrowser,
    exportProject,
    importProject,
    touchProject,
  }
})
