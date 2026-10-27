// Out-of-core octree build (plan-lod ▸ L2), PotreeConverter 2's scheme. Pure: the
// point source and the file storage are injected, so the same code runs in the
// worker (OPFS) and in tests (memory).
//
// 1. Distribute: one pass over the source puts every point, quantised, into the chunk
//    file of its cube at a fixed level (blocks of node-codec columns).
// 2. Re-split: a chunk file holding more than `chunkMax` points is streamed into its
//    eight children's files, until every chunk fits in memory.
// 3. Per chunk: read it, build its subtree in memory, write every node below the
//    chunk root to the data file; keep the root's points (a grid subsample: small).
// 4. Lift the levels above the chunks from the kept roots, write them.
// Memory stays bounded by one chunk plus the roots, not by the cloud.
//
// source  { count, bounds: { min, max }, colour: bool, attributes: [{ name, type }],
//           batches(): async iterator of { count, pos (Float32|Float64 3n, the
//           cloud's frame), col?: Uint8Array 3n, attributes?: { name: TypedArray } } }
// tmp     { append(name, u8), size(name), read(name, offset, length) → u8, remove(name) }
// out     { write(u8) → byte offset }  (sequential: the data file)

import { rootCube, buildSubtree, liftLevels, keyString, GRID } from './octree.js'
import { encodeNode, decodeNode } from './nodeCodec.js'
import { encodeHierarchy } from './hierarchy.js'

export const CHUNK_MAX = 4_000_000 // points of one chunk built in memory
export const LOD_MIN_POINTS = 4_000_000 // dense clouds this big get an octree and are drawn through it
const HEADER = 8 // block: Uint32 count, Uint32 payload bytes
const MAX_CHUNK_LEVEL = 12

/**
 * The quantisation of a cloud's positions: an explicit LAS { offset, scale } is kept
 * (exact); otherwise the offset is the bounds' min and the scale the power of ten
 * that spans the extent with about 10⁸ steps (0.01 mm on a 1 km cloud).
 */
export function chooseLayout({ bounds, colour, attributes = [], offset, scale }) {
  if (!offset || !scale) {
    const size = Math.max(...[0, 1, 2].map((k) => bounds.max[k] - bounds.min[k])) || 1
    const s = Number(`1e${Math.floor(Math.log10(size / 1e8))}`) // exactly the decimal step
    scale = [s, s, s]
    offset = bounds.min.map((v) => Math.floor(v / s) * s)
  }
  return { offset: [...offset], scale: [...scale], colour: !!colour, attributes: attributes.map((a) => ({ ...a })) }
}

/** The chunk level whose cubes hold about `chunkMax / 2` points on 2.5D data. */
export function chunkLevelFor(count, chunkMax = CHUNK_MAX) {
  return Math.min(7, Math.max(0, Math.ceil(Math.log((2 * count) / chunkMax) / Math.log(4))))
}

const chunkName = ([l, x, y, z]) => `c${l}-${x}-${y}-${z}`

function block(bytes, count) {
  const out = new Uint8Array(HEADER + bytes.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, count, true)
  dv.setUint32(4, bytes.length, true)
  out.set(bytes, HEADER)
  return out
}

// The blocks of a chunk file, decoded one at a time (bounded reads).
async function* readBlocks(tmp, name, layout) {
  const size = await tmp.size(name)
  let off = 0
  while (off < size) {
    const head = await tmp.read(name, off, HEADER)
    const dv = new DataView(head.buffer, head.byteOffset, HEADER)
    const count = dv.getUint32(0, true),
      len = dv.getUint32(4, true)
    const body = await tmp.read(name, off + HEADER, len)
    yield decodeNode(body, count, layout, { as: 'absolute' })
    off += HEADER + len
  }
}

// Growable columns of points (absolute Float64 positions, colour, attributes).
function columns(layout, capacity) {
  const T = (a) =>
    ({
      uint8: Uint8Array,
      int8: Int8Array,
      uint16: Uint16Array,
      int16: Int16Array,
      uint32: Uint32Array,
      int32: Int32Array,
      float32: Float32Array,
      float64: Float64Array,
    })[a.type]
  const c = {
    count: 0,
    pos: new Float64Array(3 * capacity),
    col: layout.colour ? new Uint8Array(3 * capacity) : null,
    attributes: Object.fromEntries(layout.attributes.map((a) => [a.name, new (T(a))(capacity)])),
  }
  c.reserve = (extra) => {
    const need = c.count + extra
    if (3 * need <= c.pos.length) return
    const cap = Math.max(need, Math.ceil((c.pos.length / 3) * 1.5))
    const grow = (arr, per) => {
      const g = new arr.constructor(per * cap)
      g.set(arr.subarray(0, per * c.count))
      return g
    }
    c.pos = grow(c.pos, 3)
    if (c.col) c.col = grow(c.col, 3)
    for (const k of Object.keys(c.attributes)) c.attributes[k] = grow(c.attributes[k], 1)
  }
  // Append points `idx` of `src` (or all of it).
  c.push = (src, idx = null) => {
    const n = idx ? idx.length : src.count
    c.reserve(n)
    for (let k = 0; k < n; k++) {
      const i = idx ? idx[k] : k,
        j = c.count + k
      c.pos[3 * j] = src.pos[3 * i]
      c.pos[3 * j + 1] = src.pos[3 * i + 1]
      c.pos[3 * j + 2] = src.pos[3 * i + 2]
      if (c.col) {
        c.col[3 * j] = src.col[3 * i]
        c.col[3 * j + 1] = src.col[3 * i + 1]
        c.col[3 * j + 2] = src.col[3 * i + 2]
      }
      for (const [name, arr] of Object.entries(c.attributes)) arr[j] = src.attributes[name][i]
    }
    c.count += n
  }
  return c
}

// Point indices of `pts` grouped by the cube (at `level`) they fall in. → Map keyString → { key, idx }
function groupByCube(pts, root, level) {
  const per = 2 ** level,
    cs = root.size / per
  const cell = new Uint32Array(pts.count)
  const counts = new Map()
  for (let i = 0; i < pts.count; i++) {
    const cx = Math.min(per - 1, Math.max(0, Math.floor((pts.pos[3 * i] - root.min[0]) / cs)))
    const cy = Math.min(per - 1, Math.max(0, Math.floor((pts.pos[3 * i + 1] - root.min[1]) / cs)))
    const cz = Math.min(per - 1, Math.max(0, Math.floor((pts.pos[3 * i + 2] - root.min[2]) / cs)))
    const id = cx + per * (cy + per * cz)
    cell[i] = id
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  const groups = new Map()
  for (const [id, n] of counts) {
    const cx = id % per,
      cy = Math.floor(id / per) % per,
      cz = Math.floor(id / (per * per))
    groups.set(id, { key: [level, cx, cy, cz], idx: new Uint32Array(n), fill: 0 })
  }
  for (let i = 0; i < pts.count; i++) {
    const g = groups.get(cell[i])
    g.idx[g.fill++] = i
  }
  return [...groups.values()]
}

/**
 * Build the octree of `source` into `out` (data) using `tmp` (chunk files): the three
 * phases below one after another. The store can run the middle one on the pool instead
 * (each worker a share of the chunks, into a part file of its own: finishLod joins them).
 * opts { chunkMax, leafMax, grid, layout: { offset, scale } (LAS), onProgress(done, total, label) }
 * → { root, layout, spacing, hierarchy: Uint8Array, bounds (of the points written), stats: {
 *   ranges: { attribute: { min, max } }, classes: { value: count } }, nodeCount, dataBytes,
 *   points, levels, outside? (points beyond `source.bounds`' cube, kept in its edge nodes) }
 */
export async function buildLod(source, tmp, out, opts = {}) {
  const state = await distributeLod(source, tmp, opts)
  const part = await buildChunks(state.chunks, tmp, out, state, opts)
  return finishLod(state, [part], out, opts)
}

/**
 * 1 + 2. Every point of `source` into the chunk file of its cube; a chunk of more than
 * `chunkMax` points re-split into its children's files until every chunk fits in memory.
 * → the build's state (plain data): { layout, root, chunks: [{ key, count }], ranges,
 *   classes, lo, hi, outside, total }
 */
export async function distributeLod(source, tmp, opts = {}) {
  const { chunkMax = CHUNK_MAX, onProgress = () => {} } = opts
  const layout = chooseLayout({ ...source, ...(opts.layout ?? {}) })
  const [ox, oy, oz] = layout.offset,
    [sx, sy, sz] = layout.scale
  // A quantisation step around the extent: a point quantises to its nearest step, which
  // may lie just past the extent measured from the unquantised points.
  const root = rootCube(
    source.bounds.min.map((v, k) => v - layout.scale[k]),
    source.bounds.max.map((v, k) => v + layout.scale[k]),
  )
  const total = source.count

  // Each point goes by its quantised position, so the chunk it lands in is the one its
  // stored coordinates say.
  const level0 = chunkLevelFor(total, chunkMax)
  const chunks = new Map() // name → { key, count }
  // Whole-cloud statistics for styling nodes alike (ranges, class counts).
  const ranges = Object.fromEntries(layout.attributes.map((a) => [a.name, { min: Infinity, max: -Infinity }]))
  const classes = {}
  // The extent of the points as written (an edit's output is not its source's extent,
  // a LAS header's is often rounded or stale), and how many fall outside the root cube
  // the build was planned in (a wrong header: stored, but in edge nodes).
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity]
  const cubeHi = [0, 1, 2].map((k) => root.min[k] + root.size)
  let outside = 0
  let done = 0
  for await (const b of source.batches()) {
    for (const [name, r] of Object.entries(ranges)) {
      const arr = b.attributes?.[name]
      if (!arr) continue
      for (let i = 0; i < b.count; i++) {
        const v = arr[i]
        if (v < r.min) r.min = v
        if (v > r.max) r.max = v
      }
      if (name === 'classification') for (let i = 0; i < b.count; i++) classes[arr[i]] = (classes[arr[i]] ?? 0) + 1
    }
    const q = { count: b.count, pos: new Float64Array(3 * b.count), col: b.col, attributes: b.attributes }
    for (let i = 0; i < b.count; i++) {
      const x = (q.pos[3 * i] = Math.round((b.pos[3 * i] - ox) / sx) * sx + ox)
      const y = (q.pos[3 * i + 1] = Math.round((b.pos[3 * i + 1] - oy) / sy) * sy + oy)
      const z = (q.pos[3 * i + 2] = Math.round((b.pos[3 * i + 2] - oz) / sz) * sz + oz)
      if (x < lo[0]) lo[0] = x
      if (x > hi[0]) hi[0] = x
      if (y < lo[1]) lo[1] = y
      if (y > hi[1]) hi[1] = y
      if (z < lo[2]) lo[2] = z
      if (z > hi[2]) hi[2] = z
      if (x < root.min[0] || y < root.min[1] || z < root.min[2] || x > cubeHi[0] || y > cubeHi[1] || z > cubeHi[2])
        outside++
    }
    for (const g of groupByCube(q, root, level0)) {
      const name = chunkName(g.key)
      await tmp.append(name, block(encodeNode(q, g.idx, layout), g.idx.length))
      const c = chunks.get(name) ?? chunks.set(name, { key: g.key, count: 0 }).get(name)
      c.count += g.idx.length
    }
    done += b.count
    onProgress(done, total, 'Sorting points into chunks')
  }

  // A chunk too big for memory: streamed into its children's files.
  const queue = [...chunks.values()]
  const ready = []
  while (queue.length) {
    const chunk = queue.pop()
    if (!(chunk.count > chunkMax && chunk.key[0] < MAX_CHUNK_LEVEL)) {
      ready.push(chunk)
      continue
    }
    const name = chunkName(chunk.key)
    const children = new Map()
    for await (const pts of readBlocks(tmp, name, layout)) {
      for (const g of groupByCube(pts, root, chunk.key[0] + 1)) {
        const cn = chunkName(g.key)
        await tmp.append(cn, block(encodeNode(pts, g.idx, layout), g.idx.length))
        const c = children.get(cn) ?? children.set(cn, { key: g.key, count: 0 }).get(cn)
        c.count += g.idx.length
      }
    }
    await tmp.remove(name)
    queue.push(...children.values())
  }
  // Largest first: a pool's last chunk is a small one.
  ready.sort((a, b) => b.count - a.count)
  return { layout, root, chunks: ready, ranges, classes, lo, hi, outside, total }
}

/**
 * 3. Chunks of a distributed build (distributeLod's `chunks`, or a share of them): each
 * read, its subtree built in memory, every node below the chunk root written to `out`.
 * → { entries: [{ key, count, offset (in `out`), length }], roots: [{ key, hasChildren,
 *   points: { count, pos, col, attributes } (the chunk root's: a grid subsample) }] }
 */
export async function buildChunks(chunks, tmp, out, state, opts = {}) {
  const { grid = GRID, onProgress = () => {} } = opts
  const { layout, root } = state
  const entries = [],
    roots = []
  const total = chunks.reduce((a, c) => a + c.count, 0)
  let built = 0
  for (const chunk of chunks) {
    const name = chunkName(chunk.key)
    const pts = columns(layout, chunk.count)
    for await (const part of readBlocks(tmp, name, layout)) pts.push(part)
    await tmp.remove(name)
    const all = Uint32Array.from({ length: pts.count }, (_, i) => i)
    const sub = buildSubtree(pts, all, root, chunk.key, { leafMax: opts.leafMax, grid })
    for (let k = 1; k < sub.length; k++) {
      const n = sub[k]
      const bytes = encodeNode(pts, n.idx, layout)
      entries.push({ key: n.key, count: n.idx.length, offset: await out.write(bytes), length: bytes.length })
    }
    // The chunk root's points stay for the lift; its children are known now.
    const kept = columns(layout, sub[0].idx.length)
    kept.push(pts, sub[0].idx)
    roots.push({
      key: chunk.key,
      hasChildren: sub.length > 1,
      points: { count: kept.count, pos: kept.pos, col: kept.col, attributes: kept.attributes },
    })
    built += chunk.count
    onProgress(built, total, 'Building the octree')
  }
  return { entries, roots }
}

/**
 * 4. The levels above the chunks, lifted from the chunk roots of every part
 * (buildChunks' results, their node bytes already in `out` at `base` + their offsets),
 * written to `out`; then the hierarchy. → buildLod's result
 */
export async function finishLod(state, parts, out, opts = {}) {
  const { grid = GRID } = opts
  const { layout, root, ranges, classes, lo, hi, outside } = state
  const entries = []
  const kept = columns(layout, 1 << 16)
  const roots = new Map()
  for (const part of parts) {
    const base = part.base ?? 0
    for (const e of part.entries) entries.push(base ? { ...e, offset: e.offset + base } : e)
    for (const r of part.roots) {
      const start = kept.count
      kept.push(r.points)
      roots.set(keyString(r.key), {
        key: r.key,
        idx: Uint32Array.from({ length: kept.count - start }, (_, i) => start + i),
        hasChildren: r.hasChildren,
      })
    }
  }
  const keptPts = { count: kept.count, pos: kept.pos, col: kept.col, attributes: kept.attributes }
  liftLevels(keptPts, roots, root, { grid })
  for (const n of roots.values()) {
    const childOf = n.hasChildren ?? true // lifted parents always have children
    if (!n.idx.length && !childOf) continue
    const bytes = n.idx.length ? encodeNode(keptPts, n.idx, layout) : new Uint8Array(0)
    entries.push({
      key: n.key,
      count: n.idx.length,
      offset: bytes.length ? await out.write(bytes) : 0,
      length: bytes.length,
    })
  }

  // Parents before children, then by position: the reader's walk order.
  entries.sort((a, b) => a.key[0] - b.key[0] || a.key[3] - b.key[3] || a.key[2] - b.key[2] || a.key[1] - b.key[1])
  let dataBytes = 0,
    points = 0,
    levels = 0
  for (const e of entries) {
    dataBytes += e.length
    points += e.count
    levels = Math.max(levels, e.key[0] + 1)
  }
  for (const r of Object.values(ranges))
    if (r.min > r.max) {
      r.min = 0
      r.max = 1
    }
  const bounds = points ? { min: lo, max: hi } : { min: [...root.min], max: root.min.map((v) => v + root.size) }
  return {
    root,
    layout,
    spacing: root.size / grid,
    hierarchy: encodeHierarchy(entries),
    bounds,
    stats: { ranges, classes },
    nodeCount: entries.length,
    dataBytes,
    points,
    levels,
    ...(outside ? { outside } : {}),
  }
}
