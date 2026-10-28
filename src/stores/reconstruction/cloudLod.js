import { markRaw, watch } from 'vue'
import * as opfs from '../../utils/opfs.js'
import {
  buildLod as workerBuildLod,
  extractLod as workerExtractLod,
  exportLod as workerExportLod,
  transformLod as workerTransformLod,
  planLodEdit as workerPlanLodEdit,
  editLodTile as workerEditLodTile,
  releaseLodSource as workerReleaseLodSource,
  buildLodChunk as workerBuildLodChunk,
  finishLodPool as workerFinishLodPool,
  POOL_SIZE,
  exportPointTiles as workerExportPointTiles,
  importCopc as workerImportCopc,
} from '../../workers/computeClient.js'
import { readCopcNode } from '../../workers/copcNodeClient.js'
import { openCloudSource, isCopcLod, lodFileNames } from '../../core/lod/cloudSource.js'
import { LOD_MIN_POINTS, CHUNK_MAX } from '../../core/lod/build.js'
import { postableCopy } from '../../core/bigArray.js'
import { outlierLimit } from '../../core/products/cloudEdit.js'
import { clothNote } from '../../core/lod/clothNote.js'
import { DEFAULT_BUDGET_BYTES } from '../../core/dense/memBudget.js'
import { pluralize } from '../../core/textFormat.js'
import { stampOf } from '../../core/products/productSet.js'

// A neighbourhood edit of a streamed cloud (Filter, Classify ground) runs tile by tile;
// with more than one tile the tiles go to the whole pool. Each worker holds one tile at
// a time and gets its share of the memory budget, so the tiles are smaller the more
// workers there are: a tile's edit peaks at about this many bytes per point (read, the
// outlier filter's tree and neighbour means, the output; ~100 B measured, plus the read).
const TILE_BYTES_PER_POINT = 160
const MIN_TILE_POINTS = 1_000_000
const MAX_TILE_POINTS = 6_000_000
// An octree build sorts the points into chunks (one worker: one pass over the source),
// then builds each chunk's subtree on any worker, one chunk at a time each, so a chunk
// holds at most its worker's share of the memory budget: about this many bytes per point
// (the chunk's columns, its subtree's index lists, the encoded nodes).
const CHUNK_BYTES_PER_POINT = 150

// Level-of-detail octrees of dense clouds (dev/planning/plan-lod.md). The octree is
// built in the compute worker straight into the project's lod/ folder; the cloud keeps
// its metadata as `cloud.lod` (persisted with the cloud), the viewer reads its nodes
// on demand. An octree belongs to the cloud object it was built from: every edit makes
// a new cloud, which has none until it is built again.
//
// A COPC file (core/lod/copc.js) needs no octree of ours: it is copied into lod/ as it
// is and read in place (`lod.format === 'copc'`, the file is `lod.dataFile`).
export function createCloudLod({
  clouds,
  log,
  save,
  projectId,
  makeCloudId,
  selectedCloudId,
  projectCrs = () => null,
}) {
  const building = new Set() // octree names being written (kept by pruning)

  async function prune() {
    const pid = projectId()
    if (!pid) return 0
    const keep = new Set()
    for (const c of clouds.value) if (c.lod) for (const f of lodFileNames(c.lod)) keep.add(f)
    for (const name of building) {
      keep.add(`${name}.lod`)
      keep.add(`${name}.hier`)
      keep.add(`${name}.copc.laz`)
    }
    return opfs.pruneLodFiles(pid, keep, { building: building.size > 0 })
  }

  // The octree's files: { data, hierarchy (null for a COPC file) }.
  async function lodFiles(pid, lod) {
    const [data, hierarchy] = await Promise.all([
      opfs.loadLodFile(pid, lod.dataFile),
      lod.hierarchyFile ? opfs.loadLodFile(pid, lod.hierarchyFile) : null,
    ])
    return { data, hierarchy }
  }

  // An octree written for a project that is no longer the open one (closed or switched
  // while the worker ran): no cloud of that project names it, so its files go now
  // rather than at that project's next open.
  async function discard(dir, meta) {
    for (const f of lodFileNames(meta)) await dir.removeEntry(f).catch(() => {})
  }

  // An octree build over the pool. `first(pool)` runs the op that reads the source
  // (buildLod or transformLod, with `pool` when the pool has more than one worker); when
  // it comes back with chunks, every worker builds the next one until none is left, and
  // one worker joins them into the data file. `report`: the log line's kind, as the op
  // writes it (workers/ops/lod.js reportOctree). → the octree's metadata
  async function buildOnPool(first, { dir, name, report }, onProgress) {
    if (POOL_SIZE < 2) return first(null)
    const startedAt = Date.now()
    const tmpDir = `build-${name}`
    const chunkMax = Math.max(
      1_000_000,
      Math.min(CHUNK_MAX, Math.floor(DEFAULT_BUDGET_BYTES / POOL_SIZE / CHUNK_BYTES_PER_POINT)),
    )
    const r = await first({ tmpDir, chunkMax })
    if (!r?.pooled) return r
    const { chunks, ...state } = r.pooled
    const n = chunks.length
    const workers = Math.min(POOL_SIZE, n)
    const total = chunks.reduce((a, c) => a + c.count, 0)
    const parts = new Array(n)
    let next = 0,
      built = 0,
      failed = false
    await Promise.all(
      Array.from({ length: workers }, async (_, w) => {
        try {
          while (!failed && next < n) {
            const index = next++
            const part = await workerBuildLodChunk({ tmpDir, state, chunk: chunks[index], index }, { worker: w })
            parts[index] = { index, ...part }
            built += chunks[index].count
            onProgress?.(built, total, 'Building the octree', built / total)
          }
        } catch (err) {
          failed = true
          throw err
        }
      }),
    )
    return workerFinishLodPool(
      { tmpDir, state, parts, dir, name, extra: r.extra, report: { ...report, startedAt, workers } },
      { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
    )
  }

  // → the cloud's new `lod` metadata, or null (refused, failed).
  async function buildCloudLod(cloudId, onProgress) {
    const cloud = clouds.value.find((c) => c.id === cloudId)
    const pid = projectId()
    if (!cloud || cloud.kind !== 'dense' || !cloud.count || !pid) return null
    const name = `${cloud.id}-${Date.now().toString(36)}`
    // Copies the worker may keep; a shared cloud (core/bigArray.js, past 2 GiB) is sent as
    // a view of itself, which a copy could not be.
    const pos = postableCopy(cloud.pos, 3 * cloud.count),
      col = cloud.col ? postableCopy(cloud.col, 3 * cloud.count) : null
    const attributes = {}
    for (const [k, a] of Object.entries(cloud.attributes ?? {})) attributes[k] = postableCopy(a, cloud.count)
    const transfer = [pos.buffer, ...(col ? [col.buffer] : []), ...Object.values(attributes).map((a) => a.buffer)]
    building.add(name)
    try {
      const dir = await opfs.lodDir(pid)
      const meta = await buildOnPool(
        (pool) =>
          workerBuildLod(
            { cloud: { count: cloud.count, pos, col, attributes }, dir, name, pool },
            { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
          ),
        { dir, name, report: { kind: 'build' } },
        onProgress,
      )
      // The cloud may have been replaced or removed meanwhile, or its project closed:
      // then the files go.
      const live = projectId() === pid ? clouds.value.find((c) => c.id === cloudId) : null
      if (live !== cloud) {
        await discard(dir, meta)
        return null
      }
      // Stamped with the generation it was built from: a reopen keeps it only for the
      // same points (cloudSerde.js), as an edit renews `createdAt`.
      cloud.lod = markRaw({ ...meta, cloudCreatedAt: cloud.createdAt ?? null })
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

  // A LAS/LAZ too large to hold in memory, imported straight into an octree (a
  // *streamed* cloud, core/lod/streamed.js): the file is read in batches in the worker
  // and never held whole, here or there. → the new cloud, or null.
  async function importStreamedCloud(file, onProgress) {
    const pid = projectId()
    if (!pid) {
      log(
        `Cloud import: ${file.name} is too large to hold in memory, and streaming it needs a saved project`,
        'error',
        'Import',
      )
      return null
    }
    const id = makeCloudId()
    const name = `${id}-${Date.now().toString(36)}`
    building.add(name)
    try {
      const dir = await opfs.lodDir(pid)
      log(
        `Cloud import: ${file.name} is too large to hold in memory — streaming it into a level-of-detail octree`,
        'info',
        'Import',
      )
      const meta = await buildOnPool(
        (pool) =>
          workerBuildLod(
            { file, dir, name, pool },
            { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
          ),
        { dir, name, report: { kind: 'import' } },
        onProgress,
      )
      if (projectId() !== pid) {
        await discard(dir, meta)
        log(`Cloud import: ${file.name} was not added — its project was closed while it streamed`, 'warn', 'Import')
        return null
      }
      const cloud = {
        id,
        name: `Imported (${file.name})`,
        kind: 'dense',
        createdAt: Date.now(),
        imported: true,
        cameras: markRaw(new Map()),
        count: meta.points,
        pos: null,
        col: null,
        lod: markRaw(meta),
        // A survey without colour reads best by height (a single colour shows no relief).
        ...(meta.layout.colour ? {} : { style: { field: 'elevation' } }),
      }
      clouds.value.push(cloud)
      selectedCloudId.value = cloud.id
      log(
        `Cloud import: added "${cloud.name}" — ${meta.points.toLocaleString()} points, streamed` +
          `${meta.layout.colour ? ', colour' : ''}`,
        'success',
        'Import',
      )
      await save()
      return cloud
    } catch (err) {
      log(`Cloud import: ${file.name}: ${err?.message ?? err}`, 'error', 'Import')
      return null
    } finally {
      building.delete(name)
      await prune().catch(() => {})
    }
  }

  // A COPC file (core/lod/copc.js) imported as it is: it already is a level-of-detail
  // octree, so it is copied into the project's lod/ folder and read in place, never
  // decoded whole and never rebuilt. A streamed cloud like the others: drawn, cropped,
  // gridded, edited and exported through its octree. → the new cloud, or null.
  async function importCopcCloud(file, onProgress) {
    const pid = projectId()
    if (!pid) {
      log(`Cloud import: reading ${file.name} in place (COPC) needs a saved project`, 'error', 'Import')
      return null
    }
    const id = makeCloudId()
    const name = `${id}-${Date.now().toString(36)}`
    building.add(name)
    try {
      const dir = await opfs.lodDir(pid)
      log(`Cloud import: ${file.name} is a COPC file — reading its octree in place`, 'info', 'Import')
      const meta = await workerImportCopc(
        { file, dir, name },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
      )
      if (projectId() !== pid) {
        await discard(dir, meta)
        log(`Cloud import: ${file.name} was not added — its project was closed while it was copied`, 'warn', 'Import')
        return null
      }
      // Coordinates land as they are (no reprojection, as for every cloud import): say so
      // when the file's CRS is not the project's. A project still in its default
      // (geographic) CRS has not chosen one yet: a hint, not a warning.
      const crs = meta.file?.crs,
        project = projectCrs()
      if (crs && project && project !== 'local' && crs !== project) {
        const unset = project === 'EPSG:4326'
        log(
          `Cloud import: ${file.name} is in ${crs}, the project in ${project} — its coordinates are used as they are, not reprojected` +
            (unset ? `; set the project CRS to ${crs} to georeference the model into them` : ''),
          unset ? 'info' : 'warn',
          'Import',
        )
      }
      const cloud = {
        id,
        name: `Imported (${file.name})`,
        kind: 'dense',
        createdAt: Date.now(),
        imported: true,
        cameras: markRaw(new Map()),
        count: meta.points,
        pos: null,
        col: null,
        lod: markRaw(meta),
        ...(meta.layout.colour ? {} : { style: { field: 'elevation' } }),
      }
      clouds.value.push(cloud)
      selectedCloudId.value = cloud.id
      log(
        `Cloud import: added "${cloud.name}" — ${meta.points.toLocaleString()} points, read in place (COPC)` +
          `${meta.layout.colour ? ', colour' : ''}`,
        'success',
        'Import',
      )
      await save()
      return cloud
    } catch (err) {
      log(`Cloud import: ${file.name}: ${err?.message ?? err}`, 'error', 'Import')
      return null
    } finally {
      building.delete(name)
      await prune().catch(() => {})
    }
  }

  // A source over the cloud's octree (core/lod/cloudSource.js: ours or a COPC file), or
  // null when it has none or its files are gone.
  async function openCloudLod(cloud) {
    const pid = projectId()
    if (!cloud?.lod || !pid) return null
    try {
      const lod = cloud.lod
      const { data, hierarchy } = await lodFiles(pid, lod)
      // A COPC node is a LASzip chunk: decoded in its own worker; the hierarchy pages
      // below the root are read as the view reaches them.
      return await openCloudSource(
        lod,
        { data, hierarchy },
        isCopcLod(lod) ? { readNode: (node, as) => readCopcNode(data, node, lod, as), hierarchy: 'lazy' } : {},
      )
    } catch (err) {
      // A cloud whose points are in memory does not need its octree: drop the
      // unreadable one (a new object, so the viewer draws it whole and the
      // background build makes a fresh octree). A streamed cloud has nothing else.
      const idx = projectId() === pid ? clouds.value.findIndex((c) => c === cloud || c.id === cloud.id) : -1
      if (idx >= 0 && clouds.value[idx].pos && clouds.value[idx].lod === cloud.lod) {
        const { lod: _lod, ...rest } = clouds.value[idx]
        clouds.value.splice(idx, 1, rest)
        log(
          `Level of detail: the octree of "${cloud.name}" could not be read (${err?.message ?? err}); drawing it whole and building it again`,
          'warn',
          'Products',
        )
      }
      return null
    }
  }

  // Every dense cloud of LOD_MIN_POINTS or more gets its octree in the background, one
  // at a time, once per cloud object (a failed build is not retried until it changes).
  const attempted = new WeakSet()
  let running = false
  async function buildMissing() {
    if (running || !projectId()) return
    running = true
    try {
      for (;;) {
        const next = clouds.value.find(
          (c) => c.kind === 'dense' && !c.lod && c.count >= LOD_MIN_POINTS && c.pos && !attempted.has(c),
        )
        if (!next) break
        attempted.add(next)
        log(
          `Level of detail: building the octree of "${next.name}" (${next.count.toLocaleString()} points)…`,
          'info',
          'Products',
        )
        await buildCloudLod(next.id)
      }
    } finally {
      running = false
    }
  }
  watch(
    () => clouds.value.map((c) => (c.lod ? null : c.count)),
    () => {
      buildMissing()
    },
  )

  // Points of a cloud's octree into memory (core/lod/extract.js), for a tool that
  // needs resident points: a box, a point budget (met by stopping at a level, so the
  // cloud is thinned evenly), a spacing that is fine enough, LAS classes.
  // → { cloud: { count, pos, col?, attributes }, plan: { level, deepest, spacing, complete } }
  async function extractCloudPoints(cloud, opts = {}, onProgress) {
    const pid = projectId()
    if (!cloud?.lod || !pid) throw new Error('the cloud has no octree')
    const { data, hierarchy } = await lodFiles(pid, cloud.lod)
    return workerExtractLod(
      { lod: JSON.parse(JSON.stringify(cloud.lod)), data, hierarchy, ...opts },
      { onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
    )
  }

  // A cloud written from its octree (a streamed cloud's export): → { blob, count }
  async function exportCloudLod(cloud, { format, color = true } = {}, onProgress) {
    const pid = projectId()
    if (!cloud?.lod || !pid) throw new Error('the cloud has no octree')
    const { data, hierarchy } = await lodFiles(pid, cloud.lod)
    return workerExportLod(
      { lod: JSON.parse(JSON.stringify(cloud.lod)), data, hierarchy, format, color },
      { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
    )
  }

  // A cloud's octree as a 3D Tiles tileset (core/lod/tiles3d.js), one tile per node:
  // placement { sim, origin, transform } from the caller. → { blob, tiles, contentTiles, points, levels }
  async function exportCloudTiles(cloud, { sim = null, origin, transform = null, color = true } = {}, onProgress) {
    const pid = projectId()
    if (!cloud?.lod || !pid) throw new Error('the cloud has no octree')
    const { data, hierarchy } = await lodFiles(pid, cloud.lod)
    return workerExportPointTiles(
      { lod: JSON.parse(JSON.stringify(cloud.lod)), data, hierarchy, sim, origin, transform, color },
      { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
    )
  }

  // A neighbourhood edit's tiles on the pool (core/lod/transform.js planTiledEdit): each
  // worker takes the next tile until none is left, and writes its output to a temporary
  // file; the outlier filter's limit comes from every tile's statistics; one worker
  // builds the octree from the files. → the octree's metadata, or undefined where one
  // worker does it all (one tile, one worker, an outlier filter that is not last, or
  // `settings.split === false`).
  async function editTilesOnPool(input, onProgress) {
    const { mode, settings } = input
    const methods = settings.methods ?? []
    if (POOL_SIZE < 2 || settings.split === false || (mode !== 'filter' && mode !== 'classify-ground')) return undefined
    if (mode === 'filter' && methods.includes('sor') && methods.at(-1) !== 'sor') return undefined
    const t0 = performance.now()
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
    const tilePoints = Math.max(
      MIN_TILE_POINTS,
      Math.min(settings.tilePoints ?? MAX_TILE_POINTS, Math.floor(budget / POOL_SIZE / TILE_BYTES_PER_POINT)),
    )
    const files = { lod: input.lod, data: input.data, hierarchy: input.hierarchy }
    const plan = await workerPlanLodEdit({ ...files, mode, settings, tilePoints }, { worker: 0 })
    const n = plan.tiles.length
    const workers = Math.min(POOL_SIZE, n)
    if (workers < 2) {
      await workerReleaseLodSource(0)
      return undefined
    }
    log(
      `${plan.label}: ${pluralize(n, 'tile')} of up to ${(tilePoints / 1e6).toFixed(1)} M points with a ` +
        `${plan.halo.toPrecision(3)}-unit margin, on ${pluralize(workers, 'worker')}`,
      'info',
      'Products',
    )
    const dir = `edit-${input.name}`
    const results = new Array(n)
    let next = 0,
      done = 0,
      failed = false
    try {
      await Promise.all(
        Array.from({ length: workers }, async (_, w) => {
          try {
            while (!failed && next < n) {
              const tile = next++
              results[tile] = await workerEditLodTile({ ...files, plan, tile, dir }, { worker: w })
              done++
              onProgress?.(done, n + 1, mode === 'filter' ? 'Filtering tiles' : 'Classifying tiles', done / (n + 1))
            }
          } catch (err) {
            failed = true
            throw err
          }
        }),
      )
    } finally {
      await Promise.all(Array.from({ length: workers }, (_, w) => workerReleaseLodSource(w).catch(() => {})))
    }
    let limit = null
    if (plan.sor) {
      const s = outlierLimit(results.map((r) => r.stats).filter(Boolean), plan.sor.stdRatio)
      limit = s.limit
      log(
        `Filter (outlier): mean neighbour distance ${s.mu.toFixed(4)} ±${s.sigma.toFixed(4)} over the whole cloud, limit ${limit.toFixed(4)}`,
        'info',
        'Products',
      )
    }
    if (mode === 'classify-ground') {
      const ground = results.reduce((a, r) => a + r.ground, 0)
      log(`Ground filter: ${ground.toLocaleString()} ground points`, 'info', 'Products')
      const note = clothNote(
        results.map((r) => r.cloth),
        settings.clothResolution ?? 1,
        settings.metresPerUnit ?? 1,
      )
      if (note) log(note, 'warn', 'Products')
    }
    log(
      `${plan.label}: ${pluralize(n, 'tile')} on ${pluralize(workers, 'worker')} in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      'info',
      'Products',
    )
    return buildOnPool(
      (pool) =>
        workerTransformLod(
          { ...input, tiles: { dir, plan, limit }, pool },
          {
            onLog: (m, l, c) => log(m, l, c),
            onProgress: (d, t) =>
              onProgress?.(n + d / Math.max(1, t), n + 1, 'Sorting the octree', (n + d / t) / (n + 1)),
          },
        ),
      { dir: input.dir, name: input.name, report: { kind: 'edit', sourcePoints: input.lod.points } },
      onProgress,
    )
  }

  // An edit of a streamed cloud (core/lod/transform.js): its points go through the
  // edit into a new octree, and so a NEW streamed cloud, as every edit is non-destructive.
  // mode 'crop' (invert) | 'mask' | 'classify' | 'filter' | 'classify-ground'. → the cloud, or null
  async function editStreamedCloud(source, { mode, settings = {}, name }, onProgress) {
    const pid = projectId()
    if (!source?.lod || !pid) return null
    const id = makeCloudId()
    const fileName = `${id}-${Date.now().toString(36)}`
    building.add(fileName)
    try {
      const { data, hierarchy } = await lodFiles(pid, source.lod)
      const dir = await opfs.lodDir(pid)
      const input = {
        lod: JSON.parse(JSON.stringify(source.lod)),
        data,
        hierarchy,
        dir,
        name: fileName,
        mode,
        settings: JSON.parse(JSON.stringify(settings)),
      }
      const meta =
        (await editTilesOnPool(input, onProgress)) ??
        (await buildOnPool(
          (pool) =>
            workerTransformLod(
              { ...input, pool },
              { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
            ),
          { dir, name: fileName, report: { kind: 'edit', sourcePoints: source.lod.points } },
          onProgress,
        ))
      if (projectId() !== pid) {
        await discard(dir, meta)
        log(`Cloud edit: "${name}" was not added — its project was closed while the edit ran`, 'warn', 'Products')
        return null
      }
      const cloud = {
        id,
        name,
        kind: 'dense',
        createdAt: Date.now(),
        derived: true,
        basedOn: [stampOf(source)],
        ...(source.imported ? { imported: true } : {}),
        cameras: markRaw(new Map()),
        count: meta.points,
        pos: null,
        col: null,
        lod: markRaw(meta),
        ...(source.style ? { style: JSON.parse(JSON.stringify(source.style)) } : {}),
      }
      clouds.value.push(cloud)
      selectedCloudId.value = cloud.id
      await save()
      return cloud
    } finally {
      building.delete(fileName)
      await prune().catch(() => {})
    }
  }

  return {
    buildCloudLod,
    openCloudLod,
    importStreamedCloud,
    importCopcCloud,
    extractCloudPoints,
    exportCloudLod,
    exportCloudTiles,
    editStreamedCloud,
    pruneLod: prune,
  }
}
