// The orthophoto's low-level geometry, shared by every pass (ortho.js) and the mosaic
// (orthoMosaic.js): projecting into a map, sampling a photo, a ground cell's 3D point,
// the window's tiles of linearised cells, and the conservative map/box cull.
// Pure: no Vue/Pinia/OPFS/DOM.
import { sampleRgbaBilinear, sampleRgbBilinear } from './undistort.js'

// Project a world point into a map, requiring it in front of the camera.
// Returns { u, v, depth } (u,v continuous px) or null.
export function projectInto(m, P) {
  const { R, t, K } = m
  const zc = R[2][0] * P[0] + R[2][1] * P[1] + R[2][2] * P[2] + t[2]
  if (!(zc > 1e-9)) return null
  const xc = R[0][0] * P[0] + R[0][1] * P[1] + R[0][2] * P[2] + t[0]
  const yc = R[1][0] * P[0] + R[1][1] * P[1] + R[1][2] * P[2] + t[1]
  return { u: K.fx * (xc / zc) + K.cx, v: K.fy * (yc / zc) + K.cy, depth: zc }
}

// The per-cell source label (Uint16Array): which map coloured the cell, NO_LABEL where
// none did. Only 'best' has one ('average' mixes every visible view), and only below
// 65,535 maps — otherwise null.
export const NO_LABEL = 0xffff

export const newLabels = (n, opts, nMaps) =>
  opts.blend !== 'average' && nMaps < NO_LABEL ? new Uint16Array(n).fill(NO_LABEL) : null

// A decoded photo: RGBA, or packed RGB with `channels: 3` (the products worker's loader).
export const samplePhoto = (photo, x, y, px) =>
  (photo.channels === 3 ? sampleRgbBilinear : sampleRgbaBilinear)(photo.data, photo.width, photo.height, x, y, px, 0)

export const cameraCentre = ({ R, t }) => [
  -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
  -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
  -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
]

// A cell centre of the grid in SfM coordinates, into P.
export function cellToSfm(grid, affine, toSfm, col, row, z, P) {
  const x = grid.originX + (col + 0.5) * grid.gsd,
    y = grid.originY - (row + 0.5) * grid.gsd
  if (affine) {
    const { c0, P0, A } = affine,
      dx = x - c0[0],
      dy = y - c0[1],
      dz = z - c0[2]
    P[0] = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
    P[1] = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
    P[2] = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
  } else {
    const q = toSfm([x, y, z])
    P[0] = q[0]
    P[1] = q[1]
    P[2] = q[2]
  }
}

// Within a block window, a map usually sees a part only: the window is split into
// WIN_TILE² tiles and a pass visits only the tiles the map can see (the block cull's
// exact box test, per tile with its own height range), so it computes exactly what a
// loop over every cell would. `winTiles` sets the ranges up once per window.
export const WIN_TILE = 64

// Per tile, the frame without an exact affine (gp.local): the affine for its culls, and
// for its cells when it misses by under CELL_AFFINE_TOL of a cell (else the cells take
// the exact frame). The transform does not depend on the map, so a window's tiles are
// fitted once for all the maps that visit it.
const CELL_AFFINE_TOL = 1e-3

export function winTiles(win, grid = null, gp = null) {
  const { w, h, data, mask } = win,
    nx = Math.ceil(w / WIN_TILE),
    ny = Math.ceil(h / WIN_TILE)
  const lo = new Float64Array(nx * ny).fill(Infinity),
    hi = new Float64Array(nx * ny).fill(-Infinity)
  for (let r = 0; r < h; r++) {
    const tr = Math.floor(r / WIN_TILE) * nx
    for (let c = 0; c < w; c++) {
      const i = r * w + c
      if (!mask[i]) continue
      const t = tr + Math.floor(c / WIN_TILE),
        z = data[i]
      if (z < lo[t]) lo[t] = z
      if (z > hi[t]) hi[t] = z
    }
  }
  let near = null,
    cellAff = null
  if (gp && !gp.affine && gp.local) {
    near = new Array(nx * ny).fill(null)
    cellAff = new Array(nx * ny).fill(null)
    const { gsd, originX, originY } = grid
    for (let t = 0; t < nx * ny; t++) {
      if (!(lo[t] <= hi[t])) continue
      const tx = t % nx,
        ty = Math.floor(t / nx)
      const c0 = tx * WIN_TILE,
        r0 = ty * WIN_TILE,
        c1 = Math.min(w, c0 + WIN_TILE),
        r1 = Math.min(h, r0 + WIN_TILE)
      const fit = gp.local([
        originX + (win.x0 + c0 + 0.5) * gsd,
        originX + (win.x0 + c1 - 0.5) * gsd,
        originY - (win.y0 + r1 - 0.5) * gsd,
        originY - (win.y0 + r0 + 0.5) * gsd,
        lo[t],
        hi[t],
      ])
      near[t] = fit
      if (fit.err <= CELL_AFFINE_TOL * gsd * fit.stretch) cellAff[t] = fit
    }
  }
  win.tiles = { nx, ny, lo, hi, near, cellAff }
}

// A window cell (c, r) into SfM: the frame's exact affine, else its tile's (winTiles),
// else the exact frame.
export function winCellToSfm(win, grid, gp, toSfm, c, r, z, P) {
  const aff =
    gp.affine ?? win.tiles?.cellAff?.[Math.floor(r / WIN_TILE) * win.tiles.nx + Math.floor(c / WIN_TILE)] ?? null
  cellToSfm(grid, aff, toSfm, win.x0 + c, win.y0 + r, z, P)
}

// Call fn(c0, r0, c1, r1) for the part of window box [bx0, bx1) × [by0, by1) in each tile
// that map m can see (every tile when the frame is not affine).
export function forTilesReaching(win, grid, m, affine, bx0, by0, bx1, by1, fn) {
  const { nx, lo, hi } = win.tiles,
    { gsd, originX, originY } = grid
  for (let ty = Math.floor(by0 / WIN_TILE); ty * WIN_TILE < by1; ty++)
    for (let tx = Math.floor(bx0 / WIN_TILE); tx * WIN_TILE < bx1; tx++) {
      const t = ty * nx + tx
      if (!(lo[t] <= hi[t])) continue
      const c0 = Math.max(bx0, tx * WIN_TILE),
        r0 = Math.max(by0, ty * WIN_TILE)
      const c1 = Math.min(bx1, (tx + 1) * WIN_TILE, win.w),
        r1 = Math.min(by1, (ty + 1) * WIN_TILE, win.h)
      if (affine) {
        const box = [
          originX + (win.x0 + c0 + 0.5) * gsd,
          originX + (win.x0 + c1 - 0.5) * gsd,
          originY - (win.y0 + r1 - 0.5) * gsd,
          originY - (win.y0 + r0 + 0.5) * gsd,
          lo[t],
          hi[t],
        ]
        if (!boxReachesMap(m, affine, box)) continue
      } else if (win.tiles.near?.[t]) {
        // The tile's own affine, its whole (grown) box: never culls what the frame sees.
        const near = win.tiles.near[t]
        if (!boxReachesMap(m, near, near.box)) continue
      }
      fn(c0, r0, c1, r1)
    }
}

// Can any cell of the frame-coordinate box [x0,x1]×[y0,y1]×[z0,z1] land on map m?
// Projected through the grid's affine toSfm, the box is a parallelepiped; u and v are
// linear-fractional in the point, so where the box lies wholly in front of the camera
// their extremes are at its corners. A box straddling the camera plane is kept; one
// wholly behind it is not (depth is affine too).
export function boxReachesMap(m, affine, [x0, x1, y0, y1, z0, z1]) {
  const { c0, P0, A } = affine,
    { R, t, K } = m
  let behind = 0,
    straddle = false
  let uMin = Infinity,
    uMax = -Infinity,
    vMin = Infinity,
    vMax = -Infinity
  for (let k = 0; k < 8; k++) {
    const dx = (k & 1 ? x1 : x0) - c0[0],
      dy = (k & 2 ? y1 : y0) - c0[1],
      dz = (k & 4 ? z1 : z0) - c0[2]
    const X = P0[0] + A[0] * dx + A[1] * dy + A[2] * dz
    const Y = P0[1] + A[3] * dx + A[4] * dy + A[5] * dz
    const Z = P0[2] + A[6] * dx + A[7] * dy + A[8] * dz
    const zc = R[2][0] * X + R[2][1] * Y + R[2][2] * Z + t[2]
    if (!(zc > 1e-9)) {
      behind++
      straddle = true
      continue
    }
    const xc = R[0][0] * X + R[0][1] * Y + R[0][2] * Z + t[0]
    const yc = R[1][0] * X + R[1][1] * Y + R[1][2] * Z + t[1]
    const u = K.fx * (xc / zc) + K.cx,
      v = K.fy * (yc / zc) + K.cy
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v < vMin) vMin = v
    if (v > vMax) vMax = v
  }
  if (behind === 8) return false
  if (straddle) return true
  // The kernel accepts round(u) ∈ [0, width − 1], i.e. u ∈ [−½, width − ½).
  return uMax >= -1.5 && uMin <= m.width + 0.5 && vMax >= -1.5 && vMin <= m.height + 0.5
}
