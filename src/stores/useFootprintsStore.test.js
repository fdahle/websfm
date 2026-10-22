import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useFootprintsStore } from './useFootprintsStore.js'
import { useProjectsStore } from './useProjectsStore.js'

describe('computeFootprints', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function openTransientProject(crs = 'EPSG:32632') {
    const projects = useProjectsStore()
    projects.persistenceAvailable = false
    projects.projects = [{ id: 'project-1', name: 'test', sceneType: 'aerial', crs }]
    projects.currentProjectId = 'project-1'
  }

  it('replaces the previous footprint set but keeps contour line layers', async () => {
    openTransientProject()
    const store = useFootprintsStore()
    const ring = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]
    store.sets = [
      { id: 'old', name: 'footprints', source: 'computed', visible: true, footprints: [{ id: 'a', rings: [ring] }] },
      { id: 'imp', name: 'Imported', source: 'imported', visible: true, footprints: [{ id: 'b', rings: [ring] }] },
    ]
    await store.addLineSet([{ path: ring, level: 100, index: true }], 'EPSG:32632', 'Contours')

    await store.computeFootprints()

    expect(store.sets.map((s) => s.name)).toEqual(['Imported', 'Contours'])
  })
})
