// What a length means on a given cloud or mesh — the one rule every Point Cloud ▾
// / Mesh ▾ tool uses to label its distance fields and its results. Pure.
//
// A computed cloud lives in the SfM frame: its numbers are model units until the
// project's resolved frame supplies metres (georeference > scale bars > none — the
// store's `currentFrameSignature`, see stores/reconstruction/frames.js). An
// IMPORTED cloud landed verbatim, in whatever units its file used (CLAUDE.md:
// "coordinates land verbatim in the current frame"), so no project scale applies
// to it and nothing may relabel its numbers as metres. "Never fabricate a metre."

/**
 * @param {object} cloud   the cloud/mesh record (only `imported` is read)
 * @param {{ source: string|null, scale: number }} signature  currentFrameSignature
 * @returns {{ scale: number, unit: 'm'|'model'|'source', label: string }}
 *   `scale` converts a length in the cloud's coordinates to the labelled unit:
 *   labelled = coordinate length × scale (areas × scale², volumes × scale³).
 */
export function cloudUnits(cloud, signature) {
  if (cloud?.imported) return { scale: 1, unit: 'source', label: 'file units' }
  if (signature?.source && signature.scale > 0) return { scale: signature.scale, unit: 'm', label: 'm' }
  return { scale: 1, unit: 'model', label: 'model units' }
}

/** A length typed in the labelled unit, as a coordinate length on the cloud. */
export function toCoordLength(value, units) {
  return Number.isFinite(value) ? value / units.scale : value
}

/** A coordinate length on the cloud, in the labelled unit. */
export function fromCoordLength(value, units) {
  return Number.isFinite(value) ? value * units.scale : value
}

/** Format a length/area/volume with its unit; never a bare number. */
export function formatMeasure(value, units, power = 1, digits = 3) {
  if (!Number.isFinite(value)) return '—'
  const v = value * units.scale ** power
  const suffix = units.unit === 'm' ? (power === 1 ? 'm' : power === 2 ? 'm²' : 'm³')
    : `${units.label}${power === 1 ? '' : power === 2 ? '²' : '³'}`
  return `${v.toLocaleString(undefined, { maximumFractionDigits: digits })} ${suffix}`
}
