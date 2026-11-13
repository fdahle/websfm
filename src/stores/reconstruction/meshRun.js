// Build Mesh (reconstruction/dense.js): Poisson meshing of a cloud on the worker pool,
// with the depth maps as optional extra input.
//
// Moved verbatim from the store: everything it shares comes in by name.

import { toRaw } from 'vue'
import { MESH_STEPS } from '../../core/runSteps.js'
import { meshDepthBasis, tileTask } from '../../core/products/mesh.js'
import { regionContains } from '../../core/products/region.js'
import {
  POOL_SIZE,
  releaseIdleWorkers,
  recycleWorker,
  meshify as workerMeshify,
  meshPrepare as workerMeshPrepare,
  meshTile as workerMeshTile,
  meshFinish as workerMeshFinish,
} from '../../workers/computeClient.js'
import { DEFAULT_BUDGET_BYTES, formatBytes } from '../../core/dense/memBudget.js'
import { pluralize } from '../../core/textFormat.js'
import { isSharedArray, postableCopy } from '../../core/bigArray.js'
import { poissonHeapBytes } from '../../core/products/mesh.js'

export function createMeshRun({
  activeRegion,
  cancelled,
  clipToRegion,
  clouds,
  denseSummary,
  log,
  meshSource,
  meshSources,
  reconStatus,
  save,
  upsertMeshCloud,
}) {
  // Build Mesh ▸ Auto depth's inputs for the dialog (core/products/mesh.js meshDepthBasis):
  // a strided sample of the source, clipped by the Region as generateMesh clips it, with
  // the fusion merge cell as spacing (0 for an imported cloud, whose spacing the run
  // estimates). Kept per cloud, region and spacing; null without a resident source.
  const DEPTH_SAMPLE = 200_000
  let depthBasisMemo = { key: null, value: null }
  function meshDepthInputs(sourceId) {
    const pick = sourceId != null ? meshSources.value.find((s) => s.id === sourceId) : meshSource.value
    const dense = pick ? clouds.value.find((c) => c.id === pick.id) : null
    if (!dense?.pos || !(dense.count > 0)) return null
    const region = dense.imported ? null : activeRegion()
    const spacing = dense.imported ? 0 : (denseSummary.value?.mergeCell ?? 0)
    const key = JSON.stringify([dense.id, dense.count, region, spacing])
    if (depthBasisMemo.key === key) return depthBasisMemo.value
    const pos = toRaw(dense.pos)
    const stride = Math.max(1, Math.ceil(dense.count / DEPTH_SAMPLE))
    const sample = new Float64Array(Math.ceil(dense.count / stride) * 3)
    let m = 0
    let seen = 0
    for (let i = 0; i < dense.count; i += stride) {
      seen++
      const x = pos[i * 3],
        y = pos[i * 3 + 1],
        z = pos[i * 3 + 2]
      if (region && !regionContains(region, x, y, z)) continue
      sample[m * 3] = x
      sample[m * 3 + 1] = y
      sample[m * 3 + 2] = z
      m++
    }
    const value = meshDepthBasis(sample.subarray(0, m * 3), { count: (dense.count * m) / seen, spacing })
    depthBasisMemo = { key, value }
    return value
  }

  // Mesh — screened Poisson over a dense cloud with oriented normals: `settings.sourceId`
  // when given (the modal's picker), else `meshSource` — never "the first dense cloud".
  // Sends disposable copies of the dense buffers to the worker. Keeping the
  // authoritative arrays here costs one temporary copy, but makes cancellation
  // genuinely non-destructive: terminating a worker cannot strand detached
  // source buffers. Upserts a single kind:'mesh' cloud.
  async function generateMesh(settings = {}, onProgress) {
    // replaceMain: Mesh ▸ Replace the main mesh (where the mesh goes, not how it is built).
    const { sourceId, replaceMain, ...meshSettings } = settings
    const pick = sourceId != null ? meshSources.value.find((s) => s.id === sourceId) : meshSource.value
    const dense = pick ? clouds.value.find((c) => c.id === pick.id) : null
    if (!dense?.count) {
      log(
        sourceId != null
          ? 'Mesh: the chosen dense cloud is gone or has no normals'
          : 'Mesh: build a dense point cloud (with normals) first',
        'warn',
        'Products',
      )
      return
    }
    if (!dense.nrm || dense.nrm.length < dense.count * 3) {
      log(
        'Mesh: the dense cloud has no per-point normals — build it again (Reconstruct ▸ Dense Model) or estimate them (Tools ▸ Point Cloud ▾ ▸ Estimate normals…)',
        'warn',
        'Products',
      )
      return
    }
    // The fusion merge cell is the sample spacing of the clouds fused in this project's
    // frame — the computed cloud and its edits. An imported cloud (or an edit of one)
    // has its own spacing, which the worker estimates.
    const mergeCell = dense.imported ? 0 : (denseSummary.value?.mergeCell ?? 0)
    log(
      `Mesh: source "${dense.name ?? 'Dense'}" (${dense.count.toLocaleString()} points` +
        `${dense.derived ? ', edited' : ''}${dense.imported ? ', imported' : ''})`,
      'info',
      'Products',
    )
    const clipped = clipToRegion(dense, 'Mesh')
    if (clipped && !clipped.count) {
      log('Mesh: no point of the source lies inside the region', 'warn', 'Products')
      return
    }
    // A shared cloud (core/bigArray.js, past 178 M points) goes as a view of itself:
    // nothing can detach it, and a copy would be one buffer over 2 GiB.
    const posCopy = clipped ? clipped.pos : postableCopy(dense.pos)
    const colCopy = clipped ? (clipped.col ?? null) : dense.col ? postableCopy(dense.col) : null
    const nrmCopy = clipped ? clipped.nrm : postableCopy(dense.nrm)
    const input = {
      dense: { count: clipped ? clipped.count : dense.count, pos: posCopy, col: colCopy, nrm: nrmCopy },
      settings: { ...meshSettings, mergeCell },
    }
    const transfer = [posCopy.buffer]
    if (colCopy) transfer.push(colCopy.buffer)
    transfer.push(nrmCopy.buffer)
    reconStatus.value = 'running'
    // Fresh workers: a solve that trapped (out of a wasm heap) leaves its worker's mesh
    // module unusable, and idle workers keep their last run's garbage in the pool.
    releaseIdleWorkers()
    try {
      const { mesh } =
        POOL_SIZE > 1 && meshSettings.tiles !== 'off'
          ? await meshOnPool(input, transfer, meshSettings, onProgress, {
              // Worker 0 keeps the input until the join; a shared cloud goes as a view.
              heldBytes:
                pageCloudBytes().pageBytes +
                [posCopy, colCopy, nrmCopy].reduce((n, a) => n + (a && !isSharedArray(a) ? a.byteLength : 0), 0),
            })
          : await workerMeshify(input, {
              onLog: (m, l, c) => log(m, l, c),
              onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f),
              transfer,
            })
      if (!mesh || !mesh.nVerts) {
        log('Mesh: Poisson produced no surface — try a lower depth or check the cloud/normals', 'warn', 'Products')
        reconStatus.value = 'done'
        return
      }
      upsertMeshCloud(mesh, {
        sourceId: dense.id,
        sourceName: dense.name ?? null,
        settings: meshSettings,
        replace: !!replaceMain,
      })
      reconStatus.value = 'done'
      await save()
    } catch (err) {
      if (cancelled(err, 'Mesh')) return
      log(`Mesh error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // The point data the open project's clouds hold in this tab: all of it (pageBytes), and
  // the part in the tab's ArrayBuffer pool (pagePoolBytes; shared arrays are wasm memory).
  function pageCloudBytes() {
    let pageBytes = 0,
      pagePoolBytes = 0
    for (const c of clouds.value ?? [])
      for (const v of [c, c.attributes, c.points])
        for (const a of Object.values(v ?? {}))
          if (ArrayBuffer.isView(a)) {
            pageBytes += a.byteLength
            if (!isSharedArray(a)) pagePoolBytes += a.byteLength
          }
    return { pageBytes, pagePoolBytes }
  }

  // Build Mesh with its tiles over the pool (workers/ops/mesh.js meshPrepare / meshTile /
  // meshFinish): worker 0 conditions the input and plans — and solves at once when one
  // solve fits — then the tiles go to as many workers as the memory budget holds solves of
  // the largest tile (each a wasm heap that keeps its high-water mark), and worker 0 joins
  // them. Resolves to { mesh }.
  async function meshOnPool(input, transfer, settings, onProgress, { heldBytes = 0 } = {}) {
    const onLog = (m, l, c) => log(m, l, c)
    const runId = `mesh-${Date.now().toString(36)}`
    const prep = await workerMeshPrepare(
      { ...input, runId },
      { worker: 0, onLog, onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f, 'prepare'), transfer },
    )
    if (prep.mesh) return prep
    const { share, tiles: n } = prep
    const tiles = share.tiling.tiles
    const perTile = poissonHeapBytes(Math.max(...tiles.map((t) => t.samples)), share.solveArgs.depth)
    const budget = settings.ramBudgetBytes > 0 ? settings.ramBudgetBytes : DEFAULT_BUDGET_BYTES
    // The tiles plan with the budget less what the tab already holds (the project's
    // clouds, worker 0's copy of the input): each solve's wasm heap keeps its high-water
    // mark until the worker goes. Worker 0 holds the run for the join, so the tiles go to
    // the others where the pool has them.
    const room = Math.max(perTile, budget - heldBytes)
    const first = POOL_SIZE > 1 ? 1 : 0
    const workers = Math.max(1, Math.min(POOL_SIZE - first, n, Math.floor(room / perTile)))
    log(
      `Mesh: ${n} tiles on ${pluralize(workers, 'worker')} (a solve ≤ ${formatBytes(perTile)} each, memory ` +
        `budget ${formatBytes(budget)}${heldBytes > 0 ? `, of which the open project and the input hold ${formatBytes(heldBytes)}` : ''})`,
      'info',
      'Products',
    )
    const JOIN = 0.05
    const done = new Float64Array(n)
    const report = (lbl) => {
      const f = done.reduce((a, b) => a + b, 0) / n
      onProgress?.(Math.round(f * n), n, lbl, (1 - JOIN) * f, 'tiles')
    }
    // A mesh in tiles has steps (core/runSteps.js); one in a single piece has none to show.
    onProgress?.(0, n, `Meshing ${n} tiles…`, 0, 'tiles', MESH_STEPS)
    // Largest tiles first, so the pool does not end on one long straggler.
    const queue = tiles.map((_, i) => i).sort((a, b) => tiles[b].samples - tiles[a].samples)
    const results = new Array(n)
    const runner = async (w) => {
      while (queue.length) {
        const i = queue.shift()
        // Only this tile's samples go, handed over (core/products/mesh.js tileTask).
        const task = tileTask(share, i)
        results[i] = await workerMeshTile(
          { task },
          {
            worker: first + w,
            transfer: [task.input.pos.buffer, task.input.nrm.buffer, task.input.wgt.buffer],
            onLog,
            // The worker reports a tile's progress as its share of the whole bar.
            onProgress: (d, t, lbl, f) => {
              done[i] = Math.min(1, Math.max(0, (f ?? 0) * n - i))
              report(lbl)
            },
          },
        )
        done[i] = 1
        report(`Tile ${i + 1}/${n} done`)
        // A fresh worker for the next tile: a wasm heap reused tile after tile grew
        // past the estimate (quarry at depth 11, 16 GB budget: the tab crept 13 → 19 GB
        // over 48 tiles; recycled, it peaks at 15.1 GB, for 2 % more time).
        if (queue.length) recycleWorker(first + w)
      }
    }
    await Promise.all(Array.from({ length: workers }, (_, w) => runner(w)))
    // The tile workers' heaps stay at their largest solve while they live: give them up
    // before worker 0 joins the tiles and colours the mesh (quarry at depth 11, 16 GB
    // budget: the join at 28–32 GB before, 6–9 GB after).
    releaseIdleWorkers({ keep: [0] })
    onProgress?.(n, n, 'Joining the tiles…', 1 - JOIN, 'join')
    return workerMeshFinish({ runId, results }, { worker: 0, onLog })
  }

  return { generateMesh, meshDepthInputs, pageCloudBytes }
}
