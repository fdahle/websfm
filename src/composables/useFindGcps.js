import { toRaw } from 'vue'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { findReferenceMatches, alignTerrain } from '../workers/computeClient.js'
import { referenceGcpCandidates, referencePick, orthoFrame, trackObservations } from '../core/sfm/referenceGcps.js'
import { terrainInitial, terrainCandidates } from '../core/sfm/terrainControl.js'
import { fitSimilarity2d } from '../core/sfm/referenceLook.js'
import { cameraCenter } from '../core/sfm/geometry.js'
import { learnedDetector } from '../core/features/learnedDetectors.js'
import { isModelCached } from '../core/models/modelCache.js'
import { modelUrl } from '../core/models/registry.js'
import { useModelsStore } from '../stores/useModelsStore.js'
import { FIND_GCPS_DEFAULTS } from '../core/defaults.user.js'
import { polygonAreaTest } from '../core/products/vectorLayers.js'
import {
  gpsSearchOutline,
  searchRegion,
  footprintSearchPoints,
  searchAreaSource,
  polygonSetPoints,
} from '../core/sfm/referenceMatch.js'
import { worldToPixel } from '../core/io/rasterSample.js'
import { makePinholeToMark, makeFrameModelResolver } from '../core/sfm/displayFrame.js'
import { ensureProjection, transform, isGeographic, metresToCrsUnits } from '../core/crs.js'

// Reconstruct ▸ Find GCPs: candidate controls from matching the current orthophoto
// to a georeferenced reference raster (core/sfm/referenceMatch.js, referenceGcps.js).
// The dialog (FindGcpsModal.vue) reviews them; the bench runs the same search.

// The polygon layers that can mark stable ground: every vector set but lines.
export function stableAreaLayers() {
  return useFootprintsStore().sets.filter((s) => s.kind !== 'lines')
}

// What the search area would be now (core/sfm/referenceMatch.js searchAreaSource),
// with the counts behind it, for the dialog and for the search itself.
// → { source: 'manual' | 'ortho' | 'footprints' | 'gps' | null, set, footprintImages,
//     gpsImages, poses (enabled poses with a position, which footprints can be computed from) }
export function searchAreaPlan(searchSetId = null) {
  const recon = useReconstructionStore(),
    images = useImagesStore(),
    projects = useProjectsStore(),
    footprints = useFootprintsStore(),
    poses = usePosesStore()
  const ortho = recon.ortho,
    cloud = recon.mainSparseCloud
  const set = searchSetId ? (stableAreaLayers().find((s) => s.id === searchSetId) ?? null) : null
  const registered = cloud ? images.images.filter((im) => cloud.cameras.get(im.uuid)) : []
  const ids = new Set(registered.map((im) => im.id))
  const withFootprint = new Set()
  for (const fs of footprints.sets)
    if (fs.kind !== 'lines')
      for (const fp of fs.footprints || [])
        if (ids.has(fp.imageId) && fp.rings?.[0]?.length) withFootprint.add(fp.imageId)
  const gps = registered.filter(
    (im) => Number.isFinite(Number(im.meta?.gpsLon)) && Number.isFinite(Number(im.meta?.gpsLat)),
  )
  const crs = projects.currentCrs
  const counts = {
    footprintImages: withFootprint.size,
    gpsImages: gps.length,
    poses: poses.poses.filter((p) => p.enabled !== false && p.x != null && p.y != null).length,
  }
  const source = searchAreaSource({
    manual: !!set && polygonSetPoints(set).length >= 3,
    orthoGeoreferenced: !!(ortho?.crs && ortho.crs !== 'local'),
    hasCrs: !!(crs && crs !== 'local'),
    ...counts,
  })
  return { source, set, ...counts, registered, gps }
}

// Where in the reference to look, as searchAreaPlan says, in reference pixels:
// → { region, source } (region null: the whole reference).
async function searchArea(ortho, refRaster, searchSetId) {
  const projects = useProjectsStore()
  const plan = searchAreaPlan(searchSetId)
  const toPixels = (pts, crs) =>
    pts
      .map((p) => transform(p, crs, refRaster.crs))
      .map(([x, y]) => {
        const px = worldToPixel(refRaster, x, y)
        return [px.col, px.row]
      })
  const region = (pts, crs) => searchRegion(toPixels(pts, crs), refRaster.width, refRaster.height)
  const crs = projects.currentCrs
  switch (plan.source) {
    case 'manual':
      await ensureProjection(crs)
      return { region: region(polygonSetPoints(plan.set), crs), source: `the polygons of "${plan.set.name}"` }
    case 'ortho': {
      await ensureProjection(ortho.crs)
      const x1 = ortho.originX + ortho.width * ortho.gsd,
        y1 = ortho.originY - ortho.height * ortho.gsd
      const pts = [
        [ortho.originX, ortho.originY],
        [x1, ortho.originY],
        [x1, y1],
        [ortho.originX, y1],
      ]
      return { region: region(pts, ortho.crs), source: 'the georeferenced orthophoto' }
    }
    case 'footprints':
      await ensureProjection(crs)
      return {
        region: region(
          footprintSearchPoints(useFootprintsStore().sets, new Set(plan.registered.map((im) => im.id))),
          crs,
        ),
        source: "the photos' footprints",
      }
    case 'gps':
      return {
        region: region(
          gpsSearchOutline(plan.gps.map((im) => [Number(im.meta.gpsLon), Number(im.meta.gpsLat)])),
          'EPSG:4326',
        ),
        source: "the photos' GPS positions",
      }
  }
  return { region: null, source: null }
}

// A camera counts as vertical within this angle of straight down: its footprint's
// centre is then where it stands. An oblique's footprint lies kilometres off.
const VERTICAL_DEG = 20

/**
 * A similarity from orthophoto native px to reference native px, for the learned
 * coarse look: { a, b, tx, ty, scale, rotationDeg, rms, used, source } or null.
 * A georeferenced orthophoto gives it exactly; otherwise the registered cameras' GPS
 * positions, else the footprint centres of the near-vertical photos, are paired
 * with their camera centres in the orthophoto.
 */
async function orthoPrior(ortho, cloud, refRaster) {
  const toRef = async (pts, crs) => {
    await ensureProjection(crs)
    return pts.map((p) => {
      const [x, y] = transform(p, crs, refRaster.crs)
      const px = worldToPixel(refRaster, x, y)
      return px ? [px.col, px.row] : [NaN, NaN]
    })
  }
  const fit = (pairs, source) => {
    const m = fitSimilarity2d(pairs)
    return m && m.scale > 0 ? { ...m, source } : null
  }
  if (ortho.crs && ortho.crs !== 'local') {
    const grid = []
    for (const u of [0, 0.5, 1]) for (const v of [0, 0.5, 1]) grid.push([u * ortho.width, v * ortho.height])
    const world = grid.map(([u, v]) => [ortho.originX + u * ortho.gsd, ortho.originY - v * ortho.gsd])
    const q = await toRef(world, ortho.crs)
    return fit(
      grid.map((p, i) => ({ p, q: q[i] })),
      'the georeferenced orthophoto',
    )
  }
  let frame
  try {
    frame = orthoFrame(ortho)
  } catch {
    return null
  }
  const imagesStore = useImagesStore()
  const registered = imagesStore.images.filter((im) => cloud.cameras.get(im.uuid))
  const orthoPx = (cam) => {
    const [x, y] = frame.fromSfm(cameraCenter(cam))
    return [(x - ortho.originX) / ortho.gsd, (ortho.originY - y) / ortho.gsd]
  }
  const withGps = registered.filter(
    (im) => Number.isFinite(Number(im.meta?.gpsLon)) && Number.isFinite(Number(im.meta?.gpsLat)),
  )
  if (withGps.length >= 3) {
    const q = await toRef(
      withGps.map((im) => [Number(im.meta.gpsLon), Number(im.meta.gpsLat)]),
      'EPSG:4326',
    )
    const m = fit(
      withGps.map((im, i) => ({ p: orthoPx(cloud.cameras.get(im.uuid)), q: q[i] })),
      "the photos' GPS positions",
    )
    if (m) return m
  }
  const crs = useProjectsStore().currentCrs
  if (!crs || crs === 'local') return null
  const centre = new Map()
  for (const set of useFootprintsStore().sets) {
    if (set.kind === 'lines') continue
    for (const fp of set.footprints || []) {
      const ring = (fp.rings?.[0] || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
      const open =
        ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring
      if (fp.imageId == null || open.length < 3 || centre.has(fp.imageId)) continue
      centre.set(fp.imageId, [
        open.reduce((s, p) => s + p[0], 0) / open.length,
        open.reduce((s, p) => s + p[1], 0) / open.length,
      ])
    }
  }
  const cos = Math.cos((VERTICAL_DEG * Math.PI) / 180)
  const vertical = registered.filter((im) => {
    const cam = cloud.cameras.get(im.uuid)
    if (!centre.has(im.id)) return false
    const c = cameraCenter(cam),
      d = cam.R[2]
    const a = frame.fromSfm(c),
      b = frame.fromSfm([c[0] + d[0], c[1] + d[1], c[2] + d[2]])
    const v = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    return -v[2] / Math.hypot(...v) >= cos
  })
  if (vertical.length < 3) return null
  const q = await toRef(
    vertical.map((im) => centre.get(im.id)),
    crs,
  )
  return fit(
    vertical.map((im, i) => ({ p: orthoPx(cloud.cameras.get(im.uuid)), q: q[i] })),
    'the vertical photos’ footprints',
  )
}

// The coarse matcher: 'auto' is SuperPoint when its (user-supplied) weights are
// installed, else DISK, which websfm ships. Learned weights are fetched with consent.
async function resolveMatcher(matcher) {
  if (matcher === 'terrain') return 'terrain'
  let id = matcher
  if (id === 'auto') id = (await isModelCached(modelUrl('superpoint'))) ? 'superpoint' : 'disk'
  const spec = learnedDetector(id)
  if (spec && !(await useModelsStore().ensureReady([spec.modelId, spec.matcherModelId])))
    throw new Error(`${spec.label} and its LightGlue weights are needed for the coarse look`)
  return id
}

/**
 * Find candidate controls. `stableSetId` names a polygon layer (stableAreaLayers):
 * only candidates whose reference position lies inside one of its polygons are
 * kept, before they are spread over the block. `searchSetId` names a polygon layer
 * whose extent is searched instead of the automatic area (searchAreaPlan).
 * → { candidates, result, area, stable: { name, rejected } | null }
 */
export async function findGcpCandidates({
  referenceId,
  band = 1,
  matcher = FIND_GCPS_DEFAULTS.matcher,
  demId = null,
  stableSetId = null,
  searchSetId = null,
  limit = FIND_GCPS_DEFAULTS.candidates,
  onLog,
} = {}) {
  const external = useExternalStore(),
    recon = useReconstructionStore(),
    images = useImagesStore(),
    sensors = useSensorsStore(),
    projects = useProjectsStore()
  const terrain = matcher === 'terrain'
  // Terrain matches against the reference DEM; every other matcher against the image.
  const ortho = recon.ortho,
    cloud = recon.mainSparseCloud,
    refRaster = external.rasterById(terrain ? demId : referenceId)
  if (!ortho || !cloud || !refRaster)
    throw new Error(`Build an orthophoto and choose a reference ${terrain ? 'DEM' : 'raster'} first`)
  const file = await external.originalFile(refRaster.id)
  if (!file) throw new Error('The original reference raster is unavailable — re-import it')
  await Promise.all([ensureProjection(refRaster.crs), ensureProjection(projects.currentCrs)])
  if (terrain && isGeographic(refRaster.crs))
    throw new Error('Terrain matching needs a reference DEM in a projected (metric) CRS')
  const area = terrain ? { region: null, source: null } : await searchArea(ortho, refRaster, searchSetId)
  const used = await resolveMatcher(matcher)
  const prior = terrain || learnedDetector(used) ? await orthoPrior(ortho, cloud, refRaster) : null
  if (terrain && !prior)
    throw new Error(
      'Terrain matching needs a starting position: footprints of near-vertical photos, GPS, or a georeferenced orthophoto',
    )
  const rgb = band === 'rgb'
  const result = terrain
    ? null
    : await findReferenceMatches(
        {
          local: { cog: ortho.cog ?? null, previewUrl: ortho.previewUrl, width: ortho.width, height: ortho.height },
          reference: {
            file,
            width: refRaster.width,
            height: refRaster.height,
            band: rgb ? 0 : band - 1,
            rgb,
            region: area.region,
          },
          matcher: used,
          prior,
        },
        { onLog },
      )
  const frameModel = makeFrameModelResolver({ summary: toRaw(recon.summary), sensors: sensors.sensors })
  const sourceImages = images.images.flatMap((image) => {
    const camera = cloud.cameras.get(image.uuid)
    if (!camera) return []
    const { dist, selfCal, fiducial, filmMissing } = frameModel(image)
    if (filmMissing) return []
    return [{ uuid: image.uuid, name: image.name, toScan: makePinholeToMark({ K: camera.K, dist, selfCal, fiducial }) }] // candidates become marks
  })
  const toProject = (p) => transform(p, refRaster.crs, projects.currentCrs)
  let stable = null,
    accept = null
  const stableSet = stableSetId ? useFootprintsStore().sets.find((s) => s.id === stableSetId) : null
  if (stableSet) {
    // Layers are stored in the project CRS; candidates come in the reference CRS.
    const inside = polygonAreaTest(stableSet.footprints.map((f) => f.rings))
    stable = { name: stableSet.name, rejected: 0 }
    accept = (x, y) => {
      const ok = inside(...toProject([x, y]))
      if (!ok) stable.rejected++
      return ok
    }
  }
  const { found, result: matched } = terrain
    ? await terrainSearch({ ortho, cloud, dem: refRaster, file, prior, images: sourceImages, accept, limit, onLog })
    : {
        found: referenceGcpCandidates({
          points: cloud.points,
          images: sourceImages,
          ortho,
          reference: refRaster,
          accept,
          limit,
          ...result,
        }),
        result,
      }
  const geographic = isGeographic(projects.currentCrs),
    declared = metresToCrsUnits(refRaster.horizontalAccuracy, projects.currentCrs)
  const candidates = found.map((c) => {
    // Position and planimetric σ from the reference pixel, widened by the match's
    // own residual (core/sfm/referenceGcps.js referencePick).
    const { x, y, sigma } = referencePick(refRaster, ...c.reference, {
      toProject,
      geographic,
      declared,
      displayFactor: c.residualRefPx,
    })
    const round = (v) => (v == null ? null : Number(v.toPrecision(3)))
    return {
      ...c,
      x,
      y,
      selected: false,
      role: 'control',
      z: null,
      accuracyX: round(sigma),
      accuracyY: round(sigma),
      accuracyZ: null,
      verticalDatum: 'unknown',
    }
  })
  return { candidates, result: matched, area, stable, matcher: used, prior }
}

// Coarse matcher ▸ Terrain: the sparse cloud aligned to the reference DEM by ICP from
// the prior (core/sfm/terrainControl.js), then tracks on the aligned surface as
// candidates. Returns them with a result shaped like the image matcher's, so the
// dialog shows it the same way (one coarse "tile", no matches).
async function terrainSearch({ ortho, cloud, dem, file, prior, images, accept, limit, onLog }) {
  const frame = orthoFrame(ortho)
  const n = cloud.points.length,
    points = new Float64Array(3 * n)
  for (let i = 0; i < n; i++) points.set(frame.fromSfm(cloud.points.xyz(i)), 3 * i)
  const local = Array.from({ length: n }, (_, i) => [
    (points[3 * i] - ortho.originX) / ortho.gsd,
    (ortho.originY - points[3 * i + 1]) / ortho.gsd,
  ])
  const initial = terrainInitial(prior, ortho, dem.geoTransform)
  const t = await alignTerrain(
    {
      points,
      dem: { file, width: dem.width, height: dem.height, geoTransform: { ...dem.geoTransform } },
      initial,
      misfit: prior.rms * Math.abs(dem.geoTransform.scaleX),
    },
    { onLog },
  )
  const gate = 3 * Math.max(t.rms, t.pixel)
  const imageByUuid = new Map(images.map((image) => [image.uuid, image]))
  const items = []
  for (let i = 0; i < n; i++) {
    const [u, v] = local[i]
    if (!(Math.abs(t.residual[i]) <= gate) || u < 0 || v < 0 || u >= ortho.width || v >= ortho.height) continue
    const x = t.positions[3 * i],
      y = t.positions[3 * i + 1]
    const px = worldToPixel(dem, x, y)
    items.push({
      pointIndex: i,
      local: [u, v],
      x,
      y,
      reference: [px.col, px.row],
      residual: t.residual[i],
      observations: trackObservations(cloud.points, i, imageByUuid),
    })
  }
  const found = terrainCandidates(items, {
    rms: t.rms,
    pixel: t.pixel,
    accept,
    width: ortho.width,
    height: ortho.height,
    limit,
  })
  onLog?.(
    `Terrain: ICP RMS ${t.rms.toFixed(1)} m with ${(100 * t.inlierFraction).toFixed(0)} % of the points in range; ${found.length} candidates on the aligned surface`,
    'info',
    'Find GCPs',
  )
  return {
    found,
    result: {
      matches: [],
      tiles: [{ H: null, inliers: 0, ratio: 1, local: null, reference: null }],
      kl: ortho.width / 1536,
      kr: 1,
      refined: false,
      coarse: null,
      terrain: { rms: t.rms, inlierFraction: t.inlierFraction, passes: t.passes, dz: t.dz },
      referencePreview: t.referencePreview,
    },
  }
}
