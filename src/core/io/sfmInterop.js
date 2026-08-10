// Small, pure readers for browser-friendly SfM interchange formats. They all
// normalize to the same world-to-camera/OpenCV boundary consumed by the store.

const transpose3 = (m) => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]]
const mul3v = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])

function quatToRotation([w, x, y, z]) {
  const n = Math.hypot(w, x, y, z) || 1; w /= n; x /= n; y /= n; z /= n
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}

function angleAxisToRotation(v) {
  const a = Math.hypot(...v)
  if (!a) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  const [x, y, z] = v.map((n) => n / a), c = Math.cos(a), s = Math.sin(a), t = 1 - c
  return [[t*x*x+c,t*x*y-s*z,t*x*z+s*y],[t*x*y+s*z,t*y*y+c,t*y*z-s*x],[t*x*z-s*y,t*y*z+s*x,t*z*z+c]]
}

export function parseTransformsJson(data) {
  const root = typeof data === 'string' ? JSON.parse(data) : data
  if (!Array.isArray(root?.frames)) throw new Error('Not a transforms.json file (frames missing)')
  const images = root.frames.map((frame, i) => {
    const m = frame.transform_matrix
    if (!Array.isArray(m) || m.length !== 4) throw new Error(`transforms frame ${i}: invalid transform_matrix`)
    // c2w_gl → c2w_cv by flipping camera Y/Z columns, then invert.
    const c2w = [[m[0][0],-m[0][1],-m[0][2]],[m[1][0],-m[1][1],-m[1][2]],[m[2][0],-m[2][1],-m[2][2]]]
    const R = transpose3(c2w), C = [m[0][3], m[1][3], m[2][3]]
    const t = mul3v(R, C).map((x) => -x)
    const v = { ...root, ...frame }
    return { externalId: i + 1, imageId: i + 1, name: frame.file_path, width: v.w, height: v.h, K: { fx: v.fl_x, fy: v.fl_y ?? v.fl_x, cx: v.cx, cy: v.cy }, R, t }
  })
  return { format: 'transforms.json', images, points: [], warnings: ['This format contains cameras but no sparse point tracks'] }
}

export function parseNvm(text) {
  const lines = String(text).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (!/^NVM_V3/i.test(lines[0] ?? '')) throw new Error('Not an NVM_V3 file')
  let p = 1
  const n = Number(lines[p++]), images = []
  for (let i = 0; i < n; i++) {
    const a = lines[p++].split(/\s+/), focal = Number(a[1]), R = quatToRotation(a.slice(2, 6).map(Number)), C = a.slice(6, 9).map(Number)
    images.push({ externalId: i, imageId: i, name: a[0], K: { fx: focal, fy: focal, cx: null, cy: null }, R, t: mul3v(R, C).map((x) => -x) })
  }
  const pointCount = Number(lines[p++] ?? 0), points = []
  for (let i = 0; i < pointCount; i++) {
    const a = lines[p++].split(/\s+/), views = [], count = Number(a[6])
    for (let k = 0; k < count; k++) {
      const o = 7 + k * 4, imageId = Number(a[o]), im = images[imageId]
      if (im) views.push({ imageId, name: im.name, x: Number(a[o + 2]), y: Number(a[o + 3]) })
    }
    points.push({ xyz: a.slice(0, 3).map(Number), color: a.slice(3, 6).map(Number), error: -1, views })
  }
  return { format: 'VisualSFM NVM v3', images, points, warnings: ['NVM principal points are inferred from the loaded image dimensions'] }
}

export function parseOpenMvg(data) {
  const root = typeof data === 'string' ? JSON.parse(data) : data
  if (!Array.isArray(root?.views) || !Array.isArray(root?.extrinsics)) throw new Error('Not OpenMVG sfm_data.json')
  const intrinsics = new Map((root.intrinsics ?? []).map((x) => [x.key, x.value?.ptr_wrapper?.data ?? x.value?.data ?? x.value]))
  const poses = new Map(root.extrinsics.map((x) => [x.key, x.value]))
  const images = root.views.map((x) => {
    const v = x.value?.ptr_wrapper?.data ?? x.value?.data ?? x.value, pose = poses.get(v.id_pose), intr = intrinsics.get(v.id_intrinsic) ?? {}
    if (!pose) return null
    const R = pose.rotation, C = pose.center
    const pp = intr.principal_point ?? [v.width / 2, v.height / 2], f = intr.focal_length
    return { externalId: v.id_view, imageId: v.id_view, name: [v.local_path, v.filename].filter(Boolean).join('/'), width: v.width, height: v.height, K: { fx: f, fy: f, cx: pp[0], cy: pp[1] }, R, t: mul3v(R, C).map((n) => -n) }
  }).filter(Boolean)
  const byId = new Map(images.map((im) => [im.imageId, im]))
  const points = (root.structure ?? []).map((x) => ({
    xyz: x.value.X, color: x.value.color ?? [180, 180, 180], error: -1,
    views: (x.value.observations ?? []).map((o) => ({ imageId: o.key, name: byId.get(o.key)?.name, x: o.value.x[0], y: o.value.x[1] })).filter((v) => v.name),
  }))
  return { format: 'OpenMVG sfm_data.json', images, points, warnings: [] }
}

export function parseOpenSfm(data) {
  const raw = typeof data === 'string' ? JSON.parse(data) : data
  const root = Array.isArray(raw) ? raw[0] : raw
  if (!root?.shots || !root?.cameras) throw new Error('Not OpenSfM reconstruction.json')
  const images = Object.entries(root.shots).map(([name, shot], i) => {
    const c = root.cameras[shot.camera] ?? {}, R = angleAxisToRotation(shot.rotation ?? [0, 0, 0]), scale = Math.max(c.width ?? 0, c.height ?? 0)
    const f = (c.focal_x ?? c.focal ?? 0) * scale
    return { externalId: name, imageId: name, name, width: c.width, height: c.height, K: { fx: f, fy: (c.focal_y ?? c.focal ?? 0) * scale, cx: (c.c_x ?? 0) * scale + c.width / 2, cy: (c.c_y ?? 0) * scale + c.height / 2 }, R, t: shot.translation }
  })
  const points = Object.values(root.points ?? {}).map((x) => ({ xyz: x.coordinates, color: x.color ?? [180, 180, 180], error: x.reprojection_error ?? -1, views: [] }))
  return { format: 'OpenSfM reconstruction.json', images, points, warnings: ['OpenSfM reconstruction.json does not preserve point observations; tracks are unavailable'] }
}

export function parseSfmText(text, fileName = '') {
  if (/\.nvm$/i.test(fileName) || /^\s*NVM_V3/i.test(text)) return parseNvm(text)
  const data = JSON.parse(text)
  if (Array.isArray(data?.frames)) return parseTransformsJson(data)
  if (Array.isArray(data?.views) && Array.isArray(data?.extrinsics)) return parseOpenMvg(data)
  if ((Array.isArray(data) ? data[0] : data)?.shots) return parseOpenSfm(data)
  throw new Error('JSON is not a supported SfM project (transforms, OpenMVG, or OpenSfM)')
}

function cameraCenter(R, t) {
  return [
    -(R[0][0]*t[0]+R[1][0]*t[1]+R[2][0]*t[2]),
    -(R[0][1]*t[0]+R[1][1]*t[1]+R[2][1]*t[2]),
    -(R[0][2]*t[0]+R[1][2]*t[1]+R[2][2]*t[2]),
  ]
}

export function buildNvm(model) {
  const lines = ['NVM_V3', '', String(model.images.length)]
  for (const im of model.images) {
    const c = cameraCenter(im.R, im.t)
    lines.push(`${im.name} ${im.K.fx} ${im.q.join(' ')} ${c.join(' ')} 0 0`)
  }
  lines.push('', String(model.points3D.length))
  for (const p of model.points3D) {
    const obs = p.track.map(([imageId, point2dIdx]) => {
      const im = model.images[imageId - 1], px = im?.points2D?.[point2dIdx]
      return im && px ? `${imageId - 1} ${point2dIdx} ${px[0] - im.K.cx} ${px[1] - im.K.cy}` : null
    }).filter(Boolean)
    lines.push(`${p.xyz.join(' ')} ${p.rgb.join(' ')} ${obs.length}${obs.length ? ` ${obs.join(' ')}` : ''}`)
  }
  lines.push('', '0', '')
  return lines.join('\n')
}

export function buildOpenMvg(model) {
  return {
    sfm_data_version: '0.3', root_path: '',
    views: model.images.map((im) => ({ key: im.imageId, value: { ptr_wrapper: { id: im.imageId, data: { local_path: '', filename: im.name, width: im.width, height: im.height, id_view: im.imageId, id_intrinsic: im.cameraId, id_pose: im.imageId } } } })),
    intrinsics: model.images.map((im) => ({ key: im.cameraId, value: { ptr_wrapper: { id: im.cameraId, data: { width: im.width, height: im.height, focal_length: im.K.fx, principal_point: [im.K.cx, im.K.cy], disto_k3: [0, 0, 0] } } } })),
    extrinsics: model.images.map((im) => ({ key: im.imageId, value: { rotation: im.R, center: cameraCenter(im.R, im.t) } })),
    structure: model.points3D.map((p) => ({ key: p.point3dId, value: { X: p.xyz, color: p.rgb, observations: p.track.map(([imageId, point2dIdx]) => ({ key: imageId, value: { id_feat: point2dIdx, x: model.images[imageId - 1].points2D[point2dIdx].slice(0, 2) } })) } })),
    control_points: [],
  }
}
