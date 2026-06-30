import { ref } from 'vue'
import { terminateAll } from '../workers/computeClient.js'

// images:           Ref<Array>    — current image list, used to count pending work
// detectAll:        function      — from useImagesStore
// matchAll:         function      — from useMatchesStore
// onImageDetected:  function      — from useTabs, called after each detection to update overlays
// reconstruct:      function      — from useReconstructionStore
// computeDepthMaps:  function      — from useReconstructionStore (dense Stage A)
// densify:          function      — from useReconstructionStore (dense Stage B)
export function usePipeline({ images, detectAll, matchAll, onImageDetected, reconstruct, computeDepthMaps, densify }) {
  const progressOpen    = ref(false)
  const progressTitle   = ref('')
  const progressCurrent = ref(0)
  const progressTotal   = ref(0)
  const progressLabel   = ref('')

  // Cancellation. Loop-based ops (detect/match) poll `aborted` between items;
  // single-call ops (reconstruct) register a hard-cancel via `cancelImpl`.
  const aborted     = ref(false)
  let cancelImpl    = null
  const shouldCancel = () => aborted.value

  function openProgress(title, total = 0, onCancel = null) {
    progressTitle.value   = title
    progressCurrent.value = 0
    progressTotal.value   = total
    progressLabel.value   = ''
    aborted.value         = false
    cancelImpl            = onCancel
    progressOpen.value    = true
  }

  // Invoked by the progress modal's Cancel button.
  function cancelRun() {
    aborted.value = true
    progressLabel.value = 'Cancelling…'
    cancelImpl?.()
  }

  async function runDetect(settings) {
    const pending = settings.overwrite
      ? images.value
      : images.value.filter((img) => img.kpStatus !== 'done')
    if (pending.length === 0) return
    openProgress('Detecting Features', pending.length)
    await detectAll(settings, onImageDetected, (done, total, name) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = name ?? ''
    }, shouldCancel)
    progressOpen.value = false
  }

  async function runMatch(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done')
    if (ready.length < 2) return
    openProgress('Matching Features')
    await matchAll(images.value, settings, (done, total) => {
      progressCurrent.value = done
      progressTotal.value   = total
    }, shouldCancel)
    progressOpen.value = false
  }

  async function runReconstruct(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done')
    if (ready.length < 2) return
    // Reconstruct is a single worker call — cancel by terminating the worker
    // (the store catches the resulting rejection and resets its status).
    openProgress('Sparse Reconstruction', ready.length, () => terminateAll('reconstruction cancelled'))
    await reconstruct(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  // Dense Stage A — Build Depth Maps (PatchMatch MVS). Single worker call; cancel
  // by terminating the worker (the store catches the rejection and resets status).
  async function runComputeDepthMaps(settings) {
    openProgress('Building Depth Maps', images.value.length, () => terminateAll('depth maps cancelled'))
    await computeDepthMaps(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  // Dense Stage B — fuse the depth maps into the dense cloud.
  async function runDensify(settings) {
    openProgress('Building Dense Cloud', 1, () => terminateAll('densify cancelled'))
    await densify(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  return {
    progressOpen,
    progressTitle,
    progressCurrent,
    progressTotal,
    progressLabel,
    cancelRun,
    runDetect,
    runMatch,
    runReconstruct,
    runComputeDepthMaps,
    runDensify,
  }
}
