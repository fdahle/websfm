import { matchDescriptors } from '../../core/features/bruteforce.js'
import { compareMatchSets } from '../../core/features/nnSelect.js'
import { asKeypoints } from '../../core/features/keypoints.js'
import { matchLightGlue, matchLightGlueTiled } from '../../core/features/lightglue.js'
import { verifyMatches, verifyPointPairs } from '../../core/features/verify.js'
import { trainCodebook, vladEncode, topKSimilar, diverseSimilar } from '../../core/features/retrieval.js'
import { beginGpuMatchRun, endGpuMatchRun, matchDescriptorsGpu } from '../gpu/matchGpu.js'

// Matching + geometric-verification ops. No worker-local pixel helpers needed —
// these operate on already-detected keypoints/descriptors.
export function makeMatchOps() {
  async function match([descA, descB, options = {}]) {
    return { result: await matchDescriptors(descA, descB, options) }
  }

  // WebGPU brute-force backend (workers/gpu/matchGpu.js). The client pins all three
  // ops to one worker — the per-run descriptor cache lives in that worker's device.
  async function matchGpuBegin([opts = {}]) {
    return { result: await beginGpuMatchRun(opts) }
  }
  async function matchGpuEnd([opts = {}]) {
    return { result: endGpuMatchRun(opts) }
  }
  // `validate` (the run's first pair of each kind): also run the WASM matcher on the
  // same descriptors and report the agreement. A failed check returns the WASM
  // result for this pair, so a wrong GPU answer never reaches verification.
  async function matchGpu([args = {}]) {
    const res = await matchDescriptorsGpu(args)
    if (res.needs || !args.validate) return { result: res }
    const { descA, descB, dim, ratioThreshold, crossCheck } = args
    const t0 = performance.now()
    const cpu = await matchDescriptors(descA, descB, { dim, ratioThreshold, crossCheck })
    const cpuMs = performance.now() - t0
    const validation = {
      ...compareMatchSets(cpu.matches, res.matches),
      gpuMs: res.gpuMs,
      cpuMs,
      nA: res.nA,
      nB: res.nB,
    }
    return { result: validation.pass ? { ...res, validation } : { ...cpu, validation, backend: 'wasm' } }
  }

  // LightGlue joint matcher (ONNX). Unlike `match`, it needs both keypoint sets +
  // image sizes (attention input + internal coord normalization), so it takes one
  // args object. Streams first-run init/backend log lines like SuperPoint.
  async function matchLightGluePair([args = {}], { emit } = {}) {
    // Thread the log level (default 'info') so per-pair timing can land at 'debug'.
    const onLog = emit ? (msg, level) => emit('log', [msg, level]) : undefined
    // One op name, one pinned worker: route to the coarse-to-fine tiled variant
    // when the caller asked for it, else the plain capped match.
    const fn = args.tiled ? matchLightGlueTiled : matchLightGlue
    // Keypoints arrive structured-cloned ({ data, rgb }: the class does not survive).
    return { result: await fn({ ...args, kpsA: asKeypoints(args.kpsA), kpsB: asKeypoints(args.kpsB), onLog }) }
  }

  async function verify([kpsA, kpsB, matches, options = {}]) {
    const res = await verifyMatches(asKeypoints(kpsA), asKeypoints(kpsB), matches, options)
    if (!res) return { result: null }
    // res.inlierMask is a fresh Float32Array → transfer it back.
    return { result: res, transfer: [res.inlierMask.buffer] }
  }

  // Packed form used by the match store: only the putatives' coordinates cross
  // postMessage (transferred), never the two whole keypoint arrays.
  async function verifyPoints([ptsA, ptsB, options = {}]) {
    const res = await verifyPointPairs(ptsA, ptsB, options)
    if (!res) return { result: null }
    return { result: res, transfer: [res.inlierMask.buffer] }
  }

  // Image retrieval (Pairing ▸ Similar images, core/features/retrieval.js): the codebook
  // from the run's sampled descriptors, one photo's VLAD vector, and the k most similar
  // photos for a block of rows (the vectors come shared where the page allows it).
  async function retrievalCodebook([samples, dim, opts = {}]) {
    const r = trainCodebook(samples, dim, opts)
    return { result: r, transfer: [r.codebook] }
  }
  async function retrievalEncode([desc, dim, codebook, words]) {
    const v = vladEncode(desc, dim, codebook, words)
    return { result: v, transfer: [v] }
  }
  async function retrievalTopK([vectors, len, k, from, to, extra = 0, pool = 0]) {
    if (extra > 0) {
      const r = diverseSimilar(vectors, len, k, extra, pool, from, to)
      return { result: r, transfer: [r.index] }
    }
    const r = topKSimilar(vectors, len, k, from, to)
    return { result: r, transfer: [r.index, r.score] }
  }

  return {
    verifyPoints,
    match,
    matchGpuBegin,
    matchGpu,
    matchGpuEnd,
    matchLightGlue: matchLightGluePair,
    verify,
    retrievalCodebook,
    retrievalEncode,
    retrievalTopK,
  }
}
