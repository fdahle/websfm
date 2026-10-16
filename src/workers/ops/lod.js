import { buildLod as runBuild } from '../../core/lod/build.js'
import { typeName } from '../../core/lod/nodeCodec.js'
import { openLasStream } from '../../core/io/lasStream.js'
import { blobSource } from '../../utils/blobParts.js'
import { openLodReader } from '../../core/lod/reader.js'
import { planExtract, extractPoints } from '../../core/lod/extract.js'
import { lodToLas, lodToText } from '../../core/lod/exportStream.js'

// Level-of-detail octree build (dev/planning/plan-lod.md ▸ L2). The core
// (core/lod/build.js) is pure; this side supplies the files:
//   - chunk files: always in OPFS (they are temporary, so a project kept in a folder on
//     disk needs them nowhere else), through sync access handles: appends in place,
//     where a writable would copy the file per append;
//   - the data file and hierarchy: in the directory the caller passes (the project's
//     lod/ folder, OPFS or on disk), written sequentially through one writable.

const OPEN_HANDLES = 48           // chunk files open at once (each holds a descriptor)
const WRITE_BUFFER = 16 << 20     // data file bytes gathered per write

async function tmpStore(dirName) {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle('websfm', { create: true })
  const tmpRoot = await root.getDirectoryHandle('tmp', { create: true })
  const dir = await tmpRoot.getDirectoryHandle(dirName, { create: true })
  const open = new Map() // name → handle, in least-recently-used order
  async function handle(name) {
    let h = open.get(name)
    if (h) { open.delete(name); open.set(name, h); return h }
    if (open.size >= OPEN_HANDLES) {
      const [oldest, oh] = open.entries().next().value
      oh.close(); open.delete(oldest)
    }
    const fh = await dir.getFileHandle(name, { create: true })
    h = await fh.createSyncAccessHandle()
    open.set(name, h)
    return h
  }
  return {
    async append(name, u8) { const h = await handle(name); h.write(u8, { at: h.getSize() }) },
    async size(name) { return (await handle(name)).getSize() },
    async read(name, offset, length) {
      const out = new Uint8Array(length)
      ;(await handle(name)).read(out, { at: offset })
      return out
    },
    async remove(name) {
      open.get(name)?.close(); open.delete(name)
      await dir.removeEntry(name).catch(() => {})
    },
    async dispose() {
      for (const h of open.values()) h.close()
      open.clear()
      await tmpRoot.removeEntry(dirName, { recursive: true }).catch(() => {})
    },
  }
}

async function dataWriter(dir, name) {
  const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
  let size = 0, pending = [], pendingBytes = 0
  async function flush() {
    if (!pendingBytes) return
    const buf = new Uint8Array(pendingBytes)
    let o = 0
    for (const p of pending) { buf.set(p, o); o += p.length }
    pending = []; pendingBytes = 0
    await writable.write(buf)
  }
  return {
    async write(u8) {
      const at = size
      pending.push(u8); pendingBytes += u8.length; size += u8.length
      if (pendingBytes >= WRITE_BUFFER) await flush()
      return at
    },
    async close() { await flush(); await writable.close() },
    async abort() { await writable.abort?.().catch(() => {}) },
  }
}

// A resident cloud as a batch source (views, no copies).
function arraySource(cloud, batch = 1 << 20) {
  const { count, pos, col } = cloud
  const attrs = cloud.attributes ?? {}
  let bounds = cloud.bounds
  if (!bounds) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < count; i++) for (let k = 0; k < 3; k++) {
      const v = pos[3 * i + k]
      if (v < min[k]) min[k] = v
      if (v > max[k]) max[k] = v
    }
    bounds = { min, max }
  }
  return {
    count, bounds, colour: !!col,
    attributes: Object.entries(attrs).map(([name, arr]) => ({ name, type: typeName(arr) })),
    async *batches() {
      for (let s = 0; s < count; s += batch) {
        const e = Math.min(count, s + batch)
        yield {
          count: e - s, pos: pos.subarray(3 * s, 3 * e), col: col?.subarray(3 * s, 3 * e),
          attributes: Object.fromEntries(Object.entries(attrs).map(([k, a]) => [k, a.subarray(s, e)])),
        }
      }
    },
  }
}

export function makeLodOps({ lazCodec = null } = {}) {
  // input { cloud: { count, pos, col?, attributes?, bounds? } | file: File (a LAS/LAZ,
  //         streamed: never held whole), dir: FileSystemDirectoryHandle, name }
  // → { name, dataFile, hierarchyFile, root, layout, spacing, nodeCount, dataBytes, points,
  //     levels, bounds, stats, file?: { version, format, laz } }
  async function buildLod([input], { emit }) {
    const { cloud, file, dir, name } = input
    const t0 = performance.now()
    const log = (m, l, c) => emit('log', [m, l, c])
    let source, layout = input.layout, fileInfo = null
    if (file) {
      const src = blobSource(file, file.name)
      await lazCodec?.ensure() // a LAZ is told by its header bit or its VLR: load it either way
      source = await openLasStream(src, { createLazDecoder: lazCodec?.createDecoder ?? null, onLog: log })
      layout = source.layout
      const h = source.header
      // The projection VLRs (GeoKeys, WKT) go back into a LAS written from the octree.
      const projection = h.vlrs.filter((v) => v.userId === 'LASF_Projection').map((v) => ({
        userId: v.userId, recordId: v.recordId, description: '', data: btoa(String.fromCharCode(...v.data)),
      }))
      fileInfo = { version: `${h.versionMajor}.${h.versionMinor}`, format: h.format, laz: h.isLaz, projection }
    } else source = arraySource(cloud)
    const tmp = await tmpStore(`lod-${name}`)
    const dataFile = `${name}.lod`, hierarchyFile = `${name}.hier`
    const out = await dataWriter(dir, dataFile)
    try {
      const res = await runBuild(source, tmp, out, {
        layout,
        onProgress: (done, total, label) => emit('progress', [done, total, label, done / total]),
      })
      await out.close()
      const hw = await (await dir.getFileHandle(hierarchyFile, { create: true })).createWritable()
      await hw.write(res.hierarchy)
      await hw.close()
      const { hierarchy, ...meta } = res
      emit('log', [`Level of detail: ${meta.points.toLocaleString()} points in ${meta.nodeCount.toLocaleString()} nodes, `
        + `${meta.levels} levels, ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'info', 'Products'])
      return { result: { ...meta, name, dataFile, hierarchyFile, hierarchyBytes: hierarchy.length, ...(fileInfo ? { file: fileInfo } : {}) } }
    } catch (err) {
      await out.abort()
      await dir.removeEntry(dataFile).catch(() => {})
      throw err
    } finally {
      await tmp.dispose()
    }
  }

  // Points of an octree into memory (core/lod/extract.js): a box, a budget, classes.
  // input { lod, data: File, hierarchy: File, box?, maxPoints?, minSpacing?, classes?: [n], fields? }
  // → { cloud: { count, pos, col?, attributes }, plan: { level, deepest, spacing, complete } }
  async function extractLod([input], { emit }) {
    const { lod, data, hierarchy, box = null, maxPoints = Infinity, minSpacing = 0, classes = null, fields = 'all' } = input
    const reader = await openLodReader(lod, { data, hierarchy })
    const plan = planExtract(reader.nodes, lod, { box, maxPoints, minSpacing })
    const cloud = await extractPoints(reader, plan, lod, {
      box, classes: classes ? new Set(classes) : null, fields,
      onProgress: (done, total) => emit('progress', [done, total, 'Reading points', done / Math.max(1, total)]),
    })
    const transfer = [cloud.pos.buffer, ...(cloud.col ? [cloud.col.buffer] : []), ...Object.values(cloud.attributes).map((a) => a.buffer)]
    const { nodes, ...summary } = plan
    return { result: { cloud, plan: { ...summary, nodes: nodes.length } }, transfer }
  }

  // A streamed cloud to a file, node by node (core/lod/exportStream.js).
  // input { lod, data: File, hierarchy: File, format: 'las' | 'ply' | 'xyz', color } → { blob, count }
  async function exportLod([input], { emit }) {
    const { lod, data, hierarchy, format, color = true } = input
    const t0 = performance.now()
    const reader = await openLodReader(lod, { data, hierarchy })
    const onProgress = (done, total) => emit('progress', [done, total, 'Writing points', done / Math.max(1, total)])
    // Parts gathered into a Blob in batches (the browser keeps large Blobs on disk).
    let blob = null, batch = [], size = 0
    const add = (p) => {
      batch.push(p); size += typeof p === 'string' ? p.length : p.byteLength
      if (size >= 64 << 20) { blob = new Blob(blob ? [blob, ...batch] : batch); batch = []; size = 0 }
    }
    let type = 'application/octet-stream'
    if (format === 'las') {
      const las = lodToLas(reader, lod, { onProgress })
      for await (const p of las.parts) add(p)
      blob = new Blob([las.header(), ...(blob ? [blob] : []), ...batch], { type })
    } else {
      if (format === 'xyz') type = 'text/plain;charset=utf-8'
      for await (const p of lodToText(reader, lod, { format, color, onProgress })) add(p)
      blob = new Blob([...(blob ? [blob] : []), ...batch], { type })
    }
    emit('log', [`${format.toUpperCase()} written: ${lod.points.toLocaleString()} points from the octree, `
      + `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info', 'Export'])
    return { result: { blob, count: lod.points } }
  }

  return { buildLod, extractLod, exportLod }
}
