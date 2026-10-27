import { epsgToWkt } from '../../core/products/wkt.js'
import {
  demToCog,
  demToGeoTiff,
  demSupportToGeoTiff,
  rasterWorldFile,
  demToAsciiGridParts,
  orthoToGeoTiff,
} from '../../core/products/exporters.js'
import { downloadBlob } from '../../utils/download.js'
import { showToast } from '../useToasts.js'
import { defaultExportName, exportFileName } from '../../core/exportNames.js'
import { partsToBlob } from '../../utils/blobParts.js'
import {
  exportOrthoFile,
  demTool as workerDemTool,
  demAscii as workerDemAscii,
  warpRaster as workerWarpRaster,
} from '../../workers/computeClient.js'
import { ensureProjection, projDefinition, isGeographic, transformer } from '../../core/crs.js'
import { rasterGroundScale, rasterUnits } from '../../core/products/rasterUnits.js'
import { productDescriptor } from '../../core/io/rasterSource.js'
import { pluralize } from '../../core/textFormat.js'
import { demRef } from '../../core/products/demWindow.js'

// The raster exports, split out of useExports: DEM and orthophoto (GeoTIFF / COG,
// ASCII grid, world files) and the Tools ▸ Products ▾ derivatives — contours,
// terrain products and a polygon clip — computed in the worker from the DEM.
//
// Deps are useExports' injected refs and shared helpers.
export function createRasterExports({ addLineSet, crsInfo, dem, log, ortho, projectBase }) {
  async function deflateBytes(bytes) {
    const cs = new CompressionStream('deflate')
    const stream = new Blob([bytes]).stream().pipeThrough(cs)
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }

  // `.prj` contents for a CRS: real OGC WKT1 when we can build a correct one for
  // the EPSG code (WGS84 geographic / UTM zones), else the raw proj4/EPSG string.
  function prjText(info) {
    const wkt = epsgToWkt(info.code)
    if (wkt) return wkt
    log(`.prj: no WKT template for ${info.crs} — writing the raw proj4/EPSG string`, 'info', 'Export')
    return info.crs
  }

  // DEM → GeoTIFF (optional DEFLATE), ESRI ASCII grid, or hillshade PNG — each
  // with a .prj sidecar carrying the CRS (real WKT where possible).
  // A DEM / ortho GeoTIFF in another CRS (`outputCrs`): reprojected block by block in
  // the export worker (workers/ops/export.js warpRaster) from the stored GeoTIFF, or a
  // DEM's plane when it has none; always a DEFLATE COG. The product stays as built.
  async function exportReprojected(kind, product, { outputCrs, resampling, fileName }) {
    const info = crsInfo(product)
    const label = kind === 'dem' ? 'DEM' : 'Ortho'
    if (!info.crs) {
      log(`${label} export: a raster in the local frame has no CRS to reproject from`, 'warn', 'Export')
      return
    }
    await ensureProjection(info.crs)
    await ensureProjection(outputCrs)
    const fromDef = projDefinition(info.crs),
      toDef = projDefinition(outputCrs)
    if (!fromDef || !toDef) throw new Error(`no proj4 definition for ${fromDef ? outputCrs : info.crs}`)
    const blockDem = kind === 'dem' && product.cog
    const geo = blockDem
      ? {
          width: product.fullWidth,
          height: product.fullHeight,
          gsd: product.fullGsd,
          originX: product.originX,
          originY: product.originY,
        }
      : {
          width: product.width,
          height: product.height,
          gsd: product.gsd,
          originX: product.originX,
          originY: product.originY,
        }
    let plane = null,
      transfer = []
    if (kind === 'dem' && !product.cog) {
      // The plane's mask can differ from its NaNs (a filled cell): what it masks is nodata.
      const data = Float32Array.from(product.data)
      if (product.mask) for (let i = 0; i < data.length; i++) if (!product.mask[i]) data[i] = NaN
      plane = { data }
      transfer = [data.buffer]
    }
    const epsg = Number(/^EPSG:(\d+)$/i.exec(outputCrs)?.[1]) || null
    const { blob, width, height } = await workerWarpRaster(
      {
        kind,
        file: product.cog ?? null,
        plane,
        geo,
        resampling,
        from: { code: info.crs, def: fromDef },
        to: { code: outputCrs, def: toDef, epsg, geographic: isGeographic(outputCrs) },
      },
      { transfer, onLog: (m, l, c) => log(m, l, c) },
    )
    const name = exportFileName(fileName, defaultExportName(kind, { base: projectBase(), crs: outputCrs }))
    downloadBlob(`${name}.tif`, blob, 'image/tiff')
    log(
      `${label} export: ${width}×${height} Cloud-Optimized GeoTIFF in ${outputCrs}, reprojected from ${info.crs}` +
        (kind === 'dem' ? ' (nodata NaN; heights keep their vertical datum)' : ''),
      'success',
      'Export',
    )
  }

  async function doExportDem({ format, nodata, compression, outputCrs = null, resampling = 'bilinear', fileName }) {
    if (!dem.value) return
    if (outputCrs && (format === 'cog' || format === 'geotiff'))
      return exportReprojected('dem', dem.value, { outputCrs, resampling, fileName })
    const info = crsInfo(dem.value)
    const name = exportFileName(fileName, defaultExportName('dem', { format, base: projectBase() }))
    if (format === 'support') {
      // On the plane grid: a DEM past one plane records support on its overview.
      const tif = await demSupportToGeoTiff(dem.value, {
        crs: info,
        deflate: compression === 'deflate' ? deflateBytes : null,
      })
      downloadBlob(`${name}.tif`, tif, 'image/tiff')
      log(
        `DEM export: support layer, ${dem.value.width}×${dem.value.height}` +
          (dem.value.cog ? ` (the overview of the ${dem.value.fullWidth}×${dem.value.fullHeight} grid)` : ''),
        'success',
        'Export',
      )
      return
    }
    // A DEM past one plane (SAT-3) is its stored COG: both TIFF formats hand that file
    // out as it is (DEFLATE, NaN for nodata), and the other formats are its overview.
    const full = dem.value.cog
    if (full && (format === 'cog' || format === 'geotiff')) {
      downloadBlob(`${name}.tif`, full, 'image/tiff')
      log(
        `DEM export: the full ${dem.value.fullWidth}×${dem.value.fullHeight} grid as its stored Cloud-Optimized ` +
          'GeoTIFF (DEFLATE, nodata NaN)',
        'success',
        'Export',
      )
      return
    }
    if (full && format !== 'png') {
      // The ASCII grid of the full grid, written from the COG in row bands.
      const blob = await workerDemAscii({ dem: demRef(dem.value), nodata }, { onLog: (m, l, c) => log(m, l, c) })
      downloadBlob(`${name}.asc`, blob, 'text/plain;charset=utf-8')
      if (info.crs) downloadBlob(`${name}.prj`, prjText(info), 'text/plain;charset=utf-8')
      log(`DEM export: ASCII grid of the full ${dem.value.fullWidth}×${dem.value.fullHeight} grid`, 'success', 'Export')
      return
    }
    if (full) {
      log(
        `DEM export: the hillshade PNG is of the ${dem.value.width}×${dem.value.height} overview, not the full ` +
          `${dem.value.fullWidth}×${dem.value.fullHeight} grid; export a GeoTIFF for that`,
        'warn',
        'Export',
      )
    }
    if (format === 'cog') {
      // COG defaults to DEFLATE: an uncompressed tiled file is strictly larger
      // than the baseline one for no benefit, and the whole point of the format
      // is cheap partial reads.
      const deflate = compression === 'none' ? null : deflateBytes
      const tif = await demToCog(dem.value, { crs: info, nodata, deflate })
      downloadBlob(`${name}.tif`, tif, 'image/tiff')
      log(`DEM export: Cloud-Optimized GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
    if (format === 'geotiff') {
      const deflate = compression === 'deflate' ? deflateBytes : null
      const tif = await demToGeoTiff(dem.value, { crs: info, nodata, deflate })
      downloadBlob(`${name}.tif`, tif, 'image/tiff')
      log(`DEM export: GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
    if (format === 'png') {
      // Hillshade PNG — the DEM's hillshaded preview canvas + world file + .prj.
      if (!dem.value.previewBlob) {
        log('DEM: no hillshade preview to export', 'warn', 'Export')
        return
      }
      downloadBlob(`${name}.png`, dem.value.previewBlob)
      downloadBlob(`${name}.wld`, rasterWorldFile(dem.value), 'text/plain;charset=utf-8')
      if (info.crs) downloadBlob(`${name}.prj`, prjText(info), 'text/plain;charset=utf-8')
      log('DEM export: hillshade PNG + world file', 'success', 'Export')
      return
    }
    downloadBlob(`${name}.asc`, partsToBlob(demToAsciiGridParts(dem.value, { nodata }), 'text/plain;charset=utf-8'))
    if (info.crs) downloadBlob(`${name}.prj`, prjText(info), 'text/plain;charset=utf-8')
  }

  // Ortho → COG, GeoTIFF (optional DEFLATE), or PNG/JPEG + world file (.wld) + .prj.
  // An orthophoto IS a stored Cloud-Optimized GeoTIFF (tiled, DEFLATE, overviews,
  // its CRS tagged): the COG export is that file, and the other forms are streamed
  // out of it in the export worker (workers/ops/export.js exportOrtho), so no export
  // ever holds the ortho as one array. The geotransform is the ORTHO's own.
  async function doExportOrtho({
    format,
    compression,
    jpegQuality,
    orthoAlpha = true,
    orthoNodata = 0,
    outputCrs = null,
    resampling = 'bilinear',
    fileName,
  }) {
    const o = ortho.value
    if (!o?.cog) return
    if (outputCrs && (format === 'cog' || format === 'geotiff'))
      return exportReprojected('ortho', o, { outputCrs, resampling, fileName })
    const info = crsInfo(o)
    const name = exportFileName(fileName, defaultExportName('ortho', { format, base: projectBase() }))
    if (format === 'cog') {
      downloadBlob(`${name}.tif`, o.cog, 'image/tiff')
      log('Ortho export: Cloud-Optimized GeoTIFF (the stored file, DEFLATE)', 'success', 'Export')
      return
    }
    const onLog = (m, l, c) => log(m, l, c)
    if (format === 'geotiff') {
      const deflate = compression === 'deflate'
      const { blob } = await exportOrthoFile(
        {
          file: o.cog,
          format,
          deflate,
          alpha: orthoAlpha,
          nodata: orthoNodata,
          crs: { code: info.code, geographic: info.geographic },
        },
        { onLog },
      )
      downloadBlob(`${name}.tif`, blob, 'image/tiff')
      log(`Ortho export: GeoTIFF${deflate ? ' (DEFLATE)' : ''}`, 'success', 'Export')
      return
    }
    const jpeg = format === 'jpeg'
    const ext = jpeg ? 'jpg' : 'png'
    // Full resolution, so the world file's cell size is the image's (the preview is not).
    const { blob } = await exportOrthoFile(
      {
        file: o.cog,
        format: jpeg ? 'jpeg' : 'png',
        quality: jpegQuality ?? 0.9,
        alpha: !jpeg && orthoAlpha,
        nodata: orthoNodata,
      },
      { onLog },
    )
    downloadBlob(`${name}.${ext}`, blob)
    // World file extension mirrors the image (.wld works for both; .jgw/.pgw are the
    // strict siblings — .wld is universally accepted, so keep it simple).
    downloadBlob(`${name}.wld`, rasterWorldFile(o), 'text/plain;charset=utf-8')
    if (info.crs) downloadBlob(`${name}.prj`, prjText(info), 'text/plain;charset=utf-8')
    log(`Ortho export: ${jpeg ? 'JPEG' : 'PNG'} + world file`, 'success', 'Export')
  }

  // ── Tools ▸ Products ▾ — contours, terrain derivatives, polygon clip ────────
  // Derived downloads of the existing DEM/ortho; no stored product changes. The
  // plane goes to the worker as a COPY (transferred), so the product stays intact.

  // Grid E/N in a projected CRS carry the point scale factor k (heights do not):
  // the true horizontal spacing is gsd / k. 1 for local/model frames, and for a
  // geographic grid, which has no linear scale (rasterUnits.js — the same rule as
  // the raster measurement tools).
  async function gridScaleFactor(product) {
    try {
      return (await rasterGroundScale(productDescriptor(product), product?.crs)) ?? 1
    } catch {
      return 1
    }
  }

  const gridCopy = (g) => ({
    width: g.width,
    height: g.height,
    gsd: g.gsd,
    originX: g.originX,
    originY: g.originY,
    data: g.data.slice(),
    mask: g.mask ? g.mask.slice() : null,
    crs: g.crs ?? null,
  })
  // A DEM tool's input: a block-built DEM (SAT-3) goes as its record and is read from
  // its COG in the worker; any other as a copy of its plane (transferred).
  const demToolInput = (g) => {
    if (g.cog) return { input: { dem: demRef(g) }, transfer: [] }
    const grid = gridCopy(g)
    return { input: { grid }, transfer: [grid.data.buffer, ...(grid.mask ? [grid.mask.buffer] : [])] }
  }
  const unitLabelOf = (g) => rasterUnits(g).vertical

  // Contours go on the map as a line layer (listed in Products) when the DEM has a CRS, and
  // are downloaded in `format` unless it is 'none'. A DEM in the local frame has no
  // place on the map's layers, so it is always downloaded (ContoursModal).
  async function exportContours({ interval, indexEvery, smooth, generalize, minCells, format, fileName }) {
    const grid = dem.value
    if (!grid) return
    const { input, transfer } = demToolInput(grid)
    const info = crsInfo(grid)
    const download = info.crs ? format : format === 'none' ? 'geojson' : format
    const { text, paths, lines, levels } = await workerDemTool(
      {
        tool: 'contours',
        ...input,
        settings: { interval, indexEvery, smooth, generalize, minCells },
        format: download,
        crs: info.crs,
      },
      { transfer, onLog: (m, l, c) => log(m, l, c) },
    )
    const unit = unitLabelOf(grid)
    let layer = null
    if (info.crs && paths.length) layer = await addLineSet(paths, info.crs, `Contours ${interval} ${unit}`)
    const dxf = download === 'dxf'
    const name = exportFileName(fileName, defaultExportName('contours', { base: projectBase() }))
    if (download !== 'none') {
      downloadBlob(`${name}.${dxf ? 'dxf' : 'geojson'}`, text, dxf ? 'application/dxf' : 'application/geo+json')
      if (dxf && info.crs) downloadBlob(`${name}.prj`, prjText(info), 'text/plain;charset=utf-8')
    }
    const where = [layer && `on the map (${layer.name})`, download !== 'none' && (dxf ? 'DXF' : 'GeoJSON')]
      .filter(Boolean)
      .join(' and ')
    log(
      `Contours: ${lines.toLocaleString()} lines over ${levels} levels every ${interval} ${unit} → ${where}`,
      'success',
      'Export',
    )
    if (layer)
      showToast('Contours added to the map', {
        detail: `Sidebar ▸ Products ▸ ${layer.name}, and View ▸ Map ▸ Layers. Its right-click menu downloads them as GeoJSON.`,
      })
    else if (!paths.length)
      showToast('No contour lines', { detail: 'No level crosses the DEM at this interval.', kind: 'error' })
  }

  async function exportTerrain({ products, slopeUnits, azimuth, altitude, multidirectional, compression, fileName }) {
    const base = exportFileName(fileName, defaultExportName('terrain', { base: projectBase() }))
    const grid = dem.value
    if (!grid || !products?.length) return
    const k = await gridScaleFactor(grid)
    if (k !== 1)
      log(
        `Terrain: point scale factor k = ${k.toFixed(6)} at the DEM centre — horizontal spacing is gsd/k`,
        'info',
        'Export',
      )
    const { input, transfer } = demToolInput(grid)
    const { rasters } = await workerDemTool(
      { tool: 'terrain', ...input, settings: { products, units: slopeUnits, azimuth, altitude, multidirectional, k } },
      { transfer, onLog: (m, l, c) => log(m, l, c) },
    )
    const info = crsInfo(grid)
    const deflate = compression === 'none' ? null : deflateBytes
    for (const name of products) {
      const r = rasters[name]
      if (!r) continue
      // Float32 single band with GDAL nodata, like the DEM itself — hillshade's
      // 0..255 bytes fit exactly, and one writer keeps the georeferencing identical.
      const data = name === 'hillshade' ? Float32Array.from(r.data, (v, i) => (r.mask[i] ? v : NaN)) : r.data
      const tif = await demToGeoTiff({ ...r, data }, { crs: info, nodata: -9999, deflate })
      downloadBlob(`${base}-${name}.tif`, tif, 'image/tiff')
    }
    log(`Terrain: exported ${products.join(', ')} as GeoTIFF`, 'success', 'Export')
  }

  async function exportClipped({ kind, polygons, polygonsCrs = null, compression, fileName }) {
    const product = kind === 'ortho' ? ortho.value : dem.value
    if (!product || !polygons?.length || (kind === 'ortho' && !product.cog)) return
    const geo = product
    // A GeoJSON in another CRS (lon/lat, as RFC 7946 has it) is moved into the raster's.
    const rasterCrs = crsInfo(geo).crs
    // Polygons that already overlap the raster as they are stay as they are (a local CRS
    // whose small numbers only look like lon/lat).
    const overlapsAsIs = () => {
      if (![geo.originX, geo.originY, geo.gsd, geo.width, geo.height].every(Number.isFinite)) return false
      const x0 = geo.originX,
        x1 = geo.originX + geo.width * geo.gsd,
        y1 = geo.originY,
        y0 = geo.originY - geo.height * geo.gsd
      return polygons.some((poly) => poly[0].some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1))
    }
    if (polygonsCrs && rasterCrs && polygonsCrs !== rasterCrs && !overlapsAsIs()) {
      await ensureProjection(polygonsCrs)
      await ensureProjection(rasterCrs)
      const to = transformer(polygonsCrs, rasterCrs)
      polygons = polygons.map((poly) => poly.map((ring) => ring.map(([x, y]) => to(x, y))))
      log(`Clip: the polygons were reprojected from ${polygonsCrs} to ${rasterCrs}`, 'info', 'Export')
    } else if (polygonsCrs && !rasterCrs)
      log(`Clip: the polygons are in ${polygonsCrs} but the raster has no CRS — taken as they are`, 'warn', 'Export')
    // An ortho is clipped from a window of its COG, read in the worker (no plane here).
    const input =
      kind === 'ortho'
        ? {
            tool: 'clip',
            kind,
            polygons,
            cog: product.cog,
            geo: {
              width: product.width,
              height: product.height,
              gsd: product.gsd,
              originX: product.originX,
              originY: product.originY,
            },
          }
        : { tool: 'clip', kind, polygons, ...demToolInput(product).input }
    const buffers =
      kind === 'ortho' || !input.grid
        ? []
        : [input.grid.data.buffer, ...(input.grid.mask ? [input.grid.mask.buffer] : [])]
    const { raster } = await workerDemTool(input, { transfer: buffers, onLog: (m, l, c) => log(m, l, c) })
    if (!raster) {
      log('Clip: the polygon does not overlap the raster', 'warn', 'Export')
      return
    }
    const info = crsInfo(geo)
    const deflate = compression === 'none' ? null : deflateBytes
    const tif =
      kind === 'ortho'
        ? await orthoToGeoTiff({ width: raster.width, height: raster.height, rgba: raster.data }, raster, {
            crs: info,
            deflate,
          })
        : await demToGeoTiff(raster, { crs: info, nodata: -9999, deflate })
    const name = exportFileName(fileName, defaultExportName('clip', { base: projectBase(), product: kind }))
    downloadBlob(`${name}.tif`, tif, 'image/tiff')
    log(
      `Clip: ${kind === 'ortho' ? 'orthophoto' : 'DEM'} clipped to ${pluralize(polygons.length, 'polygon')}, ${raster.width}×${raster.height} px`,
      'success',
      'Export',
    )
  }

  return {
    deflateBytes,
    prjText,
    doExportDem,
    doExportOrtho,
    gridScaleFactor,
    exportContours,
    exportTerrain,
    exportClipped,
    gridCopy,
    unitLabelOf,
  }
}
