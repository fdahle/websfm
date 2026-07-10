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
    size: [w, h], format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  device.queue.writeTexture({ texture: tex }, gray, { bytesPerRow: w, rowsPerImage: h }, { width: w, height: h })
  return tex
}

// Pack one Src struct (96 bytes, std430) at byte offset `o` of DataView `dv`.
function writeSrc(dv, o, s) {
  dv.setUint32(o + 0, s.w, true); dv.setUint32(o + 4, s.h, true)
  dv.setFloat32(o + 16, s.K.fx, true); dv.setFloat32(o + 20, s.K.fy, true)
  dv.setFloat32(o + 24, s.K.cx, true); dv.setFloat32(o + 28, s.K.cy, true)
  const R = s.R, t = s.t
  dv.setFloat32(o + 32, R[0][0], true); dv.setFloat32(o + 36, R[0][1], true); dv.setFloat32(o + 40, R[0][2], true)
  dv.setFloat32(o + 48, R[1][0], true); dv.setFloat32(o + 52, R[1][1], true); dv.setFloat32(o + 56, R[1][2], true)
  dv.setFloat32(o + 64, R[2][0], true); dv.setFloat32(o + 68, R[2][1], true); dv.setFloat32(o + 72, R[2][2], true)
  dv.setFloat32(o + 80, t[0], true); dv.setFloat32(o + 84, t[1], true); dv.setFloat32(o + 88, t[2], true)
}

export async function computeDepthMapGPU(refGray, refW, refH, refK, sources, opts = {}) {
  const state = await ensureDevice()
  if (!state) return null
  const { device } = state
  const npix = refW * refH
  if (npix === 0 || !sources.length) return null

  const {
    depthMin = 0, depthMax = 0, seedDepth = null,
    window = 2, iterations = 3, bestK = 3, seed = 1,
  } = opts
  const radius = Math.min(5, Math.max(1, window)) // match mvs.rs radius cap (≤11×11)
  const iters = Math.max(1, iterations)
  const hasSeed = seedDepth && seedDepth.length >= npix
  const MAX_SRC = 16
  const srcList = sources.slice(0, MAX_SRC)
  const nSrc = srcList.length
  const maxW = Math.max(...srcList.map((s) => s.w))
  const maxH = Math.max(...srcList.map((s) => s.h))
  const { pipeline, sampler } = getPipeline(device)

  const refTex = uploadGray(device, refGray, refW, refH)

  // ── Sources as a texture_2d_array: each in its own maxW×maxH layer ─────────
  const srcArrTex = device.createTexture({
    size: [maxW, maxH, nSrc], format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  srcList.forEach((s, layer) => {
    device.queue.writeTexture(
      { texture: srcArrTex, origin: [0, 0, layer] },
      s.gray, { bytesPerRow: s.w, rowsPerImage: s.h },
      { width: s.w, height: s.h, depthOrArrayLayers: 1 },
    )
  })

  // ── Source exclusion masks (frame/fiducials), same layer layout ────────────
  // Always created (the shader binding is mandatory); layers for unmasked sources
  // stay zero. The 0/1 LUT is scaled to 0/255 so the shader's `> 0.5` test works
  // against the r8unorm-normalised texel.
  const srcMaskTex = device.createTexture({
    size: [maxW, maxH, nSrc], format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  srcList.forEach((s, layer) => {
    if (!s.mask) return
    const bytes = new Uint8Array(s.w * s.h)
    for (let k = 0; k < bytes.length; k++) bytes[k] = s.mask[k] ? 255 : 0
    device.queue.writeTexture(
      { texture: srcMaskTex, origin: [0, 0, layer] },
      bytes, { bytesPerRow: s.w, rowsPerImage: s.h },
      { width: s.w, height: s.h, depthOrArrayLayers: 1 },
    )
  })

  // ── Params uniform (64 bytes) ──────────────────────────────────────────────
  const pbuf = new ArrayBuffer(64)
  const pv = new DataView(pbuf)
  pv.setUint32(0, refW, true);  pv.setUint32(4, refH, true)
  pv.setInt32(8, radius, true); pv.setUint32(12, hasSeed ? 1 : 0, true)
  pv.setFloat32(16, refK.fx, true); pv.setFloat32(20, refK.fy, true)
  pv.setFloat32(24, refK.cx, true); pv.setFloat32(28, refK.cy, true)
  pv.setFloat32(32, depthMin, true); pv.setFloat32(36, depthMax, true)
  pv.setUint32(40, seed >>> 0, true); pv.setUint32(44, iters, true)
  pv.setUint32(48, nSrc, true); pv.setUint32(52, Math.max(1, bestK), true)
  pv.setUint32(56, maxW, true); pv.setUint32(60, maxH, true)
  const paramsBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(paramsBuf, 0, pbuf)

  // ── Per-source pose storage buffer (array<Src>, 96 bytes each) ─────────────
  const sbuf = new ArrayBuffer(96 * nSrc)
  const sv = new DataView(sbuf)
  srcList.forEach((s, idx) => writeSrc(sv, idx * 96, s))
  const srcBuf = device.createBuffer({ size: 96 * nSrc, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(srcBuf, 0, sbuf)

  // ── Control uniform (16 bytes), rewritten before each dispatch ─────────────
  const ctrlBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const writeCtrl = (mode, parity, iter) => {
    const b = new ArrayBuffer(16); const d = new DataView(b)
    d.setUint32(0, mode, true); d.setUint32(4, parity, true); d.setUint32(8, iter, true)
    device.queue.writeBuffer(ctrlBuf, 0, b)
  }

  // ── Seed (storage, read-only); dummy when absent ───────────────────────────
  const seedArr = hasSeed ? seedDepth : new Float32Array(1)
  const seedBuf = device.createBuffer({
    size: Math.max(4, seedArr.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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
  const costBuf  = device.createBuffer({ size: costBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })

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
    ],
  })

  const gx = Math.ceil(refW / 8), gy = Math.ceil(refH / 8)
  const dispatch = () => {
    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(gx, gy)
    pass.end()
    device.queue.submit([enc.finish()])
  }

  // Init, then iterations × {parity 0, parity 1}. Each writeCtrl is ordered before
  // its dispatch's submit, so the GPU runs them in sequence on the queue.
  writeCtrl(0, 0, 0); dispatch()
  for (let it = 0; it < iters; it++) {
    writeCtrl(1, 0, it); dispatch()
    writeCtrl(1, 1, it); dispatch()
  }

  // ── Readback ───────────────────────────────────────────────────────────────
  const stateRead = device.createBuffer({ size: stateBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
  const costRead  = device.createBuffer({ size: costBytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ })
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

  for (const r of [refTex, srcArrTex, srcMaskTex, paramsBuf, srcBuf, ctrlBuf, seedBuf, stateBuf, costBuf, stateRead, costRead]) r.destroy?.()

  return { depth, cost, width: refW, height: refH, normals }
}
