// Multiband (Laplacian pyramid) seam blending for the mosaicked orthophoto (plan O4b).
// Pure, typed arrays, one block window at a time.
//
// Burt & Adelson (1983), "A multiresolution spline": split each photo into frequency
// bands and blend every band across a seam over a width matched to it — the fine
// detail switches within a cell or two, so nothing ghosts, while the low frequencies
// (exposure, vignetting, haze) fade over 2^levels cells, so no step shows. Each band
// k of photo j is weighted by its region mask M_j smoothed to the same level, G_k(M_j),
// and the weights are normalised per level (OpenCV's MultiBandBlender does the same).
//
// Formulated as a correction to the hard-seam mosaic. Let `base` be the mosaic with
// hard seams (every cell from its own label) and d_j = c_j − base, photo j's colour
// minus the base, which is zero inside j's own region. The pyramid operations are
// linear for a fixed validity pyramid, so the blend Σ_j G_k(M_j)·L_k(c_j) / Σ_j G_k(M_j)
// equals L_k(base) + Σ_j G_k(M_j)·L_k(d_j) / V_k, and collapsing the pyramid gives
//   result = base + collapse_k( Σ_j G_k(M_j)·L_k(d_j) / V_k ).
// d_j is only non-zero on a ring around j's region (RING cells wide, where j's own
// colour is sampled), so each photo needs only its region's box plus a margin, and a
// cell deep inside a region keeps its photo's colour exactly — no sharpness lost there.
//
// Normalised convolution. V_0 is 1 on cells with a label and 0 elsewhere (holes, the
// grid edge); every pyramid level divides by the matching level of V, so the edge of
// the data is no darker than its inside. V_k = Σ_j G_k(M_j) is also the weight sum.
//
// Exactness across blocks. The kernel is the 5-tap [1 4 6 4 1]/16, so every value has a
// finite cone. A block window is aligned to the 2^levels lattice of the grid (so its
// pyramid cells are the grid's) and extends `halo` cells past its core, enough that no
// core cell reads a value the window's edge truncated: blocks join bit for bit. A
// photo's box margin (RING + 2^(levels+1)) holds all of its d_j pyramid's support, so a
// box's own edge never truncates either.

export const MULTIBAND_LEVELS = 5

// The radii a blend with `levels` levels needs (in cells): the ring around a region
// where a photo's own colour is sampled (its coarsest weight G_L(M) reaches 2^(L+1) − 2
// cells past the region), a photo's box margin, and the window halo beyond the block
// core (the cone of a core cell's correction, 4·2^L, plus the ring it reads).
export function multibandReach(levels = MULTIBAND_LEVELS) {
  const ring = 2 << levels
  return { ring, margin: ring + (2 << levels), halo: 4 * (1 << levels) + ring, align: 1 << levels }
}

const W0 = 1 / 16,
  W1 = 4 / 16,
  W2 = 6 / 16

// REDUCE: blur with the 5-tap kernel and keep every other cell, zero outside [w × h].
// dst is ceil(w/2) × ceil(h/2); tmp holds h × ceil(w/2). The interior runs without the
// edge tests; every cell adds its taps in the same order either way.
function reduce(src, so, w, h, dst, dO, tmp) {
  const w2 = (w + 1) >> 1,
    h2 = (h + 1) >> 1
  const mIn = Math.max(1, Math.min(w2, (w - 1) >> 1)) // cells 1 ≤ m < mIn have all four taps
  for (let r = 0; r < h; r++) {
    const row = so + r * w,
      t = r * w2
    if (w2 > 0) reduceCell(src, row, w, tmp, t, 0)
    for (let m = 1, c = row + 2; m < mIn; m++, c += 2) {
      tmp[t + m] = W2 * src[c] + W1 * src[c - 1] + W0 * src[c - 2] + W1 * src[c + 1] + W0 * src[c + 2]
    }
    for (let m = mIn; m < w2; m++) reduceCell(src, row, w, tmp, t, m)
  }
  for (let m = 0; m < h2; m++) {
    const r = 2 * m,
      o = dO + m * w2,
      t = r * w2
    if (r >= 2 && r + 2 < h) {
      for (let c = 0; c < w2; c++) {
        dst[o + c] =
          W2 * tmp[t + c] +
          W1 * tmp[t - w2 + c] +
          W0 * tmp[t - 2 * w2 + c] +
          W1 * tmp[t + w2 + c] +
          W0 * tmp[t + 2 * w2 + c]
      }
      continue
    }
    for (let c = 0; c < w2; c++) {
      let s = W2 * tmp[t + c]
      if (r >= 1) s += W1 * tmp[t - w2 + c]
      if (r >= 2) s += W0 * tmp[t - 2 * w2 + c]
      if (r + 1 < h) s += W1 * tmp[t + w2 + c]
      if (r + 2 < h) s += W0 * tmp[t + 2 * w2 + c]
      dst[o + c] = s
    }
  }
}
function reduceCell(src, row, w, tmp, t, m) {
  const c = 2 * m
  let s = W2 * src[row + c]
  if (c >= 1) s += W1 * src[row + c - 1]
  if (c >= 2) s += W0 * src[row + c - 2]
  if (c + 1 < w) s += W1 * src[row + c + 1]
  if (c + 2 < w) s += W0 * src[row + c + 2]
  tmp[t + m] = s
}

// EXPAND as a weighted sum (no ×4: it is always used as a ratio of two expands):
// out[i] = Σ_m w(i − 2m)·in[m] per axis, from sw × sh into dw × dh (sw = ceil(dw/2)).
// tmp holds sh × dw. Edge cells keep their `+ 0` so a −0 rounds as before.
function expandSum(src, so, sw, sh, dst, dO, dw, dh, tmp) {
  const mIn = Math.max(1, Math.min(sw - 1, dw >> 1)) // 1 ≤ m < mIn: m ± 1 inside, both outputs exist
  for (let r = 0; r < sh; r++) {
    const row = so + r * sw,
      t = r * dw
    if (dw > 0) expandCell(src, row, sw, tmp, t, dw, 0)
    for (let m = 1, x = row + 1, i = t + 2; m < mIn; m++, x++, i += 2) {
      tmp[i] = W2 * src[x] + W0 * src[x - 1] + W0 * src[x + 1]
      tmp[i + 1] = W1 * src[x] + W1 * src[x + 1]
    }
    for (let m = mIn; 2 * m < dw; m++) expandCell(src, row, sw, tmp, t, dw, m)
  }
  for (let i = 0; i < dh; i++) {
    const m = i >> 1,
      o = dO + i * dw,
      t = m * dw
    if (i & 1) {
      if (m + 1 < sh) for (let c = 0; c < dw; c++) dst[o + c] = W1 * tmp[t + c] + W1 * tmp[t + dw + c]
      else for (let c = 0; c < dw; c++) dst[o + c] = W1 * tmp[t + c] + 0
    } else if (m >= 1 && m + 1 < sh) {
      for (let c = 0; c < dw; c++) dst[o + c] = W2 * tmp[t + c] + W0 * tmp[t - dw + c] + W0 * tmp[t + dw + c]
    } else {
      for (let c = 0; c < dw; c++) {
        dst[o + c] = W2 * tmp[t + c] + (m >= 1 ? W0 * tmp[t - dw + c] : 0) + (m + 1 < sh ? W0 * tmp[t + dw + c] : 0)
      }
    }
  }
}
// The two outputs 2m, 2m + 1 of source cell m (where they exist), with the edge tests.
function expandCell(src, row, sw, tmp, t, dw, m) {
  const i = 2 * m
  tmp[t + i] = W2 * src[row + m] + (m >= 1 ? W0 * src[row + m - 1] : 0) + (m + 1 < sw ? W0 * src[row + m + 1] : 0)
  if (i + 1 < dw) tmp[t + i + 1] = W1 * src[row + m] + (m + 1 < sw ? W1 * src[row + m + 1] : 0)
}

// Level offsets and sizes of a pyramid over w × h.
function layout(w, h, levels) {
  const dims = [],
    off = []
  let o = 0
  for (let k = 0; k <= levels; k++) {
    const lw = Math.ceil(w / 2 ** k),
      lh = Math.ceil(h / 2 ** k)
    dims.push([lw, lh])
    off.push(o)
    o += lw * lh
  }
  return { dims, off, size: o }
}

// Buffers for windows of up to maxW × maxH cells: the window's validity pyramid V and
// its expands EV, the correction accumulators (3 channels), and a photo box's scratch
// (its mask and one channel's pyramid, an expand, the separable pass) — about
// 7 · 4/3 + 2 floats per cell (MULTIBAND_BYTES_PER_CELL).
export function createMultiband(maxW, maxH, levels = MULTIBAND_LEVELS) {
  const pyr = layout(maxW, maxH, levels).size,
    maxCells = maxW * maxH
  return {
    levels,
    V: new Float32Array(pyr),
    EV: new Float32Array(pyr),
    acc: [0, 1, 2].map(() => new Float32Array(pyr)),
    M: new Float32Array(pyr),
    N: new Float32Array(pyr),
    E: new Float32Array(maxCells),
    tmp: new Float32Array(maxCells + 64),
    win: null,
  }
}
// Bytes per window cell of createMultiband (for the block's memory preflight).
export const MULTIBAND_BYTES_PER_CELL = 4 * ((4 / 3) * 7 + 2)

// Start a window of ew × eh cells with its label plane (stride ew; `none` = no label).
export function multibandBegin(mb, ew, eh, labels, none) {
  const L = mb.levels,
    lay = layout(ew, eh, L)
  mb.win = { ew, eh, lay }
  const { V, EV, tmp } = mb
  for (let i = 0, n = ew * eh; i < n; i++) V[i] = labels[i] !== none ? 1 : 0
  for (let k = 0; k < L; k++) {
    const [w, h] = lay.dims[k]
    reduce(V, lay.off[k], w, h, V, lay.off[k + 1], tmp)
  }
  for (let k = 0; k < L; k++) {
    const [w, h] = lay.dims[k],
      [w1, h1] = lay.dims[k + 1]
    expandSum(V, lay.off[k + 1], w1, h1, EV, lay.off[k], w, h, tmp)
  }
  for (const a of mb.acc) a.fill(0, 0, lay.size)
}

// Add photo j's correction. Its box [bx0, bx0 + bw) × [by0, by0 + bh) in window cells,
// bx0/by0 multiples of 2^levels; d: 3 floats per box cell (j's colour minus the base,
// zero where j is not sampled); j's region: the window cells labelled j.
export function multibandAdd(mb, bx0, by0, bw, bh, d, labels, j) {
  const L = mb.levels,
    { lay, ew } = mb.win,
    box = layout(bw, bh, L)
  const { V, EV, M, N, E, tmp, acc } = mb
  for (let r = 0, i = 0; r < bh; r++) {
    const row = (by0 + r) * ew + bx0
    for (let c = 0; c < bw; c++, i++) M[i] = labels[row + c] === j ? 1 : 0
  }
  for (let k = 0; k < L; k++) reduce(M, box.off[k], box.dims[k][0], box.dims[k][1], M, box.off[k + 1], tmp)
  for (let ch = 0; ch < 3; ch++) {
    for (let i = 0, n = bw * bh; i < n; i++) N[i] = d[3 * i + ch]
    for (let k = 0; k < L; k++) reduce(N, box.off[k], box.dims[k][0], box.dims[k][1], N, box.off[k + 1], tmp)
    const a = acc[ch]
    for (let k = 0; k <= L; k++) {
      const [w, h] = box.dims[k],
        wo = lay.off[k],
        ww = lay.dims[k][0],
        bo = box.off[k]
      const ox = bx0 >> k,
        oy = by0 >> k
      if (k < L) expandSum(N, box.off[k + 1], box.dims[k + 1][0], box.dims[k + 1][1], E, 0, w, h, tmp)
      for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++) {
          const bi = r * w + c,
            g = M[bo + bi]
          if (g === 0) continue
          const wi = wo + (oy + r) * ww + ox + c,
            v = V[wi]
          if (!(v > 0)) continue
          let lp = N[bo + bi] / v
          if (k < L) {
            const ev = EV[wi]
            if (ev > 0) lp -= E[bi] / ev
          }
          a[wi] += g * lp
        }
    }
  }
}

// Collapse the corrections and add them to `base` (4 floats per window cell, linear
// RGB + unused) on the labelled cells.
export function multibandFinish(mb, base) {
  const L = mb.levels,
    { lay, ew, eh } = mb.win
  const { V, EV, E, tmp, acc, N } = mb
  for (const a of acc) {
    // corr_L = acc_L / V_L; corr_k = acc_k / V_k + E(corr_{k+1}·V_{k+1}) / EV_k
    {
      const o = lay.off[L],
        n = lay.dims[L][0] * lay.dims[L][1]
      for (let i = 0; i < n; i++) a[o + i] = V[o + i] > 0 ? a[o + i] / V[o + i] : 0
    }
    for (let k = L - 1; k >= 0; k--) {
      const [w, h] = lay.dims[k],
        [w1, h1] = lay.dims[k + 1],
        o = lay.off[k],
        o1 = lay.off[k + 1]
      for (let i = 0, n = w1 * h1; i < n; i++) N[i] = a[o1 + i] * V[o1 + i]
      expandSum(N, 0, w1, h1, E, 0, w, h, tmp)
      for (let i = 0, n = w * h; i < n; i++) {
        const v = V[o + i]
        a[o + i] = v > 0 ? a[o + i] / v + (EV[o + i] > 0 ? E[i] / EV[o + i] : 0) : 0
      }
    }
  }
  for (let i = 0, n = ew * eh; i < n; i++) {
    if (!(V[i] > 0)) continue
    base[4 * i] += acc[0][i]
    base[4 * i + 1] += acc[1][i]
    base[4 * i + 2] += acc[2][i]
  }
}
