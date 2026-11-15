// What the matches allow the sparse solver to hold, counted before the run: the keypoints
// that are in some match (no point can observe any other, guided track extension aside)
// and the tracks they join into (union-find over every match). The run assigns a
// keypoint to at most one point, so `observations` bounds the model's observations; each
// point has two views or more, so they also bound its points at observations / 2.
// `tracks` (the connected components) is about the number of points a model has: a
// component with two keypoints of one image becomes two points, filtering removes some.
//
// memBudget.js sizes the bundle adjustment from these instead of guessing them from the
// keypoint count, which overestimated a 1,940-image block about twofold (TODO ▸ Mill19).
// Memory: one Int32 per keypoint of the run while it counts.

/**
 * @param {ArrayLike<number>} keypointCounts keypoints per image, by image index
 */
export function createTrackCensus(keypointCounts) {
  const offsets = new Float64Array(keypointCounts.length + 1)
  for (let i = 0; i < keypointCounts.length; i++) offsets[i + 1] = offsets[i] + Math.max(0, keypointCounts[i] | 0)
  const total = offsets[keypointCounts.length]
  // -1: in no match yet; otherwise the union-find parent.
  const parent = new Int32Array(total).fill(-1)
  let joins = 0
  const find = (x) => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]] // path halving
      x = parent[x]
    }
    return x
  }
  const touch = (x) => {
    if (parent[x] < 0) parent[x] = x
    return find(x)
  }
  return {
    /**
     * One pair's matches, packed [kpA, kpB, …] (matchCodec.js), between images a and b.
     * Indices outside an image's keypoints are ignored (the run drops them too).
     */
    add(a, b, packed) {
      const oa = offsets[a],
        na = offsets[a + 1] - oa,
        ob = offsets[b],
        nb = offsets[b + 1] - ob
      for (let i = 0; i + 1 < packed.length; i += 2) {
        const ka = packed[i],
          kb = packed[i + 1]
        if (ka >= na || kb >= nb) continue
        const ra = touch(oa + ka),
          rb = touch(ob + kb)
        if (ra === rb) continue
        // The larger root under the smaller: deterministic, and enough with path halving.
        if (ra < rb) parent[rb] = ra
        else parent[ra] = rb
        joins++
      }
    },
    /** @returns {{ observations: number, tracks: number }} */
    finish() {
      let observations = 0
      for (let i = 0; i < total; i++) if (parent[i] >= 0) observations++
      return { observations, tracks: observations - joins }
    },
  }
}
