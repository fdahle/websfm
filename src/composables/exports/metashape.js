import { toRaw } from 'vue'
import { makeFrameModelResolver, makePinholeToMark } from '../../core/sfm/displayFrame.js'
import { similarityForExport } from '../../core/products/exportFrame.js'
import { applySimilarity } from '../../core/products/georef.js'
import { ensureProjection, transform, metresPerCrsUnit, isGeographic } from '../../core/crs.js'
import { heightShifter } from '../../core/verticalDatum.js'
import { stem } from '../../core/io/nameMatch.js'
import {
  fitMetashapeFrame,
  metashapeCameraFrames,
  buildMetashapeXml,
  WGS84_WKT,
  LOCAL_WKT,
} from '../../core/io/metashapeXml.js'
import { downloadBlob } from '../../utils/download.js'
import { defaultExportName, exportFileName } from '../../core/exportNames.js'
import { pluralize } from '../../core/textFormat.js'

// Export ▸ SfM Project ▸ Metashape XML: the registered cameras, their calibration and
// the GCPs with their marks, as the document Metashape's Export Markers writes
// (core/io/metashapeXml.js buildMetashapeXml), so File ▸ Import ▸ Import Cameras and
// Import Markers read it. Georeferenced, the chunk is WGS 84 with ellipsoidal heights;
// otherwise a local frame in the export frame's units.
//
// Each camera group becomes one Metashape sensor: Metashape's frame model fitted to the
// group's whole lens (its own model and any self-calibrated terms on top), the misfit
// logged. Film scans are left out: their fiducial frame has no place in a frame sensor.
export function createMetashapeExport({
  currentCrs,
  images,
  sensors,
  sparseCloud,
  summary,
  gcps,
  effectiveFrameSpec,
  log,
  projectBase,
}) {
  const rad = Math.PI / 180

  async function doExportMetashape({ fileName } = {}) {
    const cloud = sparseCloud()
    const cameras = cloud?.cameras
    if (!cameras?.size) {
      log('Metashape export: no registered cameras', 'warn', 'Export')
      return
    }
    const frameModel = makeFrameModelResolver({ summary: toRaw(summary?.value ?? null), sensors: sensors.value })
    const sensorById = new Map(sensors.value.map((s) => [s.id, s]))

    // Cameras and their lens groups.
    const groups = new Map()
    const out = []
    let film = 0
    for (const img of images.value) {
      const cam = cameras.get(img.uuid)
      if (!cam?.K) continue
      const fm = frameModel(img)
      if (fm.fiducial) {
        film++
        continue
      }
      const width = img.meta?.width,
        height = img.meta?.height
      if (!(width > 0 && height > 0)) continue
      const key = JSON.stringify([img.sensorId ?? img.uuid, cam.K, fm.dist, fm.selfCal, width, height])
      if (!groups.has(key)) groups.set(key, { id: groups.size, img, K: cam.K, fm, width, height })
      out.push({ img, cam, sensorId: groups.get(key).id })
    }
    if (!out.length) {
      log('Metashape export: no camera to write (film scans are not exported)', 'warn', 'Export')
      return
    }

    const msSensors = []
    for (const g of groups.values()) {
      const s = g.img.sensorId != null ? sensorById.get(g.img.sensorId) : null
      const label = `${s?.label ?? g.img.name}${groups.size > 1 && s ? ` #${g.id + 1}` : ''}`
      const base = { id: g.id, label, width: g.width, height: g.height, pixelSize: s?.pixelSize ?? null }
      if (g.fm.dist?.fisheye && !g.fm.selfCal) {
        const d = g.fm.dist
        msSensors.push({
          ...base,
          type: 'fisheye',
          calibration: {
            f: g.K.fy,
            cx: g.K.cx + 0.5 - g.width / 2,
            cy: g.K.cy + 0.5 - g.height / 2,
            k1: d.k1,
            k2: d.k2,
            k3: d.k3,
            k4: d.k4,
          },
        })
        continue
      }
      const toMark = makePinholeToMark({ K: g.K, dist: g.fm.dist, selfCal: g.fm.selfCal })
      const fit = fitMetashapeFrame(toMark, g.K, g.width, g.height)
      if (fit.rmsPx > 0.05)
        log(
          `Metashape export: the lens of ${label} fits Metashape's model to ${fit.rmsPx.toFixed(2)} px RMS ` +
            `(${fit.maxPx.toFixed(2)} px at most)`,
          'warn',
          'Export',
        )
      msSensors.push({ ...base, type: 'frame', calibration: fit.calibration })
    }

    // The frame the cameras go into.
    // The georeference when there is one, fitted now if it has not been yet (as a DEM
    // run does): a project in a projected CRS goes to Metashape georeferenced.
    let resolved = await effectiveFrameSpec?.()
    const projectCrs = currentCrs?.value
    if (resolved?.source !== 'georef' && projectCrs && projectCrs !== 'local' && !isGeographic(projectCrs))
      resolved = await effectiveFrameSpec?.({ crs: projectCrs })
    const { sim, crs, source } = similarityForExport(resolved)
    let geo = null,
      toWgs = null
    const notes = []
    if (source === 'georef' && crs && crs !== 'local') {
      await ensureProjection(crs)
      const unit = metresPerCrsUnit(crs) || 1
      const datum = resolved?.verticalDatum ?? 'unknown'
      const shift = await heightShifter(datum, 'ellipsoidal').catch(() => null)
      if (!shift) notes.push(`heights written as they are (${datum}), not converted to ellipsoidal`)
      toWgs = ([x, y, z], shiftOf = shift) => {
        const [lon, lat] = transform([x, y], crs, 'EPSG:4326')
        return [lon, lat, z * unit + (shiftOf ? shiftOf(lon, lat) : 0)]
      }
      // East/north/up at a place → the export frame's axes: the grid's convergence
      // there, or, in a local tangent frame, the convergence at its origin.
      const gridRotation = (lon, lat) => {
        const [x, y] = transform([lon, lat], 'EPSG:4326', crs)
        const [x2, y2] = transform([lon, lat + 1e-5], 'EPSG:4326', crs)
        const g = -Math.atan2(x2 - x, y2 - y)
        return [
          [Math.cos(g), -Math.sin(g), 0],
          [Math.sin(g), Math.cos(g), 0],
          [0, 0, 1],
        ]
      }
      let enuToFrame = gridRotation
      if (sim.local) {
        const [lon0, lat0] = transform([sim.local.e0, sim.local.n0], crs, 'EPSG:4326')
        const G0 = gridRotation(lon0, lat0)
        const E0 = enuRows(lon0, lat0)
        const fixed = mul(G0, E0) // geocentric → local frame axes
        enuToFrame = (lon, lat) => mul(fixed, T(enuRows(lon, lat)))
      }
      geo = { toGeodetic: (p) => toWgs(p), enuToFrame }
    }
    const frames = metashapeCameraFrames(
      out.map((o) => o.cam),
      sim,
      applySimilarity,
      geo,
    )

    // Markers: the GCPs and markers with marks on the exported photos.
    const camIndex = new Map(out.map((o, i) => [o.img.id, i]))
    const markers = []
    for (const g of gcps.value) {
      const locations = (g.observations ?? [])
        .filter((o) => camIndex.has(o.imageId) && Number.isFinite(o.px) && Number.isFinite(o.py))
        .map((o) => ({ cameraId: camIndex.get(o.imageId), x: o.px, y: o.py }))
      let reference = null
      if (geo && g.role !== 'marker' && Number.isFinite(g.x) && Number.isFinite(g.y)) {
        const shiftG = await heightShifter(g.verticalDatum ?? 'unknown', 'ellipsoidal').catch(() => null)
        const [lon, lat, h] = toWgs([g.x, g.y, g.z ?? 0], shiftG)
        const acc = [g.accuracyX, g.accuracyY].filter((v) => v > 0)
        reference = {
          x: lon,
          y: lat,
          z: h,
          sxy: acc.length ? acc.reduce((a, b) => a + b, 0) / acc.length : null,
          sz: g.accuracyZ > 0 ? g.accuracyZ : null,
          enabled: g.role === 'control',
        }
      }
      if (!reference && !locations.length) continue
      markers.push({ id: markers.length, label: g.name, reference, locations })
    }

    const xml = buildMetashapeXml({
      sensors: msSensors,
      cameras: out.map((o, i) => ({
        id: i,
        label: stem(o.img.name),
        sensorId: o.sensorId,
        enabled: o.img.enabled !== false,
        transform: frames.transforms[i],
      })),
      markers,
      chunk: frames.chunk,
      wkt: geo ? WGS84_WKT : LOCAL_WKT,
      label: projectBase(),
    })
    const name = exportFileName(fileName, defaultExportName('colmap', { format: 'metashape', base: projectBase() }))
    downloadBlob(`${name}.xml`, xml, 'application/xml')
    log(
      `Exported ${pluralize(out.length, 'camera')}, ${pluralize(msSensors.length, 'calibration')} and ` +
        `${pluralize(markers.length, 'marker')} for Metashape ${geo ? 'in WGS 84' : 'in a local frame'}` +
        (film ? `; ${pluralize(film, 'film scan')} left out` : '') +
        (notes.length ? `; ${notes.join('; ')}` : ''),
      'success',
      'Export',
    )
  }

  // Rows: east, north, up at (lon°, lat°) in geocentric axes.
  function enuRows(lon, lat) {
    const so = Math.sin(lon * rad),
      co = Math.cos(lon * rad),
      sa = Math.sin(lat * rad),
      ca = Math.cos(lat * rad)
    return [
      [-so, co, 0],
      [-sa * co, -sa * so, ca],
      [ca * co, ca * so, sa],
    ]
  }

  return { doExportMetashape }
}

const mul = (A, B) => A.map((r) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const T = (A) => A[0].map((_, j) => A.map((r) => r[j]))
