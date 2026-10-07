// LiDAR reference surface for the bench: decode LAZ strips into a height grid once
// (cached), then measure how well a reconstruction's points lie on it.
//
//   "reference": {
//     "lidar": {
//       "dir":  "<folder of .laz/.las strips>",
//       "crs":  "EPSG:28992",            the strips' horizontal CRS (proj4 def below)
//       "cell": 0.5,                      grid cell, metres
//       "flatRangeM": 0.15                a cell is "flat" when its LiDAR heights span ≤ this
//     }
//   }
//
// Why a grid and only flat cells: a photogrammetric point and a LiDAR return on a
// slope, a wall or vegetation differ by however the two sensors sample the edge. On a
// flat cell they must agree, so the residual there is the model's error.
//
// The reconstruction reaches the LiDAR frame through the camera-GPS similarity
// (positionCheck.js: SfM → local ENU). That GPS is a standalone receiver here, metres
// off, and its heights are ellipsoidal while the LiDAR heights are national-datum
// (NAP: ~43 m apart on the Dutch coast). So the check first fits a horizontal shift and
// a vertical offset, and only the shape that remains is reported: tilt, dome, scatter.
import { readFile, readdir, writeFile, mkdir, stat, open } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import proj4 from 'proj4'
import initLaz, { decompress_points } from '../../src/wasm/lazcodec/lazcodec.js'
import { decompressLazRecords } from '../../src/core/io/laz.js'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const DEFS = {
  'EPSG:28992': '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 '
    + '+x_0=155000 +y_0=463000 +ellps=bessel '
    + '+towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
}
const NOISE_CLASSES = new Set([7, 18]) // ASPRS low / high noise

let lazReady = null
const ensureLaz = () => (lazReady ??= readFile(join(repo, 'src/wasm/lazcodec/lazcodec_bg.wasm'))
  .then((bytes) => initLaz({ module_or_path: bytes })))

/** Build (or load from cache) the height grid. */
export async function loadLidarGrid(cfg, log = console.log) {
  const cell = Number(cfg.cell ?? 0.5)
  const files = (await readdir(cfg.dir)).filter((f) => ['.laz', '.las'].includes(extname(f).toLowerCase())).sort()
  if (!files.length) throw new Error(`lidar: no .laz/.las in ${cfg.dir}`)
  const sizes = await Promise.all(files.map((f) => stat(join(cfg.dir, f)).then((s) => s.size)))
  const key = `${files.length}-${sizes.reduce((a, b) => a + b, 0)}-${cell}`
  const cacheDir = join(repo, 'bench-out', 'cache')
  const base = join(cacheDir, `lidar-${key}`)
  try {
    const meta = JSON.parse(await readFile(`${base}.json`, 'utf8'))
    const buf = await readFile(`${base}.bin`)
    const n = meta.nx * meta.ny
    const f32 = new Float32Array(buf.buffer, buf.byteOffset, 2 * n)
    log(`lidar: grid from cache ${meta.nx}×${meta.ny} @ ${cell} m (${meta.points.toLocaleString()} points)`)
    return { ...meta, mean: f32.subarray(0, n), range: f32.subarray(n, 2 * n) }
  } catch { /* build it */ }

  // Extent from the public headers alone (LAS: max X, min X, max Y, min Y at 179..211).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const f of files) {
    const fh = await open(join(cfg.dir, f))
    const b = Buffer.alloc(227)
    await fh.read(b, 0, 227, 0)
    await fh.close()
    maxX = Math.max(maxX, b.readDoubleLE(179)); minX = Math.min(minX, b.readDoubleLE(187))
    maxY = Math.max(maxY, b.readDoubleLE(195)); minY = Math.min(minY, b.readDoubleLE(203))
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) throw new Error('lidar: headers carry no extent')
  const x0 = Math.floor(minX), y0 = Math.floor(minY)
  const nx = Math.ceil((maxX - x0) / cell) + 1, ny = Math.ceil((maxY - y0) / cell) + 1
  const n = nx * ny
  const count = new Uint32Array(n), sum = new Float64Array(n)
  const lo = new Float32Array(n).fill(Infinity), hi = new Float32Array(n).fill(-Infinity)
  await ensureLaz()
  let total = 0, noise = 0
  const t0 = Date.now()
  for (const f of files) {
    const bytes = new Uint8Array(await readFile(join(cfg.dir, f)))
    // The codec decodes at most 512 MiB of records per call and has no streaming
    // decoder, so an oversized strip contributes its first points only; the
    // neighbouring strips overlap it. (The same cap stops the app importing it.)
    const recLen = new DataView(bytes.buffer).getUint16(105, true)
    const maxPoints = Math.floor((512 * 1024 * 1024) / recLen)
    const { header: h, records } = decompressLazRecords(bytes, { decompress: decompress_points, maxPoints })
    if (h.truncatedFrom) log(`lidar: ${f} decoded ${h.count.toLocaleString()} of ${h.truncatedFrom.toLocaleString()} points (codec limit)`)
    const dv = new DataView(records.buffer, records.byteOffset, records.byteLength)
    const modern = h.format >= 6
    for (let i = 0, p = 0; i < h.count; i++, p += h.recordLength) {
      const cls = modern ? dv.getUint8(p + 16) : dv.getUint8(p + 15) & 31
      if (NOISE_CLASSES.has(cls)) { noise++; continue }
      const x = dv.getInt32(p, true) * h.scale[0] + h.offset[0]
      const y = dv.getInt32(p + 4, true) * h.scale[1] + h.offset[1]
      const z = dv.getInt32(p + 8, true) * h.scale[2] + h.offset[2]
      const ix = Math.floor((x - x0) / cell), iy = Math.floor((y - y0) / cell)
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue
      const k = iy * nx + ix
      count[k]++; sum[k] += z
      if (z < lo[k]) lo[k] = z
      if (z > hi[k]) hi[k] = z
    }
    total += h.count
    log(`lidar: ${f} ${h.count.toLocaleString()} points (format ${h.format}) — ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  }
  const mean = new Float32Array(n).fill(NaN), range = new Float32Array(n).fill(NaN)
  for (let k = 0; k < n; k++) if (count[k]) { mean[k] = sum[k] / count[k]; range[k] = hi[k] - lo[k] }
  const meta = { crs: cfg.crs, cell, x0, y0, nx, ny, points: total, noise, files: files.length }
  await mkdir(cacheDir, { recursive: true })
  await writeFile(`${base}.json`, JSON.stringify(meta))
  const out = new Float32Array(2 * n); out.set(mean, 0); out.set(range, n)
  await writeFile(`${base}.bin`, Buffer.from(out.buffer))
  log(`lidar: grid ${nx}×${ny} @ ${cell} m from ${total.toLocaleString()} points (${noise.toLocaleString()} noise skipped)`)
  return { ...meta, mean, range }
}

// ── ENU (positionCheck frame) → WGS84 → the grid CRS ────────────────────────────
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F), RAD = Math.PI / 180
function enuToGeodetic([e, nn, u], { lat, lon, h }) {
  const la = lat * RAD, lo = lon * RAD, sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo)
  const N0 = A / Math.sqrt(1 - E2 * sl * sl)
  const o = [(N0 + h) * cl * co, (N0 + h) * cl * so, (N0 * (1 - E2) + h) * sl]
  // ECEF = o + Rᵀ·enu (rows of R are the e, n, u axes)
  const X = o[0] - so * e - sl * co * nn + cl * co * u
  const Y = o[1] + co * e - sl * so * nn + cl * so * u
  const Z = o[2] + cl * nn + sl * u
  const p = Math.hypot(X, Y)
  let phi = Math.atan2(Z, p * (1 - E2)), hh = 0
  for (let i = 0; i < 6; i++) {
    const s = Math.sin(phi), Nn = A / Math.sqrt(1 - E2 * s * s)
    hh = p / Math.cos(phi) - Nn
    phi = Math.atan2(Z, p * (1 - E2 * Nn / (Nn + hh)))
  }
  return [Math.atan2(Y, X) / RAD, phi / RAD, hh]
}

function sampler(grid, flatRangeM) {
  return (x, y) => {
    const ix = Math.floor((x - grid.x0) / grid.cell), iy = Math.floor((y - grid.y0) / grid.cell)
    if (ix < 0 || iy < 0 || ix >= grid.nx || iy >= grid.ny) return NaN
    const k = iy * grid.nx + ix
    return grid.range[k] <= flatRangeM ? grid.mean[k] : NaN
  }
}

const median = (a) => { const s = Float64Array.from(a).sort(); return s.length ? s[s.length >> 1] : NaN }
const quantile = (a, q) => { const s = Float64Array.from(a).sort(); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN }

/**
 * @param {number[][]} pointsEnu   reconstruction points in the positionCheck ENU frame
 * @param {{lat,lon,h}} origin     that frame's geodetic origin
 */
export function lidarCheck(pointsEnu, origin, grid, { flatRangeM = 0.15 } = {}) {
  const def = DEFS[grid.crs] ?? grid.crs
  const toGrid = proj4('EPSG:4326', def)
  const pts = pointsEnu.map((q) => {
    const [lon, lat, h] = enuToGeodetic(q, origin)
    const [x, y] = toGrid.forward([lon, lat])
    return [x, y, h]
  })
  const sample = sampler(grid, flatRangeM)
  // Horizontal shift by grid search on a subsample: the robust spread of dz is
  // smallest when the two surfaces line up (slopes and edges carry the signal).
  const sub = pts.filter((_, i) => i % Math.max(1, Math.floor(pts.length / 20000)) === 0)
  const spread = (dx, dy, list) => {
    const dz = []
    for (const [x, y, h] of list) { const z = sample(x + dx, y + dy); if (Number.isFinite(z)) dz.push(h - z) }
    if (dz.length < 50) return { cost: Infinity, dz }
    const m = median(dz)
    return { cost: median(dz.map((v) => Math.abs(v - m))), dz }
  }
  let best = { dx: 0, dy: 0, cost: Infinity }
  for (let dx = -6; dx <= 6; dx += 0.5) for (let dy = -6; dy <= 6; dy += 0.5) {
    const c = spread(dx, dy, sub).cost
    if (c < best.cost) best = { dx, dy, cost: c }
  }
  for (let dx = best.dx - 0.5; dx <= best.dx + 0.5; dx += 0.1) for (let dy = best.dy - 0.5; dy <= best.dy + 0.5; dy += 0.1) {
    const c = spread(dx, dy, sub).cost
    if (c < best.cost) best = { dx, dy, cost: c }
  }
  // Residuals on flat cells at that shift; fit offset + plane, then + dome (r²).
  const rows = []
  for (const [x, y, h] of pts) {
    const z = sample(x + best.dx, y + best.dy)
    if (Number.isFinite(z)) rows.push([x + best.dx, y + best.dy, h - z])
  }
  if (rows.length < 100) return { points: pts.length, onFlat: rows.length, error: 'too few points on flat LiDAR cells' }
  const cx = rows.reduce((s, r) => s + r[0], 0) / rows.length, cy = rows.reduce((s, r) => s + r[1], 0) / rows.length
  // Iteratively reweighted (drop |r| > 3·1.4826·MAD) least squares.
  const fit = (cols) => {
    let keep = rows.map(() => true), coef = null
    for (let it = 0; it < 4; it++) {
      const k = cols.length, M = Array.from({ length: k }, () => new Float64Array(k)), b = new Float64Array(k)
      rows.forEach((r, i) => {
        if (!keep[i]) return
        const v = cols.map((c) => c(r[0] - cx, r[1] - cy))
        for (let a = 0; a < k; a++) { b[a] += v[a] * r[2]; for (let c2 = 0; c2 < k; c2++) M[a][c2] += v[a] * v[c2] }
      })
      coef = solve(M, b)
      const res = rows.map((r) => r[2] - cols.reduce((s, c, a) => s + coef[a] * c(r[0] - cx, r[1] - cy), 0))
      const mad = median(res.map(Math.abs)) * 1.4826
      keep = res.map((v) => Math.abs(v) <= Math.max(3 * mad, 0.05))
      if (it === 3) return { coef, res, keep }
    }
  }
  const planeCols = [() => 1, (x) => x, (x, y) => y]
  const plane = fit(planeCols)
  const dome = fit([...planeCols, (x, y) => x * x + y * y])
  const rmax = Math.sqrt(quantile(rows.map((r) => (r[0] - cx) ** 2 + (r[1] - cy) ** 2), 0.95))
  const kept = (f) => f.res.filter((_, i) => f.keep[i])
  const pr = kept(plane), ab = pr.map(Math.abs)
  const r4 = (v) => Math.round(v * 1e4) / 1e4
  return {
    points: pts.length, onFlat: rows.length, inlierShare: r4(pr.length / rows.length),
    shiftM: [r4(best.dx), r4(best.dy)], offsetM: r4(plane.coef[0]),
    // Block tilt, metres per 100 m, and the dome: height at the 95 % radius relative
    // to the centre, from the quadratic term (positive = edges high, i.e. a bowl).
    tiltPer100m: [r4(plane.coef[1] * 100), r4(plane.coef[2] * 100)],
    domeAtEdgeM: r4(dome.coef[3] * rmax * rmax), edgeRadiusM: Math.round(rmax),
    rmsM: r4(Math.sqrt(pr.reduce((s, v) => s + v * v, 0) / pr.length)),
    medianAbsM: r4(median(ab)), p90AbsM: r4(quantile(ab, 0.9)),
    within10cm: r4(ab.filter((v) => v <= 0.1).length / ab.length),
  }
}

function solve(M, b) {
  const n = b.length, A2 = M.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A2[r][c]) > Math.abs(A2[p][c])) p = r;
    [A2[c], A2[p]] = [A2[p], A2[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = A2[r][c] / A2[c][c]
      for (let k = c; k <= n; k++) A2[r][k] -= f * A2[c][k]
    }
  }
  return A2.map((r, i) => r[n] / r[i])
}

export const _test = { enuToGeodetic }
