import { ensureProjection, isGeographic } from '../../core/crs.js'
import { isGroundControl } from '../../core/io/gcp.js'
import { precisionFromGcp } from '../../core/gcpAccuracy.js'
import { surveyFrameFor, gcpToSurveyFrame, normalizeLeverArm, buildCameraPriors } from '../../core/sfm/cameraPriors.js'
import { gcpsInPinholeFrame } from '../../core/sfm/displayFrame.js'
import { formatBytes, deviceBudget } from '../../core/dense/memBudget.js'
import { SFM_TUNING } from '../../core/tuning.js'
import { applyTuningOverrides } from '../tuningOverrides.js'
import {
  projectSparsePeakBreakdownBytes,
  sparseMemoryDecision,
  planSparseRun,
  WASM_SOLVER_LIMIT_BYTES,
  SPARSE_HEAP_FRACTION,
} from '../../core/sfm/memBudget.js'
import { terminateAll, reconstruct as workerReconstruct } from '../../workers/computeClient.js'
import { keypointSetFrom, keypointSetTransfer } from '../../core/sfm/keypointSet.js'
import { useMatchesStore } from '../useMatchesStore.js'
import { packMatchPairs, inNameOrder } from '../../core/sfm/matchCodec.js'
import * as opfs from '../../utils/opfs.js'
import { toMatchSpace, rootSiftToU8 } from '../../core/features/siftDescriptors.js'
import { unpackReconstructionResult } from '../../core/sfm/resultCodec.js'
import { aerialUpRotation, rotateReconstruction, sceneUpFromCameras } from '../../core/products/projection.js'
import { pluralize } from '../../core/textFormat.js'
import { SparsePoints } from '../../core/sfm/sparsePoints.js'
import { markRaw } from 'vue'

// The sparse reconstruction run, split out of useReconstructionStore: packing the
// keypoints, matches and survey constraints for the SfM worker, the memory
// preflight (and the in-memory release of a replaceable model when headroom is
// short), and committing the solved model — which retires everything built on the
// previous camera solution.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createSparseRun({
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
}) {
  // The external 3D evidence a bundle adjustment is held to — enabled ground
  // control and camera priors — as worker-ready plain data, in ONE Cartesian survey
  // frame for a projected CRS (cameraPriors.js surveyFrameFor: scale factor divided
  // out, curvature restored). Reconstruct and gradual selection share it, so a
  // refinement is constrained exactly like the solve it refines.
  //   marks: 'raw'     — GCP marks as clicked (sfm.js maps them alongside keypoints)
  //          'pinhole' — marks mapped into the cameras' frame (for an existing model)
  async function surveyConstraintInput({ marks = 'raw' } = {}) {
    const crs = projects.currentCrs
    if (crs && crs !== 'local') await ensureProjection(crs).catch(() => {})
    const control = gcpsStore.gcps.filter((g) => isGroundControl(g, { precision: precisionFromGcp }))
    const surveyFrame = surveyFrameFor(
      [
        ...control.map((g) => [g.x, g.y, g.z]),
        ...posesStore.poses.filter((p) => p.enabled !== false).map((p) => [p.x, p.y, p.z]),
      ],
      crs,
    )
    if (surveyFrame) {
      log(
        `Survey constraints: fitted in a local metric frame (grid scale factor k=${surveyFrame.k.toFixed(6)}, ` +
          'curvature restored) — the project CRS is unchanged for display and export',
        'info',
        'Reconstruction',
      )
    }
    const imgById = imagesById()
    // Anchored BA is a Euclidean 3D constraint. Do not mix longitude/latitude
    // degrees with metre elevations, and never invent z=0 for a 2D control point.
    // Post-hoc products enforce the same boundary.
    const inFrame =
      marks === 'pinhole'
        ? gcpsInPinholeFrame(control, {
            imagesById: imgById,
            sparseCameras: sparseCameras.value,
            frameModel: frameModelFor.value,
          })
        : control
    const gcps = isGeographic(crs)
      ? []
      : inFrame
          .map((g) => gcpToSurveyFrame(g, surveyFrame))
          .map((g) => ({
            role: 'control',
            x: g.x,
            y: g.y,
            z: g.z,
            accuracyX: g.accuracyX,
            accuracyY: g.accuracyY,
            accuracyZ: g.accuracyZ,
            correlationXY: g.correlationXY,
            correlationXZ: g.correlationXZ,
            correlationYZ: g.correlationYZ,
            observations: (g.observations || [])
              .map((o) => ({
                uuid: imgById.get(o.imageId)?.uuid,
                px: o.px,
                py: o.py,
                accuracyX: o.accuracyX ?? g.accuracyImgX,
                accuracyY: o.accuracyY ?? g.accuracyImgY,
              }))
              .filter((o) => o.uuid != null),
          }))
    // Surveyed/imported and EXIF-derived camera positions; a geographic project's
    // priors get their own survey-centred metric frame (buildCameraPriors).
    // A sensor's GNSS antenna offset makes its images' priors antenna positions.
    const armBySensor = new Map(sensors.value.map((s) => [s.id, normalizeLeverArm(s.gnssLeverArm)]))
    const leverArmFor = (imageId) => armBySensor.get(imgById.get(imageId)?.sensorId) ?? null
    const cameraPriors = buildCameraPriors(posesStore.poses, images.value, crs, { surveyFrame, leverArmFor })
    if (isGeographic(crs) && cameraPriors.length) {
      log(
        `Camera priors: ${pluralize(cameraPriors.length, 'geographic position')} converted to a ` +
          'survey-centred metric frame for bundle adjustment',
        'info',
        'Pose',
      )
    }
    const withArm = cameraPriors.filter((p) => p.leverArm)
    if (withArm.length) {
      const arms = [...new Set(withArm.map((p) => p.leverArm.map((v) => v.toFixed(3)).join(', ')))]
      log(
        `Camera priors: ${withArm.length}/${cameraPriors.length} are GNSS antenna positions, ` +
          `offset from the camera centre by (${arms.slice(0, 3).join('), (')}) m in camera axes` +
          `${arms.length > 3 ? ', …' : ''}`,
        'info',
        'Pose',
      )
    }
    return { gcps, cameraPriors, surveyFrame }
  }

  // Run incremental SfM in the compute worker (off the main thread). The heavy
  // orchestration lives in core/sfm/sfm.js; this gathers the plain inputs it needs
  // (keypoints + match graph + settings), streams its log/progress back through
  // the usual hooks, then writes the returned model into reactive state and
  // persists it. (The model now lands all at once at the end rather than building
  // up live in the viewer — a fair trade for never freezing the UI.)
  async function reconstruct(settings = {}, onProgress) {
    // The console's session overrides of SFM_TUNING knobs (stores/tuningOverrides.js).
    settings = applyTuningOverrides('sfm', settings, (msg) => log(msg, 'warn', 'Reconstruction'))
    supersedeRestore()
    reconStatus.value = 'running'
    let stopMemoryWatchdog = () => {}
    const runProjectId = projects.currentProjectId

    try {
      // Descriptors are required for matching, never for SfM. In a persistent
      // project they are already in OPFS and can be loaded on demand if matching
      // is run again. Keeping 127 × 25k × 128 float SIFT descriptors resident can
      // consume ~1.5 GiB and is enough to kill the renderer during reconstruction.
      let descriptorBytesReleased = 0
      let descriptorImagesReleased = 0
      if (isPersisting()) {
        for (const img of images.value) {
          const bytes = img.descriptors?.byteLength ?? 0
          if (!bytes) continue
          descriptorBytesReleased += bytes
          descriptorImagesReleased++
          img.descriptors = null
        }
      }
      if (descriptorBytesReleased) {
        log(
          `Released ${formatBytes(descriptorBytesReleased)} of persisted descriptors from ` +
            `${pluralize(descriptorImagesReleased, 'image')} before reconstruction`,
          'info',
          'Compute',
        )
        // Yield once so the engine can reclaim detached descriptor backing stores
        // before the live-heap reading below. Never assume it did: the decision
        // uses the observed value without subtracting bytes optimistically.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      // Counts gate and size the run: keypoints and matches are on disk, read below
      // image by image / pair by pair straight into the worker input.
      // By name, not import order (the file picker's order varies): with inNameOrder below,
      // the same photos and matches always reach the solver in the same order.
      let imgs = images.value
        .filter((img) => img.kpStatus === 'done' && (img.kpCount ?? 0) > 0)
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      const sensorById = new Map(sensors.value.map((s) => [s.id, s]))
      const reconstructionTransfers = []
      const reconstructionPairs = [...matchStore.value.values()].filter(
        (e) => e.status === 'done' && e.enabled !== false,
      )

      // Renderer OOM cannot be caught after the fact. Refuse before constructing
      // the large plain worker input when its projected peak exceeds safe headroom.
      const keypointCount = imgs.reduce((sum, img) => sum + (img.kpCount ?? 0), 0)
      const matchCount = reconstructionPairs.reduce((sum, pair) => sum + (pair.nMatches ?? 0), 0)
      // Guided track extension ships 128 B of descriptors per keypoint and builds
      // keypoint grids. When it is what pushes a run past a ceiling, the run goes ahead
      // without it (logged, recorded in the summary, flagged by the verdict) rather than
      // being refused or dying in the worker.
      let guided = settings.guidedTrackExtension ?? SFM_TUNING.guidedTrackExtension
      const project = (withGuided) =>
        projectSparsePeakBreakdownBytes({
          keypointCount,
          matchCount,
          imageCount: imgs.length,
          descriptorBytesPerKeypoint: withGuided ? 128 : 0,
        })
      const heap = globalThis.performance?.memory
      const hardwareBudget = deviceBudget({
        deviceMemoryGB: Number(globalThis.navigator?.deviceMemory) || null,
        jsHeapLimitBytes: Number(heap?.jsHeapSizeLimit) || null,
      }).budgetBytes
      const decideMemory = (peak) => ({
        renderer: sparseMemoryDecision({
          estimateBytes: peak.rendererHeapBytes,
          bufferBytes: peak.rendererBufferBytes,
          usedHeapBytes: Number(globalThis.performance?.memory?.usedJSHeapSize),
          heapLimitBytes: Number(globalThis.performance?.memory?.jsHeapSizeLimit),
          fallbackBudgetBytes: hardwareBudget,
        }),
        // A Web Worker is a separate V8 isolate with its own heap ceiling. Comparing
        // renderer-used + worker-projected bytes to one isolate's limit rejected safe
        // runs (the 127-image DJI set: 1.40 + 2.35 > 3.52 GB) even though neither heap
        // approached its own ceiling.
        worker: sparseMemoryDecision({
          estimateBytes: peak.workerHeapBytes,
          // The renderer's input buffers are transferred into the worker, so they are
          // part of this, not held twice.
          bufferBytes: peak.workerBufferBytes,
          usedHeapBytes: 0,
          heapLimitBytes: Number(globalThis.performance?.memory?.jsHeapSizeLimit),
          fallbackBudgetBytes: hardwareBudget,
        }),
      })
      let plan = planSparseRun({ guided, project, decide: decideMemory })

      // A reload restores the saved sparse model, so "reload and retry" alone does
      // not create renderer headroom. If the only thing preventing a rerun is the
      // replaceable current result, unload it in memory (the saved copy stays on disk),
      // discard idle worker heaps, yield for collection, and measure again.
      if (!plan.decisions.renderer.safe) {
        const released = releaseReplaceableModelForRerun()
        if (released.released) {
          terminateAll('preparing a clean sparse-reconstruction rerun')
          log(
            `Released the loaded reconstruction before rerun (${released.cameraCount} cameras, ` +
              `${released.pointCount.toLocaleString()} points` +
              `${released.dependentClouds ? `, ${pluralize(released.dependentClouds, 'computed dependent cloud')}` : ''}). ` +
              'The saved model remains recoverable by reloading until the replacement succeeds.',
            'info',
            'Compute',
          )
          await new Promise((resolve) => setTimeout(resolve, 50))
          plan = planSparseRun({ guided, project, decide: decideMemory })
        }
      }
      const { peak, decisions } = plan
      let guidedSkippedForMemory = null
      if (plan.guidedDropped) {
        guided = false
        const w = plan.withGuidedPeak
        const reason =
          `worker heap ${formatBytes(w.workerHeapBytes)} / buffers ` +
          `${formatBytes(w.workerBufferBytes)} projected with it, ` +
          `${formatBytes(peak.workerHeapBytes)} / ${formatBytes(peak.workerBufferBytes)} without`
        guidedSkippedForMemory = { reason, withBytes: w.workerBytes, withoutBytes: peak.workerBytes }
        log(
          `Sparse memory preflight: guided track extension turned off for this run so it fits — ${reason}. ` +
            'The model is complete without it; lower the keypoint cap or the preselection neighbours to keep it.',
          'warn',
          'Reconstruction',
        )
      }
      const decisionSafe = plan.safe
      const ceiling = (d) => (d.limitBytes ? ` ≤ ${formatBytes(d.limitBytes)} ceiling` : '')
      log(
        `Sparse memory preflight — ${keypointCount.toLocaleString()} keypoints, ` +
          `${matchCount.toLocaleString()} matches${guided ? ', guided extension on' : ''}; renderer heap ` +
          `${decisions.renderer.usedBytes != null ? `${formatBytes(decisions.renderer.usedBytes)} current + ` : ''}` +
          `${formatBytes(peak.rendererHeapBytes)}${ceiling(decisions.renderer)}, ` +
          `input buffers ${formatBytes(peak.rendererBufferBytes)}; ` +
          `worker projected heap ${formatBytes(peak.workerHeapBytes)}${ceiling(decisions.worker)}, ` +
          `buffers ${formatBytes(peak.workerBufferBytes)}` +
          `${decisions.worker.bufferLimitBytes ? ` ≤ ${formatBytes(decisions.worker.bufferLimitBytes)} device budget` : ''}` +
          ` (of which bundle adjustment ${formatBytes(peak.solverWasmBytes)} ≤ ${formatBytes(WASM_SOLVER_LIMIT_BYTES)} wasm memory)`,
        decisionSafe ? 'info' : 'error',
        'Compute',
      )
      if (!decisionSafe) {
        reconStatus.value = 'error'
        const parts = []
        if (!decisions.renderer.heapSafe) parts.push('renderer heap')
        if (!decisions.worker.heapSafe) parts.push('worker heap')
        if (!decisions.renderer.buffersSafe || !decisions.worker.buffersSafe) parts.push('device memory')
        if (!peak.wasmSolverSafe) parts.push('bundle-adjustment (wasm) memory')
        const where = parts.join(' and ') || 'memory'
        log(
          `Sparse reconstruction stopped before start because the projected ${where} would exceed ` +
            'its safety ceiling. Close other memory-heavy tabs or reduce the image/keypoint/match set' +
            (!peak.wasmSolverSafe ? " (fewer keypoints per image lowers the solver's observation count)" : '') +
            '.',
          'error',
          'Reconstruction',
        )
        return
      }

      const survey = await surveyConstraintInput({ marks: 'raw' })

      // Keypoints and matches are on disk (TODO ▸ SC-2/SC-3): read image by image and
      // pair by pair straight into the packed, transferred worker input — never all
      // resident first. Typed arrays (core/sfm/keypointSet.js): ~20 B per keypoint
      // instead of a 104 B object per keypoint per copy.
      const keypointSets = new Map()
      const missingKeypoints = []
      for (const img of imgs) {
        const kps = await imagesStore.readKeypoints(img)
        if (!kps) {
          missingKeypoints.push(img.name)
          continue
        }
        const set = keypointSetFrom(kps)
        reconstructionTransfers.push(...keypointSetTransfer(set))
        keypointSets.set(img.uuid, set)
      }
      if (missingKeypoints.length) {
        log(
          `Reconstruction: ${pluralize(missingKeypoints.length, 'image')} left out — their keypoints could not be read ` +
            `(${missingKeypoints.slice(0, 5).join(', ')}${missingKeypoints.length > 5 ? ', …' : ''})`,
          'warn',
          'Reconstruction',
        )
        imgs = imgs.filter((img) => keypointSets.has(img.uuid))
      }
      // Millions of tuple arrays are catastrophic to clone. Each pair's matches are a
      // fresh packed copy (the stream hands views into its read windows), transferred.
      const packedPairMatches = new Map()
      await useMatchesStore().streamPairMatches(reconstructionPairs, (e, m) => {
        packedPairMatches.set(e, packMatchPairs(m))
      })

      const imageNameByUuid = new Map(imgs.map((img) => [img.uuid, img.name]))
      const input = {
        images: imgs.map((img) => {
          // Forward everything resolveK() may need: the EXIF fields that let it
          // derive focal length in pixels, plus the assigned sensor's intrinsics
          // (which take priority, so edits in the sensor table actually apply).
          const s = img.sensorId ? sensorById.get(img.sensorId) : null
          return {
            uuid: img.uuid,
            name: img.name,
            kpStatus: img.kpStatus,
            // Resolution the keypoints were MEASURED at (keypoint coords themselves
            // are native px). core/scaleContext.js resolves the reprojection gates
            // against it — a gate below the measurement quantum rejects good data.
            // Absent on pre-scale projects ⇒ treated as 1 ⇒ no correction.
            detectScale: img.detectScale ?? null,
            // Sensor id lets BA share one focal across images on the same sensor
            // (self-calibration); null → the image is its own intrinsics group.
            sensorId: img.sensorId ?? null,
            // Read above, one image at a time; transferred rather than cloned.
            keypoints: keypointSets.get(img.uuid),
            // Fiducial detections (F4) — scan-pixel slots the sfm ingest joins with
            // the sensor's calibration to fit this image's scan→canonical transform.
            // Spread to plain objects (the Vue proxy can't be structured-cloned).
            fiducialDetections: (img.fiducialDetections || []).map((d) => ({
              slot: d.slot,
              px: d.px,
              py: d.py,
              family: d.family,
              source: d.source,
              confidence: d.confidence,
              reviewed: d.reviewed,
            })),
            meta: img.meta
              ? {
                  width: img.meta.width,
                  height: img.meta.height,
                  focalLength35: img.meta.focalLength35,
                  focalLength: img.meta.focalLength,
                  focalPlaneXRes: img.meta.focalPlaneXRes,
                  focalPlaneResUnit: img.meta.focalPlaneResUnit,
                  make: img.meta.make,
                  model: img.meta.model,
                }
              : null,
            sensor: s
              ? {
                  focal: s.focal,
                  focalUnit: s.focalUnit,
                  pixelSize: s.pixelSize,
                  sensorWidthMm: s.sensorWidthMm,
                  cx: s.cx,
                  cy: s.cy,
                  width: s.width,
                  height: s.height,
                  // Lens model (Brown / rational / fisheye) — undistorted at ingest so the
                  // pipeline stays pinhole. Null coeffs are treated as zero.
                  k1: s.k1,
                  k2: s.k2,
                  k3: s.k3,
                  k4: s.k4,
                  k5: s.k5,
                  k6: s.k6,
                  p1: s.p1,
                  p2: s.p2,
                  distortionModel: s.distortionModel,
                  // Film-scan interior orientation (F4): kind + fiducial calibration.
                  // The sfm ingest fits a per-image transform and builds one canonical
                  // K per sensor (resolveK path 0).
                  kind: s.kind ?? 'digital',
                  // Stitched half frames (SAT-5): film geometry already corrected.
                  reseauStitched: !!s.reseauStitched,
                  // Panoramic strip segments: exact pinholes of the certificate focal.
                  panoramicSegments: !!s.panoramicSegments,
                  fiducialCalibration: s.fiducialCalibration ? JSON.parse(JSON.stringify(s.fiducialCalibration)) : null,
                }
              : null,
          }
        }),
        // Name order, not uuid order (matchCodec.js inNameOrder): the same matches must
        // reconstruct the same model in every session.
        pairs: inNameOrder(
          reconstructionPairs.map((e) => ({
            idA: e.idA,
            idB: e.idB,
            // F (3×3) and matches come from reactive store entries; rebuild them
            // as plain arrays or the Vue proxy can't be structured-cloned to the
            // worker ("[object Array] could not be cloned").
            F: e.F ? e.F.map((row) => [...row]) : null,
            // Streamed above: a fresh packed buffer, transferred into the worker below.
            matches: packedPairMatches.get(e),
            // WS1: weak pairs (valid F below the accept gate) ride through with the flag.
            // sfm.js keeps them out of init / triangulation and feeds
            // them only to PnP correspondence collection (register.js).
            inlierCount: e.inlierCount,
            weak: e.weak ?? false,
            status: 'done',
          })),
          (uuid) => imageNameByUuid.get(uuid),
        ),
        // GCP anchors + camera priors in one survey frame (surveyConstraintInput).
        gcps: survey.gcps,
        cameraPriors: survey.cameraPriors,
        settings,
      }

      // Each pair's packed matches (a swapped pair's are a new buffer) are transferred.
      for (const p of input.pairs) if (p.matches) reconstructionTransfers.push(p.matches.buffer)
      // Guided track extension needs each image's descriptors in the worker, as
      // COLMAP-style uint8 RootSIFT (×512): 128 B per keypoint instead of 512.
      if (guidedSkippedForMemory) {
        input.settings = { ...settings, guidedTrackExtension: false, guidedSkippedForMemory }
      }
      if (guided) {
        // One image at a time: the float descriptors are 4× the uint8 copy, and loading
        // them all at once (2.2 M keypoints ≈ 1.1 GB) would be the renderer's peak.
        let bytes = 0,
          shipped = 0
        for (let i = 0; i < imgs.length; i++) {
          const img = imgs[i]
          if ((img.detector ?? 'sift') !== 'sift' || (img.descDim ?? 128) !== 128) continue
          const raw = isPersisting()
            ? ((await opfs.loadDescriptors(projects.currentProjectId, img.uuid)) ?? img.descriptors)
            : img.descriptors
          const d = toMatchSpace(raw, img, 128)
          if (!d || d.length !== img.kpCount * 128) continue
          const u8 = rootSiftToU8(d)
          input.images[i].descU8 = u8
          reconstructionTransfers.push(u8.buffer)
          bytes += u8.length
          shipped++
        }
        if (shipped) {
          log(
            `guided track extension: sending ${shipped}/${pluralize(imgs.length, 'image')}' descriptors ` +
              `to the worker (${formatBytes(bytes)}, uint8 RootSIFT)`,
            'info',
            'Reconstruction',
          )
        }
      }

      // Chrome exposes live heap usage. Poll while the main thread is idle and the
      // worker solves; terminate early because a renderer OOM itself is uncatchable.
      if (Number.isFinite(heap?.usedJSHeapSize) && Number.isFinite(heap?.jsHeapSizeLimit)) {
        const stopAt = heap.jsHeapSizeLimit * SPARSE_HEAP_FRACTION
        let stopped = false
        const timer = setInterval(() => {
          if (stopped || !(performance.memory?.usedJSHeapSize >= stopAt)) return
          stopped = true
          clearInterval(timer)
          const used = performance.memory.usedJSHeapSize
          log(
            `Sparse reconstruction stopped at ${formatBytes(used)} heap usage ` +
              `(safety ceiling ${formatBytes(stopAt)})`,
            'error',
            'Compute',
          )
          terminateAll('reconstruction stopped before browser memory exhaustion')
        }, 500)
        stopMemoryWatchdog = () => {
          stopped = true
          clearInterval(timer)
        }
      }

      input.liveSnapshots = true
      let packedResult = await workerReconstruct(input, {
        onLog: (message, level, category) => log(message, level, category),
        onProgress: (done, total, label, fraction) => onProgress?.(done, total, label, fraction),
        onEvent: (ev, [snap]) => {
          if (ev === 'snapshot' && projects.currentProjectId === runProjectId) showLive(snap)
        },
        transfer: reconstructionTransfers,
      })
      liveSparse.value = null
      stopMemoryWatchdog()
      stopMemoryWatchdog = () => {}
      const result = unpackReconstructionResult(packedResult)
      // The expanded Maps are now authoritative. Drop the transferred CSR buffers
      // before orientation + persistence allocate their own compact arrays.
      packedResult = null
      log(`Compact result received: ${result.points.length.toLocaleString()} points`, 'info', 'Reconstruction')

      // Apply the compact worker result. The transport codec has already expanded
      // its CSR buffers directly into the Map-based point shape used by the app.
      if (result.status === 'done') {
        let camMap = result.cameras
        let pts = result.points

        // Aerial auto-orient: SfM leaves the model in an arbitrary frame (it can
        // come out upside-down). For aerial surveys the cameras look down, so we
        // rotate the whole model Z-up — cameras above the ground — before storing.
        if (projects.currentSceneType === 'aerial') {
          const R = aerialUpRotation(camMap)
          if (R) {
            const oriented = rotateReconstruction(camMap, pts, R, { inPlace: true })
            camMap = oriented.cameras
            pts = oriented.points
            // Which camera signal set "up" — an oblique set's viewing directions are
            // not vertical, so say when the level camera plane overrode them.
            const how = sceneUpFromCameras([...camMap.values()])
            log(
              how.source === 'camera-plane'
                ? `Oriented model Z-up from the level camera plane (aerial; the mean viewing direction is ${how.viewTiltDeg.toFixed(1)}° off it — an oblique capture)`
                : 'Oriented model Z-up from the mean viewing direction (aerial: cameras above ground)',
              'info',
              'Reconstruction',
            )
          }
        }
        upsertSparseCloud(camMap, pts)
        // A secondary component that could not satisfy the conservative shared-camera
        // alignment gates is still a valid reconstruction. Preserve it as a separate
        // sparse cloud rather than discarding it or forcing it into the primary frame.
        clouds.value = clouds.value.filter((c) => !(c.kind === 'sparse' && c.secondary))
        for (const [si, model] of (result.secondaryModels || []).entries()) {
          let secondaryCameras = model.cameras
          let secondaryPoints = model.points
          if (projects.currentSceneType === 'aerial') {
            const R = aerialUpRotation(secondaryCameras)
            if (R)
              ({ cameras: secondaryCameras, points: secondaryPoints } = rotateReconstruction(
                secondaryCameras,
                secondaryPoints,
                R,
                { inPlace: true },
              ))
          }
          upsertSparseCloud(secondaryCameras, secondaryPoints, {
            replaceId: null,
            asMain: false,
            select: false,
            secondary: true,
            name: model.name || `Secondary sparse ${si + 1}`,
          })
        }
        await invalidateSparseDependents()
        // Retire the outgoing summary into the run history before overwriting it, so
        // "vs previous run" compares against what was on screen a moment ago (WS5).
        if (summary.value) {
          summaryHistory.value = [...summaryHistory.value, summary.value].slice(-SUMMARY_HISTORY_MAX)
        }
        summary.value = result.summary ?? null
        healthDirty.value++
        reconStatus.value = 'done'
        const saved = await save()
        log(
          saved
            ? 'Reconstruction saved to project storage'
            : 'Reconstruction is available in memory but could not be saved to project storage',
          saved ? 'success' : 'warn',
          'Project',
        )
      } else {
        reconStatus.value = result.status === 'error' ? 'error' : 'idle'
      }
    } catch (err) {
      log(`Reconstruction error: ${err?.message ?? err}`, 'error', 'Reconstruction')
      reconStatus.value = 'error'
    } finally {
      stopMemoryWatchdog()
      liveSparse.value = null
    }
  }

  // A worker snapshot (core/sfm/liveSnapshot.js) as a cloud the 3D view can draw. An
  // aerial model is turned Z-up as the finished one will be, so the view does not
  // flip at the end.
  function showLive({ cameras: list, pos, col }) {
    const n = pos.length / 3
    let cameras = new Map(list.map(({ uuid, R, t, K }) => [uuid, { R, t, K }]))
    let points = new SparsePoints({
      pos,
      col,
      vcount: new Uint32Array(n),
      vcam: new Uint32Array(0),
      vkp: new Uint32Array(0),
    })
    if (projects.currentSceneType === 'aerial' && cameras.size >= 2) {
      const R = aerialUpRotation(cameras)
      if (R) ({ cameras, points } = rotateReconstruction(cameras, points, R, { inPlace: true }))
    }
    liveSparse.value = { cameras: markRaw(cameras), points: markRaw(points) }
  }

  return {
    surveyConstraintInput,
    reconstruct,
  }
}
