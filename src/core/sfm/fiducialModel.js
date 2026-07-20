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

export function calibratedFiducialPairs(image, sensor) {
  const cal = sensor?.fiducialCalibration
  if (cal?.marks?.length && cal.slotMap) {
    const byId = new Map(cal.marks.map((m) => [m.id, m]))
    return (image?.fiducialDetections || []).flatMap((d) => {
      const fidId = cal.slotMap[d.slot], m = byId.get(fidId)
      return m ? [{ slot: d.slot, fidId, px: d.px, py: d.py, xMm: m.xMm, yMm: m.yMm }] : []
    })
  }
  // One-release compatibility for pre-split projects.
  const marks = sensor?.fiducials?.marks || []
  const byId = new Map(marks.map((m) => [m.id, m]))
  return (image?.fiducialObs || []).flatMap((o) => {
    const m = byId.get(o.fidId)
    return m ? [{ slot: null, fidId: o.fidId, px: o.px, py: o.py, xMm: m.xMm, yMm: m.yMm }] : []
  })
}

export function migrateLegacyFiducialImage(image, sensor) {
  if (image?.fiducialDetections?.length || !image?.fiducialObs?.length) return image?.fiducialDetections || []
  const width = image.meta?.width, height = image.meta?.height
  const allowed = image.fiducialObs.length > 4 ? [...CORNER_SLOTS, ...SIDE_SLOTS] : CORNER_SLOTS
  return image.fiducialObs.map((o) => ({
    slot: classifyDetectionSlot(o.px, o.py, width, height, allowed) ?? `custom-${o.fidId}`,
    px: o.px, py: o.py, family: 'legacy', source: 'manual', confidence: 1, reviewed: true,
    legacyFidId: o.fidId,
  }))
}

export function deriveLegacyCalibration(sensor, detections = []) {
  if (sensor?.fiducialCalibration || !sensor?.fiducials?.marks?.length) return sensor?.fiducialCalibration ?? null
  const slotMap = {}
  for (const d of detections) if (d.legacyFidId && !slotMap[d.slot]) slotMap[d.slot] = d.legacyFidId
  const f = sensor.fiducials
  return {
    version: 1, method: 'certificate', transform: 'affine', allowReflection: false,
    slotMap, marks: f.marks.map((m) => ({ ...m })), focalMm: f.focalMm,
    ppxMm: f.ppxMm ?? 0, ppyMm: f.ppyMm ?? 0, scanPitchMm: null,
    fit: null, legacy: true,
  }
}

