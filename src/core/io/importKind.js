// Decide what a dropped non-image file actually contains, so the sidebar
// drag-and-drop can route it without forcing the user to pick a command first.
//
// The hard case is ground control points vs. camera positions: both are just a
// label followed by an absolute X/Y/Z. We classify confidently when the data
// carries a distinctive signal (pixel observations → GCP, orientation angles →
// pose, intrinsics → sensor), fall back to weak header hints, and otherwise
// report 'ambiguous' so the caller can ask the user.

import { sniffDelimiter, parseRows, guessMapping as guessGcps } from './gcp.js'
import { guessMapping as guessPoses } from './pose.js'
import { guessMapping as guessSensors } from './sensor.js'
import { guessMapping as guessFiducials } from './fiducialObs.js'
import { looksLikeGeoJson, parseGeoJson } from './geojson.js'
import { looksLikeXyzText } from './cloudImport.js'

// GCP-specific vs. image/photo-specific header tokens (the shared 'label' token
// is deliberately excluded — it tells us nothing either way).
const GCP_NAME_TOKEN = /^(name|id|gcp|point|pt)$/i
const IMAGE_TOKEN = /^(image|img|photo|file|filename|picture)$/i
const INTRINSIC_KEYS = ['focal', 'k1', 'k2', 'k3', 'p1', 'p2', 'cx', 'cy', 'pixelSize']

// A COLMAP sparse model is a *set* of files recognised by name, not content —
// `cameras.txt` / `images.txt` / `points3D.txt` (or their `.bin` variants). Detected
// up front so a dropped model file (or `.zip`) routes to the COLMAP importer.
const COLMAP_FILE = /^(cameras|images|points3D)\.(txt|bin)$/i
export function isColmapFile(fileName = '') {
  return COLMAP_FILE.test(String(fileName).split(/[\\/]/).pop() || '')
}

// Returns { kind, confidence } where
//   kind:       'colmap' | 'gcp' | 'footprint' | 'pose' | 'sensor' | 'cloud' | 'ambiguous'
//   confidence: 'high' | 'low'
// 'gcp' and 'footprint' both route through the GeoJSON/GCP importer. NOTE: this
// takes decoded TEXT — binary cloud formats (PLY/LAS) are sniffed by magic bytes
// in the routing layer (sniffCloudFormat) BEFORE the text decode ever happens;
// only text-shaped clouds (a bare numeric xyz table) are detected here.
export function detectFileKind(text, fileName = '') {
  if (isColmapFile(fileName)) return { kind: 'colmap', confidence: 'high' }
  // A pure-numeric 3–7 column table with no header is a point cloud, not a
  // labelled GCP/pose list (those lead with a name/image column). Checked before
  // the delimited-table guessing so xyz files don't land in 'ambiguous'.
  if (looksLikeXyzText(text)) return { kind: 'cloud', confidence: 'low' }
  if (looksLikeGeoJson(fileName, text)) {
    const parsed = parseGeoJson(text)
    // points/mixed are handled by the GCP importer, polygons by the footprint one.
    return { kind: parsed.kind === 'polygons' ? 'footprint' : 'gcp', confidence: 'high' }
  }

  const rows = parseRows(text, sniffDelimiter(text))
  if (!rows.length) return { kind: 'ambiguous', confidence: 'low' }

  const header = rows[0]
  const columnCount = rows.reduce((m, r) => Math.max(m, r.length), 0)

  // Header-only signals: positional fallbacks would fabricate matches (every
  // file gets an image/orientation/focal column by position) and defeat the
  // mutually-distinctive checks below.
  const gcpMap = guessGcps(header, columnCount, true, { positional: false })
  const poseMap = guessPoses(header, columnCount, true, { positional: false })
  const sensorMap = guessSensors(header, columnCount, true, { positional: false })
  const fidMap = guessFiducials(header, columnCount, true, { positional: false })

  // Strong, mutually-distinctive signals.
  const hasPixels = gcpMap.px != null && gcpMap.py != null
  const hasOrientation = poseMap.omega != null || poseMap.phi != null || poseMap.kappa != null
  const hasIntrinsics = INTRINSIC_KEYS.some((k) => sensorMap[k] != null)
  // Fiducial obs hallmark: an image column + a fiducial-id column + px/py, and no
  // ground coordinates (which would make it a GCP). Checked before GCP because a
  // GCP file also carries image+px+py — the fiducial-id column is the tie-breaker.
  const hasFiducialCol = fidMap.fiducial != null && fidMap.image != null && fidMap.px != null && fidMap.py != null
  const hasGroundCoords = gcpMap.x != null && gcpMap.y != null

  if (hasIntrinsics && poseMap.image == null) return { kind: 'sensor', confidence: 'high' }
  if (hasFiducialCol && !hasGroundCoords) return { kind: 'fiducialObs', confidence: 'high' }
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
