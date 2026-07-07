import { ref, watch, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { exifSignature, sensorFromExif } from '../core/sensor.js'
import { DISTORTION_MODELS, inferDistortionModel } from '../core/distortion.js'
import * as opfs from '../utils/opfs.js'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// Sensors are shared camera intrinsics. Each image references one via
// `image.sensorId`. Sensors arrive two ways:
//   - automatically, grouped from image EXIF (same camera + focal + dimensions)
//   - explicitly, imported from a calibration file (utils/sensor.js)
//
// Project-scoped, but NOT registry-driven: its restore must run *before* images
// restore (the EXIF auto-grouping watcher reacts to the image list), so App.vue
// orchestrates restoreSensors/clearSensors directly.
export const useSensorsStore = defineStore('sensors', () => {
  const { log } = useLog()
  const imagesStore = useImagesStore()
  const projects = useProjectsStore()
  const { images } = storeToRefs(imagesStore)

  // [{ id, label, width, height, focal, focalUnit, cx, cy,
  //    k1, k2, k3, p1, p2, pixelSize, signature, source }]
  const sensors = ref([])

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // `save()` fires from the EXIF-grouping watcher, which re-runs once per image
  // as metadata lands during a bulk add. Overlapping `createWritable` streams on
  // the same sensors.json race the OPFS backend (Chrome: "Failed to create swap
  // file"), so writes are coalesced exactly like `useImagesStore.sync()`: at most
  // one in flight, a request arriving mid-write schedules a single trailing re-run
  // that captures the latest state.
  let writing = false
  let rerun = false
  async function save() {
    if (!isPersisting()) return
    if (writing) { rerun = true; return }
    writing = true
    try {
      do {
        rerun = false
        await opfs.saveSensors(projects.currentProjectId, { sensors: sensors.value })
          .catch((err) => log(`Sensor save failed — ${err?.message ?? err}`, 'error', 'Sensor'))
      } while (rerun)
    } finally {
      writing = false
    }
  }

  // How many images currently reference a sensor.
  function imageCount(sensorId) {
    return images.value.filter((img) => img.sensorId === sensorId).length ?? 0
  }

  // Auto-create / assign sensors from EXIF. Images with an identical signature
  // collapse into one sensor; only images lacking a sensorId are touched, so a
  // manual reassignment is never overwritten.
  function ensureExifSensors() {
    if (!images.value.length) return
    let changed = false
    for (const img of images.value) {
      // Skip images already bound to a live sensor. A sensorId that points to no
      // existing sensor (e.g. a restore race, or a removed sensor) is re-resolved.
      const bound = img.sensorId && sensors.value.some((s) => s.id === img.sensorId)
      if (bound || !img.meta) continue
      const sig = exifSignature(img.meta)
      if (!sig) continue
      let sensor = sensors.value.find((s) => s.signature === sig)
      if (!sensor) {
        sensor = {
          id: crypto.randomUUID(),
          ...sensorFromExif(img.meta),
          // EXIF carries no lens coefficients — start pinhole; the user opts into a
          // distortion model (and self-calibration) in the sensor table (D3).
          distortionModel: 'pinhole',
          signature: sig,
          source: 'exif',
        }
        sensors.value.push(sensor)
        log(`Sensor detected: ${sensor.label}`, 'info', 'Sensor')
      }
      img.sensorId = sensor.id
      changed = true
    }
    if (changed) {
      save()
      if (isPersisting()) imagesStore.sync()
    }
  }

  // Re-group whenever an image is added/removed, its EXIF lands, or its sensor
  // assignment changes. Keyed on id+sensorId+EXIF-signature rather than a deep
  // watch, so unrelated image mutations (keypoints, masks) don't re-scan.
  const imageSensorSig = computed(() =>
    images.value.map((i) => `${i.id}:${i.sensorId ?? ''}:${exifSignature(i.meta) ?? ''}`).join('|'),
  )
  watch(imageSensorSig, ensureExifSensors)

  // Add sensors parsed from a calibration file. These are not EXIF-grouped
  // (no signature), so the user assigns images to them manually.
  async function addSensors(rawSensors) {
    let added = 0
    for (const raw of rawSensors) {
      sensors.value.push({
        id: crypto.randomUUID(),
        label: raw.label,
        width: raw.width ?? null,
        height: raw.height ?? null,
        focal: raw.focal ?? null,
        focalUnit: raw.focalUnit ?? 'px',
        cx: raw.cx ?? null,
        cy: raw.cy ?? null,
        k1: raw.k1 ?? null, k2: raw.k2 ?? null, k3: raw.k3 ?? null,
        p1: raw.p1 ?? null, p2: raw.p2 ?? null,
        // Seed the model from whatever coefficients the calibration carried; the
        // user can change it in the sensor table (D3).
        distortionModel: raw.distortionModel ?? inferDistortionModel(raw),
        pixelSize: raw.pixelSize ?? null,
        signature: null,
        source: 'imported',
      })
      added++
    }
    log(`Sensors imported: ${added}`, 'success', 'Sensor')
    await save()
    return added
  }

  // Editable intrinsic fields and their parsing. Blank input clears the field
  // to null; `label` is free text, everything else is numeric.
  const NUMERIC_FIELDS = new Set(['width', 'height', 'focal', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2', 'pixelSize', 'sensorWidthMm'])

  function updateSensor(id, field, value) {
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    if (field === 'label') {
      s.label = String(value).trim() || s.label
    } else if (field === 'focalUnit') {
      // Toggle between a focal length in pixels and one in millimetres. Only
      // these two are valid; anything else leaves it as-is.
      if (value === 'px' || value === 'mm') { s.focalUnit = value; save() }
      return
    } else if (field === 'distortionModel') {
      // Lens distortion model (D3): which Brown coefficients this sensor uses.
      if (DISTORTION_MODELS.some((m) => m.id === value)) { s.distortionModel = value; save() }
      return
    } else if (NUMERIC_FIELDS.has(field)) {
      if (value === '' || value == null) { s[field] = null }
      else {
        const num = Number(value)
        if (Number.isFinite(num)) s[field] = num
      }
    } else return
    save()
  }

  // Intrinsics a future bundle adjustment may refine; the others (width/height)
  // are physical facts, never solved for. A truthy `sensor.fixed[field]` tells
  // the solver to hold that parameter constant. Absent ⇒ free to refine.
  const LOCKABLE_FIELDS = new Set(['focal', 'cx', 'cy', 'k1', 'k2', 'k3', 'p1', 'p2'])

  function toggleSensorFixed(id, field) {
    if (!LOCKABLE_FIELDS.has(field)) return
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    const fixed = { ...(s.fixed || {}) }
    if (fixed[field]) delete fixed[field]
    else fixed[field] = true
    s.fixed = fixed
    save()
  }

  function assignSensor(imageId, sensorId) {
    const img = images.value.find((i) => i.id === imageId)
    if (!img) return
    img.sensorId = sensorId || null
    save()
    if (isPersisting()) imagesStore.sync()
  }

  // Fold `sourceId` into `targetId`: move its images, then drop it.
  function mergeSensors(targetId, sourceId) {
    if (targetId === sourceId) return
    for (const img of images.value) {
      if (img.sensorId === sourceId) img.sensorId = targetId
    }
    const idx = sensors.value.findIndex((s) => s.id === sourceId)
    if (idx !== -1) sensors.value.splice(idx, 1)
    save()
    if (isPersisting()) imagesStore.sync()
  }

  function removeSensor(id) {
    for (const img of images.value) {
      if (img.sensorId === id) img.sensorId = null
    }
    const idx = sensors.value.findIndex((s) => s.id === id)
    if (idx !== -1) sensors.value.splice(idx, 1)
    save()
    if (isPersisting()) imagesStore.sync()
  }

  function clearSensors() {
    sensors.value = []
    if (isPersisting()) opfs.deleteSensors(projects.currentProjectId).catch(() => {})
  }

  async function restoreSensors(projectId) {
    sensors.value = []
    const data = await opfs.loadSensors(projectId)
    if (data?.sensors?.length) {
      sensors.value = data.sensors
      log(`Sensors restored: ${sensors.value.length}`, 'success', 'Sensor')
    }
    // Re-derive any sensors for images whose EXIF wasn't grouped yet.
    ensureExifSensors()
  }

  return {
    sensors,
    imageCount,
    ensureExifSensors,
    addSensors,
    updateSensor,
    toggleSensorFixed,
    assignSensor,
    mergeSensors,
    removeSensor,
    clearSensors,
    restoreSensors,
  }
})
