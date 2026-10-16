import * as THREE from 'three'
import { buildCloudStyle, resolveCloudStyle } from '../../core/products/cloudStyle.js'
import { pickNearestPoint } from '../../core/products/screenPick.js'
import { screenSelectMask } from '../../core/products/screenSelect.js'
import { keyString } from '../../core/lod/octree.js'
import { LOD_MIN_POINTS } from '../../core/lod/build.js'

// A point cloud drawn through its level-of-detail octree (dev/planning/plan-lod.md ▸
// L3): on every frame the hierarchy is walked from the root, largest-on-screen node
// first, taking nodes inside the view until the point budget is spent. A node not yet
// loaded is fetched (a few at a time); its children wait for it, so the view sharpens
// coarse to fine. Loaded nodes stay on the GPU, hidden when the view leaves them,
// until the cache needs room (least recently used first).
//
// Every node is its own THREE.Points under one group placed at the octree's offset;
// node positions are Float32 relative to it. Colours come from the cloud's style
// with whole-cloud context (ranges and class counts from the build), so nodes match.

export const LOD_VIEW_MIN = LOD_MIN_POINTS // a resident cloud this big is drawn through its octree
const MIN_NODE_PIXELS = 150             // nodes smaller on screen are not refined
const CONCURRENT_LOADS = 4
const CACHE_FACTOR = 2                  // loaded points kept: this × the budget

// Max-heap of { node, weight }.
function heap() {
  const a = []
  return {
    get size() { return a.length },
    push(node, weight) {
      a.push({ node, weight })
      let i = a.length - 1
      while (i > 0) {
        const p = (i - 1) >> 1
        if (a[p].weight >= a[i].weight) break
        ;[a[p], a[i]] = [a[i], a[p]]; i = p
      }
    },
    pop() {
      const top = a[0], last = a.pop()
      if (a.length) {
        a[0] = last
        let i = 0
        for (;;) {
          const l = 2 * i + 1, r = l + 1
          let m = i
          if (l < a.length && a[l].weight > a[m].weight) m = l
          if (r < a.length && a[r].weight > a[m].weight) m = r
          if (m === i) break
          ;[a[m], a[i]] = [a[i], a[m]]; i = m
        }
      }
      return top
    },
  }
}

/**
 * cloud: a cloud with `lod` metadata. open(cloud) → Promise<reader | null>
 * (core/lod/reader.js); material: the layer's PointsMaterial; onChange(): something
 * loaded (redraw, which walks again).
 */
export function createLodLayer(cloud, { open, material, onChange }) {
  const lod = cloud.lod
  const offset = lod.layout.offset
  const group = new THREE.Group()
  group.position.set(...offset)
  group.userData.cloudId = cloud.id
  const cache = new Map()   // key → { key, node, pts, object, lastUsed }
  const loading = new Set()
  const failed = new Set()
  let reader = null, disposed = false, frame = 0, queue = []
  let style = null          // { input, opts } of the last restyle
  const frustum = new THREE.Frustum(), viewProj = new THREE.Matrix4(), box = new THREE.Box3(), centre = new THREE.Vector3()
  const layer = {
    lod: true, object: group, baseMaterial: material, source: cloud, count: cloud.count,
    visiblePoints: 0, loadedPoints: 0, rootPoints: null, ready: false,
  }

  open(cloud).then((r) => {
    if (disposed) return
    reader = r
    layer.ready = !!r
    onChange()
  })

  function cubeBox(node) {
    const c = reader.cube(node)
    box.min.set(c.min[0], c.min[1], c.min[2])
    box.max.set(c.min[0] + c.size, c.min[1] + c.size, c.min[2] + c.size)
    return c
  }
  // Size on screen (px) of the node's bounding sphere.
  function weight(node, camera, height) {
    const c = cubeBox(node)
    const r = c.size * 0.866
    box.getCenter(centre)
    if (camera.isOrthographicCamera) return r * camera.zoom * height / (camera.top - camera.bottom)
    const d = camera.position.distanceTo(centre)
    if (d <= r) return Infinity
    return r / (d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * height / 2
  }

  function colourise(e) {
    if (!e.object || !style) return
    const { pts } = e
    const visual = buildCloudStyle({ kind: 'dense', count: pts.count, pos: pts.pos, col: pts.col, attributes: pts.attributes, style: style.input },
      style.input, style.opts)
    const g = e.object.geometry
    if (visual.colors) g.setAttribute('color', new THREE.BufferAttribute(visual.colors, 3, true))
    else g.deleteAttribute('color')
    g.setIndex(visual.indices ? new THREE.BufferAttribute(visual.indices, 1) : null)
  }

  async function load({ node, key }) {
    loading.add(key)
    try {
      const pts = await reader.read(node)
      if (disposed) return
      const e = { key, node, pts, object: null, lastUsed: frame }
      if (pts.count) {
        const g = new THREE.BufferGeometry()
        g.setAttribute('position', new THREE.BufferAttribute(pts.pos, 3))
        g.computeBoundingSphere()
        e.object = new THREE.Points(g, material)
        e.object.visible = false
        e.object.userData.level = node.key[0]
        colourise(e)
        group.add(e.object)
      }
      cache.set(key, e)
      layer.loadedPoints += pts.count
      if (node.key[0] === 0) layer.rootPoints = pts
    } catch {
      failed.add(key) // a missing or short file: never asked for again this session
    } finally {
      loading.delete(key)
      if (!disposed) onChange()
    }
  }

  function pump() {
    while (loading.size < CONCURRENT_LOADS && queue.length) {
      const job = queue.shift()
      if (!loading.has(job.key) && !cache.has(job.key)) load(job)
    }
  }

  function evict(wanted, budget) {
    if (layer.loadedPoints <= CACHE_FACTOR * budget) return
    const idle = [...cache.values()].filter((e) => !wanted.has(e.key) && e.node.key[0] > 0).sort((a, b) => a.lastUsed - b.lastUsed)
    for (const e of idle) {
      if (layer.loadedPoints <= CACHE_FACTOR * budget) break
      if (e.object) { group.remove(e.object); e.object.geometry.dispose() }
      cache.delete(e.key)
      layer.loadedPoints -= e.pts.count
    }
  }

  // Walk the hierarchy for this camera; show what fits the budget, queue what is missing.
  layer.update = (camera, height, budget) => {
    if (!reader?.root || disposed) return
    frame++
    camera.updateMatrixWorld()
    frustum.setFromProjectionMatrix(viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse))
    const h = heap()
    h.push(reader.root, Infinity)
    const wanted = new Set(), missing = []
    let points = 0
    while (h.size) {
      const { node, weight: w } = h.pop()
      cubeBox(node)
      if (!frustum.intersectsBox(box)) continue
      if (points > 0 && points + node.count > budget) break
      const key = keyString(node.key)
      if (failed.has(key)) continue
      const e = cache.get(key)
      if (!e) { missing.push({ node, key, weight: w }); continue }
      points += node.count
      wanted.add(key)
      e.lastUsed = frame
      for (const child of reader.children(node)) {
        const cw = weight(child, camera, height)
        if (cw >= MIN_NODE_PIXELS) h.push(child, cw)
      }
    }
    for (const e of cache.values()) if (e.object) e.object.visible = wanted.has(e.key)
    layer.visiblePoints = points
    queue = missing.filter((j) => !loading.has(j.key))
    pump()
    evict(wanted, budget)
  }

  // The cloud's style, applied to every loaded node and to those that load later.
  layer.restyle = (c, elevationRange) => {
    cloud = c
    layer.source = c
    const input = c.style || {} // a restored cloud's style may be null
    const proxy = {
      kind: 'dense', count: 0, style: input, col: lod.layout.colour ? new Uint8Array(0) : null,
      attributes: Object.fromEntries(lod.layout.attributes.map((a) => [a.name, new Float32Array(0)])),
    }
    const resolved = resolveCloudStyle(proxy)
    const axis = { x: 0, y: 1, elevation: 2 }[resolved.field]
    const range = axis != null ? { min: lod.bounds.min[axis], max: lod.bounds.max[axis] }
      : resolved.field.startsWith('attribute:') ? lod.stats?.ranges?.[resolved.field.slice(10)] ?? null : null
    const opts = { elevationRange, origin: offset, range, classCounts: lod.stats?.classes ?? null }
    const visual = buildCloudStyle(proxy, input, opts)
    style = { input, opts }
    for (const e of cache.values()) colourise(e)
    material.vertexColors = visual.style.field !== 'single'
    material.color.set(visual.style.field !== 'single' ? 0xffffff : visual.style.colour)
    material.opacity = visual.style.opacity
    material.transparent = visual.style.opacity < 1
    material.depthWrite = visual.style.opacity === 1
    material.needsUpdate = true
    return visual.legend
  }

  // Bounds for framing: from the root node (a grid subsample: uniform over space)
  // once it is in, until then from the octree's bounds. robust(positions, count, up)
  // is the viewer's own estimator; along-up extents are relative to the centre.
  layer.boundsFor = (up, robust) => {
    if (layer.rootPoints?.count > 100) {
      const b = robust(layer.rootPoints.pos, layer.rootPoints.count, up)
      b.center.add(group.position)
      return b
    }
    const min = new THREE.Vector3(...lod.bounds.min), max = new THREE.Vector3(...lod.bounds.max)
    const center = min.clone().add(max).multiplyScalar(0.5)
    let alongMin = Infinity, alongMax = -Infinity
    for (let k = 0; k < 8; k++) {
      const corner = new THREE.Vector3(k & 1 ? max.x : min.x, k & 2 ? max.y : min.y, k & 4 ? max.z : min.z).sub(center)
      const a = corner.dot(up)
      alongMin = Math.min(alongMin, a); alongMax = Math.max(alongMax, a)
    }
    return { center, radius: max.distanceTo(min) / 2 || 1, alongMin, alongMax }
  }

  // The drawn point nearest the camera within the tolerance. → { pos: [x,y,z], depth } | null
  layer.pick = ({ viewProj: vp, x, y, tolX, tolY }) => {
    group.updateMatrixWorld()
    let best = null
    for (const e of cache.values()) {
      if (!e.object?.visible) continue
      const matrix = vp.clone().multiply(group.matrixWorld).elements
      const hit = pickNearestPoint(e.pts.pos, e.pts.count, { matrix, x, y, tolX, tolY, indices: e.object.geometry.index?.array ?? null })
      if (hit && (!best || hit.depth < best.depth)) {
        const i = hit.index
        best = { depth: hit.depth, pos: [e.pts.pos[3 * i] + offset[0], e.pts.pos[3 * i + 1] + offset[1], e.pts.pos[3 * i + 2] + offset[2]] }
      }
    }
    return best
  }

  // A recorded selection (core/lod/transform.js replaySelection) on the points drawn
  // now: the highlight and the count while selecting. The edit itself replays the
  // shapes on every point of the octree. → { selected, pos: Float32Array (offset-relative) }
  layer.selectDrawn = (ops) => {
    const parts = []
    let selected = 0
    for (const e of cache.values()) {
      if (!e.object?.visible) continue
      const indices = e.object.geometry.index?.array ?? null
      let mask = new Uint8Array(e.pts.count)
      for (const o of ops) mask = screenSelectMask(e.pts.pos, e.pts.count, { matrix: o.matrix, shape: o.shape, indices, base: mask, op: o.op }).mask
      let n = 0
      for (let i = 0; i < mask.length; i++) n += mask[i]
      if (!n) continue
      const pos = new Float32Array(3 * n)
      for (let i = 0, k = 0; i < mask.length; i++) if (mask[i]) { pos[k++] = e.pts.pos[3 * i]; pos[k++] = e.pts.pos[3 * i + 1]; pos[k++] = e.pts.pos[3 * i + 2] }
      parts.push(pos); selected += n
    }
    const pos = new Float32Array(3 * selected)
    let o = 0
    for (const p of parts) { pos.set(p, o); o += p.length }
    return { selected, pos }
  }

  layer.dispose = () => {
    disposed = true
    for (const e of cache.values()) e.object?.geometry.dispose()
    cache.clear()
    group.clear()
    material.dispose()
  }

  return layer
}
