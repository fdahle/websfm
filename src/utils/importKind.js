// Decide what a dropped non-image file actually contains, so the sidebar
// drag-and-drop can route it without forcing the user to pick a command first.
//
// The hard case is ground control points vs. camera positions: both are just a
// label followed by an absolute X/Y/Z. We classify confidently when the data
// carries a distinctive signal (pixel observations → GCP, orientation angles →
// pose, intrinsics → sensor), fall back to weak header hints, and otherwise
// report 'ambiguous' so the caller can ask the user.

import { sniffDelimiter, parseRows, guessMapping as guessGcps } from '../core/io/gcp.js'
import { guessMapping as guessPoses } from '../core/io/pose.js'
import { guessMapping as guessSensors } from '../core/io/sensor.js'
import { looksLikeGeoJson, parseGeoJson } from '../core/io/geojson.js'

// GCP-specific vs. image/photo-specific header tokens (the shared 'label' token
// is deliberately excluded — it tells us nothing either way).
const GCP_NAME_TOKEN = /^(name|id|gcp|point|pt)$/i
const IMAGE_TOKEN = /^(image|img|photo|file|filename|picture)$/i
const INTRINSIC_KEYS = ['focal', 'k1', 'k2', 'k3', 'p1', 'p2', 'cx', 'cy', 'pixelSize']

// Returns { kind, confidence } where
//   kind:       'gcp' | 'footprint' | 'pose' | 'sensor' | 'ambiguous'
//   confidence: 'high' | 'low'
// 'gcp' and 'footprint' both route through the GeoJSON/GCP importer.
export function detectFileKind(text, fileName = '') {
  if (looksLikeGeoJson(fileName, text)) {
    const parsed = parseGeoJson(text)
    // points/mixed are handled by the GCP importer, polygons by the footprint one.
    return { kind: parsed.kind === 'polygons' ? 'footprint' : 'gcp', confidence: 'high' }
  }

  const rows = parseRows(text, sniffDelimiter(text))
  if (!rows.length) return { kind: 'ambiguous', confidence: 'low' }

  const header = rows[0]
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0)

  const gcpMap = guessGcps(header, columnCount, true)
  const poseMap = guessPoses(header, columnCount, true)
  const sensorMap = guessSensors(header, columnCount, true)

  // Strong, mutually-distinctive signals.
  const hasPixels = gcpMap.px != null && gcpMap.py != null
  const hasOrientation = poseMap.omega != null || poseMap.phi != null || poseMap.kappa != null
  const hasIntrinsics = INTRINSIC_KEYS.some((k) => sensorMap[k] != null)

  if (hasIntrinsics && poseMap.image == null) return { kind: 'sensor', confidence: 'high' }
  if (hasPixels) return { kind: 'gcp', confidence: 'high' }
  if (hasOrientation) return { kind: 'pose', confidence: 'high' }

  // Bare label + X/Y/Z: lean on header wording if it points one way.
  const cells = header.map((c) => String(c ?? '').trim())
  const looksGcp = cells.some((c) => GCP_NAME_TOKEN.test(c))
  const looksImage = cells.some((c) => IMAGE_TOKEN.test(c))
  if (looksImage && !looksGcp) return { kind: 'pose', confidence: 'low' }
  if (looksGcp && !looksImage) return { kind: 'gcp', confidence: 'low' }

  return { kind: 'ambiguous', confidence: 'low' }
}
