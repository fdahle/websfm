import { reconstruct as sfmReconstruct } from '../../core/sfm/sfm.js'

// Sparse incremental-SfM op.
export function makeSfmOps() {
  // Long-running incremental SfM. Streams the algorithm's log + progress back to
  // the main thread as intermediate `ev` messages (see emit), then returns the
  // final model.
  async function reconstruct([input], { emit }) {
    const result = await sfmReconstruct(input, {
      onLog: (message, level, category) => emit('log', [message, level, category]),
      onProgress: (done, total, label) => emit('progress', [done, total, label]),
    })
    return { result }
  }

  return { reconstruct }
}
