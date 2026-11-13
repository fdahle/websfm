// What a model download must look like: the checks that tell ONNX weights from the
// web page a host serves for a missing file. Pure; the Cache Storage side (reading,
// evicting, the fetch fallback) is utils/modelCache.js, which core reaches through
// core/coreIo.js `loadModelBytes`.

import { coreIo } from '../coreIo.js'

// Every real weight file is megabytes; anything this small is an error page.
export const MIN_MODEL_BYTES = 64 * 1024

/**
 * Why a response cannot be an ONNX model, or null if it plausibly is. ONNX is a
 * binary protobuf, so a body that opens with `<` is a web page. The usual source
 * is a dev server's or static host's SPA fallback: a missing `/models/x.onnx`
 * comes back as `index.html` with HTTP 200, so `resp.ok` passes, and ORT later
 * fails with the opaque "protobuf parsing failed".
 * `head` = the first bytes of the body (≥ 16 is plenty), `size` = total bytes
 * (omit when unknown).
 */
export function modelBytesProblem({ head, size, contentType = '' }) {
  if (/text\/html/i.test(contentType)) return 'the server returned an HTML page'
  if (head) {
    const u8 = head instanceof Uint8Array ? head : new Uint8Array(head)
    let i = 0
    // Skip whitespace and a UTF-8 BOM before looking for the opening tag.
    while (i < u8.length && [0x20, 0x09, 0x0a, 0x0d, 0xef, 0xbb, 0xbf].includes(u8[i])) i++
    if (u8[i] === 0x3c) return 'the server returned an HTML/XML page'
  }
  if (Number.isFinite(size) && size < MIN_MODEL_BYTES) return `only ${size} bytes arrived`
  return null
}

/** The error to throw when `url` did not serve a model; names the likely fix. */
export function badModelError(label, url, problem) {
  return new Error(
    `${label}: ${url} is not an ONNX model (${problem}). The file is probably ` +
      'missing on the server: place the .onnx files in public/models/ or set VITE_MODEL_BASE_URL.',
  )
}

/**
 * A model's bytes for InferenceSession.create: bytes (an ArrayBuffer or Uint8Array)
 * as they are, a URL from the model cache or the network (utils/modelCache.js,
 * installed as core I/O).
 */
export function modelBytes(model, onLog, label = 'model') {
  return typeof model === 'string' ? coreIo().loadModelBytes(model, onLog, label) : Promise.resolve(model)
}
