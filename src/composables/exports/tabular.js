import { buildPosesCsv, buildSensorsCsv, buildFiducialMarksCsv, buildFiducialObsCsv } from '../../utils/exportCsv.js'
import { downloadBlob } from '../../utils/download.js'
import { partsToBlob } from '../../utils/blobParts.js'
import { jsonParts, jsonArrayItemParts, jsonArrayEnd, lazyArray } from '../../core/io/parts.js'
import { posesToGeoJson } from '../../core/io/geojson.js'
import { asPairList } from '../../core/sfm/matchCodec.js'
import { hasPairMatches } from '../../core/features/matchStorage.js'
import { estimatedPose, estimatedCalibration } from '../../core/sfm/cameraEstimated.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { ensureProjection, transform } from '../../core/crs.js'
import { defaultExportName, exportFileName } from '../../core/exportNames.js'
import { pluralize } from '../../core/textFormat.js'
import { toRaw } from 'vue'

// The tabular exports, split out of useExports: camera poses, calibration and both
// fiducial tables as CSV or tab-separated text, poses also as GeoJSON points, and
// keypoints / matches as JSON or CSV streamed from disk. Each takes its dialog's
// settings (ExportModal.vue) and names its file by core/exportNames.js.
//
// Deps are useExports' injected refs and shared helpers.
export function createTabularExports({
  currentCrs,
  exportSimilarity,
  images,
  imagesStore,
  log,
  matchStore,
  matchesStore,
  poses,
  projectBase,
  sensors,
  sparseCloud,
  summary,
}) {
  // A table as CSV ('csv') or tab-separated text ('txt').
  const TABLE = {
    csv: { delimiter: ',', ext: 'csv', mime: 'text/csv;charset=utf-8' },
    txt: { delimiter: '\t', ext: 'txt', mime: 'text/plain;charset=utf-8' },
  }
  const tableOf = (format) => TABLE[format] ?? TABLE.csv
  const nameFor = (kind, settings, extra = {}) =>
    exportFileName(settings.fileName, defaultExportName(kind, { base: projectBase(), ...extra, ...settings }))

  // The cameras the sparse model registered, in image order, posed in the frame THE
  // resolver gives an export (exportSimilarity), or in the model frame without
  // `applyGeoref`. → { poses, frame }
  async function estimatedPoses(applyGeoref) {
    const cameras = sparseCloud()?.cameras
    const frame = applyGeoref ? await exportSimilarity() : { sim: null, unit: 'model', crs: null, source: null }
    const out = []
    for (const img of images.value) {
      const p = cameras && estimatedPose(cameras.get(img.uuid), frame.sim)
      if (p) out.push({ imageName: img.name, ...p })
    }
    return { poses: out, frame }
  }

  async function doExportPoses(settings) {
    const { source, format, orientation, accuracy, applyGeoref, coords } = settings
    const estimated = source === 'estimated'
    const { poses: rows, frame } = estimated
      ? await estimatedPoses(applyGeoref)
      : { poses: poses.value, frame: { crs: currentCrs.value || null } }
    if (!rows.length) {
      log(`Export: no ${estimated ? 'registered cameras' : 'imported camera poses'}`, 'warn', 'Export')
      return
    }
    const crs = frame.crs && frame.crs !== 'local' ? frame.crs : null
    // Estimated poses have no accuracies of their own.
    const opts = { orientation: !!orientation, accuracy: !estimated && !!accuracy }
    const name = nameFor('poses', settings)
    if (format === 'geojson') {
      const wgs84 = coords === 'wgs84' && crs
      if (wgs84) await ensureProjection(crs)
      const reproject = wgs84 ? (c) => transform(c, crs, 'EPSG:4326') : null
      downloadBlob(
        `${name}.geojson`,
        JSON.stringify(posesToGeoJson(rows, { ...opts, crs, reproject })),
        'application/geo+json',
      )
    } else {
      const t = tableOf(format)
      downloadBlob(`${name}.${t.ext}`, buildPosesCsv(rows, crs ?? '', { ...opts, delimiter: t.delimiter }), t.mime)
    }
    const where = crs
      ? `in ${format === 'geojson' && coords === 'wgs84' ? 'WGS 84' : crs}`
      : `in ${frame.unit ?? 'model'} units, no CRS`
    log(
      `Exported ${pluralize(rows.length, estimated ? 'estimated camera pose' : 'imported camera pose')} ${where}`,
      'success',
      'Export',
    )
  }

  // Calibration as entered (the camera groups), or as bundle adjustment ended with
  // ('estimated' per group, 'estimatedPerImage' per camera).
  function doExportSensors(settings) {
    const { source, format } = settings
    const rows =
      source === 'entered'
        ? sensors.value
        : estimatedCalibration({
            cameras: sparseCloud()?.cameras,
            images: images.value,
            sensors: sensors.value,
            frameModel: makeFrameModelResolver({ summary: toRaw(summary?.value ?? null), sensors: sensors.value }),
            perImage: source === 'estimatedPerImage',
          })
    if (!rows.length) {
      log(`Export: no ${source === 'entered' ? 'camera groups' : 'registered cameras'}`, 'warn', 'Export')
      return
    }
    const t = tableOf(format)
    downloadBlob(`${nameFor('sensors', settings)}.${t.ext}`, buildSensorsCsv(rows, { delimiter: t.delimiter }), t.mime)
    log(
      `Exported ${source === 'entered' ? pluralize(rows.length, 'camera group') : `the estimated calibration (${pluralize(rows.length, 'row')})`}`,
      'success',
      'Export',
    )
  }

  // Film fiducials, in the two shapes Import reads back (core/io/fiducialMarks.js,
  // core/io/fiducialObs.js): the camera's marks in mm, each image's marks in pixels.
  function doExportCameraFiducials(settings) {
    const film = sensors.value.filter((s) => s.fiducialCalibration?.marks?.length)
    if (!film.length) return
    const t = tableOf(settings.format)
    const text = buildFiducialMarksCsv(film, { delimiter: t.delimiter })
    downloadBlob(`${nameFor('cameraFiducials', settings)}.${t.ext}`, text, t.mime)
  }

  function doExportImageFiducials(settings) {
    const marked = images.value.filter((i) => i.fiducialDetections?.length)
    if (!marked.length) return
    const t = tableOf(settings.format)
    const text = buildFiducialObsCsv(marked, { delimiter: t.delimiter })
    downloadBlob(`${nameFor('imageFiducials', settings)}.${t.ext}`, text, t.mime)
  }

  // Pretty-printed JSON (`JSON.stringify(data, null, 2)`, byte for byte), streamed
  // into the Blob in bounded parts: a keypoint or match export of a big project is
  // far past V8's ~512 M-char string limit. Arrays that scale with the data are
  // lazyArrays, so their elements exist only while they are written.
  function saveJson(data, filename) {
    downloadBlob(filename, partsToBlob(jsonParts(data, { space: 2 }), 'application/json'))
  }

  // A top-level JSON array whose elements are built one at a time from data read in
  // between (core/io/parts.js jsonArrayItemParts): each element becomes a Blob before
  // the next one's data is read, so only one image's keypoints / one read window of
  // matches is ever resident. Byte-identical to saveJson on the whole array.
  function jsonArrayWriter() {
    const blobs = []
    return {
      add(value) {
        blobs.push(partsToBlob(jsonArrayItemParts(value, blobs.length, { space: 2 })))
      },
      save(filename) {
        downloadBlob(
          filename,
          new Blob([...blobs, jsonArrayEnd(blobs.length, { space: 2 })], { type: 'application/json' }),
        )
      },
    }
  }

  // A CSV built a block of rows at a time (each block a Blob before the next is
  // read), so a big project's keypoints or matches never exist as one string.
  function csvWriter(header) {
    const blobs = [header.join(',') + '\r\n']
    return {
      rows(rows) {
        if (rows.length) blobs.push(new Blob([rows.join('\r\n') + '\r\n']))
      },
      save(filename) {
        downloadBlob(filename, new Blob(blobs, { type: 'text/csv;charset=utf-8' }))
      },
    }
  }
  // An image name as a CSV cell.
  const csvName = (s) => (/[",\r\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s)

  // Every image's keypoints: JSON (one entry per image) or CSV (one row per keypoint).
  async function doExportKeypoints(settings) {
    try {
      const csv = settings.format === 'csv'
      const out = csv ? csvWriter(['image', 'x', 'y', 'scale', 'response']) : jsonArrayWriter()
      for (const img of images.value) {
        if (img.kpStatus !== 'done' || !img.kpCount) continue
        const kps = await imagesStore.readKeypoints(img)
        if (!kps?.length) continue
        if (csv) {
          const name = csvName(img.name)
          for (let i0 = 0; i0 < kps.length; i0 += 65536) {
            const rows = []
            for (let i = i0; i < Math.min(kps.length, i0 + 65536); i++)
              rows.push(`${name},${kps.x(i)},${kps.y(i)},${kps.scale(i)},${kps.response(i)}`)
            out.rows(rows)
          }
          continue
        }
        out.add({
          image: img.name,
          uuid: img.uuid,
          kpCount: img.kpCount,
          keypoints: lazyArray(kps.length, (i) => ({
            x: kps.x(i),
            y: kps.y(i),
            scale: kps.scale(i),
            response: kps.response(i),
          })),
        })
      }
      out.save(`${nameFor('keypoints', settings)}.${csv ? 'csv' : 'json'}`)
    } catch (err) {
      log(`Keypoint export failed: ${err?.message ?? err}`, 'error', 'Export')
    }
  }

  // The matched pairs: JSON or CSV, with every match (`content` 'matches': keypoint
  // indices into each image's keypoints) or the pair list alone ('pairs', with counts).
  async function doExportMatches(settings) {
    try {
      const csv = settings.format === 'csv'
      const pairsOnly = settings.content === 'pairs'
      const byUuid = Object.fromEntries(images.value.map((img) => [img.uuid, img.name]))
      // The pairs with matches (a rejected pair has none to list), the same before
      // and after a reopen.
      const done = [...matchStore.value.values()].filter(hasPairMatches)
      const nameA = (e) => byUuid[e.idA] ?? e.idA,
        nameB = (e) => byUuid[e.idB] ?? e.idB
      const file = `${nameFor('matches', settings)}.${csv ? 'csv' : 'json'}`
      if (pairsOnly) {
        if (csv) {
          const out = csvWriter(['image_a', 'image_b', 'raw_count', 'inlier_count'])
          out.rows(
            done.map((e) => `${csvName(nameA(e))},${csvName(nameB(e))},${e.rawCount ?? ''},${e.inlierCount ?? ''}`),
          )
          out.save(file)
        } else {
          saveJson(
            done.map((e) => ({ imageA: nameA(e), imageB: nameB(e), rawCount: e.rawCount, inlierCount: e.inlierCount })),
            file,
          )
        }
        return
      }
      const out = csv ? csvWriter(['image_a', 'image_b', 'index_a', 'index_b']) : jsonArrayWriter()
      // In the store's order, which after a reopen is the document's: a few large reads.
      // `m` may be a view into the stream's read window: serialized inside the call.
      await matchesStore.streamPairMatches(done, (entry, m) => {
        if (csv) {
          const a = csvName(nameA(entry)),
            b = csvName(nameB(entry))
          const rows = []
          for (let i = 0; i < m.length; i += 2) rows.push(`${a},${b},${m[i]},${m[i + 1]}`)
          out.rows(rows)
          return
        }
        out.add({
          imageA: nameA(entry),
          imageB: nameB(entry),
          rawCount: entry.rawCount,
          inlierCount: entry.inlierCount,
          // The store keeps a flat Uint32Array; the file keeps the [[ia, ib], …] format.
          matches: pairListOf(m),
        })
      })
      out.save(file)
    } catch (err) {
      log(`Match export failed: ${err?.message ?? err}`, 'error', 'Export')
    }
  }

  // A flat [a, b, …] match array as the lazy [[a, b], …] the JSON file carries.
  const pairListOf = (m) => {
    const l = asPairList(m)
    return lazyArray(l.length, (k) => [l.a(k), l.b(k)])
  }

  // A flat [a, b, …] match array with every pair reversed (a fresh copy).
  const swapPairs = (m) => {
    const out = new Uint32Array(m.length)
    for (let i = 0; i < m.length; i += 2) {
      out[i] = m[i + 1]
      out[i + 1] = m[i]
    }
    return out
  }

  return {
    doExportPoses,
    doExportSensors,
    doExportCameraFiducials,
    doExportImageFiducials,
    saveJson,
    jsonArrayWriter,
    doExportKeypoints,
    doExportMatches,
    pairListOf,
    swapPairs,
  }
}
