import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createWorkflow, normalizeWorkflow } from '../core/workflow.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useLog } from '../composables/useLog.js'

const TEMPLATE_KEY = 'websfm-workflow-templates-v1'
const MAX_RUNS = 30

function readTemplates() {
  try {
    const value = JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '[]')
    return Array.isArray(value) ? value.map(normalizeWorkflow) : []
  } catch { return [] }
}

export const useWorkflowsStore = registerProjectStore(defineStore('workflows', () => {
  const projects = useProjectsStore()
  const { log } = useLog()
  const workflows = ref([])
  const activeId = ref(null)
  const runs = ref([])
  let restoreGeneration = 0
  const templates = ref(typeof localStorage === 'undefined' ? [] : readTemplates())

  const activeWorkflow = computed(() => workflows.value.find((w) => w.id === activeId.value) ?? workflows.value[0] ?? null)
  const isPersisting = () => projects.isPersisting

  async function save() {
    if (!isPersisting()) return
    await opfs.saveWorkflows(projects.currentProjectId, {
      workflows: workflows.value,
      activeId: activeId.value,
      runs: runs.value,
    }).catch((err) => log(`Workflow save failed — ${err?.message ?? err}`, 'error', 'Workflow'))
  }

  function addWorkflow(workflow = createWorkflow()) {
    const value = normalizeWorkflow(workflow)
    workflows.value.push(value)
    activeId.value = value.id
    save()
    return value.id
  }

  function ensureWorkflow() {
    if (activeWorkflow.value) return activeWorkflow.value
    addWorkflow(createWorkflow())
    return activeWorkflow.value
  }

  function updateWorkflow(id, patch) {
    const index = workflows.value.findIndex((w) => w.id === id)
    if (index < 0) return
    workflows.value[index] = normalizeWorkflow({
      ...workflows.value[index], ...patch, id,
      updatedAt: new Date().toISOString(),
    })
    save()
  }

  function removeWorkflow(id) {
    const index = workflows.value.findIndex((w) => w.id === id)
    if (index < 0) return
    workflows.value.splice(index, 1)
    if (activeId.value === id) activeId.value = workflows.value[0]?.id ?? null
    save()
  }

  function duplicateWorkflow(id) {
    const source = workflows.value.find((w) => w.id === id)
    if (!source) return null
    const copy = normalizeWorkflow({ ...JSON.parse(JSON.stringify(source)), id: null, name: `${source.name} copy`, createdAt: null })
    return addWorkflow(copy)
  }

  function setActive(id) {
    if (!workflows.value.some((w) => w.id === id)) return
    activeId.value = id
    save()
  }

  function saveTemplate(id) {
    const source = workflows.value.find((w) => w.id === id)
    if (!source) return
    const copy = normalizeWorkflow({ ...JSON.parse(JSON.stringify(source)), id: null, name: source.name })
    templates.value.push(copy)
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates.value))
    log(`Workflow template saved: ${copy.name}`, 'success', 'Workflow', { channel: 'activity' })
  }

  function applyTemplate(templateId) {
    const template = templates.value.find((w) => w.id === templateId)
    if (!template) return null
    return addWorkflow(normalizeWorkflow({ ...JSON.parse(JSON.stringify(template)), id: null, createdAt: null }))
  }

  function removeTemplate(id) {
    templates.value = templates.value.filter((w) => w.id !== id)
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(templates.value))
  }

  function recordRun(snapshot) {
    runs.value.unshift({
      id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...snapshot,
      workflow: normalizeWorkflow(snapshot.workflow),
    })
    if (runs.value.length > MAX_RUNS) runs.value.length = MAX_RUNS
    save()
  }

  async function restore({ projectId, projectData }) {
    const generation = ++restoreGeneration
    const data = await opfs.loadWorkflows(projectId)
    if (generation !== restoreGeneration || projectId !== projects.currentProjectId) return
    workflows.value = Array.isArray(data?.workflows) ? data.workflows.map(normalizeWorkflow) : []
    runs.value = Array.isArray(data?.runs) ? data.runs.slice(0, MAX_RUNS) : []
    activeId.value = workflows.value.some((w) => w.id === data?.activeId) ? data.activeId : workflows.value[0]?.id ?? null
    if (!workflows.value.length) ensureWorkflow()
  }

  function clear({ purge = false } = {}) {
    restoreGeneration++
    workflows.value = []
    activeId.value = null
    runs.value = []
    if (purge && isPersisting()) opfs.deleteWorkflows(projects.currentProjectId).catch(() => {})
  }

  return {
    workflows, activeId, activeWorkflow, runs, templates,
    addWorkflow, ensureWorkflow, updateWorkflow, removeWorkflow, duplicateWorkflow,
    setActive, saveTemplate, applyTemplate, removeTemplate, recordRun, save, restore, clear,
  }
}))
