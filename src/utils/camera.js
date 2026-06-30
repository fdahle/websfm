// Decide whether a delimited camera file is intrinsics ('sensor') or exterior
// orientation ('pose'), so the import modal can open in the right mode. The
// modal lets the user override, so this only needs to be a good first guess.

import { sniffDelimiter, parseRows } from '../core/gcp.js'
import { guessMapping as guessSensors } from '../core/sensor.js'
import { guessMapping as guessPoses } from '../core/pose.js'

export function detectCameraMode(text) {
  const delim = sniffDelimiter(text)
  const rows = parseRows(text, delim)
  if (!rows.length) return 'pose'
  const header = rows[0]
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0)

  const poseMap = guessPoses(header, columnCount, true)
  const sensorMap = guessSensors(header, columnCount, true)

  // A per-row image name + position is the hallmark of a pose file. Distortion /
  // focal / sensor-dimension columns mark an intrinsics file.
  const poseHit = poseMap.image != null && (poseMap.omega != null || poseMap.kappa != null || poseMap.phi != null)
  const sensorHit = ['focal', 'k1', 'k2', 'k3', 'p1', 'p2', 'cx', 'cy', 'pixelSize'].some((k) => sensorMap[k] != null)

  if (poseHit) return 'pose'
  if (sensorHit && poseMap.image == null) return 'sensor'
  return 'pose'
}
