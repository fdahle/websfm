import { ref } from 'vue'
import { terminateAll } from '../workers/computeClient.js'

// images:           Ref<Array>    — current image list, used to count pending work
// detectAll:        function      — from useImagesStore
// matchAll:         function      — from useMatchesStore
// reconstruct:      function      — from useReconstructionStore
// computeDepthMaps:  function      — from useReconstructionStore (dense Stage A)
// densify:          function      — from useReconstructionStore (dense Stage B)
export function usePipeline({ images, detectAll, matchAll, reconstruct, computeDepthMaps, densify, generateDem, generateOrtho, generateMesh, editClouds }) {
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
    // Detection polls `aborted` between images, but ONE image can be a long
    // worker call (SuperPoint on CPU WASM, or a tiled native-res run), so Cancel
    // also hard-terminates the pool — the in-flight detect rejects, detectOne
    // reverts that image, and the batch loop exits on the aborted flag.
    openProgress('Detecting Features', pending.length, () => terminateAll('detection cancelled'))
    // No per-image overlay callback: the keypoint overlay is a global toggle gated on
    // the image's own kpStatus, so it lights up reactively as each detection lands.
    await detectAll(settings, null, (done, total, name) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = name ?? ''
    }, shouldCancel)
    progressOpen.value = false
  }

  async function runMatch(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done')
    if (ready.length < 2) return
    // Matching polls `aborted` between pairs, but ONE pair can be a long,
    // uninterruptible worker call (LightGlue on CPU WASM, or a hung run), so
    // Cancel also hard-terminates the pool — the in-flight matchPair's worker
    // promise rejects, matchPair catches it and marks the pair, and the drain
    // loops exit on the aborted flag. Cost: worker 0 drops its cached ORT/LightGlue
    // session (~model reload next run); acceptable for an explicit user cancel.
    openProgress('Matching Features', 0, () => terminateAll('matching cancelled'))
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

  // Products — DEM (rasterise a height grid). Single worker call; cancel by
  // terminating the worker (the store catches the rejection and resets status).
  async function runGenerateDem(settings) {
    openProgress('Building DEM', 1, () => terminateAll('DEM cancelled'))
    await generateDem(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  // Products — orthophoto (reproject the DEM through the cached depth maps).
  async function runGenerateOrtho(settings) {
    openProgress('Building Orthophoto', 1, () => terminateAll('orthophoto cancelled'))
    await generateOrtho(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  // Products — mesh (screened Poisson over the dense cloud). Single worker call;
  // cancel by terminating the worker (the store catches the rejection).
  async function runGenerateMesh(settings) {
    openProgress('Building Mesh', 1, () => terminateAll('mesh cancelled'))
    await generateMesh(settings, (done, total, label) => {
      progressCurrent.value = done
      progressTotal.value   = total
      progressLabel.value   = label ?? ''
    })
    progressOpen.value = false
  }

  // Tools — cloud editing (crop / filter / merge). Single worker call, same
  // cancel-by-terminate contract as the mesh run.
  async function runEditClouds(request) {
    const titles = { crop: 'Cropping Cloud', filter: 'Filtering Cloud', merge: 'Merging Clouds' }
    openProgress(titles[request.mode] ?? 'Editing Cloud', 1, () => terminateAll('cloud edit cancelled'))
    await editClouds(request, (done, total, label) => {
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
    runGenerateDem,
    runGenerateOrtho,
    runGenerateMesh,
    runEditClouds,
  }
}
