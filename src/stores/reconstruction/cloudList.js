// The reconstruction store's cloud list: the selected and main clouds, the
// sources each build offers (demSource, meshSource, orthoSurfaces …: a dialog
// renders them and its run consumes them, so the two cannot disagree), and the
// sidebar's edits (select, main, style, visibility, remove, rename).
//
// Moved verbatim from the store: what it shares comes in by name; names the store
// defines further down come in late (late.js).

import { isStreamed } from '../../core/lod/streamed.js'
import { computed } from 'vue'
import { mainOf } from '../../core/products/productSet.js'

export function createCloudList({
  clouds,
  dem,
  log,
  mainProductIds,
  mainSparseId,
  productStatus,
  save,
  selectedCloudId,
}) {
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
          ? `"${dem.value.name}" · ${dem.value.fullWidth ?? dem.value.width}×${dem.value.fullHeight ?? dem.value.height} · ${dem.value.crs === 'local' || !dem.value.crs ? 'local frame' : dem.value.crs}` +
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
          : 'Build a mesh first (Reconstruct ▸ Mesh).',
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

  return {
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
  }
}
