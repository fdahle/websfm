import { ref, watch, computed } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import { ensureProjection, transform, transformer, isGeographic, localMetricFrame } from '../core/crs.js'
import { projectFootprint, projectFootprintOnTerrain } from '../core/footprint.js'
import { terrainSampler, terrainZoom, TERRAIN_DATUM } from '../core/terrainHeights.js'
import { heightShifter, datumLabel, shiftRange } from '../core/verticalDatum.js'
import { makeNameResolver, relinkImageRecord } from '../core/io/nameMatch.js'
import { resolveK } from '../core/sfm/reconstruction.js'
import * as opfs from '../utils/opfs.js'
import { createDocumentSaver } from '../utils/documentSaver.js'
import { registerProjectStore } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useExternalStore } from './useExternalStore.js'
import { pluralize } from '../core/textFormat.js'

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
export const useFootprintsStore = registerProjectStore(
  defineStore('footprints', () => {
    const { log } = useLog()
    const projects = useProjectsStore()
    const { images } = storeToRefs(useImagesStore())
    const { sensors } = storeToRefs(useSensorsStore())
    const { poses } = storeToRefs(usePosesStore())
    const { currentCrs } = storeToRefs(projects)

    // [{ id, name, source: 'computed' | 'imported', visible, footprints: [
    //     { id, imageId, imageName, rings: [[ [x,y], ... ], ...] } ] }]
    // rings are stored in the project CRS. A line layer (contours: kind 'lines') holds
    //     { id, name, level, index, lines: [[ [x,y], ... ]] }
    // instead: open paths, no image link, the same CRS.
    const sets = ref([])

    // Flat list of every polygon in every set that is shown on the map — what the
    // map viewer renders. Each carries its `setId` so a per-set toggle/zoom can find
    // its polygons without re-flattening.
    const mapPolygons = computed(() =>
      sets.value
        .filter((s) => s.visible !== false)
        .flatMap((s) => s.footprints.map((fp) => ({ ...fp, setId: s.id, setName: s.name }))),
    )

    // Persist only when a project is open and OPFS is usable (see useProjectsStore).
    const isPersisting = () => projects.isPersisting

    const save = createDocumentSaver({
      label: 'footprints',
      currentProjectId: () => projects.currentProjectId,
      isPersisting,
      build: () => ({ crs: currentCrs.value, sets: sets.value }),
      write: opfs.saveFootprints,
      onError: (err) => log(`Shapefile save failed — ${err?.message ?? err}`, 'error', 'Footprint'),
    })

    // Name → image-id matching is shared with GCP observations / poses / COLMAP
    // import (core/io/nameMatch.js). Indexed once per image-list change, so a full
    // reconcile is O(polygons + images) rather than a scan per polygon.
    const resolveImageId = computed(() => makeNameResolver(images.value))

    function transformRings(rings, from, to) {
      return rings.map((ring) => ring.map((c) => transform([c[0], c[1]], from, to)))
    }
    // A polygon's rings or a line feature's paths, moved to another CRS.
    function transformFeature(fp, from, to) {
      if (fp.lines) return { ...fp, lines: transformRings(fp.lines, from, to) }
      return { ...fp, rings: transformRings(fp.rings, from, to) }
    }

    // Re-resolve every polygon's imageId across every set against the current image
    // list. Lets a polygon imported before its image (or images added later) link up.
    function resolveImageMatches() {
      let changed = false
      const resolve = resolveImageId.value
      const byId = new Map(images.value.map((img) => [img.id, img]))
      for (const set of sets.value) {
        for (const fp of set.footprints) {
          if (relinkImageRecord(fp, byId, resolve)) changed = true
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
        const imageId = resolveImageId.value(raw.imageName)
        if (imageId) matched++
        return { id: crypto.randomUUID(), imageId, imageName: raw.imageName ?? raw.name ?? null, rings }
      })
      if (!footprints.length) {
        log('Shapefile import: no polygons found', 'warn', 'Footprint')
        return 0
      }

      sets.value.push({
        id: crypto.randomUUID(),
        name: uniqueSetName(name),
        source: 'imported',
        visible: true,
        footprints,
      })
      log(
        `Shapefile imported: ${pluralize(footprints.length, 'polygon')}${matched ? `, ${matched} matched to images` : ''} (from ${sourceCrs})`,
        'success',
        'Footprint',
      )
      await save()
      return footprints.length
    }

    // Contour lines (Tools ▸ Products ▾ ▸ Contours) as ONE new line layer. `lines`:
    // [{ path: [[x,y], …], level, index }] in `sourceCrs` (the DEM's).
    async function addLineSet(lines, sourceCrs, name) {
      const projCrs = currentCrs.value
      try {
        await ensureProjection(sourceCrs)
        await ensureProjection(projCrs)
      } catch (err) {
        log(`Line layer not added — could not resolve CRS (${err?.message ?? err})`, 'error', 'Footprint')
        return null
      }
      const footprints = lines.map((l) => ({
        id: crypto.randomUUID(),
        name: String(l.level),
        level: l.level,
        index: !!l.index,
        lines: sourceCrs === projCrs ? [l.path] : transformRings([l.path], sourceCrs, projCrs),
      }))
      const set = {
        id: crypto.randomUUID(),
        name: uniqueSetName(name),
        source: 'computed',
        kind: 'lines',
        visible: true,
        footprints,
      }
      sets.value.push(set)
      await save()
      return set
    }

    // Resolve usable intrinsics for a pose, preferring its matched image's sensor
    // and falling back to a sole sensor, then to a caller-supplied manual override
    // { focal(px), width, height }. Returns { focal(px), cx, cy, width, height } or
    // null. Exported so the modal can mirror eligibility without duplicating it.
    function resolveIntrinsics(pose, fallback = null) {
      const imageId = pose.imageId ?? resolveImageId.value(pose.imageName)
      const img = imageId ? images.value.find((i) => i.id === imageId) : null
      const sensor =
        (img && sensors.value.find((s) => s.id === img.sensorId)) ??
        (sensors.value.length === 1 ? sensors.value[0] : null)
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
        return {
          focal: fallback.focal,
          cx: fallback.width / 2,
          cy: fallback.height / 2,
          width: fallback.width,
          height: fallback.height,
        }
      }
      return null
    }

    // Synthesise ONE footprint set ("footprints") from camera poses + intrinsics by
    // projecting each image's corners onto the ground. Poses are already in the
    // project CRS (so are the resulting rings). Re-running replaces the previously
    // computed set. Settings:
    //   ground       'dem'      — follow a terrain model (monoplotting per corner)
    //                'absolute' — one horizontal plane at groundElev
    //                'agl'      — a plane per image at pose.z − agl
    //   demSource    'terrain' (the global terrain tiles) or a reference DEM's id
    //   poseDatum    vertical datum of the camera heights; the DEM's heights are
    //                converted to it when both convert (core/verticalDatum.js)
    //   groundElev   absolute ground Z (project vertical units)
    //   agl          flying height above ground
    //   assumeNadir  treat missing omega/phi/kappa as 0 (vertical aerial)
    //   intrinsics   manual { focal(px), width, height } fallback when a pose has no
    //                calibrated sensor (e.g. poses imported without their images)
    // Returns a summary { computed, skipped, reasons:{...}, setId }.
    async function computeFootprints({
      ground = 'absolute',
      groundElev = 0,
      agl = 0,
      demSource = 'terrain',
      poseDatum = 'unknown',
      assumeNadir = true,
      intrinsics = null,
    } = {}) {
      const reasons = { noPose: 0, noElevation: 0, noAngles: 0, noSensor: 0, belowPlane: 0, diverges: 0, offTerrain: 0 }
      const none = () => ({ computed: 0, skipped: poses.value.length, reasons, setId: null })
      const valid = poses.value.filter((p) => p.enabled !== false && p.x != null && p.y != null)

      // Footprint synthesis casts camera rays onto the ground in metres. In a
      // metric (projected) CRS we work directly in the project frame. In a
      // geographic (lat/lon) CRS the project units are degrees, so we instead build a
      // *local metric frame* (azimuthal-equidistant, centred on the poses), cast the
      // rays there, and map the resulting polygon corners back to the geographic CRS.
      // Near the data, aeqd's east/north align with geographic, so the pose angles
      // stay valid to within a small meridian-convergence error.
      const crs = currentCrs.value
      const geographic = isGeographic(crs)
      let toLocal = null,
        fromLocal = null,
        local = null
      if (geographic) {
        if (!valid.length) {
          log('Footprints computed from poses: 0 (no poses with a position)', 'warn', 'Footprint')
          return none()
        }
        try {
          const cx = valid.reduce((s, p) => s + p.x, 0) / valid.length
          const cy = valid.reduce((s, p) => s + p.y, 0) / valid.length
          const [lon0, lat0] = transform([cx, cy], crs, 'EPSG:4326') // centre in lon/lat
          local = localMetricFrame(lon0, lat0)
          toLocal = (p) => transform([p.x, p.y], crs, local) // → metres
          fromLocal = (c) => transform(c, local, crs) // metres → project CRS
        } catch (err) {
          log(
            `Cannot compute footprints — failed to build a local metric frame for ${crs} (${err?.message ?? err})`,
            'error',
            'Footprint',
          )
          return none()
        }
      }

      // The terrain surface, in the frame the rays are cast in.
      let surface = null
      if (ground === 'dem') {
        try {
          surface = await groundSurface({ demSource, poseDatum, crs, local, valid })
        } catch (err) {
          log(`Cannot compute footprints on the terrain — ${err?.message ?? err}`, 'error', 'Footprint')
          return none()
        }
      }

      const footprints = []
      for (const pose of poses.value) {
        if (pose.enabled === false) continue
        if (pose.x == null || pose.y == null) {
          reasons.noPose++
          continue
        }
        if (pose.z == null) {
          reasons.noElevation++
          continue
        }
        if (!assumeNadir && (pose.omega == null || pose.phi == null || pose.kappa == null)) {
          reasons.noAngles++
          continue
        }

        const intr = resolveIntrinsics(pose, intrinsics)
        if (!intr) {
          reasons.noSensor++
          continue
        }
        const imageId = pose.imageId ?? resolveImageId.value(pose.imageName)

        // In a geographic CRS, ray-cast in the local metric frame, then map the ring
        // corners back to the project (geographic) CRS.
        let castPose = pose
        if (geographic) {
          const [lx, ly] = toLocal(pose)
          castPose = { ...pose, x: lx, y: ly }
        }
        let fp = surface
          ? await projectFootprintOnTerrain(castPose, intr, surface.heightAt)
          : projectFootprint(castPose, intr, ground === 'agl' ? pose.z - agl : groundElev)
        if (fp.error === 'below_plane') {
          reasons.belowPlane++
          continue
        }
        if (fp.error === 'off_terrain') {
          reasons.offTerrain++
          continue
        }
        if (fp.error) {
          reasons.diverges++
          continue
        }
        if (geographic) fp = { rings: fp.rings.map((ring) => ring.map((c) => fromLocal(c))) }

        footprints.push({
          id: crypto.randomUUID(),
          imageId,
          imageName: pose.imageName,
          rings: fp.rings,
        })
      }

      // One computed footprint set at a time — a re-run replaces the previous one.
      // Contour line layers are computed too, and stay.
      sets.value = sets.value.filter((s) => s.source !== 'computed' || s.kind === 'lines')
      let setId = null
      if (footprints.length) {
        setId = crypto.randomUUID()
        sets.value.push({ id: setId, name: uniqueSetName('footprints'), source: 'computed', visible: true, footprints })
      }

      const REASON_LABEL = {
        noPose: 'no X/Y',
        noElevation: 'no elevation',
        noAngles: 'no angles',
        noSensor: 'no intrinsics',
        belowPlane: 'camera below the ground',
        diverges: 'view too oblique',
        offTerrain: 'no terrain height',
      }
      const skipped = Object.values(reasons).reduce((a, b) => a + b, 0)
      const detail = Object.entries(reasons)
        .filter(([, n]) => n)
        .map(([k, n]) => `${n} ${REASON_LABEL[k]}`)
        .join(', ')
      log(
        `Footprints computed from poses: ${footprints.length}${skipped ? ` (${skipped} skipped — ${detail})` : ''}` +
          (surface ? ` — ground from ${surface.describe()}` : ''),
        footprints.length ? 'success' : 'warn',
        'Footprint',
      )
      if (surface?.error) log(`Terrain: ${surface.error}`, 'warn', 'Footprint')
      if (reasons.belowPlane && surface) {
        log(
          'Cameras below the terrain usually mean their heights are in another vertical datum than ' +
            'chosen, or are heights above take-off rather than absolute',
          'warn',
          'Footprint',
        )
      }
      save()
      return { computed: footprints.length, skipped, reasons, setId }
    }

    // A terrain surface for footprints: `heightAt(x, y)` in the frame rays are cast
    // in (the project CRS, or the local metric frame `local` of a geographic one),
    // heights in `poseDatum` when the DEM's datum converts to it. Throws with a
    // user-facing reason.
    // → { heightAt, describe() → text for the log, error: first tile failure | null }
    async function groundSurface({ demSource, poseDatum, crs, local, valid }) {
      if (!valid.length) throw new Error('no poses with a position')
      const frame = local ?? crs
      const target = poseDatum && poseDatum !== 'unknown' ? poseDatum : null

      if (demSource !== 'terrain') {
        const external = useExternalStore()
        const s = await external.referenceDemSampler(demSource, crs, { datum: target })
        const toProject = local ? transformer(local, crs) : (x, y) => [x, y]
        const conv = s.conversion
        return {
          heightAt: (x, y) => s.sample(...toProject(x, y)),
          describe: () =>
            `reference DEM "${s.meta.name}"` +
            (conv && conv.min <= conv.max
              ? `, ${datumLabel(conv.from)} → ${datumLabel(conv.to)} ${shiftRange(conv)}`
              : ''),
          error: null,
        }
      }

      await ensureProjection(crs)
      const toLonLat = transformer(frame, 'EPSG:4326')
      const lonLats = valid.map((p) => transform([p.x, p.y], crs, 'EPSG:4326'))
      // Corners reach past the cameras by about the flying height; pad the box by
      // a quarter of its size and at least ~2 km so the edge tiles come in at once.
      let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity]
      for (const [lon, lat] of lonLats) {
        w = Math.min(w, lon)
        e = Math.max(e, lon)
        s = Math.min(s, lat)
        n = Math.max(n, lat)
      }
      const pad = Math.max(0.02, 0.25 * Math.max(e - w, n - s))
      const box = [w - pad, Math.max(-85, s - pad), e + pad, Math.min(85, n + pad)]
      const sampler = terrainSampler(terrainZoom(box))
      await sampler.prefetch(box)
      const shiftAt = target ? await heightShifter(TERRAIN_DATUM, target) : null
      if (target && !shiftAt) {
        log(
          `Terrain heights are ${datumLabel(TERRAIN_DATUM)}; camera heights in ${datumLabel(target)} cannot ` +
            'be converted to it, so the terrain is used as it is',
          'warn',
          'Footprint',
        )
      }
      const range = { min: Infinity, max: -Infinity }
      return {
        async heightAt(x, y) {
          const [lon, lat] = toLonLat(x, y)
          const h = await sampler.heightAt(lon, lat)
          if (h == null || !shiftAt) return h
          const shift = shiftAt(lon, lat)
          if (shift < range.min) range.min = shift
          if (shift > range.max) range.max = shift
          return h + shift
        },
        describe: () =>
          `the global terrain (level ${sampler.zoom}, ${sampler.tileCount} tiles)` +
          (range.min <= range.max ? `, ${datumLabel(TERRAIN_DATUM)} → ${datumLabel(target)} ${shiftRange(range)}` : ''),
        get error() {
          return sampler.error
        },
      }
    }

    function removeSet(id) {
      const idx = sets.value.findIndex((s) => s.id === id)
      if (idx === -1) return false
      const [removed] = sets.value.splice(idx, 1)
      log(`Shapefile removed: ${removed.name}`, 'info', 'Footprint', { channel: 'activity' })
      save()
      return true
    }

    function renameSet(id, name) {
      const set = sets.value.find((s) => s.id === id)
      if (!set) return false
      const clean = String(name ?? '').trim()
      if (!clean || clean === set.name) return false
      set.name = clean
      log(`Shapefile renamed to ${clean}`, 'info', 'Footprint', { channel: 'activity' })
      save()
      return true
    }

    function setSetVisible(id, visible) {
      const set = sets.value.find((s) => s.id === id)
      if (!set) return
      set.visible = !!visible
      log(`Shapefile ${set.name} ${set.visible ? 'shown on' : 'hidden from'} map`, 'info', 'Footprint', {
        channel: 'activity',
      })
      save()
    }

    // The combined polygon rings (or line paths) of a set: the map zooms to their extent.
    function setRings(id) {
      return sets.value.find((s) => s.id === id)?.footprints.flatMap((fp) => fp.rings ?? fp.lines ?? []) ?? []
    }

    // Only { purge: true } deletes persisted data; a plain clear (project
    // switch/close) leaves OPFS intact so restore can read it back.
    function clear({ purge = false } = {}) {
      sets.value = []
      if (purge && isPersisting()) opfs.deleteFootprints(projects.currentProjectId).catch(() => {})
    }

    async function restore({ projectId, projectData }) {
      const projectCrs = projectData?.crs
      sets.value = []
      const data = await opfs.loadFootprints(projectId)
      const stored = Array.isArray(data?.sets) ? data.sets : []
      if (!stored.length) return
      // Stored CRS may differ from the current project CRS (e.g. CRS changed elsewhere).
      if (data.crs && projectCrs && data.crs !== projectCrs) {
        await ensureProjection(data.crs).catch(() => {})
        await ensureProjection(projectCrs).catch(() => {})
        sets.value = stored.map((s) => ({
          ...s,
          footprints: s.footprints.map((fp) => transformFeature(fp, data.crs, projectCrs)),
        }))
        await opfs.saveFootprints(projectId, { crs: projectCrs, sets: sets.value }).catch(() => {})
      } else {
        sets.value = stored
      }
      resolveImageMatches()
      const polys = sets.value.reduce((n, s) => n + s.footprints.length, 0)
      log(
        `Shapefiles restored: ${pluralize(sets.value.length, 'layer')}, ${pluralize(polys, 'polygon')}`,
        'success',
        'Footprint',
      )
    }

    // Re-project every stored polygon when the project CRS changes.
    async function reprojectFootprints(fromCrs, toCrs) {
      if (!sets.value.length || fromCrs === toCrs) {
        await save()
        return
      }
      await ensureProjection(fromCrs).catch(() => {})
      await ensureProjection(toCrs).catch(() => {})
      sets.value = sets.value.map((s) => ({
        ...s,
        footprints: s.footprints.map((fp) => transformFeature(fp, fromCrs, toCrs)),
      }))
      await save()
      log(`Shapefiles re-projected to ${toCrs}`, 'info', 'Footprint')
    }

    return {
      sets,
      mapPolygons,
      addFootprints,
      addLineSet,
      computeFootprints,
      resolveIntrinsics,
      removeSet,
      renameSet,
      setSetVisible,
      setRings,
      reprojectFootprints,
      restore,
      clear,
    }
  }),
)
