import { readDepthFiles } from '../../core/dense/depthFileReader.js'
import { pointView } from '../../core/products/pointView.ts'
import { hillshadeRgba } from '../../core/products/colormap.js'
import { rasterToPng } from '../rasterPreview.js'
import { frameFromSpec, describeFrame } from '../../core/products/frameSpec.js'
import { rasterizeDem, coreExtent } from '../../core/products/dem.js'
import { orthorectifyStreamed } from '../../core/products/ortho.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import { orthoStats, describeOrthoStats } from '../../core/eval/orthoStats.js'
import { meshSurface, planeSurface, resampleSurface } from '../../core/products/surface.js'
import { traceContours, contoursToGeoJSON, contoursToDxf } from '../../core/products/contours.js'
import { terrainProducts } from '../../core/products/terrain.js'
import { clipDem, clipOrtho } from '../../core/products/rasterClip.js'
import { unitName as frameUnitName } from '../../core/products/rasterUnits.js'

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
  const load = async (mi, m, mapPxPerCell) => {
    const im = byUuid.get(m.uuid)
    if (!im) { load.fellBack++; return null }
    try {
      // Decode no finer than ~2 photo pixels per ortho cell (bilinear needs no more),
      // never above native: a coarse ortho then pays a fraction of the decode.
      const s = m.K.fx / im.K.fx   // depth-map pixels per native photo pixel
      const scale = mapPxPerCell > 0 ? Math.min(1, (2 * s) / mapPxPerCell) : 1
      const nativeMax = Math.max(m.width, m.height) / s
      const r = await rasterize(im.url, scale < 1 ? Math.ceil(nativeMax * scale) : Infinity)
      load.scaleSum += r.scale
      const map = makeSampleMap({ K: im.K, dist: im.dist, selfCal: im.selfCal, fiducial: im.fiducial,
        outScale: m.K.fx / im.K.fx, srcScale: r.scale })
      load.decoded++
      return { data: r.data, width: r.width, height: r.height, map }
    } catch (err) {
      emit('log', [`Ortho: ${im.name ?? m.uuid} — source photo unavailable (${err?.message ?? err}); `
        + 'using its depth-map colour', 'warn', 'Products'])
      load.fellBack++
      return null
    }
  }
  load.decoded = 0
  load.scaleSum = 0
  load.fellBack = 0
  return load
}

// Product ops (DEM + orthophoto). The frame rebuild/descriptor + raster→dataURL
// canvas helpers live here next to the two handlers; pure compute is in
// core/products/*. `rasterize` (injected) decodes the ortho's source photos.
export function makeProductsOps({ rasterize } = {}) {
  // Frames carry closures, so they can't cross postMessage — the store sends a
  // spec, the worker resolves it (core/products/frameSpec.js, shared with the
  // main thread's map placement). `cameras` is the uuid → { R, t } Map here.
  const rebuildFrame = (spec, cameras, points) => frameFromSpec(spec, cameras ? [...cameras.values()] : [], points ?? [])
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
    emit('log', [`${label}: extent is the cloud's dense core, ${f(core.maxX - core.minX)} × ${f(core.maxY - core.minY)} ${unit}`
      + (out ? ` — ${out.toLocaleString()} of ${count.toLocaleString()} points (${(100 * out / count).toFixed(1)}%) lie outside and are left out; choose Extent ▸ All points to keep them` : ''),
    out / count > 0.05 ? 'warn' : 'info', 'Products'])
    return core
  }

  // Colourise + hillshade a DEM height grid to a PNG data URL for the preview.
  // The pixel math is shared with the imported reference-DEM preview
  // (core/products/colormap.js `hillshadeRgba`) so the two look identical.
  async function demPreviewPng(grid) {
    return rasterToPng(hillshadeRgba(grid), grid.width, grid.height)
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
      pos[i++] = projected[0]; pos[i++] = projected[1]; pos[i++] = projected[2]
    }
    const framed = pointView({ pos, count: view.length })

    emit('progress', [0, 1, 'Rasterising grid…'])
    // The staged points stay alive through the rasterise, so the grid gets what
    // the budget leaves after them.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes - pos.byteLength : undefined
    const unitName = frameUnitName(frame.unit)
    const bounds = productBounds(pos, view.length, settings.extent, 'DEM', unitName, emit)
    const grid = rasterizeDem(framed, { ...settings, bounds, memBudgetBytes: budget })
    if (!grid) throw new Error('DEM: could not rasterise (need a denser cloud or a smaller GSD)')

    const previewBlob = await demPreviewPng(grid)
    const unitLabel = frameUnitName(frame.unit)
    emit('log', [`DEM: ${grid.width}×${grid.height} @ ${grid.gsd.toPrecision(3)} ${unitLabel}/px, `
      + `z ${grid.zMin.toPrecision(4)}–${grid.zMax.toPrecision(4)}, `
      + `${grid.count} measured + ${grid.filled} filled cells (${frame.crs}`
      // A local frame's vertical is an estimate; say which camera signal set it.
      + `${frame.crs === 'local' && frame.source ? `, up from ${frame.source}` : ''})`, 'success', 'Products'])
    emit('progress', [1, 1, 'Done'])

    const result = {
      width: grid.width, height: grid.height, gsd: grid.gsd,
      originX: grid.originX, originY: grid.originY,
      data: grid.data, mask: grid.mask, zMin: grid.zMin, zMax: grid.zMax,
      count: grid.count, filled: grid.filled,
      frame: frameDescriptor(frame, frameSpec), crs: frame.crs, unit: frame.unit,
      previewBlob,
    }
    return { result, transfer: [grid.data.buffer, grid.mask.buffer] }
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
    const framePts = new Array(needsScene ? surface.framePointCount ?? 0 : 0)
    for (let i = 0; i < framePts.length; i++) {
      framePts[i] = { x: fp[i * 3], y: fp[i * 3 + 1], z: fp[i * 3 + 2] }
    }
    const camMap = new Map(needsScene
      ? (surface.cameras ?? []).map((c) => [c.uuid, { R: c.R, t: c.t, K: c.K }])
      : [])
    const frame = rebuildFrame(surface.frame, camMap, framePts)
    if (kind === 'mesh') {
      emit('progress', [0, 1, 'Rasterising mesh surface…'])
      const n = Math.floor(surface.pos.length / 3)
      // Float64: these are absolute frame/CRS coordinates — at polar-stereographic
      // magnitudes (~2.5e6 m) Float32 steps are 0.25 m and the surface snaps.
      const framed = new Float64Array(surface.pos.length)
      for (let i = 0; i < n; i++) {
        const [x, y, z] = frame.fromSfm([surface.pos[i * 3], surface.pos[i * 3 + 1], surface.pos[i * 3 + 2]])
        framed[i * 3] = x; framed[i * 3 + 1] = y; framed[i * 3 + 2] = z
      }
      const unitName = frameUnitName(frame.unit)
      const bounds = productBounds(framed, n, surface.settings?.extent, 'Ortho (mesh surface)', unitName, emit)
      const grid = meshSurface({ pos: framed, idx: surface.idx }, { ...(surface.settings ?? {}), bounds },
        (done, total) => emit('progress', [done, total, 'Rasterising mesh surface…']))
      if (!grid) throw new Error('Ortho: the mesh has no triangles to rasterise')
      emit('log', [`Ortho: mesh surface ${grid.width}×${grid.height} @ `
        + `${grid.gsd.toPrecision(3)} ${frameUnitName(frame.unit)}/px from `
        + `${grid.triangles.toLocaleString()} triangles, ${grid.count} cells with height`,
      'info', 'Products'])
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
      for (let i = 0; i < surface.count; i++) { flat[i * 3] = framed[i].x; flat[i * 3 + 1] = framed[i].y }
      const unitName = frameUnitName(frame.unit)
      const bounds = productBounds(flat, surface.count, surface.settings?.extent, 'Ortho (plane surface)', unitName, emit)
      const grid = planeSurface(framed, { ...(surface.settings ?? {}), bounds })
      if (!grid) throw new Error('Ortho: could not fit a plane (need ≥3 spread points)')
      const p = grid.plane
      emit('log', [`Ortho: plane surface ${grid.width}×${grid.height} @ `
        + `${grid.gsd.toPrecision(3)} ${frameUnitName(frame.unit)}/px — `
        + `slope ${(Math.hypot(p.a, p.b) * 100).toFixed(1)}%, residual RMS `
        + `${p.rms.toPrecision(3)} over ${p.n.toLocaleString()} points`
        + (p.dropped ? ` (${p.dropped.toLocaleString()} outliers dropped)` : ''),
      'info', 'Products'])
      return { grid: { ...grid, frame: frameDescriptor(frame, surface.frame) }, frame, label: 'plane' }
    }
    throw new Error(`Ortho: unknown surface "${kind}"`)
  }

  // Build an orthophoto by reprojecting each surface cell into the cached depth
  // maps (their depth planes double as occlusion z-buffers; their RGB planes
  // supply the colour). Pure compute lives in core/products/{ortho,surface}.js.
  async function generateOrtho([input], { emit }) {
    const { surface, maps, streamed = false, settings = {} } = input
    const built = buildSurfaceGrid(surface, emit)
    const { frame, label } = built
    // The ortho's own GSD is independent of the surface's: a coarse surface is
    // plenty for reprojection while the ortho wants image resolution.
    const grid = settings.gsd > 0 ? resampleSurface(built.grid, settings.gsd) : built.grid
    if (grid !== built.grid) {
      emit('log', [`Ortho: resampled the ${label} surface to ${grid.width}×${grid.height} @ `
        + `${grid.gsd.toPrecision(3)} ${frameUnitName(frame.unit)}/px`, 'info', 'Products'])
    }
    // Products are capped at 4,096 px per side (surface.js MAX_GRID): a finer GSD over
    // this extent is coarsened, never silently.
    if (settings.gsd > 0 && grid.gsd > settings.gsd * (1 + 1e-6)) {
      const unit = frameUnitName(frame.unit)
      const want = Math.ceil(Math.max(grid.width, grid.height) * grid.gsd / settings.gsd)
      emit('log', [`Ortho: the requested ${settings.gsd.toPrecision(3)} ${unit}/px would need ~${want.toLocaleString()} px `
        + `on the long side; products are capped at 4,096 px, so this ortho is ${grid.gsd.toPrecision(3)} ${unit}/px. `
        + 'Limit the area (Tools ▸ Model ▸ Region, then rebuild the surface) for a finer GSD.', 'warn', 'Products'])
    }

    emit('progress', [0, grid.height, 'Orthorectifying…'])
    const t0 = performance.now()
    // Map-major whether the maps are saved (read one at a time) or in memory, so each
    // map's source photo is decoded once, used, and dropped before the next.
    const loadMap = streamed ? (i) => readDepthFiles(maps[i]) : async (i) => maps[i]
    const loadImage = makePhotoLoader(input.images, rasterize, emit)
    const { width, height, rgba, covered, sampled, filled, labels } = await orthorectifyStreamed(
      grid, maps, loadMap, frame.toSfm, settings,
      (done, total) => emit('progress', [done, total, 'Orthorectifying…']), loadImage)
    if (loadImage) {
      const meanScale = loadImage.decoded ? loadImage.scaleSum / loadImage.decoded : 0
      emit('log', [`Ortho: colour from ${loadImage.decoded} source photo(s), decoded at `
        + `${(100 * meanScale).toFixed(0)}% of native on average (≈ 2 photo px per ortho cell, at most native)`
        + `${loadImage.fellBack ? `, ${loadImage.fellBack} from depth-map colour (photo unavailable)` : ''}`, 'info', 'Products'])
    }

    const previewBlob = await rasterToPng(new ImageData(rgba, width, height), width, height)
    const cells = width * height
    // A DEM surface arrives as the stored DEM grid, which carries no cell count.
    let surfaceCells = grid.count
    if (surfaceCells == null) { surfaceCells = 0; for (let i = 0; i < cells; i++) if (grid.mask[i]) surfaceCells++ }
    emit('log', [`Ortho: ${width}×${height}, ${covered}/${cells} cells coloured `
      + `(${(100 * covered / cells).toFixed(0)}%) from ${maps.length} view(s) over the `
      + `${label} surface (${surfaceCells}/${cells} cells had a height) `
      + `— ${sampled} sampled + ${filled} interpolated `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'success', 'Products'])
    // The ortho's quality figures travel with it (its run record): sharpness, and
    // with a source label per cell, how visible the seams between images are.
    const stats = orthoStats(rgba, width, height, labels)
    emit('log', [`Ortho: ${describeOrthoStats(stats)}`, 'info', 'Products'])
    emit('progress', [height, height, 'Done'])

    const rgbaBuf = new Uint8Array(rgba.buffer)
    return {
      // The geotransform travels WITH the ortho: its grid no longer has to be the
      // DEM's, so the exporters/viewer must read it here, not off the DEM.
      result: {
        width, height, rgba: rgbaBuf, covered, sampled, filled, previewBlob,
        gsd: grid.gsd, originX: grid.originX, originY: grid.originY,
        surface: label, surfaceCells,
        frame: grid.frame, crs: frame.crs, unit: frame.unit, stats,
      },
      transfer: [rgbaBuf.buffer],
    }
  }

  // Tools ▸ Products ▾ — derived outputs of an existing DEM/ortho, all of which end
  // as a download (nothing here changes a stored product).
  //   contours: { grid, settings, format:'geojson'|'dxf', crs } → { text, lines, levels }
  //   terrain:  { grid, settings } → { rasters: { slope?, aspect?, hillshade? } }
  //   clip:     { grid | ortho, kind:'dem'|'ortho', polygons } → { raster }
  // The caller sends a COPY of the plane (transferred), so nothing is round-tripped.
  async function demTool([input], { emit }) {
    const log = (m, l, c) => emit('log', [m, l, c])
    const { tool, settings = {} } = input
    if (tool === 'contours') {
      const result = traceContours(input.grid, settings, log)
      const text = input.format === 'dxf'
        ? contoursToDxf(result)
        : JSON.stringify(contoursToGeoJSON(result, { crs: input.crs || undefined }))
      return { result: { text, lines: result.lines.length, levels: result.levels.length } }
    }
    if (tool === 'terrain') {
      const rasters = terrainProducts(input.grid, { ...settings, onLog: log })
      const transfer = Object.values(rasters).flatMap((r) => [r.data.buffer, r.mask.buffer])
      return { result: { rasters }, transfer }
    }
    if (tool === 'clip') {
      const raster = input.kind === 'ortho'
        ? clipOrtho(input.ortho, input.polygons, { onLog: log })
        : clipDem(input.grid, input.polygons, { onLog: log })
      const transfer = raster ? [raster.data.buffer, ...(raster.mask ? [raster.mask.buffer] : [])] : []
      return { result: { raster }, transfer }
    }
    throw new Error(`unknown raster tool "${tool}"`)
  }

  return { generateDem, generateOrtho, demTool }
}
