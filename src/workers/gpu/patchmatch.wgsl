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

  for (var y = -params.radius; y <= params.radius; y = y + 1) {
    for (var x = -params.radius; x <= params.radius; x = x + 1) {
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
      if (cnt == 0.0) { kR = r0; kS = s0; }
      let rval = r0 - kR;
      let sval = s0 - kS;
      sumR += rval; sumS += sval;
      sumRR += rval * rval; sumSS += sval * sval; sumRS += rval * sval;
      cnt += 1.0;
    }
  }
  if (cnt < 4.0) { return INVALID; } // too little overlap → no measurement
  let mr = sumR / cnt; let ms = sumS / cnt;
  let vr = sumRR / cnt - mr * mr; let vs = sumSS / cnt - ms * ms;
  let cov = sumRS / cnt - mr * ms;
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
    return;
  }

  if (((u + v) & 1u) != ctrl.parity) { return; }
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
