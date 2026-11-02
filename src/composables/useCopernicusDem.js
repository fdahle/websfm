import { useExternalStore } from '../stores/useExternalStore.js'
import { fetchCopDemMosaic } from '../workers/computeClient.js'
import { ensureProjection, transform } from '../core/crs.js'
import {
  COP_DEM_DATUM,
  COP_DEM_SEARCH_URL,
  COP_DEM_SIGMA,
  COP_DEM_TOKEN_URL,
  copDemAttribution,
  copDemSearchBody,
  copDemTiles,
  paddedBox,
  signedHref,
} from '../core/copernicusDem.js'
import { COP_DEM_TUNING } from '../core/tuning.js'
import { formatBytes } from '../core/formatBytes.js'

// Co-register DEM ▸ Copernicus DEM (CoregisterDemModal.vue): the Copernicus DEM GLO-30
// over a DEM, fetched and imported as a reference DEM with its datum and accuracy
// declared (core/copernicusDem.js), for a project with no reference DEM of its own.

// The DEM's extent in lon/lat, from a 5 × 5 grid of points over it (a projection's
// curvature, near a pole, can put the extremes between the corners), padded.
async function lonLatBox(dem) {
  if (!dem?.crs || dem.crs === 'local' || !(dem.gsd > 0))
    throw new Error('The DEM has no coordinate system: georeference the model and build the DEM in the project CRS')
  await ensureProjection(dem.crs)
  const points = []
  for (let i = 0; i <= 4; i++)
    for (let j = 0; j <= 4; j++) {
      const x = dem.originX + (i / 4) * dem.width * dem.gsd,
        y = dem.originY - (j / 4) * dem.height * dem.gsd
      points.push(dem.crs === 'EPSG:4326' ? [x, y] : transform([x, y], dem.crs, 'EPSG:4326'))
    }
  const box = paddedBox(points, COP_DEM_TUNING)
  if (!box || box[0] >= box[2]) throw new Error('The DEM could not be placed in longitude and latitude')
  return box
}

async function getJson(url, init, what) {
  let res
  try {
    res = await fetch(url, init)
  } catch {
    throw new Error(`${what}: no connection to the Planetary Computer`)
  }
  if (!res.ok) throw new Error(`${what}: the Planetary Computer answered ${res.status}`)
  return res.json()
}

// → the imported reference DEM's record.
export async function fetchCopernicusDem(dem, { onLog } = {}) {
  const bbox = await lonLatBox(dem)
  const fc = await getJson(
    COP_DEM_SEARCH_URL,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(copDemSearchBody(bbox)) },
    'Copernicus DEM search',
  )
  const tiles = copDemTiles(fc)
  if (!tiles.length) throw new Error('The Copernicus DEM has no tile over this DEM (open sea has none)')
  const { token } = await getJson(COP_DEM_TOKEN_URL, undefined, 'Copernicus DEM access')
  const t0 = performance.now()
  const { bytes, width, height, min, max } = await fetchCopDemMosaic({
    hrefs: tiles.map((t) => signedHref(t.href, token)),
    bbox,
    maxPx: COP_DEM_TUNING.maxPx,
  })
  const external = useExternalStore()
  const file = new File([bytes], `Copernicus DEM (${dem.name}).tif`, { type: 'image/tiff' })
  const meta = await external.importRaster(file, { forceKind: 'dem', origin: 'copernicus-dem' })
  if (!meta) throw new Error('The fetched Copernicus DEM could not be imported')
  await external.setRasterAccuracy(meta.id, {
    horizontalAccuracy: COP_DEM_SIGMA.horizontal,
    verticalAccuracy: COP_DEM_SIGMA.vertical,
    verticalDatum: COP_DEM_DATUM,
  })
  onLog?.(
    `Copernicus DEM over "${dem.name}": ${width} × ${height} cells of 1″ from ${tiles.length} ` +
      `tile${tiles.length === 1 ? '' : 's'}, heights ${min.toFixed(0)}–${max.toFixed(0)} m above EGM2008, ` +
      `${formatBytes(bytes.byteLength)} in ${((performance.now() - t0) / 1000).toFixed(1)} s, read on one ` +
      `worker. ${copDemAttribution()}.`,
    'success',
    'Import',
  )
  return meta
}
