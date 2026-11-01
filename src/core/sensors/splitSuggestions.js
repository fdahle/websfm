// Camera groups that may hold photos of more than one camera (Sidebar ▸ Sensors ▸
// Split camera group…). A group shares one focal length, principal point, lens
// distortion and, for film, one fiducial layout; photos of another camera in it bend
// the block (TMA Melville: groups by camera position that mixed scan formats put the
// cameras 28 m RMS off the reference, split by scan size 13 m). This only suggests:
// the Sensors section shows it and the user splits, or not.
//
// Evidence, each from what the project already holds:
//   - scan format: photos of another exact size come from another camera or scan
//     batch (sizes within formatTolFrac count as one when frames were cropped one by one);
//   - fiducial fit (a calibrated film group): the photos of one roll (the file name
//     without its frame number) that fit the group's mark layout far worse than the
//     rest were taken with another camera or scanned another way.
// Pure: plain data in, plain data out.
import { validateFiducialCalibration } from '../sfm/fiducialCalibration.js'
import { isFiducialCalibrated } from '../sfm/fiducialModel.js'
import { SENSOR_TUNING } from '../tuning.js'

const median = (v) => {
  const s = [...v].sort((a, b) => a - b),
    m = s.length >> 1
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null
}

// The roll of a photo: its file name without the extension and the trailing frame
// number (CA215731L0040.tif → CA215731L). Null when nothing is left.
export function rollOf(name) {
  const base = String(name ?? '').replace(/\.[^.]+$/, '')
  const roll = base.replace(/[\s_.-]*\d+$/, '')
  return roll && roll !== base ? roll : null
}

// The scan formats of a group → [{ key, w, h, ids }]. A scan batch has one exact size,
// and on the Melville scans sizes 3 px apart were other cameras (their fiducial fits
// halved once split). So exact sizes count, unless the frames were cropped one by one:
// when fewer than exactShare of the photos share their exact size with exactMinPhotos
// or more, sizes within formatTolFrac are one format.
function formatClusters(images, tuning) {
  const sized = images
    .filter((im) => im.meta?.width > 0 && im.meta?.height > 0)
    .sort((a, b) => a.meta.width - b.meta.width || a.meta.height - b.meta.height)
  const exact = new Map()
  for (const im of sized) {
    const key = `${im.meta.width}×${im.meta.height}`
    if (!exact.has(key)) exact.set(key, { key, w: im.meta.width, h: im.meta.height, ids: [] })
    exact.get(key).ids.push(im.id)
  }
  const shared = [...exact.values()].filter((c) => c.ids.length >= tuning.exactMinPhotos)
  if (shared.reduce((n, c) => n + c.ids.length, 0) >= tuning.exactShare * sized.length) return [...exact.values()]
  const tol = tuning.formatTolFrac
  const out = []
  for (const im of sized) {
    const { width: w, height: h } = im.meta
    const c = out.find((c) => Math.abs(w - c.w) <= tol * c.w && Math.abs(h - c.h) <= tol * c.h)
    if (c) c.ids.push(im.id)
    else out.push({ key: `${w}×${h}`, w, h, ids: [im.id] })
  }
  return out
}

// Rolls whose photos fit the group's fiducial layout far worse than the others.
// → [{ roll, ids, medianUm, othersUm }]
function misfitRolls(images, calibration, tuning) {
  const v = validateFiducialCalibration(images, calibration)
  const rms = new Map(v.perImage.filter((r) => r.fit).map((r) => [r.id, r.fit.rmsUm]))
  const byRoll = new Map()
  for (const im of images) {
    const roll = rollOf(im.name)
    if (!roll || !rms.has(im.id)) continue
    if (!byRoll.has(roll)) byRoll.set(roll, [])
    byRoll.get(roll).push(im.id)
  }
  if (byRoll.size < 2) return []
  // Half a scan pixel: below it a fit is as good as the marks are.
  const floorUm = calibration.scanPitchMm > 0 ? 500 * calibration.scanPitchMm : 0
  const out = []
  for (const [roll, ids] of byRoll) {
    const others = [...rms].filter(([id]) => !ids.includes(id)).map(([, r]) => r)
    const medianUm = median(ids.map((id) => rms.get(id)))
    const othersUm = median(others)
    if (othersUm == null) continue
    if (medianUm > Math.max(tuning.fiducialMisfitFactor * othersUm, floorUm))
      out.push({ roll, ids, medianUm, othersUm })
  }
  return out
}

// → [{ sensorId, label, groups: [{ label, imageIds, small }], formats, misfits }], one
// entry per group the evidence would split; groups under minImages are marked `small`
// (they get fewer self-calibration terms).
//   images: [{ id, name, sensorId, meta: { width, height }, fiducialDetections }]
export function suggestSensorSplits({ sensors, images }, tuning = SENSOR_TUNING) {
  const out = []
  for (const s of sensors) {
    const imgs = images.filter((im) => im.sensorId === s.id)
    if (imgs.length < 2) continue
    const formats = formatClusters(imgs, tuning)
    const cal = s.kind === 'film' && isFiducialCalibrated(s.fiducialCalibration) ? s.fiducialCalibration : null
    const misfits = cal ? misfitRolls(imgs, cal, tuning) : []
    // Each image's group: its format, then a misfit roll of its own.
    const keyOf = new Map()
    for (const f of formats) for (const id of f.ids) keyOf.set(id, formats.length > 1 ? f.key : '')
    for (const m of misfits) for (const id of m.ids) keyOf.set(id, [keyOf.get(id), m.roll].filter(Boolean).join(' · '))
    const groups = new Map()
    for (const im of imgs) {
      const k = keyOf.get(im.id) ?? ''
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(im.id)
    }
    if (groups.size < 2) continue
    out.push({
      sensorId: s.id,
      label: s.label,
      groups: [...groups]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([k, ids]) => ({
          label: k ? `${s.label} · ${k}` : s.label,
          imageIds: ids,
          small: ids.length < tuning.splitMinImages,
        })),
      formats: formats.length > 1 ? formats.map((f) => ({ key: f.key, images: f.ids.length })) : [],
      misfits: misfits.map(({ roll, ids, medianUm, othersUm }) => ({ roll, images: ids.length, medianUm, othersUm })),
    })
  }
  return out
}

// The groups a split by one criterion makes (the Split camera group dialog's choices):
//   by: 'format' (scan size, as suggestSensorSplits compares it) | 'roll' (file name
//   without its frame number; photos without one stay in the first group).
// → [{ label, imageIds, small }], largest first; one group when the criterion splits nothing.
export function splitBy(sensor, images, by, tuning = SENSOR_TUNING) {
  const imgs = images.filter((im) => im.sensorId === sensor.id)
  const groups = new Map()
  if (by === 'format') for (const f of formatClusters(imgs, tuning)) groups.set(f.key, f.ids)
  else
    for (const im of imgs) {
      const k = rollOf(im.name) ?? ''
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(im.id)
    }
  const unsized = by === 'format' ? imgs.filter((im) => !(im.meta?.width > 0 && im.meta?.height > 0)) : []
  const list = [...groups].sort((a, b) => b[1].length - a[1].length)
  if (unsized.length) list[0]?.[1].push(...unsized.map((im) => im.id))
  return list.map(([k, ids]) => ({
    label: list.length > 1 && k ? `${sensor.label} · ${k}` : sensor.label,
    imageIds: ids,
    small: ids.length < tuning.splitMinImages,
  }))
}
