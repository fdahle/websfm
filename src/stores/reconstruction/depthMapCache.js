import { computed, shallowRef } from 'vue'
import {
  serializeDepthMap, deserializeDepthMap, depthPlanesMissing,
  buildDepthIndex, isDepthIndexStale, depthMapBytes,
} from '../../core/dense/depthMapCodec.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import * as opfs from '../../utils/opfs.js'

// The per-image dense Stage A depth-map cache, and its persistence.
//
// Depth maps are the ONE recomputable artifact expensive enough to earn disk
// (minutes/image) — without them, reopening a project forced a full Stage A re-run
// before densify/ortho. Two invariants carry the design:
//
//  1. Loading is LAZY. `restore` reads only the tiny index into `depthMapsMeta`;
//     `ensureDepthMapsLoaded()` hydrates the planes on first use. Eagerly pulling
//     hundreds of MB into memory on every project open would undo the fusion memory
//     budget for opens that never densify. Hence `depthMapCount` counts the
//     restored-but-not-yet-loaded entries too — anything gating on "are there depth
//     maps" must read it, never `depthMaps.size` (0 on a fresh reopen).
//  2. A map whose sidecars are MISSING (its image was removed) drops alone; a
//     CORRUPT one (truncated / wrong size) discards the whole set. A partial plane
//     fuses into a silently wrong cloud, which is worse than recomputing.
//
// Staleness is stamped against the main sparse cloud, because depth lives in that
// cloud's frame (see core/dense/depthMapCodec.js for the id+createdAt rule).
//
// The two refs are returned rather than hidden: the pipeline runners assign to them
// directly (Stage A produces a fresh set; ortho re-reads after a memory bail), and
// routing every write through a setter would buy nothing.
//
// Deps: isPersisting() · currentProjectId() · mainSparseCloud() · log()
export function createDepthMapCache({ isPersisting, currentProjectId, mainSparseCloud, log }) {
  // shallowRef so the large typed-array planes stay PLAIN — a reactive Proxy
  // wrapper can't be structured-cloned to the densify worker.
  const depthMaps = shallowRef(new Map())
  // Restored index entries for planes still on disk but not yet hydrated. Empty
  // once loaded (the maps themselves are then the source of truth).
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
    const index = buildDepthIndex(maps, { sparseCloud: mainSparseCloud(), settings })
    const entries = maps.map((m) => ({ uuid: m.uuid, buffers: serializeDepthMap(m).buffers }))
    try {
      await opfs.saveDepthPlanes(currentProjectId(), index, entries)
      log(`Dense: ${maps.length} depth map(s) saved (${formatBytes(depthMapBytes(index.maps))}) `
        + `— reopening this project will not need a Stage A re-run`, 'info', 'Dense')
    } catch (err) {
      // Non-fatal: the maps are live in memory, this run still works.
      log(`Dense: could not save depth maps — ${err?.message ?? err}. They will be lost on reload.`,
        'warn', 'Dense')
    }
  }

  // Hydrate the planes for a restored project on first use. Returns true when
  // `depthMaps` holds usable maps. Cheap no-op once loaded (or when Stage A ran
  // this session).
  async function ensureDepthMapsLoaded() {
    if (depthMaps.value.size) return true
    const metas = depthMapsMeta.value
    if (!metas.length) return false
    const t0 = performance.now()
    log(`Dense: loading ${metas.length} saved depth map(s) (${formatBytes(depthMapBytes(metas))})…`,
      'info', 'Dense')
    try {
      const loaded = await opfs.loadDepthPlanes(currentProjectId(), metas)
      const byUuid = new Map(loaded.map((e) => [e.uuid, e.buffers]))
      const maps = new Map()
      const gone = []      // image removed since — its planes went with it
      const corrupt = []   // present but truncated / wrong size
      for (const meta of metas) {
        const buffers = byUuid.get(meta.uuid)
        if (depthPlanesMissing(buffers)) { gone.push(meta.uuid); continue }
        const m = deserializeDepthMap(meta, buffers)
        if (m) maps.set(m.uuid, m)
        else corrupt.push(meta.uuid)
      }
      if (corrupt.length) {
        // Fusing a truncated plane yields a silently wrong cloud — refuse the set.
        log(`Dense: ${corrupt.length} saved depth map(s) are corrupt — discarding the saved set; `
          + `recompute depth maps before densifying`, 'error', 'Dense')
        depthMapsMeta.value = []
        await opfs.deleteDepthPlanes(currentProjectId()).catch(() => {})
        return false
      }
      if (gone.length) {
        // Fusion is happy with fewer maps, and a removed image *should* stop
        // contributing — drop those entries and re-stamp the index.
        log(`Dense: ${gone.length} saved depth map(s) dropped — their images are no longer in `
          + `this project`, 'info', 'Dense')
        await opfs.saveDepthIndex(currentProjectId(),
          buildDepthIndex([...maps.values()], { sparseCloud: mainSparseCloud() })).catch(() => {})
      }
      depthMaps.value = maps
      depthMapsMeta.value = []
      if (!maps.size) return false
      log(`Dense: ${maps.size} depth map(s) restored in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        'success', 'Dense')
      return true
    } catch (err) {
      log(`Dense: could not load saved depth maps — ${err?.message ?? err}. Recompute them.`,
        'error', 'Dense')
      depthMapsMeta.value = []
      return false
    }
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
    persistDepthMaps, ensureDepthMapsLoaded, loadDepthIndexIntoMeta, clearDepthMaps,
  }
}
