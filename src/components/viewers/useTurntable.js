// The turntable in the 3D view (Viewer3D.vue; View ▸ Camera ▸ Turntable): the camera
// circles the orbit centre about the scene's up axis, so the model turns
// counter-clockwise seen from above. "Record one turn" saves exactly one turn of the
// view as a video (core/products/turntable.js). `view` reads the renderer state live.
import * as THREE from 'three'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { recorderBitrate, recorderFormat, turntableStep } from '../../core/products/turntable.js'
import { useViewerSettings } from '../../composables/useViewerSettings.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { downloadBlob } from '../../utils/download.js'

// controls(): the current OrbitControls (Viewer3D rebuilds them when up changes).
// alignUp(): puts the camera's up on the scene's up, so the turn is level.
export function useTurntable({ view, controls, alignUp, container, requestRender, emit }) {
  const { turntableSeconds, setTurntableSeconds } = useViewerSettings()
  const { currentProjectName } = storeToRefs(useProjectsStore())

  const turntableOn = ref(false)
  const recording = ref(false)
  const recordProgress = ref(0) // share of the turn recorded, 0..1
  const recordError = ref('')

  let lastTime = null
  // A mouse button or finger is down on the view: the user steers, the turn waits.
  let held = false
  // Radians turned since the recording started; null while none runs.
  let turned = null
  let recorder = null
  const offset = new THREE.Vector3()

  function setTurntable(on) {
    if (turntableOn.value === on) return
    if (!on) stopRecording(false)
    turntableOn.value = on
    lastTime = null
    emit('turntable', on)
    requestRender()
  }
  const toggleTurntable = () => setTurntable(!turntableOn.value)

  // Turns the camera for the frame drawn at `now` (ms), before the controls update.
  // True while the turntable runs, so the render loop asks for the next frame.
  function stepTurntable(now) {
    if (!turntableOn.value) return false
    const dt = lastTime == null ? 0 : (now - lastTime) / 1000
    lastTime = now
    if (held && turned == null) return true
    alignUp()
    const c = controls()
    const camera = view.camera
    if (!c || !camera) return true
    // Nothing may steer a recording; a view preset during it rebuilds the controls.
    c.enabled = turned == null
    const { angle, done } = turntableStep(dt, turntableSeconds.value, turned)
    offset.copy(camera.position).sub(c.target).applyAxisAngle(camera.up, -angle)
    camera.position.copy(c.target).add(offset)
    if (turned != null) {
      turned += angle
      recordProgress.value = turned / (2 * Math.PI)
      // This frame shows the start pose again: stop before it is captured, so the
      // video loops without a repeated frame.
      if (done) stopRecording(true)
    }
    return true
  }

  function fileBase() {
    const name = String(currentProjectName.value ?? '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '')
    return name || 'websfm'
  }

  // One turn of the canvas as drawn, with the browser's MediaRecorder. The turn starts
  // when the recorder does, so its first frames are not lost.
  function recordTurn() {
    const canvas = view.renderer?.domElement
    if (!canvas || recording.value) return
    const format =
      typeof MediaRecorder === 'undefined' || !canvas.captureStream
        ? null
        : recorderFormat((t) => MediaRecorder.isTypeSupported(t))
    if (!format) {
      recordError.value = 'This browser cannot record the 3D view.'
      return
    }
    recordError.value = ''
    setTurntable(true)
    const chunks = []
    const rec = new MediaRecorder(canvas.captureStream(), {
      mimeType: format.mime,
      videoBitsPerSecond: recorderBitrate(canvas.width, canvas.height),
    })
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.onstart = () => {
      if (recorder !== rec) return
      turned = 0
      lastTime = null
      requestRender()
    }
    rec.onstop = () => {
      for (const track of rec.stream.getTracks()) track.stop()
      if (rec.keep && chunks.length) {
        downloadBlob(`${fileBase()}-turntable.${format.ext}`, new Blob(chunks, { type: format.mime }))
      }
    }
    rec.onerror = (e) => {
      recordError.value = `Recording failed: ${e.error?.message ?? 'unknown error'}`
      stopRecording(false)
    }
    recorder = rec
    recording.value = true
    recordProgress.value = 0
    rec.start(1000)
  }

  // `keep`: save the video (a finished turn); otherwise drop it (cancel, turntable off).
  function stopRecording(keep) {
    const rec = recorder
    if (!rec) return
    recorder = null
    rec.keep = keep
    if (rec.state !== 'inactive') rec.stop()
    turned = null
    recording.value = false
    recordProgress.value = 0
    const c = controls()
    if (c) c.enabled = true
  }

  function onPointerDown() {
    held = true
  }
  function onPointerUp() {
    if (!held) return
    held = false
    lastTime = null
    requestRender()
  }
  onMounted(() => {
    container.value?.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  })
  onBeforeUnmount(() => {
    stopRecording(false)
    container.value?.removeEventListener('pointerdown', onPointerDown, { capture: true })
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  })

  return {
    turntableOn,
    turntableSeconds,
    setTurntableSeconds,
    recording,
    recordProgress,
    recordError,
    setTurntable,
    toggleTurntable,
    stepTurntable,
    recordTurn,
    stopRecording,
  }
}
