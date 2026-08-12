import { hillshadeRgba } from '../../core/products/colormap.js'
import { rasterToDataUrl } from '../rasterPreview.js'
import { buildLocalFrame, makeFrame } from '../../core/products/projection.js'
import { frameFromSimilarity } from '../../core/products/georef.js'
import { rasterizeDem } from '../../core/products/dem.js'
import { orthorectify } from '../../core/products/ortho.js'
import { meshSurface, planeSurface, resampleSurface } from '../../core/products/surface.js'

// Product ops (DEM + orthophoto). The frame rebuild/descriptor + raster→dataURL
// canvas helpers live here next to the two handlers; pure compute is in
// core/products/*. No injected worker helpers (products don't rasterise sources).
export function makeProductsOps() {
  // Rebuild a projection frame from a serialisable descriptor (frames carry
  // closures, so they can't cross postMessage — the store sends a spec, the worker
  // resolves it). 'local' is derived from the scene; 'similarity' from a fit.
  function rebuildFrame(spec, cameras, points) {
    if (spec?.kind === 'similarity') {
      return frameFromSimilarity({ scale: spec.scale, R: spec.R, t: spec.t }, spec.crs)
    }
    if (spec && spec.origin && spec.east) {
      // A fully-resolved local descriptor (re-used by the ortho pass).
      return makeFrame(spec)
    }
    return buildLocalFrame(cameras.values(), points)
  }

  // A serialisable snapshot of a frame (basis + metadata) so the DEM result can
  // carry the exact frame its grid was built in, for the ortho pass to reuse.
  function frameDescriptor(frame, spec) {
    if (spec?.kind === 'similarity') return { kind: 'similarity', scale: spec.scale, R: spec.R, t: spec.t, crs: spec.crs }
    return {
      kind: 'local', origin: frame.origin, east: frame.east, north: frame.north, up: frame.up,
      crs: frame.crs, unit: frame.unit, source: frame.source,
    }
  }

  // Colourise + hillshade a DEM height grid to a PNG data URL for the preview.
  // The pixel math is shared with the imported reference-DEM preview
  // (core/products/colormap.js `hillshadeRgba`) so the two look identical.
  async function demToDataUrl(grid) {
    return rasterToDataUrl(hillshadeRgba(grid), grid.width, grid.height)
  }

  // Build a DEM: transform the (dense) points into the chosen frame, rasterise a
  // height grid, and bake a hillshaded preview. Pure compute lives in
  // core/{projection,georef,dem}.js. Returns the grid (+ its frame descriptor so
  // the ortho pass reuses the exact same frame).
  async function generateDem([input], { emit }) {
    const { points, cameras = [], frame: frameSpec, settings = {} } = input
    const camMap = new Map(cameras.map((c) => [c.uuid, { R: c.R, t: c.t, K: c.K }]))
    emit('progress', [0, 1, 'Projecting points…'])
    const frame = rebuildFrame(frameSpec, camMap, points)

    // Project every point into the frame (z = height).
    const framed = new Array(points.length)
    for (let i = 0; i < points.length; i++) {
      const [x, y, z] = frame.fromSfm(points[i])
      framed[i] = { x, y, z }
    }

    emit('progress', [0, 1, 'Rasterising grid…'])
    const grid = rasterizeDem(framed, settings)
    if (!grid) throw new Error('DEM: could not rasterise (need a denser cloud or a smaller GSD)')

    const previewDataUrl = await demToDataUrl(grid)
    const unitLabel = frame.unit === 'm' ? 'm' : 'model units'
    emit('log', [`DEM: ${grid.width}×${grid.height} @ ${grid.gsd.toPrecision(3)} ${unitLabel}/px, `
      + `z ${grid.zMin.toPrecision(4)}–${grid.zMax.toPrecision(4)}, `
      + `${grid.count} measured + ${grid.filled} filled cells (${frame.crs})`, 'success', 'Products'])
    emit('progress', [1, 1, 'Done'])

    const result = {
      width: grid.width, height: grid.height, gsd: grid.gsd,
      originX: grid.originX, originY: grid.originY,
      data: grid.data, mask: grid.mask, zMin: grid.zMin, zMax: grid.zMax,
      count: grid.count, filled: grid.filled,
      frame: frameDescriptor(frame, frameSpec), crs: frame.crs, unit: frame.unit,
      previewDataUrl,
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
      const framed = new Float32Array(surface.pos.length)
      for (let i = 0; i < n; i++) {
        const [x, y, z] = frame.fromSfm([surface.pos[i * 3], surface.pos[i * 3 + 1], surface.pos[i * 3 + 2]])
        framed[i * 3] = x; framed[i * 3 + 1] = y; framed[i * 3 + 2] = z
      }
      const grid = meshSurface({ pos: framed, idx: surface.idx }, surface.settings ?? {},
        (done, total) => emit('progress', [done, total, 'Rasterising mesh surface…']))
      if (!grid) throw new Error('Ortho: the mesh has no triangles to rasterise')
      emit('log', [`Ortho: mesh surface ${grid.width}×${grid.height} @ `
        + `${grid.gsd.toPrecision(3)} ${frame.unit === 'm' ? 'm' : 'units'}/px from `
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
      const grid = planeSurface(framed, surface.settings ?? {})
      if (!grid) throw new Error('Ortho: could not fit a plane (need ≥3 spread points)')
      const p = grid.plane
      emit('log', [`Ortho: plane surface ${grid.width}×${grid.height} @ `
        + `${grid.gsd.toPrecision(3)} ${frame.unit === 'm' ? 'm' : 'units'}/px — `
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
    const { surface, maps, settings = {} } = input
    const built = buildSurfaceGrid(surface, emit)
    const { frame, label } = built
    // The ortho's own GSD is independent of the surface's: a coarse surface is
    // plenty for reprojection while the ortho wants image resolution.
    const grid = settings.gsd > 0 ? resampleSurface(built.grid, settings.gsd) : built.grid
    if (grid !== built.grid) {
      emit('log', [`Ortho: resampled the ${label} surface to ${grid.width}×${grid.height} @ `
        + `${grid.gsd.toPrecision(3)} ${frame.unit === 'm' ? 'm' : 'units'}/px`, 'info', 'Products'])
    }

    emit('progress', [0, grid.height, 'Orthorectifying…'])
    const t0 = performance.now()
    const { width, height, rgba, covered, sampled, filled } = orthorectify(grid, maps, frame.toSfm, settings,
      (done, total) => emit('progress', [done, total, 'Orthorectifying…']))

    const previewDataUrl = await rasterToDataUrl(new ImageData(rgba, width, height), width, height)
    const cells = width * height
    emit('log', [`Ortho: ${width}×${height}, ${covered}/${cells} cells coloured `
      + `(${(100 * covered / cells).toFixed(0)}%) from ${maps.length} view(s) over the `
      + `${label} surface (${grid.count}/${cells} cells had a height) `
      + `— ${sampled} sampled + ${filled} interpolated `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'success', 'Products'])
    emit('progress', [height, height, 'Done'])

    const rgbaBuf = new Uint8Array(rgba.buffer)
    return {
      // The geotransform travels WITH the ortho: its grid no longer has to be the
      // DEM's, so the exporters/viewer must read it here, not off the DEM.
      result: {
        width, height, rgba: rgbaBuf, covered, sampled, filled, previewDataUrl,
        gsd: grid.gsd, originX: grid.originX, originY: grid.originY,
        surface: label, surfaceCells: grid.count,
        frame: grid.frame, crs: frame.crs, unit: frame.unit,
      },
      transfer: [rgbaBuf.buffer],
    }
  }

  return { generateDem, generateOrtho }
}
