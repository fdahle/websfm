// The 3D view's turntable (components/viewers/useTurntable.js): how far the camera
// turns in one frame, and how a recording of one full turn is encoded.
import { TURNTABLE_TUNING } from '../tuning.js'

const TWO_PI = 2 * Math.PI
// A frame later than this (a hidden tab, a slow level-of-detail load) turns as if it
// had taken this long, so the view never jumps.
const MAX_FRAME_SECONDS = 0.1

// The angle (radians) to turn in a frame that took `dtSeconds`. `turned` is the
// angle since a recording started (null while none runs): the recording's last step
// is cut short so the turn ends exactly where it began, and `done` marks it.
export function turntableStep(dtSeconds, secondsPerTurn, turned = null) {
  const dt = Math.min(Math.max(dtSeconds, 0), MAX_FRAME_SECONDS)
  const angle = (TWO_PI * dt) / secondsPerTurn
  if (turned == null) return { angle, done: false }
  if (turned + angle >= TWO_PI) return { angle: TWO_PI - turned, done: true }
  return { angle, done: false }
}

// In order of preference: VP9 where the browser has it (Chromium), VP8 (Firefox),
// then MP4 (Safari records only that).
const RECORDER_TYPES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']

// The first video type `isSupported` (MediaRecorder.isTypeSupported) accepts, with
// its file extension; null when the browser can record none of them.
export function recorderFormat(isSupported) {
  const mime = RECORDER_TYPES.find((t) => isSupported(t))
  if (!mime) return null
  return { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' }
}

// Bits per second for a recording of a `width`×`height` canvas.
export function recorderBitrate(width, height) {
  const { bitsPerPixel, minBitrate, maxBitrate } = TURNTABLE_TUNING
  return Math.round(Math.min(maxBitrate, Math.max(minBitrate, width * height * bitsPerPixel)))
}
