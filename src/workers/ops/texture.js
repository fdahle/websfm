import { textureMesh as runTexture } from '../../core/products/texture/texture.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import { fisheyeCanvas, sampleRgbaBilinear } from '../../core/products/undistort.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { fromScaledPx } from '../../core/sfm/geometry.js'
import { buildMaskLookup } from '../../core/mask.js'
import { TEXTURE_TUNING } from '../../core/tuning.js'
import { TEXTURE_DEFAULTS } from '../../core/defaults.user.js'
import { projectVertices, rasterizeDepth } from '../../core/products/texture/visibility.js'
import { createTextureDepthGpu, compareDepth } from '../gpu/textureDepthGpu.js'
import { formatBytes } from '../../core/dense/memBudget.js'

// GPU vs CPU depth on the first view the mesh covers enough of to judge (at least
// GPU_CHECK_COVERAGE of its grid): below GPU_AGREE_MIN of the covered pixels agreeing,
// the run falls back to the CPU pass. Rasterisers differ by a pixel along occluder
// edges, which weigh more among covered pixels than among all of them. A view that
// covers less is not judged: it takes the CPU pass, and the next view is checked.
const GPU_AGREE_MIN = 0.95
const GPU_CHECK_COVERAGE = 0.02

// Mesh texture op (plan-texture T2). The core (core/products/texture/) is pure; this
// worker side supplies what needs the browser: each photo decoded at the scale the
// texels need (`rasterize`, injected), the pinhole → photo map of its lens and film
// frame, the usable-pixel LUT of each view's z-buffer grid (on the photo, not masked),
// and the JPEG encoding of the finished pages.
//
// input.views: [{ uuid, name, url, R, t, K, width, height, dist, selfCal, fiducial, mask }]
//   K — the camera's full-resolution pinhole K; width/height — the photo in scan pixels
//   (a film scan's pinhole frame is its canonical frame, fiducial.frame).
// → { mesh: { pos, idx, uv, col, nVerts, count }, texture: { data, pages, groups }, summary }
export function makeTextureOps({ rasterize } = {}) {
  async function textureMesh([input], { emit }) {
    const { mesh, views, settings = {} } = input
    const log = (m, level = 'info') => emit('log', [m, level, 'Products'])
    const t0 = performance.now()

    // The pinhole window a face must lie in, per view: the photo, a film scan's
    // canonical frame, or a fisheye's widened 60° canvas.
    const coreViews = views.map((v) => {
      const frame = v.fiducial?.frame
      const width = frame?.width ?? v.width, height = frame?.height ?? v.height
      const canvas = !frame && !hasDistortion(v.selfCal) ? fisheyeCanvas(v.K, v.dist, v.width, v.height) : null
      const rect = canvas ? { x0: -canvas.dx, y0: -canvas.dy, width: canvas.width, height: canvas.height } : undefined
      return { R: v.R, t: v.t, K: v.K, width, height, rect, weight: v.weight ?? 1 }
    })
    const toPhoto = views.map((v) => makeSampleMap({ K: v.K, dist: v.dist, selfCal: v.selfCal, fiducial: v.fiducial }))

    // Where each z-buffer grid pixel lands on the photo (scan pixels), once per view:
    // the usable-pixel LUT and the grid-resolution photo both read it.
    let gridMapOf = { vi: -1, px: null, py: null }
    function gridMap(vi, grid) {
      if (gridMapOf.vi === vi) return gridMapOf
      const map = toPhoto[vi], W = grid.width, H = grid.height
      const px = new Float32Array(W * H), py = new Float32Array(W * H)
      for (let gy = 0; gy < H; gy++) {
        const y = grid.y0 + fromScaledPx(gy, grid.scale)
        for (let gx = 0; gx < W; gx++) {
          const x = grid.x0 + fromScaledPx(gx, grid.scale)
          const p = map ? map(x, y) : { x, y }
          px[gy * W + gx] = p.x; py[gy * W + gx] = p.y
        }
      }
      gridMapOf = { vi, px, py }
      return gridMapOf
    }

    // The photo resampled into the z-buffer grid, for the candidates' colours (photo
    // consistency, gains): decoded at about the grid's resolution, never above native.
    async function viewImage(vi, grid) {
      const v = views[vi]
      try {
        const native = Math.max(v.width, v.height)
        const r = await rasterize(v.url, Math.min(native, Math.ceil(native * grid.scale * 1.25)))
        const [sx, sy] = Array.isArray(r.scaleXY) ? r.scaleXY : [r.scale, r.scale]
        const { px, py } = gridMap(vi, grid)
        const data = new Uint8ClampedArray(grid.width * grid.height * 4)
        for (let i = 0; i < px.length; i++) {
          // Scan pixel → decoded raster pixel (centre-aligned, geometry.js toScaledPx).
          sampleRgbaBilinear(r.data, r.width, r.height, (px[i] + 0.5) * sx - 0.5, (py[i] + 0.5) * sy - 0.5, data, 4 * i)
        }
        return { data }
      } catch (err) {
        log(`Texture: ${v.name} — photo unavailable for the colour check (${err?.message ?? err})`, 'warn')
        return null
      }
    }

    // Grid pixels whose pinhole ray lands on the photo and outside its mask. Null when
    // the whole window is usable (no lens, no film frame, no mask): the common case.
    async function validLut(vi, grid) {
      const v = views[vi], map = toPhoto[vi]
      const mask = settings.useMasks !== false ? v.mask : null
      if (!map && !mask) return null
      const W = grid.width, H = grid.height
      const gm = gridMap(vi, grid)
      let maskLut = null, mw = 0, mh = 0
      if (mask) {
        mw = Math.max(1, Math.round(v.width * grid.scale)); mh = Math.max(1, Math.round(v.height * grid.scale))
        try { maskLut = await buildMaskLookup(mask, mw, mh) } catch (err) {
          log(`Texture: ${v.name} — mask unreadable (${err?.message ?? err}); used unmasked`, 'warn')
        }
      }
      const lut = new Uint8Array(W * H)
      for (let gy = 0; gy < H; gy++) {
        for (let gx = 0; gx < W; gx++) {
          const p = { x: gm.px[gy * W + gx], y: gm.py[gy * W + gx] }
          if (!(p.x >= -0.5 && p.y >= -0.5 && p.x <= v.width - 0.5 && p.y <= v.height - 0.5)) continue
          if (maskLut) {
            const mx = Math.min(mw - 1, Math.max(0, Math.round((p.x + 0.5) * mw / v.width - 0.5)))
            const my = Math.min(mh - 1, Math.max(0, Math.round((p.y + 0.5) * mh / v.height - 0.5)))
            if (maskLut[my * mw + mx]) continue
          }
          lut[gy * W + gx] = 1
        }
      }
      return lut
    }

    // The photo at ~2 photo pixels per texel (bilinear needs no more), never above
    // native, plus the texel-grid → raster map.
    async function loadPhoto(vi, scale) {
      const v = views[vi]
      try {
        const native = Math.max(v.width, v.height)
        const want = Math.min(1, 2 * scale)
        const r = await rasterize(v.url, want < 1 ? Math.ceil(native * want) : Infinity)
        const map = makeSampleMap({ K: v.K, dist: v.dist, selfCal: v.selfCal, fiducial: v.fiducial,
          outScale: scale, srcScale: r.scaleXY ?? r.scale })
        return { data: r.data, width: r.width, height: r.height, map }
      } catch (err) {
        log(`Texture: ${v.name} — photo unavailable (${err?.message ?? err})`, 'warn')
        return null
      }
    }

    // The z-buffer on the GPU when asked for and available, checked against the CPU
    // pass on the first view that covers enough to judge (workers/gpu/README ▸ Invariants).
    let gpu = null, gpuState = settings.useGpu ? 'pending' : 'off'
    async function renderDepth(vi, grid, cam, geom, idx) {
      if (gpuState === 'off') return null
      try {
        if (gpuState === 'pending') {
          gpu = await createTextureDepthGpu(geom.P, idx)
          if (!gpu) { gpuState = 'off'; log('Texture: WebGPU unavailable, depth pass on the CPU'); return null }
          gpuState = 'check'
        }
        let ext = 0
        for (let i = 0; i < geom.P.length; i++) ext = Math.max(ext, Math.abs(geom.P[i]))
        const depth = await gpu.render(cam, grid, Math.max(1e-9, ext * 1e-7))
        if (!depth) return null
        if (gpuState === 'check') {
          const cpu = rasterizeDepth(projectVertices(geom.P, cam, grid), idx, grid.width, grid.height)
          const { agree, coverage } = compareDepth(depth, cpu)
          if (coverage < GPU_CHECK_COVERAGE) return cpu // too little of the mesh in view to judge
          if (agree < GPU_AGREE_MIN) {
            log(`Texture: GPU validate failed — ${(100 * agree).toFixed(2)} % of covered pixels agree with the CPU pass; using the CPU`, 'warn')
            gpu.destroy(); gpu = null; gpuState = 'off'
            return cpu
          }
          log(`Texture: GPU validate ok — ${(100 * agree).toFixed(2)} % of covered pixels agree with the CPU pass`)
          gpuState = 'on'
        }
        return depth
      } catch (err) {
        log(`Texture: GPU depth pass failed (${err?.message ?? err}); using the CPU`, 'warn')
        gpu?.destroy(); gpu = null; gpuState = 'off'
        return null
      }
    }

    // Memory: the pages are the big allocation (RGBA, pageSize² × 4 each), next to one
    // decoded photo and the mesh. Cap the page count to what the budget leaves.
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : 0
    let maxPages = settings.maxPages ?? TEXTURE_DEFAULTS.maxPages
    if (budget) {
      const pageSize = settings.pageSize ?? TEXTURE_DEFAULTS.pageSize
      const photo = Math.max(...views.map((v) => v.width * v.height)) * 4
      const meshBytes = mesh.pos.length * 8 * 3 + mesh.idx.length * 4 * 12
      const fit = Math.floor((budget - photo - meshBytes) / (pageSize * pageSize * 4))
      if (fit < 1) {
        throw new Error(`Texture needs at least ${formatBytes(photo + meshBytes + pageSize * pageSize * 4)} `
          + `but the memory budget is ${formatBytes(budget)}; decimate the mesh, use smaller pages or raise the budget`)
      }
      if (fit < maxPages) {
        log(`Texture: at most ${fit} page${fit === 1 ? '' : 's'} of ${pageSize} px fit the memory budget `
          + `(${formatBytes(budget)}), not ${maxPages}`, 'warn')
        maxPages = fit
      }
    }

    const stageLabel = { visibility: 'Finding which photos see each face…', selection: 'Choosing a photo per face…',
      bake: 'Copying photo pixels into the atlas…', done: 'Encoding pages…' }
    let out
    try {
      out = await runTexture(mesh, coreViews, { ...settings, maxPages }, {
        validLut, loadPhoto, renderDepth, viewImage,
      onLog: log,
        onProgress: (f, stage) => emit('progress', [Math.round(f * 100), 100, stageLabel[stage] ?? stage, f]),
      })
    } finally {
      gpu?.destroy()
    }

    // Encode the pages (JPEG) into one buffer, with each page's slice.
    const quality = settings.jpegQuality ?? TEXTURE_TUNING.jpegQuality
    const blobs = []
    for (const p of out.pages) {
      const canvas = new OffscreenCanvas(p.width, p.height)
      canvas.getContext('2d').putImageData(new ImageData(p.data, p.width, p.height), 0, 0)
      blobs.push(await canvas.convertToBlob({ type: 'image/jpeg', quality }))
      p.data = null
    }
    const total = blobs.reduce((a, b) => a + b.size, 0)
    const data = new Uint8Array(total)
    const pages = []
    let off = 0
    for (let i = 0; i < blobs.length; i++) {
      data.set(new Uint8Array(await blobs[i].arrayBuffer()), off)
      pages.push({ width: out.pages[i].width, height: out.pages[i].height, offset: off, length: blobs[i].size, type: 'image/jpeg' })
      off += blobs[i].size
    }
    log(`Texture: ${out.count.toLocaleString()} triangles, ${out.nVerts.toLocaleString()} vertices, `
      + `${pages.length} page${pages.length === 1 ? '' : 's'} (${(total / 1e6).toFixed(1)} MB JPEG) `
      + `in ${((performance.now() - t0) / 1000).toFixed(1)} s`, 'success')

    const result = {
      mesh: { pos: out.pos, idx: out.idx, uv: out.uv, col: out.col, nVerts: out.nVerts, count: out.count },
      texture: { data, pages, groups: out.groups },
      summary: out.summary,
    }
    const transfer = [out.pos.buffer, out.idx.buffer, out.uv.buffer, data.buffer]
    if (out.col) transfer.push(out.col.buffer)
    return { result, transfer }
  }

  return { textureMesh }
}
