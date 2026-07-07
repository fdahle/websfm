import { depthColor } from '../../core/products/colormap.js'
import { buildLocalFrame, makeFrame } from '../../core/products/projection.js'
import { frameFromSimilarity } from '../../core/products/georef.js'
import { rasterizeDem } from '../../core/products/dem.js'
import { orthorectify } from '../../core/products/ortho.js'

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

  // Colourise + hillshade a DEM height grid to a PNG data URL for the preview. Uses
  // the shared depth ramp for elevation, multiplied by a simple Lambertian
  // hillshade from the height gradient. Nodata cells are transparent.
  async function demToDataUrl(grid) {
    const { width: w, height: h, data, mask, gsd, zMin, zMax } = grid
    const span = zMax > zMin ? zMax - zMin : 1
    const img = new ImageData(w, h)
    // Light from the north-west, 45° up.
    const lx = -0.7071, ly = 0.7071, lz = 1
    const at = (c, r) => (mask[r * w + c] ? data[r * w + c] : NaN)
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const o = (r * w + c) * 4
        const z = at(c, r)
        if (Number.isNaN(z)) { img.data[o + 3] = 0; continue }
        const [cr, cg, cb] = depthColor((z - zMin) / span)
        // Central-difference slope (fall back to same cell at borders/holes).
        const zl = mask[r * w + Math.max(0, c - 1)] ? data[r * w + Math.max(0, c - 1)] : z
        const zr = mask[r * w + Math.min(w - 1, c + 1)] ? data[r * w + Math.min(w - 1, c + 1)] : z
        const zt = mask[Math.max(0, r - 1) * w + c] ? data[Math.max(0, r - 1) * w + c] : z
        const zb = mask[Math.min(h - 1, r + 1) * w + c] ? data[Math.min(h - 1, r + 1) * w + c] : z
        const dzdx = (zr - zl) / (2 * gsd), dzdy = (zb - zt) / (2 * gsd)
        const nlen = Math.hypot(dzdx, dzdy, 1)
        const shade = Math.max(0.25, Math.min(1, (-dzdx * lx - dzdy * ly + lz) / (nlen * Math.hypot(lx, ly, lz))))
        img.data[o] = cr * shade; img.data[o + 1] = cg * shade; img.data[o + 2] = cb * shade; img.data[o + 3] = 255
      }
    }
    return rasterToDataUrl(img, w, h)
  }

  async function rasterToDataUrl(imageData, w, h) {
    const canvas = new OffscreenCanvas(w, h)
    canvas.getContext('2d').putImageData(imageData, 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    return await new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.readAsDataURL(blob)
    })
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

  // Build an orthophoto by reprojecting each DEM cell into the cached depth maps
  // (their depth planes double as occlusion z-buffers; their RGB planes supply the
  // colour). Pure compute lives in core/products/ortho.js.
  async function generateOrtho([input], { emit }) {
    const { dem, maps, settings = {} } = input
    emit('progress', [0, dem.height, 'Orthorectifying…'])
    const frame = rebuildFrame(dem.frame)
    const t0 = performance.now()
    const { width, height, rgba, covered } = orthorectify(dem, maps, frame.toSfm, settings,
      (done, total) => emit('progress', [done, total, 'Orthorectifying…']))

    const previewDataUrl = await rasterToDataUrl(new ImageData(rgba, width, height), width, height)
    emit('log', [`Ortho: ${width}×${height}, ${covered}/${width * height} cells coloured `
      + `(${(100 * covered / (width * height)).toFixed(0)}%) from ${maps.length} view(s) `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)}s`, 'success', 'Products'])
    emit('progress', [height, height, 'Done'])

    const rgbaBuf = new Uint8Array(rgba.buffer)
    return {
      result: { width, height, rgba: rgbaBuf, covered, previewDataUrl },
      transfer: [rgbaBuf.buffer],
    }
  }

  return { generateDem, generateOrtho }
}
