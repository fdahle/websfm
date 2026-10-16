import { readDepthFiles } from '../../core/dense/depthFileReader.js'
import { pointView } from '../../core/products/pointView.ts'
import { hillshadeRgba } from '../../core/products/colormap.js'
import { demRenderOptions } from '../../core/products/productStyle.js'
import { rasterToPng } from '../rasterPreview.js'
import { frameFromSpec, describeFrame } from '../../core/products/frameSpec.js'
import { rasterizeDem, coreExtent } from '../../core/products/dem.js'
import { orthorectifyTiled, orthoTiledWorkingBytes, ORTHO_BLOCK, MAX_SEAM_CELLS } from '../../core/products/ortho.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import { describeOrthoStats } from '../../core/eval/orthoStats.js'
import { meshSurface, planeSurface, resampledGeometry } from '../../core/products/surface.js'
import { createCogBuilder, cogRawBytes, geoKeysForEpsg, crsTagInfo } from '../../core/products/geotiff.js'
import { formatBytes } from '../../core/dense/memBudget.js'
import { traceContours, contoursToGeoJSON, contoursToDxf } from '../../core/products/contours.js'
import { terrainProducts } from '../../core/products/terrain.js'
import { clipDem, clipOrtho, polygonPixelWindow, windowGeometry } from '../../core/products/rasterClip.js'
import { openRaster, readWindowBytes } from '../cogRead.js'
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
      const outScale = [m.K.fx / im.K.fx, m.K.fy / im.K.fy]
      const base = makeSampleMap({ K: im.K, dist: im.dist, selfCal: im.selfCal, fiducial: im.fiducial,
        outScale, srcScale: r.scaleXY ?? r.scale })
      // A fisheye's depth map sits on a widened canvas (dense undistortRaster): its
      // principal point is shifted by the pad, so shift its pixels back first.
      const ox = im.dist?.fisheye ? m.K.cx - ((im.K.cx + 0.5) * outScale[0] - 0.5) : 0
      const oy = im.dist?.fisheye ? m.K.cy - ((im.K.cy + 0.5) * outScale[1] - 0.5) : 0
      const map = ox || oy ? (u, v) => base(u - ox, v - oy) : base
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

// The stored ortho COG: 512-px tiles (as the ortho export always wrote them), a
// preview of at most 2,048 px a side (the viewers draw the tiles for detail), and the
// classic-TIFF ceiling. The side cap only bounds the grid arithmetic; the 4 GiB
// ceiling is the real limit (~28 k px square).
const ORTHO_TILE = 512
const PREVIEW_MAX = 2048
const MAX_ORTHO_SIDE = 65535
const TIFF_LIMIT = 0xffffffff
// A clip window is read whole and copied once (the clipped output): 8,192² RGBA is
// 256 MB each, and the clip is written as one baseline GeoTIFF.
const MAX_CLIP_CELLS = 8192 * 8192

// One tile's zlib stream, kept as a Blob part (off the heap; assembleCog takes parts).
async function deflateTile(bytes) {
  const part = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).blob()
  return { length: part.size, part }
}

// Upper bound on a source photo's decoded RGBA: its full-resolution K puts the
// principal point near the centre, so 2·cx × 2·cy is about the native size.
const photoBytesBound = (im) => (im?.K ? Math.ceil(2 * im.K.cx) * Math.ceil(2 * im.K.cy) * 4 : 0)

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
      pos[i++] = projected[0]; pos[i++] = projected[1]; pos[i++] = projected[2]
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
    const grid = rasterizeDem(framed, { ...settings, bounds, memBudgetBytes: budget })
    if (!grid) throw new Error(`${label}: could not rasterise (need a denser cloud or a smaller GSD)`)

    // A rebuild keeps the previous DEM's symbology (an automatic range follows the new
    // heights; a manual one is the user's and stays).
    const previewBlob = await demPreviewPng(grid, settings.style)
    const unitLabel = frameUnitName(frame.unit)
    emit('log', [`${label}: ${grid.width}×${grid.height} @ ${grid.gsd.toPrecision(3)} ${unitLabel}/px, `
      + `z ${grid.zMin.toPrecision(4)}–${grid.zMax.toPrecision(4)}, `
      + `${grid.count} measured + ${grid.filled} filled cells`
      + `${grid.holesFilled ? ` (${grid.holesFilled} in enclosed gaps)` : ''} (${frame.crs}`
      // A local frame's vertical is an estimate; say which camera signal set it.
      + `${frame.crs === 'local' && frame.source ? `, up from ${frame.source}` : ''})`, 'success', 'Products'])
    emit('progress', [1, 1, 'Done'])

    const result = {
      width: grid.width, height: grid.height, gsd: grid.gsd,
      originX: grid.originX, originY: grid.originY,
      data: grid.data, mask: grid.mask, zMin: grid.zMin, zMax: grid.zMax,
      count: grid.count, filled: grid.filled, holesFilled: grid.holesFilled,
      frame: frameDescriptor(frame, frameSpec), crs: frame.crs, unit: frame.unit,
      previewBlob, ...(settings.style && { style: settings.style }),
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
  // The ortho is computed block by block (core/products/ortho.js orthorectifyTiled)
  // and each block goes straight into a Cloud-Optimized GeoTIFF (core/products/
  // geotiff.js createCogBuilder), so no full-resolution plane exists anywhere: the
  // ortho's grid can be far finer than its ≤ 4,096 surface. The stored COG is the
  // ortho — the viewer and the map draw its tiles, exports copy or stream it.
  async function generateOrtho([input], { emit }) {
    const { surface, maps, streamed = false, settings = {} } = input
    const built = buildSurfaceGrid(surface, emit)
    const { frame, label } = built
    const unit = frameUnitName(frame.unit)
    // The ortho's own GSD is independent of the surface's: a coarse surface is
    // plenty for reprojection while the ortho wants image resolution. Its heights are
    // sampled from the surface per block, never resampled into a full-size copy.
    const want = settings.gsd > 0 ? settings.gsd : 0
    let geom = resampledGeometry(built.grid, want, MAX_ORTHO_SIDE)
    // The stored COG is a classic TIFF, whose 32-bit offsets hold 4 GiB. A grid whose
    // uncompressed tiles could exceed that is coarsened, never silently (BigTIFF would
    // lift it).
    for (let raw; (raw = cogRawBytes({ ...geom, tileSize: ORTHO_TILE, bytesPerPixel: 4 })) > TIFF_LIMIT;) {
      geom = resampledGeometry(built.grid, geom.gsd * Math.sqrt(raw / TIFF_LIMIT) * 1.01, MAX_ORTHO_SIDE)
    }
    if (!geom.identity) {
      emit('log', [`Ortho: ${geom.width.toLocaleString()}×${geom.height.toLocaleString()} @ ${geom.gsd.toPrecision(3)} ${unit}/px `
        + `over the ${label} surface (${built.grid.width}×${built.grid.height} @ ${built.grid.gsd.toPrecision(3)} ${unit}/px)`, 'info', 'Products'])
    }
    if (want > 0 && geom.gsd > want * (1 + 1e-6)) {
      const side = Math.ceil(Math.max(geom.width, geom.height) * geom.gsd / want)
      emit('log', [`Ortho: the requested ${want.toPrecision(3)} ${unit}/px would need ~${side.toLocaleString()} px on the long side; `
        + `an orthophoto is stored as a GeoTIFF of at most 4 GiB, so this one is ${geom.gsd.toPrecision(3)} ${unit}/px. `
        + 'Limit the area (Tools ▸ Model ▸ Region, then rebuild the surface) for a finer GSD.', 'warn', 'Products'])
    }

    // Preflight. Resident at once: one block's working planes, the COG's accumulated
    // overview level and preview, and at least one map with its decoded photo. What
    // the budget leaves after the first two is the map/photo cache.
    const { width, height } = geom
    const blockBytes = orthoTiledWorkingBytes({ width, height, blend: settings.blend, fillRadius: settings.fillRadius ?? 2,
      seamWidth: settings.seamWidth ?? 0 })
    const pyramidBytes = Math.ceil(width / 8) * Math.ceil(height / 8) * 4 + 2048 * 2048 * 4
    // A map's planes are 23 B/px (depth, cost, rgb, normals).
    const photoOf = new Map((input.images ?? []).map((im) => [im.uuid, im]))
    const maxEntry = maps.reduce((n, m) => Math.max(n, m.width * m.height * 23 + photoBytesBound(photoOf.get(m.uuid))), 0)
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : Infinity
    const fixed = blockBytes + pyramidBytes
    if (fixed + maxEntry > budget) {
      throw new Error(`the orthophoto needs ~${formatBytes(fixed + maxEntry)} at once (one ${ORTHO_BLOCK}² block `
        + `${formatBytes(blockBytes)}, overviews ${formatBytes(pyramidBytes)}, one depth map + photo ${formatBytes(maxEntry)}) `
        + `and the memory budget is ${formatBytes(budget)} — raise it in Settings ▸ Compute, or build at a coarser GSD`)
    }
    const cacheBytes = Number.isFinite(budget) ? budget - fixed : 2 * 1024 ** 3

    const t0 = performance.now()
    const tags = crsTagInfo({ crs: frame.crs, unit: frame.unit })
    const builder = createCogBuilder({
      width, height, tileSize: ORTHO_TILE, ArrayType: Uint8ClampedArray,
      samples: [0, 1, 2, 3].map(() => ({ bits: 8, format: 1 })),
      photometric: 2, extraSamples: [2], // RGB + unassociated alpha (transparent = no colour)
      pixelScale: [geom.gsd, geom.gsd, 0], tiepoint: [0, 0, 0, geom.originX, geom.originY, 0],
      geoKeys: geoKeysForEpsg(tags.code, tags.geographic),
    }, { blockSize: ORTHO_BLOCK, compress: deflateTile, previewMaxDim: PREVIEW_MAX })

    // Each map's planes and source photo are cached across the blocks that see it.
    const loadMap = streamed ? (i) => readDepthFiles(maps[i]) : async (i) => maps[i]
    const loadImage = makePhotoLoader(input.images, rasterize, emit)
    // The mosaic's gain fit reads every photo once more, coarse (a gain needs means,
    // not detail); its own loader keeps the decode figures below about the colour pass.
    const loadStatsImage = settings.blend === 'mosaic' && settings.colourBalance
      ? makePhotoLoader(input.images, rasterize, emit) : null
    emit('progress', [0, 1, 'Orthorectifying…'])
    const res = await orthorectifyTiled(built.grid, geom, maps, loadMap, frame.toSfm,
      { ...settings, blockSize: ORTHO_BLOCK, cacheBytes, mapsResident: !streamed }, {
        loadImage, loadStatsImage,
        onProgress: (done, total) => emit('progress', [done, total, 'Orthorectifying…', 0.95 * done / total]),
        onBlock: (b) => builder.addBlock({ col0: b.col0, row0: b.row0, width: b.width, height: b.height, data: b.rgba }),
      })
    emit('progress', [1, 1, 'Writing the GeoTIFF…', 0.96])
    const { parts, preview } = await builder.finish()
    const cog = new Blob(parts, { type: 'image/tiff' })
    const previewBlob = await rasterToPng(new ImageData(preview.data, preview.width, preview.height), preview.width, preview.height)

    const { covered, sampled, filled, surfaceCells, stats } = res
    if (loadImage) {
      const meanScale = loadImage.decoded ? loadImage.scaleSum / loadImage.decoded : 0
      emit('log', [`Ortho: colour from the source photos, decoded at `
        + `${(100 * meanScale).toFixed(0)}% of native on average (≈ 2 photo px per ortho cell, at most native)`
        + `${loadImage.fellBack ? `, ${loadImage.fellBack} from depth-map colour (photo unavailable)` : ''}`, 'info', 'Products'])
    }
    const blocksX = Math.ceil(width / ORTHO_BLOCK), blocksY = Math.ceil(height / ORTHO_BLOCK)
    emit('log', [`Ortho: ${res.blocks} block(s) of ${ORTHO_BLOCK}² (${blocksX}×${blocksY}), ${res.visits} map visit(s) `
      + `after culling (of ${res.blocks * maps.length}); ${res.mapLoads} map read(s), ${res.photoLoads} photo decode(s), `
      + `${res.cacheHits} cache hit(s) in a ${Number.isFinite(cacheBytes) ? formatBytes(cacheBytes) : 'default'} cache`, 'info', 'Products'])
    const cells = width * height
    emit('log', [`Ortho: ${width}×${height}, ${covered}/${cells} cells coloured `
      + `(${(100 * covered / cells).toFixed(0)}%) from ${maps.length} view(s) over the `
      + `${label} surface (${surfaceCells}/${cells} cells had a height) `
      + `— ${sampled} sampled + ${filled} interpolated; GeoTIFF ${formatBytes(cog.size)} `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'success', 'Products'])
    // The ortho's quality figures travel with it (its run record): sharpness, and
    // with a source label per cell, how visible the seams between images are.
    if (res.mosaic) {
      const { seamCells, smoothPasses, balance } = res.mosaic
      const seams = seamCells
        ? `feathered over ${seamCells} cell(s) (${settings.seamWidth}% of the short side${seamCells === MAX_SEAM_CELLS ? ', capped' : ''})`
        : 'hard (no feathering)'
      emit('log', [`Ortho: mosaic — each cell from its most nadir view (finest foreshortened footprint), `
        + `labels smoothed by ${smoothPasses} majority pass(es); seams ${seams}`, 'info', 'Products'])
      if (balance) {
        const f = (v) => (v == null ? '—' : v.toFixed(3))
        const decode = loadStatsImage?.decoded
          ? `; photos decoded at ${(100 * loadStatsImage.scaleSum / loadStatsImage.decoded).toFixed(0)}% of native for the fit` : ''
        emit('log', [`Ortho: colour balance — gains for ${balance.images} of ${maps.length} image(s) from `
          + `${balance.pairs} overlapping pair(s) over ${balance.latticeCells.toLocaleString()} lattice cells (every `
          + `${balance.latticeStep}th; ${balance.clippedObservations.toLocaleString()} clipped sample(s) left out); gain min ${f(balance.min)} / median ${f(balance.median)} / max ${f(balance.max)}`
          + (balance.clamped ? `, ${balance.clamped} channel gain(s) clamped to 0.5–2` : '') + decode,
        balance.clamped ? 'warn' : 'info', 'Products'])
        if (res.gains) {
          const name = (m) => photoOf.get(m.uuid)?.name ?? m.uuid
          const list = maps.map((m, i) => `${name(m)} ${[0, 1, 2].map((c) => res.gains[3 * i + c].toFixed(3)).join('/')}`)
          emit('log', [`Ortho: gains per image (R/G/B): ${list.join(', ')}`, 'debug', 'Products'])
        }
      }
    }
    emit('log', [`Ortho: ${describeOrthoStats(stats)}`, 'info', 'Products'])
    emit('progress', [1, 1, 'Done'])

    return {
      // The geotransform travels WITH the ortho: its grid no longer has to be the
      // DEM's, so the exporters/viewer must read it here, not off the DEM. Its frame is
      // the SURFACE's frame, whatever the GSD (a resampled grid used to drop it).
      result: {
        width, height, covered, sampled, filled, previewBlob, cog, tileSize: ORTHO_TILE,
        gsd: geom.gsd, originX: geom.originX, originY: geom.originY,
        surface: label, surfaceCells,
        frame: built.grid.frame, crs: frame.crs, unit: frame.unit, stats,
        // How the pixels were chosen: the blend, and for a mosaic its seam band and gains.
        blend: settings.blend ?? 'best', mosaic: res.mosaic ?? null,
      },
    }
  }

  // Tools ▸ Products ▾ — derived outputs of an existing DEM/ortho, all of which end
  // as a download (nothing here changes a stored product).
  //   contours: { grid, settings, format:'geojson'|'dxf', crs } → { text, lines, levels }
  //   terrain:  { grid, settings } → { rasters: { slope?, aspect?, hillshade? } }
  //   clip:     { kind:'dem', grid, polygons } | { kind:'ortho', cog, geo, polygons } → { raster }
  // A DEM plane arrives as a COPY (transferred), so nothing is round-tripped; an
  // ortho's COG File arrives as a handle and only the clip's window is read.
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
      // An ortho is a file: read only the window the polygons can touch, then clip that
      // sub-raster (rasterClip.js polygonPixelWindow — the same result as the whole plane).
      let ortho = null
      if (input.kind === 'ortho') {
        const { geo, cog } = input
        const win = polygonPixelWindow(geo, input.polygons)
        if (!win) { log('Clip ortho: the polygon(s) do not overlap the orthophoto', 'warn', 'Products'); return { result: { raster: null } } }
        if (win.width * win.height > MAX_CLIP_CELLS) {
          throw new Error(`the polygon(s) span ${win.width.toLocaleString()}×${win.height.toLocaleString()} px of the orthophoto; `
            + `a clip holds at most ${MAX_CLIP_CELLS.toLocaleString()} px — clip a smaller area, or export the COG and clip it in a GIS`)
        }
        const image = await openRaster(cog)
        const data = await readWindowBytes(image, win.col0, win.row0, win.col0 + win.width, win.row0 + win.height)
        ortho = { ...windowGeometry(geo, win), data }
      }
      const raster = input.kind === 'ortho'
        ? clipOrtho(ortho, input.polygons, { onLog: log })
        : clipDem(input.grid, input.polygons, { onLog: log })
      const transfer = raster ? [raster.data.buffer, ...(raster.mask ? [raster.mask.buffer] : [])] : []
      return { result: { raster }, transfer }
    }
    throw new Error(`unknown raster tool "${tool}"`)
  }

  return { generateDem, generateOrtho, demTool, demPreview }
}
