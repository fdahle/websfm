// The streamed ground filter's word on its tiles' cloths (core/lod/transform.js
// editTile): each tile coarsens its own cloth past groundFilter.js's particle cap. Pure,
// and small, so the store can import it.
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
