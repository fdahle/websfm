import { markRaw } from 'vue'
import { isImageEnabled } from '../../core/imageEnabled.js'
import {
  POOL_SIZE,
  textureBegin,
  textureVisibility,
  textureLayout,
  textureBake,
  textureBakeAdd,
  textureFinish,
  textureAbort,
} from '../../workers/computeClient.js'
import { computeSourceOf } from '../../utils/image.js'
import { relativeQuality } from '../../core/features/imageQuality.js'
import { pluralize } from '../../core/textFormat.js'
import { rollingShutterWarps } from '../../core/sfm/rollingShutter.js'
import { exposureOf } from '../../core/products/colourGains.js'
import { pageBytes } from '../../core/bigArray.js'
import { formatBytes } from '../../core/dense/memBudget.js'

// Tools ▸ Mesh ▾ ▸ Texture (dev/planning/plan-texture.md): a NEW mesh with per-vertex
// UVs and JPEG atlas pages, textured from the registered photos. Like every mesh tool
// it leaves its source alone.
export function createMeshTexture({
  addDerivedMesh,
  clouds,
  frameModelFor,
  images,
  imagesStore,
  log,
  mainSparseCloud,
  reconStatus,
  save,
}) {
  // { sourceId, settings, name } → the new cloud, or null (refused, failed, empty).
  async function textureMesh({ sourceId, settings = {}, name } = {}, onProgress) {
    const source = clouds.value.find((c) => c.id === sourceId && c.kind === 'mesh')
    if (!source?.count) {
      log('Texture: choose a mesh to texture', 'warn', 'Products')
      return null
    }
    const cameras = mainSparseCloud.value?.cameras
    if (!cameras?.size) {
      log('Texture: needs a sparse model with registered cameras', 'error', 'Products')
      return null
    }
    const frameModel = frameModelFor.value
    // A rolling-shutter photo is read on its principal row's pose (RSH-4).
    const rsWarps = rollingShutterWarps(cameras, mainSparseCloud.value.points)
    const imagesByUuid = new Map(images.value.map((im) => [im.uuid, im]))
    const views = []
    let unready = 0
    let disabled = 0
    for (const im of images.value) {
      const cam = cameras.get(im.uuid)
      if (!cam) continue
      // Disabled (core/imageEnabled.js): no colour from it.
      if (!isImageEnabled(im)) {
        disabled++
        continue
      }
      // A TIFF's lossless compute source may still be encoding right after ingest.
      try {
        await imagesStore.whenComputeReady(im)
      } catch {
        unready++
        continue
      }
      const { dist, selfCal, fiducial } = frameModel(im)
      views.push({
        uuid: im.uuid,
        name: im.name,
        url: computeSourceOf(im),
        R: cam.R.map((row) => [...row]),
        t: [...cam.t],
        K: { fx: cam.K.fx, fy: cam.K.fy, cx: cam.K.cx, cy: cam.K.cy },
        // The photo in scan pixels; without metadata, the extent K implies.
        width: im.meta?.width || Math.round(2 * (cam.K.cx + 0.5)),
        height: im.meta?.height || Math.round(2 * (cam.K.cy + 0.5)),
        dist,
        selfCal,
        fiducial,
        rs: rsWarps.get(im.uuid) ?? null,
        exposure: exposureOf(im.meta),
        mask: settings.useMasks !== false ? (im.mask?.blob ?? null) : null,
      })
    }
    if (unready) log(`Texture: ${pluralize(unready, 'photo')} not readable yet were left out`, 'warn', 'Products')
    if (disabled) log(`Texture: ${pluralize(disabled, 'disabled photo')} left out`, 'info', 'Products')
    // Sharpness (Tools ▸ Images ▸ Image quality, when it was run): a photo blurrier than
    // the batch's median scores proportionally less, so a sharper one of similar
    // resolution wins its faces. Never below 0.3: blur is not occlusion.
    const rel = relativeQuality(views.map((v) => imagesByUuid.get(v.uuid)?.quality?.sharpness ?? null))
    let weighted = 0
    views.forEach((v, i) => {
      if (rel[i] != null && rel[i] < 1) {
        v.weight = Math.max(0.3, rel[i])
        weighted++
      }
    })
    if (weighted)
      log(
        `Texture: ${pluralize(weighted, 'blurrier photo')} weighted down by their image-quality sharpness`,
        'info',
        'Products',
      )
    if (!views.length) {
      log('Texture: no registered photo is available', 'error', 'Products')
      return null
    }
    const pos = source.pos.slice(),
      idx = source.idx.slice(),
      col = source.col?.slice() ?? null
    const transfer = [pos.buffer, idx.buffer]
    if (col) transfer.push(col.buffer)
    reconStatus.value = 'running'
    try {
      const res = await runTexture({ mesh: { pos, idx, col }, views, settings }, transfer, onProgress)
      const cloud = addDerivedMesh(
        { ...res.mesh, uv: res.mesh.uv, texture: res.texture },
        {
          name: name || `${source.name} (textured)`,
          imported: !!source.imported,
          from: [source],
        },
      )
      cloud.textureSummary = { ...res.summary, sourceId: source.id, sourceName: source.name, settings }
      // Show the result in place of its source; the source stays one toggle away.
      source.visible = false
      log(`Texture: added "${cloud.name}"`, 'success', 'Products')
      reconStatus.value = 'done'
      await save()
      return cloud
    } catch (err) {
      log(`Texture failed: ${err?.message ?? err}`, 'error', 'Products')
      reconStatus.value = 'error'
      return null
    }
  }

  // The run on the pool (workers/ops/texture.js): worker 0 holds it (begin, layout, the
  // pasting of baked blocks, finish); the visibility and the bake go out in shares of the
  // views, one per worker, as many as the memory budget gives room for. A visibility share
  // is a run of views (each costs about the same); a bake share a run of photos of about
  // equal work (texels to fill, plus a decode each), on the workers other than 0 when
  // there are three or more, so worker 0 pastes their blocks as they arrive.
  // settings.textureWorkers: the most workers to use (default: the pool).
  async function runTexture(input, transfer, onProgress) {
    const onLog = (m, l, c) => log(m, l, c ?? 'Products')
    const runId = `texture-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const { views, settings } = input
    const want = Math.max(1, Math.min(POOL_SIZE, settings.textureWorkers ?? POOL_SIZE))
    let begun = false
    try {
      const begin = await textureBegin(
        { runId, ...input, settings: { ...settings, shares: want } },
        { worker: 0, onLog, transfer },
      )
      begun = true
      const { pos, idx, shares } = begin
      const shareSettings = { ...settings, maxPages: begin.maxPages }

      // 1 · Visibility.
      const V = views.length
      const viewShares = runs(V, Math.min(shares, V)).map(([a, b]) => Array.from({ length: b - a }, (_, i) => a + i))
      const seen = new Array(viewShares.length).fill(0)
      const tickVis = () => {
        const d = seen.reduce((a, b) => a + b, 0)
        onProgress?.(d, V, 'Finding which photos see each face…', (0.55 * d) / V)
      }
      const vis = await Promise.all(
        viewShares.map((viewList, k) =>
          textureVisibility(
            { pos, idx, views, settings: shareSettings, viewList },
            {
              worker: k,
              onLog,
              onProgress: (d) => {
                seen[k] = d
                tickVis()
              },
            },
          ),
        ),
      )
      const gpu = vis.map((v) => v.gpu)
      const onGpu = gpu.filter((g) => g.state === 'on')
      if (onGpu.length)
        log(
          `Texture: z-buffers on the GPU in ${pluralize(onGpu.length, 'worker')}, each checked against the CPU pass ` +
            `(lowest agreement ${(100 * Math.min(...onGpu.map((g) => g.agree))).toFixed(2)} %)`,
          'info',
          'Products',
        )

      // 2–4 · Selection, charts, packing.
      onProgress?.(0, 1, 'Choosing a photo per face…', 0.56)
      const parts = vis.map((v) => v.part)
      const { layout, entries, sampling } = await textureLayout(
        { runId, parts },
        { worker: 0, onLog, transfer: parts.flatMap(partTransfer) },
      )

      // 5 · Bake.
      const bakeWorkers = shares >= 3 ? shares - 1 : shares
      const cost = entries.map(
        ([, list]) => list.reduce((a, p) => a + layout.pieces.w[p] * layout.pieces.h[p], 0) + BAKE_DECODE_TEXELS,
      )
      const bakeShares = weightedRuns(cost, Math.min(bakeWorkers, entries.length)).map(([a, b]) => entries.slice(a, b))
      const baked = new Array(bakeShares.length).fill(0)
      const tickBake = () => {
        const d = baked.reduce((a, b) => a + b, 0)
        onProgress?.(
          d,
          entries.length,
          'Copying photo pixels into the atlas…',
          0.6 + (0.35 * d) / Math.max(1, entries.length),
        )
      }
      const firstBaker = bakeShares.length < shares ? 1 : 0
      let decoded = 0
      const failed = []
      const obs = await Promise.all(
        bakeShares.map(async (share, k) => {
          const r = await textureBake(
            { pos, idx, views, settings: shareSettings, layout, entries: share, sampling },
            {
              worker: firstBaker + k,
              onLog,
              onProgress: (d) => {
                baked[k] = d
                tickBake()
              },
            },
          )
          decoded += r.decoded
          failed.push(...r.failed)
          await textureBakeAdd(
            { runId, list: r.list, data: r.data },
            { worker: 0, transfer: [r.data.buffer, r.list.buffer] },
          )
          return r.obs
        }),
      )
      log(
        `Texture: visibility in ${pluralize(viewShares.length, 'worker')}, the bake in ${pluralize(bakeShares.length, 'worker')}` +
          (shares < want
            ? ` (the memory budget gives each about ${formatBytes(begin.perShare)}, room for ${shares})`
            : ''),
        'info',
        'Products',
      )

      // 6–7 · Levelling, seams, output.
      const res = await textureFinish(
        { runId, decoded, failed: failed.sort((a, b) => a - b), obs: sampling ? obs : [] },
        { worker: 0, onLog, onProgress: (d, t, lbl, f) => onProgress?.(d, t, lbl, f) },
      )
      begun = false
      return res
    } finally {
      if (begun) textureAbort(runId, { worker: 0 }).catch(() => {})
    }
  }

  return { textureMesh }
}

// A bake share's weight per photo, besides its texels: about what decoding one costs.
const BAKE_DECODE_TEXELS = 5e6

// [0, n) in `k` runs of about equal length, as [from, to).
function runs(n, k) {
  return Array.from({ length: k }, (_, i) => [Math.floor((i * n) / k), Math.floor(((i + 1) * n) / k)])
}

// The items in `k` consecutive runs of about equal total `weight`, as [from, to); none empty.
function weightedRuns(weight, k) {
  const n = weight.length,
    total = weight.reduce((a, b) => a + b, 0)
  const out = []
  let from = 0,
    acc = 0
  for (let i = 0; i < n && out.length < k - 1; i++) {
    acc += weight[i]
    const left = n - i - 1
    if (acc >= (total * (out.length + 1)) / k || left === k - out.length - 1) {
      out.push([from, i + 1])
      from = i + 1
    }
  }
  if (from < n) out.push([from, n])
  return out
}

// A visibility part's buffers, to hand on to the layout.
function partTransfer(part) {
  const out = [part.seenBy.buffer]
  for (const sp of [part.main, part.fallback])
    if (sp) for (const a of [sp.face, sp.n, sp.view, sp.score, sp.colour]) if (a) out.push(a.buffer)
  return out
}

// The atlas pages of a textured mesh as Blobs (the viewer and the exporters). A Blob
// refuses a shared view (a texture loaded into shared memory): such a page is copied.
export function texturePageBlobs(texture) {
  if (!texture?.data || !texture.pages?.length) return []
  return texture.pages.map((p) => new Blob([pageBytes(texture.data, p)], { type: p.type }))
}

// Plain-object form of the texture for in-memory clouds (markRaw: large typed data).
export const rawTexture = (texture) =>
  texture
    ? markRaw({
        data: texture.data,
        pages: texture.pages.map((p) => ({ ...p })),
        groups: texture.groups.map((g) => ({ ...g })),
      })
    : null
