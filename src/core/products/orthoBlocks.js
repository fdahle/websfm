// The block size and the memory a tiled orthophoto needs (core/products/ortho.js
// orthorectifyTiled walks the grid in these blocks). Pure.

import { seamGrid, SEAM_CANDIDATES } from './seamCut.js'
import { MULTIBAND_LEVELS, MULTIBAND_BYTES_PER_CELL } from './multiband.js'
import { mosaicMode, orthoHalo } from './orthoMosaic.js'
import { RUN_DEFAULTS } from './orthoColour.js'

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
