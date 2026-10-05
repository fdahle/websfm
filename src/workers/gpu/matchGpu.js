// WebGPU brute-force descriptor matcher — drop-in for core/features/bruteforce.js
// `matchDescriptors` (same `{ matches, count }` result). The GPU computes only the
// per-row/per-column top-2 (match.wgsl); the ratio test + mutual filter are
// core/features/nnSelect.js `selectMatches`, the same rule the WASM crate applies.
//
// Descriptor buffers are cached on the GPU per matching run, keyed by image uuid:
// exhaustive matching touches each image N−1 times, and re-uploading (and, before
// that, structured-cloning to the worker) ~4 MB per side per pair would dominate a
// ~10 ms kernel. The cache is an LRU under a byte budget; a miss is reported back
// as `{ needs: [ids] }` so the caller resends — eviction can never corrupt a match.
// Subset-gate calls pass `id: null` and use throw-away buffers.
//
// Concurrency: several calls may be in flight on this worker at once. Everything
// from cache lookup to the last queue.submit is synchronous (no await), and every
// per-call buffer is private to that call, so interleaved calls cannot see each
// other's state; the GPU queue orders their work.
//
// Worker-only (touches navigator.gpu) — never import from core/*.

import { ensureDevice } from './device.js'
import shaderSrc from './match.wgsl?raw'
import { descriptorNorms, selectMatches } from '../../core/features/nnSelect.js'

// Kernel geometry — must agree with the constants in match.wgsl.
export const MATCH_GPU_GEOMETRY = Object.freeze({
  tileA: 64, tileB: 64, workgroup: '16×16', microTile: '4×4', kChunk: 16,
})
// Upper bound on multiply-adds per dispatch. A pair is split into row-block chunks
// so no single dispatch approaches the OS GPU watchdog (Windows TDR ≈ 2 s): 2³³
// MAC is ~9 GMAC — one 8.4k×8.4k×128 pair — i.e. ~0.1 s at a modest 200 GFLOP/s.
const MAC_PER_DISPATCH = 2 ** 33
const KCHUNK = 16
const RECORD = 16 // bytes per vec4<u32> top-2 record
const UNIFORM_STRIDE = 256 // minUniformBufferOffsetAlignment upper bound

const pipelineCache = new WeakMap()

function getPipelines(device) {
  let cached = pipelineCache.get(device)
  if (cached) return cached
  const module = device.createShaderModule({ code: shaderSrc })
  cached = {
    nn2: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'nn2Tile' } }),
    reduce: device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'colReduce' } }),
  }
  pipelineCache.set(device, cached)
  return cached
}

// ── Per-run state (one run at a time per worker) ────────────────────────────

let run = null

function freshStats() {
  return { calls: 0, uploads: 0, uploadBytes: 0, hits: 0, misses: 0, evictions: 0,
    peakBytes: 0, gpuMs: 0, selectMs: 0 }
}

function adapterLabel(state) {
  const info = state.info ?? {}
  const id = [...new Set([info.vendor, info.architecture || info.description].filter(Boolean))].join(' ')
  return `${id || 'unknown adapter'}${state.isFallback ? ' [software adapter]' : ''}`
}

/**
 * Start a run: acquire the device, compile the pipelines (so a shader error
 * surfaces here, before any pair depends on it) and reset the cache.
 * @returns {Promise<{ok:true, adapter, budgetBytes, geometry, macPerDispatch, limits} | {ok:false, reason}>}
 */
export async function beginGpuMatchRun({ runId, cacheBudgetBytes }) {
  const state = await ensureDevice()
  if (!state) return { ok: false, reason: 'no WebGPU adapter' }
  const { device } = state
  device.pushErrorScope('validation')
  getPipelines(device)
  const err = await device.popErrorScope()
  if (err) return { ok: false, reason: `shader/pipeline: ${err.message}` }
  if (run) releaseEntries(run)
  const lim = device.limits
  const budgetBytes = Math.max(16 * 2 ** 20, Math.min(cacheBudgetBytes, lim.maxBufferSize ?? Infinity))
  run = { runId, device, entries: new Map(), bytes: 0, budgetBytes, stats: freshStats() }
  return {
    ok: true,
    adapter: adapterLabel(state),
    budgetBytes,
    geometry: MATCH_GPU_GEOMETRY,
    macPerDispatch: MAC_PER_DISPATCH,
    limits: {
      maxStorageBufferBindingSize: lim.maxStorageBufferBindingSize,
      maxComputeWorkgroupStorageSize: lim.maxComputeWorkgroupStorageSize,
    },
  }
}

/** End a run: free every cached buffer, return the run's counters. */
export function endGpuMatchRun({ runId }) {
  if (!run || run.runId !== runId) return null
  const stats = { ...run.stats, cachedAtEnd: run.entries.size }
  releaseEntries(run)
  run = null
  return stats
}

function releaseEntries(r) {
  for (const e of r.entries.values()) destroyEntry(e)
  r.entries.clear()
  r.bytes = 0
}

function destroyEntry(e) {
  e.buf.destroy()
  e.normBuf.destroy()
}

function createEntry(device, desc, dim) {
  const n = Math.floor(desc.length / dim)
  const descBytes = Math.max(RECORD, n * dim * 4)
  const buf = device.createBuffer({ size: descBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  if (n) device.queue.writeBuffer(buf, 0, desc.buffer, desc.byteOffset, n * dim * 4)
  const norms = descriptorNorms(desc, dim)
  const normBuf = device.createBuffer({ size: Math.max(RECORD, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  if (n) device.queue.writeBuffer(normBuf, 0, norms)
  return { buf, normBuf, norms, n, dim, bytes: descBytes + Math.max(RECORD, n * 4) }
}

// Resolve one side to a GPU entry: cached (LRU touch), uploaded now (cached when it
// has an id), or a miss the caller must resend. Synchronous.
function resolveSide(r, id, desc, dim, keep) {
  if (id != null && r.entries.has(id)) {
    const e = r.entries.get(id)
    if (e.dim === dim) {
      r.entries.delete(id); r.entries.set(id, e) // LRU touch
      r.stats.hits++
      return { entry: e, ephemeral: false }
    }
    r.entries.delete(id); r.bytes -= e.bytes; destroyEntry(e) // re-detected at another width
  }
  if (!desc) { r.stats.misses++; return { miss: true } }
  const e = createEntry(r.device, desc, dim)
  r.stats.uploads++
  r.stats.uploadBytes += e.bytes
  if (id == null) return { entry: e, ephemeral: true }
  // Evict least-recently-used entries (never the other side of this pair).
  for (const [oid, oe] of r.entries) {
    if (r.bytes + e.bytes <= r.budgetBytes) break
    if (keep.has(oid)) continue
    r.entries.delete(oid); r.bytes -= oe.bytes; destroyEntry(oe)
    r.stats.evictions++
  }
  r.entries.set(id, e)
  r.bytes += e.bytes
  r.stats.peakBytes = Math.max(r.stats.peakBytes, r.bytes)
  return { entry: e, ephemeral: false }
}

function evict(r, id) {
  const e = id != null ? r.entries.get(id) : null
  if (!e) return
  r.entries.delete(id); r.bytes -= e.bytes; destroyEntry(e)
}

/**
 * Match one pair on the GPU.
 * @param {object} a
 * @param {string} a.runId
 * @param {string|null} a.idA, a.idB  cache keys (image uuids); null ⇒ throw-away buffers
 * @param {Float32Array|null} a.descA, a.descB  required on a cache miss
 * @param {number} a.dim  descriptor width (128 SIFT / 256 SuperPoint)
 * @returns {Promise<{needs:string[]} | {matches, count, nA, nB, gpuMs, selectMs, chunks}>}
 */
export async function matchDescriptorsGpu({ runId, idA, idB, descA, descB, dim, ratioThreshold, crossCheck }) {
  // Capture the run: a later begin/end must not redirect this call's bookkeeping.
  const r = run
  if (!r || r.runId !== runId) throw new Error('GPU match run not started (call beginGpuMatchRun)')
  if (!(dim > 0) || dim % KCHUNK !== 0) {
    throw new Error(`descriptor width ${dim} is not a multiple of ${KCHUNK} — GPU kernel needs it`)
  }
  const { device } = r
  const lim = device.limits
  const bindCap = Math.min(lim.maxStorageBufferBindingSize ?? Infinity, lim.maxBufferSize ?? Infinity)

  // ── Synchronous section: resolve → allocate → encode → submit ─────────────
  const keep = new Set([idA, idB].filter((x) => x != null))
  const pre = [descA, descB].map((d) => (d ? d.length * 4 : 0))
  if (Math.max(...pre) > bindCap) {
    throw new Error(`descriptor buffer ${Math.round(Math.max(...pre) / 2 ** 20)} MB exceeds GPU binding limit `
      + `${Math.round(bindCap / 2 ** 20)} MB`)
  }
  const sa = resolveSide(r, idA, descA, dim, keep)
  const sb = resolveSide(r, idB, descB, dim, keep)
  if (sa.miss || sb.miss) {
    for (const s of [sa, sb]) if (s.ephemeral) destroyEntry(s.entry)
    return { needs: [sa.miss ? idA : null, sb.miss ? idB : null].filter((x) => x != null) }
  }
  const A = sa.entry
  const B = sb.entry
  const nA = A.n
  const nB = B.n
  const cleanupInputs = () => { for (const s of [sa, sb]) if (s.ephemeral) destroyEntry(s.entry) }
  if (!nA || !nB) {
    cleanupInputs()
    return { matches: [], count: 0, nA, nB, gpuMs: 0, selectMs: 0, chunks: 0 }
  }

  const doCols = !!crossCheck
  const dim4 = dim / 4
  const totalBlocks = Math.ceil(nA / 64)
  const macPerBlock = 64 * nB * dim
  let blocksPerChunk = Math.max(1, Math.min(totalBlocks, Math.floor(MAC_PER_DISPATCH / macPerBlock),
    lim.maxComputeWorkgroupsPerDimension ?? 65535))
  // The column partials buffer is blocksPerChunk × nB records — keep it bindable.
  if (doCols) blocksPerChunk = Math.max(1, Math.min(blocksPerChunk, Math.floor(bindCap / (nB * RECORD))))
  const nChunks = Math.ceil(totalBlocks / blocksPerChunk)

  const rowBytes = nA * RECORD
  const colBytes = doCols ? nB * RECORD : RECORD
  const partBytes = doCols ? blocksPerChunk * nB * RECORD : RECORD
  if (rowBytes > bindCap || partBytes > bindCap) {
    cleanupInputs()
    throw new Error(`top-2 buffers exceed GPU binding limit (${nA}×${nB} kp)`)
  }

  const { nn2, reduce } = getPipelines(device)
  device.pushErrorScope('out-of-memory')
  device.pushErrorScope('validation')

  const S = GPUBufferUsage
  const rowOut = device.createBuffer({ size: rowBytes, usage: S.STORAGE | S.COPY_SRC })
  const colPart = device.createBuffer({ size: partBytes, usage: S.STORAGE })
  const colOut = device.createBuffer({ size: colBytes, usage: S.STORAGE | S.COPY_SRC })
  const readBytes = rowBytes + (doCols ? colBytes : 0)
  const readBuf = device.createBuffer({ size: readBytes, usage: S.COPY_DST | S.MAP_READ })

  // One Params record per chunk, each at its own 256-byte uniform offset.
  const params = new ArrayBuffer(nChunks * UNIFORM_STRIDE)
  const pv = new DataView(params)
  for (let c = 0; c < nChunks; c++) {
    const o = c * UNIFORM_STRIDE
    const rowBlock0 = c * blocksPerChunk
    pv.setUint32(o + 0, nA, true)
    pv.setUint32(o + 4, nB, true)
    pv.setUint32(o + 8, dim4, true)
    pv.setUint32(o + 12, rowBlock0, true)
    pv.setUint32(o + 16, Math.min(blocksPerChunk, totalBlocks - rowBlock0), true)
    pv.setUint32(o + 20, doCols ? 1 : 0, true)
    pv.setUint32(o + 24, c === 0 ? 1 : 0, true)
  }
  const paramBuf = device.createBuffer({ size: params.byteLength, usage: S.UNIFORM | S.COPY_DST })
  device.queue.writeBuffer(paramBuf, 0, params)

  const t0 = performance.now()
  for (let c = 0; c < nChunks; c++) {
    const nBlocks = Math.min(blocksPerChunk, totalBlocks - c * blocksPerChunk)
    const p = { buffer: paramBuf, offset: c * UNIFORM_STRIDE, size: 32 }
    const bgTile = device.createBindGroup({
      layout: nn2.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: p },
        { binding: 1, resource: { buffer: A.buf } },
        { binding: 2, resource: { buffer: B.buf } },
        { binding: 3, resource: { buffer: A.normBuf } },
        { binding: 4, resource: { buffer: B.normBuf } },
        { binding: 5, resource: { buffer: rowOut } },
        { binding: 6, resource: { buffer: colPart } },
      ],
    })
    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(nn2)
    pass.setBindGroup(0, bgTile)
    pass.dispatchWorkgroups(nBlocks)
    if (doCols) {
      const bgReduce = device.createBindGroup({
        layout: reduce.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: p },
          { binding: 6, resource: { buffer: colPart } },
          { binding: 7, resource: { buffer: colOut } },
        ],
      })
      pass.setPipeline(reduce)
      pass.setBindGroup(0, bgReduce)
      pass.dispatchWorkgroups(Math.ceil(nB / 64))
    }
    pass.end()
    if (c === nChunks - 1) {
      enc.copyBufferToBuffer(rowOut, 0, readBuf, 0, rowBytes)
      if (doCols) enc.copyBufferToBuffer(colOut, 0, readBuf, rowBytes, colBytes)
    }
    // One submit per chunk: the watchdog bound is per submission on some drivers.
    device.queue.submit([enc.finish()])
  }
  const valP = device.popErrorScope()
  const oomP = device.popErrorScope()
  // ── End of synchronous section ─────────────────────────────────────────────

  const destroyScratch = () => {
    for (const b of [rowOut, colPart, colOut, paramBuf, readBuf]) b.destroy()
    cleanupInputs()
  }
  let gpuErr
  try {
    const [valErr, oomErr] = await Promise.all([valP, oomP])
    gpuErr = valErr || oomErr
  } catch (err) {
    gpuErr = err
  }
  if (gpuErr) {
    destroyScratch()
    // A failed upload may have left an invalid cached buffer — drop both sides so a
    // later pair re-uploads rather than failing on the same broken entry forever.
    evict(r, idA); evict(r, idB)
    throw new Error(`GPU match failed: ${gpuErr.message ?? gpuErr}`)
  }
  try {
    await readBuf.mapAsync(GPUMapMode.READ)
  } catch (err) {
    destroyScratch()
    evict(r, idA); evict(r, idB)
    throw new Error(`GPU match readback failed: ${err?.message ?? err}`)
  }
  const gpuMs = performance.now() - t0
  const raw = readBuf.getMappedRange().slice(0)
  readBuf.unmap()
  const normsA = A.norms
  const normsB = B.norms
  destroyScratch()

  const t1 = performance.now()
  const u = new Uint32Array(raw)
  const fl = new Float32Array(raw)
  const top2 = (n, rec0) => {
    const t = { best: new Uint32Array(n), s1: new Float32Array(n), s2: new Float32Array(n) }
    for (let i = 0; i < n; i++) {
      const o = (rec0 + i) * 4
      t.best[i] = u[o]; t.s1[i] = fl[o + 1]; t.s2[i] = fl[o + 2]
    }
    return t
  }
  const rows = top2(nA, 0)
  const cols = doCols ? top2(nB, nA) : null
  const res = selectMatches({ rows, cols, normsA, normsB, ratioThreshold, crossCheck: doCols })
  const selectMs = performance.now() - t1

  r.stats.calls++
  r.stats.gpuMs += gpuMs
  r.stats.selectMs += selectMs
  return { ...res, nA, nB, gpuMs, selectMs, chunks: nChunks }
}
