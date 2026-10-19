// Metric interpretation of anonymous fiducial detections. Detection is a strict
// upstream input; this module never changes detected pixel centres.

function solveLinear(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (!(Math.abs(M[p][c]) > 1e-12)) return null
    ;[M[c], M[p]] = [M[p], M[c]]
    const d = M[c][c]; for (let j = c; j <= n; j++) M[c][j] /= d
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c]; for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j] }
  }
  return M.map((r) => r[n])
}

function leastSquares(rows, values, n) {
  const N = Array.from({ length: n }, () => Array(n).fill(0)), rhs = Array(n).fill(0)
  for (let i = 0; i < rows.length; i++) for (let a = 0; a < n; a++) {
    rhs[a] += rows[i][a] * values[i]
    for (let b = 0; b < n; b++) N[a][b] += rows[i][a] * rows[i][b]
  }
  return solveLinear(N, rhs)
}

function invert3(h) {
  const [a,b,c,d,e,f,g,i,j] = h
  const A=e*j-f*i, B=c*i-b*j, C=b*f-c*e, D=f*g-d*j, E=a*j-c*g, F=c*d-a*f, G=d*i-e*g, H=b*g-a*i, I=a*e-b*d
  const det=a*A+b*D+c*G
  if (!(Math.abs(det) > 1e-15)) return null
  return [A,B,C,D,E,F,G,H,I].map((v) => v/det)
}

// scan px → camera mm. A 'reseau' transform (SAT-5) adds its film-deformation field
// after the affine: the correction, bilinear between the reseau crosses, that takes
// each measured cross onto its nominal position.
export function applyFiducialTransform(point, transform) {
  const h = transform?.forward
  if (!h) return null
  const w = h[6] * point.x + h[7] * point.y + h[8]
  if (!(Math.abs(w) > 1e-15)) return null
  const x = (h[0] * point.x + h[1] * point.y + h[2]) / w, y = (h[3] * point.x + h[4] * point.y + h[5]) / w
  if (!transform.residual) return { x, y }
  const c = residualAt(transform.residual, x, y)
  return { x: x + c.x, y: y + c.y }
}

// camera mm → scan px. The deformation field is undone by fixed-point iteration:
// m + c(m) = target, with c smooth and ≪ the reseau spacing, converges in a few steps.
export function invertFiducialTransform(point, transform) {
  const inverse = transform?.inverse || invert3(transform?.forward || [])
  if (!inverse) return null
  let p = point
  if (transform.residual) {
    let x = point.x, y = point.y
    for (let k = 0; k < 6; k++) {
      const c = residualAt(transform.residual, x, y)
      x = point.x - c.x; y = point.y - c.y
    }
    p = { x, y }
  }
  return applyFiducialTransform(p, { forward: inverse })
}

// The deformation correction (mm) at camera-mm (x, y): bilinear between the lattice
// nodes, held at the edge value outside the lattice.
function residualAt(r, x, y) {
  const fx = Math.min(r.nx - 1, Math.max(0, (x - r.x0Mm) / r.stepMm))
  const fy = Math.min(r.ny - 1, Math.max(0, (y - r.y0Mm) / r.stepMm))
  const i0 = Math.min(r.nx - 2, Math.floor(fx)), j0 = Math.min(r.ny - 2, Math.floor(fy))
  if (r.nx < 2 || r.ny < 2) return { x: r.dx[0] ?? 0, y: r.dy[0] ?? 0 }
  const tx = fx - i0, ty = fy - j0
  const at = (a, i, j) => a[j * r.nx + i]
  const lerp = (a) => (1 - ty) * ((1 - tx) * at(a, i0, j0) + tx * at(a, i0 + 1, j0))
    + ty * ((1 - tx) * at(a, i0, j0 + 1) + tx * at(a, i0 + 1, j0 + 1))
  return { x: lerp(r.dx), y: lerp(r.dy) }
}

// The film-deformation field of a reseau fit: at each lattice node the correction that
// takes the affine-mapped cross onto its nominal position. A cross that disagrees with
// its neighbours by more than `outlierMm` (a mis-detection) is dropped; empty nodes are
// filled from their neighbours; then one light 3×3 smoothing pass, so a cross's
// detection noise is not built into the warp (film deformation varies over centimetres,
// the lattice step).
function reseauResidual(pairs, h, stepMm, outlierMm) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pairs) { x0 = Math.min(x0, p.xMm); x1 = Math.max(x1, p.xMm); y0 = Math.min(y0, p.yMm); y1 = Math.max(y1, p.yMm) }
  const nx = Math.round((x1 - x0) / stepMm) + 1, ny = Math.round((y1 - y0) / stepMm) + 1
  const dx = new Float64Array(nx * ny).fill(NaN), dy = new Float64Array(nx * ny).fill(NaN)
  for (const p of pairs) {
    const i = Math.round((p.xMm - x0) / stepMm), j = Math.round((p.yMm - y0) / stepMm)
    if (Math.abs(p.xMm - (x0 + i * stepMm)) > 0.25 * stepMm || Math.abs(p.yMm - (y0 + j * stepMm)) > 0.25 * stepMm) continue
    const q = applyFiducialTransform({ x: p.px, y: p.py }, { forward: h })
    dx[j * nx + i] = p.xMm - q.x; dy[j * nx + i] = p.yMm - q.y
  }
  const neighbours = (a, i, j) => {
    const v = []
    for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      if (!b && !c) continue
      const ii = i + c, jj = j + b
      if (ii >= 0 && jj >= 0 && ii < nx && jj < ny && Number.isFinite(a[jj * nx + ii])) v.push(a[jj * nx + ii])
    }
    return v
  }
  const median = (v) => { const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
  let outliers = 0
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i
    if (!Number.isFinite(dx[k])) continue
    const nxv = neighbours(dx, i, j), nyv = neighbours(dy, i, j)
    if (nxv.length < 3) continue
    if (Math.hypot(dx[k] - median(nxv), dy[k] - median(nyv)) > outlierMm) { dx[k] = NaN; dy[k] = NaN; outliers++ }
  }
  const measured = dx.reduce((n, v) => n + (Number.isFinite(v) ? 1 : 0), 0)
  // Fill holes ring by ring from the measured neighbours.
  for (let pass = 0; pass < nx + ny; pass++) {
    let open = 0
    const fx = dx.slice(), fy = dy.slice()
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const k = j * nx + i
      if (Number.isFinite(dx[k])) continue
      const a = neighbours(dx, i, j), b = neighbours(dy, i, j)
      if (a.length) { fx[k] = a.reduce((s, v) => s + v, 0) / a.length; fy[k] = b.reduce((s, v) => s + v, 0) / b.length } else open++
    }
    dx.set(fx); dy.set(fy)
    if (!open) break
  }
  dx.forEach((v, k) => { if (!Number.isFinite(v)) { dx[k] = 0; dy[k] = 0 } })
  const smooth = (a) => {
    const out = new Float64Array(a.length)
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 4 * a[j * nx + i], w = 4
      for (const [c, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const ii = i + c, jj = j + b
        if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) { s += a[jj * nx + ii]; w++ }
      }
      out[j * nx + i] = s / w
    }
    return out
  }
  return { residual: { x0Mm: x0, y0Mm: y0, stepMm, nx, ny, dx: Array.from(smooth(dx)), dy: Array.from(smooth(dy)) },
    measured, outliers }
}

// `options.spacingMm`: a 'reseau' model's lattice step (the cross spacing).
export function fitFiducialTransform(pairs, model = 'affine', options = {}) {
  const clean = (pairs || []).filter((p) => [p.px,p.py,p.xMm,p.yMm].every(Number.isFinite))
  const need = model === 'conformal' ? 2 : model === 'projective' ? 4 : model === 'reseau' ? 9 : 3
  if (clean.length < need) return null
  let h
  if (model === 'conformal') {
    const rows = [], vals = []
    for (const p of clean) {
      rows.push([p.px, -p.py, 1, 0]); vals.push(p.xMm)
      rows.push([p.py,  p.px, 0, 1]); vals.push(p.yMm)
    }
    const q = leastSquares(rows, vals, 4); if (!q) return null
    h = [q[0], -q[1], q[2], q[1], q[0], q[3], 0, 0, 1]
  } else if (model === 'projective') {
    const rows = [], vals = []
    for (const p of clean) {
      rows.push([p.px,p.py,1,0,0,0,-p.xMm*p.px,-p.xMm*p.py]); vals.push(p.xMm)
      rows.push([0,0,0,p.px,p.py,1,-p.yMm*p.px,-p.yMm*p.py]); vals.push(p.yMm)
    }
    const q = leastSquares(rows, vals, 8); if (!q) return null
    h = [...q, 1]
  } else {
    const rows = [], vals = []
    for (const p of clean) {
      rows.push([p.px,p.py,1,0,0,0]); vals.push(p.xMm)
      rows.push([0,0,0,p.px,p.py,1]); vals.push(p.yMm)
    }
    const q = leastSquares(rows, vals, 6); if (!q) return null
    h = [q[0],q[1],q[2],q[3],q[4],q[5],0,0,1]
  }
  const inverse = invert3(h); if (!inverse) return null
  // A reseau fit (SAT-5): the affine above is the scan placement + mean film scale;
  // the crosses' leftover offsets are the film's own deformation, kept as a field.
  let reseau = null
  if (model === 'reseau') {
    const stepMm = options.spacingMm > 0 ? options.spacingMm : null
    if (!stepMm) return null
    const affineUm = clean.map((p) => { const q = applyFiducialTransform({ x:p.px,y:p.py }, { forward:h }); return 1000 * Math.hypot(q.x-p.xMm,q.y-p.yMm) })
    const pitch0 = Math.sqrt(Math.abs(h[0] * h[4] - h[1] * h[3]))
    reseau = { ...reseauResidual(clean, h, stepMm, Math.max(3 * pitch0, 0.15 * stepMm / 10)),
      affineRmsUm: Math.sqrt(affineUm.reduce((s, r) => s + r * r, 0) / affineUm.length) }
  }
  const model1 = reseau ? { forward: h, residual: reseau.residual } : { forward: h }
  const residualsUm = clean.map((p) => { const q = applyFiducialTransform({ x:p.px,y:p.py }, model1); return 1000 * Math.hypot(q.x-p.xMm,q.y-p.yMm) })
  const rmsUm = Math.sqrt(residualsUm.reduce((s,r) => s+r*r,0)/residualsUm.length)
  const cx=clean.reduce((s,p)=>s+p.px,0)/clean.length,cy=clean.reduce((s,p)=>s+p.py,0)/clean.length
  const q0=applyFiducialTransform({x:cx,y:cy},{forward:h}),qx=applyFiducialTransform({x:cx+1,y:cy},{forward:h}),qy=applyFiducialTransform({x:cx,y:cy+1},{forward:h})
  const pitchMm=(Math.hypot(qx.x-q0.x,qx.y-q0.y)+Math.hypot(qy.x-q0.x,qy.y-q0.y))/2
  return { model, forward: h, inverse, rmsUm, residualsUm, count: clean.length, pitchMm,
    ...(reseau ? { residual: reseau.residual, affineRmsUm: reseau.affineRmsUm, crosses: reseau.measured, outliers: reseau.outliers } : {}) }
}

export function pairsForCalibration(image, calibration) {
  const byId = new Map((calibration?.marks || []).map((m) => [m.id,m]))
  return (image?.fiducialDetections || []).flatMap((d) => {
    const id = calibration?.slotMap?.[d.slot], m = byId.get(id)
    return m ? [{ slot:d.slot,fidId:id,px:d.px,py:d.py,xMm:m.xMm,yMm:m.yMm }] : []
  })
}

export function validateFiducialCalibration(images, calibration) {
  const perImage = (images || []).map((image) => {
    const pairs = pairsForCalibration(image, calibration)
    const fit = fitFiducialTransform(pairs, calibration.transform || 'affine')
    return { id:image.id,name:image.name,count:pairs.length,fit,status:fit?'ok':'failed' }
  })
  const valid = perImage.filter((r) => r.fit), rms = valid.map((r) => r.fit.rmsUm).sort((a,b)=>a-b)
  return { perImage, imageCount:valid.length, failed:perImage.length-valid.length,
    rmsUm:rms.length?Math.sqrt(rms.reduce((s,v)=>s+v*v,0)/rms.length):null,
    p95Um:rms.length?rms[Math.min(rms.length-1,Math.floor(.95*(rms.length-1)))]:null }
}

export function estimateBatchFiducialLayout(images, scanPitchMm, options = {}) {
  if (!(scanPitchMm > 0)) return null
  const bySlot = new Map()
  for (const image of images || []) {
    const ds = image.fiducialDetections || []; if (ds.length < 2) continue
    const cx=ds.reduce((s,d)=>s+d.px,0)/ds.length, cy=ds.reduce((s,d)=>s+d.py,0)/ds.length
    for (const d of ds) { if(!bySlot.has(d.slot))bySlot.set(d.slot,[]); bySlot.get(d.slot).push({x:(d.px-cx)*scanPitchMm,y:(d.py-cy)*scanPitchMm}) }
  }
  if (bySlot.size < 3) return null
  const median = (v) => { const s=[...v].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
  const marks=[...bySlot].map(([slot,pts])=>({id:slot,xMm:median(pts.map(p=>p.x)),yMm:median(pts.map(p=>p.y))}))
  const slotMap=Object.fromEntries(marks.map((m)=>[m.id,m.id]))
  return { version:1,method:'batch',transform:options.transform||'affine',allowReflection:false,
    slotMap,marks,focalMm:Number(options.focalMm)||0,ppxMm:Number(options.ppxMm)||0,
    ppyMm:Number(options.ppyMm)||0,scanPitchMm,fit:null }
}
