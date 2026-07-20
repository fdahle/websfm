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

export function applyFiducialTransform(point, transform) {
  const h = transform?.forward
  if (!h) return null
  const w = h[6] * point.x + h[7] * point.y + h[8]
  if (!(Math.abs(w) > 1e-15)) return null
  return { x: (h[0] * point.x + h[1] * point.y + h[2]) / w,
    y: (h[3] * point.x + h[4] * point.y + h[5]) / w }
}

export function invertFiducialTransform(point, transform) {
  const inverse = transform?.inverse || invert3(transform?.forward || [])
  return inverse ? applyFiducialTransform(point, { forward: inverse }) : null
}

export function fitFiducialTransform(pairs, model = 'affine') {
  const clean = (pairs || []).filter((p) => [p.px,p.py,p.xMm,p.yMm].every(Number.isFinite))
  const need = model === 'conformal' ? 2 : model === 'projective' ? 4 : 3
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
  const residualsUm = clean.map((p) => { const q = applyFiducialTransform({ x:p.px,y:p.py }, { forward:h }); return 1000 * Math.hypot(q.x-p.xMm,q.y-p.yMm) })
  const rmsUm = Math.sqrt(residualsUm.reduce((s,r) => s+r*r,0)/residualsUm.length)
  const cx=clean.reduce((s,p)=>s+p.px,0)/clean.length,cy=clean.reduce((s,p)=>s+p.py,0)/clean.length
  const q0=applyFiducialTransform({x:cx,y:cy},{forward:h}),qx=applyFiducialTransform({x:cx+1,y:cy},{forward:h}),qy=applyFiducialTransform({x:cx,y:cy+1},{forward:h})
  const pitchMm=(Math.hypot(qx.x-q0.x,qx.y-q0.y)+Math.hypot(qy.x-q0.x,qy.y-q0.y))/2
  return { model, forward: h, inverse, rmsUm, residualsUm, count: clean.length, pitchMm }
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
