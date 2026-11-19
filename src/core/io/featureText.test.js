import { describe, expect, it } from 'vitest'
import { imageNameOfFile, keypointsFromPointMatches, readFeatureFile, validMatchIndices } from './featureText.js'

describe('readFeatureFile: keypoints', () => {
  it('reads a table with an image column', () => {
    const r = readFeatureFile('image,x,y,scale\nA.jpg,1,2,3\nA.jpg,4,5,6\nB.jpg,7,8,9\n', 'kps.csv')
    expect(r.kind).toBe('keypoints')
    expect(r.images.map((i) => i.name)).toEqual(['A.jpg', 'B.jpg'])
    expect([...r.images[0].x]).toEqual([1, 4])
    expect([...r.images[0].scale]).toEqual([3, 6])
    expect(r.images[1].angle).toBeNull()
  })

  it('reads one file per image, with or without a header, named after the image', () => {
    const r = readFeatureFile('# from my detector\n10.5 20.25\n30 40\n', 'IMG_0001.jpg.txt')
    expect(r.images).toHaveLength(1)
    expect(r.images[0].name).toBe('IMG_0001.jpg')
    expect([...r.images[0].y]).toEqual([20.25, 40])
    const h = readFeatureFile('x;y\n1;2\n', 'IMG_2.csv')
    expect(h.kind).toBe('keypoints')
    expect(h.images[0].name).toBe('IMG_2')
    expect([...h.images[0].x]).toEqual([1])
  })

  it('reads image-named rows without a header', () => {
    const r = readFeatureFile('A.jpg 1 2\nB.jpg 3 4 1.5 0.2\n', 'all.txt')
    expect(r.images.map((i) => [i.name, i.x[0]])).toEqual([
      ['A.jpg', 1],
      ['B.jpg', 3],
    ])
  })

  it("reads Lowe's .key, row before column, and leaves the descriptors", () => {
    const desc = Array.from({ length: 128 }, (_, i) => i % 7).join(' ')
    const text = `2 128\n10.0 20.0 1.5 0.3\n${desc}\n11.0 21.0 2.5 -0.3\n${desc}\n`
    const r = readFeatureFile(text, 'IMG_0001.key')
    expect(r.images[0].name).toBe('IMG_0001')
    expect([...r.images[0].x]).toEqual([20, 21])
    expect([...r.images[0].y]).toEqual([10, 11])
    expect(r.images[0].scale[1]).toBeCloseTo(2.5)
    // Recognised by its content too.
    expect(readFeatureFile(text, 'IMG_0001.txt').images[0].x[0]).toBe(20)
    expect(() => readFeatureFile('3 128\n1 2 3 4\n', 'short.key')).toThrow(/ends after/)
  })
})

describe('readFeatureFile: matches', () => {
  it("reads COLMAP's custom-match blocks", () => {
    const r = readFeatureFile('A.jpg B.jpg\n0 1\n2 3\n\nA.jpg C.jpg\n4 5\n', 'matches.txt')
    expect(r.kind).toBe('matches')
    expect(r.pairs.map((p) => [p.a, p.b, [...p.idx]])).toEqual([
      ['A.jpg', 'B.jpg', [0, 1, 2, 3]],
      ['A.jpg', 'C.jpg', [4, 5]],
    ])
    expect(() => readFeatureFile('A.jpg B.jpg\n0 1\n0 1 2\n', 'bad.txt')).toThrow(/line 3/)
  })

  it('reads index rows, with a header or by their pattern', () => {
    const h = readFeatureFile('image_a,image_b,idx_a,idx_b\nA,B,0,1\nA,B,2,3\nB,C,5,6\n', 'm.csv')
    expect(h.pairs.map((p) => [p.a, p.b, p.idx.length])).toEqual([
      ['A', 'B', 4],
      ['B', 'C', 2],
    ])
    const n = readFeatureFile('A.jpg\tB.jpg\t0\t1\n', 'm.tsv')
    expect(n.kind).toBe('matches')
    expect([...n.pairs[0].idx]).toEqual([0, 1])
  })

  it('reads matched points by position', () => {
    const r = readFeatureFile('image1,x1,y1,image2,x2,y2\nA,1,2,B,3,4\nA,5,6,B,7,8\n', 'pts.csv')
    expect(r.kind).toBe('point-matches')
    expect([...r.pairs[0].pts]).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(readFeatureFile('A 1 2 B 3 4\n', 'pts.txt').kind).toBe('point-matches')
  })

  it('says what it could not read', () => {
    expect(() => readFeatureFile('', 'empty.txt')).toThrow(/empty/)
    expect(() => readFeatureFile('image_a,image_b\nA,B\n', 'x.csv')).toThrow(/no index or x\/y/)
    expect(() => readFeatureFile('a b c d e\n1 2 3 4 5\n', 'x.txt')).toThrow(/x and y/)
  })
})

describe('keypointsFromPointMatches', () => {
  it('makes one keypoint per position, so tracks join across pairs', () => {
    const { keypoints, pairs } = keypointsFromPointMatches([
      { a: 'A', b: 'B', pts: Float64Array.from([1, 1, 2, 2, 5, 5, 6, 6]) },
      { a: 'B', b: 'C', pts: Float64Array.from([2.001, 2, 9, 9]) },
    ])
    expect(keypoints.get('B').x.length).toBe(2)
    expect([...pairs[0].idx]).toEqual([0, 0, 1, 1])
    // B's (2.001, 2) is the keypoint (2, 2) matched to A: one track over A, B and C.
    expect([...pairs[1].idx]).toEqual([0, 0])
  })
})

describe('validMatchIndices', () => {
  it('drops indices past the keypoints and repeated matches', () => {
    const r = validMatchIndices(Uint32Array.from([0, 0, 1, 9, 0, 0, 2, 1]), 3, 2)
    expect([...r.idx]).toEqual([0, 0, 2, 1])
    expect(r.invalid).toBe(1)
  })
})

it('imageNameOfFile strips the file extension only', () => {
  expect(imageNameOfFile('dir/IMG_1.JPG.txt')).toBe('IMG_1.JPG')
})

describe('readFeatureFile: cells and JSON', () => {
  it('keeps a quoted name, or one with spaces, as one cell', () => {
    const r = readFeatureFile('image,x,y\n"B,2.jpg",1,2\nIMG 1.jpg,3,4\n"say ""hi"".jpg",5,6\n', 'kps.csv')
    expect(r.images.map((i) => [i.name, i.x[0]])).toEqual([
      ['B,2.jpg', 1],
      ['IMG 1.jpg', 3],
      ['say "hi".jpg', 5],
    ])
  })

  it('reads keypoints and matches JSON, orientation when given', () => {
    const k = readFeatureFile(
      JSON.stringify([{ image: 'A.jpg', keypoints: [{ x: 1, y: 2, orientation: 0.5 }] }]),
      'k.json',
    )
    expect(k.kind).toBe('keypoints')
    expect([k.images[0].name, k.images[0].x[0], k.images[0].angle[0], k.images[0].scale]).toEqual([
      'A.jpg',
      1,
      0.5,
      null,
    ])
    const m = readFeatureFile(
      JSON.stringify([
        { imageA: 'A.jpg', imageB: 'B.jpg', matches: [[3, 4]] },
        { imageA: 'A.jpg', imageB: 'C.jpg', matches: [] },
      ]),
      'm.json',
    )
    expect(m.pairs.map((p) => [p.a, p.b, [...p.idx]])).toEqual([
      ['A.jpg', 'B.jpg', [3, 4]],
      ['A.jpg', 'C.jpg', []],
    ])
  })

  it('names what is wrong with a JSON file it cannot read', () => {
    expect(() => readFeatureFile('[{"image": "A.jpg", "keypoints": [', 'k.json')).toThrow(/k\.json: not valid JSON/)
    expect(() => readFeatureFile('[]', 'k.json')).toThrow(/empty/)
    expect(() => readFeatureFile('{"a": 1}', 'k.json')).toThrow(/a list of images or of image pairs/)
    expect(() => readFeatureFile('[{"image": "A.jpg", "keypoints": [{"x": 1}]}]', 'k.json')).toThrow(
      /entry 1, keypoint 1: no x and y/,
    )
    expect(() => readFeatureFile('[{"imageA": "A", "imageB": "B", "matches": [[1, -2]]}]', 'm.json')).toThrow(
      /entry 1, match 1/,
    )
    expect(() => readFeatureFile('[{"imageA": "A", "imageB": "B", "inlierCount": 4}]', 'p.json')).toThrow(
      /without their matches/,
    )
  })
})
