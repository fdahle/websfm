// Tools ▸ Products ops on a built DEM or ortho: contours, terrain, clip, window reads
// and ASCII grids. Product helpers shared with the DEM and ortho ops are in products.js.

import { traceContours, contoursToGeoJSON, contoursToDxf } from '../../core/products/contours.js'
import { terrainProducts } from '../../core/products/terrain.js'
import { clipDem, clipOrtho, polygonPixelWindow, windowGeometry } from '../../core/products/rasterClip.js'
import { openRaster, readWindowBytes } from '../cogRead.js'
import { fromBlob } from 'geotiff'
import { readDemGrid } from './productsShared.js'

// A clip window is read whole and copied once (the clipped output): 8,192² RGBA is
// 256 MB each, and the clip is written as one baseline GeoTIFF.
const MAX_CLIP_CELLS = 8192 * 8192

// Cells a DEM tool may read from a COG in one piece (contours, terrain): Float32 +
// mask + the tool's own planes stay within a few hundred MB.
const DEM_TOOL_CELLS = 48 * 1024 ** 2

export function makeRasterToolOps() {
  // Tools ▸ Products ▾ — derived outputs of an existing DEM/ortho, all of which end
  // as a download (nothing here changes a stored product).
  //   contours: { grid, settings, format:'geojson'|'dxf'|'none', crs }
  //             → { text (null for 'none'), paths: [{ path, level, index }], lines, levels }
  //   terrain:  { grid, settings } → { rasters: { slope?, aspect?, hillshade? } }
  //   clip:     { kind:'dem', grid, polygons } | { kind:'ortho', cog, geo, polygons } → { raster }
  // A DEM plane arrives as a COPY (transferred), so nothing is round-tripped; an
  // ortho's COG File arrives as a handle and only the clip's window is read.
  async function demTool([input], { emit }) {
    const log = (m, l, c) => emit('log', [m, l, c])
    const { tool, settings = {} } = input
    // A block-built DEM (SAT-3) arrives as its record ({ dem }), not a plane: contours
    // and terrain read it whole at the finest level that fits DEM_TOOL_CELLS, a clip
    // reads its polygons' window at full resolution.
    if (input.dem && tool !== 'clip') {
      const d = input.dem
      input.grid = { ...(await readDemGrid(d, null, DEM_TOOL_CELLS)), crs: d.crs ?? null }
      log(
        `${tool === 'contours' ? 'Contours' : 'Terrain'}: DEM read at ${input.grid.width}×${input.grid.height} @ ` +
          `${input.grid.gsd.toPrecision(3)}${
            input.grid.level
              ? ` (level ${input.grid.level} of its GeoTIFF; the full ` +
                `${d.fullWidth}×${d.fullHeight} grid is past ${DEM_TOOL_CELLS.toLocaleString()} cells)`
              : ' (full resolution)'
          }`,
        input.grid.level ? 'warn' : 'info',
        'Products',
      )
    }
    if (tool === 'contours') {
      const result = traceContours(input.grid, settings, log)
      const fc = contoursToGeoJSON(result, { crs: input.crs || undefined })
      const text = input.format === 'dxf' ? contoursToDxf(result) : input.format === 'none' ? null : JSON.stringify(fc)
      // The lines for the map layer: the GeoJSON's coordinates, closed rings closed.
      const paths = fc.features.map((f) => ({
        path: f.geometry.coordinates,
        level: f.properties.elevation,
        index: f.properties.index,
      }))
      return { result: { text, paths, lines: result.lines.length, levels: result.levels.length } }
    }
    if (tool === 'terrain') {
      const rasters = terrainProducts(input.grid, { ...settings, onLog: log })
      const transfer = Object.values(rasters).flatMap((r) => [r.data.buffer, r.mask.buffer])
      return { result: { rasters }, transfer }
    }
    if (tool === 'clip') {
      // An ortho is a file: read only the window the polygons can touch, then clip that
      // sub-raster (rasterClip.js polygonPixelWindow — the same result as the whole plane).
      let ortho = null
      if (input.kind === 'ortho') {
        const { geo, cog } = input
        const win = polygonPixelWindow(geo, input.polygons)
        if (!win) {
          log('Clip ortho: no clip polygon overlaps the orthophoto', 'warn', 'Products')
          return { result: { raster: null } }
        }
        if (win.width * win.height > MAX_CLIP_CELLS) {
          throw new Error(
            `the clip area spans ${win.width.toLocaleString()}×${win.height.toLocaleString()} px of the orthophoto; ` +
              `a clip holds at most ${MAX_CLIP_CELLS.toLocaleString()} px — clip a smaller area, or export the COG and clip it in a GIS`,
          )
        }
        const image = await openRaster(cog)
        const data = await readWindowBytes(image, win.col0, win.row0, win.col0 + win.width, win.row0 + win.height)
        ortho = { ...windowGeometry(geo, win), data }
      }
      if (input.kind === 'dem' && input.dem) {
        const d = input.dem
        // The polygons' window in full-resolution cells (any polygon shape), as a frame rectangle.
        const win = polygonPixelWindow(
          { width: d.fullWidth, height: d.fullHeight, gsd: d.fullGsd, originX: d.originX, originY: d.originY },
          input.polygons,
        )
        const rect = win && {
          minX: d.originX + win.col0 * d.fullGsd,
          maxX: d.originX + (win.col0 + win.width) * d.fullGsd,
          maxY: d.originY - win.row0 * d.fullGsd,
          minY: d.originY - (win.row0 + win.height) * d.fullGsd,
        }
        input.grid = rect ? await readDemGrid(d, rect, MAX_CLIP_CELLS) : null
        if (!input.grid) {
          log('Clip DEM: no clip polygon overlaps the DEM', 'warn', 'Products')
          return { result: { raster: null } }
        }
        if (input.grid.level) {
          log(
            `Clip DEM: the clip area is past ${MAX_CLIP_CELLS.toLocaleString()} cells at full resolution; clipped at ` +
              `${input.grid.gsd.toPrecision(3)} (level ${input.grid.level} of its GeoTIFF)`,
            'warn',
            'Products',
          )
        }
      }
      const raster =
        input.kind === 'ortho'
          ? clipOrtho(ortho, input.polygons, { onLog: log })
          : clipDem(input.grid, input.polygons, { onLog: log })
      const transfer = raster ? [raster.data.buffer, ...(raster.mask ? [raster.mask.buffer] : [])] : []
      return { result: { raster }, transfer }
    }
    throw new Error(`unknown raster tool "${tool}"`)
  }

  // The main thread's window onto a block-built DEM (measurements, the GCP check):
  // [{ dem, rect, maxCells }] → readDemGrid's grid, its planes transferred.
  async function readDemWindow([{ dem, rect = null, maxCells = 16 * 1024 ** 2 }]) {
    const grid = await readDemGrid(dem, rect, maxCells)
    return { result: grid, transfer: grid ? [grid.data.buffer, grid.mask.buffer] : [] }
  }

  // A block-built DEM as an ESRI ASCII grid, read from its COG in row bands of level 0
  // so no full plane exists: [{ dem, nodata }] → a Blob (text/plain).
  async function demAscii([{ dem, nodata = -9999 }], { emit }) {
    const tiff = await fromBlob(dem.cog)
    const image = await tiff.getImage(0)
    const W = dem.fullWidth,
      H = dem.fullHeight,
      BAND = 256
    const parts = [
      `ncols ${W}\nnrows ${H}\nxllcorner ${dem.originX}\nyllcorner ${dem.originY - H * dem.fullGsd}\n` +
        `cellsize ${dem.fullGsd}\nNODATA_value ${nodata}\n`,
    ]
    const row = new Array(W)
    for (let r0 = 0; r0 < H; r0 += BAND) {
      const r1 = Math.min(H, r0 + BAND)
      const [band] = await image.readRasters({ window: [0, r0, W, r1], samples: [0], interleave: false })
      let text = ''
      for (let r = 0; r < r1 - r0; r++) {
        for (let c = 0; c < W; c++) {
          const v = band[r * W + c]
          row[c] = Number.isFinite(v) ? v : nodata
        }
        text += row.join(' ') + '\n'
      }
      parts.push(text)
      emit('progress', [r1, H, 'Writing the ASCII grid…'])
    }
    return { result: new Blob(parts, { type: 'text/plain' }) }
  }

  return {
    demTool,
    readDemWindow,
    demAscii,
  }
}
