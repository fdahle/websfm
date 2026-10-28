import { isStreamed } from '../core/lod/streamed.js'
import { createFrameResolver } from './reconstruction/frames.js'
import { createSparseRun } from './reconstruction/sparseRun.js'
import { createProductRuns } from './reconstruction/productRuns.js'
import { createCloudEdits } from './reconstruction/cloudEdits.js'
import { createMeshTexture } from './reconstruction/meshTexture.js'
import { createCloudLod } from './reconstruction/cloudLod.js'
import { createDense } from './reconstruction/dense.js'
import { createProducts } from './reconstruction/products.js'
import { createImporters } from './reconstruction/importers.js'
import { ref, shallowRef, computed, markRaw, nextTick, watch, toRaw } from 'vue'
import { defineStore, storeToRefs } from 'pinia'
import { useLog } from '../composables/useLog.js'
import * as opfs from '../utils/opfs.js'
import { yieldToPaint } from '../utils/concurrency.js'
import { normalizeRegion, regionStatus, regionMask } from '../core/products/region.js'
import { normalizeProductLayers, productMapBlocker } from '../core/products/productLayers.js'
import { normalizeMapOrder } from '../core/products/mapOrder.js'
import { IMAGE_LAYER_ID, normalizeImageLayer } from '../core/products/imageOverlay.js'
import { selectPoints } from '../core/products/cloudEdit.js'
import { normalizeOrientation, orientationStatus, orientationBasis } from '../core/products/orientation.js'
import { formatBytes } from '../core/dense/memBudget.js'
import { depthMapBytes } from '../core/dense/depthMapCodec.js'
import { serializeCloud, deserializeCloud } from './reconstruction/cloudSerde.js'
import { SparsePoints } from '../core/sfm/sparsePoints.js'
import { createSavedCloudFiles } from './reconstruction/savedCloudFiles.js'
import { createDepthMapCache } from './reconstruction/depthMapCache.js'
import { createGeoreferencing } from './reconstruction/georeferencing.js'
import { createScaling } from './reconstruction/scaling.js'
import { registerProjectStore } from './projectStores.js'
import { showToast } from '../composables/useToasts.js'
import { useImagesStore } from './useImagesStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import { useProjectsStore } from './useProjectsStore.js'
import { useSensorsStore } from './useSensorsStore.js'
import { usePosesStore } from './usePosesStore.js'
import { useGcpsStore } from './useGcpsStore.js'
import { useScaleBarsStore } from './useScaleBarsStore.js'
import { makeFrameModelResolver } from '../core/sfm/displayFrame.js'
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
    // Bumped by anything that makes an in-flight restore stale (a new restore,
    // clear, a reconstruct that will replace the model it is reading).
    let restoreGeneration = 0
    const supersedeRestore = () => {
      restoreGeneration++
    }

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

    // The reconstruction REGION (Tools ▸ Model ▾ ▸ Region, core/products/region.js):
    // a model-frame box that bounds depth maps, fusion, mesh and DEM input. Stamped
    // with the main sparse model; a stale region is ignored, never reinterpreted.
    // Persisted in reconstruction.json; absent ⇒ none. Not cleared by a rebuild —
    // the stamp makes it stale, so the user can see it and refit it.
    const region = ref(null)
    const regionState = computed(() => regionStatus(region.value, mainSparseCloud.value))
    // The box to apply to a run right now, or null (none / stale / invalid).
    function activeRegion() {
      return regionState.value.active ? normalizeRegion(region.value) : null
    }
    function setRegion({ min, max }) {
      const c = mainSparseCloud.value
      const next = normalizeRegion({ min, max, sourceStamp: c ? { id: c.id, createdAt: c.createdAt ?? null } : null })
      if (!next || !c) return false
      region.value = next
      const f = (v) => v.map((x) => x.toPrecision(5)).join(', ')
      log(`Region set: [${f(next.min)}] – [${f(next.max)}]`, 'info', 'Reconstruction', { channel: 'activity' })
      save()
      return true
    }
    // A copy of a flat cloud ({ count, pos, col?, nrm? }) cut to the active region,
    // or null when no region applies — the region is model-frame data, so an
    // imported cloud (its own frame) is never cut. Logs what it removed.
    function clipToRegion(cloud, label) {
      const r = activeRegion()
      if (!r || cloud.imported) return null
      const { keep, kept } = regionMask(cloud.pos, cloud.count, r)
      log(
        `${label}: region keeps ${kept.toLocaleString()} of ${cloud.count.toLocaleString()} points`,
        'info',
        'Products',
      )
      return selectPoints(cloud, keep, kept)
    }
    // Settings for a dense run with the active region attached (null ⇒ unbounded).
    function withRegion(settings) {
      const r = activeRegion()
      if (r) log('Dense: limited to the region', 'info', 'Dense')
      else if (regionState.value.reason === 'stale')
        log('Dense: the region was drawn on an older model and is ignored — refit it to use it', 'warn', 'Dense')
      return { ...settings, region: r ? { min: r.min, max: r.max } : null }
    }
    // The user ORIENTATION of the local frame (Tools ▸ Model ▾ ▸ Orient model,
    // core/products/orientation.js). Like scale, it lives in the frame, never in the
    // coordinates; the frame resolver applies it to local/scale-bar products, and a
    // georeference outranks it. Same stamp rule as the region.
    const orientation = ref(null)
    const orientationState = computed(() => orientationStatus(orientation.value, mainSparseCloud.value))
    function activeOrientationBasis() {
      return orientationState.value.active ? orientationBasis(orientation.value) : null
    }
    function setOrientation({ up, origin, headingDeg = 0 }) {
      const c = mainSparseCloud.value
      const next = normalizeOrientation({
        up,
        origin,
        headingDeg,
        sourceStamp: c ? { id: c.id, createdAt: c.createdAt ?? null } : null,
      })
      if (!next || !c) return false
      orientation.value = next
      const f = (v) => v.map((x) => x.toPrecision(4)).join(', ')
      log(
        `Orientation set: up [${f(next.up)}], origin [${f(next.origin)}], heading ${next.headingDeg}°` +
          (validGeoref.value ? ' — the georeference outranks it for georeferenced products' : ''),
        'info',
        'Reconstruction',
        { channel: 'activity' },
      )
      save()
      return true
    }
    // An edit of the model (Optimize cameras, Gradual selection) keeps its frame: the
    // region and orientation drawn on it carry over to the edited model, rather than
    // going stale as they do on a rebuild. → the names of what carried over
    function carryFrameStamps(before, after) {
      const was = (s) => s && s.id === before.id && (s.createdAt ?? null) === (before.createdAt ?? null)
      const now = { id: after.id, createdAt: after.createdAt ?? null }
      const carried = []
      if (was(region.value?.sourceStamp)) {
        region.value = { ...region.value, sourceStamp: now }
        carried.push('region')
      }
      if (was(orientation.value?.sourceStamp)) {
        orientation.value = { ...orientation.value, sourceStamp: now }
        carried.push('orientation')
      }
      return carried
    }
    function clearOrientation() {
      if (!orientation.value) return
      orientation.value = null
      log('Orientation removed — the local frame is levelled from the cameras again', 'info', 'Reconstruction', {
        channel: 'activity',
      })
      save()
    }
    function clearRegion() {
      if (!region.value) return
      region.value = null
      log('Region cleared', 'info', 'Reconstruction', { channel: 'activity' })
      save()
    }

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
    const dem = computed(() => mainOf(rasterProducts.value, 'dem', mainProductIds.value.dem))
    const ortho = computed(() => mainOf(rasterProducts.value, 'ortho', mainProductIds.value.ortho))
    let productSeq = 0
    const makeProductId = (kind) => `${kind}-${Date.now().toString(36)}-${productSeq++}`
    // Add a built DEM/ortho as the main one of its kind, or put it in place of the
    // record `replaceId` names (keeping that one's id and name). → the stored record.
    function putRasterProduct(record, { replaceId = null } = {}) {
      const list = rasterProducts.value
      const prev = replaceId ? list.find((p) => p.id === replaceId && p.kind === record.kind) : null
      const fallback = record.kind === 'ortho' ? 'Orthophoto' : 'DEM'
      const next = {
        ...record,
        id: prev?.id ?? makeProductId(record.kind),
        name:
          prev?.name ??
          nextProductName(
            fallback,
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
    const withPreviewUrl = (p) =>
      p?.previewBlob && !p.previewUrl ? { ...p, previewUrl: URL.createObjectURL(p.previewBlob) } : p
    // A preview URL no record holds any more (replaced, removed, cleared) is revoked.
    watch(rasterProducts, (now, before) => {
      const live = new Set(now.map((p) => p.previewUrl).filter(Boolean))
      for (const p of before ?? []) if (p.previewUrl && !live.has(p.previewUrl)) URL.revokeObjectURL(p.previewUrl)
    })
    // Map-layer view state per computed product ({ dem: { visible, opacity }, … };
    // core/products/productLayers.js). Kept in reconstruction.json, NOT on the
    // product record: saving a product rewrites its raster buffers, and a map
    // toggle must not. It survives a rebuild, so a DEM on the map stays there.
    const productLayers = ref({})
    // A product built for the first time goes on the map (into View ▸ Map ▸ Layers),
    // as a new layer does in a GIS. One taken off the map has an entry, and stays off.
    for (const [kind, product] of [
      ['dem', dem],
      ['ortho', ortho],
    ]) {
      watch(product, (now) => {
        if (!now || productLayers.value[kind] || productMapBlocker(now)) return
        productLayers.value = { ...productLayers.value, [kind]: { visible: true, opacity: 1 } }
      })
    }
    // The 2D map's layer stack, top first (core/products/mapOrder.js): the ids of
    // reference rasters, `product:dem` / `product:ortho` and `vector:<set id>`. Empty =
    // the default.
    const mapOrder = ref([])
    function setMapOrder(ids) {
      mapOrder.value = normalizeMapOrder(ids)
      save()
    }
    // The ids of layers on the map that are unticked in View ▸ Map ▸ Layers: still
    // listed there, not drawn. Being on the map at all is the layer's own `visible`
    // (a raster record, productLayers, a vector set), which the sidebar sets.
    const mapHidden = ref([])
    function setMapLayerHidden(id, hidden) {
      const rest = mapHidden.value.filter((x) => x !== id)
      const next = hidden ? [...rest, id] : rest
      if (next.length === mapHidden.value.length) return
      mapHidden.value = next
      save()
    }
    // The Photos layer (View ▸ Map ▸ Photos, core/products/imageOverlay.js):
    // { visible, opacity, mode: 'selected' | 'all' }, null until first put on the map.
    const imageLayer = ref(null)
    function setImageLayer(patch) {
      const next = normalizeImageLayer({ visible: false, opacity: 1, mode: 'selected', ...imageLayer.value, ...patch })
      // Put back on the map, it is listed ticked, as any layer added from the sidebar.
      if (next.visible && !imageLayer.value?.visible) setMapLayerHidden(IMAGE_LAYER_ID, false)
      imageLayer.value = next
      save()
    }

    let cloudSeq = 0
    const makeCloudId = () => `cloud-${Date.now()}-${cloudSeq++}`

    // The cloud currently shown in the 3D viewer.
    const selectedCloud = computed(() => clouds.value.find((c) => c.id === selectedCloudId.value) || null)

    // Camera poses / 3D points of the selected cloud. Kept as derived refs so the
    // image & sensor tables (which read estimated extrinsics/intrinsics) and the
    // viewer keep working off "the active model" without knowing about the list.
    const cameras = computed(() => selectedCloud.value?.cameras ?? new Map())
    const points3d = computed(() => selectedCloud.value?.points ?? [])

    // Cameras of the sparse model specifically — only the sparse cloud carries
    // bundle-adjusted poses/intrinsics. The sensor table reads estimated values
    // from these, so it must not follow the viewer's selection (selecting the
    // dense cloud, whose camera Map is empty, would otherwise blank the table).
    // The main sparse cloud — what downstream stages consume. Falls back to the first
    // sparse cloud when `mainSparseId` is stale/unset (legacy projects, post-delete).
    const mainSparseCloud = computed(
      () =>
        clouds.value.find((c) => c.id === mainSparseId.value && c.kind === 'sparse') ??
        clouds.value.find((c) => c.kind === 'sparse') ??
        null,
    )

    const sparseCameras = computed(() => mainSparseCloud.value?.cameras ?? new Map())

    // The main dense cloud and mesh (mainProductIds): the inputs the next step uses.
    const mainDenseCloud = computed(() => mainOf(clouds.value, 'dense', mainProductIds.value.dense))
    const mainMeshCloud = computed(() => mainOf(clouds.value, 'mesh', mainProductIds.value.mesh))

    // The cloud a DEM run would rasterise: the densest one available. Exposed as a
    // getter (rather than re-derived in DemModal) so the modal's "Source:" line and
    // generateDem() below can never disagree about what is about to be built —
    // generateDem consumes this, it does not repeat the pick.
    // A sparse source is allowed on purpose (it's the only DEM available for an
    // imported COLMAP model, and the fastest orientation/scale sanity check before
    // committing to dense) — the modal warns, it does not gate.
    const demSource = computed(() => {
      // The main dense cloud; else a resident one, else a streamed one
      // (core/lod/streamed.js), which generateDem reads from its octree at the spacing
      // the grid needs.
      const usable = (c) => c?.kind === 'dense' && c.count > 0 && (c.pos || isStreamed(c))
      const main = mainDenseCloud.value
      const dense = usable(main)
        ? main
        : (clouds.value.find((c) => c.kind === 'dense' && c.pos) ?? clouds.value.find((c) => isStreamed(c)))
      if (dense?.count) return { cloud: dense, kind: 'dense', count: dense.count, name: dense.name ?? null }
      const sparse = mainSparseCloud.value
      const n = sparse?.points?.length ?? 0
      if (!n) return null
      return { cloud: sparse, kind: 'sparse', count: n, name: sparse.name ?? null }
    })

    // The cloud Build DEM ▸ Points ▸ Ground only rasterises: a dense cloud carrying a
    // per-point LAS `classification` (Classify ground, or an imported classified LAS).
    // Same contract as demSource — DemModal renders it, generateDem consumes it. The
    // viewer-selected one wins, then the newest: a classified cloud is a derived copy
    // made for exactly this.
    const groundSource = computed(() => {
      const list = clouds.value.filter(
        (c) =>
          c.kind === 'dense' &&
          c.count > 0 &&
          (c.attributes?.classification?.length === c.count || (isStreamed(c) && (c.lod.stats?.classes?.[2] ?? 0) > 0)),
      )
      if (!list.length) return null
      const pick =
        list.find((c) => c.id === mainDenseCloud.value?.id) ??
        list.find((c) => c.id === selectedCloudId.value) ??
        list[list.length - 1]
      return { cloud: pick, kind: 'dense', count: pick.count, name: pick.name ?? null }
    })

    // The dense clouds Build Mesh can use (any dense cloud with per-point normals —
    // computed, edited or imported) and the one it uses by default. Same contract as
    // demSource: MeshModal RENDERS this and generateMesh() CONSUMES it, so the modal's
    // "Source:" line and the run can't disagree. The default prefers the viewer-selected
    // dense cloud, then the newest edited (`derived`) one — a cleaned cloud is what the
    // user made it for — then the first. Picking the first dense cloud unconditionally
    // (as before) meshed the original fusion output and silently ignored every edit.
    const meshSources = computed(() =>
      clouds.value
        .filter((c) => c.kind === 'dense' && c.count > 0 && c.nrm && c.nrm.length >= c.count * 3)
        .map((c) => ({
          id: c.id,
          name: c.name ?? 'Dense',
          count: c.count,
          derived: !!c.derived,
          imported: !!c.imported,
        })),
    )
    const meshSource = computed(() => {
      const list = meshSources.value
      if (!list.length) return null
      // The main dense cloud first: it is the one the user set.
      const main = list.find((s) => s.id === mainDenseCloud.value?.id)
      if (main) return main
      const selected = list.find((s) => s.id === selectedCloudId.value)
      if (selected) return selected
      const derived = list.filter((s) => s.derived)
      return derived.length ? derived[derived.length - 1] : list[0]
    })

    // The mesh a mesh-surface ortho would rasterise: the main one, else the first
    // non-empty one.
    const meshCloud = computed(() =>
      mainMeshCloud.value?.count > 0
        ? mainMeshCloud.value
        : (clouds.value.find((c) => c.kind === 'mesh' && c.count > 0) ?? null),
    )

    // Which surfaces an ortho run could use for its height-per-cell. Same contract
    // as demSource: the modal RENDERS this list and generateOrtho() CONSUMES it, so
    // the two can't disagree about what is available or what is about to be built.
    // An ortho is not a DEM product — it just needs a surface (Metashape's Build
    // Orthomosaic ▸ Surface: DEM / Mesh / planar), and the DEM is the holey one.
    const orthoSurfaces = computed(() => {
      const src = demSource.value
      return [
        {
          id: 'dem',
          label: 'DEM',
          available: !!dem.value,
          detail: dem.value
            ? `"${dem.value.name}" · ${dem.value.width}×${dem.value.height} · ${dem.value.crs === 'local' || !dem.value.crs ? 'local frame' : dem.value.crs}` +
              (productStatus(dem.value).outdated ? ' · outdated' : '')
            : null,
          hint: dem.value
            ? 'Uses the main DEM and its frame. Cells the DEM has no height for stay transparent.'
            : 'Build a DEM first.',
        },
        {
          id: 'mesh',
          label: 'Mesh',
          available: !!meshCloud.value,
          detail: meshCloud.value
            ? `"${meshCloud.value.name}" · ${meshCloud.value.count.toLocaleString()} triangles` +
              (productStatus(meshCloud.value).outdated ? ' · outdated' : '')
            : null,
          hint: meshCloud.value
            ? 'Rasterises the mesh from above. Watertight, so there are no surface holes — the fix for a patchy ortho.'
            : 'Build a mesh first (Products ▸ Mesh).',
        },
        {
          id: 'plane',
          label: 'Plane',
          available: !!src,
          detail: src ? `fitted to the ${src.kind} cloud` : null,
          hint: src
            ? 'Least-squares plane through the cloud. Fully dense, but only correct where the ground really is flat.'
            : 'Build a point cloud first.',
        },
      ]
    })

    // Re-establish the "one sparse cloud is always main" invariant after any change
    // to the cloud list (delete, restore). If the current main is gone but sparse
    // clouds remain, promote the first; if none remain, clear it.
    function ensureMainSparse() {
      const stillMain = clouds.value.some((c) => c.id === mainSparseId.value && c.kind === 'sparse')
      if (stillMain) return
      mainSparseId.value = clouds.value.find((c) => c.kind === 'sparse')?.id ?? null
    }

    // Promote a sparse cloud to main (right-click "Set as main" in the sidebar).
    function setMainSparse(id) {
      const cloud = clouds.value.find((c) => c.id === id && c.kind === 'sparse')
      if (!cloud || mainSparseId.value === id) return
      mainSparseId.value = id
      log(`Main sparse cloud → "${cloud.name}"`, 'info', 'Reconstruction', { channel: 'activity' })
      save()
    }

    function selectCloud(id) {
      selectedCloudId.value = id
    }

    function setCloudStyle(id, style) {
      const cloud = clouds.value.find((c) => c.id === id)
      if (!cloud) return
      cloud.style = JSON.parse(JSON.stringify(style))
      save()
    }

    function setCloudVisible(id, visible) {
      const cloud = clouds.value.find((c) => c.id === id)
      if (!cloud) return
      cloud.visible = !!visible
      save()
    }

    function removeCloud(id) {
      const removed = clouds.value.find((c) => c.id === id)
      if (!removed) return false
      clouds.value = clouds.value.filter((c) => c.id !== id)
      if (selectedCloudId.value === id) selectedCloudId.value = clouds.value[0]?.id ?? null
      ensureMainSparse()
      log(`Removed cloud "${removed.name}"`, 'info', 'Reconstruction', { channel: 'activity' })
      save()
      return true
    }

    // Rename is label-only — every link (selection, persistence, viewer) keys off
    // the cloud's stable `id`, so the name is free to change. A custom name also
    // survives a rebuild (upsertSparseCloud carries the previous name forward).
    function renameCloud(id, name) {
      const cloud = clouds.value.find((c) => c.id === id)
      const trimmed = name.trim()
      if (!cloud || !trimmed || trimmed === cloud.name) return false
      const prev = cloud.name
      cloud.name = trimmed
      log(`Renamed cloud "${prev}" → "${trimmed}"`, 'info', 'Reconstruction', { channel: 'activity' })
      save()
      return true
    }

    // The DEM / orthophoto records (reconstruction/products.js).
    const {
      productById,
      renameProduct,
      setMainProduct: setMainRaster,
      setProductStyle,
      saveProductRecord,
      setProductVisible,
      setProductOpacity,
      removeProduct,
    } = createProducts({
      rasterProducts,
      mainProductIds,
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

    // Serialise every cloud to the on-disk shape (metadata + binary buffers).
    // Committed sidecar files per unchanged dense/mesh cloud (savedCloudFiles.js).
    const savedCloudFiles = createSavedCloudFiles()
    // The project whose saved model could not be read this session (see restore).
    // Until something is put in its place, an empty save would overwrite that
    // document and collect its buffers — so save() declines it.
    let unreadableProjectId = null

    // `reuse[i]` (optional) — files to point cloud i at instead of re-serialising it.
    function serialize(reuse = null) {
      return {
        clouds: clouds.value.map((c, i) => serializeCloud(c, { reuse: reuse?.[i] ?? null })),
        // Which sparse cloud downstream stages consume (MC). Absent in legacy docs ⇒
        // restore falls back to the first sparse cloud.
        mainSparseId: mainSparseId.value,
        // The main dense cloud, mesh, DEM and ortho (the rasters are saved apart).
        mainProductIds: mainProductIds.value,
        // Small + reusable across sessions; the DEM/ortho rasters themselves are
        // recomputable and stay out of the persisted doc.
        georef: georef.value,
        // Derived, not evidence — the bars live in scalebars.json (see D11).
        scaleFit: scaleFit.value,
        region: region.value,
        orientation: orientation.value,
        productLayers: productLayers.value,
        mapOrder: mapOrder.value,
        mapHidden: mapHidden.value,
        imageLayer: imageLayer.value,
        // Run-quality summaries (Q3) — tiny, kept for cross-run comparison.
        summary: summary.value,
        denseSummary: denseSummary.value,
        depthSummary: depthSummary.value,
        summaryHistory: summaryHistory.value,
      }
    }

    // Writes only the clouds whose heavy data changed since the last committed save; the
    // rest keep their files (savedCloudFiles.js). If a reused file has gone — another tab
    // saved this project in between — the saver writes nothing and this resends in full.
    async function save() {
      if (!isPersisting()) return false
      const projectId = projects.currentProjectId
      if (projectId === unreadableProjectId && clouds.value.length === 0) return false
      try {
        for (const full of [false, true]) {
          const list = clouds.value
          const reuse = full ? null : list.map((c) => savedCloudFiles.lookup(c, projectId))
          const res = await opfs.saveReconstruction(projectId, serialize(reuse))
          if (res?.ok === false) {
            savedCloudFiles.clear()
            continue
          }
          if (res?.files) for (const c of list) savedCloudFiles.remember(c, projectId, res.files[c.id])
          const reused = reuse?.filter(Boolean).length ?? 0
          if (reused) {
            log(
              `Saved the reconstruction — ${pluralize(list.length - reused, 'cloud')} written, ${reused} unchanged kept`,
              'debug',
              'Reconstruction',
            )
          }
          return true
        }
        return false
      } catch {
        return false
      }
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
      } = opts
      const idx = replaceId ? clouds.value.findIndex((c) => c.id === replaceId && c.kind === 'sparse') : -1
      const prev = idx >= 0 ? clouds.value[idx] : null
      const cloud = {
        id: prev?.id ?? makeCloudId(),
        name: name ?? prev?.name ?? 'Sparse cloud',
        kind: 'sparse',
        createdAt: Date.now(),
        // Provenance, not a role: a COLMAP-imported sparse cloud still lives in the
        // Reconstruction section (it IS the model) but carries the chip. NOT
        // inherited from `prev` — a reconstruct that replaces an imported cloud
        // in place has genuinely recomputed it, so the flag must clear.
        ...(imported ? { imported: true } : {}),
        ...(secondary ? { secondary: true } : {}),
        // markRaw: keep the big point/camera data out of Vue's reactivity (see restore).
        cameras: markRaw(cameras),
        points: markRaw(points),
      }
      if (idx >= 0) clouds.value.splice(idx, 1, cloud)
      else clouds.value.push(cloud)
      if (select) selectedCloudId.value = cloud.id
      if (asMain || !mainSparseCloud.value) mainSparseId.value = cloud.id
    }

    // A sparse rerun replaces the current main model. Keeping that model's tracks
    // (hundreds of MB at millions of points) resident while constructing the worker input can
    // make the memory preflight reject a run that fits comfortably from a clean state.
    // Replace it with a lightweight placeholder only when headroom is insufficient.
    // Nothing is persisted here: if the new solve fails, reloading restores the previous
    // saved reconstruction. The dense clouds, meshes, DEMs and orthophotos stay: they
    // outlive the rebuild (marked outdated), so dropping them here would lose them at
    // the next save.
    function releaseReplaceableModelForRerun() {
      const main = mainSparseCloud.value
      const replaceId = main?.id ?? null
      const pointCount = main?.points?.length ?? 0
      const cameraCount = main?.cameras?.size ?? 0

      clouds.value = clouds.value.flatMap((cloud) => {
        if (cloud.kind === 'sparse' && cloud.secondary) return []
        if (cloud.id !== replaceId || cloud.kind !== 'sparse') return [cloud]
        return [{ ...cloud, cameras: markRaw(new Map()), points: markRaw(SparsePoints.empty()), count: 0 }]
      })
      clearDepthMaps()
      georef.value = null
      scaleFit.value = null
      summary.value = null
      denseSummary.value = null
      depthSummary.value = null
      healthDirty.value++
      // Depth previews stay: they are Blobs outside the heap, and leaving them lets
      // invalidateSparseDependents find and retire them once the new solve lands.
      if (selectedCloudId.value && !clouds.value.some((c) => c.id === selectedCloudId.value))
        selectedCloudId.value = replaceId

      return { released: pointCount > 0 || cameraCount > 0, pointCount, cameraCount }
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
    const { importColmapModel, importInteropModel, importCloud } = createImporters({
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
    const { computeDepthMaps, densify, generateMesh } = createDense({
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

    // Each image's frame model (calibrated bag, composed self-cal bag, film
    // transform) from the run record — the one join displayFrame.js owns. GCP and
    // marker triangulation map raw marks through it into the cameras' frame.
    const frameModelFor = computed(() =>
      makeFrameModelResolver({ summary: toRaw(summary.value), sensors: sensors.value }),
    )

    const {
      imagesById,
      canGeoreferenceGcps,
      canGeoreference,
      georeferenceBlocker,
      crsSuggestion,
      georeference,
      validGeoref,
      poseResidualReport,
      gcpAccuracyReport,
      gcpGuides,
      gcpEstimate,
    } = createGeoreferencing({
      sparseCameras,
      images,
      georef,
      healthDirty,
      modelStamp: () => (mainSparseCloud.value ? [mainSparseCloud.value.id, mainSparseCloud.value.createdAt] : null),
      poses: () => posesStore.poses,
      gcps: () => gcpsStore.gcps,
      currentCrs: () => projects.currentCrs,
      save,
      log,
      frameModel: () => frameModelFor.value,
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

    const { effectiveFrameSpec, currentFrameSignature, productFrameStatus, frameStampOf } = createFrameResolver({
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
      sensors,
      sparseCameras,
      summary,
      summaryHistory,
      supersedeRestore,
      upsertSparseCloud,
      liveSparse,
    })

    // Reset the in-memory clouds. Pass { purge: true } to also delete the persisted
    // reconstruction.json — do NOT purge on project switch, since restore reads it.
    function clear({ purge = false } = {}) {
      restoreGeneration++
      unreadableProjectId = null
      clouds.value = []
      selectedCloudId.value = null
      mainSparseId.value = null
      reconStatus.value = 'idle'
      clearDepthMaps()
      rasterProducts.value = []
      mainProductIds.value = {}
      georef.value = null
      scaleFit.value = null
      region.value = null
      orientation.value = null
      productLayers.value = {}
      mapOrder.value = []
      mapHidden.value = []
      imageLayer.value = null
      summary.value = null
      denseSummary.value = null
      depthSummary.value = null
      summaryHistory.value = []
      if (purge && isPersisting()) {
        opfs.deleteReconstruction(projects.currentProjectId).catch(() => {})
        opfs.deleteProducts(projects.currentProjectId).catch(() => {})
        opfs.deleteDepthPlanes(projects.currentProjectId).catch(() => {})
      }
    }

    // Project Settings cleanup: retain reconstruction/clouds while dropping the
    // recomputable depth-map and raster-product caches from memory and storage.
    async function clearDerived() {
      clearDepthMaps()
      rasterProducts.value = []
      const { dem: _dem, ortho: _ortho, ...cloudMains } = mainProductIds.value
      mainProductIds.value = cloudMains
      if (isPersisting()) await opfs.deleteProjectDerived(projects.currentProjectId)
      log('Cleared cached image transcodes, depth maps, and raster products.', 'success', 'Project')
    }

    // Rebuild one cloud from version-2 metadata + binary buffers (inverse of
    // serializeCloud). markRaw: point clouds are large and only ever replaced
    // wholesale, never mutated per-point — deep reactivity freezes render/restore.
    //
    // `report` feeds the project-load overlay (stores/projectStores.js). Every slow
    // step announces itself and then yields once so the label is actually painted:
    // decoding a cloud and the first render of the restored model are each one long
    // synchronous task, and a label set inside such a task is never drawn. The
    // per-phase timing line is how a slow open is attributed to a step.
    async function restore({ projectId, report = () => {} }) {
      // Reset first so switching to a project without a saved model doesn't leave
      // the previous project's clouds in memory (loadReconstruction returns null for
      // an empty project and would otherwise no-op).
      clear()
      const generation = restoreGeneration
      const isCurrentRestore = () => generation === restoreGeneration && projectId === projects.currentProjectId
      const phases = []
      let lapStart = performance.now()
      const lap = (phase) => {
        const t = performance.now()
        phases.push(`${phase} ${Math.round(t - lapStart)} ms`)
        lapStart = t
      }
      // The model, the raster products and the depth index are independent files:
      // read them concurrently so project open waits for the slowest, not the sum.
      report('Reading the model files…')
      const productsRead = opfs.loadProducts(projectId).catch(() => [])
      const depthIndexRead = opfs.loadDepthIndex(projectId).catch(() => null)
      let data
      try {
        data = await opfs.loadReconstruction(projectId)
      } catch (err) {
        if (!isCurrentRestore()) return
        // Not the same as "no model yet": the document is there but unreadable. Keep
        // it on disk untouched (save() refuses an empty save over it) and leave
        // the depth planes alone, since their staleness check needs the model.
        unreadableProjectId = projectId
        const detail = String(err?.message ?? err)
        log(
          `Could not read the saved reconstruction — ${detail}. It is left on disk unchanged; ` +
            'a new reconstruction or import will replace it.',
          'error',
          'Reconstruction',
        )
        showToast('Saved reconstruction could not be read', { detail, kind: 'error', ms: 8000 })
        return
      }
      if (!isCurrentRestore()) return
      if (!data) {
        // No sparse model, so any saved depth planes are orphans (they only exist in a
        // sparse cloud's frame). Let the staleness check collect them rather than leak
        // hundreds of MB of OPFS forever.
        await loadDepthIndexIntoMeta(projectId, isCurrentRestore, depthIndexRead)
        return
      }
      lap('read')

      const raw = Array.isArray(data.clouds) ? data.clouds : []

      // One cloud per task, so the overlay can say which one is decoding. Each cloud's
      // own decode time goes into the timing line, so a slow open names its cloud.
      const restored = []
      const perCloud = []
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i]
        const name = c.name ?? c.kind ?? 'cloud'
        report(`Decoding "${name}"`, i + 1, raw.length)
        await yieldToPaint()
        if (!isCurrentRestore()) return
        const t = performance.now()
        restored.push(deserializeCloud(c, makeCloudId))
        perCloud.push(
          `${name} [${c.kind ?? 'sparse'}, ${(c.pointCount ?? 0).toLocaleString()} pts] ` +
            `${Math.round(performance.now() - t)} ms`,
        )
      }
      lap('decode')
      if (perCloud.length) phases[phases.length - 1] += ` (${perCloud.join(', ')})`
      report('Preparing the 3D view and panels…')
      await yieldToPaint()
      if (!isCurrentRestore()) return
      clouds.value = restored
      // The arrays just read ARE the committed files' contents, so the first save after
      // opening need not rewrite them.
      savedCloudFiles.clear()
      raw.forEach((c, i) => {
        if (c.savedFiles) savedCloudFiles.remember(clouds.value[i], projectId, c.savedFiles)
      })
      // Octree files no cloud names any more (a deleted cloud, an unfinished build).
      pruneLod().catch(() => {})
      for (const c of clouds.value) {
        if (!c.attributeError) continue
        log(
          `Cloud "${c.name}": point attributes could not be restored (${c.attributeError}) — ` +
            'the points are intact; re-import the file to recover intensity/classification',
          'warn',
          'Reconstruction',
        )
        delete c.attributeError
      }
      selectedCloudId.value = clouds.value[0]?.id ?? null
      mainSparseId.value = data.mainSparseId ?? null
      ensureMainSparse() // legacy docs (no mainSparseId) → first sparse cloud
      // A stale or missing id means the newest of the kind (mainOf).
      mainProductIds.value = data.mainProductIds && typeof data.mainProductIds === 'object' ? data.mainProductIds : {}
      georef.value = data.georef ?? null
      scaleFit.value = data.scaleFit ?? null // absent in older projects ⇒ no scale
      region.value = normalizeRegion(data.region) ?? null
      orientation.value = normalizeOrientation(data.orientation) ?? null
      productLayers.value = normalizeProductLayers(data.productLayers) // absent ⇒ nothing on the map
      mapOrder.value = normalizeMapOrder(data.mapOrder) // absent ⇒ the default stack
      mapHidden.value = normalizeMapOrder(data.mapHidden) // a list of ids, as the order
      imageLayer.value = normalizeImageLayer(data.imageLayer)
      summary.value = data.summary ?? null
      denseSummary.value = data.denseSummary ?? null
      depthSummary.value = data.depthSummary ?? null
      summaryHistory.value = Array.isArray(data.summaryHistory) ? data.summaryHistory : []
      // The render + watcher flush these assignments queued (sidebar, 3D layers, map
      // frame) — timed on its own, since it is not part of reading or decoding.
      await nextTick()
      lap('first render')

      // Restore persisted raster products (DEMs / orthos), if any. A record keeps the
      // name of the document it was read from as its id, so its saves go back there.
      report('Reading the DEMs / orthophotos…')
      const saved = await productsRead
      if (!isCurrentRestore()) return
      const restoredProducts = []
      for (const { stem, product } of saved) {
        if (product.outdated) {
          // Saved before orthophotos were stored as tiled GeoTIFFs; that shape is not read.
          log(
            'A saved orthophoto uses an older storage format and was removed — rebuild it (Products ▸ Orthophoto)',
            'warn',
            'Products',
          )
          opfs.deleteProduct(projectId, stem).catch(() => {})
          continue
        }
        const kind = product.kind ?? (stem.startsWith('ortho') ? 'ortho' : 'dem')
        restoredProducts.push(withPreviewUrl({ ...product, id: stem, kind }))
      }
      rasterProducts.value = restoredProducts
      if (restoredProducts.length) {
        const n = (kind) => restoredProducts.filter((p) => p.kind === kind).length
        log(
          `Products restored: ${[n('dem') && pluralize(n('dem'), 'DEM'), n('ortho') && pluralize(n('ortho'), 'ortho')]
            .filter(Boolean)
            .join(' + ')}`,
          'success',
          'Products',
        )
      }
      await nextTick()
      lap('products')

      if (clouds.value.length) {
        const camTotal = clouds.value.reduce((n, c) => n + c.cameras.size, 0)
        log(
          `Reconstruction restored: ${pluralize(clouds.value.length, 'cloud')}, ${camTotal} cameras`,
          'success',
          'Reconstruction',
        )
      }

      // Advertise saved depth maps without loading their planes — densify / ortho
      // hydrate them on demand. Runs after ensureMainSparse() so the staleness check
      // compares against the cloud the pipeline will actually consume.
      if ((await loadDepthIndexIntoMeta(projectId, isCurrentRestore, depthIndexRead)) && isCurrentRestore()) {
        log(
          `Dense: ${pluralize(depthMapsMeta.value.length, 'saved depth map')} available ` +
            `(${formatBytes(depthMapBytes(depthMapsMeta.value))}, loaded on demand)`,
          'success',
          'Dense',
        )
      }
      lap('depth index')
      // JS memory at the end (Chromium only). The decode itself is ~0.1 s for 20 M
      // dense points, so a decode measured in seconds is memory pressure (GC or paging)
      // landing in it. Caveat, measured: `usedJSHeapSize` INCLUDES ArrayBuffer backing
      // stores (a 32.8 M-point dense cloud moved it by its ~0.9 GB of typed arrays),
      // which the ~4 GB V8 heap limit does not count — the bench's DevTools reading
      // (`V8 heap + ArrayBuffers`) separates the two.
      const mem = globalThis.performance?.memory
      const heap = mem?.usedJSHeapSize
        ? ` · JS memory (heap + ArrayBuffers) ${formatBytes(mem.usedJSHeapSize)}, heap limit ${formatBytes(mem.jsHeapSizeLimit)}`
        : ''
      log(`Reconstruction restore timing: ${phases.join(' · ')}${heap}`, 'info', 'Reconstruction')
    }

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
      depthMaps,
      depthMapsMeta,
      forgetDepthMap,
      depthMapCount,
      georef,
      scaleFit,
      summary,
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
      gcpAccuracyReport,
      poseResidualReport,
      gcpGuides,
      gcpEstimate,
      generateDem,
      generateOrtho,
      estimateRasterSize,
      generateMesh,
      reconstruct,
      importColmapModel,
      importInteropModel,
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
