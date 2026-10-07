import { attributeBuffers } from '../../core/io/cloudAttributes.js'
import { cropCloud, filterCloud, mergeClouds, maskCloud, cloudCount } from '../../core/products/cloudEdit.js'
import { cleanMesh, taubinSmooth, cropMesh, sampleMesh } from '../../core/products/meshEdit.js'
import { sectionCloud } from '../../core/products/cloudSection.js'
import { estimateNormals } from '../../core/products/cloudNormals.js'
import { decimateMesh } from '../../core/products/meshDecimate.js'
import { transformCloud, icpAlign, alignmentReport } from '../../core/products/cloudAlign.js'
import { cloudToCloudDistance, cloudToMeshDistance } from '../../core/products/cloudDistance.js'
import { estimateSpacing, cloudBounds } from '../../core/products/cloudEdit.js'

// Cloud- and mesh-editing ops (the Tools tab's Point Cloud ▾ and Mesh ▾ tools, plus
// the 3D selection). Pure math lives in core/products/*; this file only marshals
// buffers and picks the function by `mode`. No injected worker helpers (nothing
// here rasterises or touches wasm).
//
// The store sends COPIES of the source buffers (transferred, so no second clone),
// and every input is still round-tripped home under `home[]`, keyed by id, for the
// store to re-attach — the contract `meshify` set. Editing is non-destructive: the
// source must still be usable afterwards.
export function makeCloudOps() {
  // Rebuild the home payload + transfer list for the inputs. Called once, at the
  // end, so a throw mid-edit leaves the buffers un-transferred.
  function homeward(clouds, transfer) {
    return clouds.map((c) => {
      for (const key of ['pos', 'col', 'nrm', 'idx']) if (c[key]?.buffer) transfer.push(c[key].buffer)
      return { id: c.id, pos: c.pos, col: c.col || null, nrm: c.nrm || null, idx: c.idx || null }
    })
  }

  // Push the result's own buffers onto the transfer list. A result may share a
  // buffer with an input (e.g. colour passed through unchanged), so de-duplicate.
  function outward(out, transfer) {
    for (const key of ['pos', 'col', 'nrm', 'idx']) if (out[key]?.buffer) transfer.push(out[key].buffer)
    transfer.push(...attributeBuffers(out))
  }

  // One entry per mode: (clouds, settings, log, progress) → { out, extra? }.
  // `extra` carries small non-buffer results (a report) back to the store.
  const MODES = {
    crop:   ([c], s, log) => ({ out: cropCloud(c, s, log) }),
    filter: ([c], s, log) => ({ out: filterCloud(c, s, log) }),
    merge:  (cs, s, log) => ({ out: mergeClouds(cs, s, log) }),
    mask:   ([c], s, log) => ({ out: maskCloud(c, s, log) }),
    // The same points with (re-)estimated normals; colour and attributes pass through.
    normals: ([c], s, log, progress) => {
      const { nrm } = estimateNormals(c, s, log, (f) => progress(f, 'Estimating normals…'))
      return { out: { count: c.count, pos: c.pos, col: c.col, nrm, attributes: c.attributes } }
    },
    // Move/rotate/scale by a transform ({ scale, R, t }) or a 4×4 `matrix`. The
    // only keys kept are the cloud's own buffers (transformCloud copies every field).
    transform: ([c], s) => {
      const t = transformCloud(c, s.matrix ?? s.transform)
      return { out: { count: c.count, pos: t.pos, col: c.col, nrm: t.nrm ?? null, attributes: c.attributes } }
    },
    // ICP: [source, reference]. The source moves; the reference is only read.
    icp: ([src, ref], s, log, progress) => {
      const maxDistance = s.maxDistance > 0 ? s.maxDistance
        : 10 * (estimateSpacing(cloudBounds(src), src.count) || 1)
      if (!(s.maxDistance > 0)) log(`ICP: correspondence radius auto = ${maxDistance.toPrecision(3)} (10× the source spacing)`, 'info', 'Products')
      const reference = ref.kind === 'mesh' ? { ...ref, count: ref.count } : ref
      const result = icpAlign(src, reference, { ...s, maxDistance }, log, (f) => progress(f, 'Aligning…'))
      for (const line of alignmentReport(result, { unit: s.unitLabel || 'units' })) log(`ICP: ${line}`, 'info', 'Products')
      if (!result.converged) log('ICP: did not converge — the result may be only partly aligned', 'warn', 'Products')
      const t = transformCloud(src, result.transform)
      return {
        out: { count: src.count, pos: t.pos, col: src.col, nrm: t.nrm ?? null, attributes: src.attributes },
        extra: { rms: result.rms, inlierFraction: result.inlierFraction, iterations: result.iterations, converged: result.converged },
      }
    },
    // Distance: [source, reference] → the source with a per-point `distance`
    // attribute (NaN beyond the cutoff), coloured by it in the viewer.
    distance: ([src, ref], s, log, progress) => {
      const opts = { maxDistance: s.maxDistance > 0 ? s.maxDistance : Infinity, signed: s.signed ? (ref.kind === 'mesh' ? true : 'auto') : false }
      const { distance, stats } = ref.kind === 'mesh'
        ? cloudToMeshDistance(src, ref, opts, log, (f) => progress(f, 'Measuring distances…'))
        : cloudToCloudDistance(src, ref, opts, log, (f) => progress(f, 'Measuring distances…'))
      const fmt = (v) => (Number.isFinite(v) ? v.toPrecision(4) : '—')
      log(`Distance: mean ${fmt(stats.mean)}, median ${fmt(stats.median)}, RMS ${fmt(stats.rms)}, `
        + `95% |d| ≤ ${fmt(stats.p95Abs)} (${stats.validCount.toLocaleString()} of ${src.count.toLocaleString()} points)`, 'info', 'Products')
      return {
        out: { count: src.count, pos: src.pos, col: src.col, nrm: src.nrm ?? null,
          attributes: { ...(src.attributes || {}), distance } },
        extra: stats,
      }
    },
    section: ([c], s, log) => {
      const { cloud } = sectionCloud(c, s, log)
      return { out: cloud }
    },
    'mesh-clean':  ([m], s, log) => ({ out: cleanMesh(m, s, log).mesh }),
    'mesh-smooth': ([m], s, log) => ({ out: taubinSmooth(m, s, log) }),
    'mesh-crop':   ([m], s, log) => ({ out: cropMesh(m, s, log) }),
    'mesh-decimate': ([m], s, log) => {
      const { mesh, stats } = decimateMesh(m, s, log)
      return { out: mesh, extra: stats }
    },
    'mesh-sample': ([m], s, log) => ({ out: sampleMesh(m, s, log) }),
  }

  // input: { mode, clouds: [{ id, kind, count, pos, col, nrm?, idx?, nVerts?, attributes? }],
  //          settings }. Resolves to { cloud, error, home, extra }.
  //
  // This op NEVER throws. The source buffers are already detached on the caller's
  // side by the time we run, so a thrown error would reject the call with no way to
  // carry a transfer list. Failures come back as `{ cloud: null, error }` alongside
  // the round-tripped `home` buffers, and the store raises them.
  async function editCloud([input], { emit }) {
    const { mode, clouds = [], settings = {} } = input
    const log = (m, l, c) => emit('log', [m, l, c])
    const progress = (f, label) => emit('progress', [f, 1, label, f])
    const transfer = []
    let out = null, error = null, extra = null
    try {
      if (!clouds.length) throw new Error('no source cloud')
      const run = MODES[mode]
      if (!run) throw new Error(`unknown mode "${mode}"`)
      const t0 = performance.now()
      emit('progress', [0, 1, 'Working…'])
      ;({ out, extra = null } = await run(clouds, settings, log, progress))
      const isMesh = !!out?.idx
      const unit = isMesh ? 'triangles' : 'points'
      const size = isMesh ? out.count : cloudCount(out)
      const before = clouds[0].kind === 'mesh' ? clouds[0].count : clouds.reduce((s, c) => s + cloudCount(c), 0)
      log(`${mode[0].toUpperCase()}${mode.slice(1)}: ${size.toLocaleString()} ${unit} `
        + `from ${before.toLocaleString()} in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
      size ? 'success' : 'warn', 'Products')
      emit('progress', [1, 1, 'Done'])
      outward(out, transfer)
    } catch (err) {
      out = null
      error = err?.message ?? String(err)
    }
    const home = homeward(clouds, transfer)
    return { result: { cloud: out, error, home, extra }, transfer: [...new Set(transfer)] }
  }

  return { editCloud }
}
