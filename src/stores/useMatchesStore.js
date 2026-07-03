import { ref, computed } from 'vue'
import { defineStore } from 'pinia'
import * as opfs from '../utils/opfs.js'
import { matchDescriptors, verifyMatches } from '../workers/computeClient.js'
import { useLog } from '../composables/useLog.js'
import { registerProjectStore } from './projectStores.js'
import { useProjectsStore } from './useProjectsStore.js'

// Project-scoped store: pairwise feature matches. Reads persistence flags from the
// projects store; restore/clear run through the project-store registry.
export const useMatchesStore = registerProjectStore(defineStore('matches', () => {
  const { log } = useLog()
  const projects = useProjectsStore()

  // pairId → { idA, idB, rawCount, inlierCount, F, matches: [[ia,ib],...], status }
  const matchStore = ref(new Map())

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

    const entry = { idA, idB, rawCount: 0, inlierCount: 0, F: null, matches: [], status: 'running' }
    matchStore.value.set(pid, entry)
    // Trigger reactivity
    matchStore.value = new Map(matchStore.value)

    try {
      const projectId = projects.currentProjectId
      // Image whose uuid sorts first → idA; its descriptors go to descA
      const srcA = idA === imgA.uuid ? imgA : imgB
      const srcB = idA === imgA.uuid ? imgB : imgA

      const loadDesc = async (id, src) => {
        if (descCache?.has(id)) return descCache.get(id)
        const d = isPersisting() ? await opfs.loadDescriptors(projectId, id) : (src.descriptors ?? null)
        if (d && descCache) descCache.set(id, d)
        return d
      }
      const descA = await loadDesc(idA, srcA)
      const descB = await loadDesc(idB, srcB)

      if (!descA || !descB) {
        entry.status = 'error'
        const names = `${imgA.name} / ${imgB.name}`
        log(`Match failed: descriptors missing for ${names} — re-run feature detection`, 'error', 'Matching')
        matchStore.value = new Map(matchStore.value)
        return
      }

      const { matches: raw } = await matchDescriptors(descA, descB, {
        ratioThreshold: settings.ratioThreshold ?? 0.75,
        crossCheck: settings.crossCheck ?? false,
      })
      entry.rawCount = raw.length

      const minMatches = settings.minMatches ?? 15

      if (raw.length < minMatches) {
        entry.status = 'done'
        const label = `${imgA.name} ↔ ${imgB.name}`
        log(`Skip: ${label} — only ${raw.length} raw matches (need ${minMatches})`, 'warn', 'Matching')
        matchStore.value = new Map(matchStore.value)
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
        if (result && result.inlierCount >= minMatches && ratio >= minInlierRatio) {
          entry.F = result.F
          entry.inlierCount = result.inlierCount
          entry.matches = raw
            .filter((_, i) => result.inlierMask[i] > 0.5)
            .map(m => [m.ia, m.ib])
        } else {
          entry.inlierCount = 0
          entry.matches = []
          entry.rejectRatio = ratio // for the diagnostic log below
        }
        // Detailed diagnostics (debug level): putatives, inliers, the ratio, and
        // the gate/threshold that decided the outcome — for every verified pair,
        // not just rejects (marginal accepts are the interesting ones to audit).
        log(`Match ${imgA.name} ↔ ${imgB.name} — ${raw.length} putatives → `
          + `${result?.inlierCount ?? 0} inliers (ratio ${ratio.toFixed(2)}, gate ${minInlierRatio}), `
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
        }).catch(() => {})
      }

      const label = `${imgA.name} ↔ ${imgB.name}`
      // A pair with 0 inliers failed geometric verification — it is not a usable
      // match, so don't report it in green as a success.
      if (entry.inlierCount > 0) {
        log(`Matched: ${label} — ${entry.inlierCount}/${entry.rawCount} inliers`, 'success', 'Matching')
      } else if (entry.rejectRatio != null && entry.rejectRatio > 0) {
        // Failed the inlier-ratio gate: likely a spurious epipolar fit on repetitive
        // structure, not a real overlap.
        log(`Rejected: ${label} — ${entry.rawCount} raw matches, inlier ratio `
          + `${entry.rejectRatio.toFixed(2)} too low (likely false match on repetitive structure)`,
          'warn', 'Matching')
      } else {
        log(`Rejected: ${label} — ${entry.rawCount} raw matches, none passed geometric verification`, 'warn', 'Matching')
      }
    } catch (err) {
      entry.status = 'error'
      log(`Match error: ${imgA.name} ↔ ${imgB.name} — ${err?.message ?? err}`, 'error', 'Matching')
    }

    matchStore.value = new Map(matchStore.value)
    onDone?.(pairId(imgA.uuid, imgB.uuid), entry)
  }

  async function matchAll(images, settings = {}, onProgress, shouldCancel) {
    const ready = images.filter(img => img.kpStatus === 'done')
    const strategy = settings.strategy ?? 'exhaustive'

    const pairs = []
    if (strategy === 'sequential') {
      for (let i = 0; i < ready.length - 1; i++) pairs.push([ready[i], ready[i + 1]])
    } else {
      for (let i = 0; i < ready.length; i++)
        for (let j = i + 1; j < ready.length; j++)
          pairs.push([ready[i], ready[j]])
    }

    if (pairs.length === 0) {
      log('Match: no image pairs to process (need at least 2 images with keypoints)', 'warn', 'Matching')
      return
    }

    log(`Matching: ${pairs.length} pair(s) — ${strategy}`, 'info', 'Matching')
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
    for (const [a, b] of pairs) {
      if (shouldCancel?.()) { log(`Matching cancelled — ${done}/${pairs.length} done`, 'warn', 'Matching'); return }
      await matchPair(a, b, settings, tally, descCache)
      // matchPair writes its entry into the store as it goes, so a cancel pressed
      // while this pair was in flight leaves a finished result behind — drop it
      // and stop, so cancellation doesn't silently attach one more pair.
      if (shouldCancel?.()) {
        const pid = pairId(a.uuid, b.uuid)
        matchStore.value.delete(pid)
        matchStore.value = new Map(matchStore.value)
        if (isPersisting()) opfs.deleteMatches(projects.currentProjectId, pid).catch(() => {})
        log(`Matching cancelled — ${done}/${pairs.length} done`, 'warn', 'Matching')
        return
      }
      done++
      onProgress?.(done, pairs.length)
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
      matchStore.value = new Map(matchStore.value)
      log(`Matches invalidated: ${removed} pair(s) — keypoints changed, re-match these`, 'warn', 'Matching')
    }
    return removed
  }

  // Project-store contract.
  async function restore({ projectId }) {
    const all = await opfs.loadAllMatches(projectId)
    const newMap = new Map()
    for (const { pairId, idA, idB, rawCount, inlierCount, F, matches } of all) {
      newMap.set(pairId, {
        idA, idB,
        rawCount:     rawCount    ?? 0,
        inlierCount:  inlierCount ?? 0,
        F:            F           ?? null,
        matches:      matches     ?? [],
        status: 'done',
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

  return { matchStore, pairId, getMatch, verifiedPairs, matchPair, matchAll, removeMatchesForImage, restore, clear }
}))
