import { describe, expect, it } from 'vitest'
import { cameraToWorldGl } from './transforms.js'
import {
  parseNvm,
  parseTransformsJson,
  parseOpenSfm,
  buildNvmParts,
  buildOpenMvg,
  parseBundler,
  parseSfmText,
} from './sfmInterop.js'
import { joinParts, jsonParts } from './parts.js'

describe('SfM interop readers', () => {
  it('round-trips transforms camera convention', () => {
    const R = [
        [0, -1, 0],
        [1, 0, 0],
        [0, 0, 1],
      ],
      t = [2, 3, 4]
    const parsed = parseTransformsJson({
      fl_x: 900,
      fl_y: 901,
      cx: 400,
      cy: 300,
      w: 800,
      h: 600,
      frames: [{ file_path: 'a.jpg', transform_matrix: cameraToWorldGl(R, t) }],
    })
    expect(parsed.images[0].R.flat()).toEqual(R.flat())
    expect(parsed.images[0].t).toEqual(t)
    // Its pixel centres are at +½, WebSfM's at 0.
    expect(parsed.images[0].K).toMatchObject({ cx: 399.5, cy: 299.5 })
  })

  it('reads an OpenSfM principal point in WebSfM pixels', () => {
    const parsed = parseOpenSfm({
      cameras: { cam: { width: 800, height: 600, focal: 1, c_x: 0, c_y: 0 } },
      shots: { 'a.jpg': { camera: 'cam', rotation: [0, 0, 0], translation: [0, 0, 0] } },
    })
    // A centred OpenSfM principal point is the image centre: ((w − 1)/2, (h − 1)/2).
    expect(parsed.images[0].K).toMatchObject({ cx: 399.5, cy: 299.5 })
  })

  it('reads an NVM camera and measurement', () => {
    const parsed = parseNvm('NVM_V3\n1\na.jpg 1000 1 0 0 0 1 2 3 0\n1\n0 0 0 255 0 0 1 0 7 10 20\n0')
    expect(parsed.images[0].t).toEqual([-1, -2, -3])
    expect(parsed.points[0].views[0].name).toBe('a.jpg')
  })
})

describe('NVM / OpenMVG writers — streamed', () => {
  const model = {
    images: [
      {
        imageId: 1,
        cameraId: 1,
        name: 'a.jpg',
        q: [1, 0, 0, 0],
        t: [1, 2, 3],
        R: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        K: { fx: 100, cx: 50, cy: 40 },
        width: 100,
        height: 80,
        points2D: [[60, 50, 1]],
      },
      {
        imageId: 2,
        cameraId: 2,
        name: 'b.jpg',
        q: [1, 0, 0, 0],
        t: [0, 0, 0],
        R: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
        K: { fx: 90, cx: 45, cy: 35 },
        width: 90,
        height: 70,
        points2D: [
          [1, 2, -1],
          [47, 36, 1],
        ],
      },
    ],
    points3D: [
      {
        point3dId: 1,
        xyz: [0.5, 1, 2],
        rgb: [10, 20, 30],
        error: 0,
        track: [
          [1, 0],
          [2, 1],
        ],
      },
    ],
  }
  it('NVM text is unchanged and splits into parts', () => {
    expect(joinParts(buildNvmParts(model))).toBe(
      'NVM_V3\n\n2\na.jpg 100 1 0 0 0 -1 -2 -3 0 0\nb.jpg 90 1 0 0 0 0 0 0 0 0\n\n1\n0.5 1 2 10 20 30 2 0 0 10 10 1 1 2 1\n\n0\n',
    )
    expect([...buildNvmParts(model, { partChars: 8 })].length).toBeGreaterThan(3)
  })
  it('OpenMVG JSON streams to the same text as the materialized document', () => {
    const doc = buildOpenMvg(model)
    const materialized = {
      ...doc,
      structure: Array.from({ length: doc.structure.length }, (_, i) => doc.structure.at(i)),
    }
    expect(joinParts(jsonParts(doc, { space: 2 }))).toBe(JSON.stringify(materialized, null, 2))
  })
})

describe('parseBundler', () => {
  // A camera turned 0.3 rad about y, a point in front of it: Bundler projects
  // p = −(R X + t)/z, image (x, y) = f·p with y up about the centre.
  const a = 0.3
  const Rb = [
    [Math.cos(a), 0, Math.sin(a)],
    [0, 1, 0],
    [-Math.sin(a), 0, Math.cos(a)],
  ]
  const tb = [0.2, -0.1, 0.5]
  const X = [0.4, 0.7, -5]
  const f = 800
  const P = Rb.map((r, i) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + tb[i])
  const xb = (-f * P[0]) / P[2],
    yb = (-f * P[1]) / P[2]
  const text = [
    '# Bundle file v0.3',
    '2 1',
    `${f} 0 0`,
    ...Rb.map((r) => r.join(' ')),
    tb.join(' '),
    '0 0 0',
    '0 0 0',
    '0 0 0',
    '0 0 0',
    '0 0 0',
    X.join(' '),
    '200 100 50',
    `1 0 12 ${xb} ${yb}`,
  ].join('\n')

  it('turns the Bundler camera into an OpenCV pose that sees the point where Bundler did', () => {
    const m = parseSfmText(text, 'bundle.out', { listText: 'images/a.jpg 0 800\nimages/b.jpg\n' })
    expect(m.format).toBe('Bundler bundle.out')
    // The second camera is all zeros: Bundler did not place it.
    expect(m.images.map((im) => im.name)).toEqual(['images/a.jpg'])
    expect(m.warnings.join(' ')).toMatch(/did not place/)
    const { R, t, K } = m.images[0]
    const c = R.map((r, i) => r[0] * X[0] + r[1] * X[1] + r[2] * X[2] + t[i])
    expect(c[2]).toBeGreaterThan(0) // in front, looking down +z
    const w = 1000,
      h = 600
    const view = m.points[0].views[0]
    expect(m.viewsCentered).toBe(true)
    expect((K.fx * c[0]) / c[2] + w / 2).toBeCloseTo(view.x + w / 2, 6)
    expect((K.fy * c[1]) / c[2] + h / 2).toBeCloseTo(view.y + h / 2, 6)
    expect(m.points[0].color).toEqual([200, 100, 50])
  })

  it('says when list.txt is missing', () => {
    expect(parseBundler(text).warnings.join(' ')).toMatch(/No list\.txt/)
  })
})
