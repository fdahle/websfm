import { isStreamed, streamedRefusal, anyCloudBounds, STREAMED_ICP_SAMPLE_POINTS } from '../../core/lod/streamed.js'
import { markRaw, toRaw } from 'vue'
import { rawTexture } from './meshTexture.js'
import { facePages, regroupByPage } from '../../core/products/texture/carry.js'
import { isFisheyeModel } from '../../core/sfm/distortion.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { packSparseCloud, unpackReconstructionResult } from '../../core/sfm/resultCodec.js'
import {
  refineSparse as workerRefineSparse,
  optimizeSparse as workerOptimizeSparse,
  editCloud as workerEditCloud,
  POOL_SIZE,
} from '../../workers/computeClient.js'
import { pluralize } from '../../core/textFormat.js'
import { stampOf } from '../../core/products/productSet.js'
import { planCloudSlabs, gatherPoints } from '../../core/products/cloudSlabs.js'
import { planMeshBlocks, blockMesh, joinBlocks, BLOCK_HEADROOM } from '../../core/products/meshBlocks.js'
import { cloudBounds, estimateSpacing } from '../../core/products/cloudEdit.js'

// A crop of a streamed cloud becomes a resident one: at most this many points.
const STREAMED_CROP_MAX_POINTS = 25_000_000
// Edits a streamed cloud takes as it is (core/lod/transform.js); the rest need a crop.
const STREAMED_EDIT_MODES = new Set(['crop', 'mask', 'classify', 'filter', 'classify-ground', 'transform'])
// From this many points the outlier filter and normals split the cloud into slabs over
// the worker pool (each slab with a margin); below it one worker is as quick.
const SPLIT_MIN_POINTS = 1_000_000
const SPLIT_POINTS_PER_WORKER = 400_000
// From this many triangles Decimate splits an untextured mesh into blocks over the pool
// (core/products/meshBlocks.js), each worker taking at least SPLIT_TRIANGLES_PER_WORKER.
const DECIMATE_SPLIT_MIN_TRIANGLES = 500_000
const SPLIT_TRIANGLES_PER_WORKER = 250_000
// A streamed REFERENCE (alignment, distance) is read where the source is, at full
// detail up to this many points, coarser beyond (the log says so).
const STREAMED_REFERENCE_MAX_POINTS = 12_000_000

// Tools-tab edits (`editClouds` modes, dispatched by workers/ops/cloud.js):
// Mesh ▾ tools read a mesh (mesh-sample turns it into a dense cloud) …
const MESH_EDIT_MODES = new Set(['mesh-clean', 'mesh-smooth', 'mesh-decimate', 'mesh-crop', 'mesh-sample'])
// … these take [source, reference], where the reference may be a cloud or a mesh …
const REFERENCE_MODES = new Set(['icp', 'distance'])
// … and these produce a replacement view of their source (an aligned or
// recoloured copy), so the source is hidden like a selection edit's.
const REPLACES_SOURCE_VIEW = new Set([
  'transform',
  'icp',
  'distance',
  'normals',
  'classify-ground',
  'mesh-clean',
  'mesh-smooth',
  'mesh-decimate',
])

// Tools-tab cloud and mesh edits, split out of useReconstructionStore: every
// `editClouds` mode runs in the cloud-edit worker (workers/ops/cloud.js) and adds a
// derived cloud — non-destructive — except the sparse refinements (gradual
// selection, optimize cameras), which replace the main model and retire what was
// built on it.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createCloudEdits({
  clouds,
  healthDirty,
  imagesStore,
  invalidateSparseDependents,
  log,
  mainSparseCloud,
  makeCloudId,
  save,
  projects,
  reconStatus,
  selectedCloudId,
  summary,
  surveyConstraintInput,
  upsertSparseCloud,
  sensors,
  extractCloudPoints = null,
  carryFrameStamps = null,
  editStreamedCloud = null,
}) {
  // ── Cloud editing (crop / filter / merge) ────────────────────────────────────

  // Add a cloud produced by an edit. Always a NEW cloud — editing is
  // non-destructive, so the source stays exactly as it was and the user can compare
  // or discard. Flagged `derived: true` so upsertDenseCloud never replaces it with a
  // re-fuse's output (the same protection `imported` gives an imported cloud, for
  // the same reason: neither is the densify stage's own slot). `imported` is
  // INHERITED from the source, because that flag is what sorts the sidebar into
  // Products vs Reference Data — a crop of imported evidence is still evidence.
  // `from`: the clouds it was made from (basedOn: it is outdated once one is rebuilt).
  function addDerivedCloud(flat, { name, imported = false, from = [] }) {
    const cloud = {
      id: makeCloudId(),
      name,
      kind: 'dense',
      createdAt: Date.now(),
      derived: true,
      ...(from.length ? { basedOn: from.map(stampOf) } : {}),
      ...(imported ? { imported: true } : {}),
      cameras: markRaw(new Map()),
      count: flat.count,
      pos: markRaw(flat.pos),
      ...(flat.attributes ? { attributes: markRaw(flat.attributes) } : {}),
      col: flat.col ? markRaw(flat.col) : null, // markRaw(null) throws (Vue 3.5)
      ...(flat.nrm ? { nrm: markRaw(flat.nrm) } : {}),
    }
    clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    return cloud
  }

  // A Mesh ▾ tool's output: like addDerivedCloud, a NEW mesh flagged `derived`, so
  // upsertMeshCloud (a re-mesh) never replaces it.
  function addDerivedMesh(flat, { name, imported = false, from = [] }) {
    const cloud = {
      id: makeCloudId(),
      name,
      kind: 'mesh',
      createdAt: Date.now(),
      derived: true,
      ...(from.length ? { basedOn: from.map(stampOf) } : {}),
      ...(imported ? { imported: true } : {}),
      cameras: markRaw(new Map()),
      count: flat.count,
      nVerts: flat.nVerts,
      pos: markRaw(flat.pos),
      idx: markRaw(flat.idx),
      col: flat.col ? markRaw(flat.col) : null, // markRaw(null) throws (Vue 3.5)
      // A textured mesh (reconstruction/meshTexture.js): per-vertex UVs + atlas pages.
      ...(flat.uv && flat.texture ? { uv: markRaw(flat.uv), texture: rawTexture(flat.texture) } : {}),
    }
    clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    return cloud
  }

  // A mesh tool's result on a textured source keeps the texture when the tool kept the
  // triangles' UVs and pages (crop, clean without filled holes, smooth): regroup its
  // faces by page and share the source's atlas. Otherwise say why it is gone.
  function carryTexture(source, edited, mode) {
    if (!(source?.uv && source.texture)) return edited
    const regrouped = edited.uv ? regroupByPage(edited) : null
    if (regrouped) {
      return {
        ...edited,
        idx: regrouped.idx,
        texture: { data: source.texture.data, pages: source.texture.pages, groups: regrouped.groups },
      }
    }
    const why =
      mode === 'mesh-decimate'
        ? 'decimation merges triangles, so the photo texture cannot follow'
        : edited.uv
          ? 'the filled holes have no photo'
          : 'this tool does not keep it'
    log(
      `Mesh edit: the result has no texture (${why}); texture it again with Tools ▸ Mesh ▸ Texture`,
      'warn',
      'Products',
    )
    const { uv: _uv, page: _page, ...plain } = edited
    return plain
  }

  // Swap a derived cloud's buffers for an edited result, keeping its identity
  // (id/name/flags/style). A new object, like upsertSparseCloud, so the viewer
  // and the sidebar see the change by reference.
  function replaceDerivedCloud(snapshot, flat) {
    // Re-read by id: the edit awaited the worker, and a rename/restyle made
    // meanwhile must survive while a removal must not resurrect the cloud.
    const idx = clouds.value.findIndex((c) => c.id === snapshot.id)
    if (idx < 0) return null
    // The octree (`lod`) described the old points: the new ones get their own, built
    // again in the background (reconstruction/cloudLod.js), and the old files are
    // pruned once no cloud names them.
    const { attributes: _a, nrm: _n, lod: _l, ...rest } = clouds.value[idx]
    const cloud = {
      ...rest,
      createdAt: Date.now(),
      count: flat.count,
      pos: markRaw(flat.pos),
      ...(flat.attributes ? { attributes: markRaw(flat.attributes) } : {}),
      col: flat.col ? markRaw(flat.col) : null, // markRaw(null) throws (Vue 3.5)
      ...(flat.nrm ? { nrm: markRaw(flat.nrm) } : {}),
    }
    clouds.value.splice(idx, 1, cloud)
    selectedCloudId.value = cloud.id
    return cloud
  }

  // Crop / filter / merge / mask dense clouds in the worker. `sourceIds` are cloud ids
  // (one for crop/filter/mask, two or more for merge); `settings` is already in the
  // core/products/cloudEdit.js shape (the modals do the UI→core mapping in run()).
  //
  // Disposable copies are transferred to the worker. The source buffers remain
  // attached throughout, including when Cancel hard-terminates the worker.
  // Re-solve the MAIN sparse model in the worker and commit the result in place —
  // gradual selection and Optimize cameras (Tools ▸ Model ▾). Both work on a
  // disposable packed copy, are held to the same survey evidence (GCP anchors +
  // camera priors), and on success retire every computed dependent (depth maps,
  // dense, DEM/ortho…) through invalidateSparseDependents. A project switch or a
  // set-as-main mid-run supersedes the edit and leaves the model as it was.
  //   run(packed, { gcps, cameraPriors }) → worker result (packed)
  //   describe(result) → the log line's middle part
  async function refineMainSparse({ label, sourceId, createdAt, run, describe }) {
    const original = mainSparseCloud.value
    if (!original || original.id !== sourceId || original.createdAt !== createdAt) return null
    const projectId = projects.currentProjectId
    const statusBefore = reconStatus.value
    reconStatus.value = 'running'
    try {
      // Do not transfer: compact tracks may share the live model's buffers.
      const packed = packSparseCloud(original).result
      const survey = await surveyConstraintInput({ marks: 'pinhole' })
      if (projects.currentProjectId !== projectId || mainSparseCloud.value !== original) {
        if (reconStatus.value === 'running') reconStatus.value = statusBefore
        return null
      }
      const result = unpackReconstructionResult(
        await run(packed, { gcps: survey.gcps, cameraPriors: survey.cameraPriors }),
      )
      if (projects.currentProjectId !== projectId || mainSparseCloud.value !== original) {
        // Superseded (project switch / set-as-main mid-run): nothing changed here.
        if (reconStatus.value === 'running') reconStatus.value = statusBefore
        return null
      }
      // An edit of the model, not a recompute: provenance and the user's
      // display choices carry over (a reconstruct deliberately clears `imported`).
      upsertSparseCloud(result.cameras, result.points, {
        replaceId: original.id,
        asMain: true,
        name: original.name,
        imported: !!original.imported,
        secondary: !!original.secondary,
      })
      const edited = mainSparseCloud.value
      if (edited && original.style !== undefined) edited.style = original.style
      if (edited && original.visible !== undefined) edited.visible = original.visible
      // Same frame: the region and orientation drawn on the model stay with it.
      const carried = edited && carryFrameStamps ? carryFrameStamps(original, edited) : []
      if (carried.length)
        log(`${label}: the ${carried.join(' and ')} carried over to the edited model`, 'info', 'Reconstruction')
      await invalidateSparseDependents()
      // Calibration defines the canonical observation frame and must survive
      // a re-solve (neither tool frees a radial term). Old run statistics must not
      // masquerade as statistics of the edited cloud.
      summary.value = {
        selfCalDistortion: summary.value?.selfCalDistortion ?? [],
        fiducialTransforms: summary.value?.fiducialTransforms ?? [],
      }
      healthDirty.value++
      reconStatus.value = 'done'
      if (!(await save())) {
        log(`${label}: the edited model could not be saved — it will be lost on reload`, 'warn', 'Reconstruction')
      }
      const held = result.constraints ?? {}
      log(
        `${label}: ${describe(result)}; bundle adjustment ${result.costBefore.toFixed(3)} → ${result.costAfter.toFixed(3)} px` +
          (held.gcpAnchors || held.cameraPriors
            ? ` (held to ${pluralize(held.gcpAnchors || 0, 'GCP anchor')}, ${pluralize(held.cameraPriors || 0, 'camera prior')})`
            : ' (no survey constraints)'),
        'success',
        'Reconstruction',
      )
      if (held.gcpError) log(`${label}: GCP anchoring skipped — ${held.gcpError}`, 'warn', 'Reconstruction')
      return mainSparseCloud.value
    } catch (err) {
      log(`${label} stopped: ${err?.message ?? err}`, 'error', 'Reconstruction')
      reconStatus.value = 'error'
      return null
    }
  }

  // The lens each fisheye camera of the main model was solved with — the run's
  // (self-calibrated) lens where it has one, else its sensor's (displayFrame.js
  // resolver) — as plain data for the worker. Empty without fisheye sensors.
  function fisheyeLensByUuid() {
    const cams = mainSparseCloud.value?.cameras
    const fisheyeIds = new Set((sensors?.value ?? []).filter((s) => isFisheyeModel(s.distortionModel)).map((s) => s.id))
    if (!cams || !fisheyeIds.size) return {}
    const frameModel = makeFrameModelResolver({ summary: toRaw(summary.value), sensors: sensors.value })
    const out = {}
    for (const img of imagesStore.images) {
      if (!fisheyeIds.has(img.sensorId) || !cams.has(img.uuid)) continue
      const { dist } = frameModel(img)
      if (dist?.fisheye) out[img.uuid] = { ...dist }
    }
    return out
  }

  // Images' sensor ids as small integers (BA groups shared intrinsics by them).
  function sensorIndexByUuid() {
    const ids = new Map()
    const out = {}
    for (const img of imagesStore.images) {
      if (img.sensorId == null) continue
      if (!ids.has(img.sensorId)) ids.set(img.sensorId, ids.size)
      out[img.uuid] = ids.get(img.sensorId)
    }
    return out
  }

  // Crop of a streamed cloud (core/lod/streamed.js): the points inside the box come
  // out of its octree as a new, resident cloud that every tool can use. Past the
  // budget the copy is thinned evenly (finer octree levels left out), never cut.
  async function cropStreamed(source, settings, name, onProgress) {
    const statusBefore = reconStatus.value
    reconStatus.value = 'running'
    try {
      const box = { min: settings.min ?? [], max: settings.max ?? [] }
      const projectId = projects.currentProjectId
      const { cloud: flat, plan } = await extractCloudPoints(
        source,
        { box, maxPoints: STREAMED_CROP_MAX_POINTS },
        onProgress,
      )
      // A project closed or switched while the octree was read: the crop is not its.
      if (projects.currentProjectId !== projectId) {
        log('Crop: not added — its project was closed while the points were read', 'warn', 'Products')
        if (reconStatus.value === 'running') reconStatus.value = statusBefore
        return null
      }
      if (!flat.count) {
        log('Crop: no point of the cloud lies inside the box', 'warn', 'Products')
        reconStatus.value = 'done'
        return null
      }
      const cloud = addDerivedCloud(flat, {
        name: name || `${source.name} (cropped)`,
        imported: !!source.imported,
        from: [source],
      })
      if (source.style) cloud.style = JSON.parse(JSON.stringify(source.style))
      log(
        `Crop: copied ${flat.count.toLocaleString()} points of the streamed cloud into "${cloud.name}"` +
          (plan.complete
            ? ''
            : ` — thinned to ${plan.spacing.toPrecision(3)}-unit spacing to stay within ` +
              `${(STREAMED_CROP_MAX_POINTS / 1e6).toFixed(0)} M points; crop a smaller box for full detail`),
        plan.complete ? 'success' : 'warn',
        'Products',
      )
      reconStatus.value = 'done'
      await save()
      return cloud
    } catch (err) {
      log(`Crop error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
      return null
    }
  }

  // The points of a streamed reference within the source's box, grown by the search
  // radius (or 10 % of the box), as a plain resident cloud { kind: 'dense', count, pos,
  // col } for one alignment or distance run. Not added to the project.
  async function streamedReference(reference, source, settings, onProgress) {
    const b = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    for (let i = 0; i < source.count; i++)
      for (let k = 0; k < 3; k++) {
        const v = source.pos[3 * i + k]
        if (v < b.min[k]) b.min[k] = v
        if (v > b.max[k]) b.max[k] = v
      }
    const size = Math.max(...[0, 1, 2].map((k) => b.max[k] - b.min[k]))
    const grow = settings.maxDistance > 0 ? settings.maxDistance : 0.1 * size
    const box = { min: b.min.map((v) => v - grow), max: b.max.map((v) => v + grow) }
    try {
      const { cloud: flat, plan } = await extractCloudPoints(
        reference,
        { box, maxPoints: STREAMED_REFERENCE_MAX_POINTS },
        onProgress,
      )
      if (!flat.count) {
        log(`Cloud edit: the reference "${reference.name}" has no point where the source is`, 'warn', 'Products')
        return null
      }
      log(
        `Cloud edit: read ${flat.count.toLocaleString()} points of the streamed reference "${reference.name}" around the source` +
          (plan.complete ? '' : ` (thinned to ${plan.spacing.toPrecision(3)}-unit spacing)`),
        plan.complete ? 'info' : 'warn',
        'Products',
      )
      return { ...flat, id: reference.id, name: reference.name, kind: 'dense' }
    } catch (err) {
      log(`Cloud edit error: ${err?.message ?? err}`, 'error', 'Products')
      return null
    }
  }

  // One slab-split run over the pool (core/products/cloudSlabs.js): `mode` runs on every
  // slab + margin in its own worker; `take(part, result)` keeps each slab's own points'
  // results. Progress is the slabs' mean.
  async function runOverSlabs(cloud, { mode, settings, halo, withNormals = false }, take, onProgress) {
    const workers = Math.max(2, Math.min(POOL_SIZE, Math.ceil(cloud.count / SPLIT_POINTS_PER_WORKER)))
    const { parts } = planCloudSlabs(cloud.pos, cloud.count, { slabs: workers, halo })
    const fractions = new Array(parts.length).fill(0)
    await Promise.all(
      parts.map(async (part, w) => {
        const slab = gatherPoints(cloud, part.idx, { withNormals })
        const transfer = [slab.pos.buffer, ...(slab.nrm ? [slab.nrm.buffer] : [])]
        const { cloud: out, error } = await workerEditCloud(
          { mode, clouds: [{ id: `part-${w}`, kind: 'dense', ...slab }], settings },
          {
            worker: w,
            transfer,
            onLog: (m, l, c) => log(m, l, c),
            onProgress: (d, t, lbl, f) => {
              fractions[w] = f ?? d / Math.max(1, t)
              onProgress?.(
                fractions.reduce((a, b) => a + b, 0),
                parts.length,
                lbl,
                fractions.reduce((a, b) => a + b, 0) / parts.length,
              )
            },
          },
        )
        if (error) throw new Error(error)
        take(part, out)
      }),
    )
    return parts.length
  }

  // The dense cloud's buffers as the cloud-edit worker takes them (copies, transferred).
  function editPayload(c, transfer) {
    const pos = c.pos.slice(),
      col = c.col?.slice() || null,
      nrm = c.nrm?.slice() || null
    transfer.push(pos.buffer, ...(col ? [col.buffer] : []), ...(nrm ? [nrm.buffer] : []))
    const attributes = Object.fromEntries(
      Object.entries(c.attributes || {}).map(([key, values]) => {
        const copy = values.slice()
        transfer.push(copy.buffer)
        return [key, copy]
      }),
    )
    return { id: c.id, kind: 'dense', count: c.count, pos, col, nrm, attributes }
  }

  // The outlier filter (Filter with `sor` last) and Estimate normals of a large resident
  // cloud, split over the pool. The outlier filter is exact: a slab's margin is the
  // filter's own neighbour reach (nothing farther counts), and the limit is the whole
  // cloud's mean + ratio·σ. Normals take a margin of six point spacings. → the new cloud,
  // or undefined when the run is not one to split.
  async function splitEdit(source, mode, settings, name, onProgress) {
    const methods = settings.methods ?? []
    const sorLast = mode === 'filter' && methods[methods.length - 1] === 'sor'
    // `split: false` keeps one worker (the bench compares the two).
    if (settings.split === false) return undefined
    if (!(sorLast || mode === 'normals') || POOL_SIZE < 2 || source.count < SPLIT_MIN_POINTS) return undefined
    const t0 = performance.now()
    let result
    if (mode === 'normals') {
      const nrm = new Float32Array(source.count * 3)
      const halo = 6 * (estimateSpacing(cloudBounds(source), source.count) || 1)
      const used = await runOverSlabs(
        source,
        { mode: 'part-normals', settings, halo, withNormals: settings.orient?.kind === 'existing' },
        (part, out) => {
          for (let j = 0; j < part.own; j++) {
            const i = part.idx[j] * 3
            nrm[i] = out.nrm[j * 3]
            nrm[i + 1] = out.nrm[j * 3 + 1]
            nrm[i + 2] = out.nrm[j * 3 + 2]
          }
        },
        onProgress,
      )
      const t = []
      const copy = editPayload(source, t)
      result = { count: source.count, pos: copy.pos, col: copy.col, nrm, attributes: copy.attributes }
      log(
        `Normals: ${source.count.toLocaleString()} points on ${pluralize(used, 'worker')} in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        'success',
        'Products',
      )
    } else {
      // The filters before the outlier filter (cheap, linear) on one worker, then the
      // outlier filter's neighbour means over the pool, then the cut.
      let cloud = source
      const before = methods.slice(0, -1)
      if (before.length) {
        const transfer = []
        const { cloud: pre, error } = await workerEditCloud(
          { mode: 'filter', clouds: [editPayload(source, transfer)], settings: { ...settings, methods: before } },
          { transfer, onLog: (m, l, c) => log(m, l, c) },
        )
        if (error) throw new Error(error)
        cloud = pre
      }
      if (!cloud?.count) return null
      const sor = settings.sor ?? {}
      const reach = sor.reach > 0 ? sor.reach : 4 * estimateSpacing(cloudBounds(cloud), cloud.count)
      const mean = new Float64Array(cloud.count),
        lonely = new Uint8Array(cloud.count)
      const used = await runOverSlabs(
        cloud,
        { mode: 'part-sor', settings: { k: sor.k ?? 12, reach }, halo: reach },
        (part, out) => {
          for (let j = 0; j < part.own; j++) {
            mean[part.idx[j]] = out.attributes.mean[j]
            lonely[part.idx[j]] = out.attributes.lonely[j]
          }
        },
        onProgress,
      )
      let cnt = 0,
        s1 = 0,
        s2 = 0
      for (let i = 0; i < cloud.count; i++) {
        if (lonely[i]) continue
        cnt++
        s1 += mean[i]
        s2 += mean[i] * mean[i]
      }
      const mu = cnt ? s1 / cnt : 0
      const sigma = cnt ? Math.sqrt(Math.max(s2 / cnt - mu * mu, 0)) : 0
      const limit = mu + (sor.stdRatio ?? 1.5) * sigma
      const keep = new Uint8Array(cloud.count)
      let kept = 0
      for (let i = 0; i < cloud.count; i++)
        if (!lonely[i] && mean[i] <= limit) {
          keep[i] = 1
          kept++
        }
      log(
        `Filter (outlier): mean neighbour distance ${mu.toFixed(4)} ±${sigma.toFixed(4)}, limit ${limit.toFixed(4)} → ` +
          `kept ${kept.toLocaleString()} of ${cloud.count.toLocaleString()}, on ${pluralize(used, 'worker')} ` +
          `in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        'info',
        'Products',
      )
      const transfer = [keep.buffer]
      const { cloud: out, error } = await workerEditCloud(
        { mode: 'mask', clouds: [editPayload(cloud, transfer)], settings: { mask: keep, keepSelected: true } },
        { transfer, onLog: () => {} },
      )
      if (error) throw new Error(error)
      result = out
    }
    if (!result?.count) return null
    const cloud = addDerivedCloud(result, {
      name: name || `${source.name} (${mode})`,
      imported: !!source.imported,
      from: [source],
    })
    if (REPLACES_SOURCE_VIEW.has(mode)) source.visible = false
    log(`Cloud edit: added "${cloud.name}" — ${cloud.count.toLocaleString()} points`, 'success', 'Products')
    return cloud
  }

  // Decimate of a large untextured mesh over the pool (core/products/meshBlocks.js): the
  // blocks decimated apart with their shared vertices locked, to BLOCK_HEADROOM above
  // the target, then one pass over the joined mesh to the target, across the seams.
  // → the new mesh, or undefined where one worker does it (`settings.split === false`,
  // a small or textured mesh, one worker).
  async function splitDecimate(source, settings, name, onProgress) {
    if (settings.split === false || POOL_SIZE < 2 || source.uv || source.count < DECIMATE_SPLIT_MIN_TRIANGLES)
      return undefined
    const t0 = performance.now()
    const target =
      settings.targetTriangles != null
        ? Math.max(0, Math.floor(settings.targetTriangles))
        : Math.round(source.count * Math.min(1, Math.max(0, Number(settings.targetRatio) || 0)))
    const { targetTriangles: _t, targetRatio: _r, split: _s, ...opts } = settings
    const workers = Math.max(2, Math.min(POOL_SIZE, Math.floor(source.count / SPLIT_TRIANGLES_PER_WORKER)))
    const { parts, shared } = planMeshBlocks(source, workers)
    const ratio = Math.min(1, (target / Math.max(1, source.count)) * (1 + BLOCK_HEADROOM))
    const fractions = new Array(parts.length).fill(0)
    const blocks = await Promise.all(
      parts.map(async (part, w) => {
        const b = blockMesh(source, part.tris, shared)
        const transfer = [b.mesh.pos.buffer, b.mesh.idx.buffer, ...(b.mesh.col ? [b.mesh.col.buffer] : [])]
        const {
          cloud: out,
          error,
          extra,
        } = await workerEditCloud(
          {
            mode: 'part-decimate',
            clouds: [{ id: `block-${w}`, kind: 'mesh', ...b.mesh }],
            settings: {
              ...opts,
              targetTriangles: Math.round(part.tris.length * ratio),
              locked: b.locked,
              vertex: b.vertex,
            },
          },
          {
            worker: w,
            transfer,
            onLog: (m, l, c) => log(m, l, c),
            onProgress: (d, t, lbl, f) => {
              fractions[w] = f ?? d / Math.max(1, t)
              const sum = fractions.reduce((a, c) => a + c, 0)
              onProgress?.(sum, parts.length + 1, 'Decimating blocks', sum / (parts.length + 1))
            },
          },
        )
        if (error) throw new Error(error)
        return { mesh: out, vertex: extra.vertex }
      }),
    )
    const joined = joinBlocks(blocks, shared)
    const transfer = [joined.pos.buffer, joined.idx.buffer, ...(joined.col ? [joined.col.buffer] : [])]
    const {
      cloud: out,
      error,
      extra: stats,
    } = await workerEditCloud(
      {
        mode: 'part-decimate',
        clouds: [{ id: 'joined', kind: 'mesh', ...joined }],
        settings: { ...opts, targetTriangles: target },
      },
      {
        transfer,
        onLog: (m, l, c) => log(m, l, c),
        onProgress: (d, t, lbl, f) =>
          onProgress?.(
            parts.length + (f ?? 0),
            parts.length + 1,
            'Decimating across the seams',
            (parts.length + (f ?? 0)) / (parts.length + 1),
          ),
      },
    )
    if (error) throw new Error(error)
    if (!out?.count) return null
    log(
      `Decimate: ${out.count.toLocaleString()} triangles from ${source.count.toLocaleString()}, ` +
        `${pluralize(parts.length, 'block')} on ${pluralize(parts.length, 'worker')} ` +
        `(${joined.count.toLocaleString()} joined, then across the seams), largest error ` +
        `${(stats?.maxError ?? 0).toPrecision(3)}, in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      'success',
      'Products',
    )
    const mesh = addDerivedMesh(out, {
      name: name || `${source.name} (mesh-decimate)`,
      imported: !!source.imported,
      from: [source],
    })
    if (REPLACES_SOURCE_VIEW.has('mesh-decimate')) source.visible = false
    return mesh
  }

  async function editClouds({ mode, sourceIds = [], settings = {}, name, style = null } = {}, onProgress) {
    // Model edits (Tools ▸ Model ▾): one shared commit path, refineMainSparse.
    if (mode === 'sparse') {
      return refineMainSparse({
        label: 'Gradual selection',
        sourceId: sourceIds[0],
        createdAt: settings.createdAt,
        run: (packed, survey) =>
          workerRefineSparse(packed, { metric: settings.metric, threshold: settings.threshold }, survey),
        describe: (r) => `removed ${r.removed} points`,
      })
    }
    if (mode === 'optimize') {
      return refineMainSparse({
        label: 'Optimize cameras',
        sourceId: sourceIds[0],
        createdAt: settings.createdAt,
        // Fisheye cameras solve in recorded pixels with the run's lens, and their
        // observations are re-derived about the new K (gradualSelection.js).
        run: (packed, survey) =>
          workerOptimizeSparse(
            packed,
            { refine: settings.refine, sensorOfUuid: sensorIndexByUuid(), lensOfUuid: fisheyeLensByUuid() },
            survey,
          ),
        describe: (r) =>
          `refined ${settings.refine === 'f,cxcy' ? 'focal length and principal point' : 'focal length'} (largest change ${((r.focalChange ?? 0) * 100).toFixed(2)}%)` +
          (r.removed ? `, dropped ${r.removed} points with fewer than two observations` : ''),
      })
    }
    // Which kinds each slot accepts. Mesh ▾ tools read a mesh; the reference of an
    // alignment or a distance may be a dense cloud or a mesh; everything else is
    // dense-only (a sparse cloud's points carry view-tracks — never edited here).
    const meshSource = MESH_EDIT_MODES.has(mode)
    let resolved = sourceIds.map((id) => clouds.value.find((c) => c.id === id) ?? null)
    // A streamed source of an alignment: found on a sample of it, then applied to all of
    // it by the streamed Transform (below, once the worker has the transform).
    const streamedSource = mode === 'icp' && isStreamed(resolved[0]) && editStreamedCloud ? resolved[0] : null
    if (streamedSource) {
      if (!extractCloudPoints || !resolved[1] || resolved[1].id === streamedSource.id) {
        log('Cloud edit: choose a reference other than the source', 'warn', 'Products')
        return null
      }
      try {
        const { cloud: flat, plan } = await extractCloudPoints(
          streamedSource,
          { maxPoints: STREAMED_ICP_SAMPLE_POINTS },
          onProgress,
        )
        if (!flat.count) return null
        log(
          `ICP: aligning on ${flat.count.toLocaleString()} points of the streamed source "${streamedSource.name}"` +
            (plan.complete ? '' : ` (${plan.spacing.toPrecision(3)}-unit spacing)`) +
            `, then moving all ${streamedSource.count.toLocaleString()}`,
          'info',
          'Products',
        )
        resolved = [
          { ...flat, id: `${streamedSource.id}:sample`, name: streamedSource.name, kind: 'dense' },
          resolved[1],
        ]
        // The automatic search radius is the whole cloud's (10× its spacing), not the
        // thinned sample's.
        if (!(settings.maxDistance > 0))
          settings = {
            ...settings,
            maxDistance: 10 * (estimateSpacing(anyCloudBounds(streamedSource), streamedSource.count) || 1),
          }
      } catch (err) {
        log(`Cloud edit error: ${err?.message ?? err}`, 'error', 'Products')
        return null
      }
    }
    // A streamed reference (an imported survey too large to hold): only the part around
    // the source matters, read from its octree as a resident cloud for this run.
    if (REFERENCE_MODES.has(mode) && isStreamed(resolved[1]) && resolved[0]?.pos && extractCloudPoints) {
      const ref = await streamedReference(resolved[1], resolved[0], settings, onProgress)
      if (!ref) return null
      resolved = [resolved[0], ref]
    }
    const okKind = (c, slot) =>
      c &&
      c.count > 0 &&
      !isStreamed(c) &&
      (slot === 0
        ? meshSource
          ? c.kind === 'mesh'
          : c.kind === 'dense'
        : REFERENCE_MODES.has(mode)
          ? c.kind === 'dense' || c.kind === 'mesh'
          : c.kind === 'dense')
    const sources = resolved.filter((c, slot) => okKind(c, slot))
    const streamed = resolved.find(isStreamed)
    if (streamed && mode === 'crop' && !settings.invert && resolved.length === 1 && extractCloudPoints) {
      return cropStreamed(streamed, settings, name, onProgress)
    }
    // The edits that run on a streamed cloud itself, into a new streamed cloud.
    if (streamed && resolved.length === 1 && STREAMED_EDIT_MODES.has(mode) && editStreamedCloud) {
      if ((mode === 'mask' || mode === 'classify') && !settings.selection) {
        log('Selection edit: the selection no longer matches the cloud — select again', 'warn', 'Products')
        return null
      }
      reconStatus.value = 'running'
      try {
        const label = {
          'crop': 'cropped',
          'mask': 'edited',
          'classify': 'reclassified',
          'filter': 'filtered',
          'classify-ground': 'ground',
          'transform': 'transformed',
        }[mode]
        const selection = mode === 'mask' || mode === 'classify'
        // A selection edit of a derived cloud refines it (as for a resident cloud): the
        // new one takes its place, and the old octree's files are pruned once no cloud
        // names them (the next octree build, or the project's next open).
        const refine = selection && streamed.derived
        const cloud = await editStreamedCloud(
          streamed,
          { mode, settings, name: refine ? streamed.name : name || `${streamed.name} (${label})` },
          onProgress,
        )
        if (cloud && mode === 'classify-ground') cloud.style = { field: 'attribute:classification' }
        if (cloud && refine) {
          clouds.value = clouds.value.filter((c) => c !== streamed)
          await save()
        } else if (cloud && (selection || REPLACES_SOURCE_VIEW.has(mode))) streamed.visible = false
        reconStatus.value = cloud ? 'done' : 'error'
        if (cloud)
          log(
            `Cloud edit: added "${cloud.name}" (${cloud.count.toLocaleString()} points, streamed)`,
            'success',
            'Products',
          )
        return cloud
      } catch (err) {
        log(`Cloud edit error: ${err?.message ?? err}`, 'error', 'Products')
        reconStatus.value = 'error'
        return null
      }
    }
    if (streamed) {
      log(streamedRefusal(streamed, 'Cloud edit'), 'warn', 'Products')
      return null
    }
    if (!sources.length || sources.length !== resolved.length) {
      log(`Cloud edit: no usable ${meshSource ? 'mesh' : 'dense cloud'} for this tool`, 'warn', 'Products')
      return null
    }
    if (sources.length === 1 && (mode === 'filter' || mode === 'normals' || mode === 'mesh-decimate')) {
      reconStatus.value = 'running'
      try {
        const cloud =
          mode === 'mesh-decimate'
            ? await splitDecimate(sources[0], settings, name, onProgress)
            : await splitEdit(sources[0], mode, settings, name, onProgress)
        if (cloud !== undefined) {
          reconStatus.value = 'done'
          if (cloud) await save()
          else log('Cloud edit: the result is empty — nothing was added', 'warn', 'Products')
          return cloud
        }
      } catch (err) {
        log(`Cloud edit error: ${err?.message ?? err}`, 'error', 'Products')
        reconStatus.value = 'error'
        return null
      }
    }
    if (mode === 'merge' && sources.length < 2) {
      log('Cloud edit: merge needs at least two dense clouds', 'warn', 'Products')
      return null
    }
    if (REFERENCE_MODES.has(mode) && (sources.length < 2 || sources[0].id === sources[1].id)) {
      log('Cloud edit: choose a reference other than the source', 'warn', 'Products')
      return null
    }
    const transfer = []
    const payload = sources.map((c) => {
      const pos = c.pos.slice()
      const col = c.col?.slice() || null
      const nrm = c.nrm?.slice() || null
      transfer.push(pos.buffer)
      if (col) transfer.push(col.buffer)
      if (nrm) transfer.push(nrm.buffer)
      if (c.kind === 'mesh') {
        const idx = c.idx.slice()
        transfer.push(idx.buffer)
        // A textured mesh: UVs and a page per face travel with it (meshEdit.js carries
        // them); Sample to points also needs the pages themselves.
        const tex =
          c.uv && c.texture
            ? {
                uv: c.uv.slice(),
                page: facePages(c.texture.groups, c.count),
                ...(mode === 'mesh-sample'
                  ? { texture: { data: c.texture.data, pages: c.texture.pages.map((p) => ({ ...p })) } }
                  : {}),
              }
            : {}
        if (tex.uv) transfer.push(tex.uv.buffer, tex.page.buffer)
        return { id: c.id, kind: 'mesh', count: c.count, nVerts: c.nVerts, pos, col, idx, ...tex }
      }
      const attributes = Object.fromEntries(
        Object.entries(c.attributes || {}).map(([key, values]) => {
          const copy = values.slice()
          transfer.push(copy.buffer)
          return [key, copy]
        }),
      )
      return { id: c.id, kind: 'dense', count: c.count, pos, col, nrm, attributes }
    })
    if (mode === 'mask' || mode === 'classify') {
      // The viewer's selection is stamped with the buffer it was drawn from; a
      // replaced cloud (re-fuse, another edit) must not receive a stale mask.
      if (!(settings.mask instanceof Uint8Array) || settings.mask.length !== sources[0].count) {
        log('Selection edit: the selection no longer matches the cloud — select again', 'warn', 'Products')
        return null
      }
      transfer.push(settings.mask.buffer)
    }
    reconStatus.value = 'running'
    try {
      const {
        cloud: edited,
        error,
        extra,
      } = await workerEditCloud(
        { mode, clouds: payload, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      if (error) throw new Error(error)
      if (!edited?.count) {
        log('Cloud edit: the result is empty — nothing was added', 'warn', 'Products')
        reconStatus.value = 'done'
        return null
      }
      if (streamedSource) {
        const cloud = await editStreamedCloud(
          streamedSource,
          { mode: 'transform', settings: { transform: extra.transform }, name: name || `${streamedSource.name} (icp)` },
          onProgress,
        )
        if (cloud) streamedSource.visible = false
        reconStatus.value = cloud ? 'done' : 'error'
        if (cloud)
          log(
            `Cloud edit: added "${cloud.name}" (${cloud.count.toLocaleString()} points, streamed)`,
            'success',
            'Products',
          )
        return cloud
      }
      let cloud
      if ((mode === 'mask' || mode === 'classify') && sources[0].derived) {
        // A derived cloud is already the user's own working copy, so selection
        // edits refine it in place — repeated cleanup must not stack one full copy
        // per stroke in memory and OPFS. Computed and imported clouds stay
        // untouched: their first selection edit forks a derived copy (below).
        cloud = replaceDerivedCloud(sources[0], edited)
        if (!cloud) {
          log('Selection edit: the cloud was removed while the edit ran', 'warn', 'Products')
          reconStatus.value = 'done'
          return null
        }
        log(
          mode === 'classify'
            ? `Classify: "${cloud.name}" updated`
            : `Selection edit: "${cloud.name}" now has ${cloud.count.toLocaleString()} points`,
          'success',
          'Products',
        )
        // A reclassification shows its classes.
        if (mode === 'classify' && cloud.style?.field !== 'attribute:classification')
          cloud.style = { ...(cloud.style || {}), field: 'attribute:classification' }
      } else {
        const opts = {
          name:
            name || `${sources[0].name} (${mode === 'mask' ? 'edited' : mode === 'classify' ? 'classified' : mode})`,
          // Provenance follows the SOURCE (slot 0) — a reference only informs the edit.
          imported: REFERENCE_MODES.has(mode) ? !!sources[0].imported : sources.every((c) => c.imported),
          from: REFERENCE_MODES.has(mode) ? [sources[0]] : sources,
        }
        cloud = edited.idx
          ? addDerivedMesh(carryTexture(sources[0], edited, mode), opts)
          : addDerivedCloud(edited, opts)
        // A tool may start its result on a colouring (distance → a diverging ramp);
        // a function sees the worker's small result record (e.g. the distance spread).
        const startStyle =
          mode === 'classify'
            ? { field: 'attribute:classification' }
            : typeof style === 'function'
              ? style(extra ?? null)
              : style
        if (startStyle) cloud.style = startStyle
        // Show the edit in place of its source; the source stays one visibility
        // toggle away for comparison or to start over.
        if (mode === 'mask' || mode === 'classify' || REPLACES_SOURCE_VIEW.has(mode)) sources[0].visible = false
        log(
          `Cloud edit: added "${cloud.name}" — ${
            cloud.kind === 'mesh'
              ? `${cloud.count.toLocaleString()} triangles`
              : `${cloud.count.toLocaleString()} points`
          }`,
          'success',
          'Products',
        )
      }
      reconStatus.value = 'done'
      await save()
      return cloud
    } catch (err) {
      log(`Cloud edit error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
      return null
    }
  }

  return {
    addDerivedCloud,
    addDerivedMesh,
    replaceDerivedCloud,
    refineMainSparse,
    sensorIndexByUuid,
    editClouds,
  }
}
