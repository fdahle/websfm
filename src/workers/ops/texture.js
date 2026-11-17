import {
  textureBegin,
  textureLayout,
  textureFinish,
  gainObservations,
  gainSampleView,
} from '../../core/products/texture/texture.js'
import { faceCandidatesPart, mergeCandidateParts, meshGeometry } from '../../core/products/texture/visibility.js'
import { bakeViews, pieceBlocks, pasteBlocks } from '../../core/products/texture/bake.js'
import { makeSampleMap } from '../../core/sfm/displayFrame.js'
import { fisheyeCanvas, sampleRgbaBilinear } from '../../core/products/undistort.js'
import { hasDistortion } from '../../core/sfm/distortion.js'
import { fromScaledPx } from '../../core/sfm/geometry.js'
import { buildMaskLookup } from '../../utils/maskCanvas.js'
import { TEXTURE_TUNING } from '../../core/tuning.js'
import { TEXTURE_DEFAULTS } from '../../core/defaults.user.js'
import { projectVertices, rasterizeDepth } from '../../core/products/texture/visibility.js'
import { createTextureDepthGpu, compareDepth } from '../gpu/textureDepthGpu.js'
import { formatBytes } from '../../core/dense/memBudget.js'

// GPU vs CPU depth on the first view the mesh covers enough of to judge
// (TEXTURE_TUNING says how it is judged).
const { gpuAgreeMin: GPU_AGREE_MIN, gpuCheckCoverage: GPU_CHECK_COVERAGE } = TEXTURE_TUNING

// Mesh texture ops (plan-texture T2). The core (core/products/texture/) is pure; this
// worker side supplies what needs the browser: each photo decoded at the scale the
// texels need (`rasterize`, injected), the pinhole → photo map of its lens and film
// frame, the usable-pixel LUT of each view's z-buffer grid (on the photo, not masked),
// and the JPEG encoding of the finished pages.
//
// A run is split over the pool (stores/reconstruction/meshTexture.js): one worker holds
// the run (textureBegin, textureLayout, textureBakeAdd, textureFinish, in a session),
// while the visibility (textureVisibility) and the bake (textureBake) go to every worker
// in shares of the views. Each per-view step is independent, and both are mostly photo
// work (decodes, lens maps), so the shares run side by side.
//
// views: [{ uuid, name, url, R, t, K, width, height, dist, selfCal, fiducial, mask, exposure, weight? }]
//   K — the camera's full-resolution pinhole K; width/height — the photo in scan pixels
//   (a film scan's pinhole frame is its canonical frame, fiducial.frame).
export function makeTextureOps({ rasterize } = {}) {
  // runId → the run between its steps, on the worker that began it.
  const sessions = new Map()
  // The run, its log and progress now going to this request's `emit`.
  const sessionOf = (runId, emit) => {
    const r = sessions.get(runId)
    if (!r) throw new Error('Texture: the run was lost (the worker restarted); run it again')
    if (emit) bindRun(r, emit)
    return r
  }

  // { runId, mesh, views, settings } → { pos, idx, maxPages, shares }: the run begun (an
  // open mesh welded), the mesh the shares work on, and how many shares the memory
  // budget gives room for (at most settings.shares).
  async function textureBeginOp([input], { emit }) {
    const { runId, mesh, views, settings = {} } = input
    const log = (m, level = 'info') => emit('log', [m, level, 'Products'])
    const budget = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : 0
    let maxPages = settings.maxPages ?? TEXTURE_DEFAULTS.maxPages
    const pageSize = settings.pageSize ?? TEXTURE_DEFAULTS.pageSize
    const photo = Math.max(...views.map((v) => v.width * v.height)) * 4
    const meshBytes = mesh.pos.length * 8 * 3 + mesh.idx.length * 4 * 12
    // Memory: the pages are the big allocation (RGBA, pageSize² × 4 each), on this worker
    // next to one decoded photo and the mesh. Cap the page count to what the budget leaves.
    if (budget) {
      const fit = Math.floor((budget - photo - meshBytes) / (pageSize * pageSize * 4))
      if (fit < 1) {
        throw new Error(
          `Texture needs at least ${formatBytes(photo + meshBytes + pageSize * pageSize * 4)} ` +
            `but the memory budget is ${formatBytes(budget)}; decimate the mesh, use smaller pages or raise the budget`,
        )
      }
      if (fit < maxPages) {
        log(
          `Texture: at most ${fit} page${fit === 1 ? '' : 's'} of ${pageSize} px fit the memory budget ` +
            `(${formatBytes(budget)}), not ${maxPages}`,
          'warn',
        )
        maxPages = fit
      }
    }
    const run = textureBegin(mesh, coreViewsOf(views), { ...settings, maxPages }, { onLog: log })
    bindRun(run, emit)
    run.t0 = performance.now()
    run.settings = settings
    sessions.set(runId, run)
    // Each share holds the mesh, its geometry and candidates, a z-buffer and one decoded
    // photo; the pages stay here.
    const F = run.geom.nFaces
    const K = run.o.maxCandidates
    const perShare =
      meshBytes + F * (2 + 10 * K + 48) + run.o.bufferSide ** 2 * 24 + 2 * photo + run.mesh.pos.length * 12
    const want = Math.max(1, settings.shares ?? 1)
    const shares = budget
      ? Math.max(1, Math.min(want, Math.floor((budget - maxPages * pageSize * pageSize * 4) / perShare)))
      : want
    const pos = run.mesh.pos.slice(),
      idx = run.mesh.idx.slice()
    return { result: { pos, idx, maxPages, shares, perShare }, transfer: [pos.buffer, idx.buffer] }
  }

  // { pos, idx, views, settings, viewList } → { part (faceCandidatesPart), gpu }: the
  // visibility of a share of the views. The GPU check runs in every share; `gpu` says
  // how it went, for one log line.
  async function textureVisibilityOp([input], { emit }) {
    const { pos, idx, views, settings = {}, viewList } = input
    const log = (m, level = 'info') => emit('log', [m, level, 'Products'])
    const hooks = viewHooks(views, settings, rasterize, log, { quietGpu: true })
    const o = { ...TEXTURE_TUNING, ...TEXTURE_DEFAULTS, ...settings }
    try {
      const part = await faceCandidatesPart(meshGeometry(pos, idx), idx, coreViewsOf(views), viewList, o, {
        validLut: hooks.validLut,
        renderDepth: hooks.renderDepth,
        viewImage: o.photoConsistency ? hooks.viewImage : undefined,
        onProgress: (d, t) => emit('progress', [d, t]),
      })
      return { result: { part, gpu: hooks.gpuStatus() }, transfer: partBuffers(part) }
    } finally {
      hooks.destroy()
    }
  }

  // { runId, parts } (in view order) → { layout, entries, sampling }: candidates merged,
  // views chosen, charts packed; the pages allocated here.
  async function textureLayoutOp([input], { emit }) {
    const run = sessionOf(input.runId, emit)
    const cand = mergeCandidateParts(input.parts, run.views.length, run.o)
    const { layout, entries, sampling } = textureLayout(run, cand)
    run.pages = layout.pageHeights.map((h) => new Uint8ClampedArray(layout.pageSize * h * 4))
    return { result: { layout, entries, sampling } }
  }

  // { pos, idx, views, settings, layout, entries, sampling } → { list, data, decoded,
  // failed, obs }: a share of the photos baked into its own blocks (pieceBlocks, pieces in
  // `list` order), with its colour-levelling samples.
  async function textureBakeOp([input], { emit }) {
    const { pos, idx, views, settings = {}, layout, entries, sampling } = input
    const log = (m, level = 'info') => emit('log', [m, level, 'Products'])
    const hooks = viewHooks(views, settings, rasterize, log)
    const core = coreViewsOf(views)
    const geom = sampling ? meshGeometry(pos, idx) : null
    const obs = sampling ? gainObservations() : null
    const blocks = pieceBlocks(layout, entries)
    const o = { ...TEXTURE_TUNING, ...TEXTURE_DEFAULTS, ...settings }
    const { decoded, failed } = await bakeViews(
      layout,
      entries,
      blocks.target,
      {
        loadPhoto: hooks.loadPhoto,
        onPhoto: obs
          ? (vi, photo) => gainSampleView(sampling, geom, idx, core, vi, photo, layout.scale, obs)
          : undefined,
        onProgress: (d, t) => emit('progress', [d, t]),
      },
      o.grayFallback,
    )
    const list = Int32Array.from(entries.flatMap(([, l]) => l))
    const o2 = obs?.done() ?? null
    const transfer = [blocks.data.buffer, list.buffer]
    if (o2) transfer.push(o2.pt.buffer, o2.img.buffer, o2.rgb.buffer)
    return { result: { list, data: blocks.data, decoded, failed, obs: o2 }, transfer }
  }

  // { runId, list, data } → a bake share's blocks pasted onto the pages.
  async function textureBakeAddOp([input]) {
    const run = sessionOf(input.runId)
    pasteBlocks(run.layout, run.pages, input.list, input.data)
    return { result: true }
  }

  // { runId, decoded, failed, obs } → the textured mesh: { mesh: { pos, idx, uv, col,
  // nVerts, count }, texture: { data, pages, groups }, summary }.
  async function textureFinishOp([input], { emit }) {
    const run = sessionOf(input.runId, emit)
    sessions.delete(input.runId)
    const out = textureFinish(run, run.pages, { decoded: input.decoded, failed: input.failed, obs: input.obs ?? [] })
    run.pages = null
    // Encode the pages (JPEG) into one buffer, with each page's slice.
    const quality = run.settings.jpegQuality ?? TEXTURE_TUNING.jpegQuality
    const blobs = []
    for (const p of out.pages) {
      const canvas = new OffscreenCanvas(p.width, p.height)
      canvas.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(p.data, p.width, p.height), 0, 0)
      blobs.push(await canvas.convertToBlob({ type: 'image/jpeg', quality }))
      p.data = null
    }
    const total = blobs.reduce((a, b) => a + b.size, 0)
    const data = new Uint8Array(total)
    const pages = []
    let off = 0
    for (let i = 0; i < blobs.length; i++) {
      data.set(new Uint8Array(await blobs[i].arrayBuffer()), off)
      pages.push({
        width: out.pages[i].width,
        height: out.pages[i].height,
        offset: off,
        length: blobs[i].size,
        type: 'image/jpeg',
      })
      off += blobs[i].size
    }
    emit('log', [
      `Texture: ${out.count.toLocaleString('en')} triangles, ${out.nVerts.toLocaleString('en')} vertices, ` +
        `${pages.length} page${pages.length === 1 ? '' : 's'} (${(total / 1e6).toFixed(1)} MB JPEG) ` +
        `in ${((performance.now() - run.t0) / 1000).toFixed(1)} s`,
      'info',
      'Products',
    ])
    const result = {
      mesh: { pos: out.pos, idx: out.idx, uv: out.uv, col: out.col, nVerts: out.nVerts, count: out.count },
      texture: { data, pages, groups: out.groups },
      summary: out.summary,
    }
    const transfer = [out.pos.buffer, out.idx.buffer, out.uv.buffer, data.buffer]
    if (out.col) transfer.push(out.col.buffer)
    return { result, transfer }
  }

  // A run that failed or was given up: its session freed.
  async function textureAbortOp([runId]) {
    sessions.delete(runId)
    return { result: true }
  }

  return {
    textureBegin: textureBeginOp,
    textureVisibility: textureVisibilityOp,
    textureLayout: textureLayoutOp,
    textureBake: textureBakeOp,
    textureBakeAdd: textureBakeAddOp,
    textureFinish: textureFinishOp,
    textureAbort: textureAbortOp,
  }
}

// A run's log and progress through `emit` (the request now running on it).
function bindRun(run, emit) {
  run.log = (m, level = 'info') => emit('log', [m, level, 'Products'])
  run.progress = (f, stage) => emit('progress', [Math.round(f * 100), 100, STAGE_LABEL[stage] ?? stage, f])
}

const STAGE_LABEL = {
  visibility: 'Finding which photos see each face…',
  selection: 'Choosing a photo per face…',
  bake: 'Copying photo pixels into the atlas…',
  done: 'Encoding pages…',
}

// A share's sparse part's buffers, to transfer.
function partBuffers(part) {
  const out = []
  for (const sp of [part.main, part.fallback])
    if (sp) for (const a of [sp.face, sp.n, sp.view, sp.score, sp.colour]) if (a) out.push(a.buffer)
  out.push(part.seenBy.buffer)
  return out
}

// The pinhole window a face must lie in, per view: the photo, a film scan's canonical
// frame, or a fisheye's widened 60° canvas.
function coreViewsOf(views) {
  return views.map((v) => {
    const frame = v.fiducial?.frame
    const width = frame?.width ?? v.width,
      height = frame?.height ?? v.height
    const canvas = !frame && !hasDistortion(v.selfCal) ? fisheyeCanvas(v.K, v.dist, v.width, v.height) : null
    const rect = canvas ? { x0: -canvas.dx, y0: -canvas.dy, width: canvas.width, height: canvas.height } : undefined
    return { R: v.R, t: v.t, K: v.K, width, height, rect, weight: v.weight ?? 1, exposure: v.exposure ?? null }
  })
}

// What the core's per-view steps read from the browser, for `views`: the usable-pixel
// LUT, the photo in the z-buffer grid, the photo at the texel scale, and the z-buffer on
// the GPU. `quietGpu`: the GPU check's success is returned (gpuStatus), not logged.
function viewHooks(views, settings, rasterize, log, { quietGpu = false } = {}) {
  // A rolling-shutter photo (`rs`, RSH-4) is read on its principal row's pose too. Built
  // on first use: a share reads only its own views.
  const maps = new Map()
  const toPhotoOf = (vi) => {
    if (!maps.has(vi)) {
      const v = views[vi]
      maps.set(vi, makeSampleMap({ K: v.K, dist: v.dist, selfCal: v.selfCal, fiducial: v.fiducial, rs: v.rs ?? null }))
    }
    return maps.get(vi)
  }

  // Where each z-buffer grid pixel lands on the photo (scan pixels), once per view:
  // the usable-pixel LUT and the grid-resolution photo both read it.
  let gridMapOf = { vi: -1, px: null, py: null }
  function gridMap(vi, grid) {
    if (gridMapOf.vi === vi) return gridMapOf
    const map = toPhotoOf(vi),
      W = grid.width,
      H = grid.height
    const px = new Float32Array(W * H),
      py = new Float32Array(W * H)
    for (let gy = 0; gy < H; gy++) {
      const y = grid.y0 + fromScaledPx(gy, grid.scale)
      for (let gx = 0; gx < W; gx++) {
        const x = grid.x0 + fromScaledPx(gx, grid.scale)
        const p = map ? map(x, y) : { x, y }
        px[gy * W + gx] = p.x
        py[gy * W + gx] = p.y
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
    const v = views[vi],
      map = toPhotoOf(vi)
    const mask = settings.useMasks !== false ? v.mask : null
    if (!map && !mask) return null
    const W = grid.width,
      H = grid.height
    const gm = gridMap(vi, grid)
    let maskLut = null,
      mw = 0,
      mh = 0
    if (mask) {
      mw = Math.max(1, Math.round(v.width * grid.scale))
      mh = Math.max(1, Math.round(v.height * grid.scale))
      try {
        maskLut = await buildMaskLookup(mask, mw, mh)
      } catch (err) {
        log(`Texture: ${v.name} — mask unreadable (${err?.message ?? err}); used unmasked`, 'warn')
      }
    }
    const lut = new Uint8Array(W * H)
    for (let gy = 0; gy < H; gy++) {
      for (let gx = 0; gx < W; gx++) {
        const p = { x: gm.px[gy * W + gx], y: gm.py[gy * W + gx] }
        if (!(p.x >= -0.5 && p.y >= -0.5 && p.x <= v.width - 0.5 && p.y <= v.height - 0.5)) continue
        if (maskLut) {
          const mx = Math.min(mw - 1, Math.max(0, Math.round(((p.x + 0.5) * mw) / v.width - 0.5)))
          const my = Math.min(mh - 1, Math.max(0, Math.round(((p.y + 0.5) * mh) / v.height - 0.5)))
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
      const map = makeSampleMap({
        K: v.K,
        dist: v.dist,
        selfCal: v.selfCal,
        fiducial: v.fiducial,
        rs: v.rs ?? null,
        outScale: scale,
        srcScale: r.scaleXY ?? r.scale,
      })
      return { data: r.data, width: r.width, height: r.height, map }
    } catch (err) {
      log(`Texture: ${v.name} — photo unavailable (${err?.message ?? err})`, 'warn')
      return null
    }
  }

  // The z-buffer on the GPU when asked for and available, checked against the CPU
  // pass on the first view that covers enough to judge (workers/gpu/README ▸ Invariants).
  let gpu = null,
    gpuState = settings.useGpu ? 'pending' : 'off',
    gpuAgree = null
  async function renderDepth(vi, grid, cam, geom, idx) {
    if (gpuState === 'off') return null
    try {
      if (gpuState === 'pending') {
        let why = 'WebGPU unavailable'
        gpu = await createTextureDepthGpu(geom.P, idx, { onNull: (reason) => (why = reason) })
        if (!gpu) {
          gpuState = 'off'
          log(`Texture: ${why}, depth pass on the CPU`)
          return null
        }
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
          log(
            `Texture: the GPU pass agrees with the CPU on only ${(100 * agree).toFixed(2)} % of covered pixels; using the CPU`,
            'warn',
          )
          gpu.destroy()
          gpu = null
          gpuState = 'off'
          return cpu
        }
        gpuAgree = agree
        if (!quietGpu)
          log(`Texture: GPU validate ok — ${(100 * agree).toFixed(2)} % of covered pixels agree with the CPU pass`)
        gpuState = 'on'
      }
      return depth
    } catch (err) {
      log(`Texture: GPU depth pass failed (${err?.message ?? err}); using the CPU`, 'warn')
      gpu?.destroy()
      gpu = null
      gpuState = 'off'
      return null
    }
  }

  return {
    validLut,
    viewImage,
    loadPhoto,
    renderDepth,
    // 'off' | 'pending' (no view checked yet) | 'check' | 'on', and the agreement when on.
    gpuStatus: () => ({ state: gpuState, agree: gpuAgree }),
    destroy: () => {
      gpu?.destroy()
      gpu = null
    },
  }
}
