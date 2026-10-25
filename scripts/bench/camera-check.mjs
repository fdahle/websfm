// Camera centres of a bench run against reference cameras in COLMAP's images.txt
// (ETH3D's dslr_calibration_undistorted, COLMAP's own South Building model, …).
//
//   node scripts/bench/camera-check.mjs <bench result.json> <images.txt | ETH3D scene dir> [stage]
//
// Fits a similarity (Horn's quaternion) from the run's centres (`stages.<stage>.model`,
// default recon) to the reference ones, refits twice without cameras beyond 5× the
// median, and prints one JSON line: registered/total, median, p90 and max error in
// reference units, and the cameras off by more than max(5× median, 0.01).
import { readFileSync } from 'node:fs'
const [, , resPath, scene, stage = 'recon'] = process.argv
const res = JSON.parse(readFileSync(resPath, 'utf8'))
const model = res.stages?.[stage]?.model ?? res.stages?.[stage]?.[0]?.model
const lines = readFileSync(scene.endsWith('.txt') ? scene : `${scene}/dslr_calibration_undistorted/images.txt`, 'utf8')
  .split('\n')
  .filter((l) => l && !l.startsWith('#'))
const truth = new Map()
for (let i = 0; i < lines.length; i += 2) {
  const p = lines[i].trim().split(/\s+/)
  const [qw, qx, qy, qz, tx, ty, tz] = p.slice(1, 8).map(Number)
  const name = p[9].split('/').pop()
  const R = [
    [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
    [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
    [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
  ]
  truth.set(
    name,
    [0, 1, 2].map((k) => -(R[0][k] * tx + R[1][k] * ty + R[2][k] * tz)),
  )
}
const centre = (c) => [0, 1, 2].map((k) => -(c.R[0][k] * c.t[0] + c.R[1][k] * c.t[1] + c.R[2][k] * c.t[2]))
const pairs = []
for (const [name, c] of Object.entries(model ?? {}))
  if (truth.has(name)) pairs.push({ name, p: centre(c), q: truth.get(name) })

function jacobiEig(A) {
  const n = 4,
    V = [...Array(n)].map((_, i) => [...Array(n)].map((_, j) => (i === j ? 1 : 0))),
    a = A.map((r) => r.slice())
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2
    if (off < 1e-30) break
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue
        const th = (a[q][q] - a[p][p]) / (2 * a[p][q]),
          t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)),
          c = 1 / Math.sqrt(t * t + 1),
          s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p],
            akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k],
            aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k][p],
            vkq = V[k][q]
          V[k][p] = c * vkp - s * vkq
          V[k][q] = s * vkp + c * vkq
        }
      }
  }
  let best = 0
  for (let i = 1; i < n; i++) if (a[i][i] > a[best][best]) best = i
  return V.map((r) => r[best])
}
function sim(P, Q) {
  const n = P.length,
    mp = [0, 0, 0],
    mq = [0, 0, 0]
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      mp[k] += P[i][k] / n
      mq[k] += Q[i][k] / n
    }
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  let vp = 0
  for (let i = 0; i < n; i++) {
    const a = P[i].map((v, k) => v - mp[k]),
      b = Q[i].map((v, k) => v - mq[k])
    vp += a[0] ** 2 + a[1] ** 2 + a[2] ** 2
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c]
  }
  const [[xx, xy, xz], [yx, yy, yz], [zx, zy, zz]] = S
  const N = [
    [xx + yy + zz, yz - zy, zx - xz, xy - yx],
    [yz - zy, xx - yy - zz, xy + yx, zx + xz],
    [zx - xz, xy + yx, -xx + yy - zz, yz + zy],
    [xy - yx, zx + xz, yz + zy, -xx - yy + zz],
  ]
  const [w, x, y, z] = jacobiEig(N)
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ]
  let num = 0
  for (let i = 0; i < n; i++) {
    const a = P[i].map((v, k) => v - mp[k]),
      b = Q[i].map((v, k) => v - mq[k])
    const ra = [0, 1, 2].map((r) => R[r][0] * a[0] + R[r][1] * a[1] + R[r][2] * a[2])
    num += ra[0] * b[0] + ra[1] * b[1] + ra[2] * b[2]
  }
  const s = num / vp
  return (p) => {
    const a = p.map((v, k) => v - mp[k])
    return [0, 1, 2].map((r) => s * (R[r][0] * a[0] + R[r][1] * a[1] + R[r][2] * a[2]) + mq[r])
  }
}
const med = (a) => {
  const b = [...a].sort((x, y) => x - y)
  return b.length ? b[b.length >> 1] : NaN
}
let use = pairs,
  errs = []
for (let it = 0; it < 3 && use.length >= 3; it++) {
  const f = sim(
    use.map((u) => u.p),
    use.map((u) => u.q),
  )
  errs = pairs.map((u) => {
    const g = f(u.p)
    return Math.hypot(g[0] - u.q[0], g[1] - u.q[1], g[2] - u.q[2])
  })
  const m = med(errs)
  use = pairs.filter((_, i) => errs[i] <= Math.max(5 * m, 1e-6))
}
const m = med(errs)
const off = pairs.filter((_, i) => errs[i] > Math.max(5 * m, 0.01)).map((u) => u.name)
const r = res.stages?.[stage]
console.log(
  JSON.stringify({
    scene: resPath.split('/').pop(),
    registered: `${pairs.length}/${truth.size}`,
    median: +m.toFixed(5),
    p90: +[...errs].sort((a, b) => a - b)[Math.floor(errs.length * 0.9)]?.toFixed(4),
    max: +Math.max(...errs).toFixed(4),
    off: off.length,
    offNames: off.slice(0, 5),
    points: r?.points ?? r?.pointCount,
    seconds: r?.seconds,
  }),
)
