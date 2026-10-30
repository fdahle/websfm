// Keep valid depth maps (Build Depth Maps ▸ Keep valid depth maps): which saved maps a
// new run can keep instead of computing them again. Pure.
//
// A saved map is valid while what it was computed from is: the same sparse model's
// camera solution (the index's stamp, which Add to the model ▸ Fixed keeps), the same
// settings that shape a map, and this map's camera exactly as the run handed it to the
// worker (pose, K, lens and film frame: `depthCameraKey`; the map's own meta holds the K
// of its working resolution, so it cannot say). A map whose camera moved, or that has
// none now, is computed again; so are the maps of images the last run did not have. The
// kept maps are filtered again with the new ones.
import { journalKey } from '../runJournal.js'
import { resolveDepthMethod } from './depthMap.js'
import { isDepthIndexStale } from './depthMapCodec.js'

// Settings that only say where and how fast the maps are computed, not what they are.
const MACHINE = new Set(['memBudgetBytes', 'useGpu', 'keepMaps', '_journalMs'])

// The key of the settings that shape a depth map, from what the dialog asked for. Auto
// resolves to the method the run uses (core/dense/depthMap.js resolveDepthMethod).
export function depthMapsKey(settings) {
  const shape = {}
  for (const [k, v] of Object.entries(settings ?? {})) if (!MACHINE.has(k) && v != null) shape[k] = v
  shape.method = resolveDepthMethod(settings?.method ?? 'auto', !!settings?.useGpu)
  return journalKey(shape)
}

// One image's camera as a depth run uses it: { R, t, K, dist, selfCal, fid }.
export const depthCameraKey = (c) =>
  journalKey({ R: c.R, t: c.t, K: c.K, dist: c.dist ?? null, selfCal: c.selfCal ?? null, fid: c.fid ?? null })

// The saved maps a run with `key` can keep: index = the saved depth index (its `maps`,
// stamp, `mapsKey` and `cameraKeys`), cloud = the main sparse cloud, cameraKeys = uuid →
// depthCameraKey of each image the run maps now. → the metas, in the index's order.
export function reusableDepthMaps({ index, cloud, key, cameraKeys }) {
  if (!index?.maps?.length || !cloud || isDepthIndexStale(index, cloud) || index.mapsKey !== key) return []
  const was = index.cameraKeys ?? {}
  return index.maps.filter((m) => cameraKeys[m.uuid] != null && was[m.uuid] === cameraKeys[m.uuid])
}
