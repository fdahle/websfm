// Orthophoto by true image reprojection — pure, no Vue/Pinia/OPFS/DOM.
//
// Given a DEM (a height per ground cell) we know each cell's full 3D position, so
// an orthophoto is: for every DEM cell, take its ground point, look at which
// source images actually SEE it (not occluded), and sample their colour. This is
// real orthorectification (relief displacement removed via the DEM), unlike a
// simple nadir paste.
//
// The clever reuse: the dense pipeline already produced, per image, a depth map
// (working-res depth + cost + RGB planes; see core/dense/mvs.js / the depthMaps cache).
// Those depth planes ARE per-image z-buffers, so occlusion is a cheap lookup —
// no re-rendering. A cell is visible in image m iff it reprojects to a pixel
// whose stored depth equals the cell's own depth-from-camera (within tolerance);
// a nearer stored depth means something occludes it.
//
// Each map: { uuid, width, height, K:{fx,fy,cx,cy}, R, t,
//             depth:Float32Array, cost:Float32Array, rgb:Uint8Array(w*h*3) }.
// Conventions match geometry.js (x_cam = R·x_world + t; K working-res).
//
// Beside this file: orthoColour.js colours a window from one map (the run defaults and
// the grid's projection quantities too), orthoBlocks.js sizes the tiled run's blocks and
// its memory and lays them out (heights, windows, buffers), orthoVisits.js keeps the maps
// and photos the tiled run's visits read; orthoWindow.js, orthoMosaic.js and orthoPlan.js
// as before.
import { srgbToLinear, linearToSrgb } from './colourGains.js'
import { sampleSurfaceWindow } from './surface.js'
import { createOrthoStats } from '../eval/orthoStats.js'
import { multibandReach, multibandBegin, multibandAdd, multibandFinish } from './multiband.js'
import { NO_LABEL, forTilesReaching, newLabels, projectInto, winCellToSfm, winTiles } from './orthoWindow.js'
import {
  MOSAIC_SMOOTH_PASSES,
  blendFromMap,
  chamferTo,
  finishMosaicWindow,
  labelFromMap,
  mapSight,
  mosaicMode,
  mosaicSeamCells,
  mosaicSurvey,
  orthoHalo,
  sampleColour,
  smoothLabels,
} from './orthoMosaic.js'
import { blockGroups, chooseGroupSize, ownersFromCut, unionMaps, visitSequence } from './orthoPlan.js'
import { fillArray } from '../bigArray.js'
import { ORTHO_BLOCK, surveyHeights, blockWindows, windowStates } from './orthoBlocks.js'
import { createVisits } from './orthoVisits.js'
import { RUN_DEFAULTS, colourFromMap, countColoured, finishWindow, gridProjection } from './orthoColour.js'

// The highest matching cost left in the depth maps, given the settings of the run that
// built them (the Stage A summary's `settings`). The cross-view filter's Minimum NCC
// floor zeroes the depth wherever cost > 1 − minNcc (dense/geomFilter.js filterConfig),
// and a pixel without depth never sees a cell, so an ortho `maxCost` at or above this
// ceiling removes nothing. null when the run skipped the filter or is not known.
export function orthoCostCeiling(depthSettings) {
  if (!depthSettings?.geomConsistency || !Number.isFinite(depthSettings.minNcc)) return null
  return 1 - depthSettings.minNcc
}

// Sample the colour for one ground point P (SfM world coords) by reprojecting it
// into every map, testing occlusion against each map's depth plane, and combining
// the visible views.
//   opts: { depthTolRel, blend ('best' | 'average'; 'mosaic' picks as 'best'), maxCost },
//   each defaulting to ORTHO_DEFAULTS in run units (RUN_DEFAULTS)
// Returns [r,g,b] (0..255) or null when no view sees the point.
export function sampleOrtho(P, maps, opts = {}) {
  return pickOrthoView(P, maps, opts)?.rgb ?? null
}

// sampleOrtho plus the index of the map that supplied the colour (`mi`, the label;
// -1 for 'average', which mixes every visible view).
function pickOrthoView(P, maps, opts) {
  const { depthTolRel = RUN_DEFAULTS.depthTolRel, blend = RUN_DEFAULTS.blend, maxCost = RUN_DEFAULTS.maxCost } = opts
  let best = null // { score, rgb, mi }
  let wsum = 0,
    r = 0,
    g = 0,
    b = 0 // for 'average'

  for (let mi = 0; mi < maps.length; mi++) {
    const m = maps[mi]
    const p = projectInto(m, P)
    if (!p) continue
    const u = Math.round(p.u),
      v = Math.round(p.v)
    if (u < 0 || v < 0 || u >= m.width || v >= m.height) continue
    const idx = v * m.width + u
    const stored = m.depth[idx]
    if (!(stored > 0)) continue // no surface here
    // Occlusion: the cell's distance to this camera must match the map's own
    // surface distance. A stored depth closer than p.depth ⇒ something in front.
    if (Math.abs(stored - p.depth) > depthTolRel * p.depth) continue
    const cost = m.cost ? m.cost[idx] : 0
    if (cost > maxCost) continue

    const o = idx * 3
    const rgb = [m.rgb[o], m.rgb[o + 1], m.rgb[o + 2]]
    // Quality: lower matching cost is better; nearer view (smaller depth) breaks
    // ties (finer ground resolution). Combine into a single "smaller = better".
    const score = cost + 1e-6 * p.depth

    if (blend === 'average') {
      const w = 1 / (cost + 1e-3)
      wsum += w
      r += w * rgb[0]
      g += w * rgb[1]
      b += w * rgb[2]
    } else if (!best || score < best.score) {
      best = { score, rgb, mi }
    }
  }

  if (blend === 'average') {
    if (wsum <= 0) return null
    return { rgb: [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)], mi: -1 }
  }
  return best
}

// 'mosaic' (plan-ortho-mosaic O2–O4) exists only in the tiled path: its label map,
// seam feathering and gains need the block halo and the whole-grid gain pass there.
function refuseMosaic(opts) {
  if (opts.blend === 'mosaic') throw new Error("blend 'mosaic' is computed by orthorectifyTiled only")
}

// Fill small transparent holes that lie INSIDE the selected surface. Reads only
// original sampled pixels, so interpolation cannot propagate across a large gap
// one radius at a time or grow beyond the DEM/mesh footprint.
export function fillOrthoGaps(rgba, surfaceMask, width, height, radius, method = 'idw') {
  const r = Math.max(0, Math.floor(radius))
  if (!r || method === 'none') return 0
  const sampled = new Uint8Array(width * height)
  for (let i = 0; i < sampled.length; i++) sampled[i] = rgba[i * 4 + 3] > 0 ? 1 : 0

  let filled = 0
  const r2 = r * r
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const i = row * width + col
      if (!surfaceMask[i] || sampled[i]) continue
      let nearest = -1,
        nearestD2 = Infinity,
        wsum = 0,
        rs = 0,
        gs = 0,
        bs = 0
      for (let dr = -r; dr <= r; dr++) {
        const rr = row + dr
        if (rr < 0 || rr >= height) continue
        for (let dc = -r; dc <= r; dc++) {
          const cc = col + dc
          if (cc < 0 || cc >= width) continue
          const d2 = dr * dr + dc * dc
          if (!d2 || d2 > r2) continue
          const ni = rr * width + cc
          if (!sampled[ni]) continue
          if (d2 < nearestD2) {
            nearestD2 = d2
            nearest = ni
          }
          const w = 1 / d2,
            o = ni * 4
          wsum += w
          rs += w * rgba[o]
          gs += w * rgba[o + 1]
          bs += w * rgba[o + 2]
        }
      }
      if (nearest < 0) continue
      const o = i * 4
      if (method === 'nearest') {
        const no = nearest * 4
        rgba[o] = rgba[no]
        rgba[o + 1] = rgba[no + 1]
        rgba[o + 2] = rgba[no + 2]
      } else {
        rgba[o] = Math.round(rs / wsum)
        rgba[o + 1] = Math.round(gs / wsum)
        rgba[o + 2] = Math.round(bs / wsum)
      }
      rgba[o + 3] = 255
      filled++
    }
  }
  return filled
}

// Orthorectify a whole DEM grid into an RGBA raster aligned to it. `toSfm` maps a
// frame coord [x,y,z] back to SfM world (frame.toSfm); `cellCenter(grid,col,row)`
// gives the ground XY. Cells with no height (mask 0) or no visible view become
// transparent.
//   grid: from dem.rasterizeDem ({ width, height, gsd, originX, originY, data, mask })
// Returns { width, height, rgba:Uint8ClampedArray(w*h*4), covered, labels } where
// `covered` is the number of cells that received a colour and `labels` the source
// map per sampled cell (see NO_LABEL; gap-filled cells stay unlabelled).
export function orthorectify(grid, maps, toSfm, opts = {}, onProgress = () => {}) {
  refuseMosaic(opts)
  const { width, height, gsd, originX, originY, data, mask } = grid
  const rgba = new Uint8ClampedArray(width * height * 4)
  const labels = newLabels(width * height, opts, maps.length)
  let covered = 0
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const idx = row * width + col
      const o = idx * 4
      if (!mask[idx]) continue
      const x = originX + (col + 0.5) * gsd
      const y = originY - (row + 0.5) * gsd
      const P = toSfm([x, y, data[idx]])
      const view = pickOrthoView(P, maps, opts)
      if (!view) continue
      const { rgb } = view
      rgba[o] = rgb[0]
      rgba[o + 1] = rgb[1]
      rgba[o + 2] = rgb[2]
      rgba[o + 3] = 255
      if (labels) labels[idx] = view.mi
      covered++
    }
    if (row % 32 === 0) onProgress(row, height)
  }
  const sampled = covered
  const filled = fillOrthoGaps(rgba, mask, width, height, opts.fillRadius ?? 2, opts.fillMethod ?? 'idw')
  covered += filled
  onProgress(height, height)
  return { width, height, rgba, covered, sampled, filled, labels }
}

// Map-major counterpart: identical selection/weights, one decoded map resident.
//
// `loadImage(mi, map)` (optional) returns the map's SOURCE photo for colour:
// `{ data: RGBA, width, height, map }`, where `map(u, v)` takes a depth-map pixel to
// the photo's raw pixel (core/sfm/displayFrame.js makeSampleMap — the same chain dense
// used to build the map; null = identity). The depth map then only decides visibility,
// and colour is bilinear at the photo's full resolution instead of nearest from the
// map's working-resolution rgb plane (plan-ortho-mosaic O1). Return null for a map
// to fall back to its rgb plane. Without loadImage the output equals orthorectify().
// Its third argument is how many depth-map pixels one ortho cell spans in that map
// (measured at the grid centre; null when the centre does not project), so the loader
// can decode the photo no finer than the ortho can use.
export async function orthorectifyStreamed(
  grid,
  metas,
  loadMap,
  toSfm,
  opts = {},
  onProgress = () => {},
  loadImage = null,
) {
  refuseMosaic(opts)
  const { width, height, data, mask } = grid
  const n = width * height,
    rgba = new Uint8ClampedArray(n * 4)
  const average = opts.blend === 'average'
  // Per-cell state is a real cost at MAX_GRID (16.8 M cells): allocate only what
  // the chosen blend reads — 8 B/cell for 'best', 32 B/cell for 'average'.
  const scores = average ? null : fillArray(new Float64Array(n), Infinity)
  const sums = average ? new Float64Array(n * 4) : null
  const labels = newLabels(n, opts, metas.length)
  let zLo = Infinity,
    zHi = -Infinity,
    zMid = 0
  for (let i = 0, k = 0; i < n; i++) {
    if (!mask[i]) continue
    const z = data[i]
    if (z < zLo) zLo = z
    if (z > zHi) zHi = z
    zMid += (z - zMid) / ++k
  }
  const { affine, mapPxPerCell } = gridProjection(grid, toSfm, zLo, zHi, zMid)
  const win = { x0: 0, y0: 0, w: width, h: height, data, mask, rgba, scores, sums, labels }
  const scratch = { P: [0, 0, 0], px: new Float32Array(4) }
  for (let mi = 0; mi < metas.length; mi++) {
    const m = await loadMap(mi)
    const photo = loadImage ? await loadImage(mi, m, mapPxPerCell(m)) : null
    colourFromMap(win, grid, m, photo, mi, affine, toSfm, opts, scratch)
    onProgress(mi + 1, metas.length)
  }
  const sampled = finishWindow(win, 0, 0, width, height)
  const filled = fillOrthoGaps(rgba, mask, width, height, opts.fillRadius ?? 2, opts.fillMethod ?? 'idw')
  return { width, height, rgba, covered: sampled + filled, sampled, filled, labels }
}

// ── Tiled orthophoto (plan SC-9 / T1) ─────────────────────────────────────────
//
// An ortho at the photos' GSD is 10–25 k px a side, hundreds of millions of cells:
// no whole-grid plane fits. orthorectifyTiled walks the grid in square BLOCKS, each
// run through the same map-major kernel over only the maps that can see it, and hands
// every finished block to the caller (the COG writer) before the next one starts.
// The surface stays the ≤ 4,096 grid it was built at; each block samples its heights
// from it (surface.js sampleSurfaceWindow), so no full-size height plane exists either.
//
// Exactness. On a grid a single pass can hold, the blocks reproduce that pass bit for
// bit — colours, labels, counts and stats (streamedProducts.test.js pins it):
//   - the grid quantities (affine linearisation, mean height for the photo footprint)
//     come from a streamed pre-pass over every cell in row-major order, the order the
//     single pass reads them in;
//   - a block is computed over its core plus a halo of fillRadius + 1 cells, so gap
//     filling (which reads original samples up to fillRadius away) is exact on the
//     core and on the one-cell ring the stats' 3×3 and right/down neighbours read;
//   - the per-block map cull is exact: a map is skipped only when the block's whole
//     3D box projects outside it (a linear-fractional map takes its extremes over a
//     box at the corners), with a 1 px margin for rounding, so a skipped map could
//     colour no cell of the window;
//   - stats sums are integers (orthoStats.js), so block order cannot move them.
//
// Reads. A map visits every block it can see; its planes and its decoded source photo
// are cached across blocks in a byte-bounded cache that evicts by Belady's MIN — the
// whole visit sequence is known after the cull, so it drops the entry wanted furthest
// ahead (the streamed-fusion precedent). Only the policy may change; the visit order
// may not, or 'average' sums would add in another order.
// surface: the height grid ({ width, height, gsd, originX, originY, data, mask });
// geom: the ortho grid over it (surface.js resampledGeometry — any size).
// metas[i]: each map's geometry { width, height, K, R, t } (no planes needed);
// loadMap(i) → the map with planes. toSfm, opts: as orthorectifyStreamed, plus
//   opts.blend 'mosaic' with opts.colourBalance (O3 gains), opts.seamline ('nadir' |
//   'graphcut', O5), opts.seamBlend ('feather' | 'multiband', O4b) and opts.seamWidth
//   (% of the short side, O4a feathering; 0 = hard seams), opts.blockSize (default ORTHO_BLOCK),
//   opts.cacheBytes (map + photo cache budget, default 1 GiB), opts.mapsResident (the
//   maps are already in memory, so only decoded photos count against the cache).
// hooks: { loadImage (as orthorectifyStreamed's), loadStatsImage (the gain pass's
//   photos; default loadImage), onProgress(done, total),
//   onBlocksStart(blockCount) — once, after the mosaic survey, before the first block,
//   onBlock({ col0, row0, width, height, rgba, labels }) — awaited, the core cells of
//   one block in row-major order, fresh arrays the hook may keep }.
// → { width, height, covered, sampled, filled, surfaceCells, labelled, stats, statsState,
//     blocks, visits, mapLoads, photoLoads, cacheHits, mosaic?, gains? }
//
// Split over workers (workers/ops/ortho.js): `opts.planOnly` stops after the survey
// and the grouping and returns { plan: { survey, groupBlocks, groups, predicted,
// shareModel, groupVisits } }; a worker then runs with `opts.survey` (the plan's, instead
// of surveying again), `groupBlocks` (the plan's size), `opts.groupIndices` (its share of
// the groups, in order) and `opts.claims` (shared: a group goes to whichever worker
// claims it first). Every block computes what it computes in one run, so the blocks of
// all the shares are the single run's; their `statsState`s merge (core/eval/orthoStats.js).
export async function orthorectifyTiled(surface, geom, metas, loadMap, toSfm, opts = {}, hooks = {}) {
  const { onProgress = () => {}, onBlock = null, loadImage = null } = hooks
  const { width: W, height: H } = geom
  const B = opts.blockSize ?? ORTHO_BLOCK
  const fillRadius = opts.fillRadius ?? 2,
    fillMethod = opts.fillMethod ?? 'idw'
  const mode = mosaicMode(opts),
    { mosaic, graphcut, multiband, align } = mode
  if (mosaic && metas.length >= NO_LABEL)
    throw new Error(`a mosaic labels cells with a 16-bit image index; ${metas.length} depth maps is too many`)
  const seamCells = mosaic && !multiband ? mosaicSeamCells(W, H, opts.seamWidth ?? 0) : 0
  const halo = orthoHalo({
    width: W,
    height: H,
    blend: opts.blend,
    fillRadius,
    seamWidth: opts.seamWidth ?? 0,
    seamline: opts.seamline,
    seamBlend: opts.seamBlend,
    blendLevels: mode.levels,
  })
  if (!(B >= 1)) throw new Error(`orthorectifyTiled: block size ${B} must be positive`)
  const nbx = Math.ceil(W / B),
    nby = Math.ceil(H / B)

  // Pre-pass (orthoBlocks.js surveyHeights): the heights, and each block core's range.
  const { blockLo, blockHi, zLo, zHi, zMid, surfaceCells } = surveyHeights(surface, geom, B, nbx, nby)
  const gp = gridProjection(geom, toSfm, zLo, zHi, zMid)
  const { affine, mapPxPerCell } = gp

  // Block windows and the maps that can see each (orthoBlocks.js blockWindows).
  const blocks = blockWindows({ geom, B, nbx, nby, halo, align, blockLo, blockHi, gp, metas })

  // O3 + O5: the gains and the graph-cut labels, once for the whole grid, before any
  // block — and before the visits are planned, since the cut says which maps own a part
  // of each block and so need their photos there. The progress total is corrected once
  // the visits are known.
  let ticks = 0
  const survey = mosaic && (opts.colourBalance || graphcut) && !opts.survey
  const passes = !mosaic ? 1 : multiband ? 3 : 2
  let total = (survey ? metas.length : 0) + blocks.reduce((n, b) => n + b.maps.length, 0) * passes
  const tick = () => onProgress(++ticks, total)
  let balance = null,
    seams = null,
    surveyFromMapRgb = 0
  if (opts.survey) ({ balance, seams, fromMapRgb: surveyFromMapRgb } = opts.survey)
  else if (survey) {
    ;({
      balance,
      seams,
      fromMapRgb: surveyFromMapRgb,
    } = await mosaicSurvey(surface, geom, metas, loadMap, hooks.loadStatsImage ?? loadImage, toSfm, gp, opts, tick, {
      gainsOn: !!opts.colourBalance,
      cut: graphcut,
    }))
  }

  // The visit sequence, and for each visit when its map is wanted next (Belady). A
  // mosaic visits a block's maps twice — labels, then colour — and a multiband one a
  // third time for the corrections; the colour passes skip the maps that own no cells
  // there, which only makes the plan pessimistic. Successive passes alternate their
  // order (ascending, descending, ascending), so each starts on the maps the last one
  // left in the cache.
  //
  // Blocks are taken in groups (`opts.groupBlocks`, a rectangle of neighbouring blocks,
  // P6): each pass of a group visits every map its blocks see ONCE, map-major, and each
  // block of the group takes from that visit. With many blocks a photo is then read once
  // per pass per group rather than per block. Within one block every map keeps its
  // per-pass order, so a block computes exactly what it computes alone.
  // `groupBlocks: 'auto'` picks the size (chooseGroupSize) from the cache it leaves:
  // each block of a group holds `opts.blockBytes` of working planes, taken from the cache.
  const owners = seams ? blocks.map((b) => ownersFromCut(seams, b)) : null
  const groupingFor = (cacheBytes) =>
    opts.groupBlocks === 'auto'
      ? chooseGroupSize(nbx, nby, blocks, passes, mosaic, {
          cacheBytes,
          blockBytes: opts.blockBytes ?? 0,
          entryBytes: opts.entryBytes ?? 0,
          mapsResident: !!opts.mapsResident,
          entrySizes: opts.entrySizes ?? null,
          owners,
        })
      : { size: Math.max(1, Math.floor(opts.groupBlocks ?? 1)) }
  // Planning a split (`opts.planShares`: [{ k, cacheBytes }], a worker count and each
  // worker's cache): the count whose predicted time is least, each worker doing 1/k of the
  // visits' work and of the reads its cache size predicts (chooseGroupSize's replay).
  // More workers split the work but each holds a smaller cache and decodes more.
  let grouping,
    shareModel = null
  if (opts.planOnly && opts.planShares?.length) {
    const visits = blocks.reduce((n, b) => n + b.maps.length, 0)
    shareModel = opts.planShares.map(({ k, cacheBytes }) => {
      const g = groupingFor(cacheBytes),
        reads = g.predicted?.[g.size] ?? 0
      return { k, cacheBytes, grouping: g, reads, seconds: (ORTHO_VISIT_S * visits + ORTHO_READ_S * reads) / k }
    })
    const best = shareModel.reduce((a, b) => (b.seconds < a.seconds ? b : a))
    grouping = best.grouping
    shareModel = { workers: best.k, candidates: shareModel.map(({ grouping: _g, ...c }) => c) }
  } else grouping = groupingFor(opts.cacheBytes ?? 1024 ** 3)
  const groups = blockGroups(nbx, nby, grouping.size)
  if (opts.planOnly) {
    // groupVisits: each group's map visits, the work a split deals out.
    return {
      plan: {
        survey: mosaic ? { balance, seams, fromMapRgb: surveyFromMapRgb } : null,
        groupBlocks: grouping.size,
        groups: groups.length,
        predicted: grouping.predicted ?? null,
        shareModel,
        groupVisits: groups.map((g) => unionMaps(g.map((bi) => blocks[bi])).length * passes),
      },
    }
  }
  // This run's share of the groups (all of them unless the work is split), in order.
  const runGroups = opts.groupIndices ?? groups.map((_, gi) => gi)
  const groupMaps = runGroups.map((gi) => unionMaps(groups[gi].map((bi) => blocks[bi])))
  const sequence = visitSequence(groupMaps, passes)
  const cacheBytes = (opts.cacheBytes ?? 1024 ** 3) - (grouping.size - 1) * (opts.blockBytes ?? 0)
  // The visit cache (orthoVisits.js): the maps and photos each visit reads, kept
  // while a later visit wants them (Belady), and the photos loaded ahead.
  const visits = createVisits({ sequence, cacheBytes, loadMap, loadImage, mapPxPerCell, opts, tick })
  const { fetch, planPhotos, visited, clock, ms } = visits
  total = (survey ? metas.length : 0) + sequence.length

  // Window buffers (orthoBlocks.js windowStates): one set per block of a group.
  const states = windowStates({ W, H, B, halo, align, groups, opts, metas, mosaic, multiband, mode })
  const labelled = !!states[0]?.buf.labels
  const stats = createOrthoStats(W, H, labelled)
  const scratch = { P: [0, 0, 0], px: new Float32Array(4), g: {} }
  let sampled = 0,
    covered = 0

  // `maxMaps`: the most maps one block sees, which the cache must hold for a block's
  // passes to read each map once; `groups` / `groupMaps`: the same for a group.
  const runBlocks = runGroups.reduce((n, gi) => n + groups[gi].length, 0)
  hooks.onBlocksStart?.(runBlocks, {
    maxMaps: blocks.reduce((n, b) => Math.max(n, b.maps.length), 0),
    groups: runGroups.length,
    groupSize: grouping.size,
    groupMaps: groupMaps.reduce((n, m) => Math.max(n, m.length), 0),
    cacheBytes,
  })
  // `opts.claims` (an Int32Array over shared memory, one slot per group): split over
  // workers, a group is taken by whichever worker claims it first, so a worker that is
  // done can take groups off a slower one's list. A group claimed elsewhere is skipped;
  // its visits are passed over in the plan, so the cache's view of what comes next stays
  // in step.
  const claims = opts.claims ?? null
  const ran = { groups: 0, blocks: 0, visits: 0 } // what this run did (not what others claimed)
  for (const [k, gi] of runGroups.entries()) {
    if (claims && Atomics.compareExchange(claims, gi, 0, 1) !== 0) {
      visits.skip(groupMaps[k].length * passes)
      continue
    }
    const group = groups[gi]
    ran.groups++
    ran.blocks += group.length
    ran.visits += group.reduce((n, bi) => n + blocks[bi].maps.length, 0)
    hooks.onGroup?.(gi, groups.length, group.length)
    // The group's blocks with a surface, each in its own window buffers.
    const active = []
    group.forEach((bi, si) => {
      const b = blocks[bi]
      if (b.empty) return
      const { ex0, ey0, ew, eh } = b,
        n = ew * eh,
        { buf } = states[si]
      const win = {
        x0: ex0,
        y0: ey0,
        w: ew,
        h: eh,
        data: buf.data.subarray(0, n),
        mask: buf.mask.subarray(0, n),
        rgba: buf.rgba.subarray(0, n * 4).fill(0),
        scores: buf.scores?.subarray(0, n).fill(Infinity) ?? null,
        sums: buf.sums?.subarray(0, n * 4).fill(0) ?? null,
        labels: buf.labels?.subarray(0, n).fill(NO_LABEL) ?? null,
      }
      sampleSurfaceWindow(surface, geom, ex0, ey0, ew, eh, win.data, win.mask)
      const st = states[si]
      b.maps.forEach((mi, j) => {
        st.slot[mi] = j
      })
      active.push({ b, win, n, st })
    })
    for (const a of active) winTiles(a.win, geom, gp)
    if (mosaic) {
      await mosaicGroup(active, {
        geom,
        gp,
        toSfm,
        opts,
        scratch,
        fetch,
        visited,
        clock,
        planPhotos,
        balance,
        seams,
        seamCells,
        multiband,
        mode,
        align,
      })
    } else {
      const union = unionMaps(active.map((a) => a.b))
      planPhotos(union)
      for (const mi of union) {
        const e = await fetch(mi, true)
        const t = performance.now()
        for (const a of active)
          if (a.st.slot[mi] >= 0) colourFromMap(a.win, geom, e.m, e.photo, mi, affine, toSfm, opts, scratch)
        clock('colour', t)
        visited(mi, e)
      }
    }
    // Finish and hand on every block of the group, in block order.
    for (const bi of group) {
      const b = blocks[bi],
        a = active.find((x) => x.b === b)
      const { col0, row0, bw, bh, ex0, ey0, ew, eh } = b
      const coreRgba = new Uint8ClampedArray(bw * bh * 4)
      const coreLabels = labelled ? new Uint16Array(bw * bh).fill(NO_LABEL) : null
      if (a) {
        const { win } = a
        const cx = col0 - ex0,
          cy = row0 - ey0
        const s0 = finishWindow(win, cx, cy, bw, bh)
        fillOrthoGaps(win.rgba, win.mask, ew, eh, fillRadius, fillMethod)
        const c = countColoured(win.rgba, ew, cx, cy, bw, bh)
        sampled += s0
        covered += c
        stats.add({
          rgba: win.rgba,
          labels: win.labels,
          x0: ex0,
          y0: ey0,
          w: ew,
          h: eh,
          cx0: col0,
          cy0: row0,
          cw: bw,
          ch: bh,
        })
        for (let r = 0; r < bh; r++) {
          const src = (cy + r) * ew + cx
          coreRgba.set(win.rgba.subarray(src * 4, (src + bw) * 4), r * bw * 4)
          if (coreLabels) coreLabels.set(win.labels.subarray(src, src + bw), r * bw)
        }
        for (const mi of b.maps) a.st.slot[mi] = -1
      }
      if (onBlock) await onBlock({ col0, row0, width: bw, height: bh, rgba: coreRgba, labels: coreLabels })
    }
  }
  visits.clear()
  const { mapLoads, photoLoads, cacheHits, shrinks, cacheLimit } = visits.counts()
  return {
    width: W,
    height: H,
    covered,
    sampled,
    filled: covered - sampled,
    surfaceCells,
    labelled,
    stats: stats.finish(),
    statsState: stats.state(),
    blocks: ran.blocks,
    groups: ran.groups,
    grouping: { size: grouping.size, groups: groups.length, cacheBytes, predicted: grouping.predicted ?? null },
    cacheShrinks: shrinks,
    cacheLimit,
    ...(survey ? { surveyFromMapRgb } : {}),
    visits: ran.visits,
    mapLoads,
    photoLoads,
    cacheHits,
    timings: Object.fromEntries(Object.entries(ms).map(([k, v]) => [k, Math.round(v)])),
    ...(mosaic
      ? {
          mosaic: {
            seamline: graphcut ? 'graphcut' : 'nadir',
            seamBlend: multiband ? 'multiband' : 'feather',
            seamCells,
            smoothPasses: graphcut ? 0 : MOSAIC_SMOOTH_PASSES,
            levels: multiband ? mode.levels : 0,
            seamCut: seams?.summary ?? null,
            balance: balance?.summary ?? null,
          },
        }
      : {}),
    // Where the graph-cut survey's time went (ms): map + photo reads, sampling, min cuts.
    ...(seams ? { seamCutMs: seams.ms } : {}),
    // Per image the R, G, B gains (3 per map, map order), for the caller's audit log.
    ...(balance ? { gains: balance.gains } : {}),
  }
}

// The mosaic's passes over a group's block windows (orthorectifyTiled's visits):
// each pass visits each map once, and every block that sees it takes its share.
async function mosaicGroup(active, ctx) {
  const { geom, gp, toSfm, opts, scratch, fetch, visited, clock, planPhotos } = ctx
  const { balance, seams, seamCells, multiband } = ctx
  for (const a of active) {
    const { win, n, st } = a,
      mbs = st.mb
    Object.assign(win, {
      raw: mbs.raw.subarray(0, n).fill(NO_LABEL),
      score: mbs.score.subarray(0, n).fill(Infinity),
      label: mbs.label.subarray(0, n),
      sums: null,
      msums: mbs.sums.subarray(0, n * 4).fill(0),
      fallback: mbs.fallback.subarray(0, n * 3),
      flags: mbs.flags.subarray(0, n).fill(0),
      dist: mbs.dist.subarray(0, n),
    })
  }
  const union = unionMaps(active.map((a) => a.b))
  // Pass 1: labels (no photo).
  for (const mi of union) {
    const e = await fetch(mi, false)
    const t = performance.now()
    for (const a of active) if (a.st.slot[mi] >= 0) labelFromMap(a.win, geom, e.m, mi, gp, toSfm, opts, scratch)
    clock('label', t)
    visited(mi, e)
  }
  const band = multiband ? 0 : seamCells,
    seam3 = 3 * band
  const gains = balance?.gains ?? null
  for (const a of active) {
    const { b, win, n, st } = a,
      { ew, eh } = b,
      k = b.maps.length
    if (seams) {
      // O5: the coarse graph-cut label of each cell; its pass-1 label where the coarse
      // cell has none, or names a map that sees nothing of this window (culled).
      const {
        labels: cut,
        grid: { f, cw },
      } = seams
      for (let r = 0, i = 0; r < eh; r++) {
        const crow = Math.floor((b.ey0 + r) / f) * cw
        for (let c = 0; c < ew; c++, i++) {
          const l = cut[crow + Math.floor((b.ex0 + c) / f)]
          win.label[i] = l !== NO_LABEL && st.slot[l] >= 0 ? l : win.raw[i]
        }
      }
    } else smoothLabels(win.raw, win.label, st.mb.tmp.subarray(0, n), ew, eh)
    // Each map's box: its region grown by the seam band, joined with the cells it
    // holds as the pass-1 fallback.
    const own = new Int32Array(4 * k),
      fb = new Int32Array(4 * k)
    for (let j = 0; j < k; j++) {
      own.set([ew, eh, -1, -1], 4 * j)
      fb.set([ew, eh, -1, -1], 4 * j)
    }
    const grow = (arr, o, c, r) => {
      if (c < arr[o]) arr[o] = c
      if (r < arr[o + 1]) arr[o + 1] = r
      if (c > arr[o + 2]) arr[o + 2] = c
      if (r > arr[o + 3]) arr[o + 3] = r
    }
    for (let r = 0, i = 0; r < eh; r++)
      for (let c = 0; c < ew; c++, i++) {
        const l = win.label[i],
          rl = win.raw[i]
        if (l !== NO_LABEL) grow(own, 4 * st.slot[l], c, r)
        if (rl !== NO_LABEL && rl !== l) grow(fb, 4 * st.slot[rl], c, r)
      }
    a.own = own
    a.fb = fb
    a.step = { ...scratch, P: [0, 0, 0] }
    a.viewWin = { ...win, sums: win.msums }
  }
  // Pass 2: colour, descending (see passOrder). Each map's boxes first, so the photos
  // the pass will read are known (and load ahead).
  const colourVisits = []
  for (let u = union.length - 1; u >= 0; u--) {
    const mi = union[u]
    const boxes = []
    for (const a of active) {
      const j = a.st.slot[mi]
      if (j < 0) continue
      const o = 4 * j,
        { own, fb } = a,
        { ew, eh } = a.b
      const hasOwn = own[o + 2] >= 0,
        hasFb = fb[o + 2] >= 0
      if (!hasOwn && !hasFb) continue
      let x0 = ew,
        y0 = eh,
        x1 = 0,
        y1 = 0
      if (hasOwn) {
        x0 = Math.max(0, own[o] - band)
        y0 = Math.max(0, own[o + 1] - band)
        x1 = Math.min(ew, own[o + 2] + 1 + band)
        y1 = Math.min(eh, own[o + 3] + 1 + band)
      }
      if (hasFb) {
        x0 = Math.min(x0, fb[o])
        y0 = Math.min(y0, fb[o + 1])
        x1 = Math.max(x1, fb[o + 2] + 1)
        y1 = Math.max(y1, fb[o + 3] + 1)
      }
      boxes.push({ a, hasOwn, box: [x0, y0, x1, y1] })
    }
    colourVisits.push({ mi, boxes })
  }
  planPhotos(colourVisits.filter((v) => v.boxes.length).map((v) => v.mi))
  for (const { mi, boxes } of colourVisits) {
    if (!boxes.length) {
      visited(mi, null)
      continue
    }
    const e = await fetch(mi, true)
    const t = performance.now()
    for (const {
      a,
      hasOwn,
      box: [x0, y0, x1, y1],
    } of boxes) {
      const { win } = a,
        ew = a.b.ew
      if (seam3 && hasOwn) chamferTo(win.label, ew, x0, y0, x1, y1, mi, win.dist)
      else if (seam3) for (let r = y0; r < y1; r++) win.dist.fill(0xffff, r * ew + x0, r * ew + x1)
      blendFromMap(a.viewWin, geom, e.m, e.photo, mi, gp, toSfm, opts, a.step, [x0, y0, x1, y1], seam3, gains)
    }
    clock('colour', t)
    visited(mi, e)
  }
  if (multiband) await multibandGroup(active, union, gains, ctx)
  else for (const a of active) finishMosaicWindow({ ...a.win, sums: a.win.msums })
}

// O4b: the hard-seam mosaic of pass 2 is the base; each map then adds its pyramid
// correction over the ring around its effective region (multiband.js), map by map
// across the group's blocks.
async function multibandGroup(active, union, gains, ctx) {
  const { geom, gp, toSfm, opts, fetch, visited, clock, planPhotos, mode, align } = ctx
  const { ring, margin } = multibandReach(mode.levels),
    ring3 = 3 * ring
  for (const a of active) {
    const { b, win, n, st } = a,
      { ew, eh } = b
    const { mask, label, raw, msums, fallback, flags } = win
    // The effective label and its colour: the label where it saw the cell, else the
    // pass-1 fallback (as finishMosaicWindow), in linear light, gains applied.
    const eff = st.mb.tmp.subarray(0, n)
    for (let i = 0; i < n; i++) {
      const f = flags[i],
        o = 4 * i
      eff[i] = NO_LABEL
      if (!mask[i]) continue
      if (f & 1) eff[i] = label[i]
      else if (f & 2) {
        eff[i] = raw[i]
        msums[o] = fallback[3 * i]
        msums[o + 1] = fallback[3 * i + 1]
        msums[o + 2] = fallback[3 * i + 2]
      }
    }
    const t = performance.now()
    multibandBegin(st.mb.pyr, ew, eh, eff, NO_LABEL)
    clock('pyramid', t)
    const k = b.maps.length,
      box = new Int32Array(4 * k)
    for (let j = 0; j < k; j++) box.set([ew, eh, -1, -1], 4 * j)
    for (let r = 0, i = 0; r < eh; r++)
      for (let c = 0; c < ew; c++, i++) {
        const l = eff[i]
        if (l === NO_LABEL) continue
        const o = 4 * st.slot[l]
        if (c < box[o]) box[o] = c
        if (r < box[o + 1]) box[o + 1] = r
        if (c > box[o + 2]) box[o + 2] = c
        if (r > box[o + 3]) box[o + 3] = r
      }
    a.eff = eff
    a.mbox = box
  }
  const { depthTolRel = RUN_DEFAULTS.depthTolRel, maxCost = RUN_DEFAULTS.maxCost } = opts
  const usersOf = union.map((mi) => active.filter((a) => a.st.slot[mi] >= 0 && a.mbox[4 * a.st.slot[mi] + 2] >= 0))
  planPhotos(union.filter((_, u) => usersOf[u].length))
  for (const [u, mi] of union.entries()) {
    const users = usersOf[u]
    if (!users.length) {
      visited(mi, null)
      continue
    }
    const e = await fetch(mi, true),
      m = e.m,
      see = mapSight(m, gp.up, depthTolRel, maxCost)
    const g0 = gains ? gains[mi * 3] : 1,
      g1 = gains ? gains[mi * 3 + 1] : 1,
      g2 = gains ? gains[mi * 3 + 2] : 1
    for (const a of users) {
      const { b, win, eff, mbox, st, step } = a,
        { ew, eh } = b,
        o = 4 * st.slot[mi]
      const { P, g, px } = step
      const { msums } = win
      // The box on the window's pyramid lattice (the window's origin is on the grid's).
      const x0 = Math.max(0, Math.floor((mbox[o] - margin) / align) * align),
        y0 = Math.max(0, Math.floor((mbox[o + 1] - margin) / align) * align)
      const x1 = Math.min(ew, mbox[o + 2] + 1 + margin),
        y1 = Math.min(eh, mbox[o + 3] + 1 + margin)
      const bw = x1 - x0,
        bh = y1 - y0
      let t = performance.now()
      chamferTo(eff, ew, x0, y0, x1, y1, mi, win.dist)
      const d = win.fallback // free now: the box's colour differences, 3 per cell
      d.fill(0, 0, 3 * bw * bh)
      forTilesReaching(win, geom, m, gp.affine, x0, y0, x1, y1, (c0, r0, c1, r1) => {
        for (let wr = r0; wr < r1; wr++)
          for (let wc = c0; wc < c1; wc++) {
            const wi = wr * ew + wc,
              dd = win.dist[wi]
            if (dd === 0 || dd > ring3 || eff[wi] === NO_LABEL) continue
            winCellToSfm(win, geom, gp, toSfm, wc, wr, win.data[wi], P)
            if (!see(P, g) || !sampleColour(m, e.photo, g, px)) continue
            const q = 3 * ((wr - y0) * bw + wc - x0),
              wo = 4 * wi
            d[q] = g0 * srgbToLinear(px[0]) - msums[wo]
            d[q + 1] = g1 * srgbToLinear(px[1]) - msums[wo + 1]
            d[q + 2] = g2 * srgbToLinear(px[2]) - msums[wo + 2]
          }
      })
      clock('ring', t)
      t = performance.now()
      multibandAdd(st.mb.pyr, x0, y0, bw, bh, d, eff, mi)
      clock('pyramid', t)
    }
    visited(mi, e)
  }
  for (const a of active) {
    const { win, eff, n, st } = a
    let t = performance.now()
    multibandFinish(st.mb.pyr, win.msums)
    clock('pyramid', t)
    const { rgba, labels, msums } = win
    for (let i = 0; i < n; i++) {
      const l = eff[i],
        o = 4 * i
      labels[i] = l
      if (l === NO_LABEL) continue
      rgba[o] = linearToSrgb(msums[o])
      rgba[o + 1] = linearToSrgb(msums[o + 1])
      rgba[o + 2] = linearToSrgb(msums[o + 2])
      rgba[o + 3] = 255
    }
  }
}

// The split's time model (opts.planShares), measured on quarry-347 at long side 12,000
// (2026-10-21, six workers): a map visit's work (labels, colour, seams; a 2048² block)
// ~0.17 s, and a unit of predicted reads (a map read 1, a photo decode 3) ~0.08 s.
const ORTHO_VISIT_S = 0.17,
  ORTHO_READ_S = 0.08

export { affineToSfm, orthoMapPxPerCell } from './orthoColour.js'
export {
  ORTHO_BLOCK,
  ORTHO_BLOCK_MIN,
  orthoBlockSize,
  orthoTiledWorkingBytes,
  orthoSeamSurveyBytes,
} from './orthoBlocks.js'
