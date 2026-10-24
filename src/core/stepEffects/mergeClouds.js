// What each step of Merge Clouds does (MergeCloudsModal.vue): join the picked clouds
// in order, then collapse the double-density overlap (core/products/cloudEdit.js
// `mergeClouds`).
import { fmtCount, fmtLength, plural } from './format.js'

// project: { chosen: [{ count }], mergeCell }
export function mergeCloudsEffects(s, { chosen = [], mergeCell = 0 } = {}) {
  const total = chosen.reduce((n, c) => n + (c.count || 0), 0)
  const join =
    chosen.length < 2
      ? 'Pick at least two clouds.'
      : `${plural(chosen.length, 'cloud')}, ${fmtCount(total)} points, are joined in this order, coordinates as they are.`
  const overlap =
    s.cell > 0
      ? `Where the clouds overlap, one point is kept per cell of ${fmtLength(s.cell, 'units')}.`
      : `Off (0): the overlap stays double-density${mergeCell > 0 ? `; the dense run used cells of ${fmtLength(mergeCell, 'units')}` : ''}.`
  return { join, overlap }
}
