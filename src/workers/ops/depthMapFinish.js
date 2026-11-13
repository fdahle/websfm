// A finished depth map made ready to hand on (Dense Stage A): the pixels no source
// measured and the speckles dropped, the mask applied, its colours and preview PNG made,
// and its log line. Moved from workers/ops/dense.js (R2).

import { filterDepthMapChunked } from '../../core/dense/mvs.js'
import { FISHEYE_DENSE_MAX_DEG } from '../../core/products/undistort.js'
import { costStats } from '../../core/dense/costStats.js'
import { rgbFromChannel, rgbFromRgba, depthToPng } from './depthRasters.js'

// `dm` the computed map (its depth plane is filtered in place or replaced), `img` its
// image, `rRef` / `refMask` its raster and mask, `ref` its matching frame (K), `srcUuids`
// its source views, `imgBestK` and `imgMs` for the log. `yieldNow` pauses between the
// steps so the next map's GPU work keeps being submitted.
// → { map, planes (its transferable buffers), cs (costStats over its depth) }
export async function finishDepthMap(
  dm,
  { img, rRef, refMask, ref, srcUuids, imgBestK, imgMs },
  { speckleFilter, filterRadius, filterRelTol, emit, yieldNow },
) {
  // P2.1: invalidate "no measurement" pixels before filtering. A pixel no source
  // ever saw keeps its random init depth at the max cost 2.0; left in place, the
  // speckle filter's median mixes that junk into good neighbours. Zero its depth
  // so it reads as a hole (depth<=0) everywhere downstream.
  {
    let culled = 0
    for (let k = 0; k < dm.depth.length; k++) {
      if (dm.depth[k] > 0 && dm.cost[k] >= 1.99) {
        dm.depth[k] = 0
        culled++
      }
    }
    if (culled)
      emit('log', [`Depth maps: ${img.name} — invalidated ${culled} no-measurement px (cost≈2.0)`, 'debug', 'Dense'])
  }
  await yieldNow()
  // Median / speckle filter: clean per-image noise before the cross-view fusion
  // gate sees it (the per-image PatchMatch has no geometric consistency check).
  if (speckleFilter) {
    const {
      depth: fdepth,
      removed,
      smoothed,
    } = await filterDepthMapChunked(
      dm.depth,
      dm.width,
      dm.height,
      { radius: filterRadius, relTol: filterRelTol },
      yieldNow,
    )
    dm.depth = fdepth
    emit('log', [
      `Depth maps: ${img.name} — speckle filter dropped ${removed} px, smoothed ${smoothed}`,
      'debug',
      'Dense',
    ])
  }
  // Drop masked regions from the dense cloud: zero the depth there so fusion
  // (which treats depth <= 0 as "no data") skips those pixels.
  // The mask moves with the raster (undistortion, or the fisheye canvas, whose pixels
  // off the photo are dropped too).
  const maskLut = refMask
  if (maskLut && maskLut.length === dm.depth.length) {
    for (let k = 0; k < dm.depth.length; k++) if (maskLut[k]) dm.depth[k] = 0
  }
  const rgb = rRef.channel ? rgbFromChannel(rRef.channel) : rgbFromRgba(rRef.data, rRef.width, rRef.height)
  await yieldNow()
  const displayBlob = await depthToPng(dm.depth, dm.width, dm.height)
  // F4: for film images the depth preview is in the canonical frame, not scan
  // space, so it won't line up with the scan in the viewer (v1 limitation).
  if (rRef.fid) {
    emit('log', [
      `Depth maps: ${img.name} — preview is in the canonical fiducial frame ` +
        `(${dm.width}×${dm.height}), not scan space`,
      'debug',
      'Dense',
    ])
  }
  if (rRef.pad) {
    emit('log', [
      `Depth maps: ${img.name} — fisheye resampled onto a ${dm.width}×${dm.height} pinhole canvas ` +
        `(up to ${FISHEYE_DENSE_MAX_DEG}° off-axis); its preview is in that frame, not the photo's`,
      'debug',
      'Dense',
    ])
  }
  // Per-pixel diagnostics: how many pixels got a depth, and the matching-cost
  // distribution over those pixels (low cost = confident; high = likely junk
  // that fusion's maxCost gate will drop — the key signal for dense quality).
  const cs = costStats(dm.depth, dm.cost)
  const valid = cs.valid
  const seedPct = ((100 * dm.seeded) / dm.depth.length).toFixed(1)
  emit('log', [
    `Depth maps: ${img.name} — ${srcUuids.length} sources (best-${imgBestK}), ${dm.width}×${dm.height}, ` +
      `depth ${dm.depthMin.toFixed(2)}–${dm.depthMax.toFixed(2)} (${dm.seeded} seeds, ${seedPct}%), ` +
      `${((100 * valid) / dm.depth.length).toFixed(0)}% with depth, ` +
      `cost median ${cs.median.toFixed(2)} / p95 ${cs.p95.toFixed(2)}, ${(imgMs / 1000).toFixed(1)}s`,
    'info',
    'Dense',
  ])

  const map = {
    uuid: img.uuid,
    name: img.name,
    width: dm.width,
    height: dm.height,
    K: ref.K,
    R: img.R,
    t: img.t,
    // Per-pixel converged plane normals (camera-frame, unit, nz<0). Kept
    // alongside depth for fusion → Poisson meshing. Holes are defined by
    // depth<=0 everywhere downstream, so stale normals under a zeroed depth are
    // harmless and deliberately NOT cleaned up.
    depth: dm.depth,
    cost: dm.cost,
    normals: dm.normals || null,
    rgb,
    displayBlob,
  }
  const planes = [dm.depth.buffer, dm.cost.buffer, rgb.buffer, ...(dm.normals ? [dm.normals.buffer] : [])]
  return { map, planes, cs }
}
