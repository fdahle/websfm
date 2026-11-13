// The block size and the memory a tiled orthophoto needs (core/products/ortho.js
// orthorectifyTiled walks the grid in these blocks). Pure.

import { seamGrid, SEAM_CANDIDATES } from './seamCut.js'
import { MULTIBAND_LEVELS, MULTIBAND_BYTES_PER_CELL } from './multiband.js'
import { mosaicMode, orthoHalo } from './orthoMosaic.js'
import { RUN_DEFAULTS } from './orthoColour.js'
import { sampleSurfaceWindow } from './surface.js'
import { boxReachesMap, newLabels } from './orthoWindow.js'
import { createMultiband } from './multiband.js'
import { fillArray } from '../bigArray.js'

export const ORTHO_BLOCK = 2048
// A split ortho's block side (workers/ops/ortho.js orthoPlan): ORTHO_BLOCK, halved
// while the grid has fewer blocks than workers that could take them, down to
// ORTHO_BLOCK_MIN. The workers share out blocks, so a small ortho in one 2,048² block ran
// on one of them. Every block computes the cells it would in a larger one (its halo
// holds what its seams and fills read), so the ortho is the same bits at any block size
// (orthoMosaic.test.js); a smaller block costs more halo and more map visits.
export const ORTHO_BLOCK_MIN = 1024
export function orthoBlockSize(width, height, shares = 1) {
  let b = ORTHO_BLOCK
  while (b > ORTHO_BLOCK_MIN && Math.ceil(width / b) * Math.ceil(height / b) < shares) b /= 2
  return b
}

// The largest block window: core + halo on both sides, plus up to align − 1 cells per
// side where a multiband window rounds out to its pyramid lattice.
export function maxWindow(W, H, B, halo, align) {
  const ext = B + 2 * halo + 2 * (align - 1)
  return { ew: Math.min(W, ext), eh: Math.min(H, ext) }
}

// The block layout and per-cell working bytes of a tiled run, for the caller's preflight.
// Per extended-window cell: height 4 + mask 1 + rgba 4 + label 2 + the gap fill's sample
// flags 1 + the stats' luma 4, plus the blend's state: 8 'best' / 32 'average' / for
// 'mosaic' raw + smoothing labels 4, score 8, sums 16, fallback 12, flags 1, distance 2,
// and for multiband its pyramids (multiband.js). Per core cell the handed-out copies,
// rgba 4 + label 2. A graph-cut mosaic holds its coarse labels (2 B per coarse cell)
// throughout, and before the blocks its survey of the candidates (orthoSeamSurveyBytes),
// whichever is larger.
export function orthoTiledWorkingBytes({
  width,
  height,
  blend = RUN_DEFAULTS.blend,
  fillRadius = RUN_DEFAULTS.fillRadius,
  seamWidth = 0,
  seamline = 'nadir',
  seamBlend = 'feather',
  blendLevels = MULTIBAND_LEVELS,
  blockSize = ORTHO_BLOCK,
}) {
  const mode = mosaicMode({ blend, seamline, seamBlend, blendLevels })
  const halo = orthoHalo({ width, height, blend, fillRadius, seamWidth, seamline, seamBlend, blendLevels })
  const { ew, eh } = maxWindow(width, height, blockSize, halo, mode.align)
  const core = Math.min(width, blockSize) * Math.min(height, blockSize)
  const state = blend === 'average' ? 32 : blend === 'mosaic' ? 4 + 8 + 16 + 12 + 1 + 2 : 8
  const pyramids = mode.multiband ? MULTIBAND_BYTES_PER_CELL : 0
  const block = ew * eh * (4 + 1 + 4 + state + pyramids + 2 + 1 + 4) + core * 6
  if (!mode.graphcut) return block
  const { cw, ch } = seamGrid(width, height)
  return Math.max(block + 2 * cw * ch, orthoSeamSurveyBytes(width, height))
}

// The graph-cut survey before the blocks: per coarse cell its height + mask, the
// candidates (image 2, footprint 4, colour 3, data cost 4 each) and the solver's labels
// and flags (~8), plus a min-cut graph over at most the whole coarse grid (~60 B/node).
export function orthoSeamSurveyBytes(width, height) {
  const { cw, ch } = seamGrid(width, height)
  return cw * ch * (5 + SEAM_CANDIDATES * 13 + 8 + 60)
}

// A tiled run's pre-pass (orthorectifyTiled): the grid's height range and mean (row-major,
// as the single pass reads them), the surface cell count, and each block core's height
// range for the cull. B: the block side; nbx × nby blocks.
export function surveyHeights(surface, geom, B, nbx, nby) {
  const { width: W, height: H } = geom
  const nBlocks = nbx * nby
  const blockLo = fillArray(new Float64Array(nBlocks), Infinity),
    blockHi = fillArray(new Float64Array(nBlocks), -Infinity)
  const rowData = new Float32Array(W),
    rowMask = new Uint8Array(W)
  let zLo = Infinity,
    zHi = -Infinity,
    zMid = 0,
    surfaceCells = 0
  for (let row = 0; row < H; row++) {
    sampleSurfaceWindow(surface, geom, 0, row, W, 1, rowData, rowMask)
    const base = Math.floor(row / B) * nbx
    for (let col = 0; col < W; col++) {
      if (!rowMask[col]) continue
      const z = rowData[col]
      if (z < zLo) zLo = z
      if (z > zHi) zHi = z
      zMid += (z - zMid) / ++surfaceCells
      const bi = base + Math.floor(col / B)
      if (z < blockLo[bi]) blockLo[bi] = z
      if (z > blockHi[bi]) blockHi[bi] = z
    }
  }
  return { blockLo, blockHi, zLo, zHi, zMid, surfaceCells }
}

// The block windows of a tiled run (core + halo, clipped to the grid; a multiband window
// rounded out to its pyramid lattice) and the maps that can see each. The window reaches
// at most `reach` blocks over, so those blocks' core ranges bound every height in it.
export function blockWindows({ geom, B, nbx, nby, halo, align, blockLo, blockHi, gp, metas }) {
  const { width: W, height: H } = geom
  const reach = Math.ceil((halo + align - 1) / B)
  const blocks = []
  for (let by = 0; by < nby; by++)
    for (let bx = 0; bx < nbx; bx++) {
      const col0 = bx * B,
        row0 = by * B,
        bw = Math.min(B, W - col0),
        bh = Math.min(B, H - row0)
      const ex0 = Math.max(0, Math.floor((col0 - halo) / align) * align),
        ey0 = Math.max(0, Math.floor((row0 - halo) / align) * align)
      const ex1 = Math.min(W, Math.ceil((col0 + bw + halo) / align) * align),
        ey1 = Math.min(H, Math.ceil((row0 + bh + halo) / align) * align)
      let lo = Infinity,
        hi = -Infinity
      for (let ny = Math.max(0, by - reach); ny <= Math.min(nby - 1, by + reach); ny++) {
        for (let nx = Math.max(0, bx - reach); nx <= Math.min(nbx - 1, bx + reach); nx++) {
          lo = Math.min(lo, blockLo[ny * nbx + nx])
          hi = Math.max(hi, blockHi[ny * nbx + nx])
        }
      }
      const maps = []
      if (lo <= hi) {
        // The cull with the block's own affine (and its grown box) when the frame has none.
        const near = gp.local([
          geom.originX + (ex0 + 0.5) * geom.gsd,
          geom.originX + (ex1 - 0.5) * geom.gsd,
          geom.originY - (ey1 - 0.5) * geom.gsd,
          geom.originY - (ey0 + 0.5) * geom.gsd,
          lo,
          hi,
        ])
        for (let mi = 0; mi < metas.length; mi++) if (boxReachesMap(metas[mi], near, near.box)) maps.push(mi)
      }
      blocks.push({ col0, row0, bw, bh, ex0, ey0, ew: ex1 - ex0, eh: ey1 - ey0, maps, empty: !(lo <= hi) })
    }
  return blocks
}

// A tiled run's window buffers, sized once for the largest window: one set per block of
// a group (`groups`, lists of block indices).
export function windowStates({ W, H, B, halo, align, groups, opts, metas, mosaic, multiband, mode }) {
  const win0 = maxWindow(W, H, B, halo, align),
    maxCells = win0.ew * win0.eh
  const average = opts.blend === 'average'
  const groupSize = groups.reduce((n, g) => Math.max(n, g.length), 0)
  return Array.from({ length: groupSize }, () => ({
    buf: {
      data: new Float32Array(maxCells),
      mask: new Uint8Array(maxCells),
      rgba: new Uint8ClampedArray(maxCells * 4),
      scores: average || mosaic ? null : new Float64Array(maxCells),
      sums: average ? new Float64Array(maxCells * 4) : null,
      labels: newLabels(maxCells, opts, metas.length),
    },
    mb: mosaic
      ? {
          raw: new Uint16Array(maxCells),
          label: new Uint16Array(maxCells),
          tmp: new Uint16Array(maxCells),
          score: new Float64Array(maxCells),
          sums: new Float32Array(maxCells * 4),
          fallback: new Float32Array(maxCells * 3),
          flags: new Uint8Array(maxCells),
          dist: new Uint16Array(maxCells),
          pyr: multiband ? createMultiband(win0.ew, win0.eh, mode.levels) : null,
        }
      : null,
    // map index → its position in the block's map list, -1 for a map the block does not see
    slot: new Int32Array(metas.length).fill(-1),
  }))
}
