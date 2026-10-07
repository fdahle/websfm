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
// Config keys (JSON file and/or flags; flags win): name, images (folder), include (regex
// on file names), limit (first N after sorting), sceneType, stages ("detect,match,recon"),
// detect / match / recon (settings objects; `preset` selects a preset delta), port, headed,
// variants ([{ label, match?, recon? }]: one detection, then a match + reconstruct per
// variant, so SfM-only experiments reuse the same keypoints and matches).
import { chromium } from 'playwright'
import { loadReference } from './reference.mjs'
import { spawn } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import { join, dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff'])
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.tif': 'image/tiff', '.tiff': 'image/tiff' }

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue }
    out[key] = next; i++
  }
  return out
}
const json = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

const args = parseArgs(process.argv.slice(2))
const cfg = { ...(args.config ? JSON.parse(await readFile(args.config, 'utf8')) : {}) }
for (const k of ['name', 'images', 'include', 'limit', 'sceneType', 'stages', 'out', 'port', 'headed', 'dev', 'build']) if (args[k] !== undefined) cfg[k] = args[k]
for (const k of ['detect', 'match', 'recon']) cfg[k] = { ...(cfg[k] ?? {}), ...(args[k] ? json(args[k]) : {}) }
if (!cfg.images) throw new Error('--images <folder> (or "images" in --config) is required')
const name = cfg.name ?? 'bench'
const stages = String(cfg.stages ?? 'detect,match,recon').split(',').map((s) => s.trim())
const port = Number(cfg.port ?? 4180)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outPrefix = resolve(repo, cfg.out ?? join('bench-out', `${name}-${stamp}`))
await mkdir(dirname(outPrefix), { recursive: true })

// ── dataset ──
// `recursive: true` walks sub-folders (a MicaSense SET splits captures into 000/001/…);
// paths stay relative with '/' and the image NAME is the basename.
const listImages = async (dir, prefix = '') => {
  const out = []
  for (const e of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory() && cfg.recursive) out.push(...await listImages(dir, rel))
    else if (e.isFile() && IMAGE_EXT.has(extname(e.name).toLowerCase())) out.push(rel)
  }
  return out
}
const baseName = (f) => f.slice(f.lastIndexOf('/') + 1)
let files = (await listImages(cfg.images)).sort((a, b) => baseName(a).localeCompare(baseName(b)))
if (cfg.include) { const re = new RegExp(cfg.include, 'i'); files = files.filter((f) => re.test(baseName(f))) }
// `minGpsAlt` (metres, EXIF GPS altitude): drop captures taken on the ground before
// takeoff / after landing, which a camera that records from power-on produces.
if (cfg.minGpsAlt != null) {
  const { default: exifr } = await import('exifr')
  const kept = []
  for (const f of files) {
    const g = await exifr.parse(join(cfg.images, f), { gps: true, tiff: true, exif: true, xmp: false }).catch(() => null)
    if (Number.isFinite(g?.GPSAltitude) && g.GPSAltitude >= Number(cfg.minGpsAlt)) kept.push(f)
  }
  console.log(`== minGpsAlt ${cfg.minGpsAlt} m: kept ${kept.length}/${files.length} image(s)`)
  files = kept
}
if (cfg.limit) files = files.slice(0, Number(cfg.limit))
if (!files.length) throw new Error(`no images in ${cfg.images}`)

// ── app server ──
// Default: build a snapshot (scripts/bench/vite.bench.config.mjs) and serve it
// statically, so source edits made while a long run is going cannot reach it (the dev
// server hot-reloads the page). `--dev` uses the dev server instead (fast, not frozen);
// `--build <dir>` reuses an earlier snapshot.
const base = `http://127.0.0.1:${port}`
const benchUrl = `${base}/tests/bench/bench.html`
const alive = async () => { try { return (await fetch(benchUrl)).ok } catch { return false } }
let vite = null, server = null
const STATIC_MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.onnx': 'application/octet-stream' }
if (cfg.dev) {
  if (!(await alive())) {
    vite = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
      { cwd: repo, stdio: 'ignore' })
  }
} else {
  const buildDir = cfg.build ? resolve(repo, cfg.build) : `${outPrefix}.build`
  if (!cfg.build) {
    const t0 = Date.now()
    await new Promise((ok, fail) => {
      const p = spawn(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'scripts/bench/vite.bench.config.mjs', '--logLevel', 'warn'],
        { cwd: repo, stdio: 'inherit', env: { ...process.env, BENCH_OUT_DIR: buildDir } })
      p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`bench build failed (${code})`))))
    })
    console.log(`== build: ${((Date.now() - t0) / 1000).toFixed(1)} s → ${buildDir}`)
  }
  const { createServer } = await import('node:http')
  server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, base).pathname)
    // Dataset files stream straight from disk: routing gigabytes through Playwright's
    // page.route (one CDP message per file) failed on the 2.9 GB quarry set.
    if (path.startsWith('/__bench_data/')) {
      const file = join(cfg.images, path.slice('/__bench_data/'.length))
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
      createReadStream(file).on('error', () => res.destroy()).pipe(res)
      return
    }
    try {
      const body = await readFile(join(buildDir, path))
      res.writeHead(200, { 'Content-Type': STATIC_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' })
      res.end(body)
    } catch { res.writeHead(404); res.end() }
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
const profileDir = `${outPrefix}.profile`
// Precise heap readings + a callable gc(), so the `== memory` lines below report live
// bytes rather than quantised numbers that include uncollected garbage.
const browser = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome', headless: !cfg.headed,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
})
const result = { name, config: cfg, files: files.length, startedAt: new Date().toISOString(), stages: {} }
try {
  const page = browser.pages()[0] ?? await browser.newPage()
  // Stall/crash watchdog. A worker or renderer that dies of memory can leave
  // page.evaluate pending forever (a 2026-10-07 Monster run sat silent for 5 h after
  // its SfM worker died). Any page crash, or no log line for `stallMinutes` (default
  // 30) while a stage runs, aborts the run with an error in the result instead.
  let lastLogAt = Date.now(), pageCrashed = false
  page.on('crash', () => { pageCrashed = true; console.error('[page crash] renderer process died') })
  const stallMs = Number(cfg.stallMinutes ?? 30) * 60_000
  const watchdog = () => new Promise((_, reject) => {
    const t = setInterval(() => {
      if (pageCrashed) { clearInterval(t); reject(new Error('page crashed (renderer process died)')) }
      else if (Date.now() - lastLogAt > stallMs) {
        clearInterval(t); reject(new Error(`stalled: no log line for ${cfg.stallMinutes ?? 30} min (worker likely died)`))
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
      logOut.write(fmt(e) + '\n')
      if (!quiet.test(e.message) && e.level !== 'debug') console.log(fmt(e))
    } else if (msg.type() === 'error') {
      logOut.write(`[page error] ${text}\n`)
      console.error('[page error]', text)
    }
  })
  page.on('pageerror', (err) => { logOut.write(`[page exception] ${err.message}\n`); console.error('[page exception]', err.message) })
  if (cfg.dev) await page.route(`${base}/__bench_data/**`, async (route) => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.replace('/__bench_data/', ''))
    const body = await readFile(join(cfg.images, file))
    await route.fulfill({ body, contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' })
  })
  await page.goto(benchUrl)
  await page.waitForFunction(() => window.benchReady === true, null, { timeout: 120_000 })

  const t0 = Date.now()
  await page.evaluate((o) => window.bench.start(o), { name, sceneType: cfg.sceneType ?? 'object' })
  if (cfg.reference) console.log('== reference:', JSON.stringify(await page.evaluate((r) => window.bench.setReference(r), await loadReference(cfg.reference))))
  // In batches, so the page never holds the whole dataset as blobs at once.
  let added = 0
  const list = files.map((f) => ({ url: `${base}/__bench_data/${encodeURIComponent(f)}`, name: baseName(f) }))
  for (let i = 0; i < list.length; i += 32) added = await page.evaluate((l) => window.bench.addImages(l), list.slice(i, i + 32))
  result.stages.ingest = { images: added, seconds: (Date.now() - t0) / 1000 }
  if (cfg.reference?.importPoses) console.log(`== imported ${await page.evaluate(() => window.bench.importReferencePoses())} reference pose(s)`)
  console.log(`== ingest: ${added} images in ${result.stages.ingest.seconds.toFixed(1)} s`)
  // Renderer heap after each stage, before and after a forced GC: the sparse memory
  // preflight reads usedJSHeapSize, so garbage the page has not collected yet can
  // refuse a run that would fit.
  const memory = async (label) => {
    const m = await page.evaluate(async () => {
      const before = performance.memory?.usedJSHeapSize ?? null
      if (typeof globalThis.gc === 'function') { globalThis.gc(); await new Promise((r) => setTimeout(r, 200)); globalThis.gc() }
      return { before, after: performance.memory?.usedJSHeapSize ?? null }
    })
    const gb = (v) => (v == null ? '?' : `${(v / 1024 ** 3).toFixed(2)} GB`)
    console.log(`== memory ${label}: renderer heap ${gb(m.before)} → ${gb(m.after)} after GC`)
    ;(result.memory ??= {})[label] = m
  }
  await memory('after ingest')

  const run = { detect: 'detect', match: 'match', recon: 'reconstruct' }
  // A LiDAR reference (scripts/bench/lidar.mjs) is gridded once, then every
  // reconstruction's points are scored against it here, in node.
  const lidarCfg = cfg.reference?.lidar ?? null
  let lidarGrid = null
  const runStage = async (stage, settings, key = stage) => {
    const s = stage === 'recon' && lidarCfg ? { ...settings, exportPoints: true } : settings
    lastLogAt = Date.now()
    let r
    try {
      r = await Promise.race([page.evaluate(([f, x]) => window.bench[f](x), [run[stage], s]), watchdog()])
    } catch (err) {
      result.stages[key] = { error: String(err?.message ?? err) }
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
    result.stages[key] = r
    const { settings: _s, model: _m, ...numbers } = r
    console.log(`== ${key}: ${JSON.stringify(numbers)}`)
    if (stage !== 'recon') await memory(`after ${key}`)
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
      if (JSON.stringify(match) !== lastMatch) { await runStage('match', match, `match[${label}]`); lastMatch = JSON.stringify(match) }
      await runStage('recon', { ...cfg.recon, ...(v.recon ?? {}) }, `recon[${label}]`)
    }
  } else {
    for (const stage of stages) {
      if (!run[stage]) throw new Error(`unknown stage ${stage}`)
      await runStage(stage, cfg[stage])
    }
  }
  result.finishedAt = new Date().toISOString()
  await writeFile(`${outPrefix}.json`, JSON.stringify(result, null, 2))
  console.log(`\nlog:     ${outPrefix}.log\nsummary: ${outPrefix}.json`)
} finally {
  await browser.close()
  await rm(profileDir, { recursive: true, force: true }).catch(() => {})
  logOut.end()
  vite?.kill()
  server?.close()
}
