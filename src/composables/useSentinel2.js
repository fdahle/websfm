import { useExternalStore } from '../stores/useExternalStore.js'
import { searchAreaPoints } from './useFindGcps.js'
import { fetchSentinel2Window } from '../workers/computeClient.js'
import { ensureProjection, transform } from '../core/crs.js'
import {
  S2_SEARCH_URL,
  s2SearchBody,
  s2Scenes,
  rankScenes,
  sceneWindow,
  lonLatBbox,
  s2RasterName,
  s2Attribution,
} from '../core/sentinel2.js'
import { SENTINEL2_DEFAULTS } from '../core/defaults.user.js'
import { SENTINEL2_TUNING } from '../core/tuning.js'

// Find GCPs ▸ Sentinel-2 (Sentinel2Modal.vue): the Sentinel-2 L2A scenes over the
// search area, and one of them fetched as a reference orthophoto (core/sentinel2.js).

// The search area in lon/lat: → { points, bbox, source } or null.
export async function sentinel2Area(searchSetId = null) {
  const area = await searchAreaPoints(searchSetId)
  if (!area?.points.length) return null
  const points = area.crs === 'EPSG:4326' ? area.points : area.points.map((p) => transform(p, area.crs, 'EPSG:4326'))
  return { points, bbox: lonLatBbox(points), source: area.source }
}

// The scenes over `area` (sentinel2Area), best first (rankScenes).
export async function searchSentinel2(area, { maxCloud = SENTINEL2_DEFAULTS.maxCloud, from = '', to = '' } = {}) {
  const res = await fetch(S2_SEARCH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(s2SearchBody({ bbox: area.bbox, maxCloud, from, to, limit: SENTINEL2_TUNING.searchLimit })),
  })
  if (!res.ok) throw new Error(`The Sentinel-2 catalogue answered ${res.status} ${res.statusText}`.trim())
  return rankScenes(s2Scenes(await res.json(), area.bbox))
}

// Read `scene` over `area`, import it as a reference orthophoto with its σ XY, and
// return the raster's record.
export async function fetchSentinel2Scene(scene, area, { onLog } = {}) {
  const crs = `EPSG:${scene.epsg}`
  await ensureProjection(crs)
  const points = area.points.map((p) => transform(p, 'EPSG:4326', crs))
  const { padFraction, minPad, maxPx, loQ, hiQ } = SENTINEL2_TUNING
  const window = sceneWindow(scene.transform, scene.shape, points, { padFraction, minPad, maxPx })
  const t0 = performance.now()
  // Plain strings: the scene may be a reactive proxy, which a worker message cannot carry.
  const hrefs = { red: scene.hrefs.red, green: scene.hrefs.green, blue: scene.hrefs.blue }
  const { bytes } = await fetchSentinel2Window({ hrefs, window, epsg: scene.epsg, loQ, hiQ })
  const external = useExternalStore()
  const file = new File([bytes], s2RasterName(scene), { type: 'image/tiff' })
  const meta = await external.importRaster(file, { forceKind: 'ortho' })
  if (!meta) throw new Error('The fetched Sentinel-2 window could not be imported')
  await external.setRasterAccuracy(meta.id, { horizontalAccuracy: SENTINEL2_DEFAULTS.horizontalAccuracy })
  onLog?.(
    `Sentinel-2 ${scene.date} (${scene.tile}): ${window.width} × ${window.height} px at ${window.res} m in ${crs}, ` +
      `${(bytes.byteLength / 1e6).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s, read on one ` +
      `worker. ${s2Attribution(scene.date.slice(0, 4))}.`,
    'success',
    'Import',
  )
  return meta
}
