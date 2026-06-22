import { ref, computed } from 'vue'
import {
  estimateK, fundamentalToEssential, makeP34flat,
  recoverPose, triangulateDlt, solvePnp, bundleAdjust,
} from '../utils/reconstruction.js'
import { useLog } from './useLog.js'
import * as opfs from '../utils/opfs.js'

// ── Geometry helpers ────────────────────────────────────────────────────────────
const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

// Depth of world point (x,y,z) along a flat 3×4 projection matrix's principal
// axis. P is row-major [r0(4), r1(4), r2(4)]; depth = r2 · [x, y, z, 1].
// Positive ⇒ the point is in front of that camera (cheirality).
function projDepth(P, x, y, z) {
  return P[8] * x + P[9] * y + P[10] * z + P[11]
}

// Camera centre C = -Rᵀt for a { R, t } pose.
function cameraCenter({ R, t }) {
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ]
}

// Median triangulation (parallax) angle in degrees between two cameras over a
// set of 3D points. Small angles ⇒ ill-conditioned depth ⇒ "points on a line".
function medianTriangulationAngle(camA, camB, pts) {
  if (!pts.length) return 0
  const Ca = cameraCenter(camA)
  const Cb = cameraCenter(camB)
  const angles = []
  for (const p of pts) {
    const ax = p.x - Ca[0], ay = p.y - Ca[1], az = p.z - Ca[2]
    const bx = p.x - Cb[0], by = p.y - Cb[1], bz = p.z - Cb[2]
    const na = Math.hypot(ax, ay, az), nb = Math.hypot(bx, by, bz)
    if (na === 0 || nb === 0) continue
    let c = (ax * bx + ay * by + az * bz) / (na * nb)
    c = Math.max(-1, Math.min(1, c))
    angles.push(Math.acos(c) * 180 / Math.PI)
  }
  if (!angles.length) return 0
  angles.sort((a, b) => a - b)
  return angles[angles.length >> 1]
}

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

      // Two-view initialisation for one matched pair: recover pose, triangulate,
      // and measure the median parallax angle. Returns null if it cannot init.
      async function tryInitPair(entry) {
        const iA = imageByUuid(entry.idA)
        const iB = imageByUuid(entry.idB)
        if (!iA || !iB || !entry.F) return null
        const KA = Kmap.get(entry.idA)
        const KB = Kmap.get(entry.idB)
        const E = fundamentalToEssential(entry.F, KA, KB)
        const matches = entry.matches // [[ia, ib], ...]
        const pa = matches.map(([ia]) => iA.keypoints[ia])
        const pb = matches.map(([, ib]) => iB.keypoints[ib])
        const pose = await recoverPose(pa, pb, E, KA)
        if (!pose) return null

        const cA = { R: I3, t: [0, 0, 0], K: KA }
        const cB = { R: pose.R, t: pose.t, K: KB }
        const PA = camToP34flat(cA)
        const PB = camToP34flat(cB)
        const tri = await triangulateDlt(
          pa.map((p) => toNorm(p.x, p.y, KA)),
          pb.map((p) => toNorm(p.x, p.y, KB)),
          PA, PB,
        )
        const points = []
        for (const { x, y, z, srcIdx } of tri) {
          if (projDepth(PA, x, y, z) > 0 && projDepth(PB, x, y, z) > 0) {
            const [ia, ib] = matches[srcIdx]
            points.push({ x, y, z, views: new Map([[entry.idA, ia], [entry.idB, ib]]) })
          }
        }
        const angle = medianTriangulationAngle(cA, cB, points)
        return { entry, iA, iB, cA, cB, points, angle, inliers: entry.inlierCount }
      }

      // ── Select initial pair: enough inliers AND a wide-enough baseline ──────
      // Picking purely by inlier count tends to choose near-identical viewpoints
      // (tiny parallax) whose triangulated points collapse onto a line. Probe the
      // top candidates and take the first with adequate parallax.
      const { minInitInliers = 15, minInitAngleDeg = 2.0, initCandidates = 8 } = settings
      const candidates = [...matchStore.value.values()]
        .filter((e) => e.status === 'done' && e.inlierCount >= minInitInliers
          && Kmap.has(e.idA) && Kmap.has(e.idB) && e.F)
        .sort((a, b) => b.inlierCount - a.inlierCount)
        .slice(0, initCandidates)

      if (candidates.length === 0) {
        log('Reconstruction: no valid matched pair found', 'warn', 'Reconstruction')
        reconStatus.value = 'idle'
        return
      }

      let best = null   // first candidate meeting the parallax threshold
      let widest = null // fallback: widest baseline seen
      for (const entry of candidates) {
        const init = await tryInitPair(entry)
        if (!init || init.points.length < 10) continue
        log(`Reconstruction: candidate ${init.iA.name} ↔ ${init.iB.name} — `
          + `${init.inliers} inliers, ${init.points.length} pts, median angle ${init.angle.toFixed(2)}°`,
          'info', 'Reconstruction')
        if (!widest || init.angle > widest.angle) widest = init
        if (init.angle >= minInitAngleDeg) { best = init; break }
      }
      best = best || widest

      if (!best) {
        log('Reconstruction: pose recovery failed for all candidate pairs', 'error', 'Reconstruction')
        reconStatus.value = 'error'
        return
      }
      if (best.angle < minInitAngleDeg) {
        log(`Reconstruction: best initial parallax is only ${best.angle.toFixed(2)}° `
          + `(< ${minInitAngleDeg}°) — the sparse cloud may look flat/linear`, 'warn', 'Reconstruction')
      }

      const bestPair = best.entry
      const imgA = best.iA
      const imgB = best.iB
      cameras.value.set(bestPair.idA, best.cA)
      cameras.value.set(bestPair.idB, best.cB)
      points3d.value = best.points

      log(`Reconstruction: initial pair ${imgA.name} ↔ ${imgB.name} `
        + `(${best.inliers} inliers, ${best.points.length} pts, ${best.angle.toFixed(2)}° parallax)`,
        'success', 'Reconstruction')
      onProgress?.(1, imgs.length, `Initial pair: ${imgA.name} ↔ ${imgB.name}`)

      // ── Incremental registration ───────────────────────────────────────────
      const { minMatchesForRegistration = 12, reprjThreshold = 4.0 } = settings
      const registeredUuids = new Set([bestPair.idA, bestPair.idB])

      // Total inliers linking `uuid` to the already-registered set (ordering heuristic).
      function countMatchesToRegistered(uuid) {
        let count = 0
        for (const [, e] of matchStore.value) {
          if (e.status !== 'done') continue
          const other = e.idA === uuid ? e.idB : e.idB === uuid ? e.idA : null
          if (other && registeredUuids.has(other)) count += e.inlierCount
        }
        return count
      }

      // Gather 2D-3D correspondences between an unregistered image and the model:
      // existing 3D points whose view in a registered image matches one of `img`'s matches.
      function collectCorrespondences(img) {
        const pts3 = []; const pts2 = []
        for (const [, entry] of matchStore.value) {
          if (entry.status !== 'done') continue
          let regUuid = null
          if (entry.idA === img.uuid && registeredUuids.has(entry.idB)) regUuid = entry.idB
          else if (entry.idB === img.uuid && registeredUuids.has(entry.idA)) regUuid = entry.idA
          else continue
          const imgIsA = entry.idA === img.uuid
          for (const [ia, ib] of entry.matches) {
            const newIdx = imgIsA ? ia : ib
            const regIdx = imgIsA ? ib : ia
            for (let pi = 0; pi < points3d.value.length; pi++) {
              const pt = points3d.value[pi]
              if (pt.views.get(regUuid) === regIdx) {
                const kp = img.keypoints[newIdx]
                pts3.push(pt); pts2.push({ x: kp.x, y: kp.y })
                break
              }
            }
          }
        }
        return { pts3, pts2 }
      }

      // Repeatedly sweep the unregistered images; each newly-registered camera adds
      // points that may let previously-deferred images register on the next pass.
      // Stop when a full pass registers nothing new.
      let progressed = true
      while (progressed) {
        progressed = false
        const remaining = imgs
          .filter((img) => !registeredUuids.has(img.uuid))
          .sort((a, b) => countMatchesToRegistered(b.uuid) - countMatchesToRegistered(a.uuid))

        for (const img of remaining) {
          const K = Kmap.get(img.uuid)
          const { pts3, pts2 } = collectCorrespondences(img)
          if (pts3.length < minMatchesForRegistration) {
            log(`Reconstruction: defer ${img.name} — ${pts3.length}/${minMatchesForRegistration} correspondences`, 'info', 'Reconstruction')
            continue
          }

          onProgress?.(cameras.value.size, imgs.length, `Registering ${img.name} (${pts3.length} correspondences)`)
          const pnp = await solvePnp(pts3, pts2, K, { ransacThreshPx: reprjThreshold, maxIters: 200 })
          if (!pnp) {
            log(`Reconstruction: PnP failed for ${img.name} (${pts3.length} correspondences)`, 'warn', 'Reconstruction')
            continue
          }
          const inlierCount = pnp.inlierMask.filter((v) => v > 0.5).length
          if (inlierCount < 6) {
            log(`Reconstruction: too few PnP inliers for ${img.name} (${inlierCount}/${pts3.length})`, 'warn', 'Reconstruction')
            continue
          }

          const newCam = { R: pnp.R, t: pnp.t, K }
          cameras.value.set(img.uuid, newCam)
          registeredUuids.add(img.uuid)
          progressed = true
          log(`Reconstruction: registered ${img.name} (${inlierCount}/${pts3.length} PnP inliers)`, 'success', 'Reconstruction')

          // Triangulate fresh points between the new camera and each registered neighbour.
          const Pnew = camToP34flat(newCam)
          let added = 0
          for (const [, entry] of matchStore.value) {
            if (entry.status !== 'done') continue
            let regUuid = null
            if (entry.idA === img.uuid && registeredUuids.has(entry.idB) && entry.idB !== img.uuid) regUuid = entry.idB
            else if (entry.idB === img.uuid && registeredUuids.has(entry.idA) && entry.idA !== img.uuid) regUuid = entry.idA
            else continue

            const regCam = cameras.value.get(regUuid)
            const regImg = imageByUuid(regUuid)
            if (!regCam || !regImg) continue
            const Preg = camToP34flat(regCam)
            const imgIsA = entry.idA === img.uuid

            // Skip matches already tracked from the new image.
            const pairsToTri = entry.matches.filter(([ia, ib]) => {
              const newIdx = imgIsA ? ia : ib
              return !points3d.value.some((pt) => pt.views.get(img.uuid) === newIdx)
            })
            if (pairsToTri.length === 0) continue

            // nNew ↔ Pnew (the new image), nReg ↔ Preg (the registered image).
            const nNew = pairsToTri.map(([ia, ib]) => {
              const kp = img.keypoints[imgIsA ? ia : ib]
              return toNorm(kp.x, kp.y, K)
            })
            const nReg = pairsToTri.map(([ia, ib]) => {
              const kp = regImg.keypoints[imgIsA ? ib : ia]
              return toNorm(kp.x, kp.y, regCam.K)
            })

            const newTri = await triangulateDlt(nNew, nReg, Pnew, Preg)
            for (const { x, y, z, srcIdx } of newTri) {
              if (projDepth(Pnew, x, y, z) > 0 && projDepth(Preg, x, y, z) > 0) {
                const [ia, ib] = pairsToTri[srcIdx]
                const views = new Map([
                  [img.uuid, imgIsA ? ia : ib],
                  [regUuid, imgIsA ? ib : ia],
                ])
                points3d.value.push({ x, y, z, views })
                added++
              }
            }
          }
          if (added) log(`Reconstruction: +${added} points from ${img.name}`, 'info', 'Reconstruction')
        }
      }

      log(`Reconstruction: ${cameras.value.size}/${imgs.length} cameras registered, ${points3d.value.length} points`, 'info', 'Reconstruction')

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

  // Reset the in-memory model. Pass { purge: true } to also delete the persisted
  // reconstruction.json — do NOT purge on project switch, since restore reads it.
  function clearReconstruction({ purge = false } = {}) {
    cameras.value = new Map()
    points3d.value = []
    reconStatus.value = 'idle'
    if (purge && isPersisting()) {
      opfs.deleteReconstruction(persist.projectId.value).catch(() => {})
    }
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

  // Compact status for the sidebar: how many cameras/points the model holds.
  const reconSummary = computed(() => ({
    status: reconStatus.value,
    cameras: cameras.value.size,
    points: points3d.value.length,
  }))

  return {
    cameras,
    points3d,
    reconStatus,
    reconSummary,
    reconstruct,
    clearReconstruction,
    restoreReconstruction,
  }
}
