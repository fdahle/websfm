import { describe, it, expect } from 'vitest'
import { stripSourcePrefix } from './logFormat.js'

describe('stripSourcePrefix', () => {
  it('drops an exact leading "<source>: " head', () => {
    expect(stripSourcePrefix('Reconstruction', 'Reconstruction: starting with 42 images'))
      .toBe('starting with 42 images')
  })

  it('is case-insensitive on the prefix', () => {
    expect(stripSourcePrefix('Dense', 'dense: coarse-to-fine 3 levels'))
      .toBe('coarse-to-fine 3 levels')
  })

  it('never strips a mid-sentence occurrence', () => {
    const msg = 'K[img]: Reconstruction: value'
    expect(stripSourcePrefix('Reconstruction', msg)).toBe(msg)
  })

  it('leaves an informative sub-stage label under a different source', () => {
    // "Mesh:" logged under the "Products" source is a sub-stage label, not a dup.
    expect(stripSourcePrefix('Products', 'Mesh: Poisson over 1M points'))
      .toBe('Mesh: Poisson over 1M points')
  })

  it('is a no-op without a source or a non-string message', () => {
    expect(stripSourcePrefix(null, 'Reconstruction: x')).toBe('Reconstruction: x')
    expect(stripSourcePrefix('Reconstruction', undefined)).toBe(undefined)
  })
})
