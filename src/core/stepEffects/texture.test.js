import { describe, it, expect } from 'vitest'
import { textureEffects } from './texture.js'
import { TEXTURE_DEFAULTS } from '../defaults.user.js'

describe('textureEffects', () => {
  it('follows visibility, selection, packing and levelling', () => {
    const e = textureEffects(TEXTURE_DEFAULTS, { triangles: 300000, cameras: 42 })
    expect(e.visibility).toMatch(/^Each of the 300,000 triangles is checked against the 42 photos/)
    expect(e.selection).toMatch(/seam penalty of 0\.5/)
    expect(e.atlas).toMatch(/^Cut out at the photos’ native resolution onto pages of 4096 × 4096 px, at most 8 pages/)
    expect(textureEffects({ ...TEXTURE_DEFAULTS, levelColours: false }).colour).toMatch(/^Off/)
    expect(textureEffects(TEXTURE_DEFAULTS).visibility).toMatch(/^Build the sparse model first/)
  })
})
