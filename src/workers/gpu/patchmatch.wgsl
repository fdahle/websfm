// PatchMatch MVS — WebGPU compute shader.
//
// PHASE 2b: multi-source PatchMatch ported from crates/reconstruction/src/mvs.rs.
// Slanted-plane init, red-black checkerboard propagation, decaying random
// refinement, and best-K cost aggregation over N source views (occlusion-robust).
// One `main` entry driven by `ctrl` (mode 0 = init whole grid; mode 1 = a red/black
// sweep). Red-black updates in place (a sweep reads only the other parity), so no
// ping-pong is needed.
//
// Sources are bound as a texture_2d_array: every layer is maxW×maxH, but a source's
// valid region is its own (w,h) ≤ (maxW,maxH). The warp out-of-bounds test uses the
// valid (w,h); the sample coordinate is clamped to [0,w-1]×[0,h-1] so we never
// bilinear-sample into the zero padding (which would diverge from the CPU
// reference). Texels (0..1) are scaled ×255 to match the reference's textureless
// VAR_FLOOR cutoff; ZNCC is otherwise scale-invariant.

const PI : f32 = 3.14159265359;
const HALF_PI : f32 = 1.57079632679;
const MAX_SRC : u32 = 16u;
// Sentinel: a source that provides no measurement (warp OOB / masked / <4 px /
// textureless REFERENCE patch). aggCost excludes these instead of averaging a max cost 2.0 in
// (Step 1 — adaptive best-K over *valid* sources). Test with >= INVALID_THRESH.
const INVALID : f32 = 1e9;
const INVALID_THRESH : f32 = 1e8;
// Per-patch intensity-variance floor (0..255 scale). Flat REFERENCE patch ⇒
// INVALID (unmeasurable); textured ref onto a flat SOURCE patch ⇒ max cost 2.0
// (bad hypothesis, never dropped from best-K). Identical in mvs.rs / planeCost.js.
const VAR_FLOOR : f32 = 1e-6;

struct Params {
  refW : u32, refH : u32, radius : i32, hasSeed : u32,
  rfx : f32, rfy : f32, rcx : f32, rcy : f32,
  depthMin : f32, depthMax : f32, seed : u32, iters : u32,
  nSrc : u32, bestK : u32, maxW : u32, maxH : u32,
  // Bilateral-weighted NCC (mvs.rs Bilateral): 1/(2σs²), 1/(2σc²); bilOn 0 = every weight 1.
  bilS : f32, bilC : f32, bilOn : u32,
  // View selection: 0 = best-K over each hypothesis' cheapest sources; 1 = ACMH (Xu &
  // Tao 2019): adaptive checkerboard sampling + multi-hypothesis joint view selection.
  acmh : u32,
  // Step between window samples (mvs.rs Patch): 1 = every pixel, 2 = every other row
  // and column; the offsets stay symmetric about the centre.
  wstep : i32, _q0 : u32, _q1 : u32, _q2 : u32,
};

struct Src {
  w : u32, h : u32, _p0 : u32, _p1 : u32,
  fx : f32, fy : f32, cx : f32, cy : f32,
  r0 : vec4<f32>, r1 : vec4<f32>, r2 : vec4<f32>, t : vec4<f32>,
};

// `scale` is the refinement scale for this sweep, perturbStart·0.5^iter, computed on
// the CPU (depthMapGpu.js) exactly as mvs.rs computes it.
struct Ctrl { mode : u32, parity : u32, iter : u32, scale : f32 };

// Depth-proposal half-span as a fraction of the current depth at scale 1 (mvs.rs).
const DEPTH_PERTURB_REL : f32 = 0.5;

@group(0) @binding(0) var<uniform> params : Params;
@group(0) @binding(1) var refTex  : texture_2d<f32>;
@group(0) @binding(2) var samp    : sampler;
@group(0) @binding(3) var<storage, read>       seedDepth : array<f32>;
@group(0) @binding(4) var<storage, read_write> state     : array<vec4<f32>>; // (depth, nx, ny, nz)
@group(0) @binding(5) var<storage, read_write> costBuf   : array<f32>;
@group(0) @binding(6) var<storage, read>       srcs      : array<Src>;
@group(0) @binding(7) var srcTexArr : texture_2d_array<f32>;
@group(0) @binding(8) var<uniform> ctrl   : Ctrl;
// Per-source exclusion mask (film frame / fiducials), same layer layout as
// srcTexArr; texel > 0.5 means "masked" → treat the warp like out-of-bounds.
@group(0) @binding(9) var srcMaskArr : texture_2d_array<f32>;
// ACMH: each pixel's most important source view of the previous sweep (its temporal
// prior), 0xFFFFFFFF = none yet. Written by mode 0 and the ACMH sweeps only.
@group(0) @binding(10) var<storage, read_write> selView : array<u32>;

fn pcg(s : ptr<function, u32>) -> u32 {
  let x = (*s) * 747796405u + 2891336453u;
  *s = x;
  let word = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (word >> 22u) ^ word;
}
fn randf(s : ptr<function, u32>) -> f32 { return f32(pcg(s)) * (1.0 / 4294967296.0); }
fn seedRng(i : u32, a : u32, b : u32, salt : u32) -> u32 {
  var s = i * 747796405u + a * 2654435761u + b * 40503u + salt + 1u;
  s = s ^ (s >> 16u); s = s * 2246822519u; s = s ^ (s >> 13u);
  return s;
}
fn randNormal(s : ptr<function, u32>) -> vec3<f32> {
  let a = randf(s) * PI - HALF_PI;
  let b = randf(s) * PI - HALF_PI;
  return normalize(vec3<f32>(sin(a) * 0.5, sin(b) * 0.5, -1.0));
}

// ZNCC cost of plane (depth at (u,v), normal n) against source `si`.
fn planeCost(si : u32, u : u32, v : u32, depth : f32, n : vec3<f32>) -> f32 {
  let s = srcs[si];
  let pu = (f32(u) - params.rcx) / params.rfx;
  let pv = (f32(v) - params.rcy) / params.rfy;
  let P  = vec3<f32>(pu * depth, pv * depth, depth);
  let d  = dot(n, P);
  if (abs(d) < 1e-9) { return 2.0; }

  let R0 = s.r0.xyz; let R1 = s.r1.xyz; let R2 = s.r2.xyz; let T = s.t.xyz;
  let layer = i32(si);
  let mw = f32(params.maxW); let mh = f32(params.maxH);
  let sw = f32(s.w); let sh = f32(s.h);
  var sumR = 0.0; var sumS = 0.0; var sumRR = 0.0; var sumSS = 0.0; var sumRS = 0.0; var cnt = 0.0;
  // Sums are over values SHIFTED by the first contributing sample. ZNCC is
  // shift-invariant, but raw f32 sums (Σx² up to 255²·121 ≈ 7.9e6) minus n·mean²
  // cancel catastrophically on bright low-contrast patches. Same in mvs.rs/planeCost.js.
  var kR = 0.0; var kS = 0.0;
  var sumW = 0.0;
  let rc = textureLoad(refTex, vec2<i32>(i32(u), i32(v)), 0).r * 255.0;

  let w0 = -((params.radius / params.wstep) * params.wstep);
  for (var y = w0; y <= params.radius; y = y + params.wstep) {
    for (var x = w0; x <= params.radius; x = x + params.wstep) {
      let xi = i32(u) + x;
      let yi = i32(v) + y;
      if (xi < 0 || yi < 0 || xi >= i32(params.refW) || yi >= i32(params.refH)) { continue; }
      let ray = vec3<f32>((f32(xi) - params.rcx) / params.rfx,
                          (f32(yi) - params.rcy) / params.rfy, 1.0);
      let nr  = dot(n, ray);
      // Plane-induced homography R + t·nᵀ/d for n·X = d (d = n·P). The "+" (not the
      // H&Z "−") is required by this d-sign convention — see mvs.rs. Lockstep w/ the
      // Rust + planeCost.js kernels.
      let xs  = vec3<f32>(dot(R0, ray) + T.x * nr / d,
                          dot(R1, ray) + T.y * nr / d,
                          dot(R2, ray) + T.z * nr / d);
      if (abs(xs.z) < 1e-9) { continue; }
      let su = s.fx * (xs.x / xs.z) + s.cx;
      let sv = s.fy * (xs.y / xs.z) + s.cy;
      if (su < 0.0 || sv < 0.0 || su >= sw || sv >= sh) { return INVALID; } // warp left source → no measurement
      // Masked source texel (frame/fiducial) — reject like an out-of-bounds warp.
      if (textureLoad(srcMaskArr, vec2<i32>(i32(su), i32(sv)), layer, 0).r > 0.5) { return INVALID; }
      // Clamp to the valid region so bilinear never reaches the layer's zero pad.
      let cu = clamp(su, 0.0, sw - 1.0);
      let cv = clamp(sv, 0.0, sh - 1.0);
      let r0 = textureLoad(refTex, vec2<i32>(xi, yi), 0).r * 255.0;
      let s0 = textureSampleLevel(srcTexArr, samp,
                 vec2<f32>((cu + 0.5) / mw, (cv + 0.5) / mh), layer, 0.0).r * 255.0;
      var wt = 1.0;
      if (params.bilOn == 1u) {
        let dc = r0 - rc;
        wt = exp(-f32(x * x + y * y) * params.bilS - dc * dc * params.bilC);
      }
      if (cnt == 0.0) { kR = r0; kS = s0; }
      let rval = r0 - kR;
      let sval = s0 - kS;
      sumR += wt * rval; sumS += wt * sval;
      sumRR += wt * rval * rval; sumSS += wt * sval * sval; sumRS += wt * rval * sval;
      cnt += 1.0; sumW += wt;
    }
  }
  if (cnt < 4.0) { return INVALID; } // too little overlap → no measurement
  let mr = sumR / sumW; let ms = sumS / sumW;
  let vr = sumRR / sumW - mr * mr; let vs = sumSS / sumW - ms * ms;
  let cov = sumRS / sumW - mr * ms;
  if (vr < VAR_FLOOR) { return INVALID; } // textureless REFERENCE patch → no measurement
  if (vs < VAR_FLOOR) { return 2.0; }     // textured ref onto flat source → bad hypothesis
  let denom = sqrt(vr * vs);
  return 1.0 - clamp(cov / denom, -1.0, 1.0);
}

// Aggregate cost over the best-K *valid* source views (robust to occlusion).
// No-measurement sources (INVALID sentinel) are compacted out before selection,
// so a source whose footprint doesn't cover the pixel can't floor the cost.
fn aggCost(u : u32, v : u32, depth : f32, n : vec3<f32>) -> f32 {
  if (depth <= 0.0) { return 2.0; }
  let ns = min(params.nSrc, MAX_SRC);
  if (ns == 0u) { return 2.0; }
  var costs : array<f32, 16>;
  var nv = 0u;
  for (var s = 0u; s < ns; s = s + 1u) {
    let c = planeCost(s, u, v, depth, n);
    if (c < INVALID_THRESH) { costs[nv] = c; nv = nv + 1u; }
  }
  if (nv == 0u) { return 2.0; } // no source measured this pixel

  let k = min(max(params.bestK, 1u), nv);
  var sum = 0.0;
  // Partial selection sort over the valid prefix: pull the k smallest to front.
  for (var a = 0u; a < k; a = a + 1u) {
    var mi = a;
    for (var b = a + 1u; b < nv; b = b + 1u) {
      if (costs[b] < costs[mi]) { mi = b; }
    }
    let tmp = costs[a]; costs[a] = costs[mi]; costs[mi] = tmp;
    sum = sum + costs[a];
  }
  return sum / f32(k);
}

// ── ACMH (Xu & Tao, CVPR 2019) ───────────────────────────────────────────────
// Candidate planes from 8 regions of the other checkerboard colour — 4 near V-shapes
// (7 samples each) and 4 far strips (11 samples, out to 23 px) — each region giving the
// sample with the lowest stored cost. Then the 9 hypotheses (own + 8) are scored against
// every source, a source is selected when > ACMH_N1 hypotheses match well in it
// (cost < τ(t)) and < ACMH_N2 badly (> ACMH_BAD), and weighted by the mean importance
// exp(−c²/2β²) of its good costs. The pixel's most important view of the previous sweep
// keeps weight: doubled when selected again, 0.2 when not (the paper's w′, eq. 5). A
// hypothesis' cost is the w′-weighted mean over the sources (eq. 6); the 8 sampled ones
// vote, the pixel's own plane is scored as the incumbent. Refinement draws a random and
// a perturbed depth and normal and tests the 6 combinations with the current ones (§4.4),
// under the same weights. Parameters are the paper's {τ0, τ1, α, β, n1, n2} =
// {0.8, 1.2, 90, 0.3, 2, 3} (Xu & Tao 2019, §7.1).
const ACMH_H : u32 = 9u;
const ACMH_TAU0 : f32 = 0.8;
const ACMH_ALPHA : f32 = 90.0;
const ACMH_BAD : f32 = 1.2;
const ACMH_N1 : u32 = 2u;
const ACMH_N2 : u32 = 3u;
const ACMH_BETA : f32 = 0.3;

// The k-th sample offset of region r (0..3 near V up/down/left/right, 4..7 far strips),
// for k < regionSize(r). Every offset has dx + dy odd: the other checkerboard colour.
fn regionSize(r : u32) -> u32 { return select(11u, 7u, r < 4u); }
fn regionOffset(r : u32, k : u32) -> vec2<i32> {
  var o : vec2<i32>;
  if (r < 4u) {
    // V: (0,-1), (±1,-2), (±2,-3), (±3,-4), pointing up; rotated for the others.
    let kk = i32(k);
    let row = (kk + 1) / 2;                       // 0,1,1,2,2,3,3
    let side = select(-1, 1, (kk & 1) == 1);      // alternate left/right
    o = vec2<i32>(select(side * row, 0, kk == 0), -(row + 1));
  } else {
    o = vec2<i32>(0, -(3 + 2 * i32(k)));          // (0,-3), (0,-5), …, (0,-23)
  }
  let d = r % 4u;
  if (d == 1u) { o = vec2<i32>(-o.x, -o.y); }      // down
  if (d == 2u) { o = vec2<i32>(o.y, o.x); }        // left
  if (d == 3u) { o = vec2<i32>(-o.y, -o.x); }      // right
  return o;
}

// Per-source photometric costs of one hypothesis (INVALID → the max cost 2).
fn sourceCosts(u : u32, v : u32, depth : f32, n : vec3<f32>, out : ptr<function, array<f32, 16>>) {
  let ns = min(params.nSrc, MAX_SRC);
  for (var s = 0u; s < ns; s = s + 1u) {
    var c = 2.0;
    if (depth > 0.0) {
      c = planeCost(s, u, v, depth, n);
      if (c >= INVALID_THRESH) { c = 2.0; }
    }
    (*out)[s] = c;
  }
}

fn weightedCost(c : ptr<function, array<f32, 16>>, w : ptr<function, array<f32, 16>>) -> f32 {
  let ns = min(params.nSrc, MAX_SRC);
  var sw = 0.0; var sc = 0.0;
  for (var s = 0u; s < ns; s = s + 1u) { sw += (*w)[s]; sc += (*w)[s] * (*c)[s]; }
  return select(2.0, sc / sw, sw > 0.0);
}

fn acmhSweep(u : u32, v : u32, i : u32) {
  let W = i32(params.refW);
  let H = i32(params.refH);
  let ns = min(params.nSrc, MAX_SRC);
  let rxI = (f32(u) - params.rcx) / params.rfx;
  let ryI = (f32(v) - params.rcy) / params.rfy;

  // 1. Hypotheses: own plane, then the cheapest sample of each region, intersected with
  // this pixel's ray (the same plane transfer as the 4-neighbour propagation).
  var hD : array<f32, 9>;
  var hN : array<vec3<f32>, 9>;
  hD[0] = state[i].x; hN[0] = state[i].yzw;
  var nh = 1u;
  for (var r = 0u; r < 8u; r = r + 1u) {
    var best = 1e30; var bj = -1;
    for (var k = 0u; k < regionSize(r); k = k + 1u) {
      let o = regionOffset(r, k);
      let nu = i32(u) + o.x; let nv = i32(v) + o.y;
      if (nu < 0 || nv < 0 || nu >= W || nv >= H) { continue; }
      let j = nv * W + nu;
      if (costBuf[j] < best) { best = costBuf[j]; bj = j; }
    }
    if (bj < 0) { continue; }
    let j = u32(bj);
    let candN = state[j].yzw;
    let nu = f32(j % params.refW); let nv = f32(j / params.refW);
    let dPlane = state[j].x * (candN.x * (nu - params.rcx) / params.rfx + candN.y * (nv - params.rcy) / params.rfy + candN.z);
    let denom = candN.x * rxI + candN.y * ryI + candN.z;
    if (abs(denom) < 1e-9) { continue; }
    let candD = dPlane / denom;
    if (candD <= params.depthMin || candD >= params.depthMax) { continue; }
    hD[nh] = candD; hN[nh] = candN; nh = nh + 1u;
  }

  // 2. The cost matrix, then the view weights (eqs. 2–5).
  var C : array<array<f32, 16>, 9>;
  for (var h = 0u; h < nh; h = h + 1u) {
    var row : array<f32, 16>;
    sourceCosts(u, v, hD[h], hN[h], &row);
    C[h] = row;
  }
  let t = f32(ctrl.iter);
  let tau = ACMH_TAU0 * exp(-t * t / ACMH_ALPHA);
  let prev = selView[i];
  var w : array<f32, 16>;
  var anySel = false;
  for (var s = 0u; s < ns; s = s + 1u) {
    var good = 0u; var bad = 0u; var sumImp = 0.0;
    for (var h = 1u; h < nh; h = h + 1u) {
      let c = C[h][s];
      if (c < tau) { good = good + 1u; sumImp += exp(-c * c / (2.0 * ACMH_BETA * ACMH_BETA)); }
      if (c > ACMH_BAD) { bad = bad + 1u; }
    }
    let isPrev = select(0.0, 1.0, s == prev);
    if (good > ACMH_N1 && bad < ACMH_N2) {
      w[s] = (isPrev + 1.0) * sumImp / f32(good);
      anySel = true;
    } else {
      w[s] = 0.2 * isPrev;
    }
  }
  if (!anySel) {
    // No view passes the vote (early sweeps, weak texture): weigh each by its best match
    // among the hypotheses, the remembered view still doubled, rather than score the
    // pixel on that one view alone (mvs.rs).
    for (var s = 0u; s < ns; s = s + 1u) {
      var m = 2.0;
      for (var h = 0u; h < nh; h = h + 1u) { m = min(m, C[h][s]); }
      let isPrev = select(0.0, 1.0, s == prev);
      w[s] = (isPrev + 1.0) * exp(-m * m / (2.0 * ACMH_BETA * ACMH_BETA));
    }
  }
  // This sweep's most important view: the next sweep's temporal prior.
  var top = 0xFFFFFFFFu; var topW = 0.0;
  for (var s = 0u; s < ns; s = s + 1u) { if (w[s] > topW) { topW = w[s]; top = s; } }
  selView[i] = top;

  // 3. The cheapest hypothesis under those weights (eq. 6).
  var bestH = 0u;
  var row0 = C[0];
  var bestC = weightedCost(&row0, &w);
  for (var h = 1u; h < nh; h = h + 1u) {
    var rowh = C[h];
    let c = weightedCost(&rowh, &w);
    if (c < bestC) { bestC = c; bestH = h; }
  }
  var bestD = hD[bestH];
  var bestN = hN[bestH];

  // 4. Refinement (§4.4): a random and a perturbed depth and normal, combined with the
  // current ones into 6 hypotheses, scored with the same weights.
  var rng = seedRng(i, ctrl.iter + 1u, ctrl.parity + 1u, params.seed);
  let shrink = ctrl.scale;
  let dspan = min(bestD, params.depthMax - params.depthMin) * DEPTH_PERTURB_REL * shrink;
  let dRand = params.depthMin + randf(&rng) * (params.depthMax - params.depthMin);
  let nRand = randNormal(&rng);
  let dPert = clamp(bestD + (randf(&rng) * 2.0 - 1.0) * dspan, params.depthMin, params.depthMax);
  let nPert = normalize(vec3<f32>(
    bestN.x + (randf(&rng) * 2.0 - 1.0) * 0.5 * shrink,
    bestN.y + (randf(&rng) * 2.0 - 1.0) * 0.5 * shrink,
    min(bestN.z - randf(&rng) * 0.3 * shrink, -0.1)));
  var pD = array<f32, 6>(dRand, bestD, dRand, dPert, bestD, dPert);
  var pN = array<vec3<f32>, 6>(bestN, nRand, nRand, bestN, nPert, nPert);
  let d0 = bestD; let n0 = bestN;
  var cr : array<f32, 16>;
  for (var k = 0u; k < 6u; k = k + 1u) {
    let dk = select(pD[k], d0, k == 1u || k == 4u);
    let nk = select(pN[k], n0, k == 0u || k == 3u);
    sourceCosts(u, v, dk, nk, &cr);
    let c = weightedCost(&cr, &w);
    if (c < bestC) { bestC = c; bestD = dk; bestN = nk; }
  }

  state[i]   = vec4<f32>(bestD, bestN.x, bestN.y, bestN.z);
  costBuf[i] = bestC;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let u = gid.x;
  let v = gid.y;
  if (u >= params.refW || v >= params.refH) { return; }
  let i = v * params.refW + u;

  if (ctrl.mode == 0u) {
    var rng = seedRng(i, 0u, 0u, params.seed);
    let seeded = select(0.0, seedDepth[i], params.hasSeed == 1u);
    var d0 : f32;
    if (seeded > 0.0) { d0 = clamp(seeded, params.depthMin, params.depthMax); }
    else { d0 = params.depthMin + randf(&rng) * (params.depthMax - params.depthMin); }
    let n0 = randNormal(&rng);
    state[i]   = vec4<f32>(d0, n0.x, n0.y, n0.z);
    costBuf[i] = aggCost(u, v, d0, n0);
    if (params.acmh == 1u) { selView[i] = 0xFFFFFFFFu; }
    return;
  }

  // mode 2 (ACMH, after the last sweep): the best-K photometric cost of the final plane,
  // the cost every later gate and the CPU validation are denominated in.
  if (ctrl.mode == 2u) {
    costBuf[i] = aggCost(u, v, state[i].x, state[i].yzw);
    return;
  }

  if (((u + v) & 1u) != ctrl.parity) { return; }
  if (params.acmh == 1u) {
    acmhSweep(u, v, i);
    return;
  }
  let it = ctrl.iter;

  var bestD = state[i].x;
  var bestN = state[i].yzw;
  var bestC = costBuf[i];

  let W = i32(params.refW);
  let H = i32(params.refH);
  // 1. Spatial propagation from the 4-neighbours' PLANES: intersect THIS pixel's
  // viewing ray with the neighbour's plane rather than copying its raw depth (which
  // only holds fronto-parallel — the depth-map "freckle" bug). Kept in lockstep with
  // mvs.rs / planeCost.js.
  let rxI = (f32(u) - params.rcx) / params.rfx;
  let ryI = (f32(v) - params.rcy) / params.rfy;
  var off = array<vec2<i32>, 4>(vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1));
  for (var k = 0; k < 4; k = k + 1) {
    let nu = i32(u) + off[k].x;
    let nv = i32(v) + off[k].y;
    if (nu < 0 || nv < 0 || nu >= W || nv >= H) { continue; }
    let j = u32(nv) * params.refW + u32(nu);
    let candN = state[j].yzw;
    let rxJ = (f32(nu) - params.rcx) / params.rfx;
    let ryJ = (f32(nv) - params.rcy) / params.rfy;
    let dPlane = state[j].x * (candN.x * rxJ + candN.y * ryJ + candN.z);
    let denom = candN.x * rxI + candN.y * ryI + candN.z;
    if (abs(denom) < 1e-9) { continue; }
    let candD = dPlane / denom;
    if (candD <= params.depthMin || candD >= params.depthMax) { continue; }
    let c = aggCost(u, v, candD, candN);
    if (c < bestC) { bestC = c; bestD = candD; bestN = candN; }
  }

  // 2. Refinement: decoupled (a) random normal, (b) depth-only, then (c) joint.
  var rng = seedRng(i, it + 1u, ctrl.parity + 1u, params.seed);
  // Relative to this pixel's depth, decaying across iterations AND pyramid levels
  // (see mvs.rs); kept in lockstep with mvs.rs.
  let shrink = ctrl.scale;
  let dspan = min(bestD, params.depthMax - params.depthMin) * DEPTH_PERTURB_REL * shrink;
  // (a) current depth + random new normal.
  let randN = randNormal(&rng);
  let ca = aggCost(u, v, bestD, randN);
  if (ca < bestC) { bestC = ca; bestN = randN; }
  // (b) current normal + perturbed depth.
  let pertDonly = clamp(bestD + (randf(&rng) * 2.0 - 1.0) * dspan, params.depthMin, params.depthMax);
  let cb = aggCost(u, v, pertDonly, bestN);
  if (cb < bestC) { bestC = cb; bestD = pertDonly; }
  // (c) joint perturbation.
  let pertD = clamp(bestD + (randf(&rng) * 2.0 - 1.0) * dspan, params.depthMin, params.depthMax);
  let pertN = normalize(vec3<f32>(
    bestN.x + (randf(&rng) * 2.0 - 1.0) * 0.5 * shrink,
    bestN.y + (randf(&rng) * 2.0 - 1.0) * 0.5 * shrink,
    min(bestN.z - randf(&rng) * 0.3 * shrink, -0.1)));
  let pc = aggCost(u, v, pertD, pertN);
  if (pc < bestC) { bestC = pc; bestD = pertD; bestN = pertN; }

  state[i]   = vec4<f32>(bestD, bestN.x, bestN.y, bestN.z);
  costBuf[i] = bestC;
}
