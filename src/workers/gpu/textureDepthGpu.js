// WebGPU depth pass for the mesh texture (plan-texture T2): the mesh's z-buffer per
// view, the one stage of texturing whose cost is views × faces. The first render
// pipeline here; the other kernels are compute-only. Worker-only (navigator.gpu).
//
// Same contract as core/products/texture/visibility.js `rasterizeDepth`: the nearest
// camera depth at each grid pixel centre, Infinity where nothing lies. Fragments carry
// the camera-space z as a varying (perspective-correct, so exact at the centre); the
// depth attachment only orders them. A second draw of the vertices as points stands in
// for the CPU pass's centroid splat: a triangle smaller than a pixel covers no pixel
// centre, and on a mesh finer than the grid the vertices keep the z-buffer closed.
// The worker A/B-checks this against the CPU pass on the first view of every run.

import { ensureDevice } from './device.js'

const SHADER = /* wgsl */ `
struct View {
  r0: vec4f, r1: vec4f, r2: vec4f,   // rows of R (xyz) and t (w), mesh-local frame
  k: vec4f,                          // ax, bx + 0.5, ay, by + 0.5 (grid pixels)
  size: vec4f,                       // W, H, near, 0
}
@group(0) @binding(0) var<uniform> view: View;

struct Out { @builtin(position) pos: vec4f, @location(0) z: f32 }

@vertex fn vs(@location(0) p: vec3f) -> Out {
  let xc = dot(view.r0.xyz, p) + view.r0.w;
  let yc = dot(view.r1.xyz, p) + view.r1.w;
  let z  = dot(view.r2.xyz, p) + view.r2.w;
  // Grid pixel g = a·x/z + b (centres at integers) → NDC, written premultiplied by w = z.
  let gx = view.k.x * xc + view.k.y * z;
  let gy = view.k.z * yc + view.k.w * z;
  var o: Out;
  // Reverse-Z: NDC depth = near / z, nearest = largest. Float32 keeps its relative
  // precision near 0, so far surfaces stay ordered; 1 − near/z rounded to 1.0 there.
  o.pos = vec4f(2.0 * gx / view.size.x - z, z - 2.0 * gy / view.size.y, view.size.z, z);
  o.z = z;
  return o;
}

@fragment fn fs(i: Out) -> @location(0) vec4f { return vec4f(i.z, 0.0, 0.0, 0.0); }
`

const FAR = 3.0e38
const cache = new WeakMap() // device → pipelines

function pipelinesFor(device) {
  let p = cache.get(device)
  if (p) return p
  const module = device.createShaderModule({ code: SHADER })
  const make = (topology) =>
    device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
      primitive: { topology, cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
    })
  p = { tris: make('triangle-list'), points: make('point-list') }
  cache.set(device, p)
  return p
}

// One mesh, many views. `P` is the mesh in its local frame (Float64, visibility.js
// meshGeometry), `idx` the triangles. → { render(cam, grid) → Float32Array, destroy() },
// or null when WebGPU is unavailable or the mesh exceeds the device's buffer limits.
export async function createTextureDepthGpu(P, idx) {
  const gpu = await ensureDevice()
  if (!gpu) return null
  const { device } = gpu
  const pos = Float32Array.from(P)
  if (pos.byteLength > device.limits.maxBufferSize || idx.byteLength > device.limits.maxBufferSize) return null
  const vbuf = device.createBuffer({ size: pos.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(vbuf, 0, pos)
  const ibuf = device.createBuffer({
    size: Math.ceil(idx.byteLength / 4) * 4,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(ibuf, 0, idx)
  const ubuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  const pipes = pipelinesFor(device)
  const bindTris = device.createBindGroup({
    layout: pipes.tris.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  })
  const bindPts = device.createBindGroup({
    layout: pipes.points.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: ubuf } }],
  })
  const nVerts = pos.length / 3
  let targets = null // reused while the grid size stays the same

  function targetsFor(W, H) {
    if (targets && targets.W === W && targets.H === H) return targets
    if (targets) {
      targets.color.destroy()
      targets.depth.destroy()
      targets.read.destroy()
    }
    const bytesPerRow = Math.ceil((W * 4) / 256) * 256
    targets = {
      W,
      H,
      bytesPerRow,
      color: device.createTexture({
        size: [W, H],
        format: 'r32float',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
      }),
      depth: device.createTexture({ size: [W, H], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT }),
      read: device.createBuffer({ size: bytesPerRow * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }),
    }
    return targets
  }

  // cam: visibility.js localCamera; grid: viewGrid; near: clip distance (scene units).
  async function render(cam, grid, near) {
    const W = grid.width,
      H = grid.height
    const max = device.limits.maxTextureDimension2D
    if (W > max || H > max) return null
    const { r, t, K } = cam,
      s = grid.scale
    const u = new Float32Array(20)
    u.set([r[0], r[1], r[2], t[0], r[3], r[4], r[5], t[1], r[6], r[7], r[8], t[2]])
    u.set([K.fx * s, (K.cx - grid.x0 + 0.5) * s - 0.5 + 0.5, K.fy * s, (K.cy - grid.y0 + 0.5) * s - 0.5 + 0.5], 12)
    u.set([W, H, near, 0], 16)
    device.queue.writeBuffer(ubuf, 0, u)
    const tg = targetsFor(W, H)
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({
      colorAttachments: [
        { view: tg.color.createView(), clearValue: { r: FAR, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' },
      ],
      depthStencilAttachment: {
        view: tg.depth.createView(),
        depthClearValue: 0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    pass.setPipeline(pipes.tris)
    pass.setBindGroup(0, bindTris)
    pass.setVertexBuffer(0, vbuf)
    pass.setIndexBuffer(ibuf, 'uint32')
    pass.drawIndexed(idx.length)
    pass.setPipeline(pipes.points)
    pass.setBindGroup(0, bindPts)
    pass.draw(nVerts)
    pass.end()
    enc.copyTextureToBuffer({ texture: tg.color }, { buffer: tg.read, bytesPerRow: tg.bytesPerRow }, [W, H])
    device.queue.submit([enc.finish()])
    await tg.read.mapAsync(GPUMapMode.READ)
    const rows = new Float32Array(tg.read.getMappedRange())
    const out = new Float32Array(W * H)
    const stride = tg.bytesPerRow / 4
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = rows[y * stride + x]
        out[y * W + x] = v >= FAR * 0.5 ? Infinity : v
      }
    }
    tg.read.unmap()
    return out
  }

  function destroy() {
    vbuf.destroy()
    ibuf.destroy()
    ubuf.destroy()
    if (targets) {
      targets.color.destroy()
      targets.depth.destroy()
      targets.read.destroy()
    }
  }

  return { render, destroy, adapter: gpu.info }
}

// The A/B check (workers/gpu/README ▸ Invariants): among the grid pixels either pass
// covers, the share where both are covered with depths within `rel`. Empty-vs-empty
// pixels say nothing and are left out: counted, a GPU pass that drew nothing scored
// 99 % on a view the mesh covers 1 % of. Edges of occluders differ by a pixel between
// rasterisers, and at grazing angles the vertex points sit up to half a pixel from the
// centre they write, so the bar is a share, not all. Measured over ALL pixels on
// Dawn/Vulkan (Turing), 1 M faces: 98.8–99.99 % at 0.5 %; a broken depth mapping
// (1 − near/z, saturating to 1.0 in float32) scored 85 %.
// → { agree (share of covered pixels; 0 when none), covered (pixels), coverage (share of the grid) }
export function compareDepth(a, b, rel = 5e-3) {
  let agree = 0,
    covered = 0
  for (let i = 0; i < a.length; i++) {
    const fa = Number.isFinite(a[i]),
      fb = Number.isFinite(b[i])
    if (!fa && !fb) continue
    covered++
    if (fa && fb && Math.abs(a[i] - b[i]) <= rel * Math.max(a[i], b[i])) agree++
  }
  return { agree: covered ? agree / covered : 0, covered, coverage: a.length ? covered / a.length : 0 }
}
