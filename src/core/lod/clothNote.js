// The streamed ground filter's word on its tiles (core/lod/transform.js editTile): each
// tile coarsens its own cloth past groundFilter.js's particle cap, and counts the classes
// it wrote. Pure, and small, so the store can import it.
import { GROUND_FILTER_LIMITS } from '../products/groundFilter.js'

/**
 * The ground filter's log line about its tiles' cloths (editTile's `cloth`, in the cloud's
 * units) when any was coarser than asked (`asked`, metres; `metresPerUnit`), or null.
 */
export function clothNote(cloths, asked, metresPerUnit = 1) {
  const used = cloths.filter((r) => r != null).map((r) => r * metresPerUnit)
  const coarser = used.filter((r) => r > asked * (1 + 1e-9))
  if (!coarser.length) return null
  return (
    `Ground filter: ${coarser.length} of ${used.length} tiles would have needed more than ${GROUND_FILTER_LIMITS.maxParticles.toLocaleString('en-US')} cloth cells at ` +
    `${asked} m and used a coarser cloth (up to ${Number(Math.max(...coarser).toPrecision(3))} m); a coarser cloth resolution ` +
    'keeps every tile alike'
  )
}

/** The points of each class Classify Points writes (LAS codes 2–6), from a classification. */
export function countClasses(classification) {
  const n = new Uint32Array(8)
  for (const c of classification ?? []) if (c < 8) n[c]++
  return { ground: n[2], low: n[3], medium: n[4], high: n[5], building: n[6] }
}

/** Classify Points' log line for a streamed run, from its tiles' counts. */
export function classCountsLine(list) {
  const t = { ground: 0, low: 0, medium: 0, high: 0, building: 0 }
  for (const c of list) for (const k of Object.keys(t)) t[k] += c?.[k] ?? 0
  const f = (v) => v.toLocaleString('en-US')
  const above = t.low + t.medium + t.high + t.building
  return (
    `Ground filter: ${f(t.ground)} ground points` +
    (above ? `; ${f(t.building)} building, vegetation ${f(t.low)} low, ${f(t.medium)} medium, ${f(t.high)} high` : '')
  )
}
