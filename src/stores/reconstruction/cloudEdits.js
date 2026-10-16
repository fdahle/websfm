import { isStreamed, streamedRefusal } from '../../core/lod/streamed.js'
import { markRaw } from 'vue'
import { rawTexture } from './meshTexture.js'
import { facePages, regroupByPage } from '../../core/products/texture/carry.js'
import { isFisheyeModel } from '../../core/sfm/distortion.js'
import { makeFrameModelResolver } from '../../core/sfm/displayFrame.js'
import { packSparseCloud, unpackReconstructionResult } from '../../core/sfm/resultCodec.js'
import { refineSparse as workerRefineSparse, optimizeSparse as workerOptimizeSparse, editCloud as workerEditCloud } from '../../workers/computeClient.js'

// A crop of a streamed cloud becomes a resident one: at most this many points.
const STREAMED_CROP_MAX_POINTS = 25_000_000

// Tools-tab edits (`editClouds` modes, dispatched by workers/ops/cloud.js):
// Mesh ▾ tools read a mesh (mesh-sample turns it into a dense cloud) …
const MESH_EDIT_MODES = new Set(['mesh-clean', 'mesh-smooth', 'mesh-decimate', 'mesh-crop', 'mesh-sample'])
// … these take [source, reference], where the reference may be a cloud or a mesh …
const REFERENCE_MODES = new Set(['icp', 'distance'])
// … and these produce a replacement view of their source (an aligned or
// recoloured copy), so the source is hidden like a selection edit's.
const REPLACES_SOURCE_VIEW = new Set(['transform', 'icp', 'distance', 'normals', 'classify-ground', 'mesh-clean', 'mesh-smooth', 'mesh-decimate'])

// Tools-tab cloud and mesh edits, split out of useReconstructionStore: every
// `editClouds` mode runs in the cloud-edit worker (workers/ops/cloud.js) and adds a
// derived cloud — non-destructive — except the sparse refinements (gradual
// selection, optimize cameras), which replace the main model and retire what was
// built on it.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createCloudEdits({
  clouds, healthDirty, imagesStore, invalidateSparseDependents, log, mainSparseCloud, makeCloudId,
  save, projects, reconStatus, selectedCloudId, summary, surveyConstraintInput, upsertSparseCloud, sensors,
  extractCloudPoints = null,
}) {
  // ── Cloud editing (crop / filter / merge) ────────────────────────────────────

  // Add a cloud produced by an edit. Always a NEW cloud — editing is
  // non-destructive, so the source stays exactly as it was and the user can compare
  // or discard. Flagged `derived: true` so upsertDenseCloud never replaces it with a
  // re-fuse's output (the same protection `imported` gives an imported cloud, for
  // the same reason: neither is the densify stage's own slot). `imported` is
  // INHERITED from the source, because that flag is what sorts the sidebar into
  // Products vs Reference Data — a crop of imported evidence is still evidence.
  function addDerivedCloud(flat, { name, imported = false }) {
    const cloud = {
      id: makeCloudId(),
      name,
      kind: 'dense',
      createdAt: Date.now(),
      derived: true,
      ...(imported ? { imported: true } : {}),
      cameras: markRaw(new Map()),
      count: flat.count,
      pos: markRaw(flat.pos),
      ...(flat.attributes ? { attributes: markRaw(flat.attributes) } : {}),
      col: markRaw(flat.col || null),
      ...(flat.nrm ? { nrm: markRaw(flat.nrm) } : {}),
    }
    clouds.value.push(cloud)
    selectedCloudId.value = cloud.id
    return cloud
  }

  // A Mesh ▾ tool's output: like addDerivedCloud, a NEW mesh flagged `derived`, so
  // upsertMeshCloud (a re-mesh) never replaces it.
  function addDerivedMesh(flat, { name, imported = false }) {
    const cloud = {
      id: makeCloudId(),
      name,
      kind: 'mesh',
      createdAt: Date.now(),
      derived: true,
      ...(imported ? { imported: true } : {}),
      cameras: markRaw(new Map()),
      count: flat.count,
      nVerts: flat.nVerts,
      pos: markRaw(flat.pos),
      idx: markRaw(flat.idx),
      col: markRaw(flat.col || null),
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
      return { ...edited, idx: regrouped.idx, texture: { data: source.texture.data, pages: source.texture.pages, groups: regrouped.groups } }
    }
    const why = mode === 'mesh-decimate' ? 'decimation merges triangles, so the photo texture cannot follow'
      : edited.uv ? 'the filled holes have no photo' : 'this tool does not keep it'
    log(`Mesh edit: the result has no texture (${why}); texture it again with Tools ▸ Mesh ▸ Texture`, 'warn', 'Products')
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
    const { attributes: _a, nrm: _n, ...rest } = clouds.value[idx]
    const cloud = {
      ...rest,
      createdAt: Date.now(),
      count: flat.count,
      pos: markRaw(flat.pos),
      ...(flat.attributes ? { attributes: markRaw(flat.attributes) } : {}),
      col: markRaw(flat.col || null),
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
      const result = unpackReconstructionResult(await run(packed, { gcps: survey.gcps, cameraPriors: survey.cameraPriors }))
      if (projects.currentProjectId !== projectId || mainSparseCloud.value !== original) {
        // Superseded (project switch / set-as-main mid-run): nothing changed here.
        if (reconStatus.value === 'running') reconStatus.value = statusBefore
        return null
      }
      // An edit of the model, not a recompute: provenance and the user's
      // display choices carry over (a reconstruct deliberately clears `imported`).
      upsertSparseCloud(result.cameras, result.points, { replaceId: original.id, asMain: true,
        name: original.name, imported: !!original.imported, secondary: !!original.secondary })
      const edited = mainSparseCloud.value
      if (edited && original.style !== undefined) edited.style = original.style
      if (edited && original.visible !== undefined) edited.visible = original.visible
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
      log(`${label}: ${describe(result)}; bundle adjustment ${result.costBefore.toFixed(3)} → ${result.costAfter.toFixed(3)} px`
        + (held.gcpAnchors || held.cameraPriors
          ? ` (held to ${held.gcpAnchors || 0} GCP anchor(s), ${held.cameraPriors || 0} camera prior(s))` : ' (no survey constraints)'),
        'success', 'Reconstruction')
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
    const frameModel = makeFrameModelResolver({ summary: summary.value, sensors: sensors.value })
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
    if (settings.invert) {
      log('Crop: keeping what lies outside the box is not available for a streamed cloud', 'warn', 'Products')
      return null
    }
    reconStatus.value = 'running'
    try {
      const box = { min: settings.min ?? [], max: settings.max ?? [] }
      const { cloud: flat, plan } = await extractCloudPoints(source, { box, maxPoints: STREAMED_CROP_MAX_POINTS }, onProgress)
      if (!flat.count) {
        log('Crop: no point of the cloud lies inside the box', 'warn', 'Products')
        reconStatus.value = 'done'
        return null
      }
      const cloud = addDerivedCloud(flat, { name: name || `${source.name} (cropped)`, imported: !!source.imported })
      if (source.style) cloud.style = JSON.parse(JSON.stringify(source.style))
      log(`Crop: copied ${flat.count.toLocaleString()} points of the streamed cloud into "${cloud.name}"`
        + (plan.complete ? '' : ` — thinned to ${plan.spacing.toPrecision(3)}-unit spacing to stay within `
          + `${(STREAMED_CROP_MAX_POINTS / 1e6).toFixed(0)} M points; crop a smaller box for full detail`),
      plan.complete ? 'success' : 'warn', 'Products')
      reconStatus.value = 'done'
      await save()
      return cloud
    } catch (err) {
      log(`Crop error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
      return null
    }
  }

  async function editClouds({ mode, sourceIds = [], settings = {}, name, style = null } = {}, onProgress) {
    // Model edits (Tools ▸ Model ▾): one shared commit path, refineMainSparse.
    if (mode === 'sparse') {
      return refineMainSparse({
        label: 'Gradual selection', sourceId: sourceIds[0], createdAt: settings.createdAt,
        run: (packed, survey) => workerRefineSparse(packed, { metric: settings.metric, threshold: settings.threshold }, survey),
        describe: (r) => `removed ${r.removed} points`,
      })
    }
    if (mode === 'optimize') {
      return refineMainSparse({
        label: 'Optimize cameras', sourceId: sourceIds[0], createdAt: settings.createdAt,
        // Fisheye cameras solve in recorded pixels with the run's lens, and their
        // observations are re-derived about the new K (gradualSelection.js).
        run: (packed, survey) => workerOptimizeSparse(packed,
          { refine: settings.refine, sensorOfUuid: sensorIndexByUuid(), lensOfUuid: fisheyeLensByUuid() }, survey),
        describe: (r) => `refined ${settings.refine === 'f,cxcy' ? 'focal length and principal point' : 'focal length'} (largest change ${((r.focalChange ?? 0) * 100).toFixed(2)}%)`
          + (r.removed ? `, dropped ${r.removed} points with fewer than two observations` : ''),
      })
    }
    // Which kinds each slot accepts. Mesh ▾ tools read a mesh; the reference of an
    // alignment or a distance may be a dense cloud or a mesh; everything else is
    // dense-only (a sparse cloud's points carry view-tracks — never edited here).
    const meshSource = MESH_EDIT_MODES.has(mode)
    const resolved = sourceIds.map((id) => clouds.value.find((c) => c.id === id) ?? null)
    const okKind = (c, slot) => c && c.count > 0 && !isStreamed(c) && (
      slot === 0 ? (meshSource ? c.kind === 'mesh' : c.kind === 'dense')
        : (REFERENCE_MODES.has(mode) ? (c.kind === 'dense' || c.kind === 'mesh') : c.kind === 'dense'))
    const sources = resolved.filter((c, slot) => okKind(c, slot))
    const streamed = resolved.find(isStreamed)
    if (streamed && mode === 'crop' && resolved.length === 1 && extractCloudPoints) {
      return cropStreamed(streamed, settings, name, onProgress)
    }
    if (streamed) {
      log(streamedRefusal(streamed, 'Cloud edit'), 'warn', 'Products')
      return null
    }
    if (!sources.length || sources.length !== resolved.length) {
      log(`Cloud edit: no usable ${meshSource ? 'mesh' : 'dense cloud'} for this tool`, 'warn', 'Products')
      return null
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
        const tex = c.uv && c.texture ? {
          uv: c.uv.slice(), page: facePages(c.texture.groups, c.count),
          ...(mode === 'mesh-sample' ? { texture: { data: c.texture.data, pages: c.texture.pages.map((p) => ({ ...p })) } } : {}),
        } : {}
        if (tex.uv) transfer.push(tex.uv.buffer, tex.page.buffer)
        return { id: c.id, kind: 'mesh', count: c.count, nVerts: c.nVerts, pos, col, idx, ...tex }
      }
      const attributes = Object.fromEntries(Object.entries(c.attributes || {}).map(([key, values]) => {
        const copy = values.slice()
        transfer.push(copy.buffer)
        return [key, copy]
      }))
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
      const { cloud: edited, error, extra } = await workerEditCloud(
        { mode, clouds: payload, settings },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f), transfer },
      )
      if (error) throw new Error(error)
      if (!edited?.count) {
        log('Cloud edit: the result is empty — nothing was added', 'warn', 'Products')
        reconStatus.value = 'done'
        return null
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
        log(mode === 'classify' ? `Classify: "${cloud.name}" updated`
          : `Selection edit: "${cloud.name}" now has ${cloud.count.toLocaleString()} points`, 'success', 'Products')
        // A reclassification shows its classes.
        if (mode === 'classify' && cloud.style?.field !== 'attribute:classification') cloud.style = { ...(cloud.style || {}), field: 'attribute:classification' }
      } else {
        const opts = {
          name: name || `${sources[0].name} (${mode === 'mask' ? 'edited' : mode === 'classify' ? 'classified' : mode})`,
          // Provenance follows the SOURCE (slot 0) — a reference only informs the edit.
          imported: REFERENCE_MODES.has(mode) ? !!sources[0].imported : sources.every((c) => c.imported),
        }
        cloud = edited.idx ? addDerivedMesh(carryTexture(sources[0], edited, mode), opts) : addDerivedCloud(edited, opts)
        // A tool may start its result on a colouring (distance → a diverging ramp);
        // a function sees the worker's small result record (e.g. the distance spread).
        const startStyle = mode === 'classify' ? { field: 'attribute:classification' }
          : typeof style === 'function' ? style(extra ?? null) : style
        if (startStyle) cloud.style = startStyle
        // Show the edit in place of its source; the source stays one visibility
        // toggle away for comparison or to start over.
        if (mode === 'mask' || mode === 'classify' || REPLACES_SOURCE_VIEW.has(mode)) sources[0].visible = false
        log(`Cloud edit: added "${cloud.name}" — ${cloud.kind === 'mesh'
          ? `${cloud.count.toLocaleString()} triangles` : `${cloud.count.toLocaleString()} points`}`,
        'success', 'Products')
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
    addDerivedCloud, addDerivedMesh, replaceDerivedCloud, refineMainSparse, sensorIndexByUuid,
    editClouds,
  }
}
