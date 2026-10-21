// A streamed cloud (dev/planning/plan-lod.md ▸ L4): a LAS/LAZ too large to hold in
// memory, imported straight into its level-of-detail octree. It has `lod` and a
// count but no resident points (`pos` null), so a tool that needs every point in
// memory must leave it out, or refuse it with this reason.
export const isStreamed = (c) => c?.kind === 'dense' && !c.pos && !!c.lod

export const streamedRefusal = (c, tool) =>
  `${tool}: "${c?.name ?? 'cloud'}" is streamed from its octree ` +
  '(too large to hold in memory), and this tool needs all of its points in memory'
