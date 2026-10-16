// Read an octree's nodes from its two files (plan-lod ▸ L3), any Blob: an OPFS
// File, a picked-folder File, or a Blob in tests. Only the hierarchy is read whole;
// a node is one slice of the data file.

import { decodeHierarchy, childrenOf } from './hierarchy.js'
import { decodeNode } from './nodeCodec.js'
import { nodeCube } from './octree.js'

/**
 * lod: the cloud's octree metadata (root, layout, spacing). → { nodes: Map keyString
 * → { key, count, offset, length }, root node, children(node), cube(node),
 * spacing(node), read(node, { as }) → decoded points }
 */
export async function openLodReader(lod, { data, hierarchy }) {
  const nodes = decodeHierarchy(new Uint8Array(await hierarchy.arrayBuffer()))
  return {
    nodes,
    root: nodes.get('0-0-0-0') ?? null,
    children: (node) => childrenOf(nodes, node.key),
    cube: (node) => nodeCube(lod.root, node.key),
    spacing: (node) => lod.spacing / 2 ** node.key[0],
    async read(node, { as = 'render' } = {}) {
      const bytes = node.length ? new Uint8Array(await data.slice(node.offset, node.offset + node.length).arrayBuffer()) : new Uint8Array(0)
      return decodeNode(bytes, node.count, lod.layout, { as })
    },
  }
}
