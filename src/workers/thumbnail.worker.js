// Thumbnail worker (TODO ▸ SC-8). A dedicated, wasm-free worker rather than an op on
// the compute pool: compute workers can be pinned to a ten-minute SfM / GPU matching
// run, and a list thumbnail must not queue behind one. Each job decodes one image,
// downsizes it to ≤ THUMB_MAX_DIM and re-encodes a small JPEG (utils/thumbnail.js).
//   in:  { id, source: Blob | url, opts }
//   out: { id, ok: true, result: { blob, width, height, ... } } | { id, ok: false, error }

import { renderThumbnail } from '../utils/thumbnail.js'

self.onmessage = async (e) => {
  const { id, source, opts } = e.data
  try {
    const result = await renderThumbnail(source, opts)
    self.postMessage({ id, ok: true, result })
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message ?? String(err) })
  }
}
