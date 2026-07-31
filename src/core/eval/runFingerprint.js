// Cheap deterministic fingerprints for diagnostics baselines. These are not security
// hashes; they answer whether two runs consumed the same feature coordinates and
// verified-match payload, which counts/settings alone cannot establish.

const OFFSET = 0x811c9dc5
const PRIME = 0x01000193
const mix = (h, n) => Math.imul(h ^ (n >>> 0), PRIME) >>> 0
const mixString = (h, s) => {
  s = String(s ?? '')
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i))
  return h
}
const hex = (h) => h.toString(16).padStart(8, '0')
const q = (v) => Number.isFinite(v) ? Math.round(v * 1000) : 0x7fffffff

export function featureFingerprint(images = []) {
  let h = OFFSET
  const rows = [...images].sort((a, b) => String(a.uuid).localeCompare(String(b.uuid)))
  for (const im of rows) {
    h = mixString(h, im.uuid); h = mixString(h, im.name)
    h = mix(h, im.keypoints?.length ?? im.kpCount ?? 0)
    for (const kp of im.keypoints || []) { h = mix(h, q(kp.x)); h = mix(h, q(kp.y)) }
  }
  return `fnv1a32:${hex(h)}`
}

export function matchFingerprint(entries = []) {
  let h = OFFSET
  const rows = [...entries].sort((a, b) => `${a.idA}--${a.idB}`.localeCompare(`${b.idA}--${b.idB}`))
  for (const e of rows) {
    h = mixString(h, e.idA); h = mixString(h, e.idB); h = mixString(h, e.status)
    h = mix(h, e.rawCount ?? 0); h = mix(h, e.inlierCount ?? 0)
    h = mix(h, e.weak ? 1 : 0); h = mix(h, e.disabled ? 1 : 0)
    for (const pair of e.matches || []) { h = mix(h, pair[0] ?? 0); h = mix(h, pair[1] ?? 0) }
  }
  return `fnv1a32:${hex(h)}`
}

export function buildRunFingerprints(images, matches) {
  return {
    algorithm: 'fnv1a32; keypoints quantized to 0.001px',
    features: featureFingerprint(images),
    matches: matchFingerprint(matches),
  }
}
