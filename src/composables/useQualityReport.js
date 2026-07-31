// Shared assembly for the Quality Report hub (PLAN-eval-quality-hub). Marshals the
// reactive stores into the PLAIN snapshot the pure `core/eval/*` fns consume, so the
// Overview health rows and the exported HTML report are built from ONE source and
// cannot drift. Sync pieces are reactive computeds; the async pieces (the GCP report)
// are pulled on demand, keyed on `recon.healthDirty` so a GCP prune refreshes them.

import { computed } from 'vue'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useMatchesStore } from '../stores/useMatchesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useGcpsStore } from '../stores/useGcpsStore.js'
import { reprojectionStats, trackLengthHistogram } from '../core/eval/reconStats.js'
import { completedMatchGraphHealth } from '../core/eval/matchGraph.js'
import { perImageResiduals, unregisteredReason } from '../core/eval/imageStats.js'
import { sampleDemAtGcps } from '../core/eval/demCheck.js'
import { focalDelta } from '../core/eval/calibration.js'
import { projectHealth } from '../core/eval/health.js'
import { estimatedIntrinsics } from '../core/sfm/cameraEstimated.js'
import { resolveK } from '../core/sfm/reconstruction.js'
import { buildReportHtml } from '../core/products/report.js'
import { buildProjectDigest, digestToMarkdown, digestToJson } from '../core/eval/summaryDigest.js'
import { buildVerdict } from '../core/sfm/verdict.js'
import { buildRunFingerprints } from '../core/eval/runFingerprint.js'

export function useQualityReport() {
  const recon = useReconstructionStore()
  const imagesStore = useImagesStore()
  const matchesStore = useMatchesStore()
  const sensorsStore = useSensorsStore()
  const gcpsStore = useGcpsStore()

  const cameras = computed(() => recon.sparseCameras)
  const points = computed(() => recon.mainSparseCloud?.points ?? [])
  const imageIds = computed(() => imagesStore.images.map((im) => im.uuid))
  const nameByUuid = computed(() => new Map(imagesStore.images.map((im) => [im.uuid, im.name])))
  const crsUnit = computed(() => recon.dem?.unit || 'm')

  const reproj = computed(() => reprojectionStats(cameras.value, points.value))
  const histogram = computed(() => trackLengthHistogram(points.value))

  // Null before matching has produced any terminal result; an empty accepted
  // graph after a completed run remains a real (split) result.
  const graph = computed(() =>
    completedMatchGraphHealth(matchesStore.matchStore.values(), imageIds.value))

  const selfCal = computed(() => recon.summary?.selfCalDistortion ?? null)

  // Per-sensor refined-vs-nominal focal (reused by the calibration section + health).
  const sensorRows = computed(() => {
    const cams = cameras.value
    return sensorsStore.sensors.map((sensor) => {
      const imgs = imagesStore.images.filter((im) => im.sensorId === sensor.id)
      const cs = imgs.map((im) => cams.get(im.uuid)).filter(Boolean)
      const fxs = cs.map((c) => estimatedIntrinsics(c)?.focal).filter((v) => v != null)
      const refinedFx = fxs.length ? fxs.reduce((a, b) => a + b, 0) / fxs.length : null
      const rep = imgs.find((im) => im.meta) ?? imgs[0]
      const nominal = rep ? resolveK(rep.meta ?? {}, sensor) : null
      const delta = focalDelta(refinedFx, nominal?.fx ?? null)
      return { id: sensor.id, label: sensor.label, nCams: cs.length, refinedFx, nominalFx: nominal?.fx ?? null, delta }
    }).filter((r) => r.nCams > 0)
  })
  const focalDeltas = computed(() => sensorRows.value.map((r) => r.delta.deltaPct))

  // Mean per-map valid-depth coverage %, from the index meta (or live planes).
  const depth = computed(() => {
    const meta = recon.depthMapsMeta
    let rows = []
    if (meta.length) {
      rows = meta.map((m) => ({ valid: m.validPx, px: m.width * m.height }))
    } else {
      rows = [...recon.depthMaps.values()].map((m) => {
        let valid = 0
        for (let i = 0; i < (m.depth?.length ?? 0); i++) if (m.depth[i] > 0) valid++
        return { valid, px: m.width * m.height }
      })
    }
    if (!rows.length) return null
    const pcts = rows.filter((r) => r.valid != null && r.px).map((r) => (r.valid / r.px) * 100)
    if (!pcts.length) return { coveragePct: null, mapCount: recon.depthMapCount }
    return { coveragePct: pcts.reduce((a, b) => a + b, 0) / pcts.length, mapCount: recon.depthMapCount }
  })

  // Async pull of the georef-dependent reports (GCP is async; pose/DEM are sync but
  // gated on the same georef, so grouped here). Returns the parts, keyed on caller.
  async function georefReports() {
    if (!recon.georef) return { gcpReport: null, poseReport: null, demCheck: null }
    const gcpReport = await recon.gcpAccuracyReport()
    const poseReport = recon.poseResidualReport()
    const gcps = gcpsStore.gcps.filter((g) => g.enabled !== false && g.x != null && g.y != null)
    const demCheck = recon.dem && gcps.length ? sampleDemAtGcps(recon.dem, gcps) : null
    return { gcpReport, poseReport, demCheck }
  }

  // The full plain snapshot for projectHealth + the health rows. Async for the GCP
  // report; call on hub open and whenever recon.healthDirty changes.
  async function computeHealth() {
    const { gcpReport, poseReport, demCheck } = await georefReports()
    const snapshot = {
      imageCount: imagesStore.images.length,
      registeredCount: cameras.value.size,
      reproj: points.value.length ? reproj.value : null,
      histogram: points.value.length ? histogram.value : null,
      graph: graph.value,
      selfCal: selfCal.value,
      focalDeltas: focalDeltas.value.length ? focalDeltas.value : null,
      gcpReport, poseReport, demCheck,
      depth: depth.value,
      crsUnit: crsUnit.value,
    }
    // The reports come back with the rows so callers that need both (the export)
    // don't pull them a second time: gcpAccuracyReport re-triangulates every GCP,
    // and two pulls could straddle a mid-edit change and disagree.
    return { snapshot, rows: projectHealth(snapshot), gcpReport, poseReport, demCheck }
  }

  // Assemble the full export report object (plain) for buildReportHtml — same numbers
  // the hub shows. Async for the GCP report.
  async function buildExportReport(projectName) {
    const { rows, gcpReport } = await computeHealth()
    const f2 = (v, d = 2) => (v == null ? '—' : v.toFixed(d))
    const sections = []

    // Sparse
    const d = reproj.value
    sections.push({
      title: 'Sparse reconstruction',
      tiles: [
        { label: 'Registered', value: `${cameras.value.size} / ${imagesStore.images.length}` },
        { label: 'Points', value: points.value.length.toLocaleString() },
        { label: 'Reproj median', value: f2(d.median), unit: 'px' },
        { label: 'Reproj P95', value: f2(d.p95), unit: 'px' },
        { label: 'Reproj max', value: f2(d.max), unit: 'px' },
        { label: 'Observations', value: (d.n ?? 0).toLocaleString() },
      ],
      columns: [
        { key: 'name', label: 'Image' }, { key: 'nObs', label: 'Obs', align: 'right' },
        { key: 'rms', label: 'RMS px', align: 'right' },
      ],
      rows: perImageResiduals(cameras.value, points.value)
        .filter((r) => r.rmsPx != null)
        .sort((a, b) => b.rmsPx - a.rmsPx).slice(0, 20)
        .map((r) => ({ name: nameByUuid.value.get(r.uuid) ?? r.uuid, nObs: r.nObs, rms: f2(r.rmsPx) })),
      note: 'Top 20 images by reprojection RMS.',
    })

    // Calibration
    if (sensorRows.value.length) {
      sections.push({
        title: 'Calibration',
        columns: [
          { key: 'label', label: 'Sensor' }, { key: 'cams', label: 'Cams', align: 'right' },
          { key: 'refined', label: 'Refined fx', align: 'right' },
          { key: 'nominal', label: 'Nominal fx', align: 'right' },
          { key: 'delta', label: 'Δ%', align: 'right' },
        ],
        rows: sensorRows.value.map((s) => ({
          label: s.label, cams: s.nCams, refined: f2(s.refinedFx, 1), nominal: f2(s.nominalFx, 1),
          delta: s.delta.deltaPct == null ? '—' : s.delta.deltaPct.toFixed(1),
        })),
      })
    }

    // Accuracy (GCP)
    if (gcpReport?.length) {
      sections.push({
        title: 'GCP accuracy',
        columns: [
          { key: 'name', label: 'GCP' }, { key: 'views', label: 'Views', align: 'right' },
          { key: 'dTotal', label: 'Δ total', align: 'right' },
        ],
        rows: gcpReport.map((g) => ({ name: g.name, views: g.viewCount, dTotal: f2(g.dTotal, 3) })),
        note: `Residual against the ${recon.georef?.method === 'gcps' ? 'GCP' : 'pose'} georeference (${crsUnit.value}).`,
      })
    }

    return buildReportHtml({
      projectName, date: new Date().toISOString(), crsUnit: crsUnit.value,
      health: rows, sections,
    })
  }

  // Detection config for the digest's run-config block. The settings ride on each
  // image (`detectSettings`, recorded at detect time), so reduce them to one row plus
  // a `mixed` flag: a batch CAN be heterogeneous (a re-detect of one image at other
  // settings), and presenting the first image's values as the run's would be a claim
  // the data doesn't support. Null when no image carries a record (older projects).
  const detectConfig = computed(() => {
    const withKp = imagesStore.images.filter((im) => im.kpStatus === 'done')
    if (!withKp.length) return null
    const recorded = withKp.filter((im) => im.detectSettings)
    const med = (vals) => {
      const s = vals.filter((v) => v != null).sort((a, b) => a - b)
      return s.length ? s[Math.min(s.length - 1, Math.round(0.5 * (s.length - 1)))] : null
    }
    const first = recorded[0]?.detectSettings ?? null
    const keys = ['maxDim', 'maxDimMode', 'maxKeypoints', 'contrastThreshold', 'tiling']
    const mixed = !!first && recorded.some((im) => keys.some((k) => im.detectSettings[k] !== first[k]))
    return {
      detector: withKp[0].detector ?? 'sift',
      images: withKp.length,
      ...(first
        ? { maxDim: first.maxDim, maxDimMode: first.maxDimMode, maxKeypoints: first.maxKeypoints,
          contrastThreshold: first.contrastThreshold, tiling: first.tiling }
        : {}),
      medianKeypoints: med(withKp.map((im) => im.kpCount ?? null)),
      medianDetectScale: med(withKp.map((im) => im.detectScale ?? null)),
      mixed,
    }
  })

  // The compact copy-pasteable digest (PLAN-debug-summary): the same classified health
  // rows as the hub, plus top offenders + run figures, in ONE structured object the two
  // renderers turn into markdown or JSON. Async for the GCP report (via computeHealth).
  async function computeDigest(projectName) {
    const { snapshot, rows } = await computeHealth()

    // Top offenders — worst images by reprojection RMS + unregistered-with-reason.
    const residuals = perImageResiduals(cameras.value, points.value)
      .filter((r) => r.rmsPx != null)
      .sort((a, b) => b.rmsPx - a.rmsPx)
      .slice(0, 10)
      .map((r) => ({ name: nameByUuid.value.get(r.uuid) ?? r.uuid, nObs: r.nObs, rmsPx: r.rmsPx }))

    const g = graph.value
    const unregistered = imagesStore.images
      .filter((im) => !cameras.value.has(im.uuid))
      .map((im) => ({
        name: im.name,
        reason: unregisteredReason({
          kpCount: im.kpCount ?? null,
          degree: g?.degrees?.get(im.uuid) ?? 0,
          componentIndex: g?.componentIndex?.get(im.uuid) ?? null,
        }) ?? 'unregistered',
      }))
      .slice(0, 20)

    // U6's rule engine over the same snapshot — so the digest states what to DO, not
    // only what happened. Skipped before a sparse run exists (nothing to judge).
    const verdict = recon.summary
      ? buildVerdict({
        imageCount: snapshot.imageCount,
        registeredCount: snapshot.registeredCount,
        nPoints: points.value.length,
        reprojMedianPx: snapshot.reproj?.median ?? null,
        reprojP95px: snapshot.reproj?.p95 ?? null,
        track3ViewPct: recon.summary.pct3plusViewTracks ?? null,
        graphComponents: snapshot.graph?.components ?? null,
        focalDeltaPct: focalDeltas.value.length
          ? focalDeltas.value.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a)) : null,
        depthCoveragePct: snapshot.depth?.coveragePct ?? null,
        selfCalResolved: recon.summary?.selfCal?.resolved ?? null,
        separateSecondaryModels: recon.summary?.secondaryRecovery?.separate?.length ?? 0,
        unregistered,
      })
      : null

    const digest = buildProjectDigest({
      projectName, date: new Date().toISOString(), crsUnit: crsUnit.value,
      rows, snapshot,
      offenders: { residuals, unregistered },
      summary: recon.summary ?? null,
      denseSummary: recon.denseSummary ?? null,
      // The Stage A record describes a depth-map set; suppress it once that set is
      // gone (a stale-stamp discard clears the maps but not the summary).
      depthSummary: recon.depthMapCount ? (recon.depthSummary ?? null) : null,
      detect: detectConfig.value,
      matchRun: matchesStore.matchRun ?? null,
      fingerprints: buildRunFingerprints(imagesStore.images, matchesStore.matchStore.values()),
      verdict,
    })
    return { digest, markdown: digestToMarkdown(digest), json: digestToJson(digest) }
  }

  return {
    cameras, points, imageIds, nameByUuid, crsUnit,
    reproj, histogram, graph, selfCal, sensorRows, focalDeltas, depth,
    perImageResiduals, unregisteredReason,
    detectConfig, computeHealth, buildExportReport, computeDigest,
  }
}
