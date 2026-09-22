import { shallowRef, triggerRef, computed } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'
import { matchDescriptors, matchLightGlue, verifyMatches, POOL_SIZE } from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import { preselectPairs, positionsForProximity, preselectByFootprintOverlap } from '../core/features/preselect.js'
import { sequentialPairs } from '../core/features/sequentialPairs.js'
import { inlierSpread } from '../core/features/verify.js'
import { evaluatePairAcceptance } from '../core/features/pairGate.js'
import { pickSpreadIndices, sliceDescriptorRows, resolveSubsetGateSize } from '../core/features/subsetGate.js'
import { MATCH_DEFAULTS } from '../core/defaults.user.js'
import { MATCH_TUNING } from '../core/tuning.js'
import { pairScaleContext, buildScaleContext, describeScaleContext, resolveScaledPx } from '../core/scaleContext.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useFootprintsStore } from './useFootprintsStore.js'
import { useModelsStore } from './useModelsStore.js'

// Original image dimensions (px) in the same space as keypoint x,y — needed by
// LightGlue's coord normalization. Prefer EXIF meta; else recover from a keypoint
// (x = nx·natW, where nx is the detect-normalized coord stored alongside).
function imageDims(img) {
  const w = img.meta?.width, h = img.meta?.height
  if (w && h) return [w, h]
  const kp = img.keypoints?.find((k) => k.nx > 0 && k.ny > 0)
  if (kp) return [Math.round(kp.x / kp.nx), Math.round(kp.y / kp.ny)]
  return [1, 1]
}

// Project-scoped store: pairwise feature matches. Reads persistence flags from the
// projects store; restore/clear run through the project-store registry.
export const useMatchesStore = registerProjectStore(defineStore('matches', () => {
  const { log } = useLog()
  const projects = useProjectsStore()
  const posesStore = usePosesStore()

  // pairId → { idA, idB, rawCount, inlierCount, F, matches: [[ia,ib],...], status,
  //            disabled }. `disabled` is a user override that excludes an otherwise-
  //            verified pair from reconstruction (obviously-wrong matches) — reversible.
  // shallowRef + in-place mutation + triggerRef (NOT a whole-Map copy per write):
  // this is what makes concurrent matchPair() calls safe — copying the Map on every
  // write races (one writer's snapshot clobbers another's set). See P2 in HANDOVER.
  const matchStore = shallowRef(new Map())
  const touch = () => triggerRef(matchStore)

  // The last completed matchAll run: its settings and its gate accounting (accepted /
  // weak / rejected / raw-skipped / subset-gated). Kept because the accounting is what
  // diagnoses a graph problem — "542 of 1280 sequential pairs gated" was the whole
  // 2026-07-25 bug, and no per-pair record shows it. Session-scoped on purpose: match
  // *pairs* persist per file, there is no run-level file, and a re-opened project has
  // no run to describe. Null until a run completes; a cancelled run leaves it alone.
  const matchRun = shallowRef(null)
  let restoreGeneration = 0

  // Persist only when a project is open and OPFS is usable (see useProjectsStore).
  const isPersisting = () => projects.isPersisting

  function pairId(uuidA, uuidB) {
    return [uuidA, uuidB].sort().join('--')
  }

  function getMatch(uuidA, uuidB) {
    return matchStore.value.get(pairId(uuidA, uuidB)) ?? null
  }

  const verifiedPairs = computed(() => {
    let n = 0
    // Weak pairs (PnP bridges) don't count as verified geometry — they carry inliers but
    // failed the accept gate, so they're excluded here and from matchStats (reported apart).
    for (const v of matchStore.value.values()) if (v.status === 'done' && v.inlierCount > 0 && !v.weak) n++
    return n
  })
  const usableMatchCount = computed(() => {
    let n = 0
    for (const entry of matchStore.value.values()) {
      if (entry.status === 'done' && !entry.disabled && entry.inlierCount > 0) n++
    }
    return n
  })

  // `descCache` (optional): id → descriptors, shared across a matchAll run so each
  // image's descriptors are loaded from OPFS once instead of once per pair (an
  // image appears in N−1 pairs, so this turns O(N²) loads into O(N)).
  async function matchPair(imgA, imgB, settings = {}, onDone, descCache = null) {
    // Resolve every knob from the single source of truth (defaults.user.js +
    // tuning.js), caller's `settings` winning. Downstream reads `settings.X` directly.
    settings = { ...MATCH_DEFAULTS, ...MATCH_TUNING, ...settings }
    const [idA, idB] = [imgA.uuid, imgB.uuid].sort()
    const pid = pairId(idA, idB)
    // Ensure descriptors are ordered the same way as IDs
    const [kpsA, kpsB] = idA === imgA.uuid
      ? [imgA.keypoints, imgB.keypoints]
      : [imgB.keypoints, imgA.keypoints]

    const entry = { idA, idB, rawCount: 0, inlierCount: 0, F: null, matches: [], status: 'running', disabled: false, weak: false }
    matchStore.value.set(pid, entry)
    // Trigger reactivity
    touch()

    const projectId = projects.currentProjectId
    const persist = isPersisting()
    try {
      // Supersede the old result before any early exit (gated, failed or cancelled).
      if (persist) await opfs.deleteMatches(projectId, pid)
      // Image whose uuid sorts first → idA; its descriptors go to descA
      const srcA = idA === imgA.uuid ? imgA : imgB
      const srcB = idA === imgA.uuid ? imgB : imgA

      // Cache the in-flight PROMISE (not just the result) so that concurrent pairs
      // sharing an image load its descriptors from OPFS exactly once.
      const loadDesc = (id, src) => {
        if (descCache?.has(id)) return descCache.get(id)
        const p = isPersisting()
          ? opfs.loadDescriptors(projectId, id)
          : Promise.resolve(src.descriptors ?? null)
        descCache?.set(id, p)
        return p
      }
      const descA = await loadDesc(idA, srcA)
      const descB = await loadDesc(idB, srcB)

      if (!descA || !descB) {
        entry.status = 'error'
        const names = `${imgA.name} / ${imgB.name}`
        log(`Match failed: descriptors missing for ${names} — re-run feature detection`, 'error', 'Matching')
        touch()
        return
      }

      const dimA = srcA.descDim ?? 128
      const dimB = srcB.descDim ?? 128
      if (dimA !== dimB || (srcA.detector ?? 'sift') !== (srcB.detector ?? 'sift')
          || !Number.isSafeInteger(dimA) || dimA <= 0
          || descA.length !== kpsA.length * dimA || descB.length !== kpsB.length * dimB
          || (settings.matcher === 'lightglue' && (srcA.detector ?? 'sift') !== 'superpoint')) {
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
      const gateEnabled = settings.subsetGate !== false && settings.matcher !== 'lightglue'
        && !settings._skipSubsetGate
      if (gateEnabled) {
        // Size the sample from THIS pair's actual keypoint counts, not a fixed
        // figure: the gate's threshold is applied to a sampled count, so holding
        // the sample size fixed makes the test ~1/N more severe as keypoint counts
        // rise — at the Detailed detection preset a fixed 200 would veto nearly
        // every pair. See core/features/subsetGate.js for the arithmetic.
        const gateSizing = resolveSubsetGateSize(kpsA.length, kpsB.length, {
          floorSize: settings.subsetGateSize,
        })
        const gateSize = gateSizing.size
        const dim = srcA.descDim ?? 128
        if (kpsA.length > gateSize * 1.5 && kpsB.length > gateSize * 1.5) {
          const idxA = pickSpreadIndices(kpsA, gateSize)
          const idxB = pickSpreadIndices(kpsB, gateSize)
          const subA = sliceDescriptorRows(descA, idxA, dim)
          const subB = sliceDescriptorRows(descB, idxB, dim)
          const gate = await matchDescriptors(subA, subB, {
            ratioThreshold: settings.ratioThreshold,
            crossCheck: settings.crossCheck,
            dim,
          })
          const gateThreshold = settings.subsetGateThreshold
          if (gate.matches.length < gateThreshold) {
            entry.rawCount = 0
            entry.status = 'done'
            entry.gated = true
            log(`Gated: ${imgA.name} ↔ ${imgB.name} — subset gate ${gate.matches.length}/${gateThreshold} `
              + `putatives on ${idxA.length}×${idxB.length}-kp subsets `
              + `(${(gateSizing.fraction * 100).toFixed(1)}% sample of ${kpsA.length}/${kpsB.length} kp`
              + `${gateSizing.clamped ? `, at the ${gateSizing.clamped === 'ceil' ? 'cost ceiling' : 'size floor'}` : ''})`
              + ' — skipping full match', 'debug', 'Matching')
            touch()
            onDone?.(pid, entry)
            return
          }
          log(`Gate passed: ${imgA.name} ↔ ${imgB.name} — ${gate.matches.length} subset putatives `
            + `(≥${gateThreshold}) → full match`, 'debug', 'Matching')
        }
      }

      // Putative correspondences: LightGlue (learned joint matcher) or brute-force
      // NN + Lowe ratio. LightGlue needs keypoints + image sizes (it normalizes
      // coords internally); brute-force needs only descriptors. Either way `raw`
      // is a [{ia,ib}] list that flows through the same verify/gate path below.
      let raw
      if (settings.matcher === 'lightglue') {
        const [wA, hA] = imageDims(srcA)
        const [wB, hB] = imageDims(srcB)
        const res = await matchLightGlue({
          kpsA, descA, wA, hA, kpsB, descB, wB, hB,
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
        }, { onLog: (msg, level = 'info') => log(msg, level, 'Matching') })
        raw = res.matches
      } else {
        const res = await matchDescriptors(descA, descB, {
          ratioThreshold: settings.ratioThreshold,
          crossCheck: settings.crossCheck,
          // Descriptor width must match the detector: 128 (SIFT) vs 256 (SuperPoint).
          // The crate slices the flat buffer by `dim`; a wrong dim yields phantom
          // rows and out-of-range match indices → the `reading 'x'` crash in verify.
          dim: srcA.descDim ?? 128,
        })
        raw = res.matches
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
        touch()
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
        const result = await verifyMatches(kpsA, kpsB, raw, {
          ransacThreshPx: ransacPx,
          maxIters: settings.maxIters,
          // Skip H-RANSAC on pairs below the hard acceptance floor: they're rejected
          // regardless of H, so the H/F degeneracy label is never consulted (see
          // verify_matches_hf). minMatches is the one un-overridable accept gate.
          hSkipBelow: minMatches,
        })
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
          entry.matches = raw
            .filter((_, i) => result.inlierMask[i] > 0.5)
            .map(m => [m.ia, m.ib])
          entry.weak = verdict.weak
          if (verdict.weak) entry.rejectReason = verdict.reason
        } else {
          entry.inlierCount = 0
          entry.matches = []
          entry.rejectRatio = ratio // for the run summary stats
          entry.rejectReason = verdict.reason
        }
        // Detailed diagnostics (debug level): putatives, inliers, the ratio, and
        // the gate/threshold that decided the outcome — for every verified pair,
        // not just rejects (marginal accepts are the interesting ones to audit).
        log(`Match ${imgA.name} ↔ ${imgB.name} — ${raw.length} putatives → `
          + `${result?.inlierCount ?? 0} inliers (ratio ${ratio.toFixed(2)}, gate ${settings.minInlierRatio}`
          + `${overrode ? `, ratio-override on ${result.inlierCount}≥${settings.overrideInliers} inliers` : ''}), `
          + `H/F ${hfRatio.toFixed(2)}${entry.degenerate ? ' (degenerate — planar/pure-rotation, poor seed)' : ''}, `
          + `${spread ? `spread ${spread.uniqueA}/${spread.uniqueB} unique, ${spread.extentA.toFixed(0)}/${spread.extentB.toFixed(0)}px` : 'spread n/a'}`
          + `${verdict.spreadDegenerate ? ' (positional collapse — REJECTED)' : ''}`
          + `${verdict.weak ? ' (WEAK — PnP bridge only)' : ''}, `
          + `RANSAC ${ransacPx.toFixed(2)}px`
          + `${scaleCtx.factor === 1 ? '' : ` (${settings.ransacThreshPx} detect-px ×${scaleCtx.factor.toFixed(2)} `
            + `for detection scale ${scaleCtx.medianScale.toFixed(3)})`}`, 'debug', 'Matching')
      } else {
        entry.matches = raw.map(m => [m.ia, m.ib])
        entry.inlierCount = raw.length
      }

      entry.status = 'done'

      // Persist any pair carrying inlier matches — accepted AND weak (a weak bridge must
      // survive a reload or the graph re-severs on restore). The old `>= minMatches` gate
      // dropped weak pairs whenever minMatches was raised above their inlier count.
      if (persist && entry.matches.length > 0) {
        await opfs.saveMatches(projectId, pid, {
          idA, idB,
          rawCount: entry.rawCount,
          inlierCount: entry.inlierCount,
          F: entry.F,
          matches: entry.matches,
          disabled: entry.disabled,
          weak: entry.weak,
        })
      }

      const label = `${imgA.name} ↔ ${imgB.name}`
      // A pair with 0 inliers failed geometric verification — it is not a usable
      // match, so don't report it in green as a success. Weak pairs get their own line.
      if (entry.weak) {
        log(`Weak: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers, ${entry.rejectReason}`,
          'info', 'Matching')
      } else if (entry.inlierCount > 0) {
        log(`Matched: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers`, 'success', 'Matching')
      } else {
        // Report the recorded cause (ratio-gate vs absolute-inlier floor vs no model),
        // not a blanket "ratio too low" that misreads floor rejections.
        log(`Rejected: ${label} — ${entry.rawCount} raw matches, `
          + `${entry.rejectReason ?? 'none passed geometric verification'}`, 'debug', 'Matching')
      }
    } catch (err) {
      // A cancelled run hard-terminates the worker pool, so the in-flight worker
      // call rejects here — that's an expected user action, not a failure. Mark the
      // pair and return quietly (warn, not error) rather than throwing out of the
      // drain loop.
      entry.status = 'error'
      const msg = err?.message ?? String(err)
      const cancelled = /cancel/i.test(msg)
      log(`Match ${cancelled ? 'cancelled' : 'error'}: ${imgA.name} ↔ ${imgB.name}`
        + `${cancelled ? '' : ` — ${msg}`}`, cancelled ? 'warn' : 'error', 'Matching')
    }

    touch()
    onDone?.(pairId(imgA.uuid, imgB.uuid), entry)
  }

  // Camera positions (project CRS) from imported poses, keyed by image **uuid** —
  // the key every preselect step downstream uses (pairId is uuid-based). Poses link
  // to images by image.id (the name/size composite), so bridge id→uuid via the image
  // list; only resolved poses (imageId set, x/y present) count.
  function positionsByUuid(images) {
    const poseById = new Map()
    for (const p of posesStore.poses) {
      if (p.enabled !== false && p.imageId && Number.isFinite(p.x) && Number.isFinite(p.y))
        poseById.set(p.imageId, p)
    }
    const linked = []
    for (const img of images) {
      const pose = poseById.get(img.id)
      if (pose) linked.push({ uuid: img.uuid, pos: [pose.x, pose.y] })
    }
    return new Map(positionsForProximity(linked, projects.currentCrs)
      .map((item) => [item.uuid, item.pos]))
  }

  // Best footprint outer-ring per image, keyed by image **uuid** (same id→uuid
  // bridge as positionsByUuid). Prefers a computed set (one polygon per image, in
  // the project frame) over an imported one; first match wins otherwise.
  function footprintRingsByUuid(images) {
    const ringById = new Map() // image.id -> { ring, source }
    for (const set of useFootprintsStore().sets) {
      for (const fp of set.footprints) {
        if (!fp.imageId || !fp.rings?.length) continue
        const existing = ringById.get(fp.imageId)
        if (!existing || (existing.source !== 'computed' && set.source === 'computed'))
          ringById.set(fp.imageId, { ring: fp.rings[0], source: set.source })
      }
    }
    const m = new Map()
    for (const img of images) {
      const e = ringById.get(img.id)
      if (e) m.set(img.uuid, e.ring)
    }
    return m
  }

  async function matchAll(images, settings = {}, onProgress, shouldCancel) {
    restoreGeneration++
    // Same merge as matchPair so this function's own settings reads (and its
    // matchPair calls) all draw from the single source of truth.
    settings = { ...MATCH_DEFAULTS, ...MATCH_TUNING, ...settings }
    const ready = images.filter((img) => img.kpStatus === 'done' && (img.keypoints?.length ?? 0) > 0)
    const strategy = settings.strategy ?? 'exhaustive'

    // LightGlue's weights are trained on SuperPoint's 256-d descriptors — refuse
    // to run it on SIFT (128-d) features, which would silently produce garbage.
    if (settings.matcher === 'lightglue') {
      const bad = ready.filter((im) => im.detector !== 'superpoint' || (im.descDim ?? 128) !== 256)
      if (bad.length) {
        const names = bad.map((im) => `"${im.name}" (${im.detector ?? 'sift'}/${im.descDim ?? 128}-d)`)
        const shown = names.slice(0, 5).join(', ')
        const more = names.length > 5 ? `, +${names.length - 5} more` : ''
        log(`LightGlue needs SuperPoint (256-d) descriptors, but ${bad.length} of ${ready.length} `
          + `image(s) are not: ${shown}${more} — re-detect these with SuperPoint (Overwrite mode), `
          + 'or switch the matcher to brute-force.', 'error', 'Matching')
        return
      }
      // Fetch the LightGlue weights (with consent) before dispatching to the worker.
      if (!(await useModelsStore().ensureReady(['lightglue']))) {
        log('Matching cancelled — LightGlue model was not downloaded.', 'warn', 'Matching')
        return
      }
    }

    let pairs = []
    if (strategy === 'sequential') {
      pairs = sequentialPairs(ready, {
        overlap: settings.sequentialOverlap,
        loopClosure: settings.sequentialLoopClosure,
      })
      log(`Sequential pairing: each image ↔ next ${settings.sequentialOverlap} in capture order`
        + `${settings.sequentialLoopClosure ? ', with end-to-start loop closure' : ''}`
        + ` — ${pairs.length} pair(s)`, 'info', 'Matching')
    } else {
      for (let i = 0; i < ready.length; i++)
        for (let j = i + 1; j < ready.length; j++)
          pairs.push([ready[i], ready[j]])
    }

    // Preselection: prune the exhaustive set to pairs that plausibly overlap, so an
    // ordered block costs far less than O(N²). Two evidence sources — camera
    // proximity (imported poses) or ground overlap (image footprints). A pair with
    // an endpoint the chosen method can't judge is kept (never silently dropped).
    // Whether preselection actually pruned pairs (a requested preselect can fall
    // back to exhaustive when too few images carry footprints/positions — in that
    // case the subset gate must still run, as no overlap prefilter happened).
    //
    // Sequential pairing counts as an overlap prefilter for exactly the same reason
    // camera-proximity preselection does: it has ALREADY decided which pairs
    // plausibly overlap, using capture order. Running the subset gate on top of it
    // only removes chain links — and a sequential chain has no redundancy, so a
    // false veto severs the graph outright. Measured on the 128-image building set
    // (2026-07-25): 542 of 1280 sequential pairs gated, match graph split into 2
    // components (largest 85/128), 101 images left with zero correspondences to the
    // registered set. The gate's threshold is calibrated against strongly-overlapping
    // pairs; the weak links a chain depends on expect well under one subset putative.
    let overlapPrefiltered = strategy === 'sequential'
    if (strategy === 'preselect') {
      const method = settings.preselectMethod ?? 'position'
      if (method === 'footprint') {
        const rings = footprintRingsByUuid(ready)
        if (rings.size < 2) {
          log('Preselection: fewer than 2 images have footprints — matching exhaustively instead', 'warn', 'Matching')
        } else {
          const keep = preselectByFootprintOverlap(
            [...rings].map(([uuid, ring]) => ({ uuid, ring })),
            { minOverlap: (settings.minOverlap ?? 30) / 100 },
          )
          const before = pairs.length
          pairs = pairs.filter(([a, b]) =>
            (rings.has(a.uuid) && rings.has(b.uuid)) ? keep.has(pairId(a.uuid, b.uuid)) : true)
          overlapPrefiltered = true
          log(`Preselection: ${pairs.length}/${before} pair(s) kept, ${before - pairs.length} skipped `
            + `(footprint overlap ≥ ${settings.minOverlap ?? 30}%)`, 'info', 'Matching')
        }
      } else {
        const pos = positionsByUuid(ready)
        if (pos.size < 2) {
          log('Preselection: fewer than 2 images have camera positions — matching exhaustively instead', 'warn', 'Matching')
        } else {
          const keep = preselectPairs(
            [...pos].map(([uuid, p]) => ({ uuid, pos: p })),
            { maxNeighbors: settings.maxNeighbors },
          )
          const before = pairs.length
          pairs = pairs.filter(([a, b]) =>
            (pos.has(a.uuid) && pos.has(b.uuid)) ? keep.has(pairId(a.uuid, b.uuid)) : true)
          overlapPrefiltered = true
          log(`Preselection: ${pairs.length}/${before} pair(s) kept, ${before - pairs.length} skipped `
            + `(camera proximity, ≤${settings.maxNeighbors} neighbours)`, 'info', 'Matching')
        }
      }
    }

    if (pairs.length === 0) {
      log('Match: no image pairs to process (need at least 2 images with keypoints)', 'warn', 'Matching')
      return
    }

    // Two per-run reasons to bypass the subset gate, both properties of the run rather
    // than of any one pair:
    //  • the pair set was ALREADY chosen for overlap — by preselection (camera
    //    proximity / footprints) or by capture order (sequential) — so the gate can
    //    only add false negatives. It vetoed 52% of preselected pairs on a low-keypoint
    //    aerial block, and 42% of sequential pairs on the 128-image building set;
    //  • too few pairs for the saving to exist — the gate skips O(Na·Nb) work, which is
    //    worth a false-negative risk across hundreds of pairs and worth nothing across a
    //    handful, where a single wrong veto can sever the match graph.
    const gateApplies = settings.subsetGate !== false && settings.matcher !== 'lightglue'
    let skipSubsetGate = false
    if (gateApplies && overlapPrefiltered) {
      skipSubsetGate = true
      log(`Subset gate disabled: ${strategy === 'sequential' ? 'capture order is' : 'preselection is'}`
        + ' the overlap prefilter', 'info', 'Matching')
    } else if (gateApplies && pairs.length < settings.subsetGateMinPairs) {
      skipSubsetGate = true
      log(`Subset gate disabled: only ${pairs.length} pair(s) (< ${settings.subsetGateMinPairs}) `
        + '— matching them in full is cheap, and a wrong veto could sever the match graph',
        'info', 'Matching')
    }
    settings = { ...settings, _skipSubsetGate: skipSubsetGate }

    // LightGlue is pinned to worker 0 and its ORT session is not reentrant (two
    // concurrent session.run() on one wasm session deadlock — the old 7-way freeze).
    // Parallel drain loops would all pile onto worker 0 and wedge it, so dispatch
    // LightGlue serially; serial also keeps the progress bar honest. Brute-force
    // keeps the full pool (each matchPair issues its own round-robin worker calls).
    const concurrency = settings.matcher === 'lightglue'
      ? 1
      : Math.max(1, Math.min(POOL_SIZE, pairs.length))
    // Log the descriptor-matching knobs so a run's settings are auditable — in
    // particular whether cross-check (mutual nearest neighbour) is active, which
    // otherwise leaves no trace in the console yet meaningfully changes putatives.
    const crossCheck = settings.crossCheck
    const lightglue = settings.matcher === 'lightglue'
    log(`Matching: ${pairs.length} pair(s) — ${strategy}${concurrency > 1 ? `, ${concurrency}× parallel` : ''}`
      + `; matcher ${lightglue ? 'LightGlue (learned)' : 'brute-force'}`
      + `${lightglue ? '' : `, cross-check ${crossCheck ? 'on (mutual NN)' : 'off'}, ratio ${settings.ratioThreshold}`}`,
      'info', 'Matching')
    // Report the detection-scale correction once per run at info level (the
    // per-pair resolved value is debug). Built over the images actually taking
    // part, so it describes this run rather than the project.
    let resolvedRansacPx = null
    if (settings.geometricVerification !== false) {
      const runCtx = buildScaleContext(ready)
      resolvedRansacPx = resolveScaledPx(settings.ransacThreshPx, runCtx)
      if (runCtx.factor !== 1 || runCtx.mixed) {
        log(describeScaleContext(runCtx, `RANSAC gate (${settings.ransacThreshPx} detect-px)`),
          runCtx.clamped ? 'warn' : 'info', 'Matching')
      }
    }
    let done = 0
    // Tally this run's outcomes for the completion summary. Skipped = too few raw
    // matches to bother verifying; rejected = verified but failed the count/ratio
    // gate; matched = kept (with ≥1 inlier).
    const stats = { matched: 0, weak: 0, rejected: 0, skipped: 0, gated: 0, inliers: 0, ratios: [], degenerate: 0 }
    const tally = (_pid, entry) => {
      if (entry.status !== 'done') return
      // Order matters: outcome flags are mutually exclusive but explicit (weak/gated/
      // skipped) so a decoupled raw-skip floor never misclassifies a reject as a skip.
      if (entry.gated) stats.gated++
      else if (entry.skipped) stats.skipped++
      else if (entry.weak) stats.weak++
      else if (entry.inlierCount > 0) {
        stats.matched++; stats.inliers += entry.inlierCount
        if (entry.rawCount) stats.ratios.push(entry.inlierCount / entry.rawCount)
        // H/F degeneracy is a per-pair label (planar scene / pure rotation) that no
        // count or ratio gate acts on, so it only ever reached the debug log — yet the
        // run-level SHARE is a first-order diagnostic: it is what decides whether an
        // aborted rotation-cycle filter means "bad intrinsics" or "F is not determined
        // on this geometry" (see the filter's sanity-abort). Counted over ACCEPTED
        // pairs only, because that is the exact population where H ran: `hSkipBelow`
        // = minMatches skips H below the accept floor, so any other denominator would
        // dilute the share with pairs that were never evaluated.
        if (entry.degenerate) stats.degenerate++
      } else stats.rejected++
    }

    // Load each image's descriptors from OPFS at most once for the whole run.
    const descCache = new Map()
    // Concurrency-limited dispatch: `concurrency` drain loops pull from a shared
    // cursor so up to POOL_SIZE pairs are matched at once (each matchPair issues its
    // own round-robin worker calls). Cancellation is cooperative — stop pulling.
    let cursor = 0
    let cancelled = false
    const drain = async () => {
      while (true) {
        if (cancelled || shouldCancel?.()) { cancelled = true; return }
        const i = cursor++
        if (i >= pairs.length) return
        const [a, b] = pairs[i]
        await matchPair(a, b, settings, tally, descCache)
        done++
        onProgress?.(done, pairs.length)
      }
    }
    await Promise.all(Array.from({ length: concurrency }, drain))
    if (cancelled || shouldCancel?.()) {
      log(`Matching cancelled — ${done}/${pairs.length} done`, 'warn', 'Matching')
      return
    }
    const meanRatio = stats.ratios.length
      ? stats.ratios.reduce((s, r) => s + r, 0) / stats.ratios.length : 0
    log(`Matching complete: ${done} pair(s) — ${stats.matched} accepted`
      + `${stats.weak ? `, ${stats.weak} weak (PnP bridges)` : ''}`
      + `, ${stats.rejected} rejected, ${stats.skipped} skipped`
      + `${stats.gated ? `, ${stats.gated} gated (subset pre-test)` : ''}`
      + `; ${stats.inliers} total inliers, mean inlier ratio ${meanRatio.toFixed(2)}`
      + `${stats.matched ? `, ${stats.degenerate}/${stats.matched} accepted pair(s) H/F-degenerate `
        + `(${(100 * stats.degenerate / stats.matched).toFixed(0)}% planar / pure-rotation)` : ''}`,
      'success', 'Matching')

    matchRun.value = {
      date: new Date().toISOString(),
      strategy,
      matcher: settings.matcher === 'lightglue' ? 'lightglue' : 'bruteforce',
      nImages: ready.length,
      nPairs: pairs.length,
      accepted: stats.matched,
      weak: stats.weak,
      rejected: stats.rejected,
      skipped: stats.skipped,
      gated: stats.gated,
      inliers: stats.inliers,
      meanInlierRatio: meanRatio,
      // Degenerate count + its denominator travel together: a bare count is unreadable
      // without knowing how many pairs H was actually evaluated on (accepted pairs).
      degenerate: stats.degenerate,
      degenerateOf: stats.matched,
      subsetGateActive: gateApplies && !skipSubsetGate,
      resolvedRansacPx,
      // The user-facing knobs only — the tuning.js internals are not what a baseline
      // varies, and dumping the merged object would bury the five that matter.
      settings: {
        ratioThreshold: settings.ratioThreshold,
        crossCheck: settings.crossCheck,
        minMatches: settings.minMatches,
        minInlierRatio: settings.minInlierRatio,
        ransacThreshPx: settings.ransacThreshPx,
        maxIters: settings.maxIters,
        subsetGate: settings.subsetGate,
        preselectMethod: strategy === 'preselect' ? settings.preselectMethod : null,
        maxNeighbors: strategy === 'preselect' ? settings.maxNeighbors : null,
        sequentialOverlap: strategy === 'sequential' ? settings.sequentialOverlap : null,
        sequentialLoopClosure: strategy === 'sequential' ? settings.sequentialLoopClosure : null,
        lgTiled: settings.matcher === 'lightglue' ? settings.lgTiled : null,
      },
    }
  }

  // Drop every pair involving `uuid`. Re-detecting an image (or clearing its
  // keypoints) renumbers its keypoint indices, so any stored match referencing
  // the old indices is now wrong — invalidate them rather than let stale indices
  // corrupt a later match/reconstruct run.
  function removeMatchesForImage(uuid) {
    restoreGeneration++
    let removed = 0
    for (const [pid, e] of matchStore.value) {
      if (e.idA === uuid || e.idB === uuid) {
        matchStore.value.delete(pid)
        if (isPersisting()) opfs.deleteMatches(projects.currentProjectId, pid).catch(() => {})
        removed++
      }
    }
    if (removed) {
      touch()
      log(`Matches invalidated: ${removed} pair(s) — keypoints changed, re-match these`, 'warn', 'Matching')
    }
    return removed
  }

  // Bulk import pairs whose feature indices already refer to the current image
  // keypoint arrays. External image ordering is normalized to the store's sorted
  // uuid ordering here; when it flips, each [ia,ib] pair flips with it.
  async function importMatches(entries, { replace = false } = {}) {
    restoreGeneration++
    const writes = []
    let imported = 0, skipped = 0
    for (const src of entries || []) {
      if (!src.uuidA || !src.uuidB || src.uuidA === src.uuidB) { skipped++; continue }
      const [idA, idB] = [src.uuidA, src.uuidB].sort()
      const pid = pairId(idA, idB)
      if (!replace && matchStore.value.has(pid)) { skipped++; continue }
      const flip = idA !== src.uuidA
      const matches = (src.matches || []).map(([a, b]) => flip ? [b, a] : [a, b])
      const entry = {
        idA, idB, rawCount: src.rawCount ?? matches.length,
        inlierCount: src.verified === false ? 0 : (src.inlierCount ?? matches.length),
        F: flip && src.F ? transpose3(src.F) : (src.F ?? null),
        matches, status: 'done', disabled: false, weak: src.verified === false,
        source: src.source ?? 'external',
      }
      matchStore.value.set(pid, entry)
      imported++
      if (isPersisting()) writes.push(opfs.saveMatches(projects.currentProjectId, pid, entry))
    }
    touch()
    if (writes.length) await Promise.all(writes)
    log(`Matches imported: ${imported} pair(s)${skipped ? `, ${skipped} skipped` : ''}`,
      imported ? 'success' : 'warn', 'Import')
    return { imported, skipped }
  }

  function transpose3(m) {
    return [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
  }

  // Toggle a verified pair's exclusion from reconstruction. A reversible user
  // override for obviously-wrong matches that clear every automatic gate; disabled
  // pairs stay stored (and re-enablable) but are filtered out at reconstruct time.
  function setPairDisabled(pid, disabled) {
    const entry = matchStore.value.get(pid)
    if (!entry || !!entry.disabled === !!disabled) return
    entry.disabled = !!disabled
    touch()
    if (isPersisting() && entry.matches.length) {
      opfs.saveMatches(projects.currentProjectId, pid, {
        idA: entry.idA, idB: entry.idB,
        rawCount: entry.rawCount, inlierCount: entry.inlierCount,
        F: entry.F, matches: entry.matches, disabled: entry.disabled, weak: entry.weak,
      }).catch(() => {})
    }
    log(`Pair ${disabled ? 'excluded from' : 'restored to'} reconstruction`, 'info', 'Matching', { channel: 'activity' })
  }

  // Project-store contract.
  async function restore({ projectId }) {
    const generation = ++restoreGeneration
    matchStore.value = new Map()
    // Pair JSON is potentially the largest collection of small files in a
    // project, but reconstruction cannot run correctly against a partially loaded
    // graph. Await it as part of project open; descriptor planes remain lazy and
    // are still read only when a new matching run needs them.
    const all = await opfs.loadAllMatches(projectId)
    if (generation !== restoreGeneration || projectId !== projects.currentProjectId) return
    const newMap = new Map()
    for (const { pairId, idA, idB, rawCount, inlierCount, F, matches, disabled, weak } of all) {
      newMap.set(pairId, {
        idA, idB,
        rawCount:     rawCount    ?? 0,
        inlierCount:  inlierCount ?? 0,
        F:            F           ?? null,
        matches:      matches     ?? [],
        status: 'done',
        disabled:     disabled    ?? false,
        weak:         weak        ?? false,
      })
    }
    matchStore.value = newMap
    if (all.length > 0) log(`Matches restored: ${all.length} pair(s)`, 'success', 'Matching')
  }

  // Reset in-memory matches. Only purge deletes the persisted match files — a plain
  // clear (project switch/close) must leave them, since restore reads them back and
  // currentProjectId still points at the project being left.
  function clear({ purge = false } = {}) {
    const removed = matchStore.value.size
    restoreGeneration++
    matchStore.value.clear()
    matchStore.value = new Map()
    matchRun.value = null
    if (purge && isPersisting()) {
      opfs.clearAllMatches(projects.currentProjectId).catch(() => {})
    }
    if (purge && removed) {
      log(`Removed ${removed} match pair${removed === 1 ? '' : 's'}`, 'info', 'Matching', { channel: 'activity' })
    }
  }

  return {
    matchStore, matchRun, pairId, getMatch, verifiedPairs, usableMatchCount,
    matchPair, matchAll, importMatches, removeMatchesForImage, setPairDisabled, restore, clear,
  }
}))
