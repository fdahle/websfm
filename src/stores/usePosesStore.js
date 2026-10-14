import { ref, watch, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, isGeographic, metresPerCrsUnit, metresToCrsUnits, transform } from '../core/crs.js'
import * as opfs from '../utils/opfs.js'
import { createDocumentSaver } from '../utils/documentSaver.js'
import { registerProjectStore } from './projectStores.js'
import { makeNameResolver, relinkImageRecord } from '../core/io/nameMatch.js'
import { pluralize } from '../core/textFormat.js'
import { useImagesStore } from './useImagesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { exifPoseFromMetadata, projectExifPose } from '../core/io/exifPose.js'
import { suggestProjectedCrs, formatLatLon } from '../core/crsSuggest.js'

// Camera poses (exterior orientation / extrinsics): one per image, used as
// georeferencing priors for bundle adjustment. Positions are stored in the
// project working CRS — exactly like GCPs/footprints — and re-projected when the
// CRS changes. Imported orientation angles pass through unchanged; EXIF/XMP
// true-north attitudes are rotated into grid north and constrain pose-prior BA.
const DEFAULT_ACC_XYZ   = 5.0   // position prior accuracy, project-CRS units (m)
const DEFAULT_ACC_ANGLE = 2.0   // orientation prior accuracy, degrees

export const usePosesStore = registerProjectStore(defineStore('poses', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const { images } = storeToRefs(useImagesStore())
  const { currentCrs } = storeToRefs(projects)

  // [{ id, imageId, imageName, x, y, z, omega, phi, kappa,
  //    accuracyX, accuracyY, accuracyZ, accXYZ,
  //    accuracyOmega, accuracyPhi, accuracyKappa, accAngle, source, enabled }]
  const poses = ref([])

  function normalizePose(p) {
    const scalar = Number.isFinite(p.accXYZ) && p.accXYZ > 0 ? p.accXYZ : DEFAULT_ACC_XYZ
    if (!(Number.isFinite(p.accuracyX) && p.accuracyX > 0)) p.accuracyX = scalar
    if (!(Number.isFinite(p.accuracyY) && p.accuracyY > 0)) p.accuracyY = scalar
    if (!(Number.isFinite(p.accuracyZ) && p.accuracyZ > 0)) p.accuracyZ = scalar
    p.accXYZ = scalar // retained for project/back-end compatibility
    const angleScalar = Number.isFinite(p.accAngle) && p.accAngle > 0 ? p.accAngle : DEFAULT_ACC_ANGLE
    if (!(Number.isFinite(p.accuracyOmega) && p.accuracyOmega > 0)) p.accuracyOmega = angleScalar
    if (!(Number.isFinite(p.accuracyPhi) && p.accuracyPhi > 0)) p.accuracyPhi = angleScalar
    if (!(Number.isFinite(p.accuracyKappa) && p.accuracyKappa > 0)) p.accuracyKappa = angleScalar
    p.accAngle = angleScalar // retained as the isotropic fallback/legacy field
    p.source = p.source === 'exif' ? 'exif' : 'imported'
    if (p.enabled == null) p.enabled = true
    // The record's own identity. A pose links to its image by imageId (imageName
    // is the import-time key that resolves it), but rows, edits and removal key on this.
    p.id ??= crypto.randomUUID()
    return p
  }

  function reprojectPose(p, fromCrs, toCrs) {
    const [x, y, z] = transform([p.x, p.y, p.z ?? 0], fromCrs, toCrs)
    if (p.source !== 'exif') return normalizePose({ ...p, x, y, z: p.z != null ? z : null })

    // New EXIF records retain their original WGS84 position, ENU attitude and
    // ENU uncertainties. Rebuild from those canonical values so changing CRS
    // also updates meridian convergence and rotates anisotropic GNSS accuracy.
    if (Number.isFinite(p.lon) && Number.isFinite(p.lat)
        && Number.isFinite(p.accuracyMetersEast) && Number.isFinite(p.accuracyMetersNorth)) {
      const projected = projectExifPose({
        lon: p.lon, lat: p.lat, altitude: p.altitudeMeters,
        accuracyX: p.accuracyMetersEast, accuracyY: p.accuracyMetersNorth,
        accuracyZ: p.accuracyMetersUp ?? p.accuracyMetersZ,
        omega: p.omegaEnu, phi: p.phiEnu, kappa: p.kappaEnu,
        accuracyOmega: p.accuracyOmega, accuracyPhi: p.accuracyPhi,
        accuracyKappa: p.accuracyKappa, accuracySource: p.accuracySource,
        orientationSource: p.orientationSource, verticalDatum: p.verticalDatum,
        direction: p.direction, directionRef: p.directionRef,
      }, toCrs)
      return normalizePose({ ...p, ...projected })
    }

    // EXIF Z/accuracy are physical metres, not horizontal-CRS units. Retain
    // canonical metre sidecars so repeated CRS changes never accumulate scale
    // error; derive them once for projects persisted before these fields existed.
    const fromFactor = metresPerCrsUnit(fromCrs) ?? 1
    const altitudeMeters = Number.isFinite(p.altitudeMeters)
      ? p.altitudeMeters : (Number.isFinite(p.z) ? p.z * fromFactor : null)
    const accuracyMetersX = Number.isFinite(p.accuracyMetersX)
      ? p.accuracyMetersX : p.accuracyX * fromFactor
    const accuracyMetersY = Number.isFinite(p.accuracyMetersY)
      ? p.accuracyMetersY : p.accuracyY * fromFactor
    const accuracyMetersZ = Number.isFinite(p.accuracyMetersZ)
      ? p.accuracyMetersZ : p.accuracyZ * fromFactor
    const accuracyX = metresToCrsUnits(accuracyMetersX, toCrs)
    const accuracyY = metresToCrsUnits(accuracyMetersY, toCrs)
    const accuracyZ = metresToCrsUnits(accuracyMetersZ, toCrs)
    return normalizePose({ ...p, x, y,
      z: altitudeMeters == null ? null : metresToCrsUnits(altitudeMeters, toCrs),
      altitudeMeters, accuracyMetersX, accuracyMetersY, accuracyMetersZ,
      accuracyX, accuracyY, accuracyZ, accXYZ: accuracyX })
  }

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  // `save()` fires from several places that overlap during a restore or a bulk
  // image add — the EXIF watcher (once per image as metadata lands),
  // `resolveImageMatches`, and `restore` itself — each rewriting the whole
  // poses.json — so it goes through the shared document saver
  // (utils/documentSaver.js): at most one write in flight, one trailing re-run
  // that captures the latest state. (opfs.js serializes same-file writes
  // regardless; this is about not queueing N redundant rewrites of one small file.)
  const save = createDocumentSaver({
    label: 'poses',
    currentProjectId: () => projects.currentProjectId,
    isPersisting,
    build: () => ({ crs: currentCrs.value, poses: poses.value }),
    write: opfs.savePoses,
    onError: (err) => log(`Poses save failed — ${err?.message ?? err}`, 'error', 'Poses'),
  })

  // Name → image-id matching is shared with GCP observations / footprints /
  // COLMAP import (core/io/nameMatch.js). Indexed once per image-list change, so
  // a full reconcile is O(poses + images) rather than a scan per pose.
  const resolveImageId = computed(() => makeNameResolver(images.value))

  // Re-resolve every pose's imageId against the current image list (retroactive
  // association for poses imported before their images, or images added later).
  function resolveImageMatches() {
    let changed = false
    const resolve = resolveImageId.value
    const byId = new Map(images.value.map((img) => [img.id, img]))
    for (const p of poses.value) {
      if (relinkImageRecord(p, byId, resolve)) changed = true
    }
    if (changed) save()
  }

  // Keyed on id+name rather than a deep watch, so unrelated image mutations
  // (keypoints, masks, EXIF) don't trigger a full re-scan.
  const imageSig = computed(() => images.value.map((i) => `${i.id}:${i.name}`).join('|'))
  watch(imageSig, resolveImageMatches)

  // Add parsed poses (positions in `sourceCrs`), transforming into the project CRS.
  async function addPoses(rawPoses, sourceCrs) {
    const projCrs = currentCrs.value
    // If either CRS can't be resolved, transform() below would throw mid-loop —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`Pose import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'Pose')
      return 0
    }

    let added = 0
    let matched = 0
    for (const raw of rawPoses) {
      const [x, y, z] = transform([raw.x, raw.y, raw.z ?? 0], sourceCrs, projCrs)
      const imageId = resolveImageId.value(raw.imageName)
      if (imageId) matched++
      const existing = poses.value.find((p) => p.imageName === raw.imageName)
      const next = {
        imageId,
        imageName: raw.imageName,
        x, y, z: raw.z != null ? z : null,
        omega: raw.omega ?? null,
        phi:   raw.phi ?? null,
        kappa: raw.kappa ?? null,
        accXYZ:   raw.accXYZ ?? DEFAULT_ACC_XYZ,
        accuracyX: raw.accuracyX ?? raw.accXYZ ?? DEFAULT_ACC_XYZ,
        accuracyY: raw.accuracyY ?? raw.accXYZ ?? DEFAULT_ACC_XYZ,
        accuracyZ: raw.accuracyZ ?? raw.accXYZ ?? DEFAULT_ACC_XYZ,
        accAngle: raw.accAngle ?? DEFAULT_ACC_ANGLE,
        accuracyOmega: raw.accuracyOmega ?? raw.accAngle ?? DEFAULT_ACC_ANGLE,
        accuracyPhi:   raw.accuracyPhi   ?? raw.accAngle ?? DEFAULT_ACC_ANGLE,
        accuracyKappa: raw.accuracyKappa ?? raw.accAngle ?? DEFAULT_ACC_ANGLE,
        source: 'imported',
        enabled: true,
      }
      if (existing) Object.assign(existing, next)
      else { poses.value.push(normalizePose(next)); added++ }
    }
    log(`Poses imported: ${added}${matched ? `, ${matched} matched to images` : ''} (from ${sourceCrs})`, 'success', 'Pose')
    await save()
    return added
  }

  // Materialise image EXIF GPS in the existing pose store. Imported pose files
  // always win; EXIF records are derived idempotently and retain user toggles/
  // accuracy edits across metadata refreshes.
  let exifSyncGeneration = 0
  function assignIfChanged(target, values) {
    const changed = Object.entries(values).some(([key, value]) => !Object.is(target[key], value))
    if (changed) Object.assign(target, values)
    return changed
  }

  async function syncExifPosesNow() {
    const generation = ++exifSyncGeneration
    const projectId = projects.currentProjectId
    const projectCrs = currentCrs.value
    try {
      await ensureProjection('EPSG:4326')
      await ensureProjection(projectCrs)
    } catch (err) {
      log(`EXIF GPS unavailable — could not resolve CRS (${err?.message ?? err})`, 'warn', 'Pose')
      return 0
    }
    if (generation !== exifSyncGeneration || projectId !== projects.currentProjectId) return 0

    const liveIds = new Set(images.value.map((im) => im.id))
    let changed = false, added = 0
    // Drop derived records only when their image is genuinely gone. During restore,
    // metadata may arrive after images, so a temporarily missing meta object is kept.
    const kept = poses.value.filter((p) => p.source !== 'exif' || liveIds.has(p.imageId))
    if (kept.length !== poses.value.length) { poses.value = kept; changed = true }

    // One index per sync, not a linear search per image: the sync walks every image,
    // so a find() per image made it O(images × poses).
    const byImageId = new Map(), byImageName = new Map()
    for (const p of poses.value) {
      if (p.imageId != null && !byImageId.has(p.imageId)) byImageId.set(p.imageId, p)
      if (p.imageName != null && !byImageName.has(p.imageName)) byImageName.set(p.imageName, p)
    }
    for (const im of images.value) {
      const raw = exifPoseFromMetadata(im.meta)
      if (!raw) continue
      const projected = projectExifPose(raw, projectCrs)
      if (!projected) continue
      const existing = byImageId.get(im.id) ?? byImageName.get(im.name)
      if (existing && existing.source !== 'exif') continue
      if (existing) {
        changed = assignIfChanged(existing, {
          imageId: im.id, imageName: im.name, x: projected.x, y: projected.y, z: projected.z,
          altitudeMeters: projected.altitudeMeters,
          accuracyMetersX: projected.accuracyMetersX,
          accuracyMetersY: projected.accuracyMetersY,
          accuracyMetersZ: projected.accuracyMetersZ,
          accuracyMetersEast: projected.accuracyMetersEast,
          accuracyMetersNorth: projected.accuracyMetersNorth,
          accuracyMetersUp: projected.accuracyMetersUp,
          lon: projected.lon, lat: projected.lat,
          omegaEnu: projected.omegaEnu, phiEnu: projected.phiEnu, kappaEnu: projected.kappaEnu,
          direction: raw.direction, directionRef: raw.directionRef,
          verticalDatum: existing.verticalDatum ?? raw.verticalDatum,
          omega: projected.omega, phi: projected.phi, kappa: projected.kappa,
          orientationSource: raw.orientationSource,
        }) || changed
        // No pose-accuracy editor exists today, but preserve a future/manual
        // override explicitly marked as user-owned instead of overwriting it.
        if (existing.accuracySource !== 'user') {
          changed = assignIfChanged(existing, {
            accuracyX: projected.accuracyX, accuracyY: projected.accuracyY,
            accuracyZ: projected.accuracyZ, accXYZ: projected.accuracyX,
            accuracySource: raw.accuracySource,
          }) || changed
        }
        if (existing.orientationAccuracySource !== 'user') {
          changed = assignIfChanged(existing, {
            accuracyOmega: raw.accuracyOmega, accuracyPhi: raw.accuracyPhi,
            accuracyKappa: raw.accuracyKappa,
            orientationAccuracySource: raw.orientationSource ? 'exif' : null,
          }) || changed
        }
      } else {
        const pose = normalizePose({
          imageId: im.id, imageName: im.name,
          x: projected.x, y: projected.y, z: projected.z,
          omega: projected.omega, phi: projected.phi, kappa: projected.kappa,
          accuracyX: projected.accuracyX, accuracyY: projected.accuracyY,
          accuracyZ: projected.accuracyZ, accXYZ: projected.accuracyX,
          altitudeMeters: projected.altitudeMeters,
          accuracyMetersX: projected.accuracyMetersX,
          accuracyMetersY: projected.accuracyMetersY,
          accuracyMetersZ: projected.accuracyMetersZ,
          accuracyMetersEast: projected.accuracyMetersEast,
          accuracyMetersNorth: projected.accuracyMetersNorth,
          accuracyMetersUp: projected.accuracyMetersUp,
          lon: projected.lon, lat: projected.lat,
          omegaEnu: projected.omegaEnu, phiEnu: projected.phiEnu, kappaEnu: projected.kappaEnu,
          accuracyOmega: raw.accuracyOmega, accuracyPhi: raw.accuracyPhi,
          accuracyKappa: raw.accuracyKappa,
          accAngle: raw.accuracyOmega ?? DEFAULT_ACC_ANGLE,
          accuracySource: raw.accuracySource, verticalDatum: raw.verticalDatum,
          orientationSource: raw.orientationSource,
          orientationAccuracySource: raw.orientationSource ? 'exif' : null,
          direction: raw.direction, directionRef: raw.directionRef,
          source: 'exif', enabled: true,
        })
        poses.value.push(pose)
        byImageId.set(im.id, pose); byImageName.set(im.name, pose)
        added++
        changed = true
      }
    }
    if (changed) await save()
    if (added) queueExifReport(projectId, projectCrs, added)
    return added
  }

  // Each image's metadata arrives on its own, so one dropped batch runs the sync
  // above once per image. Reporting per sync printed "1 camera position added" and
  // the geographic-CRS advice 127 times for 127 images; instead the counts are
  // collected per CRS and reported once the image store goes idle (or right away
  // when nothing is importing, e.g. an edit to one image's metadata).
  const imagesStore = useImagesStore()
  let pendingExif = null // { projectId, byCrs: Map<crs, added> }
  let exifSyncsInFlight = 0
  function queueExifReport(projectId, crs, added) {
    if (pendingExif?.projectId !== projectId) pendingExif = { projectId, byCrs: new Map() }
    pendingExif.byCrs.set(crs, (pendingExif.byCrs.get(crs) ?? 0) + added)
  }
  function flushExifReport() {
    if (!pendingExif || exifSyncsInFlight > 0 || imagesStore.pendingWorkCount > 0) return
    const { projectId, byCrs } = pendingExif
    pendingExif = null
    if (projectId !== projects.currentProjectId) return
    for (const [crs, added] of byCrs) {
      log(`EXIF GPS: ${pluralize(added, 'camera position')} added in ${crs}`, 'success', 'Pose')
      // Positions land in degrees, so nothing can be georeferenced until the user
      // picks a projected CRS. Say so once per batch, when they arrive — with the
      // derived choice and its inputs — rather than first at Build DEM. Only for the
      // CRS still in force: an earlier one has since been replaced.
      if (!isGeographic(crs) || crs !== currentCrs.value) continue
      const hint = suggestProjectedCrs(poses.value.filter((p) => p.source === 'exif').map((p) => ({ lon: p.x, lat: p.y })))
      if (hint) {
        log(`EXIF GPS: ${crs} is geographic, so georeferenced DEMs and orthophotos need a projected CRS — `
          + `median of ${pluralize(hint.count, 'position')} at ${formatLatLon(hint.lat, hint.lon)} suggests `
          + `${hint.code} (${hint.name}); set it in Project Settings`, 'info', 'Pose')
      }
    }
  }
  watch(() => imagesStore.pendingWorkCount, (n) => { if (n === 0) flushExifReport() })
  async function syncExifPoses() {
    exifSyncsInFlight++
    try { return await syncExifPosesNow() } finally {
      exifSyncsInFlight--
      flushExifReport()
    }
  }

  // Which EXIF fields the poses derive from, as a NUMBER (FNV-1a over them). Each
  // image's metadata lands separately, so this re-evaluates once per image: as one
  // joined string it built ~150 characters × every image on every landing (O(N²)
  // characters for one import) and ran a full sync each time (O(N³) with the old
  // linear lookups). The sync itself is debounced to the end of a burst, with a
  // maximum wait so a long import still shows its cameras on the way.
  const EXIF_FIELDS = ['gpsLat', 'gpsLon', 'gpsAlt', 'gpsAltRef', 'gpsHorizontalAccuracy', 'gpsAccuracyX',
    'gpsAccuracyY', 'gpsAccuracyZ', 'gpsDirection', 'gpsDirectionRef', 'cameraOmega', 'cameraPhi',
    'cameraKappa', 'cameraAccuracyOmega', 'cameraAccuracyPhi', 'cameraAccuracyKappa']
  const exifSig = computed(() => {
    let h = 0x811c9dc5
    const mixStr = (s) => { s = String(s ?? ''); for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0; h = Math.imul(h ^ 0x7c, 0x01000193) >>> 0 }
    for (const im of images.value) {
      const m = im.meta || {}
      mixStr(im.id); mixStr(im.name)
      for (const k of EXIF_FIELDS) mixStr(m[k])
    }
    return `${images.value.length}:${h}`
  })
  let syncTimer = null, syncDeadline = 0
  const scheduleExifSync = () => {
    const now = Date.now()
    if (syncTimer == null) syncDeadline = now + 3000
    clearTimeout(syncTimer)
    syncTimer = setTimeout(() => { syncTimer = null; syncExifPoses() }, Math.max(0, Math.min(300, syncDeadline - now)))
  }
  watch(exifSig, scheduleExifSync, { immediate: true })


  // Only { purge: true } deletes persisted data; a plain clear (project
  // switch/close) leaves OPFS intact so restore can read it back.
  function clear({ purge = false } = {}) {
    poses.value = []
    if (purge && isPersisting()) opfs.deletePoses(projects.currentProjectId).catch(() => {})
  }

  async function restore({ projectId, projectData }) {
    const projectCrs = projectData?.crs
    poses.value = []
    const data = await opfs.loadPoses(projectId)
    if (!data?.poses?.length) return
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      poses.value = data.poses.map((p) => reprojectPose(p, data.crs, projectCrs))
      await opfs.savePoses(projectId, { crs: projectCrs, poses: poses.value }).catch(() => {})
    } else {
      poses.value = data.poses.map(normalizePose)
    }
    resolveImageMatches()
    await syncExifPoses()
    log(`Poses restored: ${poses.value.length}`, 'success', 'Pose')
  }

  // Re-project all stored poses when the project CRS changes.
  async function reprojectPoses(fromCrs, toCrs) {
    if (!poses.value.length || fromCrs === toCrs) { await save(); return }
    await ensureProjection(fromCrs).catch(() => {})
    await ensureProjection(toCrs).catch(() => {})
    poses.value = poses.value.map((p) => reprojectPose(p, fromCrs, toCrs))
    await save()
    log(`Poses re-projected to ${toCrs}`, 'info', 'Pose')
  }

  return {
    poses,
    addPoses,
    syncExifPoses,
    reprojectPoses,
    restore,
    clear,
  }
}))
