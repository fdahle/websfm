import { computed, shallowRef } from 'vue'
import { serializeDepthMap, buildDepthIndex, isDepthIndexStale, depthMapBytes } from '../../core/dense/depthMapCodec.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import * as opfs from '../../utils/opfs.js'
import { storageFullRetry } from '../../utils/storageFull.js'
import { pluralize } from '../../core/textFormat.js'

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
      log(
        `Dense: ${pluralize(maps.length, 'depth map')} saved (${formatBytes(depthMapBytes(index.maps))}) ` +
          `— reopening this project will not need a Stage A re-run`,
        'info',
        'Dense',
      )
    } catch (err) {
      // Non-fatal: the maps are live in memory, this run still works.
      log(`Dense: could not save depth maps — ${err?.message ?? err}. They will be lost on reload.`, 'warn', 'Dense')
    }
  }

  // A streamed Stage A run (TODO ▸ SC-4): the worker hands each map off as it
  // finishes, it is written here at once and dropped, and the index is committed
  // only at the end — nothing holds every map. Returns null when nothing can be
  // persisted (the caller then keeps the maps in memory, as before).
  //   const run = await beginStreamedDepthMaps()
  //   run.add(map)            per finished map (planes written, then released)
  //   await run.settled()     all writes landed; run.metas = index entries in order
  //   await run.commit(settings)
  // `onWriteFailure(err)`: called once, at the first map that could not be saved (a
  // full disk), so the caller can stop computing maps it cannot keep. Every write is
  // handled as it is queued: a failure must not surface as an unhandled rejection
  // minutes before `settled()` is awaited.
  // Browser storage full: the write waits while the user is asked to move the project
  // to a folder (utils/storageFull.js), then goes there. The run waits with it: the
  // workers hold their next maps until the unsaved ones are acknowledged. `run.retry`
  // `run.saveOrMove(write)` gives the run's other writes (the filter pass, the commit)
  // the same way out.
  async function beginStreamedDepthMaps({ onWriteFailure = null } = {}) {
    if (!isPersisting()) return null
    const projectId = currentProjectId()
    await opfs.beginDepthPlanes(projectId)
    depthMaps.value = new Map()
    depthMapsMeta.value = [] // the old set is gone; the new one is advertised on commit
    const metas = [],
      writes = []
    const inFlight = new Set()
    let failure = null
    const retry = storageFullRetry({ projectId, settleFirst: () => [...inFlight] })
    // A write's first attempt, tracked until it settles (see storageFullRetry).
    const attempt = (write) => {
      const p = write()
      inFlight.add(p)
      p.finally(() => inFlight.delete(p)).catch(() => {})
      return p
    }
    const saveOrMove = (write) => attempt(write).catch((err) => retry(err, write))
    const settled = async () => {
      await Promise.all(writes)
      if (failure) throw failure
    }
    return {
      projectId,
      metas,
      // → the write, settled (never rejects): the run's backpressure waits on it.
      add(m) {
        const { meta, buffers } = serializeDepthMap(m)
        metas.push(meta)
        const write = saveOrMove(() => opfs.saveDepthPlane(projectId, m.uuid, buffers)).catch((err) => {
          if (failure) return
          failure = err
          onWriteFailure?.(err)
        })
        writes.push(write)
        return write
      },
      settled,
      saveOrMove,
      async commit(settings) {
        await settled()
        const index = { ...buildDepthIndex([], { sparseCloud: mainSparseCloud(), settings }), maps: metas }
        await saveOrMove(() => opfs.commitDepthIndex(projectId, index))
        if (currentProjectId() === projectId) depthMapsMeta.value = metas
        log(
          `Dense: ${pluralize(metas.length, 'depth map')} saved (${formatBytes(depthMapBytes(metas))}) as they finished ` +
            `— reopening this project will not need a Stage A re-run`,
          'info',
          'Dense',
        )
      },
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
  // `indexRead` lets restore start the index read alongside the cloud read; the
  // staleness check below still waits for the main sparse cloud to be in place.
  async function loadDepthIndexIntoMeta(projectId = currentProjectId(), shouldApply = () => true, indexRead = null) {
    if (!isPersisting()) return false
    const index = await (indexRead ?? opfs.loadDepthIndex(projectId)).catch(() => null)
    // Restore callers may have switched projects while the OPFS read was pending.
    // In that case this result belongs to the old project and must not touch the
    // shared refs (or delete data based on the new project's sparse model).
    if (!shouldApply()) return false
    if (!index?.maps?.length) {
      depthMapsMeta.value = []
      return false
    }
    if (isDepthIndexStale(index, mainSparseCloud())) {
      log(
        `Dense: discarding ${pluralize(index.maps.length, 'saved depth map')} — they belong to an older ` +
          `sparse reconstruction and no longer match the current model; recompute them`,
        'warn',
        'Dense',
      )
      depthMapsMeta.value = []
      await opfs.deleteDepthPlanes(projectId).catch(() => {})
      return false
    }
    depthMapsMeta.value = index.maps
    return true
  }

  // An image left the project: its map must stop contributing. The planes went
  // with the image (opfs.deleteDepth); this drops the resident copy and the index
  // entry, so counts and memory estimates stop including it.
  async function forgetDepthMap(uuid) {
    if (depthMaps.value.has(uuid)) {
      const next = new Map(depthMaps.value)
      next.delete(uuid)
      depthMaps.value = next
    }
    if (!depthMapsMeta.value.some((m) => m.uuid === uuid)) return
    depthMapsMeta.value = depthMapsMeta.value.filter((m) => m.uuid !== uuid)
    if (!isPersisting()) return
    const projectId = currentProjectId()
    const index = await opfs.loadDepthIndex(projectId)
    if (!index?.maps?.some((m) => m.uuid === uuid) || projectId !== currentProjectId()) return
    await opfs
      .commitDepthIndex(projectId, { ...index, maps: index.maps.filter((m) => m.uuid !== uuid) })
      .catch(() => {})
  }

  // Drop the in-memory cache (project switch / clear). Does NOT touch disk.
  function clearDepthMaps() {
    depthMaps.value = new Map()
    depthMapsMeta.value = []
  }

  return {
    depthMaps,
    depthMapsMeta,
    depthMapCount,
    persistDepthMaps,
    beginStreamedDepthMaps,
    depthMapInput,
    loadDepthIndexIntoMeta,
    clearDepthMaps,
    forgetDepthMap,
  }
}
