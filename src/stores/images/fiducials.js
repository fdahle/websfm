import { computeSourceOf } from '../../utils/image.js'
import { makeNameResolver } from '../../core/io/nameMatch.js'
import { observationsToDetections } from '../../core/sfm/fiducialModel.js'
import { detectFiducialSpots as detectFiducialSpotsWorker, POOL_SIZE, prepareFiducialTemplates, detectFiducials, detectReseau,
  growReseau, reseauOverlapScore, stitchReseauFrame } from '../../workers/computeClient.js'
import { reseauLattice, assignReseauIndices, pairReseauHalves, stitchedFrameGeometry } from '../../core/sfm/reseauDetect.js'
import { fitFiducialTransform, applyFiducialTransform } from '../../core/sfm/fiducialCalibration.js'
import { useGcpsStore } from '../useGcpsStore.js'
import { useSensorsStore } from '../useSensorsStore.js'
import { fiducialDetectionConcurrency } from '../../core/features/detectConcurrency.js'
import { fiducialBatchConsensus, fiducialShapeCheck } from '../../core/sfm/fiducialConsensus.js'
import { FIDUCIAL_DETECT_TUNING } from '../../core/sfm/fiducialDetect.js'
import { detectionConfidence } from '../../core/sfm/fiducialDetection.js'
import { buildBorderMask } from '../../core/mask.js'
import { pluralize } from '../../core/textFormat.js'

// Film-scan fiducials on the image records, split out of useImagesStore: detector
// results and hand-placed marks per slot (F4), imported observations, and the
// per-sensor detection run (with its optional frame masks).
// They are clicks or detections on the raster, independent of keypoint indices,
// so re-detecting keypoints never touches them.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createImageFiducials({
  imageById, images, isPersisting, log, save, updateMask, whenComputeReady, addImages = null, removeImage = null,
}) {
  // Bulk-import fiducial observations parsed from a file (F4). `rows` are
  // `[{ imageName, fidId, px, py }]`; each is matched to an image by name
  // (case-insensitive, extension-tolerant) and upserted into the image's
  // fiducialDetections by slot (observationsToDetections: a slot id is kept, a
  // mark id is placed by position). Returns the count applied.
  function addFiducialObservations(rows) {
    let applied = 0, unmatched = 0
    const byImage = new Map()
    const resolve = makeNameResolver(images.value)
    for (const r of rows || []) {
      const img = imageById(resolve(r.imageName))
      if (!img) { unmatched++; continue }
      if (!byImage.has(img)) byImage.set(img, [])
      byImage.get(img).push({ fidId: r.fidId, px: r.px, py: r.py })
    }
    for (const [img, obs] of byImage) {
      if (!Array.isArray(img.fiducialDetections)) img.fiducialDetections = []
      for (const d of observationsToDetections(obs, img.meta?.width, img.meta?.height, { family: 'generic', source: 'import' })) {
        const existing = img.fiducialDetections.find((x) => x.slot === d.slot)
        if (existing) Object.assign(existing, d)
        else img.fiducialDetections.push(d)
        applied++
      }
    }
    log(`Fiducial observations imported: ${applied}${unmatched ? `, ${pluralize(unmatched, 'unmatched image')}` : ''}`,
      applied ? 'success' : 'warn', 'Sensor')
    if (applied && isPersisting()) save()
    return applied
  }

  function setFiducialDetection(imageId, detection) {
    const img = imageById(imageId)
    if (!img || !detection?.slot || !Number.isFinite(detection.px) || !Number.isFinite(detection.py)) return
    if (!Array.isArray(img.fiducialDetections)) img.fiducialDetections = []
    const clean = { slot: String(detection.slot), px: detection.px, py: detection.py,
      family: detection.family ?? 'generic', source: detection.source ?? 'manual',
      confidence: Number.isFinite(detection.confidence) ? detection.confidence : 1,
      reviewed: detection.reviewed !== false }
    const existing = img.fiducialDetections.find((d) => d.slot === clean.slot)
    if (existing) Object.assign(existing, clean)
    else img.fiducialDetections.push(clean)
    if (isPersisting()) save()
  }

  function removeFiducialDetection(imageId, slot) {
    const img = imageById(imageId)
    const i = img?.fiducialDetections?.findIndex((d) => d.slot === slot) ?? -1
    if (i < 0) return false
    img.fiducialDetections.splice(i, 1)
    if (isPersisting()) save()
    return true
  }

  // `shouldCancel` (as detectAll's) is polled between images and between the
  // batch phases; once it returns true no further image is started and NOTHING is
  // written — detections and masks are committed together, synchronously, only
  // after the last check. A worker call already in flight runs to its end, but its
  // result is discarded. A cancelled run resolves to `{ cancelled: true }`.
  async function detectFiducialsForSensor({ sensor, imageIds = null, settings = {}, overwrite = false, onProgress, shouldCancel } = {}) {
    if (!sensor?.id) throw new Error('Choose a film sensor')
    const cancelled = () => !!shouldCancel?.()
    const abandon = () => {
      log('Fiducial detection cancelled — no detections or masks were stored', 'warn', 'Fiducial')
      return { perImage: [], drafts: [], applied: 0, masksGenerated: 0, cancelled: true }
    }
    // Pinia/Vue callers may supply a reactive Proxy. Keep worker input plain even
    // if this action is reused without the compute-client safeguard.
    settings = { ...settings }
    const selected = new Set(imageIds || [])
    const targets = images.value.filter((img) => img.sensorId === sensor.id && (!selected.size || selected.has(img.id)))
    if (!targets.length) return { perImage: [], drafts: [] }
    const buffered = []; let cursor = 0, done = 0
    const drain = async () => {
      while (true) {
        if (cancelled()) return
        const i = cursor++
        if (i >= targets.length) return
        const img = targets[i]
        try {
          await whenComputeReady(img)
          const out = await detectFiducialSpotsWorker(computeSourceOf(img), settings,
            { onLog: (m) => log(`${img.name}: ${m}`, 'info', 'Fiducial') })
          buffered.push({ id: img.id, name: img.name, out })
        } catch (err) {
          log(`${img.name}: fiducial spot detection failed — ${err.message}`, 'error', 'Fiducial')
          buffered.push({ id: img.id, name: img.name, out: { accepted: [], drafts: [], requested: 0, frame: null, ms: 0 }, error: err.message })
        }
        if (cancelled()) return
        onProgress?.(++done, targets.length)
      }
    }
    const concurrency = fiducialDetectionConcurrency(targets, POOL_SIZE, navigator.deviceMemory)
    log(`Fiducial detection: ${pluralize(targets.length, 'image')}, ${concurrency} at a time (full-resolution decode budget)`, 'info', 'Fiducial')
    await Promise.all(Array.from({ length: concurrency }, drain))
    if (cancelled()) return abandon()

    // Both checks judge one unfiltered snapshot (fiducialConsensus.js invariant 1):
    // batch consensus across images, and the per-image opposite-pair shape gate.
    const suspectsOf = () => {
      const consensus = fiducialBatchConsensus(buffered.map((r) => ({
        id: r.id, name: r.name, accepted: r.out.accepted || [],
        frame: r.out.frame, natW: r.out.natW, natH: r.out.natH,
      })))
      const shape = buffered.map((r) => ({ row: r, check: fiducialShapeCheck(r.out.accepted || []) }))
      const keys = new Set([
        ...consensus.outliers.map((o) => `${o.imageId}|${o.slot}`),
        ...shape.flatMap(({ row, check }) => check.outliers.map((o) => `${row.id}|${o.slot}`)),
      ])
      return { consensus, shape, keys }
    }

    // Learn real scan templates from the strongest anonymous detection per slot,
    // then retry incomplete images at the batch-median raster-relative position.
    // This remains detection-only: slots and image geometry, never metric marks.
    // A donor must already agree with the batch and its own image: a confident hit
    // on a data-strip blob would otherwise become the template every retry matches.
    const preliminary = suspectsOf().keys
    const donors = new Map(), normBySlot = new Map()
    for (const row of buffered) for (const d of row.out.accepted || []) {
      if (preliminary.has(`${row.id}|${d.slot}`)) continue
      if (!donors.has(d.slot) || d.confidence > donors.get(d.slot).d.confidence) donors.set(d.slot, { row, d })
      if (!normBySlot.has(d.slot)) normBySlot.set(d.slot, [])
      normBySlot.get(d.slot).push({ x: d.px / row.out.natW, y: d.py / row.out.natH })
    }
    const templates = []
    for (const { row, d } of donors.values()) {
      if (cancelled()) return abandon()
      const img = imageById(row.id)
      if (!img) continue
      try {
        const p = await prepareFiducialTemplates(computeSourceOf(img),
          [{ fidId: d.slot, px: d.px, py: d.py }], { templateHalf: FIDUCIAL_DETECT_TUNING.templateHalf })
        templates.push(...p.templates)
      } catch (err) { log(`${img.name}: donor crop failed — ${err.message}`, 'warn', 'Fiducial') }
    }
    const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
    if (templates.length) for (const row of buffered) {
      if (cancelled()) return abandon()
      if ((row.out.accepted?.length ?? 0) >= (row.out.requested ?? 0)) continue
      const img = imageById(row.id); if (!img) continue
      const have = new Set((row.out.accepted || []).map((d) => d.slot))
      const predictions = templates.flatMap((t) => {
        if (have.has(t.fidId)) return []
        const pts = normBySlot.get(t.fidId); if (!pts?.length) return []
        return [{ fidId: t.fidId, px: median(pts.map((p) => p.x)) * row.out.natW,
          py: median(pts.map((p) => p.y)) * row.out.natH,
          radius: 0.06 * Math.max(row.out.natW, row.out.natH) }]
      })
      if (!predictions.length) continue
      try {
        const retry = await detectFiducials(computeSourceOf(img), templates, predictions,
          { ...FIDUCIAL_DETECT_TUNING, tryRotations: false })
        for (const d of retry.results.filter((x) => x.score >= 0.7)) {
          row.out.accepted.push({ slot: d.fidId, px: d.px, py: d.py, family: settings.family,
            source: 'template', confidence: detectionConfidence(d.score), score: d.score, peakMargin: null, reviewed: false })
          row.out.drafts = (row.out.drafts || []).filter((x) => x.slot !== d.fidId)
        }
      } catch (err) { log(`${img.name}: anonymous template retry failed — ${err.message}`, 'warn', 'Fiducial') }
    }
    // Cross-image agreement, once the whole batch (including the template retry)
    // is in. A mark that disagrees with the rest of the flight is demoted to the
    // review queue — the case a per-image score cannot catch is a wrong-but-confident
    // hit on something else near the slot (a data-strip annotation block).
    const { consensus, shape } = suspectsOf()
    for (const s of consensus.perSlot) {
      if (!s.checked) { log(`Batch consensus: ${s.slot} skipped — only ${pluralize(s.n, 'image')}`, 'debug', 'Fiducial'); continue }
      log(`Batch consensus (${consensus.basis}-relative): ${s.slot} over ${pluralize(s.n, 'image')}, `
        + `spread ${(s.spreadFrac * 100).toFixed(2)}% of frame width, tolerance ${(s.tolFrac * 100).toFixed(2)}%`,
        'debug', 'Fiducial')
    }
    // slot → reason, per image. Batch disagreement wins the label when both fire.
    const dropById = new Map()
    const drop = (id, slot, reason) => {
      if (!dropById.has(id)) dropById.set(id, new Map())
      if (!dropById.get(id).has(slot)) dropById.get(id).set(slot, reason)
    }
    for (const o of consensus.outliers) {
      drop(o.imageId, o.slot, 'batch-outlier')
      log(`${o.imageName ?? o.imageId}: ${o.slot} disagrees with the batch — `
        + `${o.distPx.toFixed(1)} px from the batch position (tolerance ${o.tolPx.toFixed(1)} px); sent to review`,
        'warn', 'Fiducial')
    }
    for (const { row, check } of shape) {
      if (!check.checked) continue
      log(`${row.name}: opposite-mark centres agree within ${check.centreSpreadPx.toFixed(1)} px `
        + `(tolerance ${check.tolPx.toFixed(1)} px)`, 'debug', 'Fiducial')
      if (!check.outliers.length) continue
      for (const o of check.outliers) drop(row.id, o.slot, 'shape-inconsistent')
      log(`${row.name}: ${[...new Set(check.outliers.map((o) => o.slot))].join(', ')} break the layout's symmetry — `
        + `opposite-mark centres ${check.outliers[0].distPx.toFixed(1)} px apart (tolerance ${check.tolPx.toFixed(1)} px); sent to review`,
        'warn', 'Fiducial')
    }
    for (const row of buffered) {
      const reasons = dropById.get(row.id)
      if (!reasons) continue
      row.out.drafts = [...(row.out.drafts || []),
        ...(row.out.accepted || []).filter((d) => reasons.has(d.slot)).map((d) => ({ ...d, reason: reasons.get(d.slot) }))]
      row.out.accepted = (row.out.accepted || []).filter((d) => !reasons.has(d.slot))
    }

    // Frame masks are built first (async, cancellable) so the commit below has no
    // await in it: a cancel either lands before it and nothing is written, or not.
    const maskBlobs = new Map()
    if (settings.generateMasks) for (const row of buffered) {
      if (cancelled()) return abandon()
      const img = imageById(row.id)
      const f = row.out.frame
      if (!img || !(f?.confidence >= 0.06 && row.out.natW > 0 && row.out.natH > 0)) continue
      try {
        const sides = { left: f.left, top: f.top,
          right: row.out.natW - 1 - f.right, bottom: row.out.natH - 1 - f.bottom }
        maskBlobs.set(img.id, await buildBorderMask(row.out.natW, row.out.natH, sides,
          settings.overwrite ? null : img.mask?.blob ?? null))
      } catch (err) { log(`${img.name}: frame mask failed — ${err.message}`, 'warn', 'Fiducial') }
    }
    if (cancelled()) return abandon()

    let applied = 0, masksGenerated = 0
    for (const row of buffered) {
      const img = imageById(row.id)
      if (!img) continue
      if (!Array.isArray(img.fiducialDetections)) img.fiducialDetections = []
      for (const d of row.out.accepted || []) {
        const old = img.fiducialDetections.find((x) => x.slot === d.slot)
        if (old && !overwrite) continue
        const clean = { slot: d.slot, px: d.px, py: d.py, family: d.family,
          source: d.source, confidence: d.confidence, reviewed: false }
        if (old) Object.assign(old, clean); else img.fiducialDetections.push(clean)
        applied++
      }
      if (maskBlobs.has(img.id)) { updateMask(img.id, maskBlobs.get(img.id), true); masksGenerated++ }
    }
    if (applied && isPersisting()) save()
    const perImage = buffered.map((r) => ({ id: r.id, name: r.name,
      accepted: r.out.accepted?.length ?? 0, drafts: r.out.drafts?.length ?? 0,
      requested: r.out.requested ?? 0, confidence: r.out.accepted?.length
        ? r.out.accepted.reduce((s, d) => s + d.confidence, 0) / r.out.accepted.length : 0,
      frameConfidence: r.out.frame?.confidence ?? 0, ms: r.out.ms ?? 0, error: r.error ?? null }))
    return { perImage, drafts: buffered.flatMap((r) => (r.out.drafts || []).map((d) => ({ ...d, imageId: r.id, imageName: r.name }))), applied, masksGenerated }
  }

  // Tools ▸ Images ▾ ▸ Detect reseau (SAT-5): the reseau crosses of every image of a
  // film sensor, at native resolution (workers/ops/detect.js detectReseau). Each image's
  // earlier reseau detections are replaced; other fiducial marks stay. settings:
  // { spacingMm, filmWidthMm, filmHeightMm, armMm, widthMm }, the sensor's scan pitch
  // (`pixelSize`, mm/px) sets the scale. Returns { calibration, perImage }: the caller
  // applies `calibration` to the sensor (useSensorsStore.setFiducialCalibration), which
  // makes reconstruction correct each image by its own 'reseau' fit (ingest.js).
  async function detectReseauForSensor({ sensor, settings, onProgress, shouldCancel } = {}) {
    if (!sensor?.id) throw new Error('Choose a film sensor')
    const pitchMm = Number(sensor.pixelSize)
    if (!(pitchMm > 0)) throw new Error(`Sensor ${sensor.label}: set the scan pixel size (mm/px) first`)
    const { spacingMm, filmWidthMm, filmHeightMm, armMm, widthMm } = settings
    const nodes = reseauLattice({ spacingMm, filmWidthMm, filmHeightMm })
    if (!nodes.length) throw new Error('The reseau spacing and film size give no crosses')
    const targets = images.value.filter((img) => img.sensorId === sensor.id)
    const opts = {
      nodes, pitchMm, armPx: armMm / pitchMm, widthPx: Math.max(1, widthMm / pitchMm),
      // The scan may sit up to ~half a cell off centre; the film deforms by up to ~0.15 mm.
      placePx: 0.45 * spacingMm / pitchMm, refinePx: Math.max(4, Math.ceil(0.15 / pitchMm)),
    }
    const perImage = []
    for (const [k, img] of targets.entries()) {
      if (shouldCancel?.()) { log('Reseau detection cancelled', 'warn', 'Fiducial'); return { calibration: null, perImage, cancelled: true } }
      onProgress?.(k, targets.length, img.name)
      try {
        await whenComputeReady(img)
        const out = await detectReseau(computeSourceOf(img), opts, { onLog: (m, l, c) => log(m, l, c) })
        img.fiducialDetections = [
          ...(img.fiducialDetections || []).filter((d) => d.source !== 'reseau'),
          ...out.detections.map((d) => ({ slot: d.slot, px: d.px, py: d.py, family: 'reseau', source: 'reseau',
            confidence: d.score, reviewed: false })),
        ]
        const byId = new Map(nodes.map((n) => [n.id, n]))
        const fit = fitFiducialTransform(out.detections.map((d) => ({ px: d.px, py: d.py, xMm: byId.get(d.slot).xMm,
          yMm: byId.get(d.slot).yMm })), 'reseau', { spacingMm })
        const row = { id: img.id, name: img.name, found: out.found, of: out.of, placed: out.placed, ms: out.ms,
          affineRmsUm: fit?.affineRmsUm ?? null, rmsUm: fit?.rmsUm ?? null, outliers: fit?.outliers ?? null }
        perImage.push(row)
        log(`${img.name}: reseau ${out.found}/${out.of} crosses`
          + (fit ? `; film deformation ${fit.affineRmsUm.toFixed(1)} µm RMS beyond the scan placement, `
            + `${fit.rmsUm.toFixed(1)} µm left after the correction, ${pluralize(fit.outliers, 'outlier')}` : '; too few to fit')
          + ` (${(out.ms / 1000).toFixed(1)} s)`, fit ? 'info' : 'warn', 'Fiducial')
      } catch (err) {
        perImage.push({ id: img.id, name: img.name, error: err?.message ?? String(err) })
        log(`${img.name}: reseau detection failed — ${err?.message ?? err}`, 'error', 'Fiducial')
      }
    }
    onProgress?.(targets.length, targets.length, '')
    if (isPersisting()) save()
    const prev = sensor.fiducialCalibration
    const focalMm = sensor.focalUnit === 'mm' && sensor.focal > 0 ? sensor.focal : (prev?.focalMm ?? 0)
    const calibration = {
      version: 1, method: 'reseau', transform: 'reseau', allowReflection: false,
      reseau: { spacingMm, filmWidthMm, filmHeightMm, armMm, widthMm },
      marks: nodes.map((n) => ({ id: n.id, xMm: n.xMm, yMm: n.yMm })),
      slotMap: Object.fromEntries(nodes.map((n) => [n.id, n.id])),
      focalMm, ppxMm: prev?.ppxMm ?? 0, ppyMm: prev?.ppyMm ?? 0, scanPitchMm: pitchMm, fit: null,
    }
    return { calibration, perImage }
  }

  // Half-frame scans (SAT-5): `<frame>_a` + `<frame>_b` of a sensor, each frame's two
  // halves stitched into one image on the film grid through their reseau crosses —
  // scanner placement and film deformation removed — added to the project, its GCP
  // marks carried over, the halves removed (`removeHalves`). The stitched frames get a
  // sensor of their own: the certificate focal, the scan pitch, the principal point at
  // the film centre (+ the certificate's offset). settings: { spacingMm, armMm,
  // widthMm }: a half shows every row, and how many columns the halves share is
  // decided by where their scenes agree, so the film size is not needed.
  // → { pairs: [{ stem, ... numbers or error }], stitched: [image] }.
  async function stitchReseauHalvesForSensor({ sensor, settings, removeHalves = true, onProgress, shouldCancel } = {}) {
    const pitchMm = Number(sensor?.pixelSize)
    if (!(pitchMm > 0)) throw new Error(`Sensor ${sensor?.label}: set the scan pixel size (mm/px) first`)
    const { spacingMm, armMm, widthMm } = settings
    const pairs = pairReseauHalves(images.value.filter((img) => img.sensorId === sensor.id))
    if (!pairs.length) throw new Error('No half-frame pairs (<name>_a / <name>_b) among this sensor\'s scans')
    const cell = spacingMm / pitchMm
    const opts = { pitchMm, spacingMm, armPx: armMm / pitchMm, widthPx: Math.max(1, widthMm / pitchMm),
      refinePx: Math.max(4, Math.ceil(0.15 / pitchMm)) }
    const gcpsStore = useGcpsStore(), sensors = useSensorsStore()
    const cal = sensor.fiducialCalibration
    const focalMm = sensor.focalUnit === 'mm' && sensor.focal > 0 ? sensor.focal : (cal?.focalMm ?? 0)
    const out = [], stitched = []
    for (const [k, { stem, a, b }] of pairs.entries()) {
      if (shouldCancel?.()) break
      onProgress?.(k, pairs.length, stem)
      try {
        await Promise.all([whenComputeReady(a), whenComputeReady(b)])
        const [ga, gb] = await Promise.all([growReseau(computeSourceOf(a), opts), growReseau(computeSourceOf(b), opts)])
        const span = (f) => {
          let i0 = Infinity, i1 = -Infinity, j0 = Infinity, j1 = -Infinity
          for (const x of f) { i0 = Math.min(i0, x.di); i1 = Math.max(i1, x.di); j0 = Math.min(j0, x.dj); j1 = Math.max(j1, x.dj) }
          return { cols: i1 - i0 + 1, rows: j1 - j0 + 1 }
        }
        const sa = span(ga.found), sb = span(gb.found)
        if (!ga.found.length || !gb.found.length) throw new Error(`no reseau found on ${ga.found.length ? b.name : a.name}`)
        if (sa.rows !== sb.rows || sa.rows % 2 === 0) throw new Error(`the halves show ${sa.rows} and ${sb.rows} rows of crosses; both need the same odd count (the full height)`)
        const nj = (sa.rows - 1) / 2
        // Every shared-column count the halves allow; the scenes decide.
        const candidates = []
        for (let shared = 1; shared < Math.min(sa.cols, sb.cols); shared++) {
          const total = sa.cols + sb.cols - shared
          if (total % 2 === 0) continue
          const ni = (total - 1) / 2
          const fitOf = (found, side) => {
            const { detections } = assignReseauIndices(found, { side, ni, nj })
            return fitFiducialTransform(detections.map((d) => ({ px: d.px, py: d.py, xMm: d.i * spacingMm, yMm: d.j * spacingMm })),
              'reseau', { spacingMm })
          }
          const fitA = fitOf(ga.found, 'left'), fitB = fitOf(gb.found, 'right')
          if (fitA && fitB) candidates.push({ shared, ni, fitA, fitB })
        }
        if (!candidates.length) throw new Error('the halves\' crosses give no consistent lattice')
        const ni0 = candidates[0].ni
        const geometry0 = stitchedFrameGeometry({ spacingMm, filmWidthMm: 2 * ni0 * spacingMm, filmHeightMm: 2 * nj * spacingMm,
          pitchMm, marginMm: spacingMm / 2 })
        const { scores } = await reseauOverlapScore(computeSourceOf(a), computeSourceOf(b), {
          candidates: candidates.map((c) => ({ fitA: c.fitA, fitB: c.fitB })), geometry: geometry0,
          // The film both halves certainly show: a cell either side of the centre.
          xMm: [-spacingMm, spacingMm],
        })
        const ranked = candidates.map((c, i) => ({ ...c, ncc: scores[i] ?? -1 })).sort((x, y) => y.ncc - x.ncc)
        const best = ranked[0]
        if (!(best.ncc >= 0.5) || (ranked[1] && ranked[1].ncc > best.ncc - 0.15)) {
          throw new Error(`the halves do not agree on one overlap (best scene correlation ${best.ncc.toFixed(2)}`
            + `${ranked[1] ? `, next ${ranked[1].ncc.toFixed(2)}` : ''}) — an edge column of crosses may be missing`)
        }
        const geometry = stitchedFrameGeometry({ spacingMm, filmWidthMm: 2 * best.ni * spacingMm, filmHeightMm: 2 * nj * spacingMm,
          pitchMm, marginMm: spacingMm / 2, ppxMm: cal?.ppxMm ?? 0, ppyMm: cal?.ppyMm ?? 0 })
        // Seam in the middle of the shared columns: between b's leftmost and a's rightmost.
        const seamXMm = ((best.ni - sb.cols + 1) + (-best.ni + sa.cols - 1)) / 2 * spacingMm
        const blob = await stitchReseauFrame(computeSourceOf(a), computeSourceOf(b),
          { fitA: best.fitA, fitB: best.fitB, geometry, seamXMm: Number.isFinite(seamXMm) ? seamXMm : 0 },
          { onLog: (m, l, c) => log(m, l, c), onProgress: (d, t) => onProgress?.(k + d / t, pairs.length, stem) })
        const name = `${stem}.tif`
        const before = new Set(images.value.map((img) => img.id))
        await addImages([new File([blob], name, { type: 'image/tiff' })])
        const frame = images.value.find((img) => !before.has(img.id) && img.name === name)
        // GCP marks: half px → film mm → stitched px (pixel-edge).
        if (frame) {
          for (const g of gcpsStore.gcps) {
            const marks = []
            for (const [img, fit] of [[a, best.fitA], [b, best.fitB]]) {
              const o = g.observations.find((x) => x.imageId === img.id)
              if (!o) continue
              const mm = applyFiducialTransform({ x: o.px, y: o.py }, fit)
              marks.push({ x: (mm.x - geometry.x0Mm) / pitchMm, y: (geometry.y0Mm - mm.y) / pitchMm })
            }
            if (marks.length) gcpsStore.setObservation(g.id, frame.id, frame.name,
              marks.reduce((s0, m) => s0 + m.x, 0) / marks.length, marks.reduce((s0, m) => s0 + m.y, 0) / marks.length)
          }
          stitched.push({ image: frame, geometry })
        }
        const row = { stem, crossesA: ga.found.length, crossesB: gb.found.length, columns: 2 * best.ni + 1, rows: 2 * nj + 1,
          shared: best.shared, ncc: best.ncc, deformationUm: [best.fitA.affineRmsUm, best.fitB.affineRmsUm],
          leftUm: [best.fitA.rmsUm, best.fitB.rmsUm], size: [geometry.width, geometry.height],
          // Each half's scan px → film mm, for a check against a synthetic block's truth.
          fits: [{ name: a.name, forward: best.fitA.forward, residual: best.fitA.residual },
            { name: b.name, forward: best.fitB.forward, residual: best.fitB.residual }] }
        out.push(row)
        log(`${stem}: stitched ${a.name} + ${b.name} → ${name} ${geometry.width}×${geometry.height}; `
          + `${ga.found.length} + ${gb.found.length} reseau crosses, ${row.columns} × ${row.rows} lattice, `
          + `${pluralize(best.shared, 'shared column')} (scene correlation ${best.ncc.toFixed(2)}), film deformation `
          + `${best.fitA.affineRmsUm.toFixed(1)} / ${best.fitB.affineRmsUm.toFixed(1)} µm corrected`, 'success', 'Fiducial')
        if (removeHalves && frame) {
          // The marks now live on the frame: drop the halves' own, not leave them orphaned.
          for (const img of [a, b]) {
            for (const g of gcpsStore.gcps) gcpsStore.removeObservation(g.id, img.id)
            removeImage?.(img.id)
          }
        }
      } catch (err) {
        out.push({ stem, error: err?.message ?? String(err) })
        log(`${stem}: half-frame stitch failed — ${err?.message ?? err}`, 'error', 'Fiducial')
      }
    }
    onProgress?.(pairs.length, pairs.length, '')
    // The stitched frames' camera: one sensor, the certificate's focal and principal point.
    const first = stitched[0]
    if (first) {
      let sid = first.image.sensorId
      for (const { image } of stitched.slice(1)) if (image.sensorId !== sid) sensors.assignSensor(image.id, sid)
      if (sid) {
        const g = first.geometry
        sensors.updateSensor(sid, 'label', `${sensor.label} (stitched)`)
        if (focalMm > 0) { sensors.updateSensor(sid, 'focalUnit', 'mm'); sensors.updateSensor(sid, 'focal', focalMm) }
        sensors.updateSensor(sid, 'pixelSize', pitchMm)
        sensors.updateSensor(sid, 'cx', g.cx); sensors.updateSensor(sid, 'cy', g.cy)
        sensors.markReseauStitched(sid)
      }
    }
    if (isPersisting()) save()
    return { pairs: out, stitched: stitched.map((s0) => s0.image) }
  }

  return {
    addFiducialObservations, setFiducialDetection, removeFiducialDetection, detectFiducialsForSensor,
    detectReseauForSensor, stitchReseauHalvesForSensor,
  }
}
