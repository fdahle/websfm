import { describe, expect, it } from 'vitest'
import { loadProgressView } from './loadProgress.js'

describe('loadProgressView', () => {
  it('shows the image count while images load', () => {
    const v = loadProgressView({ done: 3, total: 10, label: 'a.jpg' }, new Map([['matches', { label: 'x' }]]))
    expect(v).toEqual({ label: 'Loading images — a.jpg', done: 3, total: 10, detail: null })
  })

  it('names the remaining step after the images, instead of going blank', () => {
    const stores = new Map([
      ['reconstruction', { label: 'Decoding "Dense"', done: 1, total: 2 }],
      ['matches', { label: null }],
      ['gcps', null],
    ])
    expect(loadProgressView(null, stores)).toEqual({
      label: 'Reconstruction: Decoding "Dense"',
      done: 1,
      total: 2,
      detail: 'Also restoring: Matches',
    })
  })

  it('prefers a counted step and lists silent stores by name', () => {
    const stores = new Map([
      ['reconstruction', { label: 'Preparing the 3D view' }],
      ['matches', { label: 'Reading image pairs', done: 5, total: 50 }],
    ])
    expect(loadProgressView(null, stores).label).toBe('Matches: Reading image pairs')
    expect(loadProgressView(null, new Map([['matches', { label: null }]])).label).toBe('Restoring Matches…')
  })

  it('is null once everything is done', () => {
    expect(loadProgressView(null, new Map([['matches', null]]))).toBeNull()
  })
})
