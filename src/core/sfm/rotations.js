// 3×3 rotation / symmetric-eigen helpers, factored out of sfm.js so both the
// rotation-cycle match filter (cycleFilter.js) and the orchestrator can share
// them. Pure, no module state.

export const I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

export function matMul3(A, B) {
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0
    for (let k = 0; k < 3; k++) s += A[i][k] * B[k][j]
    C[i][j] = s
  }
  return C
}

export function matT3(A) {
  return [[A[0][0], A[1][0], A[2][0]], [A[0][1], A[1][1], A[2][1]], [A[0][2], A[1][2], A[2][2]]]
}

// Geodesic angle (deg) of a rotation matrix from identity: θ = acos((tr R − 1)/2).
export function rotAngleDeg(R) {
  const tr = R[0][0] + R[1][1] + R[2][2]
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI
}

// Eigenvalues of a symmetric 3×3 matrix, descending (analytic, Smith 1961).
export function eigSym3(a) {
  const p1 = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2
  if (p1 === 0) return [a[0][0], a[1][1], a[2][2]].sort((x, y) => y - x)
  const q = (a[0][0] + a[1][1] + a[2][2]) / 3
  const p2 = (a[0][0] - q) ** 2 + (a[1][1] - q) ** 2 + (a[2][2] - q) ** 2 + 2 * p1
  const p = Math.sqrt(p2 / 6)
  const B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B[i][j] = (a[i][j] - (i === j ? q : 0)) / p
  const detB =
      B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1])
    - B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0])
    + B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0])
  const phi = Math.acos(Math.max(-1, Math.min(1, detB / 2))) / 3
  const e1 = q + 2 * p * Math.cos(phi)
  const e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3)
  return [e1, 3 * q - e1 - e3, e3]
}

// Singular values of the essential matrix E (flat row-major, 9 elements), as
// √eig(EᵀE). A true essential matrix has σ1≈σ2 and σ3≈0; when the intrinsics
// (focal length) are wrong, F→E conversion yields σ2/σ1 well below 1 — a direct
// signal that K is off. Returns { s1, s2, s3 } descending.
export function essentialSingularValues(Eflat) {
  const E = [
    [Eflat[0], Eflat[1], Eflat[2]],
    [Eflat[3], Eflat[4], Eflat[5]],
    [Eflat[6], Eflat[7], Eflat[8]],
  ]
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]] // EᵀE
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    let s = 0
    for (let k = 0; k < 3; k++) s += E[k][i] * E[k][j]
    M[i][j] = s
  }
  const [a, b, c] = eigSym3(M).map((v) => Math.sqrt(Math.max(0, v)))
  return { s1: a, s2: b, s3: c }
}
