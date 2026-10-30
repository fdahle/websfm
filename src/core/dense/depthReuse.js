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
import { resolveDepthMethod, qualityToMaxDim } from './depthMap.js'
import { isDepthIndexStale } from './depthMapCodec.js'

// Settings that only say where and how fast the maps are computed, not what they are.
const MACHINE = new Set(['memBudgetBytes', 'useGpu', 'keepMaps', '_journalMs'])

// What a run with the dialog's settings `s` computes, as the store resolves it
// (stores/reconstruction/dense.js): Auto to the method it runs (`onGpu`: a GPU backend
// actually there), the view selection and passes that method implies, the working
// resolution (`maxDim`: the run's own, after a memory step-down; else derived from
// Quality over the largest original, `nativeLong`), the scene type a blank "Consistent
// views" follows, and the region.
export function depthRunShape(
  s,
  { onGpu = false, nativeLong = 0, sceneType = null, region = null, maxDim = null } = {},
) {
  const method = resolveDepthMethod(s?.method ?? 'auto', onGpu)
  return {
    ...s,
    method,
    viewSelection: s?.viewSelection ?? (method === 'full' ? 'acmh' : 'bestk'),
    planarPrior: s?.planarPrior ?? method === 'full',
    geomPass: s?.geomPass ?? method === 'full',
    maxDim: maxDim ?? (s?.maxDim > 0 ? s.maxDim : qualityToMaxDim(s?.quality, nativeLong)),
    sceneType,
    region: region ? { min: [...region.min], max: [...region.max] } : null,
  }
}

// The key of a run's shape (depthRunShape), without what only says where and how fast
// the maps are computed.
export function depthMapsKey(shape) {
  const out = {}
  for (const [k, v] of Object.entries(shape ?? {})) if (!MACHINE.has(k) && v != null) out[k] = v
  return journalKey(out)
}

// One image's camera as a depth run uses it: { R, t, K, dist, selfCal, fid }, and its
// mask (`mask`: its file's size, or null), which excludes pixels from the map.
export const depthCameraKey = (c) =>
  journalKey({
    R: c.R,
    t: c.t,
    K: c.K,
    dist: c.dist ?? null,
    selfCal: c.selfCal ?? null,
    fid: c.fid ?? null,
    mask: c.maskKey ?? null,
  })

// The saved maps a run with `key` can keep: index = the saved depth index (its `maps`,
// stamp, `mapsKey` and `cameraKeys`), cloud = the main sparse cloud, cameraKeys = uuid →
// depthCameraKey of each image the run maps now. → the metas, in the index's order.
export function reusableDepthMaps({ index, cloud, key, cameraKeys }) {
  if (!index?.maps?.length || !cloud || isDepthIndexStale(index, cloud) || index.mapsKey !== key) return []
  const was = index.cameraKeys ?? {}
  return index.maps.filter((m) => cameraKeys[m.uuid] != null && was[m.uuid] === cameraKeys[m.uuid])
}
