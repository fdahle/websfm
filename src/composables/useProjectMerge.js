import { toRaw } from 'vue'
import * as opfs from '../utils/opfs.js'
import { planProjectMerge } from '../core/io/projectMerge.js'
import { asKeypoints } from '../core/features/keypoints.js'
import { projectFormatOf, projectFormatProblem, PROJECT_FORMAT_VERSION } from '../core/projectFormat.js'
import { pluralize } from '../core/textFormat.js'
import { PROJECT_IMPORT_TUNING } from '../core/tuning.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { useLog } from './useLog.js'

// Import ▸ Project into this project: another project's photos, sensors, features,
// matches, masks, GCP marks and imported camera positions join the open one (the plan:
// core/io/projectMerge.js). Its model and products stay behind; the photos join the
// model by matching the new pairs (Match only new pairs) and adding them to it
// (Sparse Reconstruction ▸ Add to the model).
export function useProjectMerge() {
  const projects = useProjectsStore()
  const imagesStore = useImagesStore()
  const sensors = useSensorsStore()
  const matches = useMatchesStore()
  const gcps = useGcpsStore()
  const poses = usePosesStore()
  const { log } = useLog()

  // The other project made readable: a folder-backed one needs its folder (a click on
  // Import is the gesture its permission asks for, so this runs first), an older one
  // its format brought up to date, as opening it would. → its project.json, or throws.
  async function prepareSource(sourceId) {
    const plan = await projects.openPlan(sourceId)
    if (plan.action === 'reconnect') {
      const r = await projects.reconnectProjectFolder(sourceId)
      if (!r.ok) throw new Error(r.error)
    } else if (plan.action === 'repick') throw new Error(plan.reason ?? 'its folder is no longer there')
    let data = await opfs.readProject(sourceId)
    if (!data) throw new Error('it could not be read')
    const problem = projectFormatProblem(data)
    if (problem) throw new Error(problem)
    if (projectFormatOf(data) < PROJECT_FORMAT_VERSION) data = (await opfs.migrateProjectFormat(sourceId, data)).data
    return data
  }

  // → { added, shared, pairs, sensors, gcps, poses } or null when nothing ran.
  async function importProjectInto(sourceId, onProgress = () => {}) {
    const targetId = projects.currentProjectId
    if (!targetId || !projects.isPersisting) {
      log('Import project: open a saved project first', 'error', 'Import')
      return null
    }
    if (sourceId === targetId) {
      log('Import project: choose another project than the open one', 'error', 'Import')
      return null
    }
    const sourceName = projects.projects.find((p) => p.id === sourceId)?.name ?? 'project'
    let data
    try {
      data = await prepareSource(sourceId)
    } catch (err) {
      log(`Import project: "${sourceName}" cannot be read — ${err?.message ?? err}`, 'error', 'Import')
      return null
    }
    const [sensorDoc, gcpDoc, poseDoc] = await Promise.all([
      opfs.loadSensors(sourceId).catch(() => null),
      opfs.loadGcps(sourceId).catch(() => null),
      opfs.loadPoses(sourceId).catch(() => null),
    ])
    const plan = planProjectMerge({
      target: {
        images: imagesStore.images.map((im) => toRaw(im)),
        sensors: sensors.sensors.map((s) => toRaw(s)),
        gcps: gcps.gcps,
        poses: poses.poses,
      },
      source: {
        images: data.images ?? [],
        sensors: sensorDoc?.sensors ?? [],
        gcps: gcpDoc?.gcps ?? [],
        poses: poseDoc?.poses ?? [],
      },
    })
    log(
      `Import project: "${sourceName}" — ${pluralize(plan.added.length, 'photo')} to add` +
        (plan.shared.length ? `, ${pluralize(plan.shared.length, 'photo')} already in this project` : ''),
      'info',
      'Import',
    )
    if (!plan.added.length) return { added: 0, shared: plan.shared.length, pairs: 0, sensors: 0, gcps: 0, poses: 0 }

    const newSensors = await sensors.addSensors(plan.sensors.add)

    // Photos, in batches: each keeps its uuid, label and sensor (ingest's extras).
    let done = 0
    const total = plan.added.length
    const missing = []
    const batchSize = PROJECT_IMPORT_TUNING.photosPerBatch
    for (let i = 0; i < total; i += batchSize) {
      const batch = plan.added.slice(i, i + batchSize)
      const files = [],
        extras = new Map()
      for (const { image, name } of batch) {
        const blob = await opfs.loadImageBlob(sourceId, image.uuid).catch(() => null)
        if (!blob) {
          missing.push(image.name)
          continue
        }
        const file = new File([blob], image.sourceName ?? image.name, { type: blob.type })
        files.push(file)
        extras.set(file, {
          uuid: image.uuid,
          name,
          sensorId: image.sensorId ? (plan.sensors.map.get(image.sensorId) ?? null) : null,
          meta: image.meta ?? null,
        })
      }
      if (files.length) await imagesStore.addImages(files, null, { extras, allowDuplicates: true })
      // Features: the keypoints, colours and descriptors as the other project detected them.
      const entries = []
      for (const { image } of batch) {
        if (image.kpStatus !== 'done') continue
        const data32 = await opfs.loadKeypoints(sourceId, image.uuid)
        if (!data32) continue
        const rgb = await opfs.loadColors(sourceId, image.uuid)
        const descriptors = await opfs.loadDescriptors(sourceId, image.uuid).catch(() => null)
        entries.push({ uuid: image.uuid, keypoints: asKeypoints({ data: data32, rgb }), descriptors, record: image })
      }
      if (entries.length) await imagesStore.importFeatures(entries, { invalidateMatches: false })
      for (const { image } of batch) {
        if (!image.hasMask) continue
        const mask = await opfs.loadMaskFile(sourceId, image.uuid).catch(() => null)
        const img = imagesStore.images.find((im) => im.uuid === image.uuid)
        if (mask && img) imagesStore.updateMask(img.id, mask)
      }
      done += batch.length
      onProgress(done, total, `Importing photos ${done}/${total}`)
    }
    if (missing.length)
      log(
        `Import project: ${pluralize(missing.length, 'photo')} of "${sourceName}" could not be read and stayed behind ` +
          `(${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`,
        'warn',
        'Import',
      )

    onProgress(total, total, 'Importing matches…')
    // Only pairs whose two photos arrived with their features (a photo that could not be
    // read, or whose keypoints could not, stayed behind with its pairs).
    const arrived = new Set(
      imagesStore.images.filter((im) => im.kpStatus === 'done' && plan.uuidOf.has(im.uuid)).map((im) => im.uuid),
    )
    const pairs = await matches.adoptProjectPairs(
      sourceId,
      (a, b) => plan.keepPair(a, b) && arrived.has(a) && arrived.has(b),
    )

    // GCP marks (joined by name) and imported positions, from the other project's CRS.
    const crs = gcpDoc?.crs ?? data.crs ?? projects.currentCrs
    let gcpCount = 0
    if (plan.gcps.length && crs)
      gcpCount = await gcps.addGcps(plan.gcps, crs, {}, { rememberDefaults: false, unit: 'project' })
    let poseCount = 0
    if (plan.poses.length && (poseDoc?.crs ?? data.crs))
      poseCount = await poses.addPoses(plan.poses, poseDoc?.crs ?? data.crs)
    await imagesStore.save()

    const result = {
      added: total - missing.length,
      shared: plan.shared.length,
      pairs,
      sensors: newSensors,
      gcps: gcpCount,
      poses: poseCount,
    }
    log(
      `Import project: added ${pluralize(result.added, 'photo')} from "${sourceName}" with their features and ` +
        `${pluralize(pairs, 'matched pair')}` +
        (newSensors ? `, ${pluralize(newSensors, 'new sensor')}` : '') +
        `. To join them to the model: Match Features (Match only new pairs), then Sparse Reconstruction ▸ Add to the model.`,
      'success',
      'Import',
    )
    return result
  }

  return { importProjectInto }
}
