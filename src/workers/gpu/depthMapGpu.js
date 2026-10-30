// WebGPU depth-map backend. Drop-in alternative to core/sfm/reconstruction.js's
// `computeDepthMap` (same args; returns { depth, cost, width, height, normals }),
// so the worker can pick GPU vs WASM per run with zero changes elsewhere.
//
// PHASE 2b: full multi-source PatchMatch (init → red-black sweeps → refine) with
// best-K cost aggregation, via patchmatch.wgsl. Sources are packed into one
// texture_2d_array (each in its own layer; valid (w,h) ≤ the common maxW×maxH) plus
// a per-source pose storage buffer. `normals` is returned so depthMapForImage can
// A/B the final cost against the CPU reference at the GPU's own (depth, normal).

import { ensureDevice } from './device.js'
import { refineScale } from '../../core/dense/refineSchedule.js'
import { DENSE_TUNING } from '../../core/tuning.js'

// Learned GPU speed per device and kind of pass (ms per workgroup row: 8 image rows),
// so every map after the first starts its bands at the right size.
const rowCost = new WeakMap() // GPUDevice → Map(mode → ms per workgroup row)
import shaderSrc from './patchmatch.wgsl?raw'

const pipelineCache = new WeakMap()

function getPipeline(device) {
  let cached = pipelineCache.get(device)
  if (cached) return cached
  const module = device.createShaderModule({ code: shaderSrc })
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
  cached = { pipeline, sampler }
  pipelineCache.set(device, cached)
  return cached
}

function uploadGray(device, gray, w, h) {
  const tex = device.createTexture({
    size: [w, h],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture({ texture: tex }, gray, { bytesPerRow: w, rowsPerImage: h }, { width: w, height: h })
  return tex
}

// Pack one Src struct (96 bytes, std430) at byte offset `o` of DataView `dv`.
function writeSrc(dv, o, s) {
  dv.setUint32(o + 0, s.w, true)
  dv.setUint32(o + 4, s.h, true)
  dv.setFloat32(o + 16, s.K.fx, true)
  dv.setFloat32(o + 20, s.K.fy, true)
  dv.setFloat32(o + 24, s.K.cx, true)
  dv.setFloat32(o + 28, s.K.cy, true)
  const R = s.R,
    t = s.t
  dv.setFloat32(o + 32, R[0][0], true)
  dv.setFloat32(o + 36, R[0][1], true)
  dv.setFloat32(o + 40, R[0][2], true)
  dv.setFloat32(o + 48, R[1][0], true)
  dv.setFloat32(o + 52, R[1][1], true)
  dv.setFloat32(o + 56, R[1][2], true)
  dv.setFloat32(o + 64, R[2][0], true)
  dv.setFloat32(o + 68, R[2][1], true)
  dv.setFloat32(o + 72, R[2][2], true)
  dv.setFloat32(o + 80, t[0], true)
  dv.setFloat32(o + 84, t[1], true)
  dv.setFloat32(o + 88, t[2], true)
}

export async function computeDepthMapGPU(refGray, refW, refH, refK, sources, opts = {}) {
  const state = await ensureDevice()
  if (!state) return null
  const { device } = state
  const npix = refW * refH
  if (npix === 0 || !sources.length) return null

  const {
    depthMin = 0,
    depthMax = 0,
    seedDepth = null,
    window = 3,
    iterations = 3,
    bestK = 3,
    seed = 1,
    perturbStart = 1,
    // Bilateral-weighted NCC (mvs.rs Bilateral): σs px, σc grey levels; σc ≤ 0 = off.
    sigmaSpatial = 0,
    sigmaColor = 0,
    // 'acmh': adaptive checkerboard sampling + multi-hypothesis joint view selection
    // (patchmatch.wgsl acmhSweep); else best-K. PROTOTYPE, GPU only.
    viewSelection = 'bestk',
    // Step between window samples (mvs.rs Patch): 1 = every pixel, 2 = every other one.
    windowStep = 1,
    // A prior-assisted pass (mvs.rs prior_cost): the previous pass's normals and the ACMP
    // planar prior (4 per pixel: depth, normal) with its α, γ, σ_d, σ_n (radians).
    seedNormals = null,
    prior = null,
    priorAlpha = 0.18,
    priorGamma = 0.5,
    priorSigD = 1,
    priorSigN = 0.087,
    // The geometric pass (mvs.rs Geom): per source its first-pass depth plane (srcDepth[k],
    // its w×h), the term's weight and cap (px).
    srcDepth = null,
    geomWeight = 0,
    geomMax = 5,
  } = opts
  const acmh = viewSelection === 'acmh'
  // Mirror mvs.rs's depth-range guards (dmin ≥ 1e-4, dmax ≥ dmin·1.001) so the GPU
  // and WASM backends init PatchMatch over the same interval — a zero/degenerate
  // range would otherwise make the two diverge (and trip the A/B validation).
  const dMin = Math.max(1e-4, depthMin)
  const dMax = Math.max(depthMax, dMin * 1.001)
  const radius = Math.min(5, Math.max(1, window)) // match mvs.rs radius cap (≤11×11)
  const iters = Math.max(1, iterations)
  const hasSeed = seedDepth && seedDepth.length >= npix
  const MAX_SRC = 16
  const srcList = sources.slice(0, MAX_SRC)
  const nSrc = srcList.length
  const maxW = Math.max(...srcList.map((s) => s.w))
  const maxH = Math.max(...srcList.map((s) => s.h))

  // Pre-flight the texture dimensions (device.js raised this to the adapter max).
  // The ref and every source upload as an r8unorm texture, so any side exceeding
  // maxTextureDimension2D fails opaquely in createTexture; a clear "lower maxDim"
  // message here lets the worker fall back to WASM knowingly.
  const texCap = device.limits.maxTextureDimension2D ?? Infinity
  const maxSide = Math.max(refW, refH, maxW, maxH)
  if (maxSide > texCap) {
    throw new Error(`image ${maxSide}px exceeds GPU texture limit ${texCap}px — lower maxDim (working resolution)`)
  }
  const { pipeline, sampler } = getPipeline(device)

  // Capture allocation/validation failures over the whole setup + first dispatch.
  // WebGPU surfaces these asynchronously (an oversized or invalid resource doesn't
  // throw at creation — it silently invalidates and later fails the readback with an
  // opaque "mapAsync was not successful"). Scoping them turns that into a specific
  // reason the worker can log before falling back to WASM. LIFO: validation pops first.
  device.pushErrorScope('out-of-memory')
  device.pushErrorScope('validation')

  const refTex = uploadGray(device, refGray, refW, refH)

  // ── Sources as a texture_2d_array: each in its own maxW×maxH layer ─────────
  const srcArrTex = device.createTexture({
    size: [maxW, maxH, nSrc],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  srcList.forEach((s, layer) => {
    device.queue.writeTexture(
      { texture: srcArrTex, origin: [0, 0, layer] },
      s.gray,
      { bytesPerRow: s.w, rowsPerImage: s.h },
      { width: s.w, height: s.h, depthOrArrayLayers: 1 },
    )
  })

  // ── Source exclusion masks (frame/fiducials), same layer layout ────────────
  // Always created (the shader binding is mandatory); layers for unmasked sources
  // stay zero. The 0/1 LUT is scaled to 0/255 so the shader's `> 0.5` test works
  // against the r8unorm-normalised texel.
  const srcMaskTex = device.createTexture({
    size: [maxW, maxH, nSrc],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  srcList.forEach((s, layer) => {
    if (!s.mask) return
    const bytes = new Uint8Array(s.w * s.h)
    for (let k = 0; k < bytes.length; k++) bytes[k] = s.mask[k] ? 255 : 0
    device.queue.writeTexture(
      { texture: srcMaskTex, origin: [0, 0, layer] },
      bytes,
      { bytesPerRow: s.w, rowsPerImage: s.h },
      { width: s.w, height: s.h, depthOrArrayLayers: 1 },
    )
  })

  const bilOn = sigmaColor > 0 && sigmaSpatial > 0
  // ── Params uniform (80 bytes) ──────────────────────────────────────────────
  const hasSeedN = !!(seedNormals && seedNormals.length >= npix * 3)
  const hasPrior = !!(prior && prior.length >= npix * 4)
  const geomOn = geomWeight > 0 && Array.isArray(srcDepth) && srcDepth.length >= nSrc
  const pbuf = new ArrayBuffer(128)
  const pv = new DataView(pbuf)
  pv.setUint32(0, refW, true)
  pv.setUint32(4, refH, true)
  pv.setInt32(8, radius, true)
  pv.setUint32(12, hasSeed ? 1 : 0, true)
  pv.setFloat32(16, refK.fx, true)
  pv.setFloat32(20, refK.fy, true)
  pv.setFloat32(24, refK.cx, true)
  pv.setFloat32(28, refK.cy, true)
  pv.setFloat32(32, dMin, true)
  pv.setFloat32(36, dMax, true)
  pv.setUint32(40, seed >>> 0, true)
  pv.setUint32(44, iters, true)
  pv.setUint32(48, nSrc, true)
  pv.setUint32(52, Math.max(1, bestK), true)
  pv.setUint32(56, maxW, true)
  pv.setUint32(60, maxH, true)
  pv.setFloat32(64, bilOn ? 0.5 / (sigmaSpatial * sigmaSpatial) : 0, true)
  pv.setFloat32(68, bilOn ? 0.5 / (sigmaColor * sigmaColor) : 0, true)
  pv.setUint32(72, bilOn ? 1 : 0, true)
  pv.setUint32(76, acmh ? 1 : 0, true)
  pv.setInt32(80, Math.max(1, windowStep | 0), true)
  pv.setUint32(84, hasSeedN ? 1 : 0, true)
  pv.setUint32(88, hasPrior ? 1 : 0, true)
  pv.setFloat32(96, priorAlpha, true)
  pv.setFloat32(100, priorGamma, true)
  pv.setFloat32(104, 0.5 / Math.max(1e-30, priorSigD * priorSigD), true)
  pv.setFloat32(108, 0.5 / Math.max(1e-30, priorSigN * priorSigN), true)
  pv.setFloat32(112, geomOn ? geomWeight : 0, true)
  pv.setFloat32(116, geomMax, true)
  const paramsBuf = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const storageOf = (arr) => {
    const b = device.createBuffer({
      size: Math.max(16, arr.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(b, 0, arr)
    return b
  }
  const seedNBuf = storageOf(hasSeedN ? seedNormals : new Float32Array(4))
  const priorBuf = storageOf(hasPrior ? prior : new Float32Array(4))
  // The sources' first-pass depths, one maxW×maxH layer each (the srcArrTex layout).
  let srcDepthArr = new Float32Array(4)
  if (geomOn) {
    const layer = maxW * maxH
    srcDepthArr = new Float32Array(layer * nSrc)
    srcList.forEach((s, l) => {
      const d = srcDepth[l]
      if (d) for (let y = 0; y < s.h; y++) srcDepthArr.set(d.subarray(y * s.w, (y + 1) * s.w), l * layer + y * maxW)
    })
    const cap = Math.min(device.limits.maxStorageBufferBindingSize ?? Infinity, device.limits.maxBufferSize ?? Infinity)
    if (srcDepthArr.byteLength > cap) {
      throw new Error(
        `source depth planes ${Math.round(srcDepthArr.byteLength / 2 ** 20)} MB exceed the GPU limit ` +
          `${Math.round(cap / 2 ** 20)} MB — lower maxDim or the source count`,
      )
    }
  }
  const srcDepthBuf = storageOf(srcDepthArr)
  device.queue.writeBuffer(paramsBuf, 0, pbuf)

  // ── Per-source pose storage buffer (array<Src>, 96 bytes each) ─────────────
  const sbuf = new ArrayBuffer(96 * nSrc)
  const sv = new DataView(sbuf)
  srcList.forEach((s, idx) => writeSrc(sv, idx * 96, s))
  const srcBuf = device.createBuffer({ size: 96 * nSrc, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(srcBuf, 0, sbuf)

  // ── Control uniform (32 bytes), rewritten before each dispatch ─────────────
  const ctrlBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  // `scale` = the sweep's refinement scale (refineSchedule.js), the value mvs.rs
  // derives from the same perturbStart and iteration; `rowOffset` the band's first row.
  const writeCtrl = (mode, parity, iter, rowOffset = 0) => {
    const b = new ArrayBuffer(32)
    const d = new DataView(b)
    d.setUint32(0, mode, true)
    d.setUint32(4, parity, true)
    d.setUint32(8, iter, true)
    d.setFloat32(12, refineScale(perturbStart, iter), true)
    d.setUint32(16, rowOffset, true)
    device.queue.writeBuffer(ctrlBuf, 0, b)
  }

  // ── Seed (storage, read-only); dummy when absent ───────────────────────────
  const seedArr = hasSeed ? seedDepth : new Float32Array(1)
  const seedBuf = device.createBuffer({
    size: Math.max(4, seedArr.byteLength),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(seedBuf, 0, seedArr)

  // ── Persistent state (depth+normal as vec4) + cost ─────────────────────────
  const stateBytes = npix * 16
  const costBytes = npix * 4

  // Pre-flight the largest allocation against the device limits. The state buffer
  // (npix×16) is bound as storage AND copied for readback, so it must fit both
  // maxStorageBufferBindingSize and maxBufferSize. Failing here with a clear
  // message beats a cryptic "map async was not successful" once the oversized
  // buffer turns invalid — the worker catches this and falls back to WASM.
  const lim = device.limits
  const cap = Math.min(lim.maxStorageBufferBindingSize ?? Infinity, lim.maxBufferSize ?? Infinity)
  if (stateBytes > cap) {
    const mb = (n) => Math.round(n / (1024 * 1024))
    throw new Error(
      `depth buffer ${mb(stateBytes)} MB (${refW}×${refH}) exceeds GPU limit ${mb(cap)} MB — lower maxDim`,
    )
  }

  const stateBuf = device.createBuffer({ size: stateBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  // ACMH's per-pixel temporal view prior (patchmatch.wgsl selView); a dummy otherwise.
  const selViewBuf = device.createBuffer({ size: acmh ? npix * 4 : 4, usage: GPUBufferUsage.STORAGE })
  const costBuf = device.createBuffer({ size: costBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuf } },
      { binding: 1, resource: refTex.createView() },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: seedBuf } },
      { binding: 4, resource: { buffer: stateBuf } },
      { binding: 5, resource: { buffer: costBuf } },
      { binding: 6, resource: { buffer: srcBuf } },
      { binding: 7, resource: srcArrTex.createView({ dimension: '2d-array' }) },
      { binding: 8, resource: { buffer: ctrlBuf } },
      { binding: 9, resource: srcMaskTex.createView({ dimension: '2d-array' }) },
      { binding: 10, resource: { buffer: selViewBuf } },
      { binding: 11, resource: { buffer: seedNBuf } },
      { binding: 12, resource: { buffer: priorBuf } },
      { binding: 13, resource: { buffer: srcDepthBuf } },
    ],
  })

  const gx = Math.ceil(refW / 8),
    gy = Math.ceil(refH / 8)
  // A pass goes out in bands of workgroup rows, timed: the next band is sized to take
  // DENSE_TUNING.gpuBandMs, and the queue is waited on once that much work is in it. A
  // dedicated GPU soon runs whole passes, several before a wait; a slow integrated one
  // gets short commands, and the screen (which it also draws) and the OS's GPU watchdog
  // get their turn between them. The speed is learned per device and pass kind.
  const costs = rowCost.get(device) ?? new Map()
  rowCost.set(device, costs)
  const targetMs = DENSE_TUNING.gpuBandMs
  // The work submitted since the last wait: one kind of pass, its rows, its start.
  let batchRows = 0,
    batchStart = 0,
    batchMode = null,
    queuedMs = 0
  const settle = async () => {
    if (!batchRows) return
    await device.queue.onSubmittedWorkDone()
    const perRow = (performance.now() - batchStart) / batchRows
    const known = costs.get(batchMode)
    // A moving estimate: one slow batch (a busy screen) does not halve the next band.
    costs.set(batchMode, known ? 0.5 * known + 0.5 * perRow : perRow)
    batchRows = 0
    queuedMs = 0
  }
  const runPass = async (mode, parity, iter) => {
    if (batchMode !== mode) await settle()
    for (let row = 0; row < gy;) {
      const known = costs.get(mode)
      // Unknown speed: an eighth of the image first, so even the first command is short.
      const rows = Math.max(1, Math.min(gy - row, known ? Math.floor(targetMs / known) : Math.ceil(gy / 8)))
      writeCtrl(mode, parity, iter, row * 8)
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, bindGroup)
      pass.dispatchWorkgroups(gx, rows)
      pass.end()
      if (!batchRows) batchStart = performance.now()
      device.queue.submit([enc.finish()])
      batchRows += rows
      batchMode = mode
      queuedMs += known ? known * rows : Infinity
      if (queuedMs >= targetMs) await settle()
      row += rows
    }
  }

  // Init, then iterations × {parity 0, parity 1}. Each writeCtrl is ordered before
  // its dispatch's submit, so the GPU runs them in sequence on the queue.
  await runPass(0, 0, 0)

  // Resolve the error scopes now that every resource exists and the init pass has
  // been submitted. Throwing here (worker → WASM fallback) beats an opaque readback
  // failure later, and names the actual cause.
  let valErr, oomErr
  try {
    valErr = await device.popErrorScope()
    oomErr = await device.popErrorScope()
  } catch (err) {
    const lost = state.lossInfo
    const detail = lost
      ? `device lost (${lost.reason || 'unknown'}${lost.message ? `: ${lost.message}` : ''})`
      : 'device state unavailable (the browser dropped the WebGPU instance while resolving an error scope)'
    throw new Error(`GPU depth-map setup failed: ${err?.message || err}; ${detail}`)
  }
  const gpuErr = valErr || oomErr
  if (gpuErr) {
    const lost = state.lossInfo
    const suffix = lost ? `; device lost (${lost.reason || 'unknown'}${lost.message ? `: ${lost.message}` : ''})` : ''
    throw new Error(`GPU depth-map setup failed: ${gpuErr.message}${suffix}`)
  }

  for (let it = 0; it < iters; it++) {
    await runPass(1, 0, it)
    await runPass(1, 1, it)
  }

  if (acmh || hasPrior || geomOn) await runPass(2, 0, 0)
  await settle()

  // ── Readback ───────────────────────────────────────────────────────────────
  const stateRead = device.createBuffer({ size: stateBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const costRead = device.createBuffer({ size: costBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const enc = device.createCommandEncoder()
  enc.copyBufferToBuffer(stateBuf, 0, stateRead, 0, stateBytes)
  enc.copyBufferToBuffer(costBuf, 0, costRead, 0, costBytes)
  device.queue.submit([enc.finish()])

  await Promise.all([stateRead.mapAsync(GPUMapMode.READ), costRead.mapAsync(GPUMapMode.READ)])
  const stateArr = new Float32Array(stateRead.getMappedRange().slice(0)) // [d,nx,ny,nz]×npix
  const cost = new Float32Array(costRead.getMappedRange().slice(0))
  stateRead.unmap()
  costRead.unmap()

  const depth = new Float32Array(npix)
  const normals = new Float32Array(npix * 3)
  for (let i = 0; i < npix; i++) {
    depth[i] = stateArr[i * 4]
    normals[i * 3] = stateArr[i * 4 + 1]
    normals[i * 3 + 1] = stateArr[i * 4 + 2]
    normals[i * 3 + 2] = stateArr[i * 4 + 3]
  }

  for (const r of [
    refTex,
    srcArrTex,
    srcMaskTex,
    paramsBuf,
    srcBuf,
    ctrlBuf,
    seedBuf,
    stateBuf,
    selViewBuf,
    seedNBuf,
    priorBuf,
    srcDepthBuf,
    costBuf,
    stateRead,
    costRead,
  ])
    r.destroy?.()

  return { depth, cost, width: refW, height: refH, normals }
}
