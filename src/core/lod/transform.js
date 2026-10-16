// Editing a streamed cloud (dev/planning/plan-lod.md ▸ L5): its points go through the
// edit and on into a new octree, never all in memory. Pure helpers; the worker
// (workers/ops/lod.js) runs them.
//
// - A point-wise edit (a box, a screen selection, a class) runs node by node.
// - A neighbourhood edit (outlier filters, the ground filter) runs tile by tile: each
//   tile is read at full detail with a margin (`halo`) around it, the edit runs on
//   tile + margin, and only the points of the tile itself are kept, so every point
//   comes out once and sees its neighbours across the tile's edge.

import { screenSelectMask } from '../products/screenSelect.js'
import { filterCloud, sorNeighbourMeans, estimateSpacing } from '../products/cloudEdit.js'
import { classifyCloudGround } from '../products/groundFilter.js'
import { planExtract, extractPoints } from './extract.js'

/**
 * Square tiles over the cloud's XY extent, each with about `tilePoints` points in
 * its tile + margin (from the mean density: 2.5D survey data). `align` (> 0) makes
 * the side a multiple of it (a voxel filter's cell, so no voxel spans two tiles).
 * → [{ core: { min: [x, y], max: [x, y] } (open outer edges: ±Infinity), box }]
 */
export function planTiles(lod, { tilePoints = 6_000_000, halo = 0, align = 0 } = {}) {
  const [x0, y0] = lod.bounds.min, [x1, y1] = lod.bounds.max
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9)
  const density = lod.points / (w * h)
  let side = Math.sqrt(tilePoints / Math.max(density, 1e-12)) - 2 * halo
  side = Math.max(side, halo, Math.max(w, h) / 4096)
  if (align > 0) side = Math.max(align, Math.floor(side / align) * align)
  const nx = Math.max(1, Math.ceil(w / side)), ny = Math.max(1, Math.ceil(h / side))
  // Aligned tiles start on a multiple of `align` from the origin, as the voxel grid does.
  const ox = align > 0 ? Math.floor(x0 / align) * align : x0, oy = align > 0 ? Math.floor(y0 / align) * align : y0
  const tiles = []
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const min = [i === 0 ? -Infinity : ox + i * side, j === 0 ? -Infinity : oy + j * side]
    const max = [i === nx - 1 ? Infinity : ox + (i + 1) * side, j === ny - 1 ? Infinity : oy + (j + 1) * side]
    const lo = [ox + i * side - halo, oy + j * side - halo], hi = [ox + (i + 1) * side + halo, oy + (j + 1) * side + halo]
    tiles.push({ core: { min, max }, box: { min: [i === 0 ? null : lo[0], j === 0 ? null : lo[1], null], max: [i === nx - 1 ? null : hi[0], j === ny - 1 ? null : hi[1], null] } })
  }
  return tiles
}

/** Whether (x, y) is in the tile itself (half-open, so a shared edge belongs to one tile). */
export const inCore = (tile, x, y) => x >= tile.core.min[0] && x < tile.core.max[0] && y >= tile.core.min[1] && y < tile.core.max[1]

/**
 * A recorded screen selection replayed on points in the cloud's coordinates:
 * `ops` [{ shape, matrix (clip from offset-relative), op: 'replace'|'add'|'subtract',
 * hidden?: [class] }] in the order they were drawn. A point of a class hidden when a
 * shape was drawn could not be seen, so that shape leaves it as it was.
 * → Uint8Array (1 = selected)
 */
export function replaySelection(pts, ops, offset) {
  const n = pts.count
  const rel = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) {
    rel[3 * i] = pts.pos[3 * i] - offset[0]; rel[3 * i + 1] = pts.pos[3 * i + 1] - offset[1]; rel[3 * i + 2] = pts.pos[3 * i + 2] - offset[2]
  }
  let mask = new Uint8Array(n)
  const cls = pts.attributes?.classification
  for (const o of ops) {
    const hidden = o.hidden?.length && cls ? new Set(o.hidden) : null
    let indices = null
    if (hidden) {
      const shown = new Uint32Array(n)
      let k = 0
      for (let i = 0; i < n; i++) if (!hidden.has(cls[i])) shown[k++] = i
      indices = shown.subarray(0, k)
    }
    mask = screenSelectMask(rel, n, { matrix: o.matrix, shape: o.shape, indices, base: mask, op: o.op }).mask
  }
  return mask
}

/** Batches of about `size` points from an async iterator of point sets. */
export async function* rebatch(parts, size = 1 << 20) {
  let pending = [], count = 0
  const flush = () => {
    const out = concatPoints(pending, count)
    pending = []; count = 0
    return out
  }
  for await (const p of parts) {
    if (!p.count) continue
    pending.push(p); count += p.count
    if (count >= size) yield flush()
  }
  if (count) yield flush()
}

function concatPoints(parts, total) {
  const first = parts[0]
  const pos = new Float64Array(3 * total)
  const col = first.col ? new Uint8Array(3 * total) : null
  const attributes = Object.fromEntries(Object.entries(first.attributes ?? {}).map(([k, a]) => [k, new a.constructor(total)]))
  let o = 0
  for (const p of parts) {
    pos.set(p.pos.subarray(0, 3 * p.count), 3 * o)
    if (col && p.col) col.set(p.col.subarray(0, 3 * p.count), 3 * o)
    for (const [k, a] of Object.entries(attributes)) if (p.attributes?.[k]) a.set(p.attributes[k].subarray(0, p.count), o)
    o += p.count
  }
  return { count: total, pos, col, attributes }
}

/** The points `keep` (a mask, or a predicate of the index) of a point set. */
export function subsetPoints(p, keep) {
  const test = typeof keep === 'function' ? keep : (i) => keep[i] === 1
  const idx = new Uint32Array(p.count)
  let n = 0
  for (let i = 0; i < p.count; i++) if (test(i)) idx[n++] = i
  const pos = new Float64Array(3 * n), col = p.col ? new Uint8Array(3 * n) : null
  const attributes = Object.fromEntries(Object.entries(p.attributes ?? {}).map(([k, a]) => [k, new a.constructor(n)]))
  const lists = Object.entries(attributes).map(([name, a]) => [p.attributes[name], a])
  for (let k = 0; k < n; k++) {
    const i = idx[k]
    pos[3 * k] = p.pos[3 * i]; pos[3 * k + 1] = p.pos[3 * i + 1]; pos[3 * k + 2] = p.pos[3 * i + 2]
    if (col) { col[3 * k] = p.col[3 * i]; col[3 * k + 1] = p.col[3 * i + 1]; col[3 * k + 2] = p.col[3 * i + 2] }
    for (const [src, dst] of lists) dst[k] = src[i]
  }
  return { count: n, pos, col, attributes }
}

/**
 * The edited points of a streamed cloud as a build source (core/lod/build.js):
 * mode 'crop' (settings { min, max }: keeps what lies outside), 'mask' ({ selection,
 * keepSelected }), 'classify' ({ selection, classValue }), 'filter' (filterCloud's
 * settings) or 'classify-ground' (classifyCloudGround's, in metres).
 */
export function streamedEditSource(reader, lod, mode, settings = {}, { log = () => {}, progress = null } = {}) {
  const attrs = lod.layout.attributes.map((a) => ({ ...a }))
  const addClass = (mode === 'classify' || mode === 'classify-ground') && !attrs.some((a) => a.name === 'classification')
  if (addClass) attrs.push({ name: 'classification', type: 'uint8' })
  const withClass = (p) => (addClass ? { ...p, attributes: { ...p.attributes, classification: new Uint8Array(p.count) } } : p)
  let done = 0
  const step = (n, total, label) => { done += n; progress?.(done, total, label) }

  async function* pointwise() {
    const lo = settings.min ?? [], hi = settings.max ?? []
    for (const node of reader.nodes.values()) {
      if (!node.count) continue
      const pts = withClass(await reader.read(node, { as: 'absolute' }))
      if (mode === 'crop') {
        const inBox = (i) => [0, 1, 2].every((k) => pts.pos[3 * i + k] >= (lo[k] ?? -Infinity) && pts.pos[3 * i + k] <= (hi[k] ?? Infinity))
        yield subsetPoints(pts, (i) => !inBox(i))
      } else {
        const mask = replaySelection(pts, settings.selection, lod.layout.offset)
        if (mode === 'mask') yield subsetPoints(pts, (i) => (settings.keepSelected ? mask[i] === 1 : mask[i] === 0))
        else {
          const cls = pts.attributes.classification
          for (let i = 0; i < pts.count; i++) if (mask[i]) cls[i] = settings.classValue
          yield pts
        }
      }
      step(node.count, lod.points, 'Editing points')
    }
  }

  async function* tiled() {
    // The mean point spacing of a 2.5D cloud, for the filters' margin.
    const spacing = Math.sqrt((lod.bounds.max[0] - lod.bounds.min[0]) * (lod.bounds.max[1] - lod.bounds.min[1]) / Math.max(1, lod.points))
    const voxel = mode === 'filter' && settings.methods?.includes('voxel') ? settings.voxel?.cell ?? 0 : 0
    const halo = mode === 'classify-ground'
      ? Math.max(30, 40 * (settings.clothResolution ?? 1)) / (settings.metresPerUnit ?? 1)
      : Math.max(20 * spacing, 3 * (settings.isolated?.cell ?? 0), 3 * (settings.sor?.cell ?? 0), voxel)
    const tiles = planTiles(lod, { tilePoints: settings.tilePoints ?? 6_000_000, halo, align: voxel })
    log(`${mode === 'filter' ? 'Filter' : 'Ground filter'}: ${tiles.length} tile(s) with a ${halo.toPrecision(3)}-unit margin`)
    const quiet = () => {}
    const readTile = async (tile) => withClass(await extractPoints(reader, planExtract(reader.nodes, lod, { box: tile.box }), lod, { box: tile.box }))
    // The outlier filter compares each point with the WHOLE cloud's statistics: a
    // first pass gathers them over every tile's own points (with the filters before it
    // applied), and the reach comes from the whole cloud, so the tiles filter alike.
    let run = settings
    const methods = settings.methods ?? []
    if (mode === 'filter' && methods.includes('sor')) {
      const b = lod.bounds
      const reach = 4 * estimateSpacing({ minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }, lod.points)
      const before = { ...settings, methods: methods.slice(0, methods.indexOf('sor')) }
      let cnt = 0, s1 = 0, s2 = 0
      for (const tile of tiles) {
        const cloud = await readTile(tile)
        const pre = before.methods.length && cloud.count ? filterCloud(cloud, before, quiet) : cloud
        if (pre.count >= 3) {
          const { mean, lonely } = sorNeighbourMeans(pre, { k: settings.sor?.k ?? 12, cell: settings.sor?.cell ?? 0, reach })
          for (let i = 0; i < pre.count; i++) {
            if (lonely[i] || !inCore(tile, pre.pos[3 * i], pre.pos[3 * i + 1])) continue
            cnt++; s1 += mean[i]; s2 += mean[i] * mean[i]
          }
        }
        step(1, 2 * tiles.length, 'Measuring neighbour distances')
      }
      const mu = cnt ? s1 / cnt : 0, sigma = cnt ? Math.sqrt(Math.max(s2 / cnt - mu * mu, 0)) : 0
      const limit = mu + (settings.sor?.stdRatio ?? 1.5) * sigma
      log(`Filter (outlier): mean neighbour distance ${mu.toFixed(4)} ±${sigma.toFixed(4)} over the whole cloud, limit ${limit.toFixed(4)}`)
      run = { ...settings, sor: { ...settings.sor, reach, limit } }
    }
    let ground = 0
    for (const tile of tiles) {
      const cloud = await readTile(tile)
      if (cloud.count) {
        let out
        if (mode === 'filter') out = filterCloud(cloud, run, quiet)
        else {
          const r = classifyCloudGround(cloud, null, { ...settings, extent: 'all', onLog: quiet })
          out = { ...cloud, attributes: { ...cloud.attributes, classification: r ? r.classes : cloud.attributes.classification } }
        }
        const kept = subsetPoints({ ...out, attributes: out.attributes ?? {} }, (i) => inCore(tile, out.pos[3 * i], out.pos[3 * i + 1]))
        if (mode === 'classify-ground') for (const c of kept.attributes.classification) if (c === 2) ground++
        yield kept
      }
      step(1, run !== settings ? 2 * tiles.length : tiles.length, mode === 'filter' ? 'Filtering tiles' : 'Classifying tiles')
    }
    if (mode === 'classify-ground') log(`Ground filter: ${ground.toLocaleString()} ground points`)
  }

  return {
    count: lod.points, bounds: lod.bounds, colour: lod.layout.colour, attributes: attrs,
    batches: () => rebatch(mode === 'filter' || mode === 'classify-ground' ? tiled() : pointwise()),
  }
}
