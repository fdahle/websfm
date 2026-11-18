import { describe, expect, it } from 'vitest'
import {
  annotationPage,
  georeferenceAnnotation,
  gridOutline,
  iiifImageUri,
  iiifTemplateProblem,
  normalizeIiifImages,
} from './allmaps.js'

// A ground grid of `cells` a side over a 400 × 300 photo: node (i, j) at photo pixel
// (i / cells · 400, j / cells · 300) and map point (1000 + 10 i, 2000 − 10 j); the
// nodes `drop` names ([i, j]) did not land.
function grid(cells, drop = []) {
  const n = cells + 1
  const src = new Float64Array(2 * n * n),
    dst = new Float64Array(2 * n * n)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i
      src[2 * k] = i / cells
      src[2 * k + 1] = j / cells
      const gone = drop.some(([di, dj]) => di === i && dj === j)
      dst[2 * k] = gone ? NaN : 1000 + 10 * i
      dst[2 * k + 1] = gone ? NaN : 2000 - 10 * j
    }
  return { cells, src, dst }
}
// A stand-in for the CRS → WGS 84 transform: metres to degrees by a fixed factor.
const toLonLat = ([x, y]) => [x / 1e5, y / 1e5]

describe('iiifImageUri', () => {
  it('puts each photo’s name into the address, URI-encoded', () => {
    expect(iiifImageUri('https://iiif.example.org/iiif/3/{name}', 'DSC 01.JPG')).toBe(
      'https://iiif.example.org/iiif/3/DSC%2001.JPG',
    )
    expect(iiifImageUri('https://x.org/iiif/2/photos%2F{stem}', 'flight/7.tif')).toBe(
      'https://x.org/iiif/2/photos%2Fflight%2F7',
    )
  })

  it('names the image service, not its info.json or a trailing slash', () => {
    expect(iiifImageUri(' https://x.org/iiif/3/{stem}/info.json ', 'a.jpg')).toBe('https://x.org/iiif/3/a')
    expect(iiifImageUri('https://x.org/iiif/3/{stem}/', 'a.jpg')).toBe('https://x.org/iiif/3/a')
  })
})

describe('iiifTemplateProblem', () => {
  it('asks for an http(s) address that tells the photos apart', () => {
    expect(iiifTemplateProblem('', 3)).toBe('empty')
    expect(iiifTemplateProblem('iiif.example.org/{name}', 3)).toBe('notUrl')
    expect(iiifTemplateProblem('https://iiif.example.org/one-photo', 3)).toBe('noPlaceholder')
    expect(iiifTemplateProblem('https://iiif.example.org/one-photo', 1)).toBe('')
    expect(iiifTemplateProblem('https://iiif.example.org/{stem}', 3)).toBe('')
  })
})

describe('gridOutline', () => {
  it('runs round the frame through every edge node of a grid that landed whole', () => {
    expect(gridOutline(grid(2), 400, 300)).toEqual([
      [0, 0],
      [0, 150],
      [0, 300],
      [200, 300],
      [400, 300],
      [400, 150],
      [400, 0],
      [200, 0],
    ])
  })

  it('leaves out what lies past the horizon', () => {
    // The top row and the top-right node of the middle row never reached the ground.
    const g = grid(2, [
      [0, 0],
      [1, 0],
      [2, 0],
      [2, 1],
    ])
    expect(gridOutline(g, 400, 300)).toEqual([
      [0, 150],
      [0, 300],
      [200, 300],
      [400, 300],
      [200, 150],
    ])
  })

  it('is null with fewer than two landed rows', () => {
    const drop = []
    for (let i = 0; i <= 2; i++) drop.push([i, 0], [i, 1])
    expect(gridOutline(grid(2, drop), 400, 300)).toBeNull()
  })
})

describe('georeferenceAnnotation', () => {
  const args = { width: 400, height: 300, uri: 'https://x.org/iiif/3/a', version: 3, toLonLat }

  it('pairs each landed node’s photo pixel with its longitude and latitude', () => {
    const a = georeferenceAnnotation({ ...args, grid: grid(2, [[2, 0]]) })
    const gcps = a.body.features
    expect(gcps).toHaveLength(8)
    // Node (1, 2): photo pixel (200, 300), map point (1010, 1980).
    const node = gcps.find((f) => f.properties.resourceCoords[0] === 200 && f.properties.resourceCoords[1] === 300)
    expect(node.geometry).toEqual({ type: 'Point', coordinates: [0.0101, 0.0198] })
    expect(a.body.transformation).toEqual({ type: 'thinPlateSpline' })
  })

  it('names the IIIF image with its size and masks it to the landed outline', () => {
    const a = georeferenceAnnotation({ ...args, grid: grid(2) })
    expect(a.type).toBe('Annotation')
    expect(a.motivation).toBe('georeferencing')
    expect(a.target.source).toEqual({ id: 'https://x.org/iiif/3/a', type: 'ImageService3', width: 400, height: 300 })
    expect(a.target.selector.value).toBe(
      '<svg width="400" height="300"><polygon points="0,0 0,150 0,300 200,300 400,300 400,150 400,0 200,0" /></svg>',
    )
    expect(georeferenceAnnotation({ ...args, version: 2, grid: grid(2) }).target.source.type).toBe('ImageService2')
  })

  it('gives no annotation when too little of the photo reached the ground', () => {
    const drop = []
    for (let i = 0; i <= 2; i++) drop.push([i, 0], [i, 1])
    expect(georeferenceAnnotation({ ...args, grid: grid(2, drop) })).toBeNull()
  })
})

describe('annotationPage', () => {
  it('holds the annotations as the items of one page', () => {
    const page = annotationPage([{ type: 'Annotation' }])
    expect(page.type).toBe('AnnotationPage')
    expect(page.items).toEqual([{ type: 'Annotation' }])
  })
})

describe('normalizeIiifImages', () => {
  it('keeps a given address and its version, and nothing for none', () => {
    expect(normalizeIiifImages({ template: ' https://x.org/{name} ', version: 3 })).toEqual({
      template: 'https://x.org/{name}',
      version: 3,
    })
    expect(normalizeIiifImages({ template: 'https://x.org/{name}', version: 7 })).toEqual({
      template: 'https://x.org/{name}',
      version: 2,
    })
    expect(normalizeIiifImages({ template: '  ' })).toBeNull()
    expect(normalizeIiifImages(undefined)).toBeNull()
  })
})
