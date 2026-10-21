// Points out of an octree into memory (dev/planning/plan-lod.md ▸ L5): what a tool
// that needs resident points reads from a streamed cloud. Pure over a reader
// (core/lod/reader.js).
//
// The octree's levels are even subsamples (every level halves the spacing), so a
// budget is met by stopping at a level: every node inside the box down to that level,
// which is the whole cloud thinned evenly, never a cut-off part of it. A tool that
// needs no more than a given spacing (a DEM of a given cell size) stops there too.

import { MAX_FLOAT64_XYZ_POINTS } from '../bufferLimit.js'
import { nodeCube } from './octree.js'

const intersects = (cube, box) =>
  [0, 1, 2].every(
    (k) => cube.min[k] <= (box.max[k] ?? Infinity) && cube.min[k] + cube.size >= (box.min[k] ?? -Infinity),
  )

/**
 * Which nodes to read. box { min: [x,y,z], max } (null sides unbounded) in the
 * cloud's coordinates; maxPoints: the budget (the root level is always read);
 * minSpacing: no level finer than this is needed. → { nodes, level, deepest,
 * estimate (points in the chosen nodes, before the box and class filters), spacing,
 * complete (every level read) }
 */
export function planExtract(nodes, lod, { box = null, maxPoints = Infinity, minSpacing = 0 } = {}) {
  // The read lands in one Float64 xyz buffer: never plan past the browser's buffer wall
  // (core/bufferLimit.js), whatever budget the caller derived maxPoints from.
  maxPoints = Math.min(maxPoints, MAX_FLOAT64_XYZ_POINTS)
  const hits = [],
    perLevel = []
  for (const n of nodes.values()) {
    if (box && !intersects(nodeCube(lod.root, n.key), box)) continue
    hits.push(n)
    perLevel[n.key[0]] = (perLevel[n.key[0]] ?? 0) + n.count
  }
  const deepest = perLevel.length - 1
  let level = 0,
    estimate = perLevel[0] ?? 0
  for (let l = 1; l <= deepest; l++) {
    if (lod.spacing / 2 ** (l - 1) <= minSpacing) break // the level above is fine enough
    const next = estimate + (perLevel[l] ?? 0)
    if (next > maxPoints) break
    estimate = next
    level = l
  }
  return {
    nodes: hits.filter((n) => n.key[0] <= level),
    level,
    deepest,
    estimate,
    spacing: lod.spacing / 2 ** level,
    complete: level >= deepest,
  }
}

/**
 * Read the planned nodes into one flat cloud { count, pos: Float64Array, col?,
 * attributes }. `box` filters points (the nodes only bound it); `classes` (a Set of
 * LAS classes) keeps those; `fields: 'xyz'` reads positions only.
 */
export async function extractPoints(
  reader,
  plan,
  lod,
  { box = null, classes = null, fields = 'all', onProgress } = {},
) {
  const lo = [0, 1, 2].map((k) => box?.min?.[k] ?? -Infinity),
    hi = [0, 1, 2].map((k) => box?.max?.[k] ?? Infinity)
  const wantCol = fields !== 'xyz' && lod.layout.colour
  const attrs = fields === 'xyz' ? [] : lod.layout.attributes
  const parts = []
  let total = 0,
    read = 0
  for (const node of plan.nodes) {
    const pts = await reader.read(node, { as: 'absolute' })
    read += node.count
    const cls = classes ? pts.attributes.classification : null
    const keep = new Uint32Array(pts.count)
    let n = 0
    for (let i = 0; i < pts.count; i++) {
      const x = pts.pos[3 * i],
        y = pts.pos[3 * i + 1],
        z = pts.pos[3 * i + 2]
      if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) continue
      if (cls && !classes.has(cls[i])) continue
      keep[n++] = i
    }
    if (n) {
      parts.push({ pts, keep: keep.subarray(0, n) })
      total += n
    }
    onProgress?.(read, plan.estimate)
  }
  const pos = new Float64Array(3 * total)
  const col = wantCol ? new Uint8Array(3 * total) : null
  const T = {
    uint8: Uint8Array,
    int8: Int8Array,
    uint16: Uint16Array,
    int16: Int16Array,
    uint32: Uint32Array,
    int32: Int32Array,
    float32: Float32Array,
    float64: Float64Array,
  }
  const attributes = Object.fromEntries(attrs.map((a) => [a.name, new T[a.type](total)]))
  let o = 0
  for (const { pts, keep } of parts) {
    for (let k = 0; k < keep.length; k++, o++) {
      const i = keep[k]
      pos[3 * o] = pts.pos[3 * i]
      pos[3 * o + 1] = pts.pos[3 * i + 1]
      pos[3 * o + 2] = pts.pos[3 * i + 2]
      if (col) {
        col[3 * o] = pts.col[3 * i]
        col[3 * o + 1] = pts.col[3 * i + 1]
        col[3 * o + 2] = pts.col[3 * i + 2]
      }
      for (const a of attrs) attributes[a.name][o] = pts.attributes[a.name][i]
    }
  }
  return { count: total, pos, ...(col ? { col } : {}), attributes }
}
