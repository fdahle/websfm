import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref } from 'vue'

const removed = []
const dir = { removeEntry: vi.fn(async (name) => { removed.push(name) }) }
const pruned = []
vi.mock('../../utils/opfs.js', () => ({
  lodDir: vi.fn(async () => dir),
  pruneLodFiles: vi.fn(async (pid, keep) => { pruned.push([...keep]); return 0 }),
  loadLodFile: vi.fn(async (pid, name) => new Blob([name])),
}))
const importCopc = vi.fn()
vi.mock('../../workers/computeClient.js', () => ({ importCopc: (...a) => importCopc(...a) }))

const { createCloudLod } = await import('./cloudLod.js')

const meta = (name) => ({
  format: 'copc', name, dataFile: `${name}.copc.laz`, hierarchyFile: null, points: 9_000_000,
  layout: { offset: [0, 0, 0], scale: [0.01, 0.01, 0.01], colour: false, attributes: [] },
  file: { crs: 'EPSG:25832', crsName: 'ETRS89 / UTM zone 32N' },
})
function setup({ crs = null, pid = 'p1' } = {}) {
  const clouds = ref([])
  const log = vi.fn()
  let project = pid
  const store = createCloudLod({ clouds, log, save: vi.fn(), projectId: () => project, makeCloudId: () => 'c7',
    selectedCloudId: ref(null), projectCrs: () => crs })
  return { clouds, log, store, close: () => { project = null } }
}

describe('importCopcCloud', () => {
  beforeEach(() => { removed.length = 0; pruned.length = 0; importCopc.mockReset() })

  it('adds a streamed cloud read in place from the copied file, and keeps that file', async () => {
    importCopc.mockImplementation(async ({ name }) => meta(name))
    const { clouds, store, log } = setup({ crs: 'EPSG:25832' })
    const cloud = await store.importCopcCloud(new File(['x'], 'survey.copc.laz'))
    expect(cloud).toMatchObject({ kind: 'dense', imported: true, pos: null, count: 9_000_000, style: { field: 'elevation' } })
    expect(cloud.lod.format).toBe('copc')
    expect(clouds.value).toEqual([cloud])
    expect(pruned.at(-1)).toContain(cloud.lod.dataFile)
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('not reprojected'), 'warn', 'Import')
  })

  it('says so when the file is in another CRS than the project', async () => {
    importCopc.mockImplementation(async ({ name }) => meta(name))
    const { store, log } = setup({ crs: 'EPSG:32632' })
    await store.importCopcCloud(new File(['x'], 'survey.copc.laz'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('EPSG:25832, the project in EPSG:32632'), 'warn', 'Import')
  })

  it('only hints when the project is still in its default CRS', async () => {
    importCopc.mockImplementation(async ({ name }) => meta(name))
    const { store, log } = setup({ crs: 'EPSG:4326' })
    await store.importCopcCloud(new File(['x'], 'survey.copc.laz'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('set the project CRS to EPSG:25832'), 'info', 'Import')
  })

  it('drops the copy when the project closed meanwhile', async () => {
    const ctx = setup()
    importCopc.mockImplementation(async ({ name }) => { ctx.close(); return meta(name) })
    expect(await ctx.store.importCopcCloud(new File(['x'], 'survey.copc.laz'))).toBe(null)
    expect(removed).toEqual([expect.stringMatching(/\.copc\.laz$/)])
    expect(ctx.clouds.value).toEqual([])
  })

  it('needs a saved project', async () => {
    const { store, log } = setup({ pid: null })
    expect(await store.importCopcCloud(new File(['x'], 'survey.copc.laz'))).toBe(null)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('needs a saved project'), 'error', 'Import')
  })
})
