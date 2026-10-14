// A monotonically increasing revision counter for "latest wins" async work.
//
// Every mutation of a piece of state bumps the revision; async work captures the
// revision it was started against and drops its result unless that is still the
// current one. Two shapes, both used by the image viewer's mask canvas:
//   • a task that WILL replace the state (decode a mask Blob into the canvas):
//     `const t = rev.bump()` before awaiting — it supersedes everything before it;
//   • a task that READS the state (encode the canvas to a PNG): `const t =
//     rev.current()` — any later mutation makes its snapshot stale.
// After the await, `rev.isCurrent(t)` says whether to apply the result.
export function createRevision() {
  let rev = 0
  return {
    bump: () => ++rev,
    current: () => rev,
    isCurrent: (t) => t === rev,
  }
}
