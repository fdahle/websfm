// Checkerboard GCP targets (the black-and-white quadrant mats of drone surveys): find the
// centre of one near where the model predicts it (Tools ▸ Images ▸ Detect targets,
// plan-after-0.7 ▸ TGT). Such a centre is a saddle point of the image brightness: along
// one diagonal it rises, along the other it falls. Pure: grey windows in, a position out.
//
//   gray   { data: Float32Array (0–255), width, height } — a window of the photo
//   guess  { x, y } in that window's pixel-centre coordinates
// findCheckerCorner → { x, y, score, contrast } or null.
//
// 1. Smooth (Gaussian, σ ≈ the blur of a printed edge at drone heights) and take the
//    saddle response −det(Hessian) = fxy² − fxx·fyy, positive only at saddles.
// 2. Take the strongest local maxima within `radius` of the guess and keep the first whose
//    four quadrants look like a target: the two diagonal pairs alike, the pairs apart.
// 3. Refine to sub-pixel as OpenCV's cornerSubPix does: the centre q is where every
//    gradient around it is orthogonal to (p − q), i.e. Σ g·gᵀ·(p − q) = 0, iterated.

// A separable Gaussian blur of a window.
export function gaussianBlur({ data, width, height }, sigma) {
  const r = Math.max(1, Math.ceil(3 * sigma))
  const k = new Float32Array(2 * r + 1)
  let sum = 0
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma))
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(width * height),
    out = new Float32Array(width * height)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += k[i + r] * data[y * width + Math.min(width - 1, Math.max(0, x + i))]
      tmp[y * width + x] = s
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let s = 0
      for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(height - 1, Math.max(0, y + i)) * width + x]
      out[y * width + x] = s
    }
  return { data: out, width, height }
}

// −det(Hessian) at every interior pixel (0 at the border).
export function saddleResponse({ data, width, height }) {
  const out = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const fxx = data[i - 1] - 2 * data[i] + data[i + 1]
      const fyy = data[i - width] - 2 * data[i] + data[i + width]
      const fxy = (data[i - width - 1] + data[i + width + 1] - data[i - width + 1] - data[i + width - 1]) / 4
      out[i] = Math.max(0, fxy * fxy - fxx * fyy)
    }
  return out
}

function sample({ data, width, height }, x, y) {
  const x0 = Math.max(0, Math.min(width - 2, Math.floor(x))),
    y0 = Math.max(0, Math.min(height - 2, Math.floor(y)))
  const tx = Math.max(0, Math.min(1, x - x0)),
    ty = Math.max(0, Math.min(1, y - y0))
  const i = y0 * width + x0
  return (
    (1 - ty) * ((1 - tx) * data[i] + tx * data[i + 1]) + ty * ((1 - tx) * data[i + width] + tx * data[i + width + 1])
  )
}

// The four quadrants' mean brightness around (x, y) at distances r/3 … r, the quadrants
// taken about the strongest pair of opposite directions; → { contrast (0–1), ok }.
export function quadrantTest(gray, x, y, r) {
  // Mean along N = 32 rays, then the best split of the circle into 4 quarters.
  const N = 32
  const ray = new Float64Array(N)
  for (let k = 0; k < N; k++) {
    const a = (2 * Math.PI * k) / N
    let s = 0
    for (let t = 1; t <= 3; t++) s += sample(gray, x + ((r * t) / 3) * Math.cos(a), y + ((r * t) / 3) * Math.sin(a))
    ray[k] = s / 3
  }
  let best = null
  for (let off = 0; off < N / 4; off++) {
    const q = [0, 0, 0, 0]
    for (let k = 0; k < N; k++) q[Math.floor(((k - off + N) % N) / (N / 4))] += ray[k] / (N / 4)
    const contrast = Math.abs(q[0] + q[2] - q[1] - q[3]) / 2 / 255
    if (!best || contrast > best.contrast) best = { q, contrast }
  }
  const { q, contrast } = best
  // Opposite quarters alike, and each well apart from its neighbours.
  const spread = Math.max(Math.abs(q[0] - q[2]), Math.abs(q[1] - q[3])) / 255
  const ok = contrast > 0.12 && spread < 0.6 * contrast
  return { contrast, ok }
}

// Sub-pixel refinement by gradient orthogonality in a (2·half + 1)² window.
export function refineCorner(gray, x, y, half = 4, iterations = 20) {
  const g = gray
  let qx = x,
    qy = y
  for (let it = 0; it < iterations; it++) {
    let a = 0,
      b = 0,
      c = 0,
      bx = 0,
      by = 0
    for (let dy = -half; dy <= half; dy++)
      for (let dx = -half; dx <= half; dx++) {
        const px = qx + dx,
          py = qy + dy
        const gx = (sample(g, px + 1, py) - sample(g, px - 1, py)) / 2
        const gy = (sample(g, px, py + 1) - sample(g, px, py - 1)) / 2
        // Weight toward the centre, as cornerSubPix's Gaussian window.
        const w = Math.exp(-(dx * dx + dy * dy) / (2 * (half / 2) ** 2))
        a += w * gx * gx
        b += w * gx * gy
        c += w * gy * gy
        bx += w * (gx * gx * px + gx * gy * py)
        by += w * (gx * gy * px + gy * gy * py)
      }
    const det = a * c - b * b
    if (!(Math.abs(det) > 1e-9)) break
    const nx = (c * bx - b * by) / det,
      ny = (a * by - b * bx) / det
    const moved = Math.hypot(nx - qx, ny - qy)
    qx = nx
    qy = ny
    if (moved < 1e-3) break
  }
  return { x: qx, y: qy }
}

// The target centre nearest the guess, or null. `sigma` the smoothing, `radius` how far
// from the guess to look, `quadRadius` how far out the quadrant test samples (the mat's
// half-size in pixels, roughly).
export function findCheckerCorner(gray, guess, { sigma = 1.5, radius = 30, quadRadius = 8 } = {}) {
  const smooth = gaussianBlur(gray, sigma)
  const resp = saddleResponse(smooth)
  const { width, height } = gray
  const cands = []
  const x0 = Math.max(2, Math.floor(guess.x - radius)),
    x1 = Math.min(width - 3, Math.ceil(guess.x + radius))
  const y0 = Math.max(2, Math.floor(guess.y - radius)),
    y1 = Math.min(height - 3, Math.ceil(guess.y + radius))
  let peak = 0
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const v = resp[y * width + x]
      if (v <= 0 || Math.hypot(x - guess.x, y - guess.y) > radius) continue
      let max = true
      for (let dy = -2; dy <= 2 && max; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if ((dx || dy) && resp[(y + dy) * width + x + dx] > v) {
            max = false
            break
          }
      if (max) {
        cands.push({ x, y, v })
        peak = Math.max(peak, v)
      }
    }
  cands.sort((a, b) => b.v - a.v)
  for (const c of cands.slice(0, 8)) {
    if (c.v < 0.2 * peak) break
    const quad = quadrantTest(smooth, c.x, c.y, quadRadius)
    if (!quad.ok) continue
    const p = refineCorner(smooth, c.x, c.y, Math.max(3, Math.round(quadRadius / 2)))
    if (Math.hypot(p.x - c.x, p.y - c.y) > 3) continue
    return { x: p.x, y: p.y, contrast: quad.contrast, score: Math.min(1, quad.contrast * 2) }
  }
  return null
}
