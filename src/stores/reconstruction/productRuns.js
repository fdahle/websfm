import { computeSourceOf } from '../../utils/image.js'
import { DEFAULT_BUDGET_BYTES } from '../../core/dense/memBudget.js'
import { stageDemPoints, DEM_STAGE_BYTES_PER_POINT } from '../../core/products/dem.js'
import { isStreamed } from '../../core/lod/streamed.js'
import { regionContains } from '../../core/products/region.js'
import { generateDem as workerGenerateDem, generateOrtho as workerGenerateOrtho } from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'

// Generating the computed rasters, split out of useReconstructionStore: the DEM
// from the densest cloud and the orthophoto over a DEM or mesh surface, each in
// the frame the settings ask for. The records themselves (rename, style, map
// layer, removal) are reconstruction/products.js.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createProductRuns({
  activeRegion, dem, demSource, depthMapInput, effectiveFrameSpec, frameModelFor, frameStampOf, groundSource,
  images, imagesStore, isPersisting, log, mainSparseCloud, meshCloud, ortho, orthoSurfaces, projects,
  reconStatus, saveProductRecord, sparseCameras, withPreviewUrl, extractCloudPoints = null,
}) {
  // Build a DEM from the densest available cloud, in the requested frame
  // (settings.crs: 'local' | 'project'). A new DEM invalidates the old ortho.
  // settings.points 'ground' builds a DTM from the ground class (LAS 2) of a
  // classified cloud instead.
  async function generateDem(settings = {}, onProgress) {
    const sparse = mainSparseCloud.value
    const groundOnly = settings.points === 'ground'
    // Single source of truth for "which cloud" — the same getter the modal shows.
    const source = groundOnly ? groundSource.value : demSource.value
    if (!source) {
      log(groundOnly ? 'DTM: classify the ground of a dense cloud first (Tools ▸ Point Cloud ▸ Classify ground)'
        : 'DEM: build a point cloud first', 'warn', 'Products')
      return
    }
    const src = source.cloud
    log(`DEM: source is the ${source.kind} cloud`
      + `${source.name ? ` "${source.name}"` : ''} (${source.count.toLocaleString()} points)`
      + (source.kind === 'sparse'
        ? ' — cells are interpolated from tie points; densify for a true surface'
        : ''),
      source.kind === 'sparse' ? 'warn' : 'info', 'Products')
    // Resolve the target frame through THE resolver — never independently. A
    // 'project' request fits/refits the georeference on demand; otherwise a valid
    // scale-bar fit still makes the local frame metric (with no CRS).
    const resolved = await effectiveFrameSpec({ crs: settings.crs })
    const frameSpec = resolved.frameSpec
    if (settings.crs && settings.crs !== 'local' && resolved.source !== 'georef') {
      log('DEM: no georeference available — using the local frame'
        + (resolved.unit === 'm' ? ', scaled to metres by the scale bars' : ''), 'warn', 'Products')
    }
    reconStatus.value = 'running'
    try {
      // Plain copy: cloud state is reactive (Vue proxies can't be cloned), and the
      // worker takes it by transfer. Only in-region points are copied, and the copy
      // is checked against the machine's memory budget (Settings ▸ Compute).
      const budgetBytes = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
      const r = src.imported ? null : activeRegion()
      const streamed = isStreamed(src)
      // A resident cloud whose full copy would be large reads its octree too, when it has
      // one: the grid needs no finer level than half its cell, and a 95 M-point copy
      // (2.3 GB) failed to allocate next to the cloud itself (quarry, 2026-10-17).
      const octreeHasClasses = src.lod?.layout?.attributes?.some((a) => a.name === 'classification')
      const fromOctree = streamed || (!!src.lod && !!extractCloudPoints && src.kind === 'dense'
        && src.count * DEM_STAGE_BYTES_PER_POINT > Math.min(budgetBytes / 4, 2 ** 30)
        && (!groundOnly || octreeHasClasses))
      const cls = groundOnly && !fromOctree ? src.attributes.classification : null
      const inRegion = r ? (x, y, z) => regionContains(r, x, y, z) : null
      const inside = cls
        ? (x, y, z, i) => cls[i] === 2 && (!inRegion || inRegion(x, y, z))
        : inRegion
      let staged
      if (fromOctree) {
        // From the octree (core/lod): down to half the cell size when one is set (finer
        // levels add nothing to a cell), within half the budget (the grid gets the
        // rest), the ground class for a DTM, the region as the read box.
        const maxPoints = Math.floor(budgetBytes / 2 / DEM_STAGE_BYTES_PER_POINT)
        const { cloud: flat, plan } = await extractCloudPoints(src, {
          classes: groundOnly ? [2] : null, fields: 'xyz', maxPoints, minSpacing: settings.gsd > 0 ? settings.gsd / 2 : 0,
          ...(r ? { box: { min: [...r.min], max: [...r.max] } } : {}),
        }, (d, t, lbl, f) => onProgress?.(d, t, 'Reading the octree', f))
        staged = { pos: flat.pos, count: flat.count, total: src.count }
        log(`${groundOnly ? 'DTM' : 'DEM'}: read ${flat.count.toLocaleString()} ${groundOnly ? 'ground ' : ''}points `
          + `of ${streamed ? 'the streamed cloud' : `the cloud's octree (${src.count.toLocaleString()} points)`} `
          + (plan.complete ? '(every level of its octree)' : `down to ${plan.spacing.toPrecision(3)}-unit spacing`), 'info', 'Products')
        if (!flat.count) throw new Error(groundOnly ? 'the cloud has no ground points' : (r ? 'no point of the source lies inside the region' : 'the cloud has no points'))
      } else staged = stageDemPoints(src.kind === 'dense' ? src : { count: src.points.length, pos: src.points.pos }, { budgetBytes, inside })
      if (cls) log(`DTM: ${staged.count.toLocaleString()} ground points of ${staged.total.toLocaleString()}`, 'info', 'Products')
      else if (r && !fromOctree) log(`DEM: region keeps ${staged.count.toLocaleString()} of ${staged.total.toLocaleString()} points`, 'info', 'Products')
      if (cls && !staged.count) throw new Error(r ? 'no ground point lies inside the region' : 'the cloud has no ground points')
      if (r && !staged.count) throw new Error('no point of the source lies inside the region')
      const points = { pos: staged.pos, count: staged.count }
      const cameras = [...(sparse?.cameras ?? new Map()).entries()].map(([uuid, cam]) => ({
        uuid, R: cam.R.map((r) => [...r]), t: [...cam.t], K: { ...cam.K },
      }))
      const grid = await workerGenerateDem(
        { points, cameras, frame: frameSpec, settings: { ...settings, memBudgetBytes: budgetBytes, style: dem.value?.style ?? null } },
        { transfer: [points.pos.buffer], onLog: (m, l, c) => log(m, l, c), onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
      )
      dem.value = withPreviewUrl({
        ...grid, createdAt: Date.now(), points: groundOnly ? 'ground' : 'all',
        name: dem.value?.name || 'DEM',
        frameStamp: frameStampOf(resolved),
        // Heights are in the georeference's vertical datum (georeferencing.js).
        ...(resolved.source === 'georef' ? { verticalDatum: resolved.verticalDatum } : {}),
      })
      // A new DEM invalidates an ortho BUILT ON IT — but not one built over the
      // mesh/plane surface, which this run didn't touch. (An ortho with no
      // recorded surface predates the choice, so it was a DEM ortho.)
      const orthoWasDem = ortho.value && (ortho.value.surface ?? 'DEM') === 'DEM'
      if (orthoWasDem) ortho.value = null
      saveProductRecord('dem', dem.value)
      if (isPersisting() && orthoWasDem) opfs.deleteProduct(projects.currentProjectId, 'ortho').catch(() => {})
      reconStatus.value = 'done'
    } catch (err) {
      log(`DEM error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  // Build the surface payload for an ortho run: the height source the worker will
  // turn into a grid. `settings.surface` is one of orthoSurfaces' ids. Returns null
  // (after logging why) when the chosen surface isn't available.
  //
  // A mesh/plane surface needs a frame of its own — a DEM carries the one it was
  // built in, but there may be no DEM at all now. It's resolved exactly as
  // generateDem does, so the two products stay co-registered.
  async function orthoSurfacePayload(settings, resolved) {
    const id = settings.surface ?? 'dem'
    const opt = orthoSurfaces.value.find((s) => s.id === id)
    if (!opt) { log(`Ortho: unknown surface "${id}"`, 'warn', 'Products'); return null }
    if (!opt.available) { log(`Ortho: ${opt.hint}`, 'warn', 'Products'); return null }

    if (id === 'dem') {
      const d = dem.value
      log('Ortho: surface is the DEM — cells the DEM has no height for stay transparent',
        'info', 'Products')
      return {
        kind: 'dem',
        grid: {
          width: d.width, height: d.height, gsd: d.gsd, originX: d.originX, originY: d.originY,
          data: d.data, mask: d.mask, frame: d.frame,
        },
      }
    }

    let frameSpec = resolved.source === 'georef' ? resolved.frameSpec : null
    if (settings.crs && settings.crs !== 'local' && !frameSpec) {
      log('Ortho: no georeference available — using the local frame', 'warn', 'Products')
    }
    // Local frame: reuse the DEM's when it was built locally, so a mesh ortho lands
    // on the same grid origin as the DEM instead of a near-identical one of its own.
    // A bare { kind:'local' } / { kind:'scaled-local' } spec is only a REQUEST —
    // buildLocalFrame derives the up-vector from the scene, so cameras + points must
    // travel with it. A reused DEM descriptor is only valid at the SAME scale: a
    // refit since then means its metres are not these metres.
    if (!frameSpec) {
      const reusable = dem.value?.frame
      const sameKind = reusable?.kind === resolved.frameSpec.kind
      const sameScale = resolved.frameSpec.kind !== 'scaled-local'
        || Math.abs((reusable?.scale ?? 0) - resolved.frameSpec.scale) < 1e-12
      frameSpec = sameKind && sameScale ? reusable : resolved.frameSpec
    }
    const surfSettings = { gsd: settings.surfaceGsd > 0 ? settings.surfaceGsd : 0, extent: settings.extent ?? 'core' }

    // Point sample from the densest cloud: the plane's fit input, and the local
    // frame's origin/PCA fallback. Subsampled — a plane needs spread, not every
    // point, and 25 M boxed {x,y,z} in the worker is the OOM we avoid everywhere.
    // A streamed cloud has no positions in memory (pos: null): its sample is read
    // from the octree's coarse levels instead.
    const src = demSource.value
    const cloud = src?.cloud ?? null
    const total = src?.count ?? 0
    const MAX_FIT = 200_000
    const strided = (srcPos, count) => {
      const stride = Math.max(1, Math.ceil(count / MAX_FIT))
      const m = count ? Math.ceil(count / stride) : 0
      const out = new Float64Array(m * 3)
      for (let i = 0, k = 0; i < count; i += stride, k++) {
        out[k * 3] = srcPos[i * 3]; out[k * 3 + 1] = srcPos[i * 3 + 1]; out[k * 3 + 2] = srcPos[i * 3 + 2]
      }
      return { pos: out, n: m }
    }
    let pos = new Float64Array(0), n = 0
    if (cloud && isStreamed(cloud)) {
      if (!extractCloudPoints) {
        log('Ortho: the point cloud is streamed from its octree and cannot be sampled here', 'warn', 'Products')
        return null
      }
      try {
        const { cloud: flat } = await extractCloudPoints(cloud, { fields: 'xyz', maxPoints: MAX_FIT })
        ;({ pos, n } = strided(flat.pos, flat.count))
      } catch (err) {
        log(`Ortho: reading a sample of the streamed cloud failed — ${err?.message ?? err}`, 'error', 'Products')
        return null
      }
    } else if (cloud) {
      const srcPos = cloud.kind === 'dense' ? cloud.pos : cloud.points?.pos
      if (srcPos) ({ pos, n } = strided(srcPos, total))
    }
    // A mesh surface with no cloud to sample: its own vertices place the frame.
    if (!n && id === 'mesh' && meshCloud.value?.pos) {
      const m = meshCloud.value
      ;({ pos, n } = strided(m.pos, m.nVerts ?? Math.floor(m.pos.length / 3)))
    }
    if (id !== 'mesh' && n < 3) {
      log('Ortho: a plane surface needs a point cloud to fit — build or import one first', 'warn', 'Products')
      return null
    }
    const cameras = [...sparseCameras.value.entries()].map(([uuid, cam]) => ({
      uuid, R: cam.R.map((r) => [...r]), t: [...cam.t], K: { ...cam.K },
    }))

    if (id === 'mesh') {
      const m = meshCloud.value
      log(`Ortho: surface is the mesh "${m.name ?? 'mesh'}" `
        + `(${m.count.toLocaleString()} triangles)`, 'info', 'Products')
      return {
        kind: 'mesh', frame: frameSpec, cameras, framePoints: pos, framePointCount: n,
        pos: m.pos, idx: m.idx, settings: surfSettings,
      }
    }

    log(`Ortho: surface is a plane fitted to the ${src.kind} cloud `
      + `(${n.toLocaleString()} of ${total.toLocaleString()} points${isStreamed(cloud) ? ', from its octree' : ''})`, 'info', 'Products')
    // The plane's fit points double as the local frame's — one sample, one array.
    return {
      kind: 'plane', frame: frameSpec, cameras, framePoints: pos, framePointCount: n,
      pos, count: n, settings: surfSettings,
    }
  }

  // Orthorectify a surface using the cached depth maps (occlusion via their depth
  // planes, colour from their RGB planes). Needs depth maps and a surface — which
  // is a DEM only when the user picks one (see orthoSurfaces).
  async function generateOrtho(settings = {}, onProgress) {
    const projectId = projects.currentProjectId, sparse = mainSparseCloud.value
    const stillCurrent = () => projectId === projects.currentProjectId && sparse === mainSparseCloud.value
    let input
    try { input = await depthMapInput() }
    catch (err) { log(`Ortho: ${err.message}`, 'error', 'Products'); return }
    const { maps, streamed } = input
    if (!maps.length) { log('Ortho: compute depth maps first', 'warn', 'Products'); return }
    const resolved = await effectiveFrameSpec({ crs: settings.crs })
    const surface = await orthoSurfacePayload(settings, resolved)
    if (!surface) return
    reconStatus.value = 'running'
    try {
      const mapsPayload = streamed ? maps : maps.map((m) => ({
        uuid: m.uuid, width: m.width, height: m.height, K: m.K, R: m.R, t: m.t,
        depth: m.depth, cost: m.cost, rgb: m.rgb,
      }))
      // The source photo per map, for full-resolution colour (the depth maps then only
      // decide visibility): the same image + frame-model join dense used to build them.
      const imgByUuid = new Map(images.value.map((im) => [im.uuid, im]))
      const frameModel = frameModelFor.value
      const photos = []
      for (const m of maps) {
        const im = imgByUuid.get(m.uuid), cam = sparse?.cameras?.get(m.uuid)
        if (!im || !cam) continue
        try { await imagesStore.whenComputeReady(im) } catch { continue } // falls back to map colour
        const { dist, selfCal, fiducial } = frameModel(im)
        photos.push({ uuid: m.uuid, name: im.name, url: computeSourceOf(im),
          K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy }, dist, selfCal, fiducial })
      }
      // The machine's memory gate (Settings ▸ Compute): the worker sizes its map/photo
      // cache from it and refuses, with the figures, a run whose working set exceeds it.
      const memBudgetBytes = settings.memBudgetBytes > 0 ? settings.memBudgetBytes : DEFAULT_BUDGET_BYTES
      const res = await workerGenerateOrtho(
        { surface, maps: mapsPayload, streamed, settings: { ...settings, memBudgetBytes }, images: photos },
        { onLog: (m, l, c) => log(m, l, c), onProgress: (dn, t, lbl, f) => onProgress?.(dn, t, lbl, f) },
      )
      if (!stillCurrent()) return
      // An ortho built ON the DEM inherits the DEM's recorded frame — its cells are
      // that grid's cells, so claiming today's frame would be a claim about a raster
      // this run never re-projected.
      ortho.value = withPreviewUrl({
        ...res, createdAt: Date.now(),
        name: ortho.value?.name || 'Orthophoto',
        // Symbology survives a rebuild, like the name (display only).
        ...(ortho.value?.style && { style: ortho.value.style }),
        frameStamp: (settings.surface ?? 'dem') === 'dem'
          ? (dem.value?.frameStamp ?? frameStampOf(resolved))
          : frameStampOf(resolved),
      })
      saveProductRecord('ortho', ortho.value)
      reconStatus.value = 'done'
    } catch (err) {
      if (!stillCurrent()) return
      log(`Ortho error: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
    }
  }

  return {
    generateDem, orthoSurfacePayload, generateOrtho,
  }
}
