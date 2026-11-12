// Format migration 3 → 4, frozen (core/formatMigrations.js). The step gives every sparse
// cloud the frame model the project's run summary and sensor table gave it at version 3.
// It is a copy of what displayFrame.js makeFrameModelResolver (the summary join),
// calibrationSnapshot and distortion.js distortionOf did then, kept here unchanged on
// purpose: a later change to how the app resolves a lens must not change what an old
// project migrates to. Do not import live code into this file; formatMigrations.test.js
// pins its output on the committed v3 fixture.

// distortion.js at version 3: each model's family and live coefficients.
const MODELS = {
  pinhole: { family: 'brown', coeffs: [] },
  radial: { family: 'brown', coeffs: ['k1'] },
  radial2: { family: 'brown', coeffs: ['k1', 'k2'] },
  brown: { family: 'brown', coeffs: ['k1', 'k2', 'k3', 'p1', 'p2'] },
  rational: { family: 'brown', coeffs: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'p1', 'p2'] },
  fisheye1: { family: 'fisheye', coeffs: ['k1'] },
  fisheye2: { family: 'fisheye', coeffs: ['k1', 'k2'] },
  fisheye: { family: 'fisheye', coeffs: ['k1', 'k2', 'k3', 'k4'] },
}
const BROWN_COEFFS = ['k1', 'k2', 'k3', 'p1', 'p2']
const hasDistortion = (d) => !!d && !!(d.fisheye || d.k1 || d.k2 || d.k3 || d.p1 || d.p2 || d.k4 || d.k5 || d.k6)

function distortionOf(sensor) {
  if (!sensor) return null
  const model = MODELS[sensor.distortionModel]
  const active = model?.coeffs ?? BROWN_COEFFS
  if (model?.family === 'fisheye') {
    const d = { fisheye: true, k1: 0, k2: 0, k3: 0, k4: 0 }
    for (const k of active) d[k] = sensor[k] || 0
    return d
  }
  const d = { k1: 0, k2: 0, k3: 0, p1: 0, p2: 0 }
  if (sensor.distortionModel === 'rational') Object.assign(d, { k4: 0, k5: 0, k6: 0 })
  for (const k of active) d[k] = sensor[k] || 0
  return hasDistortion(d) ? d : null
}

/** image → { dist, selfCal, fiducial, filmMissing }, from a v3 run summary and sensors. */
export function resolverFromSummaryV3(summary, sensors) {
  const sensorById = new Map((sensors || []).map((s) => [s.id, s]))
  const rows = summary?.selfCalDistortion ?? []
  const selfCalBySensor = new Map(rows.filter((d) => d.sensorId != null).map((d) => [d.sensorId, d]))
  const selfCalByImage = new Map(
    rows.filter((d) => d.sensorId == null && d.imageUuid != null).map((d) => [d.imageUuid, d]),
  )
  const fidByUuid = new Map(
    (summary?.fiducialTransforms ?? []).map((t) => [
      t.uuid,
      { A: t.A ?? null, transform: t.transform ?? null, frame: t.frame },
    ]),
  )
  return (image) => {
    const sensor = image?.sensorId != null ? sensorById.get(image.sensorId) : null
    const sc =
      image?.sensorId != null
        ? selfCalBySensor.get(image.sensorId)
        : image?.uuid != null
          ? selfCalByImage.get(image.uuid)
          : null
    const fiducial = image?.uuid != null ? (fidByUuid.get(image.uuid) ?? null) : null
    if (sc?.fisheye) {
      return {
        dist: { fisheye: true, k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0, k4: sc.k4 || 0 },
        selfCal: null,
        fiducial,
        filmMissing: false,
      }
    }
    if (sc?.full) {
      const lens = { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0, p1: sc.p1 || 0, p2: sc.p2 || 0 }
      return {
        dist: lens.k1 || lens.k2 || lens.k3 || lens.p1 || lens.p2 ? lens : null,
        selfCal: null,
        fiducial,
        filmMissing: sensor?.kind === 'film' && !fiducial,
      }
    }
    const selfCal = sc && (sc.k1 || sc.k2 || sc.k3) ? { k1: sc.k1 || 0, k2: sc.k2 || 0, k3: sc.k3 || 0 } : null
    return {
      dist: sensor ? distortionOf(sensor) : null,
      selfCal,
      fiducial,
      filmMissing: sensor?.kind === 'film' && !fiducial,
    }
  }
}

const groupKeyOf = (image) => (image?.sensorId != null ? `sensor:${image.sensorId}` : `image:${image?.uuid}`)

/** A sparse cloud's calibration as version 4 first stored it. */
export function calibrationSnapshotV3({ resolve, images = [], source }) {
  const groups = new Map()
  const fiducialTransforms = []
  for (const image of images) {
    const fm = resolve(image)
    const key = groupKeyOf(image)
    if (!groups.has(key)) {
      groups.set(key, {
        ...(image.sensorId != null ? { sensorId: image.sensorId } : { imageUuid: image.uuid }),
        dist: fm.dist ? { ...fm.dist } : null,
        selfCal: fm.selfCal ? { ...fm.selfCal } : null,
      })
    }
    if (fm.fiducial) fiducialTransforms.push({ uuid: image.uuid, ...structuredClone(fm.fiducial) })
  }
  return { groups: [...groups.values()], fiducialTransforms, source }
}
