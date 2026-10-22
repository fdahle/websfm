import { readDepthFiles } from '../../core/dense/depthFileReader.js'
import { pointView } from '../../core/products/pointView.ts'
import { hillshadeRgba } from '../../core/products/colormap.js'
import { demRenderOptions } from '../../core/products/productStyle.js'
import { rasterToPng } from '../rasterPreview.js'
import { frameFromSpec, describeFrame } from '../../core/products/frameSpec.js'
import { rasterizeDem, coreExtent, demGeometry, rasterizeDemBlocks, fillEnclosedGaps } from '../../core/products/dem.js'
import { orthorectifyTiled, orthoTiledWorkingBytes, orthoMapPxPerCell, ORTHO_BLOCK } from '../../core/products/ortho.js'
import { orthoCacheLog } from '../../core/products/orthoPlan.js'
import { MAX_SEAM_CELLS } from '../../core/products/orthoMosaic.js'
import { GAIN_MIN, GAIN_MAX } from '../../core/products/colourGains.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import { packRgb } from '../../core/products/undistort.js'
import { describeOrthoStats, createOrthoStats } from '../../core/eval/orthoStats.js'
import { meshSurface, planeSurface } from '../../core/products/surface.js'
import { createCogBuilder, geoKeysForEpsg, crsTagInfo } from '../../core/products/geotiff.js'
import { DEM_PLANE_MAX, DEM_TILE, ORTHO_TILE, MAX_RASTER_SIDE, orthoGridFor } from '../../core/products/rasterSize.js'
import { TAB_BUFFER_POOL_BYTES, isBufferAllocationFailure } from '../../core/bufferLimit.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import { traceContours, contoursToGeoJSON, contoursToDxf } from '../../core/products/contours.js'
import { terrainProducts } from '../../core/products/terrain.js'
import { clipDem, clipOrtho, polygonPixelWindow, windowGeometry } from '../../core/products/rasterClip.js'
import { openRaster, readWindowBytes } from '../cogRead.js'
import { unitName as frameUnitName } from '../../core/products/rasterUnits.js'
import { nounFor, pluralize } from '../../core/textFormat.js'
import { createBlockProgress, createStepProgress, createLogPacer } from '../../utils/blockProgress.js'
import { deflateTile } from '../deflateTile.js'
import { planDemWindow, demCogLevels, maskFromNaN } from '../../core/products/demWindow.js'
import { fromBlob } from 'geotiff'

// The browser refusing memory, however it says it: V8's RangeError, a canvas's "Out of
// memory at ImageData creation", a Blob read's NotReadableError (core/bufferLimit.js), or
// an image decode that "could not be decoded" under the same pressure (quarry run 2; a
// truly broken photo then fails its one retry too and falls back as before).
const isOutOfMemory = (err) =>
  isBufferAllocationFailure(err) ||
  /out of memory|array buffer allocation failed|requested file could not be read|could not be decoded/i.test(
    err?.message ?? '',
  )

// The ortho's source photos (plan-ortho-mosaic O1). `images` comes from the store, one
// per depth map: { uuid, name, url, K (the camera's full-resolution K), dist, selfCal,
// fiducial }. Returns orthorectifyStreamed's loadImage(mi, map): the photo decoded at
// native resolution plus the depth-map-pixel → photo-pixel map, built exactly as dense
// built the depth map (same makeSampleMap chain; the map's K fixes its working scale).
// Null when there are no photos; a photo that fails to decode falls back to the
// depth map's own colour for that map, logged.
function makePhotoLoader(images, rasterize, emit) {
  if (!images?.length || !rasterize) return null
  const byUuid = new Map(images.map((im) => [im.uuid, im]))
  // `rethrowOutOfMemory`: a decode the browser refused memory for throws (err.outOfMemory)
  // instead of falling back, so the caller can make room and try again.
  const load = async (mi, m, mapPxPerCell, { rethrowOutOfMemory = false } = {}) => {
    const im = byUuid.get(m.uuid)
    if (!im) {
      load.fellBack++
      return null
    }
    try {
      // Decode no finer than ~2 photo pixels per ortho cell (bilinear needs no more),
      // never above native: a coarse ortho then pays a fraction of the decode.
      const s = m.K.fx / im.K.fx // depth-map pixels per native photo pixel
      const scale = mapPxPerCell > 0 ? Math.min(1, (2 * s) / mapPxPerCell) : 1
      const nativeMax = Math.max(m.width, m.height) / s
      const r = await rasterize(im.url, scale < 1 ? Math.ceil(nativeMax * scale) : Infinity)
      load.scaleSum += r.scale
      const outScale = [m.K.fx / im.K.fx, m.K.fy / im.K.fy]
      const base = makeSampleMap({
        K: im.K,
        dist: im.dist,
        selfCal: im.selfCal,
        fiducial: im.fiducial,
        outScale,
        srcScale: r.scaleXY ?? r.scale,
      })
      // A fisheye's depth map sits on a widened canvas (dense undistortRaster): its
      // principal point is shifted by the pad, so shift its pixels back first.
      const ox = im.dist?.fisheye ? m.K.cx - ((im.K.cx + 0.5) * outScale[0] - 0.5) : 0
      const oy = im.dist?.fisheye ? m.K.cy - ((im.K.cy + 0.5) * outScale[1] - 0.5) : 0
      const map = ox || oy ? (u, v) => base(u - ox, v - oy) : base
      load.decoded++
      return { data: packRgb(r.data), channels: 3, width: r.width, height: r.height, map }
    } catch (err) {
      if (rethrowOutOfMemory && isOutOfMemory(err))
        throw Object.assign(new Error(err?.message ?? String(err)), { outOfMemory: true })
      emit('log', [
        `Ortho: ${im.name ?? m.uuid} — source photo unavailable (${err?.message ?? err}); ` +
          'using its depth-map colour',
        'warn',
        'Products',
      ])
      load.fellBack++
      return null
    }
  }
  load.decoded = 0
  load.scaleSum = 0
  load.fellBack = 0
  return load
}

// The raster sizes (tile sizes, the DEM plane cap, the side cap, the classic-TIFF
// ceiling) are core/products/rasterSize.js, shared with the dialogs' size readout. The
// ortho's preview is at most 2,048 px a side (the viewers draw the tiles for detail).
const DEM_BLOCK = 2048
const PREVIEW_MAX = 2048
const MAX_ORTHO_SIDE = MAX_RASTER_SIDE
// A clip window is read whole and copied once (the clipped output): 8,192² RGBA is
// 256 MB each, and the clip is written as one baseline GeoTIFF.
const MAX_CLIP_CELLS = 8192 * 8192

// Cells whose source label differs from their right or lower neighbour's, in magenta.
function paintSeams(rgba, labels, w, h) {
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const i = r * w + c,
        l = labels[i]
      if (l === 0xffff) continue
      const right = c + 1 < w ? labels[i + 1] : l,
        down = r + 1 < h ? labels[i + w] : l
      if ((right !== l && right !== 0xffff) || (down !== l && down !== 0xffff)) rgba.set([255, 0, 255, 255], 4 * i)
    }
}

// A block-built DEM (SAT-3) read back as a plain height grid: the finest COG level
// whose window of `rect` (frame coords, null = all) holds at most `maxCells` cells
// (core/products/demWindow.js). dem: the record's { cog, originX, originY, fullGsd,
// fullWidth, fullHeight }. → { width, height, gsd, originX, originY, data (Float32,
// NaN = nodata), mask, level } or null when the rectangle misses the DEM.
export async function readDemGrid(dem, rect, maxCells) {
  const plan = planDemWindow(dem, demCogLevels(dem.fullWidth, dem.fullHeight, dem.tileSize ?? 512), rect, maxCells)
  if (!plan) return null
  const tiff = await fromBlob(dem.cog)
  const image = await tiff.getImage(plan.level)
  const [c0, r0, c1, r1] = plan.window
  const [data] = await image.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: false })
  const plane = data instanceof Float32Array ? data : Float32Array.from(data)
  return {
    width: plan.width,
    height: plan.height,
    gsd: plan.gsd,
    originX: plan.originX,
    originY: plan.originY,
    data: plane,
    mask: maskFromNaN(plane),
    level: plan.level,
  }
}

// Cells a DEM tool may read from a COG in one piece (contours, terrain): Float32 +
// mask + the tool's own planes stay within a few hundred MB.
const DEM_TOOL_CELLS = 48 * 1024 ** 2
// A depth map's planes in the ortho's cache: depth and cost (4 B each), rgb (3 B).
const ORTHO_MAP_PX_BYTES = 11

// Upper bound on a source photo's decoded RGBA: its full-resolution K puts the
// principal point near the centre, so 2·cx × 2·cy is about the native size.
// Upper bound on a source photo's decoded RGBA: its full-resolution K puts the
// principal point near the centre, so 2·cx × 2·cy is about the native size. The loader
// decodes at ~2 photo px per ortho cell (makePhotoLoader), so with the map's
// `mapPxPerCell` the bound is the native size × that scale² — ×4 for a pyramid read
// that lands one level finer. A satellite frame (2 GP) under a coarse ortho decodes to
// a small fraction of its native size.
const photoBytesBound = (im, m = null, mapPxPerCell = null) => {
  if (!im?.K) return 0
  const native = Math.ceil(2 * im.K.cx) * Math.ceil(2 * im.K.cy)
  const s = m?.K ? m.K.fx / im.K.fx : 0
  const scale = s > 0 && mapPxPerCell > 0 ? Math.min(1, (2 * s) / mapPxPerCell) : 1
  return Math.min(native, Math.ceil(4 * native * scale * scale)) * 4
}
// What that decode is expected to hold: the photo at its decode scale, packed RGB once
// decoded (the bound above, RGBA as decoded, allows 4× for a pyramid read one level
// finer). For predicting the cache, not for gating it.
const photoBytesExpected = (im, m, mapPxPerCell) => {
  if (!im?.K) return 0
  const native = Math.ceil(2 * im.K.cx) * Math.ceil(2 * im.K.cy)
  const s = m?.K ? m.K.fx / im.K.fx : 0
  const scale = s > 0 && mapPxPerCell > 0 ? Math.min(1, (2 * s) / mapPxPerCell) : 1
  return Math.ceil(native * scale * scale) * 3
}

// Product ops (DEM + orthophoto). The frame rebuild/descriptor + raster→dataURL
// canvas helpers live here next to the two handlers; pure compute is in
// core/products/*. `rasterize` (injected) decodes the ortho's source photos.
export function makeProductsOps({ rasterize } = {}) {
  // Frames carry closures, so they can't cross postMessage — the store sends a
  // spec, the worker resolves it (core/products/frameSpec.js, shared with the
  // main thread's map placement). `cameras` is the uuid → { R, t } Map here.
  const rebuildFrame = (spec, cameras, points) =>
    frameFromSpec(spec, cameras ? [...cameras.values()] : [], points ?? [])
  const frameDescriptor = describeFrame

  // The product extent (dem.js coreExtent): the cloud's dense footprint unless the
  // user asked for every point. Logged with what it leaves out, so a cut is never
  // silent. `pos` is interleaved xyz in FRAME coordinates. → bounds | undefined
  function productBounds(pos, count, mode, label, unit, emit) {
    if (mode === 'all') return undefined
    const core = coreExtent(pos, count)
    if (!core) return undefined
    const out = count - core.inside
    const f = (v) => v.toPrecision(4)
    emit('log', [
      `${label}: extent is the cloud's dense core, ${f(core.maxX - core.minX)} × ${f(core.maxY - core.minY)} ${unit}` +
        (out
          ? ` — ${out.toLocaleString()} of ${count.toLocaleString()} points (${((100 * out) / count).toFixed(1)}%) lie outside and are left out; choose Extent ▸ All points to keep them`
          : ''),
      out / count > 0.05 ? 'warn' : 'info',
      'Products',
    ])
    return core
  }

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
    // Past one plane (SAT-3): a GSD the user chose that needs more than DEM_PLANE_MAX
    // cells a side is built block by block into a Float32 COG, and the record's plane is
    // its ≤ 4,096 overview. Auto still picks a grid that fits one plane.
    const chosen = settings.gsd > 0 || settings.longSide > 1 // a cell size or a long side in px
    const full = chosen ? demGeometry(framed, { ...settings, bounds, maxGrid: MAX_ORTHO_SIDE }) : null
    if (full && Math.max(full.width, full.height) > DEM_PLANE_MAX) {
      return generateDemBlocks({ pos, count: view.length, full, frame, frameSpec, settings, bounds, label, emit })
    }
    const grid = rasterizeDem(framed, { ...settings, bounds, memBudgetBytes: budget })
    if (!grid) throw new Error(`${label}: could not rasterise (need a denser cloud or a smaller GSD)`)

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
    return { result, transfer: [grid.data.buffer, grid.mask.buffer] }
  }

  // A DEM whose grid is past DEM_PLANE_MAX on a side: rasterizeDemBlocks feeds a Float32
  // COG (NaN = nodata) block by block, so no full plane exists. The record's `data` /
  // `mask` / `gsd` are the COG's first overview of ≤ DEM_PLANE_MAX, which every plane
  // reader keeps using; `cog` + `fullWidth` / `fullHeight` / `fullGsd` are the DEM.
  async function generateDemBlocks({ pos, count, full, frame, frameSpec, settings, bounds, label, emit }) {
    const unit = frameUnitName(frame.unit)
    // The grid is capped at MAX_ORTHO_SIDE a side (demGeometry grows the cell to fit);
    // past 4 GiB the stored COG is a BigTIFF. Coarsened never silently.
    const geom = full
    if (geom.gsd > full.requestedGsd * (1 + 1e-6)) {
      emit('log', [
        `${label}: ${full.requestedGsd.toPrecision(3)} ${unit}/px would need more than ` +
          `${MAX_ORTHO_SIDE.toLocaleString()} cells a side; built at ${geom.gsd.toPrecision(3)} ${unit}/px`,
        'warn',
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
    return { result, transfer: [ov.data.buffer, mask.buffer] }
  }

  // Build the height grid the ortho walks, from whichever surface the user chose.
  // Ortho needs a height per ground cell — the DEM is only one way to get one, and
  // it is the holey one (see core/products/surface.js). `surface` is one of:
  //   { kind:'dem',   grid }                       — the built DEM, frame included
  //   { kind:'mesh',  frame, pos, idx }            — SfM-world verts + indices
  //   { kind:'plane', frame, pos, count }          — SfM-world points (flat xyz)
  // Mesh/plane arrive in SfM world coords and are projected into the frame here,
  // exactly as generateDem does, so all three grids share one convention. Their
  // frame spec may be a bare { kind:'local' } REQUEST rather than a resolved
  // descriptor, so they also carry `cameras` + `framePoints` — buildLocalFrame
  // derives the up-vector and origin from the scene and cannot run without them.
  function buildSurfaceGrid(surface, emit) {
    const kind = surface?.kind
    if (kind === 'dem') {
      return { grid: surface.grid, frame: rebuildFrame(surface.grid.frame), label: 'DEM' }
    }
    // Only an unresolved spec needs the scene; a descriptor resolves on its own.
    const needsScene = !(surface.frame?.kind === 'similarity' || surface.frame?.origin)
    const fp = surface.framePoints
    const framePts = new Array(needsScene ? (surface.framePointCount ?? 0) : 0)
    for (let i = 0; i < framePts.length; i++) {
      framePts[i] = { x: fp[i * 3], y: fp[i * 3 + 1], z: fp[i * 3 + 2] }
    }
    const camMap = new Map(needsScene ? (surface.cameras ?? []).map((c) => [c.uuid, { R: c.R, t: c.t, K: c.K }]) : [])
    const frame = rebuildFrame(surface.frame, camMap, framePts)
    if (kind === 'mesh') {
      emit('progress', [0, 1, 'Rasterising mesh surface…'])
      const n = Math.floor(surface.pos.length / 3)
      // Float64: these are absolute frame/CRS coordinates — at polar-stereographic
      // magnitudes (~2.5e6 m) Float32 steps are 0.25 m and the surface snaps.
      const framed = new Float64Array(surface.pos.length)
      for (let i = 0; i < n; i++) {
        const [x, y, z] = frame.fromSfm([surface.pos[i * 3], surface.pos[i * 3 + 1], surface.pos[i * 3 + 2]])
        framed[i * 3] = x
        framed[i * 3 + 1] = y
        framed[i * 3 + 2] = z
      }
      const unitName = frameUnitName(frame.unit)
      const bounds = productBounds(framed, n, surface.settings?.extent, 'Ortho (mesh surface)', unitName, emit)
      const grid = meshSurface(
        { pos: framed, idx: surface.idx },
        { ...(surface.settings ?? {}), bounds },
        (done, total) => emit('progress', [done, total, 'Rasterising mesh surface…']),
      )
      if (!grid) throw new Error('Ortho: the mesh has no triangles to rasterise')
      emit('log', [
        `Ortho: mesh surface ${grid.width}×${grid.height} @ ` +
          `${grid.gsd.toPrecision(3)} ${frameUnitName(frame.unit)}/px from ` +
          `${grid.triangles.toLocaleString()} triangles, ${grid.count} cells with height`,
        'info',
        'Products',
      ])
      return { grid: { ...grid, frame: frameDescriptor(frame, surface.frame) }, frame, label: 'mesh' }
    }
    if (kind === 'plane') {
      emit('progress', [0, 1, 'Fitting plane surface…'])
      const framed = new Array(surface.count)
      for (let i = 0; i < surface.count; i++) {
        const [x, y, z] = frame.fromSfm([surface.pos[i * 3], surface.pos[i * 3 + 1], surface.pos[i * 3 + 2]])
        framed[i] = { x, y, z }
      }
      const flat = new Float64Array(surface.count * 3)
      for (let i = 0; i < surface.count; i++) {
        flat[i * 3] = framed[i].x
        flat[i * 3 + 1] = framed[i].y
      }
      const unitName = frameUnitName(frame.unit)
      const bounds = productBounds(
        flat,
        surface.count,
        surface.settings?.extent,
        'Ortho (plane surface)',
        unitName,
        emit,
      )
      const grid = planeSurface(framed, { ...(surface.settings ?? {}), bounds })
      if (!grid) throw new Error('Ortho: could not fit a plane (need ≥3 spread points)')
      const p = grid.plane
      emit('log', [
        `Ortho: plane surface ${grid.width}×${grid.height} @ ` +
          `${grid.gsd.toPrecision(3)} ${frameUnitName(frame.unit)}/px — ` +
          `slope ${(Math.hypot(p.a, p.b) * 100).toFixed(1)}%, residual RMS ` +
          `${p.rms.toPrecision(3)} over ${p.n.toLocaleString()} points` +
          (p.dropped ? ` (${p.dropped.toLocaleString()} outliers dropped)` : ''),
        'info',
        'Products',
      ])
      return { grid: { ...grid, frame: frameDescriptor(frame, surface.frame) }, frame, label: 'plane' }
    }
    throw new Error(`Ortho: unknown surface "${kind}"`)
  }

  // Build an orthophoto by reprojecting each surface cell into the cached depth
  // maps (their depth planes double as occlusion z-buffers; their RGB planes
  // supply the colour). Pure compute lives in core/products/{ortho,surface}.js.
  // The ortho is computed block by block (core/products/ortho.js orthorectifyTiled)
  // and each block goes straight into a Cloud-Optimized GeoTIFF (core/products/
  // geotiff.js createCogBuilder), so no full-resolution plane exists anywhere: the
  // ortho's grid can be far finer than its ≤ 4,096 surface. The stored COG is the
  // ortho — the viewer and the map draw its tiles, exports copy or stream it.
  // ── Orthophoto ────────────────────────────────────────────────────────────────
  // One run (generateOrtho), or split over pool workers by the store
  // (reconstruction/productRuns.js): orthoPlan on one worker (the survey and the group
  // size, and the GeoTIFF writer it keeps for the run), orthoShare on the others (each
  // a run of the groups, its blocks sent back as events), orthoCogAdd for each block on
  // the planning worker, orthoFinish there. Every block computes what it computes in one
  // run (core/products/ortho.js), so the ortho is the same bits either way.

  // Everything a run needs before orthorectifyTiled: the surface and the ortho grid, the
  // memory plan, the loaders. `shares`: how many workers split the blocks (each gets
  // that share of the budget for its block planes, cache and photos in flight).
  // `quiet`: no log lines (a share repeats what the plan said).
  async function orthoSetup(input, emit, { shares = 1, quiet = false } = {}) {
    const say = quiet ? () => {} : (m, l = 'info') => emit('log', [m, l, 'Products'])
    const { surface, maps, streamed = false, settings = {} } = input
    // A block-built DEM surface (SAT-3) is read from its COG, as fine as the memory
    // budget allows (a fifth of it for the Float32 heights + mask), not its overview.
    if (surface?.kind === 'dem' && surface.grid?.cog) {
      const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : 2 * 1024 ** 3
      const g = surface.grid
      const read = await readDemGrid(g, null, Math.floor(budget / 5 / 5))
      say(
        `Ortho: DEM surface read from its GeoTIFF at ${read.width}×${read.height} @ ${read.gsd.toPrecision(3)}` +
          `${read.level ? ` (level ${read.level}; the full ${g.fullWidth}×${g.fullHeight} grid exceeds the memory budget)` : ' (full resolution)'}`,
        read.level ? 'warn' : 'info',
      )
      surface.grid = { ...read, frame: g.frame }
    }
    const built = buildSurfaceGrid(surface, quiet ? () => {} : emit)
    const { frame, label } = built
    const unit = frameUnitName(frame.unit)
    // The ortho's own GSD is independent of the surface's: a coarse surface is
    // plenty for reprojection while the ortho wants image resolution. Its heights are
    // sampled from the surface per block, never resampled into a full-size copy.
    // A cell size or a long side in px (`longSide`), else the surface's own cells, capped
    // at MAX_RASTER_SIDE a side (coarsened never silently); past 4 GiB the stored COG is
    // a BigTIFF. rasterSize.js orthoGridFor, as the dialog's readout computes it.
    const { geom, want } = orthoGridFor(built.grid, settings)
    if (!geom.identity) {
      say(
        `Ortho: ${geom.width.toLocaleString()}×${geom.height.toLocaleString()} @ ${geom.gsd.toPrecision(3)} ${unit}/px ` +
          `over the ${label} surface (${built.grid.width}×${built.grid.height} @ ${built.grid.gsd.toPrecision(3)} ${unit}/px)`,
      )
    }
    if (want > 0 && geom.gsd > want * (1 + 1e-6)) {
      const side = Math.ceil((Math.max(geom.width, geom.height) * geom.gsd) / want)
      say(
        `Ortho: the requested ${want.toPrecision(3)} ${unit}/px would need ~${side.toLocaleString()} px on the long side; ` +
          `a raster is at most ${MAX_ORTHO_SIDE.toLocaleString()} px a side, so this one is ${geom.gsd.toPrecision(3)} ${unit}/px. ` +
          'Limit the area (Tools ▸ Model ▸ Region, then rebuild the surface) for a finer GSD.',
        'warn',
      )
    }

    // Preflight. Resident at once: one block's working planes, the COG's accumulated
    // overview level and preview, and at least one map with its decoded photo. What
    // the budget leaves after the first two is the map/photo cache.
    const { width, height } = geom
    const blockBytes = orthoTiledWorkingBytes({
      width,
      height,
      blend: settings.blend,
      fillRadius: settings.fillRadius ?? 2,
      seamWidth: settings.seamWidth ?? 0,
      seamline: settings.seamline,
      seamBlend: settings.seamBlend,
    })
    const pyramidBytes = Math.ceil(width / 8) * Math.ceil(height / 8) * 4 + 2048 * 2048 * 4
    // A map's planes as the ortho reads them: depth, cost and rgb, 11 B/px (not its normals).
    const photoOf = new Map((input.images ?? []).map((im) => [im.uuid, im]))
    let zSum = 0,
      zN = 0
    for (let i = 0; i < built.grid.data.length; i += 97) {
      const z = built.grid.data[i]
      if (Number.isFinite(z)) {
        zSum += z
        zN++
      }
    }
    const pxPerCell = orthoMapPxPerCell(geom, frame.toSfm, zN ? zSum / zN : 0)
    // A cache entry: the map's planes when streamed (resident maps are not counted) and its
    // decoded photo.
    const entryBytes = (m) =>
      (streamed ? m.width * m.height * ORTHO_MAP_PX_BYTES : 0) + photoBytesBound(photoOf.get(m.uuid), m, pxPerCell(m))
    const maxEntry = maps.reduce(
      (n, m) =>
        Math.max(n, m.width * m.height * ORTHO_MAP_PX_BYTES + photoBytesBound(photoOf.get(m.uuid), m, pxPerCell(m))),
      0,
    )
    const maxCacheEntry = maps.reduce((n, m) => Math.max(n, entryBytes(m)), 0)
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : Infinity
    const fixed = blockBytes + pyramidBytes
    if (fixed + maxEntry > budget) {
      throw new Error(
        `the orthophoto needs ~${formatBytes(fixed + maxEntry)} at once (one ${ORTHO_BLOCK}² block ` +
          `${formatBytes(blockBytes)}, overviews ${formatBytes(pyramidBytes)}, one depth map + photo ${formatBytes(maxEntry)}) ` +
          `and the memory budget is ${formatBytes(budget)} — raise it in Settings ▸ Compute, or build at a coarser GSD`,
      )
    }
    // The cache evicts after a visit, so a miss loads its entry on top of a full cache:
    // leave room for one. The budget is the run's; the tab's buffer pool also holds what
    // the page has (`pageBytes`) and a decode's transient, so the cache gets no more than
    // ¾ of the pool leaves after those. Quarry (2026-10-20, 12 GiB budget, a 98 M-point
    // cloud open): an 11 GB cache failed an allocation at 15.5 GB of process data, short of
    // the 16 GiB pool, as the 80 MB photo buffers came and went; the quarter is that slack.
    // Photos load ahead of their visit (ortho.js planPhotos; `photoPrefetch`, 4): the
    // decodes overlap, and each one in flight holds an entry beyond the cache.
    // Split over `shares` workers, each has its own block planes, cache and photos in
    // flight; the overviews stay with the writer.
    const photoPrefetch = settings.photoPrefetch ?? 4
    // Each worker's cache when `k` workers split the blocks, and whether the tab, not the
    // budget, set it.
    const cacheFor = (k) => {
      const perShare = (total) => total / k - blockBytes - (1 + photoPrefetch) * maxCacheEntry
      const forBudget = Number.isFinite(budget) ? perShare(budget - pyramidBytes) : 2 * 1024 ** 3
      const forTab = perShare(0.75 * TAB_BUFFER_POOL_BYTES - (settings.pageBytes ?? 0) - pyramidBytes) - maxCacheEntry
      return { bytes: Math.max(maxCacheEntry, Math.min(forBudget, forTab)), tabBound: forTab < forBudget }
    }
    const { bytes: cacheBytes, tabBound } = cacheFor(shares)
    if (tabBound) {
      say(
        `Ortho: the map/photo cache is held to ${formatBytes(cacheBytes)}${shares > 1 ? ` per worker (${shares} workers)` : ''}, ` +
          'below what the memory budget allows, so the browser tab keeps room for the ' +
          `${formatBytes(settings.pageBytes ?? 0)} the open project already holds (16 GB is all a tab gets, page and workers together)`,
      )
    }
    // Each map's planes and source photo are cached across the blocks that see it.
    const loadMap = streamed ? (i) => readDepthFiles(maps[i], { normals: false }) : async (i) => maps[i]
    const loadImage = makePhotoLoader(input.images, rasterize, emit)
    // The mosaic's gain fit and graph-cut survey read every photo once more, coarse (a
    // gain needs means, a coarse seam grid no detail); their own loader keeps the decode
    // figures below about the colour pass.
    const loadStatsImage =
      settings.blend === 'mosaic' && (settings.colourBalance || settings.seamline === 'graphcut')
        ? makePhotoLoader(input.images, rasterize, emit)
        : null
    return {
      settings,
      maps,
      streamed,
      built,
      frame,
      label,
      unit,
      geom,
      width,
      height,
      blockBytes,
      pyramidBytes,
      maxCacheEntry,
      cacheBytes,
      cacheFor,
      photoPrefetch,
      photoOf,
      pxPerCell,
      loadMap,
      loadImage,
      loadStatsImage,
    }
  }

  // The options orthorectifyTiled runs with: blocks in groups, map-major inside (P6),
  // sized by replaying the visits through the cache; each block of a group takes its
  // working planes from the cache.
  const orthoTiledOpts = (ctx) => ({
    ...ctx.settings,
    blockSize: ORTHO_BLOCK,
    cacheBytes: ctx.cacheBytes,
    mapsResident: !ctx.streamed,
    photoPrefetch: ctx.photoPrefetch,
    groupBlocks: ctx.settings.groupBlocks ?? 'auto',
    blockBytes: ctx.blockBytes,
    entryBytes: ctx.maxCacheEntry,
    entrySizes: ctx.maps.map((m) => ({
      map: ctx.streamed ? m.width * m.height * ORTHO_MAP_PX_BYTES : 0,
      photo: photoBytesExpected(ctx.photoOf.get(m.uuid), m, ctx.pxPerCell(m)),
    })),
  })

  // The GeoTIFF the blocks are written into.
  const orthoBuilder = (ctx) => {
    const tags = crsTagInfo({ crs: ctx.frame.crs, unit: ctx.frame.unit })
    return createCogBuilder(
      {
        width: ctx.width,
        height: ctx.height,
        tileSize: ORTHO_TILE,
        ArrayType: Uint8ClampedArray,
        samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
        photometric: 2,
        extraSamples: [2], // RGB + unassociated alpha (transparent = no colour)
        pixelScale: [ctx.geom.gsd, ctx.geom.gsd, 0],
        tiepoint: [0, 0, 0, ctx.geom.originX, ctx.geom.originY, 0],
        geoKeys: geoKeysForEpsg(tags.code, tags.geographic),
      },
      { blockSize: ORTHO_BLOCK, compress: deflateTile, previewMaxDim: PREVIEW_MAX },
    )
  }
  const addOrthoBlock = async (builder, settings, b) => {
    // `debugSeams` (bench only, not in the dialog): paint the seams magenta, so
    // side-by-sides show where each variant put them.
    if (settings.debugSeams && b.labels) paintSeams(b.rgba, b.labels, b.width, b.height)
    await builder.addBlock({ col0: b.col0, row0: b.row0, width: b.width, height: b.height, data: b.rgba })
  }

  // The finished ortho: the GeoTIFF, its preview, the run's log lines and the record.
  // `res` is orthorectifyTiled's result (or the shares' merged), `decode` the colour
  // pass's photo loader figures ({ decoded, scaleSum, fellBack }), `statsDecode` the
  // survey's.
  async function orthoSummary(ctx, builder, res, { decode, statsDecode, t0, workers = 1 }, emit) {
    const { settings, maps, width, height, label, photoOf } = ctx
    emit('progress', [1, 1, 'Writing the GeoTIFF…', 0.96])
    const { parts, preview } = await builder.finish()
    const cog = new Blob(parts, { type: 'image/tiff' })
    const previewBlob = await rasterToPng(
      new ImageData(preview.data, preview.width, preview.height),
      preview.width,
      preview.height,
    )

    const { covered, sampled, filled, surfaceCells, stats } = res
    if (decode) {
      const meanScale = decode.decoded ? decode.scaleSum / decode.decoded : 0
      emit('log', [
        `Ortho: colour from the source photos, decoded at ` +
          `${(100 * meanScale).toFixed(0)}% of native on average (≈ 2 photo px per ortho cell, at most native)` +
          `${decode.fellBack ? `, ${decode.fellBack} from depth-map colour (photo unavailable)` : ''}`,
        'info',
        'Products',
      ])
    }
    const blocksX = Math.ceil(width / ORTHO_BLOCK),
      blocksY = Math.ceil(height / ORTHO_BLOCK)
    emit('log', [
      `Ortho: ${pluralize(res.blocks, 'block')} of ${ORTHO_BLOCK}² (${blocksX}×${blocksY}), ${pluralize(res.visits, 'map visit')} ` +
        `after culling (of ${res.blocks * maps.length}); ${pluralize(res.mapLoads, 'map read')}, ${pluralize(res.photoLoads, 'photo decode')}, ` +
        `${pluralize(res.cacheHits, 'cache hit')} in a ${Number.isFinite(res.grouping?.cacheBytes) ? formatBytes(res.grouping.cacheBytes) : 'default'} cache` +
        `${workers > 1 ? ` per worker, ${workers} workers` : ''}`,
      'info',
      'Products',
    ])
    if (res.cacheShrinks) {
      emit('log', [
        `Ortho: the browser refused memory for a photo ${pluralize(res.cacheShrinks, 'time')}; each time the ` +
          `map/photo cache gave up a quarter (to ${formatBytes(res.cacheLimit)} in the end) and the photo was decoded again. A lower memory ` +
          'budget (Settings ▸ Compute) starts the run there',
        'warn',
        'Products',
      ])
    }
    if (res.grouping?.predicted && Object.keys(res.grouping.predicted).length) {
      emit('log', [
        `Ortho: group sizes, predicted read cost — ${Object.entries(res.grouping.predicted)
          .map(([g, c]) => `${g}: ${Math.round(c)}`)
          .join(', ')}; chose ${res.grouping.size}`,
        'debug',
        'Products',
      ])
    }
    if (res.grouping?.size > 1) {
      const p = res.grouping.predicted ?? {}
      emit('log', [
        `Ortho: blocks in ${pluralize(res.grouping.groups, 'group')} of up to ${res.grouping.size}, each pass reading a map ` +
          `once for the whole group; predicted read cost ${Math.round(p[res.grouping.size] ?? 0)} against ` +
          `${Math.round(p[1] ?? 0)} block by block (a map read 1, a photo decode 3)`,
        'info',
        'Products',
      ])
    }
    const cells = width * height
    emit('log', [
      `Ortho: ${width}×${height}, ${covered}/${cells} cells coloured ` +
        `(${((100 * covered) / cells).toFixed(0)}%) from ${pluralize(maps.length, 'view')} over the ` +
        `${label} surface (${surfaceCells}/${cells} cells had a height) ` +
        `— ${sampled} sampled + ${filled} interpolated; GeoTIFF ${formatBytes(cog.size)} ` +
        `in ${((performance.now() - t0) / 1000).toFixed(1)}s${workers > 1 ? ` on ${workers} workers` : ''}`,
      'success',
      'Products',
    ])
    // The ortho's quality figures travel with it (its run record): sharpness, and
    // with a source label per cell, how visible the seams between images are.
    if (res.mosaic) {
      const { seamline, seamBlend, seamCells, smoothPasses, levels, seamCut, balance } = res.mosaic
      const seams =
        seamBlend === 'multiband'
          ? `blended in ${levels} frequency bands (multiband; the coarsest fades over ~±${3 << levels} cells)`
          : seamCells
            ? `feathered over ${pluralize(seamCells, 'cell')} (${settings.seamWidth}% of the short side${seamCells === MAX_SEAM_CELLS ? ', capped' : ''})`
            : 'hard (no feathering)'
      const where =
        seamline === 'graphcut'
          ? 'seamlines by graph cut (colour difference + nadir cost)'
          : `each cell from its most nadir view (finest foreshortened footprint), labels smoothed by ${pluralize(smoothPasses, 'majority pass', 'majority passes')}`
      emit('log', [`Ortho: mosaic — ${where}; seams ${seams}`, 'info', 'Products'])
      if (seamCut) {
        const pct = (v) => (100 * v).toFixed(1)
        emit('log', [
          `Ortho: graph cut on a ${seamCut.width}×${seamCut.height} grid (every ${pluralize(seamCut.factor, 'cell')}), ` +
            `${pluralize(seamCut.cycles, 'expansion cycle')}, ${pluralize(seamCut.accepted, 'accepted move')}; ${pct(seamCut.changedCells / Math.max(1, seamCut.labelled))}% ` +
            `of the cells moved off their most nadir view; energy ${seamCut.energy.toLocaleString()} (nearest-nadir ${seamCut.energyNadir.toLocaleString()}, ` +
            `−${pct(1 - seamCut.energy / Math.max(1, seamCut.energyNadir))}%)` +
            (res.seamCutMs
              ? `; survey ${((res.seamCutMs.read + res.seamCutMs.sample) / 1000).toFixed(1)} s (photo reads ${(res.seamCutMs.read / 1000).toFixed(1)} s), cut ${(res.seamCutMs.solve / 1000).toFixed(1)} s`
              : ''),
          'info',
          'Products',
        ])
      }
      if (balance) {
        const f = (v) => (v == null ? '—' : v.toFixed(3))
        const surveyDecode =
          (statsDecode?.decoded
            ? `; photos decoded at ${((100 * statsDecode.scaleSum) / statsDecode.decoded).toFixed(0)}% of native for the fit${seamCut ? ' and the seams' : ''}`
            : '') +
          (res.surveyFromMapRgb
            ? `; ${res.surveyFromMapRgb} of ${maps.length} images sampled from their depth maps' own colour (as fine as the survey needs, no decode)`
            : '')
        emit('log', [
          `Ortho: colour balance — gains for ${balance.images} of ${pluralize(maps.length, 'image')} from ` +
            `${pluralize(balance.pairs, 'overlapping pair')} over ${balance.latticeCells.toLocaleString()} lattice cells (every ` +
            `${balance.latticeStep}th; ${balance.clippedObservations.toLocaleString()} ${nounFor(balance.clippedObservations, 'clipped sample')} left out); gain min ${f(balance.min)} / median ${f(balance.median)} / max ${f(balance.max)}` +
            (balance.clamped
              ? `, ${pluralize(balance.clamped, 'channel gain')} clamped to ${GAIN_MIN}–${GAIN_MAX}`
              : '') +
            surveyDecode,
          balance.clamped ? 'warn' : 'info',
          'Products',
        ])
        if (res.gains) {
          const name = (m) => photoOf.get(m.uuid)?.name ?? m.uuid
          const list = maps.map(
            (m, i) => `${name(m)} ${[0, 1, 2].map((c) => res.gains[3 * i + c].toFixed(3)).join('/')}`,
          )
          emit('log', [`Ortho: gains per image (R/G/B): ${list.join(', ')}`, 'debug', 'Products'])
        }
      }
    }
    if (res.timings)
      emit('log', [
        `Ortho: time (s)${workers > 1 ? ', summed over the workers' : ''} — ${Object.entries(res.timings)
          .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}`)
          .join(', ')}`,
        'debug',
        'Products',
      ])
    emit('log', [`Ortho: ${describeOrthoStats(stats)}`, 'info', 'Products'])
    emit('progress', [1, 1, 'Done'])

    // The geotransform travels WITH the ortho: its grid no longer has to be the
    // DEM's, so the exporters/viewer must read it here, not off the DEM. Its frame is
    // the SURFACE's frame, whatever the GSD (a resampled grid used to drop it).
    return {
      width,
      height,
      covered,
      sampled,
      filled,
      previewBlob,
      cog,
      tileSize: ORTHO_TILE,
      gsd: ctx.geom.gsd,
      originX: ctx.geom.originX,
      originY: ctx.geom.originY,
      surface: label,
      surfaceCells,
      frame: ctx.built.grid.frame,
      crs: ctx.frame.crs,
      unit: ctx.frame.unit,
      stats,
      // How the pixels were chosen: the blend, and for a mosaic its seam band and gains.
      blend: settings.blend ?? 'best',
      mosaic: res.mosaic ?? null,
    }
  }

  // The log's progress lines for an ortho's blocks and map visits (one pace).
  function orthoProgress(emit) {
    let blockProgress = null,
      groupLabel = ''
    const pacer = createLogPacer()
    const heartbeat = createStepProgress({ prefix: 'Ortho: ', unit: 'map visit', pacer })
    const label = () =>
      groupLabel
        ? `Orthorectifying… ${groupLabel}`
        : blockProgress
          ? `Orthorectifying… ${blockProgress.label()}`
          : 'Orthorectifying…'
    return {
      // Grouped (P6), no block finishes until its whole group has: the label names the group.
      group(gi, n, size) {
        groupLabel = size > 1 ? `group ${gi + 1} of ${n} (${pluralize(size, 'block')})` : ''
      },
      progress(done, total) {
        emit('progress', [done, total, label(), (0.95 * done) / total])
        // A group of blocks finishes only when all of them have: the visits say it is moving.
        const line = heartbeat.step(done, total, groupLabel || (blockProgress ? '' : 'survey'))
        if (line) emit('log', [line, 'info', 'Products'])
      },
      blocksStart(count) {
        blockProgress = createBlockProgress(count, { prefix: 'Ortho: ', pacer })
      },
      blockDone() {
        const line = blockProgress?.finished()
        if (line) emit('log', [line, 'info', 'Products'])
      },
    }
  }

  async function generateOrtho([input], { emit }) {
    const ctx = await orthoSetup(input, emit)
    const t0 = performance.now()
    const builder = orthoBuilder(ctx)
    emit('progress', [0, 1, 'Orthorectifying…'])
    const prog = orthoProgress(emit)
    const res = await orthorectifyTiled(
      ctx.built.grid,
      ctx.geom,
      ctx.maps,
      ctx.loadMap,
      ctx.frame.toSfm,
      orthoTiledOpts(ctx),
      {
        loadImage: ctx.loadImage,
        loadStatsImage: ctx.loadStatsImage,
        onProgress: (d, t) => prog.progress(d, t),
        onGroup: (gi, n, size) => prog.group(gi, n, size),
        onBlocksStart: (count, { maxMaps = 0, groupSize = 1, cacheBytes: used = ctx.cacheBytes } = {}) => {
          prog.blocksStart(count)
          // Grouped, a pass reads each map once per group: the cache then only carries
          // maps from one pass or group to the next, so the per-block warning is moot.
          if (ctx.maxCacheEntry > 0 && maxMaps > 0 && groupSize === 1) {
            emit(
              'log',
              orthoCacheLog(used, ctx.maxCacheEntry, maxMaps, {
                mosaic: ctx.settings.blend === 'mosaic',
                streamed: ctx.streamed,
              }),
            )
          }
        },
        onBlock: async (b) => {
          await addOrthoBlock(builder, ctx.settings, b)
          prog.blockDone()
        },
      },
    )
    const result = await orthoSummary(
      ctx,
      builder,
      res,
      { decode: ctx.loadImage, statsDecode: ctx.loadStatsImage, t0 },
      emit,
    )
    return { result }
  }

  // The planning worker's run: its setup, its GeoTIFF writer and when it started.
  let orthoSession = null

  // A split ortho's first step, on the worker that then writes the GeoTIFF: the survey
  // (gains, seams) and the group size, with each worker's share of the memory budget,
  // and the groups dealt out in `shares` contiguous runs of about equal work (map visits).
  // input as generateOrtho's, settings.orthoShares the worker count wanted.
  // → { plan, shares: [[group index…]…], width, height, cacheBytes }
  // A worker's cache below this many entries (at their largest) re-reads its maps on every
  // pass: fewer workers then, each with more.
  const ORTHO_SHARE_MIN_ENTRIES = 6
  async function orthoPlan([input], { emit }) {
    const ctx = await orthoSetup(input, emit, { quiet: false })
    // Every worker count that leaves each its minimum cache; the plan picks the one with
    // the least predicted time (ortho.js planShares).
    const most = Math.max(1, input.settings?.orthoShares ?? 1)
    const planShares = []
    for (let k = 1; k <= most; k++) {
      const { bytes } = ctx.cacheFor(k)
      if (k === 1 || bytes >= ORTHO_SHARE_MIN_ENTRIES * ctx.maxCacheEntry) planShares.push({ k, cacheBytes: bytes })
    }
    const t0 = performance.now()
    emit('progress', [0, 1, 'Orthorectifying…'])
    const prog = orthoProgress(emit)
    const { plan } = await orthorectifyTiled(
      ctx.built.grid,
      ctx.geom,
      ctx.maps,
      ctx.loadMap,
      ctx.frame.toSfm,
      { ...orthoTiledOpts(ctx), planOnly: true, planShares },
      { loadImage: ctx.loadImage, loadStatsImage: ctx.loadStatsImage, onProgress: (d, t) => prog.progress(d, t) },
    )
    const want = plan.shareModel?.workers ?? 1
    ctx.cacheBytes = ctx.cacheFor(want).bytes
    if (plan.shareModel) {
      emit('log', [
        `Ortho: workers vs predicted time — ${plan.shareModel.candidates
          .map(
            (c) =>
              `${c.k}: ${Math.round(c.seconds)} s ` +
              `(${formatBytes(c.cacheBytes)} cache, ${Math.round(c.reads)} reads)`,
          )
          .join(', ')}; chose ${want}`,
        'debug',
        'Products',
      ])
    }
    orthoSession = { ctx, builder: orthoBuilder(ctx), t0 }
    // Contiguous runs (neighbouring groups share maps, so each worker's cache carries
    // over), cut where the visit count reaches each share's part.
    const work = plan.groupVisits
    const total = work.reduce((a, b) => a + b, 0)
    const shares = []
    let cur = [],
      acc = 0
    for (let gi = 0; gi < work.length; gi++) {
      cur.push(gi)
      acc += work[gi]
      if (shares.length < want - 1 && acc >= (total * (shares.length + 1)) / want) {
        shares.push(cur)
        cur = []
      }
    }
    if (cur.length) shares.push(cur)
    emit('log', [
      `Ortho: ${pluralize(plan.groups, 'group')} of up to ${pluralize(plan.groupBlocks, 'block')} dealt to ` +
        `${pluralize(shares.length, 'worker')}, a ${formatBytes(ctx.cacheBytes)} map/photo cache each`,
      'info',
      'Products',
    ])
    // Fewer groups than workers: as many shares as groups.
    return { result: { plan, shares, workers: want, width: ctx.width, height: ctx.height, cacheBytes: ctx.cacheBytes } }
  }

  // One worker's share of a split ortho: its groups, the plan's survey; each finished block
  // goes out as a 'block' event (its arrays transferred). → the run's counts, its stats
  // state (to merge) and its photo loaders' figures.
  // `claims`: the run's claim table (shared memory, one slot per group), when the page
  // can share memory: a group of this list that another worker claimed first is skipped.
  async function orthoShare([input, plan, groupIndices, shares, claims = null], { emit }) {
    const ctx = await orthoSetup(input, emit, { shares, quiet: true })
    const res = await orthorectifyTiled(
      ctx.built.grid,
      ctx.geom,
      ctx.maps,
      ctx.loadMap,
      ctx.frame.toSfm,
      { ...orthoTiledOpts(ctx), survey: plan.survey, groupBlocks: plan.groupBlocks, groupIndices, claims },
      {
        loadImage: ctx.loadImage,
        onProgress: (d, t) => emit('progress', [d, t]),
        onBlock: async (b) => emit('block', [b], [b.rgba.buffer, ...(b.labels ? [b.labels.buffer] : [])]),
      },
    )
    const { stats: _s, ...rest } = res
    const fig = (l) => (l ? { decoded: l.decoded, scaleSum: l.scaleSum, fellBack: l.fellBack } : null)
    // The group size was the plan's choice, and so are its predictions.
    return {
      result: { ...rest, grouping: { ...rest.grouping, predicted: plan.predicted }, decode: fig(ctx.loadImage) },
    }
  }

  // A block of a split ortho, into the planning worker's GeoTIFF.
  async function orthoCogAdd([b]) {
    if (!orthoSession) throw new Error('orthoCogAdd: no ortho in progress on this worker')
    await addOrthoBlock(orthoSession.builder, orthoSession.ctx.settings, b)
    return { result: true }
  }

  // The end of a split ortho, on the planning worker: the shares' results merged
  // (counts summed, stats states merged, the timings summed), the GeoTIFF finished, the
  // log written; the same record generateOrtho returns.
  async function orthoFinish([parts], { emit }) {
    const session = orthoSession
    orthoSession = null
    if (!session) throw new Error('orthoFinish: no ortho in progress on this worker')
    const stats = createOrthoStats(
      session.ctx.width,
      session.ctx.height,
      parts.some((p) => p.labelled),
    )
    for (const p of parts) stats.merge(p.statsState)
    const sum = (k) => parts.reduce((n, p) => n + (p[k] ?? 0), 0)
    const first = parts[0] ?? {}
    const timings = {}
    for (const p of parts) for (const [k, v] of Object.entries(p.timings ?? {})) timings[k] = (timings[k] ?? 0) + v
    const res = {
      ...first,
      stats: stats.finish(),
      timings,
      covered: sum('covered'),
      sampled: sum('sampled'),
      filled: sum('filled'),
      blocks: sum('blocks'),
      visits: sum('visits'),
      mapLoads: sum('mapLoads'),
      photoLoads: sum('photoLoads'),
      cacheHits: sum('cacheHits'),
      cacheShrinks: sum('cacheShrinks'),
      grouping: { ...first.grouping, groups: sum('groups') },
    }
    const decode = { decoded: 0, scaleSum: 0, fellBack: 0 }
    for (const p of parts) for (const k of Object.keys(decode)) decode[k] += p.decode?.[k] ?? 0
    const result = await orthoSummary(
      session.ctx,
      session.builder,
      res,
      {
        decode,
        statsDecode: session.ctx.loadStatsImage,
        t0: session.t0,
        workers: new Set(parts.map((p, i) => p.worker ?? i)).size,
      },
      emit,
    )
    return { result }
  }

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
    generateDem,
    generateOrtho,
    orthoPlan,
    orthoShare,
    orthoCogAdd,
    orthoFinish,
    demTool,
    demPreview,
    readDemWindow,
    demAscii,
  }
}
