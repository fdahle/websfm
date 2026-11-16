// Finding and reading the text on a photograph: the detector (core/ocr/detect.js) and
// the recogniser (core/ocr/recognize.js) on their ONNX Runtime sessions. The sessions
// load once per worker, from the model cache (core/models/), and run on CPU WASM: OCR
// is spread over the worker pool one photograph per worker, where one GPU session
// would serialize it.
//
// `runners` replaces the sessions (the Node harness and the tests pass their own), so
// everything but session creation runs outside a browser.

import { createSession, tensor } from '../features/ort.js'
import { modelUrl } from '../models/registry.js'
import { modelBytes } from '../models/modelCache.js'
import { OCR_TUNING } from '../tuning.js'
import { detectText } from './detect.js'
import { recognizeText } from './recognize.js'

const sessions = new Map()

function getSession(id, onLog) {
  if (!sessions.has(id)) {
    const p = (async () => {
      const bytes = await modelBytes(modelUrl(id), onLog, `OCR ${id}`)
      return createSession(bytes, {}, onLog, 'wasm')
    })()
    // A failed load is not kept: the next call tries again (a download may finish).
    p.catch(() => sessions.delete(id))
    sessions.set(id, p)
  }
  return sessions.get(id)
}

// ORT sessions are not reentrant: one run at a time per worker.
let chain = Promise.resolve()
function serialized(fn) {
  const p = chain.then(fn, fn)
  chain = p.then(
    () => {},
    () => {},
  )
  return p
}

/** The detector and recogniser as `run(input, dims)` functions on ORT sessions. */
export function ortRunners(onLog) {
  const runner = (id, shape) => async (data, dims) => {
    const session = await getSession(id, onLog)
    const out = await serialized(async () => {
      const x = await tensor('float32', data, dims)
      return session.run({ [session.inputNames[0]]: x })
    })
    const t = out[session.outputNames[0]]
    return shape ? { data: t.data, dims: t.dims } : t.data
  }
  return { det: runner('ppocr_det', false), rec: runner('ppocr_rec_en', true) }
}

/**
 * The text lines on a grey raster (w×h, at the detection scale). With `read` each line
 * is also read: `[{ quad, score, text?, textScore?, angle? }]`, quads in raster pixels.
 */
export async function findText(gray, w, h, opts = {}) {
  const { read = false, onLog, signal, runners = ortRunners(onLog) } = opts
  const t0 = performance.now()
  const { boxes, tiles } = await detectText(gray, w, h, runners.det, { signal, ...opts.det })
  const t1 = performance.now()
  let lines = boxes.map((b) => ({ quad: b.quad, score: b.score }))
  if (read && boxes.length) {
    const reads = await recognizeText(
      gray,
      w,
      h,
      boxes.map((b) => b.quad),
      runners.rec,
      { signal },
    )
    lines = lines.map((l, i) => ({ ...l, text: reads[i].text, textScore: reads[i].score, angle: reads[i].angle }))
  }
  const t2 = performance.now()
  return {
    lines,
    tiles,
    detectMs: Math.round(t1 - t0),
    readMs: Math.round(t2 - t1),
  }
}

/** The scale at which a w×h photograph is searched for text (≤ 1). */
export function ocrScale(natW, natH, maxDim = OCR_TUNING.detMaxDim) {
  return Math.min(1, maxDim / Math.max(natW, natH))
}
