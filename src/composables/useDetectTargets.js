import { toRaw } from 'vue'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useLog } from './useLog.js'
import {
  makeFrameModelResolver,
  makePinholeToMark,
  makeScanToPinhole,
  markToCentrePx,
  centreToMarkPx,
} from '../core/sfm/displayFrame.js'
import { targetPredictions, quadRadiusFor, modelFromProject } from '../core/sfm/targetPredict.js'
import { tagNumber } from '../core/sfm/tagDetect.js'
import { detectTargets as workerDetectTargets, detectTagsInPhoto, POOL_SIZE } from '../workers/computeClient.js'
import { computeSourceOf } from '../utils/image.js'
import { mapConcurrent } from '../utils/concurrency.js'
import { pluralize } from '../core/textFormat.js'

// Tools ▸ Images ▸ Detect targets (core/sfm/targetPredict.js, targetDetect.js): plan where
// every GCP's checker mat should appear in every registered photo, then find its centre
// there in the workers and place the GCP's mark, flagged { source: 'detected', score }.
// AprilTags (core/sfm/tagDetect.js) need no plan: every enabled photo is searched whole,
// and tag N is the GCP with N in its name, or a new marker "Tag N".
//
// plan(settings) → { photos: [{ img, predictions }], counts } — what the dialog's effect
//   lines count; run(settings, plan, onProgress) places the marks it finds. A photo per
//   worker, over the whole pool.
export function useDetectTargets() {
  const gcpsStore = useGcpsStore()
  const imagesStore = useImagesStore()
  const sensors = useSensorsStore()
  const recon = useReconstructionStore()
  const { log } = useLog()

  async function plan(settings) {
    if (settings.kind === 'apriltag') return planTags()
    const cams = recon.mainSparseCloud?.cameras
    if (!cams?.size) return { photos: [], counts: { predictions: 0, photos: 0, gcps: 0, unplaced: 0, halfPx: null } }
    const frameModel = makeFrameModelResolver({ summary: toRaw(recon.summary), sensors: sensors.sensors })
    const images = imagesStore.images.filter((im) => cams.has(im.uuid))
    const camById = new Map(images.map((im) => [im.id, cams.get(im.uuid)]))
    const lens = new Map(images.map((im) => [im.id, frameModel(im)]))
    // The marks in each photo's camera frame (lens and film taken out), as the
    // triangulation needs them.
    const gcps = gcpsStore.gcps.map((g) => ({
      ...g,
      observations: (g.observations ?? []).flatMap((o) => {
        const cam = camById.get(o.imageId)
        if (!cam || o.px == null) return []
        const p = makeScanToPinhole({ K: cam.K, ...lens.get(o.imageId) })(o.px, o.py)
        return [{ imageId: o.imageId, px: p.x, py: p.y, source: o.source }]
      }),
    }))
    const g = recon.validGeoref
    const toModel = g ? (p) => modelFromProject(g.sim, p) : null
    const resolved = await recon.effectiveFrameSpec()
    const metresPerUnit = resolved?.unit === 'm' ? resolved.scale : null
    const photos = []
    const halves = []
    const seen = new Set()
    for (const img of images) {
      const cam = camById.get(img.id)
      const toMark = makePinholeToMark({ K: cam.K, ...lens.get(img.id) })
      const W = img.meta?.width,
        H = img.meta?.height
      const predictions = []
      for (const p of await targetPredictions({
        gcps,
        imageId: img.id,
        cam,
        cameras: camById,
        toModel,
        sizeM: settings.sizeM,
        metresPerUnit,
        replaceDetected: settings.replaceDetected,
      })) {
        const m = toMark(p.u, p.v)
        // Fully inside the photo, with the search window.
        const pad = settings.searchPx / 2
        if (!(m.x > pad && m.y > pad && m.x < W - pad && m.y < H - pad)) continue
        predictions.push({ ...p, x: markToCentrePx(m.x), y: markToCentrePx(m.y) })
        if (p.halfPx) halves.push(p.halfPx)
        seen.add(p.gcpId)
      }
      if (predictions.length) photos.push({ img, predictions })
    }
    halves.sort((a, b) => a - b)
    const placeable = gcpsStore.gcps.filter((x) => x.enabled !== false).length
    return {
      photos,
      counts: {
        predictions: photos.reduce((n, p) => n + p.predictions.length, 0),
        photos: photos.length,
        gcps: seen.size,
        unplaced: Math.max(0, placeable - seen.size),
        halfPx: halves.length ? halves[Math.floor(halves.length / 2)] : null,
      },
    }
  }

  function planTags() {
    const photos = imagesStore.images.filter((im) => im.enabled !== false).map((img) => ({ img }))
    return {
      photos,
      counts: {
        photos: photos.length,
        gcps: gcpsStore.gcps.length,
        tagged: gcpsStore.gcps.filter((g) => tagNumber(g.name) != null).length,
      },
    }
  }

  // The GCP standing for tag `id`: an enabled one first.
  function gcpForTag(id) {
    const named = gcpsStore.gcps.filter((g) => tagNumber(g.name) === id)
    return named.find((g) => g.enabled !== false) ?? named[0] ?? null
  }

  async function runTags(settings, planned, onProgress) {
    const n = planned.photos.length
    const workers = Math.max(1, Math.min(POOL_SIZE, n))
    let found = 0,
      done = 0
    const added = [],
      unknown = new Set()
    const t0 = performance.now()
    onProgress?.(0, n, `Looking for AprilTags in ${pluralize(n, 'photo')}…`)
    await mapConcurrent(planned.photos, workers, async ({ img }) => {
      await imagesStore.whenComputeReady(img)
      const { tags } = await detectTagsInPhoto(computeSourceOf(img))
      for (const t of tags) {
        let g = gcpForTag(t.id)
        if (!g && !settings.addMarkers) {
          unknown.add(t.id)
          continue
        }
        if (!g) {
          const id = gcpsStore.addPoint({ role: 'marker', name: `Tag ${t.id}` })
          g = gcpsStore.gcps.find((x) => x.id === id)
          added.push(g.name)
        }
        const o = g.observations.find((x) => x.imageId === img.id)
        if (o && !(settings.replaceDetected && o.source === 'detected')) continue
        gcpsStore.setObservation(g.id, img.id, img.name, centreToMarkPx(t.x), centreToMarkPx(t.y), {
          source: 'detected',
          score: t.score,
        })
        found++
      }
      onProgress?.(++done, n, `Looking for AprilTags… ${done} of ${n}`)
    })
    log(
      `Detect targets: ${pluralize(found, 'AprilTag mark')} placed in ${pluralize(n, 'photo')} on ` +
        `${pluralize(workers, 'worker')} in ${((performance.now() - t0) / 1000).toFixed(1)} s` +
        (added.length ? `; new markers ${added.join(', ')}` : '') +
        (unknown.size ? `; tags no GCP is named after: ${[...unknown].sort((a, b) => a - b).join(', ')}` : '') +
        '; check them in Edit GCPs',
      found ? 'success' : 'warn',
      'GCP',
    )
    return { found, tried: n }
  }

  async function run(settings, planned, onProgress) {
    if (settings.kind === 'apriltag') return runTags(settings, planned, onProgress)
    let found = 0,
      tried = 0,
      done = 0
    const n = planned.photos.length
    const workers = Math.max(1, Math.min(POOL_SIZE, n))
    const t0 = performance.now()
    onProgress?.(0, n, `Looking for targets in ${pluralize(n, 'photo')}…`)
    await mapConcurrent(planned.photos, workers, async ({ img, predictions }) => {
      await imagesStore.whenComputeReady(img)
      const { results } = await workerDetectTargets(
        computeSourceOf(img),
        predictions.map((p) => ({
          key: p.gcpId,
          x: p.x,
          y: p.y,
          radius: settings.searchPx,
          quadRadius: quadRadiusFor(p.halfPx),
        })),
      )
      tried += predictions.length
      for (const r of results) {
        if (!(r.score >= settings.minScore)) continue
        gcpsStore.setObservation(r.key, img.id, img.name, centreToMarkPx(r.x), centreToMarkPx(r.y), {
          source: 'detected',
          score: r.score,
        })
        found++
      }
      onProgress?.(++done, n, `Looking for targets… ${done} of ${n}`)
    })
    log(
      `Detect targets: ${pluralize(found, 'mark')} placed, ${pluralize(tried, 'place')} searched in ` +
        `${pluralize(n, 'photo')} on ${pluralize(workers, 'worker')} (score ≥ ${settings.minScore}) in ` +
        `${((performance.now() - t0) / 1000).toFixed(1)} s; check them in Edit GCPs`,
      found ? 'success' : 'warn',
      'GCP',
    )
    return { found, tried }
  }

  return { plan, run }
}
