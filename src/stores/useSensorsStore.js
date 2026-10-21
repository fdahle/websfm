import { ref, watch, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { exifSignature, sensorFromExif } from '../core/io/sensor.js'
import { DISTORTION_MODELS, DISTORTION_COEFFS, inferDistortionModel } from '../core/sfm/distortion.js'
import * as opfs from '../utils/opfs.js'
import { createDocumentSaver } from '../utils/documentSaver.js'
import { useImagesStore } from './useImagesStore.js'
import { emptyFiducialCalibration, isFiducialCalibrated } from '../core/sfm/fiducialModel.js'
import { applyFiducialMarks, planFiducialMarkTargets } from '../core/io/fiducialMarks.js'
import { normalizeLeverArm } from '../core/sfm/cameraPriors.js'
import { useProjectsStore } from './useProjectsStore.js'
import { pluralize } from '../core/textFormat.js'

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
  //    k1…k6, p1, p2, distortionModel, pixelSize, signature, source }]
  //    (distortionModel picks which coefficients are live — distortion.js)
  const sensors = ref([])

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // `save()` fires from the EXIF-grouping watcher, which re-runs once per image
  // as metadata lands during a bulk add. Overlapping `createWritable` streams on
  // the same sensors.json race the OPFS backend (Chrome: "Failed to create swap
  // file"), so writes go through the shared document saver (utils/documentSaver.js):
  // at most one in flight, a request arriving mid-write schedules a single trailing
  // re-run that captures the latest state.
  const save = createDocumentSaver({
    label: 'sensors',
    currentProjectId: () => projects.currentProjectId,
    isPersisting,
    build: () => ({ sensors: sensors.value }),
    write: opfs.saveSensors,
    onError: (err) => log(`Sensors save failed — ${err?.message ?? err}`, 'error', 'Sensors'),
  })

  // How many images currently reference a sensor.
  function imageCount(sensorId) {
    return images.value.filter((img) => img.sensorId === sensorId).length ?? 0
  }

  // Next free "Sensor N" index — one past the highest already in use, so
  // auto-named sensors get a stable, continuous number even after removals.
  function nextSensorNumber() {
    let max = 0
    for (const s of sensors.value) {
      const m = /^Sensor (\d+)\b/.exec(s.label || '')
      if (m) max = Math.max(max, Number(m[1]))
    }
    return max + 1
  }

  // Auto-create / assign sensors from EXIF. Images with an identical signature
  // collapse into one sensor; only images lacking a sensorId are touched, so a
  // manual reassignment is never overwritten.
  function ensureExifSensors() {
    if (!images.value.length) return
    let changed = false
    // Indexed once per run: this runs once per image's EXIF landing, so a search
    // per image made an import O(images² × sensors).
    const liveIds = new Set(sensors.value.map((s) => s.id))
    const bySignature = new Map()
    for (const s of sensors.value) if (s.signature && !bySignature.has(s.signature)) bySignature.set(s.signature, s)
    for (const img of images.value) {
      // Skip images already bound to a live sensor. A sensorId that points to no
      // existing sensor (e.g. a restore race, or a removed sensor) is re-resolved.
      const bound = img.sensorId && liveIds.has(img.sensorId)
      if (bound || !img.meta) continue
      const sig = exifSignature(img.meta)
      if (!sig) continue
      let sensor = bySignature.get(sig)
      if (!sensor) {
        const seed = sensorFromExif(img.meta)
        // No make/model in EXIF (scanned/historic imagery): give it a numbered
        // "Sensor N" name instead of the generic "Unknown camera", keeping any
        // focal suffix exifLabel added.
        if (!(img.meta.make || img.meta.model)) {
          seed.label = seed.label.replace('Unknown camera', `Sensor ${nextSensorNumber()}`)
        }
        sensor = {
          id: crypto.randomUUID(),
          ...seed,
          // EXIF carries no lens coefficients — start pinhole; the user opts into a
          // distortion model (and self-calibration) in the sensor table (D3).
          distortionModel: 'pinhole',
          signature: sig,
          source: 'exif',
        }
        sensors.value.push(sensor)
        liveIds.add(sensor.id)
        bySignature.set(sig, sensor)
        log(`Sensor detected: ${sensor.label}`, 'info', 'Sensor')
      }
      img.sensorId = sensor.id
      changed = true
    }
    if (changed) {
      save()
      if (isPersisting()) imagesStore.save()
    }
  }

  // Re-group whenever an image is added/removed, its EXIF lands, or its sensor
  // assignment changes. Keyed on id+sensorId+EXIF-signature rather than a deep
  // watch, so unrelated image mutations (keypoints, masks) don't re-scan.
  // A number (FNV-1a), not one joined string: it re-evaluates on every image's EXIF
  // landing, and a string over all images made that O(images²) characters.
  const imageSensorSig = computed(() => {
    let h = 0x811c9dc5
    const mix = (s) => {
      s = String(s ?? '')
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
      h = Math.imul(h ^ 0x7c, 0x01000193) >>> 0
    }
    for (const i of images.value) {
      mix(i.id)
      mix(i.sensorId)
      mix(i.meta ? exifSignature(i.meta) : '')
    }
    return `${images.value.length}:${h}`
  })
  watch(imageSensorSig, ensureExifSensors)

  // Import ▸ Calibration: `items` = [{ sensor, targetId, imageIds }], where `sensor`
  // comes from core/io/sensor.js buildSensors and `targetId` / `imageIds` from the
  // dialog (planSensorImport). A target is updated with the values the file has —
  // everything it lacks stays — a null target becomes a new sensor; the listed
  // images are then bound to it. Returns { created, updated, assigned }.
  async function importSensors(items) {
    let created = 0,
      updated = 0,
      assigned = 0
    for (const { sensor: raw, targetId, imageIds = [] } of items || []) {
      let s = targetId ? sensors.value.find((x) => x.id === targetId) : null
      const isNew = !s
      if (isNew) {
        s = {
          id: crypto.randomUUID(),
          label: raw.label || `Sensor ${nextSensorNumber()}`,
          width: null,
          height: null,
          focal: null,
          focalUnit: 'px',
          cx: null,
          cy: null,
          k1: null,
          k2: null,
          k3: null,
          k4: null,
          k5: null,
          k6: null,
          p1: null,
          p2: null,
          pixelSize: null,
          distortionModel: 'pinhole',
          signature: null,
          source: 'imported',
        }
        sensors.value.push(s)
        created++
      } else updated++
      const set = applyImportedValues(s, raw)
      for (const id of imageIds) {
        const img = images.value.find((i) => i.id === id)
        if (img && img.sensorId !== s.id) {
          img.sensorId = s.id
          assigned++
        }
      }
      log(
        `Sensor ${s.label} ${isNew ? 'created' : 'updated'} from file: ${set.join(', ') || 'no values'}` +
          (imageIds.length ? ` — ${pluralize(imageIds.length, 'image')}` : ''),
        'success',
        'Sensor',
      )
    }
    await save()
    if (assigned && isPersisting()) await imagesStore.save()
    return { created, updated, assigned }
  }

  // Copy an imported sensor's values onto `s`; returns what was set, for the log.
  function applyImportedValues(s, raw) {
    const set = []
    for (const k of ['width', 'height', 'cx', 'cy', ...DISTORTION_COEFFS, 'pixelSize']) {
      if (raw[k] != null) {
        s[k] = raw[k]
        set.push(k)
      }
    }
    if (raw.focal != null) {
      s.focal = raw.focal
      s.focalUnit = raw.focalUnit
      set.push(`focal (${raw.focalUnit})`)
    }
    // A named lens model wins (coefficients alone cannot say "fisheye"); otherwise
    // the tightest model covering the imported coefficients.
    if (raw.distortionModel) {
      s.distortionModel = raw.distortionModel
      set.push(`lens model ${raw.distortionModel}`)
    } else if (DISTORTION_COEFFS.some((k) => raw[k] != null)) s.distortionModel = inferDistortionModel(s)
    const focalMm = raw.focal != null && raw.focalUnit === 'mm' ? raw.focal : null
    if (raw.marks?.length) {
      // Certificate marks named by position: each is its own slot, so the sensor
      // comes out calibrated (validate in Calibrate fiducials).
      s.fiducialCalibration = applyFiducialMarks(s, { marks: raw.marks, focalMm, ppxMm: raw.ppxMm, ppyMm: raw.ppyMm })
      s.kind = 'film'
      if (s.fiducialCalibration.focalMm > 0) {
        s.focal = s.fiducialCalibration.focalMm
        s.focalUnit = 'mm'
      }
      set.push(`${raw.marks.length} fiducial marks`)
    } else if (s.kind === 'film' && (focalMm != null || raw.ppxMm != null || raw.ppyMm != null)) {
      const cal = (s.fiducialCalibration ??= emptyFiducialCalibration())
      if (focalMm != null) cal.focalMm = focalMm
      if (raw.ppxMm != null) cal.ppxMm = raw.ppxMm
      if (raw.ppyMm != null) cal.ppyMm = raw.ppyMm
      cal.fit = null
    }
    if (raw.ppxMm != null || raw.ppyMm != null) {
      if (s.kind === 'film') set.push('principal point (mm)')
      // A digital sensor keeps its principal point in pixels: convert about the
      // image centre (mm y points up, pixel y down) when the sizes are known.
      else if (s.pixelSize > 0 && s.width > 0 && s.height > 0) {
        s.cx = s.width / 2 + (raw.ppxMm ?? 0) / s.pixelSize
        s.cy = s.height / 2 - (raw.ppyMm ?? 0) / s.pixelSize
        set.push('principal point (mm → px)')
      } else {
        log(
          `Sensor ${s.label}: principal point in mm skipped — needs a pixel size and the image size`,
          'warn',
          'Sensor',
        )
      }
    }
    return set
  }

  // Import externally-id'd camera groups and bind matched images in one pass.
  // Returns the external-id map so an interop coordinator can report conflicts.
  async function importCameraGroups(rawSensors, imageBindings = []) {
    const idByExternal = new Map()
    for (const raw of rawSensors || []) {
      const sensor = {
        id: crypto.randomUUID(),
        label: raw.label,
        width: raw.width ?? null,
        height: raw.height ?? null,
        focal: raw.focal ?? raw.fx ?? null,
        focalUnit: 'px',
        cx: raw.cx ?? null,
        cy: raw.cy ?? null,
        k1: raw.k1 ?? null,
        k2: raw.k2 ?? null,
        k3: raw.k3 ?? null,
        k4: raw.k4 ?? null,
        k5: raw.k5 ?? null,
        k6: raw.k6 ?? null,
        p1: raw.p1 ?? null,
        p2: raw.p2 ?? null,
        distortionModel: raw.distortionModel ?? inferDistortionModel(raw),
        pixelSize: null,
        signature: null,
        source: raw.source ?? 'imported',
        // Keep anisotropic focal information for lossless re-export even though
        // the current sensor editor/solver uses the scalar focal field.
        externalFx: raw.fx ?? raw.focal ?? null,
        externalFy: raw.fy ?? raw.focal ?? null,
      }
      sensors.value.push(sensor)
      idByExternal.set(raw.externalId, sensor.id)
    }
    for (const binding of imageBindings || []) {
      const img = images.value.find((i) => i.uuid === binding.uuid)
      const sensorId = idByExternal.get(binding.cameraId)
      if (img && sensorId) img.sensorId = sensorId
    }
    await save()
    if (isPersisting()) await imagesStore.save()
    log(
      `Camera calibration imported: ${pluralize(idByExternal.size, 'group')}`,
      idByExternal.size ? 'success' : 'warn',
      'Import',
    )
    return idByExternal
  }

  // Editable intrinsic fields and their parsing. Blank input clears the field
  // to null; `label` is free text, everything else is numeric.
  const NUMERIC_FIELDS = new Set([
    'width',
    'height',
    'focal',
    'cx',
    'cy',
    ...DISTORTION_COEFFS,
    'pixelSize',
    'sensorWidthMm',
  ])
  const LEVER_ARM_FIELDS = new Map([
    ['gnssLeverArmX', 0],
    ['gnssLeverArmY', 1],
    ['gnssLeverArmZ', 2],
  ])

  // Film-camera fiducial fields (F4): the certificate's focal and principal point,
  // kept on the sensor's one fiducial record (fiducialCalibration). Numeric and
  // edited inline like the intrinsics above, but only meaningful when the
  // sensor's kind is 'film'. `focalMm` is authoritative for resolveK on the
  // fiducial path; keep `focal`/`focalUnit` in sync so the rest of the UI reads
  // sensibly (done here so the two can't drift).
  const FIDUCIAL_NUMERIC = new Set(['ppxMm', 'ppyMm', 'focalMm'])

  function updateSensor(id, field, value) {
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    if (field === 'label') {
      s.label = String(value).trim() || s.label
    } else if (field === 'kind') {
      // Digital (default) vs film (fiducial interior orientation).
      if (value !== 'digital' && value !== 'film') return
      s.kind = value
      if (value === 'film' && !s.fiducialCalibration) {
        s.fiducialCalibration = emptyFiducialCalibration(s.focalUnit === 'mm' ? (s.focal ?? 0) : 0)
      }
      log(`Sensor ${s.label} set to ${value}`, 'info', 'Sensor', { channel: 'activity' })
      save()
      if (isPersisting()) imagesStore.save()
      return
    } else if (FIDUCIAL_NUMERIC.has(field)) {
      const num = Number(value)
      if (!Number.isFinite(num)) return
      s.fiducialCalibration ??= emptyFiducialCalibration()
      s.fiducialCalibration[field] = num
      // focalMm is authoritative on the fiducial path — mirror it into focal/focalUnit.
      if (field === 'focalMm') {
        s.focal = num
        s.focalUnit = 'mm'
      }
      log(`Sensor ${s.label}: ${field} = ${num}`, 'info', 'Sensor')
      save()
      return
    } else if (LEVER_ARM_FIELDS.has(field)) {
      // GNSS antenna offset, metres, camera axes (x right, y down, z forward). Stored as
      // one [x, y, z] or null; an all-zero offset is the same as none.
      const arm = [...(s.gnssLeverArm ?? [0, 0, 0])]
      const num = value === '' || value == null ? 0 : Number(value)
      if (!Number.isFinite(num)) return
      arm[LEVER_ARM_FIELDS.get(field)] = num
      s.gnssLeverArm = normalizeLeverArm(arm)
      log(
        `Sensor ${s.label}: GNSS antenna offset ${s.gnssLeverArm ? `(${s.gnssLeverArm.join(', ')}) m` : 'cleared'}`,
        'info',
        'Sensor',
        { channel: 'activity' },
      )
      save()
      return
    } else if (field === 'focalUnit') {
      // Toggle between a focal length in pixels and one in millimetres. Only
      // these two are valid; anything else leaves it as-is.
      if (value === 'px' || value === 'mm') {
        s.focalUnit = value
        save()
      }
      return
    } else if (field === 'distortionModel') {
      // Lens model (D3): the projection (Brown / rational / fisheye) and which
      // coefficients this sensor uses.
      if (DISTORTION_MODELS.some((m) => m.id === value)) {
        s.distortionModel = value
        save()
      }
      return
    } else if (NUMERIC_FIELDS.has(field)) {
      if (value === '' || value == null) {
        s[field] = null
      } else {
        const num = Number(value)
        if (Number.isFinite(num)) s[field] = num
      }
    } else return
    save()
  }

  // Apply a suggested film format width (mm) — the sensor table's "Set to 230 mm?"
  // action when the scan pitch implies an off-standard film width
  // (core/sfm/filmFormat.js). The format outranks the pitch in resolveK, so this alone
  // moves the sensor onto the format path; the stored pitch is kept (inert) so
  // clearing the format restores it. The suggestion is a user decision, so it is
  // logged with its value and reason on the activity channel.
  function applyFilmFormat(id, widthMm, reason = '') {
    const s = sensors.value.find((x) => x.id === id)
    const mm = Number(widthMm)
    if (!s || !Number.isFinite(mm) || mm <= 0) return
    const prev = s.sensorWidthMm
    s.sensorWidthMm = mm
    log(
      `Sensor ${s.label}: film format set to ${mm} mm${prev ? ` (was ${prev} mm)` : ''}` +
        `${reason ? ` — ${reason}` : ''}`,
      'info',
      'Sensor',
      { channel: 'activity' },
    )
    save()
  }

  // Intrinsics a future bundle adjustment may refine; the others (width/height)
  // are physical facts, never solved for. A truthy `sensor.fixed[field]` tells
  // the solver to hold that parameter constant. Absent ⇒ free to refine.
  const LOCKABLE_FIELDS = new Set(['focal', 'cx', 'cy', ...DISTORTION_COEFFS])

  function toggleSensorFixed(id, field) {
    if (!LOCKABLE_FIELDS.has(field)) return false
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return false
    const fixed = { ...(s.fixed || {}) }
    if (fixed[field]) delete fixed[field]
    else fixed[field] = true
    s.fixed = fixed
    save()
    return true
  }

  // Replace a film sensor's certificate marks (F4). `marks` is `[{ id, xMm, yMm }]`;
  // non-finite rows are dropped. Ensures kind:'film'. The slot map follows a mark
  // renamed in place (same row count) and drops one whose mark is gone; `fit` is
  // cleared, since its residuals were measured against the old marks.
  function setFiducialMarks(id, marks) {
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    const clean = (marks || [])
      .filter((m) => m && Number.isFinite(Number(m.xMm)) && Number.isFinite(Number(m.yMm)))
      .map((m, i) => ({ id: String(m.id ?? `F${i + 1}`), xMm: Number(m.xMm), yMm: Number(m.yMm) }))
    const cal = (s.fiducialCalibration ??= emptyFiducialCalibration())
    const prev = cal.marks || []
    const renamed =
      prev.length === clean.length
        ? new Map(prev.map((m, i) => [m.id, clean[i].id]))
        : new Map(clean.map((m) => [m.id, m.id]))
    cal.slotMap = Object.fromEntries(
      Object.entries(cal.slotMap || {}).flatMap(([slot, fidId]) =>
        renamed.has(fidId) ? [[slot, renamed.get(fidId)]] : [],
      ),
    )
    cal.marks = clean
    cal.fit = null
    if (!s.kind) s.kind = 'film'
    log(`Sensor ${s.label}: ${pluralize(clean.length, 'fiducial mark')} set`, 'info', 'Sensor')
    save()
  }

  function setFiducialCalibration(id, calibration) {
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    s.kind = 'film'
    s.fiducialCalibration = calibration ? JSON.parse(JSON.stringify(calibration)) : null
    if (calibration?.focalMm > 0) {
      s.focal = calibration.focalMm
      s.focalUnit = 'mm'
    }
    log(
      `Sensor ${s.label}: fiducial calibration ${calibration ? 'applied' : 'cleared'}`,
      calibration ? 'success' : 'info',
      'Sensor',
    )
    save()
    if (isPersisting()) imagesStore.save()
  }

  // Import ▸ Camera Fiducials: `groups` from core/io/fiducialMarks.js, applied to
  // `targetIds[i]` (the import dialog's choice; planFiducialMarkTargets when absent).
  // Returns the number of sensors updated.
  function importFiducialMarks(groups, targetIds = planFiducialMarkTargets(groups, sensors.value)) {
    const list = groups || []
    let applied = 0
    const unmatched = []
    list.forEach((g, i) => {
      const s = targetIds[i] ? sensors.value.find((x) => x.id === targetIds[i]) : null
      if (!s || !g.marks.length) {
        unmatched.push(g.sensor || '(no sensor column)')
        return
      }
      const cal = applyFiducialMarks(s, g)
      s.kind = 'film'
      s.fiducialCalibration = cal
      if (cal.focalMm > 0) {
        s.focal = cal.focalMm
        s.focalUnit = 'mm'
      }
      log(
        `Sensor ${s.label}: ${pluralize(g.marks.length, 'fiducial mark')} imported` +
          (isFiducialCalibrated(cal) ? ' — validate them in Calibrate fiducials' : ''),
        'success',
        'Sensor',
      )
      applied++
    })
    if (unmatched.length) log(`Camera fiducials: no sensor matched ${unmatched.join(', ')}`, 'warn', 'Sensor')
    if (applied) {
      save()
      if (isPersisting()) imagesStore.save()
    }
    return applied
  }

  function assignSensor(imageId, sensorId) {
    const img = images.value.find((i) => i.id === imageId)
    if (!img) return
    img.sensorId = sensorId || null
    save()
    if (isPersisting()) imagesStore.save()
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
    if (isPersisting()) imagesStore.save()
  }

  function removeSensor(id) {
    const idx = sensors.value.findIndex((s) => s.id === id)
    if (idx === -1) return false
    for (const img of images.value) {
      if (img.sensorId === id) img.sensorId = null
    }
    sensors.value.splice(idx, 1)
    save()
    if (isPersisting()) imagesStore.save()
    return true
  }

  // Reset in-memory sensors. Pass { purge: true } to also delete the persisted
  // sensors file — do NOT purge on project switch/close: restore reads the sensors
  // back, and on a switch currentProjectId already names the project being opened.
  function clearSensors({ purge = false } = {}) {
    sensors.value = []
    if (purge && isPersisting()) opfs.deleteSensors(projects.currentProjectId).catch(() => {})
  }

  // A sensor of half-frame scans stitched through their reseau (SAT-5): its images'
  // film geometry is already corrected, so Auto self-calibration holds it like a
  // reseau-calibrated film camera (core/sfm/runRecord.js resolveRefineIntrinsics).
  function markReseauStitched(id) {
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    s.reseauStitched = true
    save()
  }

  // A sensor of panoramic-strip segments (core/sfm/panoramic.js): each is an exact pinhole
  // resampling of the film's cylinder at the certificate focal length, so Auto
  // self-calibration holds it as well, and over a few degrees of field the focal length
  // could not be solved anyway (it trades with the height).
  function markPanoramicSegments(id) {
    const s = sensors.value.find((x) => x.id === id)
    if (!s) return
    s.panoramicSegments = true
    save()
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
    importSensors,
    importCameraGroups,
    updateSensor,
    markReseauStitched,
    markPanoramicSegments,
    applyFilmFormat,
    toggleSensorFixed,
    setFiducialMarks,
    setFiducialCalibration,
    importFiducialMarks,
    assignSensor,
    mergeSensors,
    removeSensor,
    clearSensors,
    restoreSensors,
  }
})
