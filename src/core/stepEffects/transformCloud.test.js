import { describe, it, expect } from 'vitest'
import { transformCloudEffects } from './transformCloud.js'

const ID = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, scale: 1, pivot: 'centre' }

describe('transformCloudEffects', () => {
  it('says when nothing changes', () => {
    const e = transformCloudEffects(ID)
    expect(e.rotate).toMatch(/^No rotation and scale 1/)
    expect(e.move).toBe('Not moved.')
  })
  it('words the rotation, scale, pivot and move', () => {
    const e = transformCloudEffects({ ...ID, rz: 90, scale: 2, pivot: 'origin', tx: 5 })
    expect(e.rotate).toBe('Rotated 0°, 0°, 90° about X, then Y, then Z and scaled 2×, about the coordinate origin.')
    expect(e.move).toBe('Moved by 5, 0, 0 along X, Y, Z.')
  })
  it('passes on the matrix check', () => {
    expect(transformCloudEffects(ID, { mode: 'matrix', parsed: { error: 'Need 16 numbers.' } }).matrix).toMatch(
      /^Not applied yet: Need 16/,
    )
    expect(transformCloudEffects(ID, { mode: 'matrix', parsed: {} }).matrix).toMatch(/as given/)
  })
})
