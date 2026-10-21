// What a detection run will do to the project's images, in the order it does it —
// the live readout behind DetectFeaturesModal's step layout. Pure: the modal hands in
// image sizes + its settings, nothing here touches the worker.
//
// The order is the worker's (workers/ops/detect.js `detect`):
//   1. resize  — the image is rasterised so its long side ≤ the detection resolution
//                (resolveDetectMaxDim: fixed, or a fraction of native in 'auto' mode;
//                never upscaled);
//   2. tile    — THAT resized raster is cut into overlapping tiles, but only when it
//                is larger than one tile. Tiling never adds resolution: it changes how
//                the detection image is processed, not how big it is;
//   3. detect  — per tile (or once), each tile keeping only keypoints in its core;
//   4. keep    — one global strongest-N cap over the merged result.
// Step 2 being after step 1 is the whole point of this module: users read "tiling"
// as "detect at full resolution in pieces", which it is only when the detection
// resolution is at least the native size.

import { resolveDetectMaxDim } from './detectResolution.js'
import { planTiles, autoTileSize, SIFT_TILE_ALIGN } from './tiling.js'
import { learnedDetector } from './learnedDetectors.js'

// The worker's auto tile size for a learned detector is min(this, what the GPU's
// reported binding limit allows) — unknowable from the main thread, so the plan uses
// the ceiling and says "up to" (workers/ops/detect.js SP_GPU_TILE_MAX).
export const LEARNED_AUTO_TILE_MAX = 1024

/** The tile edge a run will use, and whether that is exact or an upper bound. */
export function plannedTileSize({ detector = 'sift', tiling = 'off', tileSize = 0 } = {}) {
  if (tiling === 'off') return { size: 0, exact: true }
  if (tiling === 'manual' && tileSize > 0) return { size: tileSize, exact: true }
  if (!learnedDetector(detector)) return { size: autoTileSize({ maxBindingBytes: 0 }), exact: true }
  return { size: LEARNED_AUTO_TILE_MAX, exact: false }
}

/** One image: native size → detection size → tile grid. */
export function planImageDetection(natW, natH, settings = {}) {
  const nativeMax = Math.max(natW || 0, natH || 0)
  const { maxDim } = resolveDetectMaxDim(nativeMax, settings)
  // Same arithmetic as the worker's rasterize (downscaleBitmap).
  const scale = nativeMax > 0 ? Math.min(1, maxDim / nativeMax) : 1
  const width = Math.round(natW * scale),
    height = Math.round(natH * scale)
  const tile = plannedTileSize(settings)
  let tilesX = 1,
    tilesY = 1
  if (tile.size > 0 && (width > tile.size || height > tile.size)) {
    const spec = learnedDetector(settings.detector)
    const tiles = planTiles(width, height, tile.size, settings.overlap ?? 64, {
      align: spec ? spec.tileAlign : SIFT_TILE_ALIGN,
    })
    tilesX = new Set(tiles.map((t) => t.x)).size
    tilesY = new Set(tiles.map((t) => t.y)).size
  }
  return { natW, natH, width, height, scale, tilesX, tilesY, tiles: tilesX * tilesY }
}

/**
 * Summarise a run over many images. `images` is `[{ width, height }]` (native px;
 * entries without a size are counted in `unknown`). Returns null when no image has a
 * size yet. `largest` is the image with the biggest native long side — the one the
 * modal shows as the worked example, since it is where resize and tiling bite.
 */
export function planDetection(images, settings = {}) {
  const sized = images.filter((im) => im.width > 0 && im.height > 0)
  if (!sized.length) return null
  const plans = sized.map((im) => planImageDetection(im.width, im.height, settings))
  let largest = plans[0]
  for (const p of plans) if (Math.max(p.natW, p.natH) > Math.max(largest.natW, largest.natH)) largest = p
  const detectMax = plans.map((p) => Math.max(p.width, p.height))
  return {
    count: sized.length,
    unknown: images.length - sized.length,
    largest,
    minDetect: Math.min(...detectMax),
    maxDetect: Math.max(...detectMax),
    downscaled: plans.filter((p) => p.scale < 1).length,
    tiled: plans.filter((p) => p.tiles > 1).length,
    maxTiles: Math.max(...plans.map((p) => p.tiles)),
    tileSize: plannedTileSize(settings),
  }
}
