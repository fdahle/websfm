import { matchDescriptors } from '../../core/features/bruteforce.js'
import { matchLightGlue } from '../../core/features/lightglue.js'
import { verifyMatches } from '../../core/features/verify.js'

// Matching + geometric-verification ops. No worker-local pixel helpers needed —
// these operate on already-detected keypoints/descriptors.
export function makeMatchOps() {
  async function match([descA, descB, options = {}]) {
    return { result: await matchDescriptors(descA, descB, options) }
  }

  // LightGlue joint matcher (ONNX). Unlike `match`, it needs both keypoint sets +
  // image sizes (attention input + internal coord normalization), so it takes one
  // args object. Streams first-run init/backend log lines like SuperPoint.
  async function matchLightGluePair([args = {}], { emit } = {}) {
    // Thread the log level (default 'info') so per-pair timing can land at 'debug'.
    const onLog = emit ? (msg, level) => emit('log', [msg, level]) : undefined
    return { result: await matchLightGlue({ ...args, onLog }) }
  }

  async function verify([kpsA, kpsB, matches, options = {}]) {
    const res = await verifyMatches(kpsA, kpsB, matches, options)
    if (!res) return { result: null }
    // res.inlierMask is a fresh Float32Array → transfer it back.
    return { result: res, transfer: [res.inlierMask.buffer] }
  }

  return { match, matchLightGlue: matchLightGluePair, verify }
}
