// The README's screenshots, taken in the real app from the example project, so they can
// be made again after the interface changes instead of captured by hand.
//
//   node scripts/screenshots/shoot.mjs              # every shot (builds the project once)
//   node scripts/screenshots/shoot.mjs orthophoto matches  # only these shots
//   node scripts/screenshots/shoot.mjs --rebuild    # run the example project again first
//   node scripts/screenshots/shoot.mjs --out <dir>  # write somewhere else (to compare)
//
// 1. The project: the headless bench (scripts/bench/websfm/run-bench.mjs) runs the example
//    project (npm run fetch:examples) from detection to a textured mesh, georeferenced by
//    the photos' GPS as the walkthrough does (example.json), in a browser profile it
//    keeps under bench-out/screenshots/. That takes a few minutes, once.
// 2. The app: a production build, served on the bench's port. A project lives in the
//    browser storage of one origin, so the app must be served where the bench ran.
// 3. The shots (shots.mjs): each opens a view the way a user would, through the ribbon,
//    and saves the part of the window it names as WebP in docs/images/. After each shot
//    it warns if a product shows as outdated, which no README image should.
//
// WebP comes from ffmpeg (libwebp). Chrome runs headed with the WebGPU flags, as the
// bench does on Linux: headless Chrome has no GPU there, and the 3D view and the map
// need one. A window opens while it runs. Port 4186: 4190 is on the fetch standard's
// list of blocked ports, which Chrome and Node refuse to connect to.
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SHOTS, PROJECT_NAME } from './shots.mjs'

const repo = fileURLToPath(new URL('../..', import.meta.url))
const work = join(repo, 'bench-out/screenshots')
const profile = join(work, 'profile')
const appDir = join(work, 'app')
const PORT = 4186
const VIEWPORT = { width: 1920, height: 1080 }
// Not the bench's `--enable-features=Vulkan`: with it, the 3D view and the map came out
// blank in screenshots (their canvases are not composited into the capture).
const GPU_FLAGS = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist']

const args = process.argv.slice(2)
const rebuild = args.includes('--rebuild')
const outAt = args.indexOf('--out')
const outDir = outAt >= 0 ? join(process.cwd(), args[outAt + 1]) : join(repo, 'docs/images')
const only = args.filter((a, i) => !a.startsWith('--') && i !== outAt + 1)
for (const id of only) if (!SHOTS.some((s) => s.id === id)) throw new Error(`no shot "${id}"`)

function run(cmd, cmdArgs) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, cmdArgs, { cwd: repo, stdio: 'inherit' })
    p.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`${cmdArgs.join(' ')} exited with ${code}`))))
  })
}

// 1. The example project, in a profile kept between runs.
if (rebuild || !existsSync(profile)) {
  if (!existsSync(join(repo, 'public/examples/aukerman'))) throw new Error('run `npm run fetch:examples` first')
  if (rebuild) await run('rm', ['-rf', profile])
  console.log('== building the example project (a few minutes)')
  await run(process.execPath, [
    'scripts/bench/websfm/run-bench.mjs',
    '--config',
    'scripts/screenshots/example.json',
    '--profile',
    profile,
    '--port',
    String(PORT),
    '--out',
    join(work, 'build'),
  ])
}

// 2. The app, built as it is deployed.
console.log('== building the app')
await run(process.execPath, [
  join(repo, 'node_modules/vite/bin/vite.js'),
  'build',
  '--outDir',
  appDir,
  '--logLevel',
  'warn',
])
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.JPG': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.onnx': 'application/octet-stream',
}
const server = createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname)
  if (path.endsWith('/')) path += 'index.html'
  try {
    const body = await readFile(join(appDir, path))
    res.writeHead(200, {
      'Content-Type': MIME[extname(path)] ?? 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end()
  }
})
await new Promise((ok) => server.listen(PORT, '127.0.0.1', ok))

// 3. The shots.
const browser = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  colorScheme: 'light',
  args: GPU_FLAGS,
})
let failed = 0
try {
  const page = browser.pages()[0] ?? (await browser.newPage())
  page.on('pageerror', (e) => console.warn(`page error: ${e.message}`))
  await page.goto(`http://127.0.0.1:${PORT}/`)
  await openProject(page)
  await mkdir(outDir, { recursive: true })
  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.id)) continue
    try {
      const t0 = Date.now()
      // A shot returns what to capture: a locator or the page, `{ clip }` (a region of the
      // window), or `{ recording }` (a video, which `toAnimatedWebp` turns into the image).
      const target = await shot.take(page, { work })
      let webp
      if (target?.recording) webp = await toAnimatedWebp(target.recording, shot.animation)
      else {
        const png = target?.clip
          ? await page.screenshot({ clip: target.clip, animations: 'disabled' })
          : await target.screenshot({ animations: 'disabled' })
        if (args.includes('--png')) await writeFile(join(outDir, `${shot.id}.png`), png)
        webp = await toWebp(png, shot.quality ?? 0.85)
      }
      await writeFile(join(outDir, `${shot.id}.webp`), webp)
      console.log(
        `✓ ${shot.id}.webp  ${(webp.length / 1024).toFixed(0)} KB  ${((Date.now() - t0) / 1000).toFixed(1)} s`,
      )
      if (shot.after) await shot.after(page)
      // A README image must not show a product marked outdated; say which shot left one.
      const outdated = await page.locator('.outdated-badge').evaluateAll((els) => els.map((e) => e.title))
      if (outdated.length) console.warn(`! after ${shot.id}: ${outdated.join('; ')}`)
    } catch (e) {
      failed++
      console.error(`✗ ${shot.id}: ${e.message}`)
      await page.screenshot({ path: join(work, `${shot.id}.failed.png`) })
      await page.keyboard.press('Escape')
    }
  }
} finally {
  await browser.close()
  server.close()
}
if (failed) process.exit(1)

// The project picker opens on start when projects exist; open the example, under the
// name the walkthrough uses.
async function openProject(page) {
  const picker = page.locator('.project-main').first()
  await picker.waitFor({ timeout: 60_000 })
  const named = page.locator('.project-main', { hasText: PROJECT_NAME })
  if ((await named.count()) === 0) {
    await page.getByTitle('Project actions').first().click()
    await page.locator('.row-menu .menu-item', { hasText: 'Rename' }).click()
    const field = page.locator('.project-picker .rename-input')
    await field.fill(PROJECT_NAME)
    await field.press('Enter')
  }
  await page.locator('.project-main', { hasText: PROJECT_NAME }).click()
  await page.getByRole('button', { name: `${PROJECT_NAME} ▾`, exact: true }).waitFor({ timeout: 120_000 })
}

// PNG to WebP with ffmpeg (libwebp), which the turntable needs anyway.
async function toWebp(png, quality) {
  const tmp = join(work, 'shot.png')
  const out = join(work, 'shot.webp')
  await writeFile(tmp, png)
  await run('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    tmp,
    '-c:v',
    'libwebp',
    '-quality',
    String(Math.round(quality * 100)),
    out,
  ])
  return readFile(out)
}

// A recorded turn (WebM) to a looping WebP: the middle of the frame, where the model is,
// scaled down and at a lower frame rate, so the README's image stays a few megabytes.
async function toAnimatedWebp(video, { width = 800, height = 400, crop = 0.62, fps = 12, quality = 60 } = {}) {
  const out = join(work, 'turn.webp')
  const aspect = height / width
  const filter = `crop=iw*${crop}:iw*${crop * aspect},scale=${width}:${height}:flags=lanczos,fps=${fps}`
  await run('ffmpeg', [
    '-loglevel',
    'error',
    '-y',
    '-i',
    video,
    '-vf',
    filter,
    '-c:v',
    'libwebp_anim',
    '-loop',
    '0',
    '-quality',
    String(quality),
    '-an',
    out,
  ])
  return readFile(out)
}
