import { describe, expect, it } from 'vitest'
import { MASK_HINT, maskGroups } from './maskGroups.js'

const img = (id, width, height, mask = null) => ({ id, meta: width ? { width, height } : undefined, mask })

describe('maskGroups', () => {
  it('groups by resolution in first-seen order, keeping list order within a group', () => {
    const images = [img(1, 4000, 3000), img(2, 640, 480), img(3, 4000, 3000), img(4)]
    const { groups } = maskGroups(images)
    expect(groups.map((g) => g.key)).toEqual(['4000×3000', '640×480', 'unknown'])
    expect(groups[0]).toMatchObject({ w: 4000, h: 3000, label: '4000 × 3000' })
    expect(groups[0].images.map((i) => i.id)).toEqual([1, 3])
    expect(groups[2]).toMatchObject({ w: null, h: null, label: 'Unknown size' })
  })

  it('puts an image with only one known dimension in the unknown group', () => {
    const { groups, sizedGroups } = maskGroups([
      { id: 1, meta: { width: 100 } },
      { id: 2, meta: { width: 0, height: 50 } },
    ])
    expect(groups.map((g) => g.key)).toEqual(['unknown'])
    expect(groups[0].images).toHaveLength(2)
    expect(sizedGroups).toEqual([])
  })

  it('leaves the unknown group out of sizedGroups', () => {
    const { sizedGroups } = maskGroups([img(1), img(2, 10, 20)])
    expect(sizedGroups.map((g) => g.key)).toEqual(['10×20'])
  })

  it('counts masked images and states it in the hint', () => {
    const r = maskGroups([img(1, 10, 10, { blob: 'x' }), img(2, 10, 10), img(3, null, null, 'data:')])
    expect(r.maskedCount).toBe(2)
    expect(r.hint).toBe(`2 of 3 masked. ${MASK_HINT}`)
  })

  it('handles an empty image list', () => {
    expect(maskGroups([])).toEqual({ groups: [], sizedGroups: [], maskedCount: 0, hint: `0 of 0 masked. ${MASK_HINT}` })
  })
})
