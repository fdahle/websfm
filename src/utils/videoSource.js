import {
  VIDEO_ANALYSIS, createMotionTracker, estimateFps, fitSize, frameFileName, lumaOf, scoreFrame,
} from '../core/io/videoFrames.js'
import { THUMB_MAX_DIM, THUMB_QUALITY, thumbnailSize } from './thumbnail.js'

// A video file read through the browser's own <video> element: it demuxes and
// decodes whatever container and codec this browser plays, so no demuxer ships with
// the app. Frames are taken by seeking (`currentTime` → 'seeked') and drawing the
// element onto a canvas. Seeking keeps the analysis deterministic — the same video
// gives the same samples, hence the same frames, on every run — and works in a
// background tab, where playback would be throttled.
//
// WebCodecs' VideoDecoder was considered: it decodes faster for long sequential
// reads, but it takes encoded chunks, so the app would also need a demuxer per
// container (MP4, WebM, MOV …). With a few samples per second for analysis and a few
// hundred frames to extract, the seek path is fast enough and has no such dependency.

const SEEK_TIMEOUT_MS = 15000

function mediaErrorMessage(err) {
  switch (err?.code) {
    case 1: return 'reading the video was aborted'
    case 2: return 'a network error interrupted reading the video'
    case 3: return 'the video could not be decoded (damaged, or a codec variant this browser cannot play)'
    case 4: return 'this browser cannot play this video format or codec'
    default: return err?.message || 'the video could not be read'
  }
}

function waitFor(video, ok, { timeout = SEEK_TIMEOUT_MS, what = 'the video' } = {}) {
  return new Promise((resolve, reject) => {
    const events = Array.isArray(ok) ? ok : [ok]
    const done = (fn, arg) => {
      clearTimeout(timer)
      for (const e of events) video.removeEventListener(e, onOk)
      video.removeEventListener('error', onError)
      fn(arg)
    }
    const onOk = () => done(resolve)
    const onError = () => done(reject, new Error(mediaErrorMessage(video.error)))
    const timer = setTimeout(() => done(reject, new Error(`timed out waiting for ${what}`)), timeout)
    for (const e of events) video.addEventListener(e, onOk, { once: true })
    video.addEventListener('error', onError, { once: true })
  })
}

// requestVideoFrameCallback reports the media time of each presented frame. Played
// for a moment, those times give the frame rate (which <video> does not expose),
// needed for "every N frames". null where the callback is missing or nothing plays.
async function probeFps(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return null
  const times = []
  await new Promise((resolve) => {
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      video.pause()
      resolve()
    }
    const onFrame = (_now, meta) => {
      times.push(meta.mediaTime)
      if (times.length >= 16 || finished) finish()
      else video.requestVideoFrameCallback(onFrame)
    }
    const timer = setTimeout(finish, 2000)
    video.requestVideoFrameCallback(onFrame)
    video.addEventListener('ended', finish, { once: true })
    const played = video.play()
    if (played?.catch) played.catch(finish)
  })
  return estimateFps(times)
}

/**
 * Open a video File for frame reads.
 * → { name, duration, width, height, fps, seek(t), luma(maxDim), encode(opts), close() }
 * Throws with a readable message when this browser cannot decode the file.
 */
export async function openVideoSource(file, { probeRate = true } = {}) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  // Kept in the document (invisibly): some engines neither load nor present frames
  // for a detached element.
  Object.assign(video.style, {
    position: 'fixed', left: '0', top: '0', width: '2px', height: '2px',
    opacity: '0', pointerEvents: 'none', zIndex: '-1',
  })
  document.body.appendChild(video)
  const close = () => {
    video.pause()
    video.removeAttribute('src')
    video.load()
    video.remove()
    URL.revokeObjectURL(url)
  }
  try {
    const loaded = waitFor(video, 'loadeddata', { what: 'the first frame' })
    video.src = url
    await loaded
    let duration = video.duration
    // A WebM written by MediaRecorder has no duration in its header: seeking far past
    // the end makes the element find it.
    if (!Number.isFinite(duration)) {
      const found = waitFor(video, ['durationchange', 'seeked'], { what: 'the video length' })
      video.currentTime = 1e9
      await found
      duration = video.duration
      const back = waitFor(video, 'seeked', { what: 'a seek' })
      video.currentTime = 0
      await back
    }
    const width = video.videoWidth, height = video.videoHeight
    if (!width || !height) throw new Error('the file has no video track this browser can show')
    if (!(duration > 0) || !Number.isFinite(duration)) throw new Error('the video length could not be read')
    const fps = probeRate ? await probeFps(video) : null
    return makeSource({ video, name: file.name, duration, width, height, fps, close })
  } catch (err) {
    close()
    throw err
  }
}

function makeSource({ video, name, duration, width, height, fps, close }) {
  let small = null
  let full = null

  async function seek(t) {
    const target = Math.min(Math.max(0, t), Math.max(0, duration - 1e-3))
    video.pause()
    if (video.readyState >= 2 && Math.abs(video.currentTime - target) < 1e-6 && !video.seeking) return
    const seeked = waitFor(video, 'seeked', { what: `the frame at ${target.toFixed(3)} s` })
    video.currentTime = target
    await seeked
  }

  // The current frame as luma (0..1), long side at most `maxDim`.
  function luma(maxDim = VIDEO_ANALYSIS.sharpDim) {
    const { width: w, height: h } = fitSize(width, height, maxDim)
    small ??= document.createElement('canvas')
    if (small.width !== w || small.height !== h) { small.width = w; small.height = h }
    const ctx = small.getContext('2d', { willReadFrequently: true })
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(video, 0, 0, w, h)
    return { data: lumaOf(ctx.getImageData(0, 0, w, h).data, w, h), w, h }
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('the frame could not be encoded'))), type, quality))
  }

  // The current frame encoded as an image file, plus a list thumbnail of it (so
  // the image list never decodes the full frame).
  async function encode({ maxDim = 0, format = 'jpeg', quality = 0.95 } = {}) {
    const { width: w, height: h } = fitSize(width, height, maxDim)
    full ??= document.createElement('canvas')
    if (full.width !== w || full.height !== h) { full.width = w; full.height = h }
    const ctx = full.getContext('2d')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(video, 0, 0, w, h)
    const type = format === 'png' ? 'image/png' : 'image/jpeg'
    const blob = await toBlob(full, type, format === 'png' ? undefined : quality)
    const ts = thumbnailSize(w, h, THUMB_MAX_DIM)
    const thumbCanvas = document.createElement('canvas')
    thumbCanvas.width = ts.width; thumbCanvas.height = ts.height
    const tctx = thumbCanvas.getContext('2d')
    tctx.imageSmoothingQuality = 'high'
    tctx.drawImage(full, 0, 0, ts.width, ts.height)
    const thumb = await toBlob(thumbCanvas, 'image/jpeg', THUMB_QUALITY)
    return { blob, thumb, width: w, height: h, type }
  }

  return { name, duration, width, height, fps, seek, luma, encode, close }
}

/**
 * The auto mode's analysis pass: seek to each time, score sharpness and accumulate
 * travel. `onProgress(done, total)`; `shouldCancel()` stops early (returns null).
 * → [{ t, sharpness, travel, fast, lost }]
 */
export async function analyzeVideo(source, times, { onProgress = null, shouldCancel = null } = {}) {
  const tracker = createMotionTracker()
  const samples = []
  for (let i = 0; i < times.length; i++) {
    if (shouldCancel?.()) return null
    await source.seek(times[i])
    const { data, w, h } = source.luma(VIDEO_ANALYSIS.sharpDim)
    const s = scoreFrame(data, w, h)
    const m = tracker.push(s.motion, s.motionW, s.motionH)
    samples.push({ t: times[i], sharpness: s.sharpness, travel: m.travel, fast: m.fast, lost: m.lost })
    onProgress?.(i + 1, times.length)
  }
  return samples
}

// Frames handed to the image store per call. Small, so only a few encoded frames
// are ever in memory: each batch is written to the project and read back from there
// (addImages' `fromStorage`) while the next one is encoded.
const EXTRACT_BATCH = 4

/**
 * Extract the frames at `times` as image files and add them to the project through
 * `addImages(files, onProgress, options)` (useImagesStore.addImages). Each frame is
 * named `<video>_<timestamp>.<ext>` and carries `videoSource` / `videoTime` in its
 * metadata (the frame time; shared sensor and sequential matching key off it).
 * `shouldCancel()` stops after the current frame; frames already added stay.
 * → { added, cancelled }
 */
export async function extractVideoFrames({
  file, times, duration, fps = null, settings, addImages, onProgress = null, shouldCancel = null,
}) {
  const source = await openVideoSource(file, { probeRate: false })
  const ext = settings.format === 'png' ? 'png' : 'jpg'
  const length = duration ?? source.duration
  let batch = []
  let pending = Promise.resolve()
  let added = 0
  const flush = async () => {
    if (!batch.length) return
    const items = batch
    batch = []
    await pending
    pending = addImages(items.map((i) => i.file), null, {
      extras: new Map(items.map((i) => [i.file, i.extra])),
      fromStorage: true,
    })
  }
  try {
    for (let i = 0; i < times.length; i++) {
      if (shouldCancel?.()) break
      const t = times[i]
      await source.seek(t)
      const enc = await source.encode({ maxDim: settings.maxDim, format: settings.format, quality: settings.jpegQuality })
      const name = frameFileName(file.name, t, length, ext)
      const frame = new File([enc.blob], name, { type: enc.type, lastModified: file.lastModified })
      batch.push({
        file: frame,
        extra: {
          meta: { videoSource: file.name, videoTime: t, ...(fps ? { videoFps: fps } : {}) },
          dims: { width: enc.width, height: enc.height },
          thumb: enc.thumb,
        },
      })
      added++
      if (batch.length >= EXTRACT_BATCH) await flush()
      onProgress?.(i + 1, times.length, name)
    }
    await flush()
    await pending
  } finally {
    source.close()
  }
  return { added, cancelled: added < times.length }
}
