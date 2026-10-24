import {
  prepareCloudForExport,
  prepareMeshForExport,
  cloudToPlyParts,
  meshToPlyParts,
  meshToObjParts,
  meshToStlParts,
  meshToGlbParts,
  objMaterialLibrary,
} from '../../core/products/exporters.js'
import { zipParts } from '../../utils/zip.js'
import { cloudToLasParts } from '../../core/io/las.js'
import { cloudToLaz } from '../../core/io/laz.js'
import { cloudToXyzParts } from '../../core/io/cloudText.js'
import { partsToBlob } from '../../utils/blobParts.js'
import { assembleStripTiff, geoKeysForEpsg, createCogBuilder } from '../../core/products/geotiff.js'
import { MAX_RASTER_SIDE } from '../../core/products/rasterSize.js'
import {
  warpGrid,
  warpSourceCoords,
  sourceWindow,
  sampleRgbaWarp,
  sampleHeightsWarp,
} from '../../core/products/warp.js'
import proj4 from 'proj4'
import { MAX_ORTHO_IMAGE_CELLS as MAX_IMAGE_CELLS } from '../../core/products/exporters.js'
import { openRaster, readWindowBytes, rowsPerBand } from '../cogRead.js'
import { pluralize } from '../../core/textFormat.js'
import { fillUncovered, orthoNodataByte, rgbaToRgb } from '../../core/products/orthoBands.js'

async function deflatePart(bytes) {
  const part = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).blob()
  return { length: part.size, part }
}

// A name OBJ/MTL can reference: letters, digits, `_`, `.` and `-` only (no spaces).
export const objSafeName = (name) =>
  String(name ?? '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'mesh'

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
  async function exportCloud(
    [{ cloud, format, color = true, sim = null, cell = 0, crsCode = null, geographic = false }],
    { emit },
  ) {
    const t0 = performance.now()
    const onLog = (m, l = 'info', c = 'Export') => emit('log', [m, l, c])
    const src = prepareCloudForExport(cloud, { sim, cell, onLog })
    let blob
    if (format === 'laz') {
      if (!lazCodec) throw new Error('LAZ export: the lazcodec module is not available')
      await lazCodec.ensure()
      // LASzip keeps one encoder across bounded pushes (core/io/laz.js).
      blob = new Blob(
        cloudToLaz(src, {
          crsCode,
          geographic,
          compress: lazCodec.compress,
          createCompressor: lazCodec.createCompressor,
          onLog,
          parts: true,
        }),
        { type: 'application/octet-stream' },
      )
    } else if (format === 'las') {
      blob = partsToBlob(cloudToLasParts(src, { crsCode, geographic, onLog }), 'application/octet-stream')
    } else if (format === 'xyz') {
      blob = partsToBlob(cloudToXyzParts(src, { color }), 'text/plain;charset=utf-8')
    } else {
      const binary = format !== 'ply-ascii'
      blob = partsToBlob(
        cloudToPlyParts(src, { binary, color }),
        binary ? 'application/octet-stream' : 'text/plain;charset=utf-8',
      )
    }
    const count = src.count ?? src.length
    onLog(
      `${format.toUpperCase()} written: ${count.toLocaleString()} points, ` +
        `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'info',
    )
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
    const pages = textured
      ? texture.pages.map((p) => ({ ...p, bytes: texture.data.subarray(p.offset, p.offset + p.length) }))
      : []
    let blob,
      ext = format === 'glb' || format === 'obj' || format === 'stl' ? format : 'ply'
    if (format === 'glb') {
      blob = partsToBlob(
        meshToGlbParts(src, { color, texture: textured ? { pages, groups: texture.groups } : null }),
        'model/gltf-binary',
      )
    } else if (format === 'obj' && textured) {
      // OBJ and MTL split their lines on whitespace: `mtllib My Project.mtl` names two
      // files. The names inside the zip (and so in the .obj and .mtl) are file-safe.
      const base = objSafeName(name)
      const files = pages.map((_, k) => `${base}_atlas${k}.jpg`)
      const obj = partsToBlob(
        meshToObjParts(src, { texture: { mtl: `${base}.mtl`, groups: texture.groups } }),
        'text/plain;charset=utf-8',
      )
      blob = new Blob(
        await zipParts([
          { name: `${base}.obj`, data: obj },
          { name: `${base}.mtl`, data: objMaterialLibrary(files) },
          ...pages.map((p, k) => ({ name: files[k], data: p.bytes })),
        ]),
        { type: 'application/zip' },
      )
      ext = 'zip'
    } else if (format === 'obj') blob = partsToBlob(meshToObjParts(src, { color }), 'text/plain;charset=utf-8')
    else if (format === 'stl') blob = partsToBlob(meshToStlParts(src), 'model/stl')
    else {
      const binary = format !== 'ply-ascii'
      blob = partsToBlob(
        meshToPlyParts(src, { binary, color }),
        binary ? 'application/octet-stream' : 'text/plain;charset=utf-8',
      )
    }
    const count = src.count ?? src.idx.length / 3
    onLog(
      `Mesh ${format.toUpperCase()} written: ${count.toLocaleString()} triangles` +
        `${textured && (format === 'glb' || format === 'obj') ? `, ${pages.length} texture page${pages.length === 1 ? '' : 's'}` : ''}, ` +
        `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'info',
    )
    if (textured && format !== 'glb' && format !== 'obj') {
      onLog(
        `${format.toUpperCase()} has no texture support here: geometry only (use GLB or OBJ for the texture)`,
        'warn',
      )
    }
    return { result: { blob, count, ext } }
  }

  // args: [{ file, format: 'geotiff'|'png'|'jpeg', deflate, quality, alpha, nodata,
  // crs: { code, geographic } }] → { blob, width, height }. A computed orthophoto lives
  // as its stored COG (RGBA, tiled, overviews); every other ortho file is made from it
  // here, read back a band of rows at a time. Without `alpha` (and always in a JPEG)
  // the uncovered pixels take the `nodata` byte instead (core/products/orthoBands.js).
  //   geotiff — a baseline GeoTIFF in strips (core/products/geotiff.js
  //             assembleStripTiff), optionally DEFLATE per strip; the 4 GiB classic-TIFF
  //             ceiling refuses an uncompressed one that would not fit.
  //   png/jpeg — the full-resolution image through a canvas, up to MAX_IMAGE_CELLS
  //             (a canvas and its encode must hold it whole); beyond that, refused.
  async function exportOrtho(
    [{ file, format, deflate = false, quality = 0.9, alpha = true, nodata = 0, crs = {} }],
    { emit },
  ) {
    const nodataByte = orthoNodataByte(nodata)
    const t0 = performance.now()
    const image = await openRaster(file)
    const width = image.getWidth(),
      height = image.getHeight()
    const [sx, sy] = image.getResolution(),
      [ox, oy] = image.getOrigin()
    if (format === 'geotiff') {
      const rows = rowsPerBand(width, 4)
      const n = Math.ceil(height / rows)
      const bands = alpha ? 4 : 3
      if (!deflate && width * height * bands > 0xffffffff - 65536) {
        throw new Error(
          'an uncompressed GeoTIFF of this orthophoto would exceed the 4 GiB classic-TIFF limit — choose DEFLATE, or the Cloud-Optimized GeoTIFF',
        )
      }
      const strips = []
      for (let i = 0; i < n; i++) {
        const y0 = i * rows,
          y1 = Math.min(height, y0 + rows)
        const rgba = await readWindowBytes(image, 0, y0, width, y1)
        const bytes = alpha ? rgba : rgbaToRgb(rgba, nodataByte)
        strips.push(deflate ? await deflatePart(bytes) : { length: bytes.length, part: new Blob([bytes]) })
        emit('progress', [i + 1, n, 'Writing GeoTIFF strips…'])
      }
      const parts = assembleStripTiff(
        {
          width,
          height,
          samples: Array.from({ length: bands }, () => ({ bits: 8, format: 1 })),
          photometric: 2,
          extraSamples: alpha ? [2] : null,
          gdalNoData: alpha ? undefined : String(nodataByte),
          pixelScale: [sx, -sy, 0],
          tiepoint: [0, 0, 0, ox, oy, 0],
          geoKeys: geoKeysForEpsg(crs.code, crs.geographic),
          compression: deflate ? 8 : 1,
          rowsPerStrip: rows,
        },
        strips,
        { parts: true },
      )
      const blob = new Blob(parts, { type: 'image/tiff' })
      emit('log', [
        `Ortho GeoTIFF: ${width}×${height}, ${alpha ? 'RGBA' : `RGB with NODATA ${nodataByte}`}, in ` +
          `${pluralize(n, 'strip')}, ${(blob.size / 1024 ** 2).toFixed(1)} MB ` +
          `in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        'info',
        'Export',
      ])
      return { result: { blob, width, height } }
    }
    if (width * height > MAX_IMAGE_CELLS) {
      throw new Error(
        `a ${width.toLocaleString()}×${height.toLocaleString()} px orthophoto is too large for a ${format.toUpperCase()} ` +
          `(at most ${MAX_IMAGE_CELLS.toLocaleString()} px) — export a GeoTIFF instead`,
      )
    }
    const rgba = new Uint8ClampedArray(width * height * 4)
    const rows = rowsPerBand(width, 4)
    for (let y0 = 0; y0 < height; y0 += rows) {
      rgba.set(await readWindowBytes(image, 0, y0, width, Math.min(height, y0 + rows)), y0 * width * 4)
    }
    // JPEG has no alpha, so its uncovered cells always take the NODATA value.
    if (!alpha || format === 'jpeg') fillUncovered(rgba, nodataByte)
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(rgba, width, height), 0, 0)
    const blob = await canvas.convertToBlob({ type: format === 'jpeg' ? 'image/jpeg' : 'image/png', quality })
    emit('log', [
      `Ortho ${format.toUpperCase()}: ${width}×${height}, ${(blob.size / 1024 ** 2).toFixed(1)} MB ` +
        `in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'info',
      'Export',
    ])
    return { result: { blob, width, height } }
  }

  // A DEM or orthophoto in another CRS (plan-dense-past-one-tab P5): the output grid is
  // the source outline's box in the target CRS at the source's ground cell size
  // (core/products/warp.js), built block by block into a Cloud-Optimized GeoTIFF, each
  // block reading only the source window it maps onto. Heights pass through unchanged
  // (the horizontal CRS changes, the vertical datum does not). The page resolved both
  // CRS definitions (core/crs.js projDefinition): this worker has no catalog of its own.
  // args: [{ kind: 'dem' | 'ortho', file?: Blob (the stored COG), plane?: { data } (a
  //   DEM's plane when it has no COG), geo: { width, height, gsd, originX, originY },
  //   from: { code, def }, to: { code, def, epsg, geographic }, resampling }]
  //   → { blob, width, height, gsd, originX, originY }
  const WARP_BLOCK = 2048,
    WARP_TILE = 512,
    WARP_MAX_WINDOW = 64 * 1024 ** 2
  async function warpRaster([{ kind, file = null, plane = null, geo, from, to, resampling = 'bilinear' }], { emit }) {
    const t0 = performance.now()
    proj4.defs(from.code, from.def)
    proj4.defs(to.code, to.def)
    const conv = proj4(from.code, to.code)
    const forward = (x, y) => conv.forward([x, y]),
      inverse = (x, y) => conv.inverse([x, y])
    if (to.geographic) {
      // A pole inside the raster has no bounded box in degrees.
      for (const lat of [90, -90]) {
        const [px, py] = inverse(0, lat)
        if (
          px >= geo.originX &&
          px <= geo.originX + geo.width * geo.gsd &&
          py <= geo.originY &&
          py >= geo.originY - geo.height * geo.gsd
        ) {
          throw new Error(
            `the raster contains the ${lat > 0 ? 'North' : 'South'} Pole, which a geographic CRS cannot hold in one grid`,
          )
        }
      }
    }
    const out = warpGrid(geo, forward)
    const ortho = kind === 'ortho'
    if (Math.max(out.width, out.height) > MAX_RASTER_SIDE) {
      throw new Error(
        `in ${to.code} this ${ortho ? 'orthophoto' : 'DEM'} would be ${out.width.toLocaleString()} × ${out.height.toLocaleString()} px, ` +
          `past the ${MAX_RASTER_SIDE.toLocaleString()} px a raster may have on a side; export it in its own CRS`,
      )
    }
    const image = file ? await openRaster(file) : null
    const builder = createCogBuilder(
      {
        width: out.width,
        height: out.height,
        tileSize: WARP_TILE,
        ...(ortho
          ? {
              ArrayType: Uint8ClampedArray,
              samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
              photometric: 2,
              extraSamples: [2],
            }
          : { ArrayType: Float32Array, samples: [{ bits: 32, format: 3 }], photometric: 1, gdalNoData: 'nan' }),
        pixelScale: [out.gsd, out.gsd, 0],
        tiepoint: [0, 0, 0, out.originX, out.originY, 0],
        geoKeys: geoKeysForEpsg(to.epsg, to.geographic),
      },
      { blockSize: WARP_BLOCK, compress: deflatePart },
    )
    const nb = Math.ceil(out.width / WARP_BLOCK) * Math.ceil(out.height / WARP_BLOCK)
    let done = 0,
      finest = Infinity
    const nearest = resampling === 'nearest'
    for (let row0 = 0; row0 < out.height; row0 += WARP_BLOCK)
      for (let col0 = 0; col0 < out.width; col0 += WARP_BLOCK) {
        const w = Math.min(WARP_BLOCK, out.width - col0),
          h = Math.min(WARP_BLOCK, out.height - row0)
        const data = ortho ? new Uint8ClampedArray(w * h * 4) : new Float32Array(w * h).fill(NaN)
        const { sx, sy, step } = warpSourceCoords(out, geo, inverse, col0, row0, w, h)
        finest = Math.min(finest, step)
        const win = sourceWindow(sx, sy, geo)
        if (win) {
          const ww = win.x1 - win.x0,
            wh = win.y1 - win.y0
          if (ww * wh > WARP_MAX_WINDOW)
            throw new Error(
              `one output block reads ${ww.toLocaleString()} × ${wh.toLocaleString()} source cells; the CRS distorts this raster too much to warp`,
            )
          let src
          if (image) {
            src = ortho
              ? await readWindowBytes(image, win.x0, win.y0, win.x1, win.y1)
              : (
                  await image.readRasters({ window: [win.x0, win.y0, win.x1, win.y1], samples: [0], interleave: false })
                )[0]
          } else {
            src = new Float32Array(ww * wh)
            for (let r = 0; r < wh; r++)
              src.set(plane.data.subarray((win.y0 + r) * geo.width + win.x0, (win.y0 + r) * geo.width + win.x1), r * ww)
          }
          if (ortho) sampleRgbaWarp(src, ww, wh, win.x0, win.y0, sx, sy, data, { nearest })
          else
            sampleHeightsWarp(
              src instanceof Float32Array ? src : Float32Array.from(src),
              ww,
              wh,
              win.x0,
              win.y0,
              sx,
              sy,
              data,
              { nearest },
            )
        }
        await builder.addBlock({ col0, row0, width: w, height: h, data })
        emit('progress', [++done, nb, `Reprojecting to ${to.code}…`])
      }
    const { parts } = await builder.finish()
    const blob = new Blob(parts, { type: 'image/tiff' })
    emit('log', [
      `${ortho ? 'Ortho' : 'DEM'} export: reprojected to ${to.code}, ${out.width.toLocaleString()} × ${out.height.toLocaleString()} px ` +
        `at ${out.gsd.toPrecision(4)} per px (${resampling}${finest > 1 ? `, positions interpolated every ${finest} px` : ''}), ` +
        `${(blob.size / 1024 ** 2).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(1)} s; heights keep their vertical datum`,
      'info',
      'Export',
    ])
    return { result: { blob, ...out } }
  }

  return { exportCloud, exportMesh, exportOrtho, warpRaster }
}
