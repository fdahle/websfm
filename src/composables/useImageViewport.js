import { ref, shallowRef, computed, watch } from 'vue'
import { imageFrame, fitView, zoomAbout, screenToImage } from '../utils/imageViewport.js'

// Pan/zoom state of the image viewer (components/viewers/ViewerImage.vue) and the
// native pixel frame it works in. The math is in utils/imageViewport.js; this owns
// the reactive state, the fit/zoom actions, the ResizeObserver refit and the
// frame's lifecycle across url swaps (image switch, TIFF preview → full res).
//
// `scale` is screen px per NATIVE px, and every emitted/drawn coordinate is native,
// even while the bitmap is the ≤512 px TIFF transcode preview (`frame`).
//
// Panning itself stays with the component's pointer router, which writes tx/ty
// directly from its drag-start state.
//
// Deps:
//   container     — ref to the viewport element (measured for fit, zoom centre)
//   imgEl         — ref to the <img> (its bitmap size)
//   image         — getter returning the current image record
//   onViewChange  — schedule an overlay repaint (after fit / zoom)
//   onFrameChange — the native frame was re-derived to a different size or
//                   preview state after load (late TIFF metadata) and refitted
const MIN_SCALE = 0.05
const MAX_SCALE = 40

export function useImageViewport({ container, imgEl, image, onViewChange, onFrameChange }) {
  const scale = ref(1)
  const tx = ref(0)
  const ty = ref(0)

  // True once the current image has loaded AND been fitted to the viewport —
  // gates the <img> visibility so the browser never paints it at native
  // (potentially huge) size for a frame before fit() scales it down.
  const imageReady = ref(false)

  // The native pixel frame the loaded bitmap stands for (utils/imageViewport.js).
  // null until the current `url` has loaded.
  const frame = shallowRef(null)
  // Editing (mask tools, GCP/fiducial marking) waits for the full-resolution
  // bitmap: a mark placed on a ~20× reduced preview is that imprecise, and the mask
  // canvas is (re)built when the full-res image loads, which would drop or race any
  // edit made before. Overlays still draw (correctly mapped) meanwhile.
  const editable = computed(() => imageReady.value && !!frame.value && !frame.value.preview)

  let resizeObserver = null
  let lastSize = null // { w, h } container size of the last successful fit (null = fit pending)

  // `url` is the transcode preview (stores/images/ingest.js sets lowResUrl to it).
  const showingLowRes = () => !!image().lowResUrl && image().lowResUrl === image().url

  function refreshFrame() {
    const img = imgEl.value
    frame.value = img?.naturalWidth
      ? imageFrame({
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          metaWidth: image().meta?.width,
          metaHeight: image().meta?.height,
          lowRes: showingLowRes(),
        })
      : null
  }

  // Fit the image to the viewport. A v-show-hidden tab measures 0×0 (e.g. an image
  // that finishes loading in a background tab after a reload): fitting there gave
  // scale 0 and a later wheel zoom NaN offsets. Instead the fit is deferred —
  // `lastSize` is cleared so the ResizeObserver refits once the tab has a size.
  // Returns whether it fitted; a successful fit also reveals the image.
  function fit() {
    const c = container.value
    const f = frame.value
    if (!c || !f) return false
    const v = fitView(c.clientWidth, c.clientHeight, f.width, f.height)
    if (!v) {
      lastSize = null
      return false
    }
    scale.value = v.scale
    tx.value = v.tx
    ty.value = v.ty
    lastSize = { w: c.clientWidth, h: c.clientHeight }
    imageReady.value = true
    onViewChange()
    return true
  }

  // Zoom by `factor` keeping the viewport point (cx, cy) fixed on screen.
  function zoomAt(factor, cx, cy) {
    const v = zoomAbout({ scale: scale.value, tx: tx.value, ty: ty.value }, factor, cx, cy, MIN_SCALE, MAX_SCALE)
    scale.value = v.scale
    tx.value = v.tx
    ty.value = v.ty
    onViewChange()
  }

  function applyZoom(factor) {
    const c = container.value
    if (!c) return
    zoomAt(factor, c.clientWidth / 2, c.clientHeight / 2)
  }

  function zoomIn() {
    applyZoom(1.5)
  }
  function zoomOut() {
    applyZoom(1 / 1.5)
  }
  // Zoom to `s` screen px per native px about the viewport centre (the status bar's
  // typed zoom).
  function zoomTo(s) {
    if (scale.value > 0) applyZoom(s / scale.value)
  }

  // Event → viewport-relative coords.
  function getViewportCoords(e) {
    const rect = container.value.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // Convert viewport coords to native image pixel coords (clamped to the image).
  // Always through the native frame — while a TIFF preview is shown the bitmap is
  // far smaller than the image, and its pixel coords would be stored scaled down.
  // Null while the native size is unknown (utils/imageViewport.js screenToImage).
  function toImagePixel(sx, sy) {
    return screenToImage(sx, sy, { scale: scale.value, tx: tx.value, ty: ty.value }, frame.value)
  }

  // Only refit on a *real* viewport change. A v-show-hidden tab collapses to 0×0
  // and springs back to its old size when reactivated — refitting on that would
  // throw away the zoom/pan the user left the tab with. Started/stopped by the
  // component's mount hooks (it orders them against its other setup/teardown).
  function observeResize() {
    resizeObserver = new ResizeObserver(() => {
      const c = container.value
      if (!c) return
      const w = c.clientWidth,
        h = c.clientHeight
      if (!w || !h) return
      // lastSize is null while a fit is pending (deferred at 0×0) → fit now.
      if (lastSize && lastSize.w === w && lastSize.h === h) return
      fit() // records lastSize
    })
    if (container.value) resizeObserver.observe(container.value)
  }

  function disconnectResize() {
    resizeObserver?.disconnect()
  }

  // A new `url` means a new decode (image switch, or the TIFF thumbnail →
  // full-res swap) — hide the old frame until the new one has loaded and been
  // fitted, instead of flashing native size or a stale image.
  watch(
    () => image().url,
    () => {
      imageReady.value = false
      frame.value = null
    },
  )

  // The native size can arrive after the preview bitmap has loaded (TIFF metadata
  // is read alongside the transcode). Re-derive the frame and refit if it changed.
  watch(
    () => [image().meta?.width, image().meta?.height],
    () => {
      if (!frame.value) return
      const prev = frame.value
      refreshFrame()
      const f = frame.value
      if (f && (f.width !== prev.width || f.height !== prev.height || f.preview !== prev.preview)) {
        fit()
        onFrameChange()
      }
    },
  )

  return {
    scale,
    tx,
    ty,
    imageReady,
    frame,
    editable,
    refreshFrame,
    fit,
    zoomAt,
    zoomIn,
    zoomOut,
    zoomTo,
    getViewportCoords,
    toImagePixel,
    observeResize,
    disconnectResize,
  }
}
