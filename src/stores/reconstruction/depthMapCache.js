import { computed, shallowRef } from 'vue'
import {
  serializeDepthMap,
  buildDepthIndex, isDepthIndexStale, depthMapBytes,
} from '../../core/dense/depthMapCodec.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import * as opfs from '../../utils/opfs.js'

// Persist expensive Stage A maps, then evict their resident planes. Restore reads
// only the sparse-stamped index. Consumers receive file handles and stream maps
// in workers (fusion: reference + comparison; ortho: one source). Unsaved maps
// stay resident so unavailable storage never destroys a computed result.
export function createDepthMapCache({ isPersisting, currentProjectId, mainSparseCloud, log }) {
  // shallowRef so the large typed-array planes stay PLAIN — a reactive Proxy
  // wrapper can't be structured-cloned to the densify worker.
  const depthMaps = shallowRef(new Map())
  // Index entries for saved planes; retained while workers stream their files.
  const depthMapsMeta = shallowRef([])

  // How many depth maps this project has, hydrated or merely on disk. The ribbon /
  // command guards for Densify + Ortho read this, so it must count the restored-but-
  // not-yet-loaded ones too — otherwise reopening a project leaves both stages gated
  // off despite the planes sitting in OPFS.
  const depthMapCount = computed(() => depthMaps.value.size || depthMapsMeta.value.length)

  // Write the depth planes + index. Stamped with the sparse cloud's identity so a
  // later reconstruction re-run can be detected as invalidating (see the codec).
  async function persistDepthMaps(maps, settings) {
    if (!isPersisting() || !maps.length) return
    const indexProject = currentProjectId()
    const index = buildDepthIndex(maps, { sparseCloud: mainSparseCloud(), settings })
    const entries = maps.map((m) => ({ uuid: m.uuid, buffers: serializeDepthMap(m).buffers }))
    try {
      await opfs.saveDepthPlanes(indexProject, index, entries)
      if (currentProjectId() === indexProject && mainSparseCloud()?.createdAt === index.sparseCreatedAt) {
        depthMapsMeta.value = index.maps
        depthMaps.value = new Map()
      }
      log(`Dense: ${maps.length} depth map(s) saved (${formatBytes(depthMapBytes(index.maps))}) `
        + `— reopening this project will not need a Stage A re-run`, 'info', 'Dense')
    } catch (err) {
      // Non-fatal: the maps are live in memory, this run still works.
      log(`Dense: could not save depth maps — ${err?.message ?? err}. They will be lost on reload.`,
        'warn', 'Dense')
    }
  }

  async function depthMapInput() {
    const projectId = currentProjectId()
    if (depthMapsMeta.value.length && isPersisting()) {
      const files = await opfs.loadDepthFiles(projectId, depthMapsMeta.value)
      if (projectId !== currentProjectId()) throw new Error('Project changed while loading depth maps')
      return { maps: files, streamed: true }
    }
    return { maps: [...depthMaps.value.values()], streamed: false }
  }

  // Point `depthMapsMeta` at the saved index, unless it is stale against the current
  // main sparse cloud — depth is in that cloud's frame, so a reconstruction re-run
  // invalidates it. Returns true when usable saved maps are now advertised.
  // `projectId` is explicit for the restore path (which is handed one), defaulting
  // to the open project for the in-session callers.
  async function loadDepthIndexIntoMeta(projectId = currentProjectId(), shouldApply = () => true) {
    if (!isPersisting()) return false
    const index = await opfs.loadDepthIndex(projectId).catch(() => null)
    // Restore callers may have switched projects while the OPFS read was pending.
    // In that case this result belongs to the old project and must not touch the
    // shared refs (or delete data based on the new project's sparse model).
    if (!shouldApply()) return false
    if (!index?.maps?.length) { depthMapsMeta.value = []; return false }
    if (isDepthIndexStale(index, mainSparseCloud())) {
      log(`Dense: discarding ${index.maps.length} saved depth map(s) — they belong to an older `
        + `sparse reconstruction and no longer match the current model; recompute them`,
        'warn', 'Dense')
      depthMapsMeta.value = []
      await opfs.deleteDepthPlanes(projectId).catch(() => {})
      return false
    }
    depthMapsMeta.value = index.maps
    return true
  }

  // Drop the in-memory cache (project switch / clear). Does NOT touch disk.
  function clearDepthMaps() {
    depthMaps.value = new Map()
    depthMapsMeta.value = []
  }

  return {
    depthMaps, depthMapsMeta, depthMapCount,
    persistDepthMaps, depthMapInput, loadDepthIndexIntoMeta, clearDepthMaps,
  }
}
