import { ref, watch, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, transform, isGeographic, localMetricFrame } from '../core/crs.js'
import { projectFootprint } from '../core/footprint.js'
import { resolveK } from '../core/sfm/reconstruction.js'
import * as opfs from '../utils/opfs.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useProjectsStore } from './useProjectsStore.js'

// Project-scoped store: vector polygon layers ("shapefiles"), stored in the
// project working CRS and re-projected when it changes.
//
// A **set** is one vector layer the user manages as a unit (toggle on the map,
// rename, zoom to, delete) — created either by computing footprints from poses
// (one run = one set) or by importing a polygon file. Each set holds many
// **polygons**, and every polygon keeps its own image link (`imageId`/
// `imageName`), so the geometry stays associated with a specific image (used for
// spatial match preselection). Reads the image list / sensors / poses / project
// CRS from their stores; restore/clear run through the project-store registry.
export const useFootprintsStore = registerProjectStore(defineStore('footprints', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const { images } = storeToRefs(useImagesStore())
  const { sensors } = storeToRefs(useSensorsStore())
  const { poses } = storeToRefs(usePosesStore())
  const { currentCrs } = storeToRefs(projects)

  // [{ id, name, source: 'computed' | 'imported', onMap, footprints: [
  //     { id, imageId, imageName, rings: [[ [x,y], ... ], ...] } ] }]
  // rings are stored in the project CRS.
  const sets = ref([])

  // Flat list of every polygon in every set that is shown on the map — what the
  // map viewer renders. Each carries its `setId` so a per-set toggle/zoom can find
  // its polygons without re-flattening.
  const mapPolygons = computed(() =>
    sets.value
      .filter((s) => s.onMap !== false)
      .flatMap((s) => s.footprints.map((fp) => ({ ...fp, setId: s.id, setName: s.name }))),
  )

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  async function save() {
    if (!isPersisting()) return
    await opfs.saveFootprints(projects.currentProjectId, {
      crs: currentCrs.value,
      sets: sets.value,
    }).catch((err) => log(`Shapefile save failed — ${err?.message ?? err}`, 'error', 'Footprint'))
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

  // Re-resolve every polygon's imageId across every set against the current image
  // list. Lets a polygon imported before its image (or images added later) link up.
  function resolveImageMatches() {
    let changed = false
    for (const set of sets.value) {
      for (const fp of set.footprints) {
        const id = resolveImageId(fp.imageName)
        if (id !== fp.imageId) { fp.imageId = id; changed = true }
      }
    }
    if (changed) save()
  }

  // Re-match whenever an image is added, removed, or renamed (retroactive
  // association). Keyed on id+name rather than a deep watch, so unrelated image
  // mutations (keypoints, masks, EXIF) don't trigger a full re-scan.
  const imageSig = computed(() => images.value.map((i) => `${i.id}:${i.name}`).join('|'))
  watch(imageSig, resolveImageMatches)

  // A unique "<base> N" name within the current set list (so re-imports / re-runs
  // don't collide). `base` used as-is when free.
  function uniqueSetName(base) {
    const taken = new Set(sets.value.map((s) => s.name))
    if (!taken.has(base)) return base
    let n = 2
    while (taken.has(`${base} ${n}`)) n++
    return `${base} ${n}`
  }

  // Import a polygon file as ONE new set (given in `sourceCrs`), transforming the
  // rings into the project CRS. `name` defaults to a generic label.
  async function addFootprints(rawFootprints, sourceCrs, name = 'Imported footprints') {
    const projCrs = currentCrs.value
    // If either CRS can't be resolved, transformRings() below would throw —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`Shapefile import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'Footprint')
      return 0
    }

    let matched = 0
    const footprints = rawFootprints.map((raw) => {
      const rings = transformRings(raw.rings, sourceCrs, projCrs)
      const imageId = resolveImageId(raw.imageName)
      if (imageId) matched++
      return { id: crypto.randomUUID(), imageId, imageName: raw.imageName ?? raw.name ?? null, rings }
    })
    if (!footprints.length) { log('Shapefile import: no polygons found', 'warn', 'Footprint'); return 0 }

    sets.value.push({
      id: crypto.randomUUID(),
      name: uniqueSetName(name),
      source: 'imported',
      onMap: true,
      footprints,
    })
    log(`Shapefile imported: ${footprints.length} polygon(s)${matched ? `, ${matched} matched to images` : ''} (from ${sourceCrs})`, 'success', 'Footprint')
    await save()
    return footprints.length
  }

  // Resolve usable intrinsics for a pose, preferring its matched image's sensor
  // and falling back to a sole sensor, then to a caller-supplied manual override
  // { focal(px), width, height }. Returns { focal(px), cx, cy, width, height } or
  // null. Exported so the modal can mirror eligibility without duplicating it.
  function resolveIntrinsics(pose, fallback = null) {
    const imageId = pose.imageId ?? resolveImageId(pose.imageName)
    const img = imageId ? images.value.find((i) => i.id === imageId) : null
    const sensor = (img && sensors.value.find((s) => s.id === img.sensorId))
      ?? (sensors.value.length === 1 ? sensors.value[0] : null)
    // Resolve intrinsics through the SAME resolver as SfM (resolveK), so any
    // EXIF-derivable focal works here too — 35mm-equivalent focal, or a physical
    // sensor width from FocalPlaneXResolution — not just an explicit pixel focal or
    // a manually-entered pixel size. Dimensions come from the sensor, falling back
    // to the image's own EXIF dimensions.
    if (sensor) {
      const w = sensor.width || img?.meta?.width
      const h = sensor.height || img?.meta?.height
      const k = resolveK(img?.meta ?? null, sensor)
      // Reject resolveK's default-FOV last resort (fx = max(w,h)): a guessed focal
      // would silently make a wrong footprint — better to report "no intrinsics".
      if (k && !k.source.startsWith('default FOV') && w > 0 && h > 0) {
        return { focal: k.fx, cx: k.cx, cy: k.cy, width: w, height: h }
      }
    }
    if (fallback && fallback.focal > 0 && fallback.width > 0 && fallback.height > 0) {
      return { focal: fallback.focal, cx: fallback.width / 2, cy: fallback.height / 2, width: fallback.width, height: fallback.height }
    }
    return null
  }

  // Synthesise ONE footprint set ("footprints") from camera poses + intrinsics by
  // projecting each image's corners onto a horizontal ground plane. Poses are
  // already in the project CRS (so are the resulting rings). Re-running replaces
  // the previously computed set. Settings:
  //   groundElev   absolute ground Z (project vertical units) — used when !useAgl
  //   useAgl       derive ground Z per image as pose.z − agl (height above ground)
  //   agl          flying height above ground, when useAgl
  //   assumeNadir  treat missing omega/phi/kappa as 0 (vertical aerial)
  //   intrinsics   manual { focal(px), width, height } fallback when a pose has no
  //                calibrated sensor (e.g. poses imported without their images)
  // Returns a summary { computed, skipped, reasons:{...}, setId }.
  function computeFootprints({ groundElev = 0, useAgl = false, agl = 0, assumeNadir = true, intrinsics = null } = {}) {
    const reasons = { noPose: 0, noElevation: 0, noAngles: 0, noSensor: 0, belowPlane: 0, diverges: 0 }

    // Footprint synthesis casts camera rays onto a horizontal plane in metres. In
    // a metric (projected) CRS we work directly in the project frame. In a
    // geographic (lat/lon) CRS the project units are degrees, so we instead build a
    // *local metric frame* (azimuthal-equidistant, centred on the poses), cast the
    // rays there, and map the resulting polygon corners back to the geographic CRS.
    // Near the data, aeqd's east/north align with geographic, so the pose angles
    // stay valid to within a small meridian-convergence error.
    const crs = currentCrs.value
    const geographic = isGeographic(crs)
    let toLocal = null, fromLocal = null
    if (geographic) {
      const valid = poses.value.filter((p) => p.enabled !== false && p.x != null && p.y != null)
      if (!valid.length) {
        log('Footprints computed from poses: 0 (no poses with a position)', 'warn', 'Footprint')
        return { computed: 0, skipped: poses.value.length, reasons, setId: null }
      }
      try {
        const cx = valid.reduce((s, p) => s + p.x, 0) / valid.length
        const cy = valid.reduce((s, p) => s + p.y, 0) / valid.length
        const [lon0, lat0] = transform([cx, cy], crs, 'EPSG:4326')   // centre in lon/lat
        const local = localMetricFrame(lon0, lat0)
        toLocal = (p) => transform([p.x, p.y], crs, local)            // → metres
        fromLocal = (c) => transform(c, local, crs)                   // metres → project CRS
      } catch (err) {
        log(`Cannot compute footprints — failed to build a local metric frame for ${crs} (${err?.message ?? err})`, 'error', 'Footprint')
        return { computed: 0, skipped: poses.value.length, reasons, setId: null }
      }
    }

    // One computed set at a time — a re-run replaces the previous one.
    sets.value = sets.value.filter((s) => s.source !== 'computed')

    const footprints = []
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
      // In a geographic CRS, ray-cast in the local metric frame, then map the ring
      // corners back to the project (geographic) CRS.
      let castPose = pose
      if (geographic) {
        const [lx, ly] = toLocal(pose)
        castPose = { ...pose, x: lx, y: ly }
      }
      let fp = projectFootprint(castPose, intr, groundZ)
      if (fp.error === 'below_plane') { reasons.belowPlane++; continue }
      if (fp.error) { reasons.diverges++; continue }
      if (geographic) fp = { rings: fp.rings.map((ring) => ring.map((c) => fromLocal(c))) }

      footprints.push({
        id: crypto.randomUUID(),
        imageId,
        imageName: pose.imageName,
        rings: fp.rings,
      })
    }

    let setId = null
    if (footprints.length) {
      setId = crypto.randomUUID()
      sets.value.push({ id: setId, name: uniqueSetName('footprints'), source: 'computed', onMap: true, footprints })
    }

    const REASON_LABEL = {
      noPose: 'no X/Y', noElevation: 'no elevation', noAngles: 'no angles',
      noSensor: 'no intrinsics', belowPlane: 'camera below ground plane', diverges: 'view too oblique',
    }
    const skipped = Object.values(reasons).reduce((a, b) => a + b, 0)
    const detail = Object.entries(reasons).filter(([, n]) => n).map(([k, n]) => `${n} ${REASON_LABEL[k]}`).join(', ')
    log(`Footprints computed from poses: ${footprints.length}${skipped ? ` (${skipped} skipped — ${detail})` : ''}`,
      footprints.length ? 'success' : 'warn', 'Footprint')
    save()
    return { computed: footprints.length, skipped, reasons, setId }
  }

  function removeSet(id) {
    const idx = sets.value.findIndex((s) => s.id === id)
    if (idx === -1) return
    const [removed] = sets.value.splice(idx, 1)
    log(`Shapefile removed: ${removed.name}`, 'info', 'Footprint', { channel: 'activity' })
    save()
  }

  function renameSet(id, name) {
    const set = sets.value.find((s) => s.id === id)
    if (!set) return
    const clean = String(name ?? '').trim()
    if (!clean || clean === set.name) return
    set.name = clean
    log(`Shapefile renamed to ${clean}`, 'info', 'Footprint', { channel: 'activity' })
    save()
  }

  function setSetOnMap(id, onMap) {
    const set = sets.value.find((s) => s.id === id)
    if (!set) return
    set.onMap = !!onMap
    log(`Shapefile ${set.name} ${set.onMap ? 'shown on' : 'hidden from'} map`, 'info', 'Footprint', { channel: 'activity' })
    save()
  }

  // The combined polygon rings of a set (used by the map to zoom to its extent).
  function setRings(id) {
    return sets.value.find((s) => s.id === id)?.footprints.flatMap((fp) => fp.rings) ?? []
  }

  // Only { purge: true } deletes persisted data; a plain clear (project
  // switch/close) leaves OPFS intact so restore can read it back.
  function clear({ purge = false } = {}) {
    sets.value = []
    if (purge && isPersisting()) opfs.deleteFootprints(projects.currentProjectId).catch(() => {})
  }

  // Normalise a stored payload into the sets shape. New projects carry `sets`;
  // older ones carry a flat `footprints` array — wrap those into one set so an
  // existing project isn't silently emptied.
  function normalizeStored(data) {
    if (Array.isArray(data?.sets)) return data.sets
    if (Array.isArray(data?.footprints) && data.footprints.length) {
      return [{
        id: crypto.randomUUID(),
        name: 'footprints',
        source: 'computed',
        onMap: true,
        footprints: data.footprints.map((f) => ({
          id: f.id ?? crypto.randomUUID(),
          imageId: f.imageId ?? null,
          imageName: f.imageName ?? f.name ?? null,
          rings: f.rings,
        })),
      }]
    }
    return []
  }

  async function restore({ projectId, projectData }) {
    const projectCrs = projectData?.crs
    sets.value = []
    const data = await opfs.loadFootprints(projectId)
    const stored = normalizeStored(data)
    if (!stored.length) return
    // Stored CRS may differ from the current project CRS (e.g. CRS changed elsewhere).
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      sets.value = stored.map((s) => ({
        ...s,
        footprints: s.footprints.map((fp) => ({ ...fp, rings: transformRings(fp.rings, data.crs, projectCrs) })),
      }))
      await opfs.saveFootprints(projectId, { crs: projectCrs, sets: sets.value }).catch(() => {})
    } else {
      sets.value = stored
    }
    resolveImageMatches()
    const polys = sets.value.reduce((n, s) => n + s.footprints.length, 0)
    log(`Shapefiles restored: ${sets.value.length} layer(s), ${polys} polygon(s)`, 'success', 'Footprint')
  }

  // Re-project every stored polygon when the project CRS changes.
  async function reprojectFootprints(fromCrs, toCrs) {
    if (!sets.value.length || fromCrs === toCrs) { await save(); return }
    await ensureProjection(fromCrs).catch(() => {})
    await ensureProjection(toCrs).catch(() => {})
    sets.value = sets.value.map((s) => ({
      ...s,
      footprints: s.footprints.map((fp) => ({ ...fp, rings: transformRings(fp.rings, fromCrs, toCrs) })),
    }))
    await save()
    log(`Shapefiles re-projected to ${toCrs}`, 'info', 'Footprint')
  }

  return {
    sets,
    mapPolygons,
    addFootprints,
    computeFootprints,
    resolveIntrinsics,
    removeSet,
    renameSet,
    setSetOnMap,
    setRings,
    reprojectFootprints,
    restore,
    clear,
  }
}))
