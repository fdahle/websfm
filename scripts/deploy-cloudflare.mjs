// Deploy dist/ to Cloudflare (deploy/cloudflare/, docs/deployment.md ▸ Cloudflare).
// Build first, with the models and examples fetched:
//
//   npm run fetch:models && npm run fetch:examples && npm run build:release
//   node scripts/deploy-cloudflare.mjs --upload        # first deploy, or new models/ORT
//   node scripts/deploy-cloudflare.mjs                 # websfm.app
//   node scripts/deploy-cloudflare.mjs --env dev       # dev.websfm.app
//   node scripts/deploy-cloudflare.mjs --dry-run       # check only, upload nothing
//
// Static assets take files up to 25 MiB. The model weights and any bigger file are
// left out of the upload (dist/.assetsignore, written here) and live in the R2
// bucket under their URL path, where deploy/cloudflare/worker.js serves them.
// --upload puts them there; the bucket is shared by both environments.
import { spawnSync } from 'node:child_process'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const WRANGLER = 'wrangler@4'
const BUCKET = 'websfm-data'
const MAX_ASSET_BYTES = 25 * 1024 * 1024
// The prefixes worker.js runs for (wrangler.jsonc ▸ run_worker_first).
const WORKER_PREFIXES = ['models/', 'ort/']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const upload = args.includes('--upload') && !dryRun
const envIndex = args.indexOf('--env')
// '' is the top-level (production) Worker; wrangler warns unless it is named.
const env = envIndex >= 0 ? args[envIndex + 1] : ''
const config = fileURLToPath(new URL('../deploy/cloudflare/wrangler.jsonc', import.meta.url))
const dist = fileURLToPath(new URL('../dist/', import.meta.url))

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

if (process.env.VITE_BASE_PATH && process.env.VITE_BASE_PATH !== '/') {
  console.error('✗ The Cloudflare deploy serves the domain root: build without VITE_BASE_PATH.')
  process.exit(1)
}
// The same check as build:release: LICENSE, ORT, every redistributable model, no SuperPoint.
run('node', [fileURLToPath(new URL('check-release.mjs', import.meta.url))])

const files = (await readdir(dist, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => `${entry.parentPath}/${entry.name}`.slice(dist.length))
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
    run('npx', ['--yes', WRANGLER, 'r2', 'object', 'put', `${BUCKET}/${file}`, '--file', dist + file, '--remote'])
  }
} else if (!dryRun) {
  console.log('(not uploaded: pass --upload after a model or ORT change)')
}

run('npx', ['--yes', WRANGLER, 'deploy', '--config', config, `--env=${env}`, ...(dryRun ? ['--dry-run'] : [])])
