import { describe, it, expect } from 'vitest'
import { flatAxes } from './flatAxes.js'
import { cloudToXyzParts } from '../io/cloudText.js'
import { cloudToLasParts, parseLas } from '../io/las.js'

// prepareCloudForExport hands the writers a cloud past the 2 GiB buffer wall as Float32
// positions relative to an origin; every writer must give the same file as absolute.
const abs = new Float64Array([512345.125, 5432101.5, 412.25, 512346.875, 5432099.25, 410.75, 512344.5, 5432100.125, 411.5])
const origin = [512345.5, 5432100.375, 411.5]
const rel = Float32Array.from(abs, (v, i) => v - origin[i % 3])
const col = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90])
const text = (parts) => [...parts].join('')

describe('flat clouds relative to an origin', () => {
  it('reads the absolute coordinates back', () => {
    const [x, y, z] = flatAxes({ pos: rel, origin })
    for (let i = 0; i < 3; i++) expect([x(i), y(i), z(i)]).toEqual([abs[3 * i], abs[3 * i + 1], abs[3 * i + 2]])
  })

  it('writes the same XYZ and LAS as the absolute cloud', async () => {
    expect(text(cloudToXyzParts({ count: 3, pos: rel, origin, col }))).toBe(text(cloudToXyzParts({ count: 3, pos: abs, col })))
    const read = async (cloud) => {
      const parts = [...cloudToLasParts(cloud)]
      const bytes = new Uint8Array(await new Blob(parts).arrayBuffer())
      return Array.from(parseLas(bytes).pos)
    }
    expect(await read({ count: 3, pos: rel, origin, col })).toEqual(await read({ count: 3, pos: abs, col }))
  })
})
