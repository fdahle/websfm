import { describe, it, expect } from 'vitest'
import { parseFiducialObs, guessMapping, previewFiducialObs } from './fiducialObs.js'
import { observationsToDetections } from '../sfm/fiducialModel.js'

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

// One image per row with an x/y column per mark position (the casa_grande
// preprocessing output: detected_fiducial_markers.csv).
describe('parseFiducialObs — one image per row', () => {
  const text = [
    'image_id,corner_top_left_x,corner_top_left_y,corner_top_right_x,corner_top_right_y,corner_bottom_left_x,' +
      'corner_bottom_left_y,corner_bottom_right_x,corner_bottom_right_y,midside_top_x,midside_top_y,midside_bottom_x,' +
      'midside_bottom_y,midside_left_x,midside_left_y,midside_right_x,midside_right_y,principal_point_x,principal_point_y',
    'ARBCSRD00010006.tif,329.75,329.74,8809.66,329.69,330.28,8810.29,8809.56,8809.25,4568.68,169.96,4569.51,8969.52,' +
      '168.47,4570.89,8969.09,4569.82,4569.38,4569.9',
    'ARBCSRD00010007.tif,329.66,329.89,8809.47,329.73,,,8809.52,8809.46,4568.51,170.06,4569.3,8969.41,168.32,4570.92,' +
      '8968.87,4569.93,4569.21,4569.98',
  ].join('\n')

  it('spreads each row into one mark per position, named by its slot', () => {
    const { rows, layout } = parseFiducialObs(text)
    expect(layout).toBe('wide')
    const first = rows.filter((r) => r.imageName === 'ARBCSRD00010006.tif')
    expect(first).toHaveLength(8)
    expect(first.find((r) => r.fidId === 'corner-tl')).toEqual({
      imageName: 'ARBCSRD00010006.tif',
      fidId: 'corner-tl',
      px: 329.75,
      py: 329.74,
    })
    expect(first.find((r) => r.fidId === 'side-right')).toMatchObject({ px: 8969.09, py: 4569.82 })
  })

  it('skips a blank mark and ignores the principal-point columns', () => {
    const { rows } = parseFiducialObs(text)
    const second = rows.filter((r) => r.imageName === 'ARBCSRD00010007.tif')
    expect(second.map((r) => r.fidId)).not.toContain('corner-bl')
    expect(second).toHaveLength(7)
    expect(rows.some((r) => r.px === 4569.38)).toBe(false)
  })
})

describe('previewFiducialObs', () => {
  const images = [
    { id: 1, name: 'scan_01.tif', fiducialDetections: [{ slot: 'corner-tl' }] },
    { id: 2, name: 'scan_02.tif' },
  ]
  const rows = [
    { imageName: 'scan_01.tif', fidId: 'corner-tl', px: 1, py: 2 },
    { imageName: 'scan_01.tif', fidId: 'corner-tr', px: 3, py: 4 },
    { imageName: 'SCAN_02.jpg', fidId: 'corner-tl', px: 5, py: 6 },
    { imageName: 'other.tif', fidId: 'corner-tl', px: 7, py: 8 },
  ]
  it('groups by file, matches images like the importer and counts replaced slots', () => {
    const p = previewFiducialObs(rows, images)
    expect(p.map((g) => [g.fileName, g.imageId, g.marks.length, g.replaces])).toEqual([
      ['scan_01.tif', 1, 2, 1],
      ['SCAN_02.jpg', 2, 1, 0],
      ['other.tif', null, 1, 0],
    ])
  })

  // Ids that name no slot are placed by position on import (observationsToDetections);
  // the preview has to see the same slots, or it misses the marks they overwrite.
  it('places non-slot ids by position, as the import does, and counts what they replace', () => {
    const reviewed = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'].map((slot) => ({ slot, reviewed: true }))
    const imgs = [{ id: 1, name: 'scan.tif', meta: { width: 1000, height: 1000 }, fiducialDetections: reviewed }]
    const numbered = [
      { imageName: 'scan.tif', fidId: '1', px: 20, py: 20 },
      { imageName: 'scan.tif', fidId: '2', px: 980, py: 20 },
      { imageName: 'scan.tif', fidId: '3', px: 980, py: 980 },
      { imageName: 'scan.tif', fidId: '4', px: 20, py: 980 },
    ]
    const [g] = previewFiducialObs(numbered, imgs)
    expect(g.marks.map((m) => m.slot)).toEqual(['corner-tl', 'corner-tr', 'corner-br', 'corner-bl'])
    expect(g.replaces).toBe(4)
    expect(g.shared).toBe(0)
    // The import, for the same rows, produces exactly these slots.
    expect(observationsToDetections(numbered, 1000, 1000).map((d) => d.slot)).toEqual(g.marks.map((m) => m.slot))
  })

  it('places all rows of one image together, across file names, and flags shared slots', () => {
    const imgs = [{ id: 1, name: 'scan.tif', meta: { width: 1000, height: 1000 } }]
    const p = previewFiducialObs(
      [
        { imageName: 'scan.tif', fidId: 'A', px: 10, py: 10 },
        { imageName: 'SCAN.jpg', fidId: 'B', px: 30, py: 30 },
      ],
      imgs,
    )
    expect(p.map((g) => [g.imageId, g.marks[0].slot, g.shared])).toEqual([
      [1, 'corner-tl', 1],
      [1, 'corner-tl', 1],
    ])
  })

  it('leaves the slot open for an image the project lacks', () => {
    const [g] = previewFiducialObs([{ imageName: 'x.tif', fidId: '1', px: 1, py: 1 }], [])
    expect(g).toMatchObject({ imageId: null, replaces: 0, shared: 0 })
    expect(g.marks[0].slot).toBeNull()
  })
})
