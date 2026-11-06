// A whole matching run: pair selection (exhaustive, sequential, by position or
// footprint), the subset gate, the worker pool and the WebGPU router, progress and
// one save at the end. Split out of useMatchesStore; `deps` are the store's state
// and helpers, and `beginBatch` / `endBatch` / `bumpGeneration` its counters.
import { computed, toRaw } from 'vue'
import * as opfs from '../../utils/opfs.js'
import { canContinue, journalKey, startJournal } from '../../core/runJournal.js'
import {
  matchDescriptors,
  POOL_SIZE,
  matchDescriptorsGpu,
  matchGpuBegin,
  matchGpuEnd,
  GPU_MATCH_WORKER,
} from '../../workers/computeClient.js'
import { createGpuMatchRun } from './gpuMatchRun.js'
import { createDescriptorCache } from './descriptorCache.js'
import {
  preselectPairs,
  positionsForProximity,
  preselectByFootprintOverlap,
  footprintOverlap,
} from '../../core/features/preselect.js'
import { planBridgeRepair, bridgeKey, graphPieces } from '../../core/features/bridgeRepair.js'
import { gapDetectSettings, planGapRedetect } from '../../core/features/gapRedetect.js'
import { laterPassSpan, pairPassEnd, spanFraction } from '../../core/features/matchProgress.js'
import { sequentialPairs } from '../../core/features/sequentialPairs.js'
import { findRigs, rigMembership, rigPairs, rigSummary } from '../../core/sensors/rig.js'
import { isImageEnabled } from '../../core/imageEnabled.js'
import { lightGlueModelFor } from '../../core/features/learnedDetectors.js'
import { MATCH_DEFAULTS } from '../../core/defaults.user.js'
import { MATCH_TUNING } from '../../core/tuning.js'
import { applyTuningOverrides } from '../tuningOverrides.js'
import { buildScaleContext, describeScaleContext, resolveScaledPx } from '../../core/scaleContext.js'
import { useFootprintsStore } from '../useFootprintsStore.js'
import { useImagesStore } from '../useImagesStore.js'
import { useModelsStore } from '../useModelsStore.js'
import { nounFor, pluralize } from '../../core/textFormat.js'

export function createMatchAll({
  log,
  matchPair,
  matchRun,
  matchStore,
  pairId,
  posesStore,
  projects,
  save,
  touch,
  beginBatch,
  endBatch,
  bumpGeneration,
}) {
  // Camera positions (project CRS) from imported poses, keyed by image **uuid** —
  // the key every preselect step downstream uses (pairId is uuid-based). Poses link
  // to images by image.id (the name/size composite), so bridge id→uuid via the image
  // list; only resolved poses (imageId set, x/y present) count.
  function positionsByUuid(images) {
    const poseById = new Map()
    for (const p of posesStore.poses) {
      if (p.enabled !== false && p.imageId && Number.isFinite(p.x) && Number.isFinite(p.y)) poseById.set(p.imageId, p)
    }
    const linked = []
    for (const img of images) {
      const pose = poseById.get(img.id)
      if (pose) linked.push({ uuid: img.uuid, pos: [pose.x, pose.y] })
    }
    return new Map(positionsForProximity(linked, projects.currentCrs).map((item) => [item.uuid, item.pos]))
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

  // A pair's overlap evidence for bridge repair when it was never matched: footprint
  // overlap (0–1), else camera proximity relative to the block's typical spacing.
  function unmatchedPairScore(ready) {
    const rings = footprintRingsByUuid(ready)
    if (rings.size >= 2)
      return (a, b) => (rings.has(a) && rings.has(b) ? footprintOverlap(rings.get(a), rings.get(b)) : 0)
    const pos = positionsByUuid(ready)
    if (pos.size < 2) return null
    const pts = [...pos.values()]
    const nearest = pts
      .map((p) => Math.min(...pts.filter((q) => q !== p).map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))
      .sort((x, y) => x - y)
    const spacing = nearest[nearest.length >> 1] || 1
    return (a, b) => {
      const p = pos.get(a),
        q = pos.get(b)
      return p && q ? Math.exp(-Math.hypot(p[0] - q[0], p[1] - q[1]) / (3 * spacing)) : 0
    }
  }

  // Match again the pairs planBridgeRepair proposes, then log whether the pieces
  // joined. Pairs never matched before join `pairs`, so the run's totals include them.
  // `grew`: fewer images outside the main block or hanging on it by a thread.
  async function repairSplits(
    ready,
    pairs,
    settings,
    { round, tried, tally, untally, gpuRun, concurrency, isCancelled, onPair },
  ) {
    const byUuid = new Map(ready.map((im) => [im.uuid, im]))
    const ids = [...byUuid.keys()]
    const entriesOf = () =>
      [...matchStore.value.values()]
        .filter((e) => byUuid.has(e.idA) && byUuid.has(e.idB))
        .map((e) => ({ ...e, disabled: e.enabled === false }))
    const planOpts = {
      minComponent: settings.bridgeMinComponent,
      maxPairs: settings.bridgeMaxPairs,
      perComponent: settings.bridgePerComponent,
      retryMinRaw: settings.bridgeRetryMinRaw,
      weakInliers: settings.bridgeWeakInliers,
      weakCut: settings.bridgeWeakCut,
    }
    const plan = planBridgeRepair({
      imageIds: ids,
      entries: entriesOf(),
      scoreUnmatched: unmatchedPairScore(ready),
      tried,
      opts: planOpts,
    })
    if (plan.components < 2 && !plan.weakPieces) return {}
    const split =
      plan.components > 1 ? `in ${plan.components} pieces (largest ${plan.mainSize}/${ids.length} images` : ''
    const thread = plan.weakPieces
      ? `${pluralize(plan.weakImages, 'image')} in ${pluralize(plan.weakPieces, 'piece')} ` +
        `${plan.weakPieces === 1 ? 'hangs' : 'hang'} on the main block by pairs of fewer than ` +
        `${settings.bridgeWeakInliers} inliers (${settings.bridgeWeakCut} in all)`
      : ''
    if (!plan.pairs.length) {
      log(
        `Matching: ` +
          (split ? `the match graph is ${split})` : '') +
          (split && thread ? '; ' : '') +
          thread +
          (plan.pieces || plan.weakPieces
            ? '; no pair between them is worth matching again'
            : '; only single images are cut off'),
        'info',
        'Matching',
      )
      return {}
    }
    const nNew = plan.pairs.filter((p) => p.source === 'new').length
    for (const p of plan.pairs) tried.add(bridgeKey(p.idA, p.idB))
    log(
      `Matching: ` +
        (split ? `the match graph is ${split}, ${plan.detached} outside)` : '') +
        (split && thread ? '; ' : '') +
        thread +
        `. Bridge repair${round > 1 ? ` round ${round}` : ''}: matching ` +
        `${pluralize(plan.pairs.length, 'pair')} between the main block ` +
        `and ${pluralize(plan.pieces + plan.weakPieces, 'piece')} again (${plan.pairs.length - nNew} retried, ${nNew} not tried before), ` +
        `without the subset gate, ratio ${settings.bridgeRatioThreshold}, min inlier ratio ${settings.bridgeMinInlierRatio}, ` +
        `${settings.bridgeVerifier === 'magsac' ? 'MAGSAC++' : 'RANSAC'}`,
      'info',
      'Matching',
    )
    const repairSettings = {
      ...settings,
      _skipSubsetGate: true,
      ratioThreshold: Math.max(settings.ratioThreshold, settings.bridgeRatioThreshold),
      minInlierRatio: Math.min(settings.minInlierRatio, settings.bridgeMinInlierRatio),
      verifier: settings.bridgeVerifier ?? settings.verifier,
      lgMaxKeypoints: Math.round(settings.lgMaxKeypoints * (settings.bridgeLgKeypointScale ?? 1)),
    }
    const work = plan.pairs.map(({ idA, idB }) => [byUuid.get(idA), byUuid.get(idB)])
    for (const [a, b] of work) {
      const known = matchStore.value.get(pairId(a.uuid, b.uuid))
      if (known) untally(known)
      else pairs.push([a, b])
    }
    const cache = createDescriptorCache({ pairs: work, budgetBytes: (settings.descCacheMiB ?? 2048) * 2 ** 20 })
    let cursor = 0
    let joined = 0,
      finished = 0
    onPair(0, work.length)
    const drain = async () => {
      while (cursor < work.length) {
        if (isCancelled()) return
        const [a, b] = work[cursor++]
        await matchPair(a, b, repairSettings, tally, cache, gpuRun)
        cache.release(a.uuid)
        cache.release(b.uuid)
        const e = matchStore.value.get(pairId(a.uuid, b.uuid))
        if (e?.status === 'done' && e.inlierCount > 0 && !e.weak) joined++
        onPair(++finished, work.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, work.length) }, drain))
    if (isCancelled()) return { cancelled: true }
    const after = planBridgeRepair({ imageIds: ids, entries: entriesOf(), opts: { ...planOpts, maxPairs: 0 } })
    const loose = (p) => p.detached + p.weakImages
    log(
      `Matching: bridge repair accepted ${joined}/${pluralize(work.length, 'pair')}; the graph is now in ` +
        `${pluralize(after.components, 'piece')}, the largest ${after.mainSize}/${ids.length} images ` +
        `(was ${plan.mainSize})` +
        (plan.weakPieces || after.weakPieces
          ? `; ${pluralize(after.weakImages, 'image')} still ${after.weakImages === 1 ? 'hangs' : 'hang'} by a thread (was ${plan.weakImages})`
          : ''),
      loose(after) < loose(plan) ? 'success' : 'info',
      'Matching',
    )
    return { joined, grew: loose(after) < loose(plan) && loose(after) > 0 }
  }

  // Detect again at full size the photos of the pieces bridge repair left apart, with
  // their partners in the main block (core/features/gapRedetect.js), and match their
  // pairs again: a run of matchAll on them. → the summary kept on the run record, or
  // null when nothing was apart. `span`: the part of the bar this step fills.
  async function redetectGaps(images, ready, settings, requested, { onProgress, shouldCancel, span }) {
    const byUuid = new Map(ready.map((im) => [im.uuid, im]))
    const ids = [...byUuid.keys()]
    const entriesOf = () =>
      [...matchStore.value.values()]
        .filter((e) => byUuid.has(e.idA) && byUuid.has(e.idB))
        .map((e) => ({ ...e, disabled: e.enabled === false }))
    const pieceOpts = {
      minComponent: settings.bridgeMinComponent,
      weakInliers: settings.bridgeWeakInliers,
      weakCut: settings.bridgeWeakCut,
    }
    const apartNow = () => graphPieces({ imageIds: ids, entries: entriesOf(), opts: pieceOpts })
    const before = apartNow()
    const plan = planGapRedetect({
      pieces: before.pieces,
      entries: entriesOf(),
      images: new Map(ready.map((im) => [im.uuid, { detector: im.detector, detectScale: im.detectScale }])),
      imageCount: ready.length,
      opts: { maxScale: settings.gapMaxScale, partnerShare: settings.gapPartnerShare, maxShare: settings.gapMaxShare },
    })
    if (plan.skipped === 'none') return null
    const apart = `${pluralize(plan.apart, 'image')} ${plan.apart === 1 ? 'is' : 'are'} still apart after bridge repair`
    if (plan.skipped) {
      log(
        `Matching: ${apart}; ` +
          {
            native: 'they were detected at full size already, so detecting them again adds nothing',
            learned: 'their features are from a learned detector, which is not detected again at full size',
            many: `they are more than ${Math.round(100 * settings.gapMaxShare)} % of the block: detect every image at full size instead`,
          }[plan.skipped],
        'info',
        'Matching',
      )
      return { skipped: plan.skipped, apart: plan.apart }
    }
    const chosen = [...plan.loose, ...plan.partners].map((u) => byUuid.get(u))
    const detect = {
      ...gapDetectSettings(chosen, { maxKeypoints: settings.gapMaxKeypoints }),
      onlyIds: chosen.map((im) => im.id),
      _matchAgain: true, // its pairs are matched again below: no "re-match these" per image
      ...(settings.memBudgetBytes > 0 ? { memBudgetBytes: settings.memBudgetBytes } : {}),
    }
    log(
      `Matching: ${apart}, detected at ${plan.scale.toFixed(2)}× of their size — detecting ` +
        `${pluralize(plan.loose.length, 'image')} again at full size (≤${detect.maxDim} px, tiled, ` +
        `≤${detect.maxKeypoints.toLocaleString('en-US')} keypoints) with ` +
        `${pluralize(plan.partners.length, 'image')} of the main block they share most pairs with, ` +
        `then matching their pairs again`,
      'info',
      'Matching',
    )
    const t0 = performance.now()
    // Detection is the long part (Starbuck: 18 of 24 minutes); the matching gets the rest.
    const mid = span[0] + 0.7 * (span[1] - span[0])
    await useImagesStore().detectAll(
      detect,
      null,
      (k, n, name) =>
        onProgress?.(k, n, `Detecting ${name} again at full size`, spanFraction([span[0], mid], k, n), 'gap-detect'),
      shouldCancel,
    )
    if (shouldCancel?.()) return { cancelled: true }
    const record = matchRun.value
    await matchAll(
      images,
      { ...requested, onlyIds: detect.onlyIds, gapRedetect: false, onlyNewPairs: false },
      (k, n, label, f) => onProgress?.(k, n, label, mid + (span[1] - mid) * (f ?? 0), 'gap-match'),
      shouldCancel,
    )
    const pairsAgain = matchRun.value === record ? 0 : (matchRun.value?.nPairs ?? 0)
    matchRun.value = record
    if (shouldCancel?.()) return { cancelled: true }
    const after = apartNow()
    const left = after.pieces.reduce((n, p) => n + p.ids.length, 0)
    const seconds = (performance.now() - t0) / 1000
    log(
      `Matching: after detecting ${pluralize(chosen.length, 'image')} again at full size and matching ` +
        `${pluralize(pairsAgain, 'pair')} again, ${pluralize(left, 'image')} ${left === 1 ? 'is' : 'are'} still apart ` +
        `(was ${plan.apart}); ${(seconds / 60).toFixed(1)} min`,
      left < plan.apart ? 'success' : 'info',
      'Matching',
    )
    return {
      apart: plan.apart,
      redetected: plan.loose.length,
      partners: plan.partners.length,
      scale: plan.scale,
      maxDim: detect.maxDim,
      maxKeypoints: detect.maxKeypoints,
      pairs: pairsAgain,
      left,
      seconds,
    }
  }

  // `resume`: the journal a dead tab's run left (core/runJournal.js, the Continue prompt on
  // open). The pairs it lists are kept as saved; only the rest are matched.
  async function matchAll(images, settings = {}, onProgress, shouldCancel, { resume = null } = {}) {
    const requested = structuredClone(toRaw(settings))
    bumpGeneration()
    // Same merge as matchPair so this function's own settings reads (and its
    // matchPair calls) all draw from the single source of truth.
    settings = applyTuningOverrides('match', { ...MATCH_DEFAULTS, ...MATCH_TUNING, ...settings }, (msg) =>
      log(msg, 'warn', 'Matching'),
    )
    // The COUNT gates, never resident keypoints (they load per pair on demand).
    const ready = images.filter((img) => img.kpStatus === 'done' && (img.kpCount ?? 0) > 0)
    const strategy = settings.strategy ?? 'exhaustive'

    // LightGlue's weights are trained per learned detector (SuperPoint 256-d, DISK and
    // ALIKED 128-d) — refuse SIFT features or a mix, which would silently produce garbage.
    if (settings.matcher === 'lightglue') {
      const lg = lightGlueModelFor(ready)
      if (!lg.ok) {
        const names = lg.bad.map((im) => `"${im.name}" (${im.detector ?? 'sift'}/${im.descDim ?? 128}-d)`)
        const shown = names.slice(0, 5).join(', ')
        const more = names.length > 5 ? `, +${names.length - 5} more` : ''
        log(
          `${lg.reason}, but ${lg.bad.length} of ` +
            `${pluralize(ready.length, 'image')} ${lg.bad.length === 1 ? 'is' : 'are'} not: ${shown}${more} — re-detect these (Overwrite mode), ` +
            'or switch the matcher to brute-force.',
          'error',
          'Matching',
        )
        return
      }
      // Fetch the matching LightGlue weights (with consent) before dispatching.
      if (!(await useModelsStore().ensureReady([lg.modelId]))) {
        log('Matching cancelled — the LightGlue model is not available.', 'warn', 'Matching')
        return
      }
    }

    let pairs = []
    if (strategy === 'sequential') {
      pairs = sequentialPairs(ready, {
        overlap: settings.sequentialOverlap,
        loopClosure: settings.sequentialLoopClosure,
      })
      log(
        `Sequential pairing: each image ↔ next ${settings.sequentialOverlap} in capture order` +
          `${settings.sequentialLoopClosure ? ', with end-to-start loop closure' : ''}` +
          ` — ${pluralize(pairs.length, 'pair')}`,
        'info',
        'Matching',
      )
    } else {
      for (let i = 0; i < ready.length; i++) for (let j = i + 1; j < ready.length; j++) pairs.push([ready[i], ready[j]])
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
            rings.has(a.uuid) && rings.has(b.uuid) ? keep.has(pairId(a.uuid, b.uuid)) : true,
          )
          overlapPrefiltered = true
          log(
            `Preselection: ${pairs.length}/${pluralize(before, 'pair')} kept, ${before - pairs.length} skipped ` +
              `(footprint overlap ≥ ${settings.minOverlap ?? 30}%)`,
            'info',
            'Matching',
          )
        }
      } else {
        const pos = positionsByUuid(ready)
        if (pos.size < 2) {
          log(
            'Preselection: fewer than 2 images have camera positions — matching exhaustively instead',
            'warn',
            'Matching',
          )
        } else {
          const keep = preselectPairs(
            [...pos].map(([uuid, p]) => ({ uuid, pos: p })),
            { maxNeighbors: settings.maxNeighbors },
          )
          const before = pairs.length
          pairs = pairs.filter(([a, b]) =>
            pos.has(a.uuid) && pos.has(b.uuid) ? keep.has(pairId(a.uuid, b.uuid)) : true,
          )
          overlapPrefiltered = true
          log(
            `Preselection: ${pairs.length}/${pluralize(before, 'pair')} kept, ${before - pairs.length} skipped ` +
              `(camera proximity, ≤${settings.maxNeighbors} neighbours)`,
            'info',
            'Matching',
          )
        }
      }
    }

    // A multispectral rig: across captures only the reference band is matched (as the
    // strategy chose its pairs), and each other band with its own capture's reference
    // image, which ties every band into the reference band's tracks (core/sensors/rig.js).
    const rigs = findRigs(ready.filter(isImageEnabled))
    if (rigs.length) {
      for (const rig of rigs) log(`Camera rig — ${rigSummary(rig)}`, 'info', 'Matching')
      const before = pairs.length
      const { kept, added } = rigPairs(pairs, rigMembership(rigs), ready)
      const have = new Set(kept.map(([a, b]) => pairId(a.uuid, b.uuid)))
      pairs = [...kept, ...added.filter(([a, b]) => !have.has(pairId(a.uuid, b.uuid)))]
      log(
        `Rig pairing: ${kept.length} of ${pluralize(before, 'pair')} kept (reference band across captures, ` +
          `photos outside the rig), plus ${pluralize(added.length, 'pair')} of each band with its capture's reference`,
        'info',
        'Matching',
      )
    }

    // `onlyIds` (the sidebar's Match features… on a selection): the pairs with one of
    // those images, out of what the strategy chose.
    if (settings.onlyIds?.length) {
      const only = new Set(settings.onlyIds)
      const before = pairs.length
      pairs = pairs.filter(([a, b]) => only.has(a.id) || only.has(b.id))
      log(
        `Matching: ${pluralize(pairs.length, 'pair')} of ${before} with one of the ${pluralize(only.size, 'selected image')}`,
        'info',
        'Matching',
      )
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
      log(
        `Subset gate disabled: ${strategy === 'sequential' ? 'capture order is' : 'preselection is'}` +
          ' the overlap prefilter',
        'info',
        'Matching',
      )
    } else if (gateApplies && pairs.length < settings.subsetGateMinPairs) {
      skipSubsetGate = true
      log(
        `Subset gate disabled: only ${pluralize(pairs.length, 'pair')} (< ${settings.subsetGateMinPairs}) ` +
          '— matching them in full is cheap, and a wrong veto could sever the match graph',
        'info',
        'Matching',
      )
    }
    settings = { ...settings, _skipSubsetGate: skipSubsetGate }

    // LightGlue is pinned to worker 0 and its ORT session is not reentrant (two
    // concurrent session.run() on one wasm session deadlock — the old 7-way freeze).
    // Parallel drain loops would all pile onto worker 0 and wedge it, so dispatch
    // LightGlue serially; serial also keeps the progress bar honest. Brute-force
    // keeps the full pool (each matchPair issues its own pool worker calls).
    const concurrency = settings.matcher === 'lightglue' ? 1 : Math.max(1, Math.min(POOL_SIZE, pairs.length))
    // Log the descriptor-matching knobs so a run's settings are auditable — in
    // particular whether cross-check (mutual nearest neighbour) is active, which
    // otherwise leaves no trace in the console yet meaningfully changes putatives.
    const crossCheck = settings.crossCheck
    const lightglue = settings.matcher === 'lightglue'
    log(
      `Matching: ${pluralize(pairs.length, 'pair')} — ${strategy}${concurrency > 1 ? `, ${concurrency}× parallel` : ''}` +
        `; matcher ${lightglue ? 'LightGlue (learned)' : 'brute-force'}` +
        `${lightglue ? '' : `, cross-check ${crossCheck ? 'on (mutual NN)' : 'off'}, ratio ${settings.ratioThreshold}`}`,
      'info',
      'Matching',
    )
    // Report the detection-scale correction once per run at info level (the
    // per-pair resolved value is debug). Built over the images actually taking
    // part, so it describes this run rather than the project.
    let resolvedRansacPx = null
    if (settings.geometricVerification !== false) {
      const runCtx = buildScaleContext(ready)
      resolvedRansacPx = resolveScaledPx(settings.ransacThreshPx, runCtx)
      if (runCtx.factor !== 1 || runCtx.mixed) {
        log(
          describeScaleContext(runCtx, `RANSAC gate (${settings.ransacThreshPx} detect-px)`),
          runCtx.clamped ? 'warn' : 'info',
          'Matching',
        )
      }
    }
    let done = 0
    // The gate rescue and bridge repair that may follow the pair pass each get a part of
    // the bar of their own, so it keeps moving and the dialog keeps its time estimate
    // through them (core/features/matchProgress.js).
    const canRescue =
      (settings.subsetGateRescueDegree ?? 0) > 0 &&
      settings.subsetGate !== false &&
      !lightglue &&
      !settings._skipSubsetGate
    const bridgeRounds = settings.repairSplits === false ? 0 : (settings.bridgeRounds ?? 1)
    // Whether detecting the gaps again at full size can follow bridge repair: some SIFT
    // images were detected under gapMaxScale of their size. A run on a selection never
    // starts one (that run is how it matches its photos again).
    const gapPossible =
      settings.gapRedetect !== false &&
      bridgeRounds > 0 &&
      !settings.onlyIds?.length &&
      !lightglue &&
      ready.some((im) => (im.detector ?? 'sift') === 'sift' && (im.detectScale ?? 1) < settings.gapMaxScale)
    const pairSpan = [0, pairPassEnd({ rescue: canRescue, bridgeRounds, postShare: settings.progressPostShare })]
    let barAt = 0
    const progress = (k, n, span, label, phase) => {
      barAt = Math.max(barAt, spanFraction(span, k, n))
      onProgress?.(k, n, label, barAt, phase)
    }
    // Tally this run's outcomes for the completion summary. Skipped = too few raw
    // matches to bother verifying; rejected = verified but failed the count/ratio
    // gate; matched = kept (with ≥1 inlier).
    const stats = {
      matched: 0,
      weak: 0,
      rejected: 0,
      skipped: 0,
      gated: 0,
      inliers: 0,
      ratios: [],
      degenerate: 0,
      siblingMerged: 0,
      siblingAmbiguous: 0,
      stationary: 0,
    }
    const tally = (_pid, entry) => {
      if (entry.status !== 'done') return
      stats.stationary += entry.stationaryDropped ?? 0
      stats.siblingMerged += entry.siblingMerged ?? 0
      stats.siblingAmbiguous += entry.siblingAmbiguous ?? 0
      // Order matters: outcome flags are mutually exclusive but explicit (weak/gated/
      // skipped) so a decoupled raw-skip floor never misclassifies a reject as a skip.
      if (entry.gated) stats.gated++
      else if (entry.skipped) stats.skipped++
      else if (entry.weak) stats.weak++
      else if (entry.inlierCount > 0) {
        stats.matched++
        stats.inliers += entry.inlierCount
        if (entry.rawCount) stats.ratios.push(entry.inlierCount / entry.rawCount)
        // H/F degeneracy is a per-pair label (planar scene / pure rotation) that no
        // count or ratio gate acts on, so it only ever reached the debug log — yet the
        // run-level SHARE is a first-order diagnostic: how much of the graph is planar
        // or rotation-dominated, where F is not determined. Counted over ACCEPTED
        // pairs only, because that is the exact population where H ran: `hSkipBelow`
        // = minMatches skips H below the accept floor, so any other denominator would
        // dilute the share with pairs that were never evaluated.
        if (entry.degenerate) stats.degenerate++
      } else stats.rejected++
    }

    // A pair matched again (bridge repair) leaves its first outcome's count first.
    const untally = (entry) => {
      if (entry?.status !== 'done') return
      if (entry.gated) stats.gated--
      else if (entry.skipped) stats.skipped--
      else if (entry.weak) stats.weak--
      else if (!(entry.inlierCount > 0)) stats.rejected--
    }

    // WebGPU brute-force (Settings ▸ Compute "Use GPU"): one router per run, which
    // validates against WASM on the first pair and falls back per pair. LightGlue
    // has its own GPU path (ORT WebGPU EP) and never comes through here.
    const gpuRequested = !lightglue && !!settings.useGpu
    const gpuRun = gpuRequested
      ? await createGpuMatchRun({
          client: {
            begin: matchGpuBegin,
            end: matchGpuEnd,
            gpuMatch: matchDescriptorsGpu,
            cpuMatch: (a, b, o, hooks) => matchDescriptors(a, b, o, { ...hooks, avoidWorker: GPU_MATCH_WORKER }),
          },
          log: (msg, level) => log(msg, level, 'Matching'),
          cacheBudgetBytes: settings.gpuDescCacheMiB * 2 ** 20,
          shouldCancel: () => !!shouldCancel?.(),
        })
      : null
    if (!lightglue && !gpuRun) {
      log(
        `Matching: backend = WASM (CPU)${gpuRequested ? '' : ' — enable "Use GPU" in Settings ▸ Compute for the WebGPU matcher'}`,
        'info',
        'Matching',
      )
    }

    // The run journal (core/runJournal.js): during the pair loop the matches are saved
    // every MATCH_TUNING.journalIntervalMs and the journal lists the pairs that save
    // holds, so a tab that dies loses at most that much. Keyed by the images and their
    // features, the dialog's settings and the pairs they selected.
    const projectId = projects.currentProjectId
    const key = journalKey({
      images: ready.map((im) => [im.uuid, im.kpCount, im.detector ?? 'sift']),
      settings: requested,
      pairs: journalKey(pairs.map(([a, b]) => pairId(a.uuid, b.uuid))),
    })
    let journal = null
    if (resume && projects.isPersisting) {
      const verdict = canContinue(resume, key)
      if (verdict.ok) journal = structuredClone(resume)
      else log(`Matching: the stopped run cannot continue (${verdict.why}); starting again`, 'warn', 'Matching')
    }
    // Pairs a continued run keeps: those its last save held, or all once the loop was done.
    const kept = new Set(journal ? (journal.phase === 'pairs' ? journal.done : pairs.map((_, i) => i)) : [])
    // Match only new pairs: a pair with a result keeps it (re-detecting an image removes
    // its pairs' results, so a kept one belongs to the current features).
    let keptAsMatched = 0
    if (settings.onlyNewPairs) {
      pairs.forEach(([a, b], i) => {
        if (!kept.has(i) && matchStore.value.get(pairId(a.uuid, b.uuid))?.status === 'done') {
          kept.add(i)
          keptAsMatched++
        }
      })
      log(
        `Matching: only new pairs — ${pluralize(keptAsMatched, 'pair')} already matched keep their result, ` +
          `${pluralize(pairs.length - kept.size, 'pair')} to match`,
        'info',
        'Matching',
      )
    }
    if (projects.isPersisting) {
      journal ??= startJournal({ stage: 'match', key, settings: requested, total: pairs.length, phase: 'pairs' })
      await opfs.saveRunJournal(projectId, journal).catch(() => {})
    }
    if (kept.size) {
      if (kept.size > keptAsMatched)
        log(
          `Matching: continuing the stopped run — ${pluralize(kept.size - keptAsMatched, 'pair')} of ${pairs.length} already matched`,
          'info',
          'Matching',
        )
      for (const i of kept) {
        const [a, b] = pairs[i]
        const entry = matchStore.value.get(pairId(a.uuid, b.uuid))
        if (entry) tally(pairId(a.uuid, b.uuid), entry)
      }
      done = kept.size
      progress(done, pairs.length, pairSpan)
    }
    const todo = pairs.map((_, i) => i).filter((i) => !kept.has(i))
    const finished = [...kept]
    let lastSaveAt = performance.now(),
      saveMs = 0,
      checkpointing = null
    const intervalMs = settings._journalMs ?? MATCH_TUNING.journalIntervalMs
    // Save what is matched and record it, at most once per interval (and never more
    // often than ten times the last save took); an interval of 0 saves after every pair.
    const checkpoint = () => {
      if (!journal || checkpointing) return
      if (intervalMs > 0 && performance.now() - lastSaveAt < Math.max(intervalMs, 10 * saveMs)) return
      const held = [...finished]
      const t0 = performance.now()
      touch()
      checkpointing = save()
        .then(() => {
          saveMs = performance.now() - t0
          lastSaveAt = performance.now()
          log(
            `Matching: checkpoint saved ${pluralize(held.length, 'pair')} in ${(saveMs / 1000).toFixed(2)} s`,
            'debug',
            'Matching',
          )
          journal.done = held
          return opfs.saveRunJournal(projectId, { ...journal, updatedAt: new Date().toISOString() })
        })
        .catch(() => {})
        .finally(() => (checkpointing = null))
    }

    // Each image's descriptors load from OPFS once per run, and are released after its
    // last pair or under a byte budget (stores/matching/descriptorCache.js).
    const descCache = createDescriptorCache({
      pairs: todo.map((i) => pairs[i]),
      budgetBytes: (settings.descCacheMiB ?? 2048) * 2 ** 20,
    })
    // Concurrency-limited dispatch: `concurrency` drain loops pull from a shared
    // cursor so up to POOL_SIZE pairs are matched at once (each matchPair issues its
    // own pool worker calls). Cancellation is cooperative — stop pulling.
    let cursor = 0
    let cancelled = false
    const drain = async () => {
      while (true) {
        if (cancelled || shouldCancel?.()) {
          cancelled = true
          return
        }
        const k = cursor++
        if (k >= todo.length) return
        const i = todo[k]
        const [a, b] = pairs[i]
        await matchPair(a, b, settings, tally, descCache, gpuRun)
        descCache.release(a.uuid)
        descCache.release(b.uuid)
        done++
        finished.push(i)
        progress(done, pairs.length, pairSpan)
        checkpoint()
      }
    }
    const runStarted = performance.now()
    let backendRecord = lightglue ? null : { backend: 'wasm', gpuRequested }
    beginBatch()
    try {
      await Promise.all(Array.from({ length: concurrency }, drain))
      // The pair loop is done: save it, so a run that stops in the passes below continues
      // from here (they work on the loop's result, which is now on disk).
      if (journal && !cancelled && !shouldCancel?.() && journal.phase === 'pairs') {
        await checkpointing
        touch()
        await save()
        journal.phase = 'post'
        journal.done = []
        await opfs.saveRunJournal(projectId, { ...journal, updatedAt: new Date().toISOString() }).catch(() => {})
      }
      // Gate rescue. The subset gate's sample count scales with the pair's TRUE match
      // count, so a real pair with a few hundred matches reads as ~0–2 sampled
      // putatives and is vetoed — the side-lap pairs of a film block. Iceland 1980
      // (125 scans, ~9600 kp): 7415/7750 pairs gated, 334 accepted (COLMAP verified
      // 746, half of them under 300 inliers); a 7-image strip hung off the block by
      // one pair and never registered. Images left with fewer than
      // subsetGateRescueDegree accepted pairs re-test their gated pairs on a
      // subsetGateRescueScale× larger sample; those that pass get the full match.
      const rescueDegree = settings.subsetGateRescueDegree ?? 0
      if (!cancelled && !shouldCancel?.() && canRescue) {
        const degree = new Map()
        const bump = (u) => degree.set(u, (degree.get(u) ?? 0) + 1)
        for (const [a, b] of pairs) {
          const e = matchStore.value.get(pairId(a.uuid, b.uuid))
          if (e?.status === 'done' && !e.gated && (e.inlierCount ?? 0) > 0) {
            bump(a.uuid)
            bump(b.uuid)
          }
        }
        const low = (u) => (degree.get(u) ?? 0) < rescueDegree
        // Near misses: gated pairs whose sample came close to the threshold.
        const nearMin =
          (settings.subsetGateNearMiss ?? 0) > 0
            ? Math.ceil(settings.subsetGateNearMiss * settings.subsetGateThreshold)
            : Infinity
        const isNear = (e) => (e?.gateScore ?? 0) >= nearMin
        const rescue = pairs.filter(([a, b]) => {
          const e = matchStore.value.get(pairId(a.uuid, b.uuid))
          return e?.gated && (low(a.uuid) || low(b.uuid) || isNear(e))
        })
        const nNear = rescue.filter(([a, b]) => !low(a.uuid) && !low(b.uuid)).length
        if (rescue.length) {
          const nLow = new Set(
            rescue
              .flatMap(([a, b]) => [a, b])
              .filter((im) => low(im.uuid))
              .map((im) => im.uuid),
          ).size
          const before = { matched: stats.matched, weak: stats.weak }
          stats.gated -= rescue.length // re-tallied by the rescue run
          log(
            `Matching: gate rescue — ${pluralize(nLow, 'image')} under ${pluralize(rescueDegree, 'accepted pair')}; re-testing their ` +
              `${pluralize(rescue.length - nNear, 'gated pair')} on a ${settings.subsetGateRescueScale}× larger sample` +
              (nNear
                ? `, and ${pluralize(nNear, 'near miss', 'near misses')} (≥ ${nearMin} of ${settings.subsetGateThreshold}) on a ` +
                  `${settings.subsetGateNearMissScale}× larger one`
                : ''),
            'info',
            'Matching',
          )
          const rescueSettings = { ...settings, _gateScale: settings.subsetGateRescueScale ?? 4 }
          const nearScale = settings.subsetGateNearMissScale ?? 2
          const nearSettings = {
            ...settings,
            _gateScale: nearScale,
            _gateThreshold: settings.subsetGateThreshold * nearScale,
          }
          const rescueCache = createDescriptorCache({
            pairs: rescue,
            budgetBytes: (settings.descCacheMiB ?? 2048) * 2 ** 20,
          })
          let rc = 0,
            rescued = 0
          const span = laterPassSpan(barAt, bridgeRounds === 0, 0.8)
          const rescueProgress = () =>
            progress(
              rescued,
              rescue.length,
              span,
              'Gate rescue: re-testing pairs the quick check skipped',
              'rescue',
            )
          rescueProgress()
          const drainRescue = async () => {
            while (true) {
              if (cancelled || shouldCancel?.()) {
                cancelled = true
                return
              }
              const i = rc++
              if (i >= rescue.length) return
              const [a, b] = rescue[i]
              const weak = low(a.uuid) || low(b.uuid)
              await matchPair(a, b, weak ? rescueSettings : nearSettings, tally, rescueCache, gpuRun)
              rescueCache.release(a.uuid)
              rescueCache.release(b.uuid)
              done++
              rescued++
              rescueProgress()
            }
          }
          await Promise.all(Array.from({ length: concurrency }, drainRescue))
          log(
            `Matching: gate rescue recovered ${stats.matched - before.matched} accepted` +
              `${stats.weak - before.weak ? ` + ${stats.weak - before.weak} weak` : ''} ${nounFor(stats.matched - before.matched + stats.weak - before.weak, 'pair')} of ${rescue.length} re-tested`,
            'info',
            'Matching',
          )
        }
      }
      // Bridge repair (core/features/bridgeRepair.js): a match graph left in pieces gets
      // its most promising pairs between each piece and the main block matched again,
      // without the subset gate and with looser gates. F-RANSAC still verifies them.
      // Rounds repeat while the main block grows; no pair is tried twice.
      const tried = new Set()
      for (let round = 1; round <= bridgeRounds; round++) {
        if (cancelled || shouldCancel?.()) break
        const span = laterPassSpan(barAt, round === bridgeRounds && !gapPossible)
        const label = `Bridge repair${round > 1 ? ` round ${round}` : ''}: matching the pieces of the match graph again`
        const repaired = await repairSplits(ready, pairs, settings, {
          round,
          tried,
          tally,
          untally,
          gpuRun,
          concurrency,
          isCancelled: () => cancelled || !!shouldCancel?.(),
          onPair: (k, n) => {
            if (k) done++
            progress(k, n, span, label, `bridge-${round}`)
          },
        })
        if (repaired.cancelled) cancelled = true
        if (!repaired.grew) break
      }
    } finally {
      endBatch()
      // Flush matchPair's throttled reactivity so everything reading the store's
      // computeds after the run sees the final state.
      touch()
      // One save for the whole run (and for a cancelled one, so what matched survives).
      await checkpointing
      await save()
      // A finished run leaves no journal; a cancelled one keeps it, to continue later.
      if (journal && !cancelled && !shouldCancel?.()) await opfs.deleteRunJournal(projectId, 'match').catch(() => {})
      const dc = descCache.stats()
      log(
        `Matching: descriptors loaded ${dc.loads}× for ${pluralize(ready.length, 'image')}, ` +
          `resident peak ${(dc.peakBytes / 2 ** 20).toFixed(0)} MiB`,
        'debug',
        'Matching',
      )
      // Always release the GPU-side descriptor cache, unless Cancel already
      // terminated the pool (and with it the cache).
      if (gpuRun) backendRecord = await gpuRun.finish({ cancelled: cancelled || !!shouldCancel?.() })
    }
    const timings = {
      wallMs: performance.now() - runStarted,
      descriptorLoadMs: 0,
      descriptorBytes: 0,
      postMessageMs: 0,
      matchingMs: 0,
      verificationMs: 0,
      roundTripMs: 0,
    }
    for (const [a, b] of pairs) {
      const t = matchStore.value.get(pairId(a.uuid, b.uuid))?.timing
      if (t) for (const key of Object.keys(t)) timings[key] += t[key]
    }
    log(
      `Matching timing: wall ${(timings.wallMs / 1000).toFixed(2)}s; summed pair stages: ` +
        `descriptor loads ${(timings.descriptorLoadMs / 1000).toFixed(2)}s, ` +
        `postMessage serialization ${(timings.postMessageMs / 1000).toFixed(2)}s, ` +
        `matching ${(timings.matchingMs / 1000).toFixed(2)}s, verification ${(timings.verificationMs / 1000).toFixed(2)}s; ` +
        `queue/transport remainder ${(Math.max(0, timings.roundTripMs - timings.matchingMs - timings.verificationMs - timings.postMessageMs) / 1000).toFixed(2)}s. ` +
        `Concurrent stage sums can exceed wall time.`,
      'info',
      'Matching',
    )
    if (cancelled || shouldCancel?.()) {
      log(`Matching cancelled — ${done}/${pairs.length} done`, 'warn', 'Matching')
      return
    }
    const meanRatio = stats.ratios.length ? stats.ratios.reduce((s, r) => s + r, 0) / stats.ratios.length : 0
    log(
      `Matching complete: ${pluralize(pairs.length, 'pair')} — ${stats.matched} accepted` +
        `${stats.weak ? `, ${stats.weak} weak (PnP bridges)` : ''}` +
        `, ${stats.rejected} rejected, ${stats.skipped} skipped` +
        `${stats.gated ? `, ${stats.gated} gated (subset pre-test)` : ''}` +
        `${settings.filterStationary ? `; ${pluralize(stats.stationary, 'stationary putative')} dropped` : ''}` +
        `; ${stats.inliers} total inliers, mean inlier ratio ${meanRatio.toFixed(2)}` +
        `${
          stats.matched
            ? `, ${stats.degenerate}/${pluralize(stats.matched, 'accepted pair')} H/F-degenerate ` +
              `(${((100 * stats.degenerate) / stats.matched).toFixed(0)}% planar / pure-rotation)`
            : ''
        }`,
      'success',
      'Matching',
    )
    if (stats.siblingMerged || stats.siblingAmbiguous) {
      log(
        `SIFT orientation siblings: ${pluralize(stats.siblingMerged, 'duplicate putative')} merged onto their dominant ` +
          `keypoint, ${pluralize(stats.siblingAmbiguous, 'ambiguous putative')} dropped (one feature matched to two)`,
        'info',
        'Matching',
      )
    }

    matchRun.value = {
      timings,
      date: new Date().toISOString(),
      strategy,
      matcher: settings.matcher === 'lightglue' ? 'lightglue' : 'bruteforce',
      // Brute-force backend actually used: 'wasm' | 'gpu' | 'gpu→wasm' (+ the GPU
      // validation verdicts, fallback count and cache counters). null for LightGlue.
      backend: backendRecord,
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
      // Orientation-sibling canonicalization (core/features/orientationSiblings.js).
      siblingMerged: stats.siblingMerged,
      siblingAmbiguous: stats.siblingAmbiguous,
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
        verifier: settings.verifier,
        subsetGate: settings.subsetGate,
        preselectMethod: strategy === 'preselect' ? settings.preselectMethod : null,
        maxNeighbors: strategy === 'preselect' ? settings.maxNeighbors : null,
        sequentialOverlap: strategy === 'sequential' ? settings.sequentialOverlap : null,
        sequentialLoopClosure: strategy === 'sequential' ? settings.sequentialLoopClosure : null,
        lgTiled: settings.matcher === 'lightglue' ? settings.lgTiled : null,
      },
    }
    if (gapPossible) {
      const gap = await redetectGaps(images, ready, settings, requested, {
        onProgress,
        shouldCancel,
        span: [barAt, 1],
      })
      if (gap) matchRun.value = { ...matchRun.value, gapRedetect: gap }
    }
  }

  return { positionsByUuid, footprintRingsByUuid, matchAll }
}
