export interface Point { x: number; y: number; z: number }
export interface PointCollection extends Iterable<Point> { length: number }
export interface PackedPoints { pos: Float32Array | Float64Array; count?: number }

// Reiterable view over packed XYZ. One scratch record per iterator; consumers
// must read it during iteration rather than retain it. No per-point object graph.
export function pointView(points: PackedPoints | PointCollection): PointCollection {
  if (!('pos' in points)) return points
  const { pos } = points
  const count = points.count ?? pos.length / 3
  return {
    length: count,
    *[Symbol.iterator]() {
      const p = { x: 0, y: 0, z: 0 }
      for (let i = 0; i < count; i++) {
        p.x = pos[i * 3]; p.y = pos[i * 3 + 1]; p.z = pos[i * 3 + 2]
        yield p
      }
    },
  }
}

export function relativePositions(pos: ArrayLike<number>): { origin: [number, number, number]; relative: Float32Array } {
  const origin: [number, number, number] = pos.length ? [pos[0], pos[1], pos[2]] : [0, 0, 0]
  const relative = new Float32Array(pos.length)
  for (let i = 0; i < pos.length; i++) relative[i] = pos[i] - origin[i % 3]
  return { origin, relative }
}
