import { prepareCloudForExport, prepareMeshForExport, cloudToPlyParts, meshToPlyParts, meshToObjParts, meshToStlParts, meshToGlbParts } from '../../core/products/exporters.js'
import { cloudToLasParts } from '../../core/io/las.js'
import { cloudToLaz } from '../../core/io/laz.js'
import { cloudToXyzParts } from '../../core/io/cloudText.js'
import { partsToBlob } from '../../utils/blobParts.js'

// Cloud / mesh file exports off the main thread. The writers yield bounded parts
// (core/io/parts.js) and partsToBlob folds them into a Blob a batch at a time, so
// neither the page nor this worker ever holds an ASCII PLY of a 30 M-point cloud as
// one string (V8 caps a string at ~512 M chars) or a LAS as one buffer. The Blob
// goes home as a handle. The caller sends COPIES of its arrays, transferred in, so
// nothing needs round-tripping back.
export function makeExportOps({ lazCodec = null } = {}) {
  // args: [{ cloud: { count, pos, col?, nrm?, attributes? }, format, color, sim, cell,
  //          crsCode, geographic }] → { blob, count }
  // Georeference + voxel downsample run here too (prepareCloudForExport), since they
  // walk every point.
  async function exportCloud([{ cloud, format, color = true, sim = null, cell = 0, crsCode = null, geographic = false }], { emit }) {
    const t0 = performance.now()
    const onLog = (m, l = 'info', c = 'Export') => emit('log', [m, l, c])
    const src = prepareCloudForExport(cloud, { sim, cell, onLog })
    let blob
    if (format === 'laz') {
      if (!lazCodec) throw new Error('LAZ export: the lazcodec module is not available')
      await lazCodec.ensure()
      // LASzip keeps one encoder across bounded pushes (core/io/laz.js).
      blob = new Blob(cloudToLaz(src, { crsCode, geographic, compress: lazCodec.compress,
        createCompressor: lazCodec.createCompressor, onLog, parts: true }), { type: 'application/octet-stream' })
    } else if (format === 'las') {
      blob = partsToBlob(cloudToLasParts(src, { crsCode, geographic, onLog }), 'application/octet-stream')
    } else if (format === 'xyz') {
      blob = partsToBlob(cloudToXyzParts(src, { color }), 'text/plain;charset=utf-8')
    } else {
      const binary = format !== 'ply-ascii'
      blob = partsToBlob(cloudToPlyParts(src, { binary, color }),
        binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
    }
    const count = src.count ?? src.length
    onLog(`${format.toUpperCase()} written: ${count.toLocaleString()} points, `
      + `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info')
    return { result: { blob, count } }
  }

  // args: [{ mesh: { nVerts, count, pos, idx, col? }, format, color, sim }] → { blob, count }
  async function exportMesh([{ mesh, format, color = true, sim = null }], { emit }) {
    const t0 = performance.now()
    const onLog = (m, l = 'info', c = 'Export') => emit('log', [m, l, c])
    const src = prepareMeshForExport(mesh, { sim })
    let blob
    if (format === 'glb') blob = partsToBlob(meshToGlbParts(src, { color }), 'model/gltf-binary')
    else if (format === 'obj') blob = partsToBlob(meshToObjParts(src, { color }), 'text/plain;charset=utf-8')
    else if (format === 'stl') blob = partsToBlob(meshToStlParts(src), 'model/stl')
    else {
      const binary = format !== 'ply-ascii'
      blob = partsToBlob(meshToPlyParts(src, { binary, color }),
        binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
    }
    const count = src.count ?? (src.idx.length / 3)
    onLog(`Mesh ${format.toUpperCase()} written: ${count.toLocaleString()} triangles, `
      + `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info')
    return { result: { blob, count } }
  }

  return { exportCloud, exportMesh }
}
