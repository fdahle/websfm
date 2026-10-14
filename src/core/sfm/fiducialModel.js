// Domain boundary between anonymous image-space detections and metric camera
// calibration. Pure so restore/import/reconstruction share one interpretation.

export const CORNER_SLOTS = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl']
export const SIDE_SLOTS = ['side-top', 'side-right', 'side-bottom', 'side-left']

export function slotsForPositions(positions = 'corners') {
  if (positions === 'sides') return [...SIDE_SLOTS]
  if (positions === 'corners+sides') return [...CORNER_SLOTS, ...SIDE_SLOTS]
  return [...CORNER_SLOTS]
}

export function slotUnitPoint(slot) {
  return {
    'corner-tl': { x: 0, y: 0 }, 'corner-tr': { x: 1, y: 0 },
    'corner-br': { x: 1, y: 1 }, 'corner-bl': { x: 0, y: 1 },
    'side-top': { x: 0.5, y: 0 }, 'side-right': { x: 1, y: 0.5 },
    'side-bottom': { x: 0.5, y: 1 }, 'side-left': { x: 0, y: 0.5 },
  }[slot] ?? null
}

export function classifyDetectionSlot(px, py, width, height, allowed = [...CORNER_SLOTS, ...SIDE_SLOTS]) {
  if (!(width > 0) || !(height > 0)) return null
  const x = px / width, y = py / height
  let best = null, dist = Infinity
  for (const slot of allowed) {
    const p = slotUnitPoint(slot)
    const d = Math.hypot(x - p.x, y - p.y)
    if (d < dist) { dist = d; best = slot }
  }
  return best
}

// A film sensor's one fiducial record (`sensor.fiducialCalibration`): the camera
// certificate (marks in mm, focal, principal point) plus how the raster slots map
// onto it. Certificate marks entered before calibration live here too, with an
// empty slot map and no fit — so the sensor table, the importers and Calibrate
// fiducials all edit the values reconstruction reads.
export function emptyFiducialCalibration(focalMm = 0) {
  return {
    version: 1, method: 'certificate', transform: 'affine', allowReflection: false,
    slotMap: {}, marks: [], focalMm, ppxMm: 0, ppyMm: 0, scanPitchMm: null, fit: null,
  }
}

// Calibrated = at least one raster slot maps onto a certificate mark. A record
// holding only typed certificate marks is not, so slots stay the image-view marks.
export function isFiducialCalibrated(cal) {
  return !!cal?.marks?.length && Object.values(cal.slotMap || {}).some(Boolean)
}

export function calibratedFiducialPairs(image, sensor) {
  const cal = sensor?.fiducialCalibration
  if (!cal?.marks?.length || !cal.slotMap) return []
  const byId = new Map(cal.marks.map((m) => [m.id, m]))
  return (image?.fiducialDetections || []).flatMap((d) => {
    const fidId = cal.slotMap[d.slot], m = byId.get(fidId)
    return m ? [{ slot: d.slot, fidId, px: d.px, py: d.py, xMm: m.xMm, yMm: m.yMm }] : []
  })
}

const NAMED_SLOTS = new Set([...CORNER_SLOTS, ...SIDE_SLOTS])
const isSlotId = (id) => NAMED_SLOTS.has(id) || String(id).startsWith('custom-')

// Imported mark-id observations (`{ fidId, px, py }`, a file row) → anonymous
// detections. An id that already names a slot keeps it, so a websfm export
// round-trips; any other id (a certificate id like "F1") is placed by position and
// kept as `markId`, which Calibrate fiducials offers as that slot's mapping.
export function observationsToDetections(obs, width, height, { family = 'generic', source = 'import' } = {}) {
  const allowed = obs.length > 4 ? [...CORNER_SLOTS, ...SIDE_SLOTS] : CORNER_SLOTS
  return obs.map((o) => {
    const named = isSlotId(o.fidId)
    return {
      slot: named ? o.fidId : (classifyDetectionSlot(o.px, o.py, width, height, allowed) ?? `custom-${o.fidId}`),
      px: o.px, py: o.py, family, source, confidence: 1, reviewed: true,
      ...(named ? {} : { markId: o.fidId }),
    }
  })
}
