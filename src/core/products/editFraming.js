// The 3D viewer frames the scene when a new cloud appears (an import), but not
// when the new cloud is the result of the user's own selection edit: that result
// replaces the cloud they were zoomed into. A committed edit therefore latches the
// ids of the clouds it will rewrite, and each layer update settles the latch here.
//
// An edited id is settled by the update that carries its result:
//   • in-place refinement (a derived cloud): same id, new buffers;
//   • fork (a computed/imported source): a new derived cloud appears and the source
//     is hidden in the same commit — or the source was removed meanwhile.
// A failed or cancelled edit never settles; the next update that adds a cloud
// without settling anything is an unrelated import, so it frames and drops the
// stale latch rather than leaving it set forever.
//
// `pending`  — Set of latched cloud ids (not mutated)
// `clouds`   — the incoming cloud list
// `previous` — (id) => the source record the viewer last drew for that id, or undefined
// `addedCloud` — whether this update adds a visible cloud the viewer has not seen
// Returns { editResult, pending }: whether this update is (part of) an edit result
// — it must not re-frame — and the ids still awaiting their result.
export function settleEditLatch(pending, clouds, previous, addedCloud) {
  if (!pending?.size) return { editResult: false, pending: new Set() }
  const byId = new Map(clouds.map((c) => [c.id, c]))
  const remaining = new Set()
  let editResult = false
  for (const id of pending) {
    const cloud = byId.get(id)
    const prev = previous(id)
    const settled = !cloud || cloud.visible === false
      || (!!prev && (prev.pos !== cloud.pos || prev.points !== cloud.points || prev.idx !== cloud.idx || prev.count !== cloud.count))
    if (settled) editResult = true
    else remaining.add(id)
  }
  if (addedCloud && !editResult) remaining.clear()
  return { editResult, pending: remaining }
}
