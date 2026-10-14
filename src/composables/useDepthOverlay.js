import { ref, shallowRef, watch } from 'vue'
import { depthColor } from '../core/products/colormap.js'
import { createRevision } from '../utils/revision.js'

// The image view's depth-map overlay: an OffscreenCanvas at native image
// resolution that `renderOverlay` blits under the other overlays, plus the
// import/export/clear actions behind the ribbon's depth buttons.
//
// Depth maps here are already *colorized* PNG data URLs (the pipeline colorizes
// when it writes them), so the load path is a plain blit. Only a user-imported
// file needs work: it is typically grayscale, so it is normalized by luminance
// over the valid pixels and re-colorized through the shared ramp — that keeps an
// imported map on the same visual scale as a computed one. A fully transparent
// pixel means "no data" and stays transparent.
//
// The canvas is a `shallowRef` rather than a plain `let` so the caller can read
// it (`depthCanvas.value`) without this module having to hand out a getter; the
// draw path is rAF-driven, not a reactive effect, so nothing tracks it.
//
// Deps:
//   frame      — ref to the viewer's native pixel frame (utils/imageViewport.js
//                imageFrame; null until the bitmap has loaded). The canvas is sized
//                from it — the NATIVE size, never the displayed bitmap's, which is
//                ~20× smaller while a TIFF preview is shown — and is not built for
//                a preview frame at all (initDepthCanvas is a no-op then; the viewer
//                calls it again once the full-resolution bitmap loads).
//   image      — getter returning the current image record (reads `.depth`)
//   drawOverlay— schedule an overlay repaint
//   emit       — component emit, for 'update-depth'
export function useDepthOverlay({ frame, image, drawOverlay, emit }) {
  const depthFileInput = ref(null)
  const depthCanvas = shallowRef(null)
  const hasDepth = ref(!!image().depth)
  // Latest wins (utils/revision.js): a decode that lands after a newer load, import
  // or clear must not repaint the canvas, and an export of a superseded state is
  // not emitted.
  const rev = createRevision()

  function initDepthCanvas() {
    const f = frame.value
    if (!f || f.preview) return
    depthCanvas.value = new OffscreenCanvas(f.width, f.height)
    if (image().depth?.blob) loadDepthBlob(image().depth.blob)
  }

  // Already-colorized depth previews are PNG Blobs (the store's `{ blob, url }`
  // record); just blit them in.
  async function loadDepthBlob(blob) {
    const canvas = depthCanvas.value
    if (!canvas) return
    const t = rev.bump()
    try {
      const bmp  = await createImageBitmap(blob)
      if (!rev.isCurrent(t) || depthCanvas.value !== canvas) return
      const ctx  = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height)
      hasDepth.value = true
      drawOverlay()
    } catch {}
  }

  function triggerDepthImport() {
    depthFileInput.value?.click()
  }

  // Import a (typically grayscale) depth image, normalize by luminance, and
  // store a colorized version. Fully transparent / zero pixels are "no data".
  async function onDepthFileChange(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    const canvas = depthCanvas.value
    if (!file || !canvas) return
    const t = rev.bump()
    try {
      const bmp    = await createImageBitmap(file)
      if (!rev.isCurrent(t) || depthCanvas.value !== canvas) return
      const tmp    = new OffscreenCanvas(canvas.width, canvas.height)
      const tmpCtx = tmp.getContext('2d')
      tmpCtx.drawImage(bmp, 0, 0, tmp.width, tmp.height)
      const id = tmpCtx.getImageData(0, 0, tmp.width, tmp.height)
      const d  = id.data

      // Find min/max luminance over valid pixels for contrast normalization.
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue
        const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        if (lum < lo) lo = lum
        if (lum > hi) hi = lum
      }
      const range = hi - lo || 1

      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) { d[i + 3] = 0; continue }
        const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        const t = (lum - lo) / range
        const [r, g, b] = depthColor(t)
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
      }
      const ctx = canvas.getContext('2d')
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.putImageData(id, 0, 0)
      hasDepth.value = true
      await exportDepth()
      drawOverlay()
    } catch (err) {
      console.error('Failed to import depth map:', err)
    }
  }

  async function exportDepth() {
    const canvas = depthCanvas.value
    if (!canvas) return
    const t = rev.current()
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    if (rev.isCurrent(t)) emit('update-depth', blob)
  }

  function clearDepth() {
    const canvas = depthCanvas.value
    if (!canvas) return
    rev.bump()
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    hasDepth.value = false
    emit('update-depth', null)
    drawOverlay()
  }

  // Sync the canvas when the parent clears or replaces the depth map externally.
  watch(() => image().depth, (depth, prev) => {
    if (depth === prev) return
    const canvas = depthCanvas.value
    if (depth?.blob && canvas) {
      loadDepthBlob(depth.blob)
    } else if (!depth && canvas) {
      rev.bump()
      canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
      hasDepth.value = false
      drawOverlay()
    }
  })

  return {
    depthFileInput, depthCanvas, hasDepth,
    initDepthCanvas, triggerDepthImport, onDepthFileChange, clearDepth,
  }
}
