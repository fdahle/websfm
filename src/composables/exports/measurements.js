import { computed } from 'vue'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { measurementStale } from '../../core/products/measurementRecord.js'
import {
  describeMeasurement, geoJsonMode, is3dMeasurement, measurementsCsv, measurementsGeoJson, rasterRecordCrs,
} from '../../core/products/measurementExport.js'
import { cloudUnits } from '../../core/products/cloudUnits.js'
import { ensureProjection, transform } from '../../core/crs.js'
import { downloadBlob } from '../../utils/download.js'

// Saved measurements → CSV / GeoJSON (Export ▸ Measurements, and the Export button
// of a saved-measurements list). The pure half is core/products/measurementExport.js;
// this resolves what it needs from the project: what each measurement was taken on
// and whether that changed, the 3D unit and export frame from THE resolver
// (effectiveFrameSpec, through exportSimilarity), and the CRS definitions.
//
// Deps are useExports' injected refs and shared helpers.
export function createMeasurementExports({ currentCrs, effectiveFrameSpec, exportSimilarity, log, projectBase }) {
  const measurements = useMeasurementsStore()
  const external = useExternalStore()
  const recon = useReconstructionStore()

  const cloudOf = (record) => recon.clouds.find((c) => c.id === record.source?.slice('cloud:'.length)) ?? null
  // `product:dem` / `product:ortho`, or `reference:<raster id>` (measurementRecord.js).
  function productOf(record) {
    const src = record.source ?? ''
    if (src === 'product:dem') return recon.dem
    if (src === 'product:ortho') return recon.ortho
    if (src.startsWith('reference:')) return external.rasters.find((r) => r.id === src.slice('reference:'.length)) ?? null
    return null
  }
  function sourceName(record) {
    if (is3dMeasurement(record)) return cloudOf(record)?.name ?? record.cloudName ?? 'a removed layer'
    const p = productOf(record)
    if (record.source === 'product:dem') return 'DEM'
    if (record.source === 'product:ortho') return 'Orthophoto'
    return p?.name ?? record.sourceName ?? 'a removed raster'
  }
  function stale(record) {
    if (is3dMeasurement(record)) {
      const cloud = cloudOf(record)
      return !cloud || (record.cloudStamp != null && cloud.createdAt !== record.cloudStamp)
    }
    const p = productOf(record)
    return measurementStale(record, p, p && !p.id ? recon.productFrameStatus(p) : null)
  }
  const isImported3d = (record) => {
    const cloud = cloudOf(record)
    return cloud ? !!cloud.imported : record.unitSnapshot?.unit === 'source'
  }

  // A 3D measurement's export frame: a computed layer's points go through the same
  // similarity as a cloud export; an imported layer's are its file's coordinates.
  function frameLabel(frame) {
    if (frame.source === 'georef') return frame.crs
    if (frame.source === 'orientation') return 'oriented local frame (Orient model; no CRS)'
    if (frame.source === 'scalebars') return frame.oriented
      ? 'oriented local frame in metres (Orient model, scale bars; no CRS)' : 'model frame in metres (scale bars; no CRS)'
    return 'model frame (SfM coordinates; no CRS)'
  }

  // The records an export covers: `ids` (a list's records), else all of them.
  const recordsFor = (ids) => (ids ? measurements.records.filter((r) => ids.includes(r.id)) : measurements.records)

  // The CRS a georeferenced measurement export would be in, or null when none of
  // the records has one (the dialog then offers no Coordinates choice).
  function exportCrsFor(ids, georeferenced) {
    const records = recordsFor(ids)
    const crs = currentCrs.value && currentCrs.value !== 'local' ? currentCrs.value : null
    const rasterCrs = records.filter((r) => !is3dMeasurement(r)).map(rasterRecordCrs).find(Boolean) ?? null
    const any3d = georeferenced && records.some((r) => is3dMeasurement(r) && !isImported3d(r))
    if (!rasterCrs && !any3d) return null
    return crs ?? rasterCrs
  }
  const measurementCount = computed(() => measurements.records.length)

  async function doExportMeasurements({ format = 'csv', measurementCoords = 'project', ids = null } = {}) {
    const records = recordsFor(ids)
    if (!records.length) { log('Export: no saved measurements', 'warn', 'Export'); return }
    const resolved = await effectiveFrameSpec?.()
    const frame = await exportSimilarity()
    const signature = { source: resolved?.source ?? null, scale: resolved?.scale ?? 1 }
    // Model-frame up, for records saved before they kept their own: +z of a frame
    // that has one (georeference, Orient model), else none.
    const up = frame.sim && (frame.source === 'georef' || frame.oriented) ? frame.sim.R[2] : null
    const ctx = {
      sourceName,
      stale,
      units3d: (r) => cloudUnits(cloudOf(r) ?? { imported: isImported3d(r) }, signature),
      frame3d: (r) => (isImported3d(r)
        ? { sim: null, crs: null, unit: 'file units', label: `file coordinates of "${sourceName(r)}"` }
        : { sim: frame.sim, crs: frame.crs, unit: frame.unit === 'model' ? 'model units' : frame.unit, label: frameLabel(frame), up }),
    }
    const rows = records.map((r) => describeMeasurement(r, ctx))
    const base = `${projectBase()}-measurements`
    if (format === 'csv') {
      downloadBlob(`${base}.csv`, measurementsCsv(rows), 'text/csv')
      log(`Exported ${rows.length} measurement(s) as CSV`, 'success', 'Export')
      return
    }
    const mode = geoJsonMode(rows, measurementCoords)
    const targetCrs = mode === 'project' ? exportCrsFor(ids, frame.source === 'georef') : null
    const crsList = [...new Set(rows.map((r) => r.frame.crs).filter(Boolean))]
    for (const code of [...crsList, ...(targetCrs ? [targetCrs] : []), ...(mode === 'wgs84' ? ['EPSG:4326'] : [])]) {
      await ensureProjection(code)
    }
    const reproject = (coords, from, to) => coords.map((c) => transform(c, from, to))
    const fc = measurementsGeoJson(rows, { mode, targetCrs, reproject })
    downloadBlob(`${base}.geojson`, JSON.stringify(fc), 'application/geo+json')
    const unplaced = fc.features.filter((f) => !f.geometry).length
    log(`Exported ${rows.length} measurement(s) as GeoJSON — ${fc.coordinate_frame}`
      + (unplaced ? `; ${unplaced} without a CRS kept unplaced (frame_coordinates)` : ''), 'success', 'Export')
  }

  return { doExportMeasurements, exportCrsFor, measurementCount }
}
