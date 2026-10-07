import { ref } from 'vue'
import { terminateAll } from '../workers/computeClient.js'
import { useModelsStore } from '../stores/useModelsStore.js'
import { learnedDetector, lightGlueModelFor } from '../core/features/learnedDetectors.js'

// images:           Ref<Array>    — current image list, used to count pending work
// detectAll:        function      — from useImagesStore
// matchAll:         function      — from useMatchesStore
// reconstruct:      function      — from useReconstructionStore
// computeDepthMaps:  function      — from useReconstructionStore (dense Stage A)
// densify:          function      — from useReconstructionStore (dense Stage B)
// How often the displayed counters may change. Worker progress events arrive far
// faster than a user can read them (matchAll emits once per pair — thousands of
// events on a big set), and each reactive write is a re-render. Same coalescing
// rule as App.vue's queueGcpGuidesRefresh and ViewerImage's drawOverlay: ingest
// every event into a plain object, repaint on a frame boundary at a readable rate.
const DISPLAY_INTERVAL_MS = 100
// How long the bar rests at a filled 100% before the modal closes, so a run visibly
// completes instead of vanishing at 99%.
const COMPLETE_HOLD_MS = 350

export function usePipeline({ images, detectAll, matchAll, reconstruct, computeDepthMaps, densify, generateDem, generateOrtho, generateMesh, editClouds }) {
  const progressOpen    = ref(false)
  const progressTitle   = ref('')
  const progressCurrent = ref(0)
  const progressTotal   = ref(0)
  const progressLabel   = ref('')
  const progressUnit    = ref('')
  // Authoritative bar value, 0..1 and monotonic — NOT current/total. A stage whose
  // `total` grows mid-run (matchAll) or whose counter restarts per sub-run (SfM seed
  // retries / secondary models) would otherwise drive the bar backwards.
  const progressFraction = ref(0)
  // No meaningful count: render a moving indeterminate bar rather than a determinate
  // one frozen at 0% for minutes (the single-worker-call product ops).
  const progressIndeterminate = ref(false)
  const progressComplete      = ref(false)
  const progressCancelling    = ref(false)

  // Cancellation. Loop-based ops (detect/match) poll `aborted` between items;
  // single-call ops (reconstruct) register a hard-cancel via `cancelImpl`.
  const aborted     = ref(false)
  let cancelImpl    = null
  const shouldCancel = () => aborted.value

  // ── Ingestion (hot, non-reactive) ────────────────────────────────────────────
  // Every worker event lands here; only `flush` touches refs.
  let pendingProgress = { current: 0, total: 0, label: '', fraction: 0 }
  let maxFraction = 0
  // Two handles, not one: the pacing timer and the frame callback are cancelled by
  // different functions, and clearing a rAF handle with clearTimeout silently does
  // nothing (they are separate id spaces).
  let flushTimer = null
  let flushFrame = null
  let lastFlush = 0

  const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

  function cancelScheduledFlush() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null }
    if (flushFrame != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(flushFrame)
    flushFrame = null
  }

  function flush() {
    flushFrame = null
    lastFlush = nowMs()
    progressCurrent.value  = pendingProgress.current
    progressTotal.value    = pendingProgress.total
    progressFraction.value = pendingProgress.fraction
    // The label is the user's "it moved on" signal and changes rarely (per image or
    // per phase, not per pair), so it is never worth withholding for the timer.
    if (progressLabel.value !== pendingProgress.label) progressLabel.value = pendingProgress.label
  }

  function scheduleFlush() {
    if (flushTimer != null || flushFrame != null) return
    const wait = Math.max(0, DISPLAY_INTERVAL_MS - (nowMs() - lastFlush))
    // rAF coalesces to a frame boundary and idles in a hidden tab; the timeout paces
    // it to a readable rate. A hidden tab therefore stops repainting entirely, which
    // is why every run ends with an explicit flush before the modal closes.
    flushTimer = setTimeout(() => {
      flushTimer = null
      if (typeof requestAnimationFrame === 'function') flushFrame = requestAnimationFrame(flush)
      else flush()
    }, wait)
  }

  // The single progress sink for every stage. `fraction` overrides done/total as the
  // bar value (the SfM phase plan supplies one); otherwise it derives from the count.
  function report(done, total, label, fraction) {
    const raw = fraction != null
      ? fraction
      : (total > 0 ? done / total : 0)
    // Monotonic: a stage may legitimately re-count (per-phase totals, restarted
    // sub-runs), but the bar must never retreat — a reversal reads as a failure.
    if (raw > maxFraction) maxFraction = Math.min(1, raw)
    // A stage that opened without a count (total 1) but then reports a real one —
    // ortho per scanline, mesh per multigrid layer, densify per map — becomes
    // determinate from here. DEM and cloud editing never do, and stay animated.
    if (progressIndeterminate.value && total > 1) progressIndeterminate.value = false
    pendingProgress = {
      current:  done ?? 0,
      total:    total ?? 0,
      label:    label ?? '',
      fraction: maxFraction,
    }
    scheduleFlush()
  }

  // Learned backends need their ONNX weights, and useModelsStore raises a consent
  // modal for any that aren't cached. That prompt MUST be resolved before the
  // progress modal opens: the stores raise it from inside the run, where the
  // progress overlay already covers it — the user sees a bar at 0% and an
  // unreachable dialog. Cached weights resolve immediately, so this is a no-op on
  // every run but the first. The store-side guards stay (they cover the entry
  // points that never open a progress modal); this only fixes the ordering.
  async function ensureModels(ids) {
    return useModelsStore().ensureReady(ids)
  }

  function openProgress(title, total = 0, onCancel = null, { indeterminate = false, unit = '' } = {}) {
    cancelScheduledFlush()
    progressTitle.value   = title
    progressCurrent.value = 0
    progressTotal.value   = total
    progressLabel.value   = ''
    progressFraction.value = 0
    progressUnit.value          = unit
    progressIndeterminate.value = indeterminate
    progressComplete.value      = false
    progressCancelling.value    = false
    maxFraction           = 0
    lastFlush             = 0
    pendingProgress       = { current: 0, total, label: '', fraction: 0 }
    aborted.value         = false
    cancelImpl            = onCancel
    progressOpen.value    = true
  }

  // Land on a filled bar, hold briefly, then close. Without the hold the modal
  // disappears mid-fill and the run never visibly finishes; with it, 100% means
  // "done" exactly once per run (the modal itself caps in-flight progress at 99%).
  async function closeProgress() {
    cancelScheduledFlush()
    // A cancelled run did not complete — don't reward it with a full bar.
    if (aborted.value) { progressOpen.value = false; return }
    pendingProgress = { ...pendingProgress, fraction: 1 }
    maxFraction = 1
    flush()
    progressComplete.value = true
    await new Promise((resolve) => setTimeout(resolve, COMPLETE_HOLD_MS))
    progressOpen.value = false
  }

  // Invoked by the progress modal's Cancel button.
  function cancelRun() {
    if (!progressOpen.value) return
    aborted.value = true
    progressCancelling.value = true
    progressLabel.value = 'Cancelling…'
    cancelImpl?.()
  }

  const refused = (reason, cancelled = false) => ({ ok: false, cancelled, reason })

  async function finishRun(ok = true, reason = '') {
    const cancelled = aborted.value
    await closeProgress()
    return cancelled ? refused('Cancelled', true) : { ok, cancelled: false, ...(reason ? { reason } : {}) }
  }

  async function runDetect(settings) {
    const pending = settings.overwrite
      ? images.value
      : images.value.filter((img) => img.kpStatus !== 'done')
    if (pending.length === 0) return { ok: true, unchanged: true }
    // Model consent BEFORE openProgress — see ensureModels.
    const learned = learnedDetector(settings.detector)
    if (learned && !(await ensureModels([learned.modelId]))) {
      return refused(`${learned.label} model download was cancelled`, true)
    }
    // Detection polls `aborted` between images, but ONE image can be a long
    // worker call (a learned detector on CPU WASM, or a tiled native-res run), so Cancel
    // also hard-terminates the pool — the in-flight detect rejects, detectOne
    // reverts that image, and the batch loop exits on the aborted flag.
    openProgress('Detecting Features', pending.length, () => terminateAll('detection cancelled'), { unit: 'images' })
    // No per-image overlay callback: the keypoint overlay is a global toggle gated on
    // the image's own kpStatus, so it lights up reactively as each detection lands.
    await detectAll(settings, null, report, shouldCancel)
    const ok = pending.every((img) => img.kpStatus === 'done' && (img.keypoints?.length ?? 0) > 0)
    return finishRun(ok, ok ? '' : 'Feature detection failed for one or more images')
  }

  async function runMatch(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done' && (img.keypoints?.length ?? 0) > 0)
    if (ready.length < 2) return refused('Matching requires at least two images with keypoints')
    // Model consent BEFORE openProgress — see ensureModels. Gated on the same
    // descriptor precondition useMatchesStore checks (LightGlue needs one learned
    // detector across all images): when it fails, matchAll must reach its own error first, so
    // the user isn't asked to download weights for a run that cannot start. That
    // store remains the authority — this is only about prompt ordering.
    const lg = settings.matcher === 'lightglue' ? lightGlueModelFor(ready) : null
    if (lg?.ok && !(await ensureModels([lg.modelId]))) return refused('LightGlue model download was cancelled', true)
    // Matching polls `aborted` between pairs, but ONE pair can be a long,
    // uninterruptible worker call (LightGlue on CPU WASM, or a hung run), so
    // Cancel also hard-terminates the pool — the in-flight matchPair's worker
    // promise rejects, matchPair catches it and marks the pair, and the drain
    // loops exit on the aborted flag. Cost: worker 0 drops its cached ORT/LightGlue
    // session (~model reload next run); acceptable for an explicit user cancel.
    openProgress('Matching Features', 0, () => terminateAll('matching cancelled'), { unit: 'pairs' })
    await matchAll(images.value, settings, report, shouldCancel)
    return finishRun()
  }

  async function runReconstruct(settings) {
    const ready = images.value.filter((img) => img.kpStatus === 'done' && (img.keypoints?.length ?? 0) > 0)
    if (ready.length < 2) return refused('Sparse reconstruction requires at least two images with keypoints')
    // Reconstruct is a single worker call — cancel by terminating the worker
    // (the store catches the resulting rejection and resets its status).
    openProgress('Sparse Reconstruction', ready.length, () => terminateAll('reconstruction cancelled'))
    await reconstruct(settings, report)
    return finishRun()
  }

  // Dense Stage A — Build Depth Maps (PatchMatch MVS). Single worker call; cancel
  // by terminating the worker (the store catches the rejection and resets status).
  async function runComputeDepthMaps(settings) {
    openProgress('Building Depth Maps', images.value.length, () => terminateAll('depth maps cancelled'), { unit: 'images' })
    await computeDepthMaps(settings, report)
    return finishRun()
  }

  // Dense Stage B — fuse the depth maps into the dense cloud.
  async function runDensify(settings) {
    openProgress('Building Dense Cloud', 1, () => terminateAll('densify cancelled'), { indeterminate: true, unit: 'maps' })
    await densify(settings, report)
    return finishRun()
  }

  // Products — DEM (rasterise a height grid). Single worker call; cancel by
  // terminating the worker (the store catches the rejection and resets status).
  async function runGenerateDem(settings) {
    openProgress('Building DEM', 1, () => terminateAll('DEM cancelled'), { indeterminate: true })
    await generateDem(settings, report)
    return finishRun()
  }

  // Products — orthophoto (reproject the DEM through the cached depth maps).
  async function runGenerateOrtho(settings) {
    openProgress('Building Orthophoto', 1, () => terminateAll('orthophoto cancelled'), { indeterminate: true })
    await generateOrtho(settings, report)
    return finishRun()
  }

  // Products — mesh (screened Poisson over the dense cloud). Single worker call;
  // cancel by terminating the worker (the store catches the rejection).
  async function runGenerateMesh(settings) {
    openProgress('Building Mesh', 1, () => terminateAll('mesh cancelled'), { indeterminate: true })
    await generateMesh(settings, report)
    return finishRun()
  }

  // Tools — cloud editing (crop / filter / merge / 3D-viewer selection). Single worker call, same
  // cancel-by-terminate contract as the mesh run.
  async function runEditClouds(request) {
    const titles = { crop: 'Cropping Cloud', filter: 'Filtering Cloud', merge: 'Merging Clouds', mask: 'Editing Selection' }
    openProgress(titles[request.mode] ?? 'Editing Cloud', 1, () => terminateAll('cloud edit cancelled'), { indeterminate: true })
    // ok ⇔ the store committed a result (it returns null for a refusal, an empty
    // result, a superseded run or an error) — callers act on the outcome, not on
    // a status flag a no-op leaves at its previous value.
    const cloud = await editClouds(request, report)
    return finishRun(!!cloud)
  }

  return {
    progressOpen,
    progressTitle,
    progressCurrent,
    progressTotal,
    progressLabel,
    progressUnit,
    progressFraction,
    progressIndeterminate,
    progressComplete,
    progressCancelling,
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
    // The progress contract itself, for a long-running job that is not a pipeline
    // stage — undistorted-image export is minutes of work and must not run behind
    // a frozen UI with no bar. Exposed rather than reimplemented so there stays
    // exactly one place that clamps the fraction monotonically and lands on 100%
    // once (see ProgressModal's 99% cap).
    progress: { open: openProgress, report, close: closeProgress, aborted },
  }
}
