import { ref, computed } from 'vue'
import * as opfs from '../utils/opfs.js'

export function useProjects() {
  const persistenceEnabled = ref(localStorage.getItem('persistenceEnabled') === 'true')
  const projects = ref([])        // [{ id, name, sceneType, createdAt, lastModified }]
  const currentProjectId = ref(null)

  const currentProject = computed(() =>
    projects.value.find((p) => p.id === currentProjectId.value) || null,
  )
  const currentProjectName = computed(() => currentProject.value?.name || null)
  const currentSceneType = computed(() => currentProject.value?.sceneType || null)

  function setPersistence(enabled) {
    persistenceEnabled.value = enabled
    localStorage.setItem('persistenceEnabled', String(enabled))
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

  async function createProject(name, sceneType) {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    const entry = { id, name, sceneType, createdAt: now, lastModified: now }
    projects.value.push(entry)
    currentProjectId.value = id
    await opfs.writeProject(id, { ...entry, images: [] })
    await saveIndex()
    return id
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
    persistenceEnabled,
    projects,
    currentProjectId,
    currentProjectName,
    currentSceneType,
    setPersistence,
    loadIndex,
    saveIndex,
    createProject,
    switchProject,
    renameProject,
    deleteProjectById,
    touchProject,
  }
}
