import { linearCrsUnit, ensureProjection, transform } from '../core/crs.js'
import { shiftRange } from '../core/verticalDatum.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
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
import { useExternalStore } from '../stores/useExternalStore.js'
import { useFootprintsStore } from '../stores/useFootprintsStore.js'
import { polygonAreaTest } from '../core/products/vectorLayers.js'
import { sparseModelStats } from '../core/eval/sparseStats.js'
import { completedMatchGraphHealth } from '../core/eval/matchGraph.js'
import { perImageResiduals, unregisteredReason } from '../core/eval/imageStats.js'
import { sampleDemAtGcpsFull } from '../utils/demCogSample.js'
import { compareDemToReference } from '../core/eval/demCompare.js'
import { rasterUnits } from '../core/products/rasterUnits.js'
import { focalDelta } from '../core/eval/calibration.js'
import { projectHealth } from '../core/eval/health.js'
import { estimatedIntrinsics } from '../core/sfm/cameraEstimated.js'
import { resolveK } from '../core/sfm/reconstruction.js'
import { buildReportHtml } from '../core/products/report.js'
import { methodsUsed } from '../core/help/methodsUsed.js'
import { citeShort, formatReference } from '../core/help/references.js'
import { isFisheyeModel } from '../core/sfm/distortion.js'
import { buildProjectDigest, digestToMarkdown, digestToJson } from '../core/eval/summaryDigest.js'
import { buildVerdict } from '../core/sfm/verdict.js'
import {
  featureHasher,
  matchHasher,
  featureRows,
  matchRows,
  FINGERPRINT_ALGORITHM,
} from '../core/eval/runFingerprint.js'

// Role → report label. 'marker' is a scale-bar endpoint (no surveyed position),
// so a binary control/check ternary would silently mislabel it as ground control.
const ROLE_LABEL = { control: 'Control', check: 'Check', marker: 'Marker' }

// DEM vs reference DEM: one comparison, cached at module scope so reopening the hub,
// switching sections and the HTML export reuse it. Keyed on everything that moves
// the numbers: the DEM build, the reference raster, its vertical offset and CRS.
let demRefCache = null // { key, promise }
let demRefLastRasterId = null
let demRefLastFilters = {} // { stableSetId, areaSetId }: the hub's last choice, for the export

export function useQualityReport() {
  const recon = useReconstructionStore()
  const imagesStore = useImagesStore()
  const matchesStore = useMatchesStore()
  const sensorsStore = useSensorsStore()
  const gcpsStore = useGcpsStore()
  const external = useExternalStore()

  const cameras = computed(() => recon.sparseCameras)
  const points = computed(() => recon.mainSparseCloud?.points ?? [])
  const imageIds = computed(() => imagesStore.images.map((im) => im.uuid))
  const nameByUuid = computed(() => new Map(imagesStore.images.map((im) => [im.uuid, im.name])))
  const projects = useProjectsStore()
  const crsUnit = computed(() => linearCrsUnit(projects.currentCrs))

  // Heavy per-model statistics, computed once per model and shared by every section,
  // the export and the digest (core/eval/sparseStats.js memoises on the model's
  // identity) — not once per section mount, and nothing until the hub reads them.
  const modelStats = computed(() => sparseModelStats(cameras.value, points.value))
  const reproj = computed(() => modelStats.value.reproj)
  const histogram = computed(() => modelStats.value.histogram)
  const perImage = computed(() => modelStats.value.perImage)
  const coverage = computed(() => modelStats.value.coverage)

  // Null before matching has produced any terminal result; an empty accepted
  // graph after a completed run remains a real (split) result.
  const graph = computed(() => completedMatchGraphHealth(matchesStore.matchStore.values(), imageIds.value))

  const selfCal = computed(() => recon.summary?.selfCalDistortion ?? null)

  // Per-sensor refined-vs-nominal focal (reused by the calibration section + health).
  const sensorRows = computed(() => {
    const cams = cameras.value
    return sensorsStore.sensors
      .map((sensor) => {
        const imgs = imagesStore.images.filter((im) => im.sensorId === sensor.id)
        const cs = imgs.map((im) => cams.get(im.uuid)).filter(Boolean)
        const fxs = cs.map((c) => estimatedIntrinsics(c)?.focal).filter((v) => v != null)
        const refinedFx = fxs.length ? fxs.reduce((a, b) => a + b, 0) / fxs.length : null
        const rep = imgs.find((im) => im.meta) ?? imgs[0]
        const nominal = rep ? resolveK(rep.meta ?? {}, sensor) : null
        const delta = focalDelta(refinedFx, nominal?.fx ?? null)
        return {
          id: sensor.id,
          label: sensor.label,
          nCams: cs.length,
          refinedFx,
          nominalFx: nominal?.fx ?? null,
          delta,
        }
      })
      .filter((r) => r.nCams > 0)
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
    const demCheck = recon.dem && gcps.length ? await sampleDemAtGcpsFull(recon.dem, gcps) : null
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
      gcpReport,
      poseReport,
      demCheck,
      depth: depth.value,
      crsUnit: crsUnit.value,
    }
    // The reports come back with the rows so callers that need both (the export)
    // don't pull them a second time: gcpAccuracyReport re-triangulates every GCP,
    // and two pulls could straddle a mid-edit change and disagree.
    return { snapshot, rows: projectHealth(snapshot), gcpReport, poseReport, demCheck }
  }

  // Computed DEM minus the reference DEM `rasterId`, over their overlap (core/eval/
  // demCompare.js), plus what the reader needs to trust the sign and the units.
  // Throws with a user-facing reason (model-frame DEM, unreadable reference).
  // → null without a DEM or that raster, else { ...comparison, demUnit, refUnit,
  //   reference: { id, name, datum, accuracy, vOffset, conversion }, warnings: string[] }
  //   `filters`: { stableSetId, areaSetId } — polygon layers (useFootprintsStore) that
  //   limit the comparison to stable ground and to an area of interest; the result's
  //   `filters` names them and counts the cells they left out.
  function demReferenceComparison(rasterId, filters = demRefLastFilters) {
    const dem = recon.dem
    const meta = external.rasterById(rasterId)
    if (!dem || !meta || meta.kind !== 'dem') return Promise.resolve(null)
    demRefLastRasterId = rasterId
    demRefLastFilters = filters
    const footprints = useFootprintsStore()
    const layer = (id) => (id ? (footprints.sets.find((s) => s.id === id) ?? null) : null)
    const stable = layer(filters.stableSetId),
      area = layer(filters.areaSetId)
    const key = [
      stable ? `${stable.id}:${stable.footprints.length}` : '',
      area ? `${area.id}:${area.footprints.length}` : '',
      dem.createdAt,
      dem.width,
      dem.height,
      dem.crs,
      meta.id,
      meta.crs,
      meta.vOffset || 0,
      meta.planeStyleStamp ?? '',
      dem.verticalDatum ?? '',
      meta.verticalDatum ?? '',
    ].join('|')
    if (demRefCache?.key === key) return demRefCache.promise
    const promise = (async () => {
      // Strict: a reference hole is missing coverage, not a neighbour's height. In
      // the DEM's vertical datum when the reference's converts to it.
      const { sample, conversion } = await external.referenceDemSampler(meta.id, dem.crs ?? null, {
        strict: true,
        datum: dem.verticalDatum ?? null,
      })
      const include = await demLayerTest(dem, [stable, area])
      // A DEM in a CRS is also co-registered (Nuth & Kääb): a horizontal offset against
      // the reference reads as height error on every slope.
      const cmp = await compareDemToReference(dem, sample, {
        include,
        coregister: !!dem.crs && dem.crs !== 'local',
      })
      const demUnit = rasterUnits(dem).vertical
      const refUnit = rasterUnits(meta).vertical
      const warnings = []
      // Only two KNOWN units can disagree: a geographic reference (SRTM, Copernicus
      // in EPSG:4326) has no linear unit to infer its heights from.
      const known = (u) => u === 'm' || u === 'ft' || u === 'US-ft'
      if (known(demUnit) && known(refUnit) && demUnit !== refUnit) {
        warnings.push(
          `The DEM's heights are in ${demUnit} and the reference's in ${refUnit} — the differences mix units.`,
        )
      }
      const demDatum = dem.verticalDatum ?? 'unknown',
        refDatum = meta.verticalDatum || 'unknown'
      // A DEM's datum is unknown unless its control declared one (most camera-GPS
      // fits), so only the reference's missing declaration is worth a warning.
      if (refDatum === 'unknown') {
        warnings.push(
          'The reference DEM declares no vertical datum: a constant bias may be a datum ' +
            'offset (ellipsoidal vs geoid heights differ by tens of metres) rather than an error.',
        )
      } else if (demDatum !== 'unknown' && !conversion && demDatum !== refDatum) {
        warnings.push(
          `The DEM's heights are ${demDatum} and the reference's ${refDatum}, which cannot be converted: ` +
            'a constant bias may be that datum offset.',
        )
      }
      if (!meta.crs) warnings.push("The reference DEM declares no CRS; it is read as if it were in the DEM's frame.")
      return {
        ...cmp,
        demUnit,
        refUnit,
        warnings,
        filters: { stable: stable?.name ?? null, area: area?.name ?? null, excluded: cmp.excluded },
        reference: {
          id: meta.id,
          name: meta.name,
          datum: meta.verticalDatum || 'unknown',
          accuracy: meta.verticalAccuracy ?? null,
          vOffset: meta.vOffset || 0,
          // { from, to, min, max }: the geoid separation added to the reference heights.
          conversion: conversion && Number.isFinite(conversion.min) ? { ...conversion } : null,
        },
      }
    })()
    demRefCache = { key, promise }
    promise.catch(() => {
      if (demRefCache?.promise === promise) demRefCache = null
    })
    return promise
  }

  // A cell test for the comparison: inside every given polygon layer (null entries
  // skipped). Layers are stored in the project CRS; the DEM may be in another one.
  async function demLayerTest(dem, layers) {
    const tests = []
    const crs = projects.currentCrs
    for (const set of layers) {
      if (!set) continue
      if (!dem.crs || dem.crs === 'local') throw new Error('Limiting the comparison to a layer needs a DEM in a CRS')
      let polygons = set.footprints.map((f) => f.rings)
      if (crs && dem.crs !== crs) {
        await Promise.all([ensureProjection(crs), ensureProjection(dem.crs)])
        polygons = polygons.map((rings) => rings.map((ring) => ring.map((p) => transform(p, crs, dem.crs))))
      }
      tests.push(polygonAreaTest(polygons))
    }
    return tests.length ? (x, y) => tests.every((t) => t(x, y)) : null
  }

  // The headline tiles for a comparison — the hub section and the export share them.
  function demReferenceTiles(cmp) {
    const s = cmp?.stats
    const u = cmp?.demUnit
    const f = (v) => (v == null ? '—' : v.toFixed(3))
    const signed = (v) => (v == null ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(3)}`)
    const overlap = cmp?.demCells ? (cmp.compared / cmp.demCells) * 100 : null
    const sigma = cmp?.reference?.accuracy
    // A bias is worth flagging once it stands out of the noise: larger than the
    // spread of the differences and than what the reference itself claims.
    const biasLoud = s && Math.abs(s.median) > Math.max(s.nmad, sigma ?? 0)
    return [
      {
        label: 'Median ΔZ',
        value: signed(s?.median),
        unit: u,
        tone: s ? (biasLoud ? 'warn' : undefined) : undefined,
        hint: 'robust bias (DEM − reference)',
      },
      {
        label: 'NMAD',
        value: f(s?.nmad),
        unit: u,
        hint: sigma != null ? `robust spread · reference σ ${sigma}` : 'robust spread (≈σ)',
      },
      { label: 'RMSE', value: f(s?.rmse), unit: u, hint: 'includes bias and blunders' },
      { label: 'Mean ± std', value: s ? `${signed(s.mean)} ± ${f(s.std)}` : '—', unit: u },
      { label: 'LE90', value: f(s?.le90), unit: u, hint: '90 % of |ΔZ| are below' },
      { label: 'Min / max', value: s ? `${signed(s.min)} / ${signed(s.max)}` : '—', unit: u },
      {
        label: 'Overlap',
        value: overlap == null ? '—' : overlap.toFixed(1),
        unit: '%',
        tone: overlap != null && overlap < 50 ? 'warn' : undefined,
        hint: `${(cmp?.compared ?? 0).toLocaleString()} of ${(cmp?.demCells ?? 0).toLocaleString()} DEM cells`,
      },
      // Nuth & Kääb: where the DEM sits against the reference, and its spread once
      // moved there. A large offset with a much smaller NMAD after it is a
      // georeferencing offset (control from another reference), not a noisy surface.
      ...(cmp?.coreg
        ? [
            {
              label: 'Horizontal offset',
              value: `E ${signed(cmp.coreg.shift[0])}, N ${signed(cmp.coreg.shift[1])}`,
              unit: u,
              tone: Math.hypot(...cmp.coreg.shift) > Math.max(s?.nmad ?? 0, sigma ?? 0) ? 'warn' : undefined,
              hint: 'DEM relative to the reference (Nuth & Kääb co-registration)',
            },
            {
              label: 'NMAD after shift',
              value: f(cmp.coreg.nmadAfter),
              unit: u,
              hint: `slopes 5–45°: ${f(cmp.coreg.nmadBefore)} before; bias ${signed(cmp.coreg.bias)} after`,
            },
          ]
        : []),
      // A DEM with a support layer: the error where points landed against where the
      // gaps were interpolated, which is usually where the large errors are.
      ...(cmp?.bySupport
        ? [
            {
              label: 'RMSE direct / interp.',
              value: `${f(cmp.bySupport.direct?.rmse)} / ${f(cmp.bySupport.interpolated?.rmse)}`,
              unit: u,
              hint: `${(cmp.bySupport.direct?.n ?? 0).toLocaleString()} cells with points, ${(cmp.bySupport.interpolated?.n ?? 0).toLocaleString()} interpolated`,
            },
          ]
        : []),
    ]
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
        { key: 'name', label: 'Image' },
        { key: 'nObs', label: 'Obs', align: 'right' },
        { key: 'rms', label: 'RMS px', align: 'right' },
      ],
      rows: perImage.value
        .filter((r) => r.rmsPx != null)
        .sort((a, b) => b.rmsPx - a.rmsPx)
        .slice(0, 20)
        .map((r) => ({ name: nameByUuid.value.get(r.uuid) ?? r.uuid, nObs: r.nObs, rms: f2(r.rmsPx) })),
      note: 'Top 20 images by reprojection RMS.',
    })

    // Calibration
    if (sensorRows.value.length) {
      sections.push({
        title: 'Calibration',
        columns: [
          { key: 'label', label: 'Sensor' },
          { key: 'cams', label: 'Cams', align: 'right' },
          { key: 'refined', label: 'Refined fx', align: 'right' },
          { key: 'nominal', label: 'Nominal fx', align: 'right' },
          { key: 'delta', label: 'Δ%', align: 'right' },
        ],
        rows: sensorRows.value.map((s) => ({
          label: s.label,
          cams: s.nCams,
          refined: f2(s.refinedFx, 1),
          nominal: f2(s.nominalFx, 1),
          delta: s.delta.deltaPct == null ? '—' : s.delta.deltaPct.toFixed(1),
        })),
      })
    }

    // Accuracy (GCP)
    if (gcpReport?.length) {
      sections.push({
        title: 'Control and checkpoint accuracy',
        columns: [
          { key: 'name', label: 'Point' },
          { key: 'role', label: 'Role' },
          { key: 'views', label: 'Views', align: 'right' },
          { key: 'dTotal', label: 'Δ total', align: 'right' },
          { key: 'normalized', label: 'Normalized', align: 'right' },
          { key: 'loo', label: 'LOO Δ', align: 'right' },
        ],
        rows: gcpReport.map((g) => ({
          name: g.name,
          role: ROLE_LABEL[g.role] ?? 'Control',
          views: g.viewCount,
          dTotal: f2(g.dTotal, 3),
          normalized: g.normalized == null ? '—' : `${g.normalized.toFixed(2)}σ`,
          loo: f2(g.looTotal, 3),
        })),
        note: `Checkpoints are independent; leave-one-out (LOO) predicts each control from the others. Normalized residuals divide by the residual's own uncertainty (${crsUnit.value}): a control's declared covariance less what the fit absorbs, a checkpoint's or a LOO prediction's declared covariance plus the fit's own.`,
      })
    }

    // Scale bars (D6). Present whenever bars exist — including in a georeferenced
    // project, where they are independent checks against the CRS fit, and
    // including bars excluded from the fit or not measurable, each with its reason.
    // A bar that vanishes from the report takes the user's measurement with it.
    const resolvedFrame = await recon.effectiveFrameSpec()
    const barRows = await recon.scaleBarReport(resolvedFrame.unit !== 'model' ? resolvedFrame.scale : null)
    if (barRows.length) {
      const src = resolvedFrame.source
      sections.push({
        title: 'Scale constraints',
        tiles: [
          {
            label: 'Scale source',
            value: src === 'georef' ? 'Georeference' : src === 'scalebars' ? 'Scale bars' : 'None',
          },
          {
            label: 'Metres per model unit',
            value: resolvedFrame.unit !== 'model' ? resolvedFrame.scale.toPrecision(6) : '—',
          },
          { label: 'Bars', value: String(barRows.length) },
        ],
        columns: [
          { key: 'name', label: 'Bar' },
          { key: 'used', label: 'In fit' },
          { key: 'known', label: 'Known', align: 'right' },
          { key: 'sigma', label: '± 1σ', align: 'right' },
          { key: 'measured', label: 'Measured', align: 'right' },
          { key: 'residual', label: 'Residual', align: 'right' },
          { key: 'normalized', label: 'Normalized', align: 'right' },
        ],
        rows: barRows.map((b) => ({
          name: b.name,
          used: b.enabled ? 'yes' : 'no',
          known: b.knownDistanceM == null ? '—' : `${b.knownDistanceM.toPrecision(6)} m`,
          sigma: b.accuracyM == null ? 'equal weight' : `${b.accuracyM.toPrecision(3)} m`,
          measured: b.measuredM == null ? '—' : `${b.measuredM.toPrecision(6)} m`,
          residual:
            b.residualM == null
              ? (b.reason ?? '—')
              : `${b.residualM >= 0 ? '+' : '−'}${Math.abs(b.residualM).toPrecision(3)} m`,
          normalized: b.normalizedResidual == null ? '—' : `${b.normalizedResidual.toFixed(2)}σ`,
        })),
        note:
          src === 'georef'
            ? 'The georeference defines the scale; these bars are independent checks against it.'
            : 'Residuals are measured minus entered. Bars with no declared 1σ are equally weighted, not surveyed.',
      })
    }

    // DEM vs reference DEM — the one the hub last compared, else the only one. A
    // failed comparison is reported in place rather than failing the export.
    const refId =
      demRefLastRasterId && external.rasterById(demRefLastRasterId) ? demRefLastRasterId : external.defaultDem?.id
    if (recon.dem && refId) {
      try {
        const cmp = await demReferenceComparison(refId)
        if (cmp) {
          sections.push({
            title: `DEM vs reference DEM (${cmp.reference.name})`,
            tiles: demReferenceTiles(cmp),
            note: [
              'ΔZ = DEM − reference at each compared DEM cell' +
                (cmp.step > 1 ? ` (every ${cmp.step}th cell each way)` : '') +
                (cmp.filters.stable ? `, on the stable ground of "${cmp.filters.stable}"` : '') +
                (cmp.filters.area ? `, inside "${cmp.filters.area}"` : '') +
                `; reference vertical datum: ${cmp.reference.datum}` +
                (cmp.reference.conversion
                  ? `, converted to the DEM's ${cmp.reference.conversion.to} by adding the geoid ` +
                    `separation (${shiftRange(cmp.reference.conversion)})`
                  : '') +
                '.',
              ...cmp.warnings,
            ].join(' '),
          })
        }
      } catch (err) {
        sections.push({ title: 'DEM vs reference DEM', note: `Not compared: ${err?.message ?? err}` })
      }
    }

    // Methods and references: what this project's run used, with the papers it follows
    // (core/help/methodsUsed.js) — the part of a methods section a paper would cite.
    const methods = methodsUsed({
      detector: imagesStore.images.find((im) => im.kpStatus === 'done')?.detector ?? null,
      matcher: matchesStore.matchRun?.matcher ?? null,
      verifier: matchesStore.matchRun?.settings?.verifier ?? null,
      sparse: cameras.value.size > 0,
      fisheye:
        sensorsStore.sensors.some((x) => isFisheyeModel(x.distortionModel)) ||
        (recon.summary?.selfCalDistortion ?? []).some((d) => d.fisheye),
      georef: !!recon.georef,
      dense: recon.clouds.some((c) => c.kind === 'dense' && !c.imported),
      mesh: recon.clouds.some((c) => c.kind === 'mesh' && !c.imported),
      textured: recon.clouds.some((c) => c.kind === 'mesh' && !c.imported && c.texture),
      dem: !!recon.dem,
      demFill: recon.dem?.fillMethod ?? null,
      ortho: recon.ortho ? (recon.ortho.method ?? {}) : null,
    })
    if (methods.length) {
      const keys = [...new Set(methods.flatMap((m) => m.refs))]
      sections.push({
        title: 'Methods and references',
        columns: [
          { key: 'step', label: 'Step' },
          { key: 'method', label: 'Method' },
          { key: 'refs', label: 'After' },
        ],
        rows: methods.map((m) => ({ step: m.step, method: m.method, refs: m.refs.map(citeShort).join('; ') })),
      })
      sections.push({
        title: 'References',
        columns: [{ key: 'ref', label: 'Reference' }],
        rows: keys.map((k) => ({ ref: formatReference(k) })).sort((a, b) => a.ref.localeCompare(b.ref)),
      })
    }

    return buildReportHtml({
      projectName,
      date: new Date().toISOString(),
      crsUnit: crsUnit.value,
      health: rows,
      sections,
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
    const keys = ['maxDim', 'maxDimMode', 'maxKeypoints', 'contrastThreshold', 'tiling', 'maxOrientations', 'capRule']
    const mixed = !!first && recorded.some((im) => keys.some((k) => im.detectSettings[k] !== first[k]))
    // Share of images that hit the keypoint cap. When this is high the cap — not
    // `contrastThreshold` — is what selected the keypoints, by `capRule` (by response
    // before 2026-10, which biased toward fine high-contrast texture). The
    // digest prints medianKeypoints and maxKeypoints side by side, but "they are equal"
    // is the observation that matters and nobody reads two numbers for it. Only
    // computable per-image (each image's own recorded cap), so a mixed batch is still
    // counted correctly.
    const capped = recorded.filter(
      (im) => im.detectSettings.maxKeypoints > 0 && (im.kpCount ?? 0) >= im.detectSettings.maxKeypoints,
    )
    return {
      detector: withKp[0].detector ?? 'sift',
      images: withKp.length,
      ...(first
        ? {
            maxDim: first.maxDim,
            maxDimMode: first.maxDimMode,
            maxKeypoints: first.maxKeypoints,
            contrastThreshold: first.contrastThreshold,
            tiling: first.tiling,
            // Absent on pre-2026-10 detections ⇒ stays undefined ⇒ rendered as unknown.
            ...(first.maxOrientations != null ? { maxOrientations: first.maxOrientations } : {}),
            ...(first.capRule != null ? { capRule: first.capRule } : {}),
          }
        : {}),
      medianKeypoints: med(withKp.map((im) => im.kpCount ?? null)),
      medianDetectScale: med(withKp.map((im) => im.detectScale ?? null)),
      // null (not 0) when no image carries a detect record — "unknown", never "none".
      kpCapHitPct: recorded.length ? (100 * capped.length) / recorded.length : null,
      mixed,
    }
  })

  // The compact copy-pasteable digest (PLAN-debug-summary): the same classified health
  // rows as the hub, plus top offenders + run figures, in ONE structured object the two
  // renderers turn into markdown or JSON. Async for the GCP report (via computeHealth).
  // Feature + match fingerprints (core/eval/runFingerprint.js) over data that is on
  // disk: keypoints read image by image, matches streamed pair by pair, in the
  // fingerprint's own order — never all resident at once.
  async function runFingerprints() {
    const features = featureHasher()
    for (const im of featureRows(imagesStore.images)) features.add(im, await imagesStore.readKeypoints(im))
    const matches = matchHasher()
    await matchesStore.streamPairMatches(matchRows(matchesStore.matchStore.values()), (e, m) => matches.add(e, m))
    return { algorithm: FINGERPRINT_ALGORITHM, features: features.digest(), matches: matches.digest() }
  }

  async function computeDigest(projectName) {
    const { snapshot, rows } = await computeHealth()

    // Top offenders — worst images by reprojection RMS + unregistered-with-reason.
    const residuals = perImage.value
      .filter((r) => r.rmsPx != null)
      .sort((a, b) => b.rmsPx - a.rmsPx)
      .slice(0, 10)
      .map((r) => ({ name: nameByUuid.value.get(r.uuid) ?? r.uuid, nObs: r.nObs, rmsPx: r.rmsPx }))

    const g = graph.value
    const unregistered = imagesStore.images
      .filter((im) => !cameras.value.has(im.uuid))
      .map((im) => ({
        name: im.name,
        reason:
          unregisteredReason({
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
            ? focalDeltas.value.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a))
            : null,
          depthCoveragePct: snapshot.depth?.coveragePct ?? null,
          selfCalResolved: recon.summary?.selfCal?.resolved ?? null,
          separateSecondaryModels: recon.summary?.secondaryRecovery?.separate?.length ?? 0,
          unregistered,
          // Contributing-cause inputs (see verdict.js): the resolved gates and the
          // detection/matching shape behind them. All optional — an older run that
          // recorded none of these simply skips those rules.
          filterMaxReprojPx: recon.summary?.gates?.filterMaxReprojPx ?? null,
          detectScaleFactor: recon.summary?.gates?.detectScaleFactor ?? null,
          maxDim: detectConfig.value?.maxDim ?? null,
          maxKeypoints: detectConfig.value?.maxKeypoints ?? null,
          kpCapHitPct: detectConfig.value?.kpCapHitPct ?? null,
          guidedSkippedForMemory: !!recon.summary?.guidedExtension?.some?.((g) => g.skipped === 'memory'),
        })
      : null

    const digest = buildProjectDigest({
      projectName,
      date: new Date().toISOString(),
      crsUnit: crsUnit.value,
      rows,
      snapshot,
      offenders: { residuals, unregistered },
      summary: recon.summary ?? null,
      denseSummary: recon.denseSummary ?? null,
      // The Stage A record describes a depth-map set; suppress it once that set is
      // gone (a stale-stamp discard clears the maps but not the summary).
      depthSummary: recon.depthMapCount ? (recon.depthSummary ?? null) : null,
      detect: detectConfig.value,
      matchRun: matchesStore.matchRun ?? null,
      // Unreadable feature data leaves the fingerprints absent, never the digest.
      fingerprints: await runFingerprints().catch(() => ({
        algorithm: FINGERPRINT_ALGORITHM,
        features: null,
        matches: null,
      })),
      // Recorded as-is. A fit whose evidence has moved is still what this project
      // last computed, and the digest is the record; the *resolver* is what refuses
      // to hand stale metres to a product.
      scaleFit: recon.scaleFit ?? null,
      verdict,
    })
    return { digest, markdown: digestToMarkdown(digest), json: digestToJson(digest) }
  }

  // Move the control onto the reference DEM: shift every control and check point by the
  // co-registration offset (in the DEM's CRS), refill its height from that DEM at the new
  // position, and refit. For control whose positions came from another reference than
  // its heights (Find GCPs: a satellite image and a DEM), which the DEM then inherits as
  // an offset. → { moved, filled }.
  async function alignControlToReference(refId, coreg) {
    const dem = recon.dem,
      crs = projects.currentCrs
    if (!dem?.crs || dem.crs === 'local' || !coreg) throw new Error('Needs a co-registered DEM in a CRS')
    await Promise.all([ensureProjection(crs), ensureProjection(dem.crs)])
    const [dx, dy] = coreg.shift
    const move = (x, y) => {
      const [u, v] = transform([x, y], crs, dem.crs)
      return transform([u - dx, v - dy], dem.crs, crs)
    }
    const ids = gcpsStore.gcps.filter((g) => g.role !== 'marker').map((g) => g.id)
    const moved = gcpsStore.moveGcps(move, {
      ids,
      reason: `by E ${(-dx).toFixed(2)}, N ${(-dy).toFixed(2)} onto the reference DEM`,
    })
    const filled = await gcpsStore.fillZFromReferenceDem(
      (x, y, o) => external.sampleReferenceDem(x, y, { ...o, rasterId: refId }),
      { ids, overwrite: true },
    )
    await recon.georeference()
    return { moved, filled }
  }

  return {
    alignControlToReference,
    cameras,
    points,
    imageIds,
    nameByUuid,
    crsUnit,
    reproj,
    histogram,
    perImage,
    coverage,
    graph,
    selfCal,
    sensorRows,
    focalDeltas,
    depth,
    perImageResiduals,
    unregisteredReason,
    detectConfig,
    computeHealth,
    buildExportReport,
    computeDigest,
    demReferenceComparison,
    demReferenceTiles,
  }
}
