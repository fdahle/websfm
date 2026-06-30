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

  async function matchPair(imgA, imgB, settings = {}, onDone) {
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

      const descA = isPersisting()
        ? await opfs.loadDescriptors(projectId, idA)
        : srcA.descriptors ?? null
      const descB = isPersisting()
        ? await opfs.loadDescriptors(projectId, idB)
        : srcB.descriptors ?? null

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
    for (const [a, b] of pairs) {
      if (shouldCancel?.()) { log(`Matching cancelled — ${done}/${pairs.length} done`, 'warn', 'Matching'); return }
      await matchPair(a, b, settings)
      done++
      onProgress?.(done, pairs.length)
    }
    log(`Matching complete: ${done} pair(s) processed`, 'success', 'Matching')
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
