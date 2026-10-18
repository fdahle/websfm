// Coordinate readers for a flat cloud { pos, origin? }. `origin` (3) is set when the
// positions are stored relative to it — prepareCloudForExport's Float32 form for a
// cloud past the 2 GiB buffer wall (core/bufferLimit.js). Without it the readers
// return the stored numbers untouched (no "+ 0", which would turn −0 into 0).
export function flatAxes({ pos, origin = null }) {
  if (!origin) return [(i) => pos[i * 3], (i) => pos[i * 3 + 1], (i) => pos[i * 3 + 2]]
  const [ox, oy, oz] = origin
  return [(i) => ox + pos[i * 3], (i) => oy + pos[i * 3 + 1], (i) => oz + pos[i * 3 + 2]]
}
