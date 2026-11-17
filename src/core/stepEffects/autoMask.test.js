import { describe, it, expect } from 'vitest'
import { autoMaskEffects as effects, autoMaskShorts as shorts, autoMaskDoesSomething } from './autoMask.js'
import { renderAll } from '../i18n/index.js'
import { AUTO_MASK_DEFAULTS as D } from '../defaults.user.js'

// In English, as the dialog shows them.
const autoMaskEffects = (s, project) => renderAll(effects(s, project))
const autoMaskShorts = (s) => renderAll(shorts(s))
const sides = (top, right = top, bottom = top, left = top) => ({ top, right, bottom, left })
const base = { ...D, sides: sides(D.border) }

describe('autoMaskEffects', () => {
  it('words a strip, even or per side, and the film frame', () => {
    expect(autoMaskEffects({ ...base, edges: 'strip' }, { photos: 12 }).edges).toBe(
      'A strip of 40 px along every edge of 12 photos.',
    )
    expect(autoMaskEffects({ ...base, edges: 'strip', sides: sides(10, 0, 300, 0) }, { photos: 1 }).edges).toBe(
      'A strip along the edges of 1 photo: top 10, right 0, bottom 300, left 0 px.',
    )
    expect(autoMaskEffects({ ...base, edges: 'strip', sides: sides(0) }, { photos: 3 }).edges).toMatch(/^All sides/)
    expect(autoMaskEffects({ ...base, edges: 'frame' }, { photos: 84 }).edges).toMatch(
      /^Finds where the photograph begins on each of 84 scans.*0\.5 % of the long side inside/,
    )
    expect(autoMaskEffects({ ...base, edges: 'off' }).edges).toMatch(/^Off/)
  })

  it('says how much text is still to read, and what recurs', () => {
    const e = autoMaskEffects({ ...base, edges: 'off', text: true }, { photos: 20, unread: 5 })
    expect(e.text).toMatch(/^Reads the text on 20 photos \(5 to read with PaddleOCR/)
    expect(e.text).toMatch(/20 px around it, and the text a sensor prints/)
    const read = autoMaskEffects({ ...base, text: true, textRecurring: false }, { photos: 20, unread: 0 })
    expect(read.text).toMatch(/\(all read before\)/)
    expect(read.text).not.toMatch(/sensor/)
    expect(autoMaskEffects({ ...base, text: false }).text).toMatch(/^Off/)
  })

  it('names the photos of unknown size it skips, and the masks it meets', () => {
    expect(autoMaskEffects({ ...base, edges: 'frame' }, { photos: 4, unsized: 2 }).edges).toMatch(
      /2 photos of unknown size are skipped\.$/,
    )
    expect(autoMaskEffects(base, { photos: 4 }).existing).toBe('None of these photos has a mask yet.')
    expect(autoMaskEffects({ ...base, existing: 'replace' }, { photos: 4, masked: 3 }).existing).toMatch(
      /^Replace: .* the 3 photos that have one/,
    )
  })
})

describe('autoMaskShorts', () => {
  it('states the method and its numbers', () => {
    expect(autoMaskShorts({ ...base, edges: 'strip' })).toEqual({
      edges: '40 px strip',
      text: 'off',
      existing: 'merge',
    })
    expect(autoMaskShorts({ ...base, edges: 'strip', sides: sides(1, 2, 3, 4) }).edges).toBe('strip 1/2/3/4 px')
    expect(autoMaskShorts({ ...base, edges: 'frame', text: true }).edges).toBe('film frame · 0.5 %')
    expect(autoMaskShorts({ ...base, edges: 'off', text: true }).text).toBe('20 px · recurring')
  })
})

describe('autoMaskDoesSomething', () => {
  it('is false only when neither edges nor text mask anything', () => {
    expect(autoMaskDoesSomething({ ...base, edges: 'off', text: false })).toBe(false)
    expect(autoMaskDoesSomething({ ...base, edges: 'strip', sides: sides(0), text: false })).toBe(false)
    expect(autoMaskDoesSomething({ ...base, edges: 'strip' })).toBe(true)
    expect(autoMaskDoesSomething({ ...base, edges: 'frame' })).toBe(true)
    expect(autoMaskDoesSomething({ ...base, edges: 'off', text: true })).toBe(true)
  })
})
