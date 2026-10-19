import { openWorkerCloudSource } from './lod.js'
import { lodToTiles, memoryLodReader } from '../../core/lod/tiles3d.js'
import { meshToTiles } from '../../core/products/tiles3dMesh.js'
import { prepareMeshForExport } from '../../core/products/exporters.js'
import { zipStream } from '../../utils/zip.js'

// Hierarchical 3D Tiles exports (core/lod/tiles3d.js, core/products/tiles3dMesh.js):
// every tile goes into the zip as soon as it is made, and the zip into a Blob a batch
// at a time, so neither the tiles nor the archive are ever held whole. The placement
// (origin, ECEF transform) comes from the page, which has the CRS registry.
function zipBlob() {
  const zip = zipStream()
  let blob = null, batch = [], size = 0
  const add = (parts) => {
    for (const p of parts) { batch.push(p); size += p.length }
    if (size >= 64 << 20) { blob = new Blob(blob ? [blob, ...batch] : batch); batch = []; size = 0 }
  }
  return {
    emit: (name, bytes) => add(zip.add(name, bytes)),
    // tileset.json and the external tilesets, then the central directory.
    finish(tileset, external) {
      add(zip.add('tileset.json', JSON.stringify(tileset)))
      for (const e of external) add(zip.add(e.name, JSON.stringify(e.json)))
      add(zip.finish())
      return new Blob(blob ? [blob, ...batch] : batch, { type: 'application/zip' })
    },
  }
}

export function makeTiles3dOps({ lazCodec = null } = {}) {
  // A point cloud from its octree (`lod`, `data`, `hierarchy`: a streamed cloud, a
  // resident one with an octree, or a COPC file read in place) or from its points (`cloud`, an octree built here).
  // input { lod?, data?, hierarchy?, cloud?, sim, origin, transform, color }
  // → { blob, tiles, contentTiles, points, levels }
  async function exportPointTiles([input], { emit }) {
    const { sim = null, origin, transform = null, color = true } = input
    const t0 = performance.now()
    let reader, lod
    if (input.lod) {
      lod = input.lod
      reader = await openWorkerCloudSource(lod, { data: input.data, hierarchy: input.hierarchy ?? null }, lazCodec)
    } else {
      ({ reader, lod } = memoryLodReader(input.cloud))
    }
    const out = zipBlob()
    const res = await lodToTiles(reader, lod, { sim, origin, color, transform, emit: out.emit,
      onProgress: (done, total) => emit('progress', [done, total, 'Writing tiles', done / Math.max(1, total)]) })
    const blob = out.finish(res.tileset, res.external)
    let levels = 0
    for (const n of reader.nodes.values()) levels = Math.max(levels, n.key[0] + 1)
    emit('log', [`3D Tiles: ${res.points.toLocaleString()} points in ${res.contentTiles.toLocaleString()} tiles over ${levels} levels`
      + `${res.external.length ? ` (${res.external.length} external tilesets)` : ''}, ${(blob.size / 1024 ** 2).toFixed(1)} MB in `
      + `${((performance.now() - t0) / 1000).toFixed(1)} s`, 'info', 'Export'])
    return { result: { blob, tiles: res.tiles, contentTiles: res.contentTiles, points: res.points, levels } }
  }

  // A mesh, split and decimated per level. input { mesh: { nVerts, count, pos, idx,
  // col?, uv? }, texture?: { data, pages, groups }, sim, origin, transform, color,
  // tileTriangles } → { blob, tiles, levels, textured }
  async function exportMeshTiles([input], { emit }) {
    const { mesh, texture = null, sim = null, origin, transform = null, color = true, tileTriangles } = input
    const t0 = performance.now()
    const src = prepareMeshForExport(mesh, { sim })
    const tex = texture && mesh.uv ? {
      pages: texture.pages.map((p) => ({ type: p.type, bytes: texture.data.subarray(p.offset, p.offset + p.length) })),
      groups: texture.groups,
    } : null
    const out = zipBlob()
    const res = await meshToTiles(src, tex, { origin, color, transform, tileTriangles, emit: out.emit,
      onLog: (m, l, c) => emit('log', [m, l, c]),
      onProgress: (done, total) => emit('progress', [done, total, 'Writing tiles', done / Math.max(1, total)]) })
    const blob = out.finish(res.tileset, res.external)
    emit('log', [`3D Tiles: ${(mesh.count ?? mesh.idx.length / 3).toLocaleString()} triangles in ${res.tiles.toLocaleString()} tiles `
      + `over ${res.levels} levels${res.textured ? ' (textured leaves)' : ''}, ${(blob.size / 1024 ** 2).toFixed(1)} MB in `
      + `${((performance.now() - t0) / 1000).toFixed(1)} s`, 'info', 'Export'])
    return { result: { blob, tiles: res.tiles, levels: res.levels, textured: res.textured } }
  }

  return { exportPointTiles, exportMeshTiles }
}
