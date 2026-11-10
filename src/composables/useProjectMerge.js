import { toRaw } from 'vue'
import * as opfs from '../utils/opfs.js'
import { planProjectMerge } from '../core/io/projectMerge.js'
import { alignModels, mergeModels } from '../core/sfm/modelMerge.js'
import { triangulateAllGcps } from '../core/sfm/gcpTriangulation.js'
import { gcpsInPinholeFrame, makeFrameModelResolver } from '../core/sfm/displayFrame.js'
import { frameFromSimilarity } from '../core/products/georef.js'
import { ensureProjection, isGeographic, transformer } from '../core/crs.js'
import { deserializeCloud } from '../stores/reconstruction/cloudSerde.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
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
// core/io/projectMerge.js). Its products stay behind. Its model either stays behind too
// (the photos then join this model by Match only new pairs and Add to the model, which
// needs overlap), or is merged into this one (`model: 'merge'`, core/sfm/modelMerge.js):
// placed by photos both projects solved, GCPs and markers marked in both, or both
// georeferences, so blocks without overlap join too.
export function useProjectMerge() {
  const projects = useProjectsStore()
  const imagesStore = useImagesStore()
  const sensors = useSensorsStore()
  const matches = useMatchesStore()
  const gcps = useGcpsStore()
  const poses = usePosesStore()
  const recon = useReconstructionStore()
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

  // → { added, shared, pairs, sensors, gcps, poses, cancelled, model? } or null when nothing
  // ran. `shouldCancel()` is asked between batches: a cancelled import stops there, and the
  // photos already in stay with their features, the pairs between them and their marks
  // (the model is then not merged). `options.model`: 'leave' (default) | 'merge';
  // `options.align`: 'auto' | 'photos' | 'gcps' | 'georef'.
  async function importProjectInto(sourceId, onProgress = () => {}, shouldCancel = () => false, options = {}) {
    const { model = 'leave', align = 'auto' } = options
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
    // This model's georeference as it is now: the photos and marks the import adds retire
    // it (its evidence changes), but it still places this model, which the import leaves
    // as it is.
    const georefA = recon.validGeoref ? structuredClone(toRaw(recon.validGeoref)) : null
    const crsA = projects.currentCrs
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
    if (!plan.added.length && model !== 'merge')
      return { added: 0, shared: plan.shared.length, pairs: 0, sensors: 0, gcps: 0, poses: 0 }

    const newSensors = await sensors.addSensors(plan.sensors.add)

    // Photos, in batches: each keeps its uuid, label and sensor (ingest's extras).
    let done = 0
    const total = plan.added.length
    const missing = []
    const batchSize = PROJECT_IMPORT_TUNING.photosPerBatch
    let cancelled = false
    for (let i = 0; i < total; i += batchSize) {
      if (shouldCancel()) {
        cancelled = true
        log(`Import project: cancelled after ${pluralize(done, 'photo')} of ${total}`, 'warn', 'Import')
        break
      }
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

    // GCP marks (joined by name) and imported positions, from the other project's CRS, on
    // the photos that are here: those that arrived, and those both projects hold. A
    // cancelled import leaves the rest's for the next import of the project.
    const here = new Set([
      ...plan.added.filter(({ image }) => arrived.has(image.uuid)).map(({ name }) => name),
      ...plan.shared.map(({ target }) => target.name),
    ])
    const gcpsHere = plan.gcps
      .map((g) => ({ ...g, observations: g.observations.filter((o) => here.has(o.imageName)) }))
      .filter((g) => g.observations.length || (g.x != null && g.y != null))
    const posesHere = plan.poses.filter((p) => here.has(p.imageName))
    const crs = gcpDoc?.crs ?? data.crs ?? projects.currentCrs
    let gcpCount = 0
    if (gcpsHere.length && crs)
      gcpCount = await gcps.addGcps(gcpsHere, crs, {}, { rememberDefaults: false, unit: 'project' })
    let poseCount = 0
    if (posesHere.length && (poseDoc?.crs ?? data.crs))
      poseCount = await poses.addPoses(posesHere, poseDoc?.crs ?? data.crs)
    // Sensors brought for photos that did not come: none of this project's images uses them.
    if (cancelled || missing.length) {
      const used = new Set(imagesStore.images.map((im) => im.sensorId).filter(Boolean))
      // The added sensors carry their final id (a renamed one too).
      for (const s of plan.sensors.add) if (!used.has(s.id)) sensors.removeSensor(s.id)
    }
    await imagesStore.save()

    const result = {
      cancelled,
      added: done - missing.length,
      shared: plan.shared.length,
      pairs,
      sensors: newSensors,
      gcps: gcpCount,
      poses: poseCount,
    }
    const merging = model === 'merge' && !cancelled
    log(
      `Import project: added ${pluralize(result.added, 'photo')} from "${sourceName}" with their features and ` +
        `${pluralize(pairs, 'matched pair')}` +
        (newSensors ? `, ${pluralize(newSensors, 'new sensor')}` : '') +
        (merging
          ? ''
          : `. To join them to the model: Match Features (Match only new pairs), then Sparse Reconstruction ▸ Add to the model.`),
      'success',
      'Import',
    )
    if (merging) {
      onProgress(total, total, 'Merging the model…')
      result.model = await mergeSourceModel({ sourceId, sourceName, data, plan, sensorDoc, georefA, crsA, align })
    }
    return result
  }

  // The other project's main model merged into this one (core/sfm/modelMerge.js), after
  // its photos, marks and sensors are in. → { merged, method?, cameras?, points?, tried? }.
  async function mergeSourceModel({ sourceId, sourceName, data, plan, sensorDoc, georefA, crsA, align }) {
    let doc
    try {
      doc = await opfs.loadReconstruction(sourceId)
    } catch (err) {
      log(`Import project: the model of "${sourceName}" cannot be read — ${err?.message ?? err}`, 'error', 'Import')
      return { merged: false, reason: 'unreadable' }
    }
    const sparse = (doc?.clouds ?? []).filter((c) => (c.kind ?? 'sparse') === 'sparse' && !c.secondary)
    const raw = sparse.find((c) => c.id === doc.mainSparseId) ?? sparse[0]
    if (!raw) {
      log(`Import project: "${sourceName}" has no model to merge; its photos came without one`, 'info', 'Import')
      return { merged: false, reason: 'no model' }
    }
    let n = 0
    const cloudB = deserializeCloud(raw, () => `merge-source-${n++}`)
    const here = new Set(imagesStore.images.map((im) => im.uuid))
    const sharedBtoA = new Map(plan.shared.map(({ source, target }) => [source.uuid, target.uuid]))
    // B's cameras on the photos that are here (one that could not be read stayed behind).
    const camsB = new Map([...cloudB.cameras].filter(([u]) => here.has(sharedBtoA.get(u) ?? u)))
    const sensorOfB = new Map((data.images ?? []).map((im) => [im.uuid, im.sensorId ?? null]))
    const main = recon.mainSparseCloud
    const camsA = main?.cameras ?? new Map()

    let alignment = null
    if (camsA.size) {
      const inputs = { camsA, camsB, sharedBtoA, ...(await gcpsInBoth({ camsA, camsB, cloudB, doc, sensorDoc, plan })) }
      const cross = await crossGeoref({ georefA, crsA, georefB: doc.georef, crsB: doc.georef?.crs ?? data.crs })
      if (cross.toA) inputs.toA = cross.toA
      else inputs.why = { georef: cross.reason }
      alignment = alignModels(inputs, align)
      if (!alignment.accepted) {
        log(
          `Import project: the model of "${sourceName}" could not be placed in this one — ` +
            alignment.tried.map((t) => `${METHOD_LABEL[t.method]}: ${t.reason}`).join('; ') +
            '. Its photos are in; where the blocks overlap, Match only new pairs and Add to the model join them.',
          'warn',
          'Import',
        )
        return { merged: false, tried: alignment.tried }
      }
    }
    const merged = mergeModels(
      main ? { cameras: camsA, points: main.points, calibration: main.calibration ?? null } : null,
      { cameras: camsB, points: cloudB.points, calibration: cloudB.calibration ?? null },
      { sim: alignment?.sim ?? null, sharedBtoA, sensorOfB },
    )
    await recon.addMergedModel({
      cameras: merged.cameras,
      points: merged.points,
      calibration: merged.calibration,
      name: main ? `${main.name} + ${sourceName}` : `${sourceName} (merged)`,
    })
    log(
      `Import project: merged the model of "${sourceName}"` +
        (alignment
          ? ` by ${METHOD_LABEL[alignment.method]} (${alignment.n} in common, ` +
            `RMS ${(100 * alignment.rmsFrac).toFixed(2)} % of their span)`
          : '') +
        ` — ${pluralize(merged.added.cameras, 'camera')} and ${pluralize(merged.added.points, 'point')} added` +
        (merged.dropped.cameras
          ? `; ${pluralize(merged.dropped.cameras, 'photo')} in both keep this model's camera`
          : '') +
        `. The model it was merged into stays in the list. Optimize Cameras adjusts the two together.`,
      'success',
      'Import',
    )
    // The georeference is fitted again on the merged model (GCPs of both, or positions).
    if (recon.canGeoreference) await recon.georeference()
    return {
      merged: true,
      method: alignment?.method ?? null,
      cameras: merged.added.cameras,
      points: merged.added.points,
      tried: alignment?.tried ?? [],
    }
  }

  // GCPs and markers triangulated in each model from their marks (now all in this
  // project's GCP list, on this project's photo labels), each through its own model's
  // lens. → { triA, triB } (Map name → [x, y, z]) or {}.
  async function gcpsInBoth({ camsA, camsB, cloudB, doc, sensorDoc, plan }) {
    const list = gcps.gcps.filter((g) => g.enabled !== false && (g.observations ?? []).length >= 2)
    if (!list.length) return {}
    const imagesA = new Map(imagesStore.images.map((im) => [im.id, im]))
    // B's view of the same photos: its uuid for each (a shared photo has B's own) and its
    // own sensor id, as B's calibration names them.
    const byUuidB = new Map(plan.shared.map(({ source, target }) => [target.uuid, source]))
    for (const { image } of plan.added) byUuidB.set(image.uuid, image)
    const imagesB = new Map()
    for (const im of imagesStore.images) {
      const b = byUuidB.get(im.uuid)
      if (b) imagesB.set(im.id, { ...b, id: im.id })
    }
    const frameB = makeFrameModelResolver({
      calibration: cloudB.calibration ?? null,
      summary: doc.summary ?? null,
      sensors: sensorDoc?.sensors ?? [],
    })
    const tri = async (cams, images, frameModel) => {
      const mapped = gcpsInPinholeFrame(list, { imagesById: images, sparseCameras: cams, frameModel })
      const out = new Map()
      for (const { gcp, tri: t } of await triangulateAllGcps(mapped, cams, images))
        if (t && [t.x, t.y, t.z].every(Number.isFinite)) out.set(gcp.name, [t.x, t.y, t.z])
      return out
    }
    return {
      triA: await tri(camsA, imagesA, recon.frameModelFor),
      triB: await tri(camsB, imagesB, frameB),
    }
  }

  // B model frame → A model frame through both georeferences and the two CRSs:
  // { toA } or { reason } (which side is not georeferenced, in a projected CRS). Heights
  // pass as they are.
  async function crossGeoref({ georefA, crsA, georefB, crsB }) {
    if (!georefA?.sim) return { reason: 'this model is not georeferenced' }
    if (!georefB?.sim) return { reason: 'the other model is not georeferenced' }
    if (!crsA || crsA === 'local' || !crsB || crsB === 'local') return { reason: 'a project has no CRS' }
    try {
      await ensureProjection(crsA)
      await ensureProjection(crsB)
    } catch (err) {
      return { reason: `its CRS is not known here (${err?.message ?? err})` }
    }
    if (isGeographic(crsA) || isGeographic(crsB)) return { reason: 'a project CRS is not projected' }
    const fromB = frameFromSimilarity(georefB.sim, crsB)
    const intoA = frameFromSimilarity(georefA.sim, crsA)
    const conv = transformer(crsB, crsA)
    return {
      toA: (p) => {
        const g = fromB.fromSfm(p)
        const [x, y] = conv(g[0], g[1])
        return Number.isFinite(x) && Number.isFinite(y) ? intoA.toSfm([x, y, g[2]]) : null
      },
    }
  }

  return { importProjectInto }
}

const METHOD_LABEL = { photos: 'photos in both', gcps: 'GCPs and markers', georef: 'georeference' }
