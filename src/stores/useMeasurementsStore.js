import { ref } from 'vue'
import { defineStore } from 'pinia'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import * as opfs from '../utils/opfs.js'

export const useMeasurementsStore = registerProjectStore(defineStore('measurements', () => {
  const projects = useProjectsStore(), records = ref([]), error = ref('')
  let generation = 0
  function save() {
    if (!projects.isPersisting) return Promise.resolve()
    const id = projects.currentProjectId, token = generation
    const data = JSON.parse(JSON.stringify({ version: 1, records: records.value }))
    return opfs.saveMeasurements(id, data).catch(err => { if (token === generation) error.value = `Measurement save failed: ${err.message}` })
  }
  function add(record) {
    const item = JSON.parse(JSON.stringify({ ...record, id: crypto.randomUUID(), savedAt: Date.now() }))
    records.value.push(item); save(); return item.id
  }
  function rename(id, name) {
    const r = records.value.find(r => r.id === id)
    if (r && name.trim()) { r.name = name.trim(); save() }
  }
  function remove(id) { records.value = records.value.filter(r => r.id !== id); save() }
  async function restore({ projectId }) {
    const token = ++generation
    const data = await opfs.loadMeasurements(projectId)
    if (token !== generation || projectId !== projects.currentProjectId) return
    records.value = Array.isArray(data?.records) ? data.records.filter(r => r?.id && Array.isArray(r.vertices)) : []
  }
  function clear({ purge = false } = {}) {
    generation++; records.value = []; error.value = ''
    if (purge && projects.isPersisting) opfs.deleteMeasurements(projects.currentProjectId).catch(() => {})
  }
  return { records, error, add, rename, remove, save, restore, clear }
}))
