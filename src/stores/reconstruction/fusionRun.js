// Build Dense Cloud (reconstruction/dense.js): fusion of the depth maps into the dense
// cloud, streamed over the worker pool when the maps are on disk.
//
// Moved verbatim from the store: everything it shares comes in by name.

import { disabledUuids } from '../../core/imageEnabled.js'
import { mergeFusionCounters, logFusionStream, finishFusion } from '../../core/dense/mvs.js'
import {
  fusePlanAnswer as workerFusePlanAnswer,
  POOL_SIZE,
  releaseIdleWorkers,
  densify as workerDensify,
} from '../../workers/computeClient.js'
import { DEFAULT_BUDGET_BYTES, formatBytes } from '../../core/dense/memBudget.js'
import { contiguousChunks } from '../../core/dense/depthSplit.js'
import { DENSE_TUNING } from '../../core/tuning.js'
import { FUSION_PLAN_SHARE, resolveFusePosition } from '../../core/dense/fusionPlan.js'
import { joinCloudParts } from '../../core/dense/cloudParts.js'
import { bufferFailureText } from '../../core/bufferLimit.js'
import { pluralize } from '../../core/textFormat.js'

export function createFusionRun({
  cancelled,
  denseSummary,
  depthMapInput,
  depthMaps,
  images,
  loadDepthIndexIntoMeta,
  log,
  mainSparseCloud,
  pageCloudBytes,
  projects,
  reconStatus,
  save,
  summary,
  upsertDenseCloud,
  withRegion,
}) {
  // A buffer the browser refused (it arrives from the worker as a plain message) says
  // why and what to change; anything else as it is.
  const densifyErrorText = (err) =>
    bufferFailureText(
      err?.message ?? err,
      'Lower the memory budget (Settings ▸ Compute) so fusion works in slabs, or raise the point-density sample step',
    )

  // Fusion over saved maps on `workers` pool slots. The plan's preflight already counted
  // every worker's input, accumulator and the join; a plan that cannot split (small
  // scene, tight budget) runs whole on one worker without repeating the pre-passes.
  // Returns { cloud, summary } or null (refused, already logged).
  async function densifyParallel(mapsInput, settings, budget, workers, onProgress, stillCurrent) {
    const t0 = performance.now()
    // Each worker's comparison cache (DENSE_TUNING.densifyCacheMaxMiB); the plan's
    // preflight counts it per worker.
    const cacheBytes = Math.floor(Math.min(DENSE_TUNING.densifyCacheMaxMiB * 2 ** 20, budget / (4 * workers)))
    const fuseSettings = withRegion({ ...settings, memBudgetBytes: budget, cacheBytes, parallel: workers })
    const PLAN_SHARE = FUSION_PLAN_SHARE
    const onLog = (m, l, c) => log(m, l, c)
    onProgress?.(0, 1, 'Planning fusion…', 0, 'plan')
    // The plan's pre-passes over the pool (core/dense/fusionPlan.js fusionPrepassSteps):
    // worker 0 asks for each pass as a batch, the maps go in contiguous runs to the
    // fusion's `workers` slots (worker 0 too: its plan call waits meanwhile), and the parts
    // go back to it. On quarry the plan's passes were most of fusion on one worker.
    const onPlanEvent = (ev, [token, request]) => {
      if (ev !== 'batch') return
      const shares = contiguousChunks(mapsInput.length, Math.max(1, Math.min(workers, mapsInput.length)))
      Promise.all(
        shares.map((refs, w) =>
          workerDensify(
            { maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'prepass', batch: request, refs },
            { worker: w },
          ),
        ),
      )
        .then((parts) => workerFusePlanAnswer(token, parts, 0))
        .catch((err) => workerFusePlanAnswer(token, { error: String(err?.message ?? err) }, 0))
    }
    const { plan, refused } = await workerDensify(
      { maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'plan', splitPlan: workers > 1 },
      {
        onLog,
        worker: 0,
        onEvent: onPlanEvent,
        onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, PLAN_SHARE * (f ?? 0), 'plan'),
      },
    )
    if (refused || !plan || !stillCurrent()) return null
    if (plan.workers <= 1) {
      const { cloud, summary } = await workerDensify(
        { maps: mapsInput, streamed: true, settings: { ...fuseSettings, plan } },
        {
          onLog,
          worker: 0,
          onProgress: (d, t, lbl) =>
            onProgress?.(d, t, lbl, PLAN_SHARE + (1 - PLAN_SHARE) * (t > 0 ? d / t : 0), 'fuse'),
        },
      )
      return { cloud, summary }
    }
    const nM = plan.nMaps,
      nT = plan.slabs.length
    const totalCells = plan.slabs.reduce((s, x) => s + x.cells, 0) || 1
    const slabDone = new Float64Array(nT)
    const report = (lbl) => {
      let f = 0
      for (let i = 0; i < nT; i++) f += (slabDone[i] * plan.slabs[i].cells) / totalCells
      onProgress?.(Math.round(f * nT), nT, lbl, PLAN_SHARE + (1 - PLAN_SHARE) * f, 'fuse')
    }
    // Largest slabs first, so the pool does not end on one long straggler.
    const queue = plan.slabs.map((s, i) => i).sort((a, b) => plan.slabs[b].cells - plan.slabs[a].cells)
    const parts = new Array(nT),
      counters = [],
      streams = []
    const runner = async (w) => {
      while (queue.length) {
        const i = queue.shift()
        const res = await workerDensify(
          { maps: mapsInput, streamed: true, settings: fuseSettings, mode: 'slab', plan, slab: i },
          {
            onLog,
            worker: w,
            onProgress: (d, t, lbl) => {
              slabDone[i] = Math.min(1, Math.max(0, (d - i * nM) / nM))
              report(lbl)
            },
          },
        )
        parts[i] = res.part
        counters.push(res.counters)
        streams.push(res.stream)
        slabDone[i] = 1
        report(`slab ${i + 1}/${nT} done`)
      }
    }
    await Promise.all(Array.from({ length: plan.workers }, (_, w) => runner(w)))
    // The slab workers' accumulators are wasm memories that an idle worker never collects:
    // they stayed resident through the join and the octree build (+3–5 GB past the plan on
    // a 73 M-point cloud). Their slabs are in shared memory the page holds, so they survive.
    releaseIdleWorkers()
    if (!stillCurrent()) return null
    const merged = mergeFusionCounters(counters)
    const sum = (k) => streams.reduce((s, x) => s + (x?.[k] ?? 0), 0)
    logFusionStream(onLog, {
      compared: sum('compared'),
      culled: sum('culled'),
      skipped: sum('skipped'),
      reads: sum('reads'),
      hits: sum('hits'),
      cacheBytes,
      workers: plan.workers,
      loadMs: sum('loadMs'),
      eligMs: sum('eligMs'),
      checkMs: sum('checkMs'),
    })
    const { summary } = finishFusion(plan, merged, [], onLog)
    // Join the slabs (in slab order, so a run is deterministic for a given plan), in shared
    // memory where the page is isolated: later workers then read the cloud uncopied.
    const cloud = joinCloudParts(parts)
    const n = cloud.count
    log(
      `Dense cloud: fused ${nM} depth maps → ${n} points in ${((performance.now() - t0) / 1000).toFixed(1)}s ` +
        `(${nT} slabs on ${plan.workers} workers)`,
      n === 0 ? 'error' : 'success',
      'Dense',
    )
    onProgress?.(1, 1, 'Done', 1)
    return { cloud, summary }
  }

  // Dense Stage B — fuse the Stage A depth maps into a coloured dense cloud.
  // The saved maps of the images that are not disabled (core/imageEnabled.js): a
  // disabled image's map, kept from before, stays out of fusion and the orthophoto.
  function enabledMaps(maps, category, what) {
    const off = disabledUuids(images.value)
    if (!off.size) return maps
    const kept = maps.filter((m) => !off.has(m.uuid))
    if (kept.length < maps.length)
      log(
        `${category}: ${pluralize(maps.length - kept.length, 'depth map')} of disabled images left out of ${what}`,
        'info',
        category,
      )
    return kept
  }

  async function densify(settings = {}, onProgress) {
    const projectId = projects.currentProjectId,
      sparse = mainSparseCloud.value
    const stillCurrent = () => projectId === projects.currentProjectId && sparse === mainSparseCloud.value
    let input
    try {
      input = await depthMapInput()
    } catch (err) {
      log(`Dense: ${err.message}`, 'error', 'Dense')
      return
    }
    const { streamed } = input
    const maps = enabledMaps(input.maps, 'Dense', 'the dense cloud')
    if (!maps.length) {
      log('Dense: compute depth maps before building the dense cloud', 'warn', 'Dense')
      return
    }
    // Stage B pre-flight: fusion itself measures the merged cell count (at the real
    // merge cell, step and region) and refuses over budget before its consistency
    // pass, returning the transferred buffers home — a pixel-count guess here could
    // not see the merge cell, the step or the view overlap. Same budget knob as Stage A.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    // What the open project already holds in this tab (its clouds, the previous dense
    // cloud among them until the new one replaces it): fusion plans with the rest of the
    // budget, and with the rest of the buffer pool for its plain arrays (shared ones are
    // wasm memory, outside the pool). Quarry: projected 12 GB, the renderer peaked at
    // 17.7 GB with the previous 95 M-point cloud open.
    const { pageBytes, pagePoolBytes } = pageCloudBytes()
    if (pageBytes > 0)
      log(`Dense: the open project holds ${formatBytes(pageBytes)} of point data in this tab`, 'debug', 'Dense')
    // An 'auto' Point position follows the project's scene type (fusionPlan.js
    // resolveFusePosition, resolved where fusion reads it).
    const sceneType = projects.currentSceneType ?? null
    if (settings.position == null || settings.position === 'auto')
      log(
        `Dense: point position auto → ${resolveFusePosition('auto', sceneType) === 'mean' ? 'mean of the agreeing views' : 'own depth map'} ` +
          `(${sceneType === 'object' ? 'object capture' : 'aerial / mapping'} project)`,
        'info',
        'Dense',
      )
    settings = { ...settings, pageBytes, pagePoolBytes, sceneType }
    if (streamed)
      log(
        'Dense: reading saved maps on demand (one reference + one comparison); releasing planes after use',
        'info',
        'Dense',
      )
    // Start from fresh workers: the pool's idle ones still hold the depth filter's
    // caches as uncollected garbage, charged to the tab's shared buffer pool.
    releaseIdleWorkers()
    reconStatus.value = 'running'
    // Transfer (not clone) each map's depth/cost/rgb buffers to the worker — they're
    // the bulk of dense memory, and a clone briefly doubles it (the fusion OOM's
    // secondary contributor). The per-map display PNG (displayBlob) is display-only,
    // so strip it from the wire payload entirely. The worker returns the buffers so
    // we re-attach them below; until then the store's copies are detached.
    // Resolve uuid → filename for the fusion progress/log labels. Deliberately derived
    // here rather than persisted in the depth-map index: the image list is the authority
    // on names (a rename must not leave a stale copy in the sidecar), and a restored
    // project has the list but no name on the map. Falls back to a uuid fragment in
    // core/dense/mvs.js when the image is gone.
    const nameByUuid = new Map(images.value.map((im) => [im.uuid, im.name]))
    const mapsInput = streamed
      ? maps.map((m) => ({ ...m, name: nameByUuid.get(m.uuid) }))
      : maps.map((m) => ({
          uuid: m.uuid,
          name: m.name ?? nameByUuid.get(m.uuid),
          width: m.width,
          height: m.height,
          K: m.K,
          R: m.R,
          t: m.t,
          depth: m.depth,
          cost: m.cost,
          rgb: m.rgb,
          normals: m.normals || null,
        }))
    const transfer = []
    for (const m of streamed ? [] : mapsInput) {
      transfer.push(m.depth.buffer, m.cost.buffer, m.rgb.buffer)
      if (m.normals) transfer.push(m.normals.buffer)
    }
    // Saved maps can be read by every worker, so fusion CAN split over the pool: one
    // worker plans (pre-passes + slab layout), then the slabs run in parallel, each
    // exact on its own (core/dense/mvs.js fusionSteps), and are joined in slab order.
    // Up to DENSE_TUNING.fuseWorkers (quarry at Medium: 8 workers 308 s, one 478 s).
    const workers = streamed && maps.length >= 16 ? Math.min(POOL_SIZE, DENSE_TUNING.fuseWorkers ?? 1) : 1
    if (workers > 1) {
      try {
        const done = await densifyParallel(mapsInput, settings, budget, workers, onProgress, stillCurrent)
        if (!stillCurrent() || !done) {
          if (!done) reconStatus.value = 'error'
          return
        }
        upsertDenseCloud(done.cloud, { replace: !!settings.replaceMain })
        denseSummary.value = done.summary
        reconStatus.value = 'done'
        await save()
      } catch (err) {
        if (!stillCurrent()) return
        if (cancelled(err, 'Dense cloud', 'Dense')) return
        log(`Dense: error: ${densifyErrorText(err)}`, 'error', 'Dense')
        reconStatus.value = 'error'
      }
      return
    }
    try {
      const {
        cloud,
        summary: dSummary,
        refused,
        mapBuffers,
      } = await workerDensify(
        { maps: mapsInput, streamed, settings: withRegion({ ...settings, memBudgetBytes: budget }) },
        {
          onLog: (m, l, c) => log(m, l, c),
          onProgress: (d, t, lbl, f, phase) => onProgress?.(d, t, lbl, f, phase),
          transfer,
        },
      )
      if (!stillCurrent()) return
      // Re-attach the round-tripped buffers so ortho / a second densify still work.
      if (mapBuffers) {
        for (const mb of mapBuffers) {
          const m = depthMaps.value.get(mb.uuid)
          if (m) {
            m.depth = mb.depth
            m.cost = mb.cost
            m.rgb = mb.rgb
            if (mb.normals) m.normals = mb.normals
          }
        }
      }
      // Refused by fusion's measured pre-flight (logged there with its numbers).
      if (refused) {
        reconStatus.value = 'error'
        return
      }
      // The worker returns the cloud already split (Float32 pos, Uint8 col, Float32
      // world-space normals for the Poisson mesh), assembled from its fusion slabs.
      upsertDenseCloud(cloud, { replace: !!settings.replaceMain })
      denseSummary.value = dSummary ?? null
      reconStatus.value = 'done'
      await save()
    } catch (err) {
      if (!stillCurrent()) return
      // The buffers were transferred out; if the worker failed before returning them
      // they're detached (dead). Drop the in-memory cache so ortho / re-densify don't
      // read empty buffers. The planes are on disk now, so point the store back at the
      // saved index: a retry rehydrates from OPFS instead of forcing a Stage A re-run.
      depthMaps.value = new Map()
      const recovered = await loadDepthIndexIntoMeta()
      log(
        `Dense: error: ${densifyErrorText(err)}. Depth maps were released to the worker` +
          (recovered
            ? ' — they will be reloaded from disk on the next attempt.'
            : ' and must be recomputed before retrying.'),
        'error',
        'Dense',
      )
      reconStatus.value = 'error'
    }
  }

  return { densify, densifyParallel }
}
