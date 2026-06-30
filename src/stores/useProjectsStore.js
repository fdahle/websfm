import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'

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
    projects.value.push(entry)
    currentProjectId.value = id
    await opfs.writeProject(id, { ...entry, images: [] })
    await saveIndex()
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

  async function switchProject(id) {
    currentProjectId.value = id
    const p = projects.value.find((p) => p.id === id)
    if (p) p.lastModified = new Date().toISOString()
    await saveIndex()
    return await opfs.readProject(id)
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

  async function deleteProjectById(id) {
    projects.value = projects.value.filter((p) => p.id !== id)
    await opfs.deleteProject(id)
    if (currentProjectId.value === id) currentProjectId.value = null
    await saveIndex()
    return projects.value[0]?.id || null
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
    touchProject,
  }
})
