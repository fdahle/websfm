// Which keypoints survive the per-image cap.
//
// 'response' keeps the strongest |DoG| response, which is how the crate truncated
// historically. At high resolution that fills the budget with fine-scale texture
// (brick, foliage): on South Building at native size, 85 % of the response-ranked
// 25k keypoints have σ < 4 px. Those stop matching first under a change of viewpoint
// or scale, and repetitive texture is exactly what the ratio test discards.
//
// 'coarse-first' keeps the largest scales and cuts the finest, COLMAP's rule (it keeps
// whole DoG octaves from the coarsest down). Large blobs are more repeatable across
// views and more distinctive. Ties are broken by response, so within the octave the
// cap cuts through, the strongest survive. Unlike COLMAP's whole-octave rule the cap
// stays hard: matching is O(Na·Nb), so it must be an exact budget.
//
// The kept set is returned in response order regardless of the rule: downstream code
// (LightGlue's prefix cap, guided tiles, the sparse colour pass) assumes best-first.

export const CAP_RULES = Object.freeze(['response', 'coarse-first'])

/**
 * Indices of the keypoints to keep, strongest response first.
 *
 * Orientation siblings (bit-identical scale and response) sort adjacently under
 * either rule, because both sorts are stable.
 *
 * @param {{response:number, scale?:number}[]} items
 * @param {number} cap  0 or negative ⇒ keep all
 * @param {'response'|'coarse-first'} [rule]
 * @returns {number[]}
 */
export function capOrder(items, cap, rule = 'response') {
  const byResponse = (a, b) => items[b].response - items[a].response
  const idx = Array.from({ length: items.length }, (_, i) => i)
  if (!(cap > 0) || items.length <= cap) return idx.sort(byResponse)
  if (rule === 'coarse-first') {
    idx.sort((a, b) => (items[b].scale ?? 0) - (items[a].scale ?? 0) || byResponse(a, b))
    return idx.slice(0, cap).sort(byResponse)
  }
  return idx.sort(byResponse).slice(0, cap)
}

/**
 * The value the cap cut at, for the detection log: the weakest kept response, or
 * under 'coarse-first' the smallest kept scale.
 *
 * @returns {{minResponse:number, minScale:number}}
 */
export function capBoundary(items, kept) {
  let minResponse = Infinity, minScale = Infinity
  for (const i of kept) {
    if (items[i].response < minResponse) minResponse = items[i].response
    if ((items[i].scale ?? Infinity) < minScale) minScale = items[i].scale
  }
  return { minResponse: kept.length ? minResponse : 0, minScale: Number.isFinite(minScale) ? minScale : 0 }
}
