// Deploy dist/ to Cloudflare (deploy/cloudflare/, docs/deployment.md ▸ Cloudflare).
// Build first, with the models and examples fetched:
//
//   npm run fetch:models && npm run fetch:examples && npm run build:release
//   node scripts/deploy-cloudflare.mjs --upload        # first deploy, or new models/ORT
//   node scripts/deploy-cloudflare.mjs                 # websfm.app
//   node scripts/deploy-cloudflare.mjs --env dev       # dev.websfm.app
//   node scripts/deploy-cloudflare.mjs --env experimental   # experimental.websfm.app
//   node scripts/deploy-cloudflare.mjs --dry-run       # check only, upload nothing
//   node scripts/deploy-cloudflare.mjs --pinned        # websfm.app/v/<package.json version>/
//
// Static assets take files up to 25 MiB. The model weights and any bigger file are
// left out of the upload (dist/.assetsignore, written here) and live in the R2
// bucket under their URL path, where deploy/cloudflare/worker.js serves them.
// --upload puts them there; the bucket is shared by all environments. A model file
// already in the bucket is never replaced by different bytes: the pinned versions
// still load it by that name, so new weights get a new file name (registry.js).
//
// --pinned builds the app again under /v/<version>/ (its own directory, not dist/) and
// puts it in the bucket under v/<version>/, where worker.js serves it: the copy of a
// release that stays when websfm.app moves on. Its models and example datasets load
// from the site's /models/ and /examples/; its ORT files go to the bucket's ort/, which
// all versions share (they are named by ORT's version).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import packageJson from '../package.json' with { type: 'json' }

const WRANGLER = 'wrangler@4'
const BUCKET = 'websfm-data'
// Where the bucket's models are served, to compare an upload against (all sites share it).
const LIVE = 'https://websfm.app'
const MAX_ASSET_BYTES = 25 * 1024 * 1024
// The prefixes worker.js runs for (wrangler.jsonc ▸ run_worker_first).
const WORKER_PREFIXES = ['models/', 'ort/']
// Uploads of a pinned version at a time: one wrangler process each.
const PUT_CONCURRENCY = 6

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const upload = args.includes('--upload') && !dryRun
const pinned = args.includes('--pinned')
const envIndex = args.indexOf('--env')
// '' is the top-level (production) Worker; wrangler warns unless it is named.
const env = envIndex >= 0 ? args[envIndex + 1] : ''
const config = fileURLToPath(new URL('../deploy/cloudflare/wrangler.jsonc', import.meta.url))
const dist = fileURLToPath(new URL('../dist/', import.meta.url))

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', ...options })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

async function listFiles(dir) {
  return (
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      // relative(), not a slice: a top-level entry's parentPath keeps the trailing slash.
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
  )
}

function md5(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

// 'new' (not in the bucket), 'same' (these bytes are there) or the reason it differs.
// R2's ETag is the MD5 of a single-part upload; a multipart one ("…-N") is compared by size.
async function compareWithLive(file, path) {
  const res = await fetch(`${LIVE}/${file}`, { method: 'HEAD' })
  if (res.status === 404) return 'new'
  if (!res.ok) throw new Error(`HEAD ${LIVE}/${file}: HTTP ${res.status}`)
  const etag = (res.headers.get('ETag') ?? '').replace(/^W\//, '').replaceAll('"', '')
  const size = Number(res.headers.get('Content-Length'))
  const local = (await stat(path)).size
  if (local !== size) return `${size.toLocaleString('en')} bytes there, ${local.toLocaleString('en')} here`
  if (/^[0-9a-f]{32}$/.test(etag) && etag !== (await md5(path))) return 'same size, different bytes'
  return 'same'
}

function putObject(key, file) {
  const attempt = (n) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'npx',
        ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote'],
        {
          stdio: ['ignore', 'ignore', 'inherit'],
        },
      )
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${key}: wrangler exited with ${code}`))))
    }).catch((err) => (n < 3 ? attempt(n + 1) : Promise.reject(err)))
  return attempt(1)
}

async function putAll(items) {
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < items.length) {
      const { key, file } = items[next++]
      await putObject(key, file)
      if (++done % 20 === 0) console.log(`  ${done} / ${items.length}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PUT_CONCURRENCY, items.length) }, worker))
}

// ── --pinned: the release under /v/<version>/ ─────────────────────────────────────
if (pinned) {
  const version = packageJson.version
  const out = join(tmpdir(), `websfm-pinned-${version}`) + '/'
  console.log(`Building WebSfM ${version} for /v/${version}/ in ${out}`)
  run('npx', ['vite', 'build', '--outDir', out, '--emptyOutDir'], {
    env: {
      ...process.env,
      VITE_BASE_PATH: `/v/${version}/`,
      VITE_MODEL_BASE_URL: '/models/',
      VITE_EXAMPLE_BASE_URL: '/examples/',
    },
  })
  // _headers is static-asset config; worker.js sets the headers of a pinned version.
  const files = (await listFiles(out)).filter(
    (f) => !f.startsWith('models/') && !f.startsWith('examples/') && f !== '_headers',
  )
  const items = files.map((f) => ({ key: f.startsWith('ort/') ? f : `v/${version}/${f}`, file: out + f }))
  // index.html last: until then the version's page does not load half its files.
  const index = items.findIndex((i) => i.key === `v/${version}/index.html`)
  if (index < 0) {
    console.error(`✗ The build has no index.html.`)
    process.exit(1)
  }
  items.push(...items.splice(index, 1))
  console.log(`${items.length} files to ${BUCKET}/v/${version}/ (ORT's under ${BUCKET}/ort/)`)
  if (dryRun) {
    console.log(`(dry run: nothing uploaded; the build stays in ${out} to look at)`)
  } else {
    await putAll(items)
    await rm(out, { recursive: true, force: true })
    console.log(`✓ ${LIVE}/v/${version}/`)
  }
  process.exit(0)
}

// ── The site: dist/ as static assets, the large files in R2 ──────────────────────
if (process.env.VITE_BASE_PATH && process.env.VITE_BASE_PATH !== '/') {
  console.error('✗ The Cloudflare deploy serves the domain root: build without VITE_BASE_PATH.')
  process.exit(1)
}
// The same check as build:release: LICENSE, ORT, every redistributable model, no SuperPoint.
run('node', [fileURLToPath(new URL('check-release.mjs', import.meta.url))])

const files = await listFiles(dist)
const large = []
for (const file of files) {
  const { size } = await stat(dist + file)
  if (!file.startsWith('models/') && size <= MAX_ASSET_BYTES) continue
  if (!WORKER_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    console.error(`✗ ${file} is over 25 MiB and outside ${WORKER_PREFIXES.join(', ')}, so no route serves it.`)
    process.exit(1)
  }
  large.push({ file, size })
}

await writeFile(`${dist}.assetsignore`, ['.assetsignore', ...large.map((l) => l.file)].join('\n') + '\n')
console.log(`${files.length - large.length} static assets; ${large.length} files from R2 bucket ${BUCKET}:`)
for (const { file, size } of large) console.log(`  ${file} (${(size / 2 ** 20).toFixed(1)} MiB)`)

if (upload) {
  for (const { file } of large) {
    if (file.startsWith('models/')) {
      const state = await compareWithLive(file, dist + file)
      if (state === 'same') {
        console.log(`  ${file}: already in the bucket`)
        continue
      }
      if (state !== 'new') {
        console.error(
          `✗ ${file} differs from the one ${LIVE} serves (${state}). Pinned versions still load it by this ` +
            `name: give the new weights a new file name in src/core/models/registry.js.`,
        )
        process.exit(1)
      }
    }
    run('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${file}`, '--file', dist + file, '--remote'])
  }
} else if (!dryRun) {
  console.log('(not uploaded: pass --upload after a model or ORT change)')
}

run('npx', ['--yes', WRANGLER, 'deploy', '--config', config, `--env=${env}`, ...(dryRun ? ['--dry-run'] : [])])
