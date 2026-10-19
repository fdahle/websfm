// The cloud-source boundary: a cloud whose points live in an octree on disk, read node
// by node. The point-cloud counterpart of the raster sources (core/io/rasterSource.js):
// the viewer, box reads (crop, DEM), export and the streamed edits take a source and a
// cloud's `lod` metadata, and do not know which file is behind it.
//
// Two implementations:
// - websfm's own octree (core/lod/reader.js): a data file and a hierarchy file in the
//   project's lod/ folder, built at fusion or by a streamed LAS/LAZ import;
// - a COPC file (core/lod/copc.js), read in place: `lod.format === 'copc'`, the file is
//   `lod.dataFile`, there is no hierarchy file.
//
// A source: { nodes: Map keyString → { key, count, offset, length }, root, children(node),
// cube(node), spacing(node), read(node, { as: 'render' | 'absolute' }) → { count, pos,
// col, attributes }, complete, loadAll(), close() }. `nodes` is every node once
// `complete`; a COPC source opened `hierarchy: 'lazy'` (the view) fills it as `read`
// reaches deeper pages, so a tool that walks every node opens it with 'all'.

import { openLodReader } from './reader.js'
import { openCopcSource } from './copc.js'

export const isCopcLod = (lod) => lod?.format === 'copc'

/** The files of a cloud's octree in the project's lod/ folder. */
export const lodFileNames = (lod) => [lod?.dataFile, lod?.hierarchyFile].filter(Boolean)

/**
 * files { data: Blob, hierarchy: Blob | null }; opts (COPC) { createChunkDecoder,
 * readNode, hierarchy: 'all' | 'lazy' }. → a source
 */
export async function openCloudSource(lod, { data, hierarchy = null }, opts = {}) {
  if (isCopcLod(lod)) {
    const source = { size: data.size, read: async (start, end) => new Uint8Array(await data.slice(start, end).arrayBuffer()) }
    return openCopcSource(lod, source, opts)
  }
  const reader = await openLodReader(lod, { data, hierarchy })
  return { ...reader, complete: true, loadAll: async () => {}, close() {} }
}
