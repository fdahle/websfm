import { describe, it, expect } from 'vitest'
import { vectorSetToKml } from './kml.js'

describe('vectorSetToKml', () => {
  const toLonLat = ([x, y]) => [x / 10, y / 10]

  it('writes closed polygons named by image, holes as inner boundaries', () => {
    const kml = vectorSetToKml(
      {
        name: 'Footprints & more',
        footprints: [
          {
            imageName: 'IMG<1>.jpg',
            rings: [
              [
                [0, 0],
                [20, 0],
                [20, 20],
              ],
              [
                [5, 5],
                [6, 5],
                [6, 6],
                [5, 5],
              ],
            ],
          },
        ],
      },
      { toLonLat },
    )
    expect(kml).toContain('<name>Footprints &amp; more</name>')
    expect(kml).toContain('<name>IMG&lt;1&gt;.jpg</name>')
    expect(kml).toContain(
      '<outerBoundaryIs><LinearRing><coordinates>0,0 2,0 2,2 0,0</coordinates></LinearRing></outerBoundaryIs>',
    )
    expect(kml).toContain('<innerBoundaryIs><LinearRing><coordinates>0.5,0.5 0.6,0.5 0.6,0.6 0.5,0.5')
  })

  it('writes contour lines with their elevation as the name', () => {
    const kml = vectorSetToKml(
      {
        name: 'Contours',
        footprints: [
          {
            level: 25,
            lines: [
              [
                [0, 0],
                [10, 0],
              ],
            ],
          },
        ],
      },
      { toLonLat },
    )
    expect(kml).toContain(
      '<Placemark><name>25</name><LineString><coordinates>0,0 1,0</coordinates></LineString></Placemark>',
    )
  })
})
