import { createByteLru } from '../../utils/byteLru.js'
import { RESIDENT_TUNING } from '../../core/tuning.js'
import { markRaw } from 'vue'
import * as opfs from '../../utils/opfs.js'
import { Keypoints } from '../../core/features/keypoints.js'

// Keypoints on disk, read per image on demand (TODO ▸ SC-3), split out of
// useImagesStore: a byte-budgeted LRU of resident keypoint sets, single-flight disk
// reads, and an epoch that drops a read which straddles a restore or clear.
//
// Deps are the store's own refs and helpers; the store keeps the image records.
export function createKeypointCache({ hasKeypoints, imageById, isPersisting, log, projects, save }) {
  // ── Keypoints: on disk, read per image on demand (TODO ▸ SC-3) ──────────────
  // An image record carries `kpCount`/`kpStatus` (reactive, persisted) and `kpRev`
  // (bumped whenever its keypoints are replaced, session-only); the Keypoints
  // themselves (core/features/keypoints.js) live in this byte-bounded LRU keyed by
  // uuid, never on the record. Fresh detections/imports are PINNED until their save
  // lands (and forever in a project that cannot persist); a copy read back from
  // disk is clean and evictable. Consumers:
  //   ensureKeypoints(img)  — cached; the open image tab, the match preview, matching
  //   readKeypoints(img)    — resident or read straight through, NOT cached; a bulk
  //                           pass (SfM input, exports, fingerprints) that would
  //                           otherwise flush the interactive working set
  //   residentKeypoints(img) — synchronous peek, null when not loaded
  const keypointCache = createByteLru({ budgetBytes: RESIDENT_TUNING.keypointCacheMiB * 2 ** 20 })
  const keypointLoads = new Map() // uuid → in-flight read
  let keypointEpoch = 0 // bumps on restore/clear: a read that straddles it is dropped
  const keypointBytes = (k) => k.data.byteLength + (k.rgb?.byteLength ?? 0)
  // Callers hand an image record or an id; mutate the store's proxy when there is one.
  const resolveImage = (ref) => {
    if (ref == null) return null
    if (typeof ref === 'string') return imageById(ref)
    return (ref.id != null ? imageById(ref.id) : null) ?? ref
  }

  function residentKeypoints(ref) {
    const img = resolveImage(ref)
    return hasKeypoints(img) ? (keypointCache.get(img.uuid) ?? null) : null
  }

  // Attach a fresh result (detection, import): resident and pinned until `persist`
  // resolves. Returns the wrapped set.
  function holdKeypoints(img, kps, persist = null) {
    const held = markRaw(kps)
    img.kpRev = (img.kpRev ?? 0) + 1
    keypointCache.set(img.uuid, held, keypointBytes(held), { pinned: true })
    persist
      ?.then(() => keypointCache.unpin(img.uuid, held))
      .catch((err) =>
        log(
          `Keypoints for ${img.name} could not be saved — kept in memory (${err?.message ?? err})`,
          'warn',
          'Detection',
        ),
      )
    return held
  }

  // One image's keypoints from OPFS, or null. Not cached here.
  async function readKeypointsFromDisk(img) {
    const projectId = projects.currentProjectId
    const epoch = keypointEpoch,
      rev = img.kpRev
    const data = projectId ? await opfs.loadKeypoints(projectId, img.uuid) : null
    const rgb = data ? await opfs.loadColors(projectId, img.uuid) : null
    // Replaced (re-detected, cleared) or the project changed while reading.
    if (epoch !== keypointEpoch || rev !== img.kpRev) return { stale: true }
    if (!data) {
      img.kpStatus = 'error'
      img.kpCount = 0
      log(`Keypoints missing for ${img.name} — re-run feature detection`, 'warn', 'Project')
      return { kps: null }
    }
    const kps = new Keypoints(data)
    if (rgb?.length === 3 * kps.length) kps.rgb = rgb
    // The file is what match indices refer to, so it wins over a disagreeing count.
    if (kps.length !== img.kpCount) {
      log(
        `Keypoints for ${img.name}: the file holds ${kps.length}, the project said ${img.kpCount} — using the file`,
        'warn',
        'Project',
      )
      img.kpCount = kps.length
      if (isPersisting()) save()
    }
    return { kps: markRaw(kps) }
  }

  function loadKeypointsShared(img, cache) {
    let p = keypointLoads.get(img.uuid)
    if (!p) {
      const epoch = keypointEpoch
      p = readKeypointsFromDisk(img).finally(() => {
        if (keypointLoads.get(img.uuid) === p) keypointLoads.delete(img.uuid)
      })
      keypointLoads.set(img.uuid, p)
      if (cache) {
        p.then(
          (r) => {
            if (r.kps && epoch === keypointEpoch && !keypointCache.has(img.uuid)) {
              keypointCache.set(img.uuid, r.kps, keypointBytes(r.kps))
            }
          },
          () => {},
        )
      }
    }
    return p.then((r) => (r.stale ? (keypointCache.get(img.uuid) ?? null) : r.kps))
  }

  // The image's keypoints, loaded (and kept, LRU) on first use; null when it has none.
  async function ensureKeypoints(ref) {
    const img = resolveImage(ref)
    if (!hasKeypoints(img)) return null
    return keypointCache.get(img.uuid) ?? loadKeypointsShared(img, true)
  }

  // The image's keypoints for a one-pass consumer: the resident copy if there is one,
  // else read straight from disk without displacing the cache.
  async function readKeypoints(ref) {
    const img = resolveImage(ref)
    if (!hasKeypoints(img)) return null
    const hit = keypointCache.peek(img.uuid)
    if (hit) return hit
    if (keypointLoads.has(img.uuid)) return loadKeypointsShared(img, false)
    const r = await readKeypointsFromDisk(img)
    return r.stale ? (keypointCache.peek(img.uuid) ?? null) : r.kps
  }

  const keypointCacheStats = () => keypointCache.stats()
  function resetKeypointCache() {
    keypointEpoch++
    keypointCache.clear()
    keypointLoads.clear()
  }

  return {
    residentKeypoints,
    holdKeypoints,
    readKeypointsFromDisk,
    loadKeypointsShared,
    ensureKeypoints,
    readKeypoints,
    resetKeypointCache,
    keypointCache,
    keypointLoads,
    keypointBytes,
    resolveImage,
    keypointCacheStats,
  }
}
