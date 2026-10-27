import { cloudBounds } from '../products/cloudEdit.js'

// A streamed cloud (dev/planning/plan-lod.md ▸ L4): a LAS/LAZ too large to hold in
// memory, imported straight into its level-of-detail octree. It has `lod` and a
// count but no resident points (`pos` null), so a tool that needs every point in
// memory must leave it out, or refuse it with this reason.
export const isStreamed = (c) => c?.kind === 'dense' && !c.pos && !!c.lod

export const streamedRefusal = (c, tool) =>
  `${tool}: "${c?.name ?? 'cloud'}" is streamed from its octree ` +
  '(too large to hold in memory), and this tool needs all of its points in memory'

// A cloud's box as cloudEdit.js `cloudBounds` gives it ({ minX, …, maxZ }), from its
// points or, for a streamed cloud, from its octree.
export function anyCloudBounds(c) {
  if (c?.pos) return cloudBounds(c)
  const b = c?.lod?.bounds
  if (!b) return null
  return { minX: b.min[0], minY: b.min[1], minZ: b.min[2], maxX: b.max[0], maxY: b.max[1], maxZ: b.max[2] }
}

// A streamed SOURCE of Align to Reference is aligned on a sample of this many points
// spread over it (ICP draws its correspondences from them); every point then moves.
export const STREAMED_ICP_SAMPLE_POINTS = 2_000_000
