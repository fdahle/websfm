import { createFrameState } from './reconstruction/frameState.js'
import { createMapView } from './reconstruction/mapView.js'
import { createCloudList } from './reconstruction/cloudList.js'
import { createPersistence } from './reconstruction/persistence.js'
import { late, lateRef } from './reconstruction/late.js'
import { createFrameResolver } from './reconstruction/frames.js'
import { createSparseRun } from './reconstruction/sparseRun.js'
import { createProductRuns } from './reconstruction/productRuns.js'
import { createReflectanceRun } from './reconstruction/reflectanceRun.js'
import { createCloudEdits } from './reconstruction/cloudEdits.js'
import { createMeshTexture } from './reconstruction/meshTexture.js'
import { createCloudLod } from './reconstruction/cloudLod.js'
import { createDense } from './reconstruction/dense.js'
import { createProducts } from './reconstruction/products.js'
import { createImporters } from './reconstruction/importers.js'
import { ref, shallowRef, computed, markRaw, watch, toRaw } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { createDepthMapCache } from './reconstruction/depthMapCache.js'
import { createGeoreferencing } from './reconstruction/georeferencing.js'
import { createScaling } from './reconstruction/scaling.js'
import { registerProjectStore, projectRestoring } from './projectStores.js'
import { useImagesStore } from './useImagesStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useGcpsStore } from './useGcpsStore.js'
import { useScaleBarsStore } from './useScaleBarsStore.js'
import { makeFrameModelResolver } from '../core/sfm/displayFrame.js'
import { normalizeLeverArm } from '../core/sfm/cameraPriors.js'
import { pluralize } from '../core/textFormat.js'
import { mainOf, nextProductName, outdatedReasons, stampOf } from '../core/products/productSet.js'

// Project-scoped store: the sparse model (camera poses + 3D points) from
// incremental SfM. Reads the image list and match graph from their stores;
// restore/clear run through the project-store registry.
export const useReconstructionStore = registerProjectStore(
  defineStore('reconstruction', () => {
    const { log } = useLog()
    const projects = useProjectsStore()
    // Persist only when a project is open and OPFS is usable (see useProjectsStore).
    const isPersisting = () => projects.isPersisting
    const imagesStore = useImagesStore()
    const { images } = storeToRefs(imagesStore)
    const { matchStore } = storeToRefs(useMatchesStore())
    const { sensors } = storeToRefs(useSensorsStore())
    const posesStore = usePosesStore()
    const gcpsStore = useGcpsStore()
    const scaleBarsStore = useScaleBarsStore()

    // Point clouds produced for this project. Each is an independent layer the user
    // can select in the sidebar and view in the 3D viewer (sparse now; dense later).
    //   { id, name, kind: 'sparse'|'dense', createdAt,
    //     cameras: Map<uuid, { R, t, K }>, points: [{ x, y, z, views, color }] }
    const clouds = ref([])
    const selectedCloudId = ref(null)
    // The sparse cloud downstream stages (dense / DEM / ortho / export / the sensor
    // table) consume. Distinct from `selectedCloudId` (viewer focus): multiple sparse
    // clouds can coexist — a computed reconstruction alongside a COLMAP import — but
    // exactly one is "main". Invariant: whenever any sparse cloud exists, this points
    // at one of them (see `ensureMainSparse`). Persisted in reconstruction.json.
    const mainSparseId = ref(null)
    const reconStatus = ref('idle') // last run: 'idle' | 'running' | 'done' | 'error'

    // Per-image depth maps from the dense Stage A (Build Depth Maps), keyed by image
    // uuid. Each: { uuid, width, height, K, R, t, depth, cost, rgb, normals }.
    // shallowRef so the large typed-array planes (and the rest) stay PLAIN — a
    // reactive Proxy wrapper can't be structured-cloned to the densify worker.
    //
    // These ARE persisted (depthmaps/, see core/dense/depthMapCodec.js) — the one
    // recomputable artifact expensive enough to earn disk (minutes/image), without
    // which reopening a project forced a full Stage A re-run before densify/ortho.
    // Persistence is LAZY on the way back in: `restore` reads only the tiny index
    // into `depthMapsMeta`; `depthMapInput()` opens file handles, and workers
    // stream their planes during fusion and ortho. Saved planes are evicted.
    const {
      depthMaps,
      depthMapsMeta,
      depthMapsKey,
      depthMapCount,
      persistDepthMaps,
      beginStreamedDepthMaps,
      depthMapInput,
      loadDepthIndexIntoMeta,
      clearDepthMaps,
      forgetDepthMap,
    } = createDepthMapCache({
      isPersisting: () => isPersisting(),
      currentProjectId: () => projects.currentProjectId,
      mainSparseCloud: () => mainSparseCloud.value,
      log,
    })
    // A removed photo's depth map goes with it (useImagesStore onImageRemoved).
    imagesStore.onImageRemoved((uuid) => forgetDepthMap(uuid))

    // Georeference: a fitted SfM→CRS similarity (scale + rotation + translation),
    // or null in the local frame. { sim:{scale,R,t}, crs, rms, count, method }.
    // Small + useful across sessions, so it persists in reconstruction.json.
    const georef = ref(null)

    // Scale fit: the SfM→metres scalar fitted from known distances (scale bars),
    // or null. { scale, rms, count, method:'scalebars', sourceStamp, evidenceDigest,
    // createdAt, constraints:[…] }. It is a CACHE of a derivation, which is why it
    // carries a stamp + digest and is refused when either moves — see
    // reconstruction/scaling.js and D11. The bar *records* themselves are evidence
    // and live in useScaleBarsStore / scalebars.json, not here.
    //
    // Scale NEVER rewrites coordinates. It is applied as a property of the
    // projection frame (`frameFromScaledLocal`), because rescaling the cloud would
    // invalidate the depth-map staleness stamp and contradict every recorded
    // summary number.
    const scaleFit = ref(null)
    // The georeference's co-registration to a reference DEM (Tools ▸ Products ▸
    // Co-register DEM…, core/products/demCoregistration.js), or null: the shift and tilt
    // every georeference fit is composed with, so a refit keeps it. Kept apart from
    // `georef`, which is cleared whenever its evidence changes. Absent in older projects.
    const coregistration = ref(null)

    const {
      region,
      regionState,
      activeRegion,
      setRegion,
      clipToRegion,
      withRegion,
      orientation,
      orientationState,
      activeOrientationBasis,
      setOrientation,
      carryFrameStamps,
      clearOrientation,
      clearRegion,
    } = createFrameState({
      log,
      mainSparseCloud: lateRef(() => mainSparseCloud),
      save: late(() => save),
      validGeoref: lateRef(() => validGeoref),
    })

    // Quality summaries from the last sparse / dense run (Q3). Small, persisted in
    // reconstruction.json so successive runs can be compared across sessions.
    //   summary:      { date, nCameras, nPoints, pct3plusViewTracks, preBaP95px,
    //                   postBaMedianPx, perPairInitReproj }
    //   denseSummary: { costMedian, keptPct, cullBreakdown }
    //   depthSummary: dense Stage A — { backend, settings, medianMsPerImage, coverage,
    //                 geomFilter* } (workers/ops/dense.js). Persisted for the same reason
    //                 the other two are: a dense baseline outlives the session that ran it.
    const summary = ref(null)
    const denseSummary = ref(null)
    const depthSummary = ref(null)

    // The last few sparse-run summaries (newest last), so the Quality Report can answer
    // "did that tweak help?" across runs (WS5). Summaries only — cheap JSON, no cloud
    // diffing. Persisted in reconstruction.json; absent on legacy docs ⇒ empty.
    const summaryHistory = ref([])
    const SUMMARY_HISTORY_MAX = 5

    // Monotonic counter bumped whenever something the Quality Report overview derives
    // from changes (a georef refit, a GCP toggle). The hub caches the async GCP report
    // per open and re-runs when this moves, so pruning a bad GCP updates the overview.
    const healthDirty = ref(0)

    // Raster products (DEMs + orthophotos), oldest first — shallowRef so the planes
    // stay PLAIN. Each is persisted on its own by opfs.saveProduct. A rebuild adds a
    // new one unless its dialog's Replace option is on (core/products/productSet.js).
    //   dem:   { id, kind: 'dem', name, createdAt, basedOn, width, height, gsd, originX, originY, data, mask, zMin, zMax,
    //            crs, unit, previewBlob, previewUrl }
    //   ortho: { id, kind: 'ortho', name, createdAt, basedOn, width, height, gsd,
    //            originX, originY, frame, crs, unit, covered, stats,
    //            cog, cogSaved?, tileSize, previewBlob, previewUrl }
    //          NO pixel plane: `cog` (a Blob/File) is a tiled, overviewed RGBA GeoTIFF
    //          of any size, read a window at a time (viewer tiles, hover, clip, export).
    //          `cogSaved` = its committed OPFS file, so a re-save reuses it.
    // The preview is a PNG Blob (off the V8 heap; a 4096² preview was ~100 MB as a
    // base64 string) plus its blob: URL for the viewer and the map layer, made here
    // when a product enters the store and revoked when its record is replaced.
    const rasterProducts = shallowRef([])
    // The main product of each kind ({ dense, mesh, dem, ortho } → id): what the next
    // step uses as its input, and the DEM / ortho the map and the product tab show.
    // A missing or stale id means the newest one (mainOf). Persisted in
    // reconstruction.json; the sparse model's is mainSparseId.
    const mainProductIds = ref({})
    let productSeq = 0
    const makeProductId = (kind) => `${kind}-${Date.now().toString(36)}-${productSeq++}`
    // `store.dem = record` replaces the main DEM (or adds one when there is none), and
    // null removes it, as when there was a single DEM; it does not save. The builds go
    // through putRasterProduct; this keeps the plain assignment the browser tests use.
    const mainRaster = (kind) =>
      computed({
        get: () => mainOf(rasterProducts.value, kind, mainProductIds.value[kind]),
        set: (record) => {
          const list = rasterProducts.value
          const main = mainOf(list, kind, mainProductIds.value[kind])
          if (!record) {
            rasterProducts.value = list.filter((p) => p !== main)
            return
          }
          const next = {
            ...record,
            kind,
            id: record.id ?? main?.id ?? makeProductId(kind),
            name: record.name ?? main?.name ?? (kind === 'ortho' ? 'Orthophoto' : 'DEM'),
          }
          rasterProducts.value = main ? list.map((p) => (p === main ? next : p)) : [...list, next]
          mainProductIds.value = { ...mainProductIds.value, [kind]: next.id }
        },
      })
    const dem = mainRaster('dem')
    const ortho = mainRaster('ortho')
    // Add a built DEM/ortho as the main one of its kind, or put it in place of the
    // record `replaceId` names (keeping that one's id and name). A new one is called
    // `name`, made unique, else the kind's next free name. → the stored record.
    function putRasterProduct(record, { replaceId = null, name = null } = {}) {
      const list = rasterProducts.value
      const prev = replaceId ? list.find((p) => p.id === replaceId && p.kind === record.kind) : null
      const fallback = record.kind === 'ortho' ? 'Orthophoto' : 'DEM'
      const next = {
        ...record,
        id: prev?.id ?? makeProductId(record.kind),
        name:
          prev?.name ??
          nextProductName(
            name ?? fallback,
            list.filter((p) => p.kind === record.kind).map((p) => p.name),
          ),
      }
      rasterProducts.value = prev ? list.map((p) => (p === prev ? next : p)) : [...list, next]
      mainProductIds.value = { ...mainProductIds.value, [record.kind]: next.id }
      save()
      return next
    }
    // The model a running sparse reconstruction has built so far, { cameras, points },
    // for the live 3D view; null when none is running. Never persisted.
    const liveSparse = shallowRef(null)
    // True from the start of a sparse reconstruction to its end, before the first
    // cameras and after the last snapshot too: the progress card docks in the 3D
    // view's corner for the whole run (ProjectModals.vue), not only while a model shows.
    const sparseRunning = shallowRef(false)
    const withPreviewUrl = (p) =>
      p?.previewBlob && !p.previewUrl ? { ...p, previewUrl: URL.createObjectURL(p.previewBlob) } : p
    // A preview URL no record holds any more (replaced, removed, cleared) is revoked.
    watch(rasterProducts, (now, before) => {
      const live = new Set(now.map((p) => p.previewUrl).filter(Boolean))
      for (const p of before ?? []) if (p.previewUrl && !live.has(p.previewUrl)) URL.revokeObjectURL(p.previewUrl)
    })
    const { productLayers, mapOrder, setMapOrder, mapHidden, setMapLayerHidden, imageLayer, setImageLayer } =
      createMapView({ dem, ortho, save: late(() => save) })

    const {
      makeCloudId,
      selectedCloud,
      cameras,
      points3d,
      mainSparseCloud,
      sparseCameras,
      mainDenseCloud,
      mainMeshCloud,
      demSource,
      groundSource,
      meshSources,
      meshSource,
      meshCloud,
      orthoSurfaces,
      ensureMainSparse,
      setMainSparse,
      selectCloud,
      setCloudStyle,
      setCloudVisible,
      removeCloud,
      renameCloud,
    } = createCloudList({
      clouds,
      dem,
      log,
      mainProductIds,
      mainSparseId,
      productStatus,
      save: late(() => save),
      selectedCloudId,
    })

    const {
      supersedeRestore,
      modelLanded,
      save,
      releaseReplaceableModelForRerun,
      recoverReleasedModel,
      clear,
      clearDerived,
      restore,
    } = createPersistence({
      clearDepthMaps,
      clouds,
      coregistration,
      denseSummary,
      depthMapsMeta,
      depthSummary,
      ensureMainSparse,
      georef,
      healthDirty,
      imageLayer,
      isPersisting,
      loadDepthIndexIntoMeta,
      log,
      mainProductIds,
      mainSparseCloud,
      mainSparseId,
      makeCloudId,
      mapHidden,
      mapOrder,
      orientation,
      productLayers,
      projects,
      pruneLod: late(() => pruneLod),
      rasterProducts,
      reconStatus,
      region,
      scaleFit,
      selectedCloudId,
      summary,
      summaryHistory,
      withPreviewUrl,
    })

    // The DEM / orthophoto records (reconstruction/products.js).
    const {
      productById,
      renameProduct,
      setMainProduct: setMainRaster,
      setProductStyle,
      saveProductRecord,
      addCoregisteredDem,
      setProductVisible,
      setProductOpacity,
      removeProduct,
    } = createProducts({
      rasterProducts,
      mainProductIds,
      putRasterProduct,
      dem,
      isPersisting,
      log,
      ortho,
      save,
      productLayers,
      projects,
      withPreviewUrl,
    })

    // Right-click ▸ Set as main, for any product: a sparse model, a dense cloud or mesh
    // (what the next step uses), a DEM or orthophoto (also what the map shows).
    function setMainProduct(id) {
      const cloud = clouds.value.find((c) => c.id === id)
      if (!cloud) return setMainRaster(id)
      if (cloud.kind === 'sparse') return setMainSparse(id)
      if (mainOf(clouds.value, cloud.kind, mainProductIds.value[cloud.kind])?.id === id) return false
      mainProductIds.value = { ...mainProductIds.value, [cloud.kind]: id }
      log(`Main ${cloud.kind === 'mesh' ? 'mesh' : 'dense cloud'} → "${cloud.name}"`, 'info', 'Reconstruction', {
        channel: 'activity',
      })
      save()
      return true
    }
    const isMainProduct = (record) =>
      !!record &&
      (record.kind === 'sparse'
        ? record.id === mainSparseCloud.value?.id
        : record.kind === 'dense'
          ? record.id === mainDenseCloud.value?.id
          : record.kind === 'mesh'
            ? record.id === mainMeshCloud.value?.id
            : record.id === (record.kind === 'dem' ? dem.value : ortho.value)?.id)

    // Why each product is outdated (core/products/productSet.js): an input it was built
    // from changed since. Clouds and rasters together, so a DEM of an outdated dense
    // cloud is outdated too.
    const outdatedById = computed(() =>
      outdatedReasons([...clouds.value, ...rasterProducts.value], { mainSparseId: mainSparseCloud.value?.id ?? null }),
    )
    // → { outdated, reason } for a cloud or a raster product. A DEM/ortho is also
    // outdated when the frame it records is no longer the project's (productFrameStatus:
    // a refitted georeference or scale).
    function productStatus(record) {
      if (!record) return { outdated: false, reason: null }
      const reason = outdatedById.value.get(record.id)
      if (reason) return { outdated: true, reason }
      if (record.kind === 'dem' || record.kind === 'ortho') {
        const frame = productFrameStatus(record)
        if (frame.stale) return { outdated: true, reason: frame.reason }
      }
      return { outdated: false, reason: null }
    }

    // Insert a sparse model. Two intents via `opts`:
    //   • reconstruct (default) — replace the *main* sparse cloud in place, carrying
    //     its id/name forward, and keep it main. `replaceId` defaults to the current
    //     main so a rebuild updates the model the pipeline was consuming.
    //   • import (COLMAP) — pass `replaceId: null` to add a NEW cloud alongside any
    //     existing ones (so it can be compared), with `asMain` only when there's no
    //     main yet, and an explicit `name`.
    // A new object (not an in-place mutation) so consumers watching `selectedCloud`
    // by reference re-render after a rebuild.
    function upsertSparseCloud(cameras, points, opts = {}) {
      const {
        replaceId = mainSparseId.value,
        asMain = true,
        name,
        imported = false,
        secondary = false,
        select = true,
        // The same camera solution with more in it (adding images, extendModel.js): the
        // stamp products and the region were built against stays.
        keepStamp = false,
        // The cloud's own calibration (displayFrame.js calibrationSnapshot): the lens and
        // film frame its cameras were solved in. Kept from `prev` when not given.
        calibration,
        // The frame a reconstruction held to a reference DEM was solved in
        // (sparseRun.js heldFrameOf); the georeference places the model in it. Never
        // kept from `prev`: any other solve of the cameras must earn its own.
        heldFrame = null,
      } = opts
      const idx = replaceId ? clouds.value.findIndex((c) => c.id === replaceId && c.kind === 'sparse') : -1
      const prev = idx >= 0 ? clouds.value[idx] : null
      modelLanded()
      const cloud = {
        id: prev?.id ?? makeCloudId(),
        name: name ?? prev?.name ?? 'Sparse cloud',
        kind: 'sparse',
        createdAt: keepStamp && prev ? prev.createdAt : Date.now(),
        // Provenance, not a role: a COLMAP-imported sparse cloud still lives in the
        // Reconstruction section (it IS the model) but carries the chip. NOT
        // inherited from `prev` — a reconstruct that replaces an imported cloud
        // in place has genuinely recomputed it, so the flag must clear.
        ...(imported ? { imported: true } : {}),
        ...(secondary ? { secondary: true } : {}),
        // markRaw: keep the big point/camera data out of Vue's reactivity (see restore).
        cameras: markRaw(cameras),
        points: markRaw(points),
        ...((calibration ?? prev?.calibration) ? { calibration: markRaw(calibration ?? prev.calibration) } : {}),
        ...(heldFrame ? { heldFrame: markRaw(heldFrame) } : {}),
      }
      if (idx >= 0) clouds.value.splice(idx, 1, cloud)
      else clouds.value.push(cloud)
      if (select) selectedCloudId.value = cloud.id
      if (asMain || !mainSparseCloud.value) mainSparseId.value = cloud.id
    }

    // A sparse rebuild changes the coordinate frame and camera solution. The depth maps
    // (built from those cameras, and only ever read for the next dense step) and the
    // georeference are retired with it. The products built on the old model stay,
    // marked outdated (productStatus): a user may still want them, and they are
    // still offered as inputs, named so.
    async function invalidateSparseDependents() {
      const depthPreviewImages = images.value.filter((im) => !!im.depth)
      const hadDepth = depthMapCount.value > 0 || depthPreviewImages.length > 0
      const hadGeoref = !!georef.value
      const products =
        clouds.value.filter((c) => (c.kind === 'dense' || c.kind === 'mesh') && c.basedOn?.length).length +
        rasterProducts.value.length

      clearDepthMaps()
      georef.value = null
      scaleFit.value = null
      // Measured on the old model's DEM: the next one is co-registered again.
      coregistration.value = null
      denseSummary.value = null
      depthSummary.value = null
      // Through updateDepth so each preview's blob URL is revoked and its PNG deleted;
      // one project.json sync then clears the hasDepth flags.
      for (const im of depthPreviewImages) imagesStore.updateDepth(im.id, null, { quiet: true, persistSync: false })

      if (isPersisting()) {
        if (depthPreviewImages.length) imagesStore.save()
        await opfs.deleteDepthPlanes(projects.currentProjectId).catch(() => {})
      }
      const retired = [hadDepth && 'depth maps', hadGeoref && 'georeference'].filter(Boolean)
      if (retired.length || products) {
        log(
          'Sparse model changed' +
            (retired.length ? ` — the ${retired.join(' and ')} were retired; rebuild from the adjusted model` : '') +
            (products
              ? `. ${pluralize(products, 'product')} built on the earlier model ${products === 1 ? 'is' : 'are'} kept, marked outdated.`
              : '.'),
          'info',
          'Reconstruction',
        )
      }
    }

    // COLMAP / interop sparse models and imported clouds (reconstruction/importers.js).
    const { addMergedModel, importColmapModel, importInteropModel, importCloud } = createImporters({
      clouds,
      images,
      log,
      mainSparseCloud,
      mainSparseId,
      makeCloudId,
      save,
      selectedCloudId,
      upsertSparseCloud,
    })

    // The cloud a dense/mesh build replaces when its Replace option is on: the main
    // one of the kind, if the pipeline built it. An imported or derived (crop, filter,
    // merge, Mesh ▾ tool output) cloud is the user's own and is never replaced.
    function replaceableCloud(kind) {
      const main = mainOf(clouds.value, kind, mainProductIds.value[kind])
      return main && !main.imported && !main.derived ? main : null
    }
    // Put a built dense cloud or mesh in the list as the main one of its kind: in place
    // of the replaceable main one (keeping its id and name, so a rename survives) when
    // `replace` is set, else as a new cloud named apart ("Dense cloud 2").
    function putBuiltCloud(cloud, base, replace) {
      const prev = replace ? replaceableCloud(cloud.kind) : null
      const taken = clouds.value.filter((c) => c.kind === cloud.kind).map((c) => c.name)
      const next = { ...cloud, id: prev?.id ?? makeCloudId(), name: prev?.name ?? nextProductName(base, taken) }
      const idx = prev ? clouds.value.indexOf(prev) : -1
      if (idx >= 0) clouds.value.splice(idx, 1, next)
      else clouds.value.push(next)
      mainProductIds.value = { ...mainProductIds.value, [cloud.kind]: next.id }
      selectedCloudId.value = next.id
      return next
    }

    // What a build dialog's Output step shows (core/stepEffects/output.js): the main
    // product of the kind, whether its Replace option may replace it, and the name a
    // new one would get. → { main: name|null, replaceable, newName }
    function outputPlan(kind) {
      const fallback = { dense: 'Dense cloud', mesh: 'Mesh', dem: 'DEM', ortho: 'Orthophoto' }[kind]
      const isCloud = kind === 'dense' || kind === 'mesh'
      const list = isCloud ? clouds.value : rasterProducts.value
      const main = isCloud
        ? mainOf(clouds.value, kind, mainProductIds.value[kind])
        : kind === 'dem'
          ? dem.value
          : ortho.value
      return {
        main: main?.name ?? null,
        replaceable: isCloud ? !!replaceableCloud(kind) : !!main,
        newName: nextProductName(
          fallback,
          list.filter((r) => r.kind === kind).map((r) => r.name),
        ),
      }
    }

    // Insert a fused dense model (see putBuiltCloud). Dense clouds have no cameras of
    // their own — the viewer renders their points. Unlike sparse clouds (arrays of
    // {x,y,z,color,views} objects — they carry per-point tracks), a dense cloud is
    // stored **flat**: { count, pos:Float32Array(3N), col:Uint8Array(3N) }.
    // Millions of fused points as JS objects were ~110 B each (hundreds of MB, the
    // fusion OOM's main-thread tail); the flat buffers are ~15 B/point and feed the
    // viewer / PLY / DEM directly with no per-point object churn.
    // `replace`: Dense Cloud ▸ Replace the main dense cloud.
    function upsertDenseCloud({ count, pos, col, nrm }, { replace = false } = {}) {
      const sparse = mainSparseCloud.value
      return putBuiltCloud(
        {
          kind: 'dense',
          createdAt: Date.now(),
          // Fused from depth maps of the main sparse model.
          ...(sparse ? { basedOn: [stampOf(sparse)] } : {}),
          cameras: markRaw(new Map()),
          count,
          pos: markRaw(pos),
          col: markRaw(col),
          // World-space per-point unit normals (3N Float32), when the dense run produced
          // them (Poisson mesh input). Undefined on legacy/normal-less runs.
          ...(nrm ? { nrm: markRaw(nrm) } : {}),
        },
        'Dense cloud',
        replace,
      )
    }

    // Insert a built mesh (kind:'mesh', see putBuiltCloud). Flat like the dense cloud:
    // per-vertex pos/col + triangle idx, no per-vertex objects. count = triangles.
    // `run.replace`: Mesh ▸ Replace the main mesh.
    function upsertMeshCloud({ nVerts, count, pos, idx: triIdx, col, summary }, run = {}) {
      const source = run.sourceId ? clouds.value.find((c) => c.id === run.sourceId) : null
      return putBuiltCloud(
        {
          kind: 'mesh',
          createdAt: Date.now(),
          ...(source ? { basedOn: [stampOf(source)] } : {}),
          cameras: markRaw(new Map()),
          count,
          nVerts,
          pos: markRaw(pos),
          idx: markRaw(triIdx),
          col: markRaw(col),
          // The run record (core/products/mesh.js `summary` + what was asked and of which
          // cloud). Persisted; absent on older meshes ⇒ unknown.
          ...(summary
            ? {
                meshSummary: {
                  ...summary,
                  sourceId: run.sourceId ?? null,
                  sourceName: run.sourceName ?? null,
                  settings: run.settings ?? null,
                },
              }
            : {}),
        },
        'Mesh',
        !!run.replace,
      )
    }

    // Depth maps, fusion and meshing (reconstruction/dense.js).
    const { computeDepthMaps, depthCameraKeys, densify, generateMesh, meshDepthInputs } = createDense({
      beginStreamedDepthMaps,
      clipToRegion,
      clouds,
      denseSummary,
      depthMapInput,
      depthMaps,
      depthMapsMeta,
      depthSummary,
      images,
      imagesStore,
      isPersisting,
      loadDepthIndexIntoMeta,
      log,
      mainSparseCloud,
      meshSource,
      meshSources,
      save,
      persistDepthMaps,
      projects,
      reconStatus,
      sensors,
      summary,
      upsertDenseCloud,
      upsertMeshCloud,
      withRegion,
      activeRegion,
    })

    // Level-of-detail octrees of big clouds (reconstruction/cloudLod.js).
    const {
      buildCloudLod,
      openCloudLod,
      importStreamedCloud,
      importCopcCloud,
      extractCloudPoints,
      exportCloudLod,
      exportCloudTiles,
      editStreamedCloud,
      pruneLod,
    } = createCloudLod({
      clouds,
      log,
      save,
      projectId: () => (isPersisting() ? projects.currentProjectId : null),
      makeCloudId,
      selectedCloudId,
      projectCrs: () => projects.currentCrs ?? null,
    })

    // Crop / filter / merge / select and the other Tools-tab edits (reconstruction/cloudEdits.js).
    const { editClouds, addDerivedMesh } = createCloudEdits({
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
      upsertSparseCloud,
      sensors,
      extractCloudPoints,
      editStreamedCloud,
      // Created below with the sparse run; resolved when an edit runs.
      surveyConstraintInput: (opts) => surveyConstraintInput(opts),
      carryFrameStamps,
    })

    // ── Georeferencing + products (DEM / orthophoto) ─────────────────────────────

    // Each image's frame model (its lens, an older run's correction on top, its film
    // transform) from the MAIN sparse cloud's own calibration — the one join
    // displayFrame.js owns. GCP and marker triangulation map raw marks through it into
    // the cameras' frame. A cloud without a calibration (none after the format 4
    // migration) falls back to the project's run summary.
    const frameModelFor = computed(() => frameModelOfCloud(mainSparseCloud.value))
    // The same join for any sparse cloud (an export of the selected cloud, a re-solve).
    function frameModelOfCloud(cloud) {
      return makeFrameModelResolver({
        calibration: cloud?.calibration ? toRaw(cloud.calibration) : null,
        summary: toRaw(summary.value),
        sensors: sensors.value,
      })
    }

    const {
      imagesById,
      canGeoreferenceGcps,
      canGeoreference,
      georeferenceBlocker,
      crsSuggestion,
      georeference,
      setCoregistration,
      validGeoref,
      poseResidualReport,
      gcpAccuracyReport,
      gcpGuides,
      gcpEstimate,
    } = createGeoreferencing({
      sparseCameras,
      images,
      georef,
      coregistration,
      healthDirty,
      modelStamp: () => (mainSparseCloud.value ? [mainSparseCloud.value.id, mainSparseCloud.value.createdAt] : null),
      heldFrame: () => mainSparseCloud.value?.heldFrame ?? null,
      restoring: projectRestoring,
      poses: () => posesStore.poses,
      gcps: () => gcpsStore.gcps,
      currentCrs: () => projects.currentCrs,
      save,
      log,
      frameModel: () => frameModelFor.value,
      // The same arms the run's camera priors use (sparseRun.js).
      sceneType: () => projects.currentSceneType,
      leverArms: () => {
        const armBySensor = new Map(sensors.value.map((s) => [s.id, normalizeLeverArm(s.gnssLeverArm)]))
        const sensorOf = new Map(images.value.map((im) => [im.id, im.sensorId]))
        return (imageId) => armBySensor.get(sensorOf.get(imageId)) ?? null
      },
    })

    const { canFitScale, fitScaleBars, scaleBarReport, scaleFitStatus, markerPositions } = createScaling({
      sparseCameras,
      images,
      mainSparseCloud,
      scaleFit,
      healthDirty,
      bars: () => scaleBarsStore.bars,
      gcps: () => gcpsStore.gcps,
      save,
      log,
      frameModel: () => frameModelFor.value,
    })

    const { effectiveFrameSpec, currentFrameSignature, productFrameStatus, builtInFit, frameStampOf } =
      createFrameResolver({
        mainSparseCloud,
        validGeoref,
        currentCrs: () => projects.currentCrs,
        georeference,
        scaleFit,
        scaleFitStatus,
        log,
        orientationBasis: activeOrientationBasis,
      })

    // Mesh texture (reconstruction/meshTexture.js).
    const { textureMesh } = createMeshTexture({
      addDerivedMesh,
      clouds,
      frameModelFor,
      images,
      imagesStore,
      log,
      mainSparseCloud,
      reconStatus,
      save,
    })

    // DEM and orthophoto generation (reconstruction/productRuns.js).
    const { generateDem, generateOrtho, estimateRasterSize } = createProductRuns({
      activeRegion,
      putRasterProduct,
      dem,
      demSource,
      depthMapInput,
      effectiveFrameSpec,
      frameModelFor,
      frameStampOf,
      groundSource,
      images,
      imagesStore,
      isPersisting,
      log,
      mainSparseCloud,
      meshCloud,
      ortho,
      orthoSurfaces,
      projects,
      reconStatus,
      saveProductRecord,
      sparseCameras,
      withPreviewUrl,
      extractCloudPoints,
      validGeoref,
      clouds,
    })
    // Products ▸ Reflectance map (reconstruction/reflectanceRun.js).
    const { generateReflectanceMap } = createReflectanceRun({
      dem,
      frameModelFor,
      images,
      log,
      mainSparseCloud,
      projects,
      reconStatus,
    })

    // Anything built from the main model's cameras: what Add to the model ▸ Existing
    // cameras ▸ Auto keeps fixed (core/sfm/extendModel.js resolveExistingCameras).
    function hasSparseProducts() {
      return (
        depthMapCount.value > 0 ||
        rasterProducts.value.length > 0 ||
        clouds.value.some((c) => (c.kind === 'dense' || c.kind === 'mesh') && c.basedOn?.length)
      )
    }

    // Reconstruct and the survey constraints it shares with gradual selection
    // (reconstruction/sparseRun.js).
    const { surveyConstraintInput, reconstruct } = createSparseRun({
      SUMMARY_HISTORY_MAX,
      clouds,
      frameModelFor,
      gcpsStore,
      healthDirty,
      images,
      imagesById,
      imagesStore,
      invalidateSparseDependents,
      isPersisting,
      log,
      matchStore,
      save,
      posesStore,
      projects,
      reconStatus,
      releaseReplaceableModelForRerun,
      recoverReleasedModel,
      sensors,
      sparseCameras,
      summary,
      summaryHistory,
      supersedeRestore,
      upsertSparseCloud,
      liveSparse,
      sparseRunning,
      mainSparseCloud,
      editClouds,
      hasSparseProducts,
    })

    return {
      clouds,
      selectedCloudId,
      selectedCloud,
      mainSparseId,
      mainSparseCloud,
      setMainSparse,
      mainDenseCloud,
      mainMeshCloud,
      mainProductIds,
      setMainProduct,
      isMainProduct,
      outputPlan,
      productStatus,
      rasterProducts,
      productById,
      cameras,
      sparseCameras,
      points3d,
      reconStatus,
      liveSparse,
      sparseRunning,
      depthMaps,
      depthMapsMeta,
      depthMapsKey,
      depthCameraKeys,
      // The region a run applies right now, or null (Keep valid depth maps keys on it).
      activeRegion,
      forgetDepthMap,
      depthMapCount,
      georef,
      // The georeference while it still fits the model (the Image Table's estimated poses).
      validGeoref,
      scaleFit,
      coregistration,
      summary,
      frameModelFor,
      frameModelOfCloud,
      denseSummary,
      depthSummary,
      summaryHistory,
      healthDirty,
      dem,
      demSource,
      groundSource,
      meshSources,
      meshSource,
      ortho,
      orthoSurfaces,
      canGeoreference,
      georeferenceBlocker,
      crsSuggestion,
      canGeoreferenceGcps,
      georeference,
      setCoregistration,
      // Scale constraints (F11). `effectiveFrameSpec` is THE resolver — product
      // builders, readouts, reports and exports must all ask it rather than
      // choosing a scale independently.
      effectiveFrameSpec,
      canFitScale,
      fitScaleBars,
      scaleBarReport,
      scaleFitStatus,
      currentFrameSignature,
      productFrameStatus,
      builtInFit,
      gcpAccuracyReport,
      poseResidualReport,
      gcpGuides,
      gcpEstimate,
      generateDem,
      generateOrtho,
      generateReflectanceMap,
      estimateRasterSize,
      generateMesh,
      meshDepthInputs,
      reconstruct,
      hasSparseProducts,
      importColmapModel,
      importInteropModel,
      addMergedModel,
      importCloud,
      editClouds,
      textureMesh,
      buildCloudLod,
      openCloudLod,
      importStreamedCloud,
      importCopcCloud,
      exportCloudLod,
      exportCloudTiles,
      // Tools ▸ Model ▾ ▸ Region (core/products/region.js).
      region,
      regionState,
      setRegion,
      clearRegion,
      // Tools ▸ Model ▾ ▸ Orient model (core/products/orientation.js).
      orientation,
      orientationState,
      setOrientation,
      clearOrientation,
      computeDepthMaps,
      densify,
      restore,
      // The sparse rerun's memory release and its undo (sparseRun.js).
      releaseReplaceableModelForRerun,
      recoverReleasedModel,
      clear,
      clearDerived,
      selectCloud,
      setCloudStyle,
      setCloudVisible,
      removeCloud,
      renameCloud,
      removeProduct,
      renameProduct,
      setProductStyle,
      addCoregisteredDem,
      productLayers,
      setProductVisible,
      setProductOpacity,
      mapOrder,
      setMapOrder,
      mapHidden,
      setMapLayerHidden,
      imageLayer,
      setImageLayer,
      // Triangulated marker positions (SfM frame) for the model-frame map.
      markerPositions,
    }
  }),
)
