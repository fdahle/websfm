// Target ops: checker targets at predicted positions and printed tags (AprilTag, ArUco).

import { fromScaledPx } from '../../core/sfm/geometry.js'
import { grayFromRgba } from '../../core/sfm/fiducialDetect.js'
import { TAG_DETECT_TUNING } from '../../core/tuning.js'
import { findCheckerCorner } from '../../core/sfm/targetDetect.js'
import { detectTags, tagTiles, mergeTags, DEFAULT_FAMILY } from '../../core/sfm/tagDetect.js'
import { arucoFamily } from '../../core/sfm/tags/aruco.js'
import { cropGray, decodeBitmap, downscaleBitmap } from './detectBitmaps.js'

export function makeTargetOps() {
  // Checker GCP targets (Tools ▸ Images ▸ Detect targets, core/sfm/targetDetect.js): one
  // window per prediction { key, x, y (pixel centres), radius, quadRadius }, cut from the
  // photo at full resolution, searched for the target's centre.
  // → { results: [{ key, x, y, score, contrast }] } for the targets found.
  async function detectTargets([url, predictions]) {
    const bmp = await decodeBitmap(url)
    try {
      const results = []
      for (const p of predictions) {
        const half = Math.ceil(p.radius + 2 * p.quadRadius + 8)
        const win = cropGray(bmp, p.x - half, p.y - half, 2 * half + 1, 2 * half + 1)
        const r = findCheckerCorner(
          win,
          { x: p.x - win.originX, y: p.y - win.originY },
          { radius: p.radius, quadRadius: p.quadRadius },
        )
        if (r)
          results.push({ key: p.key, x: r.x + win.originX, y: r.y + win.originY, score: r.score, contrast: r.contrast })
      }
      return { result: { results } }
    } finally {
      bmp.close()
    }
  }

  // AprilTag tag36h11 targets, or an ArUco dictionary's markers (`dict`), anywhere in one
  // photo (core/sfm/tagDetect.js): native tiles for every tag up to the tiles' overlap,
  // then the photo downscaled to one tile for the larger ones.
  // → { tags: [{ id, hamming, score, x, y (pixel centres), contrast }] }.
  async function detectTagsInPhoto([url, dict = null]) {
    const cfg = TAG_DETECT_TUNING
    const family = dict ? arucoFamily(dict) : DEFAULT_FAMILY
    const bmp = await decodeBitmap(url)
    try {
      const found = []
      const maxSide = 0.6 * cfg.overlap
      for (const t of tagTiles(bmp.width, bmp.height, cfg)) {
        const win = cropGray(bmp, t.x0, t.y0, t.w, t.h)
        for (const tag of detectTags(win, { minSide: cfg.minSide, maxSide, maxHamming: cfg.maxHamming, family })) {
          const x = tag.center.x + win.originX,
            y = tag.center.y + win.originY
          if (x >= t.core.x0 && x < t.core.x1 && y >= t.core.y0 && y < t.core.y1)
            found.push({ id: tag.id, hamming: tag.hamming, score: tag.score, x, y, contrast: tag.contrast })
        }
      }
      const long = Math.max(bmp.width, bmp.height)
      if (long > cfg.tile) {
        const small = downscaleBitmap(bmp, cfg.tile)
        const sx = small.width / bmp.width,
          sy = small.height / bmp.height
        const gray = grayFromRgba(small.data, small.width, small.height)
        const minSide = Math.max(cfg.minSide, maxSide * Math.min(sx, sy))
        const native = new Set(found.map((t) => t.id))
        for (const tag of detectTags(gray, { minSide, maxHamming: cfg.maxHamming, family }))
          if (!native.has(tag.id))
            found.push({
              id: tag.id,
              hamming: tag.hamming,
              score: tag.score,
              x: fromScaledPx(tag.center.x, sx),
              y: fromScaledPx(tag.center.y, sy),
              contrast: tag.contrast,
            })
      }
      return { result: { tags: mergeTags(found) } }
    } finally {
      bmp.close()
    }
  }

  return {
    detectTargets,
    detectTagsInPhoto,
  }
}
