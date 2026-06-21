import { ref } from 'vue'

// images:           Ref<Array>    — current image list, used to count pending work
// detectAll:        function      — from useImages
// matchAll:         function      — from useMatches
// onImageDetected:  function      — from useTabs, called after each detection to update overlays
// reconstruct:      function      — from useReconstruction
export function usePipeline({ images, detectAll, matchAll, onImageDetected, reconstruct }) {
  const progressOpen    = ref(false)
  const progressTitle   = ref('')
  const progressCurrent = ref(0)
  const progressTotal   = ref(0)
  const progressLabel   = ref('')

  function openProgress(title, total = 0) {
    progressTitle.value   = title
    progressCurrent.value = 0
    progressTotal.value   = total
    progressLabel.value   = ''
    progressOpen.value    = true
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
    })
    progressOpen.value = false
  }

  async function runMatch(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done')
    if (ready.length < 2) return
    openProgress('Matching Features')
    await matchAll(images.value, settings, (done, total) => {
      progressCurrent.value = done
      progressTotal.value   = total
    })
    progressOpen.value = false
  }

  async function runReconstruct(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done')
    if (ready.length < 2) return
    openProgress('Sparse Reconstruction', ready.length)
    await reconstruct(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  // Future pipeline stages (dense, export) slot in here.

  return {
    progressOpen,
    progressTitle,
    progressCurrent,
    progressTotal,
    progressLabel,
    runDetect,
    runMatch,
    runReconstruct,
  }
}
