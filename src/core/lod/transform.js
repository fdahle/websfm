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
import { nodeCube } from './octree.js'

/**
 * Tiles over the cloud's XY extent, each with about `tilePoints` points in its tile +
 * margin (`halo`). The extent is split in halves, the longer side first, until a
 * tile's count fits: counted from the octree's `nodes` (a decoded hierarchy: every
 * node's points spread over its cube's footprint), so a corridor or a cloud with far
 * outliers gets small tiles where its points are and large ones where it has none.
 * Without `nodes` the points are taken as spread evenly over the extent. `align` (> 0)
 * puts every inner edge on a multiple of it (a voxel filter's cell, so no voxel spans
 * two tiles). A tile is never split below max(halo, align, extent / 4096).
 * → [{ core: { min: [x, y], max: [x, y] } (open outer edges: ±Infinity), box, estimate }]
 */
export function planTiles(lod, { tilePoints = 6_000_000, halo = 0, align = 0, nodes = null } = {}) {
  const [x0, y0] = lod.bounds.min, [x1, y1] = lod.bounds.max
  const w = Math.max(x1 - x0, 1e-9), h = Math.max(y1 - y0, 1e-9)
  const minSide = Math.max(halo, align, Math.max(w, h) / 4096)
  // Footprints: [minX, minY, size, count] per non-empty node (or the extent itself).
  const feet = []
  if (nodes) {
    for (const n of nodes.values()) {
      if (!n.count) continue
      const c = nodeCube(lod.root, n.key)
      feet.push([c.min[0], c.min[1], c.size, c.size, n.count])
    }
  } else feet.push([x0, y0, w, h, lod.points])
  // Points of the footprints `idx` inside [ax, bx] × [ay, by], in proportion to overlap.
  const count = (idx, ax, ay, bx, by) => {
    let sum = 0
    const hit = []
    for (const i of idx) {
      const [fx, fy, fw, fh, n] = feet[i]
      const ox = Math.min(bx, fx + fw) - Math.max(ax, fx), oy = Math.min(by, fy + fh) - Math.max(ay, fy)
      if (ox < 0 || oy < 0) continue
      hit.push(i)
      sum += n * (fw > 0 ? Math.min(1, ox / fw) : 1) * (fh > 0 ? Math.min(1, oy / fh) : 1)
    }
    return { sum, hit }
  }
  // Where a side may be cut: its middle, on a multiple of `align`; null if a half
  // would be narrower than minSide.
  const cut = (a, b) => {
    let m = (a + b) / 2
    if (align > 0) m = Math.round(m / align) * align
    return m - a >= minSide && b - m >= minSide ? m : null
  }
  const tiles = []
  const stack = [{ min: [x0, y0], max: [x1, y1], idx: feet.map((_, i) => i) }]
  while (stack.length) {
    const r = stack.pop()
    const { sum, hit } = count(r.idx, r.min[0] - halo, r.min[1] - halo, r.max[0] + halo, r.max[1] + halo)
    let split = null
    if (sum > tilePoints) {
      const order = r.max[0] - r.min[0] >= r.max[1] - r.min[1] ? [0, 1] : [1, 0]
      for (const a of order) {
        const m = cut(r.min[a], r.max[a])
        if (m != null) { split = [a, m]; break }
      }
    }
    if (split) {
      const [a, m] = split
      const lo = { min: [...r.min], max: [...r.max], idx: hit }, hi = { min: [...r.min], max: [...r.max], idx: hit }
      lo.max[a] = m; hi.min[a] = m
      stack.push(hi, lo)
      continue
    }
    // Outer edges stay open: a point just past the extent still has one tile.
    const outerLo = [r.min[0] <= x0, r.min[1] <= y0], outerHi = [r.max[0] >= x1, r.max[1] >= y1]
    tiles.push({
      core: {
        min: [outerLo[0] ? -Infinity : r.min[0], outerLo[1] ? -Infinity : r.min[1]],
        max: [outerHi[0] ? Infinity : r.max[0], outerHi[1] ? Infinity : r.max[1]],
      },
      box: {
        min: [outerLo[0] ? null : r.min[0] - halo, outerLo[1] ? null : r.min[1] - halo, null],
        max: [outerHi[0] ? null : r.max[0] + halo, outerHi[1] ? null : r.max[1] + halo, null],
      },
      estimate: Math.round(sum),
    })
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
    const b = lod.bounds
    const box3 = { minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }
    // The mean point spacing of a 2.5D cloud, for the filters' margin.
    const spacing = Math.sqrt((b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) / Math.max(1, lod.points))
    const methods = mode === 'filter' ? settings.methods ?? [] : []
    // What each filter sees around a point, from the WHOLE cloud, so every tile filters
    // alike and a point's result does not depend on where the tile edges fall:
    //   voxel     its cell (the tiles' inner edges sit on its grid);
    //   isolated  the cell's neighbours, up to 2 cells off (an automatic cell is the
    //             whole cloud's 4× spacing, not each tile's own);
    //   outlier   neighbours within `reach` (4× the whole cloud's spacing, as a
    //             resident run's own bounds give it).
    // The margin holds them all one after another (a filter's input near the margin's
    // edge is what the one before it left).
    const voxel = methods.includes('voxel') ? settings.voxel?.cell ?? 0 : 0
    const isoCell = methods.includes('isolated')
      ? (settings.isolated?.cell > 0 ? settings.isolated.cell : Math.max(4 * estimateSpacing(box3, lod.points), 1e-9)) : 0
    const reach = methods.includes('sor') ? 4 * estimateSpacing(box3, lod.points) : 0
    const halo = mode === 'classify-ground'
      ? Math.max(30, 40 * (settings.clothResolution ?? 1)) / (settings.metresPerUnit ?? 1)
      : Math.max(20 * spacing, voxel + 3 * isoCell + Math.max(reach, 3 * (settings.sor?.cell ?? 0)))
    let run = isoCell ? { ...settings, isolated: { ...settings.isolated, cell: isoCell } } : settings
    const label = mode === 'filter' ? 'Filter' : 'Ground filter'
    const tiles = planTiles(lod, { tilePoints: settings.tilePoints ?? 6_000_000, halo, align: voxel, nodes: reader.nodes })
    log(`${label}: ${tiles.length} tile(s) with a ${halo.toPrecision(3)}-unit margin`)
    const quiet = () => {}
    // A tile is read whole: every level of the octree. One too dense to split further
    // would come back thinned (the read stops at a coarser level to stay within one
    // buffer), and so would the edit's output, silently. Refuse instead.
    const readTile = async (tile) => {
      const plan = planExtract(reader.nodes, lod, { box: tile.box })
      if (!plan.complete) {
        throw new Error(`${label}: one tile holds about ${(plan.estimate / 1e6).toFixed(0)} M points at its finest level read `
          + `(of ${(tile.estimate / 1e6).toFixed(0)} M estimated), more than one read can hold; the cloud is too dense in one place `
          + 'to edit tile by tile — crop that part out first')
      }
      return withClass(await extractPoints(reader, plan, lod, { box: tile.box }))
    }
    // The outlier filter compares each point with the WHOLE cloud's statistics: a
    // first pass gathers them over every tile's own points (with the filters before it
    // applied), and the reach comes from the whole cloud, so the tiles filter alike.
    if (methods.includes('sor')) {
      const before = { ...run, methods: methods.slice(0, methods.indexOf('sor')) }
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
      run = { ...run, sor: { ...settings.sor, reach, limit } }
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
      step(1, methods.includes('sor') ? 2 * tiles.length : tiles.length, mode === 'filter' ? 'Filtering tiles' : 'Classifying tiles')
    }
    if (mode === 'classify-ground') log(`Ground filter: ${ground.toLocaleString()} ground points`)
  }

  return {
    count: lod.points, bounds: lod.bounds, colour: lod.layout.colour, attributes: attrs,
    batches: () => rebatch(mode === 'filter' || mode === 'classify-ground' ? tiled() : pointwise()),
  }
}
