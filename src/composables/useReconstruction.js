import { ref } from 'vue'
import {
  estimateK, fundamentalToEssential, makeP34flat,
  recoverPose, triangulateDlt, solvePnp, bundleAdjust,
} from '../utils/reconstruction.js'
import { useLog } from './useLog.js'
import * as opfs from '../utils/opfs.js'

// images:     Ref<Array>          — image objects with .meta, .keypoints, .uuid
// matchStore: Ref<Map>            — pairId → { idA, idB, F, matches, inlierCount }
// persist:    { enabled, projectId, sync }
export function useReconstruction({ images, matchStore, persist }) {
  const { log } = useLog()

  // uuid → { R: [[…]×3], t: [x,y,z], K: { fx,fy,cx,cy } }
  const cameras = ref(new Map())
  // [{ x, y, z, views: Map<uuid, kpIdx> }]
  const points3d = ref([])
  const reconStatus = ref('idle') // 'idle' | 'running' | 'done' | 'error'

  function imageByUuid(uuid) {
    return images.value.find((img) => img.uuid === uuid) || null
  }

  function isPersisting() {
    return persist?.enabled.value && !!persist?.projectId.value
  }

  // Convert pixel coord to normalised (K^-1 applied).
  function toNorm(px, py, K) {
    return { x: (px - K.cx) / K.fx, y: (py - K.cy) / K.fy }
  }

  // Build flat P34 for a camera in *normalised* image coords (no K).
  function camToP34flat(cam) {
    return makeP34flat(cam.R, cam.t)
  }

  async function reconstruct(settings = {}, onProgress) {
    reconStatus.value = 'running'
    cameras.value = new Map()
    points3d.value = []

    try {
      const imgs = images.value.filter((img) => img.kpStatus === 'done')
      if (imgs.length < 2) {
        log('Reconstruction: need at least 2 images with keypoints', 'warn', 'Reconstruction')
        reconStatus.value = 'idle'
        return
      }

      // ── Build K map ────────────────────────────────────────────────────────
      const Kmap = new Map() // uuid → K
      for (const img of imgs) Kmap.set(img.uuid, estimateK(img.meta))

      // ── Select initial pair (highest inlier count) ─────────────────────────
      let bestPair = null
      let bestInliers = 0
      for (const [, entry] of matchStore.value) {
        if (entry.status !== 'done' || entry.inlierCount < 8) continue
        if (!Kmap.has(entry.idA) || !Kmap.has(entry.idB)) continue
        if (entry.inlierCount > bestInliers) { bestInliers = entry.inlierCount; bestPair = entry }
      }

      if (!bestPair) {
        log('Reconstruction: no valid matched pair found', 'warn', 'Reconstruction')
        reconStatus.value = 'idle'
        return
      }

      const imgA = imageByUuid(bestPair.idA)
      const imgB = imageByUuid(bestPair.idB)
      if (!imgA || !imgB) { reconStatus.value = 'error'; return }

      log(`Reconstruction: initial pair ${imgA.name} ↔ ${imgB.name} (${bestInliers} inliers)`, 'info', 'Reconstruction')
      onProgress?.(0, imgs.length, `Initial pair: ${imgA.name} ↔ ${imgB.name}`)

      const Ka = Kmap.get(bestPair.idA)
      const Kb = Kmap.get(bestPair.idB)

      // ── Compute E and recover pose ─────────────────────────────────────────
      const E = fundamentalToEssential(bestPair.F, Ka, Kb)
      const inlierMatches = bestPair.matches // [[ia, ib], ...]
      const ptsA = inlierMatches.map(([ia]) => imgA.keypoints[ia])
      const ptsB = inlierMatches.map(([, ib]) => imgB.keypoints[ib])

      const pose = await recoverPose(ptsA, ptsB, E, Ka)
      if (!pose) {
        log('Reconstruction: pose recovery failed', 'error', 'Reconstruction')
        reconStatus.value = 'error'
        return
      }

      // Camera A = identity
      const camA = { R: [[1,0,0],[0,1,0],[0,0,1]], t: [0,0,0], K: Ka }
      const camB = { R: pose.R, t: pose.t, K: Kb }
      cameras.value.set(bestPair.idA, camA)
      cameras.value.set(bestPair.idB, camB)

      // ── Triangulate initial point cloud ────────────────────────────────────
      const PA = camToP34flat(camA)
      const PB = camToP34flat(camB)
      const normA = ptsA.map((p) => toNorm(p.x, p.y, Ka))
      const normB = ptsB.map((p) => toNorm(p.x, p.y, Kb))
      const tri = await triangulateDlt(normA, normB, PA, PB)

      // Filter: keep points with positive depth in both cameras
      const initPoints = []
      for (const { x, y, z, srcIdx } of tri) {
        // Depth in camera B: R[2]*X + t[2]
        const R = pose.R; const t = pose.t
        const depthB = R[2][0]*x + R[2][1]*y + R[2][2]*z + t[2]
        if (z > 0 && depthB > 0) {
          const [ia, ib] = inlierMatches[srcIdx]
          const views = new Map([[bestPair.idA, ia], [bestPair.idB, ib]])
          initPoints.push({ x, y, z, views })
        }
      }

      points3d.value = initPoints
      log(`Reconstruction: ${initPoints.length} initial points triangulated`, 'success', 'Reconstruction')
      onProgress?.(1, imgs.length, `Triangulated ${initPoints.length} points`)

      // ── Incremental registration ───────────────────────────────────────────
      const { minMatchesForRegistration = 20, reprjThreshold = 4.0 } = settings
      const registeredUuids = new Set([bestPair.idA, bestPair.idB])
      const unregistered = imgs.filter((img) => !registeredUuids.has(img.uuid))

      // Sort by number of matches to already-registered cameras
      function countMatchesToRegistered(uuid) {
        let count = 0
        for (const [, e] of matchStore.value) {
          if (e.status !== 'done') continue
          const other = e.idA === uuid ? e.idB : e.idB === uuid ? e.idA : null
          if (other && registeredUuids.has(other)) count += e.inlierCount
        }
        return count
      }

      let regDone = 2
      const queue = [...unregistered]
      let pass = 0
      while (queue.length > 0 && pass < queue.length * 2) {
        pass++
        queue.sort((a, b) => countMatchesToRegistered(b.uuid) - countMatchesToRegistered(a.uuid))
        const img = queue[0]
        const K = Kmap.get(img.uuid)

        // Collect 2D-3D correspondences: look through current points for ones seen in registered images
        const pts3 = []; const pts2 = []
        const corrPtIdx = [] // index into points3d.value

        for (const [, entry] of matchStore.value) {
          if (entry.status !== 'done') continue
          let regUuid = null; let newKpIdx = null
          if (entry.idA === img.uuid && registeredUuids.has(entry.idB)) { regUuid = entry.idB; }
          else if (entry.idB === img.uuid && registeredUuids.has(entry.idA)) { regUuid = entry.idA; }
          else continue

          for (const [ia, ib] of entry.matches) {
            const [newIdx, regIdx] = entry.idA === img.uuid ? [ia, ib] : [ib, ia]
            // Find a 3D point that has a view from regUuid at regIdx
            for (let pi = 0; pi < points3d.value.length; pi++) {
              const pt = points3d.value[pi]
              if (pt.views.get(regUuid) === regIdx) {
                const kp = img.keypoints[newIdx]
                pts3.push(pt); pts2.push({ x: kp.x, y: kp.y }); corrPtIdx.push(pi)
                break
              }
            }
          }
        }

        if (pts3.length < minMatchesForRegistration) {
          // Not enough correspondences yet — defer
          queue.push(queue.shift())
          continue
        }

        onProgress?.(regDone, imgs.length, `Registering ${img.name} (${pts3.length} correspondences)`)

        const pnp = await solvePnp(pts3, pts2, K, { ransacThreshPx: reprjThreshold, maxIters: 200 })
        if (!pnp) {
          log(`Reconstruction: PnP failed for ${img.name}`, 'warn', 'Reconstruction')
          queue.shift()
          continue
        }

        const inlierCount = pnp.inlierMask.filter((v) => v > 0.5).length
        if (inlierCount < 6) {
          log(`Reconstruction: too few PnP inliers for ${img.name} (${inlierCount})`, 'warn', 'Reconstruction')
          queue.shift()
          continue
        }

        cameras.value.set(img.uuid, { R: pnp.R, t: pnp.t, K })
        registeredUuids.add(img.uuid)
        regDone++
        log(`Reconstruction: registered ${img.name} (${inlierCount} inliers)`, 'success', 'Reconstruction')

        // Triangulate new points between this image and all registered images
        const newCam = { R: pnp.R, t: pnp.t, K }
        const Pnew = camToP34flat(newCam)

        for (const [, entry] of matchStore.value) {
          if (entry.status !== 'done') continue
          let regUuid = null
          if (entry.idA === img.uuid && registeredUuids.has(entry.idB) && entry.idB !== img.uuid) regUuid = entry.idB
          else if (entry.idB === img.uuid && registeredUuids.has(entry.idA) && entry.idA !== img.uuid) regUuid = entry.idA
          else continue

          const regCam = cameras.value.get(regUuid)
          if (!regCam) continue
          const Preg = camToP34flat(regCam)
          const regImg = imageByUuid(regUuid)
          if (!regImg) continue

          const pairsToTri = entry.matches.filter(([ia, ib]) => {
            // Avoid re-triangulating already-tracked points
            const [newIdx] = entry.idA === img.uuid ? [ia] : [ib]
            return !points3d.value.some((pt) => pt.views.get(img.uuid) === newIdx)
          })

          if (pairsToTri.length === 0) continue

          const nA = pairsToTri.map(([ia, ib]) => {
            const kp = (entry.idA === img.uuid ? img : regImg).keypoints[entry.idA === img.uuid ? ia : ib]
            return toNorm(kp.x, kp.y, K)
          })
          const nB = pairsToTri.map(([ia, ib]) => {
            const kp = (entry.idA === img.uuid ? regImg : img).keypoints[entry.idA === img.uuid ? ib : ia]
            return toNorm(kp.x, kp.y, regCam.K)
          })

          const newTri = await triangulateDlt(nA, nB, Pnew, Preg)
          for (const { x, y, z, srcIdx } of newTri) {
            if (z > 0) {
              const [ia, ib] = pairsToTri[srcIdx]
              const newKpIdx = entry.idA === img.uuid ? ia : ib
              const regKpIdx = entry.idA === img.uuid ? ib : ia
              const views = new Map([[img.uuid, newKpIdx], [regUuid, regKpIdx]])
              points3d.value.push({ x, y, z, views })
            }
          }
        }

        queue.shift()
      }

      log(`Reconstruction: ${cameras.value.size} cameras registered, ${points3d.value.length} points`, 'info', 'Reconstruction')

      // ── Bundle adjustment ──────────────────────────────────────────────────
      const { baIterations = 30 } = settings
      if (cameras.value.size >= 2 && points3d.value.length >= 10 && baIterations > 0) {
        onProgress?.(imgs.length - 1, imgs.length, 'Bundle adjustment…')
        log('Reconstruction: running bundle adjustment', 'info', 'Reconstruction')

        const uuidList = [...cameras.value.keys()]
        const camList  = uuidList.map((u) => cameras.value.get(u))
        const kList    = camList.map((c) => c.K)

        // Build observation list
        const observations = []
        points3d.value.forEach((pt, pi) => {
          pt.views.forEach((kpIdx, uuid) => {
            const ci = uuidList.indexOf(uuid)
            const img = imageByUuid(uuid)
            if (ci === -1 || !img) return
            const kp = img.keypoints[kpIdx]
            if (kp) observations.push({ camIdx: ci, ptIdx: pi, x: kp.x, y: kp.y })
          })
        })

        const result = await bundleAdjust(camList, kList, points3d.value, observations, { maxIters: baIterations })
        if (result) {
          uuidList.forEach((uuid, ci) => {
            const old = cameras.value.get(uuid)
            cameras.value.set(uuid, { ...old, ...result.cameras[ci] })
          })
          points3d.value = result.points3d.map((pt, i) => ({
            ...pt, views: points3d.value[i].views,
          }))
          log('Reconstruction: bundle adjustment complete', 'success', 'Reconstruction')
        }
      }

      // Persist
      if (isPersisting()) {
        const pid = persist.projectId.value
        await opfs.saveReconstruction(pid, {
          cameras: [...cameras.value.entries()].map(([uuid, cam]) => ({ uuid, ...cam })),
          points:  points3d.value.map(({ x, y, z }) => ({ x, y, z })),
        }).catch(() => {})
      }

      reconStatus.value = 'done'
      onProgress?.(imgs.length, imgs.length, 'Done')
      log(`Reconstruction complete: ${cameras.value.size} cameras, ${points3d.value.length} points`, 'success', 'Reconstruction')
    } catch (err) {
      log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
      reconStatus.value = 'error'
    }
  }

  function clearReconstruction() {
    cameras.value = new Map()
    points3d.value = []
    reconStatus.value = 'idle'
  }

  async function restoreReconstruction(projectId) {
    const data = await opfs.loadReconstruction(projectId)
    if (!data) return
    const map = new Map()
    for (const cam of data.cameras || []) {
      const { uuid, R, t, K } = cam
      map.set(uuid, { R, t, K })
    }
    cameras.value = map
    points3d.value = (data.points || []).map(({ x, y, z }) => ({ x, y, z, views: new Map() }))
    if (cameras.value.size > 0)
      log(`Reconstruction restored: ${cameras.value.size} cameras, ${points3d.value.length} points`, 'success', 'Reconstruction')
    reconStatus.value = cameras.value.size > 0 ? 'done' : 'idle'
  }

  return {
    cameras,
    points3d,
    reconStatus,
    reconstruct,
    clearReconstruction,
    restoreReconstruction,
  }
}
