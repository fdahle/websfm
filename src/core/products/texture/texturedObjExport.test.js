import { describe, it, expect } from 'vitest'
// The textured OBJ zip (workers/ops/export.js exportMesh). Here, not next to the op: the
// vitest include covers src/core, not src/workers.
import { makeExportOps, objSafeName } from '../../../workers/ops/export.js'
import { readZipIndex, zipEntryBlob } from '../../../utils/zip.js'

describe('objSafeName', () => {
  it('keeps word characters, dots and dashes; nothing else, never empty', () => {
    expect(objSafeName('South Building-mesh')).toBe('South_Building-mesh')
    expect(objSafeName('  a/b\\c:d  ')).toBe('a_b_c_d')
    expect(objSafeName('')).toBe('mesh')
  })
})

describe('exportMesh: textured OBJ', () => {
  it('names the zip entries as the .obj and .mtl reference them, with no spaces', async () => {
    const { exportMesh } = makeExportOps()
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    const mesh = {
      nVerts: 3,
      count: 1,
      pos: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      idx: new Uint32Array([0, 1, 2]),
      uv: new Float32Array([0.1, 0.1, 0.9, 0.1, 0.1, 0.9]),
    }
    const texture = {
      data: jpeg,
      pages: [{ width: 4, height: 4, offset: 0, length: 4, type: 'image/jpeg' }],
      groups: [{ page: 0, start: 0, count: 1 }],
    }
    const { result } = await exportMesh([{ mesh, format: 'obj', texture, name: 'My Project-mesh' }], { emit: () => {} })
    expect(result.ext).toBe('zip')
    const entries = await readZipIndex(result.blob)
    const names = entries.map((e) => e.name)
    expect(names).toEqual(['My_Project-mesh.obj', 'My_Project-mesh.mtl', 'My_Project-mesh_atlas0.jpg'])
    const text = async (name) =>
      (
        await zipEntryBlob(
          result.blob,
          entries.find((e) => e.name === name),
        )
      ).text()
    const obj = await text('My_Project-mesh.obj'),
      mtl = await text('My_Project-mesh.mtl')
    expect(obj).toMatch(/^mtllib My_Project-mesh\.mtl$/m)
    expect(mtl).toMatch(/^map_Kd My_Project-mesh_atlas0\.jpg$/m)
  })
})
