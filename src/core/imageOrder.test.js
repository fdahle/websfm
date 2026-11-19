import { describe, it, expect } from 'vitest'
import { imagePlace, stepImage } from './imageOrder.js'

describe('stepping through the image list', () => {
  const order = ['a', 'b', 'c']

  it('steps forward and back in the list order', () => {
    expect(stepImage(order, 'b', 1)).toBe('c')
    expect(stepImage(order, 'b', -1)).toBe('a')
  })

  it('stops at either end rather than wrapping', () => {
    expect(stepImage(order, 'c', 1)).toBeNull()
    expect(stepImage(order, 'a', -1)).toBeNull()
  })

  it('does nothing for a photo the list does not hold', () => {
    expect(stepImage(order, 'zz', 1)).toBeNull()
    expect(imagePlace(order, 'zz')).toEqual({ first: false, last: false })
  })

  it('matches ids whatever their type', () => {
    expect(stepImage([1, 2, 3], '2', 1)).toBe(3)
  })

  it('says where a photo stands', () => {
    expect(imagePlace(order, 'a')).toEqual({ first: true, last: false })
    expect(imagePlace(order, 'c')).toEqual({ first: false, last: true })
    expect(imagePlace(['only'], 'only')).toEqual({ first: true, last: true })
  })
})
