// One image pair through the matcher: descriptors or LightGlue, the subset gate,
// the ratio test and cross-check, the fundamental-matrix verification and the
// acceptance gate, and the entry it leaves in the match store. Split out of
// useMatchesStore; `deps` are the store's own state and helpers.
import { matchDescriptors, matchLightGlue, verifyPointPairs, GPU_MATCH_WORKER } from '../../workers/computeClient.js'
import { inlierSpread, packMatchedPoints, qualityOrder } from '../../core/features/verify.js'
import { makeVerifyMapper, mapVerifyPoints, expandInlierMask } from '../../core/features/verifyFrame.js'
import { distortionOf } from '../../core/sfm/distortion.js'
import { resolveK } from '../../core/sfm/reconstruction.js'
import { evaluatePairAcceptance } from '../../core/features/pairGate.js'
import { filterStationaryMatches, stationaryTolPx } from '../../core/features/stationary.js'
import {
  pickSpreadIndices,
  sliceDescriptorRows,
  resolveSubsetGateSize,
  SUBSET_GATE_SIZE_DEFAULTS,
} from '../../core/features/subsetGate.js'
import { canonicalizeMatches } from '../../core/features/orientationSiblings.js'
import { toMatchSpace } from '../../core/features/siftDescriptors.js'
import { swapMatchRoles, transposeF } from '../../core/sfm/matchCodec.js'
import { learnedDetector } from '../../core/features/learnedDetectors.js'
import { MATCH_DEFAULTS } from '../../core/defaults.user.js'
import { MATCH_TUNING } from '../../core/tuning.js'
import { applyTuningOverrides } from '../tuningOverrides.js'
import { pairScaleContext, resolveScaledPx } from '../../core/scaleContext.js'
import { useImagesStore } from '../useImagesStore.js'
import { useSensorsStore } from '../useSensorsStore.js'
import * as opfs from '../../utils/opfs.js'

const EMPTY_MATCHES = new Uint32Array(0)

// Each image's subset-gate sample (spread indices + their descriptor rows), per size,
// kept as long as its descriptor buffer lives: a run tests every image against hundreds
// of others with the same sample.
const gateSamples = new WeakMap()
function gateSample(kps, desc, size, dim) {
  let bySize = gateSamples.get(desc)
  if (!bySize) gateSamples.set(desc, (bySize = new Map()))
  let sample = bySize.get(size)
  if (!sample) {
    const idx = pickSpreadIndices(kps, size)
    sample = { idx, desc: sliceDescriptorRows(desc, idx, dim) }
    bySize.set(size, sample)
  }
  return sample
}

// Original image dimensions (px) in the same space as keypoint x,y — needed by
// LightGlue's coord normalization. Prefer EXIF meta; else recover from a keypoint
// (x = nx·natW, where nx is the detect-normalized coord stored alongside).
function imageDims(img, kps) {
  const w = img.meta?.width,
    h = img.meta?.height
  if (w && h) return [w, h]
  for (let i = 0; i < (kps?.length ?? 0); i++) {
    if (kps.nx(i) > 0 && kps.ny(i) > 0) return [Math.round(kps.x(i) / kps.nx(i)), Math.round(kps.y(i) / kps.ny(i))]
  }
  return [1, 1]
}

export function createPairMatcher({
  canonFor,
  holdMatches,
  isPersisting,
  log,
  markHeavy,
  matchCache,
  matchStore,
  packPutatives,
  pairId,
  projects,
  touchSoon,
}) {
  // `descCache` (optional): id → descriptors, shared across a matchAll run so each
  // image's descriptors are loaded from OPFS once instead of once per pair (an
  // image appears in N−1 pairs, so this turns O(N²) loads into O(N)).
  // `gpuRun` (optional): matchAll's WebGPU router (stores/matching/gpuMatchRun.js);
  // null ⇒ brute-force runs on the WASM pool exactly as before.
  // The pinhole-frame mapper an image's putatives are verified through, or null
  // (core/features/verifyFrame.js): a sensor with a known lens gets one. Same K and lens
  // as SfM ingest (resolveK + distortionOf), so the verified F is that frame's. Film
  // keypoints are scan pixels; their frame comes from the fiducials at ingest.
  function verifyMapperFor(img) {
    const sensor = img?.sensorId ? useSensorsStore().sensors.find((s) => s.id === img.sensorId) : null
    const dist = distortionOf(sensor)
    if (!dist || sensor.kind === 'film') return null
    return makeVerifyMapper(resolveK(img.meta, sensor), dist)
  }

  async function matchPairOnce(imgA, imgB, settings = {}, onDone, descCache = null, gpuRun = null) {
    // Resolve every knob from the single source of truth (defaults.user.js +
    // tuning.js), caller's `settings` winning, then the console's session overrides
    // (stores/tuningOverrides.js). Downstream reads `settings.X` directly.
    settings = applyTuningOverrides('match', { ...MATCH_DEFAULTS, ...MATCH_TUNING, ...settings })
    const [idA, idB] = [imgA.uuid, imgB.uuid].sort()
    const pid = pairId(idA, idB)

    // `matches` is this run's result; it reaches the entry (as `nMatches`) and the
    // match cache together, once the pair is done (holdMatches).
    let matches = EMPTY_MATCHES
    const entry = {
      idA,
      idB,
      rawCount: 0,
      inlierCount: 0,
      F: null,
      nMatches: 0,
      src: null,
      status: 'running',
      enabled: true,
      weak: false,
    }
    entry.timing = {
      descriptorLoadMs: 0,
      descriptorBytes: 0,
      postMessageMs: 0,
      matchingMs: 0,
      verificationMs: 0,
      roundTripMs: 0,
    }
    const timing = (stage) => ({
      onTiming: (t) => {
        entry.timing.postMessageMs += t.postMessageMs
        entry.timing[stage] += t.workerMs
        entry.timing.roundTripMs += t.roundTripMs
      },
    })
    // Brute-force NN: through the GPU router when this run has one (it validates,
    // caches descriptors by image id and falls back to WASM per pair), else WASM.
    // While a GPU run is active, WASM work keeps off the GPU-pinned worker.
    const avoidWorker = gpuRun ? GPU_MATCH_WORKER : undefined
    const bruteForce = (dA, dB, opts, kind, ids = [null, null]) =>
      gpuRun
        ? gpuRun.match(dA, dB, { ...opts, kind, idA: ids[0], idB: ids[1] }, timing('matchingMs'))
        : matchDescriptors(dA, dB, opts, timing('matchingMs'))
    // Supersedes the old result before any early exit (gated, failed or cancelled):
    // the next save writes this entry, never the old one — nor keeps its matches.
    matchStore.value.set(pid, entry)
    matchCache.delete(pid)
    markHeavy()
    // Trigger reactivity
    touchSoon()

    const projectId = projects.currentProjectId
    try {
      // STORAGE order is by uuid (idA/idB, the pair id, the packed [ia, ib] layout),
      // but uuids are random per project, so matching in that order made which image
      // plays "A" a coin flip per pair per project — and brute-force matching is
      // asymmetric (the ratio test runs from A's side, RANSAC samples in A's match
      // order): two fresh runs of the same images differed on ~8 % of pairs. Match in
      // NAME order instead (the files' names, stable across projects; uuid order on a
      // tie), and turn the result back into storage order below (`swapRoles`).
      const storeA = idA === imgA.uuid ? imgA : imgB
      const storeB = idA === imgA.uuid ? imgB : imgA
      const swapRoles = (storeB.name ?? '') < (storeA.name ?? '')
      // From here srcA/kpsA/descA are the MATCHING roles.
      const srcA = swapRoles ? storeB : storeA
      const srcB = swapRoles ? storeA : storeB
      // Keypoints load per image on demand (useImagesStore.ensureKeypoints; LRU-kept
      // across a run's pairs), ordered the same way as the ids.
      const images = useImagesStore()
      const [kpsA, kpsB] = await Promise.all([images.ensureKeypoints(srcA), images.ensureKeypoints(srcB)])
      if (!kpsA || !kpsB) {
        entry.status = 'error'
        log(
          `Match failed: keypoints missing for ${imgA.name} / ${imgB.name} — re-run feature detection`,
          'error',
          'Matching',
        )
        touchSoon()
        return
      }

      // Cache the in-flight PROMISE (not just the result) so that concurrent pairs
      // sharing an image load its descriptors from OPFS exactly once.
      const loadDesc = (id, src) => {
        if (descCache?.has(id)) return descCache.get(id)
        // Persistent: OPFS is the copy (detection drops its in-memory one once
        // saved); the in-memory copy only survives a failed save.
        const p = (
          isPersisting()
            ? opfs.loadDescriptors(projectId, id).then((d) => d ?? src.descriptors ?? null)
            : Promise.resolve(src.descriptors ?? null)
        )
          // SIFT matches in RootSIFT; legacy L2 detections convert here, once per run
          // (core/features/siftDescriptors.js). Never in place: `src.descriptors` is
          // the image's live copy.
          .then((d) => toMatchSpace(d, src, src.descDim ?? 128))
        descCache?.set(id, p)
        return p
      }
      const loadStarted = performance.now()
      const descA = await loadDesc(srcA.uuid, srcA)
      const descB = await loadDesc(srcB.uuid, srcB)

      entry.timing.descriptorLoadMs = performance.now() - loadStarted
      entry.timing.descriptorBytes = (descA?.byteLength ?? 0) + (descB?.byteLength ?? 0)
      if (!descA || !descB) {
        entry.status = 'error'
        const names = `${imgA.name} / ${imgB.name}`
        log(`Match failed: descriptors missing for ${names} — re-run feature detection`, 'error', 'Matching')
        touchSoon()
        return
      }

      const dimA = srcA.descDim ?? 128
      const dimB = srcB.descDim ?? 128
      if (
        dimA !== dimB ||
        (srcA.detector ?? 'sift') !== (srcB.detector ?? 'sift') ||
        !Number.isSafeInteger(dimA) ||
        dimA <= 0 ||
        descA.length !== kpsA.length * dimA ||
        descB.length !== kpsB.length * dimB ||
        (settings.matcher === 'lightglue' && !learnedDetector(srcA.detector))
      ) {
        throw new Error('Incompatible descriptors — detect both images with the same detector before matching')
      }

      // Subset gate (brute-force only): a cheap coarse pre-test that rejects
      // non-overlapping pairs before the full O(Na·Nb) match. Match a small
      // spatially-uniform subset of each image's descriptors; if too few survive,
      // skip the pair entirely. Keeps exhaustive *coverage* (loop closures are
      // still found anywhere in the graph) at a fraction of the cost per pair —
      // the win when there are no poses for proximity preselection. Only kicks in
      // when both images have meaningfully more keypoints than the subset, so
      // small images just pay the full match. See core/features/subsetGate.js.
      //
      // `_skipSubsetGate` is matchAll's per-run veto (see there): preselection already
      // being the overlap prefilter, or too few pairs for the saving to be worth the
      // false-negative risk. Set on the settings object rather than checked here
      // because both reasons are properties of the *run*, not of this pair.
      const gateEnabled = settings.subsetGate !== false && settings.matcher !== 'lightglue' && !settings._skipSubsetGate
      if (gateEnabled) {
        // Size each image's sample from its OWN keypoint count (fraction × N, within the
        // floor and ceiling): a real pair then reads (sA/NA)(sB/NB)·M = fraction²·M
        // putatives whatever the counts, as the per-pair size did, but each image's sample
        // is picked and sliced once per run (gateSample) instead of once per pair: the
        // per-pair pick and slice were most of PUTI's matching time (444 images, 98k pairs:
        // 112 of 251 s on the main thread). See core/features/subsetGate.js.
        // `_gateScale` (matchAll's rescue pass): the same test on a k× larger sample —
        // k² more expected putatives on a real pair, still a few % of the full match.
        const k = settings._gateScale > 1 ? settings._gateScale : 1
        const sizing = (n) =>
          resolveSubsetGateSize(n, n, {
            floorSize: settings.subsetGateSize,
            ...(k > 1
              ? {
                  fraction: SUBSET_GATE_SIZE_DEFAULTS.fraction * k,
                  minSize: SUBSET_GATE_SIZE_DEFAULTS.minSize * k,
                  maxSize: SUBSET_GATE_SIZE_DEFAULTS.maxSize * k,
                }
              : {}),
          })
        const sizingA = sizing(kpsA.length)
        const sizingB = sizing(kpsB.length)
        const dim = srcA.descDim ?? 128
        if (kpsA.length > sizingA.size * 1.5 && kpsB.length > sizingB.size * 1.5) {
          const sampleA = gateSample(kpsA, descA, sizingA.size, dim)
          const sampleB = gateSample(kpsB, descB, sizingB.size, dim)
          const gate = await bruteForce(
            sampleA.desc,
            sampleB.desc,
            {
              ratioThreshold: settings.ratioThreshold,
              crossCheck: settings.crossCheck,
              dim,
            },
            'gate',
            // The GPU keeps each image's sample for the run, as it does full descriptors.
            [`${srcA.uuid}@gate${sizingA.size}`, `${srcB.uuid}@gate${sizingB.size}`],
          )
          const gateThreshold = settings._gateThreshold ?? settings.subsetGateThreshold
          entry.gateScore = gate.matches.length
          if (gate.matches.length < gateThreshold) {
            entry.rawCount = 0
            entry.status = 'done'
            entry.gated = true
            // No line per gated pair: on PUTI the 96k of them cost 28 s of main thread.
            // The count goes into the run's summary; the score stays on the entry.
            touchSoon()
            onDone?.(pid, entry)
            return
          }
        }
      }

      // Putative correspondences: LightGlue (learned joint matcher) or brute-force
      // NN + Lowe ratio. LightGlue needs keypoints + image sizes (it normalizes
      // coords internally); brute-force needs only descriptors. Either way `raw`
      // is a [{ia,ib}] list that flows through the same verify/gate path below.
      let raw
      if (settings.matcher === 'lightglue') {
        const [wA, hA] = imageDims(srcA, kpsA)
        const [wB, hB] = imageDims(srcB, kpsB)
        const res = await matchLightGlue(
          {
            kpsA,
            descA,
            wA,
            hA,
            kpsB,
            descB,
            wB,
            hB,
            // LightGlue weights are trained per detector (SuperPoint ≠ DISK ≠ ALIKED).
            modelId: learnedDetector(srcA.detector).matcherModelId,
            minConf: settings.lgMinConf,
            maxKeypoints: settings.lgMaxKeypoints,
            useGpu: settings.useGpu,
            // Coarse-to-fine tiled guided matching (opt-in). When off, `tiled` is
            // falsy and the worker routes to the plain capped path. The guide
            // thresholds come from MATCH_TUNING via the settings merge above.
            tiled: settings.lgTiled,
            coarseKeypoints: settings.lgCoarseKeypoints,
            coarseGateMin: settings.lgCoarseGateMin,
            tileBudget: settings.lgTileBudget,
            guideMinMatches: settings.lgGuideMinMatches,
            guideMinInliers: settings.lgGuideMinInliers,
            guideMinInlierRatio: settings.lgGuideMinInlierRatio,
            guideRelThresh: settings.lgGuideRelThresh,
            tileMinKps: settings.lgTileMinKps,
          },
          { ...timing('matchingMs'), onLog: (msg, level = 'info') => log(msg, level, 'Matching') },
        )
        raw = res.matches
      } else {
        const res = await bruteForce(
          descA,
          descB,
          {
            ratioThreshold: settings.ratioThreshold,
            crossCheck: settings.crossCheck,
            // Descriptor width must match the detector: 128 (SIFT) vs 256 (SuperPoint).
            // The crate slices the flat buffer by `dim`; a wrong dim yields phantom
            // rows and out-of-range match indices → the `reading 'x'` crash in verify.
            dim: srcA.descDim ?? 128,
          },
          'full',
          [srcA.uuid, srcB.uuid],
        )
        // One index per physical feature from here on: matches made through a
        // secondary SIFT orientation are re-expressed on the dominant keypoint and
        // deduplicated, so verification and SfM never see a feature twice (a split
        // track). No-op for images detected with one orientation.
        const sib = canonicalizeMatches(res.matches, canonFor(kpsA), canonFor(kpsB))
        raw = sib.matches
        entry.siblingMerged = sib.merged
        entry.siblingAmbiguous = sib.ambiguous
      }
      if (settings.filterStationary) {
        const [w, h] = imageDims(srcA, kpsA)
        const st = filterStationaryMatches(kpsA, kpsB, raw, { tolPx: stationaryTolPx(w, h, settings.stationaryTolPct) })
        raw = st.matches
        entry.stationaryDropped = st.dropped
      }
      entry.rawCount = raw.length

      const minMatches = settings.minMatches
      // Decoupled raw-putative skip (WS1): skipping below `rawSkipFloor` raw matches saves
      // the verify cost on pairs that clearly can't produce enough inliers — but it must
      // never be wider than the accept floor, or raising minMatches would silently kill
      // pairs before they're even verified (and before the weak-pair fallback can see them).
      const rawSkipFloor = Math.min(settings.rawSkipFloor, minMatches)

      if (raw.length < rawSkipFloor) {
        entry.status = 'done'
        entry.skipped = true
        const label = `${imgA.name} ↔ ${imgB.name}`
        log(`Skip: ${label} — only ${raw.length} raw matches (need ${rawSkipFloor})`, 'debug', 'Matching')
        touchSoon()
        onDone?.(pid, entry)
        return
      }

      if (settings.geometricVerification !== false) {
        // The RANSAC gate is in DETECTION pixels, but kpsA/kpsB are in native
        // pixels (detect.js maps them back), so resolve it against this pair's
        // detection scale. Per pair, not per run: two images may have been detected
        // at different scales, and the coarser one sets the epipolar noise floor.
        // Both at full resolution ⇒ factor 1 ⇒ the configured value, unchanged.
        const scaleCtx = pairScaleContext(srcA, srcB)
        const ransacPx = resolveScaledPx(settings.ransacThreshPx, scaleCtx)
        // A fisheye image verifies in its pinhole frame (core/features/verifyFrame.js);
        // `keep` maps the verified rows back to `raw` when off-axis putatives were left out.
        const packed = packMatchedPoints(kpsA, kpsB, raw)
        const { ptsA, ptsB, keep } = mapVerifyPoints(
          packed.ptsA,
          packed.ptsB,
          verifyMapperFor(imgA),
          verifyMapperFor(imgB),
        )
        const verified = await verifyPointPairs(
          ptsA,
          ptsB,
          {
            ransacThreshPx: ransacPx,
            maxIters: settings.maxIters,
            verifier: settings.verifier,
            // Skip H-RANSAC on pairs below the hard acceptance floor: they're rejected
            // regardless of H, so the H/F degeneracy label is never consulted (see
            // verify_matches_hf). minMatches is the one un-overridable accept gate.
            hSkipBelow: minMatches,
            // Best first, for PROSAC sampling: a weak pair's few good matches are
            // found in a few hundred samples instead of being missed.
            order: qualityOrder(raw, keep),
          },
          { ...timing('verificationMs'), avoidWorker },
        )
        const result =
          verified && keep
            ? { ...verified, inlierMask: expandInlierMask(verified.inlierMask, keep, raw.length) }
            : verified
        // Classify via the pure gate (core/features/pairGate.js): accept / weak / reject.
        // `spread` is computed here (needs the store's keypoints); everything else is a
        // plain-data decision the gate owns so it can be unit-tested in isolation.
        const spread = result ? inlierSpread(kpsA, kpsB, raw, result.inlierMask) : null
        const verdict = evaluatePairAcceptance({ result, rawCount: raw.length, spread, settings })
        const { ratio, hfRatio, overrode } = verdict
        entry.hInlierCount = verdict.hInlierCount
        entry.hfRatio = hfRatio
        entry.degenerate = verdict.degenerate
        if (verdict.accept || verdict.weak) {
          // Both keep F + the inlier match list. A WEAK pair (valid F, enough inliers,
          // but below the accept gate) is preserved as a registration-only bridge:
          // sfm.js feeds it to PnP but never seeds init or triangulates from it.
          entry.F = result.F
          entry.inlierCount = result.inlierCount
          matches = packPutatives(raw, (i) => result.inlierMask[i] > 0.5)
          entry.weak = verdict.weak
          if (verdict.weak) entry.rejectReason = verdict.reason
        } else {
          entry.inlierCount = 0
          matches = EMPTY_MATCHES
          entry.rejectRatio = ratio // for the run summary stats
          entry.rejectReason = verdict.reason
        }
        // Detailed diagnostics (debug level): putatives, inliers, the ratio, and
        // the gate/threshold that decided the outcome — for every verified pair,
        // not just rejects (marginal accepts are the interesting ones to audit).
        log(
          `Match ${imgA.name} ↔ ${imgB.name} — ${raw.length} putatives → ` +
            `${result?.inlierCount ?? 0} inliers (ratio ${ratio.toFixed(2)}, gate ${settings.minInlierRatio}` +
            `${overrode ? `, ratio-override on ${result.inlierCount}≥${settings.overrideInliers} inliers` : ''}), ` +
            `H/F ${hfRatio.toFixed(2)}${entry.degenerate ? ' (degenerate — planar/pure-rotation, poor seed)' : ''}, ` +
            `${spread ? `spread ${spread.uniqueA}/${spread.uniqueB} unique, ${spread.extentA.toFixed(0)}/${spread.extentB.toFixed(0)}px` : 'spread n/a'}` +
            `${verdict.spreadDegenerate ? ' (positional collapse — REJECTED)' : ''}` +
            `${verdict.weak ? ' (WEAK — PnP bridge only)' : ''}, ` +
            `${settings.verifier === 'magsac' ? 'MAGSAC++' : 'RANSAC'} ${ransacPx.toFixed(2)}px` +
            `${
              scaleCtx.factor === 1
                ? ''
                : ` (${settings.ransacThreshPx} detect-px ×${scaleCtx.factor.toFixed(2)} ` +
                  `for detection scale ${scaleCtx.medianScale.toFixed(3)})`
            }`,
          'debug',
          'Matching',
        )
      } else {
        matches = packPutatives(raw)
        entry.inlierCount = raw.length
      }

      // Back into storage order: swap each [ia, ib] and transpose F (x_B·F·x_A = 0
      // becomes x_A·Fᵀ·x_B = 0). Every other entry field is symmetric in the roles.
      if (swapRoles) {
        matches = swapMatchRoles(matches)
        if (entry.F) entry.F = transposeF(entry.F)
      }
      holdMatches(pid, entry, matches)
      entry.status = 'done'

      // Every done pair persists — accepted, weak (a weak bridge must survive a reload
      // or the graph re-severs on restore) and rejected (packMatchDocument keeps any
      // done pair, so a reload counts it and matching does not try it again).
      markHeavy()

      const label = `${imgA.name} ↔ ${imgB.name}`
      // A pair with 0 inliers failed geometric verification — it is not a usable
      // match, so don't report it in green as a success. Weak pairs get their own line.
      if (entry.weak) {
        log(
          `Weak: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers, ${entry.rejectReason}`,
          'info',
          'Matching',
        )
      } else if (entry.inlierCount > 0) {
        log(`Matched: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers`, 'success', 'Matching')
      } else {
        // Report the recorded cause (ratio-gate vs absolute-inlier floor vs no model),
        // not a blanket "ratio too low" that misreads floor rejections.
        log(
          `Rejected: ${label} — ${entry.rawCount} raw matches, ` +
            `${entry.rejectReason ?? 'none passed geometric verification'}`,
          'debug',
          'Matching',
        )
      }
    } catch (err) {
      // A cancelled run hard-terminates the worker pool, so the in-flight worker
      // call rejects here — that's an expected user action, not a failure. Mark the
      // pair and return quietly (warn, not error) rather than throwing out of the
      // drain loop.
      entry.status = 'error'
      const msg = err?.message ?? String(err)
      const cancelled = /cancel/i.test(msg)
      log(
        `Match ${cancelled ? 'cancelled' : 'error'}: ${imgA.name} ↔ ${imgB.name}` + `${cancelled ? '' : ` — ${msg}`}`,
        cancelled ? 'warn' : 'error',
        'Matching',
      )
    }

    touchSoon()
    markHeavy()
    onDone?.(pairId(imgA.uuid, imgB.uuid), entry)
  }

  return { verifyMapperFor, matchPairOnce }
}
