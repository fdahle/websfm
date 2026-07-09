import { ref, watch, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, transform } from '../core/crs.js'
import { projectFootprint, focalPx } from '../core/footprint.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// Project-scoped store: image footprint polygons, stored in the project working
// CRS and re-projected when it changes. Rings link to images by name. Reads the
// image list / project CRS / persistence flags from the images & projects stores;
// restore/clear run through the project-store registry.
export const useFootprintsStore = registerProjectStore(defineStore('footprints', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const { images } = storeToRefs(useImagesStore())
  const { sensors } = storeToRefs(useSensorsStore())
  const { poses } = storeToRefs(usePosesStore())
  const { currentCrs } = storeToRefs(projects)

  // [{ id, name, imageId, imageName, rings: [[ [x,y], ... ], ...], enabled }]
  // rings are stored in the project CRS.
  const footprints = ref([])

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  async function save() {
    if (!isPersisting()) return
    await opfs.saveFootprints(projects.currentProjectId, {
      crs: currentCrs.value,
      footprints: footprints.value,
    }).catch((err) => log(`Footprint save failed — ${err?.message ?? err}`, 'error', 'Footprint'))
  }

  // Resolve an image name to an in-memory image id (case-insensitive, tolerant of
  // extension differences). Same matching as GCP observations.
  function resolveImageId(imageName) {
    if (!imageName) return null
    const lc = imageName.toLowerCase()
    const base = lc.replace(/\.[^.]+$/, '')
    const hit = images.value.find((img) => {
      const n = img.name.toLowerCase()
      return n === lc || n.replace(/\.[^.]+$/, '') === base
    })
    return hit?.id ?? null
  }

  function transformRings(rings, from, to) {
    return rings.map((ring) => ring.map((c) => transform([c[0], c[1]], from, to)))
  }

  // Re-resolve every footprint's imageId against the current image list. Lets a
  // footprint imported before its image (or images added later) link up.
  function resolveImageMatches() {
    let changed = false
    for (const fp of footprints.value) {
      const id = resolveImageId(fp.imageName)
      if (id !== fp.imageId) { fp.imageId = id; changed = true }
    }
    if (changed) save()
  }

  // Re-match whenever an image is added, removed, or renamed (retroactive
  // association). Keyed on id+name rather than a deep watch, so unrelated image
  // mutations (keypoints, masks, EXIF) don't trigger a full re-scan.
  const imageSig = computed(() => images.value.map((i) => `${i.id}:${i.name}`).join('|'))
  watch(imageSig, resolveImageMatches)

  // Add parsed footprints (given in `sourceCrs`), transforming rings into the project CRS.
  async function addFootprints(rawFootprints, sourceCrs) {
    const projCrs = currentCrs.value
    // If either CRS can't be resolved, transformRings() below would throw —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`Footprint import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'Footprint')
      return 0
    }

    let added = 0
    let matched = 0
    for (const raw of rawFootprints) {
      const rings = transformRings(raw.rings, sourceCrs, projCrs)
      const imageId = resolveImageId(raw.imageName)
      if (imageId) matched++
      footprints.value.push({
        id: crypto.randomUUID(),
        name: raw.name,
        imageId,
        imageName: raw.imageName,
        rings,
        enabled: true,
      })
      added++
    }
    log(`Footprints imported: ${added} polygon(s)${matched ? `, ${matched} matched to images` : ''} (from ${sourceCrs})`, 'success', 'Footprint')
    await save()
    return added
  }

  // Resolve usable intrinsics for a pose, preferring its matched image's sensor
  // (when that sensor's focal resolves to pixels) and falling back to a sole
  // sensor, then to a caller-supplied manual override { focal(px), width, height }.
  // Returns { focal(px), cx, cy, width, height } or null. Exported via the store
  // so the modal can mirror eligibility without duplicating the lookup.
  function resolveIntrinsics(pose, fallback = null) {
    const imageId = pose.imageId ?? resolveImageId(pose.imageName)
    const img = imageId ? images.value.find((i) => i.id === imageId) : null
    const sensor = (img && sensors.value.find((s) => s.id === img.sensorId))
      ?? (sensors.value.length === 1 ? sensors.value[0] : null)
    const f = focalPx(sensor)
    if (sensor && f != null && sensor.width > 0 && sensor.height > 0) {
      return { focal: f, cx: sensor.cx ?? sensor.width / 2, cy: sensor.cy ?? sensor.height / 2, width: sensor.width, height: sensor.height }
    }
    if (fallback && fallback.focal > 0 && fallback.width > 0 && fallback.height > 0) {
      return { focal: fallback.focal, cx: fallback.width / 2, cy: fallback.height / 2, width: fallback.width, height: fallback.height }
    }
    return null
  }

  // Synthesise footprints from camera poses + intrinsics by projecting each
  // image's corners onto a horizontal ground plane. Poses are already in the
  // project CRS (so are the resulting rings). Settings:
  //   groundElev   absolute ground Z (project vertical units) — used when !useAgl
  //   useAgl       derive ground Z per image as pose.z − agl (height above ground)
  //   agl          flying height above ground, when useAgl
  //   assumeNadir  treat missing omega/phi/kappa as 0 (vertical aerial)
  //   overwrite    drop previously computed footprints first (imported ones kept)
  //   intrinsics   manual { focal(px), width, height } fallback when a pose has no
  //                calibrated sensor (e.g. poses imported without their images)
  // Returns a summary { computed, skipped, reasons:{...} }.
  function computeFootprints({ groundElev = 0, useAgl = false, agl = 0, assumeNadir = true, overwrite = true, intrinsics = null } = {}) {
    const reasons = { noPose: 0, noElevation: 0, noAngles: 0, noSensor: 0, belowPlane: 0, diverges: 0 }
    if (overwrite) {
      footprints.value = footprints.value.filter((f) => f.source !== 'computed')
    }

    let computed = 0
    for (const pose of poses.value) {
      if (pose.enabled === false) continue
      if (pose.x == null || pose.y == null) { reasons.noPose++; continue }
      if (pose.z == null) { reasons.noElevation++; continue }
      if (!assumeNadir && (pose.omega == null || pose.phi == null || pose.kappa == null)) {
        reasons.noAngles++; continue
      }

      const intr = resolveIntrinsics(pose, intrinsics)
      if (!intr) { reasons.noSensor++; continue }
      const imageId = pose.imageId ?? resolveImageId(pose.imageName)

      const groundZ = useAgl ? pose.z - agl : groundElev
      const fp = projectFootprint(pose, intr, groundZ)
      if (fp.error === 'below_plane') { reasons.belowPlane++; continue }
      if (fp.error) { reasons.diverges++; continue }

      footprints.value.push({
        id: crypto.randomUUID(),
        name: pose.imageName,
        imageId,
        imageName: pose.imageName,
        rings: fp.rings,
        enabled: true,
        source: 'computed',
      })
      computed++
    }

    const REASON_LABEL = {
      noPose: 'no X/Y', noElevation: 'no elevation', noAngles: 'no angles',
      noSensor: 'no intrinsics', belowPlane: 'camera below ground plane', diverges: 'view too oblique',
    }
    const skipped = Object.values(reasons).reduce((a, b) => a + b, 0)
    const detail = Object.entries(reasons).filter(([, n]) => n).map(([k, n]) => `${n} ${REASON_LABEL[k]}`).join(', ')
    log(`Footprints computed from poses: ${computed}${skipped ? ` (${skipped} skipped — ${detail})` : ''}`,
      computed ? 'success' : 'warn', 'Footprint')
    save()
    return { computed, skipped, reasons }
  }

  function removeFootprint(id) {
    const idx = footprints.value.findIndex((f) => f.id === id)
    if (idx === -1) return
    footprints.value.splice(idx, 1)
    save()
  }

  // Only { purge: true } deletes persisted data; a plain clear (project
  // switch/close) leaves OPFS intact so restore can read it back.
  function clear({ purge = false } = {}) {
    footprints.value = []
    if (purge && isPersisting()) opfs.deleteFootprints(projects.currentProjectId).catch(() => {})
  }

  async function restore({ projectId, projectData }) {
    const projectCrs = projectData?.crs
    footprints.value = []
    const data = await opfs.loadFootprints(projectId)
    if (!data?.footprints?.length) return
    // Stored CRS may differ from the current project CRS (e.g. CRS changed elsewhere).
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      footprints.value = data.footprints.map((f) => ({
        ...f,
        rings: transformRings(f.rings, data.crs, projectCrs),
      }))
      await opfs.saveFootprints(projectId, { crs: projectCrs, footprints: footprints.value }).catch(() => {})
    } else {
      footprints.value = data.footprints
    }
    resolveImageMatches()
    log(`Footprints restored: ${footprints.value.length} polygon(s)`, 'success', 'Footprint')
  }

  // Re-project all stored footprints when the project CRS changes.
  async function reprojectFootprints(fromCrs, toCrs) {
    if (!footprints.value.length || fromCrs === toCrs) { await save(); return }
    await ensureProjection(fromCrs).catch(() => {})
    await ensureProjection(toCrs).catch(() => {})
    footprints.value = footprints.value.map((f) => ({
      ...f,
      rings: transformRings(f.rings, fromCrs, toCrs),
    }))
    await save()
    log(`Footprints re-projected to ${toCrs}`, 'info', 'Footprint')
  }

  return {
    footprints,
    addFootprints,
    computeFootprints,
    resolveIntrinsics,
    removeFootprint,
    reprojectFootprints,
    restore,
    clear,
  }
}))
