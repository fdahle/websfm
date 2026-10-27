import { distributeLod, buildChunks, finishLod } from '../../core/lod/build.js'
import { typeName } from '../../core/lod/nodeCodec.js'
import { openLasStream } from '../../core/io/lasStream.js'
import { blobSource, blobChunks } from '../../utils/blobParts.js'
import { openCloudSource, isCopcLod } from '../../core/lod/cloudSource.js'
import { readCopcMeta } from '../../core/lod/copc.js'
import { planExtract, extractPoints } from '../../core/lod/extract.js'
import { lodToLas, lodToText, lasPlanFor } from '../../core/lod/exportStream.js'
import {
  streamedEditSource,
  planTiledEdit,
  readTile,
  editTile,
  packTile,
  tileOutputsSource,
} from '../../core/lod/transform.js'

// Level-of-detail octree build (dev/planning/plan-lod.md ▸ L2). The core
// (core/lod/build.js) is pure; this side supplies the files:
//   - chunk files: always in OPFS (they are temporary, so a project kept in a folder on
//     disk needs them nowhere else), through sync access handles: appends in place,
//     where a writable would copy the file per append;
//   - the data file and hierarchy: in the directory the caller passes (the project's
//     lod/ folder, OPFS or on disk), written sequentially through one writable.

const OPEN_HANDLES = 48 // chunk files open at once (each holds a descriptor)
const WRITE_BUFFER = 16 << 20 // data file bytes gathered per write

async function tmpStore(dirName) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('websfm', { create: true })
  const tmpRoot = await root.getDirectoryHandle('tmp', { create: true })
  const dir = await tmpRoot.getDirectoryHandle(dirName, { create: true })
  const open = new Map() // name → handle, in least-recently-used order
  async function handle(name) {
    let h = open.get(name)
    if (h) {
      open.delete(name)
      open.set(name, h)
      return h
    }
    if (open.size >= OPEN_HANDLES) {
      const [oldest, oh] = open.entries().next().value
      oh.close()
      open.delete(oldest)
    }
    const fh = await dir.getFileHandle(name, { create: true })
    h = await fh.createSyncAccessHandle()
    open.set(name, h)
    return h
  }
  return {
    async append(name, u8) {
      const h = await handle(name)
      h.write(u8, { at: h.getSize() })
    },
    async size(name) {
      return (await handle(name)).getSize()
    },
    async read(name, offset, length) {
      const out = new Uint8Array(length)
      ;(await handle(name)).read(out, { at: offset })
      return out
    },
    async remove(name) {
      open.get(name)?.close()
      open.delete(name)
      await dir.removeEntry(name).catch(() => {})
    },
    // Every handle closed, the files kept: another worker opens them next (a sync
    // access handle is exclusive).
    closeAll() {
      for (const h of open.values()) h.close()
      open.clear()
    },
    async dispose() {
      for (const h of open.values()) h.close()
      open.clear()
      await tmpRoot.removeEntry(dirName, { recursive: true }).catch(() => {})
    },
  }
}

// The temporary folder of one edit's tile outputs (planTiledEdit ▸ editLodTile), in
// OPFS like the chunk files; pruned with them when no build runs (opfs pruneLodFiles).
async function tmpRootDir() {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('websfm', { create: true })
  return root.getDirectoryHandle('tmp', { create: true })
}
const tileDir = async (name, { create = false } = {}) => (await tmpRootDir()).getDirectoryHandle(name, { create })
const removeTileDir = async (name) => (await tmpRootDir()).removeEntry(name, { recursive: true }).catch(() => {})

async function dataWriter(dir, name) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
  let size = 0,
    pending = [],
    pendingBytes = 0
  async function flush() {
    if (!pendingBytes) return
    const buf = new Uint8Array(pendingBytes)
    let o = 0
    for (const p of pending) {
      buf.set(p, o)
      o += p.length
    }
    pending = []
    pendingBytes = 0
    await writable.write(buf)
  }
  return {
    async write(u8) {
      const at = size
      pending.push(u8)
      pendingBytes += u8.length
      size += u8.length
      if (pendingBytes >= WRITE_BUFFER) await flush()
      return at
    },
    async close() {
      await flush()
      await writable.close()
    },
    async abort() {
      await writable.abort?.().catch(() => {})
    },
  }
}

// A resident cloud as a batch source (views, no copies).
function arraySource(cloud, batch = 1 << 20) {
  const { count, pos, col } = cloud
  const attrs = cloud.attributes ?? {}
  let bounds = cloud.bounds
  if (!bounds) {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++)
      for (let k = 0; k < 3; k++) {
        const v = pos[3 * i + k]
        if (v < min[k]) min[k] = v
        if (v > max[k]) max[k] = v
      }
    bounds = { min, max }
  }
  return {
    count,
    bounds,
    colour: !!col,
    attributes: Object.entries(attrs).map(([name, arr]) => ({ name, type: typeName(arr) })),
    async *batches() {
      for (let s = 0; s < count; s += batch) {
        const e = Math.min(count, s + batch)
        yield {
          count: e - s,
          pos: pos.subarray(3 * s, 3 * e),
          col: col?.subarray(3 * s, 3 * e),
          attributes: Object.fromEntries(Object.entries(attrs).map(([k, a]) => [k, a.subarray(s, e)])),
        }
      }
    },
  }
}

// A cloud's octree as a source (core/lod/cloudSource.js): ours, or a COPC file read in
// place, whose nodes are LASzip chunks (every hierarchy page read: the worker tools,
// and the 3D Tiles export, walk every node).
export async function openWorkerCloudSource(lod, files, lazCodec) {
  if (!isCopcLod(lod)) return openCloudSource(lod, files)
  if (!lazCodec) throw new Error('COPC: the lazcodec module is not available')
  await lazCodec.ensure()
  return openCloudSource(lod, files, { createChunkDecoder: lazCodec.createChunkDecoder, hierarchy: 'all' })
}

export function makeLodOps({ lazCodec = null } = {}) {
  const openSource = (lod, files) => openWorkerCloudSource(lod, files, lazCodec)

  // The octree of `source` into `dir`: `<name>.lod` and `<name>.hier`. With `pool`
  // ({ tmpDir, chunkMax }) and more than one chunk, it stops once the points are sorted
  // into chunk files (kept in OPFS tmp/<tmpDir>) and returns { pooled: state }: the store
  // builds the chunks over the pool (buildLodChunk) and joins them (finishLodPool).
  // → { res } (core/lod/build.js finishLod's result) or { pooled }
  async function writeOctree(source, { dir, name, layout, pool = null, onProgress }) {
    const tmp = await tmpStore(pool?.tmpDir ?? `lod-${name}`)
    let keep = false
    try {
      const state = await distributeLod(source, tmp, { layout, chunkMax: pool?.chunkMax, onProgress }).catch((err) => {
        throw new Error(`sorting points into chunks: ${err?.message ?? err}`)
      })
      if (pool && state.chunks.length > 1) {
        keep = true
        return { pooled: state }
      }
      const dataFile = `${name}.lod`
      const out = await dataWriter(dir, dataFile)
      try {
        const part = await buildChunks(state.chunks, tmp, out, state, { onProgress })
        const res = await finishLod(state, [part], out)
        await out.close()
        await writeHierarchy(dir, name, res.hierarchy)
        return { res }
      } catch (err) {
        await out.abort()
        await dir.removeEntry(dataFile).catch(() => {})
        throw err
      }
    } finally {
      if (keep) tmp.closeAll()
      else await tmp.dispose()
    }
  }
  async function writeHierarchy(dir, name, hierarchy) {
    const hw = await (await dir.getFileHandle(`${name}.hier`, { create: true })).createWritable()
    await hw.write(hierarchy)
    await hw.close()
  }
  // The metadata a cloud keeps of its octree.
  const octreeMeta = (res, name, extra = {}) => {
    const { hierarchy, ...meta } = res
    return {
      ...meta,
      name,
      dataFile: `${name}.lod`,
      hierarchyFile: `${name}.hier`,
      hierarchyBytes: hierarchy.length,
      ...extra,
    }
  }

  // The log of a finished octree: a build or import, or an edit (`sourcePoints`).
  function reportOctree(emit, meta, { kind, seconds, sourcePoints = 0, workers = 1 }) {
    const on = workers > 1 ? `, ${workers} workers` : ''
    if (kind === 'edit') {
      emit('log', [
        `Edit: ${meta.points.toLocaleString()} of ${sourcePoints.toLocaleString()} points into a new octree in ${seconds.toFixed(1)} s${on}`,
        'info',
        'Products',
      ])
      return
    }
    emit('log', [
      `Level of detail: ${meta.points.toLocaleString()} points in ${meta.nodeCount.toLocaleString()} nodes, ` +
        `${meta.levels} levels, ${seconds.toFixed(1)} s${on}`,
      'info',
      'Products',
    ])
    if (meta.outside) {
      // The octree's cube came from the file header's extent, before any point was read.
      emit('log', [
        `Level of detail: ${meta.outside.toLocaleString()} points lie outside the extent ${kind === 'import' ? 'the file header gives' : 'measured'} ` +
          '— they are kept, but the view and box reads (crop, DEM) can miss them; fix the header (e.g. pdal translate / lasinfo -repair) and import again',
        'warn',
        kind === 'import' ? 'Import' : 'Products',
      ])
    }
  }

  // One chunk of a pooled build (writeOctree ▸ pooled): its subtree into the part file
  // `part-<index>.bin` beside the chunk files. input { tmpDir, state, chunk, index }
  // → { entries (offsets in the part), roots } (the chunk root's points transferred)
  async function buildLodChunk([input]) {
    const { tmpDir, state, chunk, index } = input
    const tmp = await tmpStore(tmpDir)
    const part = `part-${index}.bin`
    try {
      return await buildOneChunk(tmp, part, chunk, state)
    } catch (err) {
      throw new Error(`octree chunk ${chunk.key.join('-')}: ${err?.message ?? err}`)
    } finally {
      tmp.closeAll()
    }
  }
  async function buildOneChunk(tmp, part, chunk, state) {
    const out = {
      async write(u8) {
        const at = await tmp.size(part)
        await tmp.append(part, u8)
        return at
      },
    }
    const r = await buildChunks([chunk], tmp, out, state)
    const transfer = []
    for (const root of r.roots) {
      const p = root.points
      transfer.push(p.pos.buffer, ...(p.col ? [p.col.buffer] : []), ...Object.values(p.attributes).map((a) => a.buffer))
    }
    return { result: r, transfer }
  }

  // A pooled build joined: the parts into `<name>.lod` in order, the levels above the
  // chunks lifted, the hierarchy written, the temporary folder removed.
  // input { tmpDir, state, parts: [{ index, entries, roots }], dir, name, extra, report }
  // → the octree's metadata (as buildLod's)
  async function finishLodPool([input], { emit }) {
    const { tmpDir, state, parts, dir, name, extra = {}, report = null } = input
    const dataFile = `${name}.lod`
    const out = await dataWriter(dir, dataFile)
    const folder = await tileDir(tmpDir)
    try {
      const placed = []
      let done = 0
      for (const p of parts) {
        // A chunk that is its own root only (a few points) wrote no node: no part file.
        if (!p.entries.length) {
          placed.push({ ...p, base: 0 })
          continue
        }
        const file = await (await folder.getFileHandle(`part-${p.index}.bin`)).getFile()
        let base = null
        for (let o = 0; o < file.size; o += 32 << 20) {
          const at = await out.write(new Uint8Array(await file.slice(o, o + (32 << 20)).arrayBuffer()))
          if (base == null) base = at
        }
        placed.push({ ...p, base: base ?? 0 })
        emit('progress', [++done, parts.length, 'Joining the octree', done / parts.length])
      }
      const res = await finishLod(state, placed, out)
      await out.close()
      await writeHierarchy(dir, name, res.hierarchy)
      const meta = octreeMeta(res, name, extra)
      // `report.startedAt`: Date.now() when the store started the build (another thread).
      if (report) reportOctree(emit, meta, { ...report, seconds: (Date.now() - report.startedAt) / 1000 })
      return { result: meta }
    } catch (err) {
      await out.abort()
      await dir.removeEntry(dataFile).catch(() => {})
      throw new Error(`joining the octree: ${err?.message ?? err}`)
    } finally {
      await removeTileDir(tmpDir)
    }
  }

  // The octree the tile calls of one edit read: opened once per worker, not per tile
  // (a COPC file's hierarchy is read page by page). Dropped by releaseLodSource.
  let shared = null
  async function sharedSource(lod, files) {
    const key = `${lod.dataFile}:${files.data.size}:${files.data.lastModified}`
    if (shared?.key !== key) {
      shared?.reader.close()
      shared = null
      shared = { key, reader: await openSource(lod, files) }
    }
    return shared.reader
  }
  async function releaseLodSource() {
    shared?.reader.close()
    shared = null
    return { result: true }
  }

  // A COPC file imported as it is (core/lod/copc.js): its octree is read from the file,
  // which is copied into the project's lod/ folder; nothing is decoded but the top
  // levels (styling statistics). input { file, dir, name } → the cloud's `lod` metadata
  async function importCopc([input], { emit }) {
    const { file, dir, name } = input
    if (!lazCodec) throw new Error('COPC: the lazcodec module is not available')
    const t0 = performance.now()
    const log = (m, l, c = 'Import') => emit('log', [m, l, c])
    await lazCodec.ensure()
    emit('progress', [0, 1, 'Reading the COPC hierarchy', 0])
    const meta = await readCopcMeta(blobSource(file, file.name), {
      createChunkDecoder: lazCodec.createChunkDecoder,
      onLog: log,
    })
    const dataFile = `${name}.copc.laz`
    const writable = await (await dir.getFileHandle(dataFile, { create: true })).createWritable()
    try {
      let done = 0
      for await (const chunk of blobChunks(file, { chunkBytes: 32 << 20 })) {
        await writable.write(chunk)
        done += chunk.length
        emit('progress', [done, file.size, 'Copying the file into the project', done / Math.max(1, file.size)])
      }
      await writable.close()
    } catch (err) {
      await writable.abort?.().catch(() => {})
      await dir.removeEntry(dataFile).catch(() => {})
      throw err
    }
    log(
      `COPC: ${meta.points.toLocaleString()} points in ${meta.nodeCount.toLocaleString()} nodes, ${meta.levels} levels, ` +
        `point format ${meta.file.format}${meta.layout.colour ? ', colour' : ''}, read in place ` +
        `(${(file.size / 1024 ** 2).toFixed(1)} MB copied) in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
      'info',
    )
    log(
      meta.file.crs
        ? `COPC: CRS ${meta.file.crs}${meta.file.crsName ? ` (${meta.file.crsName})` : ''} from its ${meta.file.projection.some((v) => v.recordId === 2112) ? 'WKT' : 'GeoKey'} record`
        : 'COPC: no CRS record (local coordinates)',
      'info',
    )
    return { result: { ...meta, name, dataFile, hierarchyFile: null } }
  }

  // input { cloud: { count, pos, col?, attributes?, bounds? } | file: File (a LAS/LAZ,
  //         streamed: never held whole), dir: FileSystemDirectoryHandle, name }
  // → { name, dataFile, hierarchyFile, root, layout, spacing, nodeCount, dataBytes, points,
  //     levels, bounds, stats, file?: { version, format, laz } }
  async function buildLod([input], { emit }) {
    const { cloud, file, dir, name } = input
    const t0 = performance.now()
    const log = (m, l, c) => emit('log', [m, l, c])
    let source,
      layout = input.layout,
      fileInfo = null
    if (file) {
      const src = blobSource(file, file.name)
      await lazCodec?.ensure() // a LAZ is told by its header bit or its VLR: load it either way
      source = await openLasStream(src, { createLazDecoder: lazCodec?.createDecoder ?? null, onLog: log })
      layout = source.layout
      const h = source.header
      // The projection VLRs (GeoKeys, WKT) go back into a LAS written from the octree.
      const projection = h.vlrs
        .filter((v) => v.userId === 'LASF_Projection')
        .map((v) => ({
          userId: v.userId,
          recordId: v.recordId,
          description: '',
          data: btoa(String.fromCharCode(...v.data)),
        }))
      fileInfo = { version: `${h.versionMajor}.${h.versionMinor}`, format: h.format, laz: h.isLaz, projection }
    } else source = arraySource(cloud)
    const r = await writeOctree(source, {
      dir,
      name,
      layout,
      pool: input.pool ?? null,
      onProgress: (done, total, label) => emit('progress', [done, total, label, done / total]),
    })
    const extra = fileInfo ? { file: fileInfo } : {}
    if (r.pooled) return { result: { pooled: r.pooled, extra } }
    const meta = octreeMeta(r.res, name, extra)
    reportOctree(emit, meta, { kind: file ? 'import' : 'build', seconds: (performance.now() - t0) / 1000 })
    return { result: meta }
  }

  // Points of an octree into memory (core/lod/extract.js): a box, a budget, classes.
  // input { lod, data: File, hierarchy: File, box?, maxPoints?, minSpacing?, classes?: [n], fields? }
  // → { cloud: { count, pos, col?, attributes }, plan: { level, deepest, spacing, complete } }
  async function extractLod([input], { emit }) {
    const {
      lod,
      data,
      hierarchy,
      box = null,
      maxPoints = Infinity,
      minSpacing = 0,
      classes = null,
      fields = 'all',
    } = input
    const reader = await openSource(lod, { data, hierarchy })
    const plan = planExtract(reader.nodes, lod, { box, maxPoints, minSpacing })
    const cloud = await extractPoints(reader, plan, lod, {
      box,
      classes: classes ? new Set(classes) : null,
      fields,
      onProgress: (done, total) => emit('progress', [done, total, 'Reading points', done / Math.max(1, total)]),
    })
    reader.close()
    const transfer = [
      cloud.pos.buffer,
      ...(cloud.col ? [cloud.col.buffer] : []),
      ...Object.values(cloud.attributes).map((a) => a.buffer),
    ]
    const { nodes, ...summary } = plan
    return { result: { cloud, plan: { ...summary, nodes: nodes.length } }, transfer }
  }

  // A streamed cloud to a file, node by node (core/lod/exportStream.js).
  // input { lod, data: File, hierarchy: File, format: 'las' | 'laz' | 'ply' | 'ply-ascii' | 'xyz', color }
  // → { blob, count }
  async function exportLod([input], { emit }) {
    const { lod, data, hierarchy, format, color = true } = input
    const t0 = performance.now()
    const reader = await openSource(lod, { data, hierarchy })
    const onProgress = (done, total) => emit('progress', [done, total, 'Writing points', done / Math.max(1, total)])
    // Parts gathered into a Blob in batches (the browser keeps large Blobs on disk).
    let blob = null,
      batch = [],
      size = 0
    const add = (p) => {
      batch.push(p)
      size += typeof p === 'string' ? p.length : p.byteLength
      if (size >= 64 << 20) {
        blob = new Blob(blob ? [blob, ...batch] : batch)
        batch = []
        size = 0
      }
    }
    let type = 'application/octet-stream'
    if (format === 'las') {
      const las = lodToLas(reader, lod, { onProgress })
      for await (const p of las.parts) add(p)
      blob = new Blob([las.header(), ...(blob ? [blob] : []), ...batch], { type })
    } else if (format === 'laz') {
      if (!lazCodec) throw new Error('LAZ export: the lazcodec module is not available')
      await lazCodec.ensure()
      const compressor = lazCodec.createCompressor(2, lasPlanFor(lod).recordLength)
      try {
        const laz = lodToLas(reader, lod, { onProgress, compressor })
        if (laz.dropped.length) {
          emit('log', [
            `LAZ export: ${laz.dropped.join(', ')} not written — no LAS extra-bytes type holds it`,
            'warn',
            'Export',
          ])
        }
        for await (const p of laz.parts) add(p)
        const { header, first, tail } = laz.lazEnds()
        blob = new Blob([header, first, ...(blob ? [blob] : []), ...batch, tail], { type })
      } finally {
        compressor.free?.()
      }
    } else {
      if (format === 'xyz' || format === 'ply-ascii') type = 'text/plain;charset=utf-8'
      for await (const p of lodToText(reader, lod, { format, color, onProgress })) add(p)
      blob = new Blob([...(blob ? [blob] : []), ...batch], { type })
    }
    reader.close()
    emit('log', [
      `${format.toUpperCase()} written: ${lod.points.toLocaleString()} points from the octree, ` +
        `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'info',
      'Export',
    ])
    return { result: { blob, count: lod.points } }
  }

  // A neighbourhood edit of a streamed cloud planned tile by tile (core/lod/transform.js
  // planTiledEdit), for the store to spread the tiles over the pool.
  // input { lod, data, hierarchy, mode, settings, tilePoints } → the plan
  async function planLodEdit([input]) {
    const { lod, data, hierarchy, mode, settings = {}, tilePoints } = input
    const reader = await sharedSource(lod, { data, hierarchy })
    return { result: planTiledEdit(lod, reader.nodes, mode, settings, { tilePoints }) }
  }

  // One tile of a planned edit (editTile), its output written to `<dir>/<tile>.bin` in
  // OPFS tmp for the octree build (transformLod `tiles`).
  // input { lod, data, hierarchy, plan, tile, dir } → { count, stats?, ground?, cloth? }
  async function editLodTile([input]) {
    const { lod, data, hierarchy, plan, tile: i, dir } = input
    const reader = await sharedSource(lod, { data, hierarchy })
    const tile = plan.tiles[i]
    const out = editTile(await readTile(reader, lod, plan, tile), plan, tile)
    const bytes = packTile(out, tileOutputsSource(lod, plan, null).attributes)
    const fh = await (await tileDir(dir, { create: true })).getFileHandle(`${i}.bin`, { create: true })
    const h = await fh.createSyncAccessHandle()
    try {
      h.truncate(0)
      h.write(bytes, { at: 0 })
      h.flush()
    } finally {
      h.close()
    }
    return {
      result: { count: out.points.count, stats: out.stats ?? null, ground: out.ground ?? 0, cloth: out.cloth ?? null },
    }
  }

  // An edit of a streamed cloud into a new octree (core/lod/transform.js): never all
  // in memory. Point-wise modes run node by node, neighbourhood modes tile by tile.
  // input { lod, data, hierarchy, dir, name, mode: 'crop' (invert) | 'mask' | 'classify'
  //         | 'filter' | 'classify-ground', settings, tiles?: { dir, plan, limit } }
  // → the new octree's metadata. With `tiles` the edit already ran on the pool
  // (editLodTile): the octree is built from the tiles' outputs, which are then removed.
  async function transformLod([input], { emit }) {
    const { lod, data, hierarchy, dir, name, mode, settings = {}, tiles = null } = input
    const t0 = performance.now()
    const reader = tiles ? null : await openSource(lod, { data, hierarchy })
    const log = (m, l = 'info') => emit('log', [m, l, 'Products'])
    const progress = (done, total, label) => emit('progress', [done, total, label, done / Math.max(1, total)])
    let source
    if (tiles) {
      const folder = await tileDir(tiles.dir)
      source = tileOutputsSource(
        lod,
        tiles.plan,
        async (i) => {
          const fh = await folder.getFileHandle(`${i}.bin`)
          const bytes = new Uint8Array(await (await fh.getFile()).arrayBuffer())
          await folder.removeEntry(`${i}.bin`).catch(() => {})
          return bytes
        },
        { limit: tiles.limit, progress },
      )
    } else source = streamedEditSource(reader, lod, mode, settings, { log, progress })
    try {
      // A moved cloud gets a quantisation for where it now is (the old offset may lie
      // farther from the new points than the stored integers reach); any other edit
      // keeps the source's, so an imported LAS's exact scale survives.
      const layout = mode === 'transform' ? {} : { offset: lod.layout.offset, scale: lod.layout.scale }
      const r = await writeOctree(source, { dir, name, layout, pool: input.pool ?? null })
      const extra = lod.file ? { file: lod.file } : {}
      if (r.pooled) return { result: { pooled: r.pooled, extra } }
      const meta = octreeMeta(r.res, name, extra)
      reportOctree(emit, meta, { kind: 'edit', seconds: (performance.now() - t0) / 1000, sourcePoints: lod.points })
      return { result: meta }
    } finally {
      reader?.close()
      if (tiles) await removeTileDir(tiles.dir)
    }
  }

  return {
    buildLod,
    extractLod,
    exportLod,
    transformLod,
    importCopc,
    planLodEdit,
    editLodTile,
    releaseLodSource,
    buildLodChunk,
    finishLodPool,
  }
}
