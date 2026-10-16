import { computeSourceOf } from '../utils/image.js'
import { ref, shallowRef } from 'vue'
import { logitsToBinaryMask } from '../core/segment/sam2.js'
import { segmentEncode, segmentDecode, segmentForget } from '../workers/computeClient.js'
import { useModelsStore } from '../stores/useModelsStore.js'
import { createRevision } from '../utils/revision.js'

// "Smart Select" — SAM2 click-to-segment for the image view's mask tool.
//
// Owns only the SAM2 side: model consent, the per-image encode, the click points,
// the decode loop and the cyan candidate preview. It never touches the mask canvas,
// the undo stack or the store. Committing is expressed as
// `buildCommitCanvas(w, h)` — "here is the accepted segment as an OffscreenCanvas
// ready to blit" — which lets the caller keep snapshot/blit/export ordering and
// keeps this module out of the mask-editing domain entirely.
//
// Two resolutions are in play and the difference is deliberate: the PREVIEW is
// rasterized at the encoded raster size (fast, and the smoothed overlay hides its
// coarseness), while the COMMIT re-upsamples the same raw 256² logits straight to
// native image resolution — a much finer boundary than scaling a pre-thresholded
// low-res mask up.
//
// Deps: image() → the current image record; nativeSize() → { width, height } of the
// image's native pixel frame (what click coordinates are in — NOT the displayed
// bitmap's size, which is smaller while a TIFF preview is shown); drawOverlay() →
// schedule an overlay repaint.
export function useSmartSelect({ image, nativeSize, drawOverlay }) {
  const modelsStore = useModelsStore()

  const smartStatus = ref('')            // toolbar status line
  const smartHasPreview = ref(false)     // a candidate segment is currently shown
  const smartPreviewCanvas = shallowRef(null) // cyan candidate overlay, drawn by renderOverlay

  let smartEnc = null      // { width, height } of the encoded raster (aspect-preserved ≤ maxDim)
  let smartPoints = []     // [{ x, y, positive }] in encoded-raster px
  let smartResult = null   // { logits:Float32Array, mw, mh } last decode (raw low-res)
  let smartBusy = false, smartDirty = false // coalesce overlapping decodes
  // Latest-wins tokens (utils/revision.js). A decode that resolves after the
  // candidate was discarded (Delete, tool switch, commit, image switch) must not
  // resurrect it — Enter would then commit a segment the user threw away. An
  // encode that resolves after a reset belongs to the previous image.
  const candidateRev = createRevision() // bumped by discardSmart (and so resetSmart)
  const encodeRev = createRevision()    // bumped by resetSmart

  // Build an OffscreenCanvas(w,h) painting `rgba` where the binary mask is 1, else
  // transparent. Used for both the cyan preview and the red commit blit.
  function buildMaskCanvas(mask, w, h, rgba) {
    const c = new OffscreenCanvas(w, h)
    const cx = c.getContext('2d')
    const id = cx.createImageData(w, h)
    const d = id.data
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) { d[i * 4] = rgba[0]; d[i * 4 + 1] = rgba[1]; d[i * 4 + 2] = rgba[2]; d[i * 4 + 3] = rgba[3] }
    }
    cx.putImageData(id, 0, 0)
    return c
  }

  // Encode the current image once (heavy, ~1s; the model itself loads once for the
  // whole session). Cached per uuid in the worker; smartEnc caches the raster dims.
  async function ensureEncoded() {
    if (smartEnc || smartStatus.value === 'encoding') return
    const img = image()
    if (!img?.uuid) return
    const rev = encodeRev.current()
    // SAM2 runs learned encoder + decoder models — fetch their weights (with
    // consent) before the first encode. Declining leaves Smart Select idle.
    smartStatus.value = 'loading model…'
    const ready = await modelsStore.ensureReady(['sam2_encoder', 'sam2_decoder'])
    if (!encodeRev.isCurrent(rev)) return // reset meanwhile — the new image owns the status
    if (!ready) {
      smartStatus.value = 'model not downloaded'
      return
    }
    smartStatus.value = 'encoding'
    try {
      const r = await segmentEncode(img.uuid, computeSourceOf(img))
      if (!encodeRev.isCurrent(rev)) {
        // Reset mid-encode (image switch): resetSmart already asked the worker to
        // forget this uuid, but the encode cached it afterwards — free it again.
        segmentForget(img.uuid)
        return
      }
      smartEnc = { width: r.width, height: r.height }
      smartStatus.value = 'ready — click an object'
    } catch (err) {
      if (!encodeRev.isCurrent(rev)) return
      smartStatus.value = 'encode failed'
      console.error('SAM2 encode failed:', err)
    }
  }

  // Decode the current smartPoints into a candidate segment, coalescing overlapping
  // clicks (one decode in flight; a click mid-decode re-runs afterward).
  async function runSmartDecode() {
    if (!smartEnc || !smartPoints.length) return
    if (smartBusy) { smartDirty = true; return }
    smartBusy = true
    smartStatus.value = 'segmenting…'
    try {
      do {
        smartDirty = false
        if (!smartEnc || !smartPoints.length) break // discarded/reset while the last decode ran
        const rev = candidateRev.current()
        const enc = smartEnc
        const pts = smartPoints.map((p) => ({ ...p }))
        const res = await segmentDecode(image().uuid, pts)
        // Discarded (or the image reset) while decoding: drop the stale segment. A
        // click made since then set smartDirty, so the loop re-runs for it.
        if (!candidateRev.isCurrent(rev)) continue
        smartResult = { logits: res.logits, mw: res.mw, mh: res.mh }
        const pv = logitsToBinaryMask(res.logits, res.mw, res.mh, enc.width, enc.height)
        smartPreviewCanvas.value = buildMaskCanvas(pv, enc.width, enc.height, [80, 200, 255, 255])
        smartHasPreview.value = true
        smartStatus.value = `preview · IoU ${res.iou?.toFixed?.(2) ?? '—'} — Enter to add`
        drawOverlay()
      } while (smartDirty)
    } catch (err) {
      if (smartPoints.length) smartStatus.value = 'segment failed' // not if discarded meanwhile
      console.error('SAM2 decode failed:', err)
    } finally {
      smartBusy = false
    }
  }

  // A click in the image (native px). Plain click = fresh single-point segment
  // (independent). Alt-click refines the current candidate by adding a negative
  // point (carves the region back). Coords map native px → encoded-raster px.
  async function smartClick(px, py, negative) {
    if (!smartEnc) { await ensureEncoded(); if (!smartEnc) return }
    const native = nativeSize()
    if (!(native?.width > 0) || !(native?.height > 0)) return
    const ex = px * smartEnc.width / native.width
    const ey = py * smartEnc.height / native.height
    if (negative && smartPoints.length) smartPoints.push({ x: ex, y: ey, positive: false })
    else smartPoints = [{ x: ex, y: ey, positive: true }]
    await runSmartDecode()
  }

  // The accepted segment as a red OffscreenCanvas at the caller's resolution, or
  // null when there is nothing to commit. Upsamples the raw logits to `w`×`h`
  // directly (see the resolution note above). Does NOT clear the preview — the
  // caller decides when, so it can snapshot/blit/export in its own order.
  function buildCommitCanvas(w, h) {
    if (!smartResult) return null
    const { logits, mw, mh } = smartResult
    return buildMaskCanvas(logitsToBinaryMask(logits, mw, mh, w, h), w, h, [255, 0, 0, 255])
  }

  // Drop the current candidate without touching the committed mask.
  function discardSmart() {
    candidateRev.bump() // an in-flight decode now belongs to a discarded candidate
    smartPoints = []
    smartResult = null
    smartPreviewCanvas.value = null
    smartHasPreview.value = false
    if (smartStatus.value !== 'encoding') smartStatus.value = smartEnc ? 'ready — click an object' : ''
    drawOverlay()
  }

  // Reset all Smart state (image switch / leaving edit). Frees the worker's cached
  // embedding for the old image.
  function resetSmart(forgetUuid) {
    encodeRev.bump() // an in-flight encode is for the previous image
    discardSmart()
    smartEnc = null
    smartStatus.value = ''
    if (forgetUuid) segmentForget(forgetUuid)
  }

  return {
    smartStatus, smartHasPreview, smartPreviewCanvas,
    ensureEncoded, smartClick, buildCommitCanvas, discardSmart, resetSmart,
  }
}
