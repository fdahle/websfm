import { prepareCloudForExport, prepareMeshForExport, cloudToPlyParts, meshToPlyParts, meshToObjParts, meshToStlParts, meshToGlbParts, objMaterialLibrary } from '../../core/products/exporters.js'
import { zipParts } from '../../utils/zip.js'
import { cloudToLasParts } from '../../core/io/las.js'
import { cloudToLaz } from '../../core/io/laz.js'
import { cloudToXyzParts } from '../../core/io/cloudText.js'
import { partsToBlob } from '../../utils/blobParts.js'
import { assembleStripTiff, geoKeysForEpsg } from '../../core/products/geotiff.js'
import { MAX_ORTHO_IMAGE_CELLS as MAX_IMAGE_CELLS } from '../../core/products/exporters.js'
import { openRaster, readWindowBytes, rowsPerBand } from '../cogRead.js'
import { pluralize } from '../../core/textFormat.js'

async function deflatePart(bytes) {
  const part = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).blob()
  return { length: part.size, part }
}

// A name OBJ/MTL can reference: letters, digits, `_`, `.` and `-` only (no spaces).
export const objSafeName = (name) => String(name ?? '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'mesh'

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

  // args: [{ mesh: { nVerts, count, pos, idx, col?, uv? }, format, color, sim,
  //   texture?: { data, pages, groups }, name }] → { blob, count, ext }
  // A textured mesh: GLB embeds the atlas pages; OBJ becomes a zip of the .obj, its
  // .mtl and one JPEG per page (OBJ refers to images by file name). Other formats
  // write the geometry only.
  async function exportMesh([{ mesh, format, color = true, sim = null, texture = null, name = 'mesh' }], { emit }) {
    const t0 = performance.now()
    const onLog = (m, l = 'info', c = 'Export') => emit('log', [m, l, c])
    const src = prepareMeshForExport(mesh, { sim })
    const textured = !!(texture?.pages?.length && mesh.uv)
    const pages = textured ? texture.pages.map((p) => ({ ...p, bytes: texture.data.subarray(p.offset, p.offset + p.length) })) : []
    let blob, ext = format === 'glb' || format === 'obj' || format === 'stl' ? format : 'ply'
    if (format === 'glb') {
      blob = partsToBlob(meshToGlbParts(src, { color, texture: textured ? { pages, groups: texture.groups } : null }), 'model/gltf-binary')
    } else if (format === 'obj' && textured) {
      // OBJ and MTL split their lines on whitespace: `mtllib My Project.mtl` names two
      // files. The names inside the zip (and so in the .obj and .mtl) are file-safe.
      const base = objSafeName(name)
      const files = pages.map((_, k) => `${base}_atlas${k}.jpg`)
      const obj = partsToBlob(meshToObjParts(src, { texture: { mtl: `${base}.mtl`, groups: texture.groups } }), 'text/plain;charset=utf-8')
      blob = new Blob(await zipParts([
        { name: `${base}.obj`, data: obj },
        { name: `${base}.mtl`, data: objMaterialLibrary(files) },
        ...pages.map((p, k) => ({ name: files[k], data: p.bytes })),
      ]), { type: 'application/zip' })
      ext = 'zip'
    } else if (format === 'obj') blob = partsToBlob(meshToObjParts(src, { color }), 'text/plain;charset=utf-8')
    else if (format === 'stl') blob = partsToBlob(meshToStlParts(src), 'model/stl')
    else {
      const binary = format !== 'ply-ascii'
      blob = partsToBlob(meshToPlyParts(src, { binary, color }),
        binary ? 'application/octet-stream' : 'text/plain;charset=utf-8')
    }
    const count = src.count ?? (src.idx.length / 3)
    onLog(`Mesh ${format.toUpperCase()} written: ${count.toLocaleString()} triangles`
      + `${textured && (format === 'glb' || format === 'obj') ? `, ${pages.length} texture page${pages.length === 1 ? '' : 's'}` : ''}, `
      + `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info')
    if (textured && format !== 'glb' && format !== 'obj') {
      onLog(`${format.toUpperCase()} has no texture support here: geometry only (use GLB or OBJ for the texture)`, 'warn')
    }
    return { result: { blob, count, ext } }
  }

  // args: [{ file, format: 'geotiff'|'png'|'jpeg', deflate, quality, crs: { code, geographic } }]
  // → { blob, width, height }. A computed orthophoto lives as its stored COG (RGBA,
  // tiled, overviews); every other ortho file is made from it here, read back a band
  // of rows at a time:
  //   geotiff — a baseline GeoTIFF in strips (core/products/geotiff.js
  //             assembleStripTiff), optionally DEFLATE per strip; the 4 GiB classic-TIFF
  //             ceiling refuses an uncompressed one that would not fit.
  //   png/jpeg — the full-resolution image through a canvas, up to MAX_IMAGE_CELLS
  //             (a canvas and its encode must hold it whole); beyond that, refused.
  async function exportOrtho([{ file, format, deflate = false, quality = 0.9, crs = {} }], { emit }) {
    const t0 = performance.now()
    const image = await openRaster(file)
    const width = image.getWidth(), height = image.getHeight()
    const [sx, sy] = image.getResolution(), [ox, oy] = image.getOrigin()
    if (format === 'geotiff') {
      const rows = rowsPerBand(width, 4)
      const n = Math.ceil(height / rows)
      if (!deflate && width * height * 4 > 0xffffffff - 65536) {
        throw new Error('an uncompressed GeoTIFF of this orthophoto would exceed the 4 GiB classic-TIFF limit — choose DEFLATE, or the Cloud-Optimized GeoTIFF')
      }
      const strips = []
      for (let i = 0; i < n; i++) {
        const y0 = i * rows, y1 = Math.min(height, y0 + rows)
        const bytes = await readWindowBytes(image, 0, y0, width, y1)
        strips.push(deflate ? await deflatePart(bytes) : { length: bytes.length, part: new Blob([bytes]) })
        emit('progress', [i + 1, n, 'Writing GeoTIFF strips…'])
      }
      const parts = assembleStripTiff({
        width, height, samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })), photometric: 2, extraSamples: [2],
        pixelScale: [sx, -sy, 0], tiepoint: [0, 0, 0, ox, oy, 0], geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
        compression: deflate ? 8 : 1, rowsPerStrip: rows,
      }, strips, { parts: true })
      const blob = new Blob(parts, { type: 'image/tiff' })
      emit('log', [`Ortho GeoTIFF: ${width}×${height} in ${pluralize(n, 'strip')}, ${(blob.size / 1024 ** 2).toFixed(1)} MB `
        + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info', 'Export'])
      return { result: { blob, width, height } }
    }
    if (width * height > MAX_IMAGE_CELLS) {
      throw new Error(`a ${width.toLocaleString()}×${height.toLocaleString()} px orthophoto is too large for a ${format.toUpperCase()} `
        + `(at most ${MAX_IMAGE_CELLS.toLocaleString()} px) — export a GeoTIFF instead`)
    }
    const rgba = new Uint8ClampedArray(width * height * 4)
    const rows = rowsPerBand(width, 4)
    for (let y0 = 0; y0 < height; y0 += rows) {
      rgba.set(await readWindowBytes(image, 0, y0, width, Math.min(height, y0 + rows)), y0 * width * 4)
    }
    // JPEG has no alpha; the encoder flattens uncovered cells to black.
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0)
    const blob = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality })
    emit('log', [`Ortho ${format.toUpperCase()}: ${width}×${height}, ${(blob.size / 1024 ** 2).toFixed(1)} MB `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'info', 'Export'])
    return { result: { blob, width, height } }
  }

  return { exportCloud, exportMesh, exportOrtho }
}
