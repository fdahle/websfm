import { describe, it, expect } from 'vitest'
import { regionHandles, pickHandle, axisParam, planeHit, dragRegion, createRegionDrag } from './regionGizmo.js'

const box = { min: [0, 0, 0], max: [4, 2, 6] }
const handle = (id) => regionHandles(box).find((h) => h.id === id)
// A ray from `origin` through `target`.
const ray = (origin, target) => {
  const d = target.map((v, k) => v - origin[k]),
    l = Math.hypot(...d)
  return { origin, dir: d.map((v) => v / l) }
}

describe('region gizmo', () => {
  it('puts a handle on each face centre and one at the box centre', () => {
    const hs = regionHandles(box)
    expect(hs.map((h) => h.id)).toEqual(['x-', 'x+', 'y-', 'y+', 'z-', 'z+', 'move'])
    expect(handle('x+').pos).toEqual([4, 1, 3])
    expect(handle('z-').pos).toEqual([2, 1, 0])
    expect(handle('move').pos).toEqual([2, 1, 3])
  })

  it('picks the nearest projected handle within tolerance, a face before the centre', () => {
    const hs = regionHandles(box)
    const top = (p) => [p[0] * 10, p[1] * 10] // looking down z: z± sit on the centre
    expect(pickHandle(hs, top, 41, 11, 5).id).toBe('x+')
    expect(pickHandle(hs, top, 20, 10, 5).id).toMatch(/^z[-+]$/)
    expect(pickHandle(hs, top, 30, 30, 5)).toBeNull()
    expect(pickHandle(hs, () => null, 20, 10, 5)).toBeNull()
  })

  it('finds the point of an axis nearest a ray, and refuses a ray along the axis', () => {
    // Ray along -z through x = 7, y = 1: the x axis line through (4,1,3) is met at t = 3.
    expect(axisParam(ray([7, 1, 20], [7, 1, 0]), [4, 1, 3], 0)).toBeCloseTo(3, 12)
    // Oblique ray: closest approach still at x = 7.
    expect(axisParam(ray([7, -10, 13], [7, 1, 3]), [4, 1, 3], 0)).toBeCloseTo(3, 12)
    expect(axisParam(ray([0, 1, 3], [10, 1, 3]), [4, 1, 3], 0)).toBeNull()
  })

  it('intersects a ray with a plane, not behind the origin', () => {
    expect(planeHit(ray([1, 2, 10], [1, 2, 0]), [0, 0, 3], [0, 0, 1])).toEqual([1, 2, 3])
    expect(planeHit({ origin: [0, 0, 10], dir: [0, 0, 1] }, [0, 0, 3], [0, 0, 1])).toBeNull()
    expect(planeHit({ origin: [0, 0, 10], dir: [1, 0, 0] }, [0, 0, 3], [0, 0, 1])).toBeNull()
  })

  it('moves one face, never past the other, or the whole box', () => {
    expect(dragRegion(box, handle('x+'), 1.5)).toEqual({ min: [0, 0, 0], max: [5.5, 2, 6] })
    expect(dragRegion(box, handle('y-'), -2)).toEqual({ min: [0, -2, 0], max: [4, 2, 6] })
    const squashed = dragRegion(box, handle('z+'), -100)
    expect(squashed.max[2]).toBeGreaterThan(squashed.min[2])
    expect(squashed.max[2] - squashed.min[2]).toBeLessThan(1e-4)
    expect(dragRegion(box, handle('move'), [1, -1, 2])).toEqual({ min: [1, -1, 2], max: [5, 1, 8] })
    expect(box).toEqual({ min: [0, 0, 0], max: [4, 2, 6] }) // not mutated
  })

  it('a face follows the pointer from where the drag started, without jumping', () => {
    const eye = [2, -20, 3]
    const drag = createRegionDrag(box, handle('x+'), [0, 1, 0])
    // Grab the handle slightly off its centre (x = 4.1): no change until the pointer moves.
    drag.begin(ray(eye, [4.1, 1, 3]))
    expect(drag.move(ray(eye, [4.1, 1, 3])).max[0]).toBeCloseTo(4, 9)
    expect(drag.move(ray(eye, [6.1, 1, 3])).max[0]).toBeCloseTo(6, 9)
    const along = createRegionDrag(box, handle('y+'), [0, 1, 0])
    along.begin(ray(eye, [2, 2, 3]))
    expect(along.move(ray(eye, [2, 2, 3]))).toBeNull() // looking straight down y
  })

  it('the centre handle moves the box in the plane facing the camera', () => {
    const eye = [2, 1, 30]
    const drag = createRegionDrag(box, handle('move'), [0, 0, -1])
    drag.begin(ray(eye, [2, 1, 3]))
    const moved = drag.move(ray(eye, [5, -1, 3]))
    expect(moved.min.map((v) => +v.toFixed(9))).toEqual([3, -2, 0])
    expect(moved.max.map((v) => +v.toFixed(9))).toEqual([7, 0, 6])
  })
})
