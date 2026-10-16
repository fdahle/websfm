import { markRaw } from 'vue'
import * as opfs from '../../utils/opfs.js'
import { buildLod as workerBuildLod } from '../../workers/computeClient.js'
import { openLodReader } from '../../core/lod/reader.js'

// Level-of-detail octrees of dense clouds (dev/planning/plan-lod.md). The octree is
// built in the compute worker straight into the project's lod/ folder; the cloud keeps
// its metadata as `cloud.lod` (persisted with the cloud), the viewer reads its nodes
// on demand. An octree belongs to the cloud object it was built from: every edit makes
// a new cloud, which has none until it is built again.
export function createCloudLod({ clouds, log, save, projectId }) {
  const building = new Set() // octree names being written (kept by pruning)

  async function prune() {
    const pid = projectId()
    if (!pid) return 0
    const keep = new Set()
    for (const c of clouds.value) if (c.lod) { keep.add(c.lod.dataFile); keep.add(c.lod.hierarchyFile) }
    for (const name of building) { keep.add(`${name}.lod`); keep.add(`${name}.hier`) }
    return opfs.pruneLodFiles(pid, keep, { building: building.size > 0 })
  }

  // → the cloud's new `lod` metadata, or null (refused, failed).
  async function buildCloudLod(cloudId, onProgress) {
    const cloud = clouds.value.find((c) => c.id === cloudId)
    const pid = projectId()
    if (!cloud || cloud.kind !== 'dense' || !cloud.count || !pid) return null
    const name = `${cloud.id}-${Date.now().toString(36)}`
    const pos = cloud.pos.slice(0, 3 * cloud.count), col = cloud.col?.slice(0, 3 * cloud.count) ?? null
    const attributes = {}
    for (const [k, a] of Object.entries(cloud.attributes ?? {})) attributes[k] = a.slice(0, cloud.count)
    const transfer = [pos.buffer, ...(col ? [col.buffer] : []), ...Object.values(attributes).map((a) => a.buffer)]
    building.add(name)
    try {
      const dir = await opfs.lodDir(pid)
      const meta = await workerBuildLod(
        { cloud: { count: cloud.count, pos, col, attributes }, dir, name },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      // The cloud may have been replaced or removed meanwhile: then the files go.
      const live = clouds.value.find((c) => c.id === cloudId)
      if (live !== cloud) return null
      cloud.lod = markRaw(meta)
      await save()
      return meta
    } catch (err) {
      log(`Level of detail: ${err?.message ?? err}`, 'error', 'Products')
      return null
    } finally {
      building.delete(name)
      await prune().catch(() => {})
    }
  }

  // A reader of the cloud's octree (core/lod/reader.js), or null when it has none or
  // its files are gone.
  async function openCloudLod(cloud) {
    const pid = projectId()
    if (!cloud?.lod || !pid) return null
    try {
      const [data, hierarchy] = await Promise.all([
        opfs.loadLodFile(pid, cloud.lod.dataFile), opfs.loadLodFile(pid, cloud.lod.hierarchyFile),
      ])
      return await openLodReader(cloud.lod, { data, hierarchy })
    } catch {
      return null
    }
  }

  return { buildCloudLod, openCloudLod, pruneLod: prune }
}
