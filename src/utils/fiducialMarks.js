// Certificate-mark list helpers for the Calibrate Fiducials dialog. The mark id is
// user-editable text, so it can be neither the row's identity (a key that changes
// on every keystroke remounts the row) nor assumed unique.

/** The next free `F<n>` id: counts on from the list length, skipping ids in use. */
export function nextMarkId(marks = []) {
  const used = new Set(marks.map((m) => String(m.id ?? '')))
  let n = marks.length + 1
  while (used.has(`F${n}`)) n++
  return `F${n}`
}

/** Ids carried by more than one mark, in first-seen order. Blank ids are not
 *  counted — the calibration drops unnamed marks rather than confusing them. */
export function duplicateMarkIds(marks = []) {
  const seen = new Set(), dup = new Set()
  for (const m of marks) {
    const id = String(m.id ?? '')
    if (!id) continue
    if (seen.has(id)) dup.add(id)
    else seen.add(id)
  }
  return [...dup]
}
