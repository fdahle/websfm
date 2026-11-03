// A run's multispectral rigs (Sparse Model ▸ Camera rig; plan-after-0.7 ▸ MSP-1). The
// photos of one capture share one pose in bundle adjustment, each band seen from its
// lens offset to the reference band (bundle.rs bundle_adjust_rig). The offsets start
// from what the camera records (core/sensors/rig.js bandOffset) and the global solves
// refine their rotations; the lever arm (a few centimetres) is left out, which a nadir
// block absorbs into that rotation at its flying height.
//
// Poses stay per image (the saved model is unchanged): a solve writes every camera's
// composed pose, and complete() gives the band photos that never registered (a thermal
// band matches nothing) their capture's pose through their band's offset.

import { findRigs, rigMembership, bandOffset } from '../sensors/rig.js'

const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]))
const transpose = (A) => [0, 1, 2].map((i) => [A[0][i], A[1][i], A[2][i]])
const apply = (A, v) => A.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
// The angle of a rotation matrix, degrees: from its skew part and trace (atan2), which
// stays exact for the small angles of lens offsets where acos of the trace does not.
const angleDeg = (R) =>
  (Math.atan2(Math.hypot(R[2][1] - R[1][2], R[0][2] - R[2][0], R[1][0] - R[0][1]), R[0][0] + R[1][1] + R[2][2] - 1) *
    180) /
  Math.PI

// The rotation nearest to M (polar decomposition by Newton iteration): the mean of a set
// of close rotations, from their sum.
function nearestRotation(M) {
  let X = M.map((r) => r.slice())
  for (let k = 0; k < 30; k++) {
    const T = transpose(X)
    const d =
      T[0][0] * (T[1][1] * T[2][2] - T[1][2] * T[2][1]) -
      T[0][1] * (T[1][0] * T[2][2] - T[1][2] * T[2][0]) +
      T[0][2] * (T[1][0] * T[2][1] - T[1][1] * T[2][0])
    // inv(Xᵀ) by cofactors.
    const inv = [0, 1, 2].map((i) =>
      [0, 1, 2].map((j) => {
        const r = [0, 1, 2].filter((x) => x !== j),
          c = [0, 1, 2].filter((x) => x !== i)
        const m = T[r[0]][c[0]] * T[r[1]][c[1]] - T[r[0]][c[1]] * T[r[1]][c[0]]
        return (((i + j) % 2 ? -1 : 1) * m) / d
      }),
    )
    X = X.map((row, i) => row.map((v, j) => 0.5 * (v + inv[i][j])))
  }
  return X
}

// `images`: the run's images ({ uuid, name, meta: { make, model, band } }). Null when no
// photo is a band image.
export function createRigModel(images, { log = () => {} } = {}) {
  const rigs = findRigs(images)
  if (!rigs.length) return null
  const member = rigMembership(rigs)
  const captureInt = new Map()
  for (const [, m] of member) {
    const key = `${m.rig}|${m.capture}`
    if (!captureInt.has(key)) captureInt.set(key, captureInt.size)
  }
  // Each band's offset: the camera's own (from its metadata) and the current estimate.
  const bands = new Map() // `${rig}|${band}` → { rig, band, name, own, R, t, reference }
  for (const rig of rigs) {
    const ref = rig.bands.find((b) => b.key === rig.reference)
    for (const b of rig.bands) {
      const own = b.key === rig.reference ? null : bandOffset(b, ref)
      bands.set(`${rig.key}|${b.key}`, {
        rig: rig.key,
        label: rig.label,
        band: b.key,
        name: b.name,
        own,
        R: own?.R,
        t: own?.t,
      })
    }
  }
  const bandOf = (uuid) => {
    const m = member.get(uuid)
    return m ? bands.get(`${m.rig}|${m.band}`) : null
  }
  const captureOf = (uuid) => {
    const m = member.get(uuid)
    return m ? captureInt.get(`${m.rig}|${m.capture}`) : -1
  }
  const offsetOf = (uuid) => {
    const b = bandOf(uuid)
    return b?.R ? { R: b.R, t: b.t } : null
  }
  // The captures' members, for update() and complete().
  const membersOf = new Map() // capture int → [uuid]
  for (const [uuid] of member) {
    const c = captureOf(uuid)
    if (!membersOf.has(c)) membersOf.set(c, [])
    membersOf.get(c).push(uuid)
  }
  const isReference = (uuid) => !!member.get(uuid)?.reference

  for (const rig of rigs)
    log(
      `Camera rig: ${rig.label}, ${rig.bands.length} bands over ${rig.captures.length} captures — ` +
        `a capture's photos share one pose, each band at its lens offset to ${rig.bands.find((b) => b.reference).name}`,
      'info',
      'Reconstruction',
    )

  return {
    rigs,
    captureOf,
    offsetOf,
    isReference,
    // Rig band photos other than the reference: their pose follows their capture's.
    bandUuids: () => [...member].filter(([, m]) => !m.reference).map(([u]) => u),
    // The rig inputs of one solve (reconstruction.js bundleAdjust `rig`), aligned to
    // `uuidList`.
    attach(uuidList) {
      return {
        captureOf: Int32Array.from(uuidList, (u) => captureOf(u)),
        offsets: uuidList.map((u) => offsetOf(u)),
      }
    },
    // After a global solve: each band's offset is now the same in every capture
    // (R_band·R_refᵀ, t_band − R_o·t_ref); take its mean over the captures where the
    // reference photo is registered too.
    update(cameras) {
      const sums = new Map()
      for (const [, uuids] of membersOf) {
        const ref = uuids.find((u) => isReference(u) && cameras.has(u))
        if (!ref) continue
        const cr = cameras.get(ref)
        for (const u of uuids) {
          if (u === ref || !cameras.has(u)) continue
          const b = bandOf(u)
          if (!b?.own) continue
          const cb = cameras.get(u)
          const R = mul(cb.R, transpose(cr.R))
          const Rt = apply(R, cr.t)
          const s = sums.get(b) ?? { R: [0, 1, 2].map(() => [0, 0, 0]), t: [0, 0, 0], n: 0 }
          for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) s.R[i][j] += R[i][j]
            s.t[i] += cb.t[i] - Rt[i]
          }
          s.n++
          sums.set(b, s)
        }
      }
      for (const [b, s] of sums) {
        b.R = nearestRotation(s.R)
        b.t = s.t.map((v) => v / s.n)
        b.captures = s.n
      }
    },
    // Poses for the band photos of registered captures that did not register
    // themselves: the capture's pose (its reference photo's, or another band's with that
    // band's offset taken off) through this band's offset. `kOf(uuid)` gives the K.
    // Returns the uuids added.
    complete(cameras, kOf) {
      const added = []
      for (const [, uuids] of membersOf) {
        const known = uuids.find((u) => isReference(u) && cameras.has(u)) ?? uuids.find((u) => cameras.has(u))
        if (!known) continue
        const ck = cameras.get(known)
        const ok = offsetOf(known)
        // The capture's (reference lens) pose.
        const Rc = ok ? mul(transpose(ok.R), ck.R) : ck.R
        const tc = ok
          ? apply(
              transpose(ok.R),
              [0, 1, 2].map((i) => ck.t[i] - ok.t[i]),
            )
          : ck.t
        for (const u of uuids) {
          if (cameras.has(u)) continue
          const K = kOf(u)
          if (!K) continue
          const o = offsetOf(u)
          const R = o ? mul(o.R, Rc) : Rc
          const t = o ? apply(o.R, tc).map((v, i) => v + o.t[i]) : tc.slice()
          cameras.set(u, { R, t, K })
          added.push(u)
        }
      }
      return added
    },
    // Each band's offset: how far the solve moved it from what the camera records.
    summary() {
      return [...bands.values()]
        .filter((b) => b.own)
        .map((b) => ({
          rig: b.label,
          band: b.name,
          captures: b.captures ?? 0,
          movedDeg: b.R ? angleDeg(mul(b.R, transpose(b.own.R))) : 0,
          offsetDeg: b.R ? angleDeg(b.R) : 0,
        }))
    },
  }
}
