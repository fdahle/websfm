import { computeSourceOf } from '../../utils/image.js'
import { learnedDetector, detectorLabel } from '../../core/features/learnedDetectors.js'
import { useModelsStore } from '../useModelsStore.js'
import { resolveDetectMaxDim, resolveDetectKeypoints, detectSize } from '../../core/features/detectResolution.js'
import { DETECT_TUNING } from '../../core/tuning.js'
import { detectKeypoints, POOL_SIZE } from '../../workers/computeClient.js'
import { Keypoints, fillNormalized, asKeypoints } from '../../core/features/keypoints.js'
import * as opfs from '../../utils/opfs.js'
import { markRaw, toRaw } from 'vue'
import { canContinue, journalKey, journalWriter, startJournal } from '../../core/runJournal.js'
import { useMatchesStore } from '../useMatchesStore.js'
import { detectionConcurrency } from '../../core/features/detectConcurrency.js'
import { pluralize } from '../../core/textFormat.js'

// Feature detection on the image records, split out of useImagesStore: one image
// or the batch (SIFT or a learned detector, in the workers), an external feature
// index attached in one batch, and clearing an image's keypoints. Keypoints land in
// the keypoint cache and on disk; the record keeps only counts and status.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createDetection({
  holdKeypoints,
  imageById,
  images,
  isPersisting,
  keypointCache,
  log,
  projects,
  save,
  whenComputeReady,
}) {
  async function detectOne(id, settings = {}, onDetected, shouldCancel) {
    const img = images.value.find((i) => i.id === id)
    if (!img || img.kpStatus === 'running') return
    // A learned detector needs its weights — fetch them (with consent) first.
    const learned = learnedDetector(settings.detector)
    if (learned && !(await useModelsStore().ensureReady([learned.modelId]))) {
      log(`Detection cancelled — the ${learned.label} model is not available.`, 'warn', 'Detection')
      return
    }
    // Re-detecting renumbers keypoints, so any existing matches for this image
    // become stale — invalidate them once detection succeeds (below).
    const hadKeypoints = img.kpStatus === 'done'
    // Message-text label for the chosen detector (SIFT default, SuperPoint, DISK, ALIKED);
    // the console *source* is the pipeline stage 'Detection', not the detector.
    const tag = detectorLabel(settings.detector)
    img.kpStatus = 'running'
    log(`${tag} start: ${img.name}`, 'info', 'Detection')
    try {
      // A TIFF's lossless compute PNG may still be encoding (ingest sets the
      // display JPEG first) — wait for it, or reject if its transcode failed,
      // rather than detecting on the lossy display blob (computeUrl invariant).
      await whenComputeReady(img)
      // Working resolution. In 'auto' mode this is a fraction of THIS image's
      // native size (core/features/detectResolution.js) rather than one absolute
      // cap for a set that may span 2000–10000 px; 'absolute' (the default) passes
      // the configured value straight through. Resolved here, per image, because
      // this is where the native size is known — and logged, because a silently
      // derived working resolution is not auditable.
      const nativeMax = Math.max(img.meta?.width || 0, img.meta?.height || 0)
      const res0 = resolveDetectMaxDim(nativeMax, settings)
      // Auto mode also scales the SIFT keypoint cap with the detected area (same module).
      const kp0 = resolveDetectKeypoints(
        img.meta?.width > 0 && img.meta?.height > 0 ? detectSize(img.meta.width, img.meta.height, res0.maxDim) : null,
        settings,
      )
      if (res0.mode === 'auto') {
        log(`${tag} ${img.name} — detect at ${res0.reason}; keypoint cap ${kp0.reason}`, 'debug', 'Detection')
      }
      // SIFT keypoints per extremum (dominant + secondary orientations, tuning.js
      // DETECT_TUNING). Null for a learned detector: no orientation histogram.
      const maxOrientations = learned ? null : (settings.maxOrientations ?? DETECT_TUNING.siftMaxOrientations)
      // Which keypoints the SIFT cap keeps (keypointCap.js). Learned ones rank by score.
      const capRule = learned ? null : (settings.capRule ?? DETECT_TUNING.siftCapRule)
      // Pass the per-image mask (if any) so keypoints inside masked regions are
      // dropped at detection — this propagates to matching and reconstruction.
      const res = await detectKeypoints(
        computeSourceOf(img),
        {
          ...settings,
          maxDim: res0.maxDim,
          maxKeypoints: kp0.maxKeypoints,
          mask: img.mask?.blob ?? null,
          ...(maxOrientations != null ? { maxOrientations } : {}),
          ...(capRule != null ? { capRule } : {}),
        },
        { onLog: (msg) => log(msg, 'info', 'Detection') },
      )
      // The worker can't be interrupted mid-image, so a cancel pressed while this
      // one was in flight lands here with a finished result — drop it rather than
      // attach it, reverting to the image's prior state.
      if (shouldCancel?.()) {
        const found = images.value.find((i) => i.id === id)
        if (found) found.kpStatus = hadKeypoints ? 'done' : null
        log(`${tag} discarded (cancelled): ${img.name}`, 'warn', 'Detection')
        return
      }
      const found = images.value.find((i) => i.id === id)
      if (found) {
        // markRaw: these are large and never need reactivity; leaving them as
        // Vue proxies also breaks the worker boundary (a Proxy can't be
        // structured-cloned, so postMessage throws "could not be cloned").
        // Typed (core/features/keypoints.js): the worker's transferred buffers, wrapped,
        // resident and pinned until both sidecars are saved (then evictable like any
        // other image's — they are read back on demand).
        const pid = projects.currentProjectId
        const persisting = isPersisting()
        const kpsNew = new Keypoints(res.keypoints.data, res.keypoints.rgb)
        holdKeypoints(
          found,
          kpsNew,
          persisting
            ? Promise.all([opfs.saveKeypoints(pid, found.uuid, kpsNew), opfs.saveColors(pid, found.uuid, kpsNew)])
            : null,
        )
        found.descriptors = markRaw(res.descriptors) // keep in-memory for non-persistent matching
        found.kpCount = kpsNew.length
        found.kpMs = Math.round(res.ms)
        found.kpStatus = 'done'
        // Detector + descriptor width travel with the image so matching can pick
        // the right matcher and read the descriptor stride off the buffer (SIFT
        // 128-d, SuperPoint 256-d, DISK 128-d) rather than assume a constant.
        found.detector = res.detector ?? 'sift'
        found.descDim = res.descDim ?? 128
        // Which normalisation the stored SIFT descriptors are in (RootSIFT since
        // 2026-10). Absent ⇒ legacy L2; matching converts on load, so it is never
        // back-filled (core/features/siftDescriptors.js).
        found.descNorm = res.descNorm ?? null
        // Detection scale travels with the image for the same reason descDim does:
        // keypoints come back in NATIVE pixels (detect.js maps them back), so every
        // downstream pixel threshold is denominated in native px while the
        // measurement quantum is 1/scale native px. core/scaleContext.js resolves
        // the gates against it. Absent ⇒ 1 ⇒ no correction (back-compat).
        found.detectScale = res.diag?.scale ?? 1
        // The detection settings this image's keypoints were produced WITH. Persisted
        // because a measured result without its settings is not a baseline: `detector`
        // and `detectScale` alone cannot distinguish a Balanced run from a Detailed one
        // (same scale, 2.5× the keypoint budget). Absent ⇒ null ⇒ "unknown, pre-dates
        // this field"; deliberately not back-filled from the current modal values.
        found.detectSettings = {
          maxDim: settings.maxDim ?? null,
          maxDimMode: settings.maxDimMode ?? null,
          maxKeypoints: settings.maxKeypoints ?? null,
          // The cap this image ran with: auto mode scales it with the detected area.
          maxKeypointsEffective: kp0.maxKeypoints ?? null,
          contrastThreshold: settings.contrastThreshold ?? null,
          // The lower threshold a faint image was detected again at (core/features/
          // faintRetry.js), or null: detected once at contrastThreshold.
          faintRetryContrast: res.diag?.faintRetry?.contrast ?? null,
          tiling: settings.tiling ?? null,
          // Absent on images detected before 2026-10 ⇒ unknown (they ran with 1).
          maxOrientations,
          // Absent before 2026-10 ⇒ unknown (they ran with 'response').
          capRule,
        }
        if (hadKeypoints) useMatchesStore().removeMatchesForImage(found.uuid)
        log(`${tag} done: ${found.name} — ${found.kpCount} keypoints in ${found.kpMs} ms`, 'success', 'Detection')
        // Detailed diagnostics (debug level): the working resolution actually
        // used, how many features the cap discarded, mask drops, and the response
        // spread (the signal for tuning maxKeypoints / contrastThreshold).
        const d = res.diag
        if (d) {
          log(
            `${tag} ${found.name} — detect @ ${d.detectWidth}×${d.detectHeight} ` +
              `(${d.scale.toFixed(3)}× of ${d.natW}×${d.natH})`,
            'debug',
            'Detection',
          )
          if (learnedDetector(res.detector)) {
            // Learned detector: no near-duplicate suppression / response, so report
            // the cap + mask drops and the keypoint-score spread instead.
            log(
              `${tag} ${found.name} — ${d.capped} keypoints` +
                `${d.capHit ? ' (top-K cap hit)' : ''}` +
                `${d.maskedPreCap > 0 ? `, −${d.maskedPreCap} masked before cap` : ''}` +
                `${d.maskedDropped > 0 ? `, −${d.maskedDropped} in mask → ${d.kept}` : ''}` +
                `; score p50 ${d.scoreP50.toFixed(3)} / p95 ${d.scoreP95.toFixed(3)}`,
              'debug',
              'Detection',
            )
          } else {
            log(
              `${tag} ${found.name} — ` +
                `${d.faintRetry ? `faint (${d.faintRetry.before} keypoints, under ${d.faintRetry.floor}): detected again at contrast ${d.faintRetry.contrast}, ` : ''}` +
                `${d.rawFound} found → ${d.capped}` +
                `${
                  !d.capHit
                    ? ' (under cap)'
                    : d.capRule === 'coarse-first'
                      ? ` capped coarse-first (smallest kept σ ${d.minScale.toFixed(2)} detect px)`
                      : ` capped (min response ${d.minResponse.toFixed(3)})`
                }` +
                `${d.suppressed > 0 ? `, −${d.suppressed} duplicate-position keypoints suppressed` : ''}` +
                `${d.maskedPreCap > 0 ? `, −${d.maskedPreCap} masked before cap` : ''}` +
                `${d.maskedDropped > 0 ? `, −${d.maskedDropped} in mask → ${d.kept}` : ''}` +
                `; response p50 ${d.respP50.toFixed(3)} / p95 ${d.respP95.toFixed(3)}`,
              'debug',
              'Detection',
            )
          }
        }
        if (persisting) {
          // A persistent project's matching reads descriptors from OPFS, so the
          // in-memory copy is dead weight once saved — 1.4 GB at 128 × 25k SIFT
          // descriptors, enough to fail the sparse memory preflight hours later.
          // Kept if the save fails: matching falls back to it.
          const descriptors = res.descriptors
          opfs
            .saveDescriptors(pid, found.uuid, descriptors)
            .then(() => {
              if (found.descriptors === descriptors) found.descriptors = null
            })
            .catch(() => {})
          save()
        }
        onDetected?.(id)
      }
    } catch (err) {
      const found = images.value.find((i) => i.id === id)
      // A cancel hard-terminates the worker pool, which rejects the in-flight
      // call — that's the user stopping the run, not a detector failure, so
      // revert the image to its prior state instead of flagging an error.
      if (shouldCancel?.()) {
        if (found) found.kpStatus = hadKeypoints ? 'done' : null
        log(`${tag} aborted (cancelled): ${img.name}`, 'warn', 'Detection')
        return
      }
      log(`${tag} error: ${img.name} — ${err?.message ?? err}`, 'error', 'Detection')
      if (found) found.kpStatus = 'error'
    }
  }

  // `resume`: the journal a dead tab's run left (core/runJournal.js, the Continue prompt on
  // open). The images it lists keep their features; only the rest are detected.
  async function detectAll(settings = {}, onDetected, onProgress, shouldCancel, { resume = null } = {}) {
    const requested = structuredClone(toRaw(settings))
    const key = journalKey({ images: images.value.map((im) => im.uuid), settings: requested })
    let journal = null
    if (resume && isPersisting()) {
      const verdict = canContinue(resume, key)
      if (verdict.ok) journal = structuredClone(resume)
      else log(`Detection: the stopped run cannot continue (${verdict.why}); starting again`, 'warn', 'Detection')
    }
    // An image the journal lists keeps its features, unless they did not survive (its
    // status is no longer 'done', e.g. a keypoint file that was never written).
    const kept = new Set(
      (journal?.done ?? []).filter((u) => images.value.some((im) => im.uuid === u && im.kpStatus === 'done')),
    )
    const pending = (settings.overwrite ? images.value : images.value.filter((img) => img.kpStatus !== 'done'))
      .filter((img) => img.kpStatus !== 'running')
      .filter((img) => !kept.has(img.uuid))
    const total = pending.length
    let writer = null
    if (isPersisting()) {
      const pid = projects.currentProjectId
      journal ??= startJournal({ stage: 'detect', key, settings: requested, total: total + kept.size, phase: 'images' })
      journal.done = [...kept]
      writer = journalWriter((j) => opfs.saveRunJournal(pid, j), {
        intervalMs: settings._journalMs ?? DETECT_TUNING.journalIntervalMs,
      })
      await writer.flush(journal)
      if (kept.size) {
        log(
          `Detection: continuing the stopped run — ${pluralize(kept.size, 'image')} of ${total + kept.size} already detected`,
          'info',
          'Detection',
        )
      }
    }
    // Echo the settings actually in effect so the console records what was run.
    const {
      detector = 'sift',
      maxDim = 1200,
      contrastThreshold = 0.01,
      maxKeypoints = 5000,
      maxDimMode = 'absolute',
      preset = 'medium',
    } = settings
    // Message-text label only; the console source is the stage 'Detection'.
    const batchTag = detectorLabel(detector)
    // A learned detector needs its weights — fetch them (with consent) once for the
    // whole batch before dispatching any image.
    const learnedSpec = learnedDetector(detector)
    if (learnedSpec && !(await useModelsStore().ensureReady([learnedSpec.modelId]))) {
      log(`Detection cancelled — the ${learnedSpec.label} model is not available.`, 'warn', 'Detection')
      return
    }
    // Resolution: one figure in absolute mode; in auto mode it varies per image, so
    // report the band being applied rather than a number that would only be right
    // for some of the batch.
    const resLabel = maxDimMode === 'auto' ? `auto resolution (${preset} band, ≥${maxDim}px)` : `≤${maxDim}px`
    const concurrency = detectionConcurrency(pending, settings, POOL_SIZE, navigator.deviceMemory)
    const started = performance.now()
    const budgetNote =
      settings.memBudgetBytes > 0 ? ` (memory budget ${(settings.memBudgetBytes / 1024 ** 3).toFixed(1)} GB)` : ''
    log(
      `${batchTag} batch: ${pluralize(total, 'image')} queued — ${resLabel}, ${concurrency} concurrent${budgetNote}` +
        `${learnedSpec ? '' : `, contrast ${contrastThreshold}`}, ≤${maxKeypoints} kp` +
        `${maxDimMode === 'auto' && !learnedSpec ? ' (auto: scaled with the detected area, up to 4×)' : ''}` +
        `${
          learnedSpec
            ? ''
            : `, ≤${pluralize(settings.maxOrientations ?? DETECT_TUNING.siftMaxOrientations, 'orientation')} per extremum` +
              `, cap rule ${settings.capRule ?? DETECT_TUNING.siftCapRule}, RootSIFT descriptors`
        }`,
      'info',
      'Detection',
    )
    let done = 0
    let cursor = 0
    let cancelled = false
    const stop = () => cancelled || (cancelled = !!shouldCancel?.())
    const drain = async () => {
      while (!stop()) {
        const img = pending[cursor++]
        if (!img) return
        await detectOne(img.id, settings, onDetected, stop)
        if (stop()) return
        if (writer && img.kpStatus === 'done') {
          journal.done.push(img.uuid)
          writer.touch(journal)
        }
        done++
        onProgress?.(done, total, img.name)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, drain))
    // A finished run leaves no journal; a cancelled one keeps it, to continue later.
    if (writer) {
      await writer.settled()
      if (stop()) await writer.flush(journal)
      else await opfs.deleteRunJournal(projects.currentProjectId, 'detect').catch(() => {})
    }
    const seconds = (performance.now() - started) / 1000
    log(
      `${batchTag} ${stop() ? 'cancelled' : 'batch complete'} — ${done}/${total} processed in ${seconds.toFixed(2)} s` +
        ` (${concurrency} concurrent)`,
      stop() ? 'warn' : 'success',
      'Detection',
    )
  }

  // Attach an external feature index to existing images in one batch. The caller
  // has already resolved external names to uuids and coordinated replacement of
  // dependent matches. Keeping this as a store action preserves markRaw + OPFS
  // invariants and avoids a modal mutating reactive records directly.
  async function importFeatures(entries, { invalidateMatches = true } = {}) {
    const pid = projects.currentProjectId
    let imported = 0
    const writes = []
    for (const entry of entries || []) {
      const img = images.value.find((i) => i.uuid === entry.uuid)
      if (!img || !entry.keypoints || typeof entry.keypoints.length !== 'number') continue
      if (invalidateMatches) useMatchesStore().removeMatchesForImage(img.uuid)
      // An import hands objects ({ x, y, … }) or typed keypoints; the store keeps typed.
      const kps = fillNormalized(asKeypoints(entry.keypoints), img.meta?.width, img.meta?.height)
      const persist = isPersisting()
        ? // Colours too: an import without them must not inherit a previous detection's file.
          Promise.all([opfs.saveKeypoints(pid, img.uuid, kps), opfs.saveColors(pid, img.uuid, kps)])
        : null
      if (persist) writes.push(persist)
      holdKeypoints(img, kps, persist)
      img.descriptors = entry.descriptors ? markRaw(entry.descriptors) : null
      img.kpStatus = 'done'
      img.kpCount = kps.length
      img.kpMs = 0
      img.detector = entry.detector ?? 'sift'
      img.descDim = entry.descDim ?? 128
      img.descNorm = entry.descNorm ?? null
      img.detectScale = 1
      img.detectSettings = { source: entry.source ?? 'external' }
      imported++
      if (isPersisting() && img.descriptors) writes.push(opfs.saveDescriptors(pid, img.uuid, img.descriptors))
    }
    if (writes.length) await Promise.all(writes)
    if (imported && isPersisting()) await save(pid)
    log(`Features imported: ${pluralize(imported, 'image')}`, imported ? 'success' : 'warn', 'Import')
    return imported
  }

  function clearKeypoints(id) {
    const img = imageById(id)
    if (!img) return
    keypointCache.delete(img.uuid)
    img.kpRev = (img.kpRev ?? 0) + 1
    img.kpCount = 0
    img.kpMs = 0
    img.kpStatus = null
    // The scale described keypoints that no longer exist. Inert either way (a
    // null kpStatus excludes the image from matching and SfM), but a stale value
    // must not survive into the next detection run at different settings.
    img.detectScale = null
    img.detectSettings = null
    img.descNorm = null
    log(`Keypoints cleared: ${img.name}`, 'info', 'Detection')
    useMatchesStore().removeMatchesForImage(img.uuid)
    if (isPersisting()) {
      const pid = projects.currentProjectId
      opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
      opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
      save()
    }
  }

  return {
    detectOne,
    detectAll,
    importFeatures,
    clearKeypoints,
  }
}
