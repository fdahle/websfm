import { shallowRef, computed, watch } from 'vue'
import { keypointResponseRange } from '../utils/imageOverlay.js'

// The image viewer's keypoint overlay data: this image's keypoints, read on demand
// (images store `ensureKeypoints` — they are not on the record) while the overlay
// is on. Re-read when the image is switched or its keypoints are replaced
// (`kpRev`). A shallowRef: the set is never reactive.
//
// Deps:
//   image  — getter returning the current image record
//   show   — getter: is the keypoint overlay on
//   store  — the images store (residentKeypoints / ensureKeypoints)
export function useImageKeypoints({ image, show, store }) {
  const keypoints = shallowRef(null)
  let keypointRequest = 0
  watch(
    [() => image().id, () => image().kpRev, () => image().kpStatus, show],
    async () => {
      const req = ++keypointRequest
      // Never draw the previous image's (or the replaced) set while the new one loads.
      keypoints.value = store.residentKeypoints(image())
      if (keypoints.value || !show() || image().kpStatus !== 'done') return
      const kps = await store.ensureKeypoints(image())
      if (req === keypointRequest) keypoints.value = kps
    },
    { immediate: true },
  )

  // Keypoint response range, for the cold→hot colour ramp. Recomputed only when the
  // keypoint array itself is replaced (re-detect / image switch), not on every draw —
  // it is a full pass over up to tens of thousands of points.
  const keypointRange = computed(() => keypointResponseRange(keypoints.value))

  return { keypoints, keypointRange }
}
