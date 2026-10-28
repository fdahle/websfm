import {
  downloadCsv,
  buildPosesCsv,
  buildSensorsCsv,
  buildFiducialMarksCsv,
  buildFiducialObsCsv,
} from '../../utils/exportCsv.js'
import { downloadBlob } from '../../utils/download.js'
import { partsToBlob } from '../../utils/blobParts.js'
import { jsonParts, jsonArrayItemParts, jsonArrayEnd, lazyArray } from '../../core/io/parts.js'
import { asPairList } from '../../core/sfm/matchCodec.js'
import { hasPairMatches } from '../../core/features/matchStorage.js'

// The tabular exports, split out of useExports: camera poses, sensors and both
// fiducial tables as CSV, and keypoints / matches as JSON streamed from disk.
//
// Deps are useExports' injected refs and shared helpers.
export function createTabularExports({
  currentCrs,
  currentProjectName,
  images,
  imagesStore,
  log,
  matchStore,
  matchesStore,
  poses,
  sensors,
}) {
  function exportPoses() {
    if (!poses.value.length) return
    downloadCsv(`${currentProjectName.value || 'project'}-poses.csv`, buildPosesCsv(poses.value, currentCrs.value))
  }

  function exportSensors() {
    if (!sensors.value.length) return
    downloadCsv(`${currentProjectName.value || 'project'}-sensors.csv`, buildSensorsCsv(sensors.value))
  }

  // Film fiducials, in the two shapes Import reads back (core/io/fiducialMarks.js,
  // core/io/fiducialObs.js): the camera's marks in mm, each image's marks in pixels.
  function exportCameraFiducials() {
    const film = sensors.value.filter((s) => s.fiducialCalibration?.marks?.length)
    if (!film.length) return
    downloadCsv(`${currentProjectName.value || 'project'}-camera-fiducials.csv`, buildFiducialMarksCsv(film))
  }

  function exportImageFiducials() {
    const marked = images.value.filter((i) => i.fiducialDetections?.length)
    if (!marked.length) return
    downloadCsv(`${currentProjectName.value || 'project'}-image-fiducials.csv`, buildFiducialObsCsv(marked))
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

  async function exportKeypoints() {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const out = jsonArrayWriter()
      for (const img of images.value) {
        if (img.kpStatus !== 'done' || !img.kpCount) continue
        const kps = await imagesStore.readKeypoints(img)
        if (!kps?.length) continue
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
      out.save(`keypoints-${stamp}.json`)
    } catch (err) {
      log(`Keypoint export failed: ${err?.message ?? err}`, 'error', 'Export')
    }
  }

  async function exportMatches() {
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
      const byUuid = Object.fromEntries(images.value.map((img) => [img.uuid, img.name]))
      const out = jsonArrayWriter()
      // The pairs with matches (a rejected pair has none to list), the same before
      // and after a reopen.
      const done = [...matchStore.value.values()].filter(hasPairMatches)
      // In the store's order, which after a reopen is the document's: a few large reads.
      await matchesStore.streamPairMatches(done, (entry, m) =>
        out.add({
          imageA: byUuid[entry.idA] ?? entry.idA,
          imageB: byUuid[entry.idB] ?? entry.idB,
          rawCount: entry.rawCount,
          inlierCount: entry.inlierCount,
          // The store keeps a flat Uint32Array; the file keeps the [[ia, ib], …] format.
          // Serialized inside this call: `m` may be a view into the stream's read window.
          matches: pairListOf(m),
        }),
      )
      out.save(`matches-${stamp}.json`)
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
    exportPoses,
    exportSensors,
    exportCameraFiducials,
    exportImageFiducials,
    saveJson,
    jsonArrayWriter,
    exportKeypoints,
    exportMatches,
    pairListOf,
    swapPairs,
  }
}
