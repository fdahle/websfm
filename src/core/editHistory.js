// The undo and redo history of hand edits that keep what they replaced (a point edit
// in the 3D view keeps the points it removed). Pure: an entry is the caller's own
// record, with the `bytes` it holds on to; the history only orders and bounds them.
//
// Bounded twice: at most `maxEntries` steps back, and at most `maxBytes` held by them
// all (a dense cloud's previous points are hundreds of MB), the oldest dropped first.
// A new edit clears the redo side, as in every editor.

export function createEditHistory({ maxEntries = 10, maxBytes = 2 ** 30 } = {}) {
  let undo = []
  let redo = []
  const bytesOf = (list) => list.reduce((n, e) => n + (e.bytes ?? 0), 0)
  function trim() {
    while (undo.length > maxEntries) undo.shift()
    while (undo.length > 1 && bytesOf(undo) + bytesOf(redo) > maxBytes) undo.shift()
    while (redo.length > 1 && bytesOf(undo) + bytesOf(redo) > maxBytes) redo.shift()
  }
  return {
    /** A new edit: it can be undone, and nothing undone before can be redone. */
    record(entry) {
      undo.push(entry)
      redo = []
      trim()
    },
    /** The edit to undo (taken off the history), or null. The caller undoes it and
     *  hands the way back to `undone`. */
    takeUndo: () => undo.pop() ?? null,
    takeRedo: () => redo.pop() ?? null,
    /** What undoing `entry` left to redo it. */
    undone(entry) {
      redo.push(entry)
      trim()
    },
    /** What redoing left to undo it again (the redo side stays). */
    redone(entry) {
      undo.push(entry)
      trim()
    },
    /** Drop the entries `keep` says no to (their cloud was removed). */
    filter(keep) {
      undo = undo.filter(keep)
      redo = redo.filter(keep)
    },
    clear() {
      undo = []
      redo = []
    },
    /** { undo, redo }: the labels of the next step each way, or null. */
    peek: () => ({ undo: undo.at(-1)?.label ?? null, redo: redo.at(-1)?.label ?? null }),
    get size() {
      return { undo: undo.length, redo: redo.length, bytes: bytesOf(undo) + bytesOf(redo) }
    },
  }
}
