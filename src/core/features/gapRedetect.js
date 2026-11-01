// Detecting the photos around a gap again at full size: which ones, and with what
// settings. Pure.
//
// Bridge repair (bridgeRepair.js) matches the pairs between a piece and the main block
// again with looser gates. When the photos were detected well under their own size,
// those pairs can fail however loose the gates: the features that would join them are
// finer than the detection saw. Starbuck's 10,400 px film scans, detected at 0.385× by
// auto resolution, left 46 photos in two flight lines hanging on the block by 3 pairs of
// 16–21 inliers; bridge repair matched 24 pairs between them again and accepted none.
// Detected at full size (tiled, ≤40,000 keypoints), the same 46 photos and 30 photos of
// the main block posed 32 of the 46, where the whole block at full size took 41 minutes
// of detection instead of 5.
//
// So when pieces are still apart after bridge repair, their SIFT photos detected at under
// `maxScale` of their size are detected again at full size, with `partnerShare` as many
// photos of the main block: those with candidate pairs (any pair matched, whatever its
// outcome) to the most of them, the most putatives breaking ties. A partner already at
// full size keeps its features. When the gap photos alone would be more than `maxShare`
// of the block, detecting every photo at full size is the better run, and nothing is
// planned; the partners are trimmed to stay within it.

/**
 * @param {object} args
 * @param {Array<{ ids: string[], target: Set<string> }>} args.pieces from graphPieces
 * @param {Array<{ idA, idB, rawCount?, disabled? }>} args.entries the pairs matched
 * @param {Map<string, { detector?: string, detectScale?: number }>} args.images by id
 * @param {number} args.imageCount the photos that took part in matching
 * @param {{ maxScale?: number, partnerShare?: number, maxShare?: number }} [args.opts]
 * @returns {{ loose: string[], partners: string[], skipped: null | 'none' | 'native' | 'learned' | 'many',
 *   apart: number, scale: number | null }} `apart` counts every photo of the pieces,
 *   `scale` is the median detection scale of `loose`
 */
export function planGapRedetect({ pieces, entries, images, imageCount, opts = {} }) {
  const { maxScale = 0.8, partnerShare = 0.65, maxShare = 0.5 } = opts
  const apart = pieces.reduce((n, p) => n + p.ids.length, 0)
  const out = { loose: [], partners: [], skipped: null, apart, scale: null }
  if (!apart) return { ...out, skipped: 'none' }
  const sift = (id) => (images.get(id)?.detector ?? 'sift') === 'sift'
  const small = (id) => (images.get(id)?.detectScale ?? 1) < maxScale
  const all = pieces.flatMap((p) => p.ids)
  const loose = all.filter((id) => sift(id) && small(id))
  if (!loose.length) return { ...out, skipped: all.some(sift) ? 'native' : 'learned' }
  if (loose.length > maxShare * imageCount) return { ...out, skipped: 'many' }
  const scales = loose.map((id) => images.get(id).detectScale).sort((a, b) => a - b)
  out.scale = scales[scales.length >> 1]
  out.loose = loose

  // Partners: photos of the main block (a piece's target) by how many gap photos they
  // have candidate pairs with.
  const inLoose = new Set(loose)
  const targetOf = new Map()
  for (const p of pieces) for (const id of p.ids) targetOf.set(id, p.target)
  const score = new Map() // id → { photos: Set, raw }
  for (const e of entries) {
    if (e.disabled) continue
    const [gap, other] = inLoose.has(e.idA) ? [e.idA, e.idB] : inLoose.has(e.idB) ? [e.idB, e.idA] : []
    if (!gap || inLoose.has(other) || !targetOf.get(gap)?.has(other)) continue
    const s = score.get(other) ?? { photos: new Set(), raw: 0 }
    s.photos.add(gap)
    s.raw += e.rawCount ?? 0
    score.set(other, s)
  }
  const room = Math.floor(maxShare * imageCount) - loose.length
  const want = Math.min(room, Math.ceil(partnerShare * loose.length))
  out.partners = [...score]
    .sort(([a, p], [b, q]) => q.photos.size - p.photos.size || q.raw - p.raw || (a < b ? -1 : 1))
    .slice(0, Math.max(0, want))
    .map(([id]) => id)
    .filter((id) => sift(id) && small(id))
  return out
}

/**
 * Detection settings for detecting `images` again at full size: the settings their
 * features were detected with (detectSettings of the first, as one run gives them all),
 * at the largest native size, tiled, with the keypoint cap scaled with the area
 * (1 / scale²) up to `maxKeypoints`.
 * @param {Array<{ detectSettings?: object, detectScale?: number, meta?: { width, height } }>} images
 */
export function gapDetectSettings(images, { maxKeypoints = 40000 } = {}) {
  const base = images.find((im) => im.detectSettings)?.detectSettings ?? {}
  const nativeMax = Math.max(...images.map((im) => Math.max(im.meta?.width || 0, im.meta?.height || 0)))
  const scale = Math.min(...images.map((im) => im.detectScale ?? 1))
  const cap = base.maxKeypointsEffective ?? base.maxKeypoints ?? 8000
  return {
    detector: 'sift',
    maxDimMode: 'absolute',
    maxDim: nativeMax,
    tiling: 'on',
    maxKeypoints: Math.min(maxKeypoints, Math.round(cap / (scale * scale))),
    ...(base.contrastThreshold != null ? { contrastThreshold: base.contrastThreshold } : {}),
    ...(base.maxOrientations != null ? { maxOrientations: base.maxOrientations } : {}),
    ...(base.capRule != null ? { capRule: base.capRule } : {}),
  }
}
