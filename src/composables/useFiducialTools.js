import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { CORNER_SLOTS, SIDE_SLOTS, isFiducialCalibrated } from '../core/sfm/fiducialModel.js'
import { useLog } from './useLog.js'

// Film-camera fiducials in the UI, lifted out of App.vue: which film sensor the
// Detect / Calibrate dialogs work on, the marks the image view draws for an image
// (calibrated marks, or the raw slots before calibration), and placing one by hand.
export function useFiducialTools() {
  const { log } = useLog()
  const imagesStore = useImagesStore()
  const { images } = storeToRefs(imagesStore)
  const { imageById, setFiducialDetection } = imagesStore
  const { sensors } = storeToRefs(useSensorsStore())
  const {
    sensorTableOpen,
    fiducialDetectOpen,
    fiducialDetectSensorId,
    fiducialCalibrateOpen,
    fiducialCalibrateSensorId,
  } = storeToRefs(useModalsStore())

  // Resolve the (film) sensor for an image id — feeds the viewer's fiducial menu.
  function sensorForImage(imageId) {
    const img = imageById(imageId)
    return img?.sensorId ? sensors.value.find((s) => s.id === img.sensorId) : null
  }

  // Detection and calibration target one film sensor independently. Detection only
  // sees that sensor's images; calibration joins the stored anonymous slots later.
  const fiducialDetectSensor = computed(() =>
    fiducialDetectSensorId.value ? (sensors.value.find((s) => s.id === fiducialDetectSensorId.value) ?? null) : null,
  )
  const fiducialDetectImages = computed(() =>
    fiducialDetectSensor.value ? images.value.filter((i) => i.sensorId === fiducialDetectSensor.value.id) : [],
  )
  const fiducialCalibrateSensor = computed(() =>
    fiducialCalibrateSensorId.value
      ? (sensors.value.find((s) => s.id === fiducialCalibrateSensorId.value) ?? null)
      : null,
  )
  const fiducialCalibrateImages = computed(() =>
    fiducialCalibrateSensor.value ? images.value.filter((i) => i.sensorId === fiducialCalibrateSensor.value.id) : [],
  )

  // Both entry points stay reachable for every film sensor. Calibration directs the
  // user to detection when no accepted spots exist yet.
  const filmSensors = computed(() => sensors.value.filter((s) => s.kind === 'film'))

  function fiducialDisplayForImage(imageId) {
    const img = imageById(imageId),
      sensor = sensorForImage(imageId)
    const detections = img?.fiducialDetections || []
    const cal = sensor?.fiducialCalibration
    if (isFiducialCalibrated(cal)) {
      const byId = new Map(cal.marks.map((m) => [m.id, m]))
      return {
        marks: cal.marks,
        transform: cal.transform || 'affine',
        obs: detections.flatMap((d) => {
          const fidId = cal.slotMap?.[d.slot]
          return byId.has(fidId) ? [{ fidId, px: d.px, py: d.py, slot: d.slot }] : []
        }),
      }
    }
    // Before calibration a mark IS its slot. Offer every slot, not only the ones
    // detected here — otherwise a slot the detector missed (or an image where it
    // found nothing) could never be placed by hand.
    const slots = [...CORNER_SLOTS, ...SIDE_SLOTS]
    for (const d of detections) if (!slots.includes(d.slot)) slots.push(d.slot)
    return {
      marks: slots.map((id) => ({ id })),
      transform: 'affine',
      obs: detections.map((d) => ({ fidId: d.slot, px: d.px, py: d.py, slot: d.slot })),
    }
  }

  function markDisplayedFiducial(imageId, { fidId, px, py }) {
    const cal = sensorForImage(imageId)?.fiducialCalibration
    const slot = isFiducialCalibrated(cal) ? Object.keys(cal.slotMap).find((s) => cal.slotMap[s] === fidId) : fidId
    if (slot)
      setFiducialDetection(imageId, { slot, px, py, family: 'manual', source: 'manual', confidence: 1, reviewed: true })
  }

  // Ribbon entry. With one candidate sensor go straight to the modal; with several
  // there is no way to know which is meant, so hand off to the sensor table — the
  // home of film-sensor actions, where each row has its own button.
  function openFiducialDetect() {
    const candidates = filmSensors.value
    if (candidates.length === 1) {
      fiducialDetectSensorId.value = candidates[0].id
      fiducialDetectOpen.value = true
      return
    }
    sensorTableOpen.value = true
    log(`${candidates.length} film sensors available — pick one and use "Detect fiducials…"`, 'info', 'Fiducial')
  }

  function openFiducialCalibrate() {
    const candidates = filmSensors.value
    if (candidates.length === 1) {
      fiducialCalibrateSensorId.value = candidates[0].id
      fiducialCalibrateOpen.value = true
      return
    }
    sensorTableOpen.value = true
    log(`${candidates.length} film sensors available — pick one and use "Calibrate fiducials…"`, 'info', 'Fiducial')
  }

  return {
    fiducialDetectSensor,
    fiducialDetectImages,
    fiducialCalibrateSensor,
    fiducialCalibrateImages,
    filmSensors,
    sensorForImage,
    fiducialDisplayForImage,
    markDisplayedFiducial,
    openFiducialDetect,
    openFiducialCalibrate,
  }
}
