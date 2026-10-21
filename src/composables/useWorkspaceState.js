import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { usePosesStore } from '../stores/usePosesStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { resolveK } from '../core/sfm/reconstruction.js'
import { usedKeysForPair, usedPairCounts } from '../core/eval/usedMatches.js'

// State derived from the project stores alone, lifted out of App.vue: what the
// workspace is ready for (the ribbon, console and workflow guards), the match
// summaries the match list and sidebar show, and the counts the dialogs gate on.
// No inputs: everything here is a function of store state.
export function useWorkspaceState() {
  const imagesStore = useImagesStore()
  const { images, selectedId, keypointReadyImages } = storeToRefs(imagesStore)
  const { matchStore } = storeToRefs(useMatchesStore())
  const { sets: shapefiles } = storeToRefs(useFootprintsStore())
  const { sensors } = storeToRefs(useSensorsStore())
  const { poses } = storeToRefs(usePosesStore())
  const { clouds, sparseCameras, mainSparseCloud, dem, ortho } = storeToRefs(useReconstructionStore())

  // Largest detected keypoint count over all images — lets the Match modal warn when
  // a LightGlue cap would discard most of them (P6 auto-hint).
  const detectedMaxKeypoints = computed(() => images.value.reduce((m, img) => Math.max(m, img.kpCount || 0), 0))
  // The images matching will pair up — same filter as useMatchesStore.matchAll's `ready`.
  const detectedImageCount = computed(
    () => images.value.filter((img) => img.kpStatus === 'done' && (img.kpCount || 0) > 0).length,
  )

  // Total polygons across all sets — gates the ribbon's footprint layer toggle.
  const footprintCount = computed(() => shapefiles.value.reduce((n, s) => n + s.footprints.length, 0))

  // Sensor ids whose intrinsics fall back to the default-FOV guess for at least one
  // assigned image (or, with no images, on their own) — i.e. no usable calibration.
  // Surfaced with a ⚠ in the sidebar so an uncalibrated/incomplete sensor is visible
  // before reconstruction (same test SensorTable uses for its warn badge).
  const incompleteSensorIds = computed(() => {
    const bad = new Set()
    for (const s of sensors.value) {
      const imgs = images.value.filter((i) => i.sensorId === s.id)
      const probe = imgs.length ? imgs : [{ meta: null }]
      if (probe.some((img) => resolveK(img.meta, s).source.startsWith('default FOV'))) bad.add(s.id)
    }
    return bad
  })

  // Distinct current images that carry each preselect evidence source — the Match
  // modal gates its "Preselect by" methods on these (poses link by image.id, as do
  // footprints; count only links that resolve to a loaded image).
  const posedImageCount = computed(() => {
    const ids = new Set(images.value.map((i) => i.id))
    const posed = new Set()
    for (const p of poses.value)
      if (p.enabled !== false && p.imageId && Number.isFinite(p.x) && Number.isFinite(p.y) && ids.has(p.imageId))
        posed.add(p.imageId)
    return posed.size
  })
  const footprintImageCount = computed(() => {
    const ids = new Set(images.value.map((i) => i.id))
    const withFp = new Set()
    for (const s of shapefiles.value)
      for (const fp of s.footprints) if (fp.imageId && ids.has(fp.imageId)) withFp.add(fp.imageId)
    return withFp.size
  })

  // Dense pipeline gating for the Ribbon.
  const sparseReady = computed(() => clouds.value.some((c) => c.kind === 'sparse' && c.cameras.size >= 2))
  // From the store: counts saved-but-not-yet-hydrated maps too, so Densify / Ortho
  // stay enabled after a project reopen (the planes load on demand).
  // Products gating: a DEM needs any cloud; an ortho needs a DEM (+ depth maps);
  // the preview needs a built product.
  // A mesh is not a cloud here (and has no `points`: a project whose only cloud is a
  // mesh, e.g. an imported PLY, used to throw in this check).
  const cloudReady = computed(() =>
    clouds.value.some((c) => (c.kind === 'dense' ? c.count > 0 : c.kind !== 'mesh' && (c.points?.length ?? 0) > 0)),
  )
  // Mesh needs a dense cloud (Poisson input); the modal further checks it has normals.
  const denseReady = computed(() => clouds.value.some((c) => c.kind === 'dense' && c.count > 0))
  const meshReady = computed(() => clouds.value.some((c) => c.kind === 'mesh' && c.count > 0))
  // What the crop/filter/merge tools can act on: every non-empty dense cloud, computed
  // or imported. Sparse clouds are excluded on purpose — their points carry the
  // view-tracks dense/ortho/COLMAP-export read (see core/products/cloudEdit.js).
  // Resident dense clouds only: a streamed one (core/lod/streamed.js) has no points in memory.
  const editableClouds = computed(() => clouds.value.filter((c) => c.kind === 'dense' && c.count > 0 && !!c.pos))
  // What the Mesh ▾ tools act on: every non-empty mesh (computed, imported or edited).
  const meshClouds = computed(() => clouds.value.filter((c) => c.kind === 'mesh' && c.count > 0))

  const demReady = computed(() => !!dem.value)
  const orthoReady = computed(() => !!ortho.value)
  const productReady = computed(() => !!dem.value || !!ortho.value)

  const selected = computed(() => images.value.find((img) => img.id === selectedId.value) || null)

  const kpImageCount = computed(() => keypointReadyImages.value.length)

  // True while any image is still decoding or transcoding (TIFF PNG encode /
  // preview pending). Pixel-reading compute ops (Detect, Auto-mask) gate on this so
  // they can't be launched mid-import against not-yet-ready images.
  const imagesLoading = computed(() => images.value.some((img) => img.loading || img.previewPending))

  const hasSparse = computed(() => clouds.value.some((c) => c.kind === 'sparse'))

  // UUIDs of images registered (aligned) in the sparse model. Empty until a sparse
  // cloud exists — so `hasSparse` gates whether "not in this set" means "unaligned"
  // versus "reconstruction hasn't run yet". Used to dim unregistered images.
  const alignedUuids = computed(() => new Set(sparseCameras.value.keys()))

  // Per-pair count of matches that became tie-points in the sparse model
  // (core/eval/usedMatches.js). The MAIN model — the one reconstruction consumed;
  // "first sparse cloud" was a COLMAP import's tracks whenever one sat ahead of the
  // computed model. Counts only: the per-keypoint keys are built for the one pair the
  // match preview shows (usedKeysOf), never for the whole model — that was a
  // many-second stall at project open.
  const usedCountsByPair = computed(() => usedPairCounts(mainSparseCloud.value?.points))
  const usedKeysOf = (pairId) => usedKeysForPair(mainSparseCloud.value?.points, pairId)

  const matchSummaries = computed(() => {
    const result = []
    const byUuid = new Map(images.value.map((img) => [img.uuid, img]))
    for (const [pid, entry] of matchStore.value) {
      if (entry.status !== 'done' || entry.inlierCount === 0) continue
      const imgA = byUuid.get(entry.idA)
      const imgB = byUuid.get(entry.idB)
      if (!imgA || !imgB) continue
      result.push({
        pairId: pid,
        idA: imgA.id,
        idB: imgB.id,
        idAUuid: imgA.uuid,
        idBUuid: imgB.uuid,
        nameA: imgA.name,
        nameB: imgB.name,
        inlierCount: entry.inlierCount,
        rawCount: entry.rawCount,
        usedCount: usedCountsByPair.value.get(pid) ?? 0,
        enabled: entry.enabled !== false,
      })
    }
    return result
  })

  // Imported camera positions keyed by image uuid, in the project working CRS — feeds
  // the match graph's optional geographic layout (place nodes where the photos were
  // actually taken). Only poses that resolved to an image and carry x/y are included.
  const matchNodePositions = computed(() => {
    const out = {}
    const poseByImageId = new Map()
    for (const p of poses.value) {
      if (p.enabled === false || p.imageId == null || p.x == null || p.y == null) continue
      poseByImageId.set(p.imageId, p)
    }
    for (const img of images.value) {
      const p = poseByImageId.get(img.id)
      if (p) out[img.uuid] = { x: p.x, y: p.y }
    }
    return out
  })

  // Sidebar summary of the pairwise match store: verified/total/running/failed counts.
  // `verified` mirrors matchSummaries.length (done + inliers), but we walk the store
  // once here to also surface in-flight and failed pairs at a glance.
  const matchStats = computed(() => {
    let total = 0,
      verified = 0,
      running = 0,
      error = 0,
      excluded = 0,
      weak = 0
    for (const [, entry] of matchStore.value) {
      total++
      if (entry.status === 'running') running++
      else if (entry.status === 'error') error++
      else if (entry.status === 'done' && entry.inlierCount > 0) {
        // A user-excluded pair is still geometrically verified, but it won't feed
        // reconstruction — count it separately so "verified" reflects usable pairs.
        // A weak pair (valid F below the accept gate) is a PnP-only bridge, not
        // verified geometry — counted apart too.
        if (entry.enabled === false) excluded++
        else if (entry.weak) weak++
        else verified++
      }
    }
    // Pairs that contributed at least one tie-point to the sparse model (0 until
    // reconstruction has run).
    const used = hasSparse.value ? usedCountsByPair.value.size : null
    return { total, verified, running, error, used, excluded, weak }
  })

  return {
    detectedMaxKeypoints,
    detectedImageCount,
    footprintCount,
    posedImageCount,
    footprintImageCount,
    incompleteSensorIds,
    sparseReady,
    cloudReady,
    denseReady,
    meshReady,
    demReady,
    orthoReady,
    productReady,
    editableClouds,
    meshClouds,
    selected,
    kpImageCount,
    imagesLoading,
    hasSparse,
    alignedUuids,
    usedKeysOf,
    matchSummaries,
    matchNodePositions,
    matchStats,
  }
}
