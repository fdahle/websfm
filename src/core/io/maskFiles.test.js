import { describe, it, expect } from 'vitest'
import { maskFileCandidates, matchMaskFiles } from './maskFiles.js'

const images = [
  { id: 'a', name: 'CA214732V0046.tif' },
  { id: 'b', name: 'IMG_0001.JPG' },
  { id: 'c', name: 'IMG_0002.jpg' },
]

describe('maskFileCandidates', () => {
  it('tries the name itself, then the COLMAP and Metashape forms', () => {
    expect(maskFileCandidates('masks/IMG_0001.jpg.png')).toEqual(['IMG_0001.jpg.png', 'IMG_0001.jpg'])
    expect(maskFileCandidates('IMG_0001_mask.png')).toEqual(['IMG_0001_mask.png', 'IMG_0001'])
    expect(maskFileCandidates('IMG_0001.png')).toEqual(['IMG_0001.png'])
  })
})

describe('matchMaskFiles', () => {
  it('pairs the three naming schemes', () => {
    const r = matchMaskFiles(['CA214732V0046.tif', 'img_0001.jpg.png', 'IMG_0002-mask.png'], images)
    expect(r.pairs).toEqual([
      { index: 0, imageId: 'a' },
      { index: 1, imageId: 'b' },
      { index: 2, imageId: 'c' },
    ])
    expect(r.imagesWithout).toBe(0)
  })

  it('reports files that fit no image, a further file for one image, and non-images', () => {
    const r = matchMaskFiles(['IMG_0001.png', 'IMG_0002.png', 'img_0002.PNG', 'other.png', 'notes.txt'], images)
    expect(r.pairs).toEqual([
      { index: 0, imageId: 'b' },
      { index: 1, imageId: 'c' },
    ])
    expect(r.duplicates).toEqual(['img_0002.PNG'])
    expect(r.unmatched).toEqual(['other.png'])
    expect(r.skipped).toEqual(['notes.txt'])
    expect(r.imagesWithout).toBe(1)
  })

  it("prefers a mask-style name to the image's own file in a mixed folder", () => {
    const r = matchMaskFiles(['IMG_0001.JPG', 'IMG_0001.JPG.png', 'IMG_0002.jpg'], images)
    expect(r.pairs).toEqual([
      { index: 1, imageId: 'b' },
      { index: 2, imageId: 'c' },
    ])
    expect(r.duplicates).toEqual(['IMG_0001.JPG'])
  })
})
