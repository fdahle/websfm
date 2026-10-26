// What each step of Build Depth Maps does to this project (DepthMapsModal.vue): the
// one-line effects under its numbered steps, from the same rules the run applies
// (stores/reconstruction/dense.js resolves Quality with qualityToMaxDim over the
// largest original image).
import { qualityToMaxDim } from '../dense/depthMap.js'
import { autoMinConsistent } from '../dense/geomFilter.js'
import { DEPTHMAP_QUALITY_META } from '../defaults.user.js'
import { fmtCount, plural } from './format.js'

const FRACTION = { low: '⅛', medium: '¼', high: '½', ultra: 'all' }

// project: { registered (images with a pose), nativeLong (largest original long side, px),
//            sceneType (what a blank "Consistent views" resolves to) }
export function depthMapEffects(s, { registered = 0, nativeLong = 0, sceneType = null } = {}) {
  const override = s.maxDim > 0
  const maxDim = override ? s.maxDim : qualityToMaxDim(s.quality, nativeLong)
  const label = DEPTHMAP_QUALITY_META.find((q) => q.id === s.quality)?.label ?? s.quality
  const how = override
    ? 'fixed here'
    : s.quality === 'ultra'
      ? `${label}: the originals' own size`
      : `${label}: ${FRACTION[s.quality] ?? '¼'} of the largest original, ${fmtCount(nativeLong)} px`
  const k = s.bestK > 0 ? `the best ${Math.min(s.bestK, s.maxSources)}` : 'the better half of them (1–4)'
  const resolution = !registered
    ? 'Build the sparse model first: a depth map is computed for each registered image.'
    : `${plural(registered, 'depth map')}, one per registered image, at up to ${fmtCount(maxDim)} px on the long ` +
      `side (${how}). Each is matched against up to ${plural(s.maxSources, 'neighbour')} sharing the most tie ` +
      `points; per pixel, ${k} are averaged. If that does not fit the memory budget (Settings ▸ Compute), the ` +
      'run steps down a quality and says so.'

  const d = 2 * s.window + 1
  const patchMatch =
    `A ${d}×${d} px correlation window; ${plural(s.iterations, 'propagation sweep')} at the finest level, ` +
    'more at the coarser ones.'

  const speckle = s.speckleFilter
    ? `Pixels more than ${s.filterRelTol} % from the median depth around them are dropped, and the rest ` +
      'smoothed to it, map by map.'
    : 'Off: each depth map goes on as PatchMatch left it.'

  const angle = s.minGeomAngleDeg > 0 ? `, seen at least ${s.minGeomAngleDeg}° apart,` : ''
  const auto = !(s.minConsistent > 0)
  const views = auto ? autoMinConsistent(sceneType) : s.minConsistent
  const autoNote = auto
    ? ` (auto for ${sceneType === 'object' ? 'an object capture' : 'an aerial / mapping'} project)`
    : ''
  const crossView = s.geomConsistency
    ? `A pixel stays only if at least ${plural(views, 'other view')}${autoNote} agree${views === 1 ? 's' : ''} on its depth within ` +
      `${s.maxGeomCost} px${angle} and its match scores an NCC of ${s.minNcc} or more. Runs once all maps exist.`
    : 'Off: no pixel is checked against other views, so sky and vegetation freckles reach the dense cloud.'

  return { resolution, patchMatch, speckle, crossView }
}
