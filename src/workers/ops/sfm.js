import { reconstruct as sfmReconstruct } from '../../core/sfm/sfm.js'
import { packReconstructionResult, packSparseCloud, unpackReconstructionResult } from '../../core/sfm/resultCodec.js'
import { sparsePointMetrics, refineSparseSelection, optimizeCameras } from '../../core/sfm/gradualSelection.js'
import { bundleAdjust } from '../../core/sfm/reconstruction.js'
import { wrapPackedMatches } from '../../core/sfm/matchCodec.js'

// Sparse incremental-SfM op.
export function makeSfmOps() {
  // Long-running incremental SfM. Streams the algorithm's log + progress back to
  // the main thread as intermediate `ev` messages (see emit), then returns the
  // final model.
  async function reconstruct([input], { emit }) {
    wrapPackedMatches(input.pairs)
    const result = await sfmReconstruct(input, {
      onLog: (message, level, category) => emit('log', [message, level, category]),
      // `fraction` is the phase-weighted 0..1 bar value (core/sfm/progressPlan.js);
      // done/total ride along as the numeric readout only.
      onProgress: (done, total, label, fraction) => emit('progress', [done, total, label, fraction]),
    })
    // Do not structured-clone the object-per-point/object-per-observation result.
    // Large surveys contain millions of those tuples; cloning them while the worker
    // still owns the original can kill the tab at 100%. Transfer compact buffers.
    const packed = packReconstructionResult(result)
    // Packing is a consuming boundary: make the tuple graph collectible before
    // postMessage hands the buffers to the browser process.
    result.points = []
    for (const model of (result.secondaryModels || [])) model.points = []
    // This is the worker's structured-cloned input, never the store's source data.
    // Release keypoints and pair matches before the final cross-process message too.
    input.images = []
    input.pairs = []
    input.gcps = []
    input.cameraPriors = []
    const bytes = packed.transfer.reduce((sum, buffer) => sum + buffer.byteLength, 0)
    emit('log', [`Compact result ready for transfer (${(bytes / 1024 ** 2).toFixed(1)} MiB)`,
      'info', 'Reconstruction'])
    return packed
  }

  async function sparseMetrics([packed]) {
    const model = unpackReconstructionResult(packed)
    return { result: sparsePointMetrics(model.cameras, model.points) }
  }
  // constraints: { gcps, cameraPriors } — the survey evidence the model was solved
  // under (store surveyConstraintInput), so the refinement is held to it too.
  async function refineSparse([packed, settings, constraints = {}]) {
    const model = unpackReconstructionResult(packed)
    const refined = await refineSparseSelection(model.cameras, model.points, settings, bundleAdjust, constraints)
    const packedResult = packSparseCloud(refined)
    Object.assign(packedResult.result, { removed: refined.removed, costBefore: refined.costBefore,
      costAfter: refined.costAfter, constraints: refined.constraints })
    return packedResult
  }
  // Tools ▸ Model ▾ ▸ Optimize cameras: same disposable copy and survey constraints
  // as refineSparse, with focal (+ principal point) free per sensor.
  async function optimizeSparse([packed, settings, constraints = {}]) {
    const model = unpackReconstructionResult(packed)
    const refined = await optimizeCameras(model.cameras, model.points, settings, bundleAdjust, constraints)
    const packedResult = packSparseCloud(refined)
    Object.assign(packedResult.result, { removed: refined.dropped, costBefore: refined.costBefore,
      costAfter: refined.costAfter, constraints: refined.constraints, focalChange: refined.focalChange })
    return packedResult
  }
  return { reconstruct, sparseMetrics, refineSparse, optimizeSparse }
}
