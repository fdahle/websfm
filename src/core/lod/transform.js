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
import { filterCloud, sorNeighbourMeans, estimateSpacing, outlierLimit } from '../products/cloudEdit.js'
import { classifyCloudGround } from '../products/groundFilter.js'
import { transformCloud, applyTransform } from '../products/cloudAlign.js'
import { planExtract, extractPoints } from './extract.js'
import { nodeCube } from './octree.js'
import { arrayOfType } from './nodeCodec.js'
import { clothNote, countClasses, classCountsLine } from './clothNote.js'
import { pluralize } from '../textFormat.js'

// The box around a moved box: its eight corners, transformed.
export function transformedBounds(bounds, tf) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity]
  for (let c = 0; c < 8; c++) {
    const p = applyTransform(
      tf,
      [0, 1, 2].map((k) => ((c >> k) & 1 ? bounds.max[k] : bounds.min[k])),
    )
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k]
      if (p[k] > max[k]) max[k] = p[k]
    }
  }
  return { min, max }
}

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
  const [x0, y0] = lod.bounds.min,
    [x1, y1] = lod.bounds.max
  const w = Math.max(x1 - x0, 1e-9),
    h = Math.max(y1 - y0, 1e-9)
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
      const ox = Math.min(bx, fx + fw) - Math.max(ax, fx),
        oy = Math.min(by, fy + fh) - Math.max(ay, fy)
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
        if (m != null) {
          split = [a, m]
          break
        }
      }
    }
    if (split) {
      const [a, m] = split
      const lo = { min: [...r.min], max: [...r.max], idx: hit },
        hi = { min: [...r.min], max: [...r.max], idx: hit }
      lo.max[a] = m
      hi.min[a] = m
      stack.push(hi, lo)
      continue
    }
    // Outer edges stay open: a point just past the extent still has one tile.
    const outerLo = [r.min[0] <= x0, r.min[1] <= y0],
      outerHi = [r.max[0] >= x1, r.max[1] >= y1]
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
export const inCore = (tile, x, y) =>
  x >= tile.core.min[0] && x < tile.core.max[0] && y >= tile.core.min[1] && y < tile.core.max[1]

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
    rel[3 * i] = pts.pos[3 * i] - offset[0]
    rel[3 * i + 1] = pts.pos[3 * i + 1] - offset[1]
    rel[3 * i + 2] = pts.pos[3 * i + 2] - offset[2]
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
  let pending = [],
    count = 0
  const flush = () => {
    const out = concatPoints(pending, count)
    pending = []
    count = 0
    return out
  }
  for await (const p of parts) {
    if (!p.count) continue
    pending.push(p)
    count += p.count
    if (count >= size) yield flush()
  }
  if (count) yield flush()
}

function concatPoints(parts, total) {
  const first = parts[0]
  const pos = new Float64Array(3 * total)
  const col = first.col ? new Uint8Array(3 * total) : null
  const attributes = Object.fromEntries(
    Object.entries(first.attributes ?? {}).map(([k, a]) => [k, new a.constructor(total)]),
  )
  let o = 0
  for (const p of parts) {
    pos.set(p.pos.subarray(0, 3 * p.count), 3 * o)
    if (col && p.col) col.set(p.col.subarray(0, 3 * p.count), 3 * o)
    for (const [k, a] of Object.entries(attributes))
      if (p.attributes?.[k]) a.set(p.attributes[k].subarray(0, p.count), o)
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
  const pos = new Float64Array(3 * n),
    col = p.col ? new Uint8Array(3 * n) : null
  const attributes = Object.fromEntries(Object.entries(p.attributes ?? {}).map(([k, a]) => [k, new a.constructor(n)]))
  const lists = Object.entries(attributes).map(([name, a]) => [p.attributes[name], a])
  for (let k = 0; k < n; k++) {
    const i = idx[k]
    pos[3 * k] = p.pos[3 * i]
    pos[3 * k + 1] = p.pos[3 * i + 1]
    pos[3 * k + 2] = p.pos[3 * i + 2]
    if (col) {
      col[3 * k] = p.col[3 * i]
      col[3 * k + 1] = p.col[3 * i + 1]
      col[3 * k + 2] = p.col[3 * i + 2]
    }
    for (const [src, dst] of lists) dst[k] = src[i]
  }
  return { count: n, pos, col, attributes }
}

// The attributes an edit writes: the source's, plus a classification when it classifies
// a cloud that had none.
function editAttributes(lod, mode) {
  const attrs = lod.layout.attributes.map((a) => ({ ...a }))
  const addClass =
    (mode === 'classify' || mode === 'classify-ground') && !attrs.some((a) => a.name === 'classification')
  if (addClass) attrs.push({ name: 'classification', type: 'uint8' })
  return { attrs, addClass }
}

/**
 * A neighbourhood edit ('filter': filterCloud's settings; 'classify-ground':
 * classifyCloudGround's, in metres) planned tile by tile: the tiles, their margin and
 * the settings every tile runs with. Plain data, so the tiles can go to the worker pool
 * one at a time (editTile) and their outputs on to the octree build
 * (tileOutputsSource). `tilePoints`: points per tile with its margin.
 * → { mode, label, tiles, halo, run, sor: { k, reach, stdRatio, last } | null, addClass }
 */
export function planTiledEdit(lod, nodes, mode, settings = {}, { tilePoints = settings.tilePoints ?? 6_000_000 } = {}) {
  const b = lod.bounds
  const box3 = { minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }
  // The mean point spacing of a 2.5D cloud, for the filters' margin.
  const spacing = Math.sqrt(((b.max[0] - b.min[0]) * (b.max[1] - b.min[1])) / Math.max(1, lod.points))
  const methods = mode === 'filter' ? (settings.methods ?? []) : []
  // What each filter sees around a point, from the WHOLE cloud, so every tile filters
  // alike and a point's result does not depend on where the tile edges fall:
  //   voxel     its cell (the tiles' inner edges sit on its grid);
  //   isolated  the cell's neighbours, up to 2 cells off (an automatic cell is the
  //             whole cloud's 4× spacing, not each tile's own);
  //   outlier   neighbours within `reach` (4× the whole cloud's spacing, as a
  //             resident run's own bounds give it).
  // The margin holds them all one after another (a filter's input near the margin's
  // edge is what the one before it left).
  const voxel = methods.includes('voxel') ? (settings.voxel?.cell ?? 0) : 0
  const isoCell = methods.includes('isolated')
    ? settings.isolated?.cell > 0
      ? settings.isolated.cell
      : Math.max(4 * estimateSpacing(box3, lod.points), 1e-9)
    : 0
  const reach = methods.includes('sor') ? 4 * estimateSpacing(box3, lod.points) : 0
  const halo =
    mode === 'classify-ground'
      ? Math.max(30, 40 * (settings.clothResolution ?? 1)) / (settings.metresPerUnit ?? 1)
      : Math.max(20 * spacing, voxel + 3 * isoCell + reach)
  const run = isoCell ? { ...settings, isolated: { ...settings.isolated, cell: isoCell } } : settings
  const tiles = planTiles(lod, { tilePoints, halo, align: voxel, nodes })
  return {
    mode,
    label: mode === 'filter' ? 'Filter' : 'Ground filter',
    tiles,
    halo,
    run,
    sor: methods.includes('sor')
      ? { k: settings.sor?.k ?? 12, stdRatio: settings.sor?.stdRatio ?? 1.5, reach, last: methods.at(-1) === 'sor' }
      : null,
    addClass: editAttributes(lod, mode).addClass,
  }
}

/**
 * A tile of a planned edit read whole, with its margin: every level of the octree. One
 * too dense to split further would come back thinned (the read stops at a coarser
 * level to stay within one buffer), and so would the edit's output, silently: refused.
 */
export async function readTile(reader, lod, plan, tile) {
  const ex = planExtract(reader.nodes, lod, { box: tile.box })
  if (!ex.complete) {
    throw new Error(
      `${plan.label}: one tile holds about ${(ex.estimate / 1e6).toFixed(0)} M points at its finest level read ` +
        `(of ${(tile.estimate / 1e6).toFixed(0)} M estimated), more than one read can hold; the cloud is too dense in one place ` +
        'to edit tile by tile — crop that part out first',
    )
  }
  const pts = await extractPoints(reader, ex, lod, { box: tile.box })
  return plan.addClass ? { ...pts, attributes: { ...pts.attributes, classification: new Uint8Array(pts.count) } } : pts
}

const quiet = () => {}

const ownPoints = (tile, p) => (i) => inCore(tile, p.pos[3 * i], p.pos[3 * i + 1])

/**
 * One tile of a planned edit, from its points read with the margin (readTile): its OWN
 * points after the edit. The outlier filter compares each point with the WHOLE
 * cloud's statistics, so with it the tile stops short of the cut: the filters before
 * it have run, and every point carries its neighbour mean and loneliness (`mean`,
 * `lonely`; `stats` { cnt, s1, s2 } is the tile's share of the statistics), for
 * outlierCut once every tile is done. Needs the outlier filter last in the chain.
 * → { points, mean?, lonely?, stats?, ground?, cloth? (the ground filter's cloth resolution,
 *   in the cloud's units) }
 */
export function editTile(cloud, plan, tile) {
  if (plan.mode === 'classify-ground') {
    const r = cloud.count ? classifyCloudGround(cloud, null, { ...plan.run, extent: 'all', onLog: quiet }) : null
    const out = r ? { ...cloud, attributes: { ...cloud.attributes, classification: r.classes } } : cloud
    const points = subsetPoints(out, ownPoints(tile, out))
    const counts = countClasses(points.attributes.classification)
    // The cloth's resolution in this tile (coarser than asked past the particle cap).
    return { points, ground: counts.ground, counts, cloth: r?.cloth?.res ?? null }
  }
  if (!plan.sor) {
    const out = cloud.count ? filterCloud(cloud, plan.run, quiet) : cloud
    return { points: subsetPoints({ ...out, attributes: out.attributes ?? {} }, ownPoints(tile, out)) }
  }
  if (!plan.sor.last) throw new Error('editTile: the outlier filter must be the last of the chain')
  const methods = plan.run.methods.slice(0, -1)
  const pre = methods.length && cloud.count ? filterCloud(cloud, { ...plan.run, methods }, quiet) : cloud
  const pts = { ...pre, attributes: pre.attributes ?? {} }
  const own = new Uint8Array(pts.count)
  for (let i = 0; i < pts.count; i++) own[i] = inCore(tile, pts.pos[3 * i], pts.pos[3 * i + 1]) ? 1 : 0
  const { mean: m, lonely: l } =
    pts.count >= 3
      ? sorNeighbourMeans(pts, { k: plan.sor.k, reach: plan.sor.reach })
      : { mean: new Float64Array(pts.count), lonely: new Uint8Array(pts.count).fill(1) }
  const points = subsetPoints(pts, own)
  const mean = new Float64Array(points.count),
    lonely = new Uint8Array(points.count)
  const stats = { cnt: 0, s1: 0, s2: 0 }
  for (let i = 0, o = 0; i < pts.count; i++) {
    if (!own[i]) continue
    mean[o] = m[i]
    lonely[o] = l[i]
    if (!l[i]) {
      stats.cnt++
      stats.s1 += m[i]
      stats.s2 += m[i] * m[i]
    }
    o++
  }
  return { points, mean, lonely, stats }
}

/** A tile's points that pass the outlier cut. */
export const outlierCut = (t, limit) => subsetPoints(t.points, (i) => !t.lonely[i] && t.mean[i] <= limit)

// A tile's output as bytes, for a temporary file between the worker that edited it
// and the octree build: a header (count, flags), then 8-byte aligned sections.
const align8 = (n) => (n + 7) & ~7
export function packTile(t, attrs) {
  const n = t.points.count
  const withSor = !!t.mean
  const parts = [t.points.pos.subarray(0, 3 * n)]
  if (withSor) parts.push(t.mean, t.lonely)
  for (const a of attrs) parts.push(t.points.attributes[a.name] ?? new (arrayOfType(a.type))(n))
  if (t.points.col) parts.push(t.points.col.subarray(0, 3 * n))
  let size = 8
  for (const p of parts) size += align8(p.byteLength)
  const out = new Uint8Array(size)
  new Uint32Array(out.buffer, 0, 2).set([n, (t.points.col ? 1 : 0) | (withSor ? 2 : 0)])
  let o = 8
  for (const p of parts) {
    out.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), o)
    o += align8(p.byteLength)
  }
  return out
}

export function unpackTile(u8, attrs) {
  const buf = u8.byteOffset % 8 ? u8.slice() : u8
  const [n, flags] = new Uint32Array(buf.buffer, buf.byteOffset, 2)
  let o = buf.byteOffset + 8
  const take = (T, len) => {
    const a = new T(buf.buffer, o, len)
    o += align8(a.byteLength)
    return a
  }
  const pos = take(Float64Array, 3 * n)
  const mean = flags & 2 ? take(Float64Array, n) : null
  const lonely = flags & 2 ? take(Uint8Array, n) : null
  const attributes = Object.fromEntries(attrs.map((a) => [a.name, take(arrayOfType(a.type), n)]))
  const col = flags & 1 ? take(Uint8Array, 3 * n) : null
  return { points: { count: n, pos, col, attributes }, mean, lonely }
}

/**
 * The outputs of a planned edit's tiles (packTile bytes, read in tile order by
 * `readTile(i)`) as a build source (core/lod/build.js), cut at the outlier limit when
 * the plan has the outlier filter.
 */
export function tileOutputsSource(lod, plan, readTileOutput, { limit = null, progress = null } = {}) {
  const { attrs } = editAttributes(lod, plan.mode)
  async function* parts() {
    for (let i = 0; i < plan.tiles.length; i++) {
      const t = unpackTile(await readTileOutput(i), attrs)
      yield t.mean ? outlierCut(t, limit) : t.points
      progress?.(i + 1, plan.tiles.length, 'Reading the edited tiles')
    }
  }
  return {
    count: lod.points,
    bounds: lod.bounds,
    colour: lod.layout.colour,
    attributes: attrs,
    batches: () => rebatch(parts()),
  }
}

/**
 * The edited points of a streamed cloud as a build source (core/lod/build.js):
 * mode 'crop' (settings { min, max }: keeps what lies outside), 'mask' ({ selection,
 * keepSelected }), 'classify' ({ selection, classValue }), 'transform' ({ matrix } or
 * { transform }: any form cloudAlign.js accepts), 'filter' (filterCloud's settings) or
 * 'classify-ground' (classifyCloudGround's, in metres).
 */
export function streamedEditSource(reader, lod, mode, settings = {}, { log = () => {}, progress = null } = {}) {
  const { attrs, addClass } = editAttributes(lod, mode)
  const withClass = (p) =>
    addClass ? { ...p, attributes: { ...p.attributes, classification: new Uint8Array(p.count) } } : p
  let done = 0
  const step = (n, total, label) => {
    done += n
    progress?.(done, total, label)
  }

  const tf = mode === 'transform' ? (settings.matrix ?? settings.transform) : null
  async function* pointwise() {
    const lo = settings.min ?? [],
      hi = settings.max ?? []
    for (const node of reader.nodes.values()) {
      if (!node.count) continue
      const pts = withClass(await reader.read(node, { as: 'absolute' }))
      if (mode === 'transform') {
        yield { ...pts, pos: transformCloud(pts, tf).pos }
      } else if (mode === 'crop') {
        const inBox = (i) =>
          [0, 1, 2].every(
            (k) => pts.pos[3 * i + k] >= (lo[k] ?? -Infinity) && pts.pos[3 * i + k] <= (hi[k] ?? Infinity),
          )
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

  // Tile after tile in this worker (the store spreads them over the pool instead:
  // planTiledEdit, editTile, tileOutputsSource). The outlier filter's statistics come
  // from a first pass over every tile; the second filters with the whole cloud's limit.
  async function* tiled() {
    const plan = planTiledEdit(lod, reader.nodes, mode, settings)
    const { tiles, label } = plan
    log(`${label}: ${pluralize(tiles.length, 'tile')} with a ${plan.halo.toPrecision(3)}-unit margin`)
    let run = plan.run
    const passes = plan.sor ? 2 : 1
    if (plan.sor) {
      const stats = []
      for (const tile of tiles) {
        const cloud = await readTile(reader, lod, plan, tile)
        const methods = run.methods.slice(0, run.methods.indexOf('sor'))
        const pre = methods.length && cloud.count ? filterCloud(cloud, { ...run, methods }, quiet) : cloud
        if (pre.count >= 3) {
          const { mean, lonely } = sorNeighbourMeans(pre, { k: plan.sor.k, reach: plan.sor.reach })
          const s = { cnt: 0, s1: 0, s2: 0 }
          for (let i = 0; i < pre.count; i++) {
            if (lonely[i] || !inCore(tile, pre.pos[3 * i], pre.pos[3 * i + 1])) continue
            s.cnt++
            s.s1 += mean[i]
            s.s2 += mean[i] * mean[i]
          }
          stats.push(s)
        }
        step(1, 2 * tiles.length, 'Measuring neighbour distances')
      }
      const { mu, sigma, limit } = outlierLimit(stats, plan.sor.stdRatio)
      log(
        `Filter (outlier): mean neighbour distance ${mu.toFixed(4)} ±${sigma.toFixed(4)} over the whole cloud, limit ${limit.toFixed(4)}`,
      )
      run = { ...run, sor: { ...settings.sor, reach: plan.sor.reach, limit } }
    }
    const classCounts = []
    const cloths = []
    for (const tile of tiles) {
      const cloud = await readTile(reader, lod, plan, tile)
      if (mode === 'classify-ground') {
        const r = editTile(cloud, plan, tile)
        classCounts.push(r.counts)
        cloths.push(r.cloth)
        if (r.points.count) yield r.points
      } else {
        const r = editTile(cloud, { ...plan, run, sor: null }, tile)
        if (r.points.count) yield r.points
      }
      step(1, passes * tiles.length, mode === 'filter' ? 'Filtering tiles' : 'Classifying tiles')
    }
    if (mode === 'classify-ground') {
      log(classCountsLine(classCounts))
      const note = clothNote(cloths, settings.clothResolution ?? 1, settings.metresPerUnit ?? 1)
      if (note) log(note, 'warn')
    }
  }

  return {
    count: lod.points,
    bounds: mode === 'transform' ? transformedBounds(lod.bounds, tf) : lod.bounds,
    colour: lod.layout.colour,
    attributes: attrs,
    batches: () => rebatch(mode === 'filter' || mode === 'classify-ground' ? tiled() : pointwise()),
  }
}
