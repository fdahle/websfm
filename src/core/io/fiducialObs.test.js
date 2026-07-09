import { describe, it, expect } from 'vitest'
import { parseFiducialObs, guessMapping } from './fiducialObs.js'

describe('parseFiducialObs', () => {
  it('parses a headered CSV', () => {
    const text = [
      'image,fiducial,px,py',
      'IMG_001.tif,F1,512.3,488.1',
      'IMG_001.tif,F2,7020.0,489.5',
      'IMG_002.tif,F1,510.0,490.0',
    ].join('\n')
    const { rows } = parseFiducialObs(text)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toEqual({ imageName: 'IMG_001.tif', fidId: 'F1', px: 512.3, py: 488.1 })
    expect(rows[2].imageName).toBe('IMG_002.tif')
  })

  it('parses headerless positional rows', () => {
    const text = 'IMG_001.tif\tF1\t100\t200\nIMG_001.tif\tF2\t300\t400'
    const { rows } = parseFiducialObs(text)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual({ imageName: 'IMG_001.tif', fidId: 'F2', px: 300, py: 400 })
  })

  it('drops rows with non-finite pixels', () => {
    const text = 'image,fiducial,px,py\nA,F1,10,20\nA,F2,,30\nB,F1,x,y'
    const { rows } = parseFiducialObs(text)
    expect(rows).toHaveLength(1)
  })

  it('maps alternate header names (mark / u / v)', () => {
    const map = guessMapping(['photo', 'mark', 'u', 'v'], 4, true, { positional: false })
    expect(map).toEqual({ image: 0, fiducial: 1, px: 2, py: 3 })
  })
})
