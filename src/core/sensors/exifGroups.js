// The sensors photos join as they are added (stores/useSensorsStore ensureExifSensors):
// each photo not yet bound to a sensor joins the sensor of its group (core/io/sensor.js
// sensorGroupOf), and a group with no sensor yet gets a new one. A sensor the user
// bound by hand is never touched: only photos without a live sensor are planned.
// Pure: plain data in, plain data out.
import { exifLabel, sameScanFormat, sensorFromExif, sensorGroupOf } from '../io/sensor.js'

// images: [{ id, name, meta, sensorId }]; sensors: the project's sensors.
// opts: { tolFrac (SENSOR_TUNING.formatTolFrac), newId () → id, nextNumber () → the
// next free "Sensor N" number }.
// → { created: [sensor], assign: [[imageId, sensorId]] }, `created` in the order made.
export function planExifSensors(images, sensors, { tolFrac, newId, nextNumber }) {
  const live = new Set(sensors.map((s) => s.id))
  const all = [...sensors]
  const created = []
  const assign = []
  for (const img of images) {
    if ((img.sensorId && live.has(img.sensorId)) || !img.meta) continue
    const group = sensorGroupOf(img.meta, img.name)
    if (!group) continue
    const sameKey = all.filter((s) => s.signature === group.key)
    let sensor = group.roll ? sameKey.find((s) => sameScanFormat(s, img.meta, tolFrac)) : sameKey[0]
    if (!sensor) {
      const seed = sensorFromExif(img.meta)
      sensor = {
        id: newId(),
        ...seed,
        label: groupLabel(img.meta, group, sameKey.length, nextNumber),
        // EXIF carries no lens coefficients: start pinhole; the user opts into a
        // distortion model (and self-calibration) in the sensor table.
        distortionModel: 'pinhole',
        signature: group.key,
        source: 'exif',
      }
      all.push(sensor)
      live.add(sensor.id)
      created.push(sensor)
    }
    assign.push([img.id, sensor.id])
  }
  return { created, assign }
}

// A camera's make and model; a scan's roll ("CA214732V", "CA214732V (2)" for a second
// scan format of it); otherwise a numbered "Sensor N". exifLabel adds the focal length.
function groupLabel(meta, group, sameRoll, nextNumber) {
  const label = exifLabel(meta)
  if (meta.make || meta.model || meta.videoSource) return label
  const name = group.roll ? (sameRoll ? `${group.roll} (${sameRoll + 1})` : group.roll) : `Sensor ${nextNumber()}`
  return label.replace('Unknown camera', name)
}
