// nerfstudio / instant-ngp / 3D Gaussian Splatting `transforms.json` export.
// Pure — plain data in, a plain JS object out (the caller JSON-stringifies and
// downloads). websfm is pinhole post-ingest, so distortion coeffs are 0.
//
// Coordinate convention (the #1 interop bug — see PLAN invariant 5):
//   websfm cameras are OpenCV world-to-camera R,t (row-major R, t=[x,y,z],
//   C = −Rᵀt, camera looks down +z, image +y is down).
//   transforms.json wants camera-to-world in **OpenGL/Blender** convention
//   (camera looks down −z, image +y is up). So:
//     c2w_cv = [ Rᵀ | C ; 0 0 0 1 ]          (invert the world-to-cam extrinsic)
//     c2w_gl = c2w_cv · diag(1, −1, −1, 1)    (flip the camera Y and Z axes)
//   which is exactly "negate columns 1 and 2 of the rotation part of c2w_cv".

// Camera centre C = −Rᵀ·t (row-major R, t=[x,y,z]).
function cameraCenter(R, t) {
  return [
    -(R[0][0] * t[0] + R[1][0] * t[1] + R[2][0] * t[2]),
    -(R[0][1] * t[0] + R[1][1] * t[1] + R[2][1] * t[2]),
    -(R[0][2] * t[0] + R[1][2] * t[1] + R[2][2] * t[2]),
  ]
}

// OpenCV world-to-cam (R,t) → OpenGL camera-to-world 4×4 (row-major, nested array).
export function cameraToWorldGl(R, t) {
  const C = cameraCenter(R, t)
  // c2w_cv rotation = Rᵀ; column j of Rᵀ is row j of R. Negate columns 1 and 2.
  return [
    [R[0][0], -R[1][0], -R[2][0], C[0]],
    [R[0][1], -R[1][1], -R[2][1], C[1]],
    [R[0][2], -R[1][2], -R[2][2], C[2]],
    [0, 0, 0, 1],
  ]
}

// Build the transforms.json object.
//   images: [{ name, R, t, K:{fx,fy,cx,cy}, width, height }]  (world-to-cam)
// When every camera shares one intrinsic set the top-level fl_x/… are written and
// frames carry only file_path + transform_matrix; otherwise the intrinsics are
// written per-frame (both are valid nerfstudio input).
export function buildTransformsJson({ images }) {
  if (!images.length) return { camera_model: 'OPENCV', frames: [] }
  const first = images[0]
  const same = images.every((im) =>
    im.K.fx === first.K.fx && im.K.fy === first.K.fy && im.K.cx === first.K.cx
    && im.K.cy === first.K.cy && im.width === first.width && im.height === first.height)

  const intrinsics = (im) => ({
    fl_x: im.K.fx, fl_y: im.K.fy, cx: im.K.cx, cy: im.K.cy,
    w: im.width, h: im.height,
    k1: 0, k2: 0, p1: 0, p2: 0, // pinhole post-ingest
  })

  const out = { camera_model: 'OPENCV' }
  if (same) Object.assign(out, intrinsics(first))
  out.frames = images.map((im) => ({
    file_path: im.name,
    transform_matrix: cameraToWorldGl(im.R, im.t),
    ...(same ? {} : intrinsics(im)),
  }))
  return out
}
