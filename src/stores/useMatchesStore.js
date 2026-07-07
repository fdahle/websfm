import { shallowRef, triggerRef, computed } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'
import { matchDescriptors, matchLightGlue, verifyMatches, POOL_SIZE } from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import { preselectPairs } from '../core/features/preselect.js'
import { inlierSpread } from '../core/features/verify.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'
import { usePosesStore } from './usePosesStore.js'

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
    for (const v of matchStore.value.values()) if (v.status === 'done' && v.inlierCount > 0) n++
    return n
  })

  // `descCache` (optional): id → descriptors, shared across a matchAll run so each
  // image's descriptors are loaded from OPFS once instead of once per pair (an
  // image appears in N−1 pairs, so this turns O(N²) loads into O(N)).
  async function matchPair(imgA, imgB, settings = {}, onDone, descCache = null) {
    const [idA, idB] = [imgA.uuid, imgB.uuid].sort()
    const pid = pairId(idA, idB)
    // Ensure descriptors are ordered the same way as IDs
    const [kpsA, kpsB] = idA === imgA.uuid
      ? [imgA.keypoints, imgB.keypoints]
      : [imgB.keypoints, imgA.keypoints]

    const entry = { idA, idB, rawCount: 0, inlierCount: 0, F: null, matches: [], status: 'running', disabled: false }
    matchStore.value.set(pid, entry)
    // Trigger reactivity
    touch()

    try {
      const projectId = projects.currentProjectId
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
          minConf: settings.lgMinConf ?? 0,
          maxKeypoints: settings.lgMaxKeypoints ?? 2048,
          useGpu: settings.useGpu ?? false,
        }, { onLog: (msg) => log(msg, 'info', 'Matching') })
        raw = res.matches
      } else {
        const res = await matchDescriptors(descA, descB, {
          ratioThreshold: settings.ratioThreshold ?? 0.75,
          crossCheck: settings.crossCheck ?? false,
        })
        raw = res.matches
      }
      entry.rawCount = raw.length

      const minMatches = settings.minMatches ?? 15

      if (raw.length < minMatches) {
        entry.status = 'done'
        const label = `${imgA.name} ↔ ${imgB.name}`
        log(`Skip: ${label} — only ${raw.length} raw matches (need ${minMatches})`, 'warn', 'Matching')
        touch()
        onDone?.(pid, entry)
        return
      }

      if (settings.geometricVerification !== false) {
        const result = await verifyMatches(kpsA, kpsB, raw, {
          ransacThreshPx: settings.ransacThreshPx ?? 2.0,
          maxIters: settings.maxIters ?? 1000,
        })
        // Inlier-RATIO gate, on top of the absolute count. On repetitive/near-planar
        // scenes (e.g. a building façade) the fundamental-matrix RANSAC can scrape a
        // dozen "inliers" out of ~100 putatives by fitting a bogus epipolar geometry.
        // True pairs sit well above this ratio (~0.5+); false pairs cluster ~0.15.
        // Admitting the false ones corrupts SfM registration, so reject them here.
        const minInlierRatio = settings.minInlierRatio ?? 0.25
        const ratio = result ? result.inlierCount / Math.max(1, raw.length) : 0
        // R5: absolute-inlier override. A medium-overlap bridge pair (e.g. 120
        // putatives / 27 inliers @ 0.23 across a repetitive façade) is real geometry
        // — a solid RANSAC fit with dozens of inliers is not the ~12/100 spurious fit
        // the ratio gate was built to kill. Accept on a high absolute inlier count
        // even below the ratio floor; these bridges are the glue that closes loops
        // and builds ≥3-view tracks. The ratio gate still guards the low-count junk.
        const overrideInliers = settings.overrideInliers ?? 30
        const ratioOk = ratio >= minInlierRatio
        const overrode = !ratioOk && result != null && result.inlierCount >= overrideInliers
        // H-vs-F degeneracy: when a homography captures nearly as many inliers as the
        // fundamental matrix, the pair's scene is planar or its motion a pure rotation
        // (a flat façade, a spin-in-place). Such pairs still bridge the match graph, so
        // we keep them — but they make poor SfM *seeds* (the essential-matrix pose
        // recovery is ambiguous under planar degeneracy), so flag them for the seed
        // selector. Not a rejection, just a quality label riding through to the pair.
        const degenRatioThresh = settings.hfDegenerateRatio ?? 0.8
        const hfRatio = result && result.inlierCount > 0
          ? result.hInlierCount / result.inlierCount : 0
        entry.hInlierCount = result?.hInlierCount ?? 0
        entry.hfRatio = hfRatio
        entry.degenerate = result != null && hfRatio >= degenRatioThresh
        // Positional-degeneracy REJECT (see core/features/verify.js inlierSpread): the inlier
        // set has enough points and clears every count/ratio/H-F gate, yet its positions
        // in one image collapse — many-to-one convergence (unique spots ≪ inliers) or
        // epipole degeneracy (all inliers in a pinhead region). Neither is real geometry.
        // Unlike `degenerate` (a seed-quality label), this is a hard reject.
        const minUniqueFrac = settings.minInlierUniqueFrac ?? 0.5
        const minSpreadPx = settings.minInlierSpreadPx ?? 8
        const spread = result ? inlierSpread(kpsA, kpsB, raw, result.inlierMask) : null
        let spreadDegenerate = false
        if (spread && spread.count >= minMatches) {
          const collapsed = Math.min(spread.uniqueA, spread.uniqueB) < minUniqueFrac * spread.count
          const tiny = Math.min(spread.extentA, spread.extentB) < minSpreadPx
          spreadDegenerate = collapsed || tiny
        }
        if (result && result.inlierCount >= minMatches && (ratioOk || overrode) && !spreadDegenerate) {
          entry.F = result.F
          entry.inlierCount = result.inlierCount
          entry.matches = raw
            .filter((_, i) => result.inlierMask[i] > 0.5)
            .map(m => [m.ia, m.ib])
        } else {
          entry.inlierCount = 0
          entry.matches = []
          entry.rejectRatio = ratio // for the run summary stats
          // Record the ACTUAL cause. A pair can fail the absolute inlier floor
          // (minMatches) even when its ratio clears the gate — don't blame the
          // ratio unconditionally, that misreads as "ratio too low" at ratio 0.43.
          if (!result) {
            entry.rejectReason = 'no fundamental matrix could be fit'
          } else if (spreadDegenerate) {
            entry.rejectReason = `inliers collapse positionally — ${result.inlierCount} inliers map to only `
              + `${spread.uniqueA}/${spread.uniqueB} unique spots (A/B), extent ${spread.extentA.toFixed(0)}/`
              + `${spread.extentB.toFixed(0)}px — many-to-one / epipole degeneracy, not real geometry`
          } else if (result.inlierCount < minMatches) {
            entry.rejectReason = `only ${result.inlierCount} inliers — below the ${minMatches} `
              + `absolute floor (ratio ${ratio.toFixed(2)} cleared its ${minInlierRatio} gate)`
          } else {
            entry.rejectReason = `inlier ratio ${ratio.toFixed(2)} below gate ${minInlierRatio} `
              + `and ${result.inlierCount} < ${overrideInliers} override — likely false match on repetitive structure`
          }
        }
        // Detailed diagnostics (debug level): putatives, inliers, the ratio, and
        // the gate/threshold that decided the outcome — for every verified pair,
        // not just rejects (marginal accepts are the interesting ones to audit).
        log(`Match ${imgA.name} ↔ ${imgB.name} — ${raw.length} putatives → `
          + `${result?.inlierCount ?? 0} inliers (ratio ${ratio.toFixed(2)}, gate ${minInlierRatio}`
          + `${overrode ? `, ratio-override on ${result.inlierCount}≥${overrideInliers} inliers` : ''}), `
          + `H/F ${hfRatio.toFixed(2)}${entry.degenerate ? ' (degenerate — planar/pure-rotation, poor seed)' : ''}, `
          + `${spread ? `spread ${spread.uniqueA}/${spread.uniqueB} unique, ${spread.extentA.toFixed(0)}/${spread.extentB.toFixed(0)}px` : 'spread n/a'}`
          + `${spreadDegenerate ? ' (positional collapse — REJECTED)' : ''}, `
          + `RANSAC ${settings.ransacThreshPx ?? 2.0}px`, 'debug', 'Matching')
      } else {
        entry.matches = raw.map(m => [m.ia, m.ib])
        entry.inlierCount = raw.length
      }

      entry.status = 'done'

      if (isPersisting() && entry.matches.length >= minMatches) {
        opfs.saveMatches(projectId, pid, {
          idA, idB,
          rawCount: entry.rawCount,
          inlierCount: entry.inlierCount,
          F: entry.F,
          matches: entry.matches,
          disabled: entry.disabled,
        }).catch(() => {})
      }

      const label = `${imgA.name} ↔ ${imgB.name}`
      // A pair with 0 inliers failed geometric verification — it is not a usable
      // match, so don't report it in green as a success.
      if (entry.inlierCount > 0) {
        log(`Matched: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers`, 'success', 'Matching')
      } else {
        // Report the recorded cause (ratio-gate vs absolute-inlier floor vs no model),
        // not a blanket "ratio too low" that misreads floor rejections.
        log(`Rejected: ${label} — ${entry.rawCount} raw matches, `
          + `${entry.rejectReason ?? 'none passed geometric verification'}`, 'warn', 'Matching')
      }
    } catch (err) {
      entry.status = 'error'
      log(`Match error: ${imgA.name} ↔ ${imgB.name} — ${err?.message ?? err}`, 'error', 'Matching')
    }

    touch()
    onDone?.(pairId(imgA.uuid, imgB.uuid), entry)
  }

  // Camera positions (project CRS) from imported poses, keyed by image uuid — the
  // signal proximity preselection uses. Only resolved poses (imageId set) count.
  function positionsByUuid() {
    const m = new Map()
    for (const p of posesStore.poses) {
      if (p.imageId && p.x != null && p.y != null) m.set(p.imageId, [p.x, p.y, p.z ?? 0])
    }
    return m
  }

  async function matchAll(images, settings = {}, onProgress, shouldCancel) {
    const ready = images.filter(img => img.kpStatus === 'done')
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
    }

    let pairs = []
    if (strategy === 'sequential') {
      for (let i = 0; i < ready.length - 1; i++) pairs.push([ready[i], ready[i + 1]])
    } else {
      for (let i = 0; i < ready.length; i++)
        for (let j = i + 1; j < ready.length; j++)
          pairs.push([ready[i], ready[j]])
    }

    // Proximity preselection: prune the exhaustive set to each image's nearest
    // neighbours by camera position, so ordered strips cost ~O(N·k) not O(N²). A
    // pair with an unpositioned endpoint can't be judged, so it's kept.
    if (strategy === 'preselect') {
      const pos = positionsByUuid()
      const positioned = ready.filter(im => pos.has(im.uuid))
      if (positioned.length < 2) {
        log('Preselection: fewer than 2 images have camera positions — matching exhaustively instead', 'warn', 'Matching')
      } else {
        const keep = preselectPairs(
          positioned.map(im => ({ uuid: im.uuid, pos: pos.get(im.uuid) })),
          { maxNeighbors: settings.maxNeighbors ?? 10 },
        )
        const before = pairs.length
        pairs = pairs.filter(([a, b]) =>
          (pos.has(a.uuid) && pos.has(b.uuid)) ? keep.has(pairId(a.uuid, b.uuid)) : true)
        log(`Preselection: ${pairs.length}/${before} pair(s) kept, ${before - pairs.length} skipped `
          + `(camera proximity, ≤${settings.maxNeighbors ?? 10} neighbours)`, 'info', 'Matching')
      }
    }

    if (pairs.length === 0) {
      log('Match: no image pairs to process (need at least 2 images with keypoints)', 'warn', 'Matching')
      return
    }

    const concurrency = Math.max(1, Math.min(POOL_SIZE, pairs.length))
    // Log the descriptor-matching knobs so a run's settings are auditable — in
    // particular whether cross-check (mutual nearest neighbour) is active, which
    // otherwise leaves no trace in the console yet meaningfully changes putatives.
    const crossCheck = settings.crossCheck ?? false
    const lightglue = settings.matcher === 'lightglue'
    log(`Matching: ${pairs.length} pair(s) — ${strategy}${concurrency > 1 ? `, ${concurrency}× parallel` : ''}`
      + `; matcher ${lightglue ? 'LightGlue (learned)' : 'brute-force'}`
      + `${lightglue ? '' : `, cross-check ${crossCheck ? 'on (mutual NN)' : 'off'}, ratio ${settings.ratioThreshold ?? 0.75}`}`,
      'info', 'Matching')
    let done = 0
    // Tally this run's outcomes for the completion summary. Skipped = too few raw
    // matches to bother verifying; rejected = verified but failed the count/ratio
    // gate; matched = kept (with ≥1 inlier).
    const minMatches = settings.minMatches ?? 15
    const stats = { matched: 0, rejected: 0, skipped: 0, inliers: 0, ratios: [] }
    const tally = (_pid, entry) => {
      if (entry.status !== 'done') return
      if (entry.inlierCount > 0) {
        stats.matched++; stats.inliers += entry.inlierCount
        if (entry.rawCount) stats.ratios.push(entry.inlierCount / entry.rawCount)
      } else if (entry.rawCount >= minMatches) stats.rejected++
      else stats.skipped++
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
    log(`Matching complete: ${done} pair(s) — ${stats.matched} matched, ${stats.rejected} rejected, `
      + `${stats.skipped} skipped; ${stats.inliers} total inliers, mean inlier ratio ${meanRatio.toFixed(2)}`,
      'success', 'Matching')
  }

  // Drop every pair involving `uuid`. Re-detecting an image (or clearing its
  // keypoints) renumbers its keypoint indices, so any stored match referencing
  // the old indices is now wrong — invalidate them rather than let stale indices
  // corrupt a later match/reconstruct run.
  function removeMatchesForImage(uuid) {
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
        F: entry.F, matches: entry.matches, disabled: entry.disabled,
      }).catch(() => {})
    }
    log(`Pair ${disabled ? 'excluded from' : 'restored to'} reconstruction`, 'info', 'Matching')
  }

  // Project-store contract.
  async function restore({ projectId }) {
    const all = await opfs.loadAllMatches(projectId)
    const newMap = new Map()
    for (const { pairId, idA, idB, rawCount, inlierCount, F, matches, disabled } of all) {
      newMap.set(pairId, {
        idA, idB,
        rawCount:     rawCount    ?? 0,
        inlierCount:  inlierCount ?? 0,
        F:            F           ?? null,
        matches:      matches     ?? [],
        status: 'done',
        disabled:     disabled    ?? false,
      })
    }
    matchStore.value = newMap
    if (all.length > 0) log(`Matches restored: ${all.length} pair(s)`, 'success', 'Matching')
  }

  function clear() {
    matchStore.value.clear()
    matchStore.value = new Map()
    if (isPersisting()) {
      opfs.clearAllMatches(projects.currentProjectId).catch(() => {})
    }
  }

  return { matchStore, pairId, getMatch, verifiedPairs, matchPair, matchAll, removeMatchesForImage, setPairDisabled, restore, clear }
}))
