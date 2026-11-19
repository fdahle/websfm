import { describe, it, expect } from 'vitest'
import { NO_IMAGE_FILTER, imageFilterActive, matchesImageFilter } from './imageFilter.js'

const img = (name, extra = {}) => ({ name, kpStatus: 'done', ...extra })
const filter = (text = '', state = 'all') => ({ text, state })

describe('image list filter', () => {
  it('is off with no text and every state', () => {
    expect(imageFilterActive(NO_IMAGE_FILTER)).toBe(false)
    expect(imageFilterActive(filter('  '))).toBe(false)
    expect(imageFilterActive(filter('DJI'))).toBe(true)
    expect(imageFilterActive(filter('', 'disabled'))).toBe(true)
  })

  it('matches every typed word in the name, in any case and order', () => {
    expect(matchesImageFilter(img('DJI_0042.JPG'), filter('dji'))).toBe(true)
    expect(matchesImageFilter(img('flight2/DJI_0042.JPG'), filter('0042 flight2'))).toBe(true)
    expect(matchesImageFilter(img('DJI_0042.JPG'), filter('dji 0043'))).toBe(false)
  })

  it('filters by state from what the list knows', () => {
    expect(matchesImageFilter(img('a'), filter('', 'unaligned'), { unaligned: true })).toBe(true)
    expect(matchesImageFilter(img('a'), filter('', 'unaligned'), { unaligned: false })).toBe(false)
    expect(matchesImageFilter(img('a'), filter('', 'disabled'), { enabled: false })).toBe(true)
    expect(matchesImageFilter(img('a'), filter('', 'disabled'), { enabled: true })).toBe(false)
    expect(matchesImageFilter(img('a', { kpStatus: 'idle' }), filter('', 'noKeypoints'))).toBe(true)
    expect(matchesImageFilter(img('a'), filter('', 'noKeypoints'))).toBe(false)
    expect(matchesImageFilter(img('a', { previewFailed: true }), filter('', 'failed'))).toBe(true)
  })

  it('needs the name and the state both', () => {
    const f = filter('0042', 'disabled')
    expect(matchesImageFilter(img('DJI_0042.JPG'), f, { enabled: false })).toBe(true)
    expect(matchesImageFilter(img('DJI_0043.JPG'), f, { enabled: false })).toBe(false)
    expect(matchesImageFilter(img('DJI_0042.JPG'), f, { enabled: true })).toBe(false)
  })
})
