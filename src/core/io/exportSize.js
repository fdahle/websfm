// A rough size of a cloud or mesh export before it is written, from the element counts
// and each format's bytes per element (the writers in core/products/exporters.js and
// core/io/las.js). It only decides whether the export asks for a save location first
// (EXPORT_TUNING.savePickerMinMiB), so ASCII formats use a typical line length.

// Bytes per point: PLY doubles x, y, z + RGB; LAS point formats 2/3; LAZ about a
// quarter of LAS; XYZ / ASCII PLY lines of about 40 characters.
const CLOUD_BYTES = { 'ply-binary': 27, 'ply-ascii': 40, 'las': 34, 'laz': 9, 'xyz': 40 }

// Bytes per vertex and per triangle.
const MESH_BYTES = {
  'ply-binary': [15, 13],
  'ply-ascii': [40, 16],
  'glb': [16, 12],
  'obj': [40, 25],
  'stl': [0, 50],
}

/**
 * @param {{ kind: 'cloud' | 'mesh', format: string, points?: number, vertices?: number, triangles?: number }} o
 * @returns {number} estimated bytes
 */
export function estimateExportBytes({ kind, format, points = 0, vertices = 0, triangles = 0 }) {
  if (kind === 'mesh') {
    const [v, t] = MESH_BYTES[format] ?? MESH_BYTES['ply-binary']
    return v * vertices + t * triangles
  }
  return (CLOUD_BYTES[format] ?? CLOUD_BYTES['ply-binary']) * points
}
