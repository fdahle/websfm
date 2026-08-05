// Dataset profiler (usability track U1).
//
// Classify an image set from METADATA ONLY — no pixel reads. Everything here is
// derivable from what ingest already extracted (`img.meta` from
// `core/io/metadata.js`), the sensor list, imported poses and GCPs. The output
// is the input `core/recommend.js` (U2) turns into recommended settings, and
// every decision carries a `notes[]` rationale so the derivation is auditable in
// the same "log every derived value" spirit as the rest of the pipeline.
//
// Pure: plain data in, plain data out. No Vue/Pinia/OPFS/DOM.

/** @typedef {import('./types').DatasetProfile} DatasetProfile */

// Known camera-make fingerprints. Kept deliberately small and case-insensitive —
// a substring hit is a *hint* that feeds a note, never a hard gate on its own.
const DRONE_MAKES = ['dji', 'parrot', 'autel', 'skydio', 'yuneec', 'sensefly']
// DJI writes the airframe under Make="DJI"/"Hasselblad" with model codes like
// "FC6310"; the leading "FC" (flight camera) is the reliable token.
const DRONE_MODEL_RE = /\bFC\d{3,4}\b/i
const PHONE_MAKES = ['apple', 'samsung', 'google', 'xiaomi', 'huawei', 'oneplus', 'oppo', 'vivo', 'motorola', 'nokia']

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
const longEdge = (m) => (isFiniteNum(m?.width) && isFiniteNum(m?.height) ? Math.max(m.width, m.height) : null)
const megapixels = (m) => (isFiniteNum(m?.width) && isFiniteNum(m?.height) ? (m.width * m.height) / 1e6 : null)

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// A sensor is "calibrated" for distortion once any Brown–Conrady coefficient is a
// declared, non-zero number. A null (unknown) or an explicit 0 (pinhole) does not
// count — self-calibration would still have to solve for it.
function sensorHasDistortion(s) {
  return ['k1', 'k2', 'k3', 'p1', 'p2'].some((k) => isFiniteNum(s?.[k]) && s[k] !== 0)
}

// Do the image names look like a capture sequence (a flight strip / video frames)?
// Signal: most names carry a trailing integer and, sorted by it, those integers
// form a mostly-monotonic run. This is what lets sequential matching (capture-order
// window) kick in when no poses/GPS exist.
function detectSequentialNames(names) {
  const nums = []
  for (const name of names) {
    const m = String(name).match(/(\d+)(?!.*\d)/) // last run of digits
    if (m) nums.push(Number(m[1]))
  }
  if (names.length < 3) return false
  // Need a numeric suffix on a clear majority, else it isn't a naming scheme.
  if (nums.length < names.length * 0.8) return false
  const sorted = [...nums].sort((a, b) => a - b)
  // Count strictly increasing steps that are "small" (contiguous-ish). Duplicates
  // or huge jumps break the run.
  let steps = 0
  for (let i = 1; i < sorted.length; i++) {
    const d = sorted[i] - sorted[i - 1]
    if (d >= 1 && d <= 10) steps++
  }
  return steps >= (sorted.length - 1) * 0.7
}

// Coarse size bucket for budget decisions (U2/C1). Distinct from `medianMP`
// (per-image resolution) — this is about how many images the run has to chew.
function sizeBucket(n) {
  if (n < 20) return 'small'
  if (n <= 200) return 'medium'
  return 'large'
}

/**
 * Profile a dataset from metadata alone.
 *
 * @param {object} input
 * @param {Array<{ name?: string, sensorId?: string|null, meta?: any }>} input.images
 * @param {Array<{ id?: string, kind?: string, k1?: number|null, k2?: number|null,
 *   k3?: number|null, p1?: number|null, p2?: number|null }>} [input.sensors]
 * @param {Array<any>} [input.poses]  imported camera poses (any non-empty ⇒ hasPoses)
 * @param {Array<any>} [input.gcps]   ground control points
 * @returns {DatasetProfile}
 */
export function profileDataset({ images = [], sensors = [], poses = [], gcps = [] } = {}) {
  const notes = []
  const nImages = images.length

  const longEdges = images.map((i) => longEdge(i.meta)).filter(isFiniteNum)
  const mps = images.map((i) => megapixels(i.meta)).filter(isFiniteNum)
  const minDim = longEdges.length ? Math.min(...longEdges) : null
  const maxDim = longEdges.length ? Math.max(...longEdges) : null
  const medianMP = median(mps)

  if (!longEdges.length) {
    notes.push('No image dimensions available — cannot size detection/quality; using conservative defaults downstream.')
  } else if (minDim != null && maxDim != null && maxDim > minDim * 1.5) {
    notes.push(`Mixed resolutions (${minDim}–${maxDim} px long edge) — a per-image detection cap may over/under-shoot some images.`)
  }
  if (medianMP != null) notes.push(`Median ${medianMP.toFixed(1)} MP across ${nImages} image(s).`)

  const hasGps = images.some((i) => isFiniteNum(i.meta?.gpsLat) && isFiniteNum(i.meta?.gpsLon))
  const hasPoses = (poses?.length ?? 0) > 0
  if (hasPoses) notes.push(`${poses.length} camera position(s) present — proximity preselection + georef seeds available.`)
  else if (hasGps) notes.push('EXIF GPS present — synchronizing project-CRS camera positions for proximity preselection.')

  const hasCalibratedDistortion = (sensors ?? []).some(sensorHasDistortion)
  if (hasCalibratedDistortion) notes.push('A sensor declares non-zero lens distortion — self-cal can start from it rather than from scratch.')

  const nGcps = gcps?.length ?? 0
  if (nGcps >= 3) notes.push(`${nGcps} GCP(s) — GCP-anchored BA + georeferencing available.`)

  // ── kind classification ──────────────────────────────────────────────────
  // Sensor-declared film wins outright (fiducial interior orientation, F4).
  const filmSensor = (sensors ?? []).some((s) => s?.kind === 'film')
  const makes = images.map((i) => String(i.meta?.make ?? '').toLowerCase()).filter(Boolean)
  const models = images.map((i) => String(i.meta?.model ?? '')).filter(Boolean)
  const anyExif = images.some((i) => i.meta?.make || i.meta?.model || isFiniteNum(i.meta?.focalLength))

  const droneHit = makes.some((mk) => DRONE_MAKES.some((d) => mk.includes(d))) || models.some((md) => DRONE_MODEL_RE.test(md))
  const phoneHit = makes.some((mk) => PHONE_MAKES.some((p) => mk.includes(p)))

  let kind = 'unknown'
  if (filmSensor) {
    kind = 'film'
    notes.push('Classified film: a sensor is kind:"film" (scanned imagery, fiducial interior orientation).')
  } else if (!anyExif && nImages >= 2) {
    // No make/model/focal anywhere is the signature of scanned aerial film — the
    // scanner strips EXIF. Only a hint (a bare-EXIF digital set looks the same),
    // so it is the weakest film verdict and stays overridable.
    kind = 'film'
    notes.push('Classified film (tentative): no EXIF make/model/focal on any image — typical of scanned film; override if these are digital photos.')
  } else if (droneHit) {
    kind = 'drone'
    notes.push('Classified drone: camera make/model matches a known UAV (proximity preselection + georef from GPS apply).')
  } else if (phoneHit) {
    kind = 'phone'
    notes.push('Classified phone: camera make matches a known smartphone vendor.')
  } else {
    notes.push('Camera kind unknown — EXIF present but make/model unrecognised; treating as a generic digital camera.')
  }

  const scale = sizeBucket(nImages)
  const sequentialNames = detectSequentialNames(images.map((i) => i.name ?? ''))
  if (sequentialNames) notes.push('Image names are sequential — capture-order (sequential) matching can prune pairs even without poses.')

  return {
    nImages,
    minDim,
    maxDim,
    medianMP,
    kind,
    hasGps,
    hasPoses,
    hasCalibratedDistortion,
    sequentialNames,
    scale,
    notes,
  }
}
