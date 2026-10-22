import { useExternalStore } from '../stores/useExternalStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { findReferenceMatches } from '../workers/computeClient.js'
import { referenceGcpCandidates, referencePick, polygonAreaTest } from '../core/sfm/referenceGcps.js'
import { gpsSearchOutline, searchRegion, footprintSearchPoints } from '../core/sfm/referenceMatch.js'
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

// Where in the reference to look: the ortho's own footprint when it is already
// georeferenced, else the registered photos' footprints, else their GPS positions,
// else everywhere. → { region, source }
async function searchArea(ortho, cloud, refRaster) {
  const images = useImagesStore(),
    projects = useProjectsStore()
  const toPixels = (pts, crs) =>
    pts
      .map((p) => transform(p, crs, refRaster.crs))
      .map(([x, y]) => {
        const px = worldToPixel(refRaster, x, y)
        return [px.col, px.row]
      })
  if (ortho.crs && ortho.crs !== 'local') {
    await ensureProjection(ortho.crs)
    const x1 = ortho.originX + ortho.width * ortho.gsd,
      y1 = ortho.originY - ortho.height * ortho.gsd
    const pts = [
      [ortho.originX, ortho.originY],
      [x1, ortho.originY],
      [x1, y1],
      [ortho.originX, y1],
    ]
    return {
      region: searchRegion(toPixels(pts, ortho.crs), refRaster.width, refRaster.height),
      source: 'the georeferenced orthophoto',
    }
  }
  const registered = images.images.filter((im) => cloud.cameras.get(im.uuid))
  const crs = projects.currentCrs
  if (crs && crs !== 'local') {
    const ids = new Set(registered.map((im) => im.id))
    const pts = footprintSearchPoints(useFootprintsStore().sets, ids)
    if (pts.length >= 3) {
      await ensureProjection(crs)
      return {
        region: searchRegion(toPixels(pts, crs), refRaster.width, refRaster.height),
        source: "the photos' footprints",
      }
    }
  }
  const outline = gpsSearchOutline(registered.map((im) => [Number(im.meta?.gpsLon), Number(im.meta?.gpsLat)]))
  if (outline)
    return {
      region: searchRegion(toPixels(outline, 'EPSG:4326'), refRaster.width, refRaster.height),
      source: "the photos' GPS positions",
    }
  return { region: null, source: null }
}

/**
 * Find candidate controls. `stableSetId` names a polygon layer (stableAreaLayers):
 * only candidates whose reference position lies inside one of its polygons are
 * kept, before they are spread over the block.
 * → { candidates, result, area, stable: { name, rejected } | null }
 */
export async function findGcpCandidates({ referenceId, band = 1, stableSetId = null, onLog } = {}) {
  const external = useExternalStore(),
    recon = useReconstructionStore(),
    images = useImagesStore(),
    sensors = useSensorsStore(),
    projects = useProjectsStore()
  const ortho = recon.ortho,
    cloud = recon.mainSparseCloud,
    refRaster = external.rasterById(referenceId)
  if (!ortho || !cloud || !refRaster) throw new Error('Build an orthophoto and choose a reference raster first')
  const file = await external.originalFile(refRaster.id)
  if (!file) throw new Error('The original reference raster is unavailable — re-import it')
  await Promise.all([ensureProjection(refRaster.crs), ensureProjection(projects.currentCrs)])
  const area = await searchArea(ortho, cloud, refRaster)
  const result = await findReferenceMatches(
    {
      local: { cog: ortho.cog ?? null, previewUrl: ortho.previewUrl, width: ortho.width, height: ortho.height },
      reference: {
        file,
        width: refRaster.width,
        height: refRaster.height,
        band: band - 1,
        region: area.region,
      },
    },
    { onLog },
  )
  const frameModel = makeFrameModelResolver({ summary: recon.summary, sensors: sensors.sensors })
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
  const found = referenceGcpCandidates({
    points: cloud.points,
    images: sourceImages,
    ortho,
    reference: refRaster,
    accept,
    ...result,
  })
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
  return { candidates, result, area, stable }
}
