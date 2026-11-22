import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import * as opfs from '../utils/opfs.js'

vi.mock('../utils/opfs.js', () => ({
  saveWorkflows: vi.fn(async () => {}),
  loadWorkflows: vi.fn(async () => null),
  deleteWorkflows: vi.fn(async () => {}),
}))
vi.mock('../composables/useLog.js', () => ({ useLog: () => ({ log: vi.fn() }) }))

import { useWorkflowsStore } from './useWorkflowsStore.js'
import { useProjectsStore } from './useProjectsStore.js'

describe('useWorkflowsStore', () => {
  beforeEach(() => {
    const data = new Map()
    globalThis.localStorage = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, String(value)),
      removeItem: (key) => data.delete(key),
      clear: () => data.clear(),
    }
    setActivePinia(createPinia())
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('creates and duplicates project workflows independently', () => {
    const store = useWorkflowsStore()
    const id = store.addWorkflow()
    const copyId = store.duplicateWorkflow(id)
    expect(store.workflows).toHaveLength(2)
    expect(copyId).not.toBe(id)
    store.workflows[1].blocks.push({ type: 'x' })
    expect(store.workflows[0].blocks).toHaveLength(0)
  })

  it('copies a project workflow into global templates', () => {
    const store = useWorkflowsStore()
    const id = store.addWorkflow()
    store.saveTemplate(id)
    expect(store.templates).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem('websfm-workflow-templates-v1'))).toHaveLength(1)
  })

  it('opening the builder while the workflows load neither replaces nor hides the saved ones', async () => {
    const projects = useProjectsStore()
    projects.projects = [{ id: 'project-1', name: 'One', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'
    let finish
    vi.mocked(opfs.loadWorkflows).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const store = useWorkflowsStore()
    const restoring = store.restore({ projectId: 'project-1' })
    store.ensureWorkflow() // the builder opened on the still-empty list
    expect(store.workflows).toEqual([])
    expect(opfs.saveWorkflows).not.toHaveBeenCalled()
    const saved = { id: 'w-saved', name: 'My sparse workflow', blocks: [] }
    finish({ workflows: [saved], activeId: 'w-saved', runs: [] })
    await restoring
    expect(store.workflows.map((w) => w.name)).toEqual(['My sparse workflow'])
    expect(store.activeWorkflow.id).toBe('w-saved')
    // Afterwards it makes a workflow only for a project that has none.
    store.ensureWorkflow()
    expect(store.workflows).toHaveLength(1)
  })

  it('a project without saved workflows still gets one after its restore', async () => {
    const projects = useProjectsStore()
    projects.projects = [{ id: 'project-1', name: 'One', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'
    const store = useWorkflowsStore()
    await store.restore({ projectId: 'project-1' })
    expect(store.workflows).toHaveLength(1)
    expect(store.activeWorkflow).not.toBeNull()
  })

  it('ignores a restore that finishes after the project was cleared', async () => {
    const projects = useProjectsStore()
    projects.projects = [{ id: 'project-1', name: 'One', sceneType: 'object' }]
    projects.currentProjectId = 'project-1'
    let finish
    vi.mocked(opfs.loadWorkflows).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    const store = useWorkflowsStore()
    const restoring = store.restore({ projectId: 'project-1' })
    store.clear()
    projects.currentProjectId = null
    finish({ workflows: [{ name: 'Stale', blocks: [] }], runs: [] })
    await restoring
    expect(store.workflows).toEqual([])
    expect(store.runs).toEqual([])
  })
})
