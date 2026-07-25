import { ref, shallowRef, watch } from 'vue'
import { depthColor } from '../core/products/colormap.js'

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
//   imgEl      — ref to the <img>, for the native dimensions
//   image      — getter returning the current image record (reads `.depth`)
//   drawOverlay— schedule an overlay repaint
//   emit       — component emit, for 'update-depth'
export function useDepthOverlay({ imgEl, image, drawOverlay, emit }) {
  const depthFileInput = ref(null)
  const depthCanvas = shallowRef(null)
  const hasDepth = ref(!!image().depth)

  function initDepthCanvas() {
    const img = imgEl.value
    if (!img || !img.naturalWidth) return
    depthCanvas.value = new OffscreenCanvas(img.naturalWidth, img.naturalHeight)
    if (image().depth?.dataUrl) loadDepthFromDataUrl(image().depth.dataUrl)
  }

  // Already-colorized depth maps are stored as PNG data URLs; just blit them in.
  async function loadDepthFromDataUrl(dataUrl) {
    const canvas = depthCanvas.value
    if (!canvas) return
    try {
      const blob = await (await fetch(dataUrl)).blob()
      const bmp  = await createImageBitmap(blob)
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
    try {
      const bmp    = await createImageBitmap(file)
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
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const dataUrl = await new Promise((resolve) => {
      const fr = new FileReader()
      fr.onload = () => resolve(fr.result)
      fr.readAsDataURL(blob)
    })
    emit('update-depth', dataUrl)
  }

  function clearDepth() {
    const canvas = depthCanvas.value
    if (!canvas) return
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
    hasDepth.value = false
    emit('update-depth', null)
    drawOverlay()
  }

  // Sync the canvas when the parent clears or replaces the depth map externally.
  watch(() => image().depth, (depth, prev) => {
    if (depth === prev) return
    const canvas = depthCanvas.value
    if (depth?.dataUrl && canvas) {
      loadDepthFromDataUrl(depth.dataUrl)
    } else if (!depth && canvas) {
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
