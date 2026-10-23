// Run the real websfm pipeline headlessly on a folder of images and record the run.
//
//   node scripts/bench/run-bench.mjs --config scripts/bench/configs/sb-default.json
//   node scripts/bench/run-bench.mjs --images C:/data/south-building/images \
//        --detect '{"maxDim":3200}' --match '{"ratioThreshold":0.8}' --out bench-out/sb
//
// Chrome (channel 'chrome', headless) loads tests/bench/bench.html from a Vite dev
// server and calls window.bench.* stage by stage, so it is the app's own code path:
// the worker pool, the WebGPU matcher, OPFS persistence and every store-side gate. A
// fresh browser profile per run means a fresh OPFS, so runs never see each other.
//
// Outputs (`--out <prefix>`, default bench-out/<name>-<timestamp>):
//   <prefix>.log   every log line, in the dev console's export format
//   <prefix>.json  settings + per-stage numbers (keypoints, pairs, points ≥3 views, …)
//
// Config keys (JSON file and/or flags; flags win): name, images (folder) or video (one
// video file, its frames extracted as Import ▸ Video does; `videoImport` = the dialog's
// settings), include (regex
// on file names), limit (first N after sorting), sceneType, stages ("detect,match,recon";
// also depth, dense, dem, ortho, and reopen = reload the page and restore the project),
// detect / match / recon (settings objects; `preset` selects a preset delta), port, headed,
// variants ([{ label, match?, recon? }]: one detection, then a match + reconstruct per
// variant, so SfM-only experiments reuse the same keypoints and matches).
import { chromium } from 'playwright'
import { startWorkerHeapSampler } from './workerHeap.mjs'
import { loadReference } from './reference.mjs'
import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import { join, dirname, extname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff'])
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i++
  }
  return out
}
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

const args = parseArgs(process.argv.slice(2))
const cfg = { ...(args.config ? JSON.parse(await readFile(args.config, 'utf8')) : {}) }
for (const k of [
  'name',
  'images',
  'video',
  'include',
  'openProject',
  'colmapFiles',
  'limit',
  'sceneType',
  'stages',
  'out',
  'port',
  'headed',
  'dev',
  'build',
  'maxOldSpaceMb',
  'dumpSfmInput',
  'profileReopen',
  'colmap',
  'exportDense',
  'exportDem',
  'exportCloudsProject',
  'crs',
  'profile',
  'project',
  'exportOrthoCog',
])
  if (args[k] !== undefined) cfg[k] = args[k]
for (const k of ['detect', 'match', 'recon', 'videoImport'])
  cfg[k] = { ...(cfg[k] ?? {}), ...(args[k] ? json(args[k]) : {}) }
// A video is served from its folder like a dataset of one file.
if (cfg.video) cfg.images = dirname(resolve(cfg.video))
if (!cfg.images) throw new Error('--images <folder> or --video <file> (or either in --config) is required')
const name = cfg.name ?? 'bench'
const stages = String(cfg.stages ?? 'detect,match,recon')
  .split(',')
  .map((s) => s.trim())
const port = Number(cfg.port ?? 4180)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outPrefix = resolve(repo, cfg.out ?? join('bench-out', `${name}-${stamp}`))
// The run writes <out>.json: never over the config that started it (out = the config's own path minus .json).
if (args.config && resolve(`${outPrefix}.json`) === resolve(args.config))
  throw new Error(
    `out "${cfg.out}" would overwrite the config ${args.config} with the run summary — choose another out`,
  )
await mkdir(dirname(outPrefix), { recursive: true })

// ── dataset ──
// `recursive: true` walks sub-folders (a MicaSense SET splits captures into 000/001/…);
// paths stay relative with '/' and the image NAME is the basename.
const listImages = async (dir, prefix = '') => {
  const out = []
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory() && cfg.recursive) out.push(...(await listImages(dir, rel)))
    // A symlinked file counts (a dataset of links to an archive, e.g. hist/tma_prep.py).
    else if ((e.isFile() || e.isSymbolicLink()) && IMAGE_EXT.has(extname(e.name).toLowerCase())) out.push(rel)
  }
  return out
}
const baseName = (f) => f.slice(f.lastIndexOf('/') + 1)
let files = cfg.video
  ? [basename(cfg.video)]
  : (await listImages(cfg.images)).sort((a, b) => baseName(a).localeCompare(baseName(b)))
if (cfg.include) {
  const re = new RegExp(cfg.include, 'i')
  files = files.filter((f) => re.test(baseName(f)))
}
// `minGpsAlt` (metres, EXIF GPS altitude): drop captures taken on the ground before
// takeoff / after landing, which a camera that records from power-on produces.
if (cfg.minGpsAlt != null) {
  const { default: exifr } = await import('exifr')
  const kept = []
  for (const f of files) {
    const g = await exifr
      .parse(join(cfg.images, f), { gps: true, tiff: true, exif: true, xmp: false })
      .catch(() => null)
    if (Number.isFinite(g?.GPSAltitude) && g.GPSAltitude >= Number(cfg.minGpsAlt)) kept.push(f)
  }
  console.log(`== minGpsAlt ${cfg.minGpsAlt} m: kept ${kept.length}/${files.length} image(s)`)
  files = kept
}
if (cfg.limit) files = files.slice(0, Number(cfg.limit))
if (!files.length && stages.includes('detect')) throw new Error(`no images in ${cfg.images}`) // open / import runs need none

// ── app server ──
// Default: build a snapshot (scripts/bench/vite.bench.config.mjs) and serve it
// statically, so source edits made while a long run is going cannot reach it (the dev
// server hot-reloads the page). `--dev` uses the dev server instead (fast, not frozen);
// `--build <dir>` reuses an earlier snapshot.
const base = `http://127.0.0.1:${port}`
const benchUrl = `${base}/tests/bench/bench.html`
const alive = async () => {
  try {
    return (await fetch(benchUrl)).ok
  } catch {
    return false
  }
}
let vite = null,
  server = null
const STATIC_MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.onnx': 'application/octet-stream',
}
if (cfg.dev) {
  if (!(await alive())) {
    vite = spawn(
      process.execPath,
      [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: repo, stdio: 'ignore' },
    )
  }
} else {
  const buildDir = cfg.build ? resolve(repo, cfg.build) : `${outPrefix}.build`
  if (!cfg.build) {
    const t0 = Date.now()
    await new Promise((ok, fail) => {
      const p = spawn(
        process.execPath,
        [
          join(repo, 'node_modules/vite/bin/vite.js'),
          'build',
          '--config',
          'scripts/bench/vite.bench.config.mjs',
          '--logLevel',
          'warn',
        ],
        { cwd: repo, stdio: 'inherit', env: { ...process.env, BENCH_OUT_DIR: buildDir } },
      )
      p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`bench build failed (${code})`))))
    })
    console.log(`== build: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${buildDir}`)
  }
  const { createServer } = await import('node:http')
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, base).pathname)
    // Dataset files stream straight from disk: routing gigabytes through Playwright's
    // page.route (one CDP message per file) failed on the 2.9 GB quarry set.
    // `hist.masks`: a folder of per-image mask files, served the same way.
    const dataRoot = path.startsWith('/__bench_masks/') ? cfg.hist?.masks : cfg.images
    if (path.startsWith('/__bench_data/') || (dataRoot && path.startsWith('/__bench_masks/'))) {
      const file = join(dataRoot, path.slice(path.indexOf('/', 1) + 1))
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res)
      return
    }
    try {
      const body = await readFile(join(buildDir, path))
      res.writeHead(200, {
        'Content-Type': STATIC_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
}
{
  const t0 = Date.now()
  while (!(await alive())) {
    if (Date.now() - t0 > 60_000) throw new Error('app server did not start')
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── browser ──
const logOut = createWriteStream(`${outPrefix}.log`)
const fmt = (e) => `${e.time}  ${String(e.source ?? '').padEnd(10)}  ${String(e.level).padEnd(7)}  ${e.message}`
const quiet = /^Matched: |^SIFT (start|done): |^Added image: |^Metadata /
// A persistent profile on disk, deleted afterwards: an incognito context keeps OPFS and
// blobs in memory, which a 2.9 GB dataset (quarry) exhausts — and the user's browser
// stores them on disk too.
// `profile: "<dir>"` uses (and keeps) that profile instead: a first run builds the
// project there, later runs start with `reopen` and repeat only the stages they name
// (e.g. `reopen,ortho:a,ortho:b` on one set of depth maps), on the project named
// `project` (default: the newest). Such a run skips ingest. Delete the profile by hand.
const profileDir = cfg.profile ? resolve(repo, cfg.profile) : `${outPrefix}.profile`
// Precise heap readings + a callable gc(), so the `== memory` lines below report live
// bytes rather than quantised numbers that include uncollected garbage.
// `maxOldSpaceMb` raises V8's heap ceiling for the page AND its workers (one renderer
// process). Users cannot do this; it exists so a run that would die at ~4 GB can finish
// and report its real peak (TODO ▸ MEM). The app's preflight then sees the raised
// jsHeapSizeLimit too.
const jsFlags = ['--expose-gc', ...(cfg.maxOldSpaceMb ? [`--max-old-space-size=${Number(cfg.maxOldSpaceMb)}`] : [])]
const browser = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',
  headless: !cfg.headed,
  // `chromeArgs`: extra Chrome flags. On Linux, headless Chrome only offers SwiftShader
  // WebGPU; `"headed": true, "chromeArgs": ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"]`
  // reaches the real GPU (scripts/bench/README.md ▸ Linux).
  args: ['--enable-precise-memory-info', `--js-flags=${jsFlags.join(' ')}`, ...(cfg.chromeArgs ?? [])],
  acceptDownloads: true, // the export:<tag> stage saves the app's downloads
  // Playwright stages downloads in a temp folder before saveAs copies them: keep that on
  // the run's disk (multi-GB exports, and /tmp may be a quota-limited tmpfs).
  downloadsPath: `${outPrefix}.downloads`,
})
const result = { name, config: cfg, files: files.length, startedAt: new Date().toISOString(), stages: {} }
let heap = null // worker heap sampler (workerHeap.mjs), started with the page
try {
  const page = browser.pages()[0] ?? (await browser.newPage())
  // Worker heap per SfM segment: closed by the solver's `stage "…" took` and
  // `memory mark "…"` debug lines (sfm.js), reported with each recon stage.
  heap = await startWorkerHeapSampler(page)
  const heapMark = /(?:^|: )(?:stage "([^"]+)" took|memory mark "([^"]+)")|^(Compact result ready)/
  // Stall/crash watchdog. A worker or renderer that dies of memory can leave
  // page.evaluate pending forever (a 2026-10-07 Monster run sat silent for 5 h after
  // its SfM worker died). Any page crash, or no log line for `stallMinutes` (default
  // 30) while a stage runs, aborts the run with an error in the result instead.
  let lastLogAt = Date.now(),
    pageCrashed = false
  page.on('crash', () => {
    pageCrashed = true
    console.error('[page crash] renderer process died')
  })
  const stallMs = Number(cfg.stallMinutes ?? 30) * 60_000
  const watchdog = () =>
    new Promise((_, reject) => {
      const t = setInterval(() => {
        if (pageCrashed) {
          clearInterval(t)
          reject(new Error('page crashed (renderer process died)'))
        } else if (Date.now() - lastLogAt > stallMs) {
          clearInterval(t)
          reject(new Error(`stalled: no log line for ${cfg.stallMinutes ?? 30} min (worker likely died)`))
        }
      }, 10_000)
      watchdog.timers.push(t)
    })
  watchdog.timers = []
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.startsWith('@@LOG ')) {
      lastLogAt = Date.now()
      const e = JSON.parse(text.slice(6))
      const mk = heapMark.exec(e.message)
      if (mk) {
        // Keep a sub-run's prefix ("Seed retry 2: ", "Secondary 1: ") in the segment name.
        const prefix = e.message.slice(0, mk.index + (mk[0].startsWith(': ') ? 2 : 0))
        heap.mark(`${prefix}${mk[1] ?? mk[2] ?? 'pack result (worker op)'}`)
      }
      logOut.write(fmt(e) + '\n')
      if (!quiet.test(e.message) && e.level !== 'debug') console.log(fmt(e))
    } else if (msg.type() === 'error') {
      logOut.write(`[page error] ${text}\n`)
      console.error('[page error]', text)
    }
  })
  page.on('pageerror', (err) => {
    logOut.write(`[page exception] ${err.message}\n`)
    console.error('[page exception]', err.message)
  })
  if (cfg.dev)
    for (const [prefix, root] of [
      ['__bench_data', cfg.images],
      ['__bench_masks', cfg.hist?.masks],
    ])
      if (root)
        await page.route(`${base}/${prefix}/**`, async (route) => {
          const file = decodeURIComponent(new URL(route.request().url()).pathname.replace(`/${prefix}/`, ''))
          const body = await readFile(join(root, file))
          await route.fulfill({ body, contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
        })
  await page.goto(benchUrl)
  await page.waitForFunction(() => window.benchReady === true, null, { timeout: 120_000 })

  const t0 = Date.now()
  const reuse = !!cfg.profile && stages[0] === 'reopen'
  if (!reuse)
    await page.evaluate((o) => window.bench.start(o), { name, sceneType: cfg.sceneType ?? 'object', crs: cfg.crs })
  if (cfg.reference)
    console.log(
      '== reference:',
      JSON.stringify(await page.evaluate((r) => window.bench.setReference(r), await loadReference(cfg.reference))),
    )
  // In batches, so the page never holds the whole dataset as blobs at once.
  let added = 0
  const list = files.map((f) => ({ url: `${base}/__bench_data/${encodeURIComponent(f)}`, name: baseName(f) }))
  // Under the same crash/stall watchdog as the stages: a renderer that dies mid-ingest
  // (Iceland 1980, 125 × 130 MP scans under a memory cap) left the run waiting forever.
  let video = null
  try {
    if (cfg.video && !reuse) {
      video = await Promise.race([
        page.evaluate((v) => window.bench.addVideo(v), {
          url: list[0].url,
          name: list[0].name,
          settings: cfg.videoImport,
        }),
        watchdog(),
      ])
      added = video.images
      console.log(`== video: ${JSON.stringify(video)}`)
    }
    for (let i = 0; !cfg.video && i < (reuse ? 0 : list.length); i += 32) {
      lastLogAt = Date.now()
      added = await Promise.race([page.evaluate((l) => window.bench.addImages(l), list.slice(i, i + 32)), watchdog()])
    }
  } finally {
    for (const t of watchdog.timers.splice(0)) clearInterval(t)
  }
  result.stages.ingest = { images: added, seconds: (Date.now() - t0) / 1000, ...(video ? { video } : {}) }
  // `hist` (scripts/bench/hist/README.md): a historical block's certificate focal +
  // scan pitch on one sensor, a static mask, and the surveyed GCPs (gcp.csv).
  // A reused profile already holds all of this; the project is restored by `reopen`
  // afterwards, which would replace anything imported here.
  if (cfg.hist && !reuse) {
    const { histSetup } = await import('./hist/histSetup.mjs')
    const h = await histSetup({ imagesDir: cfg.images, ...cfg.hist }, files)
    if (h.sensor)
      console.log(`== hist sensor: ${JSON.stringify(await page.evaluate((f) => window.bench.setSensor(f), h.sensor))}`)
    if (h.sensorGroups)
      console.log(
        `== hist sensors: ${JSON.stringify(await page.evaluate((b) => window.bench.groupSensors(b), h.sensorGroups))}`,
      )
    if (h.fiducialsBatch) {
      const f = await page.evaluate((x) => window.bench.setFiducialsBatch(x), h.fiducialsBatch)
      console.log(`== hist fiducials (batch layout): ${JSON.stringify(f.sensors)} · ${f.applied} marks`)
      result.fiducials = f
    }
    if (h.maskDataUrl)
      console.log(`== hist mask: ${await page.evaluate((u) => window.bench.setMask(u), h.maskDataUrl)} image(s)`)
    if (cfg.hist.footprints) {
      const fp = await page.evaluate((x) => window.bench.importPolygons(x), {
        text: await readFile(cfg.hist.footprints, 'utf8'),
        name: 'footprints',
      })
      console.log(`== hist footprints: ${JSON.stringify(fp)}`)
    }
    if (h.maskFiles) {
      const m = await page.evaluate((x) => window.bench.importMasks(x), {
        files: h.maskFiles.map((f) => ({ url: `${base}/__bench_masks/${encodeURIComponent(f)}`, name: f })),
        existing: cfg.hist.maskExisting,
      })
      console.log(`== hist masks: ${JSON.stringify(m)}`)
      result.masks = m
    }
    if (h.fiducials) {
      const f = await page.evaluate((x) => window.bench.setFiducials(x), h.fiducials)
      console.log(`== hist fiducials: ${JSON.stringify(f)}`)
      result.fiducials = f
    }
    if (h.gcps)
      console.log(
        `== hist GCPs: ${JSON.stringify(await page.evaluate((g) => window.bench.setGcps(g), { gcps: h.gcps, crs: cfg.crs }))}`,
      )
    result.hist = { sensor: h.sensor, gcps: h.gcps?.length ?? 0, checks: h.checks }
  }
  // `sensor`: one calibration for the whole block, set before detection, so matching
  // already verifies through it (a fisheye's putatives in its pinhole frame).
  if (cfg.sensor)
    console.log(`== sensor: ${JSON.stringify(await page.evaluate((f) => window.bench.setSensor(f), cfg.sensor))}`)
  if (cfg.reference?.importPoses)
    console.log(`== imported ${await page.evaluate(() => window.bench.importReferencePoses())} reference pose(s)`)
  console.log(`== ingest: ${added} images in ${result.stages.ingest.seconds.toFixed(1)} s`)
  // Renderer heap after each stage, before and after a forced GC: the sparse memory
  // preflight reads usedJSHeapSize, so garbage the page has not collected yet can
  // refuse a run that would fit.
  const memory = async (label) => {
    const m = await page.evaluate(async () => {
      const before = performance.memory?.usedJSHeapSize ?? null
      if (typeof globalThis.gc === 'function') {
        globalThis.gc()
        await new Promise((r) => setTimeout(r, 200))
        globalThis.gc()
      }
      return { before, after: performance.memory?.usedJSHeapSize ?? null }
    })
    const gb = (v) => (v == null ? '?' : `${(v / 1024 ** 3).toFixed(2)} GB`)
    console.log(`== memory ${label}: renderer heap ${gb(m.before)} → ${gb(m.after)} after GC`)
    ;(result.memory ??= {})[label] = m
  }
  await memory('after ingest')

  const run = {
    detect: 'detect',
    match: 'match',
    recon: 'reconstruct',
    depth: 'depth',
    dense: 'dense',
    dem: 'dem',
    mesh: 'mesh',
    decimate: 'decimate',
    texture: 'texture',
    meshexport: 'meshexport',
    texturedump: 'texturedump',
    ortho: 'ortho',
    modeledit: 'modelEdit',
    scalebar: 'scaleBar',
    stats: 'modelStats',
    region: 'setRegion',
    regioncheck: 'regionCheck',
    togglepair: 'togglePair',
    aligncheck: 'alignCheck',
    georef: 'georef',
    findgcps: 'findGcps',
    rastersample: 'rasterSample',
    rasterstyle: 'rasterRestyle',
    meshtools: 'meshTools',
    reseau: 'reseau',
    reseauhalves: 'reseauHalves',
    panosplit: 'panoramicSplit',
  }
  const gbStr = (v) => (v == null ? '?' : `${(v / 1024 ** 3).toFixed(2)} GB`)
  // `performance.memory` counts ArrayBuffer backing stores, which the ~4 GB V8 limit
  // does not: the DevTools protocol separates the two (V8 heap vs backing storage).
  const v8Heap = async () => {
    try {
      const s = await page.context().newCDPSession(page)
      const u = await s.send('Runtime.getHeapUsage')
      await s.detach()
      return u
    } catch {
      return null
    }
  }
  const invLine = (inv) =>
    `${inv.v8 ? `V8 heap ${gbStr(inv.v8.usedSize)} + ArrayBuffers ${gbStr(inv.v8.backingStorageSize)} · ` : ''}` +
    `performance.memory ${gbStr(inv.heapBytes)} of ${gbStr(inv.heapLimit)} · ${inv.images} images, ` +
    `${inv.keypoints.toLocaleString()} keypoints, ${inv.pairs.toLocaleString()} pairs / ${inv.matchTuples.toLocaleString()} match tuples` +
    `${
      inv.clouds.length
        ? `, clouds: ${inv.clouds
            .map(
              (c) =>
                `${c.kind} ${c.points.toLocaleString()}${c.posType ? ` (${c.posType})` : ''}` +
                (c.texturePages
                  ? ` textured: ${c.texturePages} pages ${gbStr(c.textureBytes)}, ${c.uvs.toLocaleString()} UVs`
                  : ''),
            )
            .join(', ')}`
        : ''
    }` +
    `, ${inv.depthMaps} depth maps` +
    (inv.resident
      ? ` · resident: ${inv.resident.keypointImages} images' keypoints (${gbStr(inv.resident.keypointBytes)}), ` +
        `${inv.resident.matchPairs} pairs' matches (${gbStr(inv.resident.matchBytes)})`
      : '')
  // What the renderer holds per item after each stage (bench.inventory): counts plus
  // the live heap after a GC — the data that scales the ~4 GB V8 ceiling.
  const inventory = async (label) => {
    const inv = await page.evaluate(() => window.bench.inventory())
    inv.v8 = await v8Heap()
    console.log(`== inventory ${label}: ${invLine(inv)}`)
    ;(result.inventory ??= {})[label] = inv
  }
  // Reopen the project in a fresh page: reload (OPFS survives in the on-disk profile),
  // then restore through the app's own sequence — what a user's reopen costs.
  // `colmap: "<dir with cameras.txt, images.txt, points3D.txt>"`: import that model as the
  // main sparse cloud (stage "colmap", instead of "recon").
  // `export:<tag>`: one export through the app's dialog dispatch (window.bench.exportRun),
  // config key `export:<tag>` = { kind, settings, cloud? }. Every download the export
  // triggers is saved as <prefix>.<tag>.<file name>.
  const exportStage = async (entry) => {
    const spec = cfg[entry]
    if (!spec?.kind) throw new Error(`${entry}: config needs { kind, settings }`)
    const tag = entry.slice(7),
      saves = []
    const onDownload = (d) => {
      const f = `${outPrefix}.${tag}.${saves.length ? `${saves.length}.` : ''}${d.suggestedFilename()}`
      saves.push(
        d.saveAs(f).then(
          async () => ({ file: f, bytes: (await stat(f)).size }),
          (err) => ({ file: f, error: String(err?.message ?? err) }),
        ),
      )
    }
    page.on('download', onDownload)
    try {
      const r = await page.evaluate((x) => window.bench.exportRun(x), spec)
      // The download starts after the click; a multi-GB blob can take a while to begin.
      // Wait for the first one (an export that writes nothing has logged why), then a
      // short quiet period for any further files.
      for (let t = 0; t < (spec.expectFiles === 0 ? 2 : 300) && !saves.length; t++) await page.waitForTimeout(1000)
      for (let n = -1; n !== saves.length;) {
        n = saves.length
        await page.waitForTimeout(3000)
      }
      const files = await Promise.all(saves)
      result.stages[entry] = { ...r, files }
      console.log(
        `== ${entry}: ${r.seconds.toFixed(1)} s, ${files.map((f) => `${f.file.split('/').pop()} (${f.error ?? `${(f.bytes / 1024 ** 2).toFixed(2)} MiB`})`).join(', ') || 'no file'}`,
      )
    } finally {
      page.off('download', onDownload)
    }
    await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  }
  // `openproject`: open the .websfm at cfg.openProject as a new project (fresh profile:
  // nothing of the saving run is here) and restore it; logs the inventory like reopen.
  const openProject = async () => {
    if (!cfg.openProject) throw new Error('openproject: set "openProject" to a .websfm path')
    await page.evaluate(() => {
      const el = Object.assign(document.createElement('input'), { type: 'file', id: 'bench-project-file' })
      document.body.appendChild(el)
    })
    await page.setInputFiles('#bench-project-file', cfg.openProject)
    lastLogAt = Date.now()
    let r
    try {
      r = await Promise.race([page.evaluate(() => window.bench.openProjectFile()), watchdog()])
    } finally {
      for (const t of watchdog.timers.splice(0)) clearInterval(t)
    }
    const { inventory: inv, ...numbers } = r
    result.stages.openproject = numbers
    ;(result.inventory ??= {}).openproject = inv
    console.log(`== openproject: ${JSON.stringify(numbers)}`)
    console.log(`== inventory openproject: ${invLine(inv)}`)
    await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  }
  const importColmap = async () => {
    const files = Object.fromEntries(
      await Promise.all(
        ['cameras.txt', 'images.txt', 'points3D.txt'].map(async (f) => [
          f,
          await readFile(join(cfg.colmap, f), 'utf8'),
        ]),
      ),
    )
    const r = await page.evaluate((files) => window.bench.importColmap({ files }), files)
    console.log(`== colmap: ${JSON.stringify(r)}`)
    result.stages.colmap = r
    if (!r.ok) throw new Error('COLMAP import failed (see the log)')
  }
  // `exportDense: true`: after the dense stage, write the fused positions as raw
  // Float32 xyz to <out>.dense.bin (scripts/bench/eth3d.mjs scores it).
  const exportDense = async (tag) => {
    const info = await page.evaluate(() => window.bench.denseInfo())
    if (!info) {
      console.log('== exportDense: no dense cloud')
      return
    }
    const file = `${outPrefix}${tag ? `.${tag}` : ''}.dense.bin`
    const out = createWriteStream(file)
    const step = 1 << 20
    for (let s = 0; s < info.count; s += step) {
      const b64 = await page.evaluate(([a, n]) => window.bench.denseChunk(a, n), [s, step])
      await new Promise((res, rej) => out.write(Buffer.from(b64, 'base64'), (e) => (e ? rej(e) : res())))
    }
    await new Promise((res) => out.end(res))
    console.log(`== exportDense: ${info.count} points → ${file}`)
    result.stages[tag ? `exportDense:${tag}` : 'exportDense'] = { points: info.count, file }
  }
  // `exportCloudsProject: true`: after recon (sparse, with view counts) and dense, the
  // points in the project CRS as raw Float64 (x, y, z[, views]) to <out>.<kind>.project.bin.
  const exportCloudProject = async (kind, tag) => {
    const d = await page.evaluate((kind) => window.bench.cloudPointsProject({ kind }), kind)
    if (!d) {
      console.log(`== exportCloudsProject: no ${kind} cloud or no georeference`)
      return
    }
    const file = `${outPrefix}${tag ? `.${tag}` : ''}.${kind}.project.bin`
    await writeFile(file, Buffer.from(d.b64, 'base64'))
    console.log(`== exportCloudsProject: ${kind} ${d.count} points (stride ${d.stride}, ${d.width} values) → ${file}`)
    result.stages[`export:${kind}${tag ? `:${tag}` : ''}`] = { points: d.count, stride: d.stride, width: d.width, file }
  }
  // With `reference.lidar`: score the fused cloud (a ≤1 M-point stride sample, in the
  // reconstruction's camera-GPS ENU frame) against the LiDAR surface, like the sparse
  // points after recon. Read `domeRmsM` / `domeWithin10cm` to compare two fusions of
  // one model: the dome is the model's and cancels.
  const denseLidarCheck = async (key) => {
    const d = await page.evaluate(() => window.bench.densePointsEnu())
    if (!d) {
      console.log(`== ${key} LiDAR: no dense cloud or no GPS fit`)
      return
    }
    const f = new Float32Array(Uint8Array.from(Buffer.from(d.b64, 'base64')).buffer) // own buffer: a Buffer may sit in a shared pool
    const pts = []
    for (let i = 0; i < f.length; i += 3) pts.push([f[i], f[i + 1], f[i + 2]])
    const { loadLidarGrid, lidarCheck } = await import('./lidar.mjs')
    lidarGrid ??= await loadLidarGrid(lidarCfg, (m) => console.log(`== ${m}`))
    const r = {
      ...lidarCheck(pts, d.origin, lidarGrid, { flatRangeM: lidarCfg.flatRangeM ?? 0.15 }),
      denseCount: d.count,
      stride: d.stride,
    }
    result.stages[key].lidarCheck = r
    console.log(`== ${key} LiDAR: ${JSON.stringify(r)}`)
    await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  }
  // After the ortho stage, write its PNG to <out>.ortho.png (side-by-sides, plan O0).
  const exportOrtho = async (tag) => {
    const size = await page.evaluate(() => window.bench.orthoPngSize())
    if (!size) {
      console.log('== exportOrtho: no ortho')
      return
    }
    const file = `${outPrefix}${tag ? `.${tag}` : ''}.ortho.png`
    const out = createWriteStream(file)
    for (let s = 0; s < size; s += 8 << 20) {
      const b64 = await page.evaluate(([a, n]) => window.bench.orthoPngChunk(a, n), [s, 8 << 20])
      await new Promise((res, rej) => out.write(Buffer.from(b64, 'base64'), (e) => (e ? rej(e) : res())))
    }
    await new Promise((res) => out.end(res))
    console.log(`== exportOrtho: ${(size / 1024 ** 2).toFixed(1)} MiB → ${file}`)
    // `exportOrthoCog: true`: the full-resolution ortho too (its stored COG), for crops.
    if (cfg.exportOrthoCog) {
      const n = await page.evaluate(() => window.bench.orthoCogSize())
      const tif = `${outPrefix}${tag ? `.${tag}` : ''}.ortho.tif`
      const w = createWriteStream(tif)
      for (let s = 0; s < n; s += 8 << 20) {
        const b64 = await page.evaluate(([a, k]) => window.bench.orthoCogChunk(a, k), [s, 8 << 20])
        await new Promise((res, rej) => w.write(Buffer.from(b64, 'base64'), (e) => (e ? rej(e) : res())))
      }
      await new Promise((res) => w.end(res))
      console.log(`== exportOrtho: COG ${(n / 1024 ** 2).toFixed(1)} MiB → ${tif}`)
    }
  }
  // After the texture stage: its atlas pages as <out>.texture-<n>.jpg.
  const exportTexturePages = async (tag) => {
    const sizes = await page.evaluate(() => window.bench.texturePages())
    for (let i = 0; i < sizes.length; i++) {
      const file = `${outPrefix}${tag ? `.${tag}` : ''}.texture-${i}.jpg`
      const parts = []
      for (let s = 0; s < sizes[i]; s += 8 << 20) {
        parts.push(
          Buffer.from(
            await page.evaluate(([p, a, n]) => window.bench.texturePageChunk(p, a, n), [i, s, 8 << 20]),
            'base64',
          ),
        )
      }
      await writeFile(file, Buffer.concat(parts))
      console.log(`== exportTexture: page ${i} ${(sizes[i] / 1024 ** 2).toFixed(1)} MiB → ${file}`)
    }
  }
  // After the dem stage: <out>.dem.tif, scored against `hist.refDem` (score_dem.py,
  // the Grenoble evaluation's protocol) when one is given.
  const exportDem = async (tag) => {
    const size = await page.evaluate(() => window.bench.demTiffSize())
    if (!size) {
      console.log('== exportDem: no DEM')
      return
    }
    const file = `${outPrefix}${tag ? `.${tag}` : ''}.dem.tif`
    const out = createWriteStream(file)
    for (let s = 0; s < size; s += 8 << 20) {
      const b64 = await page.evaluate(([a, n]) => window.bench.demTiffChunk(a, n), [s, 8 << 20])
      await new Promise((res, rej) => out.write(Buffer.from(b64, 'base64'), (e) => (e ? rej(e) : res())))
    }
    await new Promise((res) => out.end(res))
    console.log(`== exportDem: ${(size / 1024 ** 2).toFixed(1)} MiB → ${file}`)
    if (cfg.hist?.refDem) {
      const { scoreDem } = await import('./hist/histSetup.mjs')
      const key = tag ? `dem:${tag}` : 'dem'
      result.stages[key].demScore = scoreDem(file, cfg.hist.refDem, cfg.hist.python)
      console.log(`== ${key} vs reference: ${JSON.stringify(result.stages[key].demScore)}`)
      await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
    }
  }
  const reopen = async () => {
    // A kept profile (`profile`) opened in a new run has no current project yet: its newest.
    const id =
      (await page.evaluate(() => window.bench.currentProject())) ??
      (await page.evaluate((n) => window.bench.latestProject(n), cfg.project ?? null))
    lastLogAt = Date.now()
    await page.reload()
    await page.waitForFunction(() => window.benchReady === true, null, { timeout: 120_000 })
    // `profileReopen`: a CPU profile of the restore (DevTools-loadable .cpuprofile),
    // plus its top self-time functions on the console.
    let cdp = null
    if (cfg.profileReopen) {
      cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
      await cdp.send('Profiler.start')
    }
    let r
    try {
      r = await Promise.race([page.evaluate((x) => window.bench.reopen(x), id), watchdog()])
    } finally {
      for (const t of watchdog.timers.splice(0)) clearInterval(t)
    }
    if (cdp) {
      const { profile } = await cdp.send('Profiler.stop')
      await writeFile(`${outPrefix}.reopen.cpuprofile`, JSON.stringify(profile))
      const byId = new Map(profile.nodes.map((n) => [n.id, n]))
      const self = new Map()
      const dt = profile.timeDeltas
      profile.samples.forEach((id, i) => {
        const n = byId.get(id),
          f = n.callFrame
        const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`
        self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0))
      })
      const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)
      const NL = String.fromCharCode(10)
      console.log(
        '== reopen CPU profile (self ms):' +
          NL +
          top.map(([k, us]) => `   ${(us / 1000).toFixed(0).padStart(6)}  ${k}`).join(NL),
      )
    }
    const { inventory: inv, ...numbers } = r
    inv.v8 = await v8Heap()
    result.stages.reopen = numbers
    ;(result.inventory ??= {}).reopen = inv
    console.log(`== reopen: ${JSON.stringify(numbers)}`)
    console.log(`== inventory reopen: ${invLine(inv)}`)
    await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  }
  // A LiDAR reference (scripts/bench/lidar.mjs) is gridded once, then every
  // reconstruction's points are scored against it here, in node.
  const lidarCfg = cfg.reference?.lidar ?? null
  let lidarGrid = null
  // `profileWorkers: { stage, afterSeconds, seconds }`: during that stage (its config key,
  // e.g. "ortho:small"), CPU-profile every worker for `seconds` from `afterSeconds` in;
  // the top functions by self time go to the console, the profiles to
  // <prefix>.<stage>.worker<k>.cpuprofile (DevTools ▸ Performance loads them).
  const profileDuring = (key) => {
    const pw = cfg.profileWorkers
    if (!pw || pw.stage !== key || !heap) return null
    const NL = String.fromCharCode(10)
    return (async () => {
      await new Promise((r) => setTimeout(r, (pw.afterSeconds ?? 60) * 1000))
      const out = await heap.profile(pw.seconds ?? 60)
      for (const [k, w] of out.entries()) {
        if (!w.totalMs) continue
        await writeFile(
          `${outPrefix}.${key.replace(/[^a-z0-9]+/gi, '_')}.worker${k}.cpuprofile`,
          JSON.stringify(w.profile),
        )
        console.log(
          `== worker CPU profile ${key} #${k} (${w.worker.split('/').pop()}), ${w.totalMs.toFixed(0)} ms sampled, self ms:` +
            NL +
            w.top.map(([f, us]) => `   ${(us / 1000).toFixed(0).padStart(7)}  ${f}`).join(NL),
        )
      }
    })().catch((err) => console.log(`== worker CPU profile failed: ${err?.message ?? err}`))
  }
  const runStage = async (stage, settings, key = stage) => {
    profileDuring(key)
    const s = stage === 'recon' && lidarCfg ? { ...settings, exportPoints: true } : settings
    lastLogAt = Date.now()
    heap.mark('(before stage)')
    heap.take()
    if (stage === 'recon' && cfg.dumpSfmInput) await page.evaluate(() => window.bench.armSfmCapture())
    let r
    try {
      r = await Promise.race([page.evaluate(([f, x]) => window.bench[f](x), [run[stage], s]), watchdog()])
    } catch (err) {
      heap.mark('(at abort)')
      result.stages[key] = { error: String(err?.message ?? err), workerHeap: heap.take() }
      await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
      console.error(`== ${key}: ABORTED — ${err?.message ?? err}`)
      throw err
    } finally {
      for (const t of watchdog.timers.splice(0)) clearInterval(t)
    }
    if (stage === 'recon' && lidarCfg) {
      if (r.pointsEnu?.length && r.enuOrigin) {
        const { loadLidarGrid, lidarCheck } = await import('./lidar.mjs')
        lidarGrid ??= await loadLidarGrid(lidarCfg, (m) => console.log(`== ${m}`))
        r.lidarCheck = lidarCheck(r.pointsEnu, r.enuOrigin, lidarGrid, { flatRangeM: lidarCfg.flatRangeM ?? 0.15 })
      } else {
        r.lidarCheck = { error: 'no georeferenced points (needs camera GPS for the ENU frame)' }
      }
      delete r.pointsEnu
    }
    if (stage === 'recon' && cfg.dumpSfmInput && (await page.evaluate(() => window.bench.sfmCaptureBytes()))) {
      // The exact worker payload, for node replay (tests/bench/sfmInputDump.js).
      const file = `${outPrefix}.${key.replace(/[^\w.-]+/g, '_')}.sfminput`
      const [download, bytes] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        page.evaluate((n) => window.bench.downloadSfmCapture(n), basename(file)),
      ])
      await download.saveAs(file)
      console.log(`== ${key}: SfM input dump ${(bytes / 1024 ** 2).toFixed(1)} MiB → ${file}`)
    }
    if (stage === 'recon' || stage === 'ortho') {
      heap.mark(stage === 'ortho' ? '(ortho)' : '(tail)')
      const h = heap.take()
      r.workerHeap = h
      const gb = (v) => `${(v / 1024 ** 3).toFixed(2)} GB`
      for (const seg of h.segments) {
        console.log(
          `== worker heap ${key} ▸ ${seg.label}: ${gb(seg.peakBytes)} V8 heap, ${gb(seg.peakWithBuffersBytes)} with ArrayBuffers`,
        )
      }
    }
    result.stages[key] = r
    const { settings: _s, model: _m, workerHeap: _w, perPair: _p, kpPerImage: _k, featureDigest: _f, ...numbers } = r
    console.log(`== ${key}: ${JSON.stringify(numbers)}`)
    if (stage !== 'recon') await memory(`after ${key}`)
    await inventory(`after ${key}`)
    await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  }
  if (cfg.variants?.length) {
    // Detect once, then per variant: re-match only when its match settings differ from
    // the previous variant's, and always reconstruct. Reconstruction never mutates the
    // stored keypoints (folds act on the worker's copy), so variants are independent.
    if (stages.includes('detect')) await runStage('detect', cfg.detect)
    let lastMatch = null
    for (const v of cfg.variants) {
      const label = v.label ?? JSON.stringify(v)
      const match = { ...cfg.match, ...(v.match ?? {}) }
      if (JSON.stringify(match) !== lastMatch) {
        await runStage('match', match, `match[${label}]`)
        lastMatch = JSON.stringify(match)
      }
      await runStage('recon', { ...cfg.recon, ...(v.recon ?? {}) }, `recon[${label}]`)
    }
  } else {
    // A stage may carry a tag, `dense:loose`: it runs the `dense` stage with the config
    // key `dense:loose` (falling back to `dense`) and reports under that key, so one run
    // can repeat a stage with other settings on the same inputs.
    for (const entry of stages) {
      if (entry === 'reopen') {
        await reopen()
        continue
      }
      if (entry === 'colmap') {
        await importColmap()
        continue
      }
      if (entry.startsWith('export:')) {
        await exportStage(entry)
        continue
      }
      if (entry === 'openproject') {
        await openProject()
        continue
      }
      if (entry === 'colmapfiles') {
        // `colmapfiles`: the COLMAP model in cfg.colmapFiles (a folder) through a file input.
        const dir = cfg.colmapFiles
        const names = (await readdir(dir)).filter((f) => /\.(txt|bin)$/.test(f))
        await page.evaluate(() =>
          document.body.appendChild(
            Object.assign(document.createElement('input'), { type: 'file', multiple: true, id: 'bench-colmap-files' }),
          ),
        )
        await page.setInputFiles(
          '#bench-colmap-files',
          names.map((f) => join(dir, f)),
        )
        const r = await page.evaluate(() => window.bench.importColmapFiles())
        result.stages[entry] = r
        console.log(`== ${entry}: ${JSON.stringify(r)}`)
        continue
      }
      if (entry.startsWith('importfile:')) {
        // `importfile:<tag>`: Import ▸ point cloud / mesh of the file at cfg[entry].path.
        const path = cfg[entry]?.path
        if (!path) throw new Error(`${entry}: config needs { path }`)
        await page.evaluate(() => {
          document.getElementById('bench-import-file')?.remove()
          document.body.appendChild(
            Object.assign(document.createElement('input'), { type: 'file', id: 'bench-import-file' }),
          )
        })
        await page.setInputFiles('#bench-import-file', path)
        lastLogAt = Date.now()
        let r
        try {
          r = await Promise.race([page.evaluate(() => window.bench.importCloudFile()), watchdog()])
        } finally {
          for (const t of watchdog.timers.splice(0)) clearInterval(t)
        }
        result.stages[entry] = r
        console.log(`== ${entry}: ${JSON.stringify({ ...r, stats: undefined })}`)
        await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
        continue
      }
      if (entry === 'layers') {
        // `layers`: polygon files (stable ground, outlines) as map layers, cfg.layers =
        // [{ path, name }]; a stage, so it can follow `reopen`.
        const out = []
        for (const layer of cfg.layers ?? []) {
          const r = await page.evaluate((x) => window.bench.importPolygons(x), {
            text: await readFile(layer.path, 'utf8'),
            name: layer.name,
          })
          out.push({ name: layer.name, ...r })
        }
        result.stages.layers = out
        console.log(`== layers: ${JSON.stringify(out)}`)
        continue
      }
      if (entry.startsWith('importraster:')) {
        // `importraster:<tag>`: Import ▸ Reference raster of cfg[entry].path.
        const path = cfg[entry]?.path
        if (!path) throw new Error(`${entry}: config needs { path }`)
        await page.evaluate(() => {
          document.getElementById('bench-raster-file')?.remove()
          document.body.appendChild(
            Object.assign(document.createElement('input'), { type: 'file', id: 'bench-raster-file' }),
          )
        })
        await page.setInputFiles('#bench-raster-file', path)
        lastLogAt = Date.now()
        let r
        try {
          r = await Promise.race([page.evaluate(() => window.bench.importRasterFile()), watchdog()])
        } finally {
          for (const t of watchdog.timers.splice(0)) clearInterval(t)
        }
        result.stages[entry] = r
        console.log(`== ${entry}: ${JSON.stringify(r)}`)
        await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
        continue
      }
      if (entry === 'sensor') {
        // `sensor`: apply the config's camera calibration again (hist.intrinsics, else
        // `sensor`) — on a `reopen` of a project whose sensor never reached storage.
        const { histSetup } = await import('./hist/histSetup.mjs')
        const h = cfg.hist ? await histSetup({ imagesDir: cfg.images, ...cfg.hist }, files) : null
        const fields = h?.sensor ?? cfg.sensor
        const r = fields
          ? await page.evaluate((f) => window.bench.setSensor(f), fields)
          : { error: 'no sensor in the config' }
        result.stages[entry] = r
        console.log(`== ${entry}: ${JSON.stringify(r)}`)
        continue
      }
      if (entry.startsWith('pool:')) {
        // `pool:<n>`: set the compute worker pool to n workers (0 = the default).
        const r = await page.evaluate((n) => window.bench.setPoolSize(n), Number(entry.slice(5)))
        result.stages[entry] = r
        console.log(`== ${entry}: ${JSON.stringify(r)}`)
        continue
      }
      if (entry.startsWith('quota:')) {
        // `quota:<MB>`: cap the site's storage at what it uses now plus <MB>, so the next
        // stage runs out of space (Chrome DevTools Storage.overrideQuotaForOrigin).
        const cdp = await page.context().newCDPSession(page)
        const { usage } = await page.evaluate(() => navigator.storage.estimate())
        const quotaSize = usage + Number(entry.slice(6)) * 1024 ** 2
        await cdp.send('Storage.overrideQuotaForOrigin', { origin: base, quotaSize })
        console.log(
          `== ${entry}: storage quota ${(quotaSize / 1024 ** 2).toFixed(0)} MB (usage ${(usage / 1024 ** 2).toFixed(0)} MB)`,
        )
        continue
      }
      const [stage, tag] = entry.split(':')
      if (!run[stage]) throw new Error(`unknown stage ${stage}`)
      await runStage(stage, cfg[entry] ?? cfg[stage], entry)
      if (stage === 'dense' && cfg.exportDense) await exportDense(tag)
      if ((stage === 'recon' || stage === 'dense') && cfg.exportCloudsProject)
        await exportCloudProject(stage === 'recon' ? 'sparse' : 'dense', tag)
      if (stage === 'dense' && lidarCfg) await denseLidarCheck(entry)
      if (stage === 'ortho') await exportOrtho(tag)
      if ((stage === 'reseau' || stage === 'reseauhalves') && cfg.reseauTruth) {
        // A synthetic block (synth_sat.py): each image's fit against the film truth.
        const { reseauTruthCheck } = await import('./synth/reseauTruth.mjs')
        const check = await reseauTruthCheck(cfg.reseauTruth, result.stages[entry]?.fits ?? [])
        result.stages[entry].truth = check
        delete result.stages[entry].fits
        console.log(`== reseau vs truth: ${JSON.stringify(check)}`)
        await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
      }
      if (stage === 'texture') await exportTexturePages(tag)
      if (stage === 'texturedump') {
        const r = result.stages[entry]
        const parts = []
        for (let s = 0; s < r.size; s += 8 << 20) {
          parts.push(
            Buffer.from(await page.evaluate(([a, n]) => window.bench.textureDumpChunk(a, n), [s, 8 << 20]), 'base64'),
          )
        }
        await writeFile(`${outPrefix}.texturedump.bin`, Buffer.concat(parts))
        await writeFile(`${outPrefix}.texturedump.json`, JSON.stringify({ ...r.meta, images: cfg.images }, null, 1))
        delete r.meta
        console.log(`== texturedump: ${(r.size / 1024 ** 2).toFixed(1)} MiB → ${outPrefix}.texturedump.{json,bin}`)
      }
      if (stage === 'meshexport') {
        const files = result.stages[entry]?.files ?? []
        for (let i = 0; i < files.length; i++) {
          const file = `${outPrefix}${tag ? `.${tag}` : ''}.export-${files[i].format}.${files[i].ext}`
          const parts = []
          for (let s = 0; s < files[i].size; s += 8 << 20) {
            parts.push(
              Buffer.from(
                await page.evaluate(([k, a, n]) => window.bench.meshexportChunk(k, a, n), [i, s, 8 << 20]),
                'base64',
              ),
            )
          }
          await writeFile(file, Buffer.concat(parts))
          console.log(`== meshexport: ${files[i].format} ${(files[i].size / 1024 ** 2).toFixed(1)} MiB → ${file}`)
        }
      }
      if (stage === 'dem' && (cfg.exportDem || cfg.hist?.refDem)) await exportDem(tag)
    }
  }
  result.finishedAt = new Date().toISOString()
  await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  console.log(`\nlog:     ${outPrefix}.log\nsummary: ${outPrefix}.json`)
} finally {
  // The sampler's poll timer would otherwise keep node alive after the browser closes.
  await heap?.stop()
  await browser.close()
  if (!cfg.profile) await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  await rm(`${outPrefix}.downloads`, { recursive: true, force: true }).catch(() => {})
  logOut.end()
  vite?.kill()
  server?.close()
}
