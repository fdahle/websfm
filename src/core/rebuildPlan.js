// What to run again after a step outdated the products (Reconstruct ▸ Rebuild Outdated,
// composables/useRebuildOutdated.js): the Workflow Builder blocks that rebuild the main
// products, in the order they depend on each other.
//
// A sparse model that changed (Optimize Cameras, gradual selection, Adjust with GCPs)
// deletes the depth maps and drops the georeference (stores/useReconstructionStore.js
// invalidateSparseDependents), so a dense cloud or orthophoto needs depth maps again
// first, and a product in the georeferenced frame needs Georeference again first.
//
// Pure: plain data in, plain data out.

// The blocks, in run order (core/workflow.js WORKFLOW_BLOCKS ids).
export const REBUILD_ORDER = ['georeference', 'compute-depth', 'dense', 'gen-mesh', 'gen-dem', 'gen-ortho']
const BLOCK_OF = { dense: 'dense', mesh: 'gen-mesh', dem: 'gen-dem', ortho: 'gen-ortho' }

/**
 * @param {{ outdated: { kind: 'dense'|'mesh'|'dem'|'ortho', georeferenced?: boolean }[],
 *   depthMaps?: number, georeferenced?: boolean }} s
 *   outdated: the main products that are outdated (georeferenced: built in the
 *   georeference's frame); depthMaps: how many current depth maps there are;
 *   georeferenced: whether the model has a valid georeference now
 * @returns {string[]} the block types to run, in REBUILD_ORDER; [] when nothing is outdated
 */
export function rebuildPlan({ outdated = [], depthMaps = 0, georeferenced = false } = {}) {
  const want = new Set()
  for (const p of outdated) {
    if (BLOCK_OF[p.kind]) want.add(BLOCK_OF[p.kind])
    if (p.georeferenced && !georeferenced) want.add('georeference')
  }
  // Depth maps feed the dense cloud and the orthophoto's photo selection.
  if ((want.has('dense') || want.has('gen-ortho')) && !(depthMaps > 0)) want.add('compute-depth')
  return REBUILD_ORDER.filter((t) => want.has(t))
}

// The dialog whose last-run settings each block starts from (composables/useDialogSettings.js).
export const REBUILD_DIALOG = {
  'compute-depth': 'depth-maps',
  'dense': 'dense-cloud',
  'gen-mesh': 'mesh',
  'gen-dem': 'dem',
  'gen-ortho': 'orthophoto',
}
