// Brute-force descriptor nearest neighbours (WebGPU backend of crates/matching
// `match_descriptors`). Computes ONLY the per-row (A→B) and per-column (B→A) top-2
// in s-space from one pass over the dot matrix A·Bᵀ; the ratio test and the mutual
// filter run in JS (core/features/nnSelect.js `selectMatches`), so the decision rule
// has a single implementation shared with the tests. The Na×Nb matrix is never
// materialised — only 16-byte top-2 records leave the GPU.
//
//   s_row(i,j) = ‖b_j‖² − 2·a_i·b_j     (query a_i, the crate's A→B scan)
//   s_col(i,j) = ‖a_i‖² − 2·a_i·b_j     (query b_j, the B→A scan)
//
// Ties: every reduction uses `merge`, i.e. (s, idx) lexicographic for the best and
// the multiset second-smallest for s2 — identical to the crate's ascending strict-`<`
// scan whatever order partial results combine in (pinned by nnSelect.test.js).
//
// Records are vec4<u32> = (best index, bits(s1), bits(s2), 0). Floats are bitcast
// INTO u32, never the reverse: a small index bitcast to f32 is a denormal, and a
// driver may flush denormals to zero on a float load/store.
//
// Pass 1 `nn2Tile`: one workgroup owns TA=64 A rows and streams all of B in TB=64
// column tiles; 16×16 threads, each a 4×4 micro-tile (rows ty+16r, cols tx+16c),
// k streamed through workgroup memory 16 floats at a time. Per tile it folds the
// row candidates into a running per-row top-2 (kept in registers of threads 0..63)
// and writes one column partial per (row block, column) — each slot is written by
// exactly one workgroup, so no atomics. Pass 2 `colReduce` folds the partials of
// this dispatch's row blocks into the running per-column result.

struct Params {
  nA: u32,
  nB: u32,
  dim4: u32,       // descriptor width / 4 (vec4 per row); a multiple of KV
  rowBlock0: u32,  // first TA-row block of this dispatch
  nBlocks: u32,    // row blocks in this dispatch (pass 2 folds this many partials)
  doCols: u32,     // 1 ⇒ also produce the column top-2 (cross-check)
  firstChunk: u32, // pass 2: 1 ⇒ colOut holds no earlier result yet
  _pad: u32,
};

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> A: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> B: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> normA: array<f32>;
@group(0) @binding(4) var<storage, read> normB: array<f32>;
@group(0) @binding(5) var<storage, read_write> rowOut: array<vec4<u32>>;  // [nA]
@group(0) @binding(6) var<storage, read_write> colPart: array<vec4<u32>>; // [nBlocks × nB]
@group(0) @binding(7) var<storage, read_write> colOut: array<vec4<u32>>;  // [nB]

const TA: u32 = 64u;
const TB: u32 = 64u;
const KV: u32 = 4u;            // vec4s per k-chunk (16 floats)
const NONE: u32 = 0xffffffffu; // "no candidate" index — loses every tie
const SENT: f32 = 0x1.fffffep+127f; // f32::MAX, the crate's sentinel

// 16 KiB, the WebGPU default maxComputeWorkgroupStorageSize. Two lives:
// dot phase — [0,256) A tile, [256,512) B tile (64 rows × 4 vec4 each);
// reduce phase — [0,1024) one candidate record per (row|col, thread lane).
var<workgroup> sh: array<vec4<u32>, 1024>;

struct T2 { b: u32, s1: f32, s2: f32 };

fn merge(x: T2, y: T2) -> T2 {
  let yWins = y.s1 < x.s1 || (y.s1 == x.s1 && y.b < x.b);
  return T2(select(x.b, y.b, yWins), min(x.s1, y.s1), min(min(x.s2, y.s2), max(x.s1, y.s1)));
}

fn pack(t: T2) -> vec4<u32> {
  return vec4<u32>(t.b, bitcast<u32>(t.s1), bitcast<u32>(t.s2), 0u);
}

fn unpack(v: vec4<u32>) -> T2 {
  return T2(v.x, bitcast<f32>(v.y), bitcast<f32>(v.z));
}

@compute @workgroup_size(16, 16)
fn nn2Tile(@builtin(local_invocation_id) lid: vec3<u32>,
           @builtin(workgroup_id) wid: vec3<u32>) {
  let tx = lid.x;
  let ty = lid.y;
  let t = ty * 16u + tx;
  let localBlock = wid.x;
  let rowBase = (P.rowBlock0 + localBlock) * TA;
  let dim4 = P.dim4;

  // Running row top-2; meaningful only in threads t < TA (row rowBase + t).
  var run = T2(NONE, SENT, SENT);

  // Cooperative-load coordinates: 256 threads ↔ 64 rows × KV vec4.
  let lr = t / KV;
  let lk = t % KV;

  let nTilesB = (P.nB + TB - 1u) / TB;
  for (var tb = 0u; tb < nTilesB; tb++) {
    let colBase = tb * TB;
    var acc: array<array<f32, 4>, 4>; // [r][c], zero-initialised

    for (var k0 = 0u; k0 < dim4; k0 += KV) {
      let ar = rowBase + lr;
      var av = vec4<f32>(0.0);
      if (ar < P.nA) { av = A[ar * dim4 + k0 + lk]; }
      sh[t] = bitcast<vec4<u32>>(av);
      let bc = colBase + lr;
      var bv = vec4<f32>(0.0);
      if (bc < P.nB) { bv = B[bc * dim4 + k0 + lk]; }
      sh[256u + t] = bitcast<vec4<u32>>(bv);
      workgroupBarrier();

      for (var kk = 0u; kk < KV; kk++) {
        var a: array<vec4<f32>, 4>;
        var b: array<vec4<f32>, 4>;
        for (var r = 0u; r < 4u; r++) { a[r] = bitcast<vec4<f32>>(sh[(ty + 16u * r) * KV + kk]); }
        for (var c = 0u; c < 4u; c++) { b[c] = bitcast<vec4<f32>>(sh[256u + (tx + 16u * c) * KV + kk]); }
        for (var r = 0u; r < 4u; r++) {
          for (var c = 0u; c < 4u; c++) {
            acc[r][c] += dot(a[r], b[c]);
          }
        }
      }
      workgroupBarrier();
    }

    // ── Rows: each thread reduces its 4 columns per row, lane tx → scratch ──
    for (var r = 0u; r < 4u; r++) {
      var c2 = T2(NONE, SENT, SENT);
      for (var c = 0u; c < 4u; c++) {
        let col = colBase + tx + 16u * c;
        if (col < P.nB) {
          c2 = merge(c2, T2(col, normB[col] - 2.0 * acc[r][c], SENT));
        }
      }
      sh[(ty + 16u * r) * 16u + tx] = pack(c2);
    }
    workgroupBarrier();
    if (t < TA) {
      for (var k = 0u; k < 16u; k++) { run = merge(run, unpack(sh[t * 16u + k])); }
    }
    workgroupBarrier();

    // ── Columns: each thread reduces its 4 rows per column, lane ty → scratch ──
    if (P.doCols == 1u) {
      for (var c = 0u; c < 4u; c++) {
        var c2 = T2(NONE, SENT, SENT);
        for (var r = 0u; r < 4u; r++) {
          let row = rowBase + ty + 16u * r;
          if (row < P.nA) {
            c2 = merge(c2, T2(row, normA[row] - 2.0 * acc[r][c], SENT));
          }
        }
        sh[(tx + 16u * c) * 16u + ty] = pack(c2);
      }
      workgroupBarrier();
      if (t < TB) {
        var cr = T2(NONE, SENT, SENT);
        for (var k = 0u; k < 16u; k++) { cr = merge(cr, unpack(sh[t * 16u + k])); }
        let col = colBase + t;
        if (col < P.nB) { colPart[localBlock * P.nB + col] = pack(cr); }
      }
      workgroupBarrier();
    }
  }

  if (t < TA) {
    let row = rowBase + t;
    if (row < P.nA) { rowOut[row] = pack(run); }
  }
}

@compute @workgroup_size(64)
fn colReduce(@builtin(global_invocation_id) gid: vec3<u32>) {
  let j = gid.x;
  if (j >= P.nB) { return; }
  var cr = T2(NONE, SENT, SENT);
  if (P.firstChunk == 0u) { cr = unpack(colOut[j]); }
  for (var k = 0u; k < P.nBlocks; k++) { cr = merge(cr, unpack(colPart[k * P.nB + j])); }
  colOut[j] = pack(cr);
}
