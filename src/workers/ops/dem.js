// DEM ops: build a DEM (whole or in blocks) from a cloud, a mesh or a plane, and its
// preview. Product helpers shared with the ortho and the DEM tools are in products.js.

import { pointView } from '../../core/products/pointView.ts'
import { hillshadeRgba } from '../../core/products/colormap.js'
import { demRenderOptions } from '../../core/products/productStyle.js'
import { rasterToPng } from '../rasterPreview.js'
import {
  rasterizeDem,
  demGeometry,
  rasterizeDemBlocks,
  fillEnclosedGaps,
  createSupportOverview,
} from '../../core/products/dem.js'
import { createCogBuilder, geoKeysForEpsg, crsTagInfo, planCogFromTiles } from '../../core/products/geotiff.js'
import { DEM_PLANE_MAX, DEM_TILE, demAutoMaxSide } from '../../core/products/rasterSize.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import { unitName as frameUnitName } from '../../core/products/rasterUnits.js'
import { pluralize } from '../../core/textFormat.js'
import { createBlockProgress } from '../../utils/blockProgress.js'
import { deflateTile } from '../deflateTile.js'
import { MAX_ORTHO_SIDE, rebuildFrame, frameDescriptor, productBounds } from './productsShared.js'

// A DEM past DEM_PLANE_MAX is built in blocks of this side.
const DEM_BLOCK = 2048

export function makeDemOps() {
  // Colourise + hillshade a DEM height grid to a PNG data URL for the preview.
  // The pixel math is shared with the imported reference-DEM preview
  // (core/products/colormap.js `hillshadeRgba`) so the two look identical.
  async function demPreviewPng(grid, style = null) {
    return rasterToPng(hillshadeRgba(grid, demRenderOptions(style, grid)), grid.width, grid.height)
  }

  // Products ▸ DEM ▸ Symbology… — re-bake the preview PNG from the stored heights in
  // a new style ({ grid: { width, height, data, mask, gsd, zMin, zMax }, style }).
  // The plane arrives as a copy; only the PNG comes back.
  async function demPreview([input]) {
    return { result: { previewBlob: await demPreviewPng(input.grid, input.style) } }
  }

  // Build a DEM: transform the (dense) points into the chosen frame, rasterise a
  // height grid, and bake a hillshaded preview. Pure compute lives in
  // core/{projection,georef,dem}.js. Returns the grid (+ its frame descriptor so
  // the ortho pass reuses the exact same frame).
  async function generateDem([input], { emit }) {
    const { points, cameras = [], frame: frameSpec, settings = {} } = input
    const camMap = new Map(cameras.map((c) => [c.uuid, { R: c.R, t: c.t, K: c.K }]))
    emit('progress', [0, 1, 'Projecting points…'])
    const view = pointView(points)
    const frame = rebuildFrame(frameSpec, camMap, view)

    // Project every point into the frame (z = height).
    const pos = points.pos ?? new Float64Array(view.length * 3)
    let i = 0
    for (const p of view) {
      const projected = frame.fromSfm(p)
      pos[i++] = projected[0]
      pos[i++] = projected[1]
      pos[i++] = projected[2]
    }
    const framed = pointView({ pos, count: view.length })

    emit('progress', [0, 1, 'Rasterising grid…'])
    // The staged points stay alive through the rasterise, so the grid gets what
    // the budget leaves after them.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes - pos.byteLength : undefined
    const unitName = frameUnitName(frame.unit)
    // A DEM of the ground class alone is the bare-earth DTM; say so in the log.
    const label = settings.points === 'ground' ? 'DTM' : 'DEM'
    const bounds = productBounds(pos, view.length, settings.extent, label, unitName, emit)
    // Past one plane (SAT-3): a grid of more than DEM_PLANE_MAX cells a side is built
    // block by block into a Float32 COG, and the record's plane is its ≤ 4,096 overview.
    // Auto (≈ one point per cell) goes up to demAutoMaxSide, a chosen GSD or long side
    // up to the raster cap (rasterSize.js demGridFor, as the dialog's readout).
    const chosen = settings.gsd > 0 || settings.longSide > 1 // a cell size or a long side in px
    const full = demGeometry(framed, { ...settings, bounds, maxGrid: chosen ? MAX_ORTHO_SIDE : demAutoMaxSide() })
    if (full && Math.max(full.width, full.height) > DEM_PLANE_MAX) {
      return generateDemBlocks({
        pos,
        count: view.length,
        full,
        frame,
        frameSpec,
        settings,
        bounds,
        label,
        emit,
        chosen,
      })
    }
    const grid = rasterizeDem(framed, { ...settings, bounds, memBudgetBytes: budget })
    if (!grid) throw new Error(`${label}: could not rasterise (need a denser cloud or a smaller GSD)`)
    if (settings.aggregate && grid.aggregate !== settings.aggregate)
      emit?.('log', [
        `${label}: each cell takes the mean, not the median: the median's per-point buffer does not fit in memory`,
        'warn',
        'Products',
      ])

    // A rebuild keeps the previous DEM's symbology (an automatic range follows the new
    // heights; a manual one is the user's and stays).
    const previewBlob = await demPreviewPng(grid, settings.style)
    const unitLabel = frameUnitName(frame.unit)
    emit('log', [
      `${label}: ${grid.width}×${grid.height} @ ${grid.gsd.toPrecision(3)} ${unitLabel}/px, ` +
        `z ${grid.zMin.toPrecision(4)}–${grid.zMax.toPrecision(4)}, ` +
        `${grid.count} measured + ${grid.filled} filled cells` +
        `${grid.holesFilled ? ` (${grid.holesFilled} in enclosed gaps)` : ''} (${frame.crs}` +
        // A local frame's vertical is an estimate; say which camera signal set it.
        `${frame.crs === 'local' && frame.source ? `, up from ${frame.source}` : ''})`,
      'success',
      'Products',
    ])
    emit('progress', [1, 1, 'Done'])

    const result = {
      width: grid.width,
      height: grid.height,
      gsd: grid.gsd,
      originX: grid.originX,
      originY: grid.originY,
      data: grid.data,
      mask: grid.mask,
      support: grid.support,
      zMin: grid.zMin,
      zMax: grid.zMax,
      count: grid.count,
      filled: grid.filled,
      holesFilled: grid.holesFilled,
      frame: frameDescriptor(frame, frameSpec),
      crs: frame.crs,
      unit: frame.unit,
      previewBlob,
      ...(settings.style && { style: settings.style }),
    }
    return { result, transfer: [grid.data.buffer, grid.mask.buffer, grid.support.buffer] }
  }

  // A DEM whose grid is past DEM_PLANE_MAX on a side: rasterizeDemBlocks feeds a Float32
  // COG (NaN = nodata) block by block, so no full plane exists. The record's `data` /
  // `mask` / `gsd` are the COG's first overview of ≤ DEM_PLANE_MAX, which every plane
  // reader keeps using; `cog` + `fullWidth` / `fullHeight` / `fullGsd` are the DEM.
  async function generateDemBlocks({ pos, count, full, frame, frameSpec, settings, bounds, label, emit, chosen }) {
    const unit = frameUnitName(frame.unit)
    // The grid is capped at MAX_ORTHO_SIDE a side, an Auto one at demAutoMaxSide
    // (demGeometry grows the cell to fit); past 4 GiB the stored COG is a BigTIFF.
    // Coarsened never silently.
    const geom = full
    if (geom.gsd > full.requestedGsd * (1 + 1e-6)) {
      const cap = chosen ? MAX_ORTHO_SIDE : demAutoMaxSide()
      emit('log', [
        chosen
          ? `${label}: ${full.requestedGsd.toPrecision(3)} ${unit}/px would need more than ` +
            `${cap.toLocaleString()} cells a side; built at ${geom.gsd.toPrecision(3)} ${unit}/px`
          : `${label}: Auto — one point per cell (${full.requestedGsd.toPrecision(3)} ${unit}/px) would need more ` +
            `than ${cap.toLocaleString()} cells a side; built at ${geom.gsd.toPrecision(3)} ${unit}/px ` +
            `(set a GSD for a finer one)`,
        chosen ? 'warn' : 'info',
        'Products',
      ])
    }
    const tags = crsTagInfo({ crs: frame.crs, unit: frame.unit })
    const builder = createCogBuilder(
      {
        width: geom.width,
        height: geom.height,
        tileSize: DEM_TILE,
        ArrayType: Float32Array,
        samples: [{ bits: 32, format: 3 }],
        photometric: 1,
        gdalNoData: 'nan',
        pixelScale: [geom.gsd, geom.gsd, 0],
        tiepoint: [0, 0, 0, geom.originX, geom.originY, 0],
        geoKeys: geoKeysForEpsg(tags.code, tags.geographic),
      },
      { blockSize: DEM_BLOCK, compress: deflateTile, previewMaxDim: DEM_PLANE_MAX },
    )
    // The support plane at the overview the builder keeps (its first level that fits
    // DEM_PLANE_MAX, sized as the COG halves it): the share of measured cells in each.
    const ovLevels = planCogFromTiles({ width: geom.width, height: geom.height, tileSize: DEM_TILE }).levels
    const ovIndex = ovLevels.findIndex((l) => Math.max(l.width, l.height) <= DEM_PLANE_MAX)
    const supportOv = createSupportOverview(ovLevels[ovIndex].width, ovLevels[ovIndex].height, 2 ** ovIndex)
    const t0 = performance.now()
    const blockProgress = createBlockProgress(Math.ceil(geom.width / DEM_BLOCK) * Math.ceil(geom.height / DEM_BLOCK), {
      prefix: `${label}: `,
    })
    emit('progress', [0, 1, `Rasterising grid… ${blockProgress.label()}`])
    const res = await rasterizeDemBlocks(
      pos,
      count,
      geom,
      { ...settings, bounds, blockSize: DEM_BLOCK },
      {
        onBlock: async (b) => {
          supportOv.add(b)
          await builder.addBlock(b)
          const line = blockProgress.finished()
          if (line) emit('log', [line, 'info', 'Products'])
        },
        onProgress: (done, total) =>
          emit('progress', [done, total, `Rasterising grid… ${blockProgress.label()}`, (0.95 * done) / total]),
      },
    )
    emit('progress', [1, 1, 'Writing the GeoTIFF…', 0.96])
    const { parts, preview, levels } = await builder.finish()
    const cog = new Blob(parts, { type: 'image/tiff' })

    // The overview plane: level k of the COG, k halvings of the grid, same origin.
    const k = levels.findIndex((l) => l.width === preview.width && l.height === preview.height)
    const ov = {
      width: preview.width,
      height: preview.height,
      gsd: geom.gsd * 2 ** k,
      originX: geom.originX,
      originY: geom.originY,
      data: preview.data,
    }
    let holesFilled = 0
    if (settings.fillHoles) {
      holesFilled = fillEnclosedGaps(ov.data, ov.width, ov.height)
      emit('log', [
        `${label}: enclosed gaps are filled in the ${ov.width}×${ov.height} overview only; ` +
          `the full-resolution grid keeps them open`,
        'warn',
        'Products',
      ])
    }
    const mask = new Uint8Array(ov.width * ov.height)
    let zMin = Infinity,
      zMax = -Infinity
    for (let i = 0; i < mask.length; i++) {
      const z = ov.data[i]
      if (Number.isNaN(z)) continue
      mask[i] = 1
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
    }
    if (zMin > zMax) {
      zMin = res.zMin
      zMax = res.zMax
    }
    const grid = { ...ov, mask, zMin, zMax }
    // The builder's overview must be the level the support was binned to.
    const support =
      ovLevels[ovIndex].width === ov.width && ovLevels[ovIndex].height === ov.height ? supportOv.finish() : null
    const previewBlob = await demPreviewPng(grid, settings.style)
    emit('log', [
      `${label}: ${geom.width}×${geom.height} @ ${geom.gsd.toPrecision(3)} ${unit}/px in ` +
        `${pluralize(res.blocks, 'block')} of ${DEM_BLOCK}², z ${res.zMin.toPrecision(4)}–${res.zMax.toPrecision(4)}, ` +
        `${res.count} measured + ${res.filled} filled cells (${frame.crs}); GeoTIFF ${formatBytes(cog.size)} ` +
        `in ${((performance.now() - t0) / 1000).toFixed(1)} s, overview ${ov.width}×${ov.height} @ ` +
        `${ov.gsd.toPrecision(3)} ${unit}/px`,
      'success',
      'Products',
    ])
    emit('progress', [1, 1, 'Done'])
    const result = {
      width: ov.width,
      height: ov.height,
      gsd: ov.gsd,
      originX: ov.originX,
      originY: ov.originY,
      data: ov.data,
      mask,
      ...(support && { support }),
      zMin: res.zMin,
      zMax: res.zMax,
      count: res.count,
      filled: res.filled + holesFilled,
      holesFilled,
      cog,
      fullWidth: geom.width,
      fullHeight: geom.height,
      fullGsd: geom.gsd,
      tileSize: DEM_TILE,
      frame: frameDescriptor(frame, frameSpec),
      crs: frame.crs,
      unit: frame.unit,
      previewBlob,
      ...(settings.style && { style: settings.style }),
    }
    return { result, transfer: [ov.data.buffer, mask.buffer, ...(support ? [support.buffer] : [])] }
  }

  return {
    generateDem,
    demPreview,
  }
}
