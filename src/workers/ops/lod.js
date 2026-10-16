import { buildLod as runBuild } from '../../core/lod/build.js'
import { typeName } from '../../core/lod/nodeCodec.js'

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

export function makeLodOps() {
  // input { cloud: { count, pos, col?, attributes?, bounds? }, dir: FileSystemDirectoryHandle,
  //         name, layout?: { offset, scale } }
  // → { name, dataFile, hierarchyFile, root, layout, spacing, nodeCount, dataBytes, points, levels }
  async function buildLod([input], { emit }) {
    const { cloud, dir, name } = input
    const t0 = performance.now()
    const tmp = await tmpStore(`lod-${name}`)
    const dataFile = `${name}.lod`, hierarchyFile = `${name}.hier`
    const out = await dataWriter(dir, dataFile)
    try {
      const res = await runBuild(arraySource(cloud), tmp, out, {
        layout: input.layout,
        onProgress: (done, total, label) => emit('progress', [done, total, label, done / total]),
      })
      await out.close()
      const hw = await (await dir.getFileHandle(hierarchyFile, { create: true })).createWritable()
      await hw.write(res.hierarchy)
      await hw.close()
      const { hierarchy, ...meta } = res
      emit('log', [`Level of detail: ${meta.points.toLocaleString()} points in ${meta.nodeCount.toLocaleString()} nodes, `
        + `${meta.levels} levels, ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'info', 'Products'])
      return { result: { ...meta, name, dataFile, hierarchyFile, hierarchyBytes: hierarchy.length } }
    } catch (err) {
      await out.abort()
      await dir.removeEntry(dataFile).catch(() => {})
      throw err
    } finally {
      await tmp.dispose()
    }
  }

  return { buildLod }
}
