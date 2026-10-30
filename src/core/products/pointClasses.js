// Vegetation and buildings among the points above ground (Tools ▸ Point Cloud ▸ Classify
// points, steps 3 and 4). Pure, no Vue/Pinia/OPFS/DOM. Runs after the ground filter
// (groundFilter.js), on the points it left unclassified (class 1), with each point's
// height above the cloth.
//
// ASPRS LAS classes written here, next to the ground filter's 1, 2 and 7:
//   3 low vegetation, 4 medium vegetation, 5 high vegetation, 6 building
// Everything else above ground (cars, fences, poles, wires) stays 1.
//
// Method: rules on local geometry, the covariance features of Weinmann et al. 2015
// ("Semantic point cloud interpretation based on optimal neighborhoods, relevant
// features and efficient classifiers"), with a colour index where the cloud has
// colour. To stay linear on dense photogrammetric clouds (tens of points per square
// metre and more), the work is done on a voxel grid, not per point:
//   1. Points above ground fall into voxels of `voxel` size; each voxel keeps its
//      centroid, mean colour and the highest height above ground in it.
//   2. Each voxel's neighbourhood is the voxel centroids within `radius`. Their
//      covariance gives eigenvalues λ1 ≥ λ2 ≥ λ3 and the normal (λ3's eigenvector):
//      planarity (λ2 − λ3)/λ1 and scatter λ3/λ1. A roof or a wall is planar; a
//      canopy scatters.
//   3. Buildings: planar voxels (planarity ≥ `minPlanarity`, scatter ≤ `maxScatter`)
//      grow into segments through face-, edge- and corner-adjacent voxels whose normals
//      agree within `normalAngleDeg`. A segment whose highest voxel reaches
//      `minBuildingHeight` and whose surface (voxel count × voxel²) reaches
//      `minBuildingArea` is building, unless it is green (mean ExG above `greenExg`):
//      a hedge can be planar too.
//   4. Vegetation: the other voxels that scatter (scatter > `maxScatter`) or are green,
//      by the voxel's height above ground: up to `lowVegetationMax` low, up to
//      `mediumVegetationMax` medium, above that high.
//   5. Every point takes its voxel's class.
// The colour index is ExG = 2g − r − b on chromatic coordinates (Woebbecke et al.
// 1995); a cloud without colour (a film scan) is classified on geometry alone.
//
// Lengths are in frame units (the caller converts from metres); `hag` is per point,
// NaN where the ground filter did not classify the point.

import { eigenSym3 } from './cloudNormals.js'
import { CLASSIFY_DEFAULTS } from '../defaults.user.js'
import { CLASSIFY_TUNING } from '../tuning.js'

const CLASS_UNCLASSIFIED = 1 // groundFilter.js: above the cloth

export const CLASS_LOW_VEGETATION = 3
export const CLASS_MEDIUM_VEGETATION = 4
export const CLASS_HIGH_VEGETATION = 5
export const CLASS_BUILDING = 6

// A segment whose mean |normal z| is below this is a wall (steeper than about 60°).
const WALL_NZ = 0.5

// Excess green of one colour on chromatic coordinates, in [−1, 2].
export function excessGreen(r, g, b) {
  const s = r + g + b
  return s > 0 ? (2 * g - r - b) / s : 0
}

// Classify the above-ground points of `classes` in place.
//   pos      interleaved xyz (z up), `count` points
//   classes  Uint8Array from the ground filter; class 1 points are candidates
//   hag      Float32Array/Float64Array height above the cloth per point
//   col      Uint8Array rgb per point, or null
//   opts     { vegetation, buildings, voxel, radius, minPlanarity, maxScatter,
//              normalAngleDeg, greenExg, lowVegetationMax, mediumVegetationMax,
//              minBuildingHeight, minBuildingArea, onProgress }
// → { counts: { low, medium, high, building }, voxels, segments, buildingSegments,
//     colour }
export function classifyAboveGround(pos, count, classes, hag, col, opts = {}) {
  let {
    vegetation = CLASSIFY_DEFAULTS.vegetation,
    buildings = CLASSIFY_DEFAULTS.buildings,
    voxel = CLASSIFY_TUNING.voxel,
    radius = CLASSIFY_TUNING.radius,
    minPlanarity = CLASSIFY_TUNING.minPlanarity,
    maxScatter = CLASSIFY_TUNING.maxScatter,
    normalAngleDeg = CLASSIFY_TUNING.normalAngleDeg,
    greenExg = CLASSIFY_TUNING.greenExg,
    lowVegetationMax = CLASSIFY_DEFAULTS.lowVegetationMax,
    mediumVegetationMax = CLASSIFY_DEFAULTS.mediumVegetationMax,
    minBuildingHeight = CLASSIFY_DEFAULTS.minBuildingHeight,
    minBuildingArea = CLASSIFY_DEFAULTS.minBuildingArea,
    onProgress = null,
  } = opts
  const counts = { low: 0, medium: 0, high: 0, building: 0 }
  const colour = !!col
  if (!vegetation && !buildings) return { counts, voxels: 0, segments: 0, buildingSegments: 0, colour }
  if (!(voxel > 0) || !(radius >= voxel)) throw new Error('need voxel > 0 and radius ≥ voxel')

  // ── 1. Voxels of the candidates ─────────────────────────────────────────────
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  let n = 0
  for (let i = 0; i < count; i++) {
    if (classes[i] !== CLASS_UNCLASSIFIED || !Number.isFinite(hag[i])) continue
    const x = pos[3 * i],
      y = pos[3 * i + 1],
      z = pos[3 * i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    n++
  }
  if (!n) return { counts, voxels: 0, segments: 0, buildingSegments: 0, colour }
  // A sparser cloud than the voxel (a survey at 0.5 m spacing) leaves its surfaces'
  // voxels apart, so no segment could grow: the voxel doubles, up to four times its
  // size, until an occupied voxel holds two points, and the radius follows. At
  // 2.5 voxels it falls between the lattice's distances: at exactly 2 a tilted roof's
  // neighbours two voxels away count along one axis and not the other.
  const voxelUsed = fitVoxel(pos, count, classes, hag, voxel, minX, minY, minZ)
  voxel = voxelUsed
  radius = Math.max(radius, 2.5 * voxel)
  const nx = Math.floor((maxX - minX) / voxel) + 1
  const ny = Math.floor((maxY - minY) / voxel) + 1
  const keyOf = (ix, iy, iz) => ix + nx * (iy + ny * iz)
  const index = new Map() // voxel key → voxel id
  const of = new Int32Array(count).fill(-1) // point → voxel id
  let sum = new Float64Array(3 * 1024),
    rgb = new Float64Array(3 * 1024),
    top = new Float32Array(1024),
    cnt = new Uint32Array(1024),
    cell = new Int32Array(3 * 1024)
  const grow = () => {
    const g = (a, C) => {
      const b = new C(a.length * 2)
      b.set(a)
      return b
    }
    sum = g(sum, Float64Array)
    rgb = g(rgb, Float64Array)
    top = g(top, Float32Array)
    cnt = g(cnt, Uint32Array)
    cell = g(cell, Int32Array)
  }
  let nv = 0
  for (let i = 0; i < count; i++) {
    if (classes[i] !== CLASS_UNCLASSIFIED || !Number.isFinite(hag[i])) continue
    const x = pos[3 * i],
      y = pos[3 * i + 1],
      z = pos[3 * i + 2]
    const ix = Math.floor((x - minX) / voxel),
      iy = Math.floor((y - minY) / voxel),
      iz = Math.floor((z - minZ) / voxel)
    const key = keyOf(ix, iy, iz)
    let v = index.get(key)
    if (v === undefined) {
      if (nv === cnt.length) grow()
      v = nv++
      index.set(key, v)
      cell[3 * v] = ix
      cell[3 * v + 1] = iy
      cell[3 * v + 2] = iz
      top[v] = -Infinity
    }
    of[i] = v
    sum[3 * v] += x - minX
    sum[3 * v + 1] += y - minY
    sum[3 * v + 2] += z - minZ
    if (col) {
      rgb[3 * v] += col[3 * i]
      rgb[3 * v + 1] += col[3 * i + 1]
      rgb[3 * v + 2] += col[3 * i + 2]
    }
    if (hag[i] > top[v]) top[v] = hag[i]
    cnt[v]++
  }
  const cx = new Float64Array(nv),
    cy = new Float64Array(nv),
    cz = new Float64Array(nv),
    exg = new Float32Array(nv)
  for (let v = 0; v < nv; v++) {
    cx[v] = sum[3 * v] / cnt[v]
    cy[v] = sum[3 * v + 1] / cnt[v]
    cz[v] = sum[3 * v + 2] / cnt[v]
    if (col) exg[v] = excessGreen(rgb[3 * v], rgb[3 * v + 1], rgb[3 * v + 2])
  }
  onProgress?.(0.2)

  // ── 2. Covariance features over the voxel centroids within `radius` ─────────
  // A search grid of `radius` cells: a voxel's neighbours are in its cell and the 26
  // around it.
  const k = Math.max(1, Math.round(radius / voxel)) // voxels per search cell
  const sIndex = new Map() // search-cell key → [voxel ids]
  const sx = Math.floor(nx / k) + 1,
    sy = Math.floor(Math.floor((maxY - minY) / voxel) / k) + 1
  const sKey = (a, b, c) => a + sx * (b + sy * c)
  for (let v = 0; v < nv; v++) {
    const key = sKey(Math.floor(cell[3 * v] / k), Math.floor(cell[3 * v + 1] / k), Math.floor(cell[3 * v + 2] / k))
    const list = sIndex.get(key)
    if (list) list.push(v)
    else sIndex.set(key, [v])
  }
  const planar = new Uint8Array(nv)
  const scatter = new Float32Array(nv)
  const nrm = new Float32Array(3 * nv)
  const eig = new Float64Array(12)
  const r2 = radius * radius
  for (let v = 0; v < nv; v++) {
    const a = Math.floor(cell[3 * v] / k),
      b = Math.floor(cell[3 * v + 1] / k),
      c = Math.floor(cell[3 * v + 2] / k)
    let m = 0,
      mx = 0,
      my = 0,
      mz = 0,
      xx = 0,
      xy = 0,
      xz = 0,
      yy = 0,
      yz = 0,
      zz = 0
    for (let dc = -1; dc <= 1; dc++)
      for (let db = -1; db <= 1; db++)
        for (let da = -1; da <= 1; da++) {
          const list = sIndex.get(sKey(a + da, b + db, c + dc))
          if (!list) continue
          for (const w of list) {
            const dx = cx[w] - cx[v],
              dy = cy[w] - cy[v],
              dz = cz[w] - cz[v]
            if (dx * dx + dy * dy + dz * dz > r2) continue
            m++
            mx += dx
            my += dy
            mz += dz
            xx += dx * dx
            xy += dx * dy
            xz += dx * dz
            yy += dy * dy
            yz += dy * dz
            zz += dz * dz
          }
        }
    if (m < 5) {
      scatter[v] = 1 // too sparse to say: reads as scatter, never as a plane
      continue
    }
    mx /= m
    my /= m
    mz /= m
    eigenSym3(
      xx / m - mx * mx,
      xy / m - mx * my,
      xz / m - mx * mz,
      yy / m - my * my,
      yz / m - my * mz,
      zz / m - mz * mz,
      eig,
    )
    const l3 = Math.max(0, eig[0]),
      l2 = Math.max(0, eig[1]),
      l1 = Math.max(eig[2], 1e-30)
    scatter[v] = l3 / l1
    planar[v] = (l2 - l3) / l1 >= minPlanarity && l3 / l1 <= maxScatter ? 1 : 0
    nrm[3 * v] = eig[3]
    nrm[3 * v + 1] = eig[4]
    nrm[3 * v + 2] = eig[5]
  }
  onProgress?.(0.7)

  // ── 3. Buildings: planar segments, tall and large enough ────────────────────
  const label = new Uint8Array(nv) // 0 none, else the LAS class
  // The voxels at most `steps` voxel steps (face, edge or corner) from a voxel marked in
  // `seed`, moving only through voxels `allow` admits.
  const within = (seed, steps, allow) => {
    const out = new Uint8Array(nv)
    let front = []
    for (let v = 0; v < nv; v++)
      if (seed[v]) {
        out[v] = 1
        front.push(v)
      }
    for (let step = 0; step < steps && front.length; step++) {
      const next = []
      for (const v of front) {
        const ix = cell[3 * v],
          iy = cell[3 * v + 1],
          iz = cell[3 * v + 2]
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const jx = ix + dx,
                jy = iy + dy
              if (jx < 0 || jy < 0 || jx >= nx || jy >= ny || iz + dz < 0) continue
              const w = index.get(keyOf(jx, jy, iz + dz))
              if (w === undefined || out[w] || !allow(w)) continue
              out[w] = 1
              next.push(w)
            }
      }
      front = next
    }
    return out
  }
  let segments = 0,
    buildingSegments = 0
  if (buildings) {
    const seg = new Int32Array(nv).fill(-1)
    const cosMax = Math.cos((normalAngleDeg * Math.PI) / 180)
    const stack = []
    const members = []
    const walls = [] // qualifying segments that are mostly vertical: [voxel ids]
    for (let s0 = 0; s0 < nv; s0++) {
      if (!planar[s0] || seg[s0] >= 0) continue
      const id = segments++
      seg[s0] = id
      stack.push(s0)
      members.length = 0
      let highest = -Infinity,
        green = 0,
        upright = 0
      while (stack.length) {
        const v = stack.pop()
        members.push(v)
        if (top[v] > highest) highest = top[v]
        green += exg[v]
        upright += Math.abs(nrm[3 * v + 2])
        const ix = cell[3 * v],
          iy = cell[3 * v + 1],
          iz = cell[3 * v + 2]
        for (let dz = -1; dz <= 1; dz++)
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy && !dz) continue
              const jx = ix + dx,
                jy = iy + dy
              if (jx < 0 || jy < 0 || jx >= nx || jy >= ny || iz + dz < 0) continue
              const w = index.get(keyOf(jx, jy, iz + dz))
              if (w === undefined || seg[w] >= 0 || !planar[w]) continue
              const dot = nrm[3 * v] * nrm[3 * w] + nrm[3 * v + 1] * nrm[3 * w + 1] + nrm[3 * v + 2] * nrm[3 * w + 2]
              if (Math.abs(dot) < cosMax) continue
              seg[w] = id
              stack.push(w)
            }
      }
      const area = members.length * voxel * voxel
      const isGreen = colour && green / members.length > greenExg
      if (highest >= minBuildingHeight && area >= minBuildingArea && !isGreen) {
        // A wall alone (a retaining wall, a noise barrier) is no building: a mostly
        // vertical segment waits to see whether it meets a roof.
        if (upright / members.length < WALL_NZ) walls.push([...members])
        else {
          buildingSegments++
          for (const v of members) label[v] = CLASS_BUILDING
        }
      }
    }
    // Walls within `radius` of a roof belong to its building.
    if (walls.length) {
      const nearRoof = within(label, k + 1, () => true)
      for (const wall of walls) {
        if (!wall.some((v) => nearRoof[v])) continue
        buildingSegments++
        for (const v of wall) label[v] = CLASS_BUILDING
      }
    }
    // A building's edges and corners see two planes within `radius`, so they are not
    // planar themselves: the segments take the voxels up to `radius` around them that
    // are not green.
    const edge = within(label, k, (w) => !(colour && exg[w] > greenExg))
    for (let v = 0; v < nv; v++) if (edge[v] && !label[v]) label[v] = CLASS_BUILDING
  }
  onProgress?.(0.85)

  // ── 4. Vegetation: what scatters or is green, by height ─────────────────────
  // Scatter within `radius` of a plane is the edge of something built (a car, a wall
  // too small to be a building), not vegetation; green is vegetation anywhere, and a
  // colour clearly not green (a red car, a blue tarpaulin) never.
  if (vegetation) {
    const nearPlane = within(planar, k, () => true)
    for (let v = 0; v < nv; v++) {
      if (label[v]) continue
      const green = colour && exg[v] > greenExg
      if (colour && exg[v] < -greenExg) continue
      if (!(green || (scatter[v] > maxScatter && !nearPlane[v]))) continue
      label[v] =
        top[v] <= lowVegetationMax
          ? CLASS_LOW_VEGETATION
          : top[v] <= mediumVegetationMax
            ? CLASS_MEDIUM_VEGETATION
            : CLASS_HIGH_VEGETATION
    }
  }

  // ── 5. Points take their voxel's class ──────────────────────────────────────
  for (let i = 0; i < count; i++) {
    const v = of[i]
    if (v < 0 || !label[v]) continue
    const c = label[v]
    classes[i] = c
    if (c === CLASS_BUILDING) counts.building++
    else if (c === CLASS_LOW_VEGETATION) counts.low++
    else if (c === CLASS_MEDIUM_VEGETATION) counts.medium++
    else counts.high++
  }
  onProgress?.(1)
  return { counts, voxels: nv, voxel: voxelUsed, segments, buildingSegments, colour }
}

// The voxel for this cloud: `voxel`, doubled while an occupied voxel holds fewer than
// two candidate points on average (a surface's voxels then touch), at most twice.
function fitVoxel(pos, count, classes, hag, voxel, minX, minY, minZ) {
  for (let step = 0; step < 2; step++) {
    const seen = new Set()
    let n = 0
    for (let i = 0; i < count; i++) {
      if (classes[i] !== CLASS_UNCLASSIFIED || !Number.isFinite(hag[i])) continue
      n++
      const ix = Math.floor((pos[3 * i] - minX) / voxel),
        iy = Math.floor((pos[3 * i + 1] - minY) / voxel),
        iz = Math.floor((pos[3 * i + 2] - minZ) / voxel)
      seen.add(ix + 1048576 * (iy + 1048576 * iz))
    }
    if (n >= 2 * seen.size) break
    voxel *= 2
  }
  return voxel
}
