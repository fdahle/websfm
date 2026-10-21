// Cheap deterministic fingerprints for diagnostics baselines. These are not security
// hashes; they answer whether two runs consumed the same feature coordinates and
// verified-match payload, which counts/settings alone cannot establish.
//
// Incremental, because the data is not resident: keypoints and matches load per
// image / per pair on demand (TODO ▸ SC-2/SC-3). A caller visits the rows in
// `featureRows` / `matchRows` order and feeds each one's data; `buildRunFingerprints`
// is the same walk over data already in hand (tests, small inputs).

import { asKeypoints } from '../features/keypoints.js'
const OFFSET = 0x811c9dc5
const PRIME = 0x01000193
const mix = (h, n) => Math.imul(h ^ (n >>> 0), PRIME) >>> 0
const mixString = (h, s) => {
  s = String(s ?? '')
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i))
  return h
}
const hex = (h) => h.toString(16).padStart(8, '0')
const q = (v) => (Number.isFinite(v) ? Math.round(v * 1000) : 0x7fffffff)

/** The images in the order the feature fingerprint visits them. */
export const featureRows = (images = []) => [...images].sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)))

/** The match entries in the order the match fingerprint visits them. */
export const matchRows = (entries = []) =>
  [...entries].sort((a, b) => `${a.idA}--${a.idB}`.localeCompare(`${b.idA}--${b.idB}`))

/** add(image, keypoints | null) per row of featureRows, then digest(). */
export function featureHasher() {
  let h = OFFSET
  return {
    add(im, keypoints) {
      const kps = keypoints ? asKeypoints(keypoints) : null
      h = mixString(h, im.uuid)
      h = mixString(h, im.name)
      h = mix(h, kps?.length ?? im.kpCount ?? 0)
      for (let k = 0; k < (kps?.length ?? 0); k++) {
        h = mix(h, q(kps.x(k)))
        h = mix(h, q(kps.y(k)))
      }
    },
    digest: () => `fnv1a32:${hex(h)}`,
  }
}

/** add(entry, matches) per row of matchRows, then digest(). `matches`: flat Uint32Array or [[ia, ib], …]. */
export function matchHasher() {
  let h = OFFSET
  return {
    add(e, matches) {
      h = mixString(h, e.idA)
      h = mixString(h, e.idB)
      h = mixString(h, e.status)
      h = mix(h, e.rawCount ?? 0)
      h = mix(h, e.inlierCount ?? 0)
      h = mix(h, e.weak ? 1 : 0)
      h = mix(h, e.enabled === false ? 1 : 0)
      // Flat [ia, ib, …] (the store's shape) hashes the same sequence as [[ia, ib], …].
      if (matches instanceof Uint32Array) for (let i = 0; i < matches.length; i++) h = mix(h, matches[i])
      else
        for (const pair of matches || []) {
          h = mix(h, pair[0] ?? 0)
          h = mix(h, pair[1] ?? 0)
        }
    },
    digest: () => `fnv1a32:${hex(h)}`,
  }
}

export const FINGERPRINT_ALGORITHM = 'fnv1a32; keypoints quantized to 0.001px'

// Over data in hand: images carrying `keypoints`, entries carrying `matches`.
export function featureFingerprint(images = []) {
  const f = featureHasher()
  for (const im of featureRows(images)) f.add(im, im.keypoints ?? null)
  return f.digest()
}

export function matchFingerprint(entries = []) {
  const m = matchHasher()
  for (const e of matchRows(entries)) m.add(e, e.matches)
  return m.digest()
}

export function buildRunFingerprints(images, matches) {
  return {
    algorithm: FINGERPRINT_ALGORITHM,
    features: featureFingerprint(images),
    matches: matchFingerprint(matches),
  }
}
